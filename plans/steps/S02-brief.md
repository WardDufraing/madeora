# S02 · CI and repository guards — feature brief

**Branch:** `chore/ci-repository-guards` from `main` @ 1078629 (S01 merged).
**Sources:** build-plan S02; CLAUDE.md (CI/CD requirements, Git and repository protection, code quality B, testing A, €0 budget); architecture.md §26, §27, §29, §30; S00 review L3 and carry-over 2; S01 review L2 and risks 2–3.

## Scope

- `.github/workflows/ci.yml` on PRs into and pushes to `main` and `production`: least-privilege token, concurrency cancel for PRs, actions pinned to commit SHAs, no secrets.
- Jobs: Spec guard, Secret scan (gitleaks CLI), Dependency audit (pnpm audit + time-limited exceptions), Format/lint/typecheck/unit tests/build, E2E smoke, Release source (PRs into `production` must come from `main`).
- `tools/repo-checks` workspace: spec guard (path diff + pinned sha256 + Git attributes, closes S00 L3) and audit evaluator, both tested.
- CODEOWNERS (incl. `.gitattributes`), PR template with the CLAUDE.md checklist.
- `docs/adr/0002-branch-model.md`, `architecture.md` §26/§30 release wording (owner-approved change named in the plan), README, development guide, cost register row for GitHub Actions.
- `docs/github-setup.md`: click-by-click owner steps for both branches.
- `production` branch from seed commit 33e0576, pushed only after Ward's yes.

## Out of scope

Supabase/RLS CI job (S03), Vercel previews and deploy workflows (release stage), Dependabot PRs.

## Findings that shape the step

- Repo is private on GitHub Free: rulesets/branch protection unavailable (docs.github.com, 13 Oct). Decision card posted to Ward; default = stay private, CI unenforced, setup steps ready.
- GitHub secret scanning not free on private repos → gitleaks CLI.
- `braces` GHSA-vfj7-8cjw-p6xm: exception until 2026-12-31 (dev-only lint path, no fix).

## Acceptance tests

1. Fresh clone: install, format, lint, typecheck, test, build, e2e, check:spec, audit:deps pass; actionlint clean.
2. Spec guard fails on content edit, CRLF conversion, delete, rename, added file, nested or root `.gitattributes` change; passes on unrelated change.
3. Audit fails on unexcepted high/critical, expired exception, >90-day exception; passes with valid exception.
4. After push: CI runs all jobs on the PR; a throwaway PR editing a spec file fails Spec guard (needs Ward's yes).
