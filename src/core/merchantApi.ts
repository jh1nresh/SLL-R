import { attachPaymentProofMutation, createOrder, fulfillOrderMutation, getOrder, listOrders } from "./orders.js";
import { quoteOrder } from "./quote.js";
import { allMerchantProfiles, merchantForId } from "../merchants/profiles.js";
import { recurringSuggestion } from "./recurring.js";
import { persistQuote, getQuote } from "./quotes.js";
import { estimatedPickupWaitMinutes } from "./orders.js";
import { grantConsent, validateConsentForOrder, expectedConfirmation } from "./consent.js";
import { centsFromUsd } from "./money.js";
import { recordLoopSafe, loopIdForQuote, loopIdForOrder } from "./actionLoop.js";
import { actionKeyFrom, mutationResultForOrder, withIdempotentMutation } from "./mutations.js";
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

// The queue-aware wait for the quoted item — same formula the order promise
// uses, so the quote can never undersell the real wait (pilot trust bug).
async function queueAwareEta(merchant: MerchantProfile, itemId: string | undefined): Promise<number | null> {
  const item = itemId ? merchant.catalog.find((i) => i.id === itemId) : undefined;
  return item ? estimatedPickupWaitMinutes(merchant.id, item) : null;
}

export async function quoteMerchantOrder(merchantId: string, payload: Record<string, unknown>) {
  const merchant = requireMerchant(merchantId);
  const quote = quoteOrder(bodyWithMerchant(merchantId, payload) as QuoteRequest);
  // Honest ETA: replace the prep-only estimate with the queue-aware wait so the
  // quote and the created order's promise always come from one formula.
  const etaMinutes = quote.feasible && quote.item ? await queueAwareEta(merchant, quote.item.id) : null;
  if (etaMinutes !== null) quote.estimate.readyInMinutes = etaMinutes;
  // Persist feasible quotes so consent + the order can bind to a quoteId.
  const buyerId = typeof payload.buyerId === "string" ? payload.buyerId : null;
  const intent = typeof payload.userIntent === "string" ? payload.userIntent : "";
  const stored = await persistQuote(merchantId, quote, buyerId, intent, etaMinutes);
  if (stored) {
    await recordLoopSafe(loopIdForQuote(stored.id), { buyerId, merchantId, intent }, {
      eventType: "quote", actor: "sllr", stateAfter: "quote_created", claimLevel: "quote_only",
      receiptRef: stored.id, ids: { quoteId: stored.id },
    });
  }
  return {
    product: "SLL-R merchant quote",
    quote,
    ...(stored
      ? {
        quoteId: stored.id,
        amountUsd: stored.amountUsd,
        etaMinutes: stored.etaMinutes,
        expiresAt: stored.expiresAt,
        confirmationText: expectedConfirmation(stored),
        // Echo the order-relevant request params so a client can turn a pure
        // "confirm" into create_order deterministically (no LLM re-guessing).
        request: {
          userIntent: intent,
          ...(typeof payload.deadlineMinutes === "number" ? { deadlineMinutes: payload.deadlineMinutes } : {}),
          ...(typeof payload.maxSpendUsd === "string" ? { maxSpendUsd: payload.maxSpendUsd } : {}),
          ...(typeof payload.deliverByDays === "number" ? { deliverByDays: payload.deliverByDays } : {}),
          ...(typeof payload.quantity === "number" ? { quantity: payload.quantity } : {}),
        },
      }
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
  await recordLoopSafe(loopIdForQuote(quoteId), { buyerId, merchantId: consent.merchantId }, {
    eventType: "consent", actor: "user", stateAfter: "consent_granted", claimLevel: "consent_requested",
    receiptRef: consent.id, ids: { consentId: consent.id },
  });
  return { product: "SLL-R consent receipt", consent, next: "create the order with this quoteId + consentId." };
}

type CreateMerchantOrderResult = {
  product: string;
  status: string;
  quote: unknown;
  order: Awaited<ReturnType<typeof createOrder>>["order"];
  suggestRecurring: ReturnType<typeof recurringSuggestion>;
  next: string;
};

async function createMerchantOrderOnce(merchantId: string, payload: Record<string, unknown>): Promise<CreateMerchantOrderResult> {
  requireMerchant(merchantId);
  const seedBuyerId = typeof payload.buyerId === "string" ? payload.buyerId : null;
  const seedIntent = typeof payload.userIntent === "string" ? payload.userIntent : "";
  const payloadQuoteId = String(payload.quoteId || "");
  const seed = { buyerId: seedBuyerId, merchantId, intent: seedIntent };
  // Opt-in policy gate: no quote-bound consent → no order. Blocks are first-class
  // loop events (the spec's policy_block_receipt).
  if (consentRequired()) {
    const consentId = String(payload.consentId || "");
    let consent;
    try {
      ({ consent } = await validateConsentForOrder(payloadQuoteId, consentId, seedBuyerId));
    } catch (error) {
      const e = error as Error & { requiredNextStep?: string };
      await recordLoopSafe(payloadQuoteId ? loopIdForQuote(payloadQuoteId) : `loop_blk_${Date.now()}`, seed, {
        eventType: "policy_block", actor: "client_agent",
        blockReason: `${e.message} (next: ${e.requiredNextStep ?? "request_consent"})`,
        ids: payloadQuoteId ? { quoteId: payloadQuoteId } : {},
      });
      throw error;
    }
    // Order amount must equal the consented quote amount (catch price drift).
    const fresh = quoteOrder(bodyWithMerchant(merchantId, payload) as QuoteRequest);
    if (!fresh.feasible || !fresh.item || centsFromUsd(fresh.item.subtotalUsd) !== centsFromUsd(consent.amountUsd)) {
      await recordLoopSafe(loopIdForQuote(payloadQuoteId), seed, {
        eventType: "policy_block", actor: "client_agent",
        blockReason: `price_drift: order != consented $${consent.amountUsd} (next: quote_order)`,
        ids: { quoteId: payloadQuoteId },
      });
      throw Object.assign(new Error(`Price changed since consent ($${consent.amountUsd}) — request a fresh quote + consent.`), { status: 409, requiredNextStep: "quote_order" });
    }
  }
  // ETA reconfirm gate (opt-in SLLR_ETA_RECONFIRM): if the queue-aware wait now
  // materially exceeds what the buyer confirmed against (their deadline, or the
  // quoted ETA + one capacity window), do NOT silently create a delayed order —
  // ask for reconfirmation (acceptDelay: true).
  if (process.env.SLLR_ETA_RECONFIRM === "true" && payload.acceptDelay !== true) {
    const merchant = requireMerchant(merchantId);
    const probe = quoteOrder(bodyWithMerchant(merchantId, payload) as QuoteRequest);
    const waitNow = probe.feasible && probe.item ? await queueAwareEta(merchant, probe.item.id) : null;
    if (waitNow !== null) {
      const deadline = typeof payload.deadlineMinutes === "number" ? payload.deadlineMinutes : null;
      const quotedEta = payloadQuoteId ? (await getQuote(payloadQuoteId))?.etaMinutes ?? null : null;
      const brokenDeadline = deadline !== null && waitNow > deadline;
      const brokenQuote = quotedEta !== null && waitNow > quotedEta + 15;
      if (brokenDeadline || brokenQuote) {
        await recordLoopSafe(payloadQuoteId ? loopIdForQuote(payloadQuoteId) : `loop_blk_${Date.now()}`, seed, {
          eventType: "policy_block", actor: "sllr",
          blockReason: `eta_reconfirm: wait now ~${waitNow} min exceeds ${brokenDeadline ? `deadline ${deadline} min` : `quoted ${quotedEta} min`} (next: reconfirm_with_acceptDelay)`,
          ids: payloadQuoteId ? { quoteId: payloadQuoteId } : {},
        });
        throw Object.assign(
          new Error(`Wait is now ~${waitNow} min — longer than ${brokenDeadline ? `your ${deadline} min deadline` : `the quoted ~${quotedEta} min`}. Re-confirm with acceptDelay: true to order anyway, or pick a faster item.`),
          { status: 409, requiredNextStep: "reconfirm_with_acceptDelay", estimatedWaitMinutes: waitNow },
        );
      }
    }
  }
  const result = await createOrder(bodyWithMerchant(merchantId, payload) as OrderRequest);
  await recordLoopSafe(payloadQuoteId ? loopIdForQuote(payloadQuoteId) : loopIdForOrder(result.order.id), seed, {
    eventType: "order", actor: "sllr", stateAfter: "order_created", claimLevel: "order_created",
    receiptRef: result.order.id, ids: { orderId: result.order.id, ...(payloadQuoteId ? { quoteId: payloadQuoteId } : {}) },
  });
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

export async function createMerchantOrder(merchantId: string, payload: Record<string, unknown>) {
  requireMerchant(merchantId);
  const buyerId = typeof payload.buyerId === "string" ? payload.buyerId : null;
  const actionKey = actionKeyFrom(payload, "create_order");
  const { result, mutation } = await withIdempotentMutation({
    operation: "create_order",
    tenantId: merchantId,
    requesterId: buyerId,
    targetId: merchantId,
    actionKey,
    request: { ...payload, merchantId },
    run: () => createMerchantOrderOnce(merchantId, payload),
    mutationFromResult: (created, key) => mutationResultForOrder(key, created.order),
  });
  return mutation ? { ...result, mutation } : result;
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

  const actionKey = actionKeyFrom(payload, "attach_payment_proof");
  const { result, mutation } = await attachPaymentProofMutation({
    orderId: order.id,
    merchantId: merchant.id,
    provider,
    amountUsd: String(payload.amountUsd ?? order.item.subtotalUsd),
    paymentId,
  }, {
    requesterId: "merchant-verifier",
    actionKey,
  });
  const updated = result;
  return {
    product: "SLL-R merchant payment proof",
    status: updated.status,
    proofLevel: updated.proofLevel,
    order: updated,
    ...(mutation ? { mutation } : {}),
  };
}

export async function issueMerchantReceipt(merchantId: string, headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>) {
  requireMerchant(merchantId);
  const orderId = String(payload.orderId || "");
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  requirePaymentVerifier(headers, payload);
  const actionKey = actionKeyFrom(payload, "issue_receipt");
  const { result, mutation } = await fulfillOrderMutation(orderId, {
    merchantId,
    actor: typeof payload.actor === "string" ? payload.actor : "merchant",
    note: typeof payload.note === "string" ? payload.note : "Receipt issued through merchant API.",
  }, {
    operation: "issue_receipt",
    requesterId: "merchant-verifier",
    actionKey,
  });
  const order = result;
  return {
    product: "SLL-R merchant receipt",
    status: order.status,
    proofLevel: order.proofLevel,
    order,
    ...(mutation ? { mutation } : {}),
  };
}
