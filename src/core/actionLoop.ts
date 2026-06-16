import { randomUUID } from "node:crypto";
import { sllrStore } from "./store.js";

// Action-loop logging (spec: loop-engineering-action-settlement, Phase 1). One
// record per attempted commercial flow, threading quote→consent→order→payment→
// receipt and recording policy BLOCKS as first-class events. This is an additive
// audit/observability layer: every hook is best-effort and MUST NOT break the
// real action — call via recordLoopSafe so a logging failure is swallowed.
//
// Correlation: the quoteId is the spine (it already threads quote→consent→order).
// Orders created without a quote get their own loop, and an order→loop link lets
// later payment events attach.

export type LoopEventType =
  | "intent" | "quote" | "consent" | "policy_block" | "order"
  | "payment_option" | "payment" | "merchant_event" | "claim" | "receipt" | "eval" | "patch";
export type LoopActor = "user" | "client_agent" | "sllr" | "merchant" | "payment_provider" | "evaluator";

export type ActionLoopEvent = {
  id: string;
  eventType: LoopEventType;
  stateAfter?: string;
  claimLevel?: string;
  receiptRef?: string;
  blockReason?: string;
  actor: LoopActor;
  createdAt: string;
};

export type ActionLoop = {
  id: string;
  buyerId: string | null;
  merchantId: string;
  intent: string;
  currentState: string;
  quoteId: string | null;
  consentId: string | null;
  orderId: string | null;
  paymentReceiptId: string | null;
  receiptId: string | null;
  policyBlocks: string[];
  events: ActionLoopEvent[];
  evalStatus: "pending" | "pass" | "fail" | "blocked";
  createdAt: string;
  updatedAt: string;
};

const LOOP_KEY = (id: string) => `sllr:loop:${id}`;
const ORDER_LINK = (orderId: string) => `sllr:order-loop:${orderId}`;
const LOOP_INDEX = "sllr:loops";

export const loopIdForQuote = (quoteId: string) => `loop_q_${quoteId}`;
export const loopIdForOrder = (orderId: string) => `loop_o_${orderId}`;

export type LoopSeed = { buyerId: string | null; merchantId: string; intent?: string };

function newLoop(id: string, seed: LoopSeed, nowIso: string): ActionLoop {
  return {
    id,
    buyerId: seed.buyerId,
    merchantId: seed.merchantId,
    intent: seed.intent ?? "",
    currentState: "intent_detected",
    quoteId: null,
    consentId: null,
    orderId: null,
    paymentReceiptId: null,
    receiptId: null,
    policyBlocks: [],
    events: [],
    evalStatus: "pending",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// Append an event to a loop (creating it on first touch) and fold its facts into
// the summary. Read-modify-write; for best-effort audit logging the rare
// concurrent-append race is acceptable.
export async function recordLoopEvent(
  loopId: string,
  seed: LoopSeed,
  event: Omit<ActionLoopEvent, "id" | "createdAt"> & { ids?: Partial<Pick<ActionLoop, "quoteId" | "consentId" | "orderId" | "paymentReceiptId" | "receiptId">> },
  nowIso: string = new Date().toISOString(),
): Promise<ActionLoop> {
  const store = sllrStore();
  const loop = (await store.getJson<ActionLoop>(LOOP_KEY(loopId))) ?? newLoop(loopId, seed, nowIso);
  const ev: ActionLoopEvent = {
    id: `lev_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    eventType: event.eventType,
    actor: event.actor,
    createdAt: nowIso,
    ...(event.stateAfter ? { stateAfter: event.stateAfter } : {}),
    ...(event.claimLevel ? { claimLevel: event.claimLevel } : {}),
    ...(event.receiptRef ? { receiptRef: event.receiptRef } : {}),
    ...(event.blockReason ? { blockReason: event.blockReason } : {}),
  };
  loop.events.push(ev);
  if (event.stateAfter) loop.currentState = event.stateAfter;
  if (event.eventType === "policy_block" && event.blockReason) {
    loop.policyBlocks.push(event.blockReason);
    loop.evalStatus = "blocked";
  }
  const ids = event.ids ?? {};
  if (ids.quoteId !== undefined) loop.quoteId = ids.quoteId;
  if (ids.consentId !== undefined) loop.consentId = ids.consentId;
  if (ids.orderId !== undefined) loop.orderId = ids.orderId;
  if (ids.paymentReceiptId !== undefined) loop.paymentReceiptId = ids.paymentReceiptId;
  if (ids.receiptId !== undefined) loop.receiptId = ids.receiptId;
  loop.updatedAt = nowIso;
  await store.setJson(LOOP_KEY(loopId), loop);
  await store.addToIndex(LOOP_INDEX, loopId);
  if (ids.orderId) await store.setJson(ORDER_LINK(ids.orderId), loopId); // link for later payment events
  return loop;
}

// Best-effort wrapper: logging must never break the real action.
export async function recordLoopSafe(
  loopId: string,
  seed: LoopSeed,
  event: Parameters<typeof recordLoopEvent>[2],
): Promise<void> {
  try {
    await recordLoopEvent(loopId, seed, event);
  } catch (error) {
    console.error("[action-loop] record failed (non-fatal)", error);
  }
}

// Resolve the loop id for an order (set when the order event was recorded), so a
// later payment/receipt event attaches to the same loop. Falls back to a
// per-order loop id.
export async function loopIdForOrderResolved(orderId: string): Promise<string> {
  try {
    const linked = await sllrStore().getJson<string>(ORDER_LINK(orderId));
    if (linked) return linked;
  } catch {
    // ignore; fall back
  }
  return loopIdForOrder(orderId);
}

export async function getLoop(id: string): Promise<ActionLoop | null> {
  return sllrStore().getJson<ActionLoop>(LOOP_KEY(id));
}
