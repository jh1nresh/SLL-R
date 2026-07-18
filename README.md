# SLL-R

**Merchant-backed order execution for AI agents.**

SLL-R lets a buyer's agent move from natural-language intent to a real merchant
order without inventing the SKU, price, availability, or pickup promise. It
binds an exact quote to buyer consent, reserves merchant capacity, creates one
idempotent order, streams live queue state through short polling, and issues a
canonical receipt only after fulfillment or customer claim.

```text
buyer agent
→ merchant-backed catalog and exact quote
→ quote-bound buyer consent
→ idempotent order and capacity reservation
→ existing checkout or staff terminal
→ live queue and order status
→ payment proof ≠ fulfillment proof
→ canonical fulfillment-backed receipt
```

SLL-R is an MCP and HTTP commerce rail, not a replacement POS and not a
hackathon-only chatbot. Merchants keep their existing checkout and staff
workflow; personal agents get one bounded interface for quoting, ordering, and
tracking the outcome.

## The Problem

AI agents can recommend products, but they cannot safely promise that a real
merchant can fulfill an order now. A static menu does not answer:

- Is this SKU real and currently available?
- Is the price and pickup ETA still valid?
- Did the buyer approve this exact quote?
- Will a retry create a duplicate order?
- How many orders are ahead in the merchant's production queue?
- Does a payment event prove payment only, or actual fulfillment?
- Can the buyer verify the final outcome without seeing another buyer's order?

SLL-R turns those questions into explicit server-side state and authorization
boundaries instead of leaving them to an agent prompt.

## What Works Today

- **Grounded commerce:** merchant-backed catalogs, fixed offers, exact quotes,
  availability checks, and bounded cross-merchant recommendations.
- **Safe execution:** buyer sessions, quote-bound consent, idempotency keys, and
  atomic 15-minute capacity reservations by production class.
- **Live local fulfillment:** queue position, orders ahead, promised pickup time,
  merchant accept/reject/ready actions, and buyer status updates every two seconds.
- **Notifications:** in-page updates are guaranteed while the page is open;
  browser notifications are optional and require user permission. iMessage and
  LINE transports reuse the same canonical order state.
- **Proof separation:** payment proof advances payment state only. Merchant
  fulfillment or customer claim is required for the final receipt.
- **Tenant boundaries:** buyer-owned reads are scoped to the buyer session;
  merchant order feeds and mutations require operator or merchant-scoped auth.
- **Replaceable adapters:** staff terminal, Shopify/hosted checkout handoff,
  Stripe, Solana Pay, Base USDC, Helio/MoonPay Commerce, and Binance Pay surfaces.

The repository ships example Raposa, SOLYD, and Noun Coffee profiles. They are
demo/pilot configurations, not claims of live commercial partnerships.

## Try the End-to-End Demo

Run SLL-R, then open two browser windows:

| Role | URL | What to do |
| --- | --- | --- |
| Buyer | `http://localhost:3100/raposa/order` | Quote, consent, order, watch queue/status, receive ready update, view receipt |
| Merchant | `http://localhost:3100/raposa` | See the order, accept it, mark it ready, then record claim/fulfillment |

The visible flow is:

```text
quote → consent → order → Queue #N → accepted → ready → claimed → receipt_issued
```

For a no-secret localhost demo, merchant proof actions accept `demo: true` only
when `SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` is not configured. Any shared or
public deployment must configure that secret or issue merchant-scoped tokens.

## Connect an Agent over MCP

SLL-R exposes a stateless Streamable HTTP MCP server at `/mcp`:

```bash
claude mcp add --transport http sllr http://localhost:3100/mcp
```

The intended buyer flow is:

```text
list_merchants / shop_for_me
→ quote_order
→ request_consent
→ create_order
→ get_payment_options
→ check_order_status
```

`list_orders` and merchant mutations are not public buyer tools. They require
the operator verifier secret or a token scoped to the target merchant.

## Architecture

```text
Hermes / ChatGPT / OKX.AI / another personal agent
                         │
                  MCP + OpenAPI
                         │
              ┌──────────▼──────────┐
              │    SLL-R runtime    │
              │ quote / consent     │
              │ capacity / order    │
              │ payment / receipt   │
              └──────┬────────┬─────┘
                     │        │
             buyer status   merchant terminal
                     │        │
                     └── checkout / POS adapters
```

The same canonical order record drives MCP, REST, buyer pages, merchant
terminals, webhooks, and messaging transports. The UI does not maintain a
second queue or fulfillment state.

## Safety Invariants

1. Catalog items and prices come from merchant-authorized data.
2. Consent is bound to the exact quote and its freshness window.
3. Reusing an idempotency key cannot create a second semantic order.
4. Capacity reservation is atomic; quote inspection alone does not hold seats.
5. Payment proof never implies fulfillment.
6. A terminal receipt is issued only once after proof-backed completion.
7. Buyer A cannot read Buyer B's buyer-bound order.
8. Public agents cannot list merchant queues or perform merchant mutations.

See [the MCP runbook](./docs/sllr-mcp-runbook.md) for the full execution and
authorization contract.

## Product Boundary and Current Status

SLL-R currently proves the technical workflow locally and through automated
smoke tests. It does **not** yet claim:

