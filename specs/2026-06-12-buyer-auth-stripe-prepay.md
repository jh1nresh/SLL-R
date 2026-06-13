# SLL-R Spec: Buyer Auth + Stripe Prepay-in-Flow

Date: 2026-06-12
Status: proposed (spec only — confirm before implementing)

## Why now

Luckin Coffee shipped a first-party AI ordering platform (~2026-06-09): MCP
Server + CLI + Skill, streamable HTTP at `gwmcp.lkcoffee.com`, Bearer token
bound to the user's Luckin account, full-flow payment via Alipay MCP.
McDonald's also announced MCP support. The "order coffee via an AI agent"
thesis is now validated by the category leader.

SLL-R does not compete with a chain's first-party MCP. SLL-R is the
**seller-side aggregation + trust layer** for every merchant that cannot build
their own: one MCP fronting many merchants, plus a cross-merchant verified
receipt / membership layer no single chain can build. See repositioning:
`brain/wiki/decisions/2026-06-12-sllr-aggregation-layer-vs-chain-mcp.md`.

## Revenue model (this is a business, not a free proxy)

An MCP is an interface, not a product. SLL-R is the transaction + demand + trust
network for agent commerce; the money is:

1. **Take-rate on transactions (primary):** every paid order through SLL-R
   earns a platform fee via Stripe Connect `application_fee_amount`. This is the
   reason Stripe matters — not "let them pay" but "we earn when they pay through
   us." Guards against disintermediation: SLL-R must be IN the money flow, not a
   free forwarder a merchant can cut out by wiring their own Shopify MCP.
2. **Merchant SaaS (secondary):** monthly fee to be agent-orderable + dashboard
   + receipt analytics (Shopify-app model).
3. **Demand routing / placement (the moat money, later):** when agents are the
   ordering surface, "which café the agent picks" is the new shelf space; sell
   it. Powered by the cross-merchant receipt/identity graph.

**Sequencing decision (2026-06-12):** v0 ships prepay **no-fee** (platform
account, hosted Checkout) to prove the agent→pay→receipt flow fast; the prepay
mechanics are identical with or without a fee, so this is not wasted. **Stripe
Connect + `application_fee_amount` is the immediate next PR** and is what turns
revenue on. Build v0 fee-ready (structure the charge so adding Connect +
application fee is a thin change, not a rewrite).

Two capabilities are the concrete enablers and are the next build step:

1. **Buyer auth/session** — bind orders and receipts to a buyer identity (what
   Luckin's account binding gives them). Prerequisite for "my orders",
   cross-merchant receipt history, and portable membership (Layer 2 moat).
2. **Stripe prepay-in-flow** — a non-crypto, pay-at-order rail so any café is
   "Luckin-smooth": the buyer pays inside the agent flow; the merchant only
   fulfills and never touches money. Answers the #1 merchant objection
   (counter-pay is clunky; crypto excludes normal stores).

## Acceptance criteria

### Buyer auth/session
- A buyer (agent user) can obtain a session token and present it as a Bearer
  token on `/mcp` and the buyer-facing REST endpoints.
- Orders created with a buyer token are bound to a stable `buyerId`.
- A buyer can list "my orders" / receipts across merchants via their token.
- Tokens are revocable and expire (mirror Luckin's ~30-day session retention).
- Backward compatible: anonymous/demo ordering still works when no token is
  supplied (gated behind a flag so production can require auth).
- Receipts issued for a buyer-bound order record the `buyerId` (foundation for
  the cross-merchant identity layer).

### Stripe prepay-in-flow
- The `stripe` payment rail becomes real (currently a `setup_required` stub in
  `paymentOptions.ts`).
- `prepare-payment` for `stripe` creates a Stripe Checkout Session (hosted,
  supports card + Apple/Google Pay) bound to the SLL-R order, and returns the
  checkout URL.
- A signed `POST /webhooks/stripe` (`checkout.session.completed` /
  `payment_intent.succeeded`) verifies the Stripe signature and calls the
  existing `attachPaymentProof({ provider: "stripe", ... })`, which issues
  receipt memory — same path as the Shopify paid webhook.
- The merchant terminal shows the order as already-paid; staff only fulfill
  (Luckin model: store never handles payment).
- Amount + currency are verified against the order subtotal before proof.
- `demo=true` local path remains for testing without live Stripe.

## Verification
- `pnpm check` (build + smoke) green, with smoke covering: buyer token issue →
  authed order → "my orders" lists it; Stripe prepare-payment returns a
  checkout URL; a signed (fake) Stripe webhook issues receipt memory; bad
  signature rejected; amount-below-subtotal rejected.
- Smoke must use an in-process fake Stripe (no live keys), mirroring the fake
  Upstash / Supabase / PostgREST servers already in `smoke.ts`.

## Harness
- State surface: `GET /buyer/orders` (authed), `GET /health`, smoke output.
- Execution surface: `pnpm check`; MCP Inspector CLI for the authed `/mcp` path.
- Convergence: smoke green + Inspector handshake with a Bearer token.
- Human boundary: do NOT take live payments in tests; live Stripe keys are a
  deploy-time action, not part of this spec's implementation.

## Design notes / decisions to lock
- **Buyer token shape (v0):** issue an opaque session token server-side
  (`POST /buyer/session` returns a token + buyerId); store buyer records in the
  same KV/Supabase store (`sllr:buyer:<id>`). Per-agent API keys are acceptable
  for v0; full OAuth/device-code is deferred.
- **Stripe account model (v0):** single platform Stripe account + hosted
  Checkout for the demo/pilot; funds settle to the merchant out-of-band.
  Stripe Connect destination charges (merchant gets paid directly) is the
  Phase-2 upgrade, deferred — not in v0 scope.
- **Env:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Keep zero-runtime-dep
  ethos: call the Stripe REST API over `fetch` (no `stripe` SDK) unless the SDK
  proves necessary.
- **Receipt → identity:** buyer-bound receipts are the seam to the Layer-2
  cross-merchant consumption identity / membership. This spec only lays the
  `buyerId` foundation; the identity/membership product is a separate spec.

## Out of scope (later specs)
- Stripe Connect per-merchant payouts + `application_fee_amount` take-rate —
  the IMMEDIATE next PR (turns revenue on); v0 is built fee-ready for it.
- Cross-merchant membership/loyalty program and consumption-identity API.
- Per-merchant staff secrets (multi-merchant receipt-gating isolation) — known
  follow-up, tracked separately.
- Telegram/printer order-intake push for merchants (separate spec).

## Suggested labels
`spec`, `enhancement`, `payments`, `auth`
