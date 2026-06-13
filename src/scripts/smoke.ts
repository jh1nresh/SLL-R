import { once } from "node:events";
import { createServer } from "node:http";
import { createSllrServer } from "../server.js";
import { resetStoreForTest, sllrStore, storeBackendName } from "../core/store.js";

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

async function main() {
  const server = createSllrServer();
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start smoke server.");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
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
      actor: "smoke-staff",
      note: "Accepted during smoke test.",
    }) as { order?: { status?: string } };
    if (raposaAccepted.order?.status !== "accepted") {
      throw new Error(`Raposa accept failed: ${JSON.stringify(raposaAccepted)}`);
    }
    const raposaReady = await postJson(origin, `/orders/${raposaOrder.order.id}/ready`, {
      merchantId: "raposa-coffee",
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
      actor: "raposa-staff",
      note: "Can make it before pickup window.",
    }) as { status?: string; order?: { terminal?: { status?: string } } };
    if (accepted.status !== "accepted" || accepted.order?.terminal?.status !== "accepted") {
      throw new Error(`Merchant accept failed: ${JSON.stringify(accepted)}`);
    }

    const ready = await postJson(origin, `/orders/${pickupOrder.order.id}/ready`, {
      merchantId: "raposa-coffee",
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
