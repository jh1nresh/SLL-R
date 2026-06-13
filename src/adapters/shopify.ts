import { createHmac, timingSafeEqual } from "node:crypto";
import { attachPaymentProof, fulfillOrder, getOrder } from "../core/orders.js";
import { allMerchantProfiles, merchantForId } from "../merchants/profiles.js";
import type { CatalogItem, MerchantProfile } from "../types.js";

const DEFAULT_SHOPIFY_DOMAINS: Record<string, string> = {
  "noun-coffee": "noun.coffee",
  "raposa-shop": "raposacoffee.com",
  solyd: "solyd.store",
  "changbaishan-rice": "changbaishan-rice.example",
};

function merchantEnvKey(merchantId: string) {
  return merchantId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function requireShopifyMerchant(merchantId: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant || !merchant.paymentRails.includes("shopify")) {
    throw Object.assign(new Error(`Unknown Shopify merchant: ${merchantId}`), { status: 404 });
  }
  return merchant;
}

function shopifyDomainFor(merchantId: string) {
  const envKey = merchantEnvKey(merchantId);
  return (
    process.env[`SLLR_SHOPIFY_${envKey}_DOMAIN`]
    || DEFAULT_SHOPIFY_DOMAINS[merchantId]
    || ""
  ).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function storefrontUrlFor(merchantId: string) {
  const domain = shopifyDomainFor(merchantId);
  return domain ? `https://${domain}` : null;
}

function shopifyEndpoints(merchantId: string) {
  const storefrontUrl = storefrontUrlFor(merchantId);
  return {
    storefrontUrl,
    storefrontMcp: storefrontUrl ? `${storefrontUrl}/api/mcp` : null,
    ucpCatalogMcp: storefrontUrl ? `${storefrontUrl}/api/ucp/mcp` : null,
    storefrontApi: storefrontUrl ? `${storefrontUrl}/api/2026-04/graphql.json` : null,
  };
}

function productCheckoutUrl(merchantId: string, item: CatalogItem) {
  if (item.productUrl) return item.productUrl;
  const storefrontUrl = storefrontUrlFor(merchantId);
  return storefrontUrl || null;
}

function productSummary(merchantId: string, item: CatalogItem) {
  return {
    id: item.id,
    name: item.name,
    amountUsd: item.amountUsd,
    fulfillment: item.fulfillment,
    inventory: item.inventory ?? null,
    tags: item.tags || [],
    productUrl: productCheckoutUrl(merchantId, item),
    shopifyVariantGid: null,
    mapping: {
      source: item.productUrl ? "product_url" : "storefront_domain",
      requiredMetadataKeys: ["sllr_order_id", "sllr_merchant_id"],
      proofPath: "orders/paid webhook or fulfillment webhook",
    },
  };
}

function webhookUrls(origin: string) {
  return {
    ordersPaid: `${origin}/webhooks/shopify/orders-paid`,
    ordersFulfilled: `${origin}/webhooks/shopify/orders-fulfilled`,
    refundsCreate: `${origin}/webhooks/shopify/refunds-create`,
  };
}

function connectPlan(merchant: MerchantProfile, origin: string) {
  const envKey = merchantEnvKey(merchant.id);
  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      category: merchant.category,
      location: merchant.location,
    },
    shopify: {
      ...shopifyEndpoints(merchant.id),
      merchantDomainEnv: `SLLR_SHOPIFY_${envKey}_DOMAIN`,
      storefrontTokenEnv: `SLLR_SHOPIFY_${envKey}_STOREFRONT_TOKEN`,
      adminTokenEnv: `SLLR_SHOPIFY_${envKey}_ADMIN_TOKEN`,
      webhookSecretEnv: "SLLR_SHOPIFY_WEBHOOK_SECRET",
    },
    agentPath: [
      "Use Storefront MCP or SLL-R /shopify products to discover catalog.",
      "Create an SLL-R order with merchantId and buyer intent.",
      "Create Shopify cart or checkout handoff with sllr_order_id metadata.",
      "Let Shopify checkout handle Base Pay / card / crypto payment methods.",
      "Use Shopify orders/paid webhook as payment proof.",
      "Use Shopify fulfillment webhook as fulfillment proof when available.",
      "Issue SLL-R receipt memory after verified payment or fulfillment proof.",
    ],
    requiredMerchantSetup: [
      "Confirm Shopify storefront domain.",
      "Provide Storefront API token if SLL-R should create carts directly.",
      "Provide Admin API token only if SLL-R should subscribe or reconcile webhooks.",
      "Configure orders/paid and fulfillment webhooks to SLL-R.",
      "Include sllr_order_id in cart attributes, note attributes, or checkout metadata.",
    ],
    webhookTopics: [
      "orders/paid",
      "fulfillment_orders/fulfillment_request_submitted or fulfillment events available to the merchant setup",
      "refunds/create, optional for receipt reversals",
    ],
    webhookUrls: webhookUrls(origin),
  };
}

