import { createHash } from "node:crypto";
import type { ReceiptHandoff, SellerOrder } from "../types.js";

function publicOrigin() {
  if (process.env.SLLR_PUBLIC_ORIGIN) return process.env.SLLR_PUBLIC_ORIGIN;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.SLLR_PORT || 3100}`;
}

export async function issueSllrReceipt(order: SellerOrder): Promise<ReceiptHandoff> {
  const receiptApiUrl = (process.env.SLLR_RECEIPT_API_URL || "").trim();
  const receiptApiKey = (process.env.SLLR_RECEIPT_API_KEY || "").trim();
  const receiptHash = createHash("sha256")
    .update(`${order.id}:${order.merchantId}:${order.item.subtotalUsd}:${order.payment.paymentId || "manual"}:${order.promise.promisedReadyAt || ""}:${order.promise.readyAt || ""}:${order.promise.claimedAt || ""}`)
    .digest("hex");

  if (!receiptApiUrl) {
    return {
      status: "stubbed",
      receiptMemoryId: `stub_${order.id}`,
      receiptHash,
      claimUrl: `${publicOrigin()}/receipts/${order.id}`,
      cnftStatus: "ready_for_mint",
    };
  }

  const response = await fetch(receiptApiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(receiptApiKey ? { authorization: `Bearer ${receiptApiKey}` } : {}),
    },
    body: JSON.stringify({
      merchantId: order.merchantId,
      merchantName: order.merchantName,
      receiptNumber: order.id,
      buyerId: order.buyerId,
      amountUsd: order.item.subtotalUsd,
      category: order.item.name,
      purpose: "sllr_seller_agent_order",
      paymentProvider: order.payment.provider,
      paymentId: order.payment.paymentId,
      servicePromise: order.promise,
    }),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "SLL-R receipt handoff failed.");
  }

  return {
    status: "submitted",
    receiptMemoryId: String(payload.receiptId || payload.id || `sllr_${order.id}`),
    receiptHash: String(payload.receiptHash || receiptHash),
    claimUrl: String(payload.claimUrl || `${publicOrigin()}/receipts/${order.id}`),
    cnftStatus: "ready_for_mint",
  };
}
