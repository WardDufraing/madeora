# S04b · Vercel preview deployments — feature brief (draft, waiting for Ward's yes)

**Why:** Ward wants to see the app in a browser on every PR, much earlier than the release stage (thread "previews", 13 Oct 2026). Until now `CLAUDE.md`, `architecture.md` §26/§30 and build-plan S49 put Vercel previews at release time.
**Branch:** `chore/vercel-previews` from latest `main` (S04 merged, 9ab3d92).
**Depends on:** S01, S02 (merged). Runs before S05.

## Checked on 13 Oct 2026 (vercel.com/docs)

- **Hobby plan is free, no card, no billing cycle.** Going over a limit pauses the feature for up to 30 days; it never charges. Limits that matter: 100 deployments/day, 2 build vCPUs, 1 hour of runtime logs.
- **Hobby is for non-commercial personal use only.** "Commercial" means a deployment used for anyone's financial gain (payments, ads, selling a product). Unreleased previews with synthetic data and no customers are fine now; a paid or ad-supported public Madeora would need Pro (USD 20/month) or another host. Logged for S49.
- **Private repo works** because `WardDufraing/madeora` is under a personal account (organisation-owned private repos need Pro).
- **Preview protection is free:** "Vercel Authentication" with "Standard Protection" means only Ward, signed in to Vercel, can open preview URLs. Password protection is paid and not used.

## Scope

1. Vercel project setup, done by Ward with a click-by-click guide (`docs/vercel-setup.md`): Hobby account via GitHub, import repo, Root Directory `apps/web`, pnpm install from the repo root, **Production Branch = `production`**, Standard Protection with Vercel Authentication, preview env vars (`APP_ENV=preview`), no secrets.
2. App config: previews get `NEXT_PUBLIC_APP_URL` from Vercel's own branch URL only when `VERCEL_ENV=preview`; production never guesses it (fails closed, `architecture.md` §20). Tests for both.
3. Skip production builds until S49 (`ignoreCommand`), so nothing deploys to production by accident. Docs-only PRs may also be skipped.
4. Docs, as the owner-approved change: `CLAUDE.md` Delivery line, `architecture.md` §26 phasing and §30 item 7 (previews from S04b; staging still at release), `docs/adr/0005-early-previews.md`, `docs/provider-cost-register.md` Vercel row, `docs/development.md`.
5. Project files: `plans/build-plan.md` gets S04b and the "previews only at release" note changes.

## Database for previews

Nothing needs one yet: the app has no sign-in or stored data. Previews start with **no Supabase at all**. When S06 (sign-in) lands, previews need a database; the recommended default then is a separate free Supabase project used only by previews, with synthetic seed data (free plan allows 2 active projects; free projects pause after a week idle). Supabase's own per-PR "branching" is paid and not used. Decided in S06, not now.

## Out of scope

Staging, production deploys, custom domain, CI smoke tests against previews (needs a protection-bypass secret; can follow later), any Supabase/R2/Resend credentials in Vercel.

## Done when

1. A PR into `main` gets a Vercel preview link on GitHub, the page loads for Ward signed in to Vercel, and a signed-out browser is refused.
2. A merge into `main` updates the `main` branch preview; no production deployment succeeds (the expected failed first import deploy aside).
3. Local checks (format, lint, typecheck, tests, build, e2e) pass; CI green.
4. Cost register has the verified Vercel row; no card was entered.
5. Independent review PASS on the final diff.
