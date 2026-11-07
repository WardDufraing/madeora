# S37 review: adult account security (`feat/adult-security`)

Reviewer: independent review agent (fresh context). Scope: the uncommitted working tree against
HEAD 0763e97, which has 51 files. The supplied `s37.diff` was made against a stale local `main` ref
(a06039c), so it also contains unrelated S31–S36 hunks, for example in `notification-list.tsx`.
Sources: spec L371–390 and L537–610, CLAUDE.md, architecture §7, the brief, ADR 0047 and the owner
guide. No repository files were modified. No suites were run, and the claims below come from
reading the code.

## Verdict: CHANGES_REQUIRED

## Findings

### BLOCKER

1. **Realtime/RLS: the new restrictive policies call a private function that `authenticated` cannot execute** (`supabase/migrations/20261123090000_adult_security.sql:760-782, 822-828`)
   - The function is `private.request_session_ok()`. It gets no `grant execute ... to authenticated`, and the S03 default privileges remove PUBLIC EXECUTE (`20261013000000_private_schema.sql:17`). PostgreSQL checks EXECUTE on functions in a policy qual as the querying role. As a result, every `select` on `chore_pool_signals` and `shopping_signals`, including Realtime's per-event RLS check, fails with "permission denied for function". The chore-pool and shopping live views break for everyone.
   - Even with a grant, the test helper `tests.act_as_user` (`tests/db/sql/helpers.sql:47-52`) sets claims without `session_id`. The policy then hides every row, so existing assertions should now fail: `tests/db/rls/chore-pool.test.sql:669-675` and `tests/db/rls/shopping.test.sql:696`.
   - `adult_security.test.sql:117-118` only calls the function through a SECURITY DEFINER wrapper, so it cannot detect either problem.
   - Remediation:
     - Grant EXECUTE to `authenticated`, and add the function to the allowlist in `baseline.test.sql` with a reason.
     - Give the test helpers a real session (insert `auth.sessions` and add `session_id`), or update the existing tests.
     - Add a test that runs a real `select` on both signal tables as a live, a revoked and an aal1/2FA user.

2. **The baseline security test fails: `public.check_request()` is SECURITY DEFINER and is granted to `anon`** (`…adult_security.sql:787-816`)
   - `baseline.test.sql:70-86` asserts that no SECURITY DEFINER function in `public` is executable by anon. Together with item 1, this means the claim "DB suite passes locally" in the brief does not hold for the full suite.
   - Remediation: make `check_request` SECURITY INVOKER. It only calls private SECURITY DEFINER helpers, so grant those helpers narrowly and allowlist them. The alternative is an explicitly justified exception in the baseline, with owner sign-off.

### HIGH

3. **Reauthentication permissions belong to the whole account, not to the session that reauthenticated, so a stolen session can use them up** (`…adult_security.sql:102-110, 166-203, 270-301, 380`)
   - `private.account_change_grants` is keyed `(user_id, action)`. Any live session of the same account can consume it within its 10 minutes.
   - Attack: an attacker holding a stolen session (aal2 if 2FA is on) keeps calling GoTrue `PUT /user` with `password`, or `email` set to an address they control. The calls are refused until the victim reauthenticates. Then the attacker's call takes the permission first. GoTrue's `LogoutAllExceptMe` keeps the attacker's session and signs out the victim. For email, the confirmation link goes to the attacker's mailbox.
   - This is the exact case the spec's reauthentication requirement exists for (L386, L575, L583). Victims who suspect compromise are the likeliest to change their password at that moment.
   - A permission also outlives a failed GoTrue update (weak, same or "email exists" password or address): it is not consumed and stays valid for 10 minutes.
   - The password-reset exemption (`:275-283`) has the same flaw. _Any_ session's `otp` claim from the last hour lets _any_ session change the password. A routine change from a stolen session therefore passes as a reset and survives it, which L576 forbids.
   - Remediation:
     - Bind each permission to the browser's own session id (pass it from the memory-only client and check it belongs to `auth.uid()` and is live).
     - For passwords, add a deferred constraint trigger that fails unless the bound session survives GoTrue's `LogoutAllExceptMe` in the same transaction.
     - On the reset path, delete or require absence of non-`otp` sessions.
     - Shorten the lifetime and revoke permissions on UI failure.
     - Where binding is impossible (email, factor enrol), document the residual risk for owner acceptance.

