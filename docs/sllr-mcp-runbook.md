# SLL-R Merchant MCP Runbook

SLL-R exposes a generic merchant MCP-style contract for buyer agents.

Use this contract when the agent needs to order from a real merchant without
hard-coding a coffee, Shopify, Base, or Solana-specific flow.

## Discovery

```text
POST /mcp                          (MCP Streamable HTTP endpoint)
GET  /.well-known/sllr-mcp.json    (descriptive manifest)
GET  /openapi.json                 (equivalent REST surface)
```

`/mcp` is a stateless Streamable HTTP MCP server: JSON-RPC `initialize`,
`tools/list`, and `tools/call` over POST. MCP clients connect with:

```bash
claude mcp add --transport http sllr https://<sllr-host>/mcp
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
   - `stripe`: prepay in-flow via a Stripe hosted Checkout URL (card / Apple /
     Google Pay); the `checkout.session.completed` webhook attaches proof. The
     merchant only fulfills and never handles payment.
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

   This endpoint requires the merchant verifier secret
   (`x-sllr-merchant-payment-secret` header or `verificationToken` in the body);
   `demo: true` is only accepted when no secret is configured.

## Receipt Memory Requires Proof

Receipt memory is only issued after one of:

- **Verified payment proof** — `attach_payment_proof` with a configured verifier
  secret (or `demo=true` locally) issues receipt memory automatically.
- **Merchant fulfillment proof** — a staff terminal action (claim/fulfill) or
  `issue_receipt`. These are gated by the merchant verifier secret
  (`SLLR_MERCHANT_PAYMENT_VERIFY_SECRET`): the caller must supply it as the
  `x-sllr-merchant-payment-secret` header or `verificationToken`, and `demo=true`
  is only accepted when no secret is configured. Buyer agents cannot mint receipt
  memory — their path to a receipt is to pay.

Set `SLLR_MERCHANT_PAYMENT_VERIFY_SECRET` for any real pilot.

## Safety Rules

- Do not submit a payment without explicit user approval.
- Show merchant, item, amount, payment rail, recipient or checkout URL, and proof
  requirements before asking for approval.
- Do not issue receipt memory from order intent alone.
- If a payment rail only returns a checkout handoff, wait for webhook proof or
  merchant fulfillment proof before marking the order complete.

## Demo Merchant Ingestion

`create_demo_merchant` ingests a public Shopify storefront's `products.json`
into a runtime demo merchant (counter + Shopify checkout rails). Use it to
demo SLL-R against a real store's catalog without merchant setup:

```text
Use SLL-R MCP. Create a demo merchant from panthercoffee.com, then quote a bag of Brasil specialty coffee under $30 and show me payment options.
```

Set `SLLR_DEMO_MERCHANT_SECRET` on public deployments to gate ingestion.

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

