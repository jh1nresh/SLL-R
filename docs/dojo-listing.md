# AgentShack Listing Spec

## Listing

Name:

```text
SLL-R by Jiagon
```

Short description:

```text
Seller agents that let merchants quote, accept, and prove orders from buyer agents.
```

Category:

```text
Merchant agents / agent commerce infrastructure
```

## Buyer

Merchants that already sell through a website, checkout link, Telegram, Shopify,
MoonPay Commerce, Binance Pay, or a lightweight staff workflow and want to
become reachable by buyer agents.

## Promise

SLL-R gives a merchant an installable seller operating agent. Buyer agents can
call SLL-R to discover capabilities, request quotes, create orders, and receive
verified receipt memory after payment or fulfillment proof.

## Why AgentShack

AgentShack should list SLL-R as an agent service and install template:

- Hosted service: Jiagon runs SLL-R for early merchants.
- Self-hosted template: merchants or builders fork the runtime and configure
  their own catalog, checkout, and webhook adapters.
- Workflow primitive: other AgentShack agents can call SLL-R instead of building a
  merchant-specific ordering flow.

## Install Surface

The minimum install should ask for:

- merchant name and slug
- fulfillment modes: pickup, shipping, or both
- catalog source: static config, Shopify, or custom API
- checkout/payment source: counter, Shopify, MoonPay, Stripe, Solana Pay, or
  Binance Pay
- receipt destination: Jiagon API URL and API key
- staff notification channel: Telegram group or merchant terminal

For Binance Pay, install must also collect API credentials, webhook public-key
verification material, and a merchant order mapping rule for `merchantTradeNo`.

## Public Manifest

SLL-R exposes:

```text
GET /.well-known/sllr-agent.json
```

The manifest advertises:

- service role
- quote/order/payment endpoints
- supported merchants
- supported checkout adapters
- required environment variables
- receipt handoff capability

The manifest should expose Binance Pay as a planned payment-proof adapter, not a
live integration, until SLL-R has production merchant credentials and can verify
webhook signatures plus Query Order responses.

## Done Criteria For AgentShack Listing

- An AgentShack worker can read the manifest and understand how to call SLL-R.
- A merchant can install a static catalog profile without editing core runtime
  code.
- A buyer agent can run quote -> order -> payment proof -> receipt memory.
- Stubbed adapters are clearly marked and do not pretend to be live
  integrations.
- Binance Pay receipts only upgrade after SLL-R confirms the order through Query
  Order, even if a webhook arrived first.
