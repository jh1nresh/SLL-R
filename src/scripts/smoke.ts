import { once } from "node:events";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { createSllrServer } from "../server.js";
import { resetStoreForTest, sllrStore, storeBackendName } from "../core/store.js";
import { confirmRun, listPendingRuns, sweepDueSubscriptions } from "../core/recurring.js";
import { getQuote } from "../core/quotes.js";
import { grantConsent } from "../core/consent.js";
import { getLoop, loopIdForQuote, loopIdForOrder } from "../core/actionLoop.js";
import { setItemAvailability } from "../core/availability.js";

async function postJson(origin: string, path: string, payload: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getJsonFailure(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const json = await response.json() as Record<string, unknown>;
  if (response.ok) {
    throw new Error(`${path} unexpectedly succeeded: ${JSON.stringify(json)}`);
  }
  return { status: response.status, json };
}

async function getText(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${text}`);
  return { response, text };
}

async function postJsonFailure(origin: string, path: string, payload: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await response.json() as Record<string, unknown>;
  if (response.ok) {
    throw new Error(`${path} unexpectedly succeeded: ${JSON.stringify(json)}`);
  }
  return { status: response.status, json };
}

let nextMcpRequestId = 0;

async function mcpRequest(origin: string, method: string, params?: unknown) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method, ...(params === undefined ? {} : { params }) }),
  });
  const json = await response.json() as { result?: Record<string, unknown>; error?: { code?: number; message?: string } };
  if (!response.ok || json.error) {
    throw new Error(`MCP ${method} failed: ${JSON.stringify(json)}`);
  }
  if (!json.result) throw new Error(`MCP ${method} returned no result: ${JSON.stringify(json)}`);
  return json.result;
}

async function mcpToolCall(origin: string, name: string, args: Record<string, unknown>) {
  const result = await mcpRequest(origin, "tools/call", { name, arguments: args }) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return result;
}

async function smokeMcp(origin: string) {
  const initialize = await mcpRequest(origin, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sllr-smoke", version: "0.0.1" },
  }) as { protocolVersion?: string; serverInfo?: { name?: string }; instructions?: string; capabilities?: { tools?: unknown } };
  if (
    initialize.protocolVersion !== "2025-06-18"
    || initialize.serverInfo?.name !== "sllr-merchant-mcp"
    || !initialize.capabilities?.tools
    || !initialize.instructions?.includes("Never submit or record a payment")
  ) {
    throw new Error(`MCP initialize was not useful: ${JSON.stringify(initialize)}`);
  }

  const initialized = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  if (initialized.status !== 202) {
    throw new Error(`MCP initialized notification should return 202, got ${initialized.status}`);
  }

  const getStream = await fetch(`${origin}/mcp`);
  if (getStream.status !== 405) {
    throw new Error(`MCP GET should return 405 for the stateless server, got ${getStream.status}`);
  }

  const toolsList = await mcpRequest(origin, "tools/list") as { tools?: Array<{ name?: string; inputSchema?: unknown }> };
  const toolNames = toolsList.tools?.map((tool) => tool.name) || [];
  for (const required of ["list_merchants", "get_menu", "quote_order", "create_order", "get_payment_options", "attach_payment_proof", "check_order_status", "issue_receipt", "create_demo_merchant"]) {
    if (!toolNames.includes(required)) {
      throw new Error(`MCP tools/list is missing ${required}: ${JSON.stringify(toolNames)}`);
    }
  }
  if (toolsList.tools?.some((tool) => !tool.inputSchema)) {
    throw new Error(`MCP tools/list returned a tool without inputSchema: ${JSON.stringify(toolsList)}`);
  }

  const merchants = await mcpToolCall(origin, "list_merchants", {});
  const merchantList = merchants.structuredContent as { merchants?: Array<{ id?: string }> } | undefined;
  if (merchants.isError || !merchantList?.merchants?.some((merchant) => merchant.id === "raposa-coffee")) {
    throw new Error(`MCP list_merchants failed: ${JSON.stringify(merchants)}`);
  }

  const quote = await mcpToolCall(origin, "quote_order", {
    merchantId: "raposa-coffee",
    userIntent: "I need an iced latte in 10 minutes.",
    deadlineMinutes: 10,
    maxSpendUsd: "10.00",
  });
  const quoteContent = quote.structuredContent as { quote?: { feasible?: boolean; item?: { id?: string } } } | undefined;
  if (quote.isError || !quoteContent?.quote?.feasible || quoteContent.quote.item?.id !== "iced-latte") {
    throw new Error(`MCP quote_order failed: ${JSON.stringify(quote)}`);
  }

  const order = await mcpToolCall(origin, "create_order", {
    merchantId: "raposa-coffee",
    userIntent: "I need an iced latte in 10 minutes.",
    deadlineMinutes: 10,
    maxSpendUsd: "10.00",
    agentId: "mcp-smoke",
    customerLabel: "MCP smoke customer",
    paymentMode: "counter",
  });
  const orderContent = order.structuredContent as { order?: { id?: string; status?: string } } | undefined;
  const orderId = orderContent?.order?.id;
  if (order.isError || !orderId || orderContent?.order?.status !== "pending_payment") {
    throw new Error(`MCP create_order failed: ${JSON.stringify(order)}`);
  }

  const paymentOptions = await mcpToolCall(origin, "get_payment_options", {
    merchantId: "raposa-coffee",
    orderId,
  });
  const optionsContent = paymentOptions.structuredContent as {
    paymentOptions?: Array<{ rail?: string }>;
    safety?: { requiresUserApproval?: boolean };
  } | undefined;
  if (
    paymentOptions.isError
    || !optionsContent?.safety?.requiresUserApproval
    || !optionsContent.paymentOptions?.some((option) => option.rail === "counter")
  ) {
    throw new Error(`MCP get_payment_options failed: ${JSON.stringify(paymentOptions)}`);
  }

  const status = await mcpToolCall(origin, "check_order_status", { orderId });
  const statusContent = status.structuredContent as { order?: { id?: string } } | undefined;
  if (status.isError || statusContent?.order?.id !== orderId) {
    throw new Error(`MCP check_order_status failed: ${JSON.stringify(status)}`);
  }

  const previousVerifierSecret = process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
  delete process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
  try {
    const proofWithoutVerifier = await mcpToolCall(origin, "attach_payment_proof", {
      merchantId: "raposa-coffee",
      orderId,
      provider: "counter",
      paymentId: "mcp_counter_no_verifier",
    });
    if (!proofWithoutVerifier.isError || !proofWithoutVerifier.content?.[0]?.text?.includes("SLLR_MERCHANT_PAYMENT_VERIFY_SECRET")) {
      throw new Error(`MCP attach_payment_proof without verifier should fail safely: ${JSON.stringify(proofWithoutVerifier)}`);
    }

    const demoProof = await mcpToolCall(origin, "attach_payment_proof", {
      merchantId: "raposa-coffee",
      orderId,
      provider: "counter",
      paymentId: "mcp_counter_demo",
      demo: true,
    });
    const demoProofContent = demoProof.structuredContent as { proofLevel?: string; order?: { payment?: { paymentId?: string } } } | undefined;
    if (demoProof.isError || demoProofContent?.proofLevel !== "receipt_memory_issued" || demoProofContent.order?.payment?.paymentId !== "mcp_counter_demo") {
      throw new Error(`MCP attach_payment_proof demo path failed: ${JSON.stringify(demoProof)}`);
    }
  } finally {
    if (previousVerifierSecret === undefined) {
      delete process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
    } else {
      process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET = previousVerifierSecret;
    }
  }

  const unknownOrder = await mcpToolCall(origin, "check_order_status", { orderId: "ord_does_not_exist" });
  if (!unknownOrder.isError) {
    throw new Error(`MCP check_order_status for unknown order should set isError: ${JSON.stringify(unknownOrder)}`);
  }

  const unknownTool = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/call", params: { name: "not_a_tool", arguments: {} } }),
  }).then((response) => response.json()) as { error?: { code?: number } };
  if (unknownTool.error?.code !== -32602) {
    throw new Error(`MCP unknown tool should return -32602: ${JSON.stringify(unknownTool)}`);
  }

  const browserOrigin = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/list" }),
  });
  if (browserOrigin.status !== 403) {
    throw new Error(`MCP cross-origin browser request should return 403, got ${browserOrigin.status}`);
  }

  const wrongContentType = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/list" }),
  });
  if (wrongContentType.status !== 415) {
    throw new Error(`MCP non-JSON content type should return 415, got ${wrongContentType.status}`);
  }

  const batchRejected = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/list" }]),
  });
  if (batchRejected.status !== 400) {
    throw new Error(`MCP batch request should return 400, got ${batchRejected.status}`);
  }

  const receiptOrder = await mcpToolCall(origin, "create_order", {
    merchantId: "raposa-coffee",
    userIntent: "I need a cold brew in 15 minutes.",
    deadlineMinutes: 15,
    maxSpendUsd: "10.00",
    agentId: "mcp-smoke",
    paymentMode: "counter",
  });
  const receiptOrderId = (receiptOrder.structuredContent as { order?: { id?: string } } | undefined)?.order?.id;
  if (receiptOrder.isError || !receiptOrderId) {
    throw new Error(`MCP receipt test order failed: ${JSON.stringify(receiptOrder)}`);
  }
  const receipt = await mcpToolCall(origin, "issue_receipt", {
    merchantId: "raposa-coffee",
    orderId: receiptOrderId,
    actor: "raposa-staff",
    note: "Counter paid and handed off during MCP smoke.",
    demo: true,
  });
  const receiptContent = receipt.structuredContent as { proofLevel?: string; order?: { receipt?: { receiptHash?: string } } } | undefined;
  if (receipt.isError || receiptContent?.proofLevel !== "receipt_memory_issued" || !receiptContent.order?.receipt?.receiptHash) {
    throw new Error(`MCP issue_receipt failed: ${JSON.stringify(receipt)}`);
  }
}

async function smokeReceiptGating(origin: string) {
  const previousSecret = process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
  process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET = "verify-smoke-secret";
  try {
    const order = await postJson(origin, "/merchants/raposa-coffee/orders", {
      userIntent: "I need an iced latte in 10 minutes.",
      deadlineMinutes: 10,
      maxSpendUsd: "10.00",
      paymentMode: "counter",
    }) as { order?: { id?: string } };
    const orderId = order.order?.id;
    if (!orderId) throw new Error(`Receipt-gating test order failed: ${JSON.stringify(order)}`);

    // Buyer-style caller with no verifier secret must not be able to mint a receipt.
    const receiptNoSecret = await postJsonFailure(origin, "/merchants/raposa-coffee/receipt", {
      orderId,
      actor: "attacker",
      note: "Trying to mint a receipt with no proof.",
    });
    if (receiptNoSecret.status !== 401) {
      throw new Error(`Receipt without verifier secret should be 401: ${JSON.stringify(receiptNoSecret)}`);
    }

    // Same via MCP issue_receipt — must surface an error, not a receipt.
    const mcpReceiptNoSecret = await mcpToolCall(origin, "issue_receipt", {
      merchantId: "raposa-coffee",
      orderId,
      actor: "attacker",
    });
    if (!mcpReceiptNoSecret.isError || !mcpReceiptNoSecret.content?.[0]?.text?.includes("verifier secret")) {
      throw new Error(`MCP issue_receipt without verifier secret should fail: ${JSON.stringify(mcpReceiptNoSecret)}`);
    }

    // Staff fulfill action without the secret is rejected too.
    const fulfillNoSecret = await postJsonFailure(origin, `/orders/${orderId}/fulfill`, {
      merchantId: "raposa-coffee",
      actor: "attacker",
    });
    if (fulfillNoSecret.status !== 401) {
      throw new Error(`Staff fulfill without verifier secret should be 401: ${JSON.stringify(fulfillNoSecret)}`);
    }

    // With the verifier secret, the merchant receipt path works.
    const receiptWithSecret = await postJson(origin, "/merchants/raposa-coffee/receipt", {
      orderId,
      actor: "raposa-staff",
      note: "Counter paid and handed off.",
      verificationToken: "verify-smoke-secret",
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string } } };
    if (receiptWithSecret.proofLevel !== "receipt_memory_issued" || !receiptWithSecret.order?.receipt?.receiptHash) {
      throw new Error(`Receipt with verifier secret failed: ${JSON.stringify(receiptWithSecret)}`);
    }
  } finally {
    if (previousSecret === undefined) {
      delete process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
    } else {
      process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET = previousSecret;
    }
  }
}

async function smokeDemoMerchants(origin: string) {
  const fixtureProducts = [
    {
      title: "House Blend 12oz",
      handle: "house-blend-12oz",
      product_type: "Coffee Beans",
      tags: "coffee, beans, medium roast",
      variants: [{ id: 1, title: "Default", price: "18.00", available: true }],
    },
    {
      title: "Single Origin Drip",
      handle: "single-origin-drip",
      product_type: "Drinks",
      tags: ["coffee", "drip"],
      variants: [
        { id: 2, title: "Small", price: "5.00", available: false },
        { id: 3, title: "Large", price: "6.50", available: true },
      ],
    },
    { title: "No Variants", handle: "no-variants", variants: [] },
    { title: "Bad Price", handle: "bad-price", variants: [{ id: 4, price: "free", available: true }] },
  ];

  const created = await postJson(origin, "/demo-merchants", {
    storeDomain: "demo-roaster-smoke.com",
    name: "Demo Roaster",
    category: "coffee_shop",
    location: "Austin",
    fulfillment: "pickup",
    products: fixtureProducts,
  }) as {
    merchant?: { id?: string; catalogItems?: number; paymentRails?: string[] };
    demo?: { agentPage?: string; examplePrompt?: string };
    source?: string;
  };
  if (
    created.merchant?.id !== "demo-roaster-smoke-com"
    || created.merchant.catalogItems !== 2
    || !created.merchant.paymentRails?.includes("counter")
    || !created.merchant.paymentRails.includes("shopify")
    || created.source !== "provided_products"
    || !created.demo?.agentPage?.endsWith("/agent/demo-roaster-smoke-com")
  ) {
    throw new Error(`Demo merchant ingestion failed: ${JSON.stringify(created)}`);
  }

  const merchantList = await getJson(origin, "/merchants") as { merchants?: Array<{ id?: string }> };
  if (!merchantList.merchants?.some((merchant) => merchant.id === "demo-roaster-smoke-com")) {
    throw new Error(`Demo merchant did not appear in /merchants: ${JSON.stringify(merchantList)}`);
  }

  const demoList = await getJson(origin, "/demo-merchants") as { merchants?: Array<{ id?: string }> };
  if (!demoList.merchants?.some((merchant) => merchant.id === "demo-roaster-smoke-com")) {
    throw new Error(`Demo merchant list endpoint failed: ${JSON.stringify(demoList)}`);
  }

  const demoQuote = await postJson(origin, "/merchants/demo-roaster-smoke-com/quote", {
    userIntent: "Get me the house blend coffee beans under $20.",
    maxSpendUsd: "20.00",
  }) as { quote?: { feasible?: boolean; item?: { id?: string } } };
  if (!demoQuote.quote?.feasible || demoQuote.quote.item?.id !== "house-blend-12oz") {
    throw new Error(`Demo merchant quote failed: ${JSON.stringify(demoQuote)}`);
  }

  const demoOrder = await postJson(origin, "/merchants/demo-roaster-smoke-com/orders", {
    userIntent: "Get me the house blend coffee beans under $20.",
    maxSpendUsd: "20.00",
    agentId: "demo-smoke",
    paymentMode: "counter",
  }) as { order?: { id?: string } };
  if (!demoOrder.order?.id) {
    throw new Error(`Demo merchant order failed: ${JSON.stringify(demoOrder)}`);
  }

  const demoOptions = await postJson(origin, `/merchants/demo-roaster-smoke-com/payment-options`, {
    orderId: demoOrder.order.id,
  }) as { paymentOptions?: Array<{ rail?: string; url?: string | null }> };
  const shopifyOption = demoOptions.paymentOptions?.find((option) => option.rail === "shopify");
  const counterOption = demoOptions.paymentOptions?.find((option) => option.rail === "counter");
  if (!counterOption || !shopifyOption?.url?.endsWith("/products/house-blend-12oz")) {
    throw new Error(`Demo merchant payment options failed: ${JSON.stringify(demoOptions)}`);
  }

  const demoAgentPage = await fetch(`${origin}/agent/demo-roaster-smoke-com`).then((response) => response.text());
  if (!demoAgentPage.includes("Demo Roaster")) {
    throw new Error("Demo merchant standalone agent page did not render.");
  }

  for (const badDomain of ["127.0.0.1", "localhost", "service.internal", "10.0.0.5", "demo", "127.1", "0x7f.0.0.1", "127.000.000.001", "192.168.1.1"]) {
    const rejected = await postJsonFailure(origin, "/demo-merchants", { storeDomain: badDomain, products: fixtureProducts });
    if (rejected.status !== 400) {
      throw new Error(`Demo merchant storeDomain ${badDomain} should be rejected with 400: ${JSON.stringify(rejected)}`);
    }
  }

  const badFulfillment = await postJsonFailure(origin, "/demo-merchants", {
    storeDomain: "demo-roaster-smoke.com",
    fulfillment: "teleport",
    products: fixtureProducts,
  });
  if (badFulfillment.status !== 400) {
    throw new Error(`Invalid fulfillment should be rejected: ${JSON.stringify(badFulfillment)}`);
  }

  const emptyCatalog = await postJsonFailure(origin, "/demo-merchants", {
    storeDomain: "empty-roaster-smoke.com",
    products: [{ title: "No Variants", handle: "no-variants", variants: [] }],
  });
  if (emptyCatalog.status !== 422) {
    throw new Error(`Empty mapped catalog should be rejected with 422: ${JSON.stringify(emptyCatalog)}`);
  }

  const previousDemoSecret = process.env.SLLR_DEMO_MERCHANT_SECRET;
  process.env.SLLR_DEMO_MERCHANT_SECRET = "demo-smoke-secret";
  try {
    const missingSecret = await postJsonFailure(origin, "/demo-merchants", {
      storeDomain: "demo-roaster-smoke.com",
      products: fixtureProducts,
    });
    if (missingSecret.status !== 401) {
      throw new Error(`Demo merchant without secret should be rejected with 401: ${JSON.stringify(missingSecret)}`);
    }
    const withSecret = await postJson(origin, "/demo-merchants", {
      storeDomain: "demo-roaster-smoke.com",
      products: fixtureProducts,
      secret: "demo-smoke-secret",
    }) as { merchant?: { id?: string } };
    if (withSecret.merchant?.id !== "demo-roaster-smoke-com") {
      throw new Error(`Demo merchant with secret failed: ${JSON.stringify(withSecret)}`);
    }
  } finally {
    if (previousDemoSecret === undefined) {
      delete process.env.SLLR_DEMO_MERCHANT_SECRET;
    } else {
      process.env.SLLR_DEMO_MERCHANT_SECRET = previousDemoSecret;
    }
  }
}

// Minimal in-process Upstash / Vercel KV REST server to exercise the
// RedisRestStore command encoding (GET/SET/SADD/SMEMBERS) end to end.
async function withFakeRedis<T>(run: () => Promise<T>): Promise<T> {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const token = "fake-redis-token";
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      return response.end(JSON.stringify({ error: "unauthorized" }));
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      let command: unknown;
      try {
        command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400);
        return response.end(JSON.stringify({ error: "bad json" }));
      }
      if (!Array.isArray(command) || typeof command[0] !== "string") {
        response.writeHead(400);
        return response.end(JSON.stringify({ error: "bad command" }));
      }
      const [op, key, value] = command as string[];
      let result: unknown = null;
      if (op === "SET") { values.set(key, value); result = "OK"; }
      else if (op === "GET") { result = values.has(key) ? values.get(key) : null; }
      else if (op === "SADD") {
        const set = sets.get(key) ?? new Set<string>();
        set.add(value);
        sets.set(key, set);
        result = 1;
      } else if (op === "SMEMBERS") { result = [...(sets.get(key) ?? [])]; }
      else { response.writeHead(400); return response.end(JSON.stringify({ error: `unsupported ${op}` })); }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result }));
    });
  });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start fake Redis.");
  const prevUrl = process.env.KV_REST_API_URL;
  const prevToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.KV_REST_API_TOKEN = token;
  resetStoreForTest();
  try {
    return await run();
  } finally {
    if (prevUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = prevUrl;
    if (prevToken === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = prevToken;
    resetStoreForTest();
    server.close();
  }
}

// Minimal in-process Supabase PostgREST server to exercise the SupabaseStore
// path encoding (kv upsert/select, index insert/select) end to end.
async function withFakeSupabase<T>(run: () => Promise<T>): Promise<T> {
  const kv = new Map<string, unknown>();
  const index = new Map<string, Set<string>>();
  const key = "fake-service-role-key";
  const server = createServer((request, response) => {
    if (request.headers.apikey !== key || request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401);
      return response.end(JSON.stringify({ message: "unauthorized" }));
    }
    const url = new URL(request.url || "/", "http://supabase.test");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const eqValue = (param: string) => (url.searchParams.get(param) || "").replace(/^eq\./, "");
      const sendJson = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (request.method === "GET" && url.pathname === "/rest/v1/sllr_kv") {
        const k = eqValue("key");
        return sendJson(200, kv.has(k) ? [{ value: kv.get(k) }] : []);
      }
      if (request.method === "POST" && url.pathname === "/rest/v1/sllr_kv") {
        const prefer = String(request.headers.prefer || "");
        const rows = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as Array<{ key: string; value: unknown }>;
        // Mirror PostgREST: a PK conflict without merge-duplicates is a 409.
        if (!url.searchParams.has("on_conflict") || !prefer.includes("resolution=merge-duplicates")) {
          if (rows.some((row) => kv.has(row.key))) return sendJson(409, { message: "duplicate key" });
        }
        for (const row of rows) kv.set(row.key, row.value);
        return sendJson(201, undefined);
      }
      if (request.method === "GET" && url.pathname === "/rest/v1/sllr_index") {
        const members = [...(index.get(eqValue("index_key")) ?? [])];
        return sendJson(200, members.map((member) => ({ member })));
      }
      if (request.method === "POST" && url.pathname === "/rest/v1/sllr_index") {
        const prefer = String(request.headers.prefer || "");
        const rows = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as Array<{ index_key: string; member: string }>;
        // Mirror PostgREST: a composite-PK conflict without ignore-duplicates is a 409.
        if (!url.searchParams.has("on_conflict") || !prefer.includes("resolution=ignore-duplicates")) {
          if (rows.some((row) => index.get(row.index_key)?.has(row.member))) return sendJson(409, { message: "duplicate member" });
        }
        for (const row of rows) {
          const set = index.get(row.index_key) ?? new Set<string>();
          set.add(row.member);
          index.set(row.index_key, set);
        }
        return sendJson(201, undefined);
      }
      sendJson(404, { message: `unsupported ${request.method} ${url.pathname}` });
    });
  });
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start fake Supabase.");
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  resetStoreForTest();
  try {
    return await run();
  } finally {
    if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
    resetStoreForTest();
    server.close();
  }
}

async function smokeStoreBackend() {
  await withFakeSupabase(async () => {
    if (storeBackendName() !== "supabase") {
      throw new Error(`Store should select supabase backend when SUPABASE env is set, got ${storeBackendName()}`);
    }
    const store = sllrStore();
    if (await store.getJson("sllr:test:missing") !== null) {
      throw new Error("Supabase missing key should round-trip as null.");
    }
    await store.setJson("sllr:test:order", { id: "ord_supa", status: "pending_payment" });
    await store.setJson("sllr:test:order", { id: "ord_supa", status: "accepted" });
    const loaded = await store.getJson<{ id?: string; status?: string }>("sllr:test:order");
    if (loaded?.id !== "ord_supa" || loaded.status !== "accepted") {
      throw new Error(`Supabase JSON upsert round-trip failed: ${JSON.stringify(loaded)}`);
    }
    await store.addToIndex("sllr:test:index", "ord_supa");
    await store.addToIndex("sllr:test:index", "ord_supa");
    await store.addToIndex("sllr:test:index", "ord_supa_2");
    const members = await store.indexMembers("sllr:test:index");
    if (members.length !== 2 || !members.includes("ord_supa") || !members.includes("ord_supa_2")) {
      throw new Error(`Supabase index insert/select failed: ${JSON.stringify(members)}`);
    }
  });
  await withFakeRedis(async () => {
    if (storeBackendName() !== "redis_rest") {
      throw new Error(`Store should select redis_rest backend when KV env is set, got ${storeBackendName()}`);
    }
    const store = sllrStore();
    if (await store.getJson("sllr:test:missing") !== null) {
      throw new Error("Missing key should round-trip as null.");
    }
    await store.setJson("sllr:test:order", { id: "ord_redis", status: "pending_payment" });
    const loaded = await store.getJson<{ id?: string; status?: string }>("sllr:test:order");
    if (loaded?.id !== "ord_redis" || loaded.status !== "pending_payment") {
      throw new Error(`Redis-backed JSON round-trip failed: ${JSON.stringify(loaded)}`);
    }
    await store.addToIndex("sllr:test:index", "ord_redis");
    await store.addToIndex("sllr:test:index", "ord_redis");
    await store.addToIndex("sllr:test:index", "ord_redis_2");
    const members = await store.indexMembers("sllr:test:index");
    if (members.length !== 2 || !members.includes("ord_redis") || !members.includes("ord_redis_2")) {
      throw new Error(`Redis-backed index (SADD/SMEMBERS) failed: ${JSON.stringify(members)}`);
    }
  });
  if (storeBackendName() !== "memory") {
    throw new Error("Store should fall back to memory backend after KV env is cleared.");
  }
}

// ETA trust (pilot closure Gap 3): the quote's ETA is queue-aware (same formula
// as the order promise), and with SLLR_ETA_RECONFIRM=true an order whose wait now
// exceeds the buyer's deadline / the quoted ETA is NOT silently created — it asks
// for reconfirmation (acceptDelay).
async function smokeEtaReconfirm(origin: string) {
  const fruitTea = { userIntent: "fruit tea", deadlineMinutes: 10, paymentMode: "counter" };

  // Baseline quote: empty queue → ETA = prep minutes (2 for fruit-tea).
  const q0 = await postJson(origin, "/merchants/game-day-boba/quote", fruitTea) as { etaMinutes?: number; quote?: { estimate?: { readyInMinutes?: number } } };
  if (q0.quote?.estimate?.readyInMinutes !== 2 || q0.etaMinutes !== 2) {
    throw new Error(`baseline quote ETA should be prep(2): ${JSON.stringify({ eta: q0.etaMinutes, est: q0.quote?.estimate })}`);
  }

  // Saturate the cold production class (capacity 12 → +15 min per full window).
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${origin}/merchants/game-day-boba/orders`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIntent: "taro milk", paymentMode: "counter" }),
    });
    if (!r.ok) throw new Error(`saturation order ${i} failed: ${r.status}`);
  }

  // Quote is HONEST about the queue now: 2 + 15 = 17 min, not prep-only.
  const q1 = await postJson(origin, "/merchants/game-day-boba/quote", fruitTea) as { etaMinutes?: number };
  if (q1.etaMinutes !== 17) throw new Error(`queue-aware quote ETA should be 17, got ${q1.etaMinutes}`);

  const prev = process.env.SLLR_ETA_RECONFIRM;
  process.env.SLLR_ETA_RECONFIRM = "true";
  try {
    // Wait (17) exceeds the buyer's 10-min deadline → 409 reconfirm, no order.
    const blocked = await fetch(`${origin}/merchants/game-day-boba/orders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fruitTea),
    });
    const blockedBody = await blocked.json() as { error?: string };
    if (blocked.status !== 409 || !/acceptDelay/.test(String(blockedBody.error))) {
      throw new Error(`over-deadline order should 409 with reconfirm, got ${blocked.status}: ${JSON.stringify(blockedBody)}`);
    }
    // Buyer re-confirms the longer wait → order created, promise matches the
    // same queue-aware formula (no contradiction).
    const ok = await postJson(origin, "/merchants/game-day-boba/orders", { ...fruitTea, acceptDelay: true }) as { order?: { promise?: { estimatedWaitMinutes?: number } } };
    if (ok.order?.promise?.estimatedWaitMinutes !== 17) {
      throw new Error(`reconfirmed order promise should be 17 min, got ${JSON.stringify(ok.order?.promise?.estimatedWaitMinutes)}`);
    }
    // No deadline + no stale quote → unaffected by the gate.
    const free = await fetch(`${origin}/merchants/game-day-boba/orders`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIntent: "fruit tea", paymentMode: "counter" }),
    });
    if (!free.ok) throw new Error(`no-deadline order should not be gated: ${free.status}`);
  } finally {
    if (prev === undefined) delete process.env.SLLR_ETA_RECONFIRM; else process.env.SLLR_ETA_RECONFIRM = prev;
  }
}

// Verified review / outcome layer (spec: local-commerce-os-for-agents §5). A
// review only exists with proof; it records verifiedBy + eta + feedback and feeds
// merchant ETA reliability.
async function smokeVerifiedReview(origin: string) {
  const s = await postJson(origin, "/buyer/session", { label: "review buyer" }) as { token?: string; buyerId?: string };
  const token = s.token!;
  const auth = { authorization: `Bearer ${token}` };
  const created = await fetch(`${origin}/merchants/solyd/orders`, {
    method: "POST", headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ userIntent: "Ship me a black MagSafe iPhone 16 case under $100", maxSpendUsd: "100.00", deliverByDays: 7, paymentMode: "checkout" }),
  }).then((r) => r.json()) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
  const orderId = created.order?.id!;

  // No proof yet → review blocked.
  const early = await fetch(`${origin}/orders/${orderId}/review`, {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ feedback: { rating: 5 } }),
  });
  if (early.status !== 409) throw new Error(`review before proof should be 409, got ${early.status}`);

  // Pay (demo webhook) → payment proof → eligible.
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    await postJson(origin, "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_rev", payment_status: "paid", amount_total: Math.round(Number(created.order?.item?.subtotalUsd) * 100), metadata: { sllr_order_id: orderId, sllr_merchant_id: "solyd" } } },
      demo: true,
    });
  } finally {
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
  }

  const reviewed = await postJson(origin, `/orders/${orderId}/review`, {
    feedback: { rating: 5, wouldRepeat: true, note: "fast" },
    agentDecision: { userIntent: "case under $100", whyRecommended: "in budget + fast", alternativesRejected: ["pricier case"] },
  }, auth) as { review?: { verifiedBy?: string[]; agentUsable?: boolean; feedback?: { rating?: number }; agentDecision?: { whyRecommended?: string } } };
  if (!reviewed.review?.verifiedBy?.includes("stripe_payment") || !reviewed.review.verifiedBy.includes("user_feedback")) {
    throw new Error(`verified review missing proofs: ${JSON.stringify(reviewed.review)}`);
  }
  if (reviewed.review.agentUsable !== true || reviewed.review.feedback?.rating !== 5 || reviewed.review.agentDecision?.whyRecommended !== "in budget + fast") {
    throw new Error(`verified review fields wrong: ${JSON.stringify(reviewed.review)}`);
  }
  const list = await getJson(origin, "/merchants/solyd/reviews") as { reviews?: Array<{ orderId?: string }> };
  if (!list.reviews?.some((r) => r.orderId === orderId)) throw new Error(`merchant reviews missing the new review: ${JSON.stringify(list)}`);
}

// Game Day Boba demo (spec: local-commerce-os-for-agents). The signature move:
// "what can I get in 10 min, cold, not too sweet, under $10" → Fruit Tea picked;
// fried chicken (too slow), brown sugar (sweet), taro (86'd) rejected with reasons.
async function smokeGameDayBoba(origin: string) {
  await setItemAvailability("game-day-boba", "taro-milk", false); // 86 taro for the demo
  const rec = await postJson(origin, "/merchants/game-day-boba/recommend", {
    deadlineMinutes: 10, maxSpendUsd: "10.00", includeTags: ["cold"], excludeTags: ["sweet"],
  }) as {
    picks?: Array<{ itemId?: string; reason?: string }>;
    rejected?: Array<{ itemId?: string; reason?: string }>;
  };
  if (rec.picks?.[0]?.itemId !== "fruit-tea") {
    throw new Error(`game-day-boba should pick fruit-tea first: ${JSON.stringify(rec.picks)}`);
  }
  const rejectOf = (id: string) => rec.rejected?.find((r) => r.itemId === id);
  const chicken = rejectOf("fried-chicken");
  const sweet = rejectOf("brown-sugar-boba");
  const taro = rejectOf("taro-milk");
  if (!chicken?.reason?.includes("min")) throw new Error(`fried chicken should be rejected as too slow: ${JSON.stringify(chicken)}`);
  if (!sweet?.reason?.includes("sweet")) throw new Error(`brown sugar boba should be rejected as sweet: ${JSON.stringify(sweet)}`);
  if (taro?.reason !== "sold out") throw new Error(`86'd taro should be rejected as sold out: ${JSON.stringify(taro)}`);
  await setItemAvailability("game-day-boba", "taro-milk", true); // restore
}

// Action-loop logging (spec: loop-engineering, Phase 1). Verifies quote/order/
// payment flows + policy blocks become first-class loop events, threaded by
// quoteId / order link. Additive + best-effort — never alters the real action.
async function smokeActionLoop(origin: string) {
  // Part A — order + payment loop (consent gate off, default).
  const o = await postJson(origin, "/merchants/solyd/orders", {
    userIntent: "Ship me a black MagSafe iPhone 16 case under $100",
    maxSpendUsd: "100.00", deliverByDays: 7, paymentMode: "checkout",
  }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
  const orderId = o.order?.id;
  if (!orderId) throw new Error(`action-loop: order not created: ${JSON.stringify(o)}`);
  const orderLoop = await getLoop(loopIdForOrder(orderId));
  if (!orderLoop || !orderLoop.events.some((e) => e.eventType === "order") || orderLoop.currentState !== "order_created") {
    throw new Error(`action-loop: order event not logged: ${JSON.stringify(orderLoop)}`);
  }

  // Pay via the demo Stripe webhook → payment + receipt event on the SAME loop.
  const cents = Math.round(Number(o.order?.item?.subtotalUsd) * 100);
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    await postJson(origin, "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_loop", payment_status: "paid", amount_total: cents, metadata: { sllr_order_id: orderId, sllr_merchant_id: "solyd" } } },
      demo: true,
    });
  } finally {
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
  }
  const paidLoop = await getLoop(loopIdForOrder(orderId));
  if (!paidLoop?.events.some((e) => e.eventType === "payment") || paidLoop.currentState !== "receipt_issued") {
    throw new Error(`action-loop: payment event not logged: ${JSON.stringify(paidLoop)}`);
  }

  // Part B — quote loop + policy_block on a no-consent order (gate on).
  const prevFlag = process.env.SLLR_REQUIRE_CONSENT;
  process.env.SLLR_REQUIRE_CONSENT = "true";
  try {
    const cold = { userIntent: "cold brew in 10 minutes", deadlineMinutes: 10, paymentMode: "counter" };
    const q = await postJson(origin, "/merchants/raposa-coffee/quote", cold) as { quoteId?: string };
    const quoteLoop = await getLoop(loopIdForQuote(q.quoteId!));
    if (!quoteLoop?.events.some((e) => e.eventType === "quote")) {
      throw new Error(`action-loop: quote event not logged: ${JSON.stringify(quoteLoop)}`);
    }
    // Order without consent → blocked → policy_block event on the quote's loop.
    const blocked = await fetch(`${origin}/merchants/raposa-coffee/orders`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cold, quoteId: q.quoteId }),
    });
    if (blocked.status !== 409) throw new Error(`action-loop: expected 409, got ${blocked.status}`);
    const blockLoop = await getLoop(loopIdForQuote(q.quoteId!));
    if (!blockLoop?.events.some((e) => e.eventType === "policy_block") || blockLoop.evalStatus !== "blocked" || !blockLoop.policyBlocks.length) {
      throw new Error(`action-loop: policy_block not logged: ${JSON.stringify(blockLoop)}`);
    }
  } finally {
    if (prevFlag === undefined) delete process.env.SLLR_REQUIRE_CONSENT; else process.env.SLLR_REQUIRE_CONSENT = prevFlag;
  }
}

