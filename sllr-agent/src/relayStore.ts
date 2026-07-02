import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { RelayOrder } from "./orderRelay.js";

// Persistent relay state so a mid-rush restart can't strand orders (pilot
// closure Gap: pending merchant decisions + customer status watchers were
// in-memory only). Mirrors buyerStore: local atomic-write JSON, 0600, gitignored.
//
//   pending  merchantNumber -> orders awaiting the merchant's 1/2/3
//   watched  orderId -> which phone to notify on status transitions

export type WatchedRef = { phone: string; sendblueNumber: string };

type RelayState = {
  pending: Record<string, RelayOrder[]>;
  watched: Record<string, WatchedRef>;
};

export class RelayStore {
  private state: RelayState;

  constructor(private readonly path: string) {
    this.state = this.load();
  }

  private load(): RelayState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RelayState>;
      return { pending: parsed.pending ?? {}, watched: parsed.watched ?? {} };
    } catch {
      return { pending: {}, watched: {} };
    }
  }

  private persist(): void {
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch { /* exists */ }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  loadPending(): Record<string, RelayOrder[]> {
    return this.state.pending;
  }

  savePending(pending: Map<string, RelayOrder[]>): void {
    this.state.pending = Object.fromEntries([...pending.entries()].filter(([, q]) => q.length > 0));
    this.persist();
  }

  loadWatched(): Record<string, WatchedRef> {
    return { ...this.state.watched };
  }

  addWatched(orderId: string, ref: WatchedRef): void {
    this.state.watched[orderId] = ref;
    this.persist();
  }

  removeWatched(orderId: string): void {
    if (!(orderId in this.state.watched)) return;
    delete this.state.watched[orderId];
    this.persist();
  }
}