- a public production deployment or OKX.AI ASP listing;
- validated merchant willingness to pay;
- production partnerships with the bundled example merchants;
- that a checkout or payment event alone proves fulfillment;
- production-ready scale on the default in-memory store.

The next product proof is one permissioned merchant completing real orders
through the same quote → queue → fulfillment → receipt path.

## State and Persistence

Storage backend selection is Supabase → Redis REST/KV → memory:

- **memory** is the default and is suitable for local development or one
  long-running demo process. It resets on restart.
- **Supabase** uses PostgREST without an SDK. See the
  [Supabase store runbook](./docs/supabase-store-runbook.md).
- **Redis REST/KV** supports Vercel KV and Upstash-compatible credentials.

A durable backend is required for serverless or horizontally scaled deployment.
`GET /health` reports the selected store. Production must also set
`SLLR_MERCHANT_PAYMENT_VERIFY_SECRET`; see [env.example](./env.example).

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

## MCP Tool Reference

Buyer tools include `list_merchants`, `get_merchant`, `get_menu`, `list_offers`,
`quote_offer`, `list_capacity_windows`, `shop_for_me`, `quote_order`,
`request_consent`, `create_order`, `check_order_status`, and
`get_payment_options`. Merchant-authorized tools include `list_orders`,
fulfillment batches, payment-proof attachment, availability changes, and final
receipt issuance.

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
GET  /merchants/{merchantId}/offers
POST /merchants/{merchantId}/offers/{offerId}/quote
GET  /merchants/{merchantId}/capacity
GET  /merchants/{merchantId}/batches
POST /merchants/{merchantId}/batches
GET  /merchants/{merchantId}/batches/{batchId}
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
export SLLR_DEMO_MERCHANT_SECRET="replace-with-your-configured-secret"
curl -X POST http://localhost:3100/demo-merchants \
  -H "content-type: application/json" \
  -H "x-sllr-demo-secret: $SLLR_DEMO_MERCHANT_SECRET" \
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
Demo merchants get `counter` + `shopify` payment rails and persist through the
configured SLL-R store; the default memory backend resets on restart. Public
registration is disabled unless `SLLR_DEMO_MERCHANT_SECRET` is configured; an
existing demo merchant id cannot be replaced through this endpoint. On
localhost only, leaving the secret unconfigured permits the same request
without the secret header. Non-local
origins reject registration when no secret is configured.

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
  -H "x-sllr-merchant-payment-secret: $SLLR_MERCHANT_PAYMENT_VERIFY_SECRET" \
  -d '{
    "merchantId": "raposa-coffee",
    "actor": "raposa-staff",
    "note": "Paid at counter and handed off."
  }'
```

`fulfill`, `claim`, and `POST /merchants/{merchantId}/receipt` issue final
receipt memory, so they require the merchant verifier: configure
`SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` and pass it in
`x-sllr-merchant-payment-secret` (the terminal pages read it from
`localStorage.sllrStaffSecret`).

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
  -H "x-sllr-merchant-payment-secret: $SLLR_MERCHANT_PAYMENT_VERIFY_SECRET" \
  -d '{
    "merchantId": "raposa-coffee",
    "actor": "raposa-staff",
    "note": "Paid at counter and claimed."
  }'
```

The merchant-scoped receipt endpoint uses the same verifier:

```bash
curl -X POST http://localhost:3100/merchants/raposa-coffee/receipt \
  -H "content-type: application/json" \
  -H "x-sllr-merchant-payment-secret: $SLLR_MERCHANT_PAYMENT_VERIFY_SECRET" \
  -d '{
    "orderId": "ord_...",
    "actor": "raposa-staff",
    "note": "Merchant fulfillment confirmed."
  }'
```

For a no-secret localhost demo only, omit the verifier header and include
`"demo": true` in the JSON body sent to any of those three endpoints. Demo
mode is rejected when `SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` is configured:

```bash
curl -X POST http://localhost:3100/orders/ord_.../fulfill \
  -H "content-type: application/json" \
  -d '{"merchantId":"raposa-coffee","actor":"local-demo","demo":true}'

curl -X POST http://localhost:3100/orders/ord_.../claim \
  -H "content-type: application/json" \
  -d '{"merchantId":"raposa-coffee","actor":"local-demo","demo":true}'

curl -X POST http://localhost:3100/merchants/raposa-coffee/receipt \
  -H "content-type: application/json" \
  -d '{"orderId":"ord_...","actor":"local-demo","demo":true}'
```

## AgentShack Listing

Name:

```text
SLL-R
```

Short description:

```text
Merchant-backed order execution for AI agents.
```

What it does:

```text
SLL-R lets buyer agents obtain exact merchant-backed quotes, bind buyer consent,
reserve capacity, create idempotent orders, and track fulfillment through the
merchant's existing checkout and staff workflow. Payment proof advances payment
state only; a canonical receipt requires merchant fulfillment or customer claim.
```

## Pilot Docs

- [AgentShack listing spec](./docs/dojo-listing.md)
- [Binance Pay / Travala fit](./docs/binance-pay-travala.md)
- [Raposa / SOLYD pilot runbook](./docs/merchant-pilot-runbook.md)
- [AgentShack merchant pilot](./docs/agentshack-merchant-pilot.md)
- [Base MCP demo runbook](./docs/base-mcp-demo-runbook.md)
