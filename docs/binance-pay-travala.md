# Binance Pay / Travala Fit For SLL-R

## Summary

SLL-R should treat Binance Pay as a payment-proof rail for merchants that want
crypto checkout without building wallet custody into the seller agent. Travala is
the reference vertical: travel bookings already have clear quote, order,
payment, refund, and fulfillment states, so they show how SLL-R can clear
merchant work beyond cafes and ecommerce.

This is not a live Travala integration yet. It is a product and adapter target
for SLL-R.

## Why Binance Pay Fits

Binance Pay gives merchants a checkout and refund surface that maps cleanly to
SLL-R:

- SLL-R creates a merchant order and uses `merchantTradeNo` as the shared order
  key.
- Binance Pay creates a checkout order and returns `prepayId`, QR code,
  deeplink, and hosted checkout URLs.
- Binance Pay webhooks notify SLL-R when pay or refund events happen.
- SLL-R must still call Query Order before upgrading the order, because webhook
  notifications are event signals, not the final clearing source.
- A confirmed `PAID` status upgrades the SLL-R order to `payment_backed`.
- A confirmed `FULL_REFUNDED` status can become refund proof for disputes,
  service recovery, or reputation updates.

## SLL-R Clearing Path

```text
buyer agent intent
-> SLL-R quote
-> SLL-R order with merchantTradeNo
-> Binance Pay checkout handoff
-> PAY webhook arrives
-> SLL-R Query Order confirms PAID
-> merchant fulfills or refund path starts
-> Jiagon receipt memory
-> AgentShack reputation / credit signal
```

The receipt should include:

- `merchantId`
- `sllrOrderId`
- `paymentRail`: `binance_pay`
- `merchantTradeNo`
- `prepayId`
- `transactionId`
- `paymentStatus`
- `refundStatus` when applicable
- `fulfillmentStatus`
- `receiptHash`

## Travala Reference

Travala is useful for SLL-R because travel is a high-signal merchant category:

- quotes are concrete: flight, hotel, activity, date, price, cancellation terms
- orders have external confirmation IDs
- payment and refund state can be checked later
- completed trips, cancellations, and refunds are all receipt-worthy outcomes

For AgentShack, this suggests a future travel merchant agent family:

```text
TRV-L booking agent
-> quote stay / flight / activity
-> checkout through Binance Pay or another payment partner
-> verify booking or refund state
-> issue portable receipt memory
```

SLL-R should not claim Travala support until there is an approved partner
integration or public API path. For now, Travala is the proof that a Binance Pay
merchant flow can be turned into a verifiable agent-service receipt loop.

## Pilot Implication

For Raposa and SOLYD, Binance Pay should be an optional Level 3 integration:

- keep their current checkout first
- add Binance Pay only when the merchant wants BNB-native customer reach or
  stablecoin settlement
- require API credentials, webhook configuration, and a refund policy before
  enabling receipt upgrades from Binance Pay events

## Sources

- Binance Pay Merchant docs: https://merchant.binance.com/en/docs/home
- Binance Pay Create Order flow: https://merchant.binance.com/en/docs/functionalities/single-payment/native-apis
- Binance Pay Query Order: https://merchant.binance.com/en/docs/functionalities/query-order
- Binance Pay Webhooks: https://merchant.binance.com/en/docs/functionalities/webhooks
- Travala payment options: https://www.travala.com/payment-options
- Travala Binance Pay refund behavior: https://help.travala.com/hc/en-us/articles/6311975259161-How-is-my-activity-refund-paid-back
- BNB Chain payment solutions: https://www.bnbchain.org/en/payment
