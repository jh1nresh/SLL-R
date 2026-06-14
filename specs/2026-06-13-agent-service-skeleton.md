# SLL-R Spec: Consumer Agent Service — Implementation Skeleton

Date: 2026-06-13
Status: proposed (implementation plan — confirm before building)

Parent spec: `specs/2026-06-13-consumer-agent-channels.md` (the consumer agent +
channel-adapter architecture). This is the concrete build plan for that agent:
file structure, LLM loop (Claude API), MCP client to SLL-R, the Sendblue
iMessage adapter + LINE adapter, and the identity store.

## What this service is

A small Node/TypeScript service — **separate from SLL-R** (SLL-R stays zero-dep;
this service has dependencies). SLL-R is the brain (MCP tools + buyer/taste
memory); this service is the **agent**: an LLM loop that converses with a
consumer on a messaging channel and calls SLL-R's MCP tools to quote, order, and
pay. New package, e.g. `sllr-agent/` (own `package.json`), deployed as its own
service (Node server on Railway/Render/Fly, or Vercel functions).

```
Consumer (iMessage / LINE)
   │  channel webhook (inbound)        channel API (outbound)
   ▼                                          ▲
ChannelAdapter (Sendblue / LINE) ──► AgentCore (Claude loop) ──► MCP client ──► SLL-R /mcp
   │                                          │  (Authorization: Bearer <buyer token>)
   └── payment: render Stripe link            └── conversation + buyer/taste memory live in SLL-R + store
```

## File structure (proposed)

```
sllr-agent/
  package.json            # deps: @anthropic-ai/sdk, stripe (optional), undici/fetch
  src/
    index.ts              # HTTP server: mounts channel webhooks + health
    config.ts             # env: ANTHROPIC_API_KEY, SLLR_BASE_URL, SENDBLUE_*, LINE_*, store
    agent/
      core.ts             # AgentCore: the Claude tool-use loop (channel-agnostic)
      systemPrompt.ts     # ordering-assistant persona + safety contract
      mcpClient.ts        # JSON-RPC client to SLL-R /mcp (initialize, tools/list, tools/call)
      conversation.ts     # per-buyer message history (load/save via store)
    identity/
      store.ts            # KV: channelUserId -> { buyerId, buyerToken }, + conversation history
      buyer.ts            # resolveBuyerId(channelUserId): mint/lookup SLL-R buyer session
    channels/
      adapter.ts          # ChannelAdapter interface (from parent spec)
      sendblue.ts         # iMessage via Sendblue: inbound webhook -> onMessage; messages.send; Stripe-link payment
      line.ts             # LINE via Messaging API (later): webhook -> onMessage; reply; LINE Pay
    payment/
      stripeLink.ts       # ask SLL-R get_payment_options(stripe) -> checkout URL to render in-thread
  README.md
```

## LLM loop — Claude API (core.ts)

- SDK: `@anthropic-ai/sdk` (`new Anthropic()` reads `ANTHROPIC_API_KEY`).
- Model: **`claude-opus-4-8`** (default per house standard), `thinking:
  {type:"adaptive"}`, `output_config:{effort:"medium"}` (chat latency; raise to
  high for harder turns). `max_tokens: 16000`. Cost lever for scale: switch to
  `claude-haiku-4-5` later if volume demands — a deliberate later decision, not
  a default downgrade.
- Tools = SLL-R's MCP tools, fetched once via `mcpClient.listTools()` and mapped
  to Claude tool defs (`{name, description, input_schema}` — SLL-R's
  `tools/list` already returns `inputSchema`).
- **Manual agentic loop** (we control it, so we can gate `attach_payment_proof`
  / `issue_receipt`, render payment links, and never auto-move money):

```ts
let messages: Anthropic.MessageParam[] = await convo.load(buyerId);
messages.push({ role: "user", content: userText });
while (true) {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    tools: sllrTools,                       // from SLL-R tools/list
    messages,
  });
  messages.push({ role: "assistant", content: res.content });
  if (res.stop_reason !== "tool_use") break;
  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const b of res.content) {
    if (b.type !== "tool_use") continue;
    // forward to SLL-R MCP with this buyer's Bearer token so orders bind to buyerId
    const out = await mcp.callTool(b.name, b.input, buyerToken);
    toolResults.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
  }
  messages.push({ role: "user", content: toolResults });
}
await convo.save(buyerId, messages);
return finalText(messages);   // the assistant's last text block -> channel adapter sendText
```

- **Safety / persona (systemPrompt.ts):** ordering assistant; before any payment
  show merchant, item, amount, rail; never call `attach_payment_proof` /
  `issue_receipt` itself (those are server/webhook-gated); only order items SLL-R
  returned (no hallucinated menu items); confirm before `create_order`.

## MCP client to SLL-R (mcpClient.ts)

