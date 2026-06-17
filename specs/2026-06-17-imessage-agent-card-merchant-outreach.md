# SLL-R Spec: iMessage Agent Card + Merchant Outreach + Payment Rail Upgrade

Date: 2026-06-17
Status: proposed optimization spec; do not implement until PM Gate
Owner: JhiNResH

## Why this spec exists

Recent product direction reframed SLL-R from only a seller-side merchant agent into a consumer-facing **AI text-order lane**:

```text
merchant QR
→ iMessage/SMS thread
→ lightweight Agent Card onboarding
→ natural-language order
→ live menu / wait-time recommendation
→ explicit confirmation
→ payment link or crypto checkout
→ pickup status
→ verified review / receipt memory
```

The current repo already has most of the rails, but the consumer onboarding and merchant-acquisition loop are not yet productized.

## Current code receipt

Repository inspected: `/Users/jhinresh/projects/sll-r`

Relevant existing surfaces:

- `README.md`
  - Defines SLL-R as seller-side operating agent for merchants.
  - Existing MVP targets Raposa, SOLYD, Noun Coffee, Shopify merchants, Solana rail, AgentShack listing.
  - Exposes MCP/OpenAPI and merchant/order/payment/receipt endpoints.
- `sllr-agent/README.md`
  - Defines consumer ordering agent using Gemini + SLL-R MCP.
  - Has Sendblue iMessage server flow.
  - Notes merchant `1/2/3` relay currently does **not yet mutate SLL-R order state**.
- `sllr-agent/src/core.ts`
  - Consumer agent allowlist includes buyer-facing tools only: merchants/menu/quote/order/status/recommendation.
  - Payment options are intentionally kept out of the LLM and appended deterministically after order creation.
- `sllr-agent/src/buyerStore.ts`
  - Persists `phone -> { token, buyerId }` locally.
  - This is the right seam for future `phone -> AgentCard -> buyer profile` binding.
- `sllr-agent/src/iMessageRenderer.ts`
  - Renders structured envelopes to Sendblue-friendly text.
  - Already supports `PaymentLink`, `OrderStatus`, and choice-style replies.
- `src/core/paymentOptions.ts`
  - Already supports `counter`, `shopify`, `base_usdc`, `solana_pay`/`helio`, `stripe`, `line_pay`, and setup-required rails.
  - Safety contract requires user approval and receipt proof.
- `src/adapters/solanaPay.ts`
  - Already prepares Solana Pay URL / Helio checkout handoff with order reference.
- `src/adapters/baseCoffeePlugin.ts`
  - Already has Base USDC transaction prep and checkout handoff for Base coffee demo merchants.
- `src/core/nearby.ts`
  - Can rank onboarded merchants by geo, but there is no Google Maps lead-generation/import pipeline in this repo.
- `src/types.ts`
  - Current `BuyerStore` equivalent is outside core types; no first-class `AgentCard`, `ConsumerChannel`, or merchant lead types yet.

## Current gap summary

### Already strong

```text
SLL-R brain: merchants, quotes, orders, payment options, receipts
Consumer agent: iMessage via Sendblue exists
Payment rail abstraction: Stripe / Solana Pay / Base USDC / LINE Pay / counter already modeled
Buyer identity: phone -> buyerId seam exists
```

### Missing / weak

```text
Agent Card onboarding is not first-class
Buyer preferences/constraints are inferred from past orders only, not explicit permissions
Merchant reply 1/2/3 does not mutate canonical order state yet
No Google Maps / Places lead pipeline
No merchant lead scoring / outreach packet generator for non-crypto merchants
No channel-specific payment rendering policy for iMessage beyond generic text links
No spec for when to show Stripe vs Solana Pay vs Base Pay in iMessage
No verified review follow-up loop in the iMessage agent flow
```

## Product decision

Add a first-class **SLL-R Agent Card** concept.

Do **not** issue a real Visa/Mastercard card in v0. The Agent Card is a bounded spend/order authorization object:

```text
who: channel user / buyerId
where: merchant scope
how much: max per order
what: allowed categories + constraints
when: expiry / event context
payment: available rails + confirmation policy
memory: permission to store verified taste/review memory
```

It should feel like:

```text
Set up my AI ordering permissions for this shop.
```

Not like:

```text
Fill KYC form / open fintech account.
```

## User flow: QR → iMessage Agent Card → order

