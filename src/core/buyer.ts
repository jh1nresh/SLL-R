import { randomUUID } from "node:crypto";
import { sllrStore } from "./store.js";

// Buyer sessions bind orders and receipts to a stable buyerId, so an agent
// user can see "my orders" across merchants — the foundation for the Layer-2
// cross-merchant consumption identity / membership. A session is an opaque
// Bearer token (presented on /mcp and buyer-facing REST), stored server-side
// with an expiry. Mirrors Luckin's ~30-day account session.

const BUYER_TOKEN_PREFIX = "sllr:buyer-token:";
const BUYER_ORDERS_PREFIX = "sllr:buyer-orders:";
const SESSION_TTL_DAYS = 30;

export type BuyerSession = {
  buyerId: string;
  label: string;
  createdAt: string;
  expiresAt: string;
};

function tokenKey(token: string) {
  return `${BUYER_TOKEN_PREFIX}${token}`;
}

export function buyerOrdersIndex(buyerId: string) {
  return `${BUYER_ORDERS_PREFIX}${buyerId}`;
}

// Extract the buyer Bearer token from the Authorization header or a body field.
export function buyerTokenFrom(headers: Record<string, string | string[] | undefined>, body?: Record<string, unknown>) {
  const auth = headers["authorization"];
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (typeof header === "string") {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim()) return match[1].trim();
  }
  if (body && typeof body.buyerToken === "string" && body.buyerToken.trim()) {
    return body.buyerToken.trim();
  }
  return null;
}

// `nowIso` is passed in because Date.now() is unavailable in some contexts and
// to keep issuance deterministic/testable; callers use new Date().toISOString().
export async function issueBuyerSession(label: string, nowIso: string, ttlMs: number = SESSION_TTL_DAYS * 86_400_000): Promise<{ token: string; session: BuyerSession }> {
  const token = `sllrb_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const buyerId = `buyer_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const expiresAt = new Date(new Date(nowIso).getTime() + ttlMs).toISOString();
  const session: BuyerSession = {
    buyerId,
    label: label.trim() || "buyer agent user",
    createdAt: nowIso,
    expiresAt,
  };
  await sllrStore().setJson(tokenKey(token), session);
  return { token, session };
}

const TOKEN_FORMAT = /^sllrb_[a-f0-9]{64}$/;

// Resolve a token to its session, treating expired sessions as invalid. Rejects
// any token that is not server-issued shape (defense-in-depth for the store key
// and to avoid pointless lookups on client-crafted tokens).
export async function resolveBuyer(token: string | null, nowIso: string): Promise<BuyerSession | null> {
  if (!token || !TOKEN_FORMAT.test(token)) return null;
  const session = await sllrStore().getJson<BuyerSession>(tokenKey(token));
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= new Date(nowIso).getTime()) return null;
  return session;
}

// Revoke a session. The store interface has no delete, so revoke by writing an
// already-expired session — resolveBuyer then rejects it. Returns false if the
// token was not a valid live session.
export async function revokeBuyerSession(token: string | null, nowIso: string): Promise<boolean> {
  if (!token || !TOKEN_FORMAT.test(token)) return false;
  const session = await sllrStore().getJson<BuyerSession>(tokenKey(token));
  if (!session) return false;
  await sllrStore().setJson(tokenKey(token), { ...session, expiresAt: new Date(0).toISOString() });
  return true;
}
