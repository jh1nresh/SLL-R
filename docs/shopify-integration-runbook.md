# Shopify Integration Runbook

SLL-R should connect Shopify stores without replacing their checkout or POS.

Use Shopify as the source of truth for products, carts, paid orders, fulfillment,
and refunds. Use SLL-R as the agent-facing quote/order layer and receipt memory
bridge.

## Official Surfaces

- Storefront MCP: `https://{shop}.myshopify.com/api/mcp`
- UCP catalog MCP: `https://{shop}.myshopify.com/api/ucp/mcp`
- Storefront API cart creation: `cartCreate`
- Webhook proof: HTTPS webhooks with `X-Shopify-Hmac-SHA256`

Shopify Storefront MCP is good for catalog, cart, and policies. Payment,
fulfillment, and refund truth should come from Shopify webhooks or Admin API.

## Merchant Setup

For Noun Coffee, Raposa, or SOLYD, ask for:

1. Shopify storefront domain.
2. Storefront API token if SLL-R should create carts directly.
3. App client secret for webhook HMAC verification.
4. Optional Admin API token for webhook subscription/reconciliation.
5. Webhook topics:
   - `orders/paid`
   - fulfillment event available to the merchant app setup
   - `refunds/create`, optional
6. Agreement to store `sllr_order_id` in cart attributes, note attributes, or
   checkout metadata so paid webhooks can attach proof to the SLL-R order.

For content-commerce merchants such as Changbaishan Rice, also ask for:

1. A product story / post URL that explains the origin and quality claims.
2. The SKU that each story maps to.
3. Fulfillment promise: shipping days, pack size, and return/refund policy.
4. Whether claims such as `fresh-milled`, `unpolished`, or `natural` can appear
   as structured product tags.

## SLL-R Endpoints

```text
GET  /shopify/merchants
GET  /shopify/merchants/{merchantId}/connect
GET  /shopify/merchants/{merchantId}/products
POST /shopify/merchants/{merchantId}/cart
POST /webhooks/shopify/orders-paid
POST /webhooks/shopify/orders-fulfilled
POST /webhooks/shopify/refunds-create
```

## Agent Flow

```text
buyer agent intent
-> SLL-R quote
-> SLL-R order
-> Shopify cart / checkout handoff
-> buyer pays through Shopify checkout, including Base Pay if enabled
-> Shopify orders/paid webhook
-> SLL-R attaches payment proof
-> SLL-R receipt memory
```

## Current Adapter Behavior

Without merchant credentials, SLL-R returns a checkout/product-page handoff and a
connect plan. This is intentional. It should not claim that Noun, Raposa, or
SOLYD received a real order until Shopify checkout or webhook proof is attached.

`GET /shopify/merchants/{merchantId}/products` returns product mapping metadata:

```json
{
  "mapping": {
    "source": "product_url",
    "requiredMetadataKeys": ["sllr_order_id", "sllr_merchant_id"],
    "proofPath": "orders/paid webhook or fulfillment webhook"
  },
  "cartMetadataKeys": [
    "sllr_order_id",
    "sllr_merchant_id",
    "sllr_receipt_callback"
  ]
}
```

This is the minimum contract that lets SLL-R connect an agent-created order to a
Shopify paid-order webhook.

For local demos without a Shopify app secret, webhook proof endpoints require
`demo=true`. Production must configure `SLLR_SHOPIFY_WEBHOOK_SECRET` and verify
the raw webhook body against `X-Shopify-Hmac-SHA256`.

## Demo Commands

```bash
curl https://sll-r.vercel.app/shopify/merchants
```

```bash
curl https://sll-r.vercel.app/shopify/merchants/noun-coffee/connect
```

```bash
curl -X POST https://sll-r.vercel.app/shopify/merchants/noun-coffee/cart \
  -H "content-type: application/json" \
  -d '{"itemId":"dalat-highlands"}'
```

```bash
curl -X POST https://sll-r.vercel.app/merchants/changbaishan-rice/quote \
  -H "content-type: application/json" \
  -d '{"userIntent":"fresh-milled unpolished natural rice under $25","maxSpendUsd":"25.00","deliverByDays":7}'
```

## Production Notes

- Storefront MCP may be enough for agent shopping UX.
- Storefront API is needed when SLL-R creates carts itself.
- Admin API or app config is needed for webhook subscription management.
- Webhooks are not a replacement for reconciliation jobs; periodically reconcile
  paid and fulfilled orders if this becomes production-critical.
