# S19 · Tasks: recurrence and occurrence history — feature brief

**Branch:** `feat/task-recurrence`, from `main` at `ff041cb` (S18 merged as PR #29).
**Split (Ward, 2026-10-17):** the original S19 is three steps: **S19** recurrence, scopes and history (this brief); **S19b** reminders, templates, bulk actions; **S19c** attachments, task calendar views, task widgets.
**Sources:** build plan S19; PS L2168–L2175 (recurring occurrence history), L2265–L2279 (recurring task/chore edit and delete scopes), L2194–L2264 (labels, assignees, comments, priority, subtasks under recurrence scopes), L2145–L2150 (independent tasks: no dependencies), L780 (departure: future recurring assignments cleared), L632–L633 (Home timezone for recurrence periods), L1247 (Ora's bounded pattern set: daily, weekly, monthly, selected weekdays); ARCH §4, §9, §36; ADR 0022.
**Model:** Opus (scheduling, concurrency and trash interplay across many rows).

**Done when:** recurrence scope tests (this / this and following / entire series) for edit and delete pass, and occurrence-history tests pass.

## Model

- **Series** (`private.task_series`): one context (person or Home), a target list, a template (title, description, priority, labels, assignees, subtask titles, start offset in days before the due date) and a rule. Chain fields `root_id` / `previous_id` link the parts of a split, so history spans the whole series.
- **Rule (default picked):** `daily` / `weekly` (selected ISO weekdays) / `monthly` (the start date's day of month; 29–31 fall back to the month's last day) / `yearly` (the start date's day; 29 Feb falls back to 28 Feb); interval 1–99 ("every N"); ends never, on a date, or after N occurrences (1–999). Weeks for "every N weeks" run Monday–Sunday. Dates only, no times (tasks are date-only), in the Home's timezone or the person's effective timezone.
- **Occurrences are ordinary tasks** with `series_id`, `series_root_id`, `occurrence_date` (the original scheduled date, kept even when the due date is edited) and `detached` (individually changed). Unique `(series_root_id, occurrence_date)`: no duplicates from retries, races or splits. Each occurrence has its own completion, subtasks and comments (S18 rules unchanged).
- **Generation (no background job in S19):** every occurrence up to today exists, plus exactly one upcoming. `public.advance_task_series(context)` runs before task pages read (idempotent, row-locked per series, `on conflict do nothing`, at most 50 series × 100 occurrences per call, the rest next call). A missed occurrence stays open and Overdue; nothing is skipped, shifted or completed automatically. A series never creates occurrences before the day it was created, rescheduled or restored (no back-fill). S19b adds the background advance reminders need.
- **Lists:** archiving or deleting a list that an active series targets is refused (`has_series` with the count), like open tasks in S18.

## Scopes (spec L2265–L2279)

|                                                                                                  | This occurrence                                        | This and following                                                                                                                                              | Entire series                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Edit** content (title, description, priority, labels, start offset), assignees, list, schedule | the occurrence only; it becomes _individually changed_ | the series is split at the occurrence: the old part ends the day before, a new part (same root) starts there with the change; open later occurrences move to it | template and rule change; open occurrences take the change          |
| **Delete**                                                                                       | the occurrence goes to the trash (S18)                 | the series ends the day before; that occurrence and later open ones go to the trash together                                                                    | the series stops; all its open occurrences go to the trash together |

- Always: **completed occurrences are never changed** (read-only history); **individually changed** open ones are kept and listed as kept; schedule changes remove open, untouched upcoming occurrences that are no longer on the schedule (an occurrence with comments or ticked subtasks counts as touched and is kept). Overdue open occurrences of the old schedule stay (missed history).
- Schedule edits are offered only with _this and following_ or _entire series_. Subtask template changes apply to occurrences created afterwards (existing checklists are never rewritten).
- **Impact preview:** the same database function runs in dry-run mode (changes rolled back, impact returned), so the preview and the change cannot disagree: occurrences updated, kept (individually changed), removed (off schedule), completed (unchanged) and the next five dates. The change re-checks permissions, the series and occurrence revisions, list state and membership at confirmation.
- **Pause / resume / end:** pause stops creation (resume continues from today, no back-fill); "end" sets an end date through the schedule edit.
- **Trash:** a _following_ or _entire_ delete is one trash entry (module `tasks`, item type `task_series_removal`) holding the removed occurrences and the previous end. Restore conflicts: `series_changed` (edited, split or removed again since) with resolution `restore_tasks_only`; `list_unavailable` with `move_to_list:<id>`. Restore never back-fills missed dates. Purging an _entire_ removal removes the series definition; completed occurrences stay as completed tasks.

## Permissions (default, mirrors S18)

| Action                                            | Who                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Create a recurring task                           | any current member (assignees: task managers)                                    |
| Edit / complete _this occurrence_                 | the S18 task rule (creator, assignees, task managers)                            |
| Edit _following_ / _entire series_, pause, resume | the series' creator, task managers                                               |
| Change series assignees (any scope)               | task managers                                                                    |
| Delete _this occurrence_                          | the S18 rule (creator, task managers)                                            |
| Delete _following_ / _entire series_              | the series' creator, task managers                                               |
| See history                                       | whoever sees the occurrence                                                      |
| Restore / purge a series removal                  | S16 generic rule (who deleted it while a member; Owner and `manageHomeSettings`) |

Personal: its owner only. Departure: series assignments end with the membership (spec L780), the series and its open occurrences are flagged _Needs reassignment_, completed attribution stays.

## Occurrence history (spec L2168–L2175)

Per series chain, newest first, 50 per page with "Show more", filter all / completed / missed. Each row: scheduled date, status (**Completed**, **Completed late** — completed after the due date in the context's timezone, **Missed — still open** for an overdue open occurrence, **Due today**), actual completion time and the actual completer (one per occurrence; a former member reads as "a former member"), link to the occurrence. Future occurrences are never listed. A reopened occurrence shows its current state. Skipped does not exist for tasks (chores only).

## Interface

- New task form: **Repeats** (Does not repeat / Daily / Weekly / Monthly / Yearly), Every N, weekdays (weekly), Ends (never / on date / after N); due date required when repeating, used as the first date; a plain-language summary and the next three dates.
- Occurrence page: a **Repeats** section (summary, next date, paused/ended, Pause/Resume, Edit schedule, History link and section). Saving content or assignees on an occurrence asks for the scope in a dialog with the impact preview; Delete asks for the scope with the preview. Lists and All Tasks mark recurring rows ("Repeats", text plus icon, never colour alone).
- Trash shows series removals with their own label and conflict choices. nl and en. Keyboard and screen-reader access, focus kept on purpose after each dialog.

## API

`POST /api/v1/tasks` accepts an optional `recurrence`; `POST /api/v1/tasks/:id/series` `{ scope, expectedTaskRevision, expectedSeriesRevision, content?, assigneeIds?, schedule?, dryRun }`; `POST /api/v1/tasks/:id/series/delete` `{ scope, expectedSeriesRevision, dryRun }`; `PUT /api/v1/tasks/:id/series/paused` `{ paused, expectedSeriesRevision }`; `GET /api/v1/tasks/:id/occurrences?filter&offset`. Same CSRF, JSON, size and session checks as S18.

## Tests

- **Unit:** rule math in TypeScript (daily/weekly/monthly/yearly, intervals, 29–31 and leap days, ends) with a shared vector file the database test also runs; schemas; routes (CSRF, unauthenticated, invalid, conflict, not found, scopes, dry run); components with axe (repeat fields, scope dialog with preview, history, pause).
- **Database:** creation and generation (up to today plus one, no back-fill, catch-up cap, Home timezone today boundary, personal today window); edit scopes this / following / entire (completed untouched, detached kept, off-schedule removal, split chain, no duplicates); delete scopes and trash restore (with `series_changed` and `list_unavailable`) and purge; pause/resume; list archive/delete refused; permission matrix across two Homes and three roles; departure clears series assignees; history statuses, ordering, paging and isolation.
- **Concurrency (two connections):** two advances at once create each occurrence once; series edit vs occurrence edit; delete-following vs completion.
- **Playwright:** create a weekly task, complete this week's, edit _this and following_ with preview, delete _entire series_ and restore from the trash, history shows completed and missed; axe and keyboard in both themes.

## Out of scope (S19b / S19c and later)

Reminders, templates, bulk actions (S19b); attachments, task calendar views, task widgets (S19c); converting an existing one-off task into a series; custom rules beyond the four patterns (nth weekday of month, multiple dates); history corrections beyond normal reopen; Realtime.

## Defaults picked (Ward may override)

1. The rule set and fall-backs above; Monday-based weeks for "every N weeks".
2. No back-fill on create, reschedule, resume or restore; catch-up cap 50 series × 100 occurrences per page load.
3. Series edit/delete rights: series creator and task managers.
4. Subtask template edits apply only to occurrences created afterwards.
5. Limits: 200 active series per context; interval 1–99; after N: 1–999.
6. "Completed late" uses the context timezone (Home timezone, or the viewer's effective timezone for Personal).

## Progress

- [x] Brief
- [x] Migration, domain rule math, engine actions (`20261027090000_task_recurrence.sql`, `packages/domain/src/tasks`)
- [x] API, data layer (series, series/delete, series/paused, occurrences routes; `advanceSeries` before reads)
- [x] Interface (repeat fields, scope dialog with dry-run preview, Repeats section with history, delete scopes, "Repeats" row mark with `RepeatIcon`, trash labels; en and nl)
- [x] Tests written: domain, db (scopes, history, trash, rights), concurrency, vectors, routes, components with axe, Playwright `task-recurrence.spec.ts`
- [x] Docs: ADR 0023, docs/development.md Tasks, docs/supabase-migrations.md Check S19
- [x] Full suite green; independent review (reviews/steps/S19-review.md): CHANGES_REQUIRED with 2 HIGH (reschedule to a later start; "this and following" before a part's start). Both fixed with db tests that fail without the fix; M1 deadlock fixed (head locked first, concurrency test); completed occurrences no longer offer "this and following"; full suite re-run green