4. **The per-account TOTP attempt limit does not limit attempts** (`…adult_security.sql:455-477`; the brief admits at L19 that "a challenge can be retried")
   - The trigger counts challenge _creations_. GoTrue lets one challenge be verified again and again until it expires (about 5 minutes), and failed verifications write nothing.
   - So an attacker who has the password creates one challenge and guesses codes from many IP addresses. They are limited only by GoTrue's per-IP verify limit. The spec's "Rate-limit verification … attempts" (L384) and "stolen/replayed codes, rate limiting" (L389) are not met, yet the code and the ADR claim a per-account limit.
   - Remediation:
     - Bound each challenge's useful life in `guard_mfa_challenge_verify`, for example by refusing verification when `created_at` is more than about 30 s old, and lower the challenge allowance.
     - Or route verification through a counted path.
     - Either way, record the remaining limit (per IP × per challenge) honestly in the ADR for owner acceptance. The paid Supabase MFA-attempt hook is not an option at €0.

5. **The lost-authenticator recovery has no delay, which conflicts with the spec; this is an unresolved owner decision** (`…adult_security.sql:595-641`; spec L386: "a carefully verified lost-authenticator recovery process with **delay**, notifications and abuse safeguards")
   - Redeeming one TOTP recovery code with the password removes 2FA immediately and permanently and signs out every other session, including the real owner's.
   - Brief L40 calls "no waiting period" a default, but that contradicts explicit spec text. CLAUDE.md says to ask the owner rather than choose.
   - Remediation: get the owner's decision on a decision card. Either add a waiting/objection period before the factor is removed (the code could grant this sign-in only), or record the owner's explicit acceptance in the ADR.

### MEDIUM

6. **Email enumeration through the raw API** (`email-setting.tsx:81`)
   - The UI hides `email_exists`, but GoTrue's 422 still tells a reauthenticated caller whether an address is in use. Because a 422 does not consume the permission, one reauthentication allows unlimited probing for 10 minutes (spec L585, L557).
   - After a reload, the pending state differs for an address that is in use.
   - Remediation: document this as a residual GoTrue limitation. Consider binding or shortening the permission (item 3) and rate-limiting through an attempt counter.

7. **No audit events for sign-in or session creation** (spec L378 and L388)
   - L378 requires events for "sign-in, session creation"; L388 covers failed TOTP attempts. Only changes and failed recovery codes are recorded.
   - Remediation: add an `after insert on auth.sessions` event (no IP or user agent), or defer explicitly to S38 with owner agreement.

8. **The 90-second replay guard refuses legitimate quick follow-ups** (`:482-496`)
   - Signing in with a code and then reauthenticating within 90 s, for example to turn 2FA off or change the password, fails with a generic 500 and "try again shortly". The E2E suite has to age verifications (`adult-security.spec.ts:31-38`) to work around it.
   - Remediation: show a specific "wait for the next code" message (the hint is `two_factor_code_reused`), and test that UX.

9. **Test gaps on the done-condition** (spec L379 and L389). There are no tests for:
   - E2E proof that a _direct_ GoTrue call is refused without a permission: `updateUser({password|email})`, `mfa.enroll` and `mfa.unenroll` from a session that did not reauthenticate. Only the UI path with a wrong password is tested.
   - Realtime blocking after revocation.
   - Google sign-in followed by the 2FA challenge (the brief admits this gap).
   - Replay refused against real GoTrue, and challenge rate limiting against real GoTrue.
   - GoTrue's behaviour on hosted Supabase, as opposed to the shim. In particular, `postgres` needs DML on `auth.users`, `auth.sessions` and `auth.mfa_factors`, which no earlier migration needed (S08 only added triggers).

### LOW

10. ADR 0047 says that if `alter role authenticator` fails, revoked sessions "keep working". In fact the whole migration rolls back. Consider moving the `ALTER ROLE` and `NOTIFY` into a separate migration so a refusal does not block the rest.
11. The brief (L29) says "two calls" are exempt from the aal1 rule, while the code and ADR exempt only `/rpc/redeem_two_factor_recovery_code`. Align the documents.
12. `is_upgradable_password_hash` (`:252-255`) exempts _any_ hash that is not `$2?$10$`, so an account with a different bcrypt cost or an imported hash can change its password once without reauthentication. Narrow the exemption to the formats GoTrue actually rehashes, or check that the new hash is a bcrypt-10 rehash of the same password, which cannot be checked here and should be documented.
13. `cancel_my_email_change` (`:317-339`) writes GoTrue internals directly and leaves `auth.one_time_tokens` rows behind. Clear the matching `email_change_*` one-time tokens, or document the coupling for GoTrue upgrades.
14. `authorize_account_change` and the session RPCs do not exclude non-adult Supabase users. Child and Household Display accounts are planned as Auth users (CLAUDE.md), and spec L387 says adult 2FA is not theirs. Add an adult-only check when those accounts arrive, and note it in the ADR.
15. `two_factor_recovery_attempts` is cleared only after a successful redemption, so it grows without bound. Prune rows older than 15 minutes on insert.
16. `check_request` adds two SECURITY DEFINER lookups to every PostgREST request. They use primary-key and user-id indexes, which is acceptable; monitor latency.

