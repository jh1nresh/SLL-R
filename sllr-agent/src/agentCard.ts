// SLL-R Agent Card (spec: imessage-agent-card-merchant-outreach, Phase 1).
//
// A bounded per-merchant ordering authorization — NOT a real card and NOT KYC.
// "Set up my AI ordering permissions for this shop." First contact with a shop
// runs a 3-step quick-choice onboarding; once active, the card's constraints ride
// along on every agent turn for that merchant. Payment is hybrid: the card lists
// preferred rails but the buyer still picks/confirms at checkout.

export type AgentCard = {
  channelUserId: string;
  merchantId: string;
  status: "draft" | "active" | "revoked";
  step: 0 | 1 | 2 | 3; // onboarding progress; 3 = complete
  maxAmountUsd: string | null; // null = ask every time
  requiresConfirmation: "always" | "above_limit" | "counter_only";
  avoid: string[];
  paymentRailPreference: string[]; // hybrid — surfaced at checkout, buyer chooses
  createdAt: string;
  updatedAt: string;
};

export function cardKey(channelUserId: string, merchantId: string): string {
  return `${channelUserId}|${merchantId}`;
}

// Pull a merchant context out of a QR-seeded message: "merchant:<id>" or
// "start merchant:<id>". Returns null when none (free-form chat).
export function parseMerchantContext(text: string): string | null {
  const m = text.match(/(?:^|\b)(?:start\s+)?merchant[:\s]+([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1].toLowerCase() : null;
}

function freshCard(channelUserId: string, merchantId: string, nowIso: string): AgentCard {
  return {
    channelUserId, merchantId, status: "draft", step: 0,
    maxAmountUsd: null, requiresConfirmation: "always", avoid: [],
    paymentRailPreference: ["counter", "stripe", "solana_pay", "base_usdc"],
    createdAt: nowIso, updatedAt: nowIso,
  };
}

const Q1 = "Before I recommend/order, a quick setup for this shop.\n\n1/3 Max per order?\n1  $10\n2  $15\n3  $25\n4  Ask every time\n5  Skip setup — defaults ($15 max, ask before paying)";
const Q2 = "2/3 Payment approval?\n1  Ask before every payment\n2  Auto-approve under your max today\n3  Order draft only — I'll pay at counter";
const Q3 = "3/3 Anything to avoid?\n1  Too spicy\n2  Caffeine\n3  Dairy\n4  None";

function choice(text: string): number | null {
  const m = text.trim().match(/^([1-9])\b/);
  return m ? Number(m[1]) : null;
}

export type OnboardingResult = { card: AgentCard; reply: string; done: boolean };

// Advance onboarding one step from the buyer's message. Returns the updated card,
// the reply to send, and whether onboarding is complete (done → next message
// goes to the normal agent). Unparseable answers re-ask the current step.
export function onboardingStep(existing: AgentCard | null, text: string, channelUserId: string, merchantId: string, merchantName: string, nowIso: string): OnboardingResult {
  const card = existing ? { ...existing, updatedAt: nowIso } : freshCard(channelUserId, merchantId, nowIso);

  // step 0: first contact — greet + ask Q1 (don't consume their first words as an answer).
  if (card.step === 0) {
    card.step = 1;
    return { card, reply: `Hi — I'm ${merchantName}'s AI order lane.\n\n${Q1}`, done: false };
  }
  const c = choice(text);
  if (c === null) {
    const reAsk = card.step === 1 ? Q1 : card.step === 2 ? Q2 : Q3;
    return { card, reply: `Please reply with a number.\n\n${reAsk}`, done: false };
  }
  if (card.step === 1) {
    // "5 Skip" — the rush-window user has 8 minutes, not 3 questions. Safe
    // defaults: $15 cap, ask before every payment, no avoids.
    if (c === 5) {
      card.maxAmountUsd = "15.00";
      card.requiresConfirmation = "always";
      card.avoid = [];
      card.step = 3;
      card.status = "active";
      return { card, reply: summarizeCard(card, merchantName), done: true };
    }
    card.maxAmountUsd = c === 1 ? "10.00" : c === 2 ? "15.00" : c === 3 ? "25.00" : null;
    card.step = 2;
    return { card, reply: Q2, done: false };
  }
  if (card.step === 2) {
    card.requiresConfirmation = c === 1 ? "always" : c === 2 ? "above_limit" : "counter_only";
    card.step = 3;
    return { card, reply: Q3, done: false };
  }
  // step 3 → complete
  card.avoid = c === 1 ? ["spicy"] : c === 2 ? ["caffeine"] : c === 3 ? ["dairy"] : [];
  card.step = 3;
  card.status = "active";
  return { card, reply: summarizeCard(card, merchantName), done: true };
}

export function summarizeCard(card: AgentCard, merchantName: string): string {
  const max = card.maxAmountUsd ? `$${card.maxAmountUsd}/order` : "ask every time";
  const pay = card.requiresConfirmation === "always" ? "ask before every payment"
    : card.requiresConfirmation === "above_limit" ? `auto-approve under ${max}`
    : "order draft only, pay at counter";
  const avoid = card.avoid.length ? card.avoid.join(", ") : "nothing";
  return `✅ Agent Card ready for ${merchantName}\n- Max: ${max}\n- Payment: ${pay}\n- Avoid: ${avoid}\n\nTry: "I have 8 minutes. What can I get?"`;
}

// Constraint preamble injected into the agent turn once the card is active.
export function agentConstraintPreamble(card: AgentCard, merchantName: string): string {
  const parts = [`Agent Card for ${merchantName} (${card.merchantId})`];
  if (card.maxAmountUsd) parts.push(`max $${card.maxAmountUsd}/order`);
  if (card.avoid.length) parts.push(`avoid: ${card.avoid.join(", ")}`);
  if (card.requiresConfirmation === "counter_only") parts.push("draft only, pay at counter");
  return `[${parts.join("; ")}. Stay within these and prefer this merchant.]\n`;
}
