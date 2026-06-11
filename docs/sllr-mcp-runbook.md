# SLL-R Merchant MCP Runbook

SLL-R exposes a generic merchant MCP-style contract for buyer agents.

Use this contract when the agent needs to order from a real merchant without
hard-coding a coffee, Shopify, Base, or Solana-specific flow.

## Discovery

```text
GET /.well-known/sllr-mcp.json
GET /openapi.json
```

The generic MCP manifest lists merchant tools. Base MCP, Solana Pay, Shopify,
and counter pay are payment adapters, not separate products.

## Agent Flow

1. List merchants.

   ```text
   GET /merchants
   ```

2. Read the merchant menu.

   ```text
   GET /merchants/{merchantId}/menu
   ```

3. Quote the buyer intent.

   ```text
   POST /merchants/{merchantId}/quote
   ```

   Example body:

   ```json
   {
     "userIntent": "I need an iced latte in 10 minutes.",
     "deadlineMinutes": 10,
     "maxSpendUsd": "10.00"
   }
   ```

4. Create the order only after the user accepts the quote.

   ```text
   POST /merchants/{merchantId}/orders
   ```

5. Prepare or attach payment proof.

   Current compatible rails:

   - `counter`: user pays at pickup or merchant marks paid in terminal.
   - `shopify`: open merchant checkout and verify paid webhook.
   - `base_usdc`: prepare Base USDC calldata for Base MCP `send_calls`.
   - `solana_pay`: prepare Solana Pay URL with a unique reference.
   - `helio` / `moonpay`: open checkout handoff and verify webhook.

6. Check order status.

   ```text
   GET /orders/{orderId}
   ```

7. Issue receipt memory after payment proof or fulfillment proof.

   ```text
   POST /merchants/{merchantId}/receipt
   ```

## Safety Rules

- Do not submit a payment without explicit user approval.
- Show merchant, item, amount, payment rail, recipient or checkout URL, and proof
  requirements before asking for approval.
- Do not issue receipt memory from order intent alone.
- If a payment rail only returns a checkout handoff, wait for webhook proof or
  merchant fulfillment proof before marking the order complete.

## Example Prompts

Raposa Coffee:

```text
Use SLL-R MCP. Order an iced latte from Raposa Coffee that can be ready in 10 minutes. Show counter pay and Solana Pay options before payment.
```

SOLYD:

```text
Use SLL-R MCP. Find a SOLYD case for iPhone 16 Pro under $60 and prepare checkout.
```

Changbaishan Rice:

```text
Use SLL-R MCP. Find natural unpolished fresh-milled rice under $25 and prepare checkout.
```

