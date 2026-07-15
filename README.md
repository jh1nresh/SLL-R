# SLL-R

SLL-R is a merchant-backed commerce rail that personal agents can call.

It lets a buyer's own agent compare real merchant capabilities, obtain exact
quotes, ask for consent, place and track orders through existing checkout
systems, and turn completed outcomes into verified receipt memory.

The current product goal is not a hackathon-only demo. The goal is to list SLL-R
on AgentShack as a reusable merchant-agent service and onboard Raposa / SOLYD as
the first merchant pilots.

```text
Personal agent / Hermes / ChatGPT
-> SLL-R
-> compare merchant-backed quotes
-> explicit buyer consent
-> POS / checkout adapters
-> payment or fulfillment proof
-> SLL-R receipt memory / Solana cNFT
```

## Product Boundary

- **SLL-R**: merchant runtime plus the safe cross-merchant interface personal agents call.
- **Receipt memory**: proof-backed order, payment, and fulfillment record.
- **POS adapters**: internal SLL-R tools for Shopify, MoonPay, Binance Pay, Telegram staff flow, Browser Use, Stripe, or future POS systems.
- **Personal agent**: buyer-side caller. This can be Hermes, ChatGPT, Telegram, AgentShack, or another user-owned agent.

SLL-R is not a full POS replacement. It operates the merchant's existing checkout
and staff workflows.

## Current MVP Goal

SLL-R should be useful when a merchant wants agents to order from them without
building a custom agent stack from scratch.

Target users:

- Raposa Coffee: pickup promise, event queue, and online coffee product orders.
- SOLYD: online product quotes, checkout handoff, and payment-backed receipts.
- Noun Coffee: Base/USDC coffee storefront quote and checkout handoff.
- Shopify merchants: Noun Coffee, Raposa Shop, and SOLYD can expose Storefront
  MCP / cart handoff / paid-order webhook proof without replacing checkout.
- Content-commerce merchants: Changbaishan Rice-style grocery sellers can map
  product stories to Shopify SKUs, checkout, and receipt memory.
- Raposa / SOLYD Solana rail: Solana Pay URL or Helio checkout handoff with
  payment proof promoted into SLL-R receipt memory.
- AgentShack builders: reusable seller-agent template for their own merchants.

MVP success means:

- SLL-R has a stable agent manifest that AgentShack can index.
- ChatGPT, Hermes, Base MCP, and similar agents can discover the API through
  OpenAPI and tool manifests.
- A buyer agent can ask for a quote and create an order through the API.
- The merchant can use a simple terminal or existing checkout flow to accept,
  ready, claim, or complete the order.
- A payment or fulfillment proof can become SLL-R receipt memory.
- Raposa / SOLYD can understand what they need to configure in less than one
  meeting.

The primary agent flow is:

```text
personal agent receives natural-language intent
-> SLL-R shop_for_me compares bounded merchant candidates
-> merchant-backed quotes ranked by intent, receipt memory, location, time, and price
-> user confirms one exact quote
-> SLL-R consent + idempotent order
-> existing checkout or staff fulfillment
-> cross-merchant tracking
-> verified receipt memory improves the next recommendation
```

The standalone merchant agent remains available for QR/web pilots. MCP,
OpenAPI, and ChatGPT Actions expose the same commerce rail to personal agents.
The consumer agent also has iMessage and LINE Messaging transports; both reuse
the same quote-bound consent, order, payment-option, status, and receipt state.

## Adapter Contract

SLL-R exposes a small seller-agent runtime and keeps POS / checkout systems as
replaceable adapters:

- `staff_terminal`: Telegram or a merchant terminal that confirms fulfillment.
- `checkout_handoff`: Shopify, MoonPay Commerce, Binance Pay, or a hosted checkout link.
- `payment_proof`: webhook, Query Order, Solana Pay reference, Helio, or on-chain verification.
- `receipt_memory`: SLL-R receipt memory and Solana cNFT handoff.

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
-> SLL-R receipt memory
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

## State & Persistence

SLL-R stores orders and runtime demo merchants through a small key-value
abstraction with three backends (selection order: Supabase → Redis/KV → memory):

- **memory** (default): in-process. Survives for the process lifetime only.
  Fine for local dev, a single long-running process (Railway/Render/Fly), and
  demo recordings.
