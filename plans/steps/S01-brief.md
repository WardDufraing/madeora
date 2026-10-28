# S01 · Monorepo bootstrap — feature brief

**Branch:** `chore/bootstrap-monorepo` from `main` @ 33e0576 (S00 seed).
**Sources:** build-plan S01; CLAUDE.md (approved stack, code quality B, testing A, config A, frontend B); architecture.md §2, §5, §12, §20, §23, §27, §29; S00 review carry-overs.

## Scope

- Turborepo + pnpm workspaces (`apps/*`, `packages/*`, `tests/e2e`).
- `apps/web`: Next.js App Router, React, strict TypeScript, Tailwind CSS. One neutral placeholder page, no product behaviour.
- `packages/config`: shared tsconfig presets, shared ESLint flat config (TypeScript, React Hooks, Next.js, jsx-a11y, Prettier-compatible), and the Zod-validated typed environment loader (server vs public split). Matches both ARCH §5 ("shared lint/TypeScript/build configuration") and CLAUDE.md config strategy A.
- Prettier at the root with `.prettierignore` that keeps the formatter away from `docs/product/` (S00 review carry-over), `CLAUDE.md`, `architecture.md` and `docs/design/`.
- Vitest + React Testing Library (+ user-event, jest-dom) in `apps/web`, Vitest in `packages/config`.
- `tests/e2e`: Playwright workspace (ARCH §5 puts E2E under `tests/e2e/`) with one smoke test.
- `.env.example`, `.gitignore` covering `.env*.local`.
- `docs/adr/0001-stack.md`, `docs/provider-cost-register.md` stub, `docs/development.md` (local equivalents of CI commands).

## Out of scope

Supabase, CI workflow, CODEOWNERS, PR template (S02), design tokens/components (S04), i18n/theme/app shell (S05), `apps/mobile`, any product behaviour.

## Environment variables (infrastructure only)

- `APP_ENV` (server, required): `development | test | preview | staging | production`. Lets later steps refuse production services when non-production config is missing.
- `NEXT_PUBLIC_APP_URL` (public, required): absolute http(s) URL of the web app.
  Validated at server start through `instrumentation.ts`; errors list variable names and "missing"/"invalid", never values.

## Acceptance tests

1. Fresh clone: `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e` all pass.
2. Missing or invalid required env var fails with its name and without its value (unit tests + manual server start check).
3. `prettier --check .` never visits `docs/product/`; spec sha256 unchanged after `pnpm format`.
4. No `apps/mobile`, no Supabase, no paid service.

## Open questions

None blocking. Defaults chosen: Node 22 LTS, pnpm 10.28.0, `@playwright/test` pinned to 1.56.1 (matches the container's Chromium; CI installs its own browser), TypeScript 6.0 (typescript-eslint does not support 7 yet), ESLint 9 (eslint-plugin-react not yet ESLint 10 ready).
