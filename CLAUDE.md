# Madeora — Claude Development Instructions

These instructions are mandatory for every Claude agent working in this repository. For technical details, read `architecture.md`; obtain approved product requirements from the read-only product specification without editing it.

**The product specification** is the fixed set of three files: `Project-entry.md` (read first), `Modules.md` (module catalogue) and `Project-specification.md` (binding detailed requirements). **Everything in it is MVP.** `CLAUDE.md` and `architecture.md` may change with owner approval; the three specification files may not.

## Start here — non-negotiable baseline

- **Web MVP = Next.js App Router + React + strict TypeScript**, not a standalone React SPA. Use Server Components by default and client components only for required interaction.
- **Development spend = €0.** No paid plan, billing activation, credit-card requirement, paid add-on or unexpected charge without explicit owner approval. Verify third-party free-tier limits and terms before integration; offer a no-cost fallback when unavailable.
- **Product authority:** the product specification is immutable in this workstream. Never change it, including formatting.
- **Delivery:** one feature branch and PR per change; tests and CI; separate independent review agent; human approval before merge or production deployment. **Solo bootstrap phase (owner, 2026-10-13):** CI and the independent review agent are required on every PR; Vercel PR previews run from step S04b onward (owner, 2026-10-13, ADR 0005), on the free Hobby plan and access-protected; early production deploys run from the `production` branch, only through the owner's release PR from `main`, with demo data only and Turnstile on sign-in forms (owner, 2026-10-14, ADR 0008); dedicated staging becomes required at the release stage, not before.
- **Security:** tenant isolation in Supabase RLS plus authorized server workflows. Never rely on hidden UI or client state for access control.
- **Scope:** native iOS/Android apps are post-MVP. Never add unapproved services, architecture changes, or product behavior.

### Before writing code

1. Read relevant approved product requirements, the applicable `architecture.md` sections and this file.
2. Identify acceptance criteria, permission boundaries, data migrations, tests and any open decisions.
3. If a decision is unresolved or requirements conflict, **ask the owner**. Do not silently choose an option.
4. Implement only the approved scope and preserve the €0 development constraint.

## Source of truth and immutability

1. The product specification (`Project-entry.md`, `Modules.md`, `Project-specification.md`) is the authoritative product definition. **READ ONLY. NEVER edit, rename, move, format, replace, regenerate, or commit changes to the product specification.** It is maintained in a separate workflow.
2. `architecture.md` defines technical decisions, subject to owner approval. Do not treat proposed choices as approved when they are marked open.
3. This `CLAUDE.md` defines development process. In conflicts: do not guess; stop and ask the owner. Product requirements and privacy rules take precedence over convenience.
4. Before each task, inspect relevant specifications and existing code. Flag contradictory or missing requirements rather than inventing features.
5. Changes to architecture or agent rules require explicit owner approval and a separate PR.

## Approved implementation boundaries

