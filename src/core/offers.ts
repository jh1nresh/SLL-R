import { merchantForId } from "../merchants/profiles.js";
import type { MerchantOffer } from "../types.js";
import { minorUnitsFromDecimal } from "./money.js";
import { productionClassFor } from "./capacity.js";
import { quoteMerchantOrder } from "./merchantApi.js";

const OFFER_PREFIX = "catalog:";

function requireMerchant(merchantId: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${merchantId}`), { status: 404 });
  return merchant;
}

function offerForItem(merchantId: string, itemId: string): MerchantOffer {
  const merchant = requireMerchant(merchantId);
  const item = merchant.catalog.find((candidate) => candidate.id === itemId);
  if (!item) throw Object.assign(new Error(`Unknown offer: ${OFFER_PREFIX}${itemId}`), { status: 404 });
  const currency = merchant.currency || "USD";
  const amount = { amountMinor: minorUnitsFromDecimal(item.amountUsd, currency), currency };
  return {
    id: `${OFFER_PREFIX}${item.id}`,
    merchantId,
    level: 1,
    kind: "instant_offer",
    title: item.name,
    lineItems: [{
      itemId: item.id,
      name: item.name,
      quantity: 1,
      unitAmount: amount,
      subtotal: amount,
    }],
    amount,
    fulfillment: item.fulfillment,
    productionClass: productionClassFor(item),
    status: "active",
    startsAt: null,
    expiresAt: null,
    redemptionWindow: {
      mode: "quote_bound",
      startsAt: null,
      endsAt: null,
    },
    perBuyerLimit: null,
    inventoryLimit: typeof item.inventory === "number" ? item.inventory : null,
    terms: [
      "Price, inventory, and pickup capacity are revalidated when SLL-R creates the quote.",
      "No cross-order per-buyer limit is configured for this catalog-derived offer.",
      "The buyer must approve the exact quote before order creation and payment.",
      "Payment proof does not prove redemption; final receipt memory requires merchant fulfillment or customer claim.",
    ],
    source: {
      type: "merchant_catalog",
      reference: item.productUrl || `merchant:${merchant.id}:catalog:${item.id}`,
      lastVerifiedAt: null,
      verificationStatus: "configured",
    },
  };
}

export function getMerchantOffer(merchantId: string, offerId: string) {
  if (!offerId.startsWith(OFFER_PREFIX)) {
    throw Object.assign(new Error(`Unknown offer: ${offerId}`), { status: 404 });
  }
  return offerForItem(merchantId, offerId.slice(OFFER_PREFIX.length));
}

export function listMerchantOffers(merchantId: string) {
  const merchant = requireMerchant(merchantId);
  return {
    product: "SLL-R Level 1 offers",
    merchant: { id: merchant.id, name: merchant.name },
    offers: merchant.catalog.map((item) => offerForItem(merchant.id, item.id)),
    next: "Quote an offer, show the exact confirmation text, then request consent before creating the order.",
  };
}

export async function quoteMerchantOffer(
  merchantId: string,
  offerId: string,
  payload: Record<string, unknown>,
) {
  const offer = getMerchantOffer(merchantId, offerId);
  const suppliedItemId = typeof payload.itemId === "string" ? payload.itemId : null;
  if (suppliedItemId && suppliedItemId !== offer.lineItems[0].itemId) {
    throw Object.assign(new Error("The requested item does not match this fixed offer."), { status: 409 });
  }
  const quoted = await quoteMerchantOrder(merchantId, {
    ...payload,
    offerId: offer.id,
    itemId: offer.lineItems[0].itemId,
    userIntent: typeof payload.userIntent === "string" && payload.userIntent.trim()
      ? payload.userIntent
      : `Buy ${offer.title}`,
  });
  return { ...quoted, product: "SLL-R Level 1 offer quote", offer };
}
