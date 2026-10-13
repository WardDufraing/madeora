-- Minimal stand-in for the parts of a Supabase database that migrations, seeds and RLS tests rely on.
-- Used ONLY by the in-container fallback (`pnpm db:test:fallback`) on a throwaway local PostgreSQL
-- cluster, where the real Supabase stack cannot start (build-plan decision D4). CI runs the real
-- Supabase CLI stack, which is the binding check. Never apply this file to a Supabase database.
--
-- It mirrors, as of Supabase CLI 2.118 / supabase/postgres 17:
--   * the API roles anon, authenticated and service_role (service_role bypasses RLS);
--   * a non-superuser `postgres` role with BYPASSRLS that owns application objects and runs
--     migrations (rls/shim-fidelity.test.sql checks these role attributes on both databases);
--   * Supabase's default grants on schema public, so RLS is the only barrier, exactly as on Supabase;
--   * auth.users (only the columns seeds use) and auth.uid() / auth.role() / auth.jwt(), which read
--     the same request.jwt.* settings as on Supabase;
--   * the `extensions` schema with pgcrypto and uuid-ossp.
-- Runs as the cluster superuser (supabase_admin), like Supabase's own image setup.
--
-- Known differences from Supabase: PostgreSQL 16 here, 17 there; auth.users is a small subset
-- owned by supabase_admin (Supabase: supabase_auth_admin, many more columns); no GoTrue, PostgREST,
-- Realtime or other extensions. A test that passes here but fails in CI is a shim gap: fix the shim.

\set ON_ERROR_STOP on

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

create role postgres login createrole createdb bypassrls;
grant anon, authenticated, service_role to postgres;
grant all on database postgres to postgres;

create schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension pgcrypto with schema extensions;
create extension "uuid-ossp" with schema extensions;
alter role postgres set search_path = "$user", public, extensions;

-- Schema public: owned by postgres, API roles may use it, and every table, sequence and function
-- postgres creates there is granted to the API roles by default. Only RLS protects the rows.
alter schema public owner to postgres;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to postgres, anon, authenticated, service_role;

create table auth.users (
  instance_id uuid,
  id uuid primary key,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  confirmation_token varchar(255),
  recovery_token varchar(255),
  email_change_token_new varchar(255),
  email_change varchar(255),
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_sso_user boolean not null default false,
  is_anonymous boolean not null default false,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz
);
grant all on auth.users to postgres;

create function auth.uid() returns uuid
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

create function auth.role() returns text
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
  $$;

create function auth.jwt() returns jsonb
  language sql stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;

grant execute on function auth.uid(), auth.role(), auth.jwt() to postgres, anon, authenticated, service_role;
