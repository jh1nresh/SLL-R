# sllr-agent

Consumer ordering agent for SLL-R. An LLM (Gemini) converses with a buyer and
calls SLL-R's MCP tools to quote, order, and pay. SLL-R is the brain (merchants,
order state, payment, receipts, buyer/taste memory); this service is the agent
that talks to consumers.

This is **step 1**: a CLI harness that validates the brain (Gemini + SLL-R MCP)
before any messaging channel. Channel adapters (Sendblue iMessage, then LINE)
come next — they drive the same `AgentCore`.

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

## Env

| Var | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | required (`GOOGLE_API_KEY` also accepted) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | swap for a newer/larger model |
| `SLLR_BASE_URL` | `https://sll-r.vercel.app` | the live SLL-R backend |

## Next (not in this step)
- Sendblue iMessage adapter (inbound webhook → AgentCore → `messages.send`).
- Merchant approval-by-message (push order to the merchant's iMessage; reply 1/2/3).
- LINE adapter (LINE Pay). Stripe-link payment.
See `specs/2026-06-13-agent-service-skeleton.md`.
