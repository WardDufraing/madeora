# Madeora

Madeora is a modular personal-life and household coordination application. A person can use it alone or belong to several Homes, with personal and shared dashboards. The current codebase includes account preferences, Home membership and invitations, tasks, task calendars, chores, Home vacations and absences, Home points and rewards, recipes, meal planning, shopping lists, personal and Home habits, private personal points and rewards, notifications, private file storage, and recovery tools. The wider product plan also covers additional modules and the permission-aware assistant Ora; see the binding product documents for approved scope.

## Repository

Madeora is a Turborepo + pnpm monorepo:

- `apps/web`: Next.js web app (App Router, strict TypeScript, Tailwind CSS, next-intl for Dutch and English).
- `packages/config`: shared TypeScript and ESLint configuration and validated environment settings, separated into server-only and public values.
- `packages/database`: TypeScript types generated from the database schema.
- `packages/design-tokens`: light and dark colours, type, spacing, radii and motion; generates CSS and the Tailwind theme.
- `packages/icons`: Madeora's SVG icons as typed React components.
- `packages/jobs`: background job conventions, the outbox dispatcher and Trigger.dev tasks ([background jobs](docs/background-jobs.md)).
- `packages/observability`: correlation IDs and the structured, redacting logger.
- `supabase/`: Supabase CLI project with ordered schema/RLS migrations and synthetic seed data.
- `tests/e2e`: Playwright browser tests.
- `tests/db`: database and RLS tests, including multi-actor helpers.
- `tools/repo-checks`: repository guards run by CI, including the product-specification guard and dependency audit.

## Current implementation snapshot

The repository currently contains working code for the application shell and these feature areas:

- Account preferences, including display name, language, regional formats and timezone.
- Personal dashboards and configurable dashboard templates/widgets.
- Home creation and membership, invitations and join flows, member profiles, role and ownership management, and ownership recovery.
- Tasks, task calendars, recurrence, reminders, templates, bulk actions and attachments.
- Chores, templates, history, approval workflows, a live unassigned chore pool with claims and reassignment requests, member proposals and volunteer requests, a chores calendar and schedule widget, personal chore reminders and daily summaries.
- Home vacations and temporary chore absences, including participant invitations and date proposals, vacation-aware rotation, a confirmed Home-wide chore pause, affected-chore review and a vacation dashboard widget.
- Chore points, private per-Home ledgers and balances, manual adjustments, rewards and approval-based redemption, optional leaderboard and weekly points views, and points dashboard widgets.
- Personal and Home recipes, private drafts, exclusive edit sessions, cover images, ratings, favorites, cooking mode, cross-Home sharing, impact-reviewed deletion and protected URL import.
- Personal and Home meal planning with configurable slots, recipe and custom meals, recurring series, occurrence edits, copy/print views, reviewed shopping-list transfers and dashboard widgets.
- Personal and Home shopping lists with configurable access, categories, live check-offs, recurring items, moves and copies, trash recovery and dashboard widgets.
- Personal and Home habits with daily, weekday and weekly-target schedules, recent check-ins and corrections, pauses, reminders, streaks, milestones, insights, vacation integration and dashboard widgets.
- Private personal points ledgers and self-defined rewards, with previewed adjustments, one-time reversals, redemption limits, fulfillment outcomes and a personal-only dashboard widget, kept separate from every Home ledger.
- Notifications and notification preferences.
- Private file storage, trash and recovery.

This list describes feature areas present in the repository; it does not certify that every approved product requirement is complete. See [User stories](docs/user-stories.md) for an implementation-aligned workflow index and its verification criteria.

## Where to start

- [Product entry point](docs/product/Project-entry.md): product overview. Read this first.
- [Module catalogue](docs/product/Modules.md): planned module scope and boundaries.
- [Product specification](docs/product/Project-specification.md): binding detailed product requirements.
- [User stories](docs/user-stories.md): implemented workflow map and acceptance checks, kept separate from the binding requirements.
- [Architecture](architecture.md): technical source of truth for stack, data model, security and operations.
- [Contributor instructions](CLAUDE.md): required workflow and rules for contributors and agents.
- [Design decisions](docs/design/design-decisions.md): owner design decisions that supplement the product specification, with the [styling reference mockup](docs/design/mockups/household-dashboard-light-dark.png).
- [Development guide](docs/development.md): how to install, run and check the code locally.
- [Production setup](docs/production-setup.md) and [production migrations](docs/production-migrations.md): production environment setup and database migration reference.
- [Provider cost register](docs/provider-cost-register.md): free-tier checks for external services.
- [Architecture decision records](docs/adr/): accepted technical decisions.
- [Step roadmap](plans/roadmap.md): step order evidenced in this repository, including [S28b personal points and rewards](plans/steps/S28b-brief.md).
- [Provider setup guides](docs/): service-specific configuration and operational instructions.

## Repository rules

- **The product specification is read-only in this repository.** The three files in `docs/product/` must not be edited, renamed, moved, reformatted or regenerated here. Product requirement changes use the separate product-specification workflow.
- `architecture.md` and `CLAUDE.md` change only with the owner's approval, in their own pull request.
- Feature branches merge into `main`. Production runs only from the separate `production` branch, which changes only through a release pull request from `main` ([ADR 0002](docs/adr/0002-branch-model.md)).
- Every pull request runs CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), including a guard that fails if anything in `docs/product/` changes. Repository settings the owner applies by hand are in [GitHub setup](docs/github-setup.md).
