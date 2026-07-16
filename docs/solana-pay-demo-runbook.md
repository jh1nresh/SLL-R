# Solana Pay / Helio Demo Runbook

Use this runbook to show SLL-R turning Raposa or SOLYD into a Solana-payable,
agent-orderable merchant.

Agent/plugin discovery:

```text
GET /.well-known/solana-sllr-plugin.md
GET /solana-pay/merchants
```

## Goal

Show a buyer agent creating an order, preparing Solana payment, attaching
payment proof, and receiving SLL-R receipt memory after merchant fulfillment.

```text
agent intent
-> SLL-R quote
-> SLL-R order
-> Solana Pay URL or Helio checkout handoff
-> payment proof
-> merchant fulfillment or customer claim
-> SLL-R receipt memory
```

## Required Setup

For Solana Pay URL demos:

```text
SLLR_SOLANA_PAY_RECIPIENT=<Solana wallet you control>
SLLR_SOLANA_PAY_SPL_TOKEN=<optional SPL mint>
SLLR_SOLANA_PAY_VERIFY_SECRET=<random server-side verifier secret>
SLLR_MERCHANT_PAYMENT_VERIFY_SECRET=<merchant fulfillment verifier secret>
```

For Helio checkout handoff demos:

```text
SLLR_HELIO_CHECKOUT_BASE_URL=<merchant Helio/MoonPay Commerce pay link>
SLLR_HELIO_WEBHOOK_SECRET=<webhook verifier secret>
```

Without verifier secrets, SLL-R only accepts proof payloads that explicitly set
`demo: true`. That keeps the local demo honest and avoids presenting a public
endpoint as production payment verification.

## Demo Prompt

```text
Buy me a SOLYD black MagSafe iPhone 16 case under $100.
Use SLL-R to quote, create the order, prepare Solana Pay, and show the merchant,
item, amount, Solana recipient, and reference before payment.
After payment proof is attached, show the payment-backed state. Then record
merchant fulfillment and show the final SLL-R receipt memory.
```

For Raposa beans:

```text
Buy me Raposa coffee beans under $20 this week using Solana Pay.
```

## API Flow

1. Discover Solana-payable merchants:

   ```bash
   curl "$SLLR_URL/solana-pay/merchants"
   ```

2. Quote:

   ```bash
   curl -X POST "$SLLR_URL/quote" \
     -H "content-type: application/json" \
     -d '{
       "merchantId": "solyd",
       "userIntent": "Ship me a black MagSafe iPhone 16 case under $100",
       "maxSpendUsd": "100.00",
       "deliverByDays": 7
     }'
   ```

3. Create order:

   ```bash
   curl -X POST "$SLLR_URL/orders" \
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

4. Prepare payment:

   ```bash
   curl "$SLLR_URL/solana-pay/prepare-payment?orderId=<ORDER_ID>"
   ```

5. Attach Solana payment proof:

   ```bash
   curl -X POST "$SLLR_URL/solana-pay/verify-payment" \
     -H "content-type: application/json" \
     -H "x-sllr-solana-pay-secret: $SLLR_SOLANA_PAY_VERIFY_SECRET" \
     -d '{
       "orderId": "<ORDER_ID>",
       "merchantId": "solyd",
       "amountUsd": "79.00",
       "paymentId": "<SOLANA_SIGNATURE>",
       "reference": "<REFERENCE_FROM_PREPARE_PAYMENT>"
     }'
   ```

6. Alternatively, attach Helio webhook proof:

   ```bash
   curl -X POST "$SLLR_URL/webhooks/helio" \
     -H "content-type: application/json" \
     -H "x-helio-webhook-secret: $SLLR_HELIO_WEBHOOK_SECRET" \
     -d '{
       "orderId": "<ORDER_ID>",
       "merchantId": "solyd",
       "amountUsd": "79.00",
       "paymentId": "<HELIO_PAYMENT_ID>",
       "reference": "<REFERENCE_FROM_PREPARE_PAYMENT>"
     }'
   ```

7. Record merchant fulfillment and issue final receipt memory:

   ```bash
   curl -X POST "$SLLR_URL/merchants/solyd/receipt" \
     -H "content-type: application/json" \
     -H "x-sllr-merchant-payment-secret: $SLLR_MERCHANT_PAYMENT_VERIFY_SECRET" \
     -d '{
       "orderId": "<ORDER_ID>",
       "actor": "solyd-fulfillment",
       "note": "Merchant confirmed shipment handoff."
     }'
   ```

   After step 5 or 6, the order must first show `payment_backed` with no final
   receipt. After this fulfillment request, expect `status: receipt_issued`,
   `proofLevel: receipt_memory_issued`, and a non-null `order.receipt` containing
   the final SLL-R receipt-memory identifiers and claim URL. Pickup merchants may
   instead mark the order ready and call `POST /orders/<ORDER_ID>/claim` with the
   same verifier header after customer handoff.

## Production Notes

- The demo adapter generates Solana Pay URLs and reference IDs.
- Production should verify transaction signature, recipient, token mint, amount,
  and reference against a trusted Solana RPC or Helio webhook before issuing
  receipt memory.
- The verifier must reject any proof whose `reference` does not match the SLL-R
  order reference.
- Do not claim demo recipient wallets are merchant-owned unless the merchant has
  provided and approved that wallet.
