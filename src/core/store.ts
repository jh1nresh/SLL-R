// Durable key-value store for SLL-R order and demo-merchant state.
//
// Backends, selected by environment (first configured wins):
//   - SupabaseStore: Supabase Postgres via the PostgREST HTTP API over fetch.
//     Zero SDK dependency. Needs two tables (see docs/supabase-store-runbook.md)
//     and a service-role key. Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
//   - RedisRestStore: Upstash / Vercel KV REST API over fetch. Zero SDK
//     dependency. Configure KV_REST_API_URL + KV_REST_API_TOKEN, or
//     UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
//   - MemoryStore (default): in-process Maps. Survives for the process
//     lifetime only. Fine for local dev, a single long-running process, and
//     demo recordings, but NOT for serverless (each invocation is a fresh
//     process / instance) or horizontal scale.

export interface SllrStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
  setJsonIfAbsent(key: string, value: unknown): Promise<boolean>;
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

  async setJsonIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, JSON.stringify(value));
    return true;
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

  async setJsonIfAbsent(key: string, value: unknown): Promise<boolean> {
    return (await this.command<string | null>(["SET", key, JSON.stringify(value), "NX"])) === "OK";
  }

  async addToIndex(indexKey: string, member: string): Promise<void> {
    await this.command(["SADD", indexKey, member]);
  }

  async indexMembers(indexKey: string): Promise<string[]> {
    return (await this.command<string[]>(["SMEMBERS", indexKey])) || [];
  }
}

type SupabaseConfig = { url: string; key: string };

function supabaseConfigFromEnv(): SupabaseConfig | null {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || ""
  ).trim();
  if (!url || !key) return null;
  return { url, key };
}

// Supabase Postgres via PostgREST. Two tables:
//   sllr_kv(key text primary key, value jsonb not null)
//   sllr_index(index_key text, member text, primary key(index_key, member))
// The service-role key bypasses RLS, so server-side reads/writes work without
// row-level policies. value is jsonb, so PostgREST returns it as native JSON
// (no string round-trip).
class SupabaseStore implements SllrStore {
  private readonly rest: string;
  private readonly headers: Record<string, string>;

  constructor(config: SupabaseConfig) {
    this.rest = `${config.url}/rest/v1`;
    this.headers = {
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
    };
  }

  private async request<T>(path: string, init: RequestInit & { prefer?: string }): Promise<T> {
    const { prefer, ...rest } = init;
    let response: Response;
    try {
      response = await fetch(`${this.rest}${path}`, {
        ...rest,
        headers: { ...this.headers, ...(prefer ? { prefer } : {}) },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw Object.assign(new Error(`SLL-R Supabase store is unreachable: ${error instanceof Error ? error.message : "fetch failed"}`), { status: 503 });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(`SLL-R Supabase store error ${response.status}: ${detail.slice(0, 200)}`), { status: 503 });
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  // Keys must be pre-validated/generated (order ids, validated merchant ids,
  // static prefixes). encodeURIComponent does not encode . ( ) ! * ', so a
  // free-form, user-controlled key would not be safe in a PostgREST eq. filter.
  async getJson<T>(key: string): Promise<T | null> {
    const rows = await this.request<Array<{ value: T }>>(
      `/sllr_kv?key=eq.${encodeURIComponent(key)}&select=value&limit=1`,
      { method: "GET" },
    );
    return rows && rows.length > 0 ? rows[0].value : null;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.request("/sllr_kv?on_conflict=key", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify([{ key, value }]),
    });
  }

  async setJsonIfAbsent(key: string, value: unknown): Promise<boolean> {
    const rows = await this.request<Array<{ key: string }>>("/sllr_kv?on_conflict=key&select=key", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: JSON.stringify([{ key, value }]),
    });
    return (rows || []).some((row) => row.key === key);
  }

  async addToIndex(indexKey: string, member: string): Promise<void> {
    await this.request("/sllr_index?on_conflict=index_key,member", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=minimal",
      body: JSON.stringify([{ index_key: indexKey, member }]),
    });
  }

  async indexMembers(indexKey: string): Promise<string[]> {
    const rows = await this.request<Array<{ member: string }>>(
      `/sllr_index?index_key=eq.${encodeURIComponent(indexKey)}&select=member`,
      { method: "GET" },
    );
    return (rows || []).map((row) => row.member);
  }
}

let store: SllrStore | null = null;

export function sllrStore(): SllrStore {
  if (!store) {
    const supabase = supabaseConfigFromEnv();
    const redis = redisConfigFromEnv();
    store = supabase ? new SupabaseStore(supabase)
      : redis ? new RedisRestStore(redis)
      : new MemoryStore();
  }
  return store;
}

export function storeBackendName(): "supabase" | "redis_rest" | "memory" {
  if (supabaseConfigFromEnv()) return "supabase";
  if (redisConfigFromEnv()) return "redis_rest";
  return "memory";
}

// Test hook: drop the cached store so the next sllrStore() call re-reads the
// environment. Lets the smoke suite exercise both backends in one process.
export function resetStoreForTest() {
  store = null;
}
