# S14 brief: notifications core (in-app store, defaults and Home overrides, quiet hours, email through jobs, notification centre)

- **Branch:** `feat/notifications-core` (from `main` at `9bb4e1a`, after S13 and the Trigger.dev deploy fix)
- **Date:** 2026-10-15
- **Depends on:** S13 (outbox, executor, Trigger.dev tasks), S10 (invitations), S12b (ownership recovery), S07 (preferences, locale, timezone)

## Spec and architecture used

- Spec, "Confirmed global adult notification defaults with per-Home overrides" (`docs/product/Project-specification.md`, around line 302): defaults, per-Home overrides, inherited or overridden display, reset, essential security messages, quiet hours, evaluation at delivery time, source Home, idempotent identifiers, privacy.
- Spec, "Confirmed verified Home ownership recovery" (notify the Owner, alert adult members with minimal detail) and "Confirmed exactly one Home Owner" (notifications on ownership changes).
- Architecture §39 (in-app in Postgres, email through Resend, in-app never depends on email), §11 and §22 (jobs, outbox, logs). CLAUDE.md: background processing B, email A, database access A, observability B, €0 rule.

## Scope

1. **Notification store** (`public.notifications`, own rows readable through RLS, written only by database functions). One row per notification, per account and optionally per Home. Params hold codes, ids and dates only, never free text, names or evidence.
2. **Preferences.** `public.notification_preferences` (global rows have `home_id` null; a Home row is an override). Absence of a Home row means "inherited", so a global change reaches every inheriting Home and never overwrites an explicit Home choice. Reset deletes the Home row. Writes go through RPCs that validate the category, channel and current membership.
3. **Quiet hours** (`public.notification_quiet_hours`): global row plus optional per-Home override, wall-clock start/end in an explicit IANA zone stored on the row.
4. **Delivery core** `private.notify_user(...)`, called inside the business transaction (database triggers on recoveries, join requests): checks the recipient and membership now, resolves the effective preference, stores the notification (dedupe key, so replays and duplicates do nothing), and enqueues an email job through `private.enqueue_job` in the same transaction.
5. **Email through the S13 outbox:** three jobs in `packages/jobs`: `notification-email`, `invitation-email`, `recovery-ready` (a delayed job at the end of the objection period). Handlers reach household data only through narrow `service_role`-only `security definer` functions and send with Resend, passing the job's idempotency key. Correlation IDs and the redacting logger are used in every run.
6. **S10 invitation emails move to the outbox.** A trigger enqueues the first send when an email invitation is created; resend and renew enqueue inside `prepare_invitation_email`. The routes stop sending email and return `delivery: pending`; the job records `sent`, `failed` or `not_configured` on the invitation. `record_home_invitation_delivery` (a manager-callable status writer) is removed, since only the job records delivery now.
7. **S12b carry-over:** a trigger on recovery cases notifies (a) the claimant, in-app and by email, at review started, approved (objection period), paused, resumed, rejected, ended because the Owner has access, invalid, completed, and when the objection period has ended and they can accept; (b) the Owner, in-app and by email, at review started and approved (as before), and in-app when a request is made; (c) adult members and Administrators, in-app only, when a request is made, when the objection period opens, and when a case ends, with no claimant identity.
8. **Categories now:** `security` (essential: ownership recovery; cannot be turned off; emailed to the Owner and the claimant, in-app only for other members) and `invitations` (optional: join request received by managers, join request decided for the applicant). Chores, tasks etc. are added by the modules that generate them (the spec says only where a feature actually generates notifications).
9. **UI:** notification centre at `/notifications` (list, unread state, mark read, mark all read, quiet-hours marker, link to the source), bell with unread count in the top bar, and `/settings/notifications` (global defaults, quiet hours, per-Home list with inherited/overridden badges, reset, effective-choice preview, email verification state). English and Dutch.
10. **Docs:** ADR 0018, `docs/notifications.md` (model, how to add a category or kind, runbook), updates to `docs/background-jobs.md`, `docs/trigger-setup.md`, `docs/email-setup.md`, `docs/development.md`.

**Out of scope (and why):** web push and actionable notifications (architecture §39 keeps them open); Household Display and child notifications (S41/S43 do not exist); account deactivation (not built: `private.can_receive_notifications` is the single place it will plug in); module categories (chores…); email webhooks and suppression lists (Resend webhook handling is a separate step; bounces are not reconciled yet); retention or purge of notifications (the spec leaves retention open); a web-side "kick" of the dispatcher (the 5-minute sweep delivers; see risks).

## Decisions (defaults I chose; correct any of them)

