# ADR 0008: Early production deploys with Turnstile

- **Status:** Accepted (owner decision, Ward, 14 October 2026). Changes the "no production before the release step" part of ADR 0005, the Delivery line in `CLAUDE.md` and `architecture.md` §26 and §30. Staging, backups and the release-readiness work of S49 are unchanged.
- **Date:** 2026-10-14
- **Step:** S06b, early production

## Context

ADR 0005 kept production builds switched off until the release step (S49). The owner wants to deploy now and then to show progress to other people. Previews cannot do that: they sit behind Vercel Authentication, so only the owner can open them. Since S06 the app has adult accounts, so a public address also needs bot protection: ADR 0007 left Cloudflare Turnstile as an open choice ("before release"), and the S06 review (L4) said it must be closed before release.

Checked on 14 October 2026:

- **Supabase Auth** (source at the Auth commit the pinned CLI runs, 4eee58f): with CAPTCHA protection on, `/signup`, `/token` with `grant_type=password`, `/recover`, `/resend`, `/otp` and `/magiclink` refuse a request without a valid `captcha_token` (`400 captcha_failed`). Token refresh, PKCE and `/verify` are not checked. A disabled sign-up answers `422 signup_disabled` before it looks at the request, so that answer is the same for every address.
- **Cloudflare Turnstile Free:** up to 20 widgets, 10 hostnames per widget, unlimited challenges, no charge (developers.cloudflare.com/turnstile/plans).
- **Vercel Standard Protection:** previews and generated deployment URLs require a Vercel login; the current production domain is public. Hobby stays free and is for non-commercial use only.
- **Supabase Free:** 2 active projects per organization; `madeora-preview` holds one.

## Decision

- **Production deploys from the `production` branch only,** as ADR 0002 already says. `apps/web/vercel.json` no longer switches production off; its Ignored Build Step now skips any production build whose Git branch is not `production` (including deploys without Git), and a repository test checks that rule. A release is still the owner's pull request from `main` into `production` (`docs/github-setup.md` section D).
- **Production is public** at its Vercel production domain. Previews stay behind Vercel Authentication.
- **A separate free Supabase project, `madeora-production`** (EU, Frankfurt), used only by production. Production gets its public URL and publishable key, never a secret key, and its own Resend API key for SMTP. Owner guide: `docs/production-setup.md`.
- **Demo data only.** Until S49 decides backups, recovery and the privacy position (`architecture.md` §25), production holds the owner's own and demo accounts, never real household data.
- **Sign-up closed on production until S10** (default; the owner can switch it on with one Supabase setting). Until S10 production email reaches only the owner's own address, so anyone else who signs up would wait for a confirmation that never arrives, and their address would be stored before the privacy position is settled. The owner creates demo accounts in the Supabase dashboard. The sign-up page answers "New accounts can't be created here yet."
- **Cloudflare Turnstile through Supabase Auth's CAPTCHA protection.** The public site key is `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; the secret key lives only in Supabase's CAPTCHA settings, never in Vercel or the repository. When the site key is set, the sign-in, sign-up, reset-request and resend forms render the Turnstile widget (explicit rendering, the page's language and theme), keep their submit button disabled until it yields a token, pass it as `captchaToken`, and reset the widget after every request because tokens are single-use. Without the key (local, CI, previews) nothing changes.
- **Production fails closed:** a production build (`VERCEL_ENV=production` or `APP_ENV=production`) and a server started with `APP_ENV=production` stop without a valid site key, naming the variable. A value shaped like a Turnstile secret key is refused, so it cannot be bundled into browser code.

## Consequences

- Closes the CAPTCHA choice in ADR 0007 and S06 review finding L4 for production. Previews stay without CAPTCHA (owner-only access); the owner can add a preview widget later with the same variable.
- Supabase only checks a token where CAPTCHA protection is on, so the protection depends on that project setting as well as on the app; the owner guide checks it with a request that has no token.
- Turnstile loads a script from `challenges.cloudflare.com`. The app sets no Content Security Policy yet; when one is added, it must allow that script and frame.
- Cloudflare sees the visitor's IP address and browser signals during the check. The privacy notice (before release) must name Cloudflare as a processor.
- The S06 E2E suite runs without CAPTCHA. The forms' token handling is covered by unit tests with a stand-in widget; the real widget is checked on production with the owner guide.
- Both free Supabase project slots are now used. Staging (S49) needs one of them paused, or a paid plan; decided then.
- A free Supabase project pauses after a week without use; production then shows errors until the owner restores it. Fine for occasional demos, not for real users.
- Schema changes do not reach hosted projects yet. The first step that adds app tables also adds the way migrations reach `madeora-preview` and `madeora-production`.
- Rollback: Vercel's Instant Rollback returns production to the previous production deployment; the next release PR then brings `production` back in line.