SLL-R `/mcp` is stateless Streamable HTTP JSON-RPC (we built it). The client is a
thin fetch wrapper — no MCP SDK needed:
- `initialize` (once per process), `tools/list` (cache), `tools/call`.
- `callTool(name, args, buyerToken)` POSTs `{jsonrpc, id, method:"tools/call",
  params:{name, arguments}}` to `${SLLR_BASE_URL}/mcp` with
  `Authorization: Bearer <buyerToken>` (so create_order binds to the buyer) and
  `content-type: application/json`. Returns `result.structuredContent`.

## Identity store (identity/)

- `store.ts`: KV interface (same shape as SLL-R's): `channelUserId -> {buyerId,
  buyerToken}` and `buyerId -> conversation messages`. Back it with Supabase
  (reuse the project) or Upstash; memory for local dev.
- `buyer.ts` `resolveBuyerId(channelUserId)`: look up; if absent, `POST
  ${SLLR_BASE_URL}/buyer/session` → store `{buyerId, token}` keyed by
  channelUserId. So a phone number (Sendblue) or LINE userId maps to a stable
  SLL-R buyerId and the same taste memory follows them across channels.

## Sendblue iMessage adapter (channels/sendblue.ts)

- **Inbound:** Sendblue POSTs to `POST /channels/imessage/webhook` →
  `onMessage(fromNumber, text)` → `resolveBuyerId(fromNumber)` → `AgentCore.run`
  → reply.
- **Outbound:** `messages.send({ number, content })` (Sendblue REST, `$100/mo`
  line; free sandbox for dev). `sendChoices` → Sendblue quick options if
  available, else numbered text.
- **Payment:** no native Apple Pay on Sendblue → `sendPayment` posts the Stripe
  Checkout URL (from SLL-R `get_payment_options` stripe rail) as a message.
- Verify Sendblue webhook auth per their docs; rate-limited (1,000 inbound/day
  on the Agent plan) — fine for dogfood.

## LINE adapter (channels/line.ts) — second

- LINE Messaging API webhook (signature-verified) → `onMessage(lineUserId,
  text)`; reply via the reply/push API. Payment = LINE Pay URL from SLL-R
  `get_payment_options` (line_pay rail). Needs a LINE Official Account + channel
  token/secret + the LINE_PAY_* keys SLL-R already supports.

## Payment + receipt loop

1. Agent calls SLL-R `create_order` (binds to buyerId) → `get_payment_options`
   → gets the Stripe (US) or LINE Pay (TW) checkout URL.
2. Adapter renders the link in-thread; buyer pays.
3. Payment proof flows through SLL-R's existing webhooks (`/webhooks/stripe`,
   `/line-pay/confirm`) → SLL-R issues receipt memory bound to the buyerId.
4. Agent reports status (poll `check_order_status`, or SLL-R notifies — a thin
   callback the agent exposes is a later enhancement).

The agent never moves money and never issues receipts — SLL-R + the payment
provider do, exactly as today.

## Config / env

```
ANTHROPIC_API_KEY=...
SLLR_BASE_URL=https://sll-r.vercel.app
SENDBLUE_API_KEY=...           # + signing/secret per Sendblue
SENDBLUE_FROM_NUMBER=...
# LINE (second): LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET
# Store: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or Upstash), else memory
```

## Acceptance criteria (v0 = Sendblue iMessage, US)

- Text the Sendblue number "iced latte from <merchant>, pickup in 10" → agent
  quotes (merchant, item, amount, pickup promise) → "confirm?" → on confirm
  creates the order (bound to the texter's buyerId) → sends a Stripe Checkout
  link → after payment, SLL-R issues receipt; agent confirms.
- The same person texting again is recognized (phone→buyerId); `check_order_status`
  / their prior orders are available.
- The agent only orders items SLL-R returned; never calls payment-proof/receipt
  tools itself; shows merchant/item/amount before the pay link.
- AgentCore is channel-agnostic: adding the LINE adapter needs no core change.

## Sequencing
1. `mcpClient` + `AgentCore` loop (Claude tool-use over SLL-R MCP) + identity
   store + conversation history. Test against SLL-R prod with a CLI harness
   (stdin→agent→stdout) before any channel.
2. Sendblue adapter + webhook server + Stripe-link payment → dogfood by texting.
3. LINE adapter (TW) → dogfood with the founder's TW network + Louisa.
4. Wire `recommend_for_buyer` once the taste-graph spec ships.

## Out of scope (later)
- Apple Pay via official Apple MFB (MSP onboarding — ops, parallel).
- WhatsApp / web adapters (same pattern).
- Taste-graph recommendation (separate spec; the agent calls it when it exists).
- Push-style "your order is ready" from SLL-R → agent (callback) — v0 polls.

Related: `specs/2026-06-13-consumer-agent-channels.md`,
`specs/2026-06-12-buyer-auth-stripe-prepay.md`,
`specs/2026-06-13-taste-graph-recommend.md`.
