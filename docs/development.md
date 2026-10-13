# Local development

## Requirements

- Node.js 22 LTS, 22.18 or newer (see `.nvmrc`). The repository scripts in `tools/repo-checks` run as TypeScript directly, which needs Node 22.18+.
- pnpm 10.28.0. With Corepack: `corepack enable`, and the version in `package.json` is used automatically.
- For the database: Docker (Docker Desktop on macOS or Windows, free for personal use and small businesses; see the cost register), which the Supabase CLI uses to run a local Supabase stack, and the PostgreSQL client `psql` (16 or newer), which runs the RLS tests. The Supabase CLI itself (2.118.0) is installed by `pnpm install`; run it with `pnpm exec supabase`.

## First setup

```sh
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @madeora/e2e exec playwright install --with-deps chromium   # once per machine
pnpm dev
```

The web app runs at http://localhost:3000. `apps/web/.env.local` is ignored by Git; never commit it.

## Environment variables

Defined and validated in `packages/config/src/env/`, documented in `apps/web/.env.example`:

- `server.ts` (`@madeora/config/env/server`): server-only values and `getServerEnv()`. It starts with `import "server-only"`, so if a Client Component imports it, directly or through another module, `next build` fails. Every secret belongs here.
- `public.ts` (`@madeora/config/env/public`): `NEXT_PUBLIC_` values and `getPublicEnv()`. Next.js copies these into browser code, so never put a secret here.
- `core.ts` (`@madeora/config/env`): the shared parser and error type.

| Variable              | Where                    | Required | Meaning                                                     |
| --------------------- | ------------------------ | -------- | ----------------------------------------------------------- |
| `APP_ENV`             | server only              | yes      | `development`, `test`, `preview`, `staging` or `production` |
| `NEXT_PUBLIC_APP_URL` | public (in browser code) | yes      | Absolute `http` or `https` URL of the web app               |

`pnpm build` checks the public values first, because they are built into the browser code. The server checks all of them again when it starts. If one is missing or invalid, it logs the variable's name and answers every request with an error until the configuration is fixed. Values are never printed.

## Checks (the same commands CI runs)

CI (`.github/workflows/ci.yml`) runs these on every pull request into `main` or `production` and on every push to them. Each row names the CI check it belongs to.

| Check                                       | CI check                                   | Command                                                                       |
| ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Install from the lockfile                   | every job that builds or audits            | `pnpm install --frozen-lockfile`                                              |
| Formatting                                  | Format, lint, typecheck, unit tests, build | `pnpm format:check` (fix with `pnpm format`)                                  |
| Lint (warnings fail)                        | Format, lint, typecheck, unit tests, build | `pnpm lint`                                                                   |
| Type check                                  | Format, lint, typecheck, unit tests, build | `pnpm typecheck`                                                              |
| Unit and component tests                    | Format, lint, typecheck, unit tests, build | `pnpm test`                                                                   |
| Production build                            | Format, lint, typecheck, unit tests, build | `pnpm build`                                                                  |
| Client code cannot import server settings   | Format, lint, typecheck, unit tests, build | `pnpm test:boundary` (two real `next build` runs on small fixture apps)       |
| Browser tests (incl. axe in both themes)    | E2E smoke tests                            | `pnpm test:e2e` (builds the web app first)                                    |
| Fresh database, migrations, seed, RLS tests | Database and RLS tests                     | `pnpm db:start`, then `pnpm test:db` (see "Database" below)                   |
| Database types match the migrations         | Database and RLS tests                     | `pnpm db:types --check`                                                       |
| Reset rebuilds the same database            | Database and RLS tests                     | `pnpm db:reset --yes`, then `pnpm test:db`                                    |
| Product specification unchanged             | Spec guard                                 | `pnpm check:spec` (add `--base origin/main` to also check your branch's diff) |
| Same, using the target branch's guard       | Spec guard (trusted)                       | (CI only: runs `main`'s copy of the guard against the pull request)           |
| High or critical dependency advisories      | Dependency audit                           | `pnpm audit:deps`                                                             |
| Secrets in Git history                      | Secret scan                                | `gitleaks git --redact .` (gitleaks 8.30.1, installed separately)             |
| Pull requests into `production` from `main` | Release source                             | (CI only)                                                                     |

`pnpm build` and `pnpm test:e2e` need `APP_ENV` and `NEXT_PUBLIC_APP_URL`. CI uses the synthetic values `APP_ENV=test` and `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100`.

## Design tokens and components

Colours, type, spacing, radii, elevation, motion and icon sizes live in `packages/design-tokens/src` (TypeScript, the single source). Read the spec's UI / UX Style Guide and [`docs/design/design-decisions.md`](design/design-decisions.md) before changing them; the reasons for each choice are in [ADR 0004](adr/0004-design-tokens-and-components.md).

- **Use token utilities only:** `bg-surface`, `text-fg`, `text-fg-muted`, `border-line`, `border-line-control`, `bg-accent`, `text-on-accent`, `text-accent-fg`, `bg-danger-solid` and so on. Tailwind's own colour palette is switched off, and a test fails on any hex value, colour function or palette name outside `packages/design-tokens`. Purple is only the default accent value: never write it anywhere.
- **Change or add a token:** edit `packages/design-tokens/src`, run `pnpm --filter @madeora/design-tokens generate`, and commit the regenerated `tokens.css` and `tailwind.css`. Text and control colours need a contrast test in both themes.
- **Themes:** light by default, the system's dark mode when nothing is forced, and `data-theme="light"` or `"dark"` on an element to force one.
- **Icons:** see [`packages/icons/README.md`](../packages/icons/README.md).
- **Components:** `apps/web/src/components/ui/`. Pass every visible string as a prop (translations arrive with `next-intl` in S05).
- **Preview:** with `pnpm dev`, open http://localhost:3000/dev/components. It shows every component and is not served when `APP_ENV=production`. Switch the theme from the browser console with `document.documentElement.dataset.theme = "dark"`.
- **Accessibility tests:** component tests call `axeViolations(container)` from `apps/web/src/test/axe.ts`. Colour contrast is only measurable in a real browser, so `tests/e2e/specs/design-system.spec.ts` runs axe on the preview in both themes.

