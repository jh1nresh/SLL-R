import { randomUUID } from "node:crypto";
import { sllrStore } from "./store.js";
import { createOrder, getOrder } from "./orders.js";
import { getBuyerBilling, hasSavedCard } from "./buyerBilling.js";
import { payWithSavedCard, type PayResult } from "../adapters/cardOnFile.js";
import { merchantForId } from "../merchants/profiles.js";
import { centsFromUsd } from "./money.js";
import type { SellerOrder } from "../types.js";

// Recurring orders (confirm-each). A buyer saves a "usual" + a weekly schedule.
// SLL-R owns the schedule: a Vercel Cron sweep finds due subscriptions and opens
// a RecurringRun in `awaiting_confirm`. The buyer's channel (e.g. SAV-E) polls
// pending runs, asks the buyer, and on "yes" calls confirmRun — which creates the
// order and charges the saved card off-session. Nothing is charged without an
// explicit per-run confirmation, and every run is capped by maxPerRunUsd.

export type RecurringSchedule = {
  daysOfWeek: number[]; // 0=Sun .. 6=Sat (local to tz)
  hour: number;         // 0-23, local to tz
  minute: number;       // 0-59
  tz: string;           // IANA, e.g. "America/Los_Angeles"
};

// The stored "usual" — a QuoteRequest minus merchantId (kept on the subscription).
export type RecurringTemplate = {
  userIntent: string;
  maxSpendUsd?: string;
  deadlineMinutes?: number;
  deliverByDays?: number;
  quantity?: number;
};

export type BuyerSubscription = {
  id: string;
  buyerId: string;
  merchantId: string;
  merchantName: string;
  template: RecurringTemplate;
  schedule: RecurringSchedule;
  maxPerRunUsd: string; // hard per-run spend cap; a run above this is not charged
  status: "active" | "paused" | "canceled";
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecurringRun = {
  id: string;
  subscriptionId: string;
  buyerId: string;
  merchantId: string;
  merchantName: string;
  summary: string;     // human prompt line, e.g. "iced latte at Raposa Coffee"
  dueAt: string;
  expiresAt: string;
  status: "awaiting_confirm" | "charged" | "declined" | "expired" | "failed";
  orderId: string | null;
  result: string | null; // pay status / failure reason
  createdAt: string;
  updatedAt: string;
};

const SUB_KEY = (id: string) => `sllr:subscription:${id}`;
const BUYER_SUBS = (buyerId: string) => `sllr:buyer-subs:${buyerId}`;
const ACTIVE_SUBS = "sllr:subscriptions:active";
const RUN_KEY = (id: string) => `sllr:recurring-run:${id}`;
const BUYER_RUNS = (buyerId: string) => `sllr:buyer-runs:${buyerId}`;
const PENDING_RUNS = "sllr:recurring-runs:pending";

const DEFAULT_EXPIRY_MINUTES = 120; // a confirm prompt is good for 2h

// --- time helpers (no deps) -------------------------------------------------

// Wall-clock parts of `date` as seen in `tz`.
function localParts(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

// The offset (ms) between wall-clock-in-tz and UTC at `date`.
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return asUtc - date.getTime();
}

// The UTC instant for a given wall-clock Y-M-D H:M in `tz`.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Correct using the offset at the guessed instant (good enough across DST for a
  // confirm prompt; the charge is gated on an explicit human confirm anyway).
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

// Next instant strictly after `fromIso` that matches the schedule.
export function computeNextRunAt(schedule: RecurringSchedule, fromIso: string): string {
  const from = new Date(fromIso);
  for (let i = 0; i <= 14; i++) {
    const probe = new Date(from.getTime() + i * 86_400_000);
    const { year, month, day, weekday } = localParts(probe, schedule.tz);
    if (!schedule.daysOfWeek.includes(weekday)) continue;
    const candidate = zonedTimeToUtc(year, month, day, schedule.hour, schedule.minute, schedule.tz);
    if (candidate.getTime() > from.getTime()) return candidate.toISOString();
  }
  // Fallback: a week out (should not happen for a non-empty daysOfWeek).
  return new Date(from.getTime() + 7 * 86_400_000).toISOString();
}

// --- validation -------------------------------------------------------------

function validateSchedule(schedule: RecurringSchedule): RecurringSchedule {
  const days = Array.isArray(schedule?.daysOfWeek) ? schedule.daysOfWeek.map(Number) : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw Object.assign(new Error("schedule.daysOfWeek must be a non-empty list of 0-6 (Sun-Sat)."), { status: 400 });
  }
  const hour = Number(schedule?.hour);
  const minute = Number(schedule?.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw Object.assign(new Error("schedule.hour must be an integer 0-23."), { status: 400 });
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw Object.assign(new Error("schedule.minute must be an integer 0-59."), { status: 400 });
  }
  const tz = String(schedule?.tz || "").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw Object.assign(new Error("schedule.tz must be a valid IANA time zone, e.g. America/Los_Angeles."), { status: 400 });
  }
  return { daysOfWeek: [...new Set(days)].sort(), hour, minute, tz };
}

