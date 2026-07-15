import { createHmac, timingSafeEqual } from "node:crypto";
import type { LineConfig } from "./config.js";

export type LineInboundMessage = {
  userId: string;
  text: string;
  webhookEventId: string;
};

type LineWebhookEvent = {
  type?: unknown;
  mode?: unknown;
  webhookEventId?: unknown;
  source?: {
    type?: unknown;
    userId?: unknown;
  };
  message?: {
    type?: unknown;
    text?: unknown;
  };
};

export function verifyLineSignature(rawBody: string, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody, "utf8").digest();
  const received = Buffer.from(signature, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseLineMessages(body: unknown): LineInboundMessage[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];

  const messages: LineInboundMessage[] = [];
  for (const value of events) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as LineWebhookEvent;
    if (event.type !== "message" || event.mode === "standby") continue;
    if (event.source?.type !== "user" || typeof event.source.userId !== "string") continue;
    if (event.message?.type !== "text" || typeof event.message.text !== "string") continue;
    if (typeof event.webhookEventId !== "string" || !event.webhookEventId) continue;
    const text = event.message.text.trim();
    if (!text) continue;
    messages.push({ userId: event.source.userId, text, webhookEventId: event.webhookEventId });
  }
  return messages;
}

export class LineEventDeduper {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 5_000) {}

  accept(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(eventId);
    return true;
  }
}

export class LineClient {
  constructor(private readonly config: LineConfig) {}

  async pushText(userId: string, text: string): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}/v2/bot/message/push`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.channelAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text: text.slice(0, 5000) }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new Error(`LINE push failed (${response.status}): ${payload.slice(0, 300) || "unknown error"}`);
    }
  }
}
