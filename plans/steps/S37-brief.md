# S37 · Adult security — feature brief

**Branch:** `feat/adult-security` (from `main` at 0763e97, S36 merged).
**Model:** Opus (auth, sessions, RLS-adjacent enforcement; standing model rule).
**Sources (read only these ranges):** build plan S37; PS L371–L390 (sessions, optional 2FA), L537–L610 (trusted devices, notifications, password change, email change, sign-in methods, backup recovery); ARCH §7; ADR 0010 (S08 must gain an `aal2` check in S37); S08 brief.

## Scope (Ward, 2026-11-06: one S37 step)

Everything in one PR: 2FA with its recovery codes, password and email change, sessions, request enforcement (part one), plus trusted devices, verified backup email, account recovery codes with the recovery flow, and Google re-authentication with "set a password" (part two). Ward's decisions: a TOTP recovery code removes the authenticator at once, with emails; losing password and mailbox needs the backup email link plus one account recovery code, then a 72-hour wait with notices to both addresses, then the backup email becomes the primary.

## Part two design

- **Re-authentication:** the first factor is a fresh sign-in in a separate client: password (memory client) or Google (redirect with a sessionStorage client, callback `/auth/reauthenticate`). The second factor, when 2FA is on, is verified on the browser's own session (it becomes aal2 with a fresh TOTP claim), so Supabase Auth also accepts the following change from that session. The database checks both before giving a permission.
- **Trusted devices:** offered (unticked) after a successful code on the 2FA page; 30 days, never renewed; at most 10 per account; a random token in an httpOnly cookie per account, only its hash stored. At the next sign-in on that browser the 2FA page redeems it (same browser and platform as recorded) and the session counts as past the second factor; nothing sensitive is exempt (changes still need a fresh code). Trust ends on password, email or 2FA change, recovery-code use, account recovery, reported session, sign out everywhere, or "Revoke trust" / "Revoke all".
- **Backup email:** add, change or remove after re-authentication; a single-use link (1 hour) to the new address; the old one stays until then; the primary address is told. Must differ from the primary address; one account per backup address.
- **Account recovery codes:** 10 codes of 16 characters (distinct from the 12-character 2FA codes), shown once, hashes only, regenerating replaces the set.
- **Recovery (lost password and mailbox):** "Can't access your email?" on sign-in → enter the account email → if there is a verified backup address, a link goes there (same answer either way) → one account recovery code (5 tries per 15 minutes) and optionally "I've also lost my authenticator" → 72-hour wait, notices to both addresses and in the app, the owner can cancel from Security → link to the backup address → the backup address becomes the primary, every session ends, trust and recovery codes are reset (and the authenticator removed if asked) → reset the password through the normal reset email.

## What Supabase Auth gives (checked in the pinned GoTrue source, commit 4eee58f)

