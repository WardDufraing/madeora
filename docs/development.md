# Local development

## Requirements

- Node.js 22 LTS (see `.nvmrc`).
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

The server checks these when it starts. If one is missing or invalid, it logs the variable's name and answers every request with an error until the configuration is fixed. Values are never printed.

## Checks (the same commands CI will run)

| Check                     | Command                                      |
| ------------------------- | -------------------------------------------- |
| Install from the lockfile | `pnpm install --frozen-lockfile`             |
| Formatting                | `pnpm format:check` (fix with `pnpm format`) |
| Lint (warnings fail)      | `pnpm lint`                                  |
| Type check                | `pnpm typecheck`                             |
| Unit and component tests  | `pnpm test`                                  |
| Production build          | `pnpm build`                                 |
| Browser smoke tests       | `pnpm test:e2e` (builds the web app first)   |

Prettier never checks or rewrites `docs/product/` (the read-only product specification), `CLAUDE.md`, `architecture.md` or `docs/design/`; see `.prettierignore`.
