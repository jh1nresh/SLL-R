import { randomUUID } from "node:crypto";
import type { CapacityReservation, CapacityWindowSnapshot, CatalogItem, ProductionClass } from "../types.js";
import { sllrStore } from "./store.js";

export const CAPACITY_WINDOW_MINUTES = 15;
export const CAPACITY_BY_PRODUCTION_CLASS: Record<ProductionClass, number> = {
  espresso: 8,
  cold: 12,
  pastry: 20,
  general: 10,
};

const RESERVATION_KEY = (id: string) => `sllr:capacity-reservation:${id}`;
const RESERVATION_INDEX = (merchantId: string) => `sllr:capacity-reservations:${merchantId}`;
const MAX_WINDOW_SEARCH = 32;
const CLAIM_CREATION_GRACE_MS = 2 * 60_000;

type SeatClaim = {
  reservationId: string;
  orderId: string;
  claimedAt: string;
};

type StoredCapacityReservation = CapacityReservation & {
  orderId: string;
  seatNumbers: number[];
};

export function productionClassFor(item: CatalogItem): ProductionClass {
  if (item.productionClass) return item.productionClass;
  const tags = new Set((item.tags || []).map((tag) => tag.toLowerCase()));
  if (tags.has("pastry")) return "pastry";
  if (tags.has("cold brew") || tags.has("cold")) return "cold";
  if (tags.has("coffee") || tags.has("latte") || tags.has("espresso")) return "espresso";
  return "general";
}

export function parsePickupAt(value: unknown, now = new Date()): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("pickupAt must be an ISO-8601 date-time string."), { status: 400 });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw Object.assign(new Error("pickupAt must be a valid ISO-8601 date-time string."), { status: 400 });
  }
  if (parsed.getTime() < now.getTime()) {
    throw Object.assign(new Error("pickupAt must be in the future. Request a fresh quote."), { status: 409 });
  }
  if (parsed.getTime() > now.getTime() + 30 * 24 * 60 * 60_000) {
    throw Object.assign(new Error("pickupAt cannot be more than 30 days in the future."), { status: 422 });
  }
  return parsed;
}

function windowStart(date: Date, notBefore: boolean): Date {
  const width = CAPACITY_WINDOW_MINUTES * 60_000;
  const quotient = date.getTime() / width;
  return new Date((notBefore ? Math.ceil(quotient) : Math.floor(quotient)) * width);
}

function windowId(merchantId: string, productionClass: ProductionClass, startsAt: Date) {
  return `${merchantId}:${productionClass}:${startsAt.getTime()}`;
}

function seatKey(window: CapacityWindowSnapshot, seatNumber: number) {
  return `sllr:capacity-seat:${window.id}:${seatNumber}`;
}

async function snapshotForStart(
  merchantId: string,
  productionClass: ProductionClass,
  startsAt: Date,
): Promise<CapacityWindowSnapshot> {
  const capacity = CAPACITY_BY_PRODUCTION_CLASS[productionClass];
  const endsAt = new Date(startsAt.getTime() + CAPACITY_WINDOW_MINUTES * 60_000);
  const base: CapacityWindowSnapshot = {
    id: windowId(merchantId, productionClass, startsAt),
    merchantId,
    productionClass,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    capacity,
    reserved: 0,
    available: capacity,
  };
  const claims = await Promise.all(Array.from({ length: capacity }, async (_, seatNumber) => {
    const key = seatKey(base, seatNumber);
    const claim = await sllrStore().getJson<SeatClaim>(key);
    if (!claim) return null;
    const reservation = await sllrStore().getJson<StoredCapacityReservation>(RESERVATION_KEY(claim.reservationId));
    if (
      reservation
      && reservation.windowId === base.id
      && reservation.status !== "released"
    ) return claim;
    const claimedAt = new Date(claim.claimedAt).getTime();
    if (!reservation && Number.isFinite(claimedAt) && Date.now() - claimedAt <= CLAIM_CREATION_GRACE_MS) {
      return claim;
    }
    await sllrStore().deleteJson(key);
    return null;
  }));
  const reserved = claims.filter(Boolean).length;
  return { ...base, reserved, available: capacity - reserved };
}

export function capacityWindowAt(
  merchantId: string,
  productionClass: ProductionClass,
  at: Date,
  notBefore = false,
) {
  return snapshotForStart(merchantId, productionClass, windowStart(at, notBefore));
}

export async function listCapacityWindows(
  merchantId: string,
  productionClass: ProductionClass,
  from = new Date(),
  count = 8,
) {
  const boundedCount = Math.max(1, Math.min(Math.trunc(count), 32));
  const first = windowStart(from, true);
  return Promise.all(Array.from({ length: boundedCount }, (_, index) => (
    snapshotForStart(
      merchantId,
      productionClass,
      new Date(first.getTime() + index * CAPACITY_WINDOW_MINUTES * 60_000),
    )
  )));
}

async function deleteOwnedSeats(reservation: StoredCapacityReservation) {
  const window: CapacityWindowSnapshot = {
    id: reservation.windowId,
    merchantId: reservation.merchantId,
    productionClass: reservation.productionClass,
    startsAt: reservation.startsAt,
    endsAt: reservation.endsAt,
    capacity: CAPACITY_BY_PRODUCTION_CLASS[reservation.productionClass],
    reserved: reservation.quantity,
    available: 0,
  };
  await Promise.all(reservation.seatNumbers.map(async (seatNumber) => {
    const key = seatKey(window, seatNumber);
    const claim = await sllrStore().getJson<SeatClaim>(key);
    if (claim?.reservationId === reservation.id) await sllrStore().deleteJson(key);
  }));
}

