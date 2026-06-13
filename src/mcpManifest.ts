export function sllrMcpManifest(origin: string) {
  return {
    name: "SLL-R Merchant MCP",
    version: "0.1.0",
    description: "Generic merchant ordering tools for catalog discovery, quote, order, payment options, fulfillment status, and receipt memory.",
    transport: {
      type: "https",
      baseUrl: origin,
    },
    safety: {
      paymentApproval: "Always show payment rail, merchant, amount, recipient or checkout URL, and proof requirements before asking the user to approve payment.",
      noAutonomousPayment: true,
      proofBeforeReceipt: "Receipt memory must only be issued after payment proof or merchant fulfillment proof.",
    },
    tools: [
      {
        name: "list_merchants",
        method: "GET",
        path: "/merchants",
        description: "List merchants that SLL-R can quote and order from.",
      },
      {
        name: "get_merchant",
        method: "GET",
        path: "/merchants/{merchantId}",
        description: "Read merchant profile, fulfillment modes, and supported payment rails.",
      },
      {
        name: "get_menu",
        method: "GET",
        path: "/merchants/{merchantId}/menu",
        description: "Read normalized catalog and menu sections for a merchant.",
      },
      {
        name: "quote_order",
        method: "POST",
        path: "/merchants/{merchantId}/quote",
        description: "Quote buyer intent against merchant catalog, budget, quantity, pickup deadline, or shipping deadline.",
        inputSchema: {
          type: "object",
          required: ["userIntent"],
          properties: {
            userIntent: { type: "string" },
            maxSpendUsd: { type: "string" },
            deadlineMinutes: { type: "number" },
            deliverByDays: { type: "number" },
            quantity: { type: "number" },
          },
        },
      },
      {
        name: "create_order",
        method: "POST",
        path: "/merchants/{merchantId}/orders",
        description: "Create an SLL-R order after the quote is acceptable to the user.",
        inputSchema: {
          type: "object",
          required: ["userIntent"],
          properties: {
            userIntent: { type: "string" },
            maxSpendUsd: { type: "string" },
            deadlineMinutes: { type: "number" },
            deliverByDays: { type: "number" },
            quantity: { type: "number" },
            agentId: { type: "string" },
            customerLabel: { type: "string" },
            paymentMode: { type: "string", enum: ["counter", "checkout", "crypto"] },
          },
        },
      },
      {
        name: "list_orders",
        method: "GET",
        path: "/merchants/{merchantId}/orders",
        description: "List SLL-R orders for a merchant, optionally filtered by status.",
      },
      {
        name: "attach_payment_proof",
        method: "POST",
        path: "/merchants/{merchantId}/payment",
        description: "Attach verified or demo payment proof to an order. Production callers must use a configured verifier secret or webhook signature path.",
      },
      {
        name: "issue_receipt",
        method: "POST",
        path: "/merchants/{merchantId}/receipt",
        description: "Issue receipt memory for an order after payment or fulfillment proof. Requires the merchant verifier secret (x-sllr-merchant-payment-secret header or verificationToken); demo=true is only accepted when no secret is configured.",
      },
      {
        name: "check_order_status",
        method: "GET",
        path: "/orders/{orderId}",
        description: "Read current order state, payment status, fulfillment state, and receipt handoff.",
      },
    ],
    adapters: {
      normalCheckout: ["shopify", "stripe", "counter"],
      web3: ["base_usdc", "solana_pay", "helio", "moonpay", "binance_pay"],
      staff: ["merchant_terminal", "telegram_staff"],
    },
    exampleMerchants: [
      "raposa-coffee",
      "raposa-shop",
      "solyd",
      "noun-coffee",
    ],
    docs: `${origin}/docs/sllr-mcp-runbook.md`,
    openapi: `${origin}/openapi.json`,
  };
}
