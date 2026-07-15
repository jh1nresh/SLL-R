import type { SllrStateProof } from "./claimClamp.js";

export function recordTurnProof(store: Map<string, SllrStateProof>, identity: string, name: string, result: unknown): void {
  const proof = store.get(identity);
  if (!proof) return;
  const value = objectRecord(result);
  if (name === "quote_order") {
    const quoteId = stringField(value, "quoteId") || stringField(objectRecord(value.persistedQuote), "id");
    if (quoteId) proof.quoteId = quoteId;
    return;
  }
  if (name === "create_order") {
    recordOrderProof(proof, objectRecord(value.order));
    return;
  }
  if (name === "check_order_status") {
    const order = objectRecord(value.order);
    recordOrderProof(proof, order);
    const status = stringField(order, "status");
    if (status === "accepted" || status === "ready" || status === "fulfilled") proof.merchantStatus = status;
    if (status === "payment_backed" || status === "receipt_issued") proof.paymentVerified = true;
  }
}

function recordOrderProof(proof: SllrStateProof, order: Record<string, unknown>): void {
  const orderId = stringField(order, "id");
  if (orderId) proof.orderId = orderId;
  if (stringField(objectRecord(order.payment), "status") === "verified") proof.paymentVerified = true;
  recordReceiptProof(proof, objectRecord(order.receipt));
}

function recordReceiptProof(proof: SllrStateProof, receipt: Record<string, unknown>): void {
  const receiptId = stringField(receipt, "receiptMemoryId");
  const receiptUrl = stringField(receipt, "claimUrl");
  const receiptHash = stringField(receipt, "receiptHash");
  if (receiptId) proof.receiptId = receiptId;
  if (receiptUrl) proof.receiptUrl = receiptUrl;
  if (receiptHash) proof.receiptHash = receiptHash;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}
