import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URL } from "node:url";

// Constant-time string compare for secrets (length mismatch → false, no leak).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
import { acceptOrder, attachPaymentProofMutation, claimOrder, createOrder, fulfillOrderMutation, getOrder, listOrders, markOrderReady, rejectOrder } from "./core/orders.js";
import { quoteOrder } from "./core/quote.js";
import { allMerchantProfiles, hydrateDemoMerchants, merchantForId } from "./merchants/profiles.js";
import { pilotKitForMerchant } from "./merchants/pilotKits.js";
import { sllrManifest } from "./manifest.js";
import { actionKeyFrom } from "./core/mutations.js";
import { getUnavailableItems, setItemAvailability } from "./core/availability.js";
import { nearbyMerchants } from "./core/nearby.js";
import { issueMerchantToken, requireMerchantAuth } from "./core/merchantAuth.js";
import { attachMerchantPayment, createMerchantOrder, getMerchant, getMerchantCapacity, getMerchantMenu, grantMerchantConsent, issueMerchantReceipt, listMerchantOrders, listMerchants, quoteMerchantOrder, requirePaymentVerifier } from "./core/merchantApi.js";
import { merchantPaymentOptions } from "./core/paymentOptions.js";
import { recommendFromMenu } from "./core/menuRecommend.js";
import { createVerifiedReview, listMerchantReviews, getMerchantReliability } from "./core/verifiedReview.js";
import { raposaOrderPage, raposaTerminalPage } from "./ui/raposa.js";
import { merchantTerminalPage, standaloneAgentPage } from "./ui/agenticPos.js";
import { merchantJourneyAssetNames, merchantJourneyEngine, merchantJourneyPage } from "./ui/merchantJourney.js";
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
import { createCardSetup, payWithSavedCard } from "./adapters/cardOnFile.js";
import { cancelSubscription, confirmRun, createSubscription, declineRun, listPendingRuns, listSubscriptions, sweepDueSubscriptions } from "./core/recurring.js";
import { linePayConfirm } from "./adapters/linePay.js";
import { createDemoMerchant, listDemoMerchants } from "./adapters/shopifyCatalog.js";
import { shopForBuyer } from "./core/personalShop.js";
import { listMerchantOffers, quoteMerchantOffer } from "./core/offers.js";
import { createFulfillmentBatch, getFulfillmentBatch, listFulfillmentBatches } from "./core/batches.js";

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

function javascript(response: ServerResponse, payload: string) {
  response.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=3600",
  });
  response.end(payload);
}

function merchantJourneyAsset(response: ServerResponse, filename: string) {
  if (!merchantJourneyAssetNames.has(filename)) {
    return json(response, 404, { error: "SLL-R journey asset not found." });
  }
  try {
    const payload = readFileSync(resolve(process.cwd(), "public", "world", "assets", filename));
    const contentType = filename.endsWith(".webp") ? "image/webp" : "video/mp4";
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": payload.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    response.end(payload);
  } catch {
    return json(response, 404, { error: "SLL-R journey asset not found." });
  }
}

// Friendly mobile page shown when Stripe redirects the customer's browser back
// after (or canceling) a hosted-checkout payment. The order confirmation +
// receipt are delivered in the messaging thread; this page just closes the loop.
function orderLandingPage(order: { item?: { name?: string; subtotalUsd?: string } } | null, params: URLSearchParams) {
  const canceled = params.has("canceled");
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const itemName = order?.item?.name ? esc(order.item.name) : "your order";
  const amount = order?.item?.subtotalUsd ? `$${esc(order.item.subtotalUsd)}` : "";
  const ok = !canceled && !!order;
  const emoji = canceled ? "↩️" : order ? "✅" : "🤔";
  const heading = canceled ? "Payment canceled" : order ? "Payment received" : "Order not found";
  const body = canceled
    ? "No charge was made. Head back to Messages to finish your order."
    : order
      ? `Thanks! Your ${itemName}${amount ? ` (${amount})` : ""} is confirmed. Return to Messages — your pickup code and receipt are on the way.`
      : "We couldn't find that order. Head back to Messages.";
  return receiptShell(`${heading} · SLL-R`, `
  <div class="emoji">${emoji}</div>
  <h1>${heading}</h1>
  <p>${body}</p>
  ${ok && amount ? `<div class="amt">Paid ${amount}</div>` : ""}`);
}

