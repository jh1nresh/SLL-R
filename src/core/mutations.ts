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

type MutationClaim = {
  phase: "pending";
  actionKey: string;
  scopedKey: string;
  operation: string;
  requestHash: string;
  targetId: string | null;
  createdAt: string;
  updatedAt: string;
};

type CompletedMutationRecord<T> = {
  phase?: "completed";
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

type FailedMutationRecord = {
  phase: "failed";
  actionKey: string;
  scopedKey: string;
  operation: string;
  requestHash: string;
  resourceId: string;
  mutation: MutationResult;
  failure: { status: number; code: string };
  createdAt: string;
  updatedAt: string;
};

type StoredMutation<T> = MutationClaim | CompletedMutationRecord<T> | FailedMutationRecord;

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
const CONCURRENT_WAIT_MS = 2_000;
const CONCURRENT_POLL_MS = 25;

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

function resourceIdFor<T>(record: StoredMutation<T>) {
  return record.phase === "pending" ? record.targetId || "pending" : record.resourceId;
}

function conflictError<T>(operation: string, actionKey: string, record: StoredMutation<T>) {
  const proofRefs = record.phase === "pending" ? [] : record.mutation.proofRefs;
  const receiptRef = record.phase === "pending" ? undefined : record.mutation.receiptRef;
  return Object.assign(new Error(`Idempotency key conflict for ${operation}. Reuse the same key only with the same normalized request.`), {
    status: 409,
    code: "idempotency_conflict",
    mutation: {
      actionKey,
      resourceId: resourceIdFor(record),
      state: "refused",
      terminal: true,
      retryable: false,
      allowedNextActions: [],
      proofRefs,
      ...(receiptRef ? { receiptRef } : {}),
      refusal: { code: "idempotency_conflict", message: "Same action key was reused with a different normalized request." },
    } satisfies MutationResult,
  });
}

function replayFailure(record: FailedMutationRecord) {
  return Object.assign(new Error(`The ${record.operation} mutation previously failed for this action key.`), {
    status: record.failure.status,
    code: record.failure.code,
    mutation: record.mutation,
  });
}

function inProgressError(actionKey: string, targetId: string | null | undefined) {
  return Object.assign(new Error("An identical mutation is still in progress. Retry with the same action key."), {
    status: 409,
    code: "idempotency_in_progress",
    mutation: {
      actionKey,
      resourceId: targetId || "pending",
      state: "in_progress",
      terminal: false,
      retryable: true,
      retryAfterMs: CONCURRENT_POLL_MS,
      allowedNextActions: [],
      proofRefs: [],
    } satisfies MutationResult,
  });
}

async function waitForMutation<T>(key: string, hash: string, operation: string, actionKey: string, targetId: string | null | undefined) {
  const deadline = Date.now() + CONCURRENT_WAIT_MS;
  while (Date.now() < deadline) {
    const record = await sllrStore().getJson<StoredMutation<T>>(key);
    if (record) {
      if (record.requestHash !== hash) throw conflictError(operation, actionKey, record);
      if (record.phase === "failed") throw replayFailure(record);
      if (record.phase !== "pending") return { result: record.result, mutation: record.mutation };
    }
    await new Promise((resolve) => setTimeout(resolve, CONCURRENT_POLL_MS));
  }
  throw inProgressError(actionKey, targetId);
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
  const store = sllrStore();
  const existing = await store.getJson<StoredMutation<T>>(key);
  if (existing) {
    if (existing.requestHash !== hash) throw conflictError(args.operation, actionKey, existing);
    if (existing.phase === "failed") throw replayFailure(existing);
    if (existing.phase !== "pending") return { result: existing.result, mutation: existing.mutation };
    return waitForMutation(key, hash, args.operation, actionKey, args.targetId);
  }

  const now = new Date().toISOString();
  const claimed = await store.setJsonIfAbsent(key, {
    phase: "pending",
    actionKey,
    scopedKey: key,
    operation: args.operation,
    requestHash: hash,
    targetId: args.targetId || null,
    createdAt: now,
    updatedAt: now,
  } satisfies MutationClaim);
  if (!claimed) return waitForMutation(key, hash, args.operation, actionKey, args.targetId);

  let result: T;
  try {
    result = await args.run();
  } catch (error) {
    const rawStatus = (error as { status?: unknown })?.status;
    const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
      ? rawStatus
      : 500;
    const rawCode = (error as { code?: unknown })?.code;
    const code = typeof rawCode === "string" && /^[a-z0-9_.-]{1,64}$/i.test(rawCode) ? rawCode : "mutation_failed";
    const mutation = {
      actionKey,
      resourceId: args.targetId || "pending",
      state: "failed",
      terminal: true,
      retryable: false,
      allowedNextActions: [],
      proofRefs: [],
      refusal: { code, message: "The mutation failed and was not re-executed for this action key." },
    } satisfies MutationResult;
    await store.setJson(key, {
      phase: "failed",
      actionKey,
      scopedKey: key,
      operation: args.operation,
      requestHash: hash,
      resourceId: args.targetId || "pending",
      mutation,
      failure: { status, code },
      createdAt: now,
      updatedAt: new Date().toISOString(),
    } satisfies FailedMutationRecord);
    throw Object.assign(error instanceof Error ? error : new Error("Mutation failed."), { status, code, mutation });
  }

  const mutation = args.mutationFromResult(result, actionKey);
  // Completion persistence is deliberately outside the execution catch. If it
  // fails after the business mutation succeeded, leave the claim pending for
  // reconciliation instead of overwriting a successful side effect as failed.
  await store.setJson(key, {
    phase: "completed",
    actionKey,
    scopedKey: key,
    operation: args.operation,
    requestHash: hash,
    resourceId: mutation.resourceId,
    result,
    mutation,
    createdAt: now,
    updatedAt: new Date().toISOString(),
  } satisfies CompletedMutationRecord<T>);
  return { result, mutation };
}
