import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, loadSendblueConfig } from "./config.js";
import { createAgentSession, type AgentSession } from "./core.js";
import { SendblueClient, parseInbound, verifyWebhookSecret } from "./sendblue.js";
import { OrderRelay } from "./orderRelay.js";
import { BuyerStore } from "./buyerStore.js";
import { SllrMcp } from "./mcp.js";

// Sendblue iMessage server. One public POST route: /sendblue/inbound. Customers
// text in → their per-number AgentCore replies → we send the reply back. When an
// order is created, OrderRelay pushes it to the merchant, who replies 1/2/3.
//
// This is the same AgentCore the CLI drives — iMessage is just the transport.
async function main() {
  const config = loadConfig();              // Gemini + SLL-R
  const sb = loadSendblueConfig();          // Sendblue + merchant number
  const sendblue = new SendblueClient(sb);
  const log = (m: string) => process.stdout.write(`${m}\n`);
  const relay = new OrderRelay(sendblue, sb.merchantNumber, log);

  // Shared MCP client for server-side lookups (payment options after an order).
  const mcp = new SllrMcp(config.sllrBaseUrl);
  await mcp.initialize();
  // Orders created during the current turn, keyed by phone — used to append the
  // pay link + pickup code deterministically, never relying on the LLM to do it.
  const pendingOrder = new Map<string, { merchantId: string; orderId: string }>();

  // After an online pay link is offered, poll the order until payment lands, then
  // confirm it back in the thread. The backend (Vercel) can't message the customer
  // — it doesn't know their phone — so the agent owns this notification.
  const watching = new Set<string>();
  function watchPayment(phone: string, sendblueNumber: string, orderId: string): void {
    if (watching.has(orderId)) return;
    watching.add(orderId);
    let tries = 0;
    const maxTries = 120; // ~10 min at 5s intervals
    const tick = async () => {
      if (!watching.has(orderId)) return;
      tries++;
      try {
        const res = await mcp.callTool("check_order_status", { orderId }) as {
          order?: { status?: string; payment?: { status?: string }; item?: { name?: string }; receipt?: { claimUrl?: string } };
        };
        const o = res.order;
        if (o && (o.status === "receipt_issued" || o.payment?.status === "verified")) {
          watching.delete(orderId);
          const code = orderId.replace(/^ord_/, "").slice(0, 6).toUpperCase();
          const item = o.item?.name ? `your ${o.item.name}` : "your order";
          let msg = `✅ Payment received — ${item} is confirmed! 🎟️ Pickup code ${code}.`;
          if (o.receipt?.claimUrl) msg += `\n🧾 Receipt: ${o.receipt.claimUrl}`;
          await sendblue.sendMessage(phone, msg, sendblueNumber).catch(() => {});
          return;
        }
      } catch { /* transient — keep polling */ }
      if (tries < maxTries) setTimeout(tick, 5000);
      else watching.delete(orderId);
    };
    setTimeout(tick, 5000);
  }

  // Persistent phone → buyer mapping so a returning customer keeps the same
  // buyerId + order history across restarts (taste memory).
  const buyers = new BuyerStore(process.env.SLLR_BUYER_STORE?.trim() || ".sllr-buyers.json");

  // One agent session per customer phone number (in-memory chat history; orders
  // + buyer identity persist via SLL-R + the buyer store).
  const customers = new Map<string, Promise<AgentSession>>();
  function customerAgent(number: string): Promise<AgentSession> {
    let session = customers.get(number);
    if (!session) {
      session = createAgentSession(config, `iMessage ${number}`, {
        buyer: buyers.get(number),
        onToolResult: (name, _args, result) => {
          void relay.onToolResult(number, name, result).catch((e) => log(`[relay] push failed: ${e?.message || e}`));
          if (name === "create_order") {
            const order = (result as { order?: { id?: string; merchantId?: string } } | undefined)?.order;
            if (order?.id) pendingOrder.set(number, { merchantId: String(order.merchantId ?? ""), orderId: String(order.id) });
          }
        },
      }).then((s) => {
        // Persist the (possibly newly issued) buyer for next time.
        buyers.set(number, { token: s.token, buyerId: s.buyerId });
        return s;
      });
      customers.set(number, session);
    }
    return session;
  }

  // Idempotency: Sendblue may retry webhooks; dedupe by message_handle.
  // Bounded so a long-running server doesn't leak memory.
  const seen = new Set<string>();
  const SEEN_CAP = 5000;
  function markSeen(handle: string): void {
    if (seen.size >= SEEN_CAP) seen.clear();
    seen.add(handle);
  }

  async function handleInbound(msg: ReturnType<typeof parseInbound>): Promise<void> {
    if (relay.isMerchant(msg.fromNumber)) {
      await relay.handleMerchantReply(msg.fromNumber, msg.content);
      return;
    }
    // Presence: mark their message read + show "…" while the agent thinks, so the
    // conversation feels human. Best-effort — never block or fail the turn.
    void sendblue.markRead(msg.fromNumber, msg.sendblueNumber).catch(() => {});
    void sendblue.sendTyping(msg.fromNumber, msg.sendblueNumber).catch(() => {});
    pendingOrder.delete(msg.fromNumber);
    const { agent } = await customerAgent(msg.fromNumber);
    let reply: string;
    try {
      reply = await agent.send(msg.content);
    } catch (error) {
      reply = `⚠️ Sorry, something went wrong: ${error instanceof Error ? error.message : "agent error"}`;
    }
    // Deterministic payment surface: if an order was created this turn, append the
    // pickup code + pay link ourselves so it never depends on the LLM remembering.
    const created = pendingOrder.get(msg.fromNumber);
    if (created) {
      pendingOrder.delete(msg.fromNumber);
      try {
        const opts = await mcp.callTool("get_payment_options", { merchantId: created.merchantId, orderId: created.orderId });
        const block = paymentBlock(opts);
        if (block) reply = reply.trim() ? `${reply.trim()}\n\n${block}` : block;
        // If an online pay link was offered, watch for the payment and confirm it.
        const optList = (opts as { paymentOptions?: Array<{ type?: string }> }).paymentOptions ?? [];
        if (optList.some((o) => o.type === "checkout_url")) {
          watchPayment(msg.fromNumber, msg.sendblueNumber, created.orderId);
        }
      } catch (e) {
        log(`[payment] options lookup failed: ${(e as Error)?.message || e}`);
      }
    }
    if (reply.trim()) await sendblue.sendMessage(msg.fromNumber, reply, msg.sendblueNumber);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "sllr-agent-sendblue", merchantPush: !!sb.merchantNumber });
    }
    if (req.method !== "POST" || url.pathname !== "/sendblue/inbound") {
      return json(res, 404, { error: "not found" });
    }

    readBody(req).then((raw) => {
      let body: unknown;
      try { body = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }

      if (process.env.SLLR_DEBUG_WEBHOOK === "1") {
        log(`[debug] POST ${url.pathname}\n  headers=${JSON.stringify(req.headers)}\n  body=${raw.slice(0, 1000)}`);
      }

      if (!verifyWebhookSecret(sb, req.headers, url, body)) {
        return json(res, 401, { error: "bad webhook secret" });
      }

      const msg = parseInbound(body);
      // Drop our own outbound status callbacks, typing indicators, empty events.
      if (msg.isOutbound || msg.isTyping || !msg.content.trim() || !msg.fromNumber) {
        return json(res, 200, { ignored: true });
      }
      if (msg.messageHandle && seen.has(msg.messageHandle)) {
        return json(res, 200, { duplicate: true });
      }
      if (msg.messageHandle) markSeen(msg.messageHandle);

      // Ack immediately so Sendblue doesn't retry; process in the background
      // (Gemini turns take seconds). Fire-and-forget per JhiNResH's async pattern.
      json(res, 200, { accepted: true });
      handleInbound(msg).catch((e) => log(`[inbound] ${e?.message || e}`));
    }).catch((e) => json(res, 500, { error: e?.message || "read error" }));
  });

  server.listen(sb.port, () => {
    log(`sllr-agent Sendblue server on :${sb.port}`);
    log(`  backend       ${config.sllrBaseUrl}`);
    log(`  model         ${config.geminiModel}`);
    log(`  merchant push ${sb.merchantNumber || "(disabled — set SLLR_MERCHANT_NUMBER)"}`);
    log(`  webhook       POST /sendblue/inbound  (point your Sendblue webhook here)`);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

// Build the deterministic payment line(s) from a get_payment_options result:
// pickup code + a pay-now link (Stripe checkout / Apple Pay) when available,
// else a counter-pay instruction. This is what the customer actually acts on.
function paymentBlock(optsResult: unknown): string {
  const opts = (optsResult as { paymentOptions?: Array<Record<string, unknown>> })?.paymentOptions ?? [];
  const counter = opts.find((o) => o.rail === "counter");
  const pay = opts.find((o) => o.type === "checkout_url" && typeof o.url === "string");
  const lines: string[] = [];
  const code = counter?.pickupCode;
  if (typeof code === "string" && code) lines.push(`🎟️ Pickup code: ${code}`);
  if (pay) lines.push(`💳 Pay now (Apple Pay / card): ${pay.url}`);
  else lines.push("💵 Pay at the counter when you pick up.");
  return lines.join("\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
