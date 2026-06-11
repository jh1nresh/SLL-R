export function solanaSllrPluginSpec(origin: string) {
  return `# SLL-R Solana Merchant Plugin

SLL-R is the merchant order runtime. Solana Pay is one payment adapter.

Use this plugin when an agent needs to quote a merchant order, create the order,
prepare a Solana Pay URL or Helio checkout handoff, then attach verified payment
proof before receipt memory.

**SLL-R API:** ${origin}
**Payment rail:** Solana Pay / Helio

---

## Agent Flow

1. Discover Solana-capable merchants:

\`\`\`text
GET ${origin}/solana-pay/merchants
\`\`\`

2. Quote through the generic merchant API:

\`\`\`text
POST ${origin}/merchants/{merchantId}/quote
\`\`\`

3. Create the order:

\`\`\`text
POST ${origin}/merchants/{merchantId}/orders
\`\`\`

4. Prepare Solana payment:

\`\`\`text
GET ${origin}/solana-pay/prepare-payment?orderId=<ORDER_ID>
\`\`\`

If SLL-R is configured with \`SLLR_SOLANA_PAY_RECIPIENT\`, the response includes:

\`\`\`json
{
  "mode": "solana_pay_url",
  "reference": "...",
  "recipient": "...",
  "solanaPayUrl": "solana:..."
}
\`\`\`

If SLL-R is configured with \`SLLR_HELIO_CHECKOUT_BASE_URL\`, the response may
include a Helio checkout handoff instead.

5. Ask the user to approve payment in their wallet or checkout UI.

6. Attach payment proof:

\`\`\`text
POST ${origin}/solana-pay/verify-payment
\`\`\`

Production verification must validate reference, token, recipient, amount, and
signature or webhook source before issuing receipt memory.

## Safety Rules

- Never submit payment without explicit user approval.
- Show merchant, item, amount, recipient, token or checkout URL, and reference.
- Reject payment proof when the reference does not match the SLL-R order.
- Treat \`demo=true\` as local proof only.

## Example Prompt

\`\`\`text
Use SLL-R Solana merchant plugin.

Order Raposa Nitro Cold Brew Starter Pack under $30.
Create the order, prepare Solana Pay, show me the URL/reference, and do not verify payment until I provide the transaction proof.
\`\`\`
`;
}