## Explicit checks

- **Requirements:** mostly covered: sessions list, revoking one session, reporting, signing out everywhere, TOTP with QR code and manual secret, recovery codes shown once with only hashes stored, password change that keeps the current session, a single-link email change with notice to the old address, and 2FA on Google sign-in. Gaps:
  - delay on lost-authenticator recovery (item 5)
  - per-account limit on verification attempts (item 4)
  - sign-in audit (item 7)
  - reset path that does not let a routine change pass as a reset (item 3)
  - risk-elevated reports that revoke all sessions (L576: not built; acceptable only if the owner agrees)
- **Cross-Home isolation:** sessions and security are account-wide and own-only (`auth.uid()` in every RPC). No Home data, and the notices use `p_home_id = null`. OK.
- **Permissions:** `revoke_my_session` is limited to the caller's own sessions, and every public RPC is revoked from PUBLIC/anon. Broken: the grant on `request_session_ok` (item 1) and the anon grant on `check_request` (item 2). Permissions are not bound to sessions (item 3).
- **Secrets:** no secrets in logs. Audit rows hold no codes, addresses or IPs. The TOTP secret is shown only during setup. Codes use `gen_random_bytes` with an unbiased 32-letter alphabet. OK. Recovery-code verifiers are unsalted SHA-256 over 60 bits, which is acceptable for random codes.
- **Input validation:** the Zod schemas for codes and passwords are fine, the DB normalises codes and checks their length, `p_action` uses an allowlist, `safeNextPath` is used for `next`, and the QR code is rendered as an `<img>` data URI (no injection). OK.
- **Migration safety:** the change is additive and backward-compatible apart from items 1 and 2. Risks on hosted Supabase: the `alter role authenticator` (documented in the guide); DML on `auth.*` as `postgres` and triggers on `auth.mfa_*`, which should be checked on the preview first; and coupling to GoTrue internals (`mfa_amr_claims`, `email_change_*`). There is no down migration (the rollback is to drop the triggers and policies and reset `pgrst.db_pre_request`), so document it.
- **Test coverage:** the DB tests cover the guards through the shim; the unit and component tests include axe checks in both languages; the E2E spec covers the main flows. See items 1, 2 and 9.
- **Accessibility:** labelled forms, `FormAlert announce`, a confirmation dialog for signing out everywhere, per-row `aria-label`s, QR `alt` text with a manual secret, and axe in unit and E2E tests. OK.
- **Performance:** the pre-request adds two indexed lookups per request (item 16). Otherwise fine.
- **Maintainability:** clear comments and a shared `reauthenticate()` that removes the duplication from S08. The ADR and brief are inconsistent (items 10 and 11).

## Remaining risks and test gaps

- Behaviour that depends on GoTrue: that a challenge can be retried, that `verified_at` is kept, `LogoutAllExceptMe` in the same transaction, and `email_exists` being checked before the write. None of this is proven against the hosted version and only part of it in E2E.
- No E2E proof that the DB guards stop direct Auth API calls, or that Realtime stops after revocation.
- The Google first step followed by 2FA has no E2E.
- Grants that are not bound to a session (item 3) stay a residual risk even after mitigation; the owner needs to see it.

## Review 2: whole step

Reviewer: independent review agent (fresh context, no part in the implementation). Scope: the
whole uncommitted S37 working tree (diff `S37.diff`, generated types excluded) against CLAUDE.md,
architecture §7, spec L371–390 and L537–610, the brief, ADR 0047 and the owner guide. No repository
file other than this review was changed. Checks run (logs in the session scratchpad
`review-logs/`): web vitest for `src/i18n/messages.test.ts`, `src/auth`, `src/components/security`,
the trusted-device route and the sign-in methods component (17 files, 184 tests, all pass); jobs
`security-email.test.ts`, email `security-email.test.ts`, domain notifications (all pass). The DB
suite and E2E were not run (not allowed here), so DB and E2E statements below come from reading.