- TOTP MFA: enroll / challenge / verify, ±30 s drift (`Skew: 1`), session becomes `aal2`. Free on every plan (phone MFA is the paid add-on; stays off). Supabase blocks password and email updates on an `aal1` session of an account with 2FA.
- A password update logs out **every other session** of the account (`LogoutAllExceptMe`) — the spec's routine-change rule.
- Security emails it can send itself: password changed, email changed (to the **old** address), MFA factor added/removed (same mechanism as S08's identity linked/unlinked).
- Failed TOTP attempts are only limited per IP; a challenge can be retried; there is no replay record. Madeora adds the limits below.

## Design

1. **Re-authentication (one mechanism for every sensitive change).** Same as S08: the person types their password into a memory-only client; if the account has 2FA, that client also passes a TOTP challenge. With that fresh session the browser calls `public.authorize_account_change(action)`, which checks in the database that the session exists, has a password sign-in from the last 5 minutes and, when 2FA is on, `aal2` with a TOTP verification from the last 5 minutes. It writes a one-time permission (10 minutes) in `private.account_change_grants`. Actions: `password`, `email`, `two_factor_enroll`, `two_factor_disable`, `recovery_codes`. `authorize_sign_in_method_change` (S08) gains the same 2FA requirement (ADR 0010).
2. **Database guards** (triggers on Supabase Auth's tables, functions in `private`, like S08), so a browser cannot skip step 1 by calling Supabase Auth directly:
   - `auth.users` password change on a confirmed account: needs the `password` permission, or a password-reset (recovery) sign-in of the last hour. Unconfirmed accounts (Supabase's own sign-up flow) are left alone.
   - `auth.users` new pending email change: needs the `email` permission. Completing or clearing a change is allowed.
   - `auth.mfa_factors` new TOTP factor: needs `two_factor_enroll`; removing a verified factor needs `two_factor_disable` (or the recovery-code redemption below). Unverified, abandoned factors can always be removed.
   - `auth.mfa_challenges`: at most 10 challenges per factor in 15 minutes (per-account attempt limit on top of Supabase's per-IP limit); a second successful verification of the same factor within 90 seconds is refused, so a seen code cannot be replayed inside its validity window.
3. **Request-level enforcement.** A PostgREST pre-request function (`public.check_request`, set on the `authenticator` role) refuses with 401 any signed-in request whose session no longer exists (revoked, signed out everywhere, password changed elsewhere) and any request from an account with 2FA whose session is still `aal1`, except the one call the 2FA page needs (redeeming a recovery code). The two Realtime signal tables get the same check as a restrictive policy. On the server, `getVerifiedUser` already asks Supabase Auth (revoked sessions fail); it now also treats an `aal1` session of a 2FA account as "second factor pending": pages redirect to `/sign-in/two-factor`, API routes answer 401.
4. **2FA (Settings › Security):** status card. Turn on: re-authenticate → QR code + manual secret (shown only during setup) → enter a code → 10 recovery codes shown once with copy/download and offline-storage advice. Turn off: re-authenticate → confirm. Regenerate recovery codes: re-authenticate → new set, old set invalid. Recovery codes: 12 characters (60 bits), only SHA-256 verifiers stored, single use, 5 failed redemptions per 15 minutes per account.
5. **Sign-in with 2FA:** after a password or Google sign-in, an account with 2FA lands on `/sign-in/two-factor` (code, or "Use a recovery code"). Google sign-in cannot bypass it. Redeeming a recovery code (lost authenticator) removes the authenticator, invalidates the remaining codes, signs out the account's other sessions, sends a security notice and asks the person to set 2FA up again.
6. **Password change (Settings › Security):** current password (+ TOTP when on) → new password (same rules as sign-up) → confirmation that explains "this device stays signed in, all others are signed out" → done. Supabase signs out the others; the page shows the result. The password-reset flow (S06) already signs out everywhere, including the resetting browser.
7. **Email change (Settings › Security):** re-authenticate → new address → single-use link to the new address (`double_confirm_changes = false`: the old inbox is not required, spec); the old address gets Supabase's "email changed" notice on completion. Pending state with masked addresses, resend and cancel. An address already in use gets the same neutral answer as a free one (no account enumeration). The new address is not used for anything until confirmed.
8. **Devices and sessions (Settings › Security › Devices and sessions):** own sessions only, via `public.list_my_sessions()`: device/browser/platform from the user agent (best effort), created, approximate last activity, "This device". No IP address. Actions: sign out one session (no re-authentication, so a suspicious session can be stopped at once), **Report suspicious** (signs it out, records it, notice, then guided steps: change password, check 2FA, review sessions), **Sign out everywhere** (explained first; all sessions including this one, then the sign-in page).
9. **Audit and notices:** `private.account_security_events` (privacy-minimised: kind, time, session id, no secrets, codes, addresses or IPs) for every change above; S38 builds the history and downloadable report on it. Security emails: Supabase's own (password changed, email changed, factor added/removed, identity linked/unlinked) plus Madeora notices through `private.notify_user` (category `security`, cannot be switched off) for the events Supabase does not see: recovery code used, recovery codes regenerated, session reported, signed out everywhere.

## Defaults picked (owner may override)

- Re-authentication window 5 min (as S08); an account-change permission lasts 2 min and is bound to the browser session that asked for it (the first recovery-code permission after setup lasts 10 min).
- Recovery codes: 10 codes, 12 characters; redeeming one removes the lost authenticator (no waiting period for this path; the waiting-period recovery belongs to the account recovery codes in S37b).
- Per-account limits: 10 TOTP challenges / 15 min, each usable for 30 s; 5 failed recovery codes / 15 min; TOTP replay window 90 s.
- Signing out one session, reporting and signing out everywhere need no re-authentication (spec: a fast path to stop a suspicious session); every credential change does.
- Access tokens stay at Supabase's 1 hour; revocation is immediate anyway through the pre-request check.
- Google-only accounts: use "Forgot password" to add a password first (as S08); in-Settings Google re-authentication is S37b.

## Owner actions (guide in `docs/adult-security-setup.md`)

Hosted Supabase (`madeora-preview`, `madeora-production`): TOTP enroll/verify on, "Secure email change" off, the security email notifications and the email-change template from `supabase/templates`. Exact clicks in the guide.

## Tests

- DB (`tests/db/rls/adult_security.test.sql`): permissions (single use, expiry, bound to account and action, stale or missing 2FA), every guard, recovery code generation/redeem/replay/limit, session list (own only), revoke/report/sign out everywhere, pre-request check (revoked session, aal1 with 2FA, exemptions, anon and service role untouched).
- E2E (`tests/e2e/specs/adult-security.spec.ts`, real Supabase Auth): turn on 2FA, sign in with code, recovery-code sign-in, Google cannot skip 2FA (google project), wrong code; password change signs out a second browser; email change with confirmation link; sessions list, sign out one, sign out everywhere; re-authentication refused with a wrong password.
- Unit: user-agent labels, error mapping, schemas, components in both languages with axe.

## Done when

Every sensitive change above refuses without recent re-authentication (database and UI), and all of the above is tested. Full suite runs on CI.

## Progress

- [x] Spec, plan, existing auth code read; GoTrue behaviour checked.
- [x] Migration, pre-request check, guards
- [x] Server identity, pages and components
- [x] Tests: DB suite passes locally; web, email and domain unit tests pass; E2E spec written (runs on CI). Gap: no separate Google-project E2E for "Google cannot skip 2FA"; the server check is the same for every first step.
- [x] Owner guide `docs/adult-security-setup.md`, ADR 0047
- [x] Review of part one (`reviews/steps/S37-review.md`, CHANGES_REQUIRED), fixes below
- [x] Part two app: trusted browser (cookie + `/api/v1/me/trusted-device`, two-factor page redeems it, `getAuthState` asks `session_is_trusted`); code verified on the browser's own session; Google link passes the main session; Settings › Security recovery methods (backup email, account recovery codes), trusted browsers, recovery banner; signed-out `/account-recovery` (start, continue, finish), `/auth/confirm-backup-email`; "Confirm with Google" for accounts without a password (`/auth/reauthenticate`, sessionStorage PKCE client); en/nl.
- [x] Part two tests: component tests with axe (`recovery.test.tsx`, `security.test.tsx`), route test, `google-reauth.test.ts`, E2E for trusted browsers. Fixed the unused-messages check (Security keys looked up by value). Web lint, typecheck, prettier and 395 relevant unit tests pass locally. Gap: no E2E for backup-email and recovery links (sent by Trigger.dev jobs, not reachable in E2E); the DB suite and component tests cover them.
- [x] One review of the whole step (review 2 in `reviews/steps/S37-review.md`): CHANGES_REQUIRED, 1 BLOCKER, no HIGH. Fixes below.

## Review fixes (review in `reviews/steps/S37-review.md`, verified by the implementer)

- BLOCKER 1: `private.request_session_ok()` granted to `authenticated` and allowlisted; test users now act in a standing session (`tests.act_as_user`), and the chore-pool test checks a signed-out token sees no signal. chore-pool, shopping and every other DB test file pass locally.
- BLOCKER 2: `public.check_request()` is now a SECURITY INVOKER SQL function bound at creation; it calls `private.enforce_request_session()` (allowlisted). Baseline passes. The pre-request setting is its own migration.
- HIGH 3: permissions bound to the browser session; password changes checked at commit (only the bound session, or for a reset only the reset session, may remain); 2-minute lifetime; recovery-code creation checks the session. Residual risk for email and authenticator changes documented in ADR 0047.
- HIGH 4: a challenge succeeds only within 30 s of creation, so the per-account challenge limit bounds guessing; remaining per-IP limit documented.
- HIGH 5: Ward chose (2026-11-06) that a recovery code removes the authenticator at once, with emails; recorded in ADR 0047.
- Not changed (MEDIUM/LOW, recorded in the ADR): sign-in audit events (S38), raw-API email probing, replay-guard message, extra E2E for direct Auth API calls.
- Review 2, BLOCKER 1 (verified): with two-factor on, the aal1 reauthentication session was refused by the pre-request check. `authorize_account_change` and `authorize_sign_in_method_change` are now exempt (both require the code themselves). DB test: both paths pass the check, an aal1 pair without a code gets no permission. E2E: with two-factor on, new recovery codes and turning it off with password and code. All DB test files pass locally.
- Review 2, MEDIUM (fixed): finishing a recovery clears the old password, reset token and one-time tokens (DB test added). Other MEDIUM and LOW findings are recorded as residual risks in ADR 0047.
- CI E2E fix (reproduced on a local Supabase stack): Supabase Auth ends every aal1 session of the account when a code is verified, so verifying the reauthentication code on the browser's own session ended the short-lived password or Google session before it asked for the permission. The code is now verified on the short-lived session (browser session aal2), or first on the browser's own session on a trusted browser (aal1); for Google, on a trusted browser the code is asked before leaving for Google. New E2E: a trusted browser confirms a change with password and code. Test-only fixes: wait for the wrong-code message before the right code, scoped locators, the API confirmation no longer leaves a session behind, recovery-code click waits for hydration.
