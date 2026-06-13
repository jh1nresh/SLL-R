import {
  attachMerchantPayment,
  createMerchantOrder,
  getMerchant,
  getMerchantMenu,
  issueMerchantReceipt,
  listMerchantOrders,
  listMerchants,
  quoteMerchantOrder,
} from "./core/merchantApi.js";
import { getOrder } from "./core/orders.js";
import { merchantPaymentOptions } from "./core/paymentOptions.js";
import { createDemoMerchant } from "./adapters/shopifyCatalog.js";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INSTRUCTIONS = [
  "SLL-R is a seller-side merchant runtime. Tools cover catalog discovery, quote, order, payment options, payment proof, fulfillment status, and receipt memory.",
  "Never submit or record a payment without explicit user approval.",
  "Before asking the user to approve payment, show merchant, item, amount, payment rail, and recipient or checkout URL.",
  "Most merchants accept non-crypto rails first: counter pay at pickup or Shopify checkout handoff. Crypto rails (base_usdc, solana_pay, helio) are optional adapters.",
  "Receipt memory must only be issued after payment proof or merchant fulfillment proof, never from order intent alone.",
  "attach_payment_proof with demo=true is local-demo proof only. Production requires the merchant verifier secret.",
].join("\n");

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type McpToolResultPayload = {
  status: number;
  payload: unknown | null;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, origin: string) => Promise<unknown> | unknown;
};

const quoteProperties = {
  merchantId: { type: "string", description: "Merchant id from list_merchants, for example raposa-coffee or solyd." },
  userIntent: { type: "string", description: "Natural-language buyer intent, for example 'I need an iced latte in 10 minutes.'" },
  maxSpendUsd: { type: "string", description: "Maximum budget in USD as a decimal string, for example '10.00'." },
  deadlineMinutes: { type: "number", description: "Pickup deadline in minutes for pickup merchants." },
  deliverByDays: { type: "number", description: "Shipping deadline in days for shipping merchants." },
  quantity: { type: "number", description: "Item quantity. Defaults to 1." },
} as const;

function requireString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`Missing required string argument: ${key}`), { status: 400 });
  }
  return value.trim();
}

const tools: ToolDefinition[] = [
  {
    name: "list_merchants",
    description: "List merchants that SLL-R can quote and order from, with fulfillment modes and supported payment rails.",
    inputSchema: { type: "object", properties: {} },
    handler: () => listMerchants(),
  },
  {
    name: "get_merchant",
    description: "Read one merchant profile: fulfillment modes, payment rails, and API links.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: { merchantId: quoteProperties.merchantId },
    },
    handler: (args) => getMerchant(requireString(args, "merchantId")),
  },
  {
    name: "get_menu",
    description: "Read the normalized catalog and menu sections for a merchant.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: { merchantId: quoteProperties.merchantId },
    },
    handler: (args) => getMerchantMenu(requireString(args, "merchantId")),
  },
  {
    name: "quote_order",
    description: "Quote buyer intent against the merchant catalog, budget, quantity, and pickup or shipping deadline. Always quote before creating an order.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "userIntent"],
      properties: quoteProperties,
    },
    handler: (args) => quoteMerchantOrder(requireString(args, "merchantId"), args),
  },
  {
    name: "create_order",
    description: "Create an SLL-R order after the user accepts the quote. Do not create orders the user has not confirmed.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "userIntent"],
      properties: {
        ...quoteProperties,
        agentId: { type: "string", description: "Identifier for the calling buyer agent." },
        customerLabel: { type: "string", description: "Display label for the customer, shown in the merchant terminal." },
        paymentMode: {
          type: "string",
          enum: ["counter", "checkout", "crypto"],
          description: "counter = pay at pickup, checkout = hosted checkout handoff, crypto = on-chain rail.",
        },
      },
    },
    handler: (args) => createMerchantOrder(requireString(args, "merchantId"), args),
  },
  {
    name: "list_orders",
    description: "List SLL-R orders for a merchant, optionally filtered by status.",
    inputSchema: {
      type: "object",
      required: ["merchantId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        status: { type: "string", description: "Optional order status filter, for example pending_payment or ready." },
      },
    },
    handler: (args) => listMerchantOrders(requireString(args, "merchantId"), typeof args.status === "string" ? args.status : null),
  },
  {
    name: "check_order_status",
    description: "Read current order state, payment status, fulfillment state, pickup promise, and receipt handoff.",
    inputSchema: {
      type: "object",
      required: ["orderId"],
      properties: { orderId: { type: "string", description: "SLL-R order id, for example ord_..." } },
    },
    handler: async (args) => {
      const orderId = requireString(args, "orderId");
      const order = await getOrder(orderId);
      if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
      return { product: "SLL-R merchant terminal", order };
    },
  },
  {
    name: "get_payment_options",
    description: "List payment options for an existing order across the merchant's enabled rails: counter pay, Shopify checkout, Base USDC, Solana Pay, or Helio. Show these to the user before any payment approval.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderId: { type: "string", description: "SLL-R order id returned by create_order." },
        payer: { type: "string", description: "Optional payer wallet address for on-chain rails." },
      },
    },
    handler: (args, origin) => merchantPaymentOptions(requireString(args, "merchantId"), args, origin),
  },
  {
    name: "attach_payment_proof",
    description: "Attach payment proof to an order. Production callers must supply the merchant verifier secret as verificationToken; demo=true is accepted only for local demos without a configured secret. Never call this without explicit user approval.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId", "provider", "paymentId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderId: { type: "string", description: "SLL-R order id." },
        provider: {
          type: "string",
          enum: ["counter", "telegram_staff", "shopify", "moonpay", "helio", "stripe", "solana_pay", "base_usdc", "binance_pay"],
          description: "Payment rail that produced the proof. Must be enabled in the merchant profile.",
        },
        paymentId: { type: "string", description: "Provider transaction, payment, or reference id." },
        amountUsd: { type: "string", description: "Paid amount in USD as a decimal string. Defaults to the order subtotal." },
        verificationToken: { type: "string", description: "Merchant payment verifier secret for production proof." },
        demo: { type: "boolean", description: "Local demo proof only. Production must use verificationToken." },
      },
    },
    handler: (args) => attachMerchantPayment(requireString(args, "merchantId"), {}, args),
  },
  {
    name: "create_demo_merchant",
    description: "Ingest a public Shopify storefront's products.json into a runtime demo merchant so it can be quoted and ordered immediately. Demo merchants get counter + Shopify checkout rails and reset on server restart. Use this to demo SLL-R against a real store's actual catalog.",
    inputSchema: {
      type: "object",
      required: ["storeDomain"],
      properties: {
        storeDomain: { type: "string", description: "Public storefront domain, for example panthercoffee.com. https is assumed." },
        name: { type: "string", description: "Merchant display name. Defaults to the domain." },
        merchantId: { type: "string", description: "Optional id; demo- prefix is enforced. Defaults to demo-<domain>." },
        category: { type: "string", description: "Merchant category, for example coffee_shop." },
        location: { type: "string", description: "Merchant location label." },
        fulfillment: { type: "string", enum: ["pickup", "shipping", "both"], description: "How orders are fulfilled. Defaults to shipping." },
        secret: { type: "string", description: "Required when SLLR_DEMO_MERCHANT_SECRET is configured on the server." },
      },
    },
    handler: (args, origin) => createDemoMerchant({}, args, origin),
  },
  {
    name: "issue_receipt",
    description: "Issue receipt memory for an order after merchant fulfillment proof. This is a merchant-side action gated by the merchant verifier secret: when the server has SLLR_MERCHANT_PAYMENT_VERIFY_SECRET configured, the caller must supply it as verificationToken; demo=true is only accepted when no secret is configured. Buyer agents should obtain receipts by paying (attach_payment_proof), which issues receipt memory automatically. Never issue receipt memory from order intent alone.",
    inputSchema: {
      type: "object",
      required: ["merchantId", "orderId"],
      properties: {
        merchantId: quoteProperties.merchantId,
        orderId: { type: "string", description: "SLL-R order id." },
        actor: { type: "string", description: "Who fulfilled the order, for example raposa-staff." },
        note: { type: "string", description: "Fulfillment note stored on the receipt." },
        verificationToken: { type: "string", description: "Merchant verifier secret, required when the server configures SLLR_MERCHANT_PAYMENT_VERIFY_SECRET." },
        demo: { type: "boolean", description: "Local demo proof only, accepted only when no verifier secret is configured." },
      },
    },
    handler: (args) => issueMerchantReceipt(requireString(args, "merchantId"), {}, args),
  },
];