// Quote→consent→order gate (opt-in SLLR_REQUIRE_CONSENT). Verifies "no quote /
// no consent → no order", quote-bound consent, price-drift block, and expiry.
async function smokeConsentGate(origin: string) {
  const prev = process.env.SLLR_REQUIRE_CONSENT;
  process.env.SLLR_REQUIRE_CONSENT = "true";
  const order = (body: Record<string, unknown>) =>
    fetch(`${origin}/merchants/raposa-coffee/orders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  try {
    const cold = { userIntent: "cold brew in 10 minutes", deadlineMinutes: 10, paymentMode: "counter" };

    // 1. create_order with neither quote nor consent → blocked.
    const bare = await order(cold);
    if (bare.status !== 409) throw new Error(`order without consent should be 409, got ${bare.status}`);

    // 2. quote → returns a quoteId + confirmation text.
    const q = await postJson(origin, "/merchants/raposa-coffee/quote", cold) as { quoteId?: string; amountUsd?: string; confirmationText?: string };
    if (!q.quoteId?.startsWith("quote_") || !q.confirmationText?.startsWith("CONFIRM $")) {
      throw new Error(`quote did not return a bindable quoteId: ${JSON.stringify(q)}`);
    }

    // 3. create_order with a quote but no consent → still blocked.
    const noConsent = await order({ ...cold, quoteId: q.quoteId });
    if (noConsent.status !== 409) throw new Error(`order with quote but no consent should be 409, got ${noConsent.status}`);

    // 4. consent with a wrong confirmation phrase → 422.
    const badText = await fetch(`${origin}/consent`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: q.quoteId, confirmationText: "yes" }),
    });
    if (badText.status !== 422) throw new Error(`bad confirmation text should be 422, got ${badText.status}`);

    // 5. consent ok → consentId.
    const c = await postJson(origin, "/consent", { quoteId: q.quoteId }) as { consent?: { id?: string } };
    if (!c.consent?.id?.startsWith("cons_")) throw new Error(`consent not granted: ${JSON.stringify(c)}`);

    // 6. create_order with quote + consent → order created.
    const okRes = await order({ ...cold, quoteId: q.quoteId, consentId: c.consent.id });
    const ok = await okRes.json() as { order?: { id?: string } };
    if (!okRes.ok || !ok.order?.id) throw new Error(`consented order should be created: ${okRes.status} ${JSON.stringify(ok)}`);

    // 7. price drift: reuse the cold-brew consent but order a different (pricier)
    //    item → fresh quote amount ≠ consent amount → blocked.
    const drift = await order({ userIntent: "iced latte in 10 minutes", deadlineMinutes: 10, paymentMode: "counter", quoteId: q.quoteId, consentId: c.consent.id });
    if (drift.status !== 409) throw new Error(`price-drift order should be 409, got ${drift.status}`);

    // 8. expired quote → consent refused (deterministic via injected now).
    const q2 = await postJson(origin, "/merchants/raposa-coffee/quote", cold) as { quoteId?: string };
    const stored = await getQuote(q2.quoteId!);
    if (!stored) throw new Error("quote was not persisted for expiry test.");
    const afterExpiry = new Date(new Date(stored.expiresAt).getTime() + 1000).toISOString();
    let refused = false;
    try {
      await grantConsent({ quoteId: stored.id, buyerId: stored.buyerId }, afterExpiry);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("consent on an expired quote should be refused.");
  } finally {
    if (prev === undefined) delete process.env.SLLR_REQUIRE_CONSENT; else process.env.SLLR_REQUIRE_CONSENT = prev;
  }
}

// In-process fake Stripe API + signed-webhook test for the prepay-in-flow path.
async function smokeStripePrepay(origin: string) {
  // Fake Stripe API: only the checkout session create endpoint.
  const stripeApi = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer sk_test_smoke") {
      response.writeHead(401); return response.end(JSON.stringify({ error: { message: "bad key" } }));
    }
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "cs_test_smoke123", url: "https://checkout.stripe.test/c/cs_test_smoke123" }));
    });
  });
  stripeApi.listen(0);
  await once(stripeApi, "listening");
  const addr = stripeApi.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to start fake Stripe.");

  const prevBase = process.env.STRIPE_API_BASE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${addr.port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_smoke";
  try {
    // SOLYD supports the stripe rail. Create an order, then payment-options
    // should return a real Stripe checkout_url.
    const order = await postJson(origin, "/merchants/solyd/orders", {
      userIntent: "Ship me a black MagSafe iPhone 16 case under $100",
      maxSpendUsd: "100.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    const orderId = order.order?.id;
    if (!orderId) throw new Error(`Stripe test order failed: ${JSON.stringify(order)}`);

    const options = await postJson(origin, "/merchants/solyd/payment-options", { orderId }) as {
      paymentOptions?: Array<{ rail?: string; type?: string; url?: string }>;
    };
    const stripeOption = options.paymentOptions?.find((o) => o.rail === "stripe");
    if (!stripeOption || stripeOption.type !== "checkout_url" || !stripeOption.url?.includes("checkout.stripe.test")) {
      throw new Error(`Stripe prepare-payment did not return a checkout URL: ${JSON.stringify(options.paymentOptions)}`);
    }

    // Webhook demo path (no STRIPE_WEBHOOK_SECRET): demo=true issues receipt.
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const amountCents = Math.round(Number(order.order?.item?.subtotalUsd) * 100);
    const demoEvent = {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_smoke123", payment_status: "paid", amount_total: amountCents, metadata: { sllr_order_id: orderId, sllr_merchant_id: "solyd" } } },
      demo: true,
    };
    const demoPaid = await postJson(origin, "/webhooks/stripe", demoEvent) as { proofLevel?: string; order?: { payment?: { provider?: string }; receipt?: { receiptHash?: string } } };
    if (demoPaid.proofLevel !== "receipt_memory_issued" || demoPaid.order?.payment?.provider !== "stripe" || !demoPaid.order.receipt?.receiptHash) {
      throw new Error(`Stripe demo webhook did not issue receipt memory: ${JSON.stringify(demoPaid)}`);
    }

    // An unpaid completed session must NOT issue receipt memory (ignored).
    const unpaidOrder = await postJson(origin, "/merchants/solyd/orders", {
      userIntent: "Ship me a clear MagSafe iPhone 16 case under $100",
      maxSpendUsd: "100.00", deliverByDays: 7, paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    const unpaid = await postJson(origin, "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_unpaid", payment_status: "unpaid", amount_total: Math.round(Number(unpaidOrder.order?.item?.subtotalUsd) * 100), metadata: { sllr_order_id: unpaidOrder.order?.id, sllr_merchant_id: "solyd" } } },
      demo: true,
    }) as { ignored?: string; proofLevel?: string };
    if (unpaid.ignored !== "checkout.session.completed" || unpaid.proofLevel === "receipt_memory_issued") {
      throw new Error(`Stripe unpaid session should be ignored, not receipted: ${JSON.stringify(unpaid)}`);
    }

    // Underpayment must be rejected (fresh order, demo path).
    const underOrder = await postJson(origin, "/merchants/solyd/orders", {
      userIntent: "Ship me a black MagSafe iPhone 16 case under $100",
      maxSpendUsd: "100.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string } };
    const underPaid = await postJsonFailure(origin, "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_under", payment_status: "paid", amount_total: 100, metadata: { sllr_order_id: underOrder.order?.id, sllr_merchant_id: "solyd" } } },
      demo: true,
    });
    if (underPaid.status !== 409) {
      throw new Error(`Stripe underpayment should be rejected with 409: ${JSON.stringify(underPaid)}`);
    }

    // Signed-webhook path on a fresh order.
    const order2 = await postJson(origin, "/merchants/solyd/orders", {
      userIntent: "Ship me a clear MagSafe iPhone 16 case under $100",
      maxSpendUsd: "100.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    const order2Id = order2.order?.id as string;
    const whSecret = "whsec_smoke_secret";
    process.env.STRIPE_WEBHOOK_SECRET = whSecret;
    const body2 = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_smoke456", payment_status: "paid", amount_total: Math.round(Number(order2.order?.item?.subtotalUsd) * 100), metadata: { sllr_order_id: order2Id, sllr_merchant_id: "solyd" } } },
    });
    // Current timestamp so the signature passes the replay-tolerance window.
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", whSecret).update(`${ts}.${body2}`, "utf8").digest("hex");
    const signedRes = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` },
      body: body2,
    });
    const signed = await signedRes.json() as { proofLevel?: string };
    if (!signedRes.ok || signed.proofLevel !== "receipt_memory_issued") {
      throw new Error(`Stripe signed webhook did not issue receipt memory: ${JSON.stringify(signed)}`);
    }

    // Bad signature must be rejected.
    const badRes = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=deadbeef` },
      body: body2,
    });
    if (badRes.status !== 401) {
      throw new Error(`Stripe webhook with bad signature should be 401, got ${badRes.status}`);
    }

    // A signature with a stale timestamp must be rejected as a possible replay.
    const staleTs = (Math.floor(Date.now() / 1000) - 3600).toString();
    const staleSig = createHmac("sha256", whSecret).update(`${staleTs}.${body2}`, "utf8").digest("hex");
    const staleRes = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${staleTs},v1=${staleSig}` },
      body: body2,
    });
    if (staleRes.status !== 401) {
      throw new Error(`Stripe webhook with stale timestamp should be 401 (replay), got ${staleRes.status}`);
    }

    // A malformed STRIPE_WEBHOOK_TOLERANCE_SEC must FAIL CLOSED (fall back to the
    // 300s default), not silently disable replay protection.
    const prevTol = process.env.STRIPE_WEBHOOK_TOLERANCE_SEC;
    process.env.STRIPE_WEBHOOK_TOLERANCE_SEC = "5m"; // typo → NaN
    const typoRes = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${staleTs},v1=${staleSig}` },
      body: body2,
    });
    if (typoRes.status !== 401) {
      throw new Error(`Malformed tolerance must fail closed (reject stale), got ${typoRes.status}`);
    }
    // Explicit 0 disables the window (dashboard resend of historical events).
    process.env.STRIPE_WEBHOOK_TOLERANCE_SEC = "0";
    const disabledRes = await fetch(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${staleTs},v1=${staleSig}` },
      body: body2,
    });
    if (!disabledRes.ok) {
      throw new Error(`tolerance=0 should accept a stale-but-signed event, got ${disabledRes.status}`);
    }
    if (prevTol === undefined) delete process.env.STRIPE_WEBHOOK_TOLERANCE_SEC; else process.env.STRIPE_WEBHOOK_TOLERANCE_SEC = prevTol;
  } finally {
    if (prevBase === undefined) delete process.env.STRIPE_API_BASE; else process.env.STRIPE_API_BASE = prevBase;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
    stripeApi.close();
  }
}