- Initialize **Turborepo + pnpm workspaces** immediately, with `apps/web` as the MVP app.
- Native iOS and Android applications are intended to be **full-featured**, but are **out of MVP scope**. Do not scaffold `apps/mobile`, add Expo CI, or implement mobile-only behavior without a later approved task.
- Use the **hybrid API strategy**: Supabase Auth/Postgres/RLS (with approved selective Supabase Realtime) plus an application API for privileged, complex or integration-backed operations.
- **Approved authentication strategy A:** use Supabase Auth with official `@supabase/ssr` for Next.js SSR/cookie integration and `@supabase/supabase-js` clients. Do not add custom session infrastructure or another identity provider without owner approval. Validate identity server-side (do not trust unverified session user objects), enforce separate Home membership/role checks and RLS, protect cookie-authenticated mutations against CSRF, prevent cross-user SSR caching, and test refresh, expiration, sign-out, Home switching and revocation. Clear sensitive TanStack Query state and Realtime subscriptions on identity changes. Mobile session handling is post-MVP. Sign-in methods are decided by the product specification; build them as `architecture.md` §7 describes: adult email/password plus **Google sign-in** (Sign in with Apple is a spec requirement but **deferred** until the owner approves the Apple Developer Program fee; do not build it before then), optional TOTP 2FA, recovery codes and verified backup email. **Children and Household Displays are also Supabase Auth users** (internal non-deliverable email aliases); username/PIN and display pairing are verified by Madeora server code before a Supabase session is issued. Do not add a second session or token system.
- **Approved authorization strategy C:** enforce Home/row/action boundaries in PostgreSQL RLS and use a centralized, typed TypeScript permission engine for detailed server-side capability, role, ownership and guardian decisions. RLS must be sufficient to secure any operation exposed directly via Supabase; TypeScript-only checks never justify permissive RLS. Validate identity and current membership for each sensitive API action; use the actor's Supabase session by default. Route rules that cannot be safely enforced through RLS/RPC via the authorized server API. Client permission projections only guide UI. Audit sensitive changes; invalidate relevant caches/subscriptions on permission changes. Require policy-matrix unit tests and multi-actor RLS/integration tests for cross-Home access, forged IDs, role escalation, revocation and guardian boundaries. Obtain canonical capabilities from the read-only product specification; do not invent roles or exceptions.
- **Approved database access strategy A:** use the official `@supabase/supabase-js` client exclusively for application database queries and mutations. Do not add Prisma, Drizzle, direct `pg` access, or another ORM/query builder without explicit owner approval. Generate typed Supabase database bindings; use `supabase.rpc()` for transactional PostgreSQL functions. SQL migrations, RLS policies, indexes, constraints, functions, and DB tests remain required and permitted.
- **Approved realtime strategy C:** use Supabase Realtime only for actively relevant collaborative views; default to authoritative reads and targeted refresh elsewhere. Never create app-wide subscriptions to all tables. Scope by authenticated user and authorized Home; verify RLS/Realtime authorization, handle initial-fetch races, reconnect/refetch, token changes, Home switches and subscription cleanup. Do not assume delivery or event ordering. Test cross-Home/child privacy and long-running wall-display behavior. Select per-feature realtime mechanisms only when justified by the product specification.
- **Approved data fetching strategy B:** combine Next.js App Router server rendering with TanStack Query (`@tanstack/react-query`) for interactive client-side server state. TanStack Query is not a database client: all database access must still use official `@supabase/supabase-js` and authorized server endpoints. Use typed query keys and explicit invalidation/refetch for mutations and relevant realtime events. Prevent cross-user and cross-Home cache leakage: clear or invalidate sensitive caches on logout, Home switch, permission changes and session transitions. Treat SSR hydration and Next.js server caching of personalized data as security-sensitive. Test stale data, optimistic rollback, auth transitions, permission revocation, and reconnect reconciliation. Do not add SWR or another competing server-state library without approval.
- **Approved Ora sequencing (2026-10-13):** build Ora first with contextual suggestions, action buttons, quick actions and deterministic overviews only, with **no language-model provider and no free-text input**. Free-text input (a spec requirement) is added later, after the owner approves a model provider and budget. Do not add an LLM SDK or API key before that approval.
- **Approved storage sequencing (2026-10-13):** add Cloudflare R2 when the first feature that stores files needs it, not during bootstrap. If R2 then requires a payment card or billing activation, stop and ask the owner first (€0 rule).
- Keep shared contracts and pure domain logic framework-independent; do not put server secrets or privileged logic in shared client packages.
- A Next.js Route Handlers API is the recommended initial implementation, not yet a separately approved deployment decision. Ensure future mobile clients can consume stable HTTP contracts.

## Mandatory workflow — every change

1. Confirm scope, acceptance criteria, affected modules, risks, and tests. Ask clarifying questions when behavior is unclear.
2. Start from updated protected `main`. Create a **new descriptive branch** for this one change; never work directly on `main`. Use `feat/`, `fix/`, `refactor/`, `chore/`, `docs/`, or `test/`.
3. Implement the smallest coherent change. Keep unrelated edits out of the branch. Do not touch the product specification.
4. Add or update tests for changed behavior, including failure, authorization, privacy and edge cases.
5. Run formatting, lint, typecheck, relevant tests and build. Fix failures rather than suppressing checks.
6. **Invoke a separate independent review agent** with fresh context after implementation. It must inspect the diff, requirements, architecture, tests, security, performance and accessibility; it must not be the implementing agent and must not simply approve its own work.
7. Address all blocking review findings. If substantive code changes are made after review, run tests again and request a new independent review of the final diff.
8. Open a GitHub PR with summary, linked requirement(s), testing evidence, risks, migration/rollback notes and independent-review result. Wait for CI and required human approval.
9. **Do not self-merge or deploy.** Only merge through the protected PR process when all gates pass and owner-approved release policy permits it.
10. Record approved changes and rationale in an appropriate change log or ADR; never modify the product specification from this workflow.

