# SLL-R Base Coffee Plugin

> [!IMPORTANT]
> ## STOP - COMPLETE BASE MCP ONBOARDING FIRST
>
> Before calling any SLL-R payment endpoint, complete Base MCP onboarding:
> 1. Call `get_wallets`.
> 2. Present the selected wallet and Base transaction disclaimer to the user.
>
> The payer address used in `prepare-payment?from=<address>` must come from
> the detected wallet, not from a guessed prompt value.

This plugin shape lets a Base-aware agent discover coffee merchants, quote a
real product, create an order handoff, and prepare payment.

The first public storefront adapter is Noun Coffee. It uses public product
metadata from `noun.coffee` and should be treated as a demo adapter until Noun
explicitly configures its own merchant wallet, checkout webhook, and receipt
issuance policy.

## Agent Flow

1. Call the wallet tool first, for example `get_wallets`, so the user can choose
   the paying wallet.
2. Discover supported coffee merchants:

   ```text
   GET /base-plugin/coffee/merchants
   ```

3. Quote the buyer intent:

   ```text
   GET /base-plugin/coffee/quote?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7
   ```

4. Create the order:

   ```text
   GET /base-plugin/coffee/order?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7&agentId=base-mcp-agent
   ```

5. Prepare payment:

   ```text
   GET /base-plugin/coffee/prepare-payment?orderId=ord_...&from=0x...
   ```

If the response includes `transactions`, ask the user to approve the returned
Base USDC call and submit it with Base MCP `send_calls`. If the response mode is
`checkout_handoff`, open the merchant checkout URL instead.

## send_calls Mapping

Map `transactions[*]` into one Base MCP `send_calls` request:

```json
{
  "chain": "base",
  "calls": [
    {
      "to": "<transactions[0].to>",
      "value": "<transactions[0].value>",
      "data": "<transactions[0].data>"
    }
  ]
}
```

The SLL-R plugin endpoints are GET endpoints so they can remain usable in
Claude and ChatGPT-style consumer apps where custom plugin hosts may not support
POST access.

## Payment Proof

The default Noun Coffee adapter returns `checkout_handoff` because SLL-R does
not know Noun Coffee's merchant wallet. For local demos, set
`SLLR_BASE_COFFEE_RECIPIENT` to an EVM address. SLL-R will then return a Base
USDC `transfer` transaction to that configured demo recipient.

This is intentionally conservative: a demo recipient is not claimed to be Noun
Coffee's wallet. Real production onboarding should configure:

- merchant-owned receiving address or checkout provider webhook
- order ID to payment reference mapping
- webhook signature verification
- Jiagon receipt issuance after payment proof

## Receipt Memory

After payment proof is attached through `POST /webhooks/payment`, SLL-R upgrades
the order to Jiagon receipt memory. The receipt memory can later be represented
as a Solana cNFT by Jiagon.
