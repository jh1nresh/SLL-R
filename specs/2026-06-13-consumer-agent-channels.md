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

## Market context (drives channel order)

The founder is a Taiwanese person based in the US, so the two target channels
are their own daily life and network: **iMessage (US) + LINE (Taiwan)** — ideal
for dogfooding. Each consumer channel must be paired with merchants in the same
market:
- **US side:** merchant acquisition via Google Maps Places (`sllr_places_lead_search.py`,
  140 cafe leads) → consumers on **iMessage**.
- **Taiwan side:** Taiwan merchants (Louisa demo exists; add more drink shops) →
  consumers on **LINE**.

Hard asymmetry that sets the build order:
- **LINE = buildable now** (open Messaging API, direct webhook). LINE Pay
  in-thread. Immediately dogfoodable with the founder's TW network + Louisa.
- **iMessage / Apple Messages for Business = ops-gated.** Apple offers no direct
  API: you MUST go through an Apple-approved MSP + an Experience Review approval.
  Native Apple Pay in-thread (great), but you cannot code the adapter until MSP +
  Apple access lands. So iMessage is started as an ops/approval task in parallel,
  built when access arrives.
- **Web chat** (Stripe Checkout) = optional interim/fallback that works today and
  doubles as the merchant-outreach demo while iMessage approval is pending.
  Skippable if LINE already covers live dogfooding.
- **WhatsApp** = later (non-Apple US / Europe / LatAm).

## Architecture

```
SLL-R (MCP server) = brain: tools + taste memory keyed by buyerId
        ▲ MCP (Streamable HTTP, Bearer = buyer session)
        │
Consumer Agent (LLM host): conversation + taste reasoning; calls SLL-R tools
        │  (channel-agnostic core)
        ├── LINE adapter        → LINE Pay      (BUILD FIRST: open API, TW, dogfood)
        ├── iMessage adapter    → Apple Pay     (ops-gated: needs MSP + Apple review)
        ├── Web adapter         → Stripe Checkout (optional interim + merchant demo)
        └── WhatsApp adapter    → Stripe link   (later)

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

## Acceptance criteria (v0 = LINE adapter, Taiwan)

- A consumer messages the SLL-R LINE Official Account (no install beyond "add
  friend", no MCP), orders a drink from a Taiwan merchant (e.g. Louisa) in
  natural language, sees a quote + pickup promise, confirms, pays via LINE Pay
  in-thread, and the order appears in the merchant terminal already-paid; receipt
  memory issues and binds to a buyerId.
- The agent core is channel-agnostic: the LINE adapter implements ChannelAdapter;
  adding iMessage later requires no change to the agent core.
- The agent only orders items SLL-R returned (no hallucinated menu items).
- A returning consumer (same LINE userId → buyerId) sees their prior orders.

## Sequencing
1. Agent core (LLM loop + SLL-R MCP client + buyer-session identity) + the
   ChannelAdapter abstraction.
2. **LINE adapter + LINE Pay** (open API, build now; dogfood with TW network +
   Louisa). Requires LINE_PAY_* keys for live payment (demo otherwise).
3. **In parallel (ops, not code): start iMessage onboarding** — pick an
   Apple-approved MSP, register on Apple Business Register, begin Experience
   Review. Build the iMessage adapter (Apple Pay) when access lands.
4. Optional: web adapter + Stripe Checkout as an interim/merchant-demo surface.
5. WhatsApp later — same pattern.

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
