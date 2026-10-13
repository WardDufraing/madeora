-- Baseline (S03): a schema for internal database helpers, such as SECURITY DEFINER functions that
-- RLS policies call. architecture.md §6 asks for careful review of SECURITY DEFINER functions; the
-- Supabase guidance is never to create them in a schema the Data API exposes. `private` is not in
-- `api.schemas` (supabase/config.toml), and API roles get no access unless a later migration grants
-- it for one specific function.

create schema if not exists private;

revoke all on schema private from public;

-- Postgres lets PUBLIC execute every new function by default. Functions created here by postgres
-- must instead be granted explicitly, one by one.
alter default privileges for role postgres in schema private revoke execute on functions from public;
