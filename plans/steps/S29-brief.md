# S29 · Numeric habits — feature brief

**Branch:** `feat/numeric-habits`, from `main` at `a560825` (S28 and S28b merged as PR #50 and #51).
**Sources (read only these ranges):** build plan S29; PS L2793–L2915 (the numeric habit decisions: daily target, excess and no carryover, units and conversions, effective-date target changes, same-day status confirmation, daily-only targets, weekly/monthly summaries, interactive widget, quick-add and manual entry, positive-only increments and corrections, progress-aware reminders, daily totals without a contribution timeline, one daily note, decimal precision and localized entry, excluded from the calendar); `plans/steps/S28-brief.md` (what S29 builds on).
**Model:** Sonnet. It extends the S28 habit module (streaks, reminders, RLS pattern, access matrix) without a new security design. Thread verdict posted to Ward.
**Done when (build plan):** decimal and locale entry tests pass in nl and en.

## What already exists (S28)

Habits with tracking periods, schedule versions (`daily`, `weekdays`, `weekly`), one active check-in per habit and date, streaks and milestones computed in SQL from check-ins, manual and vacation pauses, reminders with snooze, history, insights, the Habits and Habit insights widgets. Access: `private.habit_access` → manage / complete / view.

## Model

- **A numeric habit is a daily or weekday habit whose day is completed by reaching a daily target.** Weekly-frequency habits stay binary (PS L2877–L2878): a schedule change to weekly, or a reactivation with a weekly schedule, is refused while the tracking in effect (or any later version) is numeric (`numeric_requires_daily`).
- **Tracking versions** (`private.habit_tracking`): `effective_on`, `mode` (`once` | `numeric`), `target`, `unit`, `unit_kind` (`preset` | `custom`), `quick_adds`. No row = complete once. The version in effect on a date decides that date's target and unit, so history never changes. Mode and unit changes apply from tomorrow or later; a **target-only** change (same unit, numeric before and after) may apply **today**, on the **next scheduled day** or on a **chosen future date**, with an impact preview. Applying it today needs a separate explicit confirmation when it flips today's state between partial and completed (`confirm_status`), and a stale preview (today's total moved) is refused (`stale`).
- **Contributions** (`private.habit_contributions`): positive increments, never negative, stored in the day's canonical unit with an optional original entry (`entered_quantity`, `entered_unit`) when converted; contributor, recording time, source (`app`, `widget`); client id for idempotent retries. Never deleted: Undo (own, within the 7-day window) or a manager's correction marks one `undone`; a manager may also amend a quantity (the original is kept). Totals are the exact decimal sum of active contributions; excess is shown and never carries over.
- **Completion reuses the S28 check-in machinery.** When a day's total reaches its target the database writes one _derived_ check-in (`derived = true`) for that day; when a correction or a same-day target change takes it back below, that check-in is marked undone. Streaks, milestones, insights, reminders and the calendar keep working on check-ins unchanged. A derived check-in cannot be completed, undone or noted directly (`numeric_required`, `numeric_derived`). A target-change sync never celebrates.
- **Units:** presets `glasses`, `pages`, `repetitions` (whole numbers only), `ml`, `l`, `min`, `h`, `m`, `km`, or a custom label (1–20 characters, up to 3 decimals, no conversion). Only `l`↔`ml`, `h`↔`min`, `km`↔`m` convert, in exact decimal arithmetic. A conversion that needs more than 3 decimals is refused with a rounded preview (`precision`); glasses ↔ ml and arbitrary labels never convert. Quantities and targets: strictly positive, at most 3 decimals, at most 1,000,000.
- **Locale entry:** quantities travel as decimal strings (`1500`, `1.5`); the form parses what the person typed with their locale (nl `1,5`, en `1.5`), rejecting the other separator, thousands separators and malformed text, and shows the normalized value before saving. Exact arithmetic uses thousandths as integers in the browser and `numeric` in the database.
- **Daily note:** at most one plain-text note (≤ 280) per habit and numeric day, independent of contributions, edited with a revision. Personal: the owner. Home: habit managers edit, every viewer reads. Day must be a tracked, scheduled, unpaused day that has begun. A note survives corrections.
- **Quick-adds:** up to 5 positive presets per tracking version, edited by owners and managers; changing them bumps the habit revision so widget taps against stale presets are refused (`stale`).
- **Reminders:** completion suppresses them as before (the derived check-in blocks the day); an unmet numeric day's reminder carries a point-in-time `progress` snapshot (`total`, `target`, `unit`) which the notification centre shows; **Complete** in a notification of a numeric habit opens the habit page instead (never invents a quantity). Pending snoozes of the day are cancelled when the target is reached.
- **Privacy:** contribution rows are readable through `get_habit_contributions` only by the contributor (their own rows) and habit managers/owner (all, with attribution). Members and widgets see aggregate totals only. Contributions write no `habit_events` (that list is visible to every viewer); a manager's correction and every tracking change do (ids, dates, codes), plus a Home audit event.
- **Summaries** (insights): last 8 weeks and 6 months, per period: total actual quantity, eligible days (scheduled, tracked, unpaused, begun), average per eligible day (zero days included), days that met their own target; labelled _so far_ for the running period; compatible units are merged into the most recent unit of that dimension, incompatible or custom units are split into separate segments, never mixed.
- **Calendar:** numeric habits create no calendar entries (nothing in the calendar code changes); the habit's own month view shows partial days.

## Who may do what

Unchanged from S28: owner/managers configure, set presets, change targets, correct; check-in members contribute and undo their own; view-only members read aggregates.

## Interface

- New habit / edit: **Tracking** field (Complete once | Numeric daily target), unit select with custom label, target and quick-add presets, example line (`500 / 2,000 mL`), "per eligible day" label, never a weekly target.
- Habit page: progress card (amount, target, unit, bar capped at 100% with the uncapped text), **Add progress** (manual entry with optional alternate unit and normalized preview; quick-add buttons; Undo toast), **Change target / unit** dialog (effective today / next scheduled day / date, impact preview, status confirmation), presets editor, daily totals list with day note editor and **Review contributions** for allowed users, tracking history, insights summaries.
- Habits list and Habits widget: numeric habits show `amount / target unit` and an **Open** link instead of Complete. New widget **Habit progress** (one chosen numeric habit; quick-adds, link to details; read-only on a display; states for paused, ended, unscheduled, completed, above target).

## API

`POST /api/v1/habits` takes `tracking`; `POST /habits/:id/tracking` (preview or apply), `PUT /habits/:id/quick-adds`, `POST /habits/:id/contributions`, `GET /habits/:id/contributions?on=`, `PATCH /habit-contributions/:id` (undo or correct), `GET /habits/:id/days?before=`, `PUT /habits/:id/day-notes/:date`.

## Database (`20261112090000_numeric_habits.sql`)

Tables `habit_tracking`, `habit_contributions`, `habit_day_notes`; `habit_checkins.derived`; event kinds `tracking_changed`, `contribution_corrected`; functions as above. Existing S28 functions are wrapped or re-created, not edited in place.

## Tests

- **Database:** access matrix for contributions and notes, cross-Home isolation, personal privacy; exact sums (0.1 + 0.2), 8/8 completion, 10/8 excess with one completion, next day starts at 0, shared contributors, retry and id reuse, 7-day window and 8-day refusal, paused/unscheduled/ended/untracked days, correction and Undo across the threshold with streak recalculation, historical target and unit versions, same-day target change with and without status flip, stale total, conversions and precision, discrete units, weekly refusal, presets, summaries, reminders (suppressed at target, snapshot payload), concurrency (two members on the last glass; duplicate retry).
- **Unit:** decimal parse/format in nl and en, conversions, schemas, routes, components with axe.
- **Playwright:** create a numeric habit, reach the target in steps, exceed, Undo, change target.

## Out of scope

Weekly/monthly numeric targets, timed sessions, intraday charts, calendar entries, Household Display rendering (S43–S44), push actions, points, Ora, goals (S30).

## Defaults picked (Ward may override)

1. Home day notes: managers edit, all viewers read.
2. Conversions needing more than 3 decimals are refused with a rounded preview (no "confirm rounding").
3. Presets are shared by every version with the same unit; per version otherwise.
4. 5 quick-add presets; quantity cap 1,000,000.
5. Presets are not effective-dated.
6. Insights summaries cover 8 weeks and 6 months.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests (29 files, 137 tests)
- [x] API and data layer
- [x] Interface and widget
- [x] Unit, route and component tests (web 2516, domain 2409)
- [x] Playwright (habits + numeric-habits, 7 passed)
- [x] Docs (ADR 0037, user stories, supabase-migrations, production-migrations)
- [x] Full suite (format, lint, typecheck, build)
- [x] Independent review: PASS, no BLOCKER/HIGH (`reviews/steps/S29-review.md`)

## Known follow-ups from the review (MEDIUM, not fixed in this step)

- M1: a retried contribution with the same client id but an edited amount answers `exists` and drops the new amount.
- M2: a unit change to a compatible unit does not convert the typed target or the presets in the form (the preview does).
- M3: scheduled later tracking versions are replaced by a new change without being listed in the preview.
- Nine LOW items (midnight retry, expectedTotal cap, wording, focus, polling) are listed in the review.
