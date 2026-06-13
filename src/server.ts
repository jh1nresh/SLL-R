import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { acceptOrder, claimOrder, createOrder, fulfillOrder, getOrder, listOrders, markOrderReady, rejectOrder } from "./core/orders.js";
import { quoteOrder } from "./core/quote.js";
import { allMerchantProfiles, hydrateDemoMerchants, merchantForId } from "./merchants/profiles.js";
import { pilotKitForMerchant } from "./merchants/pilotKits.js";
import { sllrManifest } from "./manifest.js";
import { attachPaymentProof } from "./core/orders.js";
import { attachMerchantPayment, createMerchantOrder, getMerchant, getMerchantMenu, issueMerchantReceipt, listMerchantOrders, listMerchants, quoteMerchantOrder, requirePaymentVerifier } from "./core/merchantApi.js";
import { merchantPaymentOptions } from "./core/paymentOptions.js";
import { raposaOrderPage, raposaTerminalPage } from "./ui/raposa.js";
import { merchantTerminalPage, standaloneAgentPage } from "./ui/agenticPos.js";
import { standaloneAgentMessage } from "./core/standaloneAgent.js";
import { issueBuyerSession, resolveBuyer, revokeBuyerSession, buyerTokenFrom } from "./core/buyer.js";
import { listOrdersForBuyer } from "./core/orders.js";
import { baseCoffeeMerchants, baseCoffeeOrder, baseCoffeePayment, baseCoffeeQuote, baseCoffeeRecordDemoPayment, baseCoffeeStatus } from "./adapters/baseCoffeePlugin.js";
import { helioWebhook, solanaPayMerchants, solanaPayPreparePayment, solanaPayVerifyPayment } from "./adapters/solanaPay.js";
import { baseMcpPluginSpec } from "./baseMcpPlugin.js";
import { sllrMcpManifest } from "./mcpManifest.js";
import { handleMcpPost, rejectMcpBrowserOrigin } from "./mcpServer.js";
import { storeBackendName } from "./core/store.js";
import { aiPluginManifest, sllrOpenApi } from "./openapi.js";
import { solanaSllrPluginSpec } from "./solanaPlugin.js";
import { shopifyCartHandoff, shopifyConnectPlan, shopifyMerchants, shopifyOrdersFulfilledWebhook, shopifyOrdersPaidWebhook, shopifyProducts, shopifyRefundsCreateWebhook } from "./adapters/shopify.js";
import { stripeWebhook } from "./adapters/stripe.js";
import { linePayConfirm } from "./adapters/linePay.js";
import { createDemoMerchant, listDemoMerchants } from "./adapters/shopifyCatalog.js";

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function html(response: ServerResponse, status: number, payload: string) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(payload);
}

function markdown(response: ServerResponse, status: number, payload: string) {
  response.writeHead(status, { "content-type": "text/markdown; charset=utf-8" });
  response.end(payload);
}

