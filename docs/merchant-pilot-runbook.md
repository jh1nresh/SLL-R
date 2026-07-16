# Raposa / SOLYD Pilot Runbook

## Goal

Use SLL-R as the seller-side agent runtime for first merchant pilots. The pilot
should prove that a merchant can accept orders from buyer agents while preserving
their current checkout and fulfillment workflow.

## Raposa Coffee Pilot

Best first wedge:

```text
buyer agent asks for coffee or beans
-> SLL-R quotes Raposa options
-> buyer agent creates order with a requested pickup window
-> SLL-R estimates the live queue and returns a pickup promise
-> Raposa confirms, marks ready, then marks customer claimed
-> SLL-R records payment or fulfillment proof
-> SLL-R issues receipt memory
```

What Raposa gets:

- one agent-readable catalog
- pickup ETA, queue visibility, and promise logic
- Telegram or simple merchant terminal for staff
- verified receipt memory for customers
- future compatibility with buyer agents on AgentShack

Initial config:

- `merchantId`: `raposa-coffee` for pickup
- `merchantId`: `raposa-shop` for shipped coffee products
- payment rail: counter first, Solana Pay or Helio / MoonPay Commerce for crypto
  checkout, Binance Pay later
- staff workflow: Telegram group or hosted merchant terminal
- promise workflow: accept, ready, claimed, then receipt memory

Day-one demo flow:

```text
1. Customer or buyer agent opens /raposa/order or /agent/raposa-coffee.
2. Customer asks for a drink with a time constraint, such as "iced latte in 10 minutes."
3. SLL-R quotes the item, price, and pickup promise from the active queue.
4. Customer creates the order and receives a pickup code.
5. Staff opens /raposa or /terminal/raposa-coffee.
6. Staff accepts the order, marks it ready, then taps Paid + Claimed after counter payment.
7. SLL-R issues receipt memory from the claim / fulfillment proof.
```

The first Raposa pilot should not require a POS migration. The value to prove is
that SLL-R can reduce wait-time uncertainty and staff interruptions while
preserving the existing counter workflow.

## SOLYD Pilot

Best first wedge:

```text
buyer agent asks for a phone case
-> SLL-R checks catalog, price, stock, and shipping estimate
-> buyer agent creates order
-> checkout handoff uses existing SOLYD checkout
-> payment webhook confirms proof
-> merchant fulfillment confirms the outcome
-> SLL-R issues receipt memory
```

What SOLYD gets:

- agent-readable product catalog
- quote/order API without rebuilding checkout
- payment proof kept separate from fulfillment-backed receipt memory
- future AgentShack distribution as an agent-ready merchant

Initial config:

- `merchantId`: `solyd`
- fulfillment: shipping
- payment rail: existing checkout first, Solana Pay / Helio / MoonPay Commerce,
  Shopify, or Binance Pay webhook later
- receipt handoff: SLL-R receipt API

## Merchant Meeting Checklist

Ask for:

- product list or menu
- prices and variants
- stock or availability rules
- pickup prep time or shipping estimate
- current checkout/payment provider
- webhook access if they want verified payment state before fulfillment
- preferred staff notification channel
- Solana Pay recipient wallet or Helio / MoonPay Commerce pay link if they want
  a Solana-native rail
- Binance Pay API access, webhook configuration, and refund policy if they want
  a BNB-native merchant rail

Do not ask them to replace their POS in the first meeting. SLL-R should wrap the
current workflow first.

## Pilot Acceptance Criteria

- Merchant can see or receive created orders.
- Buyer agent can get a quote with budget and timing constraints.
- Order has a stable ID and status.
- Pickup orders include estimated wait, promised time, ready time, and claimed
  time.
- Payment or fulfillment proof upgrades the order.
- SLL-R returns a receipt memory object or claim URL.

## First Integration Levels

Level 1: static catalog and mock payment proof.

Level 2: static catalog plus real staff confirmation.

Level 3: real checkout webhook from Shopify, Helio / MoonPay Commerce, Stripe,
Solana Pay, or Binance Pay.

Level 4: production merchant profile with receipt memory and analytics.

For Binance Pay, Level 3 must include webhook signature verification and a Query
Order confirmation before SLL-R marks an order as payment-backed.

For Solana Pay / Helio, Level 3 must include reference, amount, recipient, token,
and webhook or transaction verification before SLL-R marks an order as
payment-backed.
