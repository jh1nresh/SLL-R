import type { CatalogItem, MerchantProfile } from "../types.js";
import { allMerchantProfiles, merchantForId } from "../merchants/profiles.js";
import { isItemAvailable } from "./availability.js";
import { merchantCapabilityPacket, quoteMerchantOrder } from "./merchantApi.js";
import { centsFromUsd } from "./money.js";
import { distanceKm } from "./nearby.js";
import { scoreCatalogItem } from "./quote.js";
import { recommendForBuyer, type Recommendation } from "./recommend.js";

const MAX_CANDIDATES = 8;
const MAX_OPTIONS = 5;

type ShopRejection = {
  merchantId: string;
  merchantName?: string;
  reasons: string[];
};

type CandidateMerchant = {
  merchant: MerchantProfile;
  distanceKm?: number;
};

type CandidateItem = CandidateMerchant & {
  item: CatalogItem;
  intentScore: number;
  tasteRank: number;
  tasteRecommendation?: Recommendation;
};

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function positiveInteger(payload: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    badRequest(`${key} must be an integer between 1 and ${max}.`);
  }
  return value;
}

function positiveNumber(payload: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
    badRequest(`${key} must be a number greater than 0 and at most ${max}.`);
  }
  return value;
}

function candidateTime(item: CatalogItem, deadlineMinutes?: number, deliverByDays?: number): number {
  if (deadlineMinutes !== undefined) return item.prepMinutes ?? Number.POSITIVE_INFINITY;
  if (deliverByDays !== undefined) return item.shippingDays ?? Number.POSITIVE_INFINITY;
  if (item.prepMinutes !== undefined) return item.prepMinutes;
  if (item.shippingDays !== undefined) return item.shippingDays * 24 * 60;
  return Number.POSITIVE_INFINITY;
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function merchantMatchesCategory(merchant: MerchantProfile, category: string | undefined): boolean {
  if (!category) return true;
  const needle = category.toLowerCase();
  return `${merchant.category} ${merchant.name}`.toLowerCase().includes(needle);
}

function selectionReason(pick: CandidateItem, directIntentMatchesExist: boolean): string[] {
  const reasons: string[] = [];
  if (pick.intentScore > 0) {
    reasons.push("The selected catalog item matches the current request.");
  } else if (pick.tasteRecommendation?.reason.startsWith("matches your taste")) {
    reasons.push(`Verified receipt memory ${pick.tasteRecommendation.reason}.`);
  } else if (!directIntentMatchesExist) {
    reasons.push("No direct catalog match was found, so this is a current catalog fallback.");
  }
  if (pick.distanceKm !== undefined) reasons.push(`${pick.distanceKm} km from the supplied location.`);
  return reasons;
}

function compareCandidates(
  left: CandidateItem,
  right: CandidateItem,
  deadlineMinutes?: number,
  deliverByDays?: number,
): number {
  const tasteRank = (candidate: CandidateItem) => candidate.tasteRecommendation?.reason.startsWith("matches your taste")
    ? candidate.tasteRank
    : Number.POSITIVE_INFINITY;
  return right.intentScore - left.intentScore
    || compareNumber(tasteRank(left), tasteRank(right))
    || compareNumber(left.distanceKm ?? Number.POSITIVE_INFINITY, right.distanceKm ?? Number.POSITIVE_INFINITY)
    || compareNumber(candidateTime(left.item, deadlineMinutes, deliverByDays), candidateTime(right.item, deadlineMinutes, deliverByDays))
    || centsFromUsd(left.item.amountUsd) - centsFromUsd(right.item.amountUsd)
    || left.merchant.id.localeCompare(right.merchant.id);
}

export async function shopForBuyer(buyerId: string, payload: Record<string, unknown>) {
  if (!buyerId) {
    throw Object.assign(new Error("A buyer session is required for personal shopping."), { status: 401 });
  }

  const userIntent = typeof payload.userIntent === "string" ? payload.userIntent.trim() : "";
  if (!userIntent || userIntent.length > 500) badRequest("userIntent must be between 1 and 500 characters.");

  let maxSpendUsd: string | undefined;
  if (payload.maxSpendUsd !== undefined) {
    if (typeof payload.maxSpendUsd !== "string") badRequest("maxSpendUsd must be a positive USD decimal string.");
    const spendCents = centsFromUsd(payload.maxSpendUsd);
    if (!Number.isSafeInteger(spendCents) || spendCents <= 0) badRequest("maxSpendUsd must be a positive USD decimal string.");
    maxSpendUsd = payload.maxSpendUsd.trim();
  }
  const deadlineMinutes = positiveInteger(payload, "deadlineMinutes", 1_440);
  const deliverByDays = positiveInteger(payload, "deliverByDays", 365);
  const quantity = positiveInteger(payload, "quantity", 20);
  const limit = positiveInteger(payload, "limit", MAX_OPTIONS) ?? 3;
  const radiusKm = positiveNumber(payload, "radiusKm", 100) ?? 25;
  if (deadlineMinutes !== undefined && deliverByDays !== undefined) {
    badRequest("Choose either deadlineMinutes for pickup or deliverByDays for shipping, not both.");
  }

  const category = payload.category === undefined
    ? undefined
    : typeof payload.category === "string" && payload.category.trim() && payload.category.trim().length <= 100
      ? payload.category.trim()
      : badRequest("category must be a non-empty string.");

  const hasLat = payload.lat !== undefined;
  const hasLng = payload.lng !== undefined;
  if (hasLat !== hasLng) badRequest("lat and lng must be supplied together.");
  const lat = hasLat && typeof payload.lat === "number" && Number.isFinite(payload.lat) ? payload.lat : undefined;
  const lng = hasLng && typeof payload.lng === "number" && Number.isFinite(payload.lng) ? payload.lng : undefined;
  if (hasLat && (lat === undefined || lng === undefined || lat < -90 || lat > 90 || lng < -180 || lng > 180)) {
    badRequest("lat and lng must be valid numeric coordinates.");
  }
  const location = lat !== undefined && lng !== undefined ? { lat, lng } : undefined;

  let requestedMerchantIds: string[] | undefined;
  if (payload.merchantIds !== undefined) {
    if (!Array.isArray(payload.merchantIds)) badRequest("merchantIds must be an array of merchant ids.");
    requestedMerchantIds = [...new Set(payload.merchantIds.map((value) => {
      if (typeof value !== "string" || !value.trim() || value.trim().length > 128) badRequest("merchantIds must contain non-empty strings no longer than 128 characters.");
      return value.trim();
    }))];
    if (requestedMerchantIds.length < 1 || requestedMerchantIds.length > MAX_CANDIDATES) {
      badRequest(`merchantIds must contain between 1 and ${MAX_CANDIDATES} unique ids.`);
    }
  }

  const rejected: ShopRejection[] = [];
  const candidateMerchants: CandidateMerchant[] = [];
  const sourceProfiles = requestedMerchantIds
    ? requestedMerchantIds.map((merchantId) => {
      const merchant = merchantForId(merchantId);
      if (!merchant) rejected.push({ merchantId, reasons: ["Unknown merchant id."] });
      return merchant;
    }).filter((merchant): merchant is MerchantProfile => merchant !== null)
    : allMerchantProfiles();

  for (const merchant of sourceProfiles) {
    if (!merchantMatchesCategory(merchant, category)) {
      if (requestedMerchantIds) rejected.push({ merchantId: merchant.id, merchantName: merchant.name, reasons: ["Merchant does not match the requested category."] });
      continue;
    }
    if (deadlineMinutes !== undefined && !merchant.fulfillment.includes("pickup")) {
      rejected.push({ merchantId: merchant.id, merchantName: merchant.name, reasons: ["Merchant does not support pickup."] });
      continue;
    }
    if (deliverByDays !== undefined && !merchant.fulfillment.includes("shipping")) {
      rejected.push({ merchantId: merchant.id, merchantName: merchant.name, reasons: ["Merchant does not support shipping."] });
      continue;
    }
    let distance: number | undefined;
    if (location) {
      if (!merchant.geo) {
        if (!requestedMerchantIds) continue;
      } else {
        distance = Math.round(distanceKm(location.lat, location.lng, merchant.geo.lat, merchant.geo.lng) * 10) / 10;
        if (!requestedMerchantIds && distance > radiusKm) continue;
      }
    }
    candidateMerchants.push({ merchant, ...(distance !== undefined ? { distanceKm: distance } : {}) });
  }

  candidateMerchants.sort((left, right) => compareNumber(left.distanceKm ?? Number.POSITIVE_INFINITY, right.distanceKm ?? Number.POSITIVE_INFINITY));
  for (const overflow of candidateMerchants.splice(MAX_CANDIDATES)) {
    rejected.push({ merchantId: overflow.merchant.id, merchantName: overflow.merchant.name, reasons: [`Not compared because fan-out is capped at ${MAX_CANDIDATES} merchants.`] });
  }

  const tasteRecommendations = await recommendForBuyer(buyerId, {
    limit: MAX_CANDIDATES,
    ...(!requestedMerchantIds && location ? { location, radiusKm } : {}),
  });
  const tasteByItem = new Map(tasteRecommendations.map((recommendation, index) => [
    `${recommendation.merchantId}:${recommendation.item.id}`,
    { recommendation, rank: index + 1 },
  ]));

  const picked = await Promise.all(candidateMerchants.map(async ({ merchant, distanceKm: merchantDistance }) => {
    const fulfillment = deadlineMinutes !== undefined ? "pickup" : deliverByDays !== undefined ? "shipping" : null;
    const compatible = merchant.catalog.filter((item) => !fulfillment || item.fulfillment.includes(fulfillment));
    const availability = await Promise.all(compatible.map(async (item) => ({ item, available: await isItemAvailable(merchant.id, item.id) })));
    const available = availability.filter((entry) => entry.available).map((entry) => entry.item);
    if (!available.length) {
      return { rejection: { merchantId: merchant.id, merchantName: merchant.name, reasons: ["No compatible catalog items are currently available."] } satisfies ShopRejection };
    }
    const scored = available.map((item) => {
      const taste = tasteByItem.get(`${merchant.id}:${item.id}`);
      return {
        item,
        intentScore: scoreCatalogItem(userIntent, item),
        tasteRank: taste?.rank ?? Number.POSITIVE_INFINITY,
        tasteRecommendation: taste?.recommendation,
      };
    }).sort((left, right) => (
      right.intentScore - left.intentScore
      || compareNumber(left.tasteRank, right.tasteRank)
      || compareNumber(candidateTime(left.item, deadlineMinutes, deliverByDays), candidateTime(right.item, deadlineMinutes, deliverByDays))
      || centsFromUsd(left.item.amountUsd) - centsFromUsd(right.item.amountUsd)
    ));
    return {
      pick: {
        merchant,
        ...(merchantDistance !== undefined ? { distanceKm: merchantDistance } : {}),
        ...scored[0],
      } satisfies CandidateItem,
    };
  }));

  const candidateItems: CandidateItem[] = [];
  for (const result of picked) {
    if (result.rejection) rejected.push(result.rejection);
    if (result.pick) candidateItems.push(result.pick);
  }
  const directIntentMatchesExist = candidateItems.some((candidate) => candidate.intentScore > 0);
  const quoteCandidates = candidateItems.filter((candidate) => {
    if (!directIntentMatchesExist || candidate.intentScore > 0) return true;
    rejected.push({
      merchantId: candidate.merchant.id,
      merchantName: candidate.merchant.name,
      reasons: ["No available catalog item matched the current request."],
    });
    return false;
  });
  quoteCandidates.sort((left, right) => compareCandidates(left, right, deadlineMinutes, deliverByDays));

  type Option = {
    merchant: {
      id: string;
      name: string;
      category: string;
      location: string;
      fulfillment: MerchantProfile["fulfillment"];
      paymentRails: MerchantProfile["paymentRails"];
    };
    capabilities: ReturnType<typeof merchantCapabilityPacket>["capabilities"];
    quoteId: string;
    expiresAt: string;
    confirmationText: string;
    amountUsd: string;
    distanceKm?: number;
    why: string[];
    quote: Awaited<ReturnType<typeof quoteMerchantOrder>>["quote"];
    orderRequest: Record<string, unknown>;
    next: {
      consent: { tool: "request_consent"; arguments: { quoteId: string; confirmationText: string } };
      order: { tool: "create_order"; requires: string; arguments: Record<string, unknown> };
    };
  };
  const ranked: Option[] = [];

  const quoted = await Promise.all(quoteCandidates.map(async (candidate) => {
    try {
      const result = await quoteMerchantOrder(candidate.merchant.id, {
        buyerId,
        userIntent,
        itemId: candidate.item.id,
        ...(maxSpendUsd ? { maxSpendUsd } : {}),
        ...(deadlineMinutes !== undefined ? { deadlineMinutes } : {}),
        ...(deliverByDays !== undefined ? { deliverByDays } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      });
      return { candidate, result };
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      if (!Number.isFinite(status) || status >= 500) throw error;
      return {
        candidate,
        rejection: {
          merchantId: candidate.merchant.id,
          merchantName: candidate.merchant.name,
          reasons: [error instanceof Error ? error.message : "Merchant quote failed."],
        } satisfies ShopRejection,
      };
    }
  }));

  for (const { candidate, result, rejection } of quoted) {
    if (rejection) {
      rejected.push(rejection);
      continue;
    }
    if (!result || !result.quote.feasible || !result.quote.item || !result.quoteId || !result.expiresAt || !result.confirmationText || !result.amountUsd) {
      rejected.push({
        merchantId: candidate.merchant.id,
        merchantName: candidate.merchant.name,
        reasons: result?.quote.reasons ?? ["Merchant could not produce a persisted quote."],
      });
      continue;
    }
    const orderRequest = {
      merchantId: candidate.merchant.id,
      ...result.request,
      quoteId: result.quoteId,
    };
    const option: Option = {
      merchant: {
        id: candidate.merchant.id,
        name: candidate.merchant.name,
        category: candidate.merchant.category,
        location: candidate.merchant.location,
        fulfillment: candidate.merchant.fulfillment,
        paymentRails: candidate.merchant.paymentRails,
      },
      capabilities: merchantCapabilityPacket(candidate.merchant).capabilities,
      quoteId: result.quoteId,
      expiresAt: result.expiresAt,
      confirmationText: result.confirmationText,
      amountUsd: result.amountUsd,
      ...(candidate.distanceKm !== undefined ? { distanceKm: candidate.distanceKm } : {}),
      why: selectionReason(candidate, directIntentMatchesExist),
      quote: result.quote,
      orderRequest,
      next: {
        consent: {
          tool: "request_consent",
          arguments: { quoteId: result.quoteId, confirmationText: result.confirmationText },
        },
        order: {
          tool: "create_order",
          requires: "consentId returned by request_consent",
          arguments: orderRequest,
        },
      },
    };
    ranked.push(option);
  }

  const options = ranked.slice(0, limit).map((option, index) => ({ rank: index + 1, ...option }));

  return {
    product: "SLL-R personal shopping",
    buyerId,
    request: {
      userIntent,
      ...(maxSpendUsd ? { maxSpendUsd } : {}),
      ...(deadlineMinutes !== undefined ? { deadlineMinutes } : {}),
      ...(deliverByDays !== undefined ? { deliverByDays } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(requestedMerchantIds ? { merchantIds: requestedMerchantIds } : {}),
      ...(category ? { category } : {}),
      ...(location ? { ...location, radiusKm } : {}),
      limit,
    },
    comparedMerchants: quoteCandidates.length,
    availableOptions: ranked.length,
    recommended: options[0] ?? null,
    options,
    rejected,
    next: options.length
      ? "Show the selected quote and confirmationText to the user, then call request_consent. Only call create_order after explicit confirmation."
      : "Ask the user to relax the budget, time, location, category, or merchant constraints.",
    tracking: {
      tool: "list_my_orders",
      endpoint: "/buyer/orders",
      terminalOutcome: "Verified payment or fulfillment proof produces receipt memory for future recommendations.",
    },
  };
}
