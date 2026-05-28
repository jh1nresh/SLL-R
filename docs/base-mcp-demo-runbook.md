# Base MCP Demo Runbook

Use this runbook to record a Base Agent Quest demo for SLL-R.

## Goal

Show a buyer agent ordering Noun Coffee through SLL-R, preparing a Base USDC
transaction, and turning payment proof into Jiagon receipt memory.

## Required Setup

- Public SLL-R HTTPS URL
- `SLLR_PUBLIC_ORIGIN` set to that URL
- `SLLR_BASE_COFFEE_RECIPIENT` set to a Base wallet you control
- Base MCP connected in the assistant
- A wallet selected through Base MCP `get_wallets`

Do not use a random or burn address for `SLLR_BASE_COFFEE_RECIPIENT`.

## Agent Discovery URLs

Use these URLs when a chat agent, Hermes run, or Base MCP custom plugin needs a
self-describing tool surface:

```text
GET <SLLR_URL>/.well-known/sllr-agent.json
GET <SLLR_URL>/.well-known/ai-plugin.json
GET <SLLR_URL>/.well-known/base-mcp-plugin.md
GET <SLLR_URL>/openapi.json
```

The Base MCP plugin spec is the most direct contest artifact: it tells the
assistant to call `get_wallets`, quote/order with GET endpoints, prepare Base
USDC calldata, then pass `transactions[]` into Base MCP `send_calls`.

## Demo Prompt

```text
Buy me Dalat Highlands coffee beans from Noun Coffee under $40.
Use SLL-R to quote and create the order. Then prepare a Base USDC payment.
Before payment, show me the merchant, item, amount, recipient, and calldata summary.
Only call send_calls after I approve.
After approval, record the payment proof in SLL-R and show the receipt memory.
```

## Assistant Flow

1. Base MCP onboarding:

   ```text
   get_wallets
   ```

2. Discover merchant:

   ```text
   GET <SLLR_URL>/base-plugin/coffee/merchants
   ```

3. Quote:

   ```text
   GET <SLLR_URL>/base-plugin/coffee/quote?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7
   ```

4. Create order:

   ```text
   GET <SLLR_URL>/base-plugin/coffee/order?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7&agentId=base-mcp-demo
   ```

5. Prepare payment:

   ```text
   GET <SLLR_URL>/base-plugin/coffee/prepare-payment?orderId=<ORDER_ID>&from=<BASE_ACCOUNT_ADDRESS>
   ```

6. Map `transactions[]` into Base MCP `send_calls`:

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

7. After user approval and confirmed tx/request id, record demo payment proof:

   ```text
   GET <SLLR_URL>/base-plugin/coffee/record-demo-payment?orderId=<ORDER_ID>&paymentId=<TX_OR_REQUEST_ID>
   ```

8. Show receipt memory:

   ```text
   GET <SLLR_URL>/base-plugin/coffee/status?orderId=<ORDER_ID>
   ```

## Recording Notes

Keep the video under 3 minutes:

1. Natural language request.
2. Quote/order response.
3. Base MCP approval screen.
4. Receipt memory response.

Production note: `record-demo-payment` is a demo proof endpoint. Production must
verify the Base transaction hash, amount, recipient, and token before issuing
receipt memory.
