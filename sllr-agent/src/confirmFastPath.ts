// Deterministic confirm fast-path: when the buyer's whole message is a pure
// confirmation of the quote we just showed, skip the LLM and drive
// request_consent → create_order directly.
//
// Safety model: the pending-confirm state comes from the quote_order TOOL RESULT
// (server-side truth — the rail echoes the order params), never from LLM-authored
// text, so the fast-path cannot order something the rail didn't quote. The
// consent receipt is granted from the buyer's REAL message. Payment still goes
// through the normal options/links — this path creates the order only.

export type PendingConfirm = {
  quoteId: string;
  merchantId: string;
  userIntent: string;
  confirmationText: string;
  expiresAt: string;
  amountUsd: string;
  itemName: string;
  deadlineMinutes?: number;
  maxSpendUsd?: string;
  deliverByDays?: number;
  quantity?: number;
  // Set after the rail's ETA gate 409s: the next pure confirm re-confirms the
  // longer wait explicitly.
  acceptDelay?: boolean;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!。!]+$/, "");

// Narrow on purpose: a bare confirmation word, or the exact confirmation phrase
// the quote asked for. Anything else (extra words, new constraints) goes to the
// LLM — "yes but make it oat milk" is NOT a pure confirmation.
const PURE_CONFIRMATIONS = new Set(["1", "yes", "confirm", "ok", "好", "好的", "確認"]);
export function isPureConfirmation(text: string, confirmationText: string): boolean {
  const t = norm(text);
  if (!t) return false;
  return PURE_CONFIRMATIONS.has(t) || t === norm(confirmationText);
}

export function isConfirmExpired(p: PendingConfirm, nowIso: string = new Date().toISOString()): boolean {
  return new Date(p.expiresAt).getTime() <= new Date(nowIso).getTime();
}

// Build the pending-confirm state from a quote_order tool result. Returns null
// unless the result carries everything the fast-path needs (feasible stored
// quote + the rail's request echo) — partial data falls back to the LLM path.
export function pendingConfirmFromQuoteResult(result: unknown): PendingConfirm | null {
  const r = result as {
    quoteId?: string;
    amountUsd?: string;
    expiresAt?: string;
    confirmationText?: string;
    request?: { userIntent?: string; deadlineMinutes?: number; maxSpendUsd?: string; deliverByDays?: number; quantity?: number };
    quote?: { feasible?: boolean; merchant?: { id?: string }; item?: { name?: string } };
  } | null | undefined;
  if (!r || typeof r !== "object") return null;
  const quoteId = typeof r.quoteId === "string" ? r.quoteId : "";
  const merchantId = typeof r.quote?.merchant?.id === "string" ? r.quote.merchant.id : "";
  const userIntent = typeof r.request?.userIntent === "string" ? r.request.userIntent.trim() : "";
  const confirmationText = typeof r.confirmationText === "string" ? r.confirmationText : "";
  const expiresAt = typeof r.expiresAt === "string" ? r.expiresAt : "";
  if (!quoteId || !merchantId || !userIntent || !confirmationText || !expiresAt || r.quote?.feasible !== true) return null;
  return {
    quoteId,
    merchantId,
    userIntent,
    confirmationText,
    expiresAt,
    amountUsd: typeof r.amountUsd === "string" ? r.amountUsd : "?",
    itemName: typeof r.quote?.item?.name === "string" ? r.quote.item.name : "your order",
    ...(typeof r.request?.deadlineMinutes === "number" ? { deadlineMinutes: r.request.deadlineMinutes } : {}),
    ...(typeof r.request?.maxSpendUsd === "string" ? { maxSpendUsd: r.request.maxSpendUsd } : {}),
    ...(typeof r.request?.deliverByDays === "number" ? { deliverByDays: r.request.deliverByDays } : {}),
    ...(typeof r.request?.quantity === "number" ? { quantity: r.request.quantity } : {}),
  };
}

// The create_order args for a pending confirm (consentId from request_consent).
export function createOrderArgs(p: PendingConfirm, consentId: string): Record<string, unknown> {
  return {
    merchantId: p.merchantId,
    userIntent: p.userIntent,
    quoteId: p.quoteId,
    consentId,
    customerLabel: "iMessage confirm",
    ...(p.deadlineMinutes !== undefined ? { deadlineMinutes: p.deadlineMinutes } : {}),
    ...(p.maxSpendUsd !== undefined ? { maxSpendUsd: p.maxSpendUsd } : {}),
    ...(p.deliverByDays !== undefined ? { deliverByDays: p.deliverByDays } : {}),
    ...(p.quantity !== undefined ? { quantity: p.quantity } : {}),
    ...(p.acceptDelay ? { acceptDelay: true } : {}),
  };
}

// The rail's ETA gate rejection — the one failure the fast-path handles itself
// (re-confirm the longer wait); everything else falls back to the LLM.
export function isEtaReconfirm(error: unknown): boolean {
  return error instanceof Error && /acceptDelay/i.test(error.message);
}
