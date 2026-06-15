import { sllrStore } from "./store.js";

// Per-buyer billing: the buyer's Stripe Customer + saved card (PaymentMethod),
// keyed by buyerId. We store ONLY Stripe ids — never raw card data (PCI). This is
// what makes "say yes -> charge, no link" possible: the card is on file at Stripe.

export type BuyerBilling = {
  stripeCustomerId?: string;
  paymentMethodId?: string;
};

function key(buyerId: string): string {
  return `sllr:buyer-billing:${buyerId}`;
}

export async function getBuyerBilling(buyerId: string): Promise<BuyerBilling> {
  return (await sllrStore().getJson<BuyerBilling>(key(buyerId))) ?? {};
}

// Merge-update (so saving a payment method doesn't drop the customer id, etc.).
export async function setBuyerBilling(buyerId: string, patch: BuyerBilling): Promise<BuyerBilling> {
  const current = await getBuyerBilling(buyerId);
  const next = { ...current, ...patch };
  await sllrStore().setJson(key(buyerId), next);
  return next;
}

export function hasSavedCard(billing: BuyerBilling): boolean {
  return Boolean(billing.stripeCustomerId && billing.paymentMethodId);
}