// The verified consumption receipt — SLL-R's trust-layer artifact. Shows the
// merchant-verified payment + the integrity hash + cNFT mint status.
function receiptPage(order: Awaited<ReturnType<typeof getOrder>>): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  if (!order || !order.receipt) {
    return receiptShell("Receipt not found · SLL-R", `<div class="emoji">🤔</div><h1>Receipt not found</h1><p>We couldn't find a receipt for that order.</p>`);
  }
  const merchant = esc(order.merchantName || "Merchant");
  const item = esc(order.item?.name || "Item");
  const qty = order.item?.quantity || 1;
  const amount = order.item?.subtotalUsd ? `$${esc(order.item.subtotalUsd)}` : "";
  const code = order.id ? esc(order.id.replace(/^ord_/, "").slice(0, 6).toUpperCase()) : "";
  const when = order.createdAt ? esc(order.createdAt.replace("T", " ").slice(0, 16) + " UTC") : "";
  const provider = esc((order.payment?.provider || "").replace(/^\w/, (c) => c.toUpperCase()));
  const verified = order.payment?.status === "verified";
  const hash = esc(order.receipt.receiptHash || "");
  const mintable = order.receipt.cnftStatus === "ready_for_mint";
  const row = (label: string, value: string) => value ? `<div class="row"><span class="k">${label}</span><span class="v">${value}</span></div>` : "";
  return receiptShell(`Receipt · ${merchant} · SLL-R`, `
  <div class="emoji">🧾</div>
  <h1>Verified Receipt</h1>
  ${verified ? `<div class="badge ok">✓ Payment verified${provider ? ` · ${provider}` : ""}</div>` : `<div class="badge">Pending verification</div>`}
  <div class="rows">
    ${row("Merchant", merchant)}
    ${row("Item", `${item}${qty > 1 ? ` ×${qty}` : ""}`)}
    ${row("Amount", amount)}
    ${row("Pickup code", code)}
    ${row("Date", when)}
  </div>
  ${hash ? `<div class="hash"><div class="k">Receipt hash</div><code>${hash}</code></div>` : ""}
  ${mintable ? `<div class="badge mint">⛓ Ready to mint as on-chain receipt (cNFT)</div>` : ""}
  <p class="foot">Cryptographically anchored consumption receipt, verified by the merchant's payment. This is your proof of purchase on SLL-R.</p>`);
}

