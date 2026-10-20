# ADR 0023: Recurring tasks: series of ordinary tasks, created lazily, changed by scope

- **Status:** Accepted for S19 within the approved architecture (§4, §9, §36), CLAUDE.md (database access A, authorization C, data fetching B, forms A, frontend B, date/time A, icons C, €0 budget) and the spec's recurring task requirements (edit scopes "this occurrence", "this and following", "entire series" with an impact preview; pause, resume and end; occurrence history with scheduled date, status and the actual completer). The defaults below are open to correction by the owner.
- **Date:** 2026-10-20
- **Step:** S19 (brief: `plans/steps/S19-brief.md`). The owner split the original S19 into S19 (this), S19b (reminders, templates, bulk actions) and S19c (attachments, calendar views, task widgets) on 17 October 2026. Builds on S18 (tasks core, ADR 0022) and S16 (trash, ADR 0020).

## Context

A task can repeat daily, weekly, monthly or yearly. Each occurrence must behave like an ordinary task (complete, assign, comment, subtasks, trash), keep its own history, and never be changed behind the person's back: completed occurrences stay as they were, and one changed on its own stays changed. A change or a removal applies to this occurrence, this and following ones, or the entire series, and the person sees what it will do before confirming.

## Decision

**Occurrences are tasks.** One migration (`20261027090000_task_recurrence.sql`) adds `private.task_series` with its labels, assignees and checklist template, and gives `private.tasks` `series_id`, `series_root_id`, `occurrence_date` and `detached`. A unique index on `(series_root_id, occurrence_date)` makes each scheduled date exist at most once. All S18 functions keep working on occurrences unchanged; `update_task`, `set_task_assignees` and `move_task` mark an occurrence `detached` (changed on its own).

**A series is a chain of parts.** "This and following" splits the series: the current part ends before the chosen occurrence and a new part (same `root_id`) starts there, keeping the rhythm's anchor date (`starts_on`) and recording `active_from`. Only the head (the part not superseded) creates occurrences. "Entire series" changes the head in place and every open, not detached occurrence of the chain.

**Lazy generation.** No scheduled job: `public.advance_task_series(home, today)` runs before the task pages read, and creates every occurrence due up to today plus the next upcoming one, at most 50 series and 100 occurrences per series per call. It is idempotent and safe under concurrency (head row lock plus the unique index; two-connection test). Every series-wide change locks the series head before the occurrence it starts from, then the open occurrences in id order, so two such changes queue instead of deadlocking. Creating, rescheduling, resuming and restoring never back-fill dates that passed.

**Rules, in both languages.** Daily every N days; weekly on chosen ISO weekdays every N Monday-based weeks; monthly on the start's day of the month (the month's last day for 29–31); yearly on the start's month and day (28 February for 29 February). Interval 1–99; it ends never, on a date, or after 1–999 occurrences. `private.series_first_on_or_after` decides which dates exist; `packages/domain/src/tasks/recurrence.ts` describes and previews them. A shared vector file is run against both (`recurrence-vectors.json`), and the TypeScript is also checked against a day-by-day definition on 600 generated cases.

**Scopes and the impact preview.** `update_task_series` and `delete_task_series` take `p_dry_run`: the same work runs inside a subtransaction that is then rolled back (SQLSTATE `MD001`), and the computed impact is returned. So the preview and the change can never disagree. The impact counts occurrences changed, kept because detached, removed because no longer on the schedule, and completed (never touched), plus the next dates. "This occurrence" is the S18 request for one task. A changed due date applies only to this occurrence; the schedule is changed with Edit schedule (scopes following or entire series). A stale task or series revision answers `conflict` and changes nothing.

**Rights (default, owner may override).** Editing, pausing and deleting the series: its creator and task managers (`manageHomeTasks`, the Owner). Series assignees: task managers only. A single occurrence follows the S18 task rules. `decideSeriesAction` in `packages/domain` and `private.can_edit_series` decide the same.

**Trash.** Removing following or all occurrences is one trash entry of item type `task_series_removal` (`private.task_series_removals`), and ends the schedule there. Restoring it brings the occurrences back and the schedule as it was. If the series changed since, the conflict `series_changed` offers `restore_tasks_only`; a removed occurrence's list that is gone offers `move_to_list:<id>`. Purging an entire-series removal deletes the chain; completed occurrences stay as plain completed tasks.

**History.** `list_task_occurrences` pages the chain newest first (50 a time) with the scheduled date, status (completed, completed late, missed, open) and the actual completer. "Late" and "missed" use the context's timezone (the Home's, or the person's effective timezone for Personal). Trashed occurrences are left out.

**Lists.** Archiving or deleting a list a live series creates occurrences into answers `has_series` with the count, so a schedule never points at an unusable list. A departed member is removed from series assignees and the series is flagged as needing reassignment.

**Interface.** The new-task form gains Repeats (frequency, interval, weekdays, ends) with a plain-language summary and the next three dates. An occurrence's page gains a Repeats section (summary, next date, paused or ended, Pause/Resume, Edit schedule, history with filters and "Show more"). Saving content or assignees, moving to another list, and deleting ask for the scope in a dialog with the server's preview. Rows of recurring tasks show "Repeats" in text with the new `RepeatIcon`. Everything is in `en` and `nl`.

## Defaults chosen (owner may correct)

1. The rule set and fall-backs above; Monday-based weeks for "every N weeks".
2. No back-fill on create, reschedule, resume or restore; catch-up cap 50 series × 100 occurrences per page load.
3. Series edit and delete rights: the series' creator and task managers.
4. Checklist template changes ("also give new occurrences these subtasks") apply only to occurrences created afterwards.
5. Limits: 200 active series per context; interval 1–99; after N: 1–999; start date at most 365 days before the due date.
6. "Completed late" uses the context's timezone.

## Consequences

- Reminders (S19b) can read `occurrence_date`/`due_date` of ordinary tasks; templates (S19b) can reuse the series template tables' shape.
- Lazy generation means a series no one opens creates nothing; widgets and notifications that need occurrences must call `advance_task_series` first or move generation to a Trigger.dev job later.
- The migration redefines `update_task`, `set_task_assignees`, `move_task`, `update_task_list`, `delete_task_list`, `get_task`, `list_tasks` (dropped and recreated with a `recurring` column) and the four trash dispatch functions. It must be applied to `madeora-preview` and `madeora-production` before code that uses it runs there (`docs/supabase-migrations.md`).