- **supabase**: Supabase Postgres via the PostgREST HTTP API (zero SDK
  dependency). Create two tables then set `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` — see [Supabase store runbook](./docs/supabase-store-runbook.md).
- **redis_rest**: Vercel KV / Upstash Redis over the REST API (zero SDK
  dependency). Configure `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or the
  `UPSTASH_REDIS_REST_*` equivalents).

Either durable backend is required for **serverless** (Vercel), where each
invocation is a fresh instance, and for horizontal scale.
`GET /health` reports the active backend: `{ "ok": true, "store": "supabase" }`.

Receipt memory is gated: set `SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` so only the
merchant can issue receipts (and verify payment proof). See [env.example](./env.example).

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

## Connect As MCP

SLL-R exposes a real MCP server (stateless Streamable HTTP) at `/mcp`:

```bash
claude mcp add --transport http sllr http://localhost:3100/mcp
```

Tools: `list_merchants`, `get_merchant`, `get_menu`, `shop_for_me`, `quote_order`,
`create_order`, `list_orders`, `check_order_status`, `get_payment_options`,
`attach_payment_proof`, `issue_receipt`, `create_demo_merchant`.

Payment safety is enforced server-side: `attach_payment_proof` requires the
merchant verifier secret (`verificationToken`) in production and only accepts
`demo: true` when no secret is configured. See
[SLL-R MCP runbook](./docs/sllr-mcp-runbook.md).

## Endpoints

```text
POST /mcp
GET  /.well-known/sllr-agent.json
GET  /.well-known/sllr-mcp.json
GET  /.well-known/ai-plugin.json
GET  /.well-known/base-mcp-plugin.md
GET  /.well-known/solana-sllr-plugin.md
GET  /openapi.json
POST /buyer/session
POST /buyer/shop
GET  /buyer/orders
GET  /raposa
GET  /raposa/order
GET  /capabilities?merchantId=raposa-coffee
GET  /agent/{merchantId}
POST /agent/{merchantId}/message
GET  /terminal/{merchantId}
GET  /merchants
GET  /merchants/{merchantId}
GET  /merchants/{merchantId}/menu
POST /merchants/{merchantId}/quote
POST /merchants/{merchantId}/orders
GET  /merchants/{merchantId}/orders
POST /merchants/{merchantId}/payment-options
POST /merchants/{merchantId}/payment
POST /merchants/{merchantId}/receipt
GET  /demo-merchants
POST /demo-merchants
GET  /shopify/merchants
GET  /shopify/merchants/{merchantId}/connect
GET  /shopify/merchants/{merchantId}/products
POST /shopify/merchants/{merchantId}/cart
POST /webhooks/shopify/orders-paid
POST /webhooks/shopify/orders-fulfilled
POST /webhooks/shopify/refunds-create
GET  /pilot-kit?merchantId=raposa-coffee
GET  /base-plugin/coffee/merchants
GET  /base-plugin/coffee/quote?merchantId=noun-coffee&intent=...
GET  /base-plugin/coffee/order?merchantId=noun-coffee&intent=...
GET  /base-plugin/coffee/prepare-payment?orderId=ord_...
GET  /base-plugin/coffee/record-demo-payment?orderId=ord_...
GET  /base-plugin/coffee/status?orderId=ord_...
GET  /solana-pay/merchants
GET  /solana-pay/prepare-payment?orderId=ord_...
POST /solana-pay/verify-payment
POST /webhooks/helio
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

## Standalone Agentic POS Pages

Customer ordering agent:

```text
http://localhost:3100/agent/noun-coffee
http://localhost:3100/agent/raposa-coffee
```

Merchant terminal:

```text
http://localhost:3100/terminal/noun-coffee
http://localhost:3100/terminal/raposa-coffee
```

The first standalone agent uses deterministic intent parsing instead of an LLM.
It supports simple demo intents such as:

```text
I want Dalat Highlands coffee beans under $40.
I need an iced latte within 10 minutes.
```

The API behind the page is:

```bash
curl -X POST http://localhost:3100/agent/noun-coffee/message \
  -H "content-type: application/json" \
  -d '{
    "message": "I want Dalat Highlands coffee beans under $40."
  }'
```

Send `confirm=true` to create the order after reviewing the quote.

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

## Example Demo Merchant Ingestion

Turn any public Shopify storefront into a quotable SLL-R demo merchant from
its `products.json` feed — no merchant setup required. This powers the
"60-second demo with your actual menu" outreach flow:

```bash
curl -X POST http://localhost:3100/demo-merchants \
  -H "content-type: application/json" \
  -d '{
    "storeDomain": "panthercoffee.com",
    "name": "Panther Coffee",
    "category": "coffee_shop",
    "location": "Miami",
    "fulfillment": "shipping"
  }'
```

The response includes the agent page, terminal page, and an example MCP
prompt. The same flow is exposed as the `create_demo_merchant` MCP tool.
Demo merchants get `counter` + `shopify` payment rails, live in memory, and
reset on restart. Public registration is disabled unless
`SLLR_DEMO_MERCHANT_SECRET` is configured; an existing demo merchant id cannot
be replaced through this endpoint.

## Example Shopify Adapter

Shopify is the preferred live merchant integration path for Noun Coffee, Raposa,
and SOLYD. SLL-R should use Shopify Storefront MCP / Storefront API for catalog
and cart, then Shopify webhooks for paid and fulfilled proof.

```bash
curl "http://localhost:3100/shopify/merchants"
```

```bash
curl "http://localhost:3100/shopify/merchants/noun-coffee/connect"
```

```bash
curl -X POST http://localhost:3100/shopify/merchants/noun-coffee/cart \
  -H "content-type: application/json" \
  -d '{"itemId":"dalat-highlands"}'
```

Production webhook proof requires `SLLR_SHOPIFY_WEBHOOK_SECRET` and the raw
Shopify request body. Local demos can use `demo=true`; production should not.

## Example Solana Pay / Helio Rail

Raposa and SOLYD expose `solana_pay` capability. If `SLLR_SOLANA_PAY_RECIPIENT`
is configured, SLL-R returns a Solana Pay URL bound to the SLL-R order reference.
If `SLLR_HELIO_CHECKOUT_BASE_URL` is configured, SLL-R also returns a Helio /
MoonPay Commerce checkout handoff.

```bash
curl "http://localhost:3100/solana-pay/merchants"
```

```bash
curl -X POST http://localhost:3100/orders \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "solyd",
    "agentId": "buy-r-demo",
    "userIntent": "Ship me a black MagSafe iPhone 16 case under $100",
    "maxSpendUsd": "100.00",
    "deliverByDays": 7,
    "paymentMode": "crypto"
  }'
```

```bash
curl "http://localhost:3100/solana-pay/prepare-payment?orderId=ord_..."
```

For a local demo proof without a verifier secret:

```bash
curl -X POST http://localhost:3100/solana-pay/verify-payment \
  -H "content-type: application/json" \
  -d '{
    "orderId": "ord_...",
    "merchantId": "solyd",
    "provider": "solana_pay",
    "amountUsd": "79.00",
    "paymentId": "solana_tx_demo",
    "reference": "reference_from_prepare_payment",
    "demo": true
  }'
```

Production must configure `SLLR_SOLANA_PAY_VERIFY_SECRET` or
`SLLR_HELIO_WEBHOOK_SECRET` and verify the transaction or webhook before issuing
receipt memory.

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
    "note": "Paid at counter and handed off.",
    "demo": true
  }'
```

`fulfill`, `claim`, and `POST /merchants/{merchantId}/receipt` issue receipt
memory, so they require the same verifier as payment proof: configure
`SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` and pass it in
`x-sllr-merchant-payment-secret` (the terminal pages read it from
`localStorage.sllrStaffSecret`); `demo: true` is only accepted when no secret
is configured.

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
    "note": "Paid at counter and claimed.",
    "demo": true
  }'
```

## AgentShack Listing

Name:

```text
SLL-R
```

Short description:

```text
Seller agents for merchants in the agent economy.
```

What it does:

```text
SLL-R gives merchants an installable seller agent that buyer agents can quote,
order, and pay through. After payment or fulfillment proof, SLL-R issues
verified receipt memory.
```

## Pilot Docs

- [AgentShack listing spec](./docs/dojo-listing.md)
- [Binance Pay / Travala fit](./docs/binance-pay-travala.md)
- [Raposa / SOLYD pilot runbook](./docs/merchant-pilot-runbook.md)
- [AgentShack merchant pilot](./docs/agentshack-merchant-pilot.md)
- [Base MCP demo runbook](./docs/base-mcp-demo-runbook.md)
