# S06 · Adult email/password accounts — feature brief

**Branch:** `feat/email-password-accounts` from `main` @ e40d262 (S00–S05 and S04b merged).
**Sources:** build-plan S06 and its "Done when"; PS "Confirmed adult email/password and Apple/Google sign-in" (secure reset, email verification, brute-force/rate-limit protection, session management, no account enumeration), "Confirmed routine adult password changes and session revocation" (the **stricter recovery path**: a reset revokes every session including the one that started it and requires a fresh sign-in; one-time expiring reset tokens; no enumeration; fail closed if revocation fails), "Home-independent adult account onboarding" (register, verify, land in Personal with zero Homes; no Home is created); ARCH §7 (strategy A), §9 (TanStack Query, cache cleared on identity change), §13 (React Hook Form + Zod), §20 (config), §21, §24, §26; CLAUDE.md authentication A, data fetching B, forms A, €0 rule; ADR 0005 (previews).

## Actors and permissions

- **Signed-out visitor:** can open sign-in, sign-up, forgot-password, the email-confirm link and the password-reset link. Nothing else.
- **Signed-in adult:** can open the app shell (`(app)` routes) and sign out. Identity is global; there are no Homes, roles or app tables yet (S09), so no RLS policy is added in this step.
- **Someone finishing a reset** (opened a reset link): the reset session lives only in the reset page's memory, never in cookies, so it can only be used to choose a new password and never counts as signed in. (Changed during the build: Supabase marks reset-link and confirmation-link sessions identically, so the server could not tell them apart.)

## Scope