function svg(response: ServerResponse, status: number, payload: string) {
  response.writeHead(status, { "content-type": "image/svg+xml; charset=utf-8" });
  response.end(payload);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 200_000) {
      throw Object.assign(new Error("Request body too large."), { status: 413 });
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw, json: {} as Record<string, unknown> };
  try {
    return { raw, json: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

async function body(request: IncomingMessage) {
  return (await readBody(request)).json;
}

// Resolve the buyer session (Authorization: Bearer <buyer token>) and stamp the
// create-order payload with its buyerId, binding the order to a buyer identity.
// When SLLR_REQUIRE_BUYER_AUTH=true, ordering without a valid token is rejected.
function requireBuyerIfConfigured(buyerId: string | null) {
  if (process.env.SLLR_REQUIRE_BUYER_AUTH === "true" && !buyerId) {
    throw Object.assign(new Error("Buyer authentication required. Obtain a token from POST /buyer/session and send it as 'Authorization: Bearer <token>'."), { status: 401 });
  }
}

async function buyerIdFor(request: IncomingMessage, payload?: Record<string, unknown>) {
  const session = await resolveBuyer(buyerTokenFrom(request.headers, payload), new Date().toISOString());
  return session?.buyerId ?? null;
}

// buyerId must NEVER come from client input. Strip any client-supplied buyerId,
// then set it only from the validated session token. Enforces require-auth.
async function bindBuyer(request: IncomingMessage, payload: Record<string, unknown>) {
  delete payload.buyerId;
  const buyerId = await buyerIdFor(request, payload);
  requireBuyerIfConfigured(buyerId);
  if (buyerId) payload.buyerId = buyerId;
  return payload;
}

function originFrom(request: IncomingMessage) {
  const configured = process.env.SLLR_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const host = request.headers.host || `localhost:${process.env.SLLR_PORT || 3100}`;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProto === "string"
    ? forwardedProto.split(",")[0]
    : host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https";
  return `${protocol}://${host}`;
}

function errorResponse(response: ServerResponse, error: unknown) {
  const status = typeof error === "object" && error && "status" in error && typeof error.status === "number"
    ? error.status
    : 500;
  json(response, status, {
    error: error instanceof Error ? error.message : "SLL-R request failed.",
    ...(typeof error === "object" && error && "quote" in error ? { quote: error.quote } : {}),
  });
}

function rootDiscovery(origin: string) {
  return {
    product: "SLL-R",
    description: "Seller-side agent runtime for merchant quote, order, payment proof, and verified receipt memory.",
    status: "ready",
    agentDiscovery: {
      mcp: `${origin}/mcp`,
      sllrManifest: `${origin}/.well-known/sllr-agent.json`,
      sllrMcpManifest: `${origin}/.well-known/sllr-mcp.json`,
      aiPluginManifest: `${origin}/.well-known/ai-plugin.json`,
      baseMcpPluginSpec: `${origin}/.well-known/base-mcp-plugin.md`,
      solanaPluginSpec: `${origin}/.well-known/solana-sllr-plugin.md`,
      openapi: `${origin}/openapi.json`,
    },
    baseMcpDemo: {
      merchants: `${origin}/base-plugin/coffee/merchants`,
      quote: `${origin}/base-plugin/coffee/quote?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7`,
      order: `${origin}/base-plugin/coffee/order?merchantId=noun-coffee&intent=Ship%20me%20Dalat%20Highlands%20coffee%20beans&maxSpendUsd=40.00&deliverByDays=7&agentId=base-mcp-demo`,
      preparePayment: `${origin}/base-plugin/coffee/prepare-payment?orderId=ord_...&from=0x...`,
      status: `${origin}/base-plugin/coffee/status?orderId=ord_...`,
    },
    merchantRuntime: {
      merchants: `${origin}/merchants`,
      standaloneAgent: `${origin}/agent/{merchantId}`,
      standaloneAgentMessage: `${origin}/agent/{merchantId}/message`,
      merchantTerminal: `${origin}/terminal/{merchantId}`,
      menu: `${origin}/merchants/{merchantId}/menu`,
      quote: `${origin}/merchants/{merchantId}/quote`,
      orders: `${origin}/merchants/{merchantId}/orders`,
      payment: `${origin}/merchants/{merchantId}/payment`,
      paymentOptions: `${origin}/merchants/{merchantId}/payment-options`,
      receipt: `${origin}/merchants/{merchantId}/receipt`,
    },
    shopify: {
      merchants: `${origin}/shopify/merchants`,
      connect: `${origin}/shopify/merchants/{merchantId}/connect`,
      products: `${origin}/shopify/merchants/{merchantId}/products`,
      cart: `${origin}/shopify/merchants/{merchantId}/cart`,
      webhooks: {
        ordersPaid: `${origin}/webhooks/shopify/orders-paid`,
        ordersFulfilled: `${origin}/webhooks/shopify/orders-fulfilled`,
        refundsCreate: `${origin}/webhooks/shopify/refunds-create`,
      },
    },
  };
}

export async function handleSllrRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url || "/", originFrom(request));
    // Load any persisted demo merchants into the in-process cache so a fresh
    // serverless instance resolves merchants created by an earlier request.
    await hydrateDemoMerchants();

    if (request.method === "GET" && url.pathname === "/") {
        return json(response, 200, rootDiscovery(originFrom(request)));
      }
    if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, product: "SLL-R", store: storeBackendName() });
      }
      if (request.method === "GET" && url.pathname === "/sllr-logo.svg") {
        return svg(response, 200, `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="SLL-R"><rect width="512" height="512" rx="96" fill="#163b2b"/><path d="M120 132h272v248H120z" fill="#f8f4ea"/><path d="M164 318c28 18 70 18 98-1 24-16 36-43 36-80v-72h-52v75c0 21-6 35-17 43-13 9-32 8-48-3l-17 38z" fill="#163b2b"/><path d="M356 164a36 36 0 1 1-72 0 36 36 0 0 1 72 0z" fill="#111"/><path d="m305 164 12 13 25-29" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="M159 365h194" stroke="#163b2b" stroke-width="12" stroke-linecap="round" stroke-dasharray="1 28"/></svg>`);
      }
      if (request.method === "GET" && url.pathname === "/raposa") {
        return html(response, 200, raposaTerminalPage(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/raposa/order") {
        return html(response, 200, raposaOrderPage());
      }
      if (url.pathname === "/mcp") {
        if (request.method === "POST") {
          if (rejectMcpBrowserOrigin(request.headers.origin, originFrom(request))) {
            return json(response, 403, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "Forbidden: cross-origin browser requests are not allowed on the MCP endpoint." },
            });
          }
          const contentType = request.headers["content-type"] || "";
          if (!contentType.includes("application/json")) {
            return json(response, 415, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32000, message: "Unsupported media type: MCP requests must use content-type application/json." },
            });
          }
          const buyer = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
          const result = await handleMcpPost((await readBody(request)).json, originFrom(request), buyer?.buyerId ?? null);
          if (result.payload === null) {
            response.writeHead(result.status);
            return response.end();
          }
          return json(response, result.status, result.payload);
        }
        // Stateless server: no SSE stream, no sessions to delete.
        response.writeHead(405, { allow: "POST", "content-type": "application/json" });
        return response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Method not allowed. SLL-R MCP is a stateless Streamable HTTP endpoint; use POST." },
        }));
      }
      if (request.method === "GET" && url.pathname === "/.well-known/sllr-agent.json") {
        return json(response, 200, sllrManifest(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/.well-known/sllr-mcp.json") {
        return json(response, 200, sllrMcpManifest(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/.well-known/ai-plugin.json") {
        return json(response, 200, aiPluginManifest(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/.well-known/base-mcp-plugin.md") {
        return markdown(response, 200, baseMcpPluginSpec(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/.well-known/solana-sllr-plugin.md") {
        return markdown(response, 200, solanaSllrPluginSpec(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/openapi.json") {
        return json(response, 200, sllrOpenApi(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/capabilities") {
        const merchantId = url.searchParams.get("merchantId") || "";
        const merchant = merchantId ? merchantForId(merchantId) : null;
        return json(response, merchantId && !merchant ? 404 : 200, {
          product: "SLL-R seller operating agent",
          merchants: merchant ? [merchant] : allMerchantProfiles(),
        });
      }
      if (request.method === "GET" && url.pathname === "/merchants") {
        return json(response, 200, listMerchants());
      }
      if (request.method === "POST" && url.pathname === "/buyer/session") {
        const payload = await body(request);
        const { token, session } = await issueBuyerSession(
          typeof payload.label === "string" ? payload.label : "buyer agent user",
          new Date().toISOString(),
        );
        return json(response, 201, {
          product: "SLL-R buyer session",
          token,
          buyerId: session.buyerId,
          expiresAt: session.expiresAt,
          usage: "Send this token as 'Authorization: Bearer <token>' on /mcp and order endpoints to bind orders + receipts to your buyer identity.",
        });
      }
      if (request.method === "DELETE" && url.pathname === "/buyer/session") {
        const revoked = await revokeBuyerSession(buyerTokenFrom(request.headers), new Date().toISOString());
        return json(response, revoked ? 200 : 404, revoked
          ? { product: "SLL-R buyer session", revoked: true }
          : { error: "No matching live buyer session to revoke." });
      }
      if (request.method === "GET" && url.pathname === "/buyer/orders") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token. Obtain one from POST /buyer/session." });
        return json(response, 200, {
          product: "SLL-R buyer orders",
          buyerId: session.buyerId,
          orders: await listOrdersForBuyer(session.buyerId),
        });
      }
      const standaloneAgentRoute = url.pathname.match(/^\/agent\/([^/]+)(?:\/([^/]+))?$/);
      if (standaloneAgentRoute) {
        const [, merchantId, action] = standaloneAgentRoute;
        if (request.method === "GET" && !action) {
          const page = standaloneAgentPage(merchantId, originFrom(request));
          return page ? html(response, 200, page) : json(response, 404, { error: `Unknown merchant: ${merchantId}` });
        }
        if (request.method === "POST" && action === "message") {
          return json(response, 200, await standaloneAgentMessage(merchantId, await bindBuyer(request, await body(request)), originFrom(request)));
        }
      }
      const terminalRoute = url.pathname.match(/^\/terminal\/([^/]+)$/);
      if (terminalRoute && request.method === "GET") {
        const page = merchantTerminalPage(terminalRoute[1], originFrom(request));
        return page ? html(response, 200, page) : json(response, 404, { error: `Unknown merchant: ${terminalRoute[1]}` });
      }
      if (request.method === "GET" && url.pathname === "/demo-merchants") {
        return json(response, 200, listDemoMerchants(originFrom(request)));
      }
      if (request.method === "POST" && url.pathname === "/demo-merchants") {
        return json(response, 201, await createDemoMerchant(request.headers, await body(request), originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/shopify/merchants") {
        return json(response, 200, shopifyMerchants(originFrom(request)));
      }
      const shopifyMerchantRoute = url.pathname.match(/^\/shopify\/merchants\/([^/]+)(?:\/([^/]+))?$/);
      if (shopifyMerchantRoute) {
        const [, merchantId, action] = shopifyMerchantRoute;
        if (request.method === "GET" && action === "connect") {
          return json(response, 200, shopifyConnectPlan(merchantId, originFrom(request)));
        }
        if (request.method === "GET" && action === "products") {
          return json(response, 200, shopifyProducts(merchantId));
        }
        if (request.method === "POST" && action === "cart") {
          return json(response, 200, await shopifyCartHandoff(merchantId, await body(request), originFrom(request)));
        }
      }
      const merchantRoute = url.pathname.match(/^\/merchants\/([^/]+)(?:\/([^/]+))?$/);
      if (merchantRoute) {
        const [, merchantId, action] = merchantRoute;
        if (request.method === "GET" && !action) {
          return json(response, 200, getMerchant(merchantId));
        }
        if (request.method === "GET" && action === "menu") {
          return json(response, 200, getMerchantMenu(merchantId));
        }
        if (request.method === "POST" && action === "quote") {
          return json(response, 200, quoteMerchantOrder(merchantId, await body(request)));
        }
        if (request.method === "POST" && action === "orders") {
          return json(response, 201, await createMerchantOrder(merchantId, await bindBuyer(request, await body(request))));
        }
        if (request.method === "GET" && action === "orders") {
          return json(response, 200, await listMerchantOrders(merchantId, url.searchParams.get("status")));
        }
        if (request.method === "POST" && action === "payment") {
          return json(response, 200, await attachMerchantPayment(merchantId, request.headers, await body(request)));
        }
        if (request.method === "POST" && action === "payment-options") {
          return json(response, 200, await merchantPaymentOptions(merchantId, await body(request), originFrom(request)));
        }
        if (request.method === "POST" && action === "receipt") {
          return json(response, 200, await issueMerchantReceipt(merchantId, request.headers, await body(request)));
        }
      }
      if (request.method === "GET" && url.pathname === "/pilot-kit") {
        const merchantId = url.searchParams.get("merchantId") || "";
        const kit = merchantId ? pilotKitForMerchant(merchantId, originFrom(request)) : null;
        return json(response, kit ? 200 : 404, kit || { error: `Unknown merchant: ${merchantId || "(missing merchantId)"}` });
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/merchants") {
        return json(response, 200, baseCoffeeMerchants(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/quote") {
        return json(response, 200, baseCoffeeQuote(url.searchParams));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/order") {
        const baseBuyerId = await buyerIdFor(request);
        requireBuyerIfConfigured(baseBuyerId);
        return json(response, 201, await baseCoffeeOrder(url.searchParams, baseBuyerId));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/prepare-payment") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        return json(response, 200, await baseCoffeePayment(orderId, url.searchParams.get("from")));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/status") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        return json(response, 200, { product: "SLL-R Base coffee status", order: await baseCoffeeStatus(orderId) });
      }
      if (request.method === "GET" && url.pathname === "/solana-pay/merchants") {
        return json(response, 200, solanaPayMerchants(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/solana-pay/prepare-payment") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        return json(response, 200, await solanaPayPreparePayment(orderId));
      }
      if (request.method === "POST" && url.pathname === "/solana-pay/verify-payment") {
        const order = await solanaPayVerifyPayment(request.headers, await body(request) as never);
        return json(response, 200, {
          product: "SLL-R Solana payment proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
        });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/helio") {
        const order = await helioWebhook(request.headers, await body(request) as never);
        return json(response, 200, {
          product: "SLL-R Helio payment proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
        });
      }
      if (url.pathname === "/line-pay/confirm" && (request.method === "GET" || request.method === "POST")) {
        // LINE Pay redirects the buyer here after authorization; capture + proof.
        const orderId = url.searchParams.get("orderId") || "";
        const transactionId = url.searchParams.get("transactionId") || "";
        const order = await linePayConfirm(orderId, transactionId);
        return json(response, 200, {
          product: "SLL-R LINE Pay payment proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
        });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/stripe") {
        const parsed = await readBody(request);
        const result = await stripeWebhook(request.headers, parsed.raw, parsed.json);
        return json(response, 200, "ignored" in result
          ? result
          : { product: "SLL-R Stripe payment proof adapter", status: result.status, proofLevel: result.proofLevel, order: result });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/shopify/orders-paid") {
        const parsed = await readBody(request);
        const order = await shopifyOrdersPaidWebhook(request.headers, parsed.raw, parsed.json);
        return json(response, 200, {
          product: "SLL-R Shopify paid proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
        });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/shopify/orders-fulfilled") {
        const parsed = await readBody(request);
        const order = await shopifyOrdersFulfilledWebhook(request.headers, parsed.raw, parsed.json);
        return json(response, 200, {
          product: "SLL-R Shopify fulfillment proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
        });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/shopify/refunds-create") {
        const parsed = await readBody(request);
        return json(response, 202, shopifyRefundsCreateWebhook(request.headers, parsed.raw, parsed.json));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/record-demo-payment") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        const order = await baseCoffeeRecordDemoPayment(orderId, url.searchParams.get("paymentId"), url.searchParams.get("amountUsd"));
        return json(response, 200, {
          product: "SLL-R Base coffee demo payment proof",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
          warning: "Demo endpoint records payment proof from a provided transaction or request id. Production must verify the Base transaction before issuing receipt memory.",
        });
      }
      if (request.method === "POST" && url.pathname === "/quote") {
        return json(response, 200, { product: "SLL-R quote", quote: quoteOrder(await body(request) as never) });
      }
      if (request.method === "POST" && url.pathname === "/orders") {
        const result = await createOrder(await bindBuyer(request, await body(request)) as never);
        return json(response, 201, {
          product: "SLL-R order handoff",
          status: result.order.status,
          quote: result.quote,
          order: result.order,
          next: "Attach payment or fulfillment proof to issue SLL-R receipt memory.",
        });
      }
      if (request.method === "GET" && url.pathname === "/orders") {
        return json(response, 200, {
          product: "SLL-R merchant terminal",
          orders: await listOrders({
            merchantId: url.searchParams.get("merchantId") || undefined,
            status: url.searchParams.get("status") as never || undefined,
          }),
        });
      }
      const orderRoute = url.pathname.match(/^\/orders\/([^/]+)(?:\/([^/]+))?$/);
      if (orderRoute) {
        const [, orderId, action] = orderRoute;
        if (request.method === "GET" && !action) {
          const order = await getOrder(orderId);
          return json(response, order ? 200 : 404, order ? { product: "SLL-R merchant terminal", order } : { error: `Unknown order: ${orderId}` });
        }
        if (request.method === "POST" && action === "accept") {
          const order = await acceptOrder(orderId, await body(request) as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "reject") {
          const order = await rejectOrder(orderId, await body(request) as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "fulfill") {
          const payload = await body(request);
          requirePaymentVerifier(request.headers, payload);
          const order = await fulfillOrder(orderId, payload as never);
          return json(response, 200, {
            product: "SLL-R merchant terminal",
            status: order.status,
            proofLevel: order.proofLevel,
            order,
          });
        }
        if (request.method === "POST" && action === "ready") {
          const order = await markOrderReady(orderId, await body(request) as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "claim") {
          const payload = await body(request);
          requirePaymentVerifier(request.headers, payload);
          const order = await claimOrder(orderId, payload as never);
          return json(response, 200, {
            product: "SLL-R merchant terminal",
            status: order.status,
            proofLevel: order.proofLevel,
            order,
          });
        }
      }
      if (request.method === "POST" && url.pathname === "/webhooks/payment") {
        const order = await attachPaymentProof(await body(request) as never);
        return json(response, 200, {
          product: "SLL-R payment proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
        });
      }

    return json(response, 404, { error: "SLL-R route not found." });
  } catch (error) {
    return errorResponse(response, error);
  }
}

export function createSllrServer() {
  return createServer(handleSllrRequest);
}

if (process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.SLLR_PORT || 3100);
  createSllrServer().listen(port, () => {
    console.log(`SLL-R listening on http://localhost:${port}`);
  });
}
