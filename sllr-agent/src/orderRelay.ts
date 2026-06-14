// Merchant side of the iMessage channel: when a customer's order is created,
// push it to the merchant's iMessage; the merchant replies 1/2/3 and we relay
// the decision back to the customer.
//
// v0 scope: this is a CHANNEL RELAY. The merchant's decision is messaged to the
// customer but does NOT yet mutate SLL-R order state — there is no merchant
// order-status MCP tool. applyDecision() is the seam where that tool call lands.

import type { SendblueClient } from "./sendblue.js";

export type RelayOrder = {
  orderId: string;
  merchantId: string;
  merchantName: string;
  itemName: string;
  amountUsd: string;
  pickupCode: string;
  customerNumber: string;
};

type Decision = "accept" | "reject" | "ready";

const DECISION_BY_DIGIT: Record<string, Decision> = { "1": "accept", "2": "reject", "3": "ready" };

// Pickup code matches SLL-R's derivation (paymentOptions.ts): first 6 chars of
// the order id after the ord_ prefix, uppercased.
export function pickupCodeFor(orderId: string): string {
  return orderId.replace(/^ord_/, "").slice(0, 6).toUpperCase();
}

export class OrderRelay {
  // Orders awaiting a merchant decision, oldest first, keyed by merchant number.
  private pending = new Map<string, RelayOrder[]>();

  // Per-merchant notify numbers (merchantId -> number) for multi-merchant routing,
  // plus an optional fallback number used for any merchant without its own entry
  // (single-merchant demo). Reverse set lets us recognise merchant inbounds.
  private readonly merchantNumbers: Set<string>;

  constructor(
    private readonly sendblue: SendblueClient,
    private readonly channels: Record<string, string>,
    private readonly fallbackNumber: string,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.merchantNumbers = new Set([...Object.values(channels), fallbackNumber].filter(Boolean));
  }

  // The notify number for a given merchant: its own channel, else the fallback.
  private numberForMerchant(merchantId: string): string {
    return this.channels[merchantId] || this.fallbackNumber || "";
  }

  // Called from the create_order tool-result hook. Extracts the order and pushes
  // it to that merchant's number. Safe to call for any tool result — no-ops on
  // non-orders. Routes by merchantId, so multiple merchants work concurrently.
  async onToolResult(customerNumber: string, name: string, result: unknown): Promise<void> {
    if (name !== "create_order") return;
    const order = (typeof result === "object" && result ? (result as Record<string, unknown>).order : undefined) as
      | { id?: string; merchantId?: string; merchantName?: string; item?: { name?: string; subtotalUsd?: string | number } }
      | undefined;
    if (!order?.id) return;

    const merchantId = typeof order.merchantId === "string" ? order.merchantId : "unknown";
    const relay: RelayOrder = {
      orderId: order.id,
      merchantId,
      merchantName: typeof order.merchantName === "string" ? order.merchantName : merchantId,
      itemName: order.item?.name ?? "order",
      amountUsd: String(order.item?.subtotalUsd ?? "?"),
      pickupCode: pickupCodeFor(order.id),
      customerNumber,
    };

    const merchantNumber = this.numberForMerchant(merchantId);
    if (!merchantNumber) {
      this.log(`[relay] order ${relay.orderId} created — no channel for merchant ${merchantId}, push skipped`);
      return;
    }
    const queue = this.pending.get(merchantNumber) ?? [];
    queue.push(relay);
    this.pending.set(merchantNumber, queue);

    const text =
      `🆕 New SLL-R order — ${relay.merchantName}\n` +
      `${relay.itemName} — $${relay.amountUsd}\n` +
      `Pickup code ${relay.pickupCode}\n` +
      `Reply 1 = accept · 2 = reject · 3 = ready`;
    await this.sendblue.sendMessage(merchantNumber, text);
    this.log(`[relay] pushed order ${relay.orderId} to ${merchantId} (${merchantNumber})`);
  }

  // True if this inbound number belongs to any configured merchant.
  isMerchant(fromNumber: string): boolean {
    return this.merchantNumbers.has(fromNumber);
  }

  // Handle a merchant's "1" / "2" / "3" (optionally "1 <code>" to target a
  // specific pending order). Applies to the oldest pending order otherwise.
  async handleMerchantReply(fromNumber: string, content: string): Promise<void> {
    const queue = this.pending.get(fromNumber) ?? [];
    const tokens = content.trim().split(/\s+/);
    const decision = DECISION_BY_DIGIT[tokens[0]];
    if (!decision) {
      await this.sendblue.sendMessage(fromNumber, "Reply 1 = accept · 2 = reject · 3 = ready (optionally add the pickup code, e.g. \"1 34CF58\").");
      return;
    }

    const code = tokens[1]?.toUpperCase();
    const idx = code ? queue.findIndex((o) => o.pickupCode === code) : 0;
    if (idx < 0 || queue.length === 0) {
      await this.sendblue.sendMessage(fromNumber, code ? `No pending order with code ${code}.` : "No pending orders.");
      return;
    }
    const [order] = queue.splice(idx, 1);
    this.pending.set(fromNumber, queue);

    await this.applyDecision(order, decision);
    await this.notifyCustomer(order, decision);
    await this.sendblue.sendMessage(fromNumber, `Got it — order ${order.pickupCode} marked ${decision}.`);
    this.log(`[relay] merchant ${decision} order ${order.orderId}`);
  }

  // SEAM: where a future merchant order-status MCP tool call goes (accept/reject/
  // ready → SLL-R order state). v0 is relay-only, so this is intentionally a no-op.
  private async applyDecision(_order: RelayOrder, _decision: Decision): Promise<void> {
    // TODO(step 3+): call SLL-R merchant status tool to mutate order state.
  }

  private async notifyCustomer(order: RelayOrder, decision: Decision): Promise<void> {
    const msg =
      decision === "accept"
        ? `✅ ${order.merchantName} accepted your order — ${order.itemName}. Pickup code ${order.pickupCode}.`
        : decision === "ready"
          ? `🔔 Your order is ready for pickup! ${order.itemName} — code ${order.pickupCode}.`
          : `😕 Sorry, ${order.merchantName} can't fulfill your ${order.itemName} right now. No charge.`;
    await this.sendblue.sendMessage(order.customerNumber, msg);
  }
}
