# sllr-agent

Consumer ordering agent for SLL-R. An LLM (Gemini) converses with a buyer and
calls SLL-R's MCP tools to quote, order, and pay. SLL-R is the brain (merchants,
order state, payment, receipts, buyer/taste memory); this service is the agent
that talks to consumers.

**Step 1** is a CLI harness that validates the brain (Gemini + SLL-R MCP).
**Step 2** is the Sendblue iMessage server — customers text in, the merchant gets
the order on iMessage and replies `1/2/3`. Both drive the same `AgentCore`;
iMessage / LINE are just transports.

## Architecture

```
You (CLI / later: iMessage, LINE)
  → AgentCore (Gemini loop)  ← src/core.ts, llm-gemini.ts
  → MCP client               ← src/mcp.ts  (POST sll-r/.../mcp, buyer Bearer token)
  → SLL-R                    (quote / order / payment options / receipt, bound to buyerId)
```

The LLM is behind `LlmAgent` (`src/llm.ts`) so the provider is swappable
(Gemini now, Claude later). The agent is given only buyer-facing SLL-R tools
(no payment-proof / receipt / merchant-setup tools — those are gated server
actions).

## Run (CLI)

```bash
cd sllr-agent
npm install
export GEMINI_API_KEY=...          # from https://aistudio.google.com
# optional: export SLLR_BASE_URL=https://sll-r.vercel.app   (default)
#           export GEMINI_MODEL=gemini-2.5-flash             (default)
npm run cli
```

Then chat:

```
you ▸ I want an iced latte from Raposa, ready in 10 minutes
sll-r ▸ Found Iced latte ($6.50) at Raposa Coffee, ready in ~7 min. Confirm to order?
you ▸ yes
sll-r ▸ Order placed. Pay at the counter on pickup. ...
```

Orders bind to a buyer session (printed at startup), so "what did I order before?"
works across the conversation.

## Run (Sendblue iMessage server)

```bash
cd sllr-agent
npm install
cp .env.example .env.local        # fill in GEMINI + SENDBLUE keys + SLLR_MERCHANT_NUMBER
set -a; source .env.local; set +a
npm run server                    # listens on :8787, POST /sendblue/inbound
```

Expose `:8787` publicly (e.g. `ngrok http 8787` or deploy to Railway/Render) and
point your **Sendblue webhook** (dashboard → Settings → Webhooks) at
`https://<host>/sendblue/inbound`.

Flow:

```
Customer iMessage ─▶ /sendblue/inbound ─▶ AgentCore (Gemini + SLL-R) ─▶ reply iMessage
                                              │ create_order
                                              ▼
                         Merchant iMessage ◀─ "🆕 cold brew $5.75, code 34CF58, reply 1/2/3"
                         Merchant replies 1 ─▶ relay ─▶ "✅ accepted" iMessage to customer
```

> **v0 note:** the merchant `1/2/3` reply is a channel relay — it messages the
> customer but does not yet mutate SLL-R order state (`OrderRelay.applyDecision`
> is the seam for a future merchant order-status MCP tool). Single merchant
> number; multi-merchant routing is a follow-up.

## Env

| Var | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | required (`GOOGLE_API_KEY` also accepted) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | swap for a newer/larger model |
| `SLLR_BASE_URL` | `https://sll-r.vercel.app` | the live SLL-R backend |
| `SENDBLUE_API_KEY_ID` / `SENDBLUE_API_SECRET` | — | required for `npm run server` |
| `SENDBLUE_FROM_NUMBER` | Sendblue default | optional sender number |
| `SENDBLUE_WEBHOOK_SECRET` | — | optional; if set, inbound webhook must present it |
| `SLLR_MERCHANT_NUMBER` | — | merchant iMessage number for order push (blank = push off) |
| `PORT` | `8787` | server port |

## Next (not in this step)
- Merchant decision → SLL-R order state (a merchant order-status MCP tool).
- LINE adapter (LINE Pay) for Taiwan. Stripe-link payment in the order flow.
- Multi-merchant number routing; persist chat history across restarts.
See `specs/2026-06-13-agent-service-skeleton.md`.