### Entry

Merchant places QR at counter / window / event table:

```text
Scan to text your order
```

QR goes to either:

```text
sms:+15551234567?body=start%20merchant%3A<merchantId>
```

or preferably:

```text
https://sllr.app/m/<merchantSlug>
```

The web handoff page can offer:

```text
Continue by iMessage/SMS
Continue by Telegram/Hermes demo
Continue in web chat
```

Reason: `sms:` prefilled body is inconsistent across iOS/Android, and the web handoff also works for QR attribution and merchant analytics.

### First-message onboarding

SLL-R should reply:

```text
Hi — I’m <Merchant Name>’s AI order lane.
Before I recommend/order, I’ll set up your Agent Card for this shop.

1/3 Max per order?
1 $10
2 $15
3 $25
4 Ask every time
```

Then:

```text
2/3 Payment approval?
1 Ask before every payment
2 Allow <$10 today only
3 Order draft only, I’ll pay at counter
```

Then:

```text
3/3 Anything to avoid?
1 Too spicy
2 Caffeine
3 Dairy
4 None
```

Optional follow-up after first fulfilled order:

```text
Can I remember your verified feedback for better recommendations next time?
1 Yes
2 No
```

### Agent Card confirmation

```text
✅ Agent Card ready for <Merchant Name>
- Max: $15/order
- Payment: ask before every payment
- Avoid: caffeine
- Goal: recommend items available now and under your time limit

Try: “I have 8 minutes. What can I get?”
```

## Proposed data model

### `AgentCard`

Add to core types first; persistence can be file/Supabase later.

```ts
export type AgentCard = {
  id: string;
  buyerId: string;
  channel: "imessage" | "sms" | "line" | "web" | "telegram";
  channelUserId: string;
  merchantId: string;
  status: "draft" | "active" | "revoked";
  maxAmountUsd: string | null;
  requiresConfirmation: "always" | "above_limit" | "never_for_today";
  expiresAt: string | null;
  constraints: {
    avoid: string[];
    allergies?: string[];
    preferredWaitMinutes?: number | null;
  };
  paymentRailPreference: Array<"stripe" | "counter" | "solana_pay" | "base_usdc" | "line_pay">;
  reviewMemoryConsent: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### `MerchantLead`

For Google Maps prospecting:

```ts
export type MerchantLead = {
  id: string;
  source: "google_maps" | "manual" | "referral";
  name: string;
  address: string;
  placeId?: string;
  website?: string;
  phone?: string;
  category: "boba" | "coffee" | "cafe" | "sports_bar" | "food_truck" | "restaurant";
  geo?: { lat: number; lng: number };
  signals: {
    hasLineRisk?: boolean;              // visible queues / rush fit from reviews/photos/manual note
    pickupFriendly?: boolean;
    menuSimpleEnough?: boolean;
    independentMerchant?: boolean;
    hasOnlineOrdering?: boolean;
    likelyOwnerOperated?: boolean;
    eventProximity?: string[];          // stadium, campus, fan zone, venue
    cryptoNative?: boolean;
  };
  score: number;
  status: "new" | "shortlisted" | "contacted" | "interested" | "rejected" | "pilot";
  notes?: string;
};
```

## iMessage payment rail policy

Yes, SLL-R can later send Solana Pay checkout or Base Pay/Base USDC checkout inside iMessage.

For Sendblue/iMessage v0, it is just text links / deep links. The rail does not have to be native iMessage Apple Pay.

### Rail order for US iMessage pilots

Default per merchant:

1. `counter` — safest for first conversation and merchant adoption.
2. `stripe` — easiest non-crypto paid proof.
3. `solana_pay` / `helio` — for Solana-native or crypto-friendly pilots.
4. `base_usdc` / Base Pay-style handoff — for Base/Noun Coffee/crypto-native pilots.
5. `shopify` — if merchant already has Shopify products/cart.

### Render rules

Before sending any payment link, SLL-R must show:

```text
Merchant
Item
Amount
ETA / pickup promise
Payment rail
Refund/issue note if applicable
```

Then require explicit user confirmation unless Agent Card says otherwise.

Example:

```text
Confirm order?
- Noun Coffee
- The usual, iced
- $7.50
- Ready in ~8 min
- Pay via Base USDC link