function jsonRpcError(id: JsonRpcId, code: number, message: string, status = 200): McpToolResultPayload {
  return { status, payload: { jsonrpc: "2.0", id, error: { code, message } } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): McpToolResultPayload {
  return { status: 200, payload: { jsonrpc: "2.0", id, result } };
}

function negotiateProtocolVersion(params: unknown) {
  const requested = typeof params === "object" && params && "protocolVersion" in params
    ? (params as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

async function callTool(params: unknown, origin: string, id: JsonRpcId): Promise<McpToolResultPayload> {
  const name = typeof params === "object" && params && "name" in params
    ? (params as { name?: unknown }).name
    : undefined;
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return jsonRpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name : "(missing name)"}`);
  }
  const rawArguments = typeof params === "object" && params && "arguments" in params
    ? (params as { arguments?: unknown }).arguments
    : {};
  const args = typeof rawArguments === "object" && rawArguments ? rawArguments as Record<string, unknown> : {};
  try {
    const result = await tool.handler(args, origin);
    return jsonRpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SLL-R tool call failed.";
    return jsonRpcResult(id, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }
}

export function rejectMcpBrowserOrigin(originHeader: string | string[] | undefined, serverOrigin: string): boolean {
  // DNS-rebinding guard required by the MCP Streamable HTTP spec. Native MCP
  // clients do not send Origin; browsers always do.
  if (typeof originHeader !== "string" || !originHeader) return false;
  if (originHeader === serverOrigin) return false;
  try {
    const hostname = new URL(originHeader).hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return true;
  }
}

export async function handleMcpPost(body: unknown, origin: string): Promise<McpToolResultPayload> {
  if (Array.isArray(body)) {
    return jsonRpcError(null, -32600, "JSON-RPC batching is not supported by this server.", 400);
  }
  if (typeof body !== "object" || !body) {
    return jsonRpcError(null, -32600, "Request body must be a JSON-RPC message object.", 400);
  }
  const message = body as JsonRpcMessage;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request.", 400);
  }

  if (message.id === undefined || message.id === null) {
    // Notifications (for example notifications/initialized) get 202 with no body.
    return { status: 202, payload: null };
  }
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    return jsonRpcError(null, -32600, "JSON-RPC request id must be a string or number.", 400);
  }
  const id = message.id;

  switch (message.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(message.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sllr-merchant-mcp", title: "SLL-R Merchant MCP", version: "0.1.0" },
        instructions: SERVER_INSTRUCTIONS,
      });
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call":
      return callTool(message.params, origin, id);
    default:
      return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }
}
