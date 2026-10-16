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

| Variable                                                        | Where                    | Required        | Meaning                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                       | server only              | yes             | `development`, `test`, `preview`, `staging` or `production`                                                                                                                                                                      |
| `NEXT_PUBLIC_APP_URL`                                           | public (in browser code) | yes             | Absolute `http` or `https` URL of the web app                                                                                                                                                                                    |
| `NEXT_PUBLIC_SUPABASE_URL`                                      | public (in browser code) | yes             | Supabase API address; locally `http://127.0.0.1:54321`                                                                                                                                                                           |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                          | public (in browser code) | yes             | Supabase publishable key (`pnpm exec supabase status`). A secret or `service_role` key is refused at once                                                                                                                        |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`                                | public (in browser code) | production only | Cloudflare Turnstile site key (ADR 0008). Unset locally, in CI and on previews: no security check. A secret key is refused                                                                                                       |
| `EMAIL_TRANSPORT`                                               | server only              | no              | `resend`, `mailpit` or `off` (the default): whether the app's own email is sent in this environment. The web app only reads this flag; a Trigger.dev job sends the email with its own settings (ADR 0018, `docs/email-setup.md`) |
| `STORAGE_DRIVER`                                                | server only              | no              | `s3` or `off` (the default): whether files can be uploaded here (S15, ADR 0019, `docs/file-storage.md`). Off: pictures cannot be uploaded and the app says so                                                                    |
| `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_BUCKET` | server only              | with `s3`       | The S3-compatible store: R2 once approved, locally the S3 stand-in (`http://127.0.0.1:54390`). Plain `http` only for this machine                                                                                                |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`      | server only (secret)     | with `s3`       | An access key limited to that one bucket. Never logged or sent to the browser                                                                                                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`                                     | server only (secret)     | with `s3`       | This environment's Supabase secret key, used for one call only: recording a verified upload (`finalize_upload`, ADR 0019)                                                                                                        |

A file that starts with `"use client"` must not import `@madeora/config/env/server` or `server-only`: ESLint (`madeora/no-server-env-in-client`) flags a direct import, and `pnpm test:boundary` proves with a real build that an indirect one fails too.

On a Vercel preview (`VERCEL_ENV=preview`, see `docs/vercel-setup.md`), a missing `APP_ENV` becomes `preview` and a missing `NEXT_PUBLIC_APP_URL` becomes the preview's own `*.vercel.app` branch URL (`@madeora/config/env/vercel`). Nowhere else is a value filled in, production included.

`pnpm build` checks the public values first, because they are built into the browser code. The server checks all of them again when it starts. If one is missing or invalid, it logs the variable's name and answers every request with an error until the configuration is fixed. Values are never printed.

## Checks (the same commands CI runs)

CI (`.github/workflows/ci.yml`) runs these on every pull request into `main` or `production` and on every push to them. Each row names the CI check it belongs to.

| Check                                       | CI check                                   | Command                                                                          |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Install from the lockfile                   | every job that builds or audits            | `pnpm install --frozen-lockfile`                                                 |
| Formatting                                  | Format, lint, typecheck, unit tests, build | `pnpm format:check` (fix with `pnpm format`)                                     |
| Lint (warnings fail)                        | Format, lint, typecheck, unit tests, build | `pnpm lint`                                                                      |
| Type check                                  | Format, lint, typecheck, unit tests, build | `pnpm typecheck`                                                                 |
| Unit and component tests                    | Format, lint, typecheck, unit tests, build | `pnpm test`                                                                      |
| Production build                            | Format, lint, typecheck, unit tests, build | `pnpm build`                                                                     |
| Client code cannot import server settings   | Format, lint, typecheck, unit tests, build | `pnpm test:boundary` (two real `next build` runs on small fixture apps)          |
| Browser tests (incl. axe in both themes)    | E2E smoke tests                            | `pnpm db:start`, then `pnpm test:e2e` (builds the web app first; see "Accounts") |
| Google sign-in, linking and unlinking       | E2E Google sign-in (built Supabase Auth)   | `pnpm test:e2e:fallback -- --project=google` (see "Google sign-in tests")        |
| Fresh database, migrations, seed, RLS tests | Database and RLS tests                     | `pnpm db:start`, then `pnpm test:db` (see "Database" below)                      |
| Database types match the migrations         | Database and RLS tests                     | `pnpm db:types --check`                                                          |
| Reset rebuilds the same database            | Database and RLS tests                     | `pnpm db:reset --yes`, then `pnpm test:db`                                       |
| Product specification unchanged             | Spec guard                                 | `pnpm check:spec` (add `--base origin/main` to also check your branch's diff)    |
| Same, using the target branch's guard       | Spec guard (trusted)                       | (CI only: runs `main`'s copy of the guard against the pull request)              |
| High or critical dependency advisories      | Dependency audit                           | `pnpm audit:deps`                                                                |
| Secrets in Git history                      | Secret scan                                | `gitleaks git --redact .` (gitleaks 8.30.1, installed separately)                |
| Pull requests into `production` from `main` | Release source                             | (CI only)                                                                        |

