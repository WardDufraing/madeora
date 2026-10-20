# S19 independent review: recurring tasks, scopes and occurrence history

- Branch: `feat/task-recurrence` (working tree, uncommitted; base `ff041cb`)
- Diff reviewed: `/mnt/project-files/wip/S19/S19.diff`. It matches the working tree except for the brief file.
- Reviewer: independent agent with fresh context. This is not a GitHub human approval.
- Date: 2026-10-20

## Verdict: CHANGES_REQUIRED

There are two HIGH findings. Both are confirmed by reproduction against the dev Postgres, inside transactions that were rolled back.

Normal "Edit schedule", split and delete-following paths fail with a database check-constraint violation. The user sees a generic 400 "invalid" error. The existing tests pass only because every schedule edit in them uses a start date of today or earlier.

---

## Findings

### HIGH-1: Moving a schedule's "Repeats from" date later than the next pending date always fails

- **Where:** `supabase/migrations/20261027090000_task_recurrence.sql:840-862` (the template update writes `starts_on = p_starts_on` while `next_date` still holds the old value). For the `following` scope, lines 795-807 copy `h.next_date` into the new head first. The constraint is `task_series_next_check` (`next_date >= starts_on`, line 114). `next_date` is recomputed only afterwards (line 919).
- **Path (reproduced):**
  1. A Home daily series has occurrences up to today plus tomorrow, with `next_date` = today+2.
  2. A manager uses Edit schedule (the "Repeats from" field in `task-repeats.tsx` ScheduleForm) and sets it to today+3, for example "from next month" or "weekly from next Monday".
  3. Choosing "All occurrences", or "This and following", returns `ERROR: new row for relation "task_series" violates check constraint "task_series_next_check"` (SQLSTATE 23514).
  4. `databaseFailure` maps that to `400 invalid`.
- **Impact:** The dry-run preview fails as well, so the scope dialog shows an error and Save stays disabled. Rescheduling a repeat to start later is a core spec "changed schedule" case, and it is impossible. The brief's "schedule edits" acceptance criterion is not met.
- **Fix:**
  - In the same UPDATE that writes the new rule, set `next_date` to null, or to its recomputed value. The `following` insert should do the same.
  - Then compute `next_date` and `last_date` as now.
  - Add DB tests for a schedule edit whose `starts_on` is after the current `next_date`, for both scopes and in dry-run mode.

### HIGH-2: "This and following" (edit or delete) from an occurrence dated before the head's anchor violates `task_series_until_check`

- **Where:**
  - Split: `...task_recurrence.sql:814-818` sets `until_date = v_boundary - 1` on the old head.
  - Delete following: `...task_recurrence.sql:1057-1060`.
  - Constraint: `task_series_until_check` (`until_date >= starts_on - 1`, line 113).
- **Path (reproduced):**
  1. A daily series has open occurrences on today-3 … today.
  2. An "All occurrences" schedule edit sets "Repeats from" to the current `next_date` (today+2). This succeeds: the overdue open occurrences stay on the head as missed history, as designed.
  3. On the today-2 occurrence, either "This and following" content edit or "This and following" delete raises 23514 and returns `400 invalid`.
  4. The UI still offers "This and following" for this occurrence, because `inHead` is true.
- **Impact:** After a reschedule, the following scopes are broken for every overdue occurrence that remains. The done-condition ("recurrence scope tests for edit and delete pass") holds only for the tested shapes.
- **Fix:**
  - Choose one of these:
    - when the boundary is before the head's `starts_on`, treat it as the head itself (clamp `until_date` to `starts_on - 1` and supersede the head); or
    - return `scope_unavailable` for occurrences before the head's anchor, and hide the option in the UI.
  - Relax the constraint only if the semantics are documented.
  - Add DB tests for split and for delete-following after a forward reschedule.

### MEDIUM-1: Two series-scope operations started from different occurrences of one series can deadlock

- **Where:**
  - `update_task_series` (`:734` `lock_task`, `:743` `lock_series_head`, `:867-872` FOR UPDATE over every open occurrence).
  - `delete_task_series` (`:997`, `:1006`, `:1031-1037`).
  - `set_task_series_paused` (`:1092`, `:1097`).
