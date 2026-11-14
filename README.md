# Madeora

Madeora is a modular personal-life and household coordination application. A person can use it alone or belong to several Homes, with personal and shared dashboards. The current codebase includes account preferences, adult account security and activity history, privacy reviews, exports and deletion, Home membership and invitations, child profiles and restricted household-device access, tasks, task calendars, chores, Home vacations and absences, Home points and rewards, recipes, meal planning, shopping lists, personal and Home habits, personal and Home goals, native and Google-connected personal and Home calendars, Home pets and pet care, personal and Home photo libraries, private personal points and rewards, notifications, private file storage, paired household displays, the permission-aware Ora assistant, and recovery tools. The wider product plan also covers additional modules; see the binding product documents for approved scope.

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
- Adult account security, including optional authenticator-app two-factor sign-in and recovery codes, trusted browsers, session review and revocation, recently reauthenticated password/email changes, backup email, and delayed account recovery.
- Account activity and lifecycle controls, including security alerts and reports, suspicious-sign-in responses, remembered-account switching on shared devices, privacy-preserving temporary deactivation and explicit reactivation.
- A privacy dashboard and guided review, with recently reauthenticated, category-selective personal and permission-checked Home exports prepared as expiring private archives.
- Personal dashboards and configurable dashboard templates/widgets.
- Home creation and membership, invitations and join flows, member profiles, role and ownership management, and ownership recovery.
- Recoverable account and Home closure, category-selective personal-data deletion, and reviewed personal-to-Home copies of recipes, events and albums with destination-side access checks.
- Child profiles with accepted primary/secondary guardianship, age presets and overrides, cross-Home linking, restricted username/password or household-device PIN sign-in, guardian/device session controls, shared-device chore completion, and age-aware transition to an independent account.
- Tasks, task calendars, recurrence, reminders, templates, bulk actions and attachments.
- Chores, templates, history, approval workflows, a live unassigned chore pool with claims and reassignment requests, member proposals and volunteer requests, a chores calendar and schedule widget, personal chore reminders and daily summaries.
- Home vacations and temporary chore absences, including participant invitations and date proposals, vacation-aware rotation, a confirmed Home-wide chore pause, affected-chore review and a vacation dashboard widget.
- Chore points, private per-Home ledgers and balances, manual adjustments, rewards and approval-based redemption, optional leaderboard and weekly points views, and points dashboard widgets.
- Personal and Home recipes, private drafts, exclusive edit sessions, cover images, ratings, favorites, cooking mode, cross-Home sharing, impact-reviewed deletion and protected URL import.
- Personal and Home meal planning with configurable slots, recipe and custom meals, recurring series, occurrence edits, copy/print views, reviewed shopping-list transfers and dashboard widgets.
- Personal and Home shopping lists with configurable access, categories, live check-offs, recurring items, moves and copies, trash recovery and dashboard widgets.
- Personal and Home habits with daily, weekday, weekly-target and numeric daily-target tracking, localized quantities and unit conversions, append-only corrections, pauses, reminders, streaks, milestones, insights, vacation integration and dashboard widgets.
- Personal and Home goals with measurable or completion targets, append-only progress and corrections, achievements and reopen flows, deadlines and reminders, recurring weekly/monthly/yearly series, habit-to-goal progress links within one context, period history, trash recovery and dashboard widgets.
- Native personal and Home calendars with private or shared events, all-day and timed recurrence, scoped series edits, reminders, chosen personal-to-Home sharing, vacation/task/chore overlays, trash recovery and an upcoming-events widget.
- Optional Google Calendar connections with encrypted tokens, per-calendar personal/Home visibility, privacy-aware inbound sync, outbound creates/edits/deletes, conflict resolution and honest sync/reconnect states.
- Home pet profiles, privacy-separated medical details and documents, per-member medical access, scheduled care with assignments and reminders, vacation-aware care counts, trash recovery and a pet-care widget.
- Personal and Home photo libraries with processed private images and derivatives, multi-album membership, cross-Home album sharing and contribution, impact-reviewed deletion, trash recovery and configurable photo widgets.
- Private personal points ledgers and self-defined rewards, with previewed adjustments, one-time reversals, redemption limits, fulfillment outcomes and a personal-only dashboard widget, kept separate from every Home ledger.
- Paired household displays with manager-reviewed, single-use device pairing; independent clock, chore and shopping layouts; privacy/party locking; optional member chore actions; display-scoped sessions; offline-safe fallbacks; and rename, revoke and reset controls.
- Ora as a persistent Personal/Home assistant surface with personal settings and per-Home colours, permission-filtered navigation and daily/weekly overviews, dismissible suggestions and muted teasers, and explicitly confirmed task/shopping-item creation with a five-minute safe undo window.
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
- [Step roadmap](plans/roadmap.md): current implementation order and links to the repository's step briefs.
- [Provider setup guides](docs/): service-specific configuration and operational instructions.

## Repository rules

- **The product specification is read-only in this repository.** The three files in `docs/product/` must not be edited, renamed, moved, reformatted or regenerated here. Product requirement changes use the separate product-specification workflow.
- `architecture.md` and `CLAUDE.md` change only with the owner's approval, in their own pull request.
- Feature branches merge into `main`. Production runs only from the separate `production` branch, which changes only through a release pull request from `main` ([ADR 0002](docs/adr/0002-branch-model.md)).
- Every pull request runs CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), including a guard that fails if anything in `docs/product/` changes. Repository settings the owner applies by hand are in [GitHub setup](docs/github-setup.md).
