# Notifications

How Madeora tells people what happened (S14, [ADR 0018](adr/0018-notifications-core.md), architecture §39). Background jobs: [`background-jobs.md`](background-jobs.md). Email setup: [`email-setup.md`](email-setup.md).

## How a notification is delivered

1. A database function or trigger changes something and calls `private.notify_user(user, home, category, kind, params, dedupe_key, email?)` **in the same transaction**.
2. `notify_user` checks the person can receive (confirmed account) and, for a Home notice, is a member now. It resolves their effective choice (essential category, then the Home override, then their account default, then Madeora's default), stores the notification, and, if email applies, queues a `notification-email` job in the outbox (delayed to the end of quiet hours for optional email).
   If anything in the email part fails (for example the outbox cannot take the job), the in-app notice is kept and the email is marked `failed` with the code `enqueue_failed`; `notify_user` never lets a notification problem roll back the change it runs inside (an unknown category is the one programming error that stays loud).
3. The person sees it at once in the notification centre (`/notifications`, the bell in the top bar). The email, if any, is sent by a Trigger.dev job within minutes; the job rechecks everything and records `sent`, `failed`, `skipped` or `not_configured` on the notification. Email failing never removes the in-app notice.

Only the person can read or change their settings (`/settings/notifications`). No Home role sees anyone's choices.

## What exists

| Category      | Essential? | Kinds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security`    | yes        | Ownership recovery: for the Owner (`recovery.owner_*`), the person who asked (`recovery.claimant_*`), other members (`recovery.member_*`, in-app only), a former Owner (`recovery.former_owner_completed*`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `invitations` | no         | `join_request.received` (managers who can decide it), `join_request.decided` (the applicant; no Home)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reminders`   | no         | `task.reminder` (task reminders, S19b: the people the reminder is for; in-app on and email off by default; the email names the Home and the due date, never the task); `habit.reminder` (habit reminders, S28: the personal habit's owner, or each Home member who may check in and has not turned that habit's reminders off; offers Complete and Snooze in the notification centre; for a numeric habit (S29) it carries a point-in-time "so far" amount and offers an **Add progress** link instead of Complete; the email names the Home, never the habit); `goal.reminder` (goal deadline reminders, S30: the personal goal's owner, or each current Home member who may view the goal and has not turned its reminders off; an advance or overdue reminder naming the deadline, with a link to the goal; the email names the Home, never the goal) |
| `points`      | no         | `points.awarded`, `points.reversed` (chore points, S23: the account holder; opt-in, so in-app and email are off until the person turns them on)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `rewards`     | no         | `reward.requested` (reviewers who could approve it), `reward.approved`, `reward.rejected`, `reward.cancelled`, `reward.fulfilled`, `reward.unable`, `reward.refunded`, `reward.replacement` (the requester), `points.bonus`, `points.corrected`, `points.adjustment_reversed` (the account holder)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `habits`      | no         | `habit.paused`, `habit.resumed` (S28: a habit manager paused or resumed a Home habit, or its dated pause ended; opted-in members of the Home, only when the habit's paused state really changes; opt-in, so in-app and email are off until the person turns them on)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Invitation emails (to a person who may have no account) are not notifications: they are `invitation-email` jobs.

## Adding a category or a kind

1. **Category:** add it to `private.notification_category_essential`, to the check constraints of `notifications` (and of `notification_preferences` if optional), to `packages/domain/src/notifications` and to the `get_notification_settings` and `set_notification_preference` functions, in a new migration. Add its labels to `NotificationSettings` in both language files and a row to the settings component. A category exists only when a feature really generates its notifications (spec).
2. **Kind:** add it to `notificationKinds` in `packages/domain/src/notifications/index.ts` (a database test checks the list against the SQL), write it from the trigger or function that causes the event with a **stable dedupe key** (one key per event; keys that can repeat carry a timestamp), and add its sentence to `Notifications` in `en.json` and `nl.json` and to `kindMessage` in `notification-list.tsx`. Params hold ids, dates and short codes only: never names, free text or evidence.
3. **Email for a kind:** pass `p_email => true`, add a template entry to `packages/email/src/notification-messages.ts` (both languages) and a page for the button in `notificationPath`. A kind with no template fails its email job permanently, with the code `no_email_template`, and the in-app notice stays.
4. Test it: a case in `tests/db/rls/notifications.test.sql` (who is told, who is not, the Home boundary), and the email in `packages/email`.

## Runbook

Inspect from the Supabase SQL Editor (service role only; never expose these to the web app):

```sql
-- Emails that did not go out, with the reason code (no address, no body).
select kind, email_status, email_error_code, created_at from public.notifications
where email_status in ('failed', 'queued') and created_at < now() - interval '15 minutes'
order by created_at desc limit 50;

-- The outbox row of one notification, to requeue a dead one (docs/background-jobs.md).
select id, status, attempts, last_error_code from private.job_outbox
where job_name = 'notification-email' and payload ->> 'notificationId' = '<notification id>';
```

- `queued` for long: the job has not run. Check `public.job_outbox_stats()` and Trigger.dev (the dispatcher runs every 5 minutes; optional email waits for quiet hours to end by design).
- `failed` with `enqueue_failed`: the email job could not be queued (look for the warning `notify_user: email job not queued` in the database logs); the in-app notice exists. Nothing retries it; ask for a requeue of the case's next event or send the information another way.
- `failed` with `email_unavailable`: Resend was unreachable or limiting (free plan: 100 emails a day, 3,000 a month); the job retries 5 times, then the outbox row is dispatched but the execution is `failed_retryable`: requeue it once the cause is gone.
- `failed` with `email_rejected`: Resend refused the address or sender; not retried. Fix the cause, then requeue if it still makes sense.
- `skipped`: the person turned email off, left the Home or has no confirmed address by the time the job ran. Nothing to fix.
- `not_configured`: this Trigger.dev environment has no email transport (`EMAIL_TRANSPORT`). Set it (docs/trigger-setup.md) and requeue if needed.

Logs and Trigger.dev show event names, kinds, codes and the correlation ID, never addresses, names, links or message text.

## Privacy rules this relies on

- Params never carry names or free text; the reader's language and the Home's current name are added when the page or email is rendered.
- Member alerts about a recovery never name who asked.
- Notices for a Home disappear (RLS) the moment the person is no longer a member; their overrides for it are deleted.
- The jobs read addresses and secret links only through `service_role`-only functions at send time.
