# ADR 0039: Recurring goals

- **Status:** Accepted for S30b within the approved architecture (§4, §6, §9, §15, §19, §21, §34, §36, §39, §43), CLAUDE.md (database access A, authorization C, background processing B, forms A, internationalization A, date/time A, €0 budget) and the spec's recurring goal decisions (PS L2916–L3019). The defaults below are open to correction by the owner.
- **Date:** 2026-10-29
- **Step:** S30b (brief: `plans/steps/S30b-brief.md`), on top of the goals core (ADR 0038).

## Context

The spec asks for weekly, monthly and yearly recurring measurable goals whose periods start at zero, are finalized when they end, can be corrected afterwards by goal managers, and take target changes from the current or a later period without rewriting history; series can be paused and stopped. The done-condition is that period finalization and boundary tests (month, year, leap year, duplicate job) pass.

## Decision

**Periods are goals.** A series (`private.goal_series`) creates ordinary `private.goals` rows with `series_id`, `period_start` and `period_end` (inclusive local dates). Each period keeps its own ledger, target, unit, achievements, reminders and events, so every S30 rule (contributions, corrections, Mark achieved, reopen, locking) applies unchanged. `unique (series_id, period_start)`, deleted rows included, means a period exists at most once and is never recreated after it was trashed. Kinds: measurable (weekly, monthly, yearly) and completion (monthly, yearly).

**Period bounds** come from `private.goal_period_bounds` (weekly by the series' week start, using the habit week rule; monthly and yearly by the calendar), in the series' timezone (the Home's for a Home series). Boundaries are local dates, so daylight-saving changes cannot move them. The same rules exist in `packages/domain/src/goals` (`goalPeriodStart`, `nextGoalPeriodStart`) for the interface; change both.

**Rollover** (`private.roll_goal_series`, idempotent under the series row lock, taken before any goal lock) finalizes every period whose last day has passed and creates only the period running now when the series is active and within its first period and end date. It never backfills: a period missed while paused, stopped or not yet started stays missing. It runs hourly from the existing `task-reminder-advance` schedule (`public.roll_goal_periods`, service role, at most 200 due series per run, so no extra Trigger.dev runs) and lazily before the goals list and series reads (`public.sync_goal_periods`, with the caller's own access).

**Finalization** stores `outcome` (`reached` / `not_reached`), `outcome_total` and `finalized_at` from the period's own total and target. It never achieves or reopens anything. After the end nobody adds contributions (`period_ended`); goal managers can still correct or reverse entries, set the total, mark achieved or reopen. Each such change recomputes that period's outcome only; a flip records `outcome_changed` and marks it corrected (`outcome_corrected_at`). An explicitly achieved period that a correction takes below its target keeps the achievement and is flagged **needs review**.

**Target effective periods** (`private.goal_series_targets`) hold a target and unit per effective period start. A change applies from the current period or a later one (default: the next); past periods keep theirs. Changing the current period goes through the S30 rules (`confirm_unit`, `confirm_status`, reopening an achieved period below the new target). Every change can be previewed (`dry_run`) and is revision-checked; a period's own target is changed only from its series (`series_period`).

**Series lifecycle.** Pause stops new periods (the running one goes on), resume creates the current period if missing, stop is final. Edits to title, description, end date, timezone (personal) and the advance reminder apply to periods created afterwards; frequency, kind, week start and first period are fixed. A series goes to the trash with its periods (item type `goal_series`) and comes back unchanged. 50 series that are not stopped per context; periods do not count toward the 100-goal limit.

**Reminders.** A series may carry one advance reminder (1–90 days before each period's last day, at a local time), copied into each new period's own reminder and scheduled through the S30 `goal-reminder` job. Overdue reminders are not offered for periods, and an ended, achieved, archived or deleted period never reminds.

**Interface.** The New goal form gains Repeat, week start, first period, end date and the reminder, with a preview of the first and next periods before creating. Current periods appear in Active with a frequency badge, the series under **Recurring**; periods never fill Completed. A series page shows the current period, the target schedule with Change target, Pause / Resume / Stop, Edit, Delete, the period history and the change log. A period's page names its period and series and its outcome once ended.

## Consequences

- Any new write on a period must take the series lock before the goal lock, and any new reader of a context's goals should call `sync_goal_periods` first, as the list does.
- Known limits, accepted for this step: a single period's page does not roll its series (the hourly run and the list do), so an ended period may show as not finalized for up to an hour; the series page lists its 50 most recent change-log events without paging; restoring a series from the trash does not recheck the 50-series limit.
- S30c (habit-to-goal links, including linked recurring series) builds on periods being goals; a Goal progress widget that follows a series is later work.
- A personal export (S38) and account deletion (S40) must include series, their targets and events.
- **Rollback and compatibility:** the migration adds tables, columns and functions, re-creates the S30 functions that must know about periods (wrapping `change_goal_target` and `set_goal_reminders`), and widens the audit subject, trash item type and goal event checks; it changes no existing data, and existing goals keep behaving as before (`series_id` null). It is forward-only; repairing it on production means a new migration. Rolling the app back to S30 code while it stays applied leaves series unreachable, their periods visible as ordinary goals.