`pnpm build` and `pnpm test:e2e` need `APP_ENV`, `NEXT_PUBLIC_APP_URL` and the two Supabase values. CI uses the synthetic values `APP_ENV=test`, `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100`, and the local stack's address and publishable key.

## Design tokens and components

Colours, type, spacing, radii, elevation, motion and icon sizes live in `packages/design-tokens/src` (TypeScript, the single source). Read the spec's UI / UX Style Guide and [`docs/design/design-decisions.md`](design/design-decisions.md) before changing them; the reasons for each choice are in [ADR 0004](adr/0004-design-tokens-and-components.md).

- **Use token utilities only:** `bg-surface`, `text-fg`, `text-fg-muted`, `border-line`, `border-line-control`, `bg-accent`, `text-on-accent`, `text-accent-fg`, `bg-danger-solid` and so on. Tailwind's own colour palette is switched off, and a test fails on any hex value, colour function or palette name outside `packages/design-tokens`. Purple is only the default accent value: never write it anywhere.
- **Change or add a token:** edit `packages/design-tokens/src`, run `pnpm --filter @madeora/design-tokens generate`, and commit the regenerated `tokens.css` and `tailwind.css`. Text and control colours need a contrast test in both themes.
- **Themes:** light by default, the system's dark mode when nothing is forced, and `data-theme="light"` or `"dark"` to force one. Set it, and any accent override, on `<html>`. In the app, people choose Light, Dark or "Same as this device" on the Settings page (`/settings`); see "App shell, theme and languages" below.
- **Icons:** see [`packages/icons/README.md`](../packages/icons/README.md).
- **Components:** `apps/web/src/components/ui/`. Pass every visible string as a prop (translations arrive with `next-intl` in S05).
- **Preview:** with `pnpm dev`, open http://localhost:3000/dev/components. It shows every component and is not served when `APP_ENV=production`. It follows the theme chosen on `/settings`, or switch it from the browser console with `document.documentElement.dataset.theme = "dark"`.
- **Accessibility tests:** component tests call `axeViolations(container)` from `apps/web/src/test/axe.ts`. Colour contrast is only measurable in a real browser, so `tests/e2e/specs/design-system.spec.ts` runs axe on the preview in both themes.

## App shell, theme and languages

The reasons for each choice are in [ADR 0006](adr/0006-app-shell-theme-languages.md).

