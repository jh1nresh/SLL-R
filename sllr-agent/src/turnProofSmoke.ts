import assert from "node:assert/strict";
import type { SllrStateProof } from "./claimClamp.js";
import { recordTurnProof } from "./turnProof.js";

const proofs = new Map<string, SllrStateProof>([["buyer", {}]]);
recordTurnProof(proofs, "buyer", "quote_order", { quoteId: "quote_1" });
assert.equal(proofs.get("buyer")?.quoteId, "quote_1");

recordTurnProof(proofs, "buyer", "create_order", {
  order: { id: "ord_1", payment: { status: "pending" } },
});
assert.equal(proofs.get("buyer")?.orderId, "ord_1");
assert.equal(proofs.get("buyer")?.paymentVerified, undefined);

recordTurnProof(proofs, "buyer", "check_order_status", {
  order: {
    id: "ord_1",
    status: "receipt_issued",
    payment: { status: "verified" },
    receipt: { receiptMemoryId: "receipt_1", claimUrl: "https://example.test/receipt", receiptHash: "hash_1" },
  },
});
assert.equal(proofs.get("buyer")?.paymentVerified, true);
assert.equal(proofs.get("buyer")?.receiptId, "receipt_1");
assert.equal(proofs.get("buyer")?.receiptUrl, "https://example.test/receipt");
assert.equal(proofs.get("buyer")?.receiptHash, "hash_1");

process.stdout.write("turnProof smoke passed\n");
