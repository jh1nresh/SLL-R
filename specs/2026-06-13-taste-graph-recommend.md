# SLL-R Spec: Taste Graph + Cross-Merchant Recommendation + Agent layer

Date: 2026-06-13
Status: proposed (spec only — north-star; implement after deploy + data accrual)

## Why

This is the turn from "order bot" (commodity, disintermediable) to "consumption
identity + recommendation network" (compounding moat). The killer use case:

> Knows you ordered 四季春茶 at Louisa → you want a drink, no Louisa nearby →
> you're next to 50嵐 → recommends 50嵐's 四季春珍波椰.

No single chain can do this — Louisa only knows your Louisa orders, 50嵐 only
knows yours there. Only the cross-merchant layer transfers taste from one
merchant to another, and the taste data is **receipt-verified** (you actually
bought it), not a self-reported survey. That verified cross-merchant taste graph
is the moat. It also turns recommendation into **demand routing** — the
agent-era shelf space merchants pay for.

Builds on the already-shipped substrate: buyer sessions bind orders + receipts
to a stable `buyerId` (`listOrdersForBuyer`). That is the raw taste log.

## Architecture: MCP server vs agent (the key distinction)

- **SLL-R (MCP server) = backend / brain.** Tools + the taste memory. Memory
  lives here, keyed by `buyerId`, server-side. Does NOT converse.
- **Agent = the thing the user talks to** (ChatGPT, Claude, or a LINE bot we
  build). Holds the conversation, does taste reasoning, calls SLL-R tools.

Memory is in SLL-R, not the agent — that is why ANY agent authenticating as the
buyer remembers them (cross-agent, cross-merchant, receipt-verified), unlike a
single app's private memory.

Two product shapes, not mutually exclusive ("same system, two entrances"):
- **Shape A — infra:** users bring their own agent (ChatGPT/Claude) + SLL-R MCP.
- **Shape B — consumer agent:** we build a LINE bot (LLM loop + SLL-R MCP client
  + buyer session) that IS the assistant living in LINE. "SLL-R in LINE" = this
  bot. SLL-R is the brain, the LINE bot is the face.

Identity continuity: the LINE bot maps **LINE userId → buyerId** server-side, so
the user never handles a token and the same buyerId follows them across LINE and
ChatGPT.

Division of labor:
- LLM (agent): conversation + taste inference ("you like 四季春, 50嵐's
  四季春珍波椰 fits").
- SLL-R (MCP): verified history (what you actually bought), candidate set
  (nearby merchants + menus + geo). Recommendation is grounded in SLL-R data,
  reasoned by the LLM.

## Three data pieces needed (on top of the existing buyerId/receipt substrate)

1. **Item taxonomy / attributes.** To match "四季春" across merchants, items need
   structured attributes (tea_base, toppings, sweetness, milk, temperature,
   category). `CatalogItem.tags` exists as a start; add a typed `attributes` map.
2. **Merchant geo.** lat/lng (or area) per merchant so "near me / no Louisa
   nearby / next to 50嵐" works. Add to `MerchantProfile`. Customer location
   comes from the agent (LINE can share location; ChatGPT can be told).
3. **Taste profile derivation.** From the buyer's receipt history, derive a
   profile (e.g. weighted attribute preferences: tea_base=四季春, sweetness=低糖,
   topping=珍珠). Computed on read from `listOrdersForBuyer`, not a separate store
   to start.

## `recommend_for_buyer` MCP tool (interface)

```
recommend_for_buyer({
  // buyerId comes from the validated session (Authorization: Bearer), never args
  location?: { lat: number, lng: number } | { area: string },
  radiusKm?: number,        // default e.g. 2
  category?: string,        // optional filter, e.g. "drink"
  maxResults?: number,      // default 3
}) -> {
  tasteSummary: string,                 // human-readable, e.g. "likes 四季春, 低糖, 珍珠"
  basedOnReceipts: number,              // how many verified orders informed this
  recommendations: Array<{
    merchantId, merchantName, distanceKm,
    itemId, itemName, amountUsd,
    why: string,                        // "matches your 四季春 + 珍珠 history at Louisa"
    matchedAttributes: string[],
    sponsored?: boolean,                // demand-routing placement (see monetization)
  }>
}
```

Server returns the grounded candidate set + match rationale; the agent renders
it conversationally. If the buyer has no session/history, fall back to
merchant-popular items (cold start).

## Monetization (why this is a company, not a bot)

- **Demand routing / sponsored substitute.** When SLL-R recommends 50嵐 because
  Louisa isn't nearby, that is SLL-R directing demand. Merchants pay to be the
  recommended substitute / for placement (`sponsored` flag) — the agent-era
  Google/Yelp Ads. Must be labeled; organic match quality protects trust.
- **Retention / switching cost.** The more it knows you, the stickier. Reinforces
  the take-rate (Stripe/LINE Pay) and SaaS layers already specced.

## Acceptance criteria (when implemented)

- A buyer with ≥1 receipt gets `recommend_for_buyer` results that cite real
  prior items and surface nearby merchants' equivalent items by shared
  attributes. Cold-start (no history) returns popular items, clearly flagged.
- buyerId is derived only from the validated session, never from args (same
  rule as create_order).
- Recommendations are grounded: every `why` references real receipt history +
  real catalog attributes (no hallucinated items — the agent only picks from the
  server-returned candidate set).
- `sponsored` placements are labeled.
- LINE bot (Shape B): a LINE userId resolves to a stable buyerId; ordering +
  recommendation work in-thread; LINE Pay closes the loop.

## Sequencing (recommendation)

1. Deploy current main (buyer auth live → receipts start binding to buyerIds =
   data accrual begins). NOTHING here works without data.
2. Add item `attributes` + merchant `geo` (data model).
3. `recommend_for_buyer` tool (logic over the receipt graph).
4. LINE bot agent (Shape B) + LINE userId→buyerId linking (the consumer surface).
5. `sponsored` demand-routing placement (monetization) — last.

## Out of scope (later)
- A persisted/materialized taste-profile store (start with on-read derivation).
- ML ranking — start with attribute-overlap + recency heuristics.
- Cross-buyer collaborative filtering ("people like you").

## Positioning guard
One layer up from "order bot": **cross-merchant taste memory + recommendation,
backed by verified receipts.** Do NOT inflate to a universal consumption-identity
protocol. v1 = "it remembers what drinks you like and suggests the right one at a
nearby shop." TruCritic-v2 lineage.

Related: brain `wiki/decisions/2026-06-12-sllr-aggregation-layer-vs-chain-mcp.md`,
`wiki/decisions/2026-04-25-consumption-identity-protocol.md`,
`specs/2026-06-12-buyer-auth-stripe-prepay.md`.