## Independent reviewer contract

The reviewer receives the branch diff and relevant requirements, but no instruction to agree with the implementer. It must return:

- Verdict: `PASS` or `CHANGES_REQUIRED`.
- Findings ranked `BLOCKER`, `HIGH`, `MEDIUM`, `LOW`, each with file/line, impact, and remediation.
- Explicit checks: requirements, cross-Home isolation, permissions, secrets, input validation, migration safety, test coverage, accessibility, performance, maintainability.
- Remaining risks and test gaps.

Any BLOCKER or HIGH finding blocks PR readiness. A reviewer may not silently change scope or approve unresolved security defects. Claude must not represent an AI review as equivalent to a GitHub human code-review approval.

## Git and repository protection

- One task/change per branch and PR; use conventional commits where practical.
- No direct pushes to `main`, force pushes, rewriting shared history or bypassing required checks.
- Never commit credentials, `.env.local`, user data, production exports or generated secrets.
- Never modify unrelated files or mass-format the repository without approval.
- Keep migrations and tests with the feature that needs them.
- The three product-specification files live read-only in `docs/product/`. Protect them with CODEOWNERS and a CI check that fails any PR that modifies, renames or deletes them.
- PR template must include checklist for `product specification unchanged`, tests, security, reviewer verdict and owner approval.
- Use CODEOWNERS / branch rulesets / required checks to enforce gates where GitHub plan and configuration allow.

## CI/CD requirements

During bootstrap, implement GitHub Actions CI that runs on PRs and `main`:

- `pnpm install --frozen-lockfile`
- Prettier check, ESLint, TypeScript strict check
- Vitest unit and integration tests
- Supabase migration/RLS validation against disposable test database
- Next.js production build
- Playwright E2E smoke tests with isolated fixtures
- Secret scanning and dependency security checks
- Vercel preview deployment and preview smoke checks when configured

Require green checks before merge. Separate production environment/secrets and require appropriate release approval. Never weaken CI just to pass a PR. Keep the pipeline maintainable and document local equivalents of CI commands.

## Engineering standards

- Strict TypeScript. Avoid `any`, unchecked casts, implicit authorization and hidden side effects.
- Validate inputs at boundaries. Prefer typed domain services and simple, readable code.
- Server enforces every permission; client UI hiding is not authorization.
- Every Home-scoped query/write must enforce Home isolation; test negative cases. Default to user-session Supabase clients so RLS applies; privileged server clients are exceptional and require explicit policy checks.
- For atomic multi-record changes, use reviewed PostgreSQL functions through `supabase.rpc()` instead of unsafe sequences of independent client mutations.
- Do not use display names, avatars, icons or accent colors as identity keys.
- Respect guardian/child restrictions from product specifications.
- Treat all secrets as server-only. Service-role access requires explicit scoped authorization.
- **Approved file storage strategy B:** keep Cloudflare R2 private. Require an authenticated and Home-authorized API upload intent; server-generated opaque keys; short-lived, operation-scoped presigned direct PUT uploads; and a server-verified finalize step before making metadata/files usable. Verify actual object size/type/integrity rather than trusting client declarations or presigned URL conditions. Authorize every download before issuing short-lived GET-only URLs; never treat object paths as permissions. Keep R2 credentials server-only; rate-limit and audit signing, isolate environments, clean abandoned uploads, and make deletion idempotent. Remember issued download URLs remain usable until expiration; use an authorization gateway if immediate revocation is required. Test forged keys, cross-Home access, expiry, file mismatch and revocation. Do not invent upload limits or retention policies. Verify Turnstile and webhooks server-side.
- **Approved background processing strategy B:** use Trigger.dev only for durable, scheduled, retryable, long-running or failure-sensitive asynchronous jobs. Keep simple fast operations synchronous in the authenticated Madeora API. Do not add queue infrastructure for trivial operations.
- Make Trigger.dev jobs idempotent, typed, observable and retry-safe, with bounded retries and documented recovery. For database-write-plus-job workflows, use a transactional outbox or equally reliable handoff; never silently lose jobs or claim success prematurely. Re-check relevant permissions/resource state on execution; do not include secrets or raw sessions in job payloads. Test duplicate execution, partial failure, dispatch outage, retry, cancellation and revoked access.
- **Approved transactional email strategy A:** use Resend for transactional delivery and React Email for typed, Git-versioned templates in a server-safe shared Turborepo package. Centralize rendering, validation, sender identity and delivery; never send from browser code or expose API keys. Use Trigger.dev for durable/retryable/scheduled sends, with idempotency and bounded retries. Verify and deduplicate Resend webhooks, reconcile delivery outcomes, and honor approved preferences and suppression rules. Require accessible HTML and plain-text alternatives, safe interpolation, environment-separated verified domains, and tests for rendering, provider failure, retries and duplicate events. Do not invent email content or account flows absent the product specification approval.
- **Approved forms and validation strategy A:** use React Hook Form + Zod (`@hookform/resolvers/zod` as appropriate) for interactive web forms. Implement Madeora-owned accessible form controls; prefer native input registration and use `Controller` only when required. Share client-safe Zod schemas through `packages/validation` where justified. Validate every untrusted input again server-side; enforce authorization, invariants and database constraints separately. Handle field/form errors, submission state, focus and duplicate submissions accessibly. Test success, invalid data, server failure and cross-field constraints. Reuse schemas with future mobile apps, not web UI components. Do not introduce competing form libraries without owner approval.
- **Approved frontend strategy B:** Tailwind CSS + fully custom Madeora components. Do not install shadcn/ui or a ready-made visual component kit. Use semantic HTML and accessible React patterns; propose a focused headless primitive only when justified and approved. Implement approved tokens, gradient accents, light/dark themes, responsive and wall-display states; avoid inventing visual/product decisions. Separate UI components from data and authorization. Share platform-neutral tokens with future mobile apps, not web DOM components. Test keyboard/focus, screen readers, reduced motion, accessibility and visual states.
- Design accessible, responsive, keyboard-friendly interfaces; maintain approved visual language and light/dark behavior.
- No speculative abstractions, unnecessary dependencies, or premature microservices.
- Log actionable errors without exposing sensitive data.

