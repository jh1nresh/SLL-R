import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

// Persistent channel-identity → buyer mapping. Keeps the SAME buyer (token +
// buyerId) for a given phone number across server restarts, so SLL-R remembers
// the customer's past orders (taste). Orders persist in SLL-R; this file only
// holds the identity link, which is the channel adapter's concern.
//
// v0: a local JSON file (bearer tokens in plaintext — gitignored, single-operator
// server). A future backend channel-buyer endpoint can replace this.

export type StoredBuyer = { token: string; buyerId: string };

export class BuyerStore {
  private map: Record<string, StoredBuyer>;

  constructor(private readonly path: string) {
    this.map = this.load();
  }

  private load(): Record<string, StoredBuyer> {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, StoredBuyer>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch { /* dir exists */ }
    // Atomic write: tmp then rename, so a crash mid-write can't corrupt the file.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.map, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(phone: string): StoredBuyer | undefined {
    return this.map[phone];
  }

  set(phone: string, buyer: StoredBuyer): void {
    this.map[phone] = buyer;
    this.persist();
  }
}