- **Path:**
  1. T1 (series edit or delete from occurrence A) locks A, then the head.
  2. T2 (series edit, delete or pause from occurrence B) locks B, then waits for the head.
  3. T1's occurrence loop then waits for B. Neither can proceed.
- **Notes:**
  - The dry-run preview takes the same locks, and it fires automatically when the scope dialog opens. Two managers opening dialogs at the same moment are enough.
  - Postgres aborts one transaction with 40P01. `databaseFailure` maps that to 500 "failed".
  - The concurrency suite covers only series-vs-occurrence-edit and delete-vs-completion. Series-vs-series is not covered.
  - I found this by tracing lock order. I did not reproduce it, because that needs committed data in a shared DB.
- **Impact:** Spurious 500s under concurrent use. No data corruption, since one transaction is rolled back.
- **Fix:**
  - Lock the chain head first in all of these functions: read `series_root_id` without a lock, lock the head, then `lock_task` and re-check. Alternatively, take `pg_advisory_xact_lock` on the root id before any row lock.
  - Map 40P01 to a retryable 409.
  - Add a two-connection test for series edit vs series delete or pause.

### MEDIUM-2: A series cannot be ended now through the schedule edit

- **Where:** `...task_recurrence.sql:917-922`. With `p_set_schedule`, a `series_next(v_target, v_today)` result of null raises MD002, and the API answers `409 schedule-ended`.
- **Path (reproduced):**
  1. Daily every-3-days series: last occurrence yesterday, upcoming at today+2.
  2. Edit schedule with Ends "on a date" = today. The outcome is `ended` and the change is refused.
- **Impact:** The brief says "end sets an end date through the schedule edit", and the spec requires that pause/end keeps history. A person can only "end" a repeat by choosing an end date on or after the next scheduled date, which still creates that occurrence. The alternative is a delete, which trashes the upcoming occurrence. The UI error text ("Choose another end or start date") does not explain this.
- **Fix:** For updates, allow `next_date = null`, meaning ended. Keep refusing only on create, or when the change would leave the series with no dates at all. Untouched upcoming occurrences after the new end are already removed by the loop. Add tests.

### MEDIUM-3: No way in the UI to change a series' list, yet lists in use by a series cannot be archived or deleted

- **Where:**
  - `apps/web/src/components/tasks/task-actions.tsx` `TaskMove`: it moves only the one occurrence with S18 `move_task`, which marks it detached, and shows no scope dialog.
  - No component sends `listId` to `POST /tasks/:id/series`.
  - `en.json:1565` `errorHasSeries`: "Move or delete its repeat first".
- **Impact:**
  - The brief's scope table lists the list under Edit for all three scopes.
  - Spec L2206/L2210 require moving tasks "with full metadata and recurring occurrences".
  - A person told to "move its repeat" cannot do it. Their only options are to delete the series, or to end it and wait.
  - The API and SQL support it (`p_list_id`), but nothing exposes it.
- **Fix:** Route moves of an occurrence through the scope dialog, with "this" calling `move_task` and the series scopes sending `listId`. Alternatively, change the error copy and record the gap as an owner decision.

### LOW-1: The "Next dates" preview in the repeat fields counts from the anchor, not from today

- **Where:** `apps/web/src/components/tasks/repeat-fields.tsx:241` (`upcomingDates(rule, rule.startsOn, 3)`).
- **Impact:** In Edit schedule, "Repeats from" defaults to `series.startsOn`, which may be months old, so the "Next dates" shown are in the past. On create with a past due date, no back-fill happens, so the dates shown are never created. The server-side scope preview is correct.
- **Fix:** Use `max(startsOn, today)`.

### LOW-2: History status labels differ from the brief

- **Where:** `en.json:1562-1563`, and the nl equivalents.
- **Impact:** The labels are "Missed" and "Open"; the brief specifies "Missed — still open" and "Due today". Spec L2169/L2172 ask not to conflate an overdue open occurrence with a permanently failed one, and "Missed" alone does that. Also, "open" covers occurrences dated on or before today whose due date was edited later, or removed. Calling those "Due today" would itself be wrong, so it needs wording that fits both.

