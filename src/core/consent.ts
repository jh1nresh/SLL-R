import { randomUUID } from "node:crypto";
import { sllrStore } from "./store.js";
import { getQuote, isQuoteExpired, type StoredQuote } from "./quotes.js";
import { centsFromUsd, formatUsd } from "./money.js";

// Quote-bound consent (spec: bounded-action rail). Consent binds to a SPECIFIC
// quote — not generic intent — so a casual "yes" can never authorize a charge.
// The order path validates the consent before SLL-R mutates state.

export type ConsentReceipt = {
  id: string;
  quoteId: string;
  buyerId: string | null;
  merchantId: string;
  itemSummary: string;
  amountUsd: string;
  confirmationText: string;
  createdAt: string;
  expiresAt: string; // dies with the quote
};

const CONSENT_KEY = (id: string) => `sllr:consent:${id}`;

// The exact phrase a channel can require for explicit confirmation.
export function expectedConfirmation(quote: StoredQuote): string {
  const unitPrice = formatUsd(centsFromUsd(quote.amountUsd) / quote.quantity);
  const pickup = quote.pickupAt ? `, pickup ${quote.pickupAt}` : "";
  const offer = quote.offerId ? `, offer ${quote.offerId}` : "";
  return `CONFIRM ${quote.quantity} x ${quote.itemName} at ${quote.merchantName}, $${unitPrice} each, $${quote.amountUsd} total${offer}${pickup}`;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export type GrantConsentInput = {
  quoteId: string;
  buyerId: string | null;
  confirmationText?: string;
};

// Grant consent against a live quote. If confirmationText is supplied it must
// match the expected phrase (defense against a stray "yes"); the binding itself
// is the quoteId + amount copied from the quote.
export async function grantConsent(input: GrantConsentInput, nowIso: string = new Date().toISOString()): Promise<ConsentReceipt> {
  const quote = await getQuote(input.quoteId);
  if (!quote) throw Object.assign(new Error(`Unknown quote: ${input.quoteId}. Quote a price first.`), { status: 404 });
  if (isQuoteExpired(quote, nowIso)) {
    throw Object.assign(new Error("Quote has expired — request a fresh quote before consenting."), { status: 409 });
  }
  if (quote.buyerId && quote.buyerId !== input.buyerId) {
    throw Object.assign(new Error("This quote does not belong to you."), { status: 403 });
  }
  if (input.confirmationText !== undefined && normalize(input.confirmationText) !== normalize(expectedConfirmation(quote))) {
    throw Object.assign(new Error(`Confirmation text must be exactly: ${expectedConfirmation(quote)}`), { status: 422 });
  }
  const consent: ConsentReceipt = {
    id: `cons_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    quoteId: quote.id,
    buyerId: input.buyerId,
    merchantId: quote.merchantId,
    itemSummary: `${quote.itemName}${quote.quantity > 1 ? ` x${quote.quantity}` : ""}`,
    amountUsd: quote.amountUsd,
    confirmationText: input.confirmationText ?? expectedConfirmation(quote),
    createdAt: nowIso,
    expiresAt: quote.expiresAt,
  };
  await sllrStore().setJson(CONSENT_KEY(consent.id), consent);
  return consent;
}

export async function getConsent(id: string): Promise<ConsentReceipt | null> {
  return sllrStore().getJson<ConsentReceipt>(CONSENT_KEY(id));
}

// Validate a consent for an order: consent exists, binds the given quote, the
// quote is live, the buyer matches. Returns the consent + quote, or throws with a
// reason + the required next step (mirrors the spec's PolicyDecision).
export async function validateConsentForOrder(
  quoteId: string,
  consentId: string,
  buyerId: string | null,
  nowIso: string = new Date().toISOString(),
): Promise<{ consent: ConsentReceipt; quote: StoredQuote }> {
  const block = (reason: string, requiredNextStep: string) =>
    Object.assign(new Error(reason), { status: 409, requiredNextStep });

  if (!quoteId) throw block("Missing quoteId.", "quote_order");
  if (!consentId) throw block("Missing consentId.", "request_consent");
  const consent = await getConsent(consentId);
  if (!consent) throw block(`Unknown consent: ${consentId}.`, "request_consent");
  if (consent.quoteId !== quoteId) throw block("Consent does not match this quote.", "request_consent");
  const quote = await getQuote(quoteId);
  if (!quote) throw block(`Unknown quote: ${quoteId}.`, "quote_order");
  if (isQuoteExpired(quote, nowIso)) throw block("Quote/consent expired.", "quote_order");
  if (consent.buyerId && consent.buyerId !== buyerId) {
    throw Object.assign(new Error("Consent does not belong to you."), { status: 403, requiredNextStep: "request_consent" });
  }
  return { consent, quote };
}