- **Approved automated testing strategy A:** use Vitest for unit/integration tests, React Testing Library (`@testing-library/user-event`, `@testing-library/jest-dom`) for custom React UI, and Playwright for browser E2E. Test behavior and accessible interactions, not component internals. Use real isolated Supabase RLS/RPC security tests; mocks cannot prove data isolation. Include automated axe checks and manual accessibility review where appropriate. Keep fixtures isolated, test failures/recovery, and run lint, formatting, typecheck, tests, build, RLS checks and Playwright smoke checks in GitHub Actions. Never remove or skip failing tests to make CI green. Independent review of the final diff and human approval remain mandatory. Mobile-specific test tooling is post-MVP; do not add it now.

- **Approved code quality strategy B:** use ESLint (flat config), Prettier and TypeScript strict mode across all applicable Turborepo workspaces. Centralize shared configurations; use appropriate React Hooks, Next.js, TypeScript and accessibility lint rules. Prettier owns formatting; avoid conflicting ESLint style rules. Run `prettier --check`, ESLint and workspace typechecks locally and in required GitHub Actions PR checks. Do not use Biome, globally disable rules, suppress errors or mass-format unrelated files without explicit approval. Expo-specific configuration is post-MVP.

- **Approved observability strategy B:** use Vercel, Supabase and Trigger.dev native logs, dashboards and job diagnostics for MVP, with structured, privacy-safe application logs and correlation IDs across API requests and asynchronous work. Do not introduce Sentry, OpenTelemetry collectors or another monitoring vendor without approval. Never log secrets, auth tokens, signed URLs, email bodies, sensitive household content or child data. Restrict log access and retention, configure practical alerting/health checks for critical failures, document incident response, and test error visibility and redaction before release.

- **Approved deployment environment strategy A:** maintain local development, non-production Vercel PR previews, a dedicated staging environment and isolated production. Separate Supabase, R2, Trigger.dev and Resend configurations/credentials by environment; use synthetic test data and never expose production secrets to PR code. Promote only after required CI, independent agent review, human PR approval, staging migrations/RLS/integration/smoke validation and explicit production release approval. Rehearse backward-compatible SQL migrations and document backup/recovery and post-release verification. Do not assume database rollbacks are automatic; do not introduce progressive-rollout infrastructure without approval. Never change the product specification.


