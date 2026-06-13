// Durable key-value store for SLL-R order and demo-merchant state.
//
// Two backends, selected by environment:
//   - MemoryStore (default): in-process Maps. Survives for the process
//     lifetime only. Fine for local dev, a single long-running process, and
//     demo recordings, but NOT for serverless (each invocation is a fresh
//     process / instance) or horizontal scale.
//   - RedisRestStore: Upstash / Vercel KV REST API over fetch. Zero SDK
//     dependency. Survives cold starts and is shared across instances.
//
// Configure the REST backend with either Vercel KV env names
// (KV_REST_API_URL + KV_REST_API_TOKEN) or Upstash env names
// (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).

export interface SllrStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
  addToIndex(indexKey: string, member: string): Promise<void>;
  indexMembers(indexKey: string): Promise<string[]>;
}

class MemoryStore implements SllrStore {
  private readonly values = new Map<string, string>();
  private readonly indexes = new Map<string, Set<string>>();

  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.values.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async setJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value));
  }

  async addToIndex(indexKey: string, member: string): Promise<void> {
    const set = this.indexes.get(indexKey) ?? new Set<string>();
    set.add(member);
    this.indexes.set(indexKey, set);
  }

  async indexMembers(indexKey: string): Promise<string[]> {
    return [...(this.indexes.get(indexKey) ?? [])];
  }
}

type RedisConfig = { url: string; token: string };

function redisConfigFromEnv(): RedisConfig | null {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/$/, "");
  const token = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (!url || !token) return null;
  return { url, token };
}

class RedisRestStore implements SllrStore {
  constructor(private readonly config: RedisConfig) {}

  private async command<T>(args: Array<string>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.config.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw Object.assign(new Error(`SLL-R store backend is unreachable: ${error instanceof Error ? error.message : "fetch failed"}`), { status: 503 });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(`SLL-R store backend error ${response.status}: ${detail.slice(0, 200)}`), { status: 503 });
    }
    const payload = await response.json() as { result?: T; error?: string };
    if (payload.error) {
      throw Object.assign(new Error(`SLL-R store backend command failed: ${payload.error}`), { status: 503 });
    }
    return payload.result as T;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.command<string | null>(["GET", key]);
    return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.command(["SET", key, JSON.stringify(value)]);
  }

  async addToIndex(indexKey: string, member: string): Promise<void> {
    await this.command(["SADD", indexKey, member]);
  }

  async indexMembers(indexKey: string): Promise<string[]> {
    return (await this.command<string[]>(["SMEMBERS", indexKey])) || [];
  }
}

let store: SllrStore | null = null;

export function sllrStore(): SllrStore {
  if (!store) {
    const config = redisConfigFromEnv();
    store = config ? new RedisRestStore(config) : new MemoryStore();
  }
  return store;
}

export function storeBackendName(): "redis_rest" | "memory" {
  return redisConfigFromEnv() ? "redis_rest" : "memory";
}

// Test hook: drop the cached store so the next sllrStore() call re-reads the
// environment. Lets the smoke suite exercise both backends in one process.
export function resetStoreForTest() {
  store = null;
}
