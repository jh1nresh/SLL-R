import { createHmac, timingSafeEqual } from "node:crypto";
import { attachPaymentProof, getOrder } from "../core/orders.js";
import { merchantForId } from "../merchants/profiles.js";
import { centsFromUsd, formatUsd } from "../core/money.js";
import type { SellerOrder } from "../types.js";

// Stripe prepay-in-flow (v0): the buyer pays inside the agent flow via a Stripe
// hosted Checkout Session; a signed webhook then attaches payment proof, which
// issues receipt memory. The merchant only fulfills and never handles payment.
//
// v0 uses a single platform Stripe account, no platform fee. The flow is
// fee-ready: Stripe Connect destination charges + application_fee_amount (the
// take-rate) are an additive next step, not a rewrite. Calls the Stripe REST
// API over fetch (no SDK) to keep the runtime dependency-free.

// Override only for tests (fake Stripe server). Defaults to the real API.
function stripeApiBase() {
  return (process.env.STRIPE_API_BASE?.trim() || "https://api.stripe.com/v1").replace(/\/$/, "");
}

function stripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() || "";
}

async function requireStripeOrder(orderId: string) {
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  return getOrder(orderId);
}

function formEncode(fields: Record<string, string>) {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function stripeRequest<T>(path: string, body: Record<string, string>): Promise<T> {
  const key = stripeSecretKey();
  if (!key) throw Object.assign(new Error("STRIPE_SECRET_KEY is not configured."), { status: 503 });
  let response: Response;
  try {
    response = await fetch(`${stripeApiBase()}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: formEncode(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw Object.assign(new Error(`Stripe is unreachable: ${error instanceof Error ? error.message : "fetch failed"}`), { status: 503 });
  }
  const payload = await response.json().catch(() => ({})) as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || payload.error) {
    throw Object.assign(new Error(`Stripe error: ${payload.error?.message || response.status}`), { status: 502 });
  }
  return payload as T;
}

// Async so it matches the other prepare-payment adapters and can await the
// Stripe API. Returns a setup_required option when Stripe is not configured.
export async function stripePreparePayment(order: SellerOrder, origin: string) {
  if (!stripeSecretKey()) {
    return {
      rail: "stripe" as const,
      type: "setup_required",
      orderId: order.id,
      amountUsd: order.item.subtotalUsd,
      reason: "STRIPE_SECRET_KEY is not configured. Set it to enable Stripe hosted checkout (card / Apple Pay).",
    };
  }

  const amountCents = centsFromUsd(order.item.subtotalUsd);
  const session = await stripeRequest<{ id: string; url: string }>("/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": `${order.merchantName}: ${order.item.name}`,
    "metadata[sllr_order_id]": order.id,
    "metadata[sllr_merchant_id]": order.merchantId,
    "payment_intent_data[metadata][sllr_order_id]": order.id,
    success_url: `${origin}/orders/${order.id}?paid=1`,
    cancel_url: `${origin}/orders/${order.id}?canceled=1`,
  });

  return {
    rail: "stripe" as const,
    type: "checkout_url",
    orderId: order.id,
    amountUsd: order.item.subtotalUsd,
    checkoutSessionId: session.id,
    url: session.url,
    proof: "Stripe checkout.session.completed webhook attaches payment proof before receipt memory.",
    next: "Open the Stripe checkout, pay with card or Apple/Google Pay, then return after payment proof.",
  };
}

function signatureHeader(headers: Record<string, string | string[] | undefined>) {
  const value = headers["stripe-signature"];
  return Array.isArray(value) ? value[0] : value;
}

// Verify the Stripe webhook signature: header `t=<ts>,v1=<hexsig>`, where the
// signed payload is `${t}.${rawBody}` HMAC-SHA256'd with the webhook secret.
function verifyStripeWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, payload: Record<string, unknown>) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    if (payload.demo === true) return { mode: "demo" as const };
    throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET is not configured. Send demo=true for local demos, or configure the webhook secret before accepting Stripe payment proof."), { status: 403 });
  }
  const header = signatureHeader(headers);
  if (!header) throw Object.assign(new Error("Missing Stripe-Signature header."), { status: 401 });
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) throw Object.assign(new Error("Malformed Stripe-Signature header."), { status: 401 });
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  const providedBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw Object.assign(new Error("Stripe webhook signature verification failed."), { status: 401 });
  }
  return { mode: "signature" as const };
}

function sessionFrom(payload: Record<string, unknown>) {
  const data = payload.data as { object?: Record<string, unknown> } | undefined;
  return data?.object || {};
}

export async function stripeWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, payload: Record<string, unknown>) {
  const verifier = verifyStripeWebhook(headers, rawBody, payload);
  const type = String(payload.type || "");
  if (type && type !== "checkout.session.completed" && type !== "payment_intent.succeeded") {
    return { product: "SLL-R Stripe webhook", ignored: type };
  }

  const object = sessionFrom(payload);
  // Only treat the payment as proof when funds actually cleared. Stripe fires
  // checkout.session.completed even for delayed/async methods that are still
  // unpaid; receipt memory must wait for paid/succeeded.
  if (type === "checkout.session.completed" && object.payment_status !== undefined && object.payment_status !== "paid") {
    return { product: "SLL-R Stripe webhook", ignored: type, reason: `payment_status=${String(object.payment_status)}` };
  }
  if (type === "payment_intent.succeeded" && object.status !== undefined && object.status !== "succeeded") {
    return { product: "SLL-R Stripe webhook", ignored: type, reason: `status=${String(object.status)}` };
  }
  const metadata = (object.metadata as Record<string, unknown> | undefined) || {};
  const orderId = String(metadata.sllr_order_id || payload.sllr_order_id || "");
  const order = await requireStripeOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId || "(missing sllr_order_id)"}`), { status: 404 });

  const merchant = merchantForId(order.merchantId);
  if (!merchant || !merchant.paymentRails.includes("stripe")) {
    throw Object.assign(new Error(`Order ${order.id} merchant does not support Stripe.`), { status: 409 });
  }

  // Stripe amounts are in the smallest currency unit (cents).
  const amountTotal = Number(object.amount_total ?? object.amount ?? 0);
  const amountUsd = amountTotal > 0 ? formatUsd(amountTotal) : order.item.subtotalUsd;
  const paymentId = `${String(object.id || object.payment_intent || "stripe_session")}:${verifier.mode}`;

  return attachPaymentProof({
    orderId: order.id,
    merchantId: order.merchantId,
    provider: "stripe",
    amountUsd,
    paymentId,
  });
}
