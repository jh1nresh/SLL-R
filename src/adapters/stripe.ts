import { createHmac, timingSafeEqual } from "node:crypto";
import { attachPaymentProof, getOrder } from "../core/orders.js";
import { merchantForId } from "../merchants/profiles.js";
import { centsFromUsd, formatUsd } from "../core/money.js";
import { getBuyerBilling, setBuyerBilling } from "../core/buyerBilling.js";
import type { SellerOrder } from "../types.js";

// Stripe prepay-in-flow (v0): the buyer pays inside the agent flow via a Stripe
// hosted Checkout Session; a signed webhook then attaches payment proof, which
// attaches payment proof. The merchant still fulfills before final receipt memory.
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

async function stripeRequest<T>(
  path: string,
  body: Record<string, string>,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const key = stripeSecretKey();
  if (!key) throw Object.assign(new Error("STRIPE_SECRET_KEY is not configured."), { status: 503 });
  let response: Response;
  try {
    response = await fetch(`${stripeApiBase()}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
        // Idempotency: a retried charge with the same key never double-charges.
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: formEncode(body),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw Object.assign(new Error(`Stripe is unreachable: ${error instanceof Error ? error.message : "fetch failed"}`), { status: 503 });
  }
  const payload = await response.json().catch(() => ({})) as {
    id?: string;
    url?: string;
    error?: { message?: string; code?: string; decline_code?: string; payment_intent?: { id?: string } };
  };
  if (!response.ok || payload.error) {
    // Surface the Stripe error code so off-session callers can tell SCA-required
    // / declined apart from a real failure.
    throw Object.assign(new Error(`Stripe error: ${payload.error?.message || response.status}`), {
      status: 502,
      stripeCode: payload.error?.code,
      stripeDeclineCode: payload.error?.decline_code,
      stripePaymentIntentId: payload.error?.payment_intent?.id,
    });
  }
  return payload as T;
}

// GET a Stripe resource (used to read a completed checkout's saved PaymentMethod).
async function stripeGet<T>(path: string): Promise<T> {
  const key = stripeSecretKey();
  if (!key) throw Object.assign(new Error("STRIPE_SECRET_KEY is not configured."), { status: 503 });
  let response: Response;
  try {
    response = await fetch(`${stripeApiBase()}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw Object.assign(new Error(`Stripe is unreachable: ${error instanceof Error ? error.message : "fetch failed"}`), { status: 503 });
  }
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } } & Record<string, unknown>;
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

  // Card on file via the first checkout: for a buyer-bound order, attach the
  // checkout to the buyer's Stripe Customer and save the card off-session, so
  // every later order can charge linklessly (pay once here → remembered).
  let customerId: string | undefined;
  if (order.buyerId) {
    const billing = await getBuyerBilling(order.buyerId);
    customerId = billing.stripeCustomerId;
    if (!customerId) {
      customerId = await stripeCreateCustomer(order.buyerId);
      await setBuyerBilling(order.buyerId, { stripeCustomerId: customerId });
    }
  }

  const session = await stripeRequest<{ id: string; url: string }>("/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amountCents),
    "line_items[0][price_data][product_data][name]": `${order.merchantName}: ${order.item.name}`,
    "metadata[sllr_order_id]": order.id,
    "metadata[sllr_merchant_id]": order.merchantId,
    "payment_intent_data[metadata][sllr_order_id]": order.id,
    // Buyer-bound → save the card to the Customer for future off-session charges.
    ...(customerId ? {
      customer: customerId,
      "payment_intent_data[setup_future_usage]": "off_session",
    } : {}),
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
    proof: "Stripe checkout.session.completed attaches payment proof; merchant fulfillment is still required for final receipt memory.",
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
  // Replay protection: reject events whose signed timestamp is outside the
  // tolerance window (Stripe default 300s). Set STRIPE_WEBHOOK_TOLERANCE_SEC=0
  // to disable (e.g. replaying historical events from the Stripe dashboard).
  // Fail CLOSED on a malformed value: a typo ("5m", "300s") must not silently
  // disable replay protection, so a non-numeric value falls back to 300.
  const rawTolerance = process.env.STRIPE_WEBHOOK_TOLERANCE_SEC?.trim();
  const parsedTolerance = rawTolerance === undefined || rawTolerance === "" ? 300 : Number(rawTolerance);
  const toleranceSec = Number.isFinite(parsedTolerance) ? parsedTolerance : 300;
  if (toleranceSec > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const skew = Math.abs(nowSec - Number(timestamp));
    if (!Number.isFinite(skew) || skew > toleranceSec) {
      throw Object.assign(new Error("Stripe webhook timestamp is outside the tolerance window (possible replay)."), { status: 401 });
    }
  }
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

  // Card-on-file: a SetupIntent succeeded → the buyer just saved a card. Store the
  // PaymentMethod on their billing record so future orders charge off-session.
  if (type === "setup_intent.succeeded") {
    const si = sessionFrom(payload);
    const meta = (si.metadata as Record<string, unknown> | undefined) || {};
    const buyerId = String(meta.sllr_buyer_id || "");
    const paymentMethodId = String(si.payment_method || "");
    const customerId = String(si.customer || "");
    if (!buyerId || !paymentMethodId) {
      return { product: "SLL-R Stripe webhook", ignored: type, reason: "missing buyer/payment_method" };
    }
    await setBuyerBilling(buyerId, { paymentMethodId, ...(customerId ? { stripeCustomerId: customerId } : {}) });
    return { product: "SLL-R card on file", saved: true, buyerId, verifier: verifier.mode };
  }

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

  const proof = await attachPaymentProof({
    orderId: order.id,
    merchantId: order.merchantId,
    provider: "stripe",
    amountUsd,
    paymentId,
  });

  // First-checkout card-save: if this buyer-bound checkout saved a card
  // (setup_future_usage), capture the PaymentMethod so later orders charge
  // off-session. Best-effort — the payment proof above is already attached.
  if (type === "checkout.session.completed" && order.buyerId && object.customer && object.payment_intent) {
    try {
      const pi = await stripeGet<{ payment_method?: string }>(`/payment_intents/${encodeURIComponent(String(object.payment_intent))}`);
      if (pi.payment_method) {
        await setBuyerBilling(order.buyerId, {
          stripeCustomerId: String(object.customer),
          paymentMethodId: String(pi.payment_method),
        });
      }
    } catch {
      // Card-save is best-effort; the buyer can still bind a card later.
    }
  }

  return proof;
}