- **Pages inside the app** live in `apps/web/src/app/(app)/`, which wraps them in the shell (`src/components/shell/`): skip link, sidebar, top bar with the context switcher slot, and the small-screen menu. Each page renders one `<h1>` with `PageHeader`.
- **Navigation items** are listed in `src/components/shell/nav-items.ts`. A module that is not built yet shows a "not built yet" page through `src/app/(app)/[section]/page.tsx`. When you build a module, add its own route folder (for example `src/app/(app)/tasks/`) and remove its id from `unbuiltSections`.
- **Text:** every word the interface shows or announces comes from `src/i18n/messages/en.json` (English, the source) and `nl.json`. Use `useTranslations("Namespace")` in components and `getTranslations` in async server code. Keys are typed, so a key that is not in `en.json` fails the type check. Add every new key to both files in the same change: a test fails if the two files have different keys or different `{arguments}`, if a message cannot be formatted, or if a key is never used. Bind translators as `const t = useTranslations("Namespace")` (or `getTranslations`, also inside `Promise.all`) and call them with literal keys, so the unused-key test can see them; a key looked up from data must be added to that test's explicit list. Never translate content people write (names, notes, titles).
- **Which language:** the server decides per request, in `src/i18n/request.ts`: the language saved on the account (S07), else the language saved on this device (cookie `md-locale`), else the browser's `Accept-Language`, else English. The URL never contains the language.
- **Theme and sidebar:** saved on this device in the cookies `md-theme` (`light`, `dark` or `system`) and `md-sidebar` (`expanded` or `collapsed`). The server reads them, so the first paint already has the right theme and sidebar width. Invalid values are ignored. To start fresh, delete the `md-` cookies for the site in your browser.
- **Right-to-left:** write logical directions only (`ms-`, `pe-`, `start-`, `border-e`, `text-start`, `margin-inline-start`, …). `src/rtl-safe.test.ts` fails on physical left/right classes and CSS properties; use an `rtl:` variant only for something that must mirror, such as an arrow icon. `<html dir>` comes from `localeDirection()`, so a right-to-left language only needs to be added to the locale list.
- **Install warning:** `pnpm install` prints "Ignored build scripts: @parcel/watcher, @swc/core". That is expected: next-intl's message extractor, which Madeora does not use, brings them, and their install scripts stay blocked. Do not run `pnpm approve-builds` for them.
- **Browser tests** import `test` and `expect` from `tests/e2e/support/browser.ts`, which fails a test on any console error, page error or hydration warning. The same file has `axeViolations()` and `nonTokenColours()`.

## Personal preferences

The reasons for each choice are in [ADR 0009](adr/0009-personal-preferences.md).

- **Stored on the account** in `public.user_preferences` (one row per account, created by the first save): display name, language, the five regional formats and a chosen timezone. `NULL` means "not chosen" or Automatic. Server code reads them with `getAccountPreferences()` / `getStoredPreferences()` (`src/preferences/account.ts`), once per request.
- **Changed** only through `PATCH /api/v1/me/preferences` (`src/app/api/v1/me/preferences/route.ts`), from the settings forms through `useSavePreferences()`. The allowed values live in `src/preferences/schema.ts` and in the migration's check constraints: change both together.
- **Formats and timezone:** use `getRegionalFormats()` and `getEffectiveTimeZone()` (`src/preferences/server.ts`) and the helpers in `src/preferences/regional.ts` (`formatDate`, `formatTime`, `formatNumber`, …) to show dates, times and numbers. Never format with the server's or browser's own zone. Automatic formats come from the browser's `Accept-Language`; Automatic timezone from the cookie `md-timezone`, which `DeviceTimeZone` keeps up to date.
- **Hosted projects:** a new migration must be applied to `madeora-preview` and `madeora-production` by the owner ([`docs/supabase-migrations.md`](supabase-migrations.md)); say so in the pull request.

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

