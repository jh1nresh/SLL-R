import { randomUUID } from "node:crypto";
import { merchantForId } from "../merchants/profiles.js";
import { recordLoopSafe, loopIdForOrderResolved } from "./actionLoop.js";
import type { CatalogItem, MerchantActionRequest, MerchantOrderFilter, MerchantProfile, OrderRequest, PaymentWebhook, SellerOrder } from "../types.js";
import { issueSllrReceipt } from "../adapters/sllrReceipts.js";
import { centsFromUsd } from "./money.js";
import { quoteOrder } from "./quote.js";
import { isItemAvailable } from "./availability.js";
import { sllrStore } from "./store.js";
import { buyerOrdersIndex } from "./buyer.js";
import { mutationResultForOrder, withIdempotentMutation } from "./mutations.js";
import {
  CAPACITY_BY_PRODUCTION_CLASS,
  CAPACITY_WINDOW_MINUTES,
  capacityWindowAt,
  consumeCapacityReservation,
  parsePickupAt,
  productionClassFor,
  releaseCapacityReservation,
  reserveCapacity,
} from "./capacity.js";

const ORDER_KEY_PREFIX = "sllr:order:";
const ORDER_INDEX = "sllr:order-ids";
const MERCHANT_ORDER_INDEX_PREFIX = "sllr:order-ids:";

function orderKey(orderId: string) {
  return `${ORDER_KEY_PREFIX}${orderId}`;
}

function merchantOrderIndex(merchantId: string) {
  return `${MERCHANT_ORDER_INDEX_PREFIX}${merchantId}`;
}

async function loadOrdersByIds(ids: string[]): Promise<SellerOrder[]> {
  const loaded = await Promise.all(ids.map(loadOrder));
  return loaded.filter((order): order is SellerOrder => order !== null);
}

function syncLifecycle(order: SellerOrder): SellerOrder {
  const normalized: SellerOrder = {
    ...order,
    offerId: order.offerId || null,
    batchId: order.batchId || null,
    lineItems: order.lineItems?.length ? order.lineItems : [order.item],
    lifecycle: {
      order: order.status === "rejected" ? "rejected" : order.receipt ? "completed" : "open",
      payment: order.payment.status,
      fulfillment: order.terminal.status,
      receipt: order.receipt ? "issued" : "none",
    },
    promise: {
      ...order.promise,
      capacityWindowId: order.promise.capacityWindowId || null,
      capacityWindowStartsAt: order.promise.capacityWindowStartsAt || null,
      capacityWindowEndsAt: order.promise.capacityWindowEndsAt || null,
    },
    capacityReservation: order.capacityReservation || null,
  };
  Object.assign(order, normalized);
  return order;
}

async function saveOrder(order: SellerOrder) {
  syncLifecycle(order);
  const store = sllrStore();
  await store.setJson(orderKey(order.id), order);
  // Per-merchant index keeps the hot path (pickup-queue scan on create) and
  // merchant-scoped listings from loading every order in the system. The global
  // index backs the unfiltered terminal listing.
  await store.addToIndex(merchantOrderIndex(order.merchantId), order.id);
  await store.addToIndex(ORDER_INDEX, order.id);
  // Buyer index backs "my orders" across merchants (Layer-2 identity).
  if (order.buyerId) await store.addToIndex(buyerOrdersIndex(order.buyerId), order.id);
  return order;
}

async function loadOrder(orderId: string) {
  const order = await sllrStore().getJson<SellerOrder>(orderKey(orderId));
  if (!order) return null;
  const membership = await sllrStore().getJson<{ batchId?: string }>(`sllr:fulfillment-batch-membership:${orderId}`);
  return { ...syncLifecycle(order), batchId: membership?.batchId || order.batchId || null };
}

async function ordersForMerchant(merchantId: string): Promise<SellerOrder[]> {
  const ids = await sllrStore().indexMembers(merchantOrderIndex(merchantId));
  return loadOrdersByIds(ids);
}

async function allOrders(): Promise<SellerOrder[]> {
  const ids = await sllrStore().indexMembers(ORDER_INDEX);
  return loadOrdersByIds(ids);
}

