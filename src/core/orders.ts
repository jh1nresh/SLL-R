import { randomUUID } from "node:crypto";
import { merchantForId } from "../merchants/profiles.js";
import type { CatalogItem, MerchantActionRequest, MerchantOrderFilter, MerchantProfile, OrderRequest, PaymentWebhook, SellerOrder } from "../types.js";
import { issueSllrReceipt } from "../adapters/sllrReceipts.js";
import { centsFromUsd } from "./money.js";
import { quoteOrder } from "./quote.js";
import { sllrStore } from "./store.js";
import { buyerOrdersIndex } from "./buyer.js";

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
  const store = sllrStore();
  const loaded = await Promise.all(ids.map((id) => store.getJson<SellerOrder>(orderKey(id))));
  return loaded.filter((order): order is SellerOrder => order !== null);
}

async function saveOrder(order: SellerOrder) {
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
  return sllrStore().getJson<SellerOrder>(orderKey(orderId));
}

async function ordersForMerchant(merchantId: string): Promise<SellerOrder[]> {
  const ids = await sllrStore().indexMembers(merchantOrderIndex(merchantId));
  return loadOrdersByIds(ids);
}

async function allOrders(): Promise<SellerOrder[]> {
  const ids = await sllrStore().indexMembers(ORDER_INDEX);
  return loadOrdersByIds(ids);
}

export async function listOrdersForBuyer(buyerId: string): Promise<SellerOrder[]> {
  const ids = await sllrStore().indexMembers(buyerOrdersIndex(buyerId));
  return (await loadOrdersByIds(ids)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

const capacityByClass = {
  espresso: 8,
  cold: 12,
  pastry: 20,
  general: 10,
} as const;

function productionClassFor(item: CatalogItem): keyof typeof capacityByClass {
  if (item.productionClass) return item.productionClass;
  const tags = new Set((item.tags || []).map((tag) => tag.toLowerCase()));
  if (tags.has("pastry")) return "pastry";
  if (tags.has("cold brew") || tags.has("cold")) return "cold";
  if (tags.has("coffee") || tags.has("latte") || tags.has("espresso")) return "espresso";
  return "general";
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

async function activePickupOrders(merchantId: string, productionClass: string) {
  const merchantOrders = await ordersForMerchant(merchantId);
  return merchantOrders.filter((order) => (
    order.promise.productionClass === productionClass
    && !["rejected", "claimed", "fulfilled", "receipt_issued"].includes(order.status)
  ));
}

async function pickupPromise(merchant: MerchantProfile, item: CatalogItem, input: OrderRequest, now: Date): Promise<SellerOrder["promise"]> {
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
    };
  }

  const productionClass = productionClassFor(item);
  const activeAhead = (await activePickupOrders(merchant.id, productionClass)).length;
  const capacity = capacityByClass[productionClass];
  const capacityWindowMinutes = 15;
  const prepMinutes = Math.max(item.prepMinutes || 5, 1);
  const estimatedWaitMinutes = prepMinutes + Math.floor(activeAhead / capacity) * capacityWindowMinutes;
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
  const paymentMode = input.paymentMode || (catalogItem.fulfillment.includes("shipping") ? "checkout" : "counter");
  const order: SellerOrder = {
    id: `ord_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    merchantId: merchant.id,
    merchantName: merchant.name,
    agentId: input.agentId || "buy-r-demo",
    customerLabel: input.customerLabel || input.agentId || "buyer agent user",
    buyerId: input.buyerId || null,
    status: "pending_payment",
    proofLevel: "order_intent_only",
    item: quote.item,
    promise: await pickupPromise(merchant, catalogItem, input, nowDate),
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
  await saveOrder(order);
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

  const updated: SellerOrder = {
    ...order,
    status: "rejected",
    terminal: terminalUpdate(input, "rejected"),
    updatedAt: new Date().toISOString(),
  };
  await saveOrder(updated);
  return updated;
}

export async function fulfillOrder(orderId: string, input: MerchantActionRequest) {
  const order = await requireOrderForMerchant(orderId, input);
  if (order.status === "rejected") {
    throw Object.assign(new Error("Rejected orders cannot be fulfilled."), { status: 409 });
  }
  if (order.status === "receipt_issued") return order;

  const fulfilled: SellerOrder = {
    ...order,
    status: "fulfilled",
    proofLevel: "fulfilled",
    terminal: terminalUpdate(input, "fulfilled"),
    updatedAt: new Date().toISOString(),
  };
  fulfilled.receipt = await issueSllrReceipt(fulfilled);
  fulfilled.status = "receipt_issued";
  fulfilled.proofLevel = "receipt_memory_issued";
  fulfilled.updatedAt = new Date().toISOString();
  await saveOrder(fulfilled);
  return fulfilled;
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
  if (order.status === "receipt_issued") return order;
  if (order.status !== "ready") {
    throw Object.assign(new Error("Only ready pickup orders can be claimed."), { status: 409 });
  }

  const claimedAt = new Date().toISOString();
  const claimed: SellerOrder = {
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
  claimed.receipt = await issueSllrReceipt(claimed);
  claimed.status = "receipt_issued";
  claimed.proofLevel = "receipt_memory_issued";
  claimed.updatedAt = new Date().toISOString();
  await saveOrder(claimed);
  return claimed;
}

export async function attachPaymentProof(input: PaymentWebhook) {
  const order = await getOrder(input.orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${input.orderId}`), { status: 404 });
  // Idempotency: payment webhooks can be delivered or replayed more than once
  // (Stripe/Shopify both retry). Once proof is verified and the receipt issued,
  // return the settled order rather than re-issuing.
  if (order.status === "receipt_issued" || order.payment.status === "verified") {
    return order;
  }
  if (order.merchantId !== input.merchantId) {
    throw Object.assign(new Error(`Payment merchant ${input.merchantId} does not match order merchant ${order.merchantId}.`), { status: 409 });
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
  updated.receipt = await issueSllrReceipt(updated);
  updated.status = "receipt_issued";
  updated.proofLevel = "receipt_memory_issued";
  updated.updatedAt = new Date().toISOString();
  await saveOrder(updated);
  return updated;
}
