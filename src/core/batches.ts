import { randomUUID } from "node:crypto";
import { merchantForId } from "../merchants/profiles.js";
import type { FulfillmentBatch, SellerOrder } from "../types.js";
import { centsFromUsd, formatUsd } from "./money.js";
import { actionKeyFrom, withIdempotentMutation } from "./mutations.js";
import { getOrder } from "./orders.js";
import { sllrStore } from "./store.js";

const BATCH_KEY = (id: string) => `sllr:fulfillment-batch:${id}`;
const BATCH_INDEX = (merchantId: string) => `sllr:fulfillment-batches:${merchantId}`;
const MEMBERSHIP_KEY = (orderId: string) => `sllr:fulfillment-batch-membership:${orderId}`;

type StoredBatch = Omit<FulfillmentBatch, "status" | "totals" | "items">;
type BatchMembership = { batchId: string; merchantId: string; createdAt: string };

function requireMerchant(merchantId: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${merchantId}`), { status: 404 });
  return merchant;
}

function batchStatus(orders: SellerOrder[]): FulfillmentBatch["status"] {
  if (orders.length > 0 && orders.every((order) => order.lifecycle.receipt === "issued")) return "completed";
  if (orders.length > 0 && orders.every((order) => ["ready", "claimed", "fulfilled"].includes(order.lifecycle.fulfillment))) return "ready";
  if (orders.some((order) => order.payment.status === "verified" || order.lifecycle.fulfillment !== "requested")) return "in_progress";
  return "open";
}

function summarizeItems(orders: SellerOrder[]) {
  const grouped = new Map<string, { itemId: string; name: string; quantity: number }>();
  for (const order of orders) {
    for (const item of order.lineItems?.length ? order.lineItems : [order.item]) {
      const current = grouped.get(item.id) || { itemId: item.id, name: item.name, quantity: 0 };
      current.quantity += item.quantity;
      grouped.set(item.id, current);
    }
  }
  return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function hydrateBatch(stored: StoredBatch): Promise<FulfillmentBatch> {
  const orders = (await Promise.all(stored.orderIds.map(getOrder))).filter((order): order is SellerOrder => order !== null);
  const lineItems = orders.flatMap((order) => order.lineItems?.length ? order.lineItems : [order.item]);
  const amountCents = lineItems.reduce((total, item) => total + centsFromUsd(item.subtotalUsd), 0);
  return {
    ...stored,
    status: batchStatus(orders),
    totals: {
      orders: orders.length,
      quantity: lineItems.reduce((total, item) => total + item.quantity, 0),
      amountUsd: formatUsd(amountCents),
    },
    items: summarizeItems(orders),
    updatedAt: orders.reduce((latest, order) => order.updatedAt > latest ? order.updatedAt : latest, stored.updatedAt),
  };
}

function pickupWindowForOrders(orders: SellerOrder[]): StoredBatch["pickupWindow"] {
  const windows = new Map<string, { id: string; startsAt: string; endsAt: string }>();
  for (const order of orders) {
    const reservation = order.capacityReservation;
    if (reservation) windows.set(reservation.windowId, {
      id: reservation.windowId,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
    });
  }
  if (windows.size > 1) {
    throw Object.assign(new Error("A fulfillment batch can only group orders assigned to the same pickup window."), {
      status: 409,
      code: "batch_window_mismatch",
    });
  }
  return [...windows.values()][0] || null;
}

async function createBatchOnce(merchantId: string, payload: Record<string, unknown>) {
  requireMerchant(merchantId);
  if (!Array.isArray(payload.orderIds)) {
    throw Object.assign(new Error("orderIds must be an array of independent SLL-R order ids."), { status: 400 });
  }
  const orderIds = [...new Set(payload.orderIds.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))].sort();
  if (orderIds.length < 2 || orderIds.length > 50) {
    throw Object.assign(new Error("A fulfillment batch requires between 2 and 50 unique orders."), { status: 422 });
  }
  const orders = await Promise.all(orderIds.map(async (orderId) => {
    const order = await getOrder(orderId);
    if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
    if (order.merchantId !== merchantId) {
      throw Object.assign(new Error(`Order ${orderId} belongs to ${order.merchantId}, not ${merchantId}.`), { status: 409 });
    }
    if (order.lifecycle.order !== "open" || order.lifecycle.receipt === "issued") {
      throw Object.assign(new Error(`Order ${orderId} is already terminal and cannot enter a new batch.`), { status: 409 });
    }
    if (order.payment.status !== "verified") {
      throw Object.assign(new Error(`Order ${orderId} must have verified payment before merchant consolidation.`), {
        status: 409,
        code: "batch_requires_payment",
      });
    }
    if (!order.capacityReservation) {
      throw Object.assign(new Error(`Order ${orderId} has no pickup-capacity reservation and cannot enter a pickup batch.`), {
        status: 409,
        code: "batch_requires_pickup_window",
      });
    }
    if (!(["requested", "accepted"] as string[]).includes(order.lifecycle.fulfillment)) {
      throw Object.assign(new Error(`Order ${orderId} has already entered fulfillment and cannot join a new batch.`), {
        status: 409,
        code: "batch_fulfillment_started",
      });
    }
    return order;
  }));
  const pickupWindow = pickupWindowForOrders(orders);
  const batchId = `batch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const createdAt = new Date().toISOString();
  const acquiredMemberships: string[] = [];

  try {
    for (const orderId of orderIds) {
      const claimed = await sllrStore().setJsonIfAbsent(MEMBERSHIP_KEY(orderId), {
        batchId,
        merchantId,
        createdAt,
      } satisfies BatchMembership);
      if (!claimed) {
        const membership = await sllrStore().getJson<BatchMembership>(MEMBERSHIP_KEY(orderId));
        throw Object.assign(new Error(`Order ${orderId} already belongs to batch ${membership?.batchId || "unknown"}.`), {
          status: 409,
          code: "order_already_batched",
        });
      }
      acquiredMemberships.push(orderId);
    }

    const stored: StoredBatch = {
      id: batchId,
      merchantId,
      label: typeof payload.label === "string" && payload.label.trim()
        ? payload.label.trim().slice(0, 100)
        : `Batch ${createdAt.slice(11, 16)}`,
      level: 2,
      orderIds,
      pickupWindow,
      createdAt,
      updatedAt: createdAt,
    };
    await sllrStore().setJson(BATCH_KEY(batchId), stored);
    await sllrStore().addToIndex(BATCH_INDEX(merchantId), batchId);
    return hydrateBatch(stored);
  } catch (error) {
    await Promise.all(acquiredMemberships.map((orderId) => sllrStore().deleteJson(MEMBERSHIP_KEY(orderId))));
    await sllrStore().deleteJson(BATCH_KEY(batchId));
    throw error;
  }
}

