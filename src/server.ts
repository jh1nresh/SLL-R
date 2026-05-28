import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { acceptOrder, claimOrder, createOrder, fulfillOrder, getOrder, listOrders, markOrderReady, rejectOrder } from "./core/orders.js";
import { quoteOrder } from "./core/quote.js";
import { merchantForId, merchantProfiles } from "./merchants/profiles.js";
import { pilotKitForMerchant } from "./merchants/pilotKits.js";
import { sllrManifest } from "./manifest.js";
import { attachPaymentProof } from "./core/orders.js";
import { attachMerchantPayment, createMerchantOrder, getMerchant, getMerchantMenu, issueMerchantReceipt, listMerchantOrders, listMerchants, quoteMerchantOrder } from "./core/merchantApi.js";
import { raposaOrderPage, raposaTerminalPage } from "./ui/raposa.js";
import { baseCoffeeMerchants, baseCoffeeOrder, baseCoffeePayment, baseCoffeeQuote, baseCoffeeRecordDemoPayment, baseCoffeeStatus } from "./adapters/baseCoffeePlugin.js";
import { helioWebhook, solanaPayMerchants, solanaPayPreparePayment, solanaPayVerifyPayment } from "./adapters/solanaPay.js";

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload, null, 2));
}

function html(response: ServerResponse, status: number, payload: string) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(payload);
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 200_000) {
      throw Object.assign(new Error("Request body too large."), { status: 413 });
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
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

export async function handleSllrRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url || "/", originFrom(request));

    if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, product: "SLL-R" });
      }
      if (request.method === "GET" && url.pathname === "/raposa") {
        return html(response, 200, raposaTerminalPage(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/raposa/order") {
        return html(response, 200, raposaOrderPage());
      }
      if (request.method === "GET" && url.pathname === "/.well-known/sllr-agent.json") {
        return json(response, 200, sllrManifest(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/capabilities") {
        const merchantId = url.searchParams.get("merchantId") || "";
        const merchant = merchantId ? merchantForId(merchantId) : null;
        return json(response, merchantId && !merchant ? 404 : 200, {
          product: "SLL-R seller operating agent",
          merchants: merchant ? [merchant] : Object.values(merchantProfiles),
        });
      }
      if (request.method === "GET" && url.pathname === "/merchants") {
        return json(response, 200, listMerchants());
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
          return json(response, 201, createMerchantOrder(merchantId, await body(request)));
        }
        if (request.method === "GET" && action === "orders") {
          return json(response, 200, listMerchantOrders(merchantId, url.searchParams.get("status")));
        }
        if (request.method === "POST" && action === "payment") {
          return json(response, 200, await attachMerchantPayment(merchantId, request.headers, await body(request)));
        }
        if (request.method === "POST" && action === "receipt") {
          return json(response, 200, await issueMerchantReceipt(merchantId, await body(request)));
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
        return json(response, 201, baseCoffeeOrder(url.searchParams));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/prepare-payment") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        return json(response, 200, baseCoffeePayment(orderId, url.searchParams.get("from")));
      }
      if (request.method === "GET" && url.pathname === "/base-plugin/coffee/status") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        return json(response, 200, { product: "SLL-R Base coffee status", order: baseCoffeeStatus(orderId) });
      }
      if (request.method === "GET" && url.pathname === "/solana-pay/merchants") {
        return json(response, 200, solanaPayMerchants(originFrom(request)));
      }
      if (request.method === "GET" && url.pathname === "/solana-pay/prepare-payment") {
        const orderId = url.searchParams.get("orderId") || "";
        if (!orderId) return json(response, 400, { error: "Missing orderId." });
        return json(response, 200, solanaPayPreparePayment(orderId));
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
        const result = createOrder(await body(request) as never);
        return json(response, 201, {
          product: "SLL-R order handoff",
          status: result.order.status,
          quote: result.quote,
          order: result.order,
          next: "Attach payment or fulfillment proof to issue Jiagon receipt memory.",
        });
      }
      if (request.method === "GET" && url.pathname === "/orders") {
        return json(response, 200, {
          product: "SLL-R merchant terminal",
          orders: listOrders({
            merchantId: url.searchParams.get("merchantId") || undefined,
            status: url.searchParams.get("status") as never || undefined,
          }),
        });
      }
      const orderRoute = url.pathname.match(/^\/orders\/([^/]+)(?:\/([^/]+))?$/);
      if (orderRoute) {
        const [, orderId, action] = orderRoute;
        if (request.method === "GET" && !action) {
          const order = getOrder(orderId);
          return json(response, order ? 200 : 404, order ? { product: "SLL-R merchant terminal", order } : { error: `Unknown order: ${orderId}` });
        }
        if (request.method === "POST" && action === "accept") {
          const order = acceptOrder(orderId, await body(request) as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "reject") {
          const order = rejectOrder(orderId, await body(request) as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "fulfill") {
          const order = await fulfillOrder(orderId, await body(request) as never);
          return json(response, 200, {
            product: "SLL-R merchant terminal",
            status: order.status,
            proofLevel: order.proofLevel,
            order,
          });
        }
        if (request.method === "POST" && action === "ready") {
          const order = markOrderReady(orderId, await body(request) as never);
          return json(response, 200, { product: "SLL-R merchant terminal", status: order.status, order });
        }
        if (request.method === "POST" && action === "claim") {
          const order = await claimOrder(orderId, await body(request) as never);
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
