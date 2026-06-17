import { merchantForId } from "../merchants/profiles.js";
import { isItemAvailable } from "./availability.js";
import { centsFromUsd } from "./money.js";
import type { CatalogItem } from "../types.js";

// Constraint-first menu recommendation (spec: local-commerce-os-for-agents). The
// demo's signature move: "what can I get in 10 min, cold, not too sweet, under
// $10" → pick what's fast + in budget + on-taste over LIVE menu state, and
// return the REJECTED alternatives with reasons (sold out / too slow / over
// budget / wrong tag). No hallucinated items or ETAs — everything is grounded in
// the catalog + the availability (86) store.

export type MenuConstraints = {
  deadlineMinutes?: number;
  maxSpendUsd?: string;
  includeTags?: string[]; // item must carry ALL of these (e.g. ["cold"])
  excludeTags?: string[]; // item must carry NONE of these (e.g. ["sweet"])
  limit?: number;
};

export type MenuPick = { itemId: string; name: string; amountUsd: string; prepMinutes: number | null; tags: string[]; reason: string };
export type MenuReject = { itemId: string; name: string; reason: string };
export type MenuRecommendation = {
  merchant: { id: string; name: string };
  constraints: MenuConstraints;
  picks: MenuPick[];
  rejected: MenuReject[];
};

const norm = (t: string) => t.trim().toLowerCase();

export async function recommendFromMenu(merchantId: string, c: MenuConstraints): Promise<MenuRecommendation> {
  const merchant = merchantForId(merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${merchantId}`), { status: 404 });

  const deadline = c.deadlineMinutes;
  const maxCents = c.maxSpendUsd ? centsFromUsd(c.maxSpendUsd) : null;
  const include = (c.includeTags ?? []).map(norm);
  const exclude = (c.excludeTags ?? []).map(norm);

  const picks: Array<MenuPick & { prep: number }> = [];
  const rejected: MenuReject[] = [];

  for (const item of merchant.catalog) {
    const tags = (item.tags ?? []).map(norm);
    const name = item.name;
    // Checks ordered so the most decision-relevant reason wins.
    if (!(await isItemAvailable(merchant.id, item.id))) {
      rejected.push({ itemId: item.id, name, reason: "sold out" });
      continue;
    }
    if (deadline !== undefined && item.prepMinutes && item.prepMinutes > deadline) {
      rejected.push({ itemId: item.id, name, reason: `needs about ${item.prepMinutes} min (over your ${deadline} min)` });
      continue;
    }
    if (maxCents !== null && centsFromUsd(item.amountUsd) > maxCents) {
      rejected.push({ itemId: item.id, name, reason: `$${item.amountUsd} is over your $${c.maxSpendUsd} budget` });
      continue;
    }
    const hitExcluded = exclude.find((t) => tags.includes(t));
    if (hitExcluded) {
      rejected.push({ itemId: item.id, name, reason: `you asked to skip "${hitExcluded}"` });
      continue;
    }
    const missing = include.find((t) => !tags.includes(t));
    if (missing) {
      rejected.push({ itemId: item.id, name, reason: `not "${missing}"` });
      continue;
    }
    const prep = item.prepMinutes ?? 0;
    picks.push({
      itemId: item.id,
      name,
      amountUsd: item.amountUsd,
      prepMinutes: item.prepMinutes ?? null,
      tags: item.tags ?? [],
      prep,
      reason: `ready in ~${prep || "?"} min, $${item.amountUsd}`,
    });
  }

  // Fastest first, then cheapest — "skip the line" favors speed.
  picks.sort((a, b) => (a.prep - b.prep) || (centsFromUsd(a.amountUsd) - centsFromUsd(b.amountUsd)));
  const limit = c.limit ?? 3;

  return {
    merchant: { id: merchant.id, name: merchant.name },
    constraints: c,
    picks: picks.slice(0, limit).map(({ prep: _p, ...pick }) => pick),
    rejected,
  };
}
