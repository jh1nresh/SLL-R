import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, loadSendblueConfig } from "./config.js";
import { createAgentSession, type AgentSession } from "./core.js";
import { SendblueClient, parseInbound, verifyWebhookSecret } from "./sendblue.js";
import { OrderRelay } from "./orderRelay.js";
import { BuyerStore } from "./buyerStore.js";
import { SllrMcp } from "./mcp.js";
import { statusMessage, isTerminal, type WatchedOrder } from "./orderNotify.js";

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
  const relay = new OrderRelay(sendblue, sb.merchantChannels, sb.merchantNumber, log);
  const merchantCount = new Set([...Object.values(sb.merchantChannels), sb.merchantNumber].filter(Boolean)).size;

  // Shared MCP client for server-side lookups (payment options after an order).
  const mcp = new SllrMcp(config.sllrBaseUrl);
  await mcp.initialize();
  // Orders created during the current turn, keyed by phone — used to append the
  // pay link + pickup code deterministically, never relying on the LLM to do it.
  const pendingOrder = new Map<string, { merchantId: string; orderId: string }>();

  // Poll a created order and message the customer on each meaningful transition
  // (payment cleared, accepted, ready, rejected, receipt). The backend (Vercel)
  // can't message the customer — it doesn't know their phone — so the agent owns
  // this. Started for EVERY order (counter orders get accepted/ready too).
  const watched = new Map<string, { phone: string; sendblueNumber: string; lastStatus: string; lastPayment: string; tries: number }>();
  function watchOrder(phone: string, sendblueNumber: string, orderId: string): void {
    if (watched.has(orderId)) return;
    watched.set(orderId, { phone, sendblueNumber, lastStatus: "", lastPayment: "", tries: 0 });
    const tick = async () => {
      const w = watched.get(orderId);
      if (!w) return;
      w.tries++;
      try {
        const res = await mcp.callTool("check_order_status", { orderId }) as { order?: WatchedOrder };
        const o = res.order;
        if (o) {
          const msg = statusMessage(o, w.lastStatus, w.lastPayment, orderId);
          w.lastStatus = o.status ?? "";
          w.lastPayment = o.payment?.status ?? "";
          if (msg) await sendblue.sendMessage(w.phone, msg, w.sendblueNumber).catch(() => {});
          if (isTerminal(o.status)) { watched.delete(orderId); return; }
        }
      } catch { /* transient — keep polling */ }
      if (w.tries < 240) setTimeout(tick, 5000); // ~20 min
      else watched.delete(orderId);
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
      } catch (e) {
        log(`[payment] options lookup failed: ${(e as Error)?.message || e}`);
      }
      // Watch every order so the customer hears about accepted / ready / payment /
      // receipt — even counter orders (no online pay).
      watchOrder(msg.fromNumber, msg.sendblueNumber, created.orderId);
    }
    if (reply.trim()) await sendblue.sendMessage(msg.fromNumber, reply, msg.sendblueNumber);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "sllr-agent-sendblue", merchants: merchantCount });
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
    log(`  merchant push ${merchantCount > 0 ? `${merchantCount} merchant channel(s)` : "(disabled — set SLLR_MERCHANT_CHANNELS or SLLR_MERCHANT_NUMBER)"}`);
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