// --- subscriptions ----------------------------------------------------------

export type CreateSubscriptionInput = {
  merchantId: string;
  template: RecurringTemplate;
  schedule: RecurringSchedule;
  maxPerRunUsd: string;
};

export async function createSubscription(buyerId: string, input: CreateSubscriptionInput): Promise<{ subscription: BuyerSubscription; cardOnFile: boolean }> {
  const merchant = merchantForId(input.merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${input.merchantId}`), { status: 404 });
  if (!input.template?.userIntent?.trim()) {
    throw Object.assign(new Error("template.userIntent is required (the 'usual' to re-order)."), { status: 400 });
  }
  if (centsFromUsd(String(input.maxPerRunUsd || "")) <= 0) {
    throw Object.assign(new Error("maxPerRunUsd must be a positive amount (the per-run spend cap)."), { status: 400 });
  }
  const schedule = validateSchedule(input.schedule);
  const now = new Date().toISOString();
  const sub: BuyerSubscription = {
    id: `sub_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    buyerId,
    merchantId: merchant.id,
    merchantName: merchant.name,
    template: {
      userIntent: input.template.userIntent.trim(),
      ...(input.template.maxSpendUsd ? { maxSpendUsd: String(input.template.maxSpendUsd) } : {}),
      ...(input.template.deadlineMinutes !== undefined ? { deadlineMinutes: Number(input.template.deadlineMinutes) } : {}),
      ...(input.template.deliverByDays !== undefined ? { deliverByDays: Number(input.template.deliverByDays) } : {}),
      ...(input.template.quantity !== undefined ? { quantity: Number(input.template.quantity) } : {}),
    },
    schedule,
    maxPerRunUsd: String(input.maxPerRunUsd),
    status: "active",
    nextRunAt: computeNextRunAt(schedule, now),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await sllrStore().setJson(SUB_KEY(sub.id), sub);
  await sllrStore().addToIndex(BUYER_SUBS(buyerId), sub.id);
  await sllrStore().addToIndex(ACTIVE_SUBS, sub.id);
  const cardOnFile = hasSavedCard(await getBuyerBilling(buyerId));
  return { subscription: sub, cardOnFile };
}

export async function getSubscription(id: string): Promise<BuyerSubscription | null> {
  return sllrStore().getJson<BuyerSubscription>(SUB_KEY(id));
}

export async function listSubscriptions(buyerId: string): Promise<BuyerSubscription[]> {
  const ids = await sllrStore().indexMembers(BUYER_SUBS(buyerId));
  const subs = await Promise.all(ids.map((id) => sllrStore().getJson<BuyerSubscription>(SUB_KEY(id))));
  return subs.filter((s): s is BuyerSubscription => Boolean(s) && s!.status !== "canceled");
}

export async function cancelSubscription(id: string, buyerId: string): Promise<BuyerSubscription> {
  const sub = await getSubscription(id);
  if (!sub) throw Object.assign(new Error(`Unknown subscription: ${id}`), { status: 404 });
  if (sub.buyerId !== buyerId) throw Object.assign(new Error("This subscription does not belong to you."), { status: 403 });
  if (sub.status === "canceled") return sub;
  const updated: BuyerSubscription = { ...sub, status: "canceled", updatedAt: new Date().toISOString() };
  await sllrStore().setJson(SUB_KEY(id), updated);
  // Index membership is idempotent and not removable on this store; status guards
  // it from the sweep instead.
  return updated;
}

// --- runs -------------------------------------------------------------------

async function saveRun(run: RecurringRun): Promise<RecurringRun> {
  await sllrStore().setJson(RUN_KEY(run.id), run);
  return run;
}

// Sweep: open a confirm prompt for every active subscription that is due, and
// advance its schedule. Idempotent across overlapping cron ticks — a sub that
// already has a live awaiting_confirm run is skipped. Returns the runs created.
export async function sweepDueSubscriptions(nowIso: string = new Date().toISOString(), expiryMinutes: number = DEFAULT_EXPIRY_MINUTES): Promise<RecurringRun[]> {
  const now = new Date(nowIso);
  const ids = await sllrStore().indexMembers(ACTIVE_SUBS);
  const created: RecurringRun[] = [];
  for (const id of ids) {
    const sub = await sllrStore().getJson<BuyerSubscription>(SUB_KEY(id));
    if (!sub || sub.status !== "active") continue;
    if (new Date(sub.nextRunAt).getTime() > now.getTime()) continue;
    // Skip if a live prompt for this sub is already pending (double-tick guard).
    const pending = await listPendingRunsRaw(nowIso);
    if (pending.some((r) => r.subscriptionId === sub.id)) {
      // Still advance the schedule so we don't tight-loop on a stale nextRunAt.
      const advanced: BuyerSubscription = { ...sub, nextRunAt: computeNextRunAt(sub.schedule, nowIso), updatedAt: nowIso };
      await sllrStore().setJson(SUB_KEY(sub.id), advanced);
      continue;
    }
    const run: RecurringRun = {
      id: `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      subscriptionId: sub.id,
      buyerId: sub.buyerId,
      merchantId: sub.merchantId,
      merchantName: sub.merchantName,
      summary: `${sub.template.userIntent} at ${sub.merchantName}`,
      dueAt: sub.nextRunAt,
      expiresAt: new Date(now.getTime() + expiryMinutes * 60_000).toISOString(),
      status: "awaiting_confirm",
      orderId: null,
      result: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await saveRun(run);
    await sllrStore().addToIndex(BUYER_RUNS(sub.buyerId), run.id);
    await sllrStore().addToIndex(PENDING_RUNS, run.id);
    created.push(run);
    const advanced: BuyerSubscription = { ...sub, nextRunAt: computeNextRunAt(sub.schedule, nowIso), lastRunAt: nowIso, updatedAt: nowIso };
    await sllrStore().setJson(SUB_KEY(sub.id), advanced);
  }
  return created;
}

// Load pending runs, lazily expiring stale ones.
async function listPendingRunsRaw(nowIso: string): Promise<RecurringRun[]> {
  const now = new Date(nowIso).getTime();
  const ids = await sllrStore().indexMembers(PENDING_RUNS);
  const runs = await Promise.all(ids.map((id) => sllrStore().getJson<RecurringRun>(RUN_KEY(id))));
  const live: RecurringRun[] = [];
  for (const run of runs) {
    if (!run) continue;
    if (run.status !== "awaiting_confirm") continue;
    if (new Date(run.expiresAt).getTime() <= now) {
      await saveRun({ ...run, status: "expired", result: "expired", updatedAt: nowIso });
      continue;
    }
    live.push(run);
  }
  return live;
}

export async function listPendingRuns(buyerId: string, nowIso: string = new Date().toISOString()): Promise<RecurringRun[]> {
  return (await listPendingRunsRaw(nowIso)).filter((r) => r.buyerId === buyerId);
}

export async function getRun(id: string): Promise<RecurringRun | null> {
  return sllrStore().getJson<RecurringRun>(RUN_KEY(id));
}

export type ConfirmRunResult = {
  status: "charged" | "no_card" | "requires_action" | "declined" | "over_cap" | "expired" | "already_done";
  run: RecurringRun;
  order?: SellerOrder;
};

// The buyer said "yes": create the order from the subscription template and
// charge the saved card off-session. Capped by maxPerRunUsd. Idempotent on the
// run (a run already resolved is returned as-is).
export async function confirmRun(runId: string, buyerId: string, nowIso: string = new Date().toISOString()): Promise<ConfirmRunResult> {
  const run = await getRun(runId);
  if (!run) throw Object.assign(new Error(`Unknown run: ${runId}`), { status: 404 });
  if (run.buyerId !== buyerId) throw Object.assign(new Error("This run does not belong to you."), { status: 403 });
  if (run.status === "charged") {
    const order = run.orderId ? await getOrder(run.orderId) : null;
    return { status: "already_done", run, order: order ?? undefined };
  }
  if (run.status !== "awaiting_confirm") return { status: "expired", run };
  if (new Date(run.expiresAt).getTime() <= new Date(nowIso).getTime()) {
    const expired = await saveRun({ ...run, status: "expired", result: "expired", updatedAt: nowIso });
    return { status: "expired", run: expired };
  }
  const sub = await getSubscription(run.subscriptionId);
  if (!sub) throw Object.assign(new Error(`Subscription gone: ${run.subscriptionId}`), { status: 409 });

  // No card → don't create an order; the caller offers card binding / Checkout.
  if (!hasSavedCard(await getBuyerBilling(buyerId))) {
    const updated = await resolveRun(run, "failed", "no_card", null, nowIso);
    return { status: "no_card", run: updated };
  }

  const { order } = await createOrder({
    merchantId: sub.merchantId,
    userIntent: sub.template.userIntent,
    ...(sub.template.maxSpendUsd ? { maxSpendUsd: sub.template.maxSpendUsd } : {}),
    ...(sub.template.deadlineMinutes !== undefined ? { deadlineMinutes: sub.template.deadlineMinutes } : {}),
    ...(sub.template.deliverByDays !== undefined ? { deliverByDays: sub.template.deliverByDays } : {}),
    ...(sub.template.quantity !== undefined ? { quantity: sub.template.quantity } : {}),
    paymentMode: "checkout",
    buyerId,
    agentId: "sllr-recurring",
    customerLabel: "recurring order",
  });

  // Per-run spend cap: never charge above what the buyer authorized.
  if (centsFromUsd(order.item.subtotalUsd) > centsFromUsd(sub.maxPerRunUsd)) {
    const updated = await resolveRun(run, "failed", `over_cap:${order.item.subtotalUsd}>${sub.maxPerRunUsd}`, order.id, nowIso);
    return { status: "over_cap", run: updated, order };
  }

  const pay: PayResult = await payWithSavedCard(order.id, buyerId);
  if (pay.status === "paid" || pay.status === "already_paid") {
    const updated = await resolveRun(run, "charged", pay.status, order.id, nowIso);
    return { status: "charged", run: updated, order: pay.order ?? order };
  }
  // no_card / requires_action / declined → leave a failed run; caller falls back.
  const updated = await resolveRun(run, "failed", pay.status, order.id, nowIso);
  return { status: pay.status, run: updated, order };
}

export async function declineRun(runId: string, buyerId: string, nowIso: string = new Date().toISOString()): Promise<RecurringRun> {
  const run = await getRun(runId);
  if (!run) throw Object.assign(new Error(`Unknown run: ${runId}`), { status: 404 });
  if (run.buyerId !== buyerId) throw Object.assign(new Error("This run does not belong to you."), { status: 403 });
  if (run.status !== "awaiting_confirm") return run;
  return resolveRun(run, "declined", "declined", null, nowIso);
}

// Move a run out of awaiting_confirm into a terminal state.
async function resolveRun(run: RecurringRun, status: RecurringRun["status"], result: string, orderId: string | null, nowIso: string): Promise<RecurringRun> {
  return saveRun({ ...run, status, result, orderId: orderId ?? run.orderId, updatedAt: nowIso });
}

// A repeatable-order hint for an order response: "want this every week?"
export function recurringSuggestion(order: Pick<SellerOrder, "buyerId" | "merchantId" | "item">): { eligible: boolean; reason?: string; prompt?: string } {
  if (!order.buyerId) {
    return { eligible: false, reason: "Recurring orders need a buyer session (saved identity)." };
  }
  return {
    eligible: true,
    prompt: `Want me to set "${order.item.name}" as a recurring order? Tell me the days + time and I'll ask before each one.`,
  };
}
