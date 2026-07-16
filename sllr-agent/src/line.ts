import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

export class LinePushError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "LinePushError";
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isRetryablePushError(error: unknown): boolean {
  return error instanceof LinePushError ? error.retryable : isTimeoutError(error);
}

export class LineClient {
  constructor(private readonly config: LineConfig) {}

  async pushText(userId: string, text: string, retryKey = randomUUID()): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}/v2/bot/message/push`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.channelAccessToken}`,
          "content-type": "application/json",
          "x-line-retry-key": retryKey,
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: "text", text: text.slice(0, 5000) }],
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      const timedOut = isTimeoutError(error);
      throw new LinePushError(
        `LINE push ${timedOut ? "timed out" : "failed"}: ${error instanceof Error ? error.message : error}`,
        true,
      );
    }
    if (response.status === 409) return;
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      throw new LinePushError(
        `LINE push failed (${response.status}): ${payload.slice(0, 300) || "unknown error"}`,
        response.status >= 500,
        response.status,
      );
    }
  }
}

export async function pushLineTextReliable(
  client: Pick<LineClient, "pushText">,
  userId: string,
  text: string,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  const retryKey = randomUUID();
  try {
    await client.pushText(userId, text, retryKey);
  } catch (error) {
    if (!isRetryablePushError(error)) throw error;
    await sleep(2_000);
    await client.pushText(userId, text, retryKey);
  }
}
