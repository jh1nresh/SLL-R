import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, loadLineConfig } from "./config.js";
import { createAgentSession, type AgentSession } from "./core.js";
import { BuyerStore } from "./buyerStore.js";
import { clampEnvelope, type SllrStateProof } from "./claimClamp.js";
import { createOrderArgs, isConfirmExpired, isEtaReconfirm, isPureConfirmation, pendingConfirmFromQuoteResult, requestConsentArgs, type PendingConfirm } from "./confirmFastPath.js";
import { renderEnvelopeToText } from "./iMessageRenderer.js";
import { LineClient, LineEventDeduper, parseLineMessages, verifyLineSignature } from "./line.js";
import { SllrMcp } from "./mcp.js";
import { isTerminal, statusMessage, type WatchedOrder } from "./orderNotify.js";
import { paymentBlock } from "./paymentBlock.js";
import { parseEnvelope } from "./responseContract.js";
import { TurnQueue } from "./turnQueue.js";
import { recordTurnProof } from "./turnProof.js";

async function main() {
  const config = loadConfig();
  const lineConfig = loadLineConfig();
  const line = new LineClient(lineConfig);
  const mcp = new SllrMcp(config.sllrBaseUrl);
  await mcp.initialize();

  const log = (message: string) => process.stdout.write(`${message}\n`);
  const buyers = new BuyerStore(process.env.SLLR_LINE_BUYER_STORE?.trim() || ".sllr-line-buyers.json");
  const turns = new TurnQueue();
  const turnProof = new Map<string, SllrStateProof>();
  const pendingOrder = new Map<string, { merchantId: string; orderId: string }>();
  const pendingConfirm = new Map<string, PendingConfirm>();
  const fastPathNote = new Map<string, string>();
  const customers = new Map<string, Promise<AgentSession>>();
  const watched = new Map<string, { userId: string; lastStatus: string; lastPayment: string; tries: number }>();

  function customerAgent(userId: string): Promise<AgentSession> {
    const existing = customers.get(userId);
    if (existing) {
      customers.delete(userId);
      customers.set(userId, existing);
      return existing;
    }
    if (customers.size >= 300) {
      const oldest = customers.keys().next().value;
      if (oldest !== undefined) customers.delete(oldest);
    }
    const session = createAgentSession(config, `LINE ${userId.slice(-8)}`, {
      buyer: buyers.get(userId),
      channel: "line",
      onToolResult: (name, _args, result) => {
        recordTurnProof(turnProof, userId, name, result);
        if (name === "quote_order") {
          const confirmation = pendingConfirmFromQuoteResult(result);
          if (confirmation) pendingConfirm.set(userId, confirmation);
        }
        if (name === "create_order") {
          pendingConfirm.delete(userId);
          const order = objectRecord(objectRecord(result).order);
          const orderId = stringField(order, "id");
          if (orderId) pendingOrder.set(userId, { merchantId: stringField(order, "merchantId"), orderId });
        }
      },
    })
      .then((created) => {
        buyers.set(userId, { token: created.token, buyerId: created.buyerId });
        return created;
      })
      .catch((error) => {
        customers.delete(userId);
        throw error;
      });
    customers.set(userId, session);
    return session;
  }

  async function pushReliable(userId: string, text: string): Promise<void> {
    try {
      await line.pushText(userId, text);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await line.pushText(userId, text);
    }
  }

  function watchOrder(userId: string, orderId: string): void {
    if (watched.has(orderId)) return;
    watched.set(orderId, { userId, lastStatus: "", lastPayment: "", tries: 0 });
    const tick = async () => {
      const current = watched.get(orderId);
      if (!current) return;
      current.tries += 1;
      try {
        const result = await mcp.callTool("check_order_status", { orderId }) as { order?: WatchedOrder };
        if (result.order) {
          const message = statusMessage(result.order, current.lastStatus, current.lastPayment, orderId);
          current.lastStatus = result.order.status ?? "";
          current.lastPayment = result.order.payment?.status ?? "";
          if (message) await pushReliable(current.userId, message);
          if (isTerminal(result.order.status)) {
            watched.delete(orderId);
            return;
          }
        }
      } catch (error) {
        log(`[watch] ${error instanceof Error ? error.message : error}`);
      }
      if (current.tries < 240) setTimeout(tick, 5_000);
      else watched.delete(orderId);
    };
    setTimeout(tick, 5_000);
  }

  async function handleMessage(userId: string, text: string): Promise<void> {
    const confirmation = pendingConfirm.get(userId);
    const buyerToken = buyers.get(userId)?.token;
    if (confirmation && buyerToken && !isConfirmExpired(confirmation) && isPureConfirmation(text, confirmation.confirmationText)) {
      try {
        const consentResult = await mcp.callTool("request_consent", requestConsentArgs(confirmation), buyerToken) as { consent?: { id?: string } };
        const consentId = consentResult.consent?.id;
        if (!consentId) throw new Error("consent not granted");
        const created = await mcp.callTool(
          "create_order",
          createOrderArgs(confirmation, consentId, "LINE confirm"),
          buyerToken,
        ) as { order?: { id?: string; merchantId?: string } };
        const orderId = created.order?.id;
        if (!orderId) throw new Error("order not created");
        pendingConfirm.delete(userId);
        fastPathNote.set(userId, `The buyer confirmed quote ${confirmation.quoteId} and order ${orderId} was already created. Do not create it again.`);
        watchOrder(userId, orderId);
        let reply = `Order confirmed: ${confirmation.itemName} (${confirmation.amountUsd}).`;
        try {
          const options = await mcp.callTool("get_payment_options", {
            merchantId: confirmation.merchantId,
            orderId,
          });
          reply += `\n\n${paymentBlock(options, ["line_pay", "stripe", "shopify"])}`;
        } catch (error) {
          log(`[payment] ${error instanceof Error ? error.message : error}`);
          reply += "\n\nI couldn't load the payment options. The order exists; check its status before trying again.";
        }
        await pushReliable(userId, reply);
        return;
      } catch (error) {
        if (isEtaReconfirm(error)) {
          pendingConfirm.set(userId, { ...confirmation, acceptDelay: true });
          const reason = error instanceof Error ? error.message : "The wait is longer than quoted.";
          await pushReliable(userId, `${reason}\nReply 1 to accept the longer wait, or tell me what to get instead.`);
          return;
        }
        log(`[fastpath] ${error instanceof Error ? error.message : error}`);
        pendingConfirm.delete(userId);
      }
    }

    pendingOrder.delete(userId);
    turnProof.set(userId, {});
    const { agent, buyerId } = await customerAgent(userId);
    let reply: string;
    try {
      const note = fastPathNote.get(userId);
      fastPathNote.delete(userId);
      const rawReply = await agent.send(`${note ? `[[${note}]]\n` : ""}${text}`);
      const parsed = parseEnvelope(rawReply, { conversationId: userId, buyerId, channel: "line" });
      const normalized = { ...parsed, conversationId: userId, buyerId, channel: "line" as const };
      reply = renderEnvelopeToText(clampEnvelope(normalized, turnProof.get(userId)));
    } catch (error) {
      log(`[agent] ${error instanceof Error ? error.message : error}`);
      reply = "Sorry, I couldn't complete that request. Please try again.";
    } finally {
      turnProof.delete(userId);
    }

    const created = pendingOrder.get(userId);
    if (created) {
      pendingOrder.delete(userId);
      try {
        const options = await mcp.callTool("get_payment_options", created);
        reply = `${reply.trim()}\n\n${paymentBlock(options, ["line_pay", "stripe", "shopify"])}`;
      } catch (error) {
        log(`[payment] ${error instanceof Error ? error.message : error}`);
      }
      watchOrder(userId, created.orderId);
    }
    if (reply.trim()) await pushReliable(userId, reply);
  }

  const eventDeduper = new LineEventDeduper();

  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, service: "sllr-agent-line", watching: watched.size });
    }
    if (request.method !== "POST" || url.pathname !== "/channels/line/webhook") {
      return json(response, 404, { error: "not found" });
    }

    readBody(request).then((rawBody) => {
      const header = request.headers["x-line-signature"];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!verifyLineSignature(rawBody, signature, lineConfig.channelSecret)) {
        return json(response, 401, { error: "invalid LINE signature" });
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return json(response, 400, { error: "invalid JSON" });
      }
      const messages = parseLineMessages(body).filter((message) => eventDeduper.accept(message.webhookEventId));

      json(response, 200, { accepted: messages.length });
      for (const message of messages) {
        turns.enqueue(message.userId, () => handleMessage(message.userId, message.text).catch((error) => {
          log(`[inbound] ${error instanceof Error ? error.message : error}`);
        }));
      }
    }).catch((error) => {
      const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
      json(response, status, { error: status === 413 ? "request body too large" : "request read failed" });
    });
  });

  server.listen(lineConfig.port, () => {
    log(`sllr-agent LINE server on :${lineConfig.port}`);
    log(`  backend ${config.sllrBaseUrl}`);
    log("  webhook POST /channels/line/webhook");
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 1_000_000) {
        tooLarge = true;
        data = "";
      }
    });
    request.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error("request body too large"), { status: 413 }));
      else resolve(data);
    });
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
