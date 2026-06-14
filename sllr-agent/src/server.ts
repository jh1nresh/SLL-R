import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig, loadSendblueConfig } from "./config.js";
import { createAgentSession, type AgentSession } from "./core.js";
import { SendblueClient, parseInbound, verifyWebhookSecret } from "./sendblue.js";
import { OrderRelay } from "./orderRelay.js";

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

  // One agent session per customer phone number (in-memory; chat history lives
  // in-process). Orders still persist server-side in SLL-R via the buyer token.
  const customers = new Map<string, Promise<AgentSession>>();
  function customerAgent(number: string): Promise<AgentSession> {
    let session = customers.get(number);
    if (!session) {
      session = createAgentSession(config, `iMessage ${number}`, (name, _args, result) => {
        void relay.onToolResult(number, name, result).catch((e) => log(`[relay] push failed: ${e?.message || e}`));
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
    const { agent } = await customerAgent(msg.fromNumber);
    let reply: string;
    try {
      reply = await agent.send(msg.content);
    } catch (error) {
      reply = `⚠️ Sorry, something went wrong: ${error instanceof Error ? error.message : "agent error"}`;
    }
    if (reply.trim()) await sendblue.sendMessage(msg.fromNumber, reply);
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
