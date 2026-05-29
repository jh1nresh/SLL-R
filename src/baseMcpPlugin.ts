export function baseMcpPluginSpec(origin: string) {
  return `# SLL-R Base Coffee Plugin
> [!IMPORTANT]
> ## STOP - COMPLETE BASE MCP ONBOARDING FIRST
>
> Before calling any SLL-R payment endpoint, complete Base MCP onboarding:
> 1. Call \`get_wallets\`.
> 2. Present the selected wallet and Base transaction disclaimer to the user.
>
> The payer address used in \`prepare-payment?from=<address>\` must come from the detected wallet, not from a guessed prompt value.

SLL-R is a seller-side agent runtime for merchants. This plugin lets a Base-aware agent discover Noun Coffee, quote a real product, create an order, prepare Base USDC calldata, and attach payment proof as SLL-R receipt memory.

**SLL-R API:** ${origin}
**Supported chain:** Base mainnet (\`8453\` / \`base\`)
**Token:** USDC on Base (\`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`)

---

## Read endpoints

\`\`\`text
GET ${origin}/base-plugin/coffee/merchants
GET ${origin}/base-plugin/coffee/status?orderId=<ORDER_ID>
GET ${origin}/openapi.json
\`\`\`

## Quote endpoint

\`\`\`text
GET ${origin}/base-plugin/coffee/quote?merchantId=noun-coffee&intent=<BUYER_INTENT>&maxSpendUsd=<USD>&deliverByDays=<DAYS>
\`\`\`

Use this before ordering. If \`quote.feasible\` is false, show the reasons and alternatives.

## Order endpoint

\`\`\`text
GET ${origin}/base-plugin/coffee/order?merchantId=noun-coffee&intent=<BUYER_INTENT>&maxSpendUsd=<USD>&deliverByDays=<DAYS>&agentId=<AGENT_ID>
\`\`\`

Response includes \`order.id\`, \`order.item.subtotalUsd\`, and a checkout handoff when available.

## Prepare payment endpoint

\`\`\`text
GET ${origin}/base-plugin/coffee/prepare-payment?orderId=<ORDER_ID>&from=<BASE_ACCOUNT_ADDRESS>
\`\`\`

If SLL-R is configured with \`SLLR_BASE_COFFEE_RECIPIENT\`, the response includes:

\`\`\`json
{
  "mode": "base_mcp_demo",
  "chain": "base",
  "chainId": 8453,
  "transactions": [
    {
      "chainId": 8453,
      "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "value": "0x0",
      "data": "0x...",
      "description": "Pay ... USDC to configured SLL-R coffee demo recipient."
    }
  ]
}
\`\`\`

If the response mode is \`checkout_handoff\`, open the returned checkout URL instead of calling \`send_calls\`.

## send_calls mapping

Pass every \`transactions[*]\` into one Base MCP \`send_calls\` request:

\`\`\`json
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
\`\`\`

After the user approves and Base MCP returns a request id or transaction id, record the demo payment proof:

\`\`\`text
GET ${origin}/base-plugin/coffee/record-demo-payment?orderId=<ORDER_ID>&paymentId=<REQUEST_OR_TX_ID>
\`\`\`

Then read status:

\`\`\`text
GET ${origin}/base-plugin/coffee/status?orderId=<ORDER_ID>
\`\`\`

The order is complete when \`proofLevel\` or \`order.proofLevel\` is \`receipt_memory_issued\`.

## Safety rules

- Never invent a payer address. Use the wallet address from \`get_wallets\`.
- Show merchant, item, amount, recipient, token, and calldata summary before \`send_calls\`.
- Do not call \`send_calls\` until the user explicitly approves.
- Treat \`record-demo-payment\` as demo proof. Production must verify transaction hash, token, recipient, amount, and reference before issuing receipt memory.
`;
}
