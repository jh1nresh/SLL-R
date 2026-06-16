import { attachPaymentProof, createOrder, fulfillOrder, getOrder, listOrders } from "./orders.js";
import { quoteOrder } from "./quote.js";
import { allMerchantProfiles, merchantForId } from "../merchants/profiles.js";
import { recurringSuggestion } from "./recurring.js";
import { persistQuote } from "./quotes.js";
import { grantConsent, validateConsentForOrder, expectedConfirmation } from "./consent.js";
import { centsFromUsd } from "./money.js";
import type { MerchantProfile, OrderRequest, PaymentRail, QuoteRequest } from "../types.js";

function requireMerchant(merchantId: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${merchantId}`), { status: 404 });
  return merchant;
}

function merchantSummary(merchant: MerchantProfile) {
  return {
    id: merchant.id,
    name: merchant.name,
    category: merchant.category,
    location: merchant.location,
    geo: merchant.geo ?? null,
    fulfillment: merchant.fulfillment,
    paymentRails: merchant.paymentRails,
    catalogItems: merchant.catalog.length,
    menuSections: merchant.menuSections?.length || 0,
  };
}

function bodyWithMerchant<T extends Record<string, unknown>>(merchantId: string, payload: T) {
  return {
    ...payload,
    merchantId,
  };
}

function paymentRailFor(merchant: MerchantProfile, provider: unknown): PaymentRail {
  if (typeof provider !== "string" || !provider) {
    throw Object.assign(new Error("Missing payment provider."), { status: 400 });
  }
  if (!merchant.paymentRails.includes(provider as PaymentRail)) {
    throw Object.assign(new Error(`${merchant.id} does not support payment provider ${provider}.`), { status: 409 });
  }
  return provider as PaymentRail;
}

export function secretFrom(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>) {
  const header = headers["x-sllr-merchant-payment-secret"];
  if (typeof header === "string" && header.trim()) return header.trim();
  if (typeof body.verificationToken === "string" && body.verificationToken.trim()) {
    return body.verificationToken.trim();
  }
  return null;
}

export function requirePaymentVerifier(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>) {
  const expected = process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET?.trim();
  if (!expected) {
    if (body.demo === true) return;
    throw Object.assign(new Error("SLLR_MERCHANT_PAYMENT_VERIFY_SECRET is not configured. Send demo=true for local demos, or configure a verifier secret before accepting merchant payment or fulfillment proof."), { status: 403 });
  }
  if (secretFrom(headers, body) !== expected) {
    throw Object.assign(new Error("Merchant payment verifier secret is missing or invalid."), { status: 401 });
  }
}

export function listMerchants() {
  return {
    product: "SLL-R merchant runtime",
    merchants: allMerchantProfiles().map(merchantSummary),
  };
}

// Capability packet (spec: bounded-llm-action-settlement-rail). Derived from the
// merchant's real rails/fulfillment so an agent client stays inside reality — it
// can see what SLL-R can actually do for this merchant, and what it cannot.
export function merchantCapabilityPacket(merchant: MerchantProfile) {
  const rails = merchant.paymentRails;
  return {
    capabilities: {
      catalog_search: true,
      live_quote: true,
      create_order: true,
      stripe_checkout: rails.includes("stripe"),
      line_pay: rails.includes("line_pay"),
      counter_pay: rails.includes("counter"),
      solana_pay: rails.includes("solana_pay"),
      base_usdc: rails.includes("base_usdc"),
      pickup: merchant.fulfillment.includes("pickup"),
      shipping: merchant.fulfillment.includes("shipping"),
      fulfillment_status: "merchant_terminal" as const,
      refunds: false,
    },
    // Things the rail explicitly does NOT guarantee — the agent must not claim them.
    unsupported: [
      "live delivery ETA",
      "inventory guarantee",
      "reservation booking",
      ...(rails.includes("stripe") ? [] : ["card checkout"]),
    ],
  };
}

export function getMerchant(merchantId: string) {
  const merchant = requireMerchant(merchantId);
  return {
    product: "SLL-R merchant profile",
    merchant,
    ...merchantCapabilityPacket(merchant),
    links: {
      menu: `/merchants/${merchant.id}/menu`,
      quote: `/merchants/${merchant.id}/quote`,
      orders: `/merchants/${merchant.id}/orders`,
      payment: `/merchants/${merchant.id}/payment`,
      receipt: `/merchants/${merchant.id}/receipt`,
    },
  };
}

export function getMerchantMenu(merchantId: string) {
  const merchant = requireMerchant(merchantId);
  return {
    product: "SLL-R merchant menu",
    merchant: merchantSummary(merchant),
    catalog: merchant.catalog,
    menuSections: merchant.menuSections || [],
  };
}

// Consent gate is OPT-IN so existing callers (REST, MCP, recurring, etc.) keep
// working; flip SLLR_REQUIRE_CONSENT=true to enforce quote→consent→order.
function consentRequired(): boolean {
  return process.env.SLLR_REQUIRE_CONSENT === "true";
}

export async function quoteMerchantOrder(merchantId: string, payload: Record<string, unknown>) {
  requireMerchant(merchantId);
  const quote = quoteOrder(bodyWithMerchant(merchantId, payload) as QuoteRequest);
  // Persist feasible quotes so consent + the order can bind to a quoteId.
  const buyerId = typeof payload.buyerId === "string" ? payload.buyerId : null;
  const intent = typeof payload.userIntent === "string" ? payload.userIntent : "";
  const stored = await persistQuote(merchantId, quote, buyerId, intent);
  return {
    product: "SLL-R merchant quote",
    quote,
    ...(stored
      ? { quoteId: stored.id, amountUsd: stored.amountUsd, expiresAt: stored.expiresAt, confirmationText: expectedConfirmation(stored) }
      : {}),
  };
}

// Grant consent against a stored quote. buyerId comes from the resolved session
// (never client input).
export async function grantMerchantConsent(payload: Record<string, unknown>) {
  const quoteId = String(payload.quoteId || "");
  const buyerId = typeof payload.buyerId === "string" ? payload.buyerId : null;
  const confirmationText = typeof payload.confirmationText === "string" ? payload.confirmationText : undefined;
  const consent = await grantConsent({ quoteId, buyerId, confirmationText });
  return { product: "SLL-R consent receipt", consent, next: "create the order with this quoteId + consentId." };
}

export async function createMerchantOrder(merchantId: string, payload: Record<string, unknown>) {
  requireMerchant(merchantId);
  // Opt-in policy gate: no quote-bound consent → no order.
  if (consentRequired()) {
    const buyerId = typeof payload.buyerId === "string" ? payload.buyerId : null;
    const quoteId = String(payload.quoteId || "");
    const consentId = String(payload.consentId || "");
    const { consent } = await validateConsentForOrder(quoteId, consentId, buyerId);
    // Order amount must equal the consented quote amount (catch price drift).
    const fresh = quoteOrder(bodyWithMerchant(merchantId, payload) as QuoteRequest);
    if (!fresh.feasible || !fresh.item || centsFromUsd(fresh.item.subtotalUsd) !== centsFromUsd(consent.amountUsd)) {
      throw Object.assign(new Error(`Price changed since consent ($${consent.amountUsd}) — request a fresh quote + consent.`), { status: 409, requiredNextStep: "quote_order" });
    }
  }
  const result = await createOrder(bodyWithMerchant(merchantId, payload) as OrderRequest);
  return {
    product: "SLL-R merchant order",
    status: result.order.status,
    quote: result.quote,
    order: result.order,
    // "SLL-R asks": a hint the buyer's channel can surface to offer recurring.
    suggestRecurring: recurringSuggestion(result.order),
    next: "Attach payment or fulfillment proof to issue SLL-R receipt memory.",
  };
}

export async function listMerchantOrders(merchantId: string, status?: string | null) {
  requireMerchant(merchantId);
  return {
    product: "SLL-R merchant orders",
    orders: await listOrders({
      merchantId,
      status: status as never || undefined,
    }),
  };
}

export async function attachMerchantPayment(merchantId: string, headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>) {
  const merchant = requireMerchant(merchantId);
  const orderId = String(payload.orderId || "");
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  if (order.merchantId !== merchant.id) {
    throw Object.assign(new Error(`Merchant ${merchant.id} cannot attach payment proof for ${order.merchantId}.`), { status: 409 });
  }
  const provider = paymentRailFor(merchant, payload.provider);
  const paymentId = String(payload.paymentId || "");
  if (!paymentId) throw Object.assign(new Error("Missing paymentId."), { status: 400 });
  requirePaymentVerifier(headers, payload);

  const updated = await attachPaymentProof({
    orderId: order.id,
    merchantId: merchant.id,
    provider,
    amountUsd: String(payload.amountUsd || order.item.subtotalUsd),
    paymentId,
  });
  return {
    product: "SLL-R merchant payment proof",
    status: updated.status,
    proofLevel: updated.proofLevel,
    order: updated,
  };
}

export async function issueMerchantReceipt(merchantId: string, headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>) {
  requireMerchant(merchantId);
  const orderId = String(payload.orderId || "");
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  requirePaymentVerifier(headers, payload);
  const order = await fulfillOrder(orderId, {
    merchantId,
    actor: typeof payload.actor === "string" ? payload.actor : "merchant",
    note: typeof payload.note === "string" ? payload.note : "Receipt issued through merchant API.",
  });
  return {
    product: "SLL-R merchant receipt",
    status: order.status,
    proofLevel: order.proofLevel,
    order,
  };
}