### Verdict: CHANGES_REQUIRED

### Review 1 fixes: status

- BLOCKER 1 (Realtime helper grant, test sessions): fixed. `request_session_ok()` is granted to
  `authenticated` and allowlisted; `tests.act_as_user` now uses a standing session.
- BLOCKER 2 (`check_request` SECURITY DEFINER for anon): fixed. It is an invoker `begin atomic`
  wrapper; the private helper is allowlisted.
- HIGH 3 (unbound permissions): fixed for password (commit-time session check, reset path checks
  the remaining sessions), recovery codes, backup email and account recovery codes; email and
  authenticator permissions remain unbound, documented in ADR 0047 as accepted residual risk.
- HIGH 4 (TOTP attempt limit): fixed by the 30-second challenge window plus the challenge limit;
  remaining per-IP limit documented.
- HIGH 5 (no delay on lost-authenticator recovery): owner decision recorded in ADR 0047.
- LOW 10, 11: fixed (separate pre-request migration; exemptions now match the ADR). MEDIUM 6–8 and
  LOW 12–16 are unchanged and mostly recorded in the ADR; see below where they still matter.

### Findings

#### BLOCKER

1. **With two-factor sign-in on, every reauthentication is refused by the pre-request check, so no
   sensitive change can be made at all** (`supabase/migrations/20261123090000_adult_security.sql:1797-1823`
   and `:1845-1849`; `apps/web/src/auth/reauthenticate.ts:67`; `apps/web/src/auth/google-reauth.ts:131`)
   - In part two the second factor moved to the browser's own session. The memory-only
     reauthentication client (password) and the Google reauthentication client only pass the first
     factor, so their access token is `aal1` for an account with a verified factor. Both then call
     `authorize_account_change` (or S08's `authorize_sign_in_method_change`) through PostgREST
     with that token.
   - `public.check_request` → `private.request_session_state()` returns `second_factor_required`
     for exactly that token (aal1, `has_two_factor`, not a trusted session), and
     `enforce_request_session` exempts only `/rpc/redeem_two_factor_recovery_code` and
     `/rpc/use_trusted_device`. The call gets PT401 before the function body runs.
   - Effect for every account with 2FA: turning 2FA off, regenerating 2FA recovery codes, changing
     password or email, adding/changing/removing the backup email, creating account recovery codes,
     and linking/unlinking Google (an S08 regression) all fail with "reauthentication required".
     With "Confirm with Google" the same happens after the code step. The security feature locks
     its own users out of their settings.
   - Why the tests miss it: `adult_security.test.sql:776-800` (section 9) calls
     `authorize_account_change` as the aal1 `rae_pw` session directly, never through
     `check_request`. The E2E helper `reauthenticate(page, account, secret?)`
     (`tests/e2e/specs/adult-security.spec.ts:40`) takes a secret, but every caller (`:55`, `:208`,
     `:248`) omits it: no E2E reauthenticates on an account with 2FA on. The component tests mock
     Supabase.
   - Remediation: add `/rpc/authorize_account_change` and `/rpc/authorize_sign_in_method_change` to
     the aal1 exemption (both functions verify the TOTP claim themselves, on the reauthentication
     or the main session, so the exemption grants nothing extra), and say so in the comment and in
     ADR 0047. Add a DB test that runs `check_request()` with `request.path` set to each of them for
     an aal1 session of a 2FA account (allowed), and keeps another path refused. Add E2E with 2FA on:
     turn 2FA off, regenerate recovery codes, and change the password (each passing `secret`).

#### HIGH

None besides the BLOCKER.

#### MEDIUM

2. **Finishing an account recovery leaves the old credentials and links valid**
   (`…adult_security.sql:1663-1685`)
   - `finish_account_recovery` changes the primary address, ends sessions and clears
     `email_change_*`. It does not clear the password (`encrypted_password`), `recovery_token`,
     `confirmation_token`, `reauthentication_token` or the user's `auth.one_time_tokens`, and it
     leaves a linked Google identity as it is.
   - So a password-reset link that was sent to the old (possibly compromised) mailbox shortly
     before the finish still works afterwards, and whoever knows the old password can sign in with
     the new address before the owner's reset. Spec L584/L587 ("invalidate superseded verification
     tokens", "old-email links no longer authorize new changes after completion") and L607 ("reset
     compromised recovery material, review linked sign-in methods").
   - Remediation: in the same transaction set `encrypted_password = ''` (the guard allows clearing),
     clear the token columns and delete the user's `auth.one_time_tokens`; show "review sign-in
     methods" in the post-recovery guidance. Add DB tests for each.
3. **The old primary address never hears that the recovery finished**
   (`…adult_security.sql:1687-1690`; recipient resolved at send time in
   `20261022090000_notifications.sql:815`)
   - `account.recovered` goes through `notify_user`, whose email is addressed when the job runs, by
     which time the primary address is already the backup address. The direct `auth.users` update
     also bypasses Supabase Auth's own "email changed" notice. Spec L584 ("notify both old and new
     addresses of completion") and L550 ("avoid reliance solely on a … new address").
   - Remediation: queue a `security_emails` row to the old address (captured before the update),
     with no link, and test it.
4. **No recovery path for "password and authenticator lost, mailbox kept"**
   (`apps/web/src/components/auth/reset-password-form.tsx:113-117`)
   - Supabase Auth refuses the password update on the aal1 reset session (`insufficient_aal`), and
     the form then offers only an authenticator code. A person with two-factor recovery codes but no
     authenticator (and no linked Google) cannot reset their password, although
     `redeem_two_factor_recovery_code` would accept the reset session (it is exempt from the aal1
     rule). Spec L386/L388 (lost-authenticator recovery, clear lockout UX).
   - Remediation: offer "Use a recovery code" on the reset form (redeem, refresh, then update the
     password), with a component test and an E2E.
5. **The signed-out recovery start has no abuse control beyond 3 links per account per day**
   (`…adult_security.sql:1516-1549`; `apps/web/src/components/security/account-recovery.tsx:47`)
   - `start_account_recovery` is an anonymous PostgREST call without Turnstile and without any
     per-IP or global limit. Someone with a list of addresses can trigger up to 3 emails a day per
     account that has a backup address, which uses up the free Resend quota (100 per day) for every
     other email, including security notices. CLAUDE.md requires Turnstile on sign-in forms in
     production. The ADR lists "no Turnstile" as a residual risk, but the quota effect is not
     mentioned, and the owner has not been asked.
   - Remediation: route the start step through a Route Handler that verifies Turnstile server-side
     (as the other signed-out auth forms do) and calls the function there, or add a global daily cap
     in the database. Either way, ask the owner to accept the remaining risk explicitly.
6. **Anyone holding a session can stop the account holder's recovery, with no reauthentication**
   (`…adult_security.sql:1734-1753`)
   - Recovery exists for an owner who lost access. A session thief (or the holder of the
     compromised primary mailbox, who can reset the password and sign in) sees the in-app notice and
     cancels each attempt. There is no escalation path for conflicting evidence. Spec L606 asks for
     "restricted manual review when evidence conflicts".
   - Remediation: at least require reauthentication to cancel, and have a cancellation notify the
     backup address. Record the owner's position on contested recoveries in the ADR.

#### LOW

7. "Stop trusting all browsers" acts on one click, with no confirmation
   (`apps/web/src/components/security/trusted-devices-setting.tsx:109`); spec L541 asks for
   confirmation.
8. The replay guard still shows only a generic "try again shortly". It is now more likely to appear
   because the reauthentication code is verified on the main session, often within 90 seconds of
   the sign-in code (`two-factor.ts` `classifyTwoFactorError`; review 1 item 8).
9. If the job skips an email (expired, or no longer queued), `get_security_email` returns `skipped`
   without erasing `security_emails.token`. `to_email` (the backup address) is kept forever, and
   `backup_email_sends`, `account_recovery_attempts` and `two_factor_recovery_attempts` grow without
   pruning. Erase the token on skip and add a retention clean-up.
10. A Google reauthentication abandoned at the code step (tab closed or navigated away) leaves a live
    session in sessionStorage and on the server until it expires. It shows up in "Devices and
    sessions". `/auth/reauthenticate` with nothing pending could sign it out
    (`google-reauth-callback.tsx`, `nothingPending` branch).
11. The trust cookie has no `__Host-` prefix (`trusted-device.ts:16-28`). Consider `__Host-` on
    https (path `/`, secure, no domain).
12. A stolen aal2 session within 10 minutes of a TOTP verification can call `trust_this_device`
    directly with a token it chose. With the password, that skips 2FA for 30 days. A notice is sent;
    record this in the ADR.
13. Child and Household Display accounts are not excluded from the adult RPCs yet (review 1 item 14;
    still not in the ADR).

### Explicit checks

- **Requirements:**
  - Covered:
    - sessions list, revoke, report and sign out everywhere
    - TOTP with QR/manual secret, recovery codes and regeneration
    - password change keeping only the bound session
    - email change with notice to the old address
    - trusted browsers: opt-in, 30 days, never renewed, ended by security events, revoke one or all
    - verified backup email (distinct, unique, single-use link) and separate account recovery codes
    - 72-hour recovery with notices and owner cancel
    - Google confirmation for password-less accounts
  - Done condition not met: with 2FA on, reauthentication cannot succeed (BLOCKER 1).
  - Gaps: items 2–6.
  - Sign-in audit is deferred to S38 (ADR).
- **Cross-Home isolation:** all new functions act on `auth.uid()` only, with no Home data. Notices
  use `p_home_id = null`. Trusted devices, backup email and recovery are account-wide. OK.
- **Permissions:**
  - Every public RPC is revoked from PUBLIC/anon except the three invoker recovery wrappers, which
    are intended for anon.
  - The private helpers granted to anon/authenticated are allowlisted in `baseline.test.sql` with
    reasons. Service-role-only job functions are revoked from authenticated and listed.
  - SECURITY DEFINER functions all set `search_path = ''`.
  - Defect: the pre-request exemption list is too narrow (BLOCKER 1).
- **Secrets:**
  - Trust token: 32 random bytes, httpOnly cookie, only its hash stored, never logged.
  - Link tokens: hashed in the flow tables; the plaintext lives only in `security_emails` until the
    send is recorded (item 9). Job payloads hold only ids.
  - Codes are hashed. No secrets in logs (log lines carry only codes and kinds). OK.
- **Input validation:**
  - Zod schemas for codes and link tokens.
  - In the database: email shape and length, code length, `p_action` allowlist, device enums as
    CHECK constraints.
  - `safeNextPath` on the two-factor page. The Google callback clears the code from the URL.
  - OK.
- **Migration safety:**
  - Additive. The S08 function is replaced with a backward-compatible default argument.
  - The pre-request setting has its own migration.
  - Hosted risks as in review 1: DML on `auth.*` as `postgres`, triggers on `auth.mfa_*`, and
    coupling to GoTrue internals. `finish_account_recovery` now also writes `auth.users.email` and
    `auth.identities.identity_data` directly.
  - No down migration; the rollback is to unset `pgrst.db_pre_request` and drop the triggers and
    policies (should be in the guide).
- **Test coverage:**
  - Covered: a broad DB suite, unit/component tests with axe in both languages, the route test, and
    E2E for 2FA, trust, password, email and sessions.
  - Missing:
    - a pre-request test for the reauthentication calls
    - any E2E that reauthenticates with 2FA on (BLOCKER 1)
    - E2E for backup email and recovery links (acknowledged)
    - Google + 2FA E2E (acknowledged)
    - tests for items 2–4
- **Accessibility:**
  - Labelled fields, `FormAlert announce`, per-row `aria-label`s, a region label on the recovery
    banner, axe in component tests and E2E.
  - The revoke-all control lacks a confirmation (item 7).
- **Performance:**
  - The pre-request does up to three indexed lookups per request; acceptable.
  - `start_account_recovery` and `finish_account_recovery` compare `lower(btrim(email))` with no
    matching index (a sequential scan of `auth.users` on an anonymous endpoint). This is fine at
    MVP scale; add an expression index or compare against GoTrue's already-lowercased `email`.
- **Maintainability:** well commented, with one shared `reauthenticate()` and a shared
  account-change action list. The ADR text is now consistent with the code apart from BLOCKER 1. The
  ADR states that the residual risks are "owner accepts", but the thread shows no explicit owner
  acceptance for the part-two residuals.

### Remaining risks and test gaps

- None of the GoTrue-dependent behaviour has been proven against hosted Supabase:
  - `insufficient_aal` on aal1 updates
  - `LogoutAllExceptMe` in the same transaction
  - retryable challenges
  - `request.path` values behind Kong
  - DML rights of `postgres` on `auth.*`
- Accepted residuals (ADR):
  - unbound email and authenticator permissions
  - per-IP-only TOTP guessing outside the challenge window
  - raw-API email probing
  - stray empty account from choosing an unlinked Google account
  - copied trust cookie
- No E2E proves that direct Auth API calls without a permission are refused, or that Realtime stops
  after revocation (review 1 item 9, still open).
