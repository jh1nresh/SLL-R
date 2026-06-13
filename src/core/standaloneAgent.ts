import { merchantForId } from "../merchants/profiles.js";
import type { OrderRequest, QuoteRequest } from "../types.js";
import { createOrder } from "./orders.js";
import { quoteOrder } from "./quote.js";

function textFrom(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function maxSpendFrom(intent: string, fallback: unknown) {
  const explicit = textFrom(fallback);
  if (explicit) return explicit;
  const match = intent.match(/(?:under|below|less than|max|\$)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
  return match ? match[1] : undefined;
}

function deadlineMinutesFrom(intent: string, fallback: unknown) {
  if (typeof fallback === "number" && Number.isFinite(fallback)) return Math.max(1, Math.trunc(fallback));
  const match = intent.match(/(\d+)\s*(?:min|mins|minute|minutes)/i);
  return match ? Math.max(1, Number(match[1])) : undefined;
}

function deliverByDaysFrom(intent: string, fallback: unknown) {
  if (typeof fallback === "number" && Number.isFinite(fallback)) return Math.max(1, Math.trunc(fallback));
  const match = intent.match(/(\d+)\s*(?:day|days)/i);
  return match ? Math.max(1, Number(match[1])) : undefined;
}

function quantityFrom(intent: string, fallback: unknown) {
  if (typeof fallback === "number" && Number.isFinite(fallback)) return Math.min(Math.max(1, Math.trunc(fallback)), 20);
  const match = intent.match(/\b(\d+)\s*(?:x|bag|bags|latte|drink|drinks|item|items)\b/i);
  return match ? Math.min(Math.max(1, Number(match[1])), 20) : 1;
}

function checkoutHandoffFor(merchantId: string, itemId?: string) {
  const merchant = merchantForId(merchantId);
  const item = merchant?.catalog.find((candidate) => candidate.id === itemId);
  if (!item?.productUrl) return null;
  return {
    mode: "existing_checkout",
    url: item.productUrl,
    label: `${merchant?.name || merchantId} checkout`,
  };
}

export async function standaloneAgentMessage(merchantId: string, payload: Record<string, unknown>, origin: string) {
  const merchant = merchantForId(merchantId);
  if (!merchant) throw Object.assign(new Error(`Unknown merchant: ${merchantId}`), { status: 404 });

  const intent = textFrom(payload.message || payload.userIntent);
  if (!intent) throw Object.assign(new Error("Missing message."), { status: 400 });

  const quoteInput: QuoteRequest = {
    merchantId,
    userIntent: intent,
    maxSpendUsd: maxSpendFrom(intent, payload.maxSpendUsd),
    deadlineMinutes: deadlineMinutesFrom(intent, payload.deadlineMinutes),
    deliverByDays: deliverByDaysFrom(intent, payload.deliverByDays),
    quantity: quantityFrom(intent, payload.quantity),
  };
  const quote = quoteOrder(quoteInput);
  const confirm = payload.confirm === true;
  const checkoutHandoff = checkoutHandoffFor(merchantId, quote.item?.id);

  if (!confirm) {
    return {
      product: "SLL-R standalone ordering agent",
      merchant: { id: merchant.id, name: merchant.name },
      mode: "quote",
      quote,
      checkoutHandoff,
      reply: quote.feasible && quote.item
        ? `I found ${quote.item.name} for $${quote.item.subtotalUsd}. ${quote.estimate.readyInMinutes ? `Estimated pickup is ${quote.estimate.readyInMinutes} minutes.` : quote.estimate.shippingDays ? `Estimated shipping is ${quote.estimate.shippingDays} days.` : "It is available."} Confirm to create the order.`
        : `I cannot create this order yet. ${quote.reasons.join(" ")}`,
      next: quote.feasible ? "Send confirm=true to create the SLL-R order." : "Ask the customer to choose an alternative.",
    };
  }

  const requestedPaymentMode = textFrom(payload.paymentMode);
  const orderInput: OrderRequest = {
    ...quoteInput,
    agentId: textFrom(payload.agentId) || "sllr-standalone-agent",
    customerLabel: textFrom(payload.customerLabel) || "SLL-R customer",
    paymentMode: requestedPaymentMode === "counter"
      ? "counter"
      : requestedPaymentMode === "crypto"
        ? "crypto"
        : requestedPaymentMode === "checkout"
          ? "checkout"
          : undefined,
  };
  const result = await createOrder(orderInput);
  return {
    product: "SLL-R standalone ordering agent",
    merchant: { id: merchant.id, name: merchant.name },
    mode: "order_created",
    quote: result.quote,
    order: result.order,
    checkoutHandoff: checkoutHandoffFor(merchantId, result.order.item.id),
    terminalUrl: `${origin}/terminal/${merchantId}`,
    reply: `Order ${result.order.id} is ready for ${merchant.name}. ${result.order.promise.estimatedWaitMinutes ? `Pickup promise: about ${result.order.promise.estimatedWaitMinutes} minutes.` : result.order.promise.promisedReadyAt ? `Pickup promise: ${result.order.promise.promisedReadyAt}.` : "Use checkout or staff confirmation to complete it."}`,
    next: "Checkout through the existing rail or let staff accept the order in the terminal.",
  };
}