async function nextAvailableWindow(
  merchantId: string,
  productionClass: ProductionClass,
  after: Date,
  quantity: number,
) {
  const windows = await listCapacityWindows(merchantId, productionClass, new Date(after.getTime() + CAPACITY_WINDOW_MINUTES * 60_000), MAX_WINDOW_SEARCH);
  return windows.find((window) => window.available >= quantity) || null;
}

export async function reserveCapacity(input: {
  merchantId: string;
  item: CatalogItem;
  quantity: number;
  desiredAt: Date;
  exactWindow: boolean;
  orderId: string;
}): Promise<CapacityReservation> {
  const productionClass = productionClassFor(input.item);
  const capacity = CAPACITY_BY_PRODUCTION_CLASS[productionClass];
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > capacity) {
    throw Object.assign(new Error(`A ${productionClass} pickup window supports at most ${capacity} units per order.`), { status: 422 });
  }

  // A capacity window contains the promised ready time; it is not itself the
  // promise. Rounding up would silently turn a quoted 17-minute ETA into a
  // 30-plus-minute order promise. Move to a later window only when this one is full.
  const first = windowStart(input.desiredAt, false);
  const attempts = input.exactWindow ? 1 : MAX_WINDOW_SEARCH;
  for (let offset = 0; offset < attempts; offset += 1) {
    const startsAt = new Date(first.getTime() + offset * CAPACITY_WINDOW_MINUTES * 60_000);
    const window = await snapshotForStart(input.merchantId, productionClass, startsAt);
    const reservationId = `cap_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const claimed: number[] = [];
    const claimedAt = new Date().toISOString();
    for (let seatNumber = 0; seatNumber < capacity && claimed.length < input.quantity; seatNumber += 1) {
      if (await sllrStore().setJsonIfAbsent(seatKey(window, seatNumber), {
        reservationId,
        orderId: input.orderId,
        claimedAt,
      } satisfies SeatClaim)) {
        claimed.push(seatNumber);
      }
    }
    if (claimed.length !== input.quantity) {
      const partial: StoredCapacityReservation = {
        id: reservationId,
        windowId: window.id,
        merchantId: input.merchantId,
        productionClass,
        quantity: claimed.length,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        status: "held",
        orderId: input.orderId,
        seatNumbers: claimed,
        createdAt: claimedAt,
        updatedAt: claimedAt,
      };
      await deleteOwnedSeats(partial);
      continue;
    }

    const record: StoredCapacityReservation = {
      id: reservationId,
      windowId: window.id,
      merchantId: input.merchantId,
      productionClass,
      quantity: input.quantity,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      status: "held",
      orderId: input.orderId,
      seatNumbers: claimed,
      createdAt: claimedAt,
      updatedAt: claimedAt,
    };
    try {
      await sllrStore().setJson(RESERVATION_KEY(record.id), record);
      await sllrStore().addToIndex(RESERVATION_INDEX(input.merchantId), record.id);
      const { orderId: _orderId, seatNumbers: _seatNumbers, ...publicReservation } = record;
      return publicReservation;
    } catch (error) {
      await deleteOwnedSeats(record);
      await sllrStore().deleteJson(RESERVATION_KEY(record.id));
      throw error;
    }
  }

  const next = await nextAvailableWindow(input.merchantId, productionClass, first, input.quantity);
  throw Object.assign(new Error(
    input.exactWindow
      ? `The requested ${CAPACITY_WINDOW_MINUTES}-minute pickup window is full. Request a fresh quote${next ? ` for ${next.startsAt}` : ""}.`
      : `No ${productionClass} pickup capacity is available in the next ${MAX_WINDOW_SEARCH * CAPACITY_WINDOW_MINUTES} minutes.`,
  ), {
    status: 409,
    code: "capacity_unavailable",
    nextCapacityWindow: next,
  });
}

export async function releaseCapacityReservation(reservationId: string) {
  const reservation = await sllrStore().getJson<StoredCapacityReservation>(RESERVATION_KEY(reservationId));
  if (!reservation) return reservation;
  if (reservation.status === "released") {
    await deleteOwnedSeats(reservation);
    return reservation;
  }
  if (reservation.status !== "held") return reservation;
  const updated = { ...reservation, status: "released" as const, updatedAt: new Date().toISOString() };
  const transitioned = await sllrStore().setJsonIfFieldEquals(
    RESERVATION_KEY(reservationId),
    "status",
    "held",
    updated,
  );
  if (!transitioned) {
    return sllrStore().getJson<StoredCapacityReservation>(RESERVATION_KEY(reservationId));
  }
  await deleteOwnedSeats(updated);
  return updated;
}

export async function consumeCapacityReservation(reservationId: string) {
  const reservation = await sllrStore().getJson<StoredCapacityReservation>(RESERVATION_KEY(reservationId));
  if (!reservation || reservation.status !== "held") return reservation;
  const updated = { ...reservation, status: "consumed" as const, updatedAt: new Date().toISOString() };
  const transitioned = await sllrStore().setJsonIfFieldEquals(
    RESERVATION_KEY(reservationId),
    "status",
    "held",
    updated,
  );
  return transitioned
    ? updated
    : sllrStore().getJson<StoredCapacityReservation>(RESERVATION_KEY(reservationId));
}
