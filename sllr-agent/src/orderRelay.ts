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

  constructor(
    private readonly sendblue: SendblueClient,
    private readonly merchantNumber: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  // Called from the create_order tool-result hook. Extracts the order and pushes
  // it to the merchant. Safe to call for any tool result — it no-ops on non-orders.
  async onToolResult(customerNumber: string, name: string, result: unknown): Promise<void> {
    if (name !== "create_order") return;
    const order = (typeof result === "object" && result ? (result as Record<string, unknown>).order : undefined) as
      | { id?: string; merchantId?: string; item?: { name?: string; subtotalUsd?: string | number } }
      | undefined;
    if (!order?.id) return;

    const relay: RelayOrder = {
      orderId: order.id,
      merchantId: typeof order.merchantId === "string" ? order.merchantId : "unknown",
      itemName: order.item?.name ?? "order",
      amountUsd: String(order.item?.subtotalUsd ?? "?"),
      pickupCode: pickupCodeFor(order.id),
      customerNumber,
    };

    if (!this.merchantNumber) {
      this.log(`[relay] order ${relay.orderId} created but SLLR_MERCHANT_NUMBER unset — merchant push skipped`);
      return;
    }
    const queue = this.pending.get(this.merchantNumber) ?? [];
    queue.push(relay);
    this.pending.set(this.merchantNumber, queue);

    const text =
      `🆕 New SLL-R order\n` +
      `${relay.itemName} — $${relay.amountUsd}\n` +
      `Pickup code ${relay.pickupCode}\n` +
      `Reply 1 = accept · 2 = reject · 3 = ready`;
    await this.sendblue.sendMessage(this.merchantNumber, text);
    this.log(`[relay] pushed order ${relay.orderId} to merchant ${this.merchantNumber}`);
  }

  // True if this inbound number is the merchant we push orders to.
  isMerchant(fromNumber: string): boolean {
    return !!this.merchantNumber && fromNumber === this.merchantNumber;
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
        ? `✅ ${order.merchantId} accepted your order — ${order.itemName}. Pickup code ${order.pickupCode}.`
        : decision === "ready"
          ? `🔔 Your order is ready for pickup! ${order.itemName} — code ${order.pickupCode}.`
          : `😕 Sorry, ${order.merchantId} can't fulfill your ${order.itemName} right now. No charge.`;
    await this.sendblue.sendMessage(order.customerNumber, msg);
  }
}
