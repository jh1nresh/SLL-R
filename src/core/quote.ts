import { merchantForId } from "../merchants/profiles.js";
import type { CatalogItem, QuoteRequest, QuoteResult } from "../types.js";
import { centsFromUsd, formatUsd } from "./money.js";

function normalized(value: string) {
  return ` ${value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function quantityFrom(value: number | undefined) {
  return Math.min(Math.max(Math.trunc(value || 1), 1), 20);
}

function maxSpendCents(value: string | undefined) {
  if (!value) return null;
  const cents = centsFromUsd(value);
  return cents > 0 ? cents : null;
}

export function scoreCatalogItem(intent: string, item: CatalogItem) {
  const text = normalized(intent);
  const terms = [item.id, item.name, ...(item.tags || [])].flatMap((term) => [
    term,
    term.replace(/-/g, " "),
  ]);
  return terms.reduce((score, term) => {
    const clean = normalized(term).trim();
    if (!clean) return score;
    return text.includes(` ${clean} `) ? score + clean.length : score;
  }, 0);
}

export function quoteOrder(input: QuoteRequest): QuoteResult {
  const merchant = merchantForId(input.merchantId);
  if (!merchant) {
    throw Object.assign(new Error(`Unknown merchant: ${input.merchantId}`), { status: 404 });
  }

  const quantity = quantityFrom(input.quantity);
  const maxCents = maxSpendCents(input.maxSpendUsd);
  const ranked = merchant.catalog
    .map((item) => ({ item, score: scoreCatalogItem(input.userIntent, item) }))
    .sort((left, right) => right.score - left.score || centsFromUsd(left.item.amountUsd) - centsFromUsd(right.item.amountUsd));
  const selected = input.itemId
    ? merchant.catalog.find((item) => item.id === input.itemId) || null
    : ranked.find((entry) => entry.score > 0)?.item || merchant.catalog[0] || null;

  if (!selected) {
    return {
      merchant,
      feasible: false,
      decision: "negotiate_or_ask_user",
      item: null,
      estimate: { readyInMinutes: null, shippingDays: null },
      reasons: [input.itemId
        ? `Item ${input.itemId} is not in ${merchant.name}'s catalog.`
        : "Merchant has no configured catalog items."],
      alternatives: [],
    };
  }

  const subtotalCents = centsFromUsd(selected.amountUsd) * quantity;
  const reasons: string[] = [];
  if (input.deadlineMinutes && !selected.fulfillment.includes("pickup")) {
    reasons.push(`${selected.name} is not available for pickup.`);
  }
  if (input.deliverByDays && !selected.fulfillment.includes("shipping")) {
    reasons.push(`${selected.name} is not available for shipping.`);
  }
  if (maxCents !== null && subtotalCents > maxCents) {
    reasons.push(`Subtotal $${formatUsd(subtotalCents)} exceeds max spend $${formatUsd(maxCents)}.`);
  }
  if (typeof selected.inventory === "number" && selected.inventory < quantity) {
    reasons.push(`Only ${selected.inventory} available.`);
  }
  if (input.deadlineMinutes && selected.prepMinutes && selected.prepMinutes > input.deadlineMinutes) {
    reasons.push(`${selected.name} needs about ${selected.prepMinutes} minutes.`);
  }
  if (input.deliverByDays && selected.shippingDays && selected.shippingDays > input.deliverByDays) {
    reasons.push(`${selected.name} ships in about ${selected.shippingDays} days.`);
  }

  const feasible = reasons.length === 0;
  const alternatives = feasible
    ? []
    : merchant.catalog
      .filter((item) => item.id !== selected.id)
      .slice(0, 3)
      .map((item) => ({
        itemId: item.id,
        name: item.name,
        amountUsd: item.amountUsd,
        reason: item.prepMinutes ? `about ${item.prepMinutes} minutes` : item.shippingDays ? `about ${item.shippingDays} days` : "available alternative",
      }));

  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      fulfillment: merchant.fulfillment,
      paymentRails: merchant.paymentRails,
    },
    feasible,
    decision: feasible ? "create_order_allowed" : "negotiate_or_ask_user",
    item: {
      id: selected.id,
      name: selected.name,
      quantity,
      amountUsd: selected.amountUsd,
      subtotalUsd: formatUsd(subtotalCents),
    },
    estimate: {
      readyInMinutes: selected.prepMinutes || null,
      shippingDays: selected.shippingDays || null,
    },
    reasons: feasible ? ["Merchant can satisfy this request."] : reasons,
    alternatives,
  };
}
