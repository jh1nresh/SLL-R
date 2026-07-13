import { createHash } from "node:crypto";
import { sllrStore } from "./store.js";
import type { SellerOrder } from "../types.js";

export type MutationResult = {
  actionKey: string;
  resourceId: string;
  state: string;
  terminal: boolean;
  retryable: boolean;
  retryAfterMs?: number;
  expiresAt?: string;
  allowedNextActions: string[];
  proofRefs: string[];
  receiptRef?: string;
  refusal?: { code: string; message: string };
};

type MutationRecord<T> = {
  actionKey: string;
  scopedKey: string;
  operation: string;
  requestHash: string;
  resourceId: string;
  result: T;
  mutation: MutationResult;
  createdAt: string;
  updatedAt: string;
};

type IdempotentMutationArgs<T> = {
  operation: string;
  tenantId: string;
  requesterId?: string | null;
  targetId?: string | null;
  actionKey?: unknown;
  request: Record<string, unknown>;
  run: () => Promise<T>;
  mutationFromResult: (result: T, actionKey: string) => MutationResult;
};

const PRIVATE_KEYS = new Set(["verificationToken", "secret", "token", "__mcpRequestId"]);

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !PRIVATE_KEYS.has(key) && key !== "actionKey" && key !== "idempotencyKey")
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, child]) => [key, stableNormalize(child)]));
}

function sha256(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function requestHash(request: Record<string, unknown>) {
  return sha256(JSON.stringify(stableNormalize(request)));
}

export function actionKeyFrom(payload: Record<string, unknown>, operation: string): string | null {
  for (const key of ["idempotencyKey", "actionKey", "__mcpRequestId"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function recordKey(tenantId: string, operation: string, requesterId: string | null | undefined, actionKey: string) {
  return `sllr:mutation:${sha256(JSON.stringify({ tenantId, operation, requesterId: requesterId || null, actionKey }))}`;
}

export function allowedNextActionsForOrder(order: SellerOrder): string[] {
  switch (order.status) {
    case "pending_payment":
      return ["attach_payment_proof", "merchant_accept_order", "merchant_reject_order"];
    case "accepted":
      return ["attach_payment_proof", "merchant_mark_ready", "merchant_fulfill_order", "merchant_reject_order"];
    case "payment_backed":
      return ["merchant_mark_ready", "merchant_fulfill_order"];
    case "ready":
      return ["claim_order", "merchant_fulfill_order"];
    case "claimed":
      return ["issue_receipt"];
    case "rejected":
    case "fulfilled":
    case "receipt_issued":
      return [];
    default:
      return [];
  }
}

export function mutationResultForOrder(actionKey: string, order: SellerOrder): MutationResult {
  const terminal = order.status === "receipt_issued" || order.status === "rejected";
  return {
    actionKey,
    resourceId: order.id,
    state: order.status,
    terminal,
    retryable: false,
    allowedNextActions: allowedNextActionsForOrder(order),
    proofRefs: [
      ...(order.payment?.paymentId ? [`payment:${order.payment.provider}:${order.payment.paymentId}`] : []),
      ...(order.receipt?.receiptHash ? [`receipt:${order.receipt.receiptHash}`] : []),
    ],
    ...(order.receipt?.receiptMemoryId ? { receiptRef: order.receipt.receiptMemoryId } : {}),
  };
}

export async function withIdempotentMutation<T>(args: IdempotentMutationArgs<T>): Promise<{ result: T; mutation?: MutationResult }> {
  const actionKey = typeof args.actionKey === "string" && args.actionKey.trim() ? args.actionKey.trim() : null;
  if (!actionKey) {
    const result = await args.run();
    return { result };
  }

  const key = recordKey(args.tenantId, args.operation, args.requesterId, actionKey);
  const hash = requestHash({
    operation: args.operation,
    tenantId: args.tenantId,
    requesterId: args.requesterId || null,
    targetId: args.targetId || null,
    ...args.request,
  });
  const existing = await sllrStore().getJson<MutationRecord<T>>(key);
  if (existing) {
    if (existing.requestHash !== hash) {
      throw Object.assign(new Error(`Idempotency key conflict for ${args.operation}. Reuse the same key only with the same normalized request.`), {
        status: 409,
        code: "idempotency_conflict",
        mutation: {
          actionKey,
          resourceId: existing.resourceId,
          state: "refused",
          terminal: true,
          retryable: false,
          allowedNextActions: [],
          proofRefs: existing.mutation.proofRefs,
          ...(existing.mutation.receiptRef ? { receiptRef: existing.mutation.receiptRef } : {}),
          refusal: { code: "idempotency_conflict", message: "Same action key was reused with a different normalized request." },
        } satisfies MutationResult,
      });
    }
    return { result: existing.result, mutation: existing.mutation };
  }

  const result = await args.run();
  const mutation = args.mutationFromResult(result, actionKey);
  const now = new Date().toISOString();
  await sllrStore().setJson(key, {
    actionKey,
    scopedKey: key,
    operation: args.operation,
    requestHash: hash,
    resourceId: mutation.resourceId,
    result,
    mutation,
    createdAt: now,
    updatedAt: now,
  } satisfies MutationRecord<T>);
  return { result, mutation };
}
