# SLL-R

SLL-R is an installable seller-side operating agent for merchants.

It lets buyer agents place real-world orders with a merchant, checks merchant
constraints, routes checkout through existing systems, and hands completed
orders to Jiagon for verified receipt memory.

The current product goal is not a hackathon-only demo. The goal is to list SLL-R
on AgentShack as a reusable merchant-agent service and onboard Raposa / SOLYD as
the first merchant pilots.

```text
BUY-R / Hermes / ChatGPT
-> SLL-R
-> POS / checkout adapters
-> payment or fulfillment proof
-> Jiagon receipt memory / Solana cNFT
```

## Product Boundary

- **SLL-R**: seller agent runtime for merchants.
- **Jiagon**: proof, receipt memory, and Solana cNFT system.
- **POS adapters**: internal SLL-R tools for Shopify, MoonPay, Binance Pay, Telegram staff flow, Browser Use, Stripe, or future POS systems.
- **BUY-R**: buyer-side agent caller. This can be Hermes, ChatGPT, Telegram, AgentShack, or another personal agent.

SLL-R is not a full POS replacement. It operates the merchant's existing checkout
and staff workflows.

## Current MVP Goal

SLL-R should be useful when a merchant wants agents to order from them without
building a custom agent stack from scratch.

Target users:

- Raposa Coffee: pickup promise, event queue, and online coffee product orders.
- SOLYD: online product quotes, checkout handoff, and payment-backed receipts.
- Noun Coffee: Base/USDC coffee storefront quote and checkout handoff.
- AgentShack builders: reusable seller-agent template for their own merchants.

MVP success means:

- SLL-R has a stable agent manifest that AgentShack can index.
- A buyer agent can ask for a quote and create an order through the API.
- The merchant can use a simple terminal or existing checkout flow to accept,
  ready, claim, or complete the order.
- A payment or fulfillment proof can become Jiagon receipt memory.
- Raposa / SOLYD can understand what they need to configure in less than one
  meeting.

## Adapter Contract

SLL-R exposes a small seller-agent runtime and keeps POS / checkout systems as
replaceable adapters:

- `staff_terminal`: Telegram or a merchant terminal that confirms fulfillment.
- `checkout_handoff`: Shopify, MoonPay Commerce, Binance Pay, or a hosted checkout link.
- `payment_proof`: webhook, Query Order, or on-chain reference verification.
- `receipt_memory`: Jiagon receipt memory and Solana cNFT handoff.

The current scaffold ships Raposa and SOLYD example profiles plus adapter
metadata in `GET /.well-known/sllr-agent.json`. Real merchant integrations can
replace the mock catalog and stubbed adapters without changing the quote/order
API contract.

## BNB / Binance Pay Rail

Binance Pay is a strong SLL-R target because it gives merchants a checkout rail,
webhooks, and an order query API that can become payment proof:

```text
SLL-R order
-> Binance Pay checkout with merchantTradeNo
-> PAY webhook
-> Query Order confirms PAID
-> fulfillment or refund proof
-> Jiagon receipt memory
```

Travala is the reference merchant vertical for this path. Travel bookings have
clear quote, checkout, confirmation, cancellation, and refund states, so they are
a good example of how SLL-R can clear real merchant work beyond cafes and
ecommerce. This repo does not claim a live Travala integration yet; it documents
the path in [Binance Pay / Travala fit](./docs/binance-pay-travala.md).

## AgentShack Listing Shape

SLL-R is packaged as an AgentShack `merchant_agent`:

```text
customer intent
-> structured order
-> merchant accept / reject / fulfill
-> payment or fulfillment proof
-> receipt memory
-> reputation update
```

The public manifest includes:

- `type`: `merchant_agent`
- `category`: `local_commerce`
- `modes`: `one_time_call`, `subscription`, `fork`
- `evaluator.policy`: `order-fulfillment-v0`
- `reputation.subjects`: `merchant`, `customer`, `agent`, `evaluator`

Use `GET /pilot-kit?merchantId=raposa-coffee` or
`GET /pilot-kit?merchantId=solyd` to generate a merchant-specific onboarding
package for the first pilot meeting.

## Run Locally

```bash
pnpm install
pnpm check
pnpm smoke
pnpm dev
```

Default server:

```text
http://localhost:3100
```

## Endpoints

