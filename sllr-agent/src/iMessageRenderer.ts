import type { SllrAction, SllrBlock, SllrResponseEnvelope } from "./responseContract.js";

export type OutboundMessage = {
  content: string;
};

export function renderEnvelopeToSendblueMessages(envelope: SllrResponseEnvelope): OutboundMessage[] {
  const lines: string[] = [];
  for (const block of envelope.blocks) {
    const rendered = renderBlock(block);
    if (rendered) lines.push(rendered);
  }
  const actions = renderActions(envelope.actions);
  if (actions) lines.push(actions);
  const content = lines.join("\n\n").trim();
  return content ? [{ content }] : [{ content: "I need one more confirmed detail before I can say that." }];
}

function renderBlock(block: SllrBlock): string {
  switch (block.type) {
    case "PlainText":
      return block.text.trim();
    case "MerchantSummary":
      return [block.name, block.address].filter(Boolean).join("\n");
    case "ItemList":
      return block.items.map((item) => `- ${item.name} x${item.quantity}${item.unitPrice ? ` · ${item.unitPrice}` : ""}`).join("\n");
    case "QuoteSummary":
      return [`Quote ${block.quoteId}`, `Total: ${block.total} ${block.currency}`].join("\n");
    case "ConsentPrompt":
      return block.confirmationText;
    case "OrderStatus":
      return [
        `Order ${block.status}: ${block.orderId}`,
        block.pickupCode ? `Pickup code: ${block.pickupCode}` : "",
        block.etaMinutes ? `Ready in ~${block.etaMinutes} min` : "",
      ].filter(Boolean).join("\n");
    case "PaymentLink":
      if (block.rail === "counter") return `Pay at pickup: ${block.amount} ${block.currency}`;
      return [`Pay ${block.amount} ${block.currency}`, block.url ?? ""].filter(Boolean).join("\n");
    case "ReceiptLink":
      return [`Receipt: ${block.url}`, block.receiptHash ? `Hash: ${block.receiptHash}` : ""].filter(Boolean).join("\n");
    case "ClarifyingQuestion":
      return [block.question, block.choices?.map((choice, i) => `${i + 1} ${choice}`).join("\n")].filter(Boolean).join("\n");
  }
}

function renderActions(actions: SllrAction[]): string {
  if (actions.length === 0) return "";
  return [
    "Reply:",
    ...actions.slice(0, 3).map((action, i) => `${i + 1} ${action.label}`),
  ].join("\n");
}
