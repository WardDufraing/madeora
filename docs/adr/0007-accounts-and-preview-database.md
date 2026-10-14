# ADR 0007: Adult email/password accounts and the preview database

- **Status:** Accepted for S06 (build-plan defaults where the owner has not chosen; see "Open owner choices").
- **Date:** 2026-10-14
- **Step:** S06, adult email/password accounts

## Context

The product specification requires adult email/password accounts with email verification, a secure reset that signs out every session, brute-force protection, session management and no account enumeration. `architecture.md` §7 and `CLAUDE.md` fix the approach: Supabase Auth with `@supabase/ssr`, identity confirmed on the server, CSRF protection for cookie-authenticated mutations, no cross-user caching, and client caches cleared on identity changes. Since S04b every pull request has a Vercel preview (ADR 0005), and previews now need somewhere to create accounts.

Facts checked on 2026-10-13 (supabase.com/pricing, Supabase Auth docs and the Supabase Auth source at the version the pinned CLI runs): the Free plan allows 2 active projects, pauses a project after a week without use, and needs no card; the built-in email sender only delivers to organization members, at most 2 emails an hour; leaked-password protection is paid; Supabase Auth rate-limits sign-in, sign-up, verification and token refresh per client IP, and only accepts a forwarded client IP from callers holding a secret key.

## Decision

**Credentials go from the browser straight to Supabase Auth** (sign-up, sign-in, resend, reset request, confirming an email, choosing a new password). Sent through the Next.js server, every visitor would share the server's single rate-limit bucket, and passing the real IP needs a secret key that previews must not hold. Only one cookie-authenticated mutation exists: `POST /auth/sign-out`, a Route Handler.

**Three kinds of browser client** (`apps/web/src/auth/supabase-browser.ts`):

- The cookie client (`@supabase/ssr`) for sign-in and email confirmation, the only flows that should leave the browser signed in.
- A memory-only client for sign-up, resend and reset requests, which never sign anyone in and so leave no cookies behind.
- A separate memory-only client for the password reset. Supabase marks a session opened from a reset link exactly like one opened from a confirmation link (`amr: otp`), so the server cannot tell a half-finished reset from a sign-in. Keeping the reset session in the page's memory means an unfinished reset never counts as signed in anywhere. Saving the new password makes Supabase Auth sign out every other session of the account in the same transaction (it does this for every password change made from a session; the E2E suite re-checks it on each Supabase upgrade). The page then also ends the reset session (`scope: global`); if that fails it says so and offers a retry, and never reports success.

**Server identity** (`identity.ts`): read the session from the cookies, then ask Supabase Auth to confirm the access token (`auth.getUser(token)`), which also rejects a revoked session. The cookie's user object is never trusted; an unconfirmed email does not count as signed in. Every `(app)` page calls `requireIdentity()`, because a layout is not rendered again on client navigation.

**Proxy** (`src/proxy.ts`, Next.js 16's renamed middleware): refreshes an expiring session as `@supabase/ssr` requires, and marks every response `Cache-Control: private, no-store`.

**CSRF** (`same-origin.ts`): a mutation is accepted only when `Origin` is the configured app origin or the host the request was sent to (a Vercel preview's own address); without `Origin`, only `Sec-Fetch-Site: same-origin` is accepted; `Origin: null` is refused. The sign-out redirect is relative, so the browser stays on the origin it used.

**Client caches:** a TanStack Query provider wraps the app. `AuthSync` empties the whole query cache and re-checks access when this tab signs out, when another account appears, and when another tab signs out (`BroadcastChannel`, announced by the sign-in page after a sign-out, when the cookies are already gone).

**Passwords:** 12 to 72 bytes (bcrypt's limit), no composition rules, not equal to the email address. Supabase enforces the minimum on the server; Zod mirrors the rules for messages.

**Emails** link to the app with a one-time `token_hash`. The return address is always `NEXT_PUBLIC_APP_URL` (on a preview, its branch address), never the address the browser is on, so Supabase's allow-list holds exact addresses. A wildcard such as `madeora-*-<scope>.vercel.app` is not used: any Vercel user could create a project matching it and receive reset links. Confirmation links are checked as type `signup`, which only accepts confirmation tokens; type `email` would also accept a password-reset token and turn a reset link into a plain sign-in. Pages use a token only when a button is pressed, so link scanners cannot use it up. English only until Resend (S10).

**Preview database:** one free Supabase project, `madeora-preview` (EU, Frankfurt), used only by Vercel previews and holding synthetic accounts only. Previews get its URL and publishable key, both public; never a secret key. The schema follows `main`: the first step that adds app tables also adds the way migrations reach this project. Owner guide: `docs/supabase-preview-setup.md`. The second free project slot stays open for staging later.

**Tests:** CI's E2E job starts the real local Supabase stack (database, Auth, gateway, mail catcher) and Playwright reads confirmation and reset emails from the mail catcher. Where Docker cannot run (Claude's build containers, build-plan D4), `pnpm test:e2e:fallback` builds Supabase Auth and Mailpit from source at the versions the pinned CLI uses and runs the same suite; CI stays the binding check.

## Consequences

- Brute-force protection is Supabase's per-IP rate limiting only, until Turnstile is added.
- A revoked session's access token still works against the Supabase Data API until it expires (up to one hour); Madeora's own server rejects it at once. S09, which adds the first tables, decides whether RLS also checks the session.
- Server-side token refreshes share the server's rate-limit bucket; browsers normally refresh first. Re-check before release (S49).
- Reloading the reset page after using its link loses the reset; the person asks for a new link.
- If Supabase Auth refuses a return address (not on the allow-list), the link falls back to the Site URL and opens the dashboard instead; the guide lists each branch address explicitly.
- A Server Component can refresh an expired session it cannot save (cookies are read-only there) if the proxy's refresh failed moments earlier; the browser may then be signed out by refresh-token reuse detection. Rare; revisit if it shows up.
- If Supabase Auth is unreachable during sign-out, this browser's session cookies are still deleted, but the session itself expires on its own instead of being ended at once.
- One-time token hashes appear in page addresses, so they can reach request logs and browser history; they are single-use and expire.
- Supabase only allows custom email templates with custom SMTP, so the preview project sends through Resend's free SMTP (owner decision, 2026-10-14). Without a domain, Resend sends only from `onboarding@resend.dev` to the owner's own address. The Resend API key lives only in Supabase's SMTP settings. The app's own Resend integration is still S10.
- Local developers register through the local mail catcher (http://127.0.0.1:54324); seed users have no password.

## Open owner choices

- **CAPTCHA:** Cloudflare Turnstile (free, approved stack) now or before release. Default: before release.
- **Hosted development project:** not used (owner, 2026-10-14: "previews only"). The local stack, or the fallback, stays the development database.
- **Early production:** the owner wants to deploy to production occasionally to share progress. That changes ADR 0005 (no production before the release step), so it is a separate step and pull request after S06, with its own Supabase project and owner guide.
