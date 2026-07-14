import { allMerchantProfiles } from "../merchants/profiles.js";
import { listOrdersForBuyer } from "./orders.js";
import { distanceKm } from "./nearby.js";

// Cross-merchant taste recommendations. The signal is the buyer's VERIFIED past
// orders (real purchases, not clicks): we read the tags of what they bought and
// score every merchant's catalog by tag affinity, with a discovery boost toward
// merchants they haven't tried. This is the v1 taste graph — simple tag overlap;
// a learned model comes later, but the data shape (receipts → tags → affinity)
// is the durable part.

export type Recommendation = {
  merchantId: string;
  merchantName: string;
  item: { id: string; name: string; amountUsd: string };
  reason: string;
  distanceKm?: number;
};

export async function recommendForBuyer(
  buyerId: string,
  opts: { merchantId?: string; limit?: number; location?: { lat: number; lng: number }; radiusKm?: number } = {},
): Promise<Recommendation[]> {
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 8);
  const all = allMerchantProfiles();
  const byId = new Map(all.map((m) => [m.id, m]));
  // When a location is given, recommend only merchants near it (taste × place).
  // Online-only merchants (no geo) drop out of location-scoped recommendations.
  const radiusKm = opts.radiusKm ?? 25;
  const merchantDistance = new Map<string, number>();
  const merchants = all.filter((m) => {
    if (opts.merchantId && m.id !== opts.merchantId) return false;
    if (!opts.location) return true;
    if (!m.geo) return false;
    const d = distanceKm(opts.location.lat, opts.location.lng, m.geo.lat, m.geo.lng);
    if (d > radiusKm) return false;
    merchantDistance.set(m.id, Math.round(d * 10) / 10);
    return true;
  });

  const past = (await listOrdersForBuyer(buyerId, 100))
    .filter((order) => order.proofLevel === "receipt_memory_issued" && order.receipt !== null);

  // Taste = tag frequency from verified purchases; also track merchants tried and
  // exact items already bought.
  const tasteTags = new Map<string, number>();
  const triedMerchants = new Set<string>();
  const orderedKeys = new Set<string>();
  for (const order of past) {
    triedMerchants.add(order.merchantId);
    orderedKeys.add(`${order.merchantId}:${order.item.id}`);
    const item = byId.get(order.merchantId)?.catalog.find((c) => c.id === order.item.id);
    for (const tag of item?.tags ?? []) tasteTags.set(tag, (tasteTags.get(tag) ?? 0) + 1);
  }
  const hasTaste = tasteTags.size > 0;

  type Scored = Recommendation & { score: number };
  const scored: Scored[] = [];
  for (const merchant of merchants) {
    for (const item of merchant.catalog) {
      const tags = item.tags ?? [];
      let score = tags.reduce((sum, tag) => sum + (tasteTags.get(tag) ?? 0), 0);
      if (!triedMerchants.has(merchant.id)) score *= 1.15;       // discovery boost
      if (orderedKeys.has(`${merchant.id}:${item.id}`)) score *= 0.5; // demote "your usual"
      const topTag = tags
        .filter((tag) => tasteTags.has(tag))
        .sort((a, b) => (tasteTags.get(b) ?? 0) - (tasteTags.get(a) ?? 0))[0];
      const dist = merchantDistance.get(merchant.id);
      const baseReason = topTag ? `matches your taste for ${topTag}` : "a popular pick to try";
      scored.push({
        merchantId: merchant.id,
        merchantName: merchant.name,
        item: { id: item.id, name: item.name, amountUsd: item.amountUsd },
        reason: dist !== undefined ? `${baseReason}, ${dist} km away` : baseReason,
        ...(dist !== undefined ? { distanceKm: dist } : {}),
        score,
      });
    }
  }

  // Taste first; when location-scoped, nearer breaks ties.
  scored.sort((a, b) => b.score - a.score || (a.distanceKm ?? 0) - (b.distanceKm ?? 0));

  let picks: Scored[];
  if (hasTaste) {
    picks = scored.filter((s) => s.score > 0).slice(0, limit);
    for (const s of scored) {            // top up if too few scored matches
      if (picks.length >= limit) break;
      if (!picks.includes(s)) picks.push(s);
    }
  } else {
    // No history yet — spread one popular item per merchant so we still suggest.
    const seenMerchant = new Set<string>();
    picks = [];
    for (const s of scored) {
      if (picks.length >= limit) break;
      if (seenMerchant.has(s.merchantId)) continue;
      seenMerchant.add(s.merchantId);
      picks.push({ ...s, reason: "a popular pick to try" });
    }
  }

  return picks.map(({ score: _score, ...rec }) => rec);
}
