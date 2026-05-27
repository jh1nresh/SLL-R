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
-> Jiagon issues receipt memory
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
- payment rail: counter first, MoonPay / Shopify later
- staff workflow: Telegram group or hosted merchant terminal
- promise workflow: accept, ready, claimed, then receipt memory

## SOLYD Pilot

Best first wedge:

```text
buyer agent asks for a phone case
-> SLL-R checks catalog, price, stock, and shipping estimate
-> buyer agent creates order
-> checkout handoff uses existing SOLYD checkout
-> payment webhook confirms proof
-> Jiagon issues receipt memory
```

What SOLYD gets:

- agent-readable product catalog
- quote/order API without rebuilding checkout
- payment-backed receipt memory
- future AgentShack distribution as an agent-ready merchant

Initial config:

- `merchantId`: `solyd`
- fulfillment: shipping
- payment rail: existing checkout first, MoonPay / Shopify webhook later
- receipt handoff: Jiagon API

## Merchant Meeting Checklist

Ask for:

- product list or menu
- prices and variants
- stock or availability rules
- pickup prep time or shipping estimate
- current checkout/payment provider
- webhook access if they want payment-backed receipts
- preferred staff notification channel

Do not ask them to replace their POS in the first meeting. SLL-R should wrap the
current workflow first.

## Pilot Acceptance Criteria

- Merchant can see or receive created orders.
- Buyer agent can get a quote with budget and timing constraints.
- Order has a stable ID and status.
- Pickup orders include estimated wait, promised time, ready time, and claimed
  time.
- Payment or fulfillment proof upgrades the order.
- Jiagon returns a receipt memory object or claim URL.

## First Integration Levels

Level 1: static catalog and mock payment proof.

Level 2: static catalog plus real staff confirmation.

Level 3: real checkout webhook from Shopify, MoonPay, Stripe, or Solana Pay.

Level 4: production merchant profile with receipt memory and analytics.
