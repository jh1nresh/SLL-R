import { createHash } from "node:crypto";
import type { ReceiptHandoff, SellerOrder } from "../types.js";

function publicOrigin() {
  return process.env.SLLR_PUBLIC_ORIGIN || `http://localhost:${process.env.SLLR_PORT || 3100}`;
}

export async function issueJiagonReceipt(order: SellerOrder): Promise<ReceiptHandoff> {
  const receiptApiUrl = (process.env.JIAGON_RECEIPT_API_URL || "").trim();
  const receiptHash = createHash("sha256")
    .update(`${order.id}:${order.merchantId}:${order.item.subtotalUsd}:${order.payment.paymentId || "manual"}:${order.promise.promisedReadyAt || ""}:${order.promise.readyAt || ""}:${order.promise.claimedAt || ""}`)
    .digest("hex");

  if (!receiptApiUrl) {
    return {
      status: "stubbed",
      jiagonReceiptId: `stub_${order.id}`,
      receiptHash,
      claimUrl: `${publicOrigin()}/receipts/${order.id}`,
      cnftStatus: "ready_for_mint",
    };
  }

  const response = await fetch(receiptApiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.JIAGON_RECEIPT_API_KEY ? { authorization: `Bearer ${process.env.JIAGON_RECEIPT_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      merchantId: order.merchantId,
      merchantName: order.merchantName,
      receiptNumber: order.id,
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
    throw new Error(typeof payload.error === "string" ? payload.error : "Jiagon receipt handoff failed.");
  }

  return {
    status: "submitted",
    jiagonReceiptId: String(payload.receiptId || payload.id || `jiagon_${order.id}`),
    receiptHash: String(payload.receiptHash || receiptHash),
    claimUrl: String(payload.claimUrl || `${publicOrigin()}/receipts/${order.id}`),
    cnftStatus: "ready_for_mint",
  };
}
