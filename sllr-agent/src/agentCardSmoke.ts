import assert from "node:assert/strict";
import { onboardingStep, parseMerchantContext, agentConstraintPreamble, type AgentCard } from "./agentCard.js";

const now = "2026-06-17T00:00:00.000Z";
const user = "+15550001111";
const merchant = "game-day-boba";
const mname = "Game Day Boba Bar";

// QR context parse.
assert.equal(parseMerchantContext("start merchant:game-day-boba"), "game-day-boba");
assert.equal(parseMerchantContext("merchant: Raposa-Coffee"), "raposa-coffee");
assert.equal(parseMerchantContext("what can I get in 10 min"), null);

// Step 0: first contact greets + asks Q1, does not consume the text as an answer.
let r = onboardingStep(null, "start merchant:game-day-boba", user, merchant, mname, now);
assert.equal(r.done, false);
assert.equal(r.card.step, 1);
assert.ok(r.reply.includes("AI order lane") && r.reply.includes("1/3"));

// Unparseable answer re-asks the same step.
const stuck = onboardingStep(r.card, "uhh", user, merchant, mname, now);
assert.equal(stuck.card.step, 1);
assert.ok(stuck.reply.includes("reply with a number"));

// Q1 → max $15.
r = onboardingStep(r.card, "2", user, merchant, mname, now);
assert.equal(r.card.maxAmountUsd, "15.00");
assert.equal(r.card.step, 2);

// Q2 → ask before every payment.
r = onboardingStep(r.card, "1", user, merchant, mname, now);
assert.equal(r.card.requiresConfirmation, "always");
assert.equal(r.card.step, 3);

// Q3 → avoid caffeine → card active + confirmation.
r = onboardingStep(r.card, "2", user, merchant, mname, now);
assert.equal(r.done, true);
assert.equal(r.card.status, "active");
assert.deepEqual(r.card.avoid, ["caffeine"]);
assert.ok(r.reply.includes("Agent Card ready") && r.reply.includes("$15.00/order") && r.reply.includes("caffeine"));

// Active-card constraints ride along on the agent turn.
const card: AgentCard = r.card;
const preamble = agentConstraintPreamble(card, mname);
assert.ok(preamble.includes("max $15.00/order") && preamble.includes("avoid: caffeine"));

console.log("agentCard smoke passed");
