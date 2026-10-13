-- Baseline (S03): a schema for internal database helpers, such as SECURITY DEFINER functions that
-- RLS policies call. architecture.md §6 asks for careful review of SECURITY DEFINER functions; the
-- Supabase guidance is never to create them in a schema the Data API exposes. `private` is not in
-- `api.schemas` (supabase/config.toml).

create schema if not exists private;

revoke all on schema private from public;

-- PostgreSQL lets PUBLIC execute every new function by default, and a per-schema default cannot
-- take that away. So the owner role's global default is changed instead: functions postgres creates
-- from now on are executable only by roles granted explicitly. In schema public, Supabase's own
-- default privileges still grant them to anon, authenticated and service_role, so nothing changes
-- there. In schema private, each function must be granted one by one, and
-- tests/db/rls/baseline.test.sql fails if one is executable by PUBLIC, anon or authenticated without
-- being on that test's allowlist.
alter default privileges for role postgres revoke execute on functions from public;
