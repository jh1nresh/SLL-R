import { randomUUID } from "node:crypto";
import { merchantForId } from "../merchants/profiles.js";
import type { MerchantActionRequest, MerchantOrderFilter, OrderRequest, PaymentWebhook, SellerOrder } from "../types.js";
import { issueJiagonReceipt } from "../adapters/jiagonReceipts.js";
import { centsFromUsd } from "./money.js";
import { quoteOrder } from "./quote.js";

const orders = new Map<string, SellerOrder>();

export function createOrder(input: OrderRequest) {
  const quote = quoteOrder(input);
  if (!quote.feasible || !quote.item) {
    throw Object.assign(new Error("Quote is not feasible. Ask the buyer agent to accept an alternative first."), {
      status: 409,
      quote,
    });
  }
  const merchant = merchantForId(input.merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${input.merchantId}`), { status: 404 });

  const now = new Date().toISOString();
  const paymentMode = input.paymentMode || (merchant.fulfillment.includes("shipping") ? "checkout" : "counter");
  const order: SellerOrder = {
    id: `ord_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    merchantId: merchant.id,
    merchantName: merchant.name,
    agentId: input.agentId || "buy-r-demo",
    customerLabel: input.customerLabel || input.agentId || "buyer agent user",
    status: "pending_payment",
    proofLevel: "order_intent_only",
    item: quote.item,
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
  orders.set(order.id, order);
  return { order, quote };
}

export function getOrder(orderId: string) {
  return orders.get(orderId) || null;
}

export function listOrders(filter: MerchantOrderFilter = {}) {
  return Array.from(orders.values())
    .filter((order) => !filter.merchantId || order.merchantId === filter.merchantId)
    .filter((order) => !filter.status || order.status === filter.status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function requireOrderForMerchant(orderId: string, input: MerchantActionRequest) {
  const order = getOrder(orderId);
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

export function acceptOrder(orderId: string, input: MerchantActionRequest) {
  const order = requireOrderForMerchant(orderId, input);
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
  orders.set(updated.id, updated);
  return updated;
}

export function rejectOrder(orderId: string, input: MerchantActionRequest) {
  const order = requireOrderForMerchant(orderId, input);
  if (order.status === "payment_backed" || order.status === "fulfilled" || order.status === "receipt_issued") {
    throw Object.assign(new Error("Orders with payment, fulfillment, or receipt proof cannot be rejected."), { status: 409 });
  }

  const updated: SellerOrder = {
    ...order,
    status: "rejected",
    terminal: terminalUpdate(input, "rejected"),
    updatedAt: new Date().toISOString(),
  };
  orders.set(updated.id, updated);
  return updated;
}

export async function fulfillOrder(orderId: string, input: MerchantActionRequest) {
  const order = requireOrderForMerchant(orderId, input);
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
  fulfilled.receipt = await issueJiagonReceipt(fulfilled);
  fulfilled.status = "receipt_issued";
  fulfilled.proofLevel = "receipt_memory_issued";
  fulfilled.updatedAt = new Date().toISOString();
  orders.set(fulfilled.id, fulfilled);
  return fulfilled;
}

export async function attachPaymentProof(input: PaymentWebhook) {
  const order = getOrder(input.orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${input.orderId}`), { status: 404 });
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
  updated.receipt = await issueJiagonReceipt(updated);
  updated.status = "receipt_issued";
  updated.proofLevel = "receipt_memory_issued";
  updated.updatedAt = new Date().toISOString();
  orders.set(updated.id, updated);
  return updated;
}
