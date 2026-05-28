import { createHash } from "node:crypto";
import { attachPaymentProof, getOrder } from "../core/orders.js";
import { merchantForId, merchantProfiles } from "../merchants/profiles.js";
import type { PaymentRail, SellerOrder } from "../types.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value = value / 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function orderReference(orderId: string) {
  return encodeBase58(createHash("sha256").update(`sllr:solana-pay:${orderId}`).digest());
}

function solanaAddressEnv() {
  const value = (process.env.SLLR_SOLANA_PAY_RECIPIENT || process.env.JIAGON_SOLANA_PAY_RECIPIENT || "").trim();
  if (!value) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw Object.assign(new Error("SLLR_SOLANA_PAY_RECIPIENT must be a Solana base58 address."), { status: 500 });
  }
  return value;
}

function splTokenEnv() {
  const value = (process.env.SLLR_SOLANA_PAY_SPL_TOKEN || process.env.JIAGON_SOLANA_PAY_SPL_TOKEN || "").trim();
  if (!value) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    throw Object.assign(new Error("SLLR_SOLANA_PAY_SPL_TOKEN must be a Solana base58 mint address."), { status: 500 });
  }
  return value;
}

function helioCheckoutBaseUrl() {
  const value = (process.env.SLLR_HELIO_CHECKOUT_BASE_URL || "").trim();
  return value || null;
}

function amountForUrl(amountUsd: string) {
  return Number(amountUsd).toFixed(2);
}

function solanaPayUrl(order: SellerOrder, recipient: string, reference: string) {
  const params = new URLSearchParams({
    amount: amountForUrl(order.item.subtotalUsd),
    reference,
    label: order.merchantName,
    message: `${order.merchantName}: ${order.item.quantity}x ${order.item.name}`,
    memo: `sllr:${order.id}`,
  });
  const splToken = splTokenEnv();
  if (splToken) params.set("spl-token", splToken);
  return `solana:${recipient}?${params.toString()}`;
}

function helioCheckoutUrl(order: SellerOrder, reference: string) {
  const base = helioCheckoutBaseUrl();
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set("orderId", order.id);
  url.searchParams.set("merchantId", order.merchantId);
  url.searchParams.set("amountUsd", order.item.subtotalUsd);
  url.searchParams.set("reference", reference);
  url.searchParams.set("item", order.item.name);
  return url.toString();
}

function requireSolanaOrder(orderId: string) {
  const order = getOrder(orderId);
  if (!order) throw Object.assign(new Error(`Unknown order: ${orderId}`), { status: 404 });
  const merchant = merchantForId(order.merchantId);
  if (!merchant || (!merchant.paymentRails.includes("solana_pay") && !merchant.paymentRails.includes("helio"))) {
    throw Object.assign(new Error(`Order ${orderId} is not for a Solana-payable merchant.`), { status: 404 });
  }
  return order;
}

export function solanaPayMerchants(origin: string) {
  return {
    product: "SLL-R Solana payment adapter",
    docsUrl: "https://github.com/JhiNResH/SLL-R/blob/main/docs/solana-pay-demo-runbook.md",
    manifestUrl: `${origin}/.well-known/sllr-agent.json`,
    merchants: Object.values(merchantProfiles)
      .filter((merchant) => merchant.paymentRails.includes("solana_pay") || merchant.paymentRails.includes("helio"))
      .map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        category: merchant.category,
        location: merchant.location,
        fulfillment: merchant.fulfillment,
        paymentRails: merchant.paymentRails,
      })),
  };
}

