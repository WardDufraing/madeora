# ADR 0035: Habits

- **Status:** Accepted for S28 within the approved architecture (§8, §9, §11, §15, §39), CLAUDE.md (database access A, authorization C, realtime C, data fetching B, background processing B, forms A, date/time A, €0 budget) and the spec's habit sections (PS L2950–L3195, without the numeric and goal parts). The defaults below are open to correction by the owner.
- **Date:** 2026-10-28
- **Step:** S28 (brief: `plans/steps/S28-brief.md`). Builds on ADR 0017 (outbox), 0018 (notifications), 0020 (trash), 0021 (dashboard engine), 0024 (reminder pattern) and 0029 (vacations).

## Context

The spec asks for personal and Home habits with flexible schedules, check-ins with 7-day backdating, Undo, notes, manual and vacation pauses, end dates with reactivation, streaks and milestones, insights, reminders with Complete and Snooze from the notification, and interactive widgets. The done-condition is that streaks recalculate correctly after corrections.

## Decision

**One migration, no exposed tables.** `20261110090000_habits.sql` adds `private.habit_settings`, `habit_user_settings`, `habits`, `habit_periods`, `habit_schedules`, `habit_pauses`, `habit_vacation_choices`, `habit_vacation_days`, `habit_checkins`, `habit_milestones`, `habit_reminders`, `habit_reminder_optouts`, `habit_reminder_snoozes` and `habit_events`. Every read and change is a `security definer` function run with the person's session; RLS is enabled and nothing on the private tables is granted. Every write locks the habit row first, so two members never complete one date twice and a weekly target's last slot is taken once.

**Who does what (defaults picked).** A personal habit, its pauses, vacation choices and notes belong to its owner alone; Home managers never see them. In a Home every current member views habits, history and insights; members check in, undo their own check-ins and write their own notes unless the Home's habit member access is set to view only. Habit managers (the Owner and Administrators granted the new delegable capability `manageHomeHabits`) create, edit, reschedule, end, reactivate, pause, set reminders, archive, delete, correct anyone's check-in at any date with an optional reason, and set member access. `private.habit_access` answers `manage` / `complete` / `view` or null; `packages/domain/src/permissions/habits.ts` mirrors it for the interface only.

**Time.** A Home habit uses the Home's timezone; a personal habit stores its own (the creator's effective timezone, editable, prospective). The week start (Monday, Saturday or Sunday) is fixed per habit at creation.

**Periods and schedule versions.** A habit has tracking periods (start, optional inclusive end) and schedule versions (effective date; `daily`, `weekdays` with at least one ISO weekday, or `weekly` with a target of 1–7 days). Each date is evaluated under the version effective on it. Changes are forward only: from tomorrow, or from a later week start when the old or new version is weekly, with a preview. An end date before today needs a preview and is refused while active check-ins lie after it. An ended habit changes only through Reactivate: a new period from today or later, a schedule and a reminder review (keep, change or off; never on by itself), once under concurrent confirmations.

**Check-ins.** At most one active check-in per habit and date, for today or the 7 days before, on a tracked, scheduled, unpaused day of a habit that is not archived; a weekly habit takes one per day and none once the week's adjusted target is reached. Client ids make retries idempotent. An earlier day is confirmed first, showing the day, its state now and that it is recorded today; a confirmation says when a change moved the current streak. Check-ins are never deleted: Undo and corrections mark them undone with who, when and why, and a later check-in on that date is a new row. Notes are plain text by their author.

**Streaks are computed, never stored.** Day states, current and longest streaks, milestones' eligibility and insights are computed in SQL from the whole history on every read, so corrections, backdating, Undo, schedule and pause changes recalculate deterministically. Daily and weekday versions count consecutive completed opportunities (today's pending one does not break it); weekly versions count reached weeks, where a week's adjusted target is min(target, active unpaused days of the week in the period) and a week without any is neutral. A streak stops at a period boundary and when its unit changes. Milestones (7, 30, 100) are recorded once when a check-in newly reaches one; a celebration is shown only for that person's own non-backdated check-in with celebrations on, as text, no sound, no focus move.

**Pauses.** Manual pauses start today, with a resume date or until resumed; edits only move the resume date to today or later. A personal habit pauses during its owner's accepted vacation participation when they switched it on for that vacation (default off); a Home habit pauses on the vacation's confirmed Home-wide pause days. Vacation days are materialized per habit from today on by triggers on vacation changes, so past days never change afterwards. Paused days never count as missed.

**Reminders.** One configuration per habit, off by default: up to 3 local times on chosen weekdays. Recipients are the personal habit's owner, or every member of the Home who may check in and has not turned that habit's reminders off. The outbox job `habit-reminder` is queued per moment and queues the next; delivery re-checks everything, notifies once per person and moment (category `reminders`, quiet hours and Home overrides as in ADR 0018) and skips a moment more than 30 minutes late. The hourly `task-reminder-advance` schedule also tops up stopped chains (`advance_habit_reminders`); no new schedule. In the notification centre a reminder offers Complete (its date, or today for a weekly habit) and Snooze 15/30/60 minutes: one snooze per reminder, refused into quiet hours or after its day, re-checked when the `habit-reminder-snooze` job fires. Emails link to the habit and never name it.

**Pause notices.** A new optional category `habits`, off by default: opted-in members of a Home are told when a manager pauses or resumes a Home habit, or its dated pause ends (`habit-pause-end` job), only when the effective paused state changes.

**History, trash and limits.** `habit_events` keeps ids, dates and codes only (no note text). Delete moves a habit to the trash (module `habits`, item type `habit`) for 7 days; archive hides it from lists, widgets and reminders. At most 100 non-archived habits per context; name 80, description 500, note 280, reason 200 characters.

**No Realtime.** Pages and widgets refresh after one's own changes, on focus and every 60 s while visible (TanStack Query).

**Interface and API.** The sidebar's Habits opens `/habits` or `/homes/:id/habits` (active, Ended and Archived views); a habit's page has its status, schedules, streaks, last 8 days, history, insights and the dialogs, each change previewed where the spec asks. The vacation page offers the viewer's personal-habit switches. The dashboard gains **Habits** (5, 10 or 15 of today's habits with Complete and Undo) and **Habit insights** (one chosen habit). Routes live under `/api/v1/habits/`, `/api/v1/habit-checkins/:id/{undo,note}`, `/api/v1/habit-reminders/:notificationId/snooze` and `/api/v1/vacations/:id/habits`, with the CSRF, JSON, size, session and outcome mapping of earlier steps.

## Consequences

- Any new habit write must lock the habit row first, or two people could complete one date twice.
- Streak reads cost a scan of one habit's history; fine at household scale, revisit with an index or cache only with measurements.
- History pages continue after the last row's id (the full sort key), so rows sharing a date or moment are never skipped.
- Snooze works within the reminder's local day only.
- Turning a reminder off keeps its times and days for turning it on again; the hourly top-up looks at the least recently checked reminders first.
- Numeric habits (S29), goals (S30), Household Display actions (S43–S44), push and email action buttons, Ora and points for habits are out of scope.
- The migration is forward-only like every other; repairing it on production means a new migration.