export function shopifyMerchants(origin: string) {
  return {
    product: "SLL-R Shopify adapter",
    docsUrl: "https://github.com/JhiNResH/SLL-R/blob/main/docs/shopify-integration-runbook.md",
    merchants: allMerchantProfiles()
      .filter((merchant) => merchant.paymentRails.includes("shopify"))
      .map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        category: merchant.category,
        location: merchant.location,
        fulfillment: merchant.fulfillment,
        paymentRails: merchant.paymentRails,
        catalogItems: merchant.catalog.length,
        ...shopifyEndpoints(merchant.id),
        connectPlanUrl: `${origin}/shopify/merchants/${merchant.id}/connect`,
      })),
  };
}

export function shopifyConnectPlan(merchantId: string, origin: string) {
  return {
    product: "SLL-R Shopify connect plan",
    ...connectPlan(requireShopifyMerchant(merchantId), origin),
  };
}

export function shopifyProducts(merchantId: string) {
  const merchant = requireShopifyMerchant(merchantId);
  return {
    product: "SLL-R Shopify product handoff",
    merchant: {
      id: merchant.id,
      name: merchant.name,
      ...shopifyEndpoints(merchant.id),
    },
    products: merchant.catalog.map((item) => productSummary(merchant.id, item)),
    cartMetadataKeys: ["sllr_order_id", "sllr_merchant_id", "sllr_receipt_callback"],
    note: "Products come from the current SLL-R merchant profile until the merchant provides Storefront MCP or Storefront API access.",
  };
}

export async function shopifyCartHandoff(merchantId: string, payload: Record<string, unknown>, origin: string) {
  const merchant = requireShopifyMerchant(merchantId);
  const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
  const itemId = typeof payload.itemId === "string" ? payload.itemId : "";
  const order = orderId ? await getOrder(orderId) : null;
  if (orderId && !order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  if (order && order.merchantId !== merchant.id) {
    throw Object.assign(new Error(`Order ${order.id} is for ${order.merchantId}, not ${merchant.id}.`), { status: 409 });
  }

  const selectedItemId = order?.item.id || itemId;
  if (!selectedItemId) throw Object.assign(new Error("Missing orderId or itemId."), { status: 400 });
  const item = merchant.catalog.find((candidate) => candidate.id === selectedItemId);
  if (!item) throw Object.assign(new Error(`Unknown Shopify item: ${selectedItemId}`), { status: 404 });

  const checkoutUrl = productCheckoutUrl(merchant.id, item);
  return {
    product: "SLL-R Shopify cart handoff",
    mode: checkoutUrl ? "checkout_handoff" : "setup_required",
    merchant: {
      id: merchant.id,
      name: merchant.name,
      ...shopifyEndpoints(merchant.id),
    },
    orderId: order?.id || null,
    item: productSummary(merchant.id, item),
    checkoutHandoff: checkoutUrl
      ? {
        type: "shopify_checkout_or_product_page",
        url: checkoutUrl,
        instruction: "Open Shopify checkout/product page. For full automation, configure Storefront API cartCreate with sllr_order_id cart attributes.",
      }
      : null,
    cartMetadata: {
      sllr_order_id: order?.id || null,
      sllr_merchant_id: merchant.id,
      sllr_receipt_callback: `${origin}/webhooks/shopify/orders-paid`,
    },
    connectPlan: checkoutUrl ? null : connectPlan(merchant, origin),
  };
}

function hmacHeader(headers: Record<string, string | string[] | undefined>) {
  const value = headers["x-shopify-hmac-sha256"];
  return Array.isArray(value) ? value[0] : value;
}

function verifyShopifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, payload: Record<string, unknown>) {
  const secret = process.env.SLLR_SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    if (payload.demo === true) return { mode: "demo" as const };
    throw Object.assign(new Error("SLLR_SHOPIFY_WEBHOOK_SECRET is not configured. Send demo=true for local demos, or configure Shopify webhook verification before accepting payment proof."), { status: 403 });
  }

  const received = hmacHeader(headers);
  if (!received) throw Object.assign(new Error("Missing X-Shopify-Hmac-SHA256 header."), { status: 401 });
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const receivedBuffer = Buffer.from(received, "base64");
  const expectedBuffer = Buffer.from(expected, "base64");
  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw Object.assign(new Error("Shopify webhook HMAC verification failed."), { status: 401 });
  }
  return { mode: "hmac" as const };
}

