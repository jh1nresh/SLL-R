# SLL-R Spec: Consumer Agent + Channel Adapters

Date: 2026-06-13
Status: proposed (spec only — confirm before implementing)

## Problem

Connecting SLL-R's MCP server to ChatGPT/Claude is a power-user action — a
normal coffee customer will never do it. That entrance is for developers,
power users, and other agents (high leverage, low volume). To reach actual
consumers we need a **zero-setup ordering agent that lives where the user
already is, with in-thread payment.**

SLL-R (the MCP server) is the brain: merchants, quote, order, payment proof,
receipt, buyer taste memory. It does not converse. This spec defines the
**consumer agent** — an LLM host that calls SLL-R's MCP tools — and a
**channel-adapter** layer so the same agent reaches users through web,
iMessage, WhatsApp, or LINE without redesign.

## Market context (drives the first channel)

Launch market = **US** (merchant acquisition via Google Maps Places — the
existing `sllr_places_lead_search.py` lead engine; 140 cafe leads). US consumers
do not use LINE. So:
- **Google Maps = merchant acquisition** (find + outreach to cafes). Already built.
- **First consumer channel = web chat** (open, instant, Stripe Checkout) — also
  doubles as the per-merchant demo we send in outreach.
- **iMessage / Apple Messages for Business** = the US premium channel (native
  Apple Pay in-thread, list/time pickers) but requires an Apple-approved MSP +
  Experience Review → slower, so it comes after web.
- **LINE** (LINE Pay in-thread) = parked for a future Taiwan launch.
- **WhatsApp** = later, for non-Apple US / Europe / LatAm.

## Architecture

```
SLL-R (MCP server) = brain: tools + taste memory keyed by buyerId
        ▲ MCP (Streamable HTTP, Bearer = buyer session)
        │
Consumer Agent (LLM host): conversation + taste reasoning; calls SLL-R tools
        │  (channel-agnostic core)
        ├── Web adapter        → Stripe Checkout      (FIRST: US, open, fast)
        ├── iMessage adapter    → Apple Pay            (US premium; via MSP, gated)
        ├── WhatsApp adapter    → Stripe link          (later)
        └── LINE adapter        → LINE Pay             (parked: Taiwan)

Also still available, unchanged: ChatGPT / Claude connect SLL-R MCP directly
(developer / power-user / interop entrance).
```

- **MCP is NOT "installed into" a messaging app.** Messaging apps are transports,
  not LLM hosts. The agent (our service) is the MCP host; the channel is its
  face. iMessage's adapter additionally goes through an MSP (Apple constraint).
- **Division of labor:** the agent's LLM reasons + converses (taste inference,
  "you like X, try Y nearby") and only picks from SLL-R-returned data; SLL-R
  grounds it (real merchants, real menus, verified receipts, payment, geo). No
  hallucinated items — the agent orders only from the candidate set SLL-R returns.

## Channel adapter interface (normalize every channel to this)

```
interface ChannelAdapter {
  channel: "web" | "imessage" | "whatsapp" | "line"
  // inbound: channel delivers a user message + a stable channel user id
  onMessage(channelUserId: string, text: string, location?: GeoPoint): void
  // outbound: agent sends text + optional rich elements
  sendText(channelUserId, text): Promise<void>
  sendChoices(channelUserId, choices): Promise<void>          // quick replies / list picker
  // payment: render the channel's native in-thread payment for an order
  sendPayment(channelUserId, order, paymentOption): Promise<void>
  // identity: map a channel user to a stable SLL-R buyerId (issue on first contact)
  resolveBuyerId(channelUserId): Promise<string>
}
```

- The agent core is written once against this interface. Adding a channel = one
  adapter; the LLM loop, SLL-R tool calls, and taste logic are unchanged.
- **Identity:** each adapter maps its channel user id → a stable SLL-R `buyerId`
  (issue a buyer session on first contact, store the mapping). So taste memory
  follows the user, and the same person on web today + iMessage tomorrow is one
  buyerId. Web uses a cookie/session; iMessage uses the Business Chat opaque id;
  LINE uses LINE userId.
- **Payment per channel:** web→Stripe Checkout URL, iMessage→Apple Pay sheet,
  LINE→LINE Pay URL, WhatsApp→Stripe link. The order/receipt path in SLL-R is
  identical; only the in-thread payment rendering differs.

## Agent core behavior

1. Resolve buyerId from the channel adapter (taste memory available).
2. Parse intent; call SLL-R `quote_order` / `list_merchants` / (`recommend_for_buyer`
   when the taste layer ships).
3. Present options + the pickup promise; ask to confirm.
4. On confirm: `create_order`, then `get_payment_options`, render the channel's
   in-thread payment.
5. On payment proof (Stripe/Apple Pay/LINE Pay webhook/confirm) → SLL-R issues
   receipt memory → feeds the buyer's taste graph.
6. Always show merchant, item, amount, payment rail before payment approval
   (existing SLL-R safety contract).

## Acceptance criteria (v0 = web adapter, US)

- A consumer opens a merchant's web chat link (no install, no MCP), orders in
  natural language, sees a quote + pickup promise, confirms, pays via Stripe
  Checkout, and the order appears in the merchant terminal already-paid; receipt
  memory issues and binds to a buyerId.
- The agent core is channel-agnostic: the web adapter implements ChannelAdapter;
  adding iMessage/LINE later requires no change to the agent core.
- The agent only orders items SLL-R returned (no hallucinated menu items).
- Returning consumer (same web session/buyerId) sees their prior orders.

## Sequencing
1. Agent core (LLM loop + SLL-R MCP client + buyer-session identity) + the
   ChannelAdapter abstraction.
2. **Web adapter + Stripe Checkout** (US MVP; also the outreach demo).
3. Deploy; point a merchant's QR / link at it (Google Maps leads).
4. iMessage / Apple Messages for Business adapter (Apple Pay) — needs an MSP +
   Experience Review; start the approval in parallel.
5. WhatsApp, then LINE (Taiwan) adapters — same pattern.

## Out of scope (later specs)
- The taste-graph / `recommend_for_buyer` layer (separate spec
  `2026-06-13-taste-graph-recommend.md`); the agent calls it once it exists.
- Stripe Connect take-rate (separate; v0 web uses no-fee checkout).
- MSP selection + Apple Business Register onboarding (ops task, not code).

## Positioning guard
This is the **consumer entrance** to SLL-R. MCP stays the developer/interop
entrance. Don't conflate them: MCP is not how you acquire a coffee customer; the
channel agent is. Same SLL-R brain, many faces.

Related: `specs/2026-06-12-buyer-auth-stripe-prepay.md`,
`specs/2026-06-13-taste-graph-recommend.md`,
brain `wiki/decisions/2026-06-12-sllr-aggregation-layer-vs-chain-mcp.md`.