Reply 1 to confirm, 2 to change.
```

After confirm:

```text
Pay with Base USDC:
<base/coinbase-wallet/pay link or SLL-R tx page>
```

or:

```text
Pay with Solana Pay:
<solana:... deep link>
```

If a raw `solana:` URI is unreliable in SMS clients, wrap it in an SLL-R hosted payment page:

```text
https://sllr.app/pay/<orderId>
```

That page can display:

```text
Open Phantom / Backpack
Copy Solana Pay URL
Pay by Stripe instead
Pay at counter instead
```

## Merchant order-state gap

Current `sllr-agent/README.md` says merchant `1/2/3` reply is relay-only and does not mutate SLL-R order state.

This blocks the real verified review loop.

### Required fix before live pilot

Add a merchant status mutation path:

```text
merchant iMessage reply 1 accept
→ SLL-R order.status = accepted

reply 2 ready
→ order.status = ready
→ customer notified

reply 3 reject / sold out
→ order.status = rejected
→ customer offered substitution/refund path
```

Possible implementation seams:

- `OrderRelay.applyDecision` in `sllr-agent/src/orderRelay.ts`
- New SLL-R MCP tool for merchant status update, gated by merchant token
- Existing HTTP terminal endpoint if present can be called from the relay

Acceptance gate:

```text
merchant reply changes canonical `SellerOrder.status`, not just customer text.
```

## Verified review / receipt follow-up

After an order reaches `claimed` or `fulfilled`, iMessage agent should ask:

```text
Was it ready on time?
1 Yes
2 No, late

How was it?
1 Good, repeat
2 Too sweet/spicy/etc
3 Would not repeat
```

This should produce:

```text
verifiedOutcomeReview
- buyerId
- merchantId
- orderId
- payment/proof level
- promisedReadyAt
- readyAt
- claimedAt
- feedback
- futureRecommendationNote
```

Do not publish raw review text publicly by default. Store as buyer/merchant memory and later expose redacted aggregate reliability.

## Google Maps merchant acquisition

### Why Google Maps matters

Crypto-native merchants such as Raposa and Noun Coffee are good demo partners, but they bias SLL-R toward crypto rails. The stronger startup proof is non-crypto local merchants with a visible rush/queue problem.

### Target merchant types near Irvine / LA / OC

Prioritize:

```text
boba shops
independent cafes
campus cafes
sports bars / watch-party venues
food trucks
quick-service restaurants near event venues
```

Avoid first:

```text
large chains
POS-locked franchises
high-compliance alcohol-heavy bars as first pilot
restaurants with huge/complex menus
places without pickup workflow
```

### Search queries

Use Google Maps manually or via Places API later:

```text
"boba near UC Irvine"
"coffee shop near UC Irvine"
"cafe near Irvine Spectrum"
"boba near Anaheim Convention Center"
"sports bar Irvine World Cup"
"sports bar Costa Mesa soccer"
"food truck near Irvine"
"Vietnamese coffee Orange County"
"Taiwanese cafe Orange County"
"matcha cafe Costa Mesa"
```

For World Cup / game-day wedge:

```text
"sports bar World Cup watch party Orange County"
"soccer bar Orange County"
"bar near Angel Stadium World Cup"
"cafe near watch party Irvine"
```

### Lead scoring

Score 0–5 for each:

| Signal | Why it matters |
|---|---|
| Visible queue / rush mentions in reviews | SLL-R pain is strongest |
| Simple drink/food menu | Easy first agent ordering |
| Pickup/takeout already common | Less behavior change |
| Independent or owner-operated | Easier pilot decision |
| Instagram/website active | Can reach owner/operator |
| Near campus/event/fan-zone | Better time-pressure wedge |
| Reviews mention wait/confusion/sold-out | Direct pain proof |
| Existing Stripe/Square/Toast/Shopify links | Easier payment/order handoff |

Shortlist only merchants scoring `>= 24/40`.

### Outreach script

Do **not** pitch “agent OS.” Pitch the queue/order pain.

SMS/Instagram/Email DM:

```text
Hi <name> — I’m building a small AI text-order lane for busy cafes/boba shops in OC.

Customers scan a QR, text “I have 8 minutes, what can I get?”, and the system replies using your live menu/wait-time. Staff only get a clean order card + pickup code.

No POS replacement. You can start with pay-at-counter. Free pilot for 1 day during a rush window.