// Card-on-file (off-session) path: SetupIntent to save a card, then "pay with
// saved card" — succeeds, is idempotent, and falls back on no-card / SCA /
// decline. Uses a fake Stripe API keyed on the payment_method id.
async function smokeCardOnFile(origin: string) {
  // Fake Stripe: customers + setup_intents + payment_intents. The off-session
  // charge result is keyed on the payment_method id sent in the form body.
  const stripeApi = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer sk_test_smoke") {
      response.writeHead(401); return response.end(JSON.stringify({ error: { message: "bad key" } }));
    }
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const url = request.url || "";
      const send = (status: number, obj: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(obj));
      };
      if (url.startsWith("/customers")) {
        return send(200, { id: "cus_smoke_123", metadata: { sllr_buyer_id: params.get("metadata[sllr_buyer_id]") } });
      }
      if (url.startsWith("/setup_intents")) {
        return send(200, { id: "seti_smoke_123", client_secret: "seti_smoke_123_secret" });
      }
      if (url.startsWith("/payment_intents")) {
        const pm = params.get("payment_method") || "";
        if (pm === "pm_decline") {
          return send(402, { error: { message: "Your card was declined.", code: "card_declined", decline_code: "generic_decline" } });
        }
        if (pm === "pm_sca") {
          return send(402, { error: { message: "Authentication required.", code: "authentication_required", payment_intent: { id: "pi_sca_123" } } });
        }
        return send(200, { id: "pi_smoke_123", status: "succeeded" });
      }
      send(404, { error: { message: `unexpected path ${url}` } });
    });
  });
  stripeApi.listen(0);
  await once(stripeApi, "listening");
  const addr = stripeApi.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to start fake Stripe (card-on-file).");

  const prevBase = process.env.STRIPE_API_BASE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${addr.port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_smoke";
  delete process.env.STRIPE_WEBHOOK_SECRET; // demo webhook path saves the card

  const newBuyer = async () => {
    const s = await postJson(origin, "/buyer/session", { label: "card buyer" }) as { token?: string; buyerId?: string };
    if (!s.token || !s.buyerId) throw new Error(`buyer session failed: ${JSON.stringify(s)}`);
    return s as { token: string; buyerId: string };
  };
  const orderFor = async (token: string) => {
    const res = await fetch(`${origin}/merchants/raposa-coffee/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ userIntent: "iced latte in 10 minutes", deadlineMinutes: 10, maxSpendUsd: "10.00", paymentMode: "counter" }),
    });
    const j = await res.json() as { order?: { id?: string; buyerId?: string } };
    if (!res.ok || !j.order?.id) throw new Error(`order create failed: ${JSON.stringify(j)}`);
    return j.order.id;
  };
  // Fire the demo setup_intent.succeeded webhook that saves a card for a buyer.
  const saveCard = async (buyerId: string, paymentMethod: string) => {
    const saved = await postJson(origin, "/webhooks/stripe", {
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_smoke_123", customer: "cus_smoke_123", payment_method: paymentMethod, metadata: { sllr_buyer_id: buyerId } } },
      demo: true,
    }) as { saved?: boolean; buyerId?: string };
    if (!saved.saved || saved.buyerId !== buyerId) throw new Error(`card save webhook failed: ${JSON.stringify(saved)}`);
  };
  const pay = async (token: string, orderId: string) =>
    postJson(origin, "/buyer/pay", { orderId }, { authorization: `Bearer ${token}` }) as Promise<{ status?: string; order?: { payment?: { provider?: string }; receipt?: { receiptHash?: string } } }>;

  try {
    // 1. card/setup requires a buyer token.
    const noAuth = await fetch(`${origin}/buyer/card/setup`, { method: "POST" });
    if (noAuth.status !== 401) throw new Error(`card/setup without token should be 401, got ${noAuth.status}`);

    // 2. card/setup returns a SetupIntent client secret + customer id.
    const buyerA = await newBuyer();
    const setup = await postJson(origin, "/buyer/card/setup", {}, { authorization: `Bearer ${buyerA.token}` }) as { clientSecret?: string; customerId?: string };
    if (setup.clientSecret !== "seti_smoke_123_secret" || setup.customerId !== "cus_smoke_123") {
      throw new Error(`card/setup did not return a SetupIntent: ${JSON.stringify(setup)}`);
    }

    // 3. paying before a card is saved → no_card (caller falls back to Checkout).
    const orderA = await orderFor(buyerA.token);
    const beforeCard = await pay(buyerA.token, orderA);
    if (beforeCard.status !== "no_card") throw new Error(`pay before card should be no_card: ${JSON.stringify(beforeCard)}`);

    // 4. save a good card, then off-session charge → paid + receipt memory issued.
    await saveCard(buyerA.buyerId, "pm_good");
    const paid = await pay(buyerA.token, orderA);
    if (paid.status !== "paid" || paid.order?.payment?.provider !== "stripe" || !paid.order.receipt?.receiptHash) {
      throw new Error(`pay with saved card did not settle the order: ${JSON.stringify(paid)}`);
    }

    // 5. idempotent: paying the same order again → already_paid (no double charge).
    const again = await pay(buyerA.token, orderA);
    if (again.status !== "already_paid") throw new Error(`re-pay should be already_paid: ${JSON.stringify(again)}`);

    // 6. ownership: another buyer cannot charge buyer A's order → 403.
    const buyerB = await newBuyer();
    const forbidden = await postJsonFailure(origin, "/buyer/pay", { orderId: orderA });
    // postJsonFailure uses no auth header → 401; re-check with B's token for 403.
    void forbidden;
    const crossRes = await fetch(`${origin}/buyer/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${buyerB.token}` },
      body: JSON.stringify({ orderId: orderA }),
    });
    if (crossRes.status !== 403) throw new Error(`cross-buyer pay should be 403, got ${crossRes.status}`);

    // 7. declined card → status declined, order stays unpaid.
    const buyerC = await newBuyer();
    await saveCard(buyerC.buyerId, "pm_decline");
    const orderC = await orderFor(buyerC.token);
    const declined = await pay(buyerC.token, orderC);
    if (declined.status !== "declined") throw new Error(`declined card should return declined: ${JSON.stringify(declined)}`);
    const stillUnpaid = await pay(buyerC.token, orderC); // not already_paid
    if (stillUnpaid.status === "already_paid" || stillUnpaid.status === "paid") {
      throw new Error(`declined order must not be marked paid: ${JSON.stringify(stillUnpaid)}`);
    }

    // 8. SCA-required card → requires_action (caller offers a hosted link).
    const buyerD = await newBuyer();
    await saveCard(buyerD.buyerId, "pm_sca");
    const orderD = await orderFor(buyerD.token);
    const sca = await pay(buyerD.token, orderD);
    if (sca.status !== "requires_action") throw new Error(`SCA card should return requires_action: ${JSON.stringify(sca)}`);
  } finally {
    if (prevBase === undefined) delete process.env.STRIPE_API_BASE; else process.env.STRIPE_API_BASE = prevBase;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
    stripeApi.close();
  }
}

// Card on file via the FIRST checkout: a buyer-bound hosted Checkout saves the
// card (setup_future_usage); the checkout.session.completed webhook captures the
// PaymentMethod; a later order then charges linklessly with no SetupIntent step.
async function smokeCheckoutSavesCard(origin: string) {
  const stripeApi = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer sk_test_smoke") {
      response.writeHead(401); return response.end(JSON.stringify({ error: { message: "bad key" } }));
    }
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      const u = request.url || "";
      const send = (status: number, obj: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(obj)); };
      if (u.startsWith("/customers")) return send(200, { id: "cus_chk_123" });
      if (u.startsWith("/checkout/sessions")) return send(200, { id: "cs_chk_123", url: "https://checkout.stripe.test/c/cs_chk_123" });
      // GET /payment_intents/{id} → the saved card the webhook captures.
      if (request.method === "GET" && u.startsWith("/payment_intents/")) return send(200, { id: "pi_chk_123", payment_method: "pm_chk_123", status: "succeeded" });
      // POST /payment_intents → the later off-session charge.
      if (u.startsWith("/payment_intents")) return send(200, { id: "pi_chk_456", status: "succeeded" });
      send(404, { error: { message: `unexpected ${u}` } });
    });
  });
  stripeApi.listen(0);
  await once(stripeApi, "listening");
  const addr = stripeApi.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to start fake Stripe (checkout-saves-card).");

  const prevBase = process.env.STRIPE_API_BASE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${addr.port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_smoke";
  delete process.env.STRIPE_WEBHOOK_SECRET; // demo webhook path

  const orderFor = async (token: string) => {
    const res = await fetch(`${origin}/merchants/solyd/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ userIntent: "Ship me a black MagSafe iPhone 16 case under $100", maxSpendUsd: "100.00", deliverByDays: 7, paymentMode: "checkout" }),
    });
    const j = await res.json() as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    if (!res.ok || !j.order?.id) throw new Error(`order create failed: ${JSON.stringify(j)}`);
    return j.order;
  };

  try {
    const s = await postJson(origin, "/buyer/session", { label: "checkout-save buyer" }) as { token?: string; buyerId?: string };
    if (!s.token || !s.buyerId) throw new Error(`buyer session failed: ${JSON.stringify(s)}`);

    // First order: buyer-bound checkout. payment-options creates a Stripe session
    // attached to the buyer's Customer with setup_future_usage.
    const order1 = await orderFor(s.token);
    const opts = await postJson(origin, "/merchants/solyd/payment-options", { orderId: order1.id }) as { paymentOptions?: Array<{ rail?: string; type?: string; url?: string }> };
    const stripeOpt = opts.paymentOptions?.find((o) => o.rail === "stripe");
    if (stripeOpt?.type !== "checkout_url" || !stripeOpt.url?.includes("checkout.stripe.test")) {
      throw new Error(`buyer-bound checkout did not return a checkout URL: ${JSON.stringify(opts.paymentOptions)}`);
    }

    // The checkout completes → receipt issued AND the card is captured/saved.
    const cents = Math.round(Number(order1.item?.subtotalUsd) * 100);
    const paid = await postJson(origin, "/webhooks/stripe", {
      type: "checkout.session.completed",
      data: { object: { id: "cs_chk_123", payment_status: "paid", amount_total: cents, customer: "cus_chk_123", payment_intent: "pi_chk_123", metadata: { sllr_order_id: order1.id, sllr_merchant_id: "solyd" } } },
      demo: true,
    }) as { proofLevel?: string };
    if (paid.proofLevel !== "receipt_memory_issued") throw new Error(`checkout webhook did not issue receipt: ${JSON.stringify(paid)}`);

    // Proof the card stuck: a SECOND order charges off-session with NO SetupIntent
    // and NO link — only possible if the first checkout saved the card.
    const order2 = await orderFor(s.token);
    const pay = await postJson(origin, "/buyer/pay", { orderId: order2.id }, { authorization: `Bearer ${s.token}` }) as { status?: string };
    if (pay.status !== "paid") {
      throw new Error(`second order should charge the card saved by the first checkout, got: ${JSON.stringify(pay)}`);
    }
  } finally {
    if (prevBase === undefined) delete process.env.STRIPE_API_BASE; else process.env.STRIPE_API_BASE = prevBase;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
    stripeApi.close();
  }
}

