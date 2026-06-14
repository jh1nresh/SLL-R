import { randomBytes, timingSafeEqual } from "node:crypto";
import { sllrStore } from "./store.js";
import { secretFrom } from "./merchantApi.js";

// Per-merchant auth for the Agent POS. A merchant action is authorized if EITHER:
//   (a) the global operator secret (SLLR_MERCHANT_PAYMENT_VERIFY_SECRET) is given
//       — backward compatible, lets the operator act for any merchant; or
//   (b) a per-merchant token is given that resolves to THIS merchantId.
// Tokens are opaque, stored server-side (store), minted by an operator-gated
// endpoint. This lets us onboard a merchant without sharing one global secret and
// stops merchant A from acting on merchant B's orders.

const TOKEN_RE = /^sllrm_[a-f0-9]{48}$/;

function tokenKey(token: string): string {
  return `sllr:merchant-token:${token}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function issueMerchantToken(merchantId: string, nowIso: string): Promise<string> {
  const token = `sllrm_${randomBytes(24).toString("hex")}`;
  await sllrStore().setJson(tokenKey(token), { merchantId, issuedAt: nowIso });
  return token;
}

export async function resolveMerchantToken(token: string): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const rec = await sllrStore().getJson<{ merchantId?: string }>(tokenKey(token));
  return rec?.merchantId ?? null;
}

// Throws 401 unless the caller is authorized for `merchantId`. Accepts the global
// operator secret OR a per-merchant token (both via the x-sllr-merchant-payment-secret
// header or verificationToken body field). demo:true works only when no global
// secret is configured (local dev).
export async function requireMerchantAuth(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>,
  merchantId: string,
): Promise<void> {
  const expected = process.env.SLLR_MERCHANT_PAYMENT_VERIFY_SECRET?.trim();
  const provided = secretFrom(headers, body);

  if (expected && provided && safeEqual(provided, expected)) return;      // operator secret
  if (!expected && body.demo === true) return;                            // local demo only

  if (provided) {
    const tokenMerchant = await resolveMerchantToken(provided);
    if (tokenMerchant && tokenMerchant === merchantId) return;            // per-merchant token
  }

  throw Object.assign(
    new Error("Merchant authorization required: provide the operator verifier secret or this merchant's token (x-sllr-merchant-payment-secret header or verificationToken)."),
    { status: 401 },
  );
}