### LOW-3: "This and following" is offered on completed occurrences

- **Where:** `series-scope.tsx:111` (`following = allowSeries && inHead`).
- **Impact:** For a completed head occurrence the preview answers `scope-unavailable`. The dialog shows an error instead of hiding the option.

### LOW-4: History disappears once the entire series is deleted

- **Where:** `task-detail.tsx:59,114` render history only when `detail.series` (the live head) exists.
- **Impact:** After "Entire series", the completed occurrences remain, but their history list is unreachable, even though `list_task_occurrences` would still answer. After a purge the chain is detached for good, as the brief intends. Before the purge (seven days), showing the history would match spec L2276 better.
- **Related:** `list_tasks.recurring` still marks those occurrences "Repeats".

### LOW-5: Deleting the upcoming occurrence leaves no upcoming one

- **Where:** `advance_series` condition (`:479-480`), with `last_date` counting trashed occurrences.
- **Impact:** After "this occurrence" delete of the single upcoming occurrence, no new upcoming occurrence is created until the deleted date passes. The brief says "exactly one upcoming".

### LOW-6: Re-activating an ended series whose list was archived or trashed silently creates nothing

- **Where:** `update_task_series` checks list usability only when `p_list_id` is given. `advance_series` returns 0 silently when the list is unusable.
- **Impact:** A schedule edit can extend an ended series whose list was archived or trashed while it was ended. It saves "next date X", but no occurrence ever appears.
- **Fix:** When the edit leaves `next_date` non-null, check the head's list and answer `list_unavailable`.

### LOW-7: Restore does not re-check the 200-active-series limit

- **Where:** `trash_item_restore`, `task_series_removal` case.

### LOW-8: The permission engine mirror is not exercised by production code

- **Where:** `packages/domain` `decideSeriesAction`.
- **Detail:** It matches `private.can_edit_series` and the assign rule as I traced them: Personal owner only; Home manager or creator; assign is manager only. But the UI uses the SQL `series.can` projection, and no shared matrix test runs both. Acceptable, but drift is not guarded.

### LOW-9: The first occurrence can differ from the due date for weekly rules

- **Where:** Weekly rule creation.
- **Impact:** If the due date's weekday is not selected, the first occurrence falls on another date, while the copy says "due date … is the first date of the repeat".

---

## Explicit checks

