// Sendblue iMessage transport. Two halves:
//  - SendblueClient.sendMessage: POST a message out to a phone number.
//  - parseInbound: normalize Sendblue's inbound webhook payload.
// Docs: https://docs.sendblue.com/api-v2/ and /getting-started/webhooks/

import type { SendblueConfig } from "./config.js";

const SEND_URL = "https://api.sendblue.co/api/send-message";

export class SendblueClient {
  constructor(private readonly config: SendblueConfig) {}

  // Send an iMessage (falls back to SMS for non-iMessage numbers on Sendblue's
  // side). Returns the message_handle for tracking, or throws on a hard error.
  async sendMessage(number: string, content: string): Promise<string> {
    const body: Record<string, unknown> = { number, content };
    if (this.config.fromNumber) body.from_number = this.config.fromNumber;

    const res = await fetch(SEND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": this.config.apiKeyId,
        "sb-api-secret-key": this.config.apiSecret,
      },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({})) as {
      message_handle?: string;
      status?: string;
      error_message?: string;
    };
    if (!res.ok || payload.error_message) {
      throw new Error(`Sendblue send failed (${res.status}): ${payload.error_message || "unknown error"}`);
    }
    return payload.message_handle ?? "";
  }
}

export type InboundMessage = {
  fromNumber: string;     // the customer's (or merchant's) number, E.164
  content: string;        // message text ("" for status/typing events)
  isOutbound: boolean;    // true = our own outbound status callback, ignore
  messageHandle: string;  // unique id, used for idempotent dedupe
  isTyping: boolean;      // typing indicator, not a real message
};

// Normalize Sendblue's inbound webhook JSON into the fields we route on.
// Sendblue posts both inbound customer replies and outbound status callbacks to
// the same URL; callers must drop isOutbound / isTyping / empty-content events.
export function parseInbound(body: unknown): InboundMessage {
  const b = (typeof body === "object" && body ? body : {}) as Record<string, unknown>;
  return {
    fromNumber: typeof b.from_number === "string" ? b.from_number : (typeof b.number === "string" ? b.number : ""),
    content: typeof b.content === "string" ? b.content : "",
    isOutbound: b.is_outbound === true,
    messageHandle: typeof b.message_handle === "string" ? b.message_handle : "",
    isTyping: b.isTyping === true || b.is_typing === true,
  };
}

// Optional shared-secret check. Sendblue can attach a configured secret to the
// webhook request; the exact header name is not documented, so we accept it from
// a header (sb-signing-secret / x-sendblue-secret), a ?secret= query param, or a
// `secret` body field. If no secret is configured, all requests pass.
export function verifyWebhookSecret(
  config: SendblueConfig,
  headers: Record<string, string | string[] | undefined>,
  url: URL,
  body: unknown,
): boolean {
  if (!config.webhookSecret) return true;
  const fromHeader = headers["sb-signing-secret"] || headers["x-sendblue-secret"] || headers["x-webhook-secret"];
  const headerVal = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  const queryVal = url.searchParams.get("secret") || undefined;
  const bodyVal = typeof body === "object" && body && typeof (body as Record<string, unknown>).secret === "string"
    ? (body as Record<string, unknown>).secret as string
    : undefined;
  return [headerVal, queryVal, bodyVal].includes(config.webhookSecret);
}
