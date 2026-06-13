import { baseCoffeePayment } from "../adapters/baseCoffeePlugin.js";
import { solanaPayPreparePayment } from "../adapters/solanaPay.js";
import { stripePreparePayment } from "../adapters/stripe.js";
import { merchantForId } from "../merchants/profiles.js";
import type { CatalogItem, PaymentRail, SellerOrder } from "../types.js";
import { getOrder } from "./orders.js";

async function requireOrder(merchantId: string, orderId: string) {
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  if (order.merchantId !== merchantId) {
    throw Object.assign(new Error(`Order ${order.id} is for ${order.merchantId}, not ${merchantId}.`), { status: 409 });
  }
  return order;
}

function checkoutUrlFor(item: CatalogItem | undefined) {
  return item?.productUrl || null;
}

function shopifyOption(order: SellerOrder, item: CatalogItem | undefined, origin: string) {
  const checkoutUrl = checkoutUrlFor(item);
  return {
    rail: "shopify" as PaymentRail,
    type: checkoutUrl ? "checkout_url" : "setup_required",
    orderId: order.id,
    amountUsd: order.item.subtotalUsd,
    url: checkoutUrl,
    proof: "Shopify orders/paid webhook or fulfillment webhook must attach payment or fulfillment proof before receipt memory.",
    next: checkoutUrl
      ? "Open the merchant checkout and return after payment proof is received."
      : `Configure Shopify product mapping for ${order.merchantId}.`,
    cartHandoffUrl: `${origin}/shopify/merchants/${order.merchantId}/cart`,
  };
}

function counterOption(order: SellerOrder) {
  return {
    rail: "counter" as PaymentRail,
    type: "pay_at_counter",
    orderId: order.id,
    amountUsd: order.item.subtotalUsd,
    pickupCode: order.id.replace(/^ord_/, "").slice(0, 6).toUpperCase(),
    proof: "Merchant terminal must mark payment, ready, claimed, or fulfilled before receipt memory.",
    next: "Show pickup code to staff and pay at counter.",
  };
}

function adapterErrorOption(rail: PaymentRail, order: SellerOrder, error: unknown) {
  return {
    rail,
    type: "setup_required",
    orderId: order.id,
    amountUsd: order.item.subtotalUsd,
    error: error instanceof Error ? error.message : "Payment adapter failed.",
  };
}

export async function merchantPaymentOptions(merchantId: string, payload: Record<string, unknown>, origin: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${merchantId}`), { status: 404 });
  const order = await requireOrder(merchantId, String(payload.orderId || ""));
  const item = merchant.catalog.find((candidate) => candidate.id === order.item.id);
  const payer = typeof payload.payer === "string" ? payload.payer : null;

  const paymentOptions: unknown[] = [];

  if (merchant.paymentRails.includes("counter")) {
    paymentOptions.push(counterOption(order));
  }

  if (merchant.paymentRails.includes("shopify")) {
    paymentOptions.push(shopifyOption(order, item, origin));
  }

  if (merchant.paymentRails.includes("base_usdc")) {
    try {
      paymentOptions.push(await baseCoffeePayment(order.id, payer));
    } catch (error) {
      paymentOptions.push(adapterErrorOption("base_usdc", order, error));
    }
  }

  if (merchant.paymentRails.includes("solana_pay") || merchant.paymentRails.includes("helio")) {
    try {
      paymentOptions.push(await solanaPayPreparePayment(order.id));
    } catch (error) {
      paymentOptions.push(adapterErrorOption(merchant.paymentRails.includes("solana_pay") ? "solana_pay" : "helio", order, error));
    }
  }

  if (merchant.paymentRails.includes("stripe")) {
    try {
      paymentOptions.push(await stripePreparePayment(order, origin));
    } catch (error) {
      paymentOptions.push(adapterErrorOption("stripe", order, error));
    }
  }

  for (const rail of ["moonpay", "binance_pay"] as PaymentRail[]) {
    if (merchant.paymentRails.includes(rail)) {
      paymentOptions.push({
        rail,
        type: "setup_required",
        orderId: order.id,
        amountUsd: order.item.subtotalUsd,
        proof: `${rail} webhook or query-order verification must be configured before receipt memory.`,
      });
    }
  }

  return {
    product: "SLL-R payment options",
    merchant: {
      id: merchant.id,
      name: merchant.name,
      paymentRails: merchant.paymentRails,
    },
    orderId: order.id,
    amountUsd: order.item.subtotalUsd,
    paymentOptions,
    safety: {
      requiresUserApproval: true,
      receiptRequiresProof: true,
      instruction: "Show the user merchant, item, amount, payment rail, and recipient or checkout URL before any payment approval.",
    },
  };
}
