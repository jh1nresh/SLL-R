// Pure transition->message logic for customer order notifications, so it's unit
// testable independent of the polling/Sendblue plumbing.

export type WatchedOrder = {
  status?: string;
  payment?: { status?: string };
  item?: { name?: string };
  merchantName?: string;
  promise?: { estimatedWaitMinutes?: number | null };
  receipt?: { claimUrl?: string };
};

export function pickupCode(orderId: string): string {
  return orderId.replace(/^ord_/, "").slice(0, 6).toUpperCase();
}

// The customer-facing message for a status/payment transition, or null if nothing
// noteworthy changed. The caller tracks prevStatus/prevPayment per order and calls
// this on each poll.
export function statusMessage(
  o: WatchedOrder,
  prevStatus: string,
  prevPayment: string,
  orderId: string,
): string | null {
  const code = pickupCode(orderId);
  const item = o.item?.name || "your order";
  const merchant = o.merchantName || "the merchant";
  const status = o.status || "";
  const payment = o.payment?.status || "";

  // Payment just cleared (online pay) — announce once, unless the receipt step will.
  if (payment === "verified" && prevPayment !== "verified" && status !== "receipt_issued") {
    return `✅ Payment received — ${item} confirmed. 🎟️ Pickup code ${code}`;
  }

  if (status === prevStatus) return null;
  switch (status) {
    case "accepted":
    case "payment_backed": {
      const eta = o.promise?.estimatedWaitMinutes;
      return `✅ ${merchant} accepted your order — ${item}${eta ? `, ready in ~${eta} min` : ""}. 🎟️ Pickup code ${code}`;
    }
    case "ready":
      return `🔔 Your ${item} is ready for pickup! 🎟️ Code ${code}`;
    case "rejected":
      return `😕 Sorry, ${merchant} can't fulfill your ${item} right now. No charge.`;
    case "receipt_issued":
      return `✅ All set — ${item} complete.${o.receipt?.claimUrl ? `\n🧾 Receipt: ${o.receipt.claimUrl}` : ""}`;
    default:
      return null;
  }
}

// Terminal states: stop watching.
export function isTerminal(status: string | undefined): boolean {
  return status === "receipt_issued" || status === "claimed" || status === "rejected";
}
