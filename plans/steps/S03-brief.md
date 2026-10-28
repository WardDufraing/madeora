# S03 · Database, migrations and RLS test harness — feature brief

**Branch:** `chore/database-rls-harness` from `main` @ 331036a (S01 and S02 merged).
**Sources:** build-plan S03 and decision D4; CLAUDE.md (database access A, authorization C, testing A, config A, backup C, local dev C, €0 budget, CI list); architecture.md §5, §6, §20, §23, §24, §25, §28, §29; S01 review L3 and risk 4; S02 review risk 6.

## Scope

- Supabase CLI pinned as a dev dependency (`supabase@2.118.0`, released 25 Sep, platform binaries via optional deps, no install script). `supabase/config.toml` from `supabase init`, with storage, edge functions, analytics and the Studio AI key turned off (R2, Trigger.dev and native logs are the approved choices; no LLM).
- `supabase/migrations/20261013000000_private_schema.sql`: one baseline migration, a `private` schema for future SECURITY DEFINER helpers that the API roles cannot use (architecture §6). No product tables.
- `supabase/seed.sql`: two synthetic users (`alice@madeora.test`, `bob@madeora.test`) with fixed IDs and timestamps, no password.
- `packages/database`: generated `Database` types (`pnpm db:types`), plus a `--check` that CI runs.
- `tests/db` workspace (`@madeora/db-tests`):
  - Multi-actor SQL helpers (`tests.act_as('alice')`, `act_as_anon`, `act_as_service_role`, `act_as_owner`) that switch to the real API role and JWT claims, and assertions (`assert_row_count`, `assert_allowed`, `assert_denied`, `assert_true`).
  - A psql-based runner: helpers + test SQL in one transaction that is always rolled back; refuses any database not on this machine; refuses test SQL that ends the transaction or uses psql meta-commands.
  - Harness self-test: a two-user check on a fixture table that passes with an owner-only policy and fails when the policy is dropped, RLS is disabled, the policy is widened, or forged owner IDs are accepted.
  - Baseline guards for every future migration: every `public` table has RLS, every `public` view is `security_invoker`, `private` is closed to API roles, the seed is loaded.
  - The D4 fallback: throwaway local PostgreSQL cluster (loopback only) + a Supabase shim (roles, default grants, `auth.users`, `auth.uid()`), migrations, seed, tests, then deleted.
- `pnpm db:reset` with a warning and a confirmation, always `--local`.
- CI job **Database and RLS tests**: real Supabase CLI stack (only the services needed), migrations + seed from scratch, RLS tests, DB-types check.
- S01 carry-over L3: split `@madeora/config/env` into `env/server` (`import "server-only"`) and `env/public`, with a boundary test.
- Docs: development guide, ADR 0003, cost register row for Supabase.

## Out of scope

App Supabase clients and Supabase env variables (S06, first code that talks to Supabase), product tables and policies (S09+), any hosted Supabase project.

## Defaults picked

- **SQL tests run through `psql`, not a Node Postgres driver.** CLAUDE.md forbids direct `pg` access without owner approval, and pgTAP is not available in the container. psql is on every CI runner and in the container. The TypeScript wrapper keeps that detail in one place.
- **Type generation uses `--db-url`**, which works without Docker, so the container and CI produce the same file.
- **`.test` email domain** (RFC 2606 reserved) for synthetic users.

## Acceptance tests

1. Fallback (container): shim, migration, seed apply; all DB tests pass, including the five "must fail" and two guard cases; types `--check` passes.
2. Runner unit tests: URL guard accepts loopback and socket, refuses hosted Supabase, private IPs and lookalikes, never echoes the URL; transaction guard.
3. CI (after push): fresh Supabase stack, migrations + seed, the same tests pass; types check passes.
4. Env split: a client import of `env/server` fails; server and public accessors validate and never echo values.
5. Format, lint, typecheck, unit tests, build, E2E smoke all still pass.
