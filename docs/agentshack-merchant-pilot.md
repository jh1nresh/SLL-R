# AgentShack Merchant Pilot: SLL-R

SLL-R should be offered to Raposa and SOLYD as a merchant agent, not as a POS
replacement.

## What They Use

They use SLL-R as a hosted or self-hosted seller agent endpoint:

```text
buyer/customer agent
-> SLL-R quote
-> SLL-R order
-> merchant terminal accept/reject/fulfill
-> existing payment or checkout
-> Jiagon receipt memory
-> AgentShack reputation
```

## What Raposa Uses First

Start with `raposa-coffee`.

Flow:

```text
customer scans QR or buyer agent calls API
-> asks for coffee within budget/time
-> SLL-R creates a structured pickup order
-> Raposa sees the order queue
-> staff accepts
-> customer pays at counter
-> staff marks fulfilled
-> receipt memory is issued
```

Why this is low-friction:

- Raposa keeps its counter payment flow.
- No POS migration.
- Staff only needs an order queue and fulfill action.
- The receipt proves a real purchase/fulfillment event.

Pilot endpoint:

```text
GET /pilot-kit?merchantId=raposa-coffee
```

## What SOLYD Uses First

Start with `solyd`.

Flow:

```text
buyer agent asks for a compatible product
-> SLL-R quotes product/price/stock/shipping estimate
-> SLL-R creates an order
-> checkout is handled by existing ecommerce/payment rail
-> webhook or manual fulfillment confirms proof
-> receipt memory is issued
```

Why this is low-friction:

- SOLYD keeps its current checkout.
- SLL-R only exposes catalog and order handoff first.
- Payment-backed receipts can be added after webhook access.

Pilot endpoint:

```text
GET /pilot-kit?merchantId=solyd
```

## Meeting Ask

Ask each merchant for:

- approved catalog/menu snapshot
- prices, variants, stock, and prep/shipping estimates
- staff terminal preference
- checkout/payment rail
- receipt claim preference

Do not ask for a full POS integration in the first meeting.

## AgentShack Fit

SLL-R is a first-class AgentShack listing because every completed run creates a
receipt-worthy outcome:

```text
order + merchant acceptance + fulfillment/payment proof + receipt hash
```

That receipt can later feed:

- merchant reputation
- customer verified-consumption history
- review eligibility
- agent/service completion rate
- future clearing, refunds, disputes, or settlement