- **Approved development budget constraint (2026-10-13): €0 mandatory spend until the owner explicitly authorizes payment.** Use local/open-source tooling and verified free plans only. Before adding or provisioning any service, check its current free limits, terms, billing/card requirements, quotas and overage behavior; document the result in a provider-cost register. Never enable paid tiers, usage-based billing, paid trials, purchased domains or credit-card requirements without approval. Vercel, Supabase, Cloudflare R2, Trigger.dev, Resend and GitHub Actions are conditional on genuinely free eligibility; otherwise use local/sandbox substitutes or ask before changing architecture. A dedicated staging environment remains a release goal but must not incur development costs; emulate it locally or use truly free isolated resources until funding is approved. Do not claim Supabase PITR or production-grade backup on a free tier. If cost constraints conflict with security/privacy requirements, stop and escalate rather than weaken safeguards.


- **Approved development database backup strategy C (2026-10-13):** use Git-versioned Supabase SQL migrations and deterministic synthetic seeds **only** during the €0 development phase. Treat all local/test databases as disposable. Do not create backup jobs, snapshots, scheduled exports, cloud backup integrations or restore drills as development requirements. Provide a documented local reset/rebuild command; CI must build a fresh database, apply migrations, seed it and run real RLS tests. Never seed with actual household or sensitive user data. Clearly warn before destructive local resets. This does not authorize production without an explicitly approved, tested database and R2 recovery strategy; never claim migrations restore user content.


- **Approved local development strategy C (2026-10-13):** run Next.js, Node.js, pnpm and Turborepo natively; use isolated hosted development services only where current free-tier terms are verified and **€0 mandatory spend** is guaranteed. Prefer a free development-only Supabase cloud project for everyday work, with synthetic disposable data and ignored local credentials. Do not add cards, activate billing, incur overages or use paid trials. Record eligibility/quotas/fallbacks in the provider-cost register. Preserve Git-versioned SQL migrations and synthetic seeds only for development recovery. Run destructive migrations/reset and real RLS tests in an isolated ephemeral/local test database, **never** against the shared hosted development project. Do not mistake free development resources for staging or production. If no suitable free hosted service exists, stop and request approval for a local fallback rather than spending or weakening safeguards.


- **Approved application configuration strategy A (2026-10-13):** use a shared Zod-validated typed environment configuration package (`packages/config` or equivalent). Separate server-only secrets from explicitly allowlisted `NEXT_PUBLIC_` values; never bundle server credentials into client code. Validate required settings early with errors that identify variable names but never reveal values. Maintain `.env.example`, ignore `.env.local`, isolate development/preview/staging/production/CI values, and never default to production services when non-production configuration is missing. Avoid unnecessary build-time evaluation of runtime-only secrets. Test schema failures, server/client boundaries and deployment startup. Do not introduce T3 Env, paid secret managers or billing; preserve the €0 development budget.


- **Approved internationalization strategy A (2026-10-13):** implement Next.js App Router internationalization with free open-source `next-intl`. Use checked translation dictionaries, ICU plurals and `Intl` locale formatting. Respect each eligible user's personal interface-language preference across Homes, with an **independent Household Display locale**; never overwrite one with the other. Translate only Madeora-owned UI strings, **never automatically translate user-created content**. Start with **Dutch (`nl`) and English (`en`)** (both appear in the spec's acceptance criteria) and keep layouts RTL-safe; the full launch locale list is still open. Resolve initial locale server-side and keep hydration consistent; test locale isolation, fallbacks, formatting, missing keys and accessibility. Do not add paid translation APIs or assume a mobile localization library before post-MVP design. Preserve the €0 development budget.

- **Approved date/time strategy A (2026-10-13):** use free open-source `date-fns` + `date-fns-tz` for calculations and IANA timezone conversions, and native `Intl`/approved `next-intl` for localized display. Distinguish UTC instants, local calendar dates and wall-clock times; never assume the browser timezone is the Home or Display timezone. Validate API date/time inputs with Zod, persist UTC instants and relevant timezone/recurrence metadata, and explicitly handle DST gaps/overlaps rather than silently guessing. Recompute scheduled reminders from timezone-aware local recurrence rules and ensure idempotency. Test DST, leap days, cross-zone cases, date-only preservation, SSR hydration and recurring schedules. Maintain €0 development spend.

