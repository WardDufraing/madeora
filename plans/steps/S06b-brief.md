# S06b · Early production — feature brief

**Why:** Ward wants to deploy to production now and then to share progress (S06 thread, 14 Oct 2026). Until now ADR 0005, `CLAUDE.md` (Delivery) and `architecture.md` §26/§30 kept production builds switched off until the release step (S49). Changing that is an owner-approved rule change, so it is its own step and PR.
**Branch:** `chore/early-production` from `main` at 9980eae (S06, PR #8, merged).
**Depends on:** S04b, S06 (merged).

## Facts checked (14 Oct 2026)

- **Supabase Auth CAPTCHA** (source at the pinned CLI's Auth commit 4eee58f): when enabled, `/signup`, `/token` with `grant_type=password`, `/recover`, `/resend`, `/otp` and `/magiclink` need a `captcha_token`; refresh, PKCE and `/verify` do not. A missing or failed token is `400 captcha_failed`. `signup_disabled` (422) is returned before anything about the address is looked at, so it reveals nothing.
- **Cloudflare Turnstile free plan:** up to 20 widgets, 10 hostnames per widget, unlimited challenges, free; Enterprise is contact-sales only. (developers.cloudflare.com/turnstile/plans, via search; the page itself was unreachable from the build container.)
- **Vercel Standard Protection:** previews and generated deployment URLs need a Vercel login; the up-to-date production domain stays public. Hobby is free, non-commercial only.
- **Supabase Free:** 2 active projects. `madeora-preview` uses one, `madeora-production` takes the second, so staging later needs a paused project or a plan decision.

## Scope

1. **Vercel:** `apps/web/vercel.json` stops blocking production; it still skips any production build that is not from the `production` branch. Production deploys only when Ward merges a release PR from `main` into `production`.
2. **Turnstile in the app:** an optional public `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. When set, sign-in, sign-up, forgot-password and resend show the Turnstile widget, keep submit disabled until it has a token, send it as `captchaToken`, and reset the widget after every attempt (tokens are single-use). When unset (local, CI, previews), nothing changes. Production fails closed: a production build or start without the key stops and names the variable.
3. **Errors:** `captcha_failed` gets its own message; `signup_disabled` gets "new accounts can't be created here yet".
4. **Owner guide** `docs/production-setup.md`: Turnstile widget, `madeora-production` Supabase project (auth settings, CAPTCHA, SMTP through Resend, templates, sign-up on/off, demo accounts), Vercel production variables, first release PR, checks, rollback.
5. **Docs as owner-approved rule change:** ADR 0008, ADR 0005 status note, `CLAUDE.md` Delivery line, `architecture.md` §26 and §30, `docs/github-setup.md` section D, `docs/vercel-setup.md`, cost register (Vercel, Supabase, Cloudflare Turnstile rows), `.env.example`.
6. **Project files:** build plan gets S06b; S49 wording updated.

## Defaults picked (open to Ward)

- **Production sign-up closed until S10** (decision card posted). Ward creates demo accounts in the Supabase dashboard. Turnstile stays on for sign-in, reset and resend.
- **Demo data only:** no real household data in production before S49 decides backups and privacy (`architecture.md` §25).
- **Turnstile on previews:** off (no key). Ward can add a preview widget later.

## Out of scope

Custom domain, staging, monitoring, backups, real email delivery (S10), database migrations to hosted projects (first table step), Vercel production approvals beyond the GitHub release PR.

## Done when

1. After Ward's release PR from `main` into `production`, Vercel builds production; the production address opens in a signed-out browser, while previews still ask for a Vercel login.
2. On production, a demo account signs in after passing Turnstile; sign-up (if closed) says so; a request without a token is refused by Supabase.
3. A production build without the Turnstile key fails, naming the variable; local, CI and previews work without it and show no widget.
4. Unit tests cover the widget, the forms' token handling and the new errors; the existing E2E suite stays green.
5. Format, lint, typecheck, unit tests, build pass; independent review PASS on the final diff.
