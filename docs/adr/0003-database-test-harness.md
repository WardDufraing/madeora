# ADR 0003: Database migrations, seed and RLS test harness

- **Status:** Accepted for S03, pending the owner's PR approval
- **Date:** 2026-10-13
- **Step:** S03, database, migrations and RLS test harness (build plan decision D4)

## Context

`CLAUDE.md` and `architecture.md` §6, §25 and §29 require Git-versioned SQL migrations, a deterministic synthetic seed, a documented local reset, generated database types, and real PostgreSQL RLS tests against an isolated database, never a mocked one and never a hosted project. CI must build a fresh database, migrate, seed and run the RLS tests. Claude's build containers cannot run the Supabase Docker stack, but they have PostgreSQL 16 (D4). `CLAUDE.md` also forbids direct `pg` access and other database clients without owner approval, and pgTAP is not installed in the containers.

## Decision

- **Supabase CLI 2.118.0** is a pinned root dev dependency (`pnpm exec supabase`). It ships platform binaries as optional dependencies, so it adds no install script. `supabase/config.toml` keeps Supabase's local defaults, except that storage (R2 is the approved store), edge functions (Next.js API and Trigger.dev are approved) and analytics (native logs are approved) are off, and the Studio AI key line is removed.
- **Migrations** live in `supabase/migrations/` and run in file-name order. The first one creates schema `private` for internal helper functions (SECURITY DEFINER functions belong outside the schemas the Data API exposes), closes it to PUBLIC, and changes the `postgres` role's global default so that new functions are no longer executable by PUBLIC. A per-schema default cannot remove PUBLIC's built-in EXECUTE, so the change is global; functions in `public` stay callable by the API roles through Supabase's own default grants there. Each function in `private` must be granted explicitly, and the baseline guard fails if one is executable by PUBLIC, `anon` or `authenticated` without being allowlisted.
- **Seed** (`supabase/seed.sql`): synthetic users only, with fixed IDs and timestamps, on the reserved `.test` domain, with no password.
- **RLS tests are SQL**, run by `psql` from a small TypeScript runner (`tests/db/src/run-sql.ts`) under Vitest. Each test runs in one transaction that is always rolled back. Multi-actor helpers (`tests/db/sql/helpers.sql`) switch to the real API roles (`anon`, `authenticated`, `service_role`) and set `request.jwt.claims`, so `auth.uid()` and the policies behave as they do for a real API request. `psql` is on every GitHub runner and in the containers, and it is not an application database client, so `CLAUDE.md` database access strategy A is unaffected.
- **Safety:** the runner accepts only a database on this machine (loopback or a socket path), only a short list of connection parameters (no `hostaddr`, `service`, host lists or repeated keys), and starts `psql` and the Supabase CLI without any libpq `PG*` variable, so a test cannot reach a hosted project. A small scanner reads test SQL the way psql does (skipping comments, strings and dollar-quoted bodies) and refuses any statement that ends or nests the transaction and any psql meta-command. A final check fails the run if the transaction was ended anyway, and the helper schema is dropped and recreated in every run, so one bad run cannot break later ones.
- **Harness self-test:** a two-user check on a fixture table (created inside the rolled-back transaction, never in a migration) passes with an owner-only policy and must fail when the policy is dropped, RLS is off, the policy is widened or a forged owner ID is accepted.
- **Baseline guards** (`tests/db/rls/baseline.test.sql`) run after every migration: RLS on every table in `public`, `security_invoker` on every view there, schema `private` and its functions closed to the API roles. `tests/db/rls/shim-fidelity.test.sql` checks the role attributes the tests rely on (`postgres` is not a superuser and bypasses RLS, `service_role` bypasses RLS, `anon` and `authenticated` never do) on both Supabase and the fallback.
- **Database types** are generated with `supabase gen types typescript --db-url` into `packages/database`, formatted with Prettier, and checked in CI. `--db-url` needs no Docker, so the container and CI produce the same file.
- **CI** (`Database and RLS tests`) starts a fresh Supabase stack with only the services the tests need, runs the RLS tests, checks the types, resets the database with `pnpm db:reset --yes` and runs the tests again. This run on real Supabase is the binding check.
- **Fallback (D4):** `pnpm test:db:fallback` runs the same tests and the types check on a throwaway PostgreSQL cluster with `tests/db/shim/supabase-shim.sql`, a minimal stand-in for Supabase's roles, default grants, `auth.users` and `auth.uid()`. TCP logins need a random per-run password, and the cluster is deleted on exit, Ctrl-C, SIGTERM and SIGHUP. It is for build containers and machines without Docker only.
- **Environment configuration** is split (S01 review L3): `@madeora/config/env/server` imports `server-only`, `@madeora/config/env/public` holds only `NEXT_PUBLIC_` values. The app's Supabase variables arrive with the first code that talks to Supabase (S06).

## Consequences

- Later steps add a migration plus a `tests/db/rls/<area>.test.sql` file with at least two actors for every Home- or user-scoped table, and regenerate the types.
- The shim can drift from Supabase (it is PostgreSQL 16; local Supabase is 17). A test that passes on the fallback but fails in CI is a shim gap, fixed in the shim.
- SQL tests stop at the first failing assertion in a file, so one file per area keeps reports readable.
- If the owner later approves a Node PostgreSQL driver for tests, only `run-sql.ts` changes; the SQL tests and helpers stay.