export async function listOrdersForBuyer(buyerId: string, limit?: number): Promise<SellerOrder[]> {
  const ids = await sllrStore().indexMembers(buyerOrdersIndex(buyerId));
  const boundedIds = limit === undefined ? ids : ids.slice(-Math.max(1, Math.min(limit, 500)));
  const orders = (await loadOrdersByIds(boundedIds)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return withLiveOrderTrackingBatch(orders);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

async function activePickupOrders(merchantId: string, productionClass: string) {
  const merchantOrders = await ordersForMerchant(merchantId);
  return merchantOrders.filter((order) => (
    order.promise.productionClass === productionClass
    // Scheduled pickups already occupy their target capacity window and must
    // not inflate the queue for an order placed right now.
    && order.promise.scheduledPickup !== true
    && !["rejected", "ready", "claimed", "fulfilled", "receipt_issued"].includes(order.status)
  ));
}

// Queue-aware pickup wait for an item RIGHT NOW — the single ETA formula shared
// by quotes and order promises, so a quote can never show "~7 min" while the
// created order silently computes 52 (the trust bug the pilot audit caught).
// null for non-pickup items.
export async function estimatedPickupWaitMinutes(
  merchantId: string,
  item: CatalogItem,
  quantity = 1,
  now = new Date(),
): Promise<number | null> {
  if (!item.fulfillment.includes("pickup")) return null;
  const productionClass = productionClassFor(item);
  const activeAhead = (await activePickupOrders(merchantId, productionClass)).length;
  const capacity = CAPACITY_BY_PRODUCTION_CLASS[productionClass];
  const prepMinutes = Math.max(item.prepMinutes || 5, 1);
  const queueWait = prepMinutes + Math.floor(activeAhead / capacity) * CAPACITY_WINDOW_MINUTES;
  const desiredReadyAt = addMinutes(now, queueWait);
  for (let offset = 0; offset < 32; offset += 1) {
    const probeAt = addMinutes(desiredReadyAt, offset * CAPACITY_WINDOW_MINUTES);
    const window = await capacityWindowAt(merchantId, productionClass, probeAt);
    if (window.available >= quantity) {
      const windowWait = Math.max(
        0,
        Math.ceil((new Date(window.startsAt).getTime() - now.getTime()) / 60_000),
      );
      return Math.max(queueWait, windowWait);
    }
  }
  return Math.max(queueWait, prepMinutes + 32 * CAPACITY_WINDOW_MINUTES);
}

function queueKey(order: SellerOrder) {
  return `${order.merchantId}:${order.promise.productionClass}`;
}

function trackingSnapshot(order: SellerOrder, queue: SellerOrder[]) {
  const isPickup = order.promise.productionClass !== "shipping";
  const terminal = ["rejected", "ready", "claimed", "fulfilled", "receipt_issued"].includes(order.status);
  if (!isPickup) {
    return {
      ...order,
      tracking: {
        live: true,
        status: order.status,
        receiptState: order.receipt ? "issued" : "not_issued",
        queuePosition: null,
        ordersAhead: null,
        estimatedWaitMinutes: null,
        promisedReadyAt: order.promise.promisedReadyAt,
        updatedAt: order.updatedAt,
      },
    };
  }

  const index = terminal ? -1 : queue.findIndex((candidate) => candidate.id === order.id);
  const promised = order.promise.promisedReadyAt ? new Date(order.promise.promisedReadyAt).getTime() : Number.NaN;
  const remaining = terminal
    ? 0
    : Number.isFinite(promised)
      ? Math.max(0, Math.ceil((promised - Date.now()) / 60_000))
      : order.promise.estimatedWaitMinutes;

  return {
    ...order,
    tracking: {
      live: true,
      status: order.status,
      receiptState: order.receipt ? "issued" : "not_issued",
      queuePosition: index >= 0 ? index + 1 : null,
      ordersAhead: index >= 0 ? index : 0,
      estimatedWaitMinutes: remaining,
      promisedReadyAt: order.promise.promisedReadyAt,
      updatedAt: order.updatedAt,
    },
  };
}

export async function withLiveOrderTrackingBatch(orders: SellerOrder[]) {
  const queues = new Map<string, SellerOrder[]>();
  for (const candidate of await allOrders()) {
    if (
      candidate.promise.productionClass === "shipping"
      || candidate.promise.scheduledPickup === true
      || ["rejected", "ready", "claimed", "fulfilled", "receipt_issued"].includes(candidate.status)
    ) continue;
    const key = queueKey(candidate);
    const queue = queues.get(key) || [];
    queue.push(candidate);
    queues.set(key, queue);
  }
  for (const queue of queues.values()) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return orders.map((order) => trackingSnapshot(order, queues.get(queueKey(order)) || []));
}

async function pickupPromise(merchant: MerchantProfile, item: CatalogItem, input: OrderRequest, now: Date, quantity: number): Promise<SellerOrder["promise"]> {
  if (!item.fulfillment.includes("pickup")) {
    return {
      status: "not_applicable",
      productionClass: "shipping",
      requestedReadyAt: null,
      promisedReadyAt: null,
      estimatedWaitMinutes: null,
      capacityWindowMinutes: null,
      readyAt: null,
      claimedAt: null,
      delayMinutes: null,
      capacityWindowId: null,
      capacityWindowStartsAt: null,
      capacityWindowEndsAt: null,
      scheduledPickup: false,
    };
  }

  const productionClass = productionClassFor(item);
  const capacityWindowMinutes = CAPACITY_WINDOW_MINUTES;
  const estimatedWaitMinutes = (await estimatedPickupWaitMinutes(merchant.id, item, quantity))!;
  const promisedReadyAt = addMinutes(now, estimatedWaitMinutes);
  const requestedReadyAt = input.deadlineMinutes ? addMinutes(now, input.deadlineMinutes) : null;

  return {
    status: requestedReadyAt && promisedReadyAt > requestedReadyAt ? "delayed_offer" : "on_time",
    productionClass,
    requestedReadyAt: requestedReadyAt?.toISOString() || null,
    promisedReadyAt: promisedReadyAt.toISOString(),
    estimatedWaitMinutes,
    capacityWindowMinutes,
    readyAt: null,
    claimedAt: null,
    delayMinutes: null,
    capacityWindowId: null,
    capacityWindowStartsAt: null,
    capacityWindowEndsAt: null,
    scheduledPickup: Boolean(input.pickupAt),
  };
}

export async function createOrder(input: OrderRequest) {
  const quote = quoteOrder(input);
  if (!quote.feasible || !quote.item) {
    throw Object.assign(new Error("Quote is not feasible. Ask the buyer agent to accept an alternative first."), {
      status: 409,
      quote,
    });
  }
  const merchant = merchantForId(input.merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${input.merchantId}`), { status: 404 });

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const catalogItem = merchant.catalog.find((item) => item.id === quote.item?.id);
  if (!catalogItem) throw Object.assign(new Error(`Catalog item not found: ${quote.item.id}`), { status: 409 });
  if (input.offerId && input.offerId !== `catalog:${catalogItem.id}`) {
    throw Object.assign(new Error(`Offer ${input.offerId} does not match item ${catalogItem.id}. Request a fresh offer quote.`), {
      status: 409,
      code: "offer_item_mismatch",
    });
  }
  if (!(await isItemAvailable(merchant.id, catalogItem.id))) {
    throw Object.assign(new Error(`${catalogItem.name} is currently unavailable (86'd) at ${merchant.name}.`), { status: 409 });
  }
  const paymentMode = input.paymentMode || (catalogItem.fulfillment.includes("shipping") ? "checkout" : "counter");
  const orderId = `ord_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const promise = await pickupPromise(merchant, catalogItem, input, nowDate, quote.item.quantity);
  let capacityReservation: SellerOrder["capacityReservation"] = null;
  if (catalogItem.fulfillment.includes("pickup") && promise.promisedReadyAt) {
    const quotedReadyAt = new Date(promise.promisedReadyAt);
    const scheduledPickup = input.pickupAt ? parsePickupAt(input.pickupAt, nowDate) : null;
    capacityReservation = await reserveCapacity({
      merchantId: merchant.id,
      item: catalogItem,
      quantity: quote.item.quantity,
      desiredAt: scheduledPickup || new Date(promise.promisedReadyAt),
      exactWindow: scheduledPickup !== null,
      orderId,
    });
    promise.capacityWindowId = capacityReservation.windowId;
    promise.capacityWindowStartsAt = capacityReservation.startsAt;
    promise.capacityWindowEndsAt = capacityReservation.endsAt;
    const reservedStart = new Date(capacityReservation.startsAt);
    const reservedEnd = new Date(capacityReservation.endsAt);
    promise.promisedReadyAt = scheduledPickup?.toISOString()
      || (quotedReadyAt >= reservedStart && quotedReadyAt < reservedEnd
        ? quotedReadyAt.toISOString()
        : capacityReservation.startsAt);
    promise.estimatedWaitMinutes = Math.max(0, Math.ceil((new Date(promise.promisedReadyAt).getTime() - nowDate.getTime()) / 60_000));
    if (scheduledPickup) {
      promise.requestedReadyAt = scheduledPickup.toISOString();
      promise.status = "on_time";
    } else if (promise.requestedReadyAt && new Date(promise.promisedReadyAt) > new Date(promise.requestedReadyAt)) {
      promise.status = "delayed_offer";
    }
  }
  const order: SellerOrder = {
    id: orderId,
    merchantId: merchant.id,
    merchantName: merchant.name,
    agentId: input.agentId || "buy-r-demo",
    customerLabel: input.customerLabel || input.agentId || "buyer agent user",
    buyerId: input.buyerId || null,
    offerId: input.offerId || null,
    batchId: null,
    lifecycle: {
      order: "open",
      payment: "required",
      fulfillment: "requested",
      receipt: "none",
    },
    status: "pending_payment",
    proofLevel: "order_intent_only",
    item: quote.item,
    lineItems: [quote.item],
    promise,
    capacityReservation,
    payment: {
      mode: paymentMode,
      status: "required",
      provider: null,
      paymentId: null,
    },
    terminal: {
      status: "requested",
      actor: null,
      note: null,
      updatedAt: null,
    },
    receipt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await saveOrder(order);
  } catch (error) {
    await sllrStore().deleteJson(orderKey(order.id));
    if (capacityReservation) await releaseCapacityReservation(capacityReservation.id);
    throw error;
  }
  return { order, quote };
}

export async function getOrder(orderId: string) {
  return (await loadOrder(orderId)) || null;
}

export async function listOrders(filter: MerchantOrderFilter = {}) {
  const scoped = filter.merchantId ? await ordersForMerchant(filter.merchantId) : await allOrders();
  return scoped
    .filter((order) => !filter.status || order.status === filter.status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function requireOrderForMerchant(orderId: string, input: MerchantActionRequest) {
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  if (order.merchantId !== input.merchantId) {
    throw Object.assign(new Error(`Merchant ${input.merchantId} cannot operate order for ${order.merchantId}.`), { status: 409 });
  }
  return order;
}

function terminalUpdate(input: MerchantActionRequest, status: SellerOrder["terminal"]["status"]) {
  return {
    status,
    actor: input.actor || "merchant",
    note: input.note || null,
    updatedAt: new Date().toISOString(),
  };
}

export async function acceptOrder(orderId: string, input: MerchantActionRequest) {
  const order = await requireOrderForMerchant(orderId, input);
  if (order.status === "rejected") {
    throw Object.assign(new Error("Rejected orders cannot be accepted."), { status: 409 });
  }
  if (order.status === "receipt_issued") return order;

  const updated: SellerOrder = {
    ...order,
    status: order.payment.status === "verified" ? "payment_backed" : "accepted",
    terminal: terminalUpdate(input, "accepted"),
    updatedAt: new Date().toISOString(),
  };
  await saveOrder(updated);
  return updated;
}

export async function rejectOrder(orderId: string, input: MerchantActionRequest) {
  const order = await requireOrderForMerchant(orderId, input);
  if (order.status === "payment_backed" || order.status === "fulfilled" || order.status === "receipt_issued") {
    throw Object.assign(new Error("Orders with payment, fulfillment, or receipt proof cannot be rejected."), { status: 409 });
  }

  if (order.status === "rejected") {
    return reconcileCapacityReservation(order, "released");
  }

  const updated: SellerOrder = {
    ...order,
    status: "rejected",
    terminal: terminalUpdate(input, "rejected"),
    updatedAt: new Date().toISOString(),
  };
  await saveOrder(updated);
  return reconcileCapacityReservation(updated, "released");
}

type OrderMutationOptions = {
  operation?: string;
  requesterId?: string | null;
  actionKey?: unknown;
};

async function transitionCapacityReservation(order: SellerOrder, target: "released" | "consumed") {
  if (!order.capacityReservation) return order;
  const transitioned = target === "released"
    ? await releaseCapacityReservation(order.capacityReservation.id)
    : await consumeCapacityReservation(order.capacityReservation.id);
  if (!transitioned) return order;
  return {
    ...order,
    capacityReservation: {
      ...order.capacityReservation,
      status: transitioned.status,
      updatedAt: transitioned.updatedAt,
    },
  } satisfies SellerOrder;
}

async function reconcileCapacityReservation(order: SellerOrder, target: "released" | "consumed") {
  const reconciled = await transitionCapacityReservation(order, target);
  if (
    reconciled.capacityReservation?.status !== order.capacityReservation?.status
    || reconciled.capacityReservation?.updatedAt !== order.capacityReservation?.updatedAt
  ) {
    await saveOrder(reconciled);
  }
  return reconciled;
}

async function fulfillOrderOnce(orderId: string, input: MerchantActionRequest) {
  const order = await requireOrderForMerchant(orderId, input);
  if (order.status === "rejected") {
    throw Object.assign(new Error("Rejected orders cannot be fulfilled."), { status: 409 });
  }
  if (order.status === "receipt_issued") return reconcileCapacityReservation(order, "consumed");

  let fulfilled: SellerOrder = {
    ...order,
    status: "fulfilled",
    proofLevel: "fulfilled",
    terminal: terminalUpdate(input, "fulfilled"),
    updatedAt: new Date().toISOString(),
  };
  fulfilled = await transitionCapacityReservation(fulfilled, "consumed");
  fulfilled.receipt = await issueSllrReceipt(fulfilled);
  fulfilled.status = "receipt_issued";
  fulfilled.proofLevel = "receipt_memory_issued";
  fulfilled.updatedAt = new Date().toISOString();
  await saveOrder(fulfilled);
  return fulfilled;
}

export function fulfillOrderMutation(orderId: string, input: MerchantActionRequest, options: OrderMutationOptions = {}) {
  const operation = options.operation || "merchant_fulfill_order";
  return withIdempotentMutation({
    operation,
    tenantId: input.merchantId,
    requesterId: options.requesterId ?? "merchant-operator",
    targetId: orderId,
    actionKey: options.actionKey ?? `${operation}:${orderId}`,
    request: {
      merchantId: input.merchantId,
      orderId,
      actor: input.actor || "merchant",
      note: input.note || null,
    },
    run: () => fulfillOrderOnce(orderId, input),
    mutationFromResult: (order, key) => mutationResultForOrder(key, order),
  });
}

export async function fulfillOrder(orderId: string, input: MerchantActionRequest, options: OrderMutationOptions = {}) {
  return (await fulfillOrderMutation(orderId, input, options)).result;
}

export async function markOrderReady(orderId: string, input: MerchantActionRequest) {
  const order = await requireOrderForMerchant(orderId, input);
  if (order.status === "rejected") {
    throw Object.assign(new Error("Rejected orders cannot be marked ready."), { status: 409 });
  }
  if (order.status === "receipt_issued" || order.status === "claimed") return order;
  if (order.status !== "accepted" && order.status !== "payment_backed") {
    throw Object.assign(new Error("Only accepted orders can be marked ready."), { status: 409 });
  }

  const readyAt = new Date();
  const promisedReadyAt = order.promise.promisedReadyAt ? new Date(order.promise.promisedReadyAt) : null;
  const delayMinutes = promisedReadyAt ? Math.max(0, Math.ceil((readyAt.getTime() - promisedReadyAt.getTime()) / 60_000)) : null;
  const updated: SellerOrder = {
    ...order,
    status: "ready",
    terminal: terminalUpdate(input, "ready"),
    promise: {
      ...order.promise,
      readyAt: readyAt.toISOString(),
      delayMinutes,
    },
    updatedAt: readyAt.toISOString(),
  };
  await saveOrder(updated);
  return updated;
}

export async function claimOrder(orderId: string, input: MerchantActionRequest) {
  const order = await requireOrderForMerchant(orderId, input);
  if (order.status === "rejected") {
    throw Object.assign(new Error("Rejected orders cannot be claimed."), { status: 409 });
  }
  if (order.status === "receipt_issued") return reconcileCapacityReservation(order, "consumed");
  if (order.status !== "ready") {
    throw Object.assign(new Error("Only ready pickup orders can be claimed."), { status: 409 });
  }

  const claimedAt = new Date().toISOString();
  let claimed: SellerOrder = {
    ...order,
    status: "claimed",
    proofLevel: "fulfilled",
    terminal: terminalUpdate(input, "claimed"),
    promise: {
      ...order.promise,
      readyAt: order.promise.readyAt || claimedAt,
      claimedAt,
    },
    updatedAt: claimedAt,
  };
  claimed = await transitionCapacityReservation(claimed, "consumed");
  claimed.receipt = await issueSllrReceipt(claimed);
  claimed.status = "receipt_issued";
  claimed.proofLevel = "receipt_memory_issued";
  claimed.updatedAt = new Date().toISOString();
  await saveOrder(claimed);
  return claimed;
}

async function attachPaymentProofOnce(input: PaymentWebhook) {
  const order = await getOrder(input.orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${input.orderId}`), { status: 404 });
  if (order.merchantId !== input.merchantId) {
    throw Object.assign(new Error(`Payment merchant ${input.merchantId} does not match order merchant ${order.merchantId}.`), { status: 409 });
  }
  // Idempotency: payment webhooks can be delivered or replayed more than once.
  // Payment proof is intentionally not fulfillment proof and cannot issue the
  // final receipt memory by itself.
  if (order.status === "receipt_issued" || order.payment.status === "verified") {
    if (order.payment.provider === input.provider && order.payment.paymentId === input.paymentId) return order;
    throw Object.assign(new Error("Incoming payment proof conflicts with the proof already stored for this order."), {
      status: 409,
      code: "payment_proof_conflict",
    });
  }
  if (centsFromUsd(input.amountUsd) < centsFromUsd(order.item.subtotalUsd)) {
    throw Object.assign(new Error(`Payment $${input.amountUsd} is below order subtotal $${order.item.subtotalUsd}.`), { status: 409 });
  }

  const updated: SellerOrder = {
    ...order,
    status: "payment_backed",
    proofLevel: "payment_backed",
    payment: {
      ...order.payment,
      status: "verified",
      provider: input.provider,
      paymentId: input.paymentId,
    },
    updatedAt: new Date().toISOString(),
  };
  await saveOrder(updated);
  // Payment remains a non-terminal loop event until merchant fulfillment.
  const loopId = await loopIdForOrderResolved(updated.id);
  await recordLoopSafe(loopId, { buyerId: updated.buyerId, merchantId: updated.merchantId }, {
    eventType: "payment", actor: "payment_provider", stateAfter: "payment_backed", claimLevel: "paid",
    receiptRef: input.paymentId, ids: { orderId: updated.id, paymentReceiptId: input.paymentId },
  });
  return updated;
}

export function attachPaymentProofMutation(input: PaymentWebhook, options: OrderMutationOptions = {}) {
  const operation = options.operation || "attach_payment_proof";
  return withIdempotentMutation({
    operation,
    tenantId: input.merchantId,
    requesterId: options.requesterId ?? "payment-provider",
    targetId: input.orderId,
    actionKey: options.actionKey ?? `${input.provider}:${input.paymentId}`,
    request: {
      merchantId: input.merchantId,
      orderId: input.orderId,
      provider: input.provider,
      amountUsd: input.amountUsd,
      paymentId: input.paymentId,
    },
    run: () => attachPaymentProofOnce(input),
    mutationFromResult: (order, key) => mutationResultForOrder(key, order),
  });
}

export async function attachPaymentProof(input: PaymentWebhook, options: OrderMutationOptions = {}) {
  return (await attachPaymentProofMutation(input, options)).result;
}