## Database

The database is defined only by Git: `supabase/migrations/` (applied in file-name order) and `supabase/seed.sql`. Every local or test database is disposable and can be rebuilt from them at any time (`architecture.md` §25). Tests never use a hosted Supabase project: the test runner refuses any database that is not on this machine.

| Task                              | Command                                   | What it does                                                                                              |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Start the local Supabase stack    | `pnpm db:start`                           | Starts Supabase in Docker. A new database gets every migration and the seed.                              |
| Stop it                           | `pnpm db:stop`                            | Stops the containers. Your local data is kept.                                                            |
| Rebuild the database from scratch | `pnpm db:reset`                           | **Deletes all local data**, then applies every migration and the seed. Asks you to type `reset` first.    |
| Run the database and RLS tests    | `pnpm test:db`                            | Needs the local stack running.                                                                            |
| Run them without Docker           | `pnpm test:db:fallback`                   | Throwaway local PostgreSQL instead of Supabase (see below).                                               |
| Regenerate the database types     | `pnpm db:types`                           | Writes `packages/database/src/database.types.ts` from the running database. Commit it with the migration. |
| Add a migration                   | `pnpm exec supabase migration new <name>` | Creates `supabase/migrations/<timestamp>_<name>.sql`.                                                     |

`pnpm db:reset` always passes `--local`, so it can never reset a hosted project. `pnpm db:reset --yes` skips the question (CI uses it). Set `SUPABASE_TELEMETRY_DISABLED=1` in your shell if you do not want the Supabase CLI to send usage statistics; CI sets it.

### Writing RLS tests

Add a file `tests/db/rls/<area>.test.sql`. `pnpm test:db` runs every such file against the migrated and seeded database, each in its own transaction that is always rolled back, so a test may create rows freely. A test must not commit, roll back, use savepoints or use psql commands (a backslash outside quoted text); the runner refuses those before anything runs.

Actors (`tests/db/sql/helpers.sql`) switch to the same database role and JWT claims as a real Supabase API request, so only RLS decides what they see:

- `select tests.act_as('alice');` (or `'bob'`): a seeded synthetic user. `tests.user_id('alice')` gives the ID.
- `select tests.act_as_anon();`: not signed in.
- `select tests.act_as_service_role();`: the privileged server role, which bypasses RLS.
- `select tests.act_as_owner();`: back to the database owner, for setting up rows.

Assertions run a query as the current actor and stop the test with their description if it is false:

- `tests.assert_row_count(query, expected, description)`: the query (a `select`, or a change with `returning`) returns that many rows.
- `tests.assert_denied(query, description)`: the query is refused (by default with SQLSTATE `42501`, which covers missing grants and policy `with check` failures).
- `tests.assert_allowed(query, description)` and `tests.assert_true(condition, description)`.

Every cross-Home or cross-user rule needs a test with at least two actors, and a test that it is actually enforced. `tests/db/harness/two-user.test.ts` shows the pattern: the same check must fail when the policy is dropped, switched off or widened. `tests/db/rls/baseline.test.sql` checks the whole database after every migration: every table in schema `public` has RLS, every view there is `security_invoker`, and schema `private` (for internal helper functions) and every function in it are closed to the API roles. When an RLS policy needs a `private` helper, grant it in the migration and add it to the allowlist in that test, with the reason. `tests/db/rls/shim-fidelity.test.sql` checks the role attributes the tests rely on.

### Without Docker: the PostgreSQL fallback

Where the Supabase stack cannot start (no Docker, as in Claude's build containers; build plan decision D4), `pnpm test:db:fallback` creates a throwaway PostgreSQL cluster in a private temporary folder, listening only on `127.0.0.1` port 54339 with a random per-run password. It applies `tests/db/shim/supabase-shim.sql` (the Supabase roles, default grants, `auth.users` and `auth.uid()`), then every migration and the seed, runs the same tests and the database types check, and deletes the cluster. It needs the PostgreSQL 16+ server programs (`initdb`, `pg_ctl`; set `PG_BIN` to their folder if `pg_config --bindir` does not find them) and must not run as root. The shim imitates Supabase but is not Supabase: the CI job on the real stack is the binding check.

## Dependency audit exceptions

`pnpm audit:deps` runs `pnpm audit` and fails on any **high** or **critical** advisory. Moderate and low advisories are printed as warnings. When an advisory cannot be fixed yet (for example, no patched version exists) and does not affect Madeora, record a time-limited exception in `tools/repo-checks/audit-exceptions.json`:

- `id`: the GHSA id. `package`: the affected package name. Both must match the advisory.
- `reason`: why it does not affect Madeora, including the dependency path.
- `added` and `expires`: dates (`YYYY-MM-DD`). An exception may last at most 90 days. When it expires, the check fails until someone re-assesses the advisory and renews or removes the exception.

Exceptions are reviewed by the owner and belong in the pull request that needs them. Never use pnpm's own `auditConfig` ignore settings (`ignoreCves`, `ignoreGhsas`): they would skip the reason and expiry rules, so `pnpm audit:deps` fails if it finds them. Remove an exception as soon as the check reports it as no longer needed.

Prettier never checks or rewrites `docs/product/` (the read-only product specification), `CLAUDE.md`, `architecture.md` or `docs/design/`; see `.prettierignore`.
