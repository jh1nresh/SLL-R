// Merchant side of the iMessage channel: when a customer's order is created,
// push it to the merchant's iMessage; the merchant replies 1/2/3 and we relay
// the decision back to the customer.
//
// The merchant's 1/2/3 reply mutates the CANONICAL SellerOrder.status via SLL-R's
// merchant tools, then notifies the customer. If the status mutation fails the
// customer is NOT told it succeeded — the order is re-queued and the error
// surfaced (same no-overclaim discipline as the claim guard).

import type { SendblueClient } from "./sendblue.js";
import type { RelayStore } from "./relayStore.js";

// Minimal MCP surface the relay needs (the SllrMcp client satisfies this).
export type McpCaller = { callTool(name: string, args: Record<string, unknown>, bearer?: string): Promise<unknown> };

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

// decision → the SLL-R merchant MCP tool that mutates canonical SellerOrder.status.
const TOOL_BY_DECISION: Record<Decision, string> = {
  accept: "merchant_accept_order",
  ready: "merchant_mark_ready",
  reject: "merchant_reject_order",
};

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
    // Inject to mutate canonical order state on a merchant decision. Omitted →
    // relay-only (back-compat). verifyToken authorizes the merchant tools; absent
    // → demo:true (only accepted when SLL-R has no verifier secret configured).
    private readonly mcp?: McpCaller,
    private readonly verifyToken?: string,
    // Optional durable store: pending decisions survive a mid-rush restart.
    private readonly store?: RelayStore,
  ) {
    this.merchantNumbers = new Set([...Object.values(channels), fallbackNumber].filter(Boolean));
    if (store) {
      for (const [number, queue] of Object.entries(store.loadPending())) {
        if (queue.length) this.pending.set(number, queue);
      }
    }
  }

  private persistPending(): void {
    this.store?.savePending(this.pending);
  }

  // One retry for messages that MUST land (order cards, status updates) — a
  // silently dropped "ready" text strands a customer. Final failure is logged.
  private async sendReliable(to: string, text: string): Promise<void> {
    try {
      await this.sendblue.sendMessage(to, text);
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await this.sendblue.sendMessage(to, text);
      } catch (error) {
        this.log(`[relay] SEND FAILED after retry to ${to.slice(0, 5)}…: ${error instanceof Error ? error.message : error}`);
      }
    }
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
    this.persistPending();

    const text =
      `🆕 New SLL-R order — ${relay.merchantName}\n` +
      `${relay.itemName} — $${relay.amountUsd}\n` +
      `Pickup code ${relay.pickupCode}\n` +
      `Reply 1 = accept · 2 = reject · 3 = ready`;
    await this.sendReliable(merchantNumber, text);
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
    // Rush safety: with more than one pending order, a bare digit is ambiguous —
    // require the pickup code rather than guessing the oldest (mis-accept risk).
    if (!code && queue.length > 1) {
      const codes = queue.map((o) => `${o.pickupCode} (${o.itemName})`).join(", ");
      await this.sendblue.sendMessage(fromNumber, `You have ${queue.length} pending orders — add the pickup code, e.g. "${tokens[0]} ${queue[0].pickupCode}".\nPending: ${codes}`);
      return;
    }
    const idx = code ? queue.findIndex((o) => o.pickupCode === code) : 0;
    if (idx < 0 || queue.length === 0) {
      await this.sendblue.sendMessage(fromNumber, code ? `No pending order with code ${code}.` : "No pending orders.");
      return;
    }
    const [order] = queue.splice(idx, 1);
    this.pending.set(fromNumber, queue);
    this.persistPending();

    // Mutate canonical state FIRST. If it fails, re-queue and tell the merchant —
    // never tell the customer about a state that didn't actually change.
    try {
      await this.applyDecision(order, decision);
    } catch (error) {
      queue.unshift(order);
      this.pending.set(fromNumber, queue);
      this.persistPending();
      const reason = error instanceof Error ? error.message : "unknown error";
      await this.sendblue.sendMessage(fromNumber, `⚠️ Couldn't update order ${order.pickupCode} (${reason}). It's still pending — try again.`);
      this.log(`[relay] applyDecision failed for ${order.orderId}: ${reason}`);
      return;
    }

    await this.notifyCustomer(order, decision);
    await this.sendReliable(fromNumber, `Got it — order ${order.pickupCode} marked ${decision}.`);
    this.log(`[relay] merchant ${decision} order ${order.orderId} → canonical status mutated`);
  }

  // Mutate canonical SellerOrder.status via SLL-R's merchant tool. Relay-only
  // (no mcp injected) → no-op. Throws if the tool call fails (caller handles).
  private async applyDecision(order: RelayOrder, decision: Decision): Promise<void> {
    if (!this.mcp) return;
    const auth = this.verifyToken ? { verificationToken: this.verifyToken } : { demo: true };
    await this.mcp.callTool(TOOL_BY_DECISION[decision], { merchantId: order.merchantId, orderId: order.orderId, ...auth });
  }

  private async notifyCustomer(order: RelayOrder, decision: Decision): Promise<void> {
    const msg =
      decision === "accept"
        ? `✅ ${order.merchantName} accepted your order — ${order.itemName}. Pickup code ${order.pickupCode}.`
        : decision === "ready"
          ? `🔔 Your order is ready for pickup! ${order.itemName} — code ${order.pickupCode}.`
          : `😕 Sorry, ${order.merchantName} can't fulfill your ${order.itemName} right now. No charge.`;
    await this.sendReliable(order.customerNumber, msg);
  }
}
