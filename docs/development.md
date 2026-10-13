# Local development

## Requirements

- Node.js 22 LTS, 22.18 or newer (see `.nvmrc`). The repository scripts in `tools/repo-checks` run as TypeScript directly, which needs Node 22.18+.
- pnpm 10.28.0. With Corepack: `corepack enable`, and the version in `package.json` is used automatically.

## First setup

```sh
pnpm install --frozen-lockfile
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @madeora/e2e exec playwright install --with-deps chromium   # once per machine
pnpm dev
```

The web app runs at http://localhost:3000. `apps/web/.env.local` is ignored by Git; never commit it.

## Environment variables

Defined and validated in `packages/config/src/env/index.ts`, documented in `apps/web/.env.example`.

| Variable              | Where                    | Required | Meaning                                                     |
| --------------------- | ------------------------ | -------- | ----------------------------------------------------------- |
| `APP_ENV`             | server only              | yes      | `development`, `test`, `preview`, `staging` or `production` |
| `NEXT_PUBLIC_APP_URL` | public (in browser code) | yes      | Absolute `http` or `https` URL of the web app               |

`pnpm build` checks the public values first, because they are built into the browser code. The server checks all of them again when it starts. If one is missing or invalid, it logs the variable's name and answers every request with an error until the configuration is fixed. Values are never printed.

## Checks (the same commands CI runs)

CI (`.github/workflows/ci.yml`) runs these on every pull request into `main` or `production` and on every push to them. Each row names the CI check it belongs to.

| Check                                       | CI check                                    | Command                                                                       |
| ------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Install from the lockfile                   | every job except Spec guard and Secret scan | `pnpm install --frozen-lockfile`                                              |
| Formatting                                  | Format, lint, typecheck, unit tests, build  | `pnpm format:check` (fix with `pnpm format`)                                  |
| Lint (warnings fail)                        | Format, lint, typecheck, unit tests, build  | `pnpm lint`                                                                   |
| Type check                                  | Format, lint, typecheck, unit tests, build  | `pnpm typecheck`                                                              |
| Unit and component tests                    | Format, lint, typecheck, unit tests, build  | `pnpm test`                                                                   |
| Production build                            | Format, lint, typecheck, unit tests, build  | `pnpm build`                                                                  |
| Browser smoke tests                         | E2E smoke tests                             | `pnpm test:e2e` (builds the web app first)                                    |
| Product specification unchanged             | Spec guard                                  | `pnpm check:spec` (add `--base origin/main` to also check your branch's diff) |
| High or critical dependency advisories      | Dependency audit                            | `pnpm audit:deps`                                                             |
| Secrets in Git history                      | Secret scan                                 | `gitleaks git --redact .` (gitleaks 8.30.1, installed separately)             |
| Pull requests into `production` from `main` | Release source                              | (CI only)                                                                     |

`pnpm build` and `pnpm test:e2e` need `APP_ENV` and `NEXT_PUBLIC_APP_URL`. CI uses the synthetic values `APP_ENV=test` and `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100`.

## Dependency audit exceptions

`pnpm audit:deps` runs `pnpm audit` and fails on any **high** or **critical** advisory. Moderate and low advisories are printed as warnings. When an advisory cannot be fixed yet (for example, no patched version exists) and does not affect Madeora, record a time-limited exception in `tools/repo-checks/audit-exceptions.json`:

- `id`: the GHSA id. `package`: the affected package name. Both must match the advisory.
- `reason`: why it does not affect Madeora, including the dependency path.
- `added` and `expires`: dates (`YYYY-MM-DD`). An exception may last at most 90 days. When it expires, the check fails until someone re-assesses the advisory and renews or removes the exception.

Exceptions are owner-reviewed (`CODEOWNERS`) and belong in the pull request that needs them. Remove an exception as soon as the check reports it as no longer needed.

Prettier never checks or rewrites `docs/product/` (the read-only product specification), `CLAUDE.md`, `architecture.md` or `docs/design/`; see `.prettierignore`.
