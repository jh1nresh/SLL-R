import assert from "node:assert/strict";
import { clampEnvelope } from "./claimClamp.js";
import { renderEnvelopeToSendblueMessages } from "./iMessageRenderer.js";
import { parseEnvelope, type SllrResponseEnvelope } from "./responseContract.js";

const quote = parseEnvelope(JSON.stringify({
  version: "sllr.response.v0",
  conversationId: "+15550001111",
  channel: "imessage",
  merchantId: "raposa-coffee",
  claimLevel: "quote_created",
  blocks: [
    { type: "MerchantSummary", merchantId: "raposa-coffee", name: "Raposa Coffee" },
    { type: "ItemList", items: [{ itemId: "iced-latte", name: "Iced latte", quantity: 1, unitPrice: "$6.50" }] },
    { type: "QuoteSummary", quoteId: "quote_1", subtotal: "$6.50", total: "$6.50", currency: "USD" },
    { type: "ConsentPrompt", quoteId: "quote_1", confirmationText: "Reply 1 to confirm." },
  ],
  actions: [{ id: "confirm_quote", label: "Confirm and get pay link", quoteId: "quote_1", confirmationText: "CONFIRM $6.50" }],
  receipts: [{ kind: "quote", id: "quote_1", status: "verified" }],
  guardrails: { requiresExplicitConsent: true, highestAllowedClaim: "quote_created", sourceQuoteId: "quote_1" },
}), { conversationId: "+15550001111", channel: "imessage" });

assert.equal(quote.claimLevel, "quote_created");
const quoteWithoutProof = clampEnvelope(quote);
assert.equal(quoteWithoutProof.claimLevel, "chat_only");
const quoteWithProof = clampEnvelope(quote, { quoteId: "quote_1" });
assert.equal(quoteWithProof.claimLevel, "quote_created");
assert.match(renderEnvelopeToSendblueMessages(quoteWithProof)[0]?.content ?? "", /Raposa Coffee/);
assert.match(renderEnvelopeToSendblueMessages(quoteWithProof)[0]?.content ?? "", /Confirm and get pay link/);

const overclaim: SllrResponseEnvelope = {
  version: "sllr.response.v0",
  conversationId: "+15550001111",
  channel: "imessage",
  claimLevel: "receipt_issued",
  blocks: [
    { type: "PlainText", text: "Payment received. Receipt issued." },
    { type: "ReceiptLink", receiptId: "rcpt_fake", url: "https://sll-r.vercel.app/receipts/rcpt_fake" },
  ],
  actions: [{ id: "open_receipt", label: "Open receipt", receiptId: "rcpt_fake", url: "https://sll-r.vercel.app/receipts/rcpt_fake" }],
  receipts: [{ kind: "receipt", id: "rcpt_fake", status: "verified" }],
  guardrails: { requiresExplicitConsent: true, highestAllowedClaim: "receipt_issued" },
};

const clamped = clampEnvelope(overclaim, { orderId: "ord_1" });
const rendered = renderEnvelopeToSendblueMessages(clamped)[0]?.content ?? "";
assert.equal(clamped.claimLevel, "order_created");
assert.doesNotMatch(rendered, /Receipt: https:/);
assert.doesNotMatch(rendered, /Open receipt/);
assert.match(rendered, /one more confirmed detail/);

const freeTextOverclaim = clampEnvelope(parseEnvelope("Payment received. Receipt issued.", { conversationId: "+15550001111", channel: "imessage" }));
const freeTextRendered = renderEnvelopeToSendblueMessages(freeTextOverclaim)[0]?.content ?? "";
assert.equal(freeTextOverclaim.claimLevel, "chat_only");
assert.doesNotMatch(freeTextRendered, /Payment received/);
assert.match(freeTextRendered, /one more confirmed detail/);

const invalidClaim = parseEnvelope(JSON.stringify({
  version: "sllr.response.v0",
  conversationId: "imessage",
  channel: "imessage",
  claimLevel: "assistant_direct_suggestion",
  blocks: [{ type: "PlainText", text: "How about a Cold brew ($5.75) from Raposa Coffee?" }],
  actions: [],
  receipts: [],
  guardrails: { requiresExplicitConsent: true, highestAllowedClaim: "assistant_direct_suggestion" },
}), { conversationId: "+15550001111", channel: "imessage" });
assert.equal(invalidClaim.claimLevel, "chat_only");
assert.equal(renderEnvelopeToSendblueMessages(invalidClaim)[0]?.content, "How about a Cold brew ($5.75) from Raposa Coffee?");

const receipt = clampEnvelope(overclaim, { orderId: "ord_1", paymentVerified: true, receiptUrl: "https://sll-r.vercel.app/receipts/rcpt_1", receiptId: "rcpt_1" });
assert.equal(receipt.claimLevel, "receipt_issued");
assert.match(renderEnvelopeToSendblueMessages(receipt)[0]?.content ?? "", /Receipt:/);

// Pilot-closure Gap 4: the exact unsupported levels an earlier audit observed
// ("quote", "quote_result") must clamp to chat_only — never leak as commerce
// claims that weaken the overclaim guard.
for (const bad of ["quote", "quote_result"]) {
  const env = parseEnvelope(JSON.stringify({
    version: "sllr.response.v0",
    conversationId: "imessage",
    channel: "imessage",
    claimLevel: bad,
    blocks: [{ type: "PlainText", text: "Cold brew is $5.75." }],
    actions: [],
    receipts: [],
    guardrails: { requiresExplicitConsent: true, highestAllowedClaim: bad },
  }), { conversationId: "+15550001111", channel: "imessage" });
  assert.equal(env.claimLevel, "chat_only", `unsupported claimLevel "${bad}" must clamp to chat_only`);
}

console.log("SLL-R response contract smoke passed");
