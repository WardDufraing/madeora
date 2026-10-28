# S19b · Tasks: reminders, templates and bulk actions — feature brief

**Branch:** `feat/task-reminders-templates-bulk`, from `main` at `f2960f2` (S19 merged as PR #30; S14 notifications merged as PR #24). Depends on S19 and S14, both merged.
**Sources:** build plan S19b; PS L2186–L2192 (individual task reminders), L2135–L2143 (reusable task templates), L2159–L2166 (basic bulk task actions), L2145–L2150 (independent tasks), L301–L309 (notification defaults, categories, quiet hours); ARCH §11, §39; ADR 0017, 0018, 0022, 0023. No other spec ranges read.
**Model:** Opus (timed delivery through jobs, dedup, DST and recurrence scopes).

**Done when:** reminder dedup and quiet-hours tests pass, template tests pass, bulk partial-failure tests pass.

## 1. Reminders (spec "Confirmed individual task reminders")

**Model.** At most one reminder per task (`private.task_reminders`, keyed by task). Two modes:

- **At a date and time** (`absolute`): a wall-clock date and time in a stated zone, stored as the instant.
- **Before the due date** (`relative`): _N days before the due date (0–30) at HH:MM_. Tasks are date-only, so the person always picks the time of day (pre-filled 09:00, never inferred); "on the due day at 09:00" is 0 days. Needs a due date.
- **Zone:** a Home task uses the Home's timezone (every recipient gets the same instant). A Personal task uses the person's effective timezone, taken by the server (never from the request body) and stored with the reminder.
- **DST (one rule, server-side only):** a time that does not exist that day (spring-forward gap) moves forward by the gap (02:30 becomes 03:30); a time that happens twice (fall-back) uses the second one, standard time. This is PostgreSQL's own rule; the editor's preview comes from the server, so the shown time and the delivery time cannot differ, and the preview says when either case applied.
- **Validation:** the resolved time must be in the future (`reminder_in_past`); relative needs a due date (`needs_due_date`). Completed tasks cannot get a new reminder.

**Delivery (no new infrastructure).** Setting or changing a reminder bumps its revision and enqueues the job `task-reminder` in the S13 outbox with `available_at` = the reminder time and key `task-reminder:<task>:<revision>`. The 5-minute dispatcher runs it; the job calls `deliver_task_reminder(task, revision)` (service role only), which re-checks everything in SQL at delivery: task exists, not deleted, not completed, the revision is current, the time has come, the reminder is not waiting for review. An older revision's job finds a newer revision and does nothing.

- **Recipients (default):** a Personal task's owner; a Home task's current assignees at delivery time; with no assignees, the member who set the reminder (if still a member). The editor says who will be reminded.
- **Notification:** `private.notify_user` with new optional category **`reminders`** (in-app on, email off by default; per-Home overrides and quiet hours as S14). Dedupe key `task-reminder:<task>:<revision>` per person, so retries, a duplicate job or a re-run deliver once. In-app shows the task title, read at display time only if the reader can still see the task (else "a task"); the email names no task title (lock screens and shared devices), only the Home and the due date, with a link.
- **Quiet hours:** in-app appears at once (marked), optional email waits to the end of the window (existing S14 behaviour, tested here).
- **Latency:** up to 5 minutes after the time (the dispatcher's interval). The editor says "around".
- **Cancellation is checked at delivery:** completion, deletion, list archiving, unassignment, leaving the Home, revoked access. A task reopened or restored before the time still reminds; one restored after the time does not (no catch-up).
- **Due date changed or removed** on a task with a before-due reminder: the reminder goes to **Needs review** (not delivered). The task page shows the new time it would move to, with **Move with the due date** or **Remove**. The edit form warns before saving.
- **Channel state:** the editor shows "You'll be reminded in the app [and by email]" from the person's effective choice for this context, or a warning that reminders are switched off in their notification settings (with a link).

**Recurring tasks (scopes).** A series has an optional reminder template (before-due only: an absolute time makes no sense for a series), stored per chain so S19 splits keep it. Every new occurrence gets its own reminder from the template. Changing the reminder on an occurrence asks for the scope:

- **This occurrence:** only this one; it is then marked as having its own reminder and later series changes keep it.
- **This and following:** the template, plus open occurrences from this date on that do not have their own reminder.
- **Entire series:** the template, plus every open occurrence without its own reminder.
  Completed occurrences are never touched. The scope dialog shows the impact (changed, kept, completed) from the same function in dry-run mode (S19 pattern). Each occurrence has at most one reminder per revision.
- **Occurrences must exist before their reminder:** with a reminder template, the series creates occurrences up to _today + days before + 1_ (not only one upcoming). A scheduled Trigger.dev task, `task-reminder-advance`, runs hourly and advances only series with a reminder template (about 720 runs a month, within the free plan; recorded in ADR). Page loads keep advancing as in S19.

## 2. Templates (spec "Confirmed reusable task templates")

- `private.task_templates`, owned by one Personal space or Home: name (≤ 60, unique per context, same "confusing duplicate" key as lists), title (≤ 200), description (≤ 5,000), priority, label ids, ordered subtask titles (≤ 100), revision. Limit 100 templates per context.
- **Library** at `…/tasks/templates`: list, create, edit, delete (with confirmation). **Save as template** on a task page (prefilled from the task: title, description, priority, labels, subtask titles; never dates, assignees, comments, completion, reminders or recurrence). **Create from template** in New task: pick a template, get an editable preview (title, description, priority, labels, checklist, list, optional dates), choose the destination list, create.
- **Creation is one transaction** (`create_task_from_template`): the task and its whole checklist, all incomplete, with a client id, so a retry or double submit returns `exists` and never a second task or half a checklist. Rechecks at confirm: template revision (`template_changed`), list usable, labels valid, permission.
- **Missing labels:** label ids are kept on the template without a foreign key; a deleted label is left out and the preview says "1 label no longer exists and was left out".
- **Deletion** removes the template only; tasks made from it are untouched. Default: no trash for templates (direct delete after confirmation; the spec's "where applicable").
- **Permissions (default; the spec leaves template permissions open):** every current member sees and uses the Home's templates; **task managers** (Owner, `manageHomeTasks`) create, edit and delete them, because templates belong to the Home, not to a member. Personal templates: the owner only. Leaving the Home removes access, not the templates.

## 3. Bulk actions (spec "Confirmed basic bulk task actions")

- On a list or All Tasks: a **Select** mode with a checkbox per visible row, **Select all shown (N)**, a count, **Clear**, and an action chooser: **Complete**, **Priority**, **Labels** (add / remove / replace, clearly separate), **Move to list** (active lists of the same context only). At most 100 tasks at a time. Only loaded, visible rows can be selected; changing filters clears the selection.
- **Preview** (same function, dry run): per task whether it will change, is unchanged, or is excluded and why (no permission, completed, list unavailable, too many labels, changed since). Warnings: tasks with unfinished subtasks (completed anyway, explicit parent completion), shared completion for multi-assignee tasks, recurring occurrences (only this occurrence changes; never the series).
- **Execution** (`bulk_update_tasks`): each task in its own sub-transaction with the S18/S19 per-task rules (`can_edit_task`, list usable, labels of the context, revision from the preview). Results per task: `changed`, `unchanged` (already in that state, e.g. already completed: no second completion event), `conflict` (changed since the preview, nothing overwritten), `not_permitted`, `not_found`, `list_unavailable`, `too_many_labels`. A summary never calls a partial result complete. **Retry** of the same request is safe: tasks already in the target state answer `unchanged`.
- Recurring occurrences: complete completes that occurrence only; priority, labels and move change that occurrence only and mark it individually changed (S19 rule).

## Permissions summary

| Action                                                  | Who                                                   |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Set, change, remove a task's reminder (this occurrence) | task editors (S18: creator, assignees, task managers) |
| Series reminder (following / entire)                    | series creator, task managers (S19 `can_edit_series`) |
| Use templates                                           | any current member                                    |
| Create, edit, delete Home templates                     | task managers                                         |
| Bulk actions                                            | per task, the S18 edit rule                           |

## API (same CSRF, JSON, size and session checks as S18)

`PUT /api/v1/tasks/:id/reminder` `{ scope?, mode, at?, daysBefore?, time?, expectedRevision, dryRun }`, `DELETE` same with scope; `POST /api/v1/tasks/:id/reminder/review` `{ choice: follow|remove }`; `GET|POST /api/v1/task-templates`, `PATCH|DELETE /api/v1/task-templates/:id`; `POST /api/v1/task-templates/:id/tasks` (create from template); `POST /api/v1/tasks/bulk` `{ homeId?, taskIds, action, …, expectedRevisions, dryRun }`.

## Tests

- **Database:** reminder set/change/remove, both modes, DST gap and overlap, past time refused, needs-review on due change/removal, deliver re-checks (completed, deleted, unassigned, left Home, stale revision, not yet due), recipients (personal, assignees, unassigned fallback), dedup on repeated delivery, quiet hours defer email only, category preferences and Home override, series scopes this/following/entire with completed untouched and own reminders kept, horizon creates occurrences before their reminder, background advance; templates CRUD, name rules, permissions across two Homes and roles, departure, create-from-template atomic and idempotent, stale template, missing label, archived list; bulk per action, mixed permissions, partial failure, retry `unchanged`, conflict, cross-context refusal, recurring occurrence only.
- **Concurrency (two connections):** two deliveries of one reminder notify once; bulk complete racing a single completion records one completion.
- **Unit:** schemas, routes (CSRF, unauthenticated, invalid, outcomes), the job (`task-reminder`) with fakes, components with axe (reminder editor, scope dialog, template library and preview, bulk bar, preview and results).
- **Playwright:** set a reminder and see its delivery after running due jobs; save a task as a template and create from it; bulk-complete and bulk-move with one excluded task; keyboard and axe in both themes.

## Out of scope

Attachments, task calendar views, task widgets (S19c); multiple reminders per task, snooze, overdue escalation (spec excludes); bulk assignment, scheduling, deletion (spec excludes); push channel; Realtime.

## Defaults picked (Ward may override)

1. One reminder per task; before-due reminders 0–30 days before at a chosen time (09:00 pre-filled); series reminders before-due only.
2. Recipients: assignees, else whoever set the reminder; Personal: the owner.
3. New optional notification category `reminders` (in-app on, email off). Email without the task title.
4. DST rule: gap moves forward, repeated hour uses the second (standard-time) instance.
5. Delivery up to 5 minutes late (dispatcher interval); hourly background advance for series with reminders.
6. Templates: task managers manage Home templates, everyone uses them; no trash for templates; limit 100 per context.
7. Bulk: 100 tasks per action; occurrences changed individually.
8. (Added while building.) The reminder editor pre-fills 1 day before at 09:00 (relative) or today at 09:00 (absolute); the template checklist is typed one item per line; the Templates link is shown to every member; selection mode stays on after a bulk action, with the selection cleared.

## Progress

- [x] Brief
- [x] Migration and domain logic (`20261028090000_task_reminders_templates_bulk.sql`, `packages/domain` notifications)
- [x] Job and API (`task-reminder`, hourly `task-reminder-advance`; reminder, template and bulk routes)
- [x] Interface (reminder section and scope dialog, template library, save as template, from a template, bulk bar and preview/result dialog; en and nl)
- [x] Tests (db: `task-reminders.test.sql`, `task-reminders-concurrency.test.ts`, `task-templates-bulk.test.sql`; unit: routes 45, components 15, jobs, email, domain; e2e: `task-reminders-templates-bulk.spec.ts`, 6 passing)
- [x] Docs (ADR 0024, supabase-migrations, background-jobs, trigger-setup, notifications, development, provider-cost-register)
- [x] Full suite (logs in `wip/S19b/`): format, lint, typecheck, unit, build, boundary, db fallback, e2e fallback (146) all green. One existing recurrence e2e locator made exact (`Save` vs the new `Save as template`).
- [x] Independent review (`reviews/steps/S19b-review.md`): CHANGES_REQUIRED, one BLOCKER, no HIGH. B1 (an on-hold or switched-off reminder broke the task page; the view schema required `mode`, `timeZone` and `fireAt`) is fixed: fields nullable in `reminder-data.ts` and `TaskReminder`, the summary shows "on hold" without a time, plus a route test of both real shapes, a component test for "off", and a Playwright test of the due-date-change review flow. Verified: web unit 62/62 for the S19b files, tsc and eslint clean, reminder and recurrence e2e 10/10 (`wip/S19b/e2e-fix.log`).
- Open MEDIUM, not fixed (for Ward): M1 bulk per-task rollback untested; M2 DB DST tests use fixed 2027 dates and will start failing once those pass; M3 no automated contract check between `get_task_reminder` and the app schema.