export async function createFulfillmentBatch(merchantId: string, payload: Record<string, unknown>) {
  const actionKey = actionKeyFrom(payload, "create_fulfillment_batch");
  const { result, mutation } = await withIdempotentMutation({
    operation: "create_fulfillment_batch",
    tenantId: merchantId,
    requesterId: "merchant-operator",
    targetId: merchantId,
    actionKey,
    request: { merchantId, orderIds: payload.orderIds, label: payload.label || null },
    run: () => createBatchOnce(merchantId, payload),
    mutationFromResult: (batch, key) => ({
      actionKey: key,
      resourceId: batch.id,
      state: batch.status,
      terminal: batch.status === "completed",
      retryable: false,
      allowedNextActions: batch.status === "completed" ? [] : ["merchant_mark_ready", "merchant_fulfill_order"],
      proofRefs: batch.orderIds.map((orderId) => `order:${orderId}`),
    }),
  });
  return { product: "SLL-R Level 2 fulfillment batch", batch: result, ...(mutation ? { mutation } : {}) };
}

export async function getFulfillmentBatch(batchId: string, merchantId?: string) {
  const stored = await sllrStore().getJson<StoredBatch>(BATCH_KEY(batchId));
  if (!stored) throw Object.assign(new Error(`Unknown fulfillment batch: ${batchId}`), { status: 404 });
  if (merchantId && stored.merchantId !== merchantId) {
    throw Object.assign(new Error(`Batch ${batchId} belongs to ${stored.merchantId}, not ${merchantId}.`), { status: 409 });
  }
  return { product: "SLL-R Level 2 fulfillment batch", batch: await hydrateBatch(stored) };
}

export async function listFulfillmentBatches(merchantId: string) {
  requireMerchant(merchantId);
  const ids = await sllrStore().indexMembers(BATCH_INDEX(merchantId));
  const batches = await Promise.all(ids.map((id) => sllrStore().getJson<StoredBatch>(BATCH_KEY(id))));
  return {
    product: "SLL-R Level 2 fulfillment batches",
    merchantId,
    batches: await Promise.all(batches.filter((batch): batch is StoredBatch => batch !== null).map(hydrateBatch)),
  };
}

export async function batchMembershipForOrder(orderId: string) {
  return sllrStore().getJson<BatchMembership>(MEMBERSHIP_KEY(orderId));
}
