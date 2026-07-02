# SLL-R iMessage one-merchant pilot runbook

The exact steps to run a **single-merchant, one-rush-window, pay-at-counter-first**
iMessage pickup-order pilot. Scope is deliberately small (closure spec
`raw/inbox/2026-06-25-sllr-imessage-live-pilot-closure-spec.md`): one merchant,
one QR, ≤10 menu items, accept/reject/ready by texting 1/2/3.

> Non-goals for the pilot: POS integration, full dashboard, new payment rails,
> Solana Pay as primary, cNFT minting, multi-merchant. Don't claim any of these.

## Pieces

| Piece | What | Where |
|---|---|---|
| **Rail** | quote / order / payment-options / merchant status / receipt | `sll-r.vercel.app` (deployed) |
| **Agent** | Sendblue iMessage consumer agent | `sllr-agent/` (you host this) |
| **Merchant line** | the staff phone that gets order cards + replies 1/2/3 | Sendblue number |

## Config (sllr-agent/.env.local — never commit, never paste in chat)

```
GEMINI_API_KEY=...                      # agent LLM
SLLR_BASE_URL=https://sll-r.vercel.app  # the rail
SENDBLUE_API_KEY=...                    # Sendblue
SENDBLUE_API_SECRET=...
SENDBLUE_SIGNING_SECRET=...             # verify inbound webhooks
SLLR_SENDBLUE_NUMBER=+1...              # the agent's own iMessage number
SLLR_MERCHANT_NUMBER=+1...              # staff line for THIS pilot merchant
# OR per-merchant: SLLR_MERCHANT_CHANNELS={"raposa-coffee":"+1..."}
SLLR_AGENT_DEFAULT_MERCHANT=raposa-coffee   # scopes the Agent Card / order lane
SLLR_MERCHANT_VERIFY_TOKEN=...          # authorizes merchant 1/2/3 → canonical status
SLLR_RELAY_STORE=.sllr-relay.json       # durable pending-decision + watcher state (default shown)
```

Rail-side (Vercel), recommended for the pilot: `SLLR_ETA_RECONFIRM=true` — if the
queue-aware wait now exceeds the buyer's deadline or the quoted ETA, order
creation returns a re-confirmation prompt (`acceptDelay`) instead of silently
creating a delayed order.

Rail-side (Vercel) for receipts when a payment link is used:
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` + the Stripe dashboard webhook
(see `docs/go-live-checklist.md`). **Pay-at-counter pilot does not need Stripe.**

> `SLLR_MERCHANT_VERIFY_TOKEN`: if unset, the relay runs **demo-only** (merchant
> replies won't mutate live state unless the rail has no verifier secret). Set it
> for a real pilot. It must match the rail's `SLLR_MERCHANT_PAYMENT_VERIFY_SECRET`.

## Hosting (pick ONE — not an ad-hoc tunnel)

A rush window must not depend on a laptop sleeping or a tunnel URL changing.

1. **Named cloudflared tunnel** to the agent machine (stable hostname), or
2. **Fly/Render/VPS** running `npm run start` in `sllr-agent/`.

Either way the Sendblue inbound webhook → `https://<stable-host>/sendblue/inbound`.

## Start + health

```bash
cd /Users/jhinresh/projects/sll-r/sllr-agent
npm run check        # typecheck + contract/turn-queue/agent-card smokes must pass
npm run start        # boots the Sendblue server

curl -s https://<stable-host>/health
# → { ok, merchants: N, merchantAuth: true|false, mode: "live"|"demo-only", watching: N }
```

If `/health` is unreachable at pilot time, **do not run the pilot** — a down agent
must fail closed (no order is silently accepted). If `merchantAuth: false`
(`mode: "demo-only"`), merchant replies will NOT mutate live order state — set
`SLLR_MERCHANT_VERIFY_TOKEN` before a real merchant window.

## Demo / pilot script

1. Customer scans the merchant QR → opens an iMessage to the agent number
   (QR body may carry `merchant:<id>`; else `SLLR_AGENT_DEFAULT_MERCHANT` applies).
2. First contact runs the 3-step Agent Card setup (max/order, payment approval, avoid).
3. Customer: "I have 8 minutes — what can I get?" → agent recommends from live menu
   (fast + in budget + on-taste), shows rejected alternatives.
4. Customer confirms → order created → pickup code + (optional) pay link.
5. Staff line gets the order card → replies **1 accept / 2 reject / 3 ready**.
   - This mutates the **canonical** `SellerOrder.status` (PR #58) and the customer
     gets the matching update.
6. Customer picks up; after fulfillment the agent asks for verified feedback.

## Verify before a real merchant

```bash
cd /Users/jhinresh/projects/sll-r/sllr-agent && npm run check
cd /Users/jhinresh/projects/sll-r && pnpm build && pnpm smoke
```

Manual: create a test order from a buyer phone → from the merchant line reply
`1`, then `3`; confirm `check_order_status` shows accepted → ready and the buyer
got both updates. Reply `2` on a fresh order → buyer gets the apology, status
rejected.

## Safety / rollback

- **Stop:** kill the `npm run start` process (or scale the service to 0). With the
  agent down, no inbound is processed — fail closed, nothing auto-accepts.
- Logs should redact phone numbers / tokens; never paste either in chat or commits.
- A customer texting `1/2/3` from a non-merchant number cannot mutate state — only
  numbers in `SLLR_MERCHANT_NUMBER` / `SLLR_MERCHANT_CHANNELS` are treated as the
  merchant channel.
- Merchant replies only affect orders routed to that merchant; the rail also
  checks order/merchant ownership server-side.

## Safe outreach claim once this passes

> Customers text what they want, SLL-R quotes from your menu, creates a pickup
> order after confirmation, and staff accept/reject/mark-ready by replying 1/2/3.
> Pay-at-counter first; one short rush window.

Do not claim POS integration, autonomous settlement, live Solana Pay, cNFT
minting, or multi-location reliability.