1. **Defaults when nothing is stored:** optional categories: in-app **on**, email **off** (email is opt-in per the spec); essential: in-app and email always on.
2. **Quiet hours never hide anything.** In-app notifications are stored and shown at once, marked "arrived during quiet hours". Quiet hours **defer optional email** to the end of the window. Essential security email is never deferred or suppressed. (No push channel exists yet, so there is nothing else to silence.)
3. **Quiet-hours zone** is stored on each row (the UI pre-fills the personal timezone for the global row and the Home's timezone for a Home override, and explains this). This avoids the database guessing a device zone when the personal timezone is "Automatic". An overnight window (22:00–07:00) is supported; start = end is refused.
4. **Home overrides** cover both channels and quiet hours; a Home override cannot enable a channel the account has not got (email needs a confirmed address, checked at delivery).
5. **Recheck at delivery:** the notification is created only for a current member (Home-scoped); the email job re-reads membership, the effective email preference and the confirmed address when it runs, and skips (recorded, not an error) if anything changed. A quiet-hours change after queuing does not re-defer (documented).
6. **Applicant notifications** (`join_request.decided`) carry no Home (the applicant may not be a member), so only global settings apply to them.
7. **The former Owner** of a completed recovery who was removed gets a Home-less essential notice (no Home name); one who stays a member gets the normal Home notice.
8. **Dedupe:** unique `(user_id, dedupe_key)`; the key names the event (for example `recovery:<id>:approved:<objection end>`), so a replay or a repeated trigger creates one notification and one email.
9. **Email recipient language** is the account's saved language, else English. Sender `Madeora <no-reply@mail.madeora.studio>` (production value of `EMAIL_FROM`).
10. **Trigger.dev environment variables grow:** `APP_URL`, `EMAIL_TRANSPORT`, `EMAIL_FROM`, `RESEND_API_KEY` (and `MAILPIT_URL` locally). The web app no longer needs `RESEND_API_KEY`; it keeps `EMAIL_TRANSPORT` only as the "email invitations are possible" flag for the invitation form.
11. **Retry numbers:** reuse S13 defaults (5 task attempts, 1 s to 60 s backoff); Resend rejection (4xx other than 429) is permanent, 429/5xx/network is retryable; render failure is permanent.

## Done when

- In-app delivery works even if email fails: a test where the email job fails permanently and retryably still leaves the notification stored, readable and countable; and a notification is stored with no email transport, no confirmed address, or email disabled.
- Quiet hours are tested (overnight window, DST-zone, different zones for two Homes, essential not deferred, deferral target is the window end) and Home overrides are tested (inheritance across two Homes, override one Home, global change with and without override, reset, category × channel, essential despite a Home mute, revoked membership, Home isolation).
- Database tests prove the privilege model: API roles cannot write notifications or preferences directly, cannot read other people's rows, service-role functions are executable by `service_role` only, new `private` functions stay unreachable (baseline test), the outbox payloads carry ids only.
- Job tests: Resend gets the job's idempotency key on every attempt; a retried job cannot send twice; revoked membership, disabled preference, revoked invitation and changed recovery state skip; logs contain no address, token or name; correlation ID flows from the enqueuing transaction.
- Full suite once (format, lint, typecheck, unit, build, db, e2e), independent review saved in `reviews/steps/S14-review.md`, BLOCKER/HIGH fixed and verified.

## Tests (relevant ones while building)

- **Database:** `tests/db/rls/notifications.test.sql` (store, RLS, preferences, quiet hours, delivery, triggers, grants), extended `invitations.test.sql` and `ownership-recovery.test.sql` where behaviour changed, `baseline.test.sql` allowlist unchanged, a concurrency test for duplicate delivery.
- **Unit:** `packages/jobs` (three jobs, services, worker env), `packages/email` (new templates, both languages), `apps/web` (API routes, schemas, components with axe, messages parity).
- **E2E:** notification centre and settings smoke with axe in both themes, if the existing fixtures allow it.

## Risks

- **Heavier SQL surface:** several `security definer` functions and triggers on recovery and invitation tables; mitigated by fixed `search_path`, no API grants on delivery functions, and tests. Replacing `prepare_invitation_email` changes S10 behaviour (email moves async); the S10 route tests and SQL tests are updated.
- **Latency:** email is sent by the 5-minute sweep, so an invitation email can take up to about 5 minutes. A web-side kick needs a Trigger.dev key in Vercel, which S13 deliberately postponed; I propose it as a follow-up after you provision it.
- **Trigger.dev and Resend behaviour** (idempotency key lifetime 24 h at Resend, env var availability) is verified against fakes only until your smoke test (`docs/trigger-setup.md`).
- **Migration** must be applied to preview and production by the owner (`docs/supabase-migrations.md`); existing environments keep working because the old web code path is replaced in the same release.

## Model

**This step needs the heavier model.** It adds `security definer` functions and triggers on security-sensitive tables (ownership recovery, invitations), `service_role` functions that read email addresses and invitation secrets, RLS on user-scoped rows that must respect Home membership, and idempotency and race handling (dedupe, duplicate jobs, retried sends). A silent mistake means a leaked address or invitation link, a missed security notice or a duplicate email. The UI, translations and docs are routine, but they ride on the same change set.