export function solanaPayPreparePayment(orderId: string) {
  const order = requireSolanaOrder(orderId);
  const reference = orderReference(order.id);
  const recipient = solanaAddressEnv();
  const helioUrl = helioCheckoutUrl(order, reference);

  if (!recipient && !helioUrl) {
    return {
      product: "SLL-R Solana payment adapter",
      mode: "setup_required",
      orderId: order.id,
      amountUsd: order.item.subtotalUsd,
      reference,
      reason: "Set SLLR_SOLANA_PAY_RECIPIENT for Solana Pay URLs or SLLR_HELIO_CHECKOUT_BASE_URL for Helio checkout handoff.",
    };
  }

  return {
    product: "SLL-R Solana payment adapter",
    mode: recipient ? "solana_pay_url" : "helio_checkout_handoff",
    orderId: order.id,
    merchantId: order.merchantId,
    amountUsd: order.item.subtotalUsd,
    reference,
    recipient,
    splToken: splTokenEnv(),
    solanaPayUrl: recipient ? solanaPayUrl(order, recipient, reference) : null,
    helioCheckoutHandoff: helioUrl
      ? {
        type: "helio_checkout",
        url: helioUrl,
        instruction: "Open Helio / MoonPay Commerce checkout, then attach the verified payment webhook or transaction proof to SLL-R.",
      }
      : null,
    paymentProofStatus: "pending_webhook_or_reference_verification",
  };
}

function secretFrom(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const header = headers[name.toLowerCase()];
    if (typeof header === "string" && header.trim()) return header.trim();
    const value = body[name] || body[name.replace(/^x-/, "")];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function requireVerifier(headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>, envName: string, headerNames: string[]) {
  const expected = process.env[envName]?.trim();
  if (!expected) {
    if (body.demo === true) return { mode: "demo" as const };
    throw Object.assign(new Error(`${envName} is not configured. Send demo=true for local demos, or configure a verifier secret before accepting external payment proof.`), { status: 403 });
  }
  const received = secretFrom(headers, body, headerNames);
  if (received !== expected) {
    throw Object.assign(new Error("Payment proof verifier secret is missing or invalid."), { status: 401 });
  }
  return { mode: "secret" as const };
}

export async function solanaPayVerifyPayment(headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>) {
  const orderId = String(payload.orderId || "");
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  const order = requireSolanaOrder(orderId);
  const reference = String(payload.reference || "");
  if (!reference) throw Object.assign(new Error("Missing payment reference."), { status: 400 });
  if (reference && reference !== orderReference(order.id)) {
    throw Object.assign(new Error("Payment reference does not match this SLL-R order."), { status: 409 });
  }

  const provider = (payload.provider === "helio" ? "helio" : "solana_pay") satisfies PaymentRail;
  const verifier = requireVerifier(headers, payload, "SLLR_SOLANA_PAY_VERIFY_SECRET", [
    "x-sllr-solana-pay-secret",
    "x-sllr-payment-secret",
    "verificationToken",
  ]);
  const paymentId = String(payload.paymentId || payload.signature || `${provider}_${verifier.mode}_${order.id}`);

  return attachPaymentProof({
    orderId: order.id,
    merchantId: String(payload.merchantId || order.merchantId),
    provider,
    amountUsd: String(payload.amountUsd || order.item.subtotalUsd),
    paymentId,
  });
}

export async function helioWebhook(headers: Record<string, string | string[] | undefined>, payload: Record<string, unknown>) {
  const verifier = requireVerifier(headers, payload, "SLLR_HELIO_WEBHOOK_SECRET", [
    "x-helio-webhook-secret",
    "x-sllr-helio-secret",
    "verificationToken",
  ]);
  const orderId = String(payload.orderId || "");
  if (!orderId) throw Object.assign(new Error("Missing orderId."), { status: 400 });
  const order = requireSolanaOrder(orderId);
  const reference = String(payload.reference || "");
  if (reference && reference !== orderReference(order.id)) {
    throw Object.assign(new Error("Payment reference does not match this SLL-R order."), { status: 409 });
  }

  return attachPaymentProof({
    orderId: order.id,
    merchantId: String(payload.merchantId || order.merchantId),
    provider: "helio",
    amountUsd: String(payload.amountUsd || order.item.subtotalUsd),
    paymentId: String(payload.paymentId || payload.transactionId || payload.id || `helio_${verifier.mode}_${order.id}`),
  });
}
