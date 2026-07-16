import { randomUUID } from "node:crypto";
import { sllrStore } from "./store.js";
import { getOrder } from "./orders.js";
import { recordLoopSafe, loopIdForOrderResolved } from "./actionLoop.js";
import type { SellerOrder } from "../types.js";

// Verified Review / Outcome Layer (spec: local-commerce-os-for-agents §5). Not
// Yelp text-first — it is verified decision → action → outcome memory: a review
// only exists after merchant fulfillment or pickup claim produced final receipt,
// and it records the agent's decision + promised-vs-actual ETA + the buyer's
// feedback. It feeds taste memory, merchant ETA reliability, and future ranking.
//
// Invariant: no verified review without a proof. agentUsable is always true —
// these are written for the next agent to consume, not for human browsing.

export type ReviewVerifiedBy = "stripe_payment" | "merchant_ready" | "pickup_claim" | "user_feedback";

export type AgentDecision = {
  userIntent?: string;
  whyRecommended?: string;
  alternativesRejected?: string[];
};

export type ReviewFeedback = {
  tooSpicy?: boolean;
  tooSweet?: boolean;
  tooSalty?: boolean;
  wouldRepeat?: boolean;
  rating?: 1 | 2 | 3 | 4 | 5;
  note?: string;
};

export type VerifiedReview = {
  reviewId: string;
  orderId: string;
  merchantId: string;
  buyerId: string | null;
  verifiedBy: ReviewVerifiedBy[];
  items: string[];
  agentDecision: AgentDecision;
  etaPromisedMinutes: number | null;
  etaActualMinutes: number | null;
  onTime: boolean | null;
  feedback: ReviewFeedback;
  agentUsable: true;
  createdAt: string;
};

const REVIEW_KEY = (id: string) => `sllr:review:${id}`;
const MERCHANT_REVIEWS = (merchantId: string) => `sllr:merchant-reviews:${merchantId}`;
const BUYER_REVIEWS = (buyerId: string) => `sllr:buyer-reviews:${buyerId}`;
const MERCHANT_ETA = (merchantId: string) => `sllr:merchant-eta:${merchantId}`;

// The proofs an order actually carries (drives verifiedBy + eligibility).
export function reviewProofs(order: SellerOrder, hasFeedback: boolean): ReviewVerifiedBy[] {
  const proofs: ReviewVerifiedBy[] = [];
  if (order.payment.status === "verified") proofs.push("stripe_payment");
  if (order.promise.readyAt || order.status === "ready" || order.status === "fulfilled") proofs.push("merchant_ready");
  if (order.promise.claimedAt || order.status === "claimed" || order.status === "fulfilled") proofs.push("pickup_claim");
  if (hasFeedback) proofs.push("user_feedback");
  return proofs;
}

// A payment proves funds moved, not that the buyer received the product.
export function eligibleForReview(order: SellerOrder): boolean {
  return order.lifecycle.receipt === "issued" && order.receipt !== null;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
}

export type CreateReviewInput = { feedback?: ReviewFeedback; agentDecision?: AgentDecision };

export async function createVerifiedReview(orderId: string, input: CreateReviewInput, buyerId: string | null, nowIso: string = new Date().toISOString()): Promise<VerifiedReview> {
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  if (order.buyerId && buyerId && order.buyerId !== buyerId) {
    throw Object.assign(new Error("This order does not belong to you."), { status: 403 });
  }
  // Invariant: no verified review without a proof.
  if (!eligibleForReview(order)) {
    throw Object.assign(new Error("Order has no completed fulfillment receipt yet — not eligible for a verified review."), { status: 409, requiredNextStep: "fulfill_or_claim" });
  }
  const feedback = input.feedback ?? {};
  const hasFeedback = Object.keys(feedback).length > 0;

  const etaPromisedMinutes = order.promise.estimatedWaitMinutes
    ?? (order.promise.promisedReadyAt ? minutesBetween(order.createdAt, order.promise.promisedReadyAt) : null);
  const readyOrClaimed = order.promise.claimedAt ?? order.promise.readyAt;
  const etaActualMinutes = readyOrClaimed ? minutesBetween(order.createdAt, readyOrClaimed) : null;
  const onTime = etaPromisedMinutes !== null && etaActualMinutes !== null ? etaActualMinutes <= etaPromisedMinutes : null;

  const review: VerifiedReview = {
    reviewId: `rev_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    orderId: order.id,
    merchantId: order.merchantId,
    buyerId: order.buyerId,
    verifiedBy: reviewProofs(order, hasFeedback),
    items: [`${order.item.name}${order.item.quantity > 1 ? ` x${order.item.quantity}` : ""}`],
    agentDecision: input.agentDecision ?? {},
    etaPromisedMinutes,
    etaActualMinutes,
    onTime,
    feedback,
    agentUsable: true,
    createdAt: nowIso,
  };
  await sllrStore().setJson(REVIEW_KEY(review.reviewId), review);
  await sllrStore().addToIndex(MERCHANT_REVIEWS(order.merchantId), review.reviewId);
  if (order.buyerId) await sllrStore().addToIndex(BUYER_REVIEWS(order.buyerId), review.reviewId);

  // Merchant ETA reliability delta — emit signals first, don't build public scores.
  if (onTime !== null) {
    const eta = (await sllrStore().getJson<{ onTime: number; total: number }>(MERCHANT_ETA(order.merchantId))) ?? { onTime: 0, total: 0 };
    eta.total += 1;
    if (onTime) eta.onTime += 1;
    await sllrStore().setJson(MERCHANT_ETA(order.merchantId), eta);
  }

  // Close the action loop: reviewed.
  await recordLoopSafe(await loopIdForOrderResolved(order.id), { buyerId: order.buyerId, merchantId: order.merchantId }, {
    eventType: "receipt", actor: "user", stateAfter: "reviewed", claimLevel: "verified_review_eligible",
    receiptRef: review.reviewId, ids: { orderId: order.id },
  });
  return review;
}

export async function getReview(id: string): Promise<VerifiedReview | null> {
  return sllrStore().getJson<VerifiedReview>(REVIEW_KEY(id));
}

export async function listMerchantReviews(merchantId: string): Promise<VerifiedReview[]> {
  const ids = await sllrStore().indexMembers(MERCHANT_REVIEWS(merchantId));
  const reviews = await Promise.all(ids.map((id) => getReview(id)));
  return reviews.filter((r): r is VerifiedReview => Boolean(r));
}

export async function getMerchantReliability(merchantId: string): Promise<{ onTimeRate: number | null; sample: number }> {
  const eta = await sllrStore().getJson<{ onTime: number; total: number }>(MERCHANT_ETA(merchantId));
  if (!eta || eta.total === 0) return { onTimeRate: null, sample: 0 };
  return { onTimeRate: Number((eta.onTime / eta.total).toFixed(2)), sample: eta.total };
}
