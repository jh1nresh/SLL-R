import { claimRank, minClaim, type ClaimLevel, type SllrBlock, type SllrResponseEnvelope } from "./responseContract.js";

export type SllrStateProof = {
  quoteId?: string;
  orderId?: string;
  paymentVerified?: boolean;
  merchantStatus?: "accepted" | "ready" | "fulfilled";
  receiptId?: string;
  receiptUrl?: string;
  receiptHash?: string;
};

export function clampEnvelope(envelope: SllrResponseEnvelope, state: SllrStateProof = {}): SllrResponseEnvelope {
  const proved = provedClaim(state);
  const allowed = minClaim(envelope.guardrails.highestAllowedClaim, proved);
  if (claimRank(envelope.claimLevel) <= claimRank(allowed) && hasRequiredBlocks(envelope.blocks, allowed) && !hasUnsafePlainText(envelope.blocks, allowed)) {
    return { ...envelope, claimLevel: envelope.claimLevel, guardrails: { ...envelope.guardrails, highestAllowedClaim: allowed } };
  }
  const safeBlocks = downgradeBlocks(envelope.blocks, allowed, state);
  return {
    ...envelope,
    claimLevel: allowed,
    blocks: safeBlocks.length > 0 ? safeBlocks : [{ type: "PlainText", text: "I need one more confirmed detail before I can say that." }],
    actions: envelope.actions.filter((action) => actionIsAllowed(action.id, allowed)),
    receipts: envelope.receipts.filter((receipt) => receipt.status !== "verified" || claimRank(allowed) >= claimRank("receipt_issued")),
    guardrails: { ...envelope.guardrails, highestAllowedClaim: allowed },
  };
}

function provedClaim(state: SllrStateProof): ClaimLevel {
  if (state.receiptId || state.receiptUrl || state.receiptHash) return "receipt_issued";
  if (state.merchantStatus === "fulfilled") return "fulfilled";
  if (state.merchantStatus === "ready") return "ready";
  if (state.merchantStatus === "accepted") return "merchant_accepted";
  if (state.paymentVerified) return "payment_verified";
  if (state.orderId) return "order_created";
  if (state.quoteId) return "quote_created";
  return "chat_only";
}

function hasRequiredBlocks(blocks: SllrBlock[], allowed: ClaimLevel): boolean {
  if (claimRank(allowed) >= claimRank("payment_verified") && !blocks.some((b) => b.type === "OrderStatus")) return false;
  if (claimRank(allowed) >= claimRank("receipt_issued") && !blocks.some((b) => b.type === "ReceiptLink")) return false;
  return true;
}

function downgradeBlocks(blocks: SllrBlock[], allowed: ClaimLevel, state: SllrStateProof): SllrBlock[] {
  const out: SllrBlock[] = [];
  for (const block of blocks) {
    if (block.type === "PaymentLink" && claimRank(allowed) < claimRank("payment_pending")) continue;
    if (block.type === "ReceiptLink" && claimRank(allowed) < claimRank("receipt_issued")) continue;
    if (block.type === "OrderStatus" && claimRank(allowed) < claimRank("order_created")) continue;
    if (block.type === "PlainText" && textExceedsClaim(block.text, allowed)) continue;
    out.push(block);
  }
  if (claimRank(allowed) < claimRank("payment_verified") && blocks.some((b) => b.type === "ReceiptLink" || b.type === "PaymentLink")) {
    out.push({ type: "PlainText", text: "I need one more confirmed detail before I can say that." });
  }
  if (claimRank(allowed) >= claimRank("receipt_issued") && state.receiptUrl && !out.some((b) => b.type === "ReceiptLink")) {
    out.push({ type: "ReceiptLink", receiptId: state.receiptId ?? "receipt", url: state.receiptUrl, receiptHash: state.receiptHash });
  }
  return out;
}

function hasUnsafePlainText(blocks: SllrBlock[], allowed: ClaimLevel): boolean {
  return blocks.some((block) => block.type === "PlainText" && textExceedsClaim(block.text, allowed));
}

function textExceedsClaim(text: string, allowed: ClaimLevel): boolean {
  const normalized = text.toLowerCase();
  if (claimRank(allowed) < claimRank("payment_verified") && /\b(paid|payment received|payment verified|payment cleared)\b/.test(normalized)) return true;
  if (claimRank(allowed) < claimRank("ready") && /\b(ready for pickup|order is ready|it's ready|it is ready)\b/.test(normalized)) return true;
  if (claimRank(allowed) < claimRank("receipt_issued") && /\b(receipt issued|receipt is ready|receipt memory|claim receipt)\b/.test(normalized)) return true;
  return false;
}

function actionIsAllowed(id: string, allowed: ClaimLevel): boolean {
  if (id === "pay_now") return claimRank(allowed) >= claimRank("payment_pending");
  if (id === "open_receipt") return claimRank(allowed) >= claimRank("receipt_issued");
  if (id === "check_status" || id === "handoff_to_merchant") return claimRank(allowed) >= claimRank("order_created");
  return true;
}
