export function centsFromUsd(amountUsd: string) {
  const normalized = amountUsd.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return 0;
  return Math.round(Number(normalized) * 100);
}

export function formatUsd(cents: number) {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2);
}