| Check                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements coverage (brief, PS L2145-50, 2168-75, 2194-2279) | Mostly covered: model, generation, scopes, history, trash, pause, departure, nl/en, independent tasks (no dependencies introduced). Gaps: HIGH-1/2 (schedule and split paths), MEDIUM-2 (end), MEDIUM-3 (list scope), LOW-2 labels.                                                                                                                                                                                                   |
| Cross-Home isolation                                           | OK. Every RPC derives context from the locked task or head (`lock_task` → `in_task_context`, `require_task_context`). Labels and lists are checked against the head's owner. `member_users` limits assignees to Home members. Trash `move_to_list` is constrained to the same context. History runs per chain from an accessible task. Private tables are revoked.                                                                    |
| Permissions (series vs occurrence; SQL vs domain)              | OK. Series scopes, pause and delete go through `can_edit_series` (manager, or current member who created it). Assignees in any scope need `can_manage_tasks`. "This" uses the S18 rules. `decideSeriesAction` agrees by inspection (LOW-8).                                                                                                                                                                                           |
| Secrets                                                        | OK. None added; no new environment variables; logs carry only event names and error codes.                                                                                                                                                                                                                                                                                                                                            |
| Input validation (Zod and SQL)                                 | OK. Strict Zod schemas (interval, weekdays, count, ends, offset, scope) are repeated in SQL (`valid_series_rule`, `valid_task_fields`, limits). Body size and CSRF go through `readTaskMutation`. The history query is validated.                                                                                                                                                                                                     |
| Migration safety                                               | Grants re-applied for the dropped and recreated `list_tasks` and the new public RPCs. Helpers are revoked. All functions are `security definer` with `search_path = ''`. Redefined S18 and trash functions are supersets: diffed, no S18 lines lost. Same signatures, so grants persist. Constraint swaps are fine. Locking has a deadlock (MEDIUM-1). Check constraints break normal flows (HIGH-1/2).                               |
| Dry-run subtransaction                                         | OK. MD001 rolls back every write, including advance inserts and occurrence locks. Head and task locks stay until the RPC ends. Other errors propagate, which is how HIGH-1 also breaks the preview.                                                                                                                                                                                                                                   |
| Trash restore / purge                                          | Restore re-checks lists (23505 → needs_resolution), revision for `series_changed`, and `restore_tasks_only`. `move_to_list` covers both tasks and series. Purge of a series removal detaches completed occurrences and deletes the definition. Purge of a following removal deletes only the trashed tasks. Interleavings of following and series removals resolve through `series_changed`. OK, apart from LOW-7.                    |
| Date / timezone; TS vs SQL parity                              | OK. Date-only arithmetic. Home "today" comes from the Home timezone, and the Personal `p_today` is bounded to ±1 day. "Completed late" is judged in the context timezone. The 50 shared vectors pass. I also ran 3,000 random cases of `firstOnOrAfter` and `series_until`/`lastDate` (all frequencies, intervals up to 99, leap and 29–31 days, counts, ends) against the dev DB: 0 mismatches.                                      |
| Test coverage                                                  | Broad, and all suites are green per the logs (DB 65 tests, e2e 141, unit). Gaps: schedule edits with a later start, split or delete-following after a reschedule, ending now, series-vs-series concurrency, list scope.                                                                                                                                                                                                               |
| Accessibility                                                  | Scope dialog: native fieldset/legend radios; preview in a `polite` live region with `aria-busy`; Confirm disabled until the preview loads; errors use FormAlert `announce`; focus returns to the Edit button or the status paragraph after actions. Repeat fields are all labelled native controls. History has a labelled filter, a live count, links and status text (not colour alone). The "Repeats" badge is text plus icon. OK. |
| Performance                                                    | OK. Advance reads partial head indexes, skips up-to-date series (`last_date > today`), and is capped at 50 series × 100 occurrences. History is paged at 50 with a window count. Minor: series whose list is unusable are re-selected and locked on every page load.                                                                                                                                                                  |
| Maintainability                                                | Acceptable. Thorough comments and an ADR. The migration is large (2,060 lines) and re-states many S18 functions.                                                                                                                                                                                                                                                                                                                      |

## Remaining risks and test gaps

- No tests for:
  - schedule edits with `starts_on` after `next_date` (HIGH-1);
  - "following" scopes on occurrences before the head anchor (HIGH-2);
  - an end date before the next scheduled date (MEDIUM-2);
  - series-vs-series or pause concurrency (MEDIUM-1);
  - a list change in series scope from the UI.
- Previews run real row locks (FOR UPDATE) on every scope-dialog open and filter change. This adds contention for busy series.
- Page-render generation (`advanceSeries` in Server Components) writes on GET. This is accepted in the brief, but it should be revisited when S19b adds the background advance.
- DST and timezone boundaries are covered by the date-only design. There is no explicit DST-day DB test for "completed late" around midnight in the Home zone.

## Reproductions (rolled back; nothing persisted)

All were run with `BEGIN … ROLLBACK` on `postgresql://postgres@127.0.0.1:54400/dev`, using `tests/db/sql/helpers.sql` inside the transaction:

1. **HIGH-1:**
   - Steps: daily series, shift back 3 days, advance, then `update_task_series(today's occurrence, 'series', …, p_set_schedule, p_starts_on => today+3)`.
   - Result: `task_series_next_check` violation.
2. **HIGH-2:**
   - Steps: same series, rescheduled with `p_starts_on => today+2` (succeeds). Then `update_task_series(occurrence today-1, 'following', dry_run, content)`, and separately `delete_task_series(occurrence today-1, 'following')`.
   - Result: both raise a `task_series_until_check` violation.
3. **MEDIUM-2:**
   - Steps: every-3-days series with occurrences yesterday and today+2; schedule edit with `p_ends_on => today`.
   - Result: outcome `ended`.
