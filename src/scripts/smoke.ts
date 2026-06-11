import { once } from "node:events";
import { createSllrServer } from "../server.js";

async function postJson(origin: string, path: string, payload: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
      agentDiscovery?: { openapi?: string; baseMcpPluginSpec?: string; sllrMcpManifest?: string };
      baseMcpDemo?: { quote?: string; preparePayment?: string };
    };
    if (
      root.product !== "SLL-R"
      || !root.agentDiscovery?.openapi?.endsWith("/openapi.json")
      || !root.agentDiscovery?.sllrMcpManifest?.endsWith("/.well-known/sllr-mcp.json")
      || !root.agentDiscovery?.baseMcpPluginSpec?.endsWith("/.well-known/base-mcp-plugin.md")
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
      tools?: Array<{ name?: string; path?: string }>;
      safety?: { noAutonomousPayment?: boolean };
    };
    if (
      mcpManifest.name !== "SLL-R Merchant MCP"
      || !mcpManifest.safety?.noAutonomousPayment
      || !mcpManifest.tools?.some((tool) => tool.name === "quote_order" && tool.path === "/merchants/{merchantId}/quote")
      || !mcpManifest.tools?.some((tool) => tool.name === "create_order" && tool.path === "/merchants/{merchantId}/orders")
    ) {
      throw new Error(`SLL-R MCP manifest did not expose generic merchant tools: ${JSON.stringify(mcpManifest)}`);
    }

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
    ) {
      throw new Error(`OpenAPI schema did not expose required agent tools: ${JSON.stringify(openapi)}`);
    }

    const baseMcpPlugin = await fetch(`${origin}/.well-known/base-mcp-plugin.md`).then((response) => response.text());
    if (!baseMcpPlugin.includes("STOP - COMPLETE BASE MCP ONBOARDING FIRST") || !baseMcpPlugin.includes("send_calls")) {
      throw new Error("Base MCP plugin spec did not include onboarding and send_calls mapping.");
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
    const raposaClaimed = await postJson(origin, `/orders/${raposaOrder.order.id}/claim`, {
      merchantId: "raposa-coffee",
      actor: "smoke-staff",
      note: "Paid at counter and claimed during smoke test.",
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
    const receipt = await postJson(origin, "/merchants/raposa-coffee/receipt", {
      orderId: receiptOrder.order.id,
      actor: "raposa-staff",
      note: "Counter paid and handed off.",
    }) as { proofLevel?: string; order?: { receipt?: { receiptHash?: string } } };
    if (receipt.proofLevel !== "receipt_memory_issued" || !receipt.order?.receipt?.receiptHash) {
      throw new Error(`Merchant-scoped receipt endpoint did not issue receipt memory: ${JSON.stringify(receipt)}`);
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
