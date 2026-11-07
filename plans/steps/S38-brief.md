# S38 · Activity history and alerts — feature brief

**Branch:** `feat/activity-history-alerts` (from `main` at ddd1e9c, S37 merged).
**Model:** Opus (account security, auth triggers, RLS-scoped private history; standing model rule).
**Sources (read only these):** build plan S38; PS L312–L370 (deactivation, account switching, inactivity, activity history, security report, security activity), L546–L553 (security notifications); ARCH §7, §11, §35, §39, §42; S37 brief and migration.

## Scope

Ward chose **one S38 PR** (2026-11-07). Part 1 below is built (draft PR #71); part 2 follows on the same branch, including the done-condition Playwright test.

Original split proposal (superseded):

- **S38 (this PR):** categorized Account → Activity history, the focused Security activity view, the downloadable security report, and security notifications (mandatory vs routine sign-in alerts, Account → Security → Notifications).
- **S38b (next):** temporary deactivation and reactivation, inactivity reminders with security review on return, multi-account switching on shared devices. The build plan's done-condition ("switching accounts clears every cache and subscription", Playwright) moves to S38b.

## Values awaiting Ward's approval (defaults in use)

1. Visible history retention: 12 months, all categories (incl. Security); purged automatically after that. No legal holds exist yet.
2. Inactivity reminders (S38b): first after 12 months without qualifying activity, then at most every 3 months, at most 3 in total.
3. Security report: available 24 hours, CSV and JSON, built at download from a snapshot frozen at request time (no stored file); 3 requests per 24 hours.

Platform limit: failed password attempts are invisible to Madeora on Supabase's free plan (the password-verification hook is paid). History covers successful sign-ins, blocked TOTP/recovery-code attempts and every change.

## Design

1. **One private table** `private.account_activity_events` (user, category, kind, outcome, Home id + Home name snapshot, safe actor = you / a Home manager / Madeora / automatic, coarse device labels, user response, time). Not exposed; read only through `public.list_my_activity` for `auth.uid()`. No Home manager, guardian or display path exists.
2. **Sources (database triggers, so every path is caught):**
   - Security: every S37 `account_security_events` row is mirrored; sign-ins come from a trigger on `auth.sessions` (privacy-safe browser/platform/kind labels parsed in SQL from the user agent, the raw string is not kept).
   - Re-authentication sign-ins (S37's memory client) would look like new sign-ins: sign-in events are classified by a sweep 2+ minutes later (runs in the 5-minute outbox job); a session that was used to re-authenticate is not shown as a sign-in and gets no alert.
   - Home memberships: `private.audit_events` membership, join-request, ownership-transfer actions whose subject is this account (actor shown only as "you", "a Home manager" or "automatic").
   - Profile: account name/accent/avatar changes (`user_preferences`) and per-Home name/accent/avatar (`home_member_profiles`).
   - Integrations: Google Calendar connect, disconnect, authorization expired, Home share on/off; a failed connection attempt is recorded by the OAuth callback.
   - Privacy: the category, filter and empty state ship now; its events (privacy dashboard, guided review) arrive with S39, where those settings are built.
   - Exceptional ownership recovery affecting this account is shown under Security.
3. **Activity history page** (Settings → Activity history): category, outcome, date range and Home filters, keyword search (the app matches the query against the translated event labels in the viewer's language and the Home-name snapshot; no raw fields are searchable), newest first, "Load more" keyset paging, distinct empty / no-match / error / beyond-retention states, accessible reset. Times in the person's chosen timezone.
4. **Security activity** (Settings → Security → Security activity): the same list fixed to Security, marks the current session, and on sign-in events offers **This was me** and **Secure my account** (signs that session out if it is still live, records the answer, links to password change and devices). No IPs or locations, ever.
5. **Security report:** re-authenticate (S37 mechanism, new action `security_report`, 2-minute permission, usable for the request and the downloads that follow) → date range within retention + timezone → report row with frozen snapshot time → Download CSV / JSON through a same-origin POST route (`Cache-Control: no-store`), which re-checks ownership, expiry, the live session and the permission. Discard early. Request/download recorded as security events created after the snapshot, so a report never contains itself. "Your report is ready" notice by email and in-app without a link token.
6. **Security notifications** (Settings → Security → Notifications): mandatory list (cannot be turned off; S37's existing notices) and two routine choices: new-device sign-in alerts (on by default) and every successful sign-in (off by default). Alerts go in-app and by email to the verified primary address through `private.notify_user`; no device identifiers, Home data or links with tokens. Recent security notifications with their email state are listed. A new device = browser + platform + device kind not seen in a sign-in in the last 12 months; the first sign-in of a new account never alerts.
7. **Retention:** an hourly purge (existing hourly job) removes activity rows and security events older than 12 months.

## Tests

- DB (`tests/db/rls/activity_history.test.sql`): own-only listing, filters, keyset paging, search by kind and Home name, mirror of security events, sign-in sweep (re-auth hidden, new device alert, routine prefs), triggers per category, report request (grant, range, rate limit, snapshot excludes itself, other user denied, expired, discarded), responses, purge.
- Unit: label/search matching, CSV/JSON builders, schemas, components in both languages with axe.
- E2E (`tests/e2e/specs/activity-history.spec.ts`): history filters and search, security report download after re-authentication.

## Progress

- [x] Part 2: temporary deactivation and reactivation
- [x] Part 2: inactivity reminders with security review on return
- [x] Part 2: multi-account switching on shared devices + Playwright done-condition (`tests/e2e/specs/account-switching.spec.ts`, runs in CI)

- [x] Brief and open values
- [x] Migration + DB tests
- [x] App: pages, route, notifications, jobs
- [x] Local checks (format, lint, typecheck, relevant tests)
- [x] Independent review → `reviews/steps/S38-review.md` (CHANGES_REQUIRED: 2 HIGH, 0 BLOCKER)
- [x] HIGH fixes verified (DB tests activity_history, adult_security, sign_in_methods, notifications, baseline, homes; web/domain/email unit tests, typecheck, lint, prettier)

## Review fixes

- **H1 Google link/unlink:** trigger on `auth.identities` records `google_sign_in_linked` / `google_sign_in_unlinked` as security events (so they reach history, Security activity and the report). Signing up with Google (first identity) and identities removed with a deleted account are not recorded. Exception-safe.
- **H2 risky sign-in alert mandatory:** each sign-in records whether the account had two-factor sign-in and when the session reached aal2 (trigger on `auth.sessions` aal update). A sign-in that never completes the second step (15-minute wait while live; at once when the session is gone; a recovery-code sign-in counts as finished) becomes `sign_in_unfinished`, outcome blocked, with the mandatory alert `account.unfinished_sign_in` regardless of routine choices. It offers This was me / Secure my account. Note: someone mistyping their own code during re-authentication also gets this alert (worded "if this was you, nothing to do").

## Open after review (not fixed, for Ward or later steps)

- M1 no backfill of S37 events from before this migration; M2 first-sign-in rule reads 12-month history; M3 late sweep rows can enter an already requested report; M5 CSV has no header notes (JSON has them); M6 no E2E spec, component tests English only; M7 the purge also deletes S37's `account_security_events` after 12 months (owner decision). LOWs in the review file.

## Part 2 design (one-PR decision)

- **Migration** `20261125090000_account_lifecycle.sql`.
- **Deactivation** (`deactivate_my_account`): needs S37 re-authentication (`deactivate_account` permission) and no Home the person alone owns (each Home has one Owner, so transfer first; Home closure does not exist yet). Records `account_deactivated`, sends a security notice, pauses Google Calendar (status `authorization_expired`, shown as "paused"; reconnect needed), deletes every session. Memberships, roles and data stay.
- **While deactivated:** sign-in still works (password/Google + 2FA) but the PostgREST pre-request check and Realtime policies refuse everything except `my_account_state` and `reactivate_my_account`; the app sends the session to `/reactivate`. Only security notifications are delivered. Home members see "Inactive account" in the directory (managers: reassign open work), never a reason.
- **Reactivation:** from that fully signed-in session; records `account_reactivated`, notice, then shows Home membership history since the deactivation date. Google stays paused until reconnected; revoked access and expired invitations stay as they are.
- **Inactivity:** `account_inactivity.last_active_at` updated by signed-in page visits (at most hourly; background jobs, integrations, token refreshes never count; backfilled from last sign-in). Hourly job sends `account.inactivity_reminder` (security category, no Home/date) after 12 months, then every 3 months, at most 3; deactivated accounts excluded. Returning after the threshold sets `review_due`: banner on every page → `/settings/security/review` (email, sign-in methods, devices, security activity) → "Everything looks right" records `security_review_completed`. Nothing is forced (2FA stays optional).
- **Account switching:** chooser `/accounts` (signed in or out) with names and colours only, stored in localStorage (no tokens, emails, Homes). "Remember this account on this device" checkbox on sign-in (untick on shared devices). Switch/Add posts to `/auth/sign-out` (`then=switch`), which signs the current account out on this device and lands on sign-in: a full page load, so TanStack cache, Realtime sockets and pending requests of the previous account cannot survive; other tabs are told via `AnnounceSignedOut`. Remove = off this device's list (active one is also signed out).

## Part 2 choices to confirm (made to keep moving)

1. Switching always signs the current account out and requires the next account's own sign-in; there is no locked-but-kept session or short-lived unlock (spec allows them only "where security review permits"). Idle locking is not added.
2. Child (username/PIN) accounts and Household Displays do not exist yet, so their switching rules apply when those are built.
3. Reactivation keeps the session that signed in (it could do nothing until reactivation) instead of forcing a second sign-in.
4. Ownership transfer to a currently deactivated member is not blocked yet (follow-up).
5. Part 2 was not covered by the independent review.