```text
GET  /.well-known/sllr-agent.json
GET  /raposa
GET  /raposa/order
GET  /capabilities?merchantId=raposa-coffee
GET  /merchants
GET  /merchants/{merchantId}
GET  /merchants/{merchantId}/menu
POST /merchants/{merchantId}/quote
POST /merchants/{merchantId}/orders
GET  /merchants/{merchantId}/orders
POST /merchants/{merchantId}/payment
POST /merchants/{merchantId}/receipt
GET  /pilot-kit?merchantId=raposa-coffee
GET  /base-plugin/coffee/merchants
GET  /base-plugin/coffee/quote?merchantId=noun-coffee&intent=...
GET  /base-plugin/coffee/order?merchantId=noun-coffee&intent=...
GET  /base-plugin/coffee/prepare-payment?orderId=ord_...
GET  /base-plugin/coffee/record-demo-payment?orderId=ord_...
GET  /base-plugin/coffee/status?orderId=ord_...
POST /quote
POST /orders
GET  /orders?merchantId=raposa-coffee
GET  /orders/{orderId}
POST /orders/{orderId}/accept
POST /orders/{orderId}/reject
POST /orders/{orderId}/ready
POST /orders/{orderId}/claim
POST /orders/{orderId}/fulfill
POST /webhooks/payment
```

## Raposa Pilot Pages

Staff terminal:

```text
http://localhost:3100/raposa
```

Customer QR / order page:

```text
http://localhost:3100/raposa/order
```

The Raposa pilot keeps payment at the counter. SLL-R captures the order,
estimates the pickup promise from the active queue, lets staff accept or reject
it, marks the drink ready, and issues receipt memory after the customer claim.

## Example Quote

Merchant-scoped quote:

```bash
curl -X POST http://localhost:3100/merchants/raposa-shop/quote \
  -H "content-type: application/json" \
  -d '{
    "userIntent": "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
    "maxSpendUsd": "20.00",
    "deliverByDays": 7
  }'
```

Legacy global quote:

```bash
curl -X POST http://localhost:3100/quote \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "raposa-shop",
    "userIntent": "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
    "maxSpendUsd": "20.00",
    "deliverByDays": 7
  }'
```

## Example Base Coffee Plugin

```bash
curl "http://localhost:3100/base-plugin/coffee/quote?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7"
```

```bash
curl "http://localhost:3100/base-plugin/coffee/order?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7&agentId=base-mcp-agent"
```

`GET /base-plugin/coffee/prepare-payment` returns a checkout handoff by default.
For a Base MCP demo transaction, set `SLLR_BASE_COFFEE_RECIPIENT` to a demo EVM
address; SLL-R will return a Base USDC transfer call to that configured address.

## Example Pilot Kit

```bash
curl "http://localhost:3100/pilot-kit?merchantId=raposa-coffee"
```

```bash
curl "http://localhost:3100/pilot-kit?merchantId=solyd"
```

## Example Order

```bash
curl -X POST http://localhost:3100/merchants/raposa-shop/orders \
  -H "content-type: application/json" \
  -d '{
    "agentId": "buy-r-demo",
    "userIntent": "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
    "maxSpendUsd": "20.00",
    "deliverByDays": 7,
    "paymentMode": "checkout"
  }'
```

## Example Payment Proof

```bash
curl -X POST http://localhost:3100/merchants/raposa-shop/payment \
  -H "content-type: application/json" \
  -d '{
    "orderId": "ord_...",
    "provider": "binance_pay",
    "amountUsd": "17.95",
    "paymentId": "binance_pay_transaction_demo",
    "demo": true
  }'
```

`POST /merchants/{merchantId}/payment` binds payment proof to the path merchant.
It rejects providers that are not enabled in that merchant profile.
Production must configure `SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` and pass it in
`x-sllr-merchant-payment-secret`; `demo: true` is only for local demo proof.

## Example Merchant Terminal

```bash
curl "http://localhost:3100/orders?merchantId=raposa-coffee"
```

```bash
curl -X POST http://localhost:3100/orders/ord_.../accept \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "raposa-coffee",
    "actor": "raposa-staff",
    "note": "Can make it before pickup window."
  }'
```

```bash
curl -X POST http://localhost:3100/orders/ord_.../fulfill \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "raposa-coffee",
    "actor": "raposa-staff",
    "note": "Paid at counter and handed off."
  }'
```

Raposa promise flow:

```bash
curl -X POST http://localhost:3100/orders/ord_.../ready \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "raposa-coffee",
    "actor": "raposa-staff",
    "note": "Drink is ready."
  }'
```

```bash
curl -X POST http://localhost:3100/orders/ord_.../claim \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "raposa-coffee",
    "actor": "raposa-staff",
    "note": "Paid at counter and claimed."
  }'
```

## AgentShack Listing

Name:

```text
SLL-R by Jiagon
```

Short description:

```text
Seller agents for merchants in the agent economy.
```

What it does:

```text
SLL-R gives merchants an installable seller agent that buyer agents can quote,
order, and pay through. After payment or fulfillment proof, SLL-R calls Jiagon to
issue verified receipt memory.
```

## Pilot Docs

- [AgentShack listing spec](./docs/dojo-listing.md)
- [Binance Pay / Travala fit](./docs/binance-pay-travala.md)
- [Raposa / SOLYD pilot runbook](./docs/merchant-pilot-runbook.md)
- [AgentShack merchant pilot](./docs/agentshack-merchant-pilot.md)
- [Base MCP demo runbook](./docs/base-mcp-demo-runbook.md)