// Recurring orders (confirm-each): subscription → cron sweep opens a confirm
// prompt → buyer confirms → order + off-session charge, capped per run. Drives
// the sweep/confirm core with an injected future `now` so a just-created
// subscription is due, against the same in-process store the server uses.
async function smokeRecurring(origin: string) {
  // Capture each off-session charge's idempotency key so we can assert recurring
  // anchors it to the run (one charge per run across retries).
  const chargeKeys: string[] = [];
  const stripeApi = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer sk_test_smoke") {
      response.writeHead(401); return response.end(JSON.stringify({ error: { message: "bad key" } }));
    }
    const idemKey = (request.headers["idempotency-key"] as string | undefined) || "";
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const u = request.url || "";
      const send = (status: number, obj: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(obj)); };
      if (u.startsWith("/customers")) return send(200, { id: "cus_rec_123" });
      if (u.startsWith("/setup_intents")) return send(200, { id: "seti_rec_123", client_secret: "seti_rec_123_secret" });
      if (u.startsWith("/payment_intents")) {
        chargeKeys.push(idemKey);
        const pm = params.get("payment_method") || "";
        if (pm === "pm_decline") return send(402, { error: { message: "declined", code: "card_declined", decline_code: "generic_decline" } });
        return send(200, { id: "pi_rec_123", status: "succeeded" });
      }
      send(404, { error: { message: `unexpected ${u}` } });
    });
  });
  stripeApi.listen(0);
  await once(stripeApi, "listening");
  const addr = stripeApi.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to start fake Stripe (recurring).");

  const prevBase = process.env.STRIPE_API_BASE;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${addr.port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_smoke";
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const FUTURE = "2999-01-01T12:00:00.000Z";
  const JUST_AFTER = "2999-01-01T12:01:00.000Z"; // within the 2h confirm window
  const AFTER_EXPIRY = "2999-01-01T15:00:00.000Z"; // past expiresAt (FUTURE + 2h)

  const newBuyer = async () => {
    const s = await postJson(origin, "/buyer/session", { label: "recurring buyer" }) as { token?: string; buyerId?: string };
    if (!s.token || !s.buyerId) throw new Error(`buyer session failed: ${JSON.stringify(s)}`);
    return s as { token: string; buyerId: string };
  };
  const saveCard = async (buyerId: string, pm: string) => {
    const saved = await postJson(origin, "/webhooks/stripe", {
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_rec_123", customer: "cus_rec_123", payment_method: pm, metadata: { sllr_buyer_id: buyerId } } },
      demo: true,
    }) as { saved?: boolean };
    if (!saved.saved) throw new Error(`card save failed: ${JSON.stringify(saved)}`);
  };
  // noun-coffee keeps recurring orders off raposa's pickup-capacity window, which
  // a later on_time assertion depends on. Crowd Pleaser pourover is $11.20.
  const createSub = async (token: string, maxPerRunUsd: string) => {
    const res = await postJson(origin, "/buyer/recurring", {
      merchantId: "noun-coffee",
      template: { userIntent: "crowd pleaser pourover under $15 in 15 minutes", deadlineMinutes: 15, maxSpendUsd: "15.00" },
      schedule: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], hour: 8, minute: 0, tz: "America/Los_Angeles" },
      maxPerRunUsd,
    }, { authorization: `Bearer ${token}` }) as { subscription?: { id?: string }; cardOnFile?: boolean };
    if (!res.subscription?.id) throw new Error(`create subscription failed: ${JSON.stringify(res)}`);
    return res;
  };
  const runIdFor = async (buyerId: string, nowIso: string) => {
    const runs = await listPendingRuns(buyerId, nowIso);
    return runs[0]?.id;
  };

  try {
    // suggestRecurring hint rides on the order response ("SLL-R asks").
    const hintBuyer = await newBuyer();
    const order = await fetch(`${origin}/merchants/noun-coffee/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${hintBuyer.token}` },
      body: JSON.stringify({ userIntent: "crowd pleaser pourover under $15 in 15 minutes", deadlineMinutes: 15, maxSpendUsd: "15.00", paymentMode: "counter" }),
    }).then((r) => r.json()) as { suggestRecurring?: { eligible?: boolean; prompt?: string } };
    if (!order.suggestRecurring?.eligible || !order.suggestRecurring.prompt) {
      throw new Error(`order missing recurring suggestion: ${JSON.stringify(order.suggestRecurring)}`);
    }

    // Sweep is secret-gated.
    const noSecret = await fetch(`${origin}/internal/recurring/sweep`, { method: "POST" });
    if (noSecret.status !== 401) throw new Error(`sweep without secret should be 401, got ${noSecret.status}`);

    // Set up buyers + cards + subscriptions, then sweep once at a future instant.
    const a = await newBuyer(); await saveCard(a.buyerId, "pm_good"); await createSub(a.token, "15.00");
    const b = await newBuyer(); await saveCard(b.buyerId, "pm_good"); await createSub(b.token, "1.00"); // cap below subtotal
    const c = await newBuyer(); await createSub(c.token, "15.00"); // no card
    const d = await newBuyer(); await saveCard(d.buyerId, "pm_decline"); await createSub(d.token, "15.00");
    const e = await newBuyer(); const eSub = await createSub(e.token, "15.00");
    const f = await newBuyer(); await saveCard(f.buyerId, "pm_good"); await createSub(f.token, "15.00");

    // Cancel E's subscription via REST → it must NOT be swept.
    const del = await fetch(`${origin}/buyer/recurring/${eSub.subscription!.id}`, { method: "DELETE", headers: { authorization: `Bearer ${e.token}` } });
    if (!del.ok) throw new Error(`cancel subscription failed: ${del.status}`);

    const created = await sweepDueSubscriptions(FUTURE);
    if (!created.length) throw new Error("sweep created no runs for due subscriptions.");
    if (created.some((r) => r.buyerId === e.buyerId)) throw new Error("canceled subscription was swept.");

    // A: confirm → charged + receipt issued; second confirm → already_done.
    const aRun = await runIdFor(a.buyerId, JUST_AFTER);
    if (!aRun) throw new Error("no pending run for buyer A.");
    const aPaid = await confirmRun(aRun, a.buyerId, JUST_AFTER);
    if (aPaid.status !== "charged" || aPaid.order?.payment?.provider !== "stripe" || !aPaid.order.receipt?.receiptHash) {
      throw new Error(`recurring confirm did not charge + receipt: ${JSON.stringify(aPaid)}`);
    }
    const aAgain = await confirmRun(aRun, a.buyerId, JUST_AFTER);
    if (aAgain.status !== "already_done") throw new Error(`re-confirm should be already_done: ${JSON.stringify(aAgain)}`);
    // H1: the charge must be anchored to the run, and re-confirm must NOT hit
    // Stripe a second time (exactly one off-session charge for this run).
    const aCharges = chargeKeys.filter((k) => k === `sllr_recurring_${aRun}`);
    if (aCharges.length !== 1) {
      throw new Error(`recurring run must charge exactly once with a run-anchored key, saw: ${JSON.stringify(chargeKeys)}`);
    }

    // B: order subtotal exceeds maxPerRunUsd cap → over_cap, not charged.
    const bRun = await runIdFor(b.buyerId, JUST_AFTER);
    const bRes = await confirmRun(bRun!, b.buyerId, JUST_AFTER);
    if (bRes.status !== "over_cap") throw new Error(`over-cap run should be over_cap: ${JSON.stringify(bRes)}`);
    if (bRes.order?.payment?.status === "verified") throw new Error("over-cap order must not be charged.");

    // C: no saved card → no_card.
    const cRun = await runIdFor(c.buyerId, JUST_AFTER);
    const cRes = await confirmRun(cRun!, c.buyerId, JUST_AFTER);
    if (cRes.status !== "no_card") throw new Error(`cardless run should be no_card: ${JSON.stringify(cRes)}`);

    // D: declined card → declined.
    const dRun = await runIdFor(d.buyerId, JUST_AFTER);
    const dRes = await confirmRun(dRun!, d.buyerId, JUST_AFTER);
    if (dRes.status !== "declined") throw new Error(`declined card run should be declined: ${JSON.stringify(dRes)}`);

    // F: confirm after the prompt's expiry window → expired (never charges late).
    const fRun = await runIdFor(f.buyerId, JUST_AFTER);
    const fRes = await confirmRun(fRun!, f.buyerId, AFTER_EXPIRY);
    if (fRes.status !== "expired") throw new Error(`stale run should expire, not charge: ${JSON.stringify(fRes)}`);
  } finally {
    if (prevBase === undefined) delete process.env.STRIPE_API_BASE; else process.env.STRIPE_API_BASE = prevBase;
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
    if (prevWh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;
    stripeApi.close();
  }
}

