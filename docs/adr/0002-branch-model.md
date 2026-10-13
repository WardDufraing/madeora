# ADR 0002: Branch model — `main` for integration, `production` for releases

- **Status:** Accepted (owner decision, Ward, 13 October 2026; recorded in `plans/build-plan.md` §1)
- **Date:** 2026-10-13
- **Step:** S02, CI and repository guards

## Context

`architecture.md` §26 and §30 originally described production deploying after a merge to protected `main`. The owner decided on 13 October 2026 that production runs from a separate long-lived branch, so that merging a feature never changes what users run, and every release is an explicit, reviewable step.

## Decision

- **`main`** is the integration branch. Every feature, fix, refactor, chore and documentation branch (`feat/…`, `fix/…`, `refactor/…`, `chore/…`, `docs/…`, `test/…`) opens a pull request into `main`. Nothing is pushed to `main` directly.
- **`production`** is the release branch. It is created from `main`'s seed commit (`33e0576`), pushed only after the owner's consent. It changes only through a **release pull request from `main` into `production`**, which the owner approves and merges. Feature branches never target `production`.
- **Production deploys come only from `production`.** No other branch, and no merge into `main`, deploys to production. Vercel previews and staging (release stage, `architecture.md` §26) deploy from pull requests and `main`, never from `production`.
- **Hotfixes** also go through `main`: fix on a `fix/…` branch, merge into `main`, then a release pull request into `production`. A hotfix may use an expedited, documented review, but it never bypasses CI or the owner's approval.
- **CI** (`.github/workflows/ci.yml`) runs every check on pull requests into both branches and on pushes to both. The `Release source` check (`.github/workflows/release-source.yml`) fails any pull request into `production` whose head branch is not `main` of this repository, and re-runs when a pull request's target branch changes. `Spec guard (trusted)` (`.github/workflows/spec-guard-trusted.yml`) re-checks every pull request with the target branch's copy of the spec guard.
- **Merges** into `main` and `production` use merge commits (no squash or rebase rewriting of `production` history), so `production` always contains exactly the `main` commits that were released.

## Enforcement

GitHub branch protection and rulesets are not available for private repositories on GitHub Free. While the repository is private on the free plan, CI reports every check on every pull request, but GitHub cannot block a direct push or a merge with red checks; the rules above are followed by process (only the owner merges, Claude never pushes to `main` or `production`). `docs/github-setup.md` lists the exact ruleset settings to switch on for both branches as soon as the repository is public or on a plan that includes them.

## Consequences

- A merged feature is not live until the next release pull request. Releases are deliberate and reviewable as one diff.
- `production` can lag `main`. The release pull request shows exactly what will ship.
- Deployment wiring (S49, release readiness) must target the `production` branch only.
