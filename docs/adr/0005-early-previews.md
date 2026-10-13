# ADR 0005: Vercel previews from S04b, before the release stage

- **Status:** Accepted (owner decision, Ward, 13 October 2026). Changes the phasing in `CLAUDE.md` (Delivery) and `architecture.md` §26 and §30; staging and production phasing are unchanged.
- **Date:** 2026-10-13
- **Step:** S04b, Vercel preview deployments

## Context

`architecture.md` §26 approved local development, PR previews, staging and production, but the solo bootstrap phasing put PR previews and staging at the release stage. The owner wants to see each change in a browser much earlier. The app has no sign-in or stored data yet, so a preview needs no database or secrets.

Checked on 13 October 2026 (vercel.com/docs): the Hobby plan is free, needs no card and has no billing cycle; going over a limit pauses the feature instead of charging. Vercel Authentication on previews is included. A private repository under a personal GitHub account can deploy on Hobby. Hobby allows non-commercial personal use only.

## Decision

- **Vercel Hobby project** with Root Directory `apps/web`, connected through the Vercel GitHub app. Every pull request and every push to a branch other than `production` gets a preview; `main` therefore always has a preview of the latest merged code.
- **Access:** Standard Protection with Vercel Authentication, so only the owner, signed in to Vercel, can open a preview. Previews carry synthetic data only and no credentials.
- **No production yet:** Vercel's production branch is `production` (ADR 0002). `apps/web/vercel.json` switches off Git deployments of `production` and skips any build whose `VERCEL_ENV` is `production`, so nothing deploys to production until the release step (S49) removes both.
- **Configuration:** on a preview only (`VERCEL_ENV=preview`), `@madeora/config/env/vercel` fills a missing `APP_ENV` with `preview` and a missing `NEXT_PUBLIC_APP_URL` with the deployment's branch URL. Set values are never replaced, and production gets no default, so it still fails closed (§20). pnpm comes from the `packageManager` field through Corepack (`ENABLE_EXPERIMENTAL_COREPACK=1` in the Vercel project).
- **Not a merge gate:** the preview is informational. CI stays the required check; preview smoke tests need a protection-bypass secret and are a later step.

## Consequences

- From S05 on, every PR has a browser link for the owner.
- When sign-in lands (S06), previews need a database. The default then is a separate free Supabase project used only by previews, with synthetic seed data; Supabase's per-PR branching is paid and not used. Decided in S06.
- Before release, the owner decides whether Madeora is commercial. If it is, Hobby no longer fits and hosting needs Vercel Pro (paid, owner approval) or another host.
