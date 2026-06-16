export const CLAIM_LEVELS = [
  "chat_only",
  "catalog_sourced",
  "quote_created",
  "consent_requested",
  "order_created",
  "payment_pending",
  "payment_verified",
  "merchant_accepted",
  "ready",
  "fulfilled",
  "receipt_issued",
] as const;

export type ClaimLevel = typeof CLAIM_LEVELS[number];
export type Channel = "imessage" | "sms" | "line" | "web";

export type OrderLineItem = {
  itemId: string;
  name: string;
  quantity: number;
  modifiers?: Record<string, string | number | boolean>;
  unitPrice?: string;
};

export type SllrBlock =
  | { type: "PlainText"; text: string }
  | { type: "MerchantSummary"; merchantId: string; name: string; address?: string }
  | { type: "ItemList"; items: OrderLineItem[]; unavailableItems?: string[] }
  | { type: "QuoteSummary"; quoteId: string; subtotal: string; fees?: string; total: string; currency: string; expiresAt?: string }
  | { type: "ConsentPrompt"; quoteId: string; confirmationText: string }
  | { type: "OrderStatus"; orderId: string; status: string; pickupCode?: string; etaMinutes?: number }
  | { type: "PaymentLink"; orderId: string; rail: "stripe" | "counter" | "line_pay" | "solana_pay"; url?: string; amount: string; currency: string }
  | { type: "ReceiptLink"; receiptId: string; url: string; receiptHash?: string }
  | { type: "ClarifyingQuestion"; question: string; choices?: string[] };

export type SllrAction =
  | { id: "confirm_quote"; label: string; quoteId: string; confirmationText: string }
  | { id: "edit_order"; label: string; quoteId?: string }
  | { id: "pay_now"; label: string; orderId: string; url: string }
  | { id: "check_status"; label: string; orderId: string }
  | { id: "open_receipt"; label: string; receiptId: string; url: string }
  | { id: "handoff_to_merchant"; label: string; orderId: string };

export type SllrReceiptRef = {
  kind:
    | "intent"
    | "catalog_match"
    | "quote"
    | "consent"
    | "order"
    | "payment"
    | "merchant_decision"
    | "fulfillment"
    | "receipt";
  id: string;
  status: "pending" | "verified" | "failed" | "not_applicable";
  url?: string;
  hash?: string;
};

export type SllrResponseEnvelope = {
  version: "sllr.response.v0";
  conversationId: string;
  buyerId?: string;
  channel: Channel;
  merchantId?: string;
  claimLevel: ClaimLevel;
  blocks: SllrBlock[];
  actions: SllrAction[];
  receipts: SllrReceiptRef[];
  guardrails: {
    requiresExplicitConsent: boolean;
    highestAllowedClaim: ClaimLevel;
    sourceOrderId?: string;
    sourceQuoteId?: string;
    sourceReceiptId?: string;
  };
};

export type EnvelopeFallbackContext = {
  conversationId: string;
  channel: Channel;
  buyerId?: string;
};

export function parseEnvelope(modelOutput: string, context: EnvelopeFallbackContext): SllrResponseEnvelope {
  const raw = modelOutput.trim();
  const candidate = extractJson(raw);
  if (!candidate) return plainTextEnvelope(raw, context);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return validateEnvelope(parsed);
  } catch {
    return plainTextEnvelope(raw, context);
  }
}

export function plainTextEnvelope(text: string, context: EnvelopeFallbackContext): SllrResponseEnvelope {
  return {
    version: "sllr.response.v0",
    conversationId: context.conversationId,
    buyerId: context.buyerId,
    channel: context.channel,
    claimLevel: "chat_only",
    blocks: [{ type: "PlainText", text }],
    actions: [],
    receipts: [],
    guardrails: {
      requiresExplicitConsent: true,
      highestAllowedClaim: "chat_only",
    },
  };
}

export function claimRank(level: ClaimLevel): number {
  return CLAIM_LEVELS.indexOf(level);
}

export function minClaim(a: ClaimLevel, b: ClaimLevel): ClaimLevel {
  return claimRank(a) <= claimRank(b) ? a : b;
}

