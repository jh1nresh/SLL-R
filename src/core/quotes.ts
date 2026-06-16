import { randomUUID } from "node:crypto";
import { sllrStore } from "./store.js";
import { merchantForId } from "../merchants/profiles.js";
import type { QuoteResult } from "../types.js";

// Persisted quotes — the binding target for consent (spec: bounded-action rail).
// A quote pins a price for a merchant+item+buyer with a short TTL; consent and
// the order then reference this id so "no quote → no price claim / no order"
// becomes server-enforceable. Only feasible quotes are persisted.

export type StoredQuote = {
  id: string;
  merchantId: string;
  merchantName: string;
  buyerId: string | null;
  itemId: string;
  itemName: string;
  quantity: number;
  amountUsd: string; // subtotal — the amount consent/order must match
  intent: string;
  createdAt: string;
  expiresAt: string;
};

const QUOTE_KEY = (id: string) => `sllr:quote:${id}`;
const DEFAULT_TTL_MS = Number(process.env.SLLR_QUOTE_TTL_MS ?? 600_000); // 10 min

export async function persistQuote(
  merchantId: string,
  quote: QuoteResult,
  buyerId: string | null,
  intent: string,
  nowIso: string = new Date().toISOString(),
): Promise<StoredQuote | null> {
  if (!quote.feasible || !quote.item) return null;
  const merchant = merchantForId(merchantId);
  const record: StoredQuote = {
    id: `quote_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    merchantId,
    merchantName: merchant?.name ?? merchantId,
    buyerId,
    itemId: quote.item.id,
    itemName: quote.item.name,
    quantity: quote.item.quantity,
    amountUsd: quote.item.subtotalUsd,
    intent,
    createdAt: nowIso,
    expiresAt: new Date(new Date(nowIso).getTime() + DEFAULT_TTL_MS).toISOString(),
  };
  await sllrStore().setJson(QUOTE_KEY(record.id), record);
  return record;
}

export async function getQuote(id: string): Promise<StoredQuote | null> {
  return sllrStore().getJson<StoredQuote>(QUOTE_KEY(id));
}

export function isQuoteExpired(quote: StoredQuote, nowIso: string = new Date().toISOString()): boolean {
  return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
}
