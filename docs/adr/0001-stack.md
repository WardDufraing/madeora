# ADR 0001: Monorepo and web stack

- **Status:** Accepted (owner-approved stack, recorded in `architecture.md` §2 and `CLAUDE.md`, 13 October 2026)
- **Date:** 2026-10-13
- **Step:** S01, monorepo bootstrap

## Context

`architecture.md` §2 and `CLAUDE.md` approve the stack. This ADR records how the bootstrap applies it and which versions it pins, so later steps start from the same baseline. It does not change any approved decision.

## Decision

- **Monorepo:** Turborepo with pnpm workspaces. Workspaces: `apps/web`, `packages/config`, `tests/e2e`. No `apps/mobile` (native apps are post-MVP). Other packages from `architecture.md` §5 (`contracts`, `domain`, `validation`, `design-tokens`) are created by the step that first needs them.
- **Web app:** Next.js App Router with React and strict TypeScript, Tailwind CSS v4 through PostCSS. Server Components by default.
- **Shared configuration (`packages/config`):** TypeScript presets (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), a shared ESLint flat config (typescript-eslint strict type-checked, React, React Hooks, Next.js, jsx-a11y strict, eslint-config-prettier), and the Zod-validated environment loader. This one package covers both the "shared lint/TypeScript/build configuration" of `architecture.md` §5 and the typed environment package of `architecture.md` §20.
- **Environment configuration:** schemas in `@madeora/config/env`. Server-only and `NEXT_PUBLIC_` values have separate schemas. `apps/web/next.config.ts` validates the public values before a production build, because Next.js inlines `NEXT_PUBLIC_` values into the bundle at build time. `apps/web/src/instrumentation.ts` validates server and public values again when the server starts. Errors name each failing variable and whether it is missing or invalid, never its value. Server-only values are not needed to build.
- **Formatting:** Prettier at the root. `.prettierignore` excludes `docs/product/` so the read-only specification is never checked or rewritten, and also `CLAUDE.md`, `architecture.md` and `docs/design/`, which change only with owner approval.
- **Lint warnings fail:** every workspace runs `eslint . --max-warnings=0`.
- **Tests:** Vitest (jsdom plus React Testing Library, user-event and jest-dom in `apps/web`; node in `packages/config`). Playwright lives in the `tests/e2e` workspace and runs against the production build.

## Pinned versions

Node.js 22 LTS (`.nvmrc`, `engines >=22.12`), pnpm 10.28.0 (`packageManager`), Turborepo 2.11.8, Next.js 16.4.0, React 19.3.0, TypeScript 6.0.3, ESLint 9.39.5, typescript-eslint 8.71.2, Tailwind CSS 4.3.3, Zod 4.6.7, Vitest 5.0.4, Prettier 3.9.10, `@playwright/test` 1.56.1.

Reasons for the versions that are not the newest:

- **TypeScript 6.0, not 7:** typescript-eslint 8.71 supports TypeScript below 6.1.
- **ESLint 9, not 10:** `eslint-plugin-react` 7.37 does not support ESLint 10 yet.
- **Playwright 1.56.1:** matches the Chromium build preinstalled in the development containers, so tests run there without a browser download. CI installs its own browser for this version. Upgrade together with the containers.

## Consequences

- Every workspace inherits strict TypeScript and the same lint rules; overrides must be narrow and justified.
- New environment variables are added to the schemas in `packages/config/src/env/index.ts` and to `apps/web/.env.example` together, with tests.
- Upgrading TypeScript to 7 or ESLint to 10 needs the lint plugins to support them first.
