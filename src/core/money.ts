import type { Money } from "../types.js";

export function minorUnitsFromDecimal(amount: string, currency: Money["currency"]) {
  const normalized = amount.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return 0;
  const [whole, fraction = ""] = normalized.split(".");
  if (currency === "TWD") {
    if (fraction && /[1-9]/.test(fraction)) return 0;
  }
  const digits = currency === "TWD"
    ? whole
    : `${whole}${fraction.padEnd(2, "0")}`;
  const amountMinor = Number(digits);
  return Number.isSafeInteger(amountMinor) ? amountMinor : 0;
}

export function centsFromUsd(amountUsd: string) {
  return minorUnitsFromDecimal(amountUsd, "USD");
}

export function formatUsd(cents: number) {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}