1. **Supabase clients** (`@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.x): one browser factory, one server factory (`server-only`), one for the proxy. Settings come from two new public values, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, validated in `packages/config`. The key check refuses anything that looks like a secret (`sb_secret_…`, or a legacy JWT whose role is `service_role`), so a privileged key can never be bundled.
2. **Where credentials go:** sign-up, sign-in, resend, reset request, email confirmation and setting a new password are sent **from the browser straight to Supabase Auth**. Supabase rate-limits these per client IP; sending them through the Next.js server would put every user in the server's single rate-limit bucket (Supabase only accepts a forwarded client IP with a secret key, which previews must not hold).
3. **Server-side identity:** `getVerifiedIdentity()` (per request, React `cache`) reads the session from cookies and asks Supabase Auth to confirm the access token (`auth.getUser(token)`), which also rejects tokens whose session was revoked. It never trusts the unverified cookie user.
4. **Proxy** (`src/proxy.ts`, Next 16's renamed middleware): refreshes the session cookies per the `@supabase/ssr` guidance and marks every page response `Cache-Control: private, no-store`, so no shared cache can serve one person's page to another.
5. **Route guard:** `(app)` layout requires a confirmed identity; signed-out visitors go to `/sign-in?next=<path>` (only same-site relative paths are accepted as `next`). Signed-in people opening sign-in or sign-up go to the dashboard.
6. **Pages** (new `(auth)` route group, a centred card without the shell, all text in `en` and `nl`, React Hook Form + Zod, Madeora components, accessible errors with focus on the first invalid field):
   - `/sign-up`: email + password (show/hide toggle). Afterwards always "check your email", whether or not the address already has an account.
   - `/auth/confirm?token_hash=…`: a **Confirm my email** button, so mail scanners that open links cannot use up the one-time token. Success signs the person in and opens the dashboard. Expired or used link: a resend form with the same neutral answer.
   - `/sign-in`: generic "email or password is incorrect"; an unconfirmed account is offered a resend; HTTP 429 shows "too many attempts, try again later".
   - `/forgot-password`: always the same neutral answer.
   - `/reset-password?token_hash=…`: choose a new password. The token is only used when the form is submitted (again safe from link scanners). Then: set the password, **sign out every session for that account (scope global)**, and show the sign-in page with "password changed, sign in again". If the global sign-out fails, the page says so and offers a retry; it never reports success.
   - **Sign out** in the shell: a POST form to `/auth/sign-out` (Route Handler) that ends this session at Supabase and clears the cookies, then redirects to `/sign-in`.
7. **CSRF:** `/auth/sign-out` and every future cookie-authenticated mutation use `assertSameOrigin()`: the `Origin` header must equal the app's own origin (or, without `Origin`, `Sec-Fetch-Site: same-origin`); otherwise 403 and nothing changes. Auth calls that go to Supabase directly carry the session in a header, not a cookie, so they are not CSRF targets.
8. **Client caches:** TanStack Query (`@tanstack/react-query`) provider added now, with an `AuthSync` client component that clears the whole query cache when the user signs out, when the signed-in user changes, and when another tab signs out (`BroadcastChannel`, announced by the sign-in page after sign-out, once the cookies are gone); it then refreshes the page so the server re-checks access. Sign-up, resend and reset requests use a memory-only Supabase client, so they leave no cookies behind.
9. **Password rules** (server-enforced by Supabase Auth, mirrored in Zod for messages): at least 12 characters, at most 72 (bcrypt's limit), no composition rules, not equal to the email address. Supabase's leaked-password check is paid and not used.
10. **Emails:** confirmation and reset templates in `supabase/templates/` use `token_hash` links back to the configured app address (`NEXT_PUBLIC_APP_URL`, a preview's branch address), so Supabase's allow-list holds exact addresses; confirmation links are verified as type `signup` (review H1). English only for now; localized emails arrive with Resend (S10).
11. **Local stack and CI:** `supabase/config.toml` turns on email confirmation, minimum length 12, the two templates, redirect URLs for `http://127.0.0.1:3100` and `http://localhost:3000`, and higher local rate limits so the test suite does not trip them. The E2E job starts Supabase (auth, database, gateway, mail catcher), passes its URL and publishable key to the app, and Playwright reads verification and reset emails from the mail catcher.
12. **In-container E2E fallback** (`pnpm test:e2e:fallback`): for machines without Docker, like Claude's threads (build-plan D4). Starts a throwaway PostgreSQL, Supabase Auth (GoTrue) and Mailpit from locally built binaries, plus a small gateway for `/auth/v1`, then runs the same Playwright suite. CI on the real Supabase stack stays the binding check.
13. **Previews get a database:** a separate free Supabase project used only by previews (`madeora-preview`, EU region, synthetic data only). Owner guide `docs/supabase-preview-setup.md` with exact clicks and values, ADR 0007, cost-register update. Schema follows `main`; the first step that adds app tables also adds the step that applies migrations to it.
14. **Guide fix** (from S04b): `docs/vercel-setup.md` step 2 says the first import deploy is **canceled** by the Ignored Build Step, not failed.
15. **Existing browser tests** sign in first (one verified user created in Playwright global setup), since every `(app)` page now needs an account.

## Out of scope

Display name, language and timezone stored on the account (S07), Google sign-in (S08), Homes (S09), password change while signed in, email change, 2FA, recovery codes, device/session list, security notifications and activity history (S37/S38), localized emails and Resend (S10), CAPTCHA (see decision below), applying migrations to the preview project (first step with app tables).

## Defaults picked (owner may override)

- **Brute-force protection:** Supabase Auth's built-in per-IP rate limits only. Turnstile CAPTCHA (free, approved stack) is the stronger option; it needs a Cloudflare account, so it is put to Ward as a decision rather than assumed.
- **Password policy:** 12–72 characters, nothing else required (NIST-style length over composition).
- **Preview database:** one free Supabase project shared by all previews, as ADR 0005 proposed; the second free project slot stays open for staging later.
- **Local developer accounts:** register through the local mail catcher (http://127.0.0.1:54324). Seed users keep no password.
- **No server actions for auth:** browser-direct calls (rate limiting, see 2) and one Route Handler for sign-out.

## Known limits recorded for later

- A revoked session's access token still works against the Supabase Data API until it expires (up to 1 hour); Madeora's own server rejects it at once. S09, which adds the first app tables, decides whether RLS also checks the session.
- Supabase's built-in email sender (previews) only delivers to members of the Supabase team and at most 2 emails an hour. Fine for Ward testing previews; real delivery needs Resend (S10).
- Server-side token refreshes share the server's rate-limit bucket (150 per 5 minutes); browsers normally refresh themselves first. Re-check before release (S49).

## Acceptance tests

1. Playwright: register → confirmation email arrives in the mail catcher → confirm → dashboard with the Personal context; sign out → sign in again → dashboard.
2. Playwright: forgot password → reset email → new password → every other signed-in browser for that account is signed out on its next request, the resetting browser must sign in again, the old password fails and the new one works.
3. Playwright: signed-out visit to an app page redirects to sign-in and back to that page after signing in; `next=//evil.example` is ignored.
4. Playwright: session **refresh** (stored session marked expired → proxy refreshes it, a new refresh token is issued, and the page loads), **expiry** (expired session with an unusable refresh token → sign-in page), forged access token → sign-in page.
5. Playwright: **CSRF** — a POST to `/auth/sign-out` with a foreign `Origin` (and with none) gets 403 and the session still works; a same-origin sign-out works.
6. Playwright: two tabs; signing out in one clears the other; the TanStack Query cache clearing is covered by `AuthSync` unit tests (no test hook in the app).
7. Playwright: an unfinished reset (link used, new password refused) leaves the browser signed out and can still be finished on the same page.
   7b. Playwright: no account enumeration — sign-up with an existing address and forgot-password with an unknown address give the same screen as the normal case; sign-in errors are generic; a 429 from Supabase shows the "too many attempts" message.
8. Playwright: authenticated responses carry `Cache-Control: private, no-store`; axe has no violations on every auth page in both themes; every test fails on console or hydration errors.
9. Unit: env schema (URL, key, secret-looking keys refused), safe `next` redirects, same-origin check, password and email schemas, sign-out route (CSRF 403, relative redirect), reset form (sign-out-everywhere failure and retry), `AuthSync` cache clearing, form error messages in both languages.
10. Format, lint, typecheck, unit tests, build, boundary build, database tests (fallback here, real stack in CI) and E2E all pass.
