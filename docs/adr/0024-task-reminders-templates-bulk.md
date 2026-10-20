# ADR 0024: Task reminders, templates and bulk actions

- **Status:** Accepted for S19b within the approved architecture (§4, §9, §11, §36, §39), CLAUDE.md (database access A, authorization C, background processing B, data fetching B, forms A, frontend B, date/time A, €0 budget) and the spec's individual task reminders, reusable task templates and basic bulk task actions. The defaults below are open to correction by the owner.
- **Date:** 2026-10-20
- **Step:** S19b (brief: `plans/steps/S19b-brief.md`). Builds on S13 (outbox, ADR 0017), S14 (notifications, ADR 0018), S18 (tasks, ADR 0022) and S19 (recurring tasks, ADR 0023).

## Context

A person can be reminded of a task once, at a moment they choose; a series of repeating tasks can carry a reminder for every occurrence. A reminder must arrive once, at the right wall-clock time across daylight-saving changes, and never for a task that is done, gone or no longer theirs. Templates let people reuse task content; bulk actions change many tasks at once and must say exactly what happened to each.

## Decision

**One migration** (`20261028090000_task_reminders_templates_bulk.sql`) adds `private.task_reminders` (at most one per task), `private.task_series_reminders` (one template per series chain), `private.task_templates`, the reminder, template and bulk functions, and the notification category `reminders`.

**Reminders.** Two modes: at a wall-clock date and time, or N days (0–30) before the due date at a chosen time. Tasks are date-only, so the time is always the person's choice. A Home task uses the Home's timezone; a Personal task the person's effective timezone, which the server reads (never the request body). The relative mode needs a due date; the resolved moment must be in the future; a completed task gets no new reminder.

**DST, one rule, on the server.** PostgreSQL turns the wall-clock time into an instant: a time inside a spring-forward gap moves forward by the gap, a repeated time is the later (standard-time) one. The editor's preview is the same function in dry-run mode, so the shown and delivered moments cannot differ, and it says when either case applied.

**Delivery through the S13 outbox, no new infrastructure.** Every change bumps the reminder's revision and enqueues the job `task-reminder` with `available_at` = the reminder time and key `task-reminder:<task>:<revision>`. The 5-minute dispatcher runs it (up to 5 minutes late; the editor says "around"). The job calls `deliver_task_reminder(task, revision)` (service role only), which locks the task and reminder and re-checks everything: current revision, scheduled, time has come, task not deleted or completed, recipients still members. Recipients: a Personal task's owner; a Home task's current assignees, or with none the member who set it. It notifies through `private.notify_user` with a per-revision dedupe key, so a duplicate job, a retry or two concurrent deliveries notify once (two-connection test). Preferences, Home overrides and quiet hours are the S14 ones: the category is optional, in-app on and email off by default, and quiet hours delay only the email.

**Privacy.** The in-app notice reads the task title at display time and only if the reader can still see the task (`task_reminder_titles`); otherwise "a task". The email never names the task, only the Home (or "your personal space") and the due date.

**Due date changes.** A before-due reminder whose task's due date changes or is removed goes on hold (`needs_review`, not delivered); the task page shows where it would move and offers "Move with the due date" or "Remove". The edit form warns before saving.

**Recurring series.** A series' reminder is before-due only and copied onto every new occurrence. Setting it from an occurrence takes the S19 scopes: this occurrence (marked as its own, kept by later series changes), this and following, or the entire series; completed occurrences are never touched. The scope dialog shows the impact from the same function in dry-run mode. A series with a reminder creates occurrences up to today + days before + 1, so each exists before its reminder is due, and the hourly Trigger.dev schedule `task-reminder-advance` calls `advance_reminder_series(200)` for series nobody opens.

**Templates.** Owned by a Personal space or a Home: name (≤ 60, unique per context with the list-name comparison), title, description, priority, label ids (no foreign key; a deleted label is left out and the preview says so) and an ordered checklist (≤ 100). At most 100 per context. A library page, "Save as template" on a task page (title, description, priority, labels, checklist only) and "From a template" in New task with an editable preview. `create_task_from_template` creates the task and its whole checklist in one transaction with a client id (a retry returns `exists`), and answers `template_changed` when the template changed since the preview.

**Bulk actions.** Select mode on a task list: a checkbox per shown row, "Select all shown", at most 100 tasks; complete, priority, labels (add, remove or replace, kept apart) and move to an active list of the same context. `bulk_update_tasks` runs each task in its own sub-transaction under the S18 per-task rules and returns a result per task (`changed`, `unchanged`, `conflict`, `not_permitted`, `not_found`, `list_unavailable`, `invalid_label`, `too_many_labels`). The same function in dry-run mode gives the preview and warnings (unfinished checklist, shared completion, recurring occurrence); applying sends the revisions from the preview, so a task changed in between is left out as `conflict`, and the result says "Partly done" rather than calling it complete. A repeated request answers `unchanged` for tasks already done. A recurring occurrence changes only itself.

## Defaults chosen (owner may correct)

1. One reminder per task; before-due 0–30 days at a chosen time; series reminders before-due only.
2. The editor pre-fills 1 day before at 09:00 (relative) or today at 09:00 (absolute); the person always confirms.
3. Recipients: assignees, else whoever set it; Personal: the owner.
4. Category `reminders`: optional, in-app on, email off; the email names no task.
5. Delivery up to 5 minutes late; hourly background advance of series with a reminder.
6. Templates: task managers (Owner, `manageHomeTasks`) manage Home templates, every member uses them, the library link is shown to every member; Personal templates: the owner. No trash for templates. The checklist is typed one item per line.
7. Bulk: at most 100 tasks; selection stays on after an action (cleared), and changes with the filters.

## Cost

`task-reminder-advance` runs every hour, about 720 short runs a month, and each reminder adds one short `task-reminder` run to the existing 5-minute dispatcher. Both stay far within Trigger.dev's Free plan (`docs/provider-cost-register.md`). Nothing else is added; €0.

## Consequences

- The migration redefines `advance_task_series` (reminder horizon) and the notification settings functions (new category). It must be applied to `madeora-preview` and `madeora-production` before code that uses it runs there, and the Trigger.dev tasks deployed with it (`docs/supabase-migrations.md`, `docs/background-jobs.md`).
- Snooze, several reminders per task, overdue escalation, bulk assignment, scheduling and deletion stay out (spec).
