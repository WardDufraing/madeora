# Madeora

Madeora is a modular personal-life and household coordination application. A person can use it alone or belong to several Homes, with configurable dashboards, modules such as calendar, tasks and chores, meals, recipes and shopping, habits, pets and photos, a Household Display, and the permission-aware assistant Ora.

The code is a Turborepo + pnpm monorepo:

- `apps/web`: the Next.js web app (App Router, strict TypeScript, Tailwind CSS).
- `packages/config`: shared TypeScript and ESLint configuration and the validated environment settings (server-only and public kept apart).
- `packages/database`: TypeScript types generated from the database schema.
- `supabase/`: Supabase CLI project: `migrations/` (schema and RLS policies, in order) and `seed.sql` (synthetic data only).
- `tests/e2e`: Playwright browser tests.
- `tests/db`: database and RLS tests, with the multi-actor test helpers.
- `tools/repo-checks`: repository guards run by CI (product-specification guard, dependency audit).

No product features exist yet.

## Where to start

- [`docs/product/Project-entry.md`](docs/product/Project-entry.md): product overview. Read this first.
- [`docs/product/Modules.md`](docs/product/Modules.md): module catalogue.
- [`docs/product/Project-specification.md`](docs/product/Project-specification.md): binding detailed requirements.
- [`architecture.md`](architecture.md): technical source of truth: stack, data model, security, operations.
- [`CLAUDE.md`](CLAUDE.md): mandatory workflow and rules for every agent and contributor.
- [`docs/design/design-decisions.md`](docs/design/design-decisions.md): owner design decisions that supplement the specification, with the [styling reference mockup](docs/design/mockups/household-dashboard-light-dark.png). It was written before this repository existed: its `Initial Documentation/` paths mean `docs/product/`, and the website-builder mockup it lists as not for use is deliberately not included.
- [`docs/development.md`](docs/development.md): how to install, run and check the code locally.
- [`docs/adr/`](docs/adr/): architecture decision records.
- [`docs/provider-cost-register.md`](docs/provider-cost-register.md): free-tier checks for every external service.

## Rules that apply from the first commit

- **The product specification is read-only.** The three files in `docs/product/` must never be edited, renamed, moved, reformatted or regenerated. Changes to them happen in a separate workflow outside this repository.
- `architecture.md` and `CLAUDE.md` change only with the owner's approval, in their own pull request.
- Feature branches merge into `main`. Production runs only from the separate `production` branch, which changes only through a release pull request from `main` ([ADR 0002](docs/adr/0002-branch-model.md)).
- Every pull request runs CI (`.github/workflows/ci.yml`), including a spec guard that fails if anything in `docs/product/` changes. Repository settings the owner applies by hand are in [`docs/github-setup.md`](docs/github-setup.md).
