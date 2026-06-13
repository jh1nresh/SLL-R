import { createHmac, randomUUID } from "node:crypto";
import { attachPaymentProof, getOrder } from "../core/orders.js";
import { merchantForId } from "../merchants/profiles.js";
import type { SellerOrder } from "../types.js";

// LINE Pay prepay-in-flow (v0) — the Taiwan counterpart of the Stripe rail.
// Same shape (buyer pays in-flow, merchant only fulfills, proof issues receipt),
// but LINE Pay's Online API is request -> redirect -> confirm rather than a
// webhook: we Reserve a payment (request) to get a payment URL, the buyer
// authorizes in LINE, LINE redirects to our confirmUrl, and we then Confirm
// (capture) and attach proof. Calls the LINE Pay REST API over fetch (no SDK).
//
// Config: LINE_PAY_CHANNEL_ID + LINE_PAY_CHANNEL_SECRET. Currency defaults to
// TWD (no minor units). LINE_PAY_API_BASE is a test/sandbox override.

// Currencies LINE Pay supports and their minor-unit exponent. TWD/JPY have none.
const CURRENCY_DECIMALS: Record<string, number> = { TWD: 0, JPY: 0, USD: 2, THB: 2 };

function linePayCurrency() {
  return (process.env.LINE_PAY_CURRENCY?.trim() || "TWD").toUpperCase();
}

function linePayApiBase() {
  return (process.env.LINE_PAY_API_BASE?.trim() || "https://api-pay.line.me").replace(/\/$/, "");
}

function linePayConfig() {
  const channelId = process.env.LINE_PAY_CHANNEL_ID?.trim() || "";
  const channelSecret = process.env.LINE_PAY_CHANNEL_SECRET?.trim() || "";
  return channelId && channelSecret ? { channelId, channelSecret } : null;
}

// LINE Pay decimal-string amount -> integer in the currency's smallest unit.
// For TWD (0 decimals) the amount is the whole number; rounding guards against
// a merchant catalog priced with cents.
function linePayAmount(amountDecimal: string, currency: string) {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2;
  const value = Number(amountDecimal.trim().replace(/[$,\s]/g, "")) || 0;
  return decimals === 0 ? Math.round(value) : Math.round(value * 10 ** decimals) / 10 ** decimals;
}

// LINE Pay v3 auth signature: Base64(HMAC-SHA256(channelSecret,
// channelSecret + uri + body + nonce)). For GET-style confirms the "body" is the
// query string; here every call is POST JSON so body is the JSON string.
function authHeaders(channelId: string, channelSecret: string, uriPath: string, body: string, nonce: string) {
  const signature = createHmac("sha256", channelSecret)
    .update(channelSecret + uriPath + body + nonce, "utf8")
    .digest("base64");
  return {
    "content-type": "application/json",
    "X-LINE-ChannelId": channelId,
    "X-LINE-Authorization-Nonce": nonce,
    "X-LINE-Authorization": signature,
  };
}

async function linePayPost<T>(uriPath: string, body: Record<string, unknown>, nonce: string): Promise<T> {
  const config = linePayConfig();
  if (!config) throw Object.assign(new Error("LINE Pay is not configured."), { status: 503 });
  const json = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(`${linePayApiBase()}${uriPath}`, {
      method: "POST",
      headers: authHeaders(config.channelId, config.channelSecret, uriPath, json, nonce),
      body: json,
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw Object.assign(new Error(`LINE Pay is unreachable: ${error instanceof Error ? error.message : "fetch failed"}`), { status: 503 });
  }
  const payload = await response.json().catch(() => ({})) as { returnCode?: string; returnMessage?: string; info?: T };
  // LINE Pay returns HTTP 200 with returnCode "0000" on success; other codes are
  // failures even at HTTP 200.
  if (!response.ok || payload.returnCode !== "0000") {
    throw Object.assign(new Error(`LINE Pay error ${payload.returnCode || response.status}: ${payload.returnMessage || ""}`), { status: 502 });
  }
  return payload.info as T;
}

export async function linePayPreparePayment(order: SellerOrder, origin: string) {
  if (!linePayConfig()) {
    return {
      rail: "line_pay" as const,
      type: "setup_required",
      orderId: order.id,
      amountUsd: order.item.subtotalUsd,
      reason: "LINE_PAY_CHANNEL_ID / LINE_PAY_CHANNEL_SECRET are not configured.",
    };
  }
  const currency = linePayCurrency();
  const amount = linePayAmount(order.item.subtotalUsd, currency);
  const info = await linePayPost<{ paymentUrl?: { web?: string; app?: string }; transactionId?: number | string }>(
    "/v3/payments/request",
    {
      amount,
      currency,
      orderId: order.id,
      packages: [{
        id: order.merchantId,
        amount,
        name: order.merchantName,
        products: [{ name: order.item.name, quantity: 1, price: amount }],
      }],
      redirectUrls: {
        confirmUrl: `${origin}/line-pay/confirm`,
        cancelUrl: `${origin}/orders/${order.id}?canceled=1`,
      },
    },
    randomUUID(),
  );
  return {
    rail: "line_pay" as const,
    type: "payment_url",
    orderId: order.id,
    amount,
    currency,
    transactionId: String(info.transactionId ?? ""),
    url: info.paymentUrl?.web || info.paymentUrl?.app || null,
    proof: "After the buyer authorizes in LINE, LINE redirects to /line-pay/confirm which captures the payment and issues receipt memory.",
    next: "Open the LINE Pay payment URL, authorize, then return — SLL-R confirms the capture on redirect.",
  };
}

// Called from the LINE Pay redirect (GET /line-pay/confirm?orderId&transactionId).
export async function linePayConfirm(orderId: string, transactionId: string) {
  if (!orderId || !transactionId) {
    throw Object.assign(new Error("Missing orderId or transactionId."), { status: 400 });
  }
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  const merchant = merchantForId(order.merchantId);
  if (!merchant || !merchant.paymentRails.includes("line_pay")) {
    throw Object.assign(new Error(`Order ${order.id} merchant does not support LINE Pay.`), { status: 409 });
  }
  const currency = linePayCurrency();
  const amount = linePayAmount(order.item.subtotalUsd, currency);
  // Confirm (capture) the reserved transaction. LINE Pay validates the amount +
  // currency against the reservation, so a tampered amount is rejected upstream.
  await linePayPost(`/v3/payments/${encodeURIComponent(transactionId)}/confirm`, { amount, currency }, randomUUID());

  return attachPaymentProof({
    orderId: order.id,
    merchantId: order.merchantId,
    provider: "line_pay",
    amountUsd: order.item.subtotalUsd,
    paymentId: `line_pay_${transactionId}`,
  });
}
