# ADR 0018: Notifications core: an in-app store, preferences, quiet hours and email through jobs

- **Status:** Accepted for S14 within the approved architecture (§39, §11, §22), CLAUDE.md (background processing B, transactional email A, database access A, observability B) and the spec's "Confirmed global adult notification defaults with per-Home overrides". The defaults below are open to correction by the owner.
- **Date:** 2026-10-15
- **Step:** S14 (brief: `plans/steps/S14-brief.md`). Builds on S13 (outbox and jobs), S10 (invitations), S12b (ownership recovery) and S07 (language and timezone).

## Context

Architecture §39 asks for in-app notifications stored in Postgres and email through Resend, with the spec's global defaults, per-Home overrides and quiet hours, and says in-app delivery never depends on email. Until now the app sent invitation and recovery emails synchronously from the web request (S10, S12b), and members were told about an ownership recovery only by a banner derived from the case's state. The person who asked for a recovery was never emailed.

## Decision

**One delivery function, in the database.** `private.notify_user()` is called inside the business transaction. It re-checks the recipient (confirmed, not deleted, `private.can_receive_notifications`) and, for a Home notice, that they are a member now. It resolves the effective choice, stores the notification (unique `(user_id, dedupe_key)`, so a replay or a concurrent duplicate delivers once), and queues the email job in the S13 outbox in the same transaction. Triggers on `private.home_ownership_recoveries` and `private.home_join_requests` call it, so no code path (staff decision, objection, timeout, membership change) can change a case without telling the people involved. The web app does not decide who is notified.

**In-app never depends on email.** The notification row is the delivery. The email job only ever updates the row's `email_status` (`queued`, `sent`, `failed`, `skipped`, `not_configured`) and a short error code. A failed, rejected or never-sent email leaves the notice stored, readable and counted.

**Preferences.** `notification_preferences` holds explicit choices; a row with `home_id` null is the account default, a row with a Home is an override. A missing Home row means inherited, so a changed default reaches every inheriting Home and never overwrites an override; reset deletes the row. Built-in defaults for optional categories: in-app on, email off (email is opt-in). Overrides are removed when a membership ends, so a rejoin starts from the account defaults. Writes go through functions that check the category, channel and current membership; the tables are readable by their owner only and writable by nobody through the API. Only the person can read or change their settings: no Home role has any access.

**Essential notices.** The category `security` (ownership recovery) ignores every choice: it is always stored in-app, emailed where the event emails (the Owner, the person who asked, a former Owner), and never delayed. Other members get recovery alerts in-app only, with no claimant identity, evidence or reason.

**Quiet hours.** A row per scope (account or Home) with a start, an end and an explicit IANA zone; overnight windows are supported, start = end is refused, and a Home row (also with `enabled = false`) replaces the account row. Quiet hours delay **optional email** until the window ends (`available_at` of the outbox row). In-app notifications still appear at once, marked as arrived during quiet hours; essential email is never delayed. A quiet-hours change after an email was queued does not move it. Each row stores its own zone because "Automatic" personal timezones are known only to the browser; the settings page pre-fills the personal zone for the account and the Home's own zone for a Home, and says so.

**Recheck at send time.** The job asks `get_notification_email`, which re-evaluates membership, the confirmed address and the effective email choice (essential notices always pass). A changed choice or a left Home records `skipped` instead of sending.

**Email through the outbox, not the web request.** Three jobs in `packages/jobs`: `notification-email` (payload: the notification id), `invitation-email` (invitation id and send number) and `recovery-ready` (a delayed job at the end of an objection period). Payloads hold ids only; the job reads the address, the language and, for invitations, the secret link through `service_role`-only `security definer` functions at send time, so no address or link is ever in a payload, a log or Trigger.dev's dashboard. The handler passes the **job's idempotency key to Resend**, so a retry after a lost answer cannot send twice (Resend keeps keys for 24 hours; a retry normally follows within minutes). A Resend 4xx (other than 429) is permanent; 429, 5xx and network errors are retried by the S13 policy. Mail goes from `mail.madeora.studio` (`EMAIL_FROM`). The Resend key now lives only in Trigger.dev; the web app keeps `EMAIL_TRANSPORT` as a flag that decides whether the invitation form offers "by email".

**Invitation emails (S10 carry-over).** A trigger enqueues the first send when an email invitation is created; resend and renew enqueue inside `prepare_invitation_email`. Every send has a number; a job for a superseded send, a revoked or used invitation, sends nothing, and only the current send records its outcome. The routes return `delivery: pending`, and `record_home_invitation_delivery` (which let a manager write the status) is removed.

**Correlation.** The server Supabase client forwards the request's `x-correlation-id` to PostgREST; `private.request_correlation_id()` stamps it on the outbox row (only a lower-case UUID v4 is accepted), so the job's logs and Trigger.dev tag carry the request's id.

## Defaults chosen (owner may correct)

1. Optional categories: in-app on, email off. Only `security` and `invitations` exist now: the spec says categories appear only where a feature generates notifications.
2. Quiet hours delay optional email only; they never hide or delay anything else.
3. A Home notice for a member who has left is not shown or sent. A join-request answer has no Home, so only the account defaults apply to it.
4. A former Owner who is removed from the Home gets a notice without the Home's name.
5. Notifications and their email state are kept; retention is open in the spec, so nothing is purged.

## Consequences

- Email is sent by the 5-minute sweep (about 5 minutes of latency, up to the sweep interval). A web-side "kick" needs a Trigger.dev key in Vercel; it is left out until the owner provisions Trigger.dev and approves that key.
- The Resend free plan allows 100 emails a day; when it is hit, jobs retry with backoff and, after their attempts, are recorded as failed. In-app delivery is unaffected. A security email is not exempt from the provider's limit.
- No push channel, no bounce or suppression handling (a separate webhook step) and no account deactivation exist yet. `private.can_receive_notifications` is the one place deactivation will plug in.
- `service_role` can execute five more functions, each reading only what its job needs. They are tested to be executable by no other role.
