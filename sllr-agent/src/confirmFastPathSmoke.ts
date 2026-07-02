import assert from "node:assert/strict";
import { pendingConfirmFromQuoteResult, isPureConfirmation, isConfirmExpired, createOrderArgs, isEtaReconfirm } from "./confirmFastPath.js";

// A realistic quote_order tool result (rail shape incl. the request echo).
const quoteResult = {
  product: "SLL-R merchant quote",
  quoteId: "quote_abc",
  amountUsd: "5.75",
  etaMinutes: 2,
  expiresAt: "2999-01-01T00:00:00.000Z",
  confirmationText: "CONFIRM $5.75 Fruit Tea at Game Day Boba Bar",
  request: { userIntent: "fruit tea", deadlineMinutes: 10 },
  quote: { feasible: true, merchant: { id: "game-day-boba" }, item: { name: "Fruit Tea" } },
};

// 1. Full tool result → armed pending confirm.
const p = pendingConfirmFromQuoteResult(quoteResult);
assert.ok(p, "full quote result must arm the fast-path");
assert.equal(p!.merchantId, "game-day-boba");
assert.equal(p!.userIntent, "fruit tea");
assert.equal(p!.deadlineMinutes, 10);

// 2. Partial results must NOT arm it (fall back to the LLM path).
assert.equal(pendingConfirmFromQuoteResult({ ...quoteResult, request: undefined }), null, "no request echo → no fast-path");
assert.equal(pendingConfirmFromQuoteResult({ ...quoteResult, quoteId: undefined }), null);
assert.equal(pendingConfirmFromQuoteResult({ ...quoteResult, quote: { ...quoteResult.quote, feasible: false } }), null, "infeasible quote → no fast-path");

// 3. Pure confirmation is NARROW: bare confirmations + the exact phrase only.
for (const yes of ["1", "yes", "Confirm", " ok ", "確認", "CONFIRM $5.75 Fruit Tea at Game Day Boba Bar"]) {
  assert.ok(isPureConfirmation(yes, p!.confirmationText), `"${yes}" should confirm`);
}
for (const no of ["yes but oat milk", "2", "confirm the taro instead", "", "what's my order?"]) {
  assert.ok(!isPureConfirmation(no, p!.confirmationText), `"${no}" must go to the LLM`);
}

// 4. Expiry: a stale quote never fast-path orders.
assert.equal(isConfirmExpired(p!, "2998-12-31T23:59:00.000Z"), false);
assert.equal(isConfirmExpired({ ...p!, expiresAt: "2020-01-01T00:00:00.000Z" }), true);

// 5. create_order args carry the full request + consent; acceptDelay only after
//    the ETA gate armed it.
const args = createOrderArgs(p!, "cons_1");
assert.deepEqual(args, {
  merchantId: "game-day-boba",
  userIntent: "fruit tea",
  quoteId: "quote_abc",
  consentId: "cons_1",
  customerLabel: "iMessage confirm",
  deadlineMinutes: 10,
});
assert.equal(createOrderArgs({ ...p!, acceptDelay: true }, "cons_1").acceptDelay, true);

// 6. Only the rail's ETA-gate error is handled in-path.
assert.ok(isEtaReconfirm(new Error("Wait is now ~17 min — ... Re-confirm with acceptDelay: true ...")));
assert.ok(!isEtaReconfirm(new Error("Unknown quote: quote_abc")));

console.log("confirmFastPath smoke passed");
