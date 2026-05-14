# SLL-R

SLL-R is an installable seller-side operating agent for merchants.

It lets buyer agents place real-world orders with a merchant, checks merchant
constraints, routes checkout through existing systems, and hands completed
orders to Jiagon for verified receipt memory.

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
- **POS adapters**: internal SLL-R tools for Shopify, MoonPay, Telegram staff flow, Browser Use, Stripe, or future POS systems.
- **BUY-R**: buyer-side agent caller. This can be Hermes, ChatGPT, Telegram, Dojo, or another personal agent.

SLL-R is not a full POS replacement. It operates the merchant's existing checkout
and staff workflows.

## Adapter Contract

SLL-R exposes a small seller-agent runtime and keeps POS / checkout systems as
replaceable adapters:

- `staff_terminal`: Telegram or a merchant terminal that confirms fulfillment.
- `checkout_handoff`: Shopify, MoonPay Commerce, or a hosted checkout link.
- `payment_proof`: webhook or on-chain reference verification.
- `receipt_memory`: Jiagon receipt memory and Solana cNFT handoff.

The current scaffold ships Raposa and SOLYD example profiles plus adapter
metadata in `GET /.well-known/sllr-agent.json`. Real merchant integrations can
replace the mock catalog and stubbed adapters without changing the quote/order
API contract.

## Run Locally

```bash
pnpm install
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
GET  /capabilities?merchantId=raposa-coffee
POST /quote
POST /orders
POST /webhooks/payment
```

## Example Quote

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

## Example Order

```bash
curl -X POST http://localhost:3100/orders \
  -H "content-type: application/json" \
  -d '{
    "merchantId": "raposa-shop",
    "agentId": "buy-r-demo",
    "userIntent": "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
    "maxSpendUsd": "20.00",
    "deliverByDays": 7,
    "paymentMode": "checkout"
  }'
```

## Example Payment Proof

```bash
curl -X POST http://localhost:3100/webhooks/payment \
  -H "content-type: application/json" \
  -d '{
    "orderId": "ord_...",
    "merchantId": "raposa-shop",
    "provider": "moonpay",
    "amountUsd": "17.95",
    "paymentId": "pay_demo"
  }'
```

## Dojo Listing

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
