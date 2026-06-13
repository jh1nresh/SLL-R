# SLL-R Supabase Store Runbook

SLL-R can persist orders and runtime demo merchants in Supabase Postgres through
the PostgREST HTTP API (no SDK dependency). This is one of the durable store
backends; see also the Vercel KV / Upstash REST option in `env.example`.

## 1. Create the tables

Run this in the Supabase SQL editor (Dashboard → SQL):

```sql
create table if not exists sllr_kv (
  key text primary key,
  value jsonb not null
);

create table if not exists sllr_index (
  index_key text not null,
  member text not null,
  primary key (index_key, member)
);
```

SLL-R talks to these tables with the **service-role** key, which bypasses row
level security, so no RLS policies are required. Keep RLS enabled (the default)
so the anon/public key cannot read or write order data.

## 2. Configure SLL-R

Set these environment variables (Supabase → Project Settings → API):

```bash
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-secret-key>
```

`SUPABASE_SERVICE_ROLE_KEY` is a secret — keep it server-side only (it is never
sent to the browser). `SUPABASE_KEY` / `SUPABASE_SERVICE_KEY` are also accepted
as fallbacks.

When configured, `GET /health` reports `{ "store": "supabase" }`. Backend
selection order is Supabase → Redis/KV → memory, so Supabase wins if both are set.

## 3. How state maps to the tables

- `sllr_kv` holds one row per order (`sllr:order:<id>`) and per demo merchant
  (`sllr:demo-merchant:<id>`); `value` is the JSON document.
- `sllr_index` holds the membership sets: the global order index, the
  per-merchant order index (`sllr:order-ids:<merchantId>`), and the demo merchant
  index. Inserts use `resolution=ignore-duplicates`, so re-adding a member is a
  no-op.

## 4. Verify

```bash
curl -s https://<your-sllr-host>/health
# {"ok":true,"product":"SLL-R","store":"supabase"}
```

Create an order, then confirm it survives a fresh instance by reading it back in
a separate request:

```bash
curl -s -X POST https://<your-sllr-host>/merchants/raposa-coffee/orders \
  -H "content-type: application/json" \
  -d '{"userIntent":"iced latte in 10 minutes","deadlineMinutes":10,"maxSpendUsd":"10.00","paymentMode":"counter"}'
# note the order id, then:
curl -s https://<your-sllr-host>/orders/<ord_id>
```