// In-process fake LINE Pay Online API to exercise the request -> confirm flow.
async function smokeLinePay(origin: string) {
  const channelSecret = "line_pay_channel_secret";
  const validTxId = "2024999999";
  const linePayApi = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(Buffer.from(c)));
    request.on("end", () => {
      const url = new URL(request.url || "/", "http://linepay.test");
      const body = Buffer.concat(chunks).toString("utf8");
      const nonce = String(request.headers["x-line-authorization-nonce"] || "");
      const sig = String(request.headers["x-line-authorization"] || "");
      // Validate the LINE Pay v3 signature so a wrong scheme fails the test.
      const expected = createHmac("sha256", channelSecret).update(channelSecret + url.pathname + body + nonce, "utf8").digest("base64");
      if (!request.headers["x-line-channelid"] || !nonce || sig !== expected) {
        response.writeHead(401); return response.end(JSON.stringify({ returnCode: "1106", returnMessage: "bad signature" }));
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/v3/payments/request") {
        return response.end(JSON.stringify({ returnCode: "0000", returnMessage: "OK", info: { transactionId: validTxId, paymentUrl: { web: "https://sandbox-web-pay.line.me/web/payment/wait?transactionId=" + validTxId, app: "line://pay/payment/x" } } }));
      }
      const confirmMatch = url.pathname.match(/^\/v3\/payments\/([^/]+)\/confirm$/);
      if (confirmMatch) {
        // Unknown transaction id is rejected upstream (anti-forgery).
        if (confirmMatch[1] !== validTxId) {
          return response.end(JSON.stringify({ returnCode: "1198", returnMessage: "transaction not found" }));
        }
        return response.end(JSON.stringify({ returnCode: "0000", returnMessage: "OK", info: { orderId: "x", transactionId: validTxId } }));
      }
      response.writeHead(404); response.end(JSON.stringify({ returnCode: "1104", returnMessage: "unsupported" }));
    });
  });
  linePayApi.listen(0);
  await once(linePayApi, "listening");
  const addr = linePayApi.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to start fake LINE Pay.");

  const prev = {
    base: process.env.LINE_PAY_API_BASE, id: process.env.LINE_PAY_CHANNEL_ID,
    secret: process.env.LINE_PAY_CHANNEL_SECRET, cur: process.env.LINE_PAY_CURRENCY,
  };
  try {
    // Without config, the rail is setup_required.
    delete process.env.LINE_PAY_CHANNEL_ID; delete process.env.LINE_PAY_CHANNEL_SECRET;
    const louisaOrder = await postJson(origin, "/merchants/louisa-coffee/orders", {
      userIntent: "拿鐵 latte pickup in 10 minutes", deadlineMinutes: 10, paymentMode: "counter",
    }) as { order?: { id?: string; item?: { id?: string } } };
    const orderId = louisaOrder.order?.id;
    if (!orderId || louisaOrder.order?.item?.id !== "latte") {
      throw new Error(`Louisa order failed: ${JSON.stringify(louisaOrder)}`);
    }
    const unconfigured = await postJson(origin, "/merchants/louisa-coffee/payment-options", { orderId }) as {
      paymentOptions?: Array<{ rail?: string; type?: string }>;
    };
    if (unconfigured.paymentOptions?.find((o) => o.rail === "line_pay")?.type !== "setup_required") {
      throw new Error(`LINE Pay should be setup_required without config: ${JSON.stringify(unconfigured.paymentOptions)}`);
    }

    // Configure the fake LINE Pay and prepare a payment.
    process.env.LINE_PAY_API_BASE = `http://127.0.0.1:${addr.port}`;
    process.env.LINE_PAY_CHANNEL_ID = "1234567890";
    process.env.LINE_PAY_CHANNEL_SECRET = "line_pay_channel_secret";
    process.env.LINE_PAY_CURRENCY = "TWD";
    const options = await postJson(origin, "/merchants/louisa-coffee/payment-options", { orderId }) as {
      paymentOptions?: Array<{ rail?: string; type?: string; url?: string; transactionId?: string; currency?: string }>;
    };
    const lp = options.paymentOptions?.find((o) => o.rail === "line_pay");
    if (lp?.type !== "payment_url" || !lp.url?.includes("line.me") || !lp.transactionId || lp.currency !== "TWD") {
      throw new Error(`LINE Pay prepare did not return a payment URL: ${JSON.stringify(options.paymentOptions)}`);
    }

    // Simulate the redirect-back confirm.
    const confirmRes = await fetch(`${origin}/line-pay/confirm?orderId=${encodeURIComponent(orderId)}&transactionId=${encodeURIComponent(lp.transactionId)}`);
    const confirmed = await confirmRes.json() as { proofLevel?: string; order?: { payment?: { provider?: string }; receipt?: { receiptHash?: string } } };
    if (!confirmRes.ok || confirmed.proofLevel !== "receipt_memory_issued" || confirmed.order?.payment?.provider !== "line_pay" || !confirmed.order.receipt?.receiptHash) {
      throw new Error(`LINE Pay confirm did not issue receipt memory: ${JSON.stringify(confirmed)}`);
    }

    // Anti-forgery: a confirm with an unknown transactionId is rejected upstream
    // (returnCode != 0000) and must NOT issue receipt memory.
    const forgeOrder = await postJson(origin, "/merchants/louisa-coffee/orders", {
      userIntent: "americano pickup", deadlineMinutes: 10, paymentMode: "counter",
    }) as { order?: { id?: string } };
    const forged = await fetch(`${origin}/line-pay/confirm?orderId=${encodeURIComponent(forgeOrder.order?.id || "")}&transactionId=9999000099990000`);
    if (forged.status !== 502) {
      throw new Error(`LINE Pay confirm with unknown transactionId should fail (502), got ${forged.status}`);
    }
  } finally {
    for (const [k, v] of [["LINE_PAY_API_BASE", prev.base], ["LINE_PAY_CHANNEL_ID", prev.id], ["LINE_PAY_CHANNEL_SECRET", prev.secret], ["LINE_PAY_CURRENCY", prev.cur]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    linePayApi.close();
  }
}

async function smokeBuyerAuth(origin: string) {
  // Issue a buyer session.
  const session = await postJson(origin, "/buyer/session", { label: "smoke buyer" }) as { token?: string; buyerId?: string; expiresAt?: string };
  if (!session.token?.startsWith("sllrb_") || !session.buyerId?.startsWith("buyer_") || !session.expiresAt) {
    throw new Error(`Buyer session not issued: ${JSON.stringify(session)}`);
  }
  const token = session.token;

  // REST order with Bearer token binds to the buyerId.
  const authedRes = await fetch(`${origin}/merchants/raposa-coffee/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ userIntent: "iced latte in 10 minutes", deadlineMinutes: 10, maxSpendUsd: "10.00", paymentMode: "counter" }),
  });
  const authed = await authedRes.json() as { order?: { id?: string; buyerId?: string } };
  if (!authedRes.ok || authed.order?.buyerId !== session.buyerId) {
    throw new Error(`Authed order did not bind buyerId: ${JSON.stringify(authed)}`);
  }

  // GET /buyer/orders with the token lists it.
  const myOrdersRes = await fetch(`${origin}/buyer/orders`, { headers: { authorization: `Bearer ${token}` } });
  const myOrders = await myOrdersRes.json() as { buyerId?: string; orders?: Array<{ id?: string }> };
  if (!myOrdersRes.ok || myOrders.buyerId !== session.buyerId || !myOrders.orders?.some((o) => o.id === authed.order?.id)) {
    throw new Error(`/buyer/orders did not list the authed order: ${JSON.stringify(myOrders)}`);
  }

  // /buyer/orders without a token is rejected.
  const noToken = await fetch(`${origin}/buyer/orders`);
  if (noToken.status !== 401) throw new Error(`/buyer/orders without token should be 401, got ${noToken.status}`);

  // MCP create_order with the Bearer token binds buyerId; list_my_orders sees it.
  const mcpCreate = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/call", params: { name: "create_order", arguments: { merchantId: "raposa-coffee", userIntent: "cortado pickup in 10 min", deadlineMinutes: 10, paymentMode: "counter" } } }),
  }).then((r) => r.json()) as { result?: { structuredContent?: { order?: { id?: string; buyerId?: string } } } };
  const mcpOrder = mcpCreate.result?.structuredContent?.order;
  if (mcpOrder?.buyerId !== session.buyerId) {
    throw new Error(`MCP create_order did not bind buyerId from Bearer: ${JSON.stringify(mcpCreate)}`);
  }
  const mcpMine = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/call", params: { name: "list_my_orders", arguments: {} } }),
  }).then((r) => r.json()) as { result?: { structuredContent?: { orders?: Array<{ id?: string }> } } };
  if (!mcpMine.result?.structuredContent?.orders?.some((o) => o.id === mcpOrder?.id)) {
    throw new Error(`MCP list_my_orders did not return the buyer's order: ${JSON.stringify(mcpMine)}`);
  }

  // list_my_orders without a buyer session is an error.
  const mcpAnon = await mcpToolCall(origin, "list_my_orders", {});
  if (!mcpAnon.isError || !mcpAnon.content?.[0]?.text?.includes("buyer session")) {
    throw new Error(`MCP list_my_orders without buyer should fail: ${JSON.stringify(mcpAnon)}`);
  }

  // Anonymous ordering still works when auth is not required.
  const anon = await postJson(origin, "/merchants/raposa-coffee/orders", {
    userIntent: "espresso", maxSpendUsd: "10.00", paymentMode: "counter",
  }) as { order?: { id?: string; buyerId?: string | null } };
  if (!anon.order?.id || anon.order.buyerId) {
    throw new Error(`Anonymous order should succeed with null buyerId: ${JSON.stringify(anon)}`);
  }

  // FORGERY GUARD: a client-supplied buyerId in the body must be ignored, not
  // trusted — an anon order claiming the victim's buyerId must NOT bind to it
  // nor appear in the victim's /buyer/orders.
  const forged = await postJson(origin, "/merchants/raposa-coffee/orders", {
    userIntent: "espresso", maxSpendUsd: "10.00", paymentMode: "counter", buyerId: session.buyerId,
  }) as { order?: { id?: string; buyerId?: string | null } };
  if (forged.order?.buyerId) {
    throw new Error(`Client-supplied buyerId must be ignored, got: ${JSON.stringify(forged.order)}`);
  }
  const afterForge = await fetch(`${origin}/buyer/orders`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json()) as { orders?: Array<{ id?: string }> };
  if (afterForge.orders?.some((o) => o.id === forged.order?.id)) {
    throw new Error(`Forged order leaked into victim's /buyer/orders: ${JSON.stringify(afterForge)}`);
  }

  // Same forgery via MCP must also be ignored.
  const mcpForged = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextMcpRequestId, method: "tools/call", params: { name: "create_order", arguments: { merchantId: "raposa-coffee", userIntent: "espresso", paymentMode: "counter", buyerId: session.buyerId } } }),
  }).then((r) => r.json()) as { result?: { structuredContent?: { order?: { buyerId?: string | null } } } };
  if (mcpForged.result?.structuredContent?.order?.buyerId) {
    throw new Error(`MCP client-supplied buyerId must be ignored: ${JSON.stringify(mcpForged)}`);
  }

  // With SLLR_REQUIRE_BUYER_AUTH, anonymous create is rejected; authed still works.
  const prev = process.env.SLLR_REQUIRE_BUYER_AUTH;
  process.env.SLLR_REQUIRE_BUYER_AUTH = "true";
  try {
    const rejected = await postJsonFailure(origin, "/merchants/raposa-coffee/orders", {
      userIntent: "iced latte", maxSpendUsd: "10.00", paymentMode: "counter",
    });
    if (rejected.status !== 401) throw new Error(`Anon order under require-auth should be 401: ${JSON.stringify(rejected)}`);
    const stillOk = await fetch(`${origin}/merchants/raposa-coffee/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ userIntent: "cold brew", maxSpendUsd: "10.00", paymentMode: "counter" }),
    });
    if (!stillOk.ok) throw new Error(`Authed order under require-auth should succeed, got ${stillOk.status}`);
  } finally {
    if (prev === undefined) delete process.env.SLLR_REQUIRE_BUYER_AUTH; else process.env.SLLR_REQUIRE_BUYER_AUTH = prev;
  }

  // Revocation (last — invalidates `token`): a revoked token no longer authorizes.
  const revokeRes = await fetch(`${origin}/buyer/session`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!revokeRes.ok) throw new Error(`Revoke should succeed, got ${revokeRes.status}`);
  const afterRevoke = await fetch(`${origin}/buyer/orders`, { headers: { authorization: `Bearer ${token}` } });
  if (afterRevoke.status !== 401) throw new Error(`Revoked token should be 401, got ${afterRevoke.status}`);
}

async function main() {
  const server = createSllrServer();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start smoke server.");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const world = await getText(origin, "/world");
    if (
      !world.response.headers.get("content-type")?.includes("text/html")
      || !world.text.includes("Tell the store what you need.")
      || !world.text.includes("Every completed order can build trust.")
      || !world.text.includes("/world/assets/intent-m.mp4")
      || !world.text.includes("/world/assets/intent-m.webp")
      || !world.text.includes("/world/assets/connector-fulfillment-receipt-m.mp4")
      || !world.text.includes("/agent/raposa-shop")
    ) {
      throw new Error("Merchant journey page did not expose the complete desktop/mobile story.");
    }
    const engine = await getText(origin, "/world/engine.js");
    if (
      !engine.response.headers.get("content-type")?.includes("text/javascript")
      || !engine.text.includes("prefers-reduced-motion")
      || !engine.text.includes("clipMobile")
      || !engine.text.includes("aria-current")
    ) {
      throw new Error("Merchant journey engine did not expose motion and accessibility safeguards.");
    }
    const unknownAsset = await fetch(`${origin}/world/assets/not-allowed.mp4`);
    if (unknownAsset.status !== 404) {
      throw new Error(`Unknown merchant journey asset should be 404, got ${unknownAsset.status}.`);
    }

    const root = await getJson(origin, "/") as {
      product?: string;
      agentDiscovery?: {
        openapi?: string;
        baseMcpPluginSpec?: string;
        sllrMcpManifest?: string;
        solanaPluginSpec?: string;
      };
      baseMcpDemo?: { quote?: string; preparePayment?: string };
    };
    if (
      root.product !== "SLL-R"
      || !(root.agentDiscovery as { mcp?: string } | undefined)?.mcp?.endsWith("/mcp")
      || !root.agentDiscovery?.openapi?.endsWith("/openapi.json")
      || !root.agentDiscovery?.sllrMcpManifest?.endsWith("/.well-known/sllr-mcp.json")
      || !root.agentDiscovery?.baseMcpPluginSpec?.endsWith("/.well-known/base-mcp-plugin.md")
      || !root.agentDiscovery?.solanaPluginSpec?.endsWith("/.well-known/solana-sllr-plugin.md")
      || !root.baseMcpDemo?.quote?.includes("/base-plugin/coffee/quote")
      || !root.baseMcpDemo?.preparePayment?.includes("/base-plugin/coffee/prepare-payment")
    ) {
      throw new Error(`Root discovery response was not useful: ${JSON.stringify(root)}`);
    }

    const manifest = await fetch(`${origin}/.well-known/sllr-agent.json`).then((response) => response.json()) as {
      name?: string;
      agentShack?: { type?: string; evaluator?: { policy?: string } };
    };
    if (manifest.name !== "SLL-R") throw new Error("Manifest did not identify SLL-R.");
    if (manifest.agentShack?.type !== "merchant_agent" || manifest.agentShack.evaluator?.policy !== "order-fulfillment-v0") {
      throw new Error(`Manifest did not expose AgentShack merchant listing schema: ${JSON.stringify(manifest)}`);
    }
    if (!("endpoints" in manifest) || !(manifest as { endpoints?: { openapi?: string; baseMcpPluginSpec?: string } }).endpoints?.openapi?.endsWith("/openapi.json")) {
      throw new Error(`Manifest did not expose OpenAPI discovery: ${JSON.stringify(manifest)}`);
    }
    const mcpManifest = await getJson(origin, "/.well-known/sllr-mcp.json") as {
      name?: string;
      transport?: { type?: string; url?: string };
      tools?: Array<{ name?: string; path?: string }>;
      safety?: { noAutonomousPayment?: boolean };
    };
    if (
      mcpManifest.name !== "SLL-R Merchant MCP"
      || mcpManifest.transport?.type !== "streamable_http"
      || !mcpManifest.transport.url?.endsWith("/mcp")
      || !mcpManifest.safety?.noAutonomousPayment
      || !mcpManifest.tools?.some((tool) => tool.name === "quote_order" && tool.path === "/merchants/{merchantId}/quote")
      || !mcpManifest.tools?.some((tool) => tool.name === "create_order" && tool.path === "/merchants/{merchantId}/orders")
      || !mcpManifest.tools?.some((tool) => tool.name === "get_payment_options" && tool.path === "/merchants/{merchantId}/payment-options")
    ) {
      throw new Error(`SLL-R MCP manifest did not expose generic merchant tools: ${JSON.stringify(mcpManifest)}`);
    }

    await smokeStoreBackend();
    await smokeMcp(origin);
    await smokeReceiptGating(origin);
    await smokeBuyerAuth(origin);
    await smokeConsentGate(origin);
    await smokeActionLoop(origin);
    await smokeGameDayBoba(origin);
    await smokeEtaReconfirm(origin);
    await smokeVerifiedReview(origin);
    await smokeStripePrepay(origin);
    await smokeCardOnFile(origin);
    await smokeCheckoutSavesCard(origin);
    await smokeRecurring(origin);
    await smokeLinePay(origin);
    await smokeDemoMerchants(origin);

    const aiPlugin = await getJson(origin, "/.well-known/ai-plugin.json") as {
      name_for_model?: string;
      api?: { type?: string; url?: string };
    };
    if (aiPlugin.name_for_model !== "sllr_agent_commerce" || aiPlugin.api?.type !== "openapi" || !aiPlugin.api.url?.endsWith("/openapi.json")) {
      throw new Error(`AI plugin manifest did not point to OpenAPI schema: ${JSON.stringify(aiPlugin)}`);
    }

    const openapi = await getJson(origin, "/openapi.json") as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    if (
      openapi.openapi !== "3.1.0"
      || !openapi.paths?.["/base-plugin/coffee/prepare-payment"]
      || !openapi.paths?.["/agent/{merchantId}"]
      || !openapi.paths?.["/agent/{merchantId}/message"]
      || !openapi.paths?.["/terminal/{merchantId}"]
      || !openapi.paths?.["/merchants/{merchantId}/quote"]
      || !openapi.paths?.["/merchants/{merchantId}/payment-options"]
      || !openapi.paths?.["/shopify/merchants"]
      || !openapi.paths?.["/webhooks/shopify/orders-paid"]
      || !openapi.paths?.["/.well-known/base-mcp-plugin.md"]
      || !openapi.paths?.["/.well-known/solana-sllr-plugin.md"]
    ) {
      throw new Error(`OpenAPI schema did not expose required agent tools: ${JSON.stringify(openapi)}`);
    }

    const baseMcpPlugin = await fetch(`${origin}/.well-known/base-mcp-plugin.md`).then((response) => response.text());
    if (!baseMcpPlugin.includes("STOP - COMPLETE BASE MCP ONBOARDING FIRST") || !baseMcpPlugin.includes("send_calls")) {
      throw new Error("Base MCP plugin spec did not include onboarding and send_calls mapping.");
    }
    const solanaPlugin = await fetch(`${origin}/.well-known/solana-sllr-plugin.md`).then((response) => response.text());
    if (!solanaPlugin.includes("SLL-R Solana Merchant Plugin") || !solanaPlugin.includes("reference does not match")) {
      throw new Error("Solana merchant plugin spec did not include payment reference safety rules.");
    }

    const raposaKit = await fetch(`${origin}/pilot-kit?merchantId=raposa-coffee`).then((response) => response.json()) as {
      merchant?: { id?: string };
      apiExamples?: { quote?: { body?: { merchantId?: string } } };
    };
    if (raposaKit.merchant?.id !== "raposa-coffee" || raposaKit.apiExamples?.quote?.body?.merchantId !== "raposa-coffee") {
      throw new Error(`Raposa pilot kit was not generated: ${JSON.stringify(raposaKit)}`);
    }

    // Merchant capability packet: the agent-reality contract on get_merchant.
    const raposaProfile = await getJson(origin, "/merchants/raposa-coffee") as {
      capabilities?: { stripe_checkout?: boolean; counter_pay?: boolean; refunds?: boolean; fulfillment_status?: string };
      unsupported?: string[];
    };
    if (
      raposaProfile.capabilities?.stripe_checkout !== true
      || raposaProfile.capabilities?.counter_pay !== true
      || raposaProfile.capabilities?.refunds !== false
      || raposaProfile.capabilities?.fulfillment_status !== "merchant_terminal"
      || !raposaProfile.unsupported?.includes("inventory guarantee")
    ) {
      throw new Error(`Merchant capability packet missing/incorrect: ${JSON.stringify(raposaProfile.capabilities)}`);
    }
    // A non-Stripe merchant must report card checkout as unsupported.
    const nounProfile = await getJson(origin, "/merchants/noun-coffee") as {
      capabilities?: { stripe_checkout?: boolean }; unsupported?: string[];
    };
    if (nounProfile.capabilities?.stripe_checkout !== false || !nounProfile.unsupported?.includes("card checkout")) {
      throw new Error(`Non-Stripe merchant capability packet wrong: ${JSON.stringify(nounProfile)}`);
    }

    const raposaMenu = await getJson(origin, "/merchants/raposa-coffee/menu") as {
      catalog?: Array<{ id?: string; prepMinutes?: number }>;
      menuSections?: Array<{ id?: string; items?: Array<{ id?: string }> }>;
    };
    if (
      !raposaMenu.catalog?.some((item) => item.id === "iced-latte" && item.prepMinutes === 7)
      || !raposaMenu.catalog?.some((item) => item.id === "cold-brew" && item.prepMinutes === 3)
      || !raposaMenu.menuSections?.some((section) => section.id === "raposa-pickup-drinks" && section.items?.some((item) => item.id === "iced-latte"))
    ) {
      throw new Error(`Raposa pilot menu was not useful for pickup promises: ${JSON.stringify(raposaMenu)}`);
    }

    const raposaOrder = await postJson(origin, "/merchants/raposa-coffee/orders", {
      userIntent: "I need an iced latte in 10 minutes.",
      deadlineMinutes: 10,
      maxSpendUsd: "10.00",
      customerLabel: "Raposa smoke customer",
      paymentMode: "counter",
    }) as {
      order?: { id?: string; status?: string; item?: { id?: string }; promise?: { estimatedWaitMinutes?: number | null; promisedReadyAt?: string | null } };
    };
    if (raposaOrder.order?.status !== "pending_payment" || raposaOrder.order.item?.id !== "iced-latte" || !raposaOrder.order.promise?.promisedReadyAt) {
      throw new Error(`Raposa order did not include a pickup promise: ${JSON.stringify(raposaOrder)}`);
    }
    const raposaAccepted = await postJson(origin, `/orders/${raposaOrder.order.id}/accept`, {
      merchantId: "raposa-coffee",
      demo: true,
      actor: "smoke-staff",
      note: "Accepted during smoke test.",
    }) as { order?: { status?: string } };
    if (raposaAccepted.order?.status !== "accepted") {
      throw new Error(`Raposa accept failed: ${JSON.stringify(raposaAccepted)}`);
    }
    const raposaReady = await postJson(origin, `/orders/${raposaOrder.order.id}/ready`, {
      merchantId: "raposa-coffee",
      demo: true,
      actor: "smoke-staff",
      note: "Ready during smoke test.",
    }) as { order?: { status?: string; promise?: { readyAt?: string | null } } };
    if (raposaReady.order?.status !== "ready" || !raposaReady.order.promise?.readyAt) {
      throw new Error(`Raposa ready failed: ${JSON.stringify(raposaReady)}`);
    }
    const raposaClaimUnverified = await postJsonFailure(origin, `/orders/${raposaOrder.order.id}/claim`, {
      merchantId: "raposa-coffee",
      actor: "smoke-staff",
      note: "Claim without verifier proof should be rejected.",
    });
    if (raposaClaimUnverified.status !== 403) {
      throw new Error(`Claim without verifier secret or demo flag should be rejected: ${JSON.stringify(raposaClaimUnverified)}`);
    }
    const raposaClaimed = await postJson(origin, `/orders/${raposaOrder.order.id}/claim`, {
      merchantId: "raposa-coffee",
      actor: "smoke-staff",
      note: "Paid at counter and claimed during smoke test.",
      demo: true,
    }) as { order?: { status?: string; proofLevel?: string; receipt?: { receiptHash?: string } } };
    if (raposaClaimed.order?.status !== "receipt_issued" || raposaClaimed.order.proofLevel !== "receipt_memory_issued" || !raposaClaimed.order.receipt?.receiptHash) {
      throw new Error(`Raposa claim did not issue receipt memory: ${JSON.stringify(raposaClaimed)}`);
    }

    const solydKit = await fetch(`${origin}/pilot-kit?merchantId=solyd`).then((response) => response.json()) as {
      merchant?: { id?: string };
      pilot?: { buyerPrompt?: string };
    };
    if (solydKit.merchant?.id !== "solyd" || !solydKit.pilot?.buyerPrompt?.includes("SOLYD")) {
      throw new Error(`SOLYD pilot kit was not generated: ${JSON.stringify(solydKit)}`);
    }

    const solanaMerchants = await getJson(origin, "/solana-pay/merchants") as {
      merchants?: Array<{ id?: string; paymentRails?: string[] }>;
    };
    for (const merchantId of ["raposa-coffee", "raposa-shop", "solyd"]) {
      const merchant = solanaMerchants.merchants?.find((candidate) => candidate.id === merchantId);
      if (!merchant?.paymentRails?.includes("solana_pay")) {
        throw new Error(`Solana Pay merchant ${merchantId} was not exposed: ${JSON.stringify(solanaMerchants)}`);
      }
    }

    const merchantList = await getJson(origin, "/merchants") as {
      merchants?: Array<{ id?: string; catalogItems?: number }>;
    };
    if (
      !merchantList.merchants?.some((merchant) => merchant.id === "noun-coffee")
      || !merchantList.merchants?.some((merchant) => merchant.id === "raposa-shop")
      || !merchantList.merchants?.some((merchant) => merchant.id === "solyd")
    ) {
      throw new Error(`Merchant runtime did not list configured merchants: ${JSON.stringify(merchantList)}`);
    }

    const nounMenu = await getJson(origin, "/merchants/noun-coffee/menu") as {
      catalog?: Array<{ id?: string }>;
      menuSections?: Array<{ id?: string }>;
    };
    if (!nounMenu.catalog?.some((item) => item.id === "dalat-highlands") || !nounMenu.menuSections?.length) {
      throw new Error(`Noun Coffee merchant menu did not expose catalog and menu sections: ${JSON.stringify(nounMenu)}`);
    }

    const nounAgentPage = await fetch(`${origin}/agent/noun-coffee`).then((response) => response.text());
    if (!nounAgentPage.includes("Noun Coffee AI Ordering Agent") || !nounAgentPage.includes("/terminal/noun-coffee")) {
      throw new Error("Noun Coffee standalone agent page did not render.");
    }

    const nounAgentQuote = await postJson(origin, "/agent/noun-coffee/message", {
      message: "I want Dalat Highlands coffee beans under $40.",
    }) as {
      mode?: string;
      quote?: { feasible?: boolean; item?: { id?: string } };
      checkoutHandoff?: { url?: string };
    };
    if (nounAgentQuote.mode !== "quote" || !nounAgentQuote.quote?.feasible || nounAgentQuote.quote.item?.id !== "dalat-highlands" || !nounAgentQuote.checkoutHandoff?.url?.includes("noun.coffee")) {
      throw new Error(`Noun Coffee standalone agent quote failed: ${JSON.stringify(nounAgentQuote)}`);
    }

    const nounAgentOrder = await postJson(origin, "/agent/noun-coffee/message", {
      message: "I want Dalat Highlands coffee beans under $40.",
      confirm: true,
      customerLabel: "smoke customer",
    }) as {
      mode?: string;
      order?: { id?: string; merchantId?: string; item?: { id?: string } };
      terminalUrl?: string;
    };
    if (nounAgentOrder.mode !== "order_created" || nounAgentOrder.order?.merchantId !== "noun-coffee" || nounAgentOrder.order.item?.id !== "dalat-highlands" || !nounAgentOrder.terminalUrl?.endsWith("/terminal/noun-coffee")) {
      throw new Error(`Noun Coffee standalone agent order failed: ${JSON.stringify(nounAgentOrder)}`);
    }

    const nounPaymentOptions = await postJson(origin, "/merchants/noun-coffee/payment-options", {
      orderId: nounAgentOrder.order.id,
    }) as {
      paymentOptions?: Array<{ rail?: string; type?: string; checkoutHandoff?: { url?: string } | null }>;
      safety?: { requiresUserApproval?: boolean; receiptRequiresProof?: boolean };
    };
    const optionRails = nounPaymentOptions.paymentOptions?.map((option) => option.rail) || [];
    if (
      !nounPaymentOptions.safety?.requiresUserApproval
      || !nounPaymentOptions.safety.receiptRequiresProof
      || !optionRails.includes("counter")
      || !optionRails.includes("shopify")
      || !nounPaymentOptions.paymentOptions?.some((option) => option.type === "checkout_handoff" || option.checkoutHandoff)
    ) {
      throw new Error(`Noun Coffee payment options did not expose hybrid checkout rails: ${JSON.stringify(nounPaymentOptions)}`);
    }

    const nounTerminalPage = await fetch(`${origin}/terminal/noun-coffee`).then((response) => response.text());
    if (!nounTerminalPage.includes("Noun Coffee Merchant Terminal") || !nounTerminalPage.includes("/agent/noun-coffee")) {
      throw new Error("Noun Coffee merchant terminal page did not render.");
    }

    const shopifyMerchants = await getJson(origin, "/shopify/merchants") as {
      merchants?: Array<{ id?: string; storefrontMcp?: string | null; ucpCatalogMcp?: string | null }>;
    };
    const shopifyIds = shopifyMerchants.merchants?.map((merchant) => merchant.id) || [];
    for (const merchantId of ["noun-coffee", "raposa-shop", "solyd", "changbaishan-rice"]) {
      if (!shopifyIds.includes(merchantId)) {
        throw new Error(`Shopify merchant ${merchantId} was not listed: ${JSON.stringify(shopifyMerchants)}`);
      }
    }
    const nounShopify = shopifyMerchants.merchants?.find((merchant) => merchant.id === "noun-coffee");
    if (!nounShopify?.storefrontMcp?.includes("/api/mcp") || !nounShopify.ucpCatalogMcp?.includes("/api/ucp/mcp")) {
      throw new Error(`Noun Coffee Shopify MCP endpoints were not exposed: ${JSON.stringify(shopifyMerchants)}`);
    }

    const nounShopifyConnect = await getJson(origin, "/shopify/merchants/noun-coffee/connect") as {
      shopify?: { webhookSecretEnv?: string };
      webhookUrls?: { ordersPaid?: string };
    };
    if (nounShopifyConnect.shopify?.webhookSecretEnv !== "SLLR_SHOPIFY_WEBHOOK_SECRET" || !nounShopifyConnect.webhookUrls?.ordersPaid?.endsWith("/webhooks/shopify/orders-paid")) {
      throw new Error(`Noun Coffee Shopify connect plan was not useful: ${JSON.stringify(nounShopifyConnect)}`);
    }

    const nounShopifyProducts = await getJson(origin, "/shopify/merchants/noun-coffee/products") as {
      products?: Array<{ id?: string; productUrl?: string | null }>;
    };
    if (!nounShopifyProducts.products?.some((item) => item.id === "dalat-highlands" && item.productUrl?.includes("noun.coffee"))) {
      throw new Error(`Noun Coffee Shopify products did not expose checkout handoff: ${JSON.stringify(nounShopifyProducts)}`);
    }

    const riceQuote = await postJson(origin, "/merchants/changbaishan-rice/quote", {
      userIntent: "fresh-milled unpolished natural rice under $25",
      maxSpendUsd: "25.00",
      deliverByDays: 7,
    }) as { quote?: { feasible?: boolean; item?: { id?: string } } };
    if (!riceQuote.quote?.feasible || riceQuote.quote.item?.id !== "fresh-milled-rice-5kg") {
      throw new Error(`Changbaishan Rice quote failed: ${JSON.stringify(riceQuote)}`);
    }
    const riceProducts = await getJson(origin, "/shopify/merchants/changbaishan-rice/products") as {
      products?: Array<{ id?: string; productUrl?: string | null; mapping?: { requiredMetadataKeys?: string[] } }>;
      cartMetadataKeys?: string[];
    };
    const riceProduct = riceProducts.products?.find((item) => item.id === "fresh-milled-rice-5kg");
    if (!riceProduct?.productUrl?.includes("changbaishan-rice.example") || !riceProduct.mapping?.requiredMetadataKeys?.includes("sllr_order_id") || !riceProducts.cartMetadataKeys?.includes("sllr_receipt_callback")) {
      throw new Error(`Changbaishan Rice Shopify mapping metadata failed: ${JSON.stringify(riceProducts)}`);
    }
    const riceOrder = await postJson(origin, "/merchants/changbaishan-rice/orders", {
      userIntent: "fresh-milled unpolished natural rice under $25",
      maxSpendUsd: "25.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { id?: string; subtotalUsd?: string } } };
    if (!riceOrder.order?.id || riceOrder.order.item?.id !== "fresh-milled-rice-5kg") {
      throw new Error(`Changbaishan Rice order failed: ${JSON.stringify(riceOrder)}`);
    }
    const riceCart = await postJson(origin, "/shopify/merchants/changbaishan-rice/cart", {
      orderId: riceOrder.order.id,
    }) as { mode?: string; checkoutHandoff?: { url?: string }; cartMetadata?: { sllr_order_id?: string | null } };
    if (riceCart.mode !== "checkout_handoff" || !riceCart.checkoutHandoff?.url?.includes("changbaishan-rice.example") || riceCart.cartMetadata?.sllr_order_id !== riceOrder.order.id) {
      throw new Error(`Changbaishan Rice cart handoff failed: ${JSON.stringify(riceCart)}`);
    }
    const ricePaid = await postJson(origin, "/webhooks/shopify/orders-paid", {
      sllr_order_id: riceOrder.order.id,
      current_total_price: riceOrder.order.item?.subtotalUsd,
      admin_graphql_api_id: "gid://shopify/Order/rice-smoke",
      demo: true,
    }) as { proofLevel?: string; order?: { payment?: { provider?: string }; receipt?: { receiptHash?: string } } };
    if (ricePaid.proofLevel !== "receipt_memory_issued" || ricePaid.order?.payment?.provider !== "shopify" || !ricePaid.order.receipt?.receiptHash) {
      throw new Error(`Changbaishan Rice paid webhook did not issue receipt memory: ${JSON.stringify(ricePaid)}`);
    }

    const baseMerchants = await getJson(origin, "/base-plugin/coffee/merchants") as {
      merchants?: Array<{ id?: string; paymentRails?: string[] }>;
    };
    const nounMerchant = baseMerchants.merchants?.find((merchant) => merchant.id === "noun-coffee");
    if (!nounMerchant?.paymentRails?.includes("base_usdc")) {
      throw new Error(`Noun Coffee was not exposed through the Base coffee plugin: ${JSON.stringify(baseMerchants)}`);
    }

    const nounIntent = encodeURIComponent("Ship me Dalat Highlands coffee beans under $40");
    const nounQuote = await getJson(origin, `/base-plugin/coffee/quote?merchantId=noun-coffee&intent=${nounIntent}&maxSpendUsd=40.00&deliverByDays=7`) as {
      quote?: { feasible?: boolean; item?: { id?: string; subtotalUsd?: string } };
      checkoutHandoff?: { url?: string };
    };
    if (!nounQuote.quote?.feasible || nounQuote.quote.item?.id !== "dalat-highlands" || !nounQuote.checkoutHandoff?.url?.includes("noun.coffee")) {
      throw new Error(`Unexpected Noun Coffee Base quote: ${JSON.stringify(nounQuote)}`);
    }

    const nounOrder = await getJson(origin, `/base-plugin/coffee/order?merchantId=noun-coffee&intent=${nounIntent}&maxSpendUsd=40.00&deliverByDays=7&agentId=base-smoke`) as {
      order?: { id?: string; item?: { subtotalUsd?: string } };
      checkoutHandoff?: { url?: string };
    };
    if (!nounOrder.order?.id || nounOrder.order.item?.subtotalUsd !== "32.00" || !nounOrder.checkoutHandoff?.url) {
      throw new Error(`Noun Coffee Base order was not created: ${JSON.stringify(nounOrder)}`);
    }

    const nounShopifyCart = await postJson(origin, "/shopify/merchants/noun-coffee/cart", {
      orderId: nounOrder.order.id,
    }) as {
      mode?: string;
      checkoutHandoff?: { url?: string };
      cartMetadata?: { sllr_order_id?: string | null };
    };
    if (nounShopifyCart.mode !== "checkout_handoff" || !nounShopifyCart.checkoutHandoff?.url?.includes("noun.coffee") || nounShopifyCart.cartMetadata?.sllr_order_id !== nounOrder.order.id) {
      throw new Error(`Noun Coffee Shopify cart handoff was not created: ${JSON.stringify(nounShopifyCart)}`);
    }

    const nounPaymentHandoff = await getJson(origin, `/base-plugin/coffee/prepare-payment?orderId=${nounOrder.order.id}`) as {
      mode?: string;
      checkoutHandoff?: { url?: string };
    };
    if (nounPaymentHandoff.mode !== "checkout_handoff" || !nounPaymentHandoff.checkoutHandoff?.url) {
      throw new Error(`Noun Coffee payment should default to checkout handoff: ${JSON.stringify(nounPaymentHandoff)}`);
    }

    const nonBaseQuoteFailure = await getJsonFailure(origin, "/base-plugin/coffee/quote?merchantId=raposa-shop&intent=coffee");
    if (nonBaseQuoteFailure.status !== 404) {
      throw new Error(`Non-Base merchant quote should be rejected: ${JSON.stringify(nonBaseQuoteFailure)}`);
    }

    const previousBaseRecipient = process.env.SLLR_BASE_COFFEE_RECIPIENT;
    process.env.SLLR_BASE_COFFEE_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
    const nounDemoPayment = await getJson(origin, `/base-plugin/coffee/prepare-payment?orderId=${nounOrder.order.id}&from=0x000000000000000000000000000000000000bEEF`) as {
      mode?: string;
      chainId?: number;
      transactions?: Array<{ chainId?: number; to?: string; data?: string }>;
    };
    if (
      nounDemoPayment.mode !== "base_mcp_demo"
      || nounDemoPayment.chainId !== 8453
      || nounDemoPayment.transactions?.[0]?.chainId !== 8453
      || nounDemoPayment.transactions?.[0]?.to !== "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      || !nounDemoPayment.transactions[0].data?.startsWith("0xa9059cbb")
    ) {
      throw new Error(`Noun Coffee Base demo payment was not prepared: ${JSON.stringify(nounDemoPayment)}`);
    }
    if (previousBaseRecipient === undefined) {
      delete process.env.SLLR_BASE_COFFEE_RECIPIENT;
    } else {
      process.env.SLLR_BASE_COFFEE_RECIPIENT = previousBaseRecipient;
    }

    const nounReceipt = await getJson(origin, `/base-plugin/coffee/record-demo-payment?orderId=${nounOrder.order.id}&paymentId=base_tx_smoke`) as {
      proofLevel?: string;
      order?: { receipt?: { receiptHash?: string }; payment?: { provider?: string; paymentId?: string } };
    };
    if (
      nounReceipt.proofLevel !== "receipt_memory_issued"
      || !nounReceipt.order?.receipt?.receiptHash
      || nounReceipt.order.payment?.provider !== "base_usdc"
      || nounReceipt.order.payment.paymentId !== "base_tx_smoke"
    ) {
      throw new Error(`Noun Coffee demo payment proof did not issue receipt memory: ${JSON.stringify(nounReceipt)}`);
    }

    const shopifyOrder = await getJson(origin, `/base-plugin/coffee/order?merchantId=noun-coffee&intent=${nounIntent}&maxSpendUsd=40.00&deliverByDays=7&agentId=shopify-smoke`) as {
      order?: { id?: string; item?: { subtotalUsd?: string } };
    };
    if (!shopifyOrder.order?.id) throw new Error(`Shopify smoke order was not created: ${JSON.stringify(shopifyOrder)}`);
    const shopifyPaid = await postJson(origin, "/webhooks/shopify/orders-paid", {
      sllr_order_id: shopifyOrder.order.id,
      current_total_price: shopifyOrder.order.item?.subtotalUsd,
      admin_graphql_api_id: "gid://shopify/Order/123",
      demo: true,
    }) as { proofLevel?: string; order?: { payment?: { provider?: string }; receipt?: { receiptHash?: string } } };
    if (shopifyPaid.proofLevel !== "receipt_memory_issued" || shopifyPaid.order?.payment?.provider !== "shopify" || !shopifyPaid.order.receipt?.receiptHash) {
      throw new Error(`Shopify paid webhook proof did not issue receipt memory: ${JSON.stringify(shopifyPaid)}`);
    }

    const raposaTerminal = await fetch(`${origin}/raposa`).then((response) => response.text());
    if (!raposaTerminal.includes("Raposa Promise Terminal") || !raposaTerminal.includes("/raposa/order")) {
      throw new Error("Raposa terminal page did not render expected staff controls.");
    }

    const raposaOrderPage = await fetch(`${origin}/raposa/order`).then((response) => response.text());
    if (!raposaOrderPage.includes("Order from Raposa") || !raposaOrderPage.includes("Ask Raposa for pickup promise")) {
      throw new Error("Raposa customer order page did not render expected order form.");
    }

    const quote = await postJson(origin, "/quote", {
      merchantId: "raposa-shop",
      userIntent: "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
      maxSpendUsd: "20.00",
      deliverByDays: 7,
    }) as { quote?: { feasible?: boolean; item?: { id?: string; subtotalUsd?: string } } };
    if (!quote.quote?.feasible || quote.quote.item?.id !== "nitro-caramel-latte") {
      throw new Error(`Unexpected Raposa Shop quote: ${JSON.stringify(quote)}`);
    }

    const merchantQuote = await postJson(origin, "/merchants/raposa-shop/quote", {
      userIntent: "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
      maxSpendUsd: "20.00",
      deliverByDays: 7,
    }) as { quote?: { feasible?: boolean; merchant?: { id?: string }; item?: { id?: string } } };
    if (!merchantQuote.quote?.feasible || merchantQuote.quote.merchant?.id !== "raposa-shop" || merchantQuote.quote.item?.id !== "nitro-caramel-latte") {
      throw new Error(`Unexpected merchant-scoped Raposa Shop quote: ${JSON.stringify(merchantQuote)}`);
    }

    const pickupQuote = await postJson(origin, "/quote", {
      merchantId: "raposa-coffee",
      userIntent: "Get me an iced latte under $10 in 15 minutes",
      maxSpendUsd: "10.00",
      deadlineMinutes: 15,
    }) as { quote?: { feasible?: boolean; item?: { id?: string } } };
    if (!pickupQuote.quote?.feasible || pickupQuote.quote.item?.id !== "iced-latte") {
      throw new Error(`Unexpected Raposa Coffee quote: ${JSON.stringify(pickupQuote)}`);
    }

    const pickupOrder = await postJson(origin, "/orders", {
      merchantId: "raposa-coffee",
      agentId: "buy-r-smoke",
      userIntent: "Get me an iced latte under $10 in 15 minutes",
      maxSpendUsd: "10.00",
      deadlineMinutes: 15,
      paymentMode: "counter",
    }) as { order?: { id?: string; promise?: { status?: string; estimatedWaitMinutes?: number; promisedReadyAt?: string } } };
    if (!pickupOrder.order?.id) throw new Error(`Pickup order was not created: ${JSON.stringify(pickupOrder)}`);
    if (pickupOrder.order.promise?.status !== "on_time" || !pickupOrder.order.promise.promisedReadyAt) {
      throw new Error(`Pickup order did not include a pickup promise: ${JSON.stringify(pickupOrder)}`);
    }

    const terminalList = await fetch(`${origin}/orders?merchantId=raposa-coffee`).then((response) => response.json()) as { orders?: Array<{ id?: string }> };
    if (!terminalList.orders?.some((order) => order.id === pickupOrder.order?.id)) {
      throw new Error(`Merchant terminal did not list pickup order: ${JSON.stringify(terminalList)}`);
    }

    const accepted = await postJson(origin, `/orders/${pickupOrder.order.id}/accept`, {
      merchantId: "raposa-coffee",
      demo: true,
      actor: "raposa-staff",
      note: "Can make it before pickup window.",
    }) as { status?: string; order?: { terminal?: { status?: string } } };
    if (accepted.status !== "accepted" || accepted.order?.terminal?.status !== "accepted") {
      throw new Error(`Merchant accept failed: ${JSON.stringify(accepted)}`);
    }

    const ready = await postJson(origin, `/orders/${pickupOrder.order.id}/ready`, {
      merchantId: "raposa-coffee",
      demo: true,
      actor: "raposa-staff",
      note: "Drink is ready.",
    }) as { status?: string; order?: { promise?: { readyAt?: string } } };
    if (ready.status !== "ready" || !ready.order?.promise?.readyAt) {
      throw new Error(`Merchant ready signal failed: ${JSON.stringify(ready)}`);
    }

    const claimed = await postJson(origin, `/orders/${pickupOrder.order.id}/claim`, {
      merchantId: "raposa-coffee",
      actor: "raposa-staff",
      note: "Paid at counter and claimed.",
      demo: true,
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string }; promise?: { claimedAt?: string } } };
    if (claimed.proofLevel !== "receipt_memory_issued" || !claimed.order?.receipt?.receiptHash || !claimed.order.promise?.claimedAt) {
      throw new Error(`Customer claim did not issue receipt handoff: ${JSON.stringify(claimed)}`);
    }

    const orderResult = await postJson(origin, "/orders", {
      merchantId: "raposa-shop",
      agentId: "buy-r-smoke",
      userIntent: "Ship me Raposa Nitro Cold Brew Caramel Latte under $20 this week",
      maxSpendUsd: "20.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    if (!orderResult.order?.id) throw new Error(`Order was not created: ${JSON.stringify(orderResult)}`);

    const previousSolanaRecipient = process.env.SLLR_SOLANA_PAY_RECIPIENT;
    const previousSolanaSecret = process.env.SLLR_SOLANA_PAY_VERIFY_SECRET;
    const solanaOrder = await postJson(origin, "/orders", {
      merchantId: "raposa-shop",
      agentId: "buy-r-smoke",
      userIntent: "Ship me Raposa Nitro Cold Brew Starter Pack under $30 this week",
      maxSpendUsd: "30.00",
      deliverByDays: 7,
      paymentMode: "crypto",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    if (!solanaOrder.order?.id) throw new Error(`Solana payment order was not created: ${JSON.stringify(solanaOrder)}`);
    process.env.SLLR_SOLANA_PAY_RECIPIENT = "11111111111111111111111111111111";
    const solanaPayment = await getJson(origin, `/solana-pay/prepare-payment?orderId=${solanaOrder.order.id}`) as {
      mode?: string;
      recipient?: string;
      reference?: string;
      solanaPayUrl?: string;
    };
    if (
      solanaPayment.mode !== "solana_pay_url"
      || solanaPayment.recipient !== "11111111111111111111111111111111"
      || !solanaPayment.reference
      || !solanaPayment.solanaPayUrl?.startsWith("solana:11111111111111111111111111111111?")
    ) {
      throw new Error(`Solana Pay URL was not prepared: ${JSON.stringify(solanaPayment)}`);
    }

    const solanaWrongReference = await postJsonFailure(origin, "/solana-pay/verify-payment", {
      orderId: solanaOrder.order.id,
      merchantId: "raposa-shop",
      amountUsd: solanaOrder.order.item?.subtotalUsd,
      paymentId: "solana_tx_wrong_reference",
      reference: "wrong_reference",
      demo: true,
    });
    if (solanaWrongReference.status !== 409) {
      throw new Error(`Solana proof with wrong reference should be rejected: ${JSON.stringify(solanaWrongReference)}`);
    }

    const solanaProofWithoutSecret = await postJsonFailure(origin, "/solana-pay/verify-payment", {
      orderId: solanaOrder.order.id,
      merchantId: "raposa-shop",
      amountUsd: solanaOrder.order.item?.subtotalUsd,
      paymentId: "solana_tx_smoke",
      reference: solanaPayment.reference,
    });
    if (solanaProofWithoutSecret.status !== 403) {
      throw new Error(`Solana proof without verifier secret should be rejected: ${JSON.stringify(solanaProofWithoutSecret)}`);
    }

    const merchantOrder = await postJson(origin, "/merchants/solyd/orders", {
      agentId: "buy-r-smoke",
      userIntent: "Ship me a black MagSafe iPhone 16 case under $100",
      maxSpendUsd: "100.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; merchantId?: string; item?: { subtotalUsd?: string } } };
    if (!merchantOrder.order?.id || merchantOrder.order.merchantId !== "solyd") {
      throw new Error(`Merchant-scoped SOLYD order was not created: ${JSON.stringify(merchantOrder)}`);
    }

    const merchantOrders = await getJson(origin, "/merchants/solyd/orders") as { orders?: Array<{ id?: string }> };
    if (!merchantOrders.orders?.some((order) => order.id === merchantOrder.order?.id)) {
      throw new Error(`Merchant-scoped orders did not include SOLYD order: ${JSON.stringify(merchantOrders)}`);
    }

    const unsupportedPayment = await postJsonFailure(origin, "/merchants/solyd/payment", {
      orderId: merchantOrder.order.id,
      provider: "counter",
      amountUsd: merchantOrder.order.item?.subtotalUsd,
      paymentId: "counter_not_supported",
    });
    if (unsupportedPayment.status !== 409) {
      throw new Error(`Unsupported merchant payment provider should be rejected: ${JSON.stringify(unsupportedPayment)}`);
    }

    const merchantPayment = await postJson(origin, "/merchants/solyd/payment", {
      orderId: merchantOrder.order.id,
      provider: "moonpay",
      amountUsd: merchantOrder.order.item?.subtotalUsd,
      paymentId: "merchant_pay_smoke",
      demo: true,
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string }; payment?: { provider?: string; paymentId?: string } } };
    if (
      merchantPayment.proofLevel !== "receipt_memory_issued"
      || !merchantPayment.order?.receipt?.receiptHash
      || merchantPayment.order.payment?.provider !== "moonpay"
      || merchantPayment.order.payment.paymentId !== "merchant_pay_smoke"
    ) {
      throw new Error(`Merchant-scoped payment proof did not issue receipt memory: ${JSON.stringify(merchantPayment)}`);
    }

    const receiptOrder = await postJson(origin, "/merchants/raposa-coffee/orders", {
      agentId: "buy-r-smoke",
      userIntent: "Get me a croissant under $10",
      maxSpendUsd: "10.00",
      deadlineMinutes: 15,
      paymentMode: "counter",
    }) as { order?: { id?: string } };
    if (!receiptOrder.order?.id) throw new Error(`Receipt test order was not created: ${JSON.stringify(receiptOrder)}`);
    const receiptUnverified = await postJsonFailure(origin, "/merchants/raposa-coffee/receipt", {
      orderId: receiptOrder.order.id,
      actor: "raposa-staff",
      note: "Receipt without verifier proof should be rejected.",
    });
    if (receiptUnverified.status !== 403) {
      throw new Error(`Receipt without verifier secret or demo flag should be rejected: ${JSON.stringify(receiptUnverified)}`);
    }
    const receipt = await postJson(origin, "/merchants/raposa-coffee/receipt", {
      orderId: receiptOrder.order.id,
      actor: "raposa-staff",
      note: "Counter paid and handed off.",
      demo: true,
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string } } };
    if (receipt.proofLevel !== "receipt_memory_issued" || !receipt.order?.receipt?.receiptHash) {
      throw new Error(`Merchant-scoped receipt endpoint did not issue receipt memory: ${JSON.stringify(receipt)}`);
    }

    const secretReceiptOrder = await postJson(origin, "/merchants/raposa-coffee/orders", {
      agentId: "buy-r-smoke",
      userIntent: "Get me a croissant under $10",
      maxSpendUsd: "10.00",
      deadlineMinutes: 15,
      paymentMode: "counter",
    }) as { order?: { id?: string } };
    if (!secretReceiptOrder.order?.id) throw new Error(`Secret receipt test order was not created: ${JSON.stringify(secretReceiptOrder)}`);
    const previousVerifierSecret = process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
    process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET = "smoke-verifier-secret";
    try {
      const receiptDemoBypass = await postJsonFailure(origin, "/merchants/raposa-coffee/receipt", {
        orderId: secretReceiptOrder.order.id,
        actor: "raposa-staff",
        demo: true,
      });
      if (receiptDemoBypass.status !== 401) {
        throw new Error(`demo=true should not bypass a configured verifier secret: ${JSON.stringify(receiptDemoBypass)}`);
      }
      const secretReceipt = await postJson(origin, "/merchants/raposa-coffee/receipt", {
        orderId: secretReceiptOrder.order.id,
        actor: "raposa-staff",
        note: "Counter paid, verified by staff secret.",
      }, { "x-sllr-merchant-payment-secret": "smoke-verifier-secret" }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string } } };
      if (secretReceipt.proofLevel !== "receipt_memory_issued" || !secretReceipt.order?.receipt?.receiptHash) {
        throw new Error(`Receipt with verifier secret did not issue receipt memory: ${JSON.stringify(secretReceipt)}`);
      }
    } finally {
      if (previousVerifierSecret === undefined) {
        delete process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET;
      } else {
        process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET = previousVerifierSecret;
      }
    }

    const nonBaseStatusFailure = await getJsonFailure(origin, `/base-plugin/coffee/status?orderId=${orderResult.order.id}`);
    if (nonBaseStatusFailure.status !== 404) {
      throw new Error(`Non-Base order status should be rejected: ${JSON.stringify(nonBaseStatusFailure)}`);
    }

    const solanaPaid = await postJson(origin, "/solana-pay/verify-payment", {
      orderId: solanaOrder.order.id,
      merchantId: "raposa-shop",
      amountUsd: solanaOrder.order.item?.subtotalUsd,
      paymentId: "solana_tx_smoke",
      reference: solanaPayment.reference,
      demo: true,
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string }; payment?: { provider?: string } } };
    if (solanaPaid.proofLevel !== "receipt_memory_issued" || solanaPaid.order?.payment?.provider !== "solana_pay" || !solanaPaid.order.receipt?.receiptHash) {
      throw new Error(`Solana Pay proof did not issue receipt memory: ${JSON.stringify(solanaPaid)}`);
    }
    if (previousSolanaRecipient === undefined) {
      delete process.env.SLLR_SOLANA_PAY_RECIPIENT;
    } else {
      process.env.SLLR_SOLANA_PAY_RECIPIENT = previousSolanaRecipient;
    }
    if (previousSolanaSecret === undefined) {
      delete process.env.SLLR_SOLANA_PAY_VERIFY_SECRET;
    } else {
      process.env.SLLR_SOLANA_PAY_VERIFY_SECRET = previousSolanaSecret;
    }

    const previousHelioUrl = process.env.SLLR_HELIO_CHECKOUT_BASE_URL;
    process.env.SLLR_HELIO_CHECKOUT_BASE_URL = "https://app.hel.io/pay/sllr-demo";
    const helioOrder = await postJson(origin, "/orders", {
      merchantId: "solyd",
      agentId: "buy-r-smoke",
      userIntent: "Ship me a black MagSafe iPhone 16 case under $100",
      maxSpendUsd: "100.00",
      deliverByDays: 7,
      paymentMode: "checkout",
    }) as { order?: { id?: string; item?: { subtotalUsd?: string } } };
    if (!helioOrder.order?.id) throw new Error(`Helio handoff order was not created: ${JSON.stringify(helioOrder)}`);
    const helioHandoff = await getJson(origin, `/solana-pay/prepare-payment?orderId=${helioOrder.order.id}`) as {
      helioCheckoutHandoff?: { url?: string };
    };
    if (!helioHandoff.helioCheckoutHandoff?.url?.includes("orderId=")) {
      throw new Error(`Helio checkout handoff was not returned: ${JSON.stringify(helioHandoff)}`);
    }
    const helioPaid = await postJson(origin, "/webhooks/helio", {
      orderId: helioOrder.order.id,
      merchantId: "solyd",
      amountUsd: helioOrder.order.item?.subtotalUsd,
      paymentId: "helio_tx_smoke",
      demo: true,
    }) as { proofLevel?: string; order?: { payment?: { provider?: string }; receipt?: { receiptHash?: string } } };
    if (helioPaid.proofLevel !== "receipt_memory_issued" || helioPaid.order?.payment?.provider !== "helio" || !helioPaid.order.receipt?.receiptHash) {
      throw new Error(`Helio webhook proof did not issue receipt memory: ${JSON.stringify(helioPaid)}`);
    }
    if (previousHelioUrl === undefined) {
      delete process.env.SLLR_HELIO_CHECKOUT_BASE_URL;
    } else {
      process.env.SLLR_HELIO_CHECKOUT_BASE_URL = previousHelioUrl;
    }

    const paid = await postJson(origin, "/webhooks/payment", {
      orderId: orderResult.order.id,
      merchantId: "raposa-shop",
      provider: "moonpay",
      amountUsd: orderResult.order.item?.subtotalUsd,
      paymentId: "pay_smoke",
      demo: true,
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string; cnftStatus?: string } } };
    if (paid.proofLevel !== "receipt_memory_issued" || !paid.order?.receipt?.receiptHash) {
      throw new Error(`Payment proof did not issue receipt handoff: ${JSON.stringify(paid)}`);
    }

    console.log("SLL-R smoke passed");
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
