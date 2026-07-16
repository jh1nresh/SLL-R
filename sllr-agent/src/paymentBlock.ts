type PaymentOption = {
  rail?: unknown;
  type?: unknown;
  url?: unknown;
  pickupCode?: unknown;
};

export function paymentBlock(optsResult: unknown, preferredRails: string[] = []): string {
  const opts = (optsResult as { paymentOptions?: PaymentOption[] } | undefined)?.paymentOptions ?? [];
  const counter = opts.find((option) => option.rail === "counter" && option.type === "pay_at_counter");
  const withUrl = opts.filter((option) => typeof option.url === "string" && option.url);
  let pay: PaymentOption | undefined;
  for (const rail of preferredRails) {
    pay = withUrl.find((option) => option.rail === rail);
    if (pay) break;
  }
  if (!pay) pay = withUrl.find((option) => option.type === "checkout_url") || withUrl[0];

  const lines: string[] = [];
  if (typeof counter?.pickupCode === "string" && counter.pickupCode) {
    lines.push(`🎟️ Pickup code: ${counter.pickupCode}`);
  }
  if (pay && typeof pay.url === "string") {
    const rail = typeof pay.rail === "string" ? pay.rail : "online";
    const label = rail === "line_pay" ? "LINE Pay" : rail === "stripe" ? "Apple Pay / card" : rail.replace(/_/g, " ");
    lines.push(`💳 Pay now (${label}): ${pay.url}`);
  } else if (counter) {
    lines.push("💵 Pay at the counter when you pick up.");
  } else {
    lines.push("Payment options are currently unavailable. Check the order status or contact the merchant.");
  }
  return lines.join("\n");
}