Would you be open to a 10-min demo? I can set up your menu and QR for you.
```

If they are event/sports-bar oriented:

```text
For game-day rush, customers can ask what is fastest before kickoff/halftime. You mark accepted/ready by texting 1/2/3.
```

### Pilot offer

Lowest-friction pilot:

```text
1 merchant
1 QR code
10 menu items
2-hour rush window
pay at counter first
merchant replies 1 accept / 2 ready / 3 sold out
20 orders or 1 day max
end with receipt/review summary
```

Do not require Stripe/Solana/Base on day one unless the merchant already wants it.

## Crypto-native pilots: Raposa / Noun Coffee

Use them for:

```text
Solana Pay / Helio demo
Base USDC demo
crypto community proof
hackathon narrative
```

But do not use them as proof that normal merchants want crypto checkout.

For normal merchants:

```text
pay-at-counter or Stripe first
crypto rail later as optional payment option
```

## Implementation phases

### Phase 0 — Spec-only / PM Gate

- Confirm this spec.
- Pick one merchant segment: boba/cafe near Irvine, or game-day sports bar.
- Pick payment mode for pilot: default `counter`, optional `stripe`.

### Phase 1 — Agent Card local state

Add:

```text
AgentCard type
AgentCardStore keyed by channelUserId + merchantId
onboarding state machine in sllr-agent
Sendblue renderer for quick-choice onboarding
```

Acceptance:

```text
First inbound message creates/resumes Agent Card onboarding.
Returning user skips onboarding unless card revoked/expired.
Agent prompts include card constraints.
```

### Phase 2 — Merchant status mutation

Add canonical order updates from merchant 1/2/3 reply.

Acceptance:

```text
Merchant reply changes SellerOrder.status and customer can query status.
Ready notification includes pickup code.
```

### Phase 3 — Verified review follow-up

Add post-fulfilled feedback prompts and store verified review memory.

Acceptance:

```text
Only fulfilled/claimed orders create review memory.
Review contains ETA accuracy + repeat intent.
Returning recommendations can cite prior verified outcome.
```

### Phase 4 — Payment page abstraction

Add `/pay/<orderId>` hosted page or API response wrapper for channel-safe payment rendering.

Acceptance:

```text
iMessage can send one SLL-R pay URL that offers Stripe, Solana Pay, Base USDC, or counter fallback based on merchant rails.
No raw payment link is sent before explicit confirmation.
```

### Phase 5 — Google Maps lead pipeline

Add a script or notebook, not production API first:

```text
scripts/merchant-leads/google-maps-import.ts
```

Input can start as CSV exported/manual from Google Maps:

```text
name,address,category,website,phone,notes
```

Output:

```text
raw/merchant-leads/<date>-oc-cafes.json
shortlist.md
outreach.csv
```

Acceptance:

```text
At least 30 leads scored.
Top 10 shortlist produced.
3 outreach messages drafted.
No unsolicited sending from code.
```

## Acceptance criteria for next engineering task

Before implementation starts, PM Gate must choose:

- target merchant profile (`boba/cafe`, `sports bar`, or `crypto-native coffee`);
- channel (`Sendblue iMessage` first, or web fallback);
- payment rail (`counter`, `stripe`, `solana_pay`, `base_usdc`);
- persistence backend (`local JSON`, `Supabase`, or repo store);
- verification command (`pnpm check` plus `sllr-agent` smoke).

Minimum verification after code changes:

```bash
cd /Users/jhinresh/projects/sll-r
pnpm check
cd sllr-agent
npm run build
npm run test || true  # if tests are not defined, document skipped reason
```

## Positioning update

Short merchant-facing line:

> Customers scan a QR and text what they want. SLL-R tells them what is fastest, sends clean order cards to staff, and gives pickup codes.

Short agent-infra line:

> SLL-R turns local merchants into agent-readable order endpoints with live state, safe payment options, and verified outcome memory.

Short consumer line:

> Set your AI order card once, then text “I have 8 minutes — what can I get?”

## Non-goals

- Do not become a general iMessage assistant.
- Do not issue real credit/debit cards in v0.
- Do not require merchants to accept stablecoins.
- Do not require Apple Messages for Business before pilot.
- Do not auto-pay without explicit confirmation.
- Do not publish raw customer feedback publicly.
- Do not scrape Google Maps against terms; use manual research or official Places API if automated.
