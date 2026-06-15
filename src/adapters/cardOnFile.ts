import { stripeChargeOffSession, stripeCreateCustomer, stripeCreateSetupIntent } from "./stripe.js";
import { getBuyerBilling, hasSavedCard, setBuyerBilling } from "../core/buyerBilling.js";
import { attachPaymentProof, getOrder } from "../core/orders.js";
import type { SellerOrder } from "../types.js";

// Card-on-file orchestration. createCardSetup gets the buyer a Stripe Customer +
// a SetupIntent (the app saves a card with the returned client secret). Once a
// card is on file, payWithSavedCard charges it off-session — the "say yes → paid,
// no link" path — and falls back (no_card / requires_action / declined) so the
// caller can offer a hosted Checkout link instead.

export async function createCardSetup(buyerId: string): Promise<{ clientSecret: string; customerId: string }> {
  const billing = await getBuyerBilling(buyerId);
  let customerId = billing.stripeCustomerId;
  if (!customerId) {
    customerId = await stripeCreateCustomer(buyerId);
    await setBuyerBilling(buyerId, { stripeCustomerId: customerId });
  }
  const si = await stripeCreateSetupIntent(customerId, buyerId);
  return { clientSecret: si.clientSecret, customerId };
}

export type PayResult = {
  status: "paid" | "already_paid" | "no_card" | "requires_action" | "declined";
  order?: SellerOrder;
};

// opts.idempotencyKey overrides the default per-order Stripe idempotency key.
// Recurring passes a run-anchored key so retries of the same run never double
// charge even though they would otherwise mint distinct orders.
export async function payWithSavedCard(orderId: string, buyerId: string, opts: { idempotencyKey?: string } = {}): Promise<PayResult> {
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  // Ownership: a buyer can only charge their OWN order.
  if (order.buyerId && order.buyerId !== buyerId) {
    throw Object.assign(new Error("This order does not belong to you."), { status: 403 });
  }
  // Idempotent at the order level: already settled → don't charge again.
  if (order.status === "receipt_issued" || order.payment.status === "verified") {
    return { status: "already_paid", order };
  }
  const billing = await getBuyerBilling(buyerId);
  if (!hasSavedCard(billing)) return { status: "no_card" };

  const result = await stripeChargeOffSession({
    customerId: billing.stripeCustomerId!,
    paymentMethodId: billing.paymentMethodId!,
    amountUsd: order.item.subtotalUsd,
    orderId: order.id,
    merchantId: order.merchantId,
    merchantName: order.merchantName,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });

  if (result.status === "succeeded") {
    const paid = await attachPaymentProof({
      orderId: order.id,
      merchantId: order.merchantId,
      provider: "stripe",
      amountUsd: order.item.subtotalUsd,
      paymentId: `${result.paymentIntentId ?? "pi"}:off_session`,
    });
    return { status: "paid", order: paid };
  }
  // requires_action (SCA) | declined → caller offers a hosted Checkout link.
  return { status: result.status };
}