function extractJson(text: string): string | null {
  if (!text) return null;
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

function validateEnvelope(value: unknown): SllrResponseEnvelope {
  const v = record(value, "envelope");
  expectStringLiteral(v.version, "sllr.response.v0", "version");
  const claimLevel = expectClaim(v.claimLevel, "claimLevel");
  const blocks = expectArray(v.blocks, "blocks").map(validateBlock);
  const actions = expectArray(v.actions, "actions").map(validateAction);
  const receipts = expectArray(v.receipts, "receipts").map(validateReceipt);
  const guard = record(v.guardrails, "guardrails");
  const highestAllowedClaim = expectClaim(guard.highestAllowedClaim, "guardrails.highestAllowedClaim");
  const channel = expectOneOf(v.channel, ["imessage", "sms", "line", "web"] as const, "channel");
  return {
    version: "sllr.response.v0",
    conversationId: expectString(v.conversationId, "conversationId"),
    buyerId: optionalString(v.buyerId, "buyerId"),
    channel,
    merchantId: optionalString(v.merchantId, "merchantId"),
    claimLevel,
    blocks,
    actions,
    receipts,
    guardrails: {
      requiresExplicitConsent: expectBoolean(guard.requiresExplicitConsent, "guardrails.requiresExplicitConsent"),
      highestAllowedClaim,
      sourceOrderId: optionalString(guard.sourceOrderId, "guardrails.sourceOrderId"),
      sourceQuoteId: optionalString(guard.sourceQuoteId, "guardrails.sourceQuoteId"),
      sourceReceiptId: optionalString(guard.sourceReceiptId, "guardrails.sourceReceiptId"),
    },
  };
}

function validateBlock(value: unknown): SllrBlock {
  const v = record(value, "block");
  const type = expectString(v.type, "block.type");
  switch (type) {
    case "PlainText": return { type, text: expectString(v.text, "block.text") };
    case "MerchantSummary": return { type, merchantId: expectString(v.merchantId, "block.merchantId"), name: expectString(v.name, "block.name"), address: optionalString(v.address, "block.address") };
    case "ItemList": return { type, items: expectArray(v.items, "block.items").map(validateItem), unavailableItems: optionalStringArray(v.unavailableItems, "block.unavailableItems") };
    case "QuoteSummary": return { type, quoteId: expectString(v.quoteId, "block.quoteId"), subtotal: expectString(v.subtotal, "block.subtotal"), fees: optionalString(v.fees, "block.fees"), total: expectString(v.total, "block.total"), currency: expectString(v.currency, "block.currency"), expiresAt: optionalString(v.expiresAt, "block.expiresAt") };
    case "ConsentPrompt": return { type, quoteId: expectString(v.quoteId, "block.quoteId"), confirmationText: expectString(v.confirmationText, "block.confirmationText") };
    case "OrderStatus": return { type, orderId: expectString(v.orderId, "block.orderId"), status: expectString(v.status, "block.status"), pickupCode: optionalString(v.pickupCode, "block.pickupCode"), etaMinutes: optionalNumber(v.etaMinutes, "block.etaMinutes") };
    case "PaymentLink": return { type, orderId: expectString(v.orderId, "block.orderId"), rail: expectOneOf(v.rail, ["stripe", "counter", "line_pay", "solana_pay"] as const, "block.rail"), url: optionalString(v.url, "block.url"), amount: expectString(v.amount, "block.amount"), currency: expectString(v.currency, "block.currency") };
    case "ReceiptLink": return { type, receiptId: expectString(v.receiptId, "block.receiptId"), url: expectString(v.url, "block.url"), receiptHash: optionalString(v.receiptHash, "block.receiptHash") };
    case "ClarifyingQuestion": return { type, question: expectString(v.question, "block.question"), choices: optionalStringArray(v.choices, "block.choices") };
    default: throw new Error(`Unknown block type: ${type}`);
  }
}

function validateAction(value: unknown): SllrAction {
  const v = record(value, "action");
  const id = expectString(v.id, "action.id");
  switch (id) {
    case "confirm_quote": return { id, label: expectString(v.label, "action.label"), quoteId: expectString(v.quoteId, "action.quoteId"), confirmationText: expectString(v.confirmationText, "action.confirmationText") };
    case "edit_order": return { id, label: expectString(v.label, "action.label"), quoteId: optionalString(v.quoteId, "action.quoteId") };
    case "pay_now": return { id, label: expectString(v.label, "action.label"), orderId: expectString(v.orderId, "action.orderId"), url: expectString(v.url, "action.url") };
    case "check_status": return { id, label: expectString(v.label, "action.label"), orderId: expectString(v.orderId, "action.orderId") };
    case "open_receipt": return { id, label: expectString(v.label, "action.label"), receiptId: expectString(v.receiptId, "action.receiptId"), url: expectString(v.url, "action.url") };
    case "handoff_to_merchant": return { id, label: expectString(v.label, "action.label"), orderId: expectString(v.orderId, "action.orderId") };
    default: throw new Error(`Unknown action id: ${id}`);
  }
}

function validateReceipt(value: unknown): SllrReceiptRef {
  const v = record(value, "receipt");
  return {
    kind: expectOneOf(v.kind, ["intent", "catalog_match", "quote", "consent", "order", "payment", "merchant_decision", "fulfillment", "receipt"] as const, "receipt.kind"),
    id: expectString(v.id, "receipt.id"),
    status: expectOneOf(v.status, ["pending", "verified", "failed", "not_applicable"] as const, "receipt.status"),
    url: optionalString(v.url, "receipt.url"),
    hash: optionalString(v.hash, "receipt.hash"),
  };
}

function validateItem(value: unknown): OrderLineItem {
  const v = record(value, "item");
  return {
    itemId: expectString(v.itemId, "item.itemId"),
    name: expectString(v.name, "item.name"),
    quantity: expectNumber(v.quantity, "item.quantity"),
    modifiers: optionalModifiers(v.modifiers, "item.modifiers"),
    unitPrice: optionalString(v.unitPrice, "item.unitPrice"),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return expectString(value, path);
}

function expectNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return expectNumber(value, path);
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  const items = expectArray(value, path);
  return items.map((item, i) => expectString(item, `${path}.${i}`));
}

function expectStringLiteral<T extends string>(value: unknown, literal: T, path: string): T {
  if (value !== literal) throw new Error(`${path} must be ${literal}`);
  return literal;
}

function expectOneOf<const T extends readonly string[]>(value: unknown, allowed: T, path: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
  return value as T[number];
}

function expectClaim(value: unknown, path: string): ClaimLevel {
  return expectOneOf(value, CLAIM_LEVELS, path);
}

function optionalModifiers(value: unknown, path: string): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, path);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(input)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`${path}.${key} must be a primitive modifier`);
    }
    out[key] = item;
  }
  return out;
}