// Shared dark, mobile-first page shell for order/receipt pages.
function receiptShell(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#0b0b0c; color:#f2f2f7; padding:24px; box-sizing:border-box; }
  .card { max-width:380px; width:100%; text-align:center; background:#1c1c1e; border-radius:20px;
    padding:32px 26px; box-shadow:0 10px 40px rgba(0,0,0,.4); box-sizing:border-box; }
  .emoji { font-size:52px; line-height:1; }
  h1 { font-size:22px; margin:16px 0 10px; }
  p { color:#a1a1a6; margin:0; }
  .amt { margin-top:18px; font-size:15px; color:#30d158; font-weight:600; }
  .badge { display:inline-block; margin:4px 0 6px; padding:5px 12px; border-radius:999px;
    font-size:13px; font-weight:600; background:#2c2c2e; color:#a1a1a6; }
  .badge.ok { background:rgba(48,209,88,.15); color:#30d158; }
  .badge.mint { background:rgba(94,132,255,.15); color:#7d9bff; margin-top:14px; }
  .rows { text-align:left; margin:20px 0 4px; border-top:1px solid #2c2c2e; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:10px 2px;
    border-bottom:1px solid #2c2c2e; font-size:15px; }
  .row .k { color:#8e8e93; }
  .row .v { color:#f2f2f7; font-weight:600; text-align:right; }
  .hash { text-align:left; margin:16px 0 4px; }
  .hash .k { color:#8e8e93; font-size:13px; margin-bottom:4px; }
  .hash code { display:block; word-break:break-all; font-size:12px; color:#c7c7cc;
    background:#0b0b0c; padding:10px; border-radius:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .foot { margin-top:18px; font-size:13px; color:#8e8e93; }
</style></head>
<body><div class="card">${inner}</div></body></html>`;
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

function mutationForResponse(error: unknown) {
  if (typeof error !== "object" || !error || !("mutation" in error)) return null;
  const mutation = error.mutation;
  if (typeof mutation !== "object" || !mutation) return null;
  const candidate = mutation as Record<string, unknown>;
  if (
    typeof candidate.actionKey !== "string"
    || typeof candidate.resourceId !== "string"
    || typeof candidate.state !== "string"
    || typeof candidate.terminal !== "boolean"
    || typeof candidate.retryable !== "boolean"
    || !Array.isArray(candidate.allowedNextActions)
    || !candidate.allowedNextActions.every((value) => typeof value === "string")
    || !Array.isArray(candidate.proofRefs)
    || !candidate.proofRefs.every((value) => typeof value === "string")
  ) return null;
  const refusal = typeof candidate.refusal === "object" && candidate.refusal
    && typeof (candidate.refusal as Record<string, unknown>).code === "string"
    && typeof (candidate.refusal as Record<string, unknown>).message === "string"
    ? candidate.refusal as { code: string; message: string }
    : null;
  return {
    actionKey: candidate.actionKey,
    resourceId: candidate.resourceId,
    state: candidate.state,
    terminal: candidate.terminal,
    retryable: candidate.retryable,
    allowedNextActions: candidate.allowedNextActions,
    proofRefs: candidate.proofRefs,
    ...(typeof candidate.retryAfterMs === "number" ? { retryAfterMs: candidate.retryAfterMs } : {}),
    ...(typeof candidate.expiresAt === "string" ? { expiresAt: candidate.expiresAt } : {}),
    ...(typeof candidate.receiptRef === "string" ? { receiptRef: candidate.receiptRef } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

function errorResponse(response: ServerResponse, error: unknown) {
  const status = typeof error === "object" && error && "status" in error && typeof error.status === "number"
    ? error.status
    : 500;
  const mutation = mutationForResponse(error);
  json(response, status, {
    error: error instanceof Error ? error.message : "SLL-R request failed.",
    ...(typeof error === "object" && error && "quote" in error ? { quote: error.quote } : {}),
    ...(typeof error === "object" && error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    ...(mutation ? { mutation } : {}),
  });
}

function rootDiscovery(origin: string) {
  return {
    product: "SLL-R",
    description: "Seller-side agent runtime for merchant quote, order, payment proof, and verified receipt memory.",
    status: "ready",
    agentDiscovery: {
      mcp: `${origin}/mcp`,
      personalAgent: `${origin}/buyer/shop`,
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
      offers: `${origin}/merchants/{merchantId}/offers`,
      capacity: `${origin}/merchants/{merchantId}/capacity`,
      batches: `${origin}/merchants/{merchantId}/batches`,
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
    if (request.method === "GET" && url.pathname === "/world") {
      return html(response, 200, merchantJourneyPage());
    }
    if (request.method === "GET" && url.pathname === "/world/engine.js") {
      return javascript(response, merchantJourneyEngine());
    }
    const worldAssetRoute = url.pathname.match(/^\/world\/assets\/([^/]+)$/);
    if (request.method === "GET" && worldAssetRoute) {
      return merchantJourneyAsset(response, worldAssetRoute[1]);
    }

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
      if (request.method === "POST" && url.pathname === "/buyer/shop") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token. Obtain one from POST /buyer/session." });
        const payload = await body(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
        }
        delete payload.buyerId;
        return json(response, 200, await shopForBuyer(session.buyerId, payload));
      }
      // Card on file: start saving a card (returns a SetupIntent client secret the
      // app confirms with Stripe). Buyer-gated.
      if (request.method === "POST" && url.pathname === "/buyer/card/setup") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        const setup = await createCardSetup(session.buyerId);
        return json(response, 200, { product: "SLL-R card setup", ...setup });
      }
      // Charge the buyer's saved card for an order (linkless). Buyer-gated.
      if (request.method === "POST" && url.pathname === "/buyer/pay") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        const payload = await body(request);
        const result = await payWithSavedCard(String(payload.orderId || ""), session.buyerId);
        return json(response, 200, { product: "SLL-R pay with saved card", ...result });
      }
      // Grant quote-bound consent (spec: bounded-action rail). Buyer-aware: binds
      // the consent to the resolved buyer so create_order can verify ownership.
      if (request.method === "POST" && url.pathname === "/consent") {
        return json(response, 200, await grantMerchantConsent(await bindBuyer(request, await body(request))));
      }
      // --- Recurring orders (confirm-each) ---------------------------------
      // Create a recurring subscription ("usual" + weekly schedule). Buyer-gated.
      if (request.method === "POST" && url.pathname === "/buyer/recurring") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        const p = await body(request);
        const result = await createSubscription(session.buyerId, {
          merchantId: String(p.merchantId || ""),
          template: (p.template ?? {}) as never,
          schedule: (p.schedule ?? {}) as never,
          maxPerRunUsd: String(p.maxPerRunUsd || ""),
        });
        return json(response, 201, { product: "SLL-R recurring subscription", ...result });
      }
      // List my subscriptions / cancel one. Buyer-gated.
      if (request.method === "GET" && url.pathname === "/buyer/recurring") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        return json(response, 200, { product: "SLL-R recurring subscriptions", subscriptions: await listSubscriptions(session.buyerId) });
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/buyer/recurring/")) {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        const id = url.pathname.slice("/buyer/recurring/".length);
        return json(response, 200, { product: "SLL-R recurring subscription", subscription: await cancelSubscription(id, session.buyerId) });
      }
      // Pending confirm prompts the buyer's channel should ask about. Buyer-gated.
      if (request.method === "GET" && url.pathname === "/buyer/recurring/runs") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        return json(response, 200, { product: "SLL-R recurring runs", runs: await listPendingRuns(session.buyerId) });
      }
      // Buyer said yes → create order + charge saved card. Buyer-gated.
      if (request.method === "POST" && url.pathname === "/buyer/recurring/confirm") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        const p = await body(request);
        return json(response, 200, { product: "SLL-R recurring confirm", ...(await confirmRun(String(p.runId || ""), session.buyerId)) });
      }
      // Buyer said no → drop this run. Buyer-gated.
      if (request.method === "POST" && url.pathname === "/buyer/recurring/decline") {
        const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
        if (!session) return json(response, 401, { error: "Missing or invalid buyer token." });
        const p = await body(request);
        return json(response, 200, { product: "SLL-R recurring decline", run: await declineRun(String(p.runId || ""), session.buyerId) });
      }
      // Cron sweep: open confirm prompts for due subscriptions. Secret-gated (the
      // schedule lives here per ADR; Vercel Cron calls this). NOT buyer-gated.
      // Vercel Cron sends GET with `Authorization: Bearer <CRON_SECRET>`; we also
      // accept POST + `x-sllr-cron-secret` for manual / external schedulers.
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/internal/recurring/sweep") {
        const secret = process.env.SLLR_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();
        const auth = (request.headers.authorization as string | undefined)?.trim();
        const headerSecret = (request.headers["x-sllr-cron-secret"] as string | undefined)?.trim();
        // Constant-time compare (consistent with the Stripe webhook verifier).
        const ok = Boolean(secret) && (
          (auth !== undefined && safeEqual(auth, `Bearer ${secret}`))
          || (headerSecret !== undefined && safeEqual(headerSecret, secret!))
        );
        if (!ok) return json(response, 401, { error: "Invalid or missing cron secret." });
        const created = await sweepDueSubscriptions();
        return json(response, 200, { product: "SLL-R recurring sweep", created: created.length, runs: created });
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
      const merchantOfferQuoteRoute = url.pathname.match(/^\/merchants\/([^/]+)\/offers\/([^/]+)\/quote$/);
      if (merchantOfferQuoteRoute && request.method === "POST") {
        const [, merchantId, encodedOfferId] = merchantOfferQuoteRoute;
        let offerId: string;
        try {
          offerId = decodeURIComponent(encodedOfferId);
        } catch (error) {
          if (error instanceof URIError) {
            return json(response, 400, { error: "offerId must be valid percent-encoded UTF-8." });
          }
          throw error;
        }
        return json(response, 200, await quoteMerchantOffer(
          merchantId,
          offerId,
          await bindBuyer(request, await body(request)),
        ));
      }
      const merchantBatchRoute = url.pathname.match(/^\/merchants\/([^/]+)\/batches\/([^/]+)$/);
      if (merchantBatchRoute && request.method === "GET") {
        const [, merchantId, batchId] = merchantBatchRoute;
        await requireMerchantAuth(request.headers, { demo: url.searchParams.get("demo") === "true" }, merchantId);
        return json(response, 200, await getFulfillmentBatch(batchId, merchantId));
      }
      const merchantRoute = url.pathname.match(/^\/merchants\/([^/]+)(?:\/([^/]+))?$/);
      if (merchantRoute) {
        const [, merchantId, action] = merchantRoute;
        // GET /merchants/nearby?lat=&lng=&radiusKm=&category=&limit= — location-aware lookup.
        if (request.method === "GET" && merchantId === "nearby" && !action) {
          const lat = Number(url.searchParams.get("lat"));
          const lng = Number(url.searchParams.get("lng"));
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return json(response, 400, { error: "lat and lng query params are required (numbers)." });
          }
          const radiusKm = url.searchParams.get("radiusKm");
          const limit = url.searchParams.get("limit");
          return json(response, 200, {
            product: "SLL-R nearby merchants",
            merchants: nearbyMerchants(lat, lng, {
              radiusKm: radiusKm ? Number(radiusKm) : undefined,
              category: url.searchParams.get("category") || undefined,
              limit: limit ? Number(limit) : undefined,
            }),
          });
        }
        if (request.method === "GET" && !action) {
          return json(response, 200, getMerchant(merchantId));
        }
        if (request.method === "GET" && action === "menu") {
          return json(response, 200, getMerchantMenu(merchantId));
        }
        if (request.method === "GET" && action === "offers") {
          return json(response, 200, listMerchantOffers(merchantId));
        }
        if (request.method === "GET" && action === "capacity") {
          return json(response, 200, await getMerchantCapacity(merchantId, Object.fromEntries(url.searchParams.entries())));
        }
        if (request.method === "GET" && action === "batches") {
          await requireMerchantAuth(request.headers, { demo: url.searchParams.get("demo") === "true" }, merchantId);
          return json(response, 200, await listFulfillmentBatches(merchantId));
        }
        if (request.method === "POST" && action === "batches") {
          const payload = await body(request);
          await requireMerchantAuth(request.headers, payload, merchantId);
          return json(response, 201, await createFulfillmentBatch(merchantId, payload));
        }
        if (request.method === "POST" && action === "quote") {
          return json(response, 200, await quoteMerchantOrder(merchantId, await bindBuyer(request, await body(request))));
        }
        if (request.method === "POST" && action === "recommend") {
          return json(response, 200, await recommendFromMenu(merchantId, await body(request)));
        }
        if (request.method === "GET" && action === "reviews") {
          return json(response, 200, {
            product: "SLL-R verified reviews",
            reliability: await getMerchantReliability(merchantId),
            reviews: await listMerchantReviews(merchantId),
          });
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
        if (request.method === "POST" && action === "token") {
          // Operator-only: mint a per-merchant token (requires the global secret).
          const payload = await body(request);
          requirePaymentVerifier(request.headers, payload);
          getMerchant(merchantId);
          const token = await issueMerchantToken(merchantId, new Date().toISOString());
          return json(response, 201, { product: "SLL-R agent POS", merchantId, token, usage: "Send as x-sllr-merchant-payment-secret header (or verificationToken) on this merchant's POS actions." });
        }
        if (request.method === "POST" && action === "availability") {
          const payload = await body(request);
          await requireMerchantAuth(request.headers, payload, merchantId);
          getMerchant(merchantId);
          const itemId = String(payload.itemId || "");
          if (!itemId) throw Object.assign(new Error("Missing itemId."), { status: 400 });
          const unavailableItems = await setItemAvailability(merchantId, itemId, payload.available === true);
          return json(response, 200, { product: "SLL-R agent POS", merchantId, unavailableItems });
        }
        if (request.method === "GET" && action === "availability") {
          getMerchant(merchantId);
          return json(response, 200, { product: "SLL-R agent POS", merchantId, unavailableItems: await getUnavailableItems(merchantId) });
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
        // result is one of: ignored event | card-on-file saved | settled order.
        return json(response, 200, ("ignored" in result || "saved" in result)
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
          warning: "Demo endpoint records payment proof from a provided transaction or request id. Final receipt memory still requires merchant fulfillment.",
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
          next: "Attach payment proof, then record merchant fulfillment before issuing final receipt memory.",
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
      const receiptRoute = url.pathname.match(/^\/receipts\/([^/]+)$/);
      if (receiptRoute && request.method === "GET") {
        const order = await getOrder(receiptRoute[1]);
        const wantsJson = String(request.headers.accept || "").includes("application/json");
        if (!order || !order.receipt) {
          return wantsJson
            ? json(response, 404, { error: `No receipt for order: ${receiptRoute[1]}` })
            : html(response, 404, receiptPage(null));
        }
        return wantsJson
          ? json(response, 200, { product: "SLL-R receipt", order })
          : html(response, 200, receiptPage(order));
      }

      const orderRoute = url.pathname.match(/^\/orders\/([^/]+)(?:\/([^/]+))?$/);
      if (orderRoute) {
        const [, orderId, action] = orderRoute;
        if (request.method === "GET" && !action) {
          const order = await getOrder(orderId);
          // Stripe redirects the customer's browser here (?paid=1 / ?canceled=1).
          // Serve a friendly page for browsers; keep JSON for API/tool callers.
          const wantsHtml = url.searchParams.has("paid") || url.searchParams.has("canceled")
            || String(request.headers.accept || "").includes("text/html");
          if (wantsHtml) {
            return html(response, order ? 200 : 404, orderLandingPage(order, url.searchParams));
          }
          return json(response, order ? 200 : 404, order ? { product: "SLL-R merchant terminal", order } : { error: `Unknown order: ${orderId}` });
        }
        if (request.method === "POST" && action === "review") {
          // Verified review: buyer submits feedback; only proof-backed orders qualify.
          const session = await resolveBuyer(buyerTokenFrom(request.headers), new Date().toISOString());
          const payload = await body(request);
          const review = await createVerifiedReview(
            orderId,
            { feedback: payload.feedback as never, agentDecision: payload.agentDecision as never },
            session?.buyerId ?? null,
          );
          return json(response, 201, { product: "SLL-R verified review", review });
        }
        if (request.method === "POST" && action === "accept") {
          const payload = await body(request);
          await requireMerchantAuth(request.headers, payload, String((payload as { merchantId?: unknown }).merchantId ?? ""));
          const order = await acceptOrder(orderId, payload as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "reject") {
          const payload = await body(request);
          await requireMerchantAuth(request.headers, payload, String((payload as { merchantId?: unknown }).merchantId ?? ""));
          const order = await rejectOrder(orderId, payload as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "fulfill") {
          const payload = await body(request);
          await requireMerchantAuth(request.headers, payload, String((payload as { merchantId?: unknown }).merchantId ?? ""));
          const { result: order, mutation } = await fulfillOrderMutation(orderId, payload as never, {
            requesterId: "merchant-terminal",
            actionKey: actionKeyFrom(payload, "merchant_fulfill_order"),
          });
          return json(response, 200, {
            product: "SLL-R merchant terminal",
            status: order.status,
            proofLevel: order.proofLevel,
            order,
            ...(mutation ? { mutation } : {}),
          });
        }
        if (request.method === "POST" && action === "ready") {
          const payload = await body(request);
          await requireMerchantAuth(request.headers, payload, String((payload as { merchantId?: unknown }).merchantId ?? ""));
          const order = await markOrderReady(orderId, payload as never);
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
        const payload = await body(request);
        // Gate generic payment-proof attachment behind the merchant verifier so a
        // caller can't forge a paid order + receipt (the trust layer). demo=true
        // works only when no verifier secret is configured.
        requirePaymentVerifier(request.headers, payload);
        const { result: order, mutation } = await attachPaymentProofMutation(payload as never, {
          requesterId: "payment-provider",
          actionKey: actionKeyFrom(payload, "attach_payment_proof"),
        });
        return json(response, 200, {
          product: "SLL-R payment proof adapter",
          status: order.status,
          proofLevel: order.proofLevel,
          order,
          ...(mutation ? { mutation } : {}),
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