function noteAttribute(payload: Record<string, unknown>, keys: string[]) {
  const attributes = payload.note_attributes;
  if (!Array.isArray(attributes)) return null;
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") continue;
    const record = attribute as Record<string, unknown>;
    const name = String(record.name || record.key || "");
    if (keys.includes(name) && typeof record.value === "string" && record.value) {
      return record.value;
    }
  }
  return null;
}

function sllrOrderIdFrom(payload: Record<string, unknown>) {
  if (typeof payload.sllrOrderId === "string") return payload.sllrOrderId;
  if (typeof payload.sllr_order_id === "string") return payload.sllr_order_id;
  return noteAttribute(payload, ["sllr_order_id", "sllrOrderId"]);
}

function paymentIdFrom(payload: Record<string, unknown>) {
  return String(payload.admin_graphql_api_id || payload.id || payload.order_number || payload.name || "shopify_order");
}

function paidAmountFrom(payload: Record<string, unknown>) {
  return String(payload.current_total_price || payload.total_price || payload.subtotal_price || "0");
}

export async function shopifyOrdersPaidWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, payload: Record<string, unknown>) {
  const verifier = verifyShopifyWebhook(headers, rawBody, payload);
  const orderId = sllrOrderIdFrom(payload);
  if (!orderId) {
    throw Object.assign(new Error("Shopify paid webhook is missing sllr_order_id metadata."), { status: 409 });
  }
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  return attachPaymentProof({
    orderId: order.id,
    merchantId: order.merchantId,
    provider: "shopify",
    amountUsd: paidAmountFrom(payload),
    paymentId: `${paymentIdFrom(payload)}:${verifier.mode}`,
  });
}

export async function shopifyOrdersFulfilledWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, payload: Record<string, unknown>) {
  verifyShopifyWebhook(headers, rawBody, payload);
  const orderId = sllrOrderIdFrom(payload);
  if (!orderId) {
    throw Object.assign(new Error("Shopify fulfillment webhook is missing sllr_order_id metadata."), { status: 409 });
  }
  const order = await getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  return fulfillOrder(order.id, {
    merchantId: order.merchantId,
    actor: "shopify",
    note: "Shopify fulfillment webhook received.",
  });
}

export function shopifyRefundsCreateWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, payload: Record<string, unknown>) {
  const verifier = verifyShopifyWebhook(headers, rawBody, payload);
  return {
    product: "SLL-R Shopify refund proof adapter",
    status: "accepted",
    verifier: verifier.mode,
    sllrOrderId: sllrOrderIdFrom(payload),
    shopifyRefundId: String(payload.admin_graphql_api_id || payload.id || "shopify_refund"),
    note: "Refund receipt reversal is recorded as a future adapter path; no receipt mutation is performed yet.",
  };
}
