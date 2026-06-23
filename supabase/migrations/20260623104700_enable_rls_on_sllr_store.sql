-- Lock down SLL-R's Supabase-backed order store.
--
-- The application uses SUPABASE_SERVICE_ROLE_KEY from the server only, which
-- bypasses RLS. Public/anon clients should not be able to read or mutate the
-- KV/index tables directly through PostgREST.

alter table if exists public.sllr_kv enable row level security;
alter table if exists public.sllr_index enable row level security;

revoke all on table public.sllr_kv from anon, authenticated;
revoke all on table public.sllr_index from anon, authenticated;