- **Approved frontend state strategy A (2026-10-13):** use Zustand for narrowly scoped shared *ephemeral UI state*, local React state for component-local interactions, and TanStack Query for authoritative server data. Do not duplicate Supabase entities, roles, memberships, permissions or private household records in Zustand or use it for access control. Persist changes via authorized APIs and query invalidation; distinguish unsaved drafts from saved data. Reset account/Home-scoped UI state and sensitive query caches on sign-out, Home switching, revocation and session transitions. Avoid cross-request Zustand state on the server and SSR hydration mismatches. Test selectors, store actions, resets, multi-Home isolation and unsaved edit behavior. Do not add competing state libraries or paid dependencies; maintain €0 development spend.

- **Approved dashboard layout strategy B (2026-10-13):** use the verified free/open-source React Grid Layout package for draggable and resizable dashboard widgets. Wrap it in Madeora-owned, Tailwind-styled components; never adopt its default appearance as the product design. Use stable widget IDs and versioned, Zod-validated layouts with breakpoint constraints. Apply permissions in authorized APIs and RLS; never trust client coordinates or edit controls. Provide keyboard-accessible move/resize alternatives, focus states and announcements rather than relying on pointer drag alone. Keep drafts in ephemeral UI state and save through TanStack Query/API with conflict and error handling. Test resizing, collision, breakpoints, edit permissions, invalid layouts, Home isolation and accessibility. Do not add dnd-kit or paid grid packages without approval; maintain €0 development spend.


- **Approved icon strategy C (2026-10-13):** build a fully custom Madeora SVG icon system; no Lucide, Phosphor or general-purpose icon pack without explicit owner approval. Keep original SVGs and typed, reusable React wrappers in `packages/icons` or equivalent. Follow the approved design specifications for stroke/fill, sizing, alignment and themes; use semantic color tokens, not arbitrary hardcoded colors. Decorative icons are `aria-hidden`; icon-only controls need accessible names and keyboard focus. Never inject untrusted SVG or external references; review provenance/licenses for any adapted artwork. Test theme contrast, accessibility, responsive/display rendering and hydration. Keep development spend at €0.

- **Approved animation strategy A (2026-10-13):** use free open-source Motion for React for complex React/layout/enter-exit animations and CSS transitions/keyframes for simple states. Centralize motion tokens and reusable patterns; match the approved the read-only product specification design. Honor `prefers-reduced-motion`, preserve keyboard/focus accessibility, and never use animation as the only status signal. Prefer performant transform/opacity effects, avoid excessive motion on Household Displays, and do not let Motion transforms conflict with React Grid Layout drag/resize. Test reduced motion, interruptions, responsive behavior and hydration. No paid animation packages or services; development budget remains €0.

## Definition of done

A change is done only when: acceptance criteria are met; tests are added and pass; security/privacy and accessibility are checked; migration and rollback implications are documented; the independent agent returns PASS on the final diff; CI passes; the PR has required human approval; and no prohibited files were changed.

## Required output at the end of each implementation task

Report: branch name; files changed; behavior implemented; tests run and results; reviewer verdict/findings; CI/PR status; unresolved risks; decisions requiring owner approval. Do not claim a check ran if it did not.

## First assignment to Claude

Read the product specification set (READ ONLY), `architecture.md`, and `CLAUDE.md`. Propose a short bootstrap plan using the approved stack and list only genuinely unresolved decisions. Do not start coding dependent product behavior until its requirements are confirmed. Create the Turborepo/pnpm repository, web app, tooling and CI work in a fresh branch and obtain an independent review before PR readiness. If GitHub settings cannot be applied automatically, provide exact owner-facing setup instructions instead of claiming they are configured.

## Graphify code graph

A local, gitignored code graph lives in `graphify-out/` (built offline with `graphify update .`; no LLM, no API key, €0). The `.claude/` hooks install the pinned CLI and rebuild it at session start.

- When `graphify-out/graph.json` exists, run `graphify query "<question>"` before the first grep or source-file read for a codebase question; read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` and `graphify explain "<path::symbol>"` for relationships and single concepts.
- After modifying code, run `graphify update .` (AST-only). Never run the semantic extraction on `docs/product/` or other documents: it sends them to an LLM.
- The graph helps reading, not editing; it never replaces the product specification, `architecture.md` or the line-range rules for the specification.