// --- Card on file (off-session) ---------------------------------------------

// A Stripe Customer holds the buyer's saved card. metadata links it back to us.
export async function stripeCreateCustomer(buyerId: string): Promise<string> {
  const customer = await stripeRequest<{ id: string }>("/customers", {
    "metadata[sllr_buyer_id]": buyerId,
  });
  return customer.id;
}

// SetupIntent: the app/one-time page uses the returned client_secret to save a
// card to the Customer (PCI handled by Stripe). usage=off_session so we can later
// charge without the buyer present.
export async function stripeCreateSetupIntent(customerId: string, buyerId: string): Promise<{ id: string; clientSecret: string }> {
  const si = await stripeRequest<{ id: string; client_secret: string }>("/setup_intents", {
    customer: customerId,
    usage: "off_session",
    "payment_method_types[0]": "card",
    "metadata[sllr_buyer_id]": buyerId,
  });
  return { id: si.id, clientSecret: si.client_secret };
}

export type OffSessionResult = { status: "succeeded" | "requires_action" | "declined"; paymentIntentId?: string };

// Charge the saved card with no buyer present. Idempotency key = order id, so a
// retry never double-charges. SCA-required / declines come back as a status (not
// a throw) so the caller can fall back to a hosted Checkout link.
export async function stripeChargeOffSession(args: {
  customerId: string;
  paymentMethodId: string;
  amountUsd: string;
  orderId: string;
  merchantId: string;
  merchantName: string;
  idempotencyKey?: string;
}): Promise<OffSessionResult> {
  try {
    const pi = await stripeRequest<{ id: string; status: string }>(
      "/payment_intents",
      {
        amount: String(centsFromUsd(args.amountUsd)),
        currency: "usd",
        customer: args.customerId,
        payment_method: args.paymentMethodId,
        off_session: "true",
        confirm: "true",
        description: `${args.merchantName}: order ${args.orderId}`,
        "metadata[sllr_order_id]": args.orderId,
        "metadata[sllr_merchant_id]": args.merchantId,
      },
      // Default: per-order key. Recurring overrides with a run-anchored key so
      // retries that mint distinct orders still charge once.
      { idempotencyKey: args.idempotencyKey ?? `sllr_charge_${args.orderId}` },
    );
    return { status: pi.status === "succeeded" ? "succeeded" : "requires_action", paymentIntentId: pi.id };
  } catch (error) {
    const e = error as { stripeCode?: string; stripePaymentIntentId?: string };
    if (e.stripeCode === "authentication_required") {
      return { status: "requires_action", paymentIntentId: e.stripePaymentIntentId };
    }
    if (e.stripeCode === "card_declined" || e.stripeCode === "expired_card" || e.stripeCode === "insufficient_funds") {
      return { status: "declined" };
    }
    throw error;
  }
}