Where the Supabase stack cannot start (no Docker, as in Claude's build containers; build plan decision D4), `pnpm test:db:fallback` creates a throwaway PostgreSQL cluster in a private temporary folder, listening only on `127.0.0.1` port 54339 with a random per-run password. It applies `tests/db/shim/supabase-shim.sql` (the Supabase roles, default grants, `auth.uid()`, and the Supabase Auth tables the migrations use: `auth.users`, `auth.identities`, `auth.sessions` and `auth.mfa_amr_claims`), then every migration and the seed, runs the same tests and the database types check, and deletes the cluster. It needs the PostgreSQL 16+ server programs (`initdb`, `pg_ctl`; set `PG_BIN` to their folder if `pg_config --bindir` does not find them) and must not run as root. The shim imitates Supabase but is not Supabase: the CI job on the real stack is the binding check.

## Accounts

Sign-in uses Supabase Auth from the local stack (`pnpm db:start`). Put its address and publishable key in `apps/web/.env.local`; `pnpm exec supabase status` prints both (the API URL and the publishable key).

To offer invitations by email locally, add `EMAIL_TRANSPORT=mailpit` to `apps/web/.env.local`. The email itself is sent by a background job (ADR 0018): run Trigger.dev's `dev` mode with `EMAIL_TRANSPORT=mailpit`, `MAILPIT_URL`, `EMAIL_FROM` and `APP_URL` in `packages/jobs/.env` (`docs/background-jobs.md`, "Local development"); the email then arrives in the same mail catcher. Without them, email invitations are not offered and links and join codes still work. In-app notifications need none of this.

To get a local account, open http://localhost:3000/sign-up and register with any address on the reserved `.test` domain (for example `you@madeora.test`). The confirmation email never leaves your machine: open the local mail catcher at http://127.0.0.1:54324, open the email and follow its link. Password reset emails arrive there too. The seed users have no password and cannot sign in.

Local Supabase Auth has raised rate limits (`supabase/config.toml`) so the browser tests never trip them; hosted projects keep Supabase's defaults. Previews use a separate free Supabase project (`docs/supabase-preview-setup.md`, ADR 0007), and production its own (`docs/production-setup.md`, ADR 0008). Only production turns on Turnstile; to try the check locally, set `NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA` (Cloudflare's always-passing test key) and, in `supabase/config.toml`, `[auth.captcha]` with `enabled = true`, `provider = "turnstile"` and Cloudflare's test secret `1x0000000000000000000000000000000AA`; never commit that change.

### Browser tests without Docker

