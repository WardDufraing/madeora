# S30b · Recurring goals — feature brief

**Branch:** `feat/recurring-goals`, from `main` at `2a57ded` (S30 merged as PR #56).
**Sources (read only these ranges):** build plan S30b; PS L2916–L3019 (goals: "Confirmed completed goal lifecycle and guided renewal" recurring paragraph, "Confirmed weekly, monthly and yearly recurring measurable goals", "Confirmed recurring measurable goal period finalization and historical corrections", "Confirmed recurring measurable goal target effective periods", the recurring line of "Confirmed configurable goal deadline and overdue reminders"); `plans/steps/S30-brief.md` (the core this extends).
**Model:** Opus (period finalization, idempotent boundary jobs, concurrency with corrections, RLS).
**Done when (build plan):** period finalization and boundary tests (month, year, leap year, duplicate job) pass.

## Model

- **Series** (`goal_series`): a recurring goal in a Personal space or a Home. Kind `measurable` (weekly, monthly or yearly) or `completion` (monthly or yearly; the spec approves weekly for measurable only). Title, description, timezone (personal; a Home series uses the Home's), week start (`monday`/`saturday`/`sunday`, weekly only; the form defaults to the person's week-start preference), first period, optional end date (no period starts after it), state `active` / `paused` / `stopped`, revision, optional advance-reminder template.
- **Periods** are ordinary goals (`goals.series_id`, `period_start`, `period_end`, inclusive local dates): their own ledger, target, unit, achievement history, deadline reminders and events, so every S30 rule (contributions, corrections, Mark achieved, reopen, concurrency) applies unchanged. A period's deadline is its last day (derived, not editable). `unique (series_id, period_start)` (deleted rows included) makes a period exist at most once whatever runs twice.
- **Period bounds** (`private.goal_period_bounds`): weekly = the week containing the date by the series' week start (the habit `habit_week_of` rule; a week crossing New Year is one period); monthly = calendar month (February 28 or 29 days); yearly = calendar year. Dates are local to the series timezone, so daylight-saving changes cannot move a boundary.
- **Rollover** (`private.roll_goal_series`, under the series row lock, idempotent): (1) finalizes every period whose last day is before today; (2) creates the **current** period when the series is active, the period starts on or after the first period, and on or before the end date, and it does not exist yet. Never backfills: a period missed while paused, stopped or not yet started is never created afterwards. Runs from the existing hourly Trigger.dev schedule `task-reminder-advance` (no new schedule, so no extra free-tier runs; `public.roll_goal_periods`, service role, at most 200 series per run whose `next_roll_at` has come, oldest first) and lazily before the goals list and series reads (`public.sync_goal_periods`, the caller's context only), so a new period exists as soon as anyone looks.
- **Finalization** (measurable): `outcome` = `reached` / `not_reached` from the period's total and target at that moment, `outcome_total`, `finalized_at`. Never achieves or reopens anything; the next period starts at 0 whatever happened. Completion periods are finalized too (outcome from whether it was marked achieved by the end).
- **After the period ends:** no new contributions (`period_ended`); goal managers may still correct or reverse entries and set the total (audited historical corrections). Each such change recomputes that period's outcome only (its own target and unit), records `outcome_changed` (before/after, total) when it flips, and marks the result **corrected** (`outcome_corrected_at`). A correction that takes an explicitly achieved period below its target keeps the achievement and flags it **needs review** (the manager's existing Reopen is the review). Members cannot change ended periods.
- **Target effective periods** (`goal_series_targets`, one row per effective period start): the target and unit for periods from that period onward. A change applies to the **current** period or a chosen **future** period (default: the next). Past periods keep theirs. Changing the current period changes the current period's goal through the S30 rules: a unit change with progress needs `confirm_unit`; a change that flips "target reached" needs `confirm_status` (and on an achieved period below the new target it reopens the achievement, recorded, as in S30). Preview first (`dry_run`): current and new target, unit, effective period, which periods use it, current progress and reached before/after, achievement effect. Stale revision → `conflict` with the new impact.
- **Pause / resume / stop:** pause stops new periods (the current one runs to its end); resume creates the current period if missing (no backfill); stop is final (an end date in the past acts the same). Past and current periods stay.
- **Edits:** series title, description, end date, timezone (personal) and reminder template apply to periods created afterwards (prospective); a period's own title/description stay editable on its goal page. Frequency, kind, week start and first period are fixed after creation (stop and create a new series instead).
- **Reminders:** a series may carry an advance reminder (1–90 days before each period's last day, at a local time). Each new period copies it into its own `goal_reminders` and schedules it; an achieved, archived, ended or deleted period never reminds. Overdue reminders are not offered for periods (a period ends at its deadline).
- **Delete:** a series goes to the trash (7 days) with all its periods; restore brings it back unchanged; purge removes everything. A single period can be archived or trashed like any goal; it is never recreated.
- **History** (`goal_series_events`): created, edited, target_scheduled, paused, resumed, stopped, restored. Periods' own events add `finalized` and `outcome_changed`.
- **Limits:** 50 series per context that are not stopped; periods do not count toward the 100-goal limit.

## Who may do what (as S30)

Same `goal_access`: viewers see the series, its periods and history; contributors add progress to the current period; goal managers create, edit, change targets, pause/resume/stop, delete, and make historical corrections. Personal series are the owner's alone.

## Interface

- **New goal** form: "Repeat" (does not repeat / weekly / monthly / yearly; weekly only for measurable), week start, first period (this period or a later one), optional end date, advance reminder; a preview of the first and next periods and the target before creating.
- **Goals page:** current periods appear in Active with a "Weekly/Monthly/Yearly" badge; a **Recurring** section lists the series (state, current period progress). Periods never fill Completed (their history lives on the series page).
- **Series page** `/goals/series/[seriesId]` and `/homes/[homeId]/goals/series/[seriesId]`: frequency, state, current period card, target schedule with **Change target** (effective period choice and preview), Pause / Resume / Stop, Edit, Delete; **Period history** (period, total / target unit, outcome, "corrected", "achieved", "needs review").
- **Goal page of a period:** "Period 1–31 Oct · part of [series]", the outcome once ended; Change target and deadline point to the series.

## API

`POST /api/v1/goal-series` (`homeId`; `preview: true`; the context's series are listed with its goals, `GET /api/v1/goals` → `series`), `GET/PATCH/DELETE /api/v1/goal-series/:id`, `POST /api/v1/goal-series/:id/state` (pause, resume, stop), `POST /api/v1/goal-series/:id/target` (preview or apply), `GET /api/v1/goal-series/:id/periods?before=`. Lists and series reads sync the context first. Same CSRF, JSON, size, session and outcome mapping as the goal routes.

## Database (`20261114090000_recurring_goals.sql`)

Tables `goal_series`, `goal_series_targets`, `goal_series_events`; `goals` gains `series_id`, `period_start`, `period_end`, `outcome`, `outcome_total`, `finalized_at`, `outcome_corrected_at`; trash item type `goal_series`; audit subject `goal_series`. S30 functions that must know about periods are replaced (`goal_for`, `goal_lock`, `goal_summary_json`, `goal_status`, `get_goals`, `create_goal` limit, `update_goal`, `change_goal_target`, `add_goal_entry`, `update_goal_entry`, `set_goal_achievement`, `set_goal_reminders`, `deliver_goal_reminder`, `schedule_goal_reminders`, trash dispatch).

## Tests

- **Database:** period bounds (month ends, February 28/29, leap year 2028, year boundary, weekly week starts and a week across New Year); rollover creates the current period once, never backfills, honours first period, end date, pause, stop; duplicate rollover (twice in one transaction and the service-role job); finalization reached / not reached, next period starts at 0, no excess carried; contributions refused after the end; manager correction of an ended period flips the outcome (corrected), reverse below target, explicit achievement kept with needs review; target effective next / current (confirm_status, lower to reach, raise to unreach), future yearly, history unchanged; permissions (member, view-only, manager, Administrator without capability, non-member, cross-Home, forged ids, personal privacy); trash/restore of a series; reminders copied to new periods and silent for ended periods. **Concurrency:** rollover racing a correction; two rollovers racing.
- **Unit:** schemas, routes, components with axe, the job.
- **Playwright:** create a monthly measurable series with preview, see the current period in Active with its badge, add progress, open the series page, schedule a target change for the next period, pause and resume.

## Out of scope (this step)

Habit-to-goal links (S30c, including linked recurring series), Household Display rendering, a Goal progress widget that follows a series (it shows a chosen period; later), changing frequency of an existing series, backfill operations, Ora.

## Defaults picked (Ward may override)

1. Periods are full goals; deadline = last day of the period; advance reminders only.
2. Rollover hourly plus lazily on reads; only the current period is ever created (no backfill).
3. After a period ends, only goal managers change it (corrections, set total, Mark achieved, reopen); members cannot add late contributions.
4. Target changes default to the next period; changing the current one needs a preview and confirmation when "reached" flips.
5. Series edits are prospective; frequency, kind, week start and first period are fixed.
6. Stop is final; 50 active or paused series per context; periods do not count toward the goal limit.
7. A completed period stays on the series page, not in the Completed section.

## Progress

- [x] Brief
- [x] Migration
- [x] Database tests
- [x] API, job and data layer
- [x] Interface
- [x] Unit, route and component tests
- [x] Playwright
- [x] Docs (ADR 0039, user stories, background jobs, supabase-migrations, production-migrations, roadmap)
- [x] Full suite
- [x] Independent review (PASS, 0 blocker, 0 high, 3 medium, 6 low; reviews/steps/S30b-review.md)
