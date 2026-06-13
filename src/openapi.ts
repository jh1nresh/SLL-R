const jsonContent = {
  "application/json": {
    schema: {
      type: "object",
    },
  },
};

function jsonResponse(description = "JSON response") {
  return {
    description,
    content: jsonContent,
  };
}

function errorResponses() {
  return {
    "400": jsonResponse("Invalid request"),
    "404": jsonResponse("Resource not found"),
    "409": jsonResponse("Conflict"),
  };
}

export function sllrOpenApi(origin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "SLL-R Agent Commerce API",
      version: "0.1.0",
      description: "Seller-side agent runtime for merchant discovery, quote, order, payment proof, and receipt memory.",
    },
    servers: [
      {
        url: origin,
        description: "SLL-R runtime",
      },
    ],
    tags: [
      { name: "Discovery", description: "Agent-readable merchant and manifest discovery." },
      { name: "Standalone Agent", description: "Hosted customer agent and merchant terminal pages." },
      { name: "Merchant Runtime", description: "Merchant-scoped quote, order, payment, and receipt tools." },
      { name: "Shopify", description: "Shopify Storefront MCP, checkout handoff, and webhook proof tools." },
      { name: "Base MCP", description: "GET-only Noun Coffee flow that prepares Base USDC calldata." },
      { name: "Solana", description: "Solana Pay and Helio handoff tools." },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["Discovery"],
          operationId: "getHealth",
          summary: "Check SLL-R service health.",
          responses: { "200": jsonResponse("SLL-R health") },
        },
      },
      "/.well-known/sllr-agent.json": {
        get: {
          tags: ["Discovery"],
          operationId: "getSllrAgentManifest",
          summary: "Read the SLL-R native agent manifest.",
          responses: { "200": jsonResponse("SLL-R manifest") },
        },
      },
      "/.well-known/ai-plugin.json": {
        get: {
          tags: ["Discovery"],
          operationId: "getAiPluginManifest",
          summary: "Read the ChatGPT-style tool manifest.",
          responses: { "200": jsonResponse("AI plugin manifest") },
        },
      },
      "/.well-known/base-mcp-plugin.md": {
        get: {
          tags: ["Base MCP"],
          operationId: "getBaseMcpPluginSpec",
          summary: "Read the Base MCP custom plugin instructions.",
          responses: {
            "200": {
              description: "Markdown plugin spec",
              content: {
                "text/markdown": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/.well-known/solana-sllr-plugin.md": {
        get: {
          tags: ["Solana"],
          operationId: "getSolanaSllrPluginSpec",
          summary: "Read the Solana Pay merchant plugin instructions.",
          responses: {
            "200": {
              description: "Markdown plugin spec",
              content: {
                "text/markdown": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["Discovery"],
          operationId: "getOpenApiSpec",
          summary: "Read the OpenAPI schema for SLL-R tools.",
          responses: { "200": jsonResponse("OpenAPI schema") },
        },
      },
      "/merchants": {
        get: {
          tags: ["Merchant Runtime"],
          operationId: "listMerchants",
          summary: "List configured SLL-R merchants.",
          responses: { "200": jsonResponse("Merchant list") },
        },
      },
      "/agent/{merchantId}": {
        get: {
          tags: ["Standalone Agent"],
          operationId: "openStandaloneAgent",
          summary: "Open the hosted SLL-R customer ordering agent.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          responses: {
            "200": {
              description: "HTML ordering agent",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
            ...errorResponses(),
          },
        },
      },
      "/agent/{merchantId}/message": {
        post: {
          tags: ["Standalone Agent"],
          operationId: "messageStandaloneAgent",
          summary: "Quote or create an order from customer intent.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/StandaloneAgentMessageBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Standalone agent response"), ...errorResponses() },
        },
      },
      "/terminal/{merchantId}": {
        get: {
          tags: ["Standalone Agent"],
          operationId: "openMerchantTerminal",
          summary: "Open the hosted SLL-R merchant order terminal.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          responses: {
            "200": {
              description: "HTML merchant terminal",
              content: {
                "text/html": {
                  schema: { type: "string" },
                },
              },
            },
            ...errorResponses(),
          },
        },
      },
      "/merchants/{merchantId}": {
        get: {
          tags: ["Merchant Runtime"],
          operationId: "getMerchant",
          summary: "Read one merchant profile.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          responses: { "200": jsonResponse("Merchant profile"), ...errorResponses() },
        },
      },
      "/merchants/{merchantId}/menu": {
        get: {
          tags: ["Merchant Runtime"],
          operationId: "getMerchantMenu",
          summary: "Read a merchant catalog and menu sections.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          responses: { "200": jsonResponse("Merchant menu"), ...errorResponses() },
        },
      },
      "/merchants/{merchantId}/quote": {
        post: {
          tags: ["Merchant Runtime"],
          operationId: "quoteMerchantOrder",
          summary: "Quote a merchant-scoped buyer intent.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/QuoteRequestBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Merchant quote"), ...errorResponses() },
        },
      },
      "/merchants/{merchantId}/orders": {
        get: {
          tags: ["Merchant Runtime"],
          operationId: "listMerchantOrders",
          summary: "List orders for a merchant.",
          parameters: [
            { $ref: "#/components/parameters/MerchantId" },
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: { "200": jsonResponse("Merchant orders"), ...errorResponses() },
        },
        post: {
          tags: ["Merchant Runtime"],
          operationId: "createMerchantOrder",
          summary: "Create a merchant-scoped order.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OrderRequestBody" },
              },
            },
          },
          responses: { "201": jsonResponse("Created merchant order"), ...errorResponses() },
        },
      },
      "/merchants/{merchantId}/payment": {
        post: {
          tags: ["Merchant Runtime"],
          operationId: "attachMerchantPayment",
          summary: "Attach verified or demo payment proof to an order.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaymentProofBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Payment proof result"), ...errorResponses() },
        },
      },
      "/merchants/{merchantId}/payment-options": {
        post: {
          tags: ["Merchant Runtime"],
          operationId: "prepareMerchantPaymentOptions",
          summary: "Return normal checkout and web3 payment options for an order.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PaymentOptionsBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Payment options"), ...errorResponses() },
        },
      },
      "/merchants/{merchantId}/receipt": {
        post: {
          tags: ["Merchant Runtime"],
          operationId: "issueMerchantReceipt",
          summary: "Issue SLL-R receipt memory for a merchant order. Requires the merchant verifier secret, or demo=true when no secret is configured.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReceiptBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Receipt result"), ...errorResponses() },
        },
      },
      "/shopify/merchants": {
        get: {
          tags: ["Shopify"],
          operationId: "listShopifyMerchants",
          summary: "List Shopify-capable merchants and Storefront MCP endpoints.",
          responses: { "200": jsonResponse("Shopify merchants") },
        },
      },
      "/shopify/merchants/{merchantId}/connect": {
        get: {
          tags: ["Shopify"],
          operationId: "getShopifyConnectPlan",
          summary: "Return the merchant setup checklist for Shopify MCP, checkout, and webhooks.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          responses: { "200": jsonResponse("Shopify connect plan"), ...errorResponses() },
        },
      },
      "/shopify/merchants/{merchantId}/products": {
        get: {
          tags: ["Shopify"],
          operationId: "listShopifyProducts",
          summary: "Return product handoff data for a Shopify-capable merchant.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          responses: { "200": jsonResponse("Shopify product handoff"), ...errorResponses() },
        },
      },
      "/shopify/merchants/{merchantId}/cart": {
        post: {
          tags: ["Shopify"],
          operationId: "createShopifyCartHandoff",
          summary: "Create a Shopify checkout handoff for an SLL-R order or item.",
          parameters: [{ $ref: "#/components/parameters/MerchantId" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ShopifyCartBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Shopify cart handoff"), ...errorResponses() },
        },
      },
      "/webhooks/shopify/orders-paid": {
        post: {
          tags: ["Shopify"],
          operationId: "shopifyOrdersPaidWebhook",
          summary: "Accept a verified Shopify paid-order webhook and issue receipt memory.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          responses: { "200": jsonResponse("Shopify paid proof result"), ...errorResponses() },
        },
      },
      "/webhooks/shopify/orders-fulfilled": {
        post: {
          tags: ["Shopify"],
          operationId: "shopifyOrdersFulfilledWebhook",
          summary: "Accept a verified Shopify fulfillment webhook and issue receipt memory.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          responses: { "200": jsonResponse("Shopify fulfillment proof result"), ...errorResponses() },
        },
      },
      "/webhooks/shopify/refunds-create": {
        post: {
          tags: ["Shopify"],
          operationId: "shopifyRefundsCreateWebhook",
          summary: "Accept a verified Shopify refund webhook for future receipt reversal handling.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          responses: { "202": jsonResponse("Shopify refund proof accepted"), ...errorResponses() },
        },
      },
      "/base-plugin/coffee/merchants": {
        get: {
          tags: ["Base MCP"],
          operationId: "listBaseCoffeeMerchants",
          summary: "List coffee merchants that can prepare Base USDC payment calls.",
          responses: { "200": jsonResponse("Base coffee merchants") },
        },
      },
      "/base-plugin/coffee/quote": {
        get: {
          tags: ["Base MCP"],
          operationId: "quoteBaseCoffeeOrder",
          summary: "Quote a Base coffee order using GET-only query parameters.",
          parameters: [
            { $ref: "#/components/parameters/BaseMerchantId" },
            { $ref: "#/components/parameters/Intent" },
            { $ref: "#/components/parameters/MaxSpendUsd" },
            { $ref: "#/components/parameters/DeliverByDays" },
          ],
          responses: { "200": jsonResponse("Base coffee quote"), ...errorResponses() },
        },
      },
      "/base-plugin/coffee/order": {
        get: {
          tags: ["Base MCP"],
          operationId: "createBaseCoffeeOrder",
          summary: "Create a Base coffee order using GET-only query parameters.",
          parameters: [
            { $ref: "#/components/parameters/BaseMerchantId" },
            { $ref: "#/components/parameters/Intent" },
            { $ref: "#/components/parameters/MaxSpendUsd" },
            { $ref: "#/components/parameters/DeliverByDays" },
            {
              name: "agentId",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: { "201": jsonResponse("Base coffee order"), ...errorResponses() },
        },
      },
      "/base-plugin/coffee/prepare-payment": {
        get: {
          tags: ["Base MCP"],
          operationId: "prepareBaseCoffeePayment",
          summary: "Prepare Base USDC calldata for an order.",
          parameters: [
            { $ref: "#/components/parameters/OrderId" },
            {
              name: "from",
              in: "query",
              required: false,
              schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
            },
          ],
          responses: { "200": jsonResponse("Base payment handoff or transaction batch"), ...errorResponses() },
        },
      },
      "/base-plugin/coffee/record-demo-payment": {
        get: {
          tags: ["Base MCP"],
          operationId: "recordBaseCoffeeDemoPayment",
          summary: "Record a Base MCP payment request or transaction id for demo receipt memory.",
          parameters: [
            { $ref: "#/components/parameters/OrderId" },
            {
              name: "paymentId",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
            {
              name: "amountUsd",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: { "200": jsonResponse("Receipt memory result"), ...errorResponses() },
        },
      },
      "/base-plugin/coffee/status": {
        get: {
          tags: ["Base MCP"],
          operationId: "getBaseCoffeeStatus",
          summary: "Read the order and receipt memory status.",
          parameters: [{ $ref: "#/components/parameters/OrderId" }],
          responses: { "200": jsonResponse("Order status"), ...errorResponses() },
        },
      },
      "/solana-pay/merchants": {
        get: {
          tags: ["Solana"],
          operationId: "listSolanaPayMerchants",
          summary: "List merchants that support Solana Pay or Helio.",
          responses: { "200": jsonResponse("Solana Pay merchants") },
        },
      },
      "/solana-pay/prepare-payment": {
        get: {
          tags: ["Solana"],
          operationId: "prepareSolanaPayPayment",
          summary: "Prepare a Solana Pay URL or Helio checkout handoff.",
          parameters: [{ $ref: "#/components/parameters/OrderId" }],
          responses: { "200": jsonResponse("Solana payment handoff"), ...errorResponses() },
        },
      },
      "/solana-pay/verify-payment": {
        post: {
          tags: ["Solana"],
          operationId: "verifySolanaPayPayment",
          summary: "Verify or record Solana Pay proof for receipt memory.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SolanaPaymentProofBody" },
              },
            },
          },
          responses: { "200": jsonResponse("Solana proof result"), ...errorResponses() },
        },
      },
    },
    components: {
      parameters: {
        MerchantId: {
          name: "merchantId",
          in: "path",
          required: true,
          schema: { type: "string" },
          examples: {
            noun: { value: "noun-coffee" },
            raposa: { value: "raposa-shop" },
            solyd: { value: "solyd" },
          },
        },
        BaseMerchantId: {
          name: "merchantId",
          in: "query",
          required: false,
          schema: { type: "string", default: "noun-coffee" },
        },
        Intent: {
          name: "intent",
          in: "query",
          required: true,
          schema: { type: "string" },
          example: "Ship me Dalat Highlands coffee beans",
        },
        MaxSpendUsd: {
          name: "maxSpendUsd",
          in: "query",
          required: false,
          schema: { type: "string" },
          example: "40.00",
        },
        DeliverByDays: {
          name: "deliverByDays",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1 },
          example: 7,
        },
        OrderId: {
          name: "orderId",
          in: "query",
          required: true,
          schema: { type: "string" },
          example: "ord_...",
        },
      },
      schemas: {
        QuoteRequestBody: {
          type: "object",
          required: ["userIntent"],
          properties: {
            userIntent: { type: "string" },
            maxSpendUsd: { type: "string" },
            deadlineMinutes: { type: "integer", minimum: 1 },
            deliverByDays: { type: "integer", minimum: 1 },
            quantity: { type: "integer", minimum: 1 },
          },
        },
        OrderRequestBody: {
          allOf: [
            { $ref: "#/components/schemas/QuoteRequestBody" },
            {
              type: "object",
              properties: {
                agentId: { type: "string" },
                customerLabel: { type: "string" },
                paymentMode: { type: "string", enum: ["counter", "checkout", "crypto"] },
              },
            },
          ],
        },
        StandaloneAgentMessageBody: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string" },
            confirm: { type: "boolean" },
            maxSpendUsd: { type: "string" },
            deadlineMinutes: { type: "integer", minimum: 1 },
            deliverByDays: { type: "integer", minimum: 1 },
            quantity: { type: "integer", minimum: 1 },
            customerLabel: { type: "string" },
            paymentMode: { type: "string", enum: ["counter", "checkout", "crypto"] },
          },
        },
        PaymentProofBody: {
          type: "object",
          required: ["orderId", "provider", "paymentId"],
          properties: {
            orderId: { type: "string" },
            merchantId: { type: "string" },
            provider: { type: "string", enum: ["base_usdc", "solana_pay", "helio", "moonpay", "shopify", "stripe", "binance_pay"] },
            amountUsd: { type: "string" },
            paymentId: { type: "string" },
            reference: { type: "string" },
            demo: { type: "boolean" },
            verificationToken: { type: "string" },
          },
        },
        PaymentOptionsBody: {
          type: "object",
          required: ["orderId"],
          properties: {
            orderId: { type: "string" },
            payer: { type: "string", description: "Optional payer wallet or account address for rails that need it." },
          },
        },
        ShopifyCartBody: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            itemId: { type: "string" },
          },
          anyOf: [
            { required: ["orderId"] },
            { required: ["itemId"] },
          ],
        },
        SolanaPaymentProofBody: {
          type: "object",
          required: ["orderId", "reference"],
          properties: {
            orderId: { type: "string" },
            merchantId: { type: "string" },
            provider: { type: "string", enum: ["solana_pay", "helio"] },
            amountUsd: { type: "string" },
            paymentId: { type: "string" },
            signature: { type: "string" },
            reference: { type: "string" },
            demo: { type: "boolean" },
            verificationToken: { type: "string" },
          },
        },
        ReceiptBody: {
          type: "object",
          required: ["orderId"],
          properties: {
            orderId: { type: "string" },
            actor: { type: "string" },
            note: { type: "string" },
          },
        },
      },
    },
  };
}

export function aiPluginManifest(origin: string) {
  return {
    schema_version: "v1",
    name_for_human: "SLL-R",
    name_for_model: "sllr_agent_commerce",
    description_for_human: "Seller-side agent runtime for merchant quote, order, payment proof, and receipt memory.",
    description_for_model: "Use SLL-R to discover merchants, quote orders, create orders, prepare Base USDC payment calldata, and read receipt memory. Always ask the user before initiating any payment action.",
    auth: { type: "none" },
    api: {
      type: "openapi",
      url: `${origin}/openapi.json`,
      is_user_authenticated: false,
    },
    logo_url: `${origin}/sllr-logo.svg`,
    contact_email: "support@sll-r.local",
    legal_info_url: `${origin}/.well-known/sllr-agent.json`,
  };
}