`pnpm test:e2e:fallback` runs the same Playwright suite where the Supabase stack cannot start (Claude's build containers; build plan decision D4). It builds Supabase Auth (GoTrue) and Mailpit from source once, at the versions the pinned Supabase CLI uses, and caches them in `~/.cache/madeora/auth-fallback` (needs Go and network access to the Go module proxy the first time). It also downloads PostgREST (the Data API) once, checked against a pinned SHA-256. Each run starts a throwaway PostgreSQL (port 54349; run as root, it switches to the `nobody` user) with Supabase Auth's schema and Madeora's migrations, Supabase Auth, PostgREST (port 54353), Mailpit (ports 54354/54355), a stand-in Google (ports 54356/54357) and a small gateway for `/auth/v1` and `/rest/v1` (port 54351), passes their addresses to the tests and stops everything afterwards. Arguments after `--` go to Playwright, for example `pnpm test:e2e:fallback -- specs/auth.spec.ts`. Specs that need membership in somebody else's Home set it up in the throwaway database through `E2E_DATABASE_URL` (`tests/e2e/support/database.ts`); CI passes the local stack's database, the fallback its own. Emails the app queues (invitations, notifications) are sent by background jobs in production; the specs run the due jobs in a separate process with `tests/e2e/support/jobs.ts`, which needs `E2E_SERVICE_ROLE_KEY` (CI reads it from `supabase status`, the fallback signs its own). `node tests/e2e/scripts/auth-fallback.ts --serve` only starts the services and prints their settings. Like the database fallback, it is a stand-in: the CI job on the real stack is the binding check.

#### Google sign-in tests

The Google tests (`tests/e2e/google`) cannot run against the Supabase CLI stack, because Supabase Auth only talks to the real Google. The fallback points Supabase Auth's real Google code at a stand-in (`tests/e2e/scripts/fake-google.ts`): a throwaway certificate authority, created per run and trusted only by that Supabase Auth process, lets a small proxy answer Google's discovery document for `accounts.google.com`, and a local server plays Google's consent page, token endpoint and signing keys. Nothing reaches Google. The fallback sets `PLAYWRIGHT_FAKE_GOOGLE=1`, which adds the Playwright project `google`; run only those tests with `pnpm test:e2e:fallback -- --project=google`. CI runs exactly that in the "E2E Google sign-in" job. To try real Google locally, see the comment in `supabase/config.toml` and `docs/google-sign-in-setup.md`.

## Background jobs

Conventions, adding a job, logs and the recovery runbook: [`background-jobs.md`](background-jobs.md). The rules run in unit tests with fakes (`pnpm --filter @madeora/jobs test`) and the outbox functions in the database tests (`tests/db/rls/job_outbox.test.sql`, `tests/db/rls/job-outbox-concurrency.test.ts`). Running real tasks locally needs a free Trigger.dev account and `pnpm dlx trigger.dev@4.6.4 dev` in `packages/jobs` (settings in `packages/jobs/.env.example`); hosted setup is the owner's ([`trigger-setup.md`](trigger-setup.md)).

## File storage

Pictures (S15) go to an S3-compatible store through short-lived signed links; Madeora checks and re-encodes every upload before it is used (ADR 0019, owner guide and runbook in [`file-storage.md`](file-storage.md)). Locally, without any account, run the in-memory S3 stand-in in its own terminal with the `STORAGE_*` values from `apps/web/.env.example` in its environment:

```sh
STORAGE_DRIVER=s3 STORAGE_S3_ENDPOINT=http://127.0.0.1:54390 STORAGE_S3_BUCKET=madeora-dev \
  STORAGE_S3_ACCESS_KEY_ID=DevSyntheticAccessKey STORAGE_S3_SECRET_ACCESS_KEY=DevSyntheticSecretKey0123456789 \
  pnpm --filter @madeora/s3-stand-in start
```

and put the same values plus `SUPABASE_SERVICE_ROLE_KEY` (the local stack's secret key) in `apps/web/.env.local`. Objects vanish when the stand-in stops; the database rows stay, so restart with `pnpm db:reset` for a clean slate. The browser tests start the stand-in themselves (`tests/e2e/playwright.config.ts`).

## Dashboards

Dashboards (S17, ADR 0021) store one versioned layout per person and per Home. To add a widget type: add it to the registry in `apps/web/src/dashboard/widgets.ts` (surfaces, size bounds per breakpoint, a settings schema with defaults), its body and title in `apps/web/src/components/dashboard/widget-content.tsx`, its name and description in `use-widget-labels.ts`, any settings controls in `widget-settings.tsx`, and its texts in both dictionaries. The layout rules and keyboard moves are unit-tested in `src/dashboard/layout.test.ts`; the database rules in `tests/db/rls/dashboards.test.sql` and `dashboards-concurrency.test.ts`; the journeys in `tests/e2e/specs/dashboard.spec.ts`. Normal use is a plain CSS grid; only edit mode loads React Grid Layout, whose structural styles are in `apps/web/src/app/globals.css`.

## Dependency audit exceptions

`pnpm audit:deps` runs `pnpm audit` and fails on any **high** or **critical** advisory. Moderate and low advisories are printed as warnings. When an advisory cannot be fixed yet (for example, no patched version exists) and does not affect Madeora, record a time-limited exception in `tools/repo-checks/audit-exceptions.json`:

- `id`: the GHSA id. `package`: the affected package name. Both must match the advisory.
- `reason`: why it does not affect Madeora, including the dependency path.
- `added` and `expires`: dates (`YYYY-MM-DD`). An exception may last at most 90 days. When it expires, the check fails until someone re-assesses the advisory and renews or removes the exception.

Exceptions are reviewed by the owner and belong in the pull request that needs them. Never use pnpm's own `auditConfig` ignore settings (`ignoreCves`, `ignoreGhsas`): they would skip the reason and expiry rules, so `pnpm audit:deps` fails if it finds them. Remove an exception as soon as the check reports it as no longer needed.

Prettier never checks or rewrites `docs/product/` (the read-only product specification), `CLAUDE.md`, `architecture.md` or `docs/design/`; see `.prettierignore`.
