type PaymentOption = {
  rail?: unknown;
  type?: unknown;
  url?: unknown;
  pickupCode?: unknown;
};

export function paymentBlock(optsResult: unknown, preferredRails: string[] = []): string {
  const opts = (optsResult as { paymentOptions?: PaymentOption[] } | undefined)?.paymentOptions ?? [];
  const counter = opts.find((option) => option.rail === "counter");
  const withUrl = opts.filter((option) => typeof option.url === "string" && option.url);
  let pay: PaymentOption | undefined;
  for (const rail of preferredRails) {
    pay = withUrl.find((option) => option.rail === rail);
    if (pay) break;
  }
  if (!pay && preferredRails.length === 0) {
    pay = withUrl.find((option) => option.type === "checkout_url");
  }

  const lines: string[] = [];
  if (typeof counter?.pickupCode === "string" && counter.pickupCode) {
    lines.push(`🎟️ Pickup code: ${counter.pickupCode}`);
  }
  if (pay && typeof pay.url === "string") {
    const rail = typeof pay.rail === "string" ? pay.rail : "online";
    const label = rail === "line_pay" ? "LINE Pay" : rail === "stripe" ? "Apple Pay / card" : rail.replace(/_/g, " ");
    lines.push(`💳 Pay now (${label}): ${pay.url}`);
  } else {
    lines.push("💵 Pay at the counter when you pick up.");
  }
  return lines.join("\n");
}
