import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { cardKey, type AgentCard } from "./agentCard.js";

// Persistent per-(channelUser, merchant) Agent Card store — mirrors BuyerStore:
// a local atomic-write JSON file (gitignored, single-operator server). Also
// tracks each user's last-touched merchant so a returning buyer's free-form
// message resolves to the right shop's card.

export class AgentCardStore {
  private cards: Record<string, AgentCard>;
  private lastMerchant: Record<string, string>;

  constructor(private readonly path: string) {
    const loaded = this.load();
    this.cards = loaded.cards;
    this.lastMerchant = loaded.lastMerchant;
  }

  private load(): { cards: Record<string, AgentCard>; lastMerchant: Record<string, string> } {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { cards?: Record<string, AgentCard>; lastMerchant?: Record<string, string> };
      return { cards: parsed.cards ?? {}, lastMerchant: parsed.lastMerchant ?? {} };
    } catch {
      return { cards: {}, lastMerchant: {} };
    }
  }

  private persist(): void {
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch { /* exists */ }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ cards: this.cards, lastMerchant: this.lastMerchant }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(channelUserId: string, merchantId: string): AgentCard | undefined {
    return this.cards[cardKey(channelUserId, merchantId)];
  }

  set(card: AgentCard): void {
    this.cards[cardKey(card.channelUserId, card.merchantId)] = card;
    this.lastMerchant[card.channelUserId] = card.merchantId;
    this.persist();
  }

  lastMerchantFor(channelUserId: string): string | undefined {
    return this.lastMerchant[channelUserId];
  }
}
