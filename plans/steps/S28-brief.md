# S28 · Habits core — feature brief

**Branch:** `feat/habits`, from `main` at `b67a309` (S27 merged as PR #44).
**Sources (read only these ranges):** build plan S28; PS L2950–L3195 without the numeric and goal parts (habit schedules L2950–L2958; forward-only schedule changes L3020–L3026; pause notifications L3028–L3034; manual Home and personal pauses L3036–L3051; vacation pauses L3053–L3060; personal and Home habits L3062–L3069; 7-day backdating L3071–L3077; milestones L3079–L3086; insights L3088–L3095; end dates, Ended section, reactivation and its reminder review L3097–L3127; insights widget L3129–L3135; Undo L3137–L3143; corrections and streaks L3145–L3152; notes L3154–L3161; completion from notifications L3163–L3169; snooze L3171–L3177; reminders L3179–L3185; interactive widgets L3187–L3194, habit half). ARCH §8, §9, §11, §15, §39; ADR 0017 (outbox), 0018 (notifications), 0020 (trash), 0021 (dashboards), 0024 (reminder pattern), 0029 (vacations).
**Model:** Opus (streaks over schedule versions, periods and pauses, corrections and backdating, concurrent shared check-ins, reminder delivery and snooze, RLS).
**Done when (build plan):** streak recalculation after corrections is tested.

## What already exists

Homes, roles and delegable capabilities (S09/S12), notifications with categories, Home overrides and quiet hours (S14), the outbox and Trigger.dev jobs (S13), trash (S16), dashboard registry (S17), Home vacations with participants and the confirmed Home-wide pause (S22, which left the habit pause switches to S28), the reminder delivery pattern (S19b). Nothing about habits exists; the sidebar has no Habits entry yet.

## Model

- **Context:** a person's Personal space or one Home, like tasks and meals. **Timezone:** a Home habit uses the Home's timezone; a personal habit stores its own timezone (the creator's effective timezone, editable, prospective). **Week start:** stored on the habit at creation (the creator's preference: Monday, Saturday or Sunday) and shown on the habit; not editable. Dates are local calendar dates; "today" is now in the habit's timezone.
- **Habit:** name (1–80), optional description (≤ 500), timezone, week start, archived flag, revision. **Tracking periods** (`habit_periods`): start date and optional inclusive end date; the first period starts at the habit's start date; Ended = the last period's end is before today. **Schedule versions** (`habit_schedules`): effective date, kind `daily`, `weekdays` (ISO weekdays, at least one) or `weekly` (target 1–7 completions per habit week). Each date is evaluated under the version effective on it.
- **Day states:** outside a period (not tracked), not scheduled, paused, future, pending (today, not done), completed, missed (past, scheduled, not done). Weekly versions: every active day of the week is eligible; the week is reached when its completions reach its adjusted target = min(target, active days of that week in the period, not paused) (partial and paused weeks), with no active day = paused week.
- **Check-ins** (`habit_checkins`): at most **one active check-in per habit and date** (a unique index), with who, when recorded, the date it counts for, source (`app`, `widget`, `notification`), optional plain-text note (≤ 280) by its author. A weekly habit takes at most one check-in per day and none once the week's target is reached. Check-ins are never deleted: Undo and corrections mark them `undone` with who, when and an optional reason; checking the date again makes a new row.
- **Eligibility of a new check-in:** date between today − 7 and today (habit timezone), inside a period, scheduled under that date's version, not paused, habit not archived or deleted; not already completed (answer `already_completed` with who did it), weekly target not reached (`target_reached`). Older dates: `outside_window`. Client ids make retries idempotent (`exists`).
- **Streaks:** daily/weekday versions count consecutive completed scheduled, unpaused opportunities; today's pending one does not break it, a missed one does. Weekly versions count consecutive reached weeks; the current week counts once reached and does not break while open; paused weeks are neutral. A streak stops at a period boundary (reactivation starts fresh) and when the unit changes (occurrences ↔ weeks). Longest streak per unit over all history. All computed in SQL from history every time, so corrections, backdating, Undo and schedule or pause changes recalculate deterministically.
- **Milestones:** 7, 30 and 100 (occurrences or weeks). Recorded once in `habit_milestones` when a persisted check-in newly reaches one in a streak in which no milestone of that threshold was recorded before; the answer says `celebrate` only for a non-backdated check-in by that person, with celebrations not muted (a per-person setting). Corrections never delete milestones; the history shows them as reached on their date.
- **Pauses:** manual pauses (`habit_pauses`: start today, optional resume date, or open-ended until resumed; edits only move a resume date to today or later; Resume now = resume date today) and vacation pauses. Effective paused = any applies (union). A personal habit pauses during its owner's accepted participation in a Home vacation when the owner switched that habit on for that vacation (default off). A Home habit pauses on the dates the vacation's confirmed Home-wide pause covers. Vacation-paused days are materialized per habit (`habit_vacation_days`) and refreshed by triggers on vacation changes for today onward only, so past days never change afterwards.
- **Schedule changes:** forward only, effective tomorrow or later (default tomorrow); when the old or new version is weekly, the effective date must be the start of a later habit week (default next week). Preview: old and new schedule, upcoming opportunities, current streak, overlapping pauses, reminder effect.
- **End date and reactivation:** setting, changing or clearing the end date of the current period: not before its start; moving it before today needs a preview and is refused while active check-ins lie after it (`checkins_after_end`). An Ended habit is changed only through **Reactivate**: a new period from today or later, with an optional future end, a schedule (default the last one) and a **Review reminders** step (keep, change or turn off; never on by itself); one new period even under concurrent confirmations (revision).
- **Archive and delete:** archive/unarchive (managers) hides the habit from lists, widgets and reminders but keeps everything; delete moves it to the trash for 7 days (S16), restore brings it back unchanged.
- **Reminders** (`habit_reminders`, one per habit): off by default; up to 3 local times on chosen weekdays. Daily/weekday habits remind only on scheduled, unpaused, not-done days; weekly habits on the chosen days while the week's target is not reached. Recipients: the personal habit's owner; for a Home habit every member who may check in and has not turned that habit's reminders off for themselves. Category `reminders` (in-app on, email off by default), quiet hours and Home overrides as in S14. Delivery is the outbox job `habit-reminder` per habit and reminder moment (the job queues the next one; the hourly `task-reminder-advance` schedule also tops habit reminders up, no new schedule); everything is rechecked at delivery, and a moment more than 30 minutes late is skipped, never sent afterwards.
- **From the notification centre:** a habit reminder offers **Complete** (the reminder's date, or today for a weekly habit) and **Snooze 15/30/60 min** (one deferred delivery per reminder notice; refused if it would land in quiet hours or after the day or week it is for; rechecked when it fires). Email reminders only link to the habit.
- **Pause notices:** new optional category `habits`, opt-in (off on every channel by default), with S14 Home overrides: opted-in members who can see the habit are told when a manager manually pauses or resumes a Home habit, or its dated pause ends, only when the effective state changes (not when a vacation still pauses it, never for vacation changes).
- **History** (`habit_events`): created, edited, schedule changed, end changed, paused, pause changed, resumed, archived, restored, reactivated, reminders changed, check-in, undone, corrected, note added/edited/removed. Ids, dates and codes only (no note text); shown on the habit page to whoever may view it.

## Who may do what (defaults picked, Ward may override)

| Action                                                                                        | Personal habit | Home member (habit access **Check in**, default) | Home member (access **View only**) | Habit managers |
| --------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------ | ---------------------------------- | -------------- |
| See habits, history, insights                                                                 | owner          | yes                                              | yes                                | yes            |
| Check in (today and 7 days back), Undo own check-in, own notes                                | owner          | yes                                              |                                    | yes            |
| Correct (undo) someone else's or an older check-in, with optional reason                      | owner          |                                                  |                                    | yes            |
| Turn a Home habit's reminders off for oneself, snooze                                         | owner          | yes                                              |                                    | yes            |
| Create, edit, schedule, end, reactivate, pause, reminders, archive, delete; set member access | owner          |                                                  |                                    | yes            |

- **Habit managers:** the Owner and Administrators granted the new delegable capability `manageHomeHabits`.
- Engine: `packages/domain/src/permissions/habits.ts`; SQL `private.habit_access(home, user)` returns `manage` / `complete` / `view` / null.
- Personal habits, their pauses, vacation choices and notes are never visible to anyone else, Home managers included.

## Interface

- **Habits** in the sidebar: `/habits` (Personal) and `/homes/[homeId]/habits`: active and paused habits with today's state, week progress for weekly habits and the current streak; Complete with a 10-second **Undo** in the confirmation; link to **Ended habits** (count, search) and **Archived**; New habit (name, schedule, start date, optional end date, description, timezone for personal); the habit timezone and week start are shown.
- **Habit page** `/habits/[habitId]`: status (Active, Paused with resume date or "Until resumed", Ended, Archived), schedule and its history, current and longest streak with units, milestones, last 8 days with Mark completed / Undo / note; older check-ins with Correct (managers); history; **Insights** (period 7/30/90/365 days: completion rate with "no eligible opportunities", longest streak, month calendar with all states and a text list, 12-week trend with values as text); settings dialogs with previews: edit, schedule change, end date, pause/resume, reminders, reactivate (with reminder review), archive, delete; my reminders on/off (Home); celebrations on/off (per person, on the Habits page).
- **Vacation page:** for the viewer's own accepted participation, "Pause my personal habits" with a switch per active personal habit and a preview of the affected days.
- **Widgets:** **Habits** (today's habits of its context: Complete/Undo where allowed, weekly progress, streak; read-only otherwise; ended and archived ones excluded) and **Habit insights** (one chosen habit: completion rate of the last 30 days, current streak with unit, 12-week mini trend with text, View insights; "Ended" label; a missing or inaccessible habit shows an explicit state).
- **Celebration:** a short, dismissible, non-blocking message for a newly reached milestone (static under reduced motion), no sound, no focus move.

## API

`GET/POST /api/v1/habits` (list with `homeId`, `view=active|ended|archived`, `q`; create), `GET/PATCH/DELETE /api/v1/habits/:id` (detail; edit; to trash), `POST /api/v1/habits/:id/schedule` (preview or apply), `POST /api/v1/habits/:id/end` (preview or apply), `POST /api/v1/habits/:id/reactivate` (preview or apply), `POST /api/v1/habits/:id/pauses`, `PATCH /api/v1/habits/:id/pauses/:pauseId`, `POST /api/v1/habits/:id/archive`, `PUT /api/v1/habits/:id/reminders`, `PUT /api/v1/habits/:id/my-reminders`, `GET /api/v1/habits/:id/insights?days=`, `GET /api/v1/habits/:id/calendar?month=`, `GET /api/v1/habits/:id/history`, `POST /api/v1/habits/:id/checkins` (complete a date), `POST /api/v1/habit-checkins/:id/undo`, `PATCH /api/v1/habit-checkins/:id/note`, `POST /api/v1/habit-reminders/:notificationId/snooze`, `PATCH /api/v1/habits/settings` (member access, celebrations), `GET/PUT /api/v1/vacations/:id/habits` (own personal habit switches). Same CSRF, JSON, size, session and outcome mapping as earlier steps.

## Database (`20261110090000_habits.sql`)

Tables `habit_settings`, `habit_user_settings`, `habits`, `habit_periods`, `habit_schedules`, `habit_pauses`, `habit_vacation_choices`, `habit_vacation_days`, `habit_checkins`, `habit_milestones`, `habit_reminders`, `habit_reminder_optouts`, `habit_reminder_snoozes`, `habit_events`; capability `manageHomeHabits`; notification category `habits` and kinds `habit.reminder`, `habit.paused`, `habit.resumed`; trash module `habits` with item type `habit`; audit subject `habit`. All access through security-definer functions with the person's session; no table exposed. Every change takes the habit lock; check-ins serialize per habit so two members never both complete the same date.

## Tests

- **Database:** access matrix (owner; member check-in/view; manager; Administrator with and without the capability; non-member; forged ids; departed member); personal habits invisible to Home managers; cross-Home isolation for every read and write; schedules (daily, Mon-Wed-Fri with unscheduled days, 3×/week reached and not, week boundary per week start, timezone boundary); check-ins (duplicate, retry, already completed by another member, target reached, 7 days ok, 8 days refused, unscheduled, paused, outside period, archived); **streak recalculation after corrections** (missed Friday breaks, late Friday backfill restores, Undo lowers, manager correction, weekly backfill reaches a target, past week still incomplete); schedule changes (forward only, week boundary for weekly, history evaluated under old version, streak across daily→weekdays and weekdays→weekly); pauses (manual, dated auto-resume, open-ended, union with vacation, no misses, streak preserved); vacation choices (default off, past days frozen); end date (past end refused with later check-ins, Ended section) and reactivation (fresh streak, longest kept, no gap backfill, concurrent once); milestones once; insights (rate denominators, no eligible opportunities, mid-period creation); reminders (recipients, opt-out, done/paused/ended suppress, late skip, dedupe), snooze (quiet hours, window, revalidation), pause notices (opt-in, vacation overlap no false "resumed"); trash. **Concurrency:** two members completing the same date (one `completed`, one `already_completed`); two weekly check-ins racing for the last target slot; two reactivations.
- **Unit:** schemas, permission matrix, date/week helpers, routes, components with axe.
- **Playwright:** create a habit, check in, Undo, backdate a missed day and see the streak restored; weekly habit progress; pause and resume; insights page; Habits widget.

## Out of scope

Numeric habits (S29), goals and habit-to-goal links (S30), Household Display rendering and wall-display actions (S43–S44), push and email action buttons (email links only), Ora, Realtime (pages refresh after own changes, on focus and every 60 s), points or rewards for habits.

## Defaults picked (Ward may override)

1. Permissions as in the table; Home members check in by default; managers (`manageHomeHabits`) configure and may set members to view only.
2. One check-in per date; a weekly target counts distinct days (1–7) and refuses check-ins once reached; partial and paused weeks use min(target, active days).
3. Corrections: members undo their own check-ins within the 7-day window; managers undo any check-in at any date with an optional reason; new completions only within 7 days.
4. Schedule changes from tomorrow; weekly-involved changes from the next week start. Week start fixed per habit; personal habits keep their own timezone.
5. Milestones 7, 30, 100 for both units; celebrations on by default, mutable per person.
6. Reminders: one config per habit (≤ 3 times, chosen weekdays), set by whoever manages the habit; Home members can turn a habit's reminders off for themselves; delivered up to 5 minutes late, skipped when more than 30 minutes late.
7. Snooze and Complete in the in-app notification centre only.
8. Pause notices: category `habits`, opt-in.
9. Limits: 100 non-archived habits per context, name 80, description 500, note 280, reason 200, 3 reminder times.
10. Undo shown for 10 seconds; insights periods 7/30/90/365 days (default 30), trend 12 weeks.

## Progress

- [x] Brief
- [ ] Domain and migration
- [ ] Database tests
- [ ] API and data layer
- [ ] Interface and widgets
- [ ] Unit, route and component tests
- [ ] Playwright
- [ ] Docs (ADR 0035, user stories, notifications, supabase-migrations, production-migrations)
- [ ] Full suite
- [ ] Independent review
