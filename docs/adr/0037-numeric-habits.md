# ADR 0037: Numeric habits

- **Status:** Accepted for S29 within the approved architecture (§4, §6, §9, §15, §19, §21, §34, §36, §39, §43), CLAUDE.md (database access A, authorization C, forms A, internationalization A, date/time A, €0 budget) and the spec's numeric habit decisions (PS L2793–L2915). The defaults below are open to correction by the owner.
- **Date:** 2026-10-29
- **Step:** S29 (brief: `plans/steps/S29-brief.md`). Builds on ADR 0035 (habits). It changes no S28 function in place.

## Context

S28 habits complete once per scheduled day. The spec adds a daily numeric target (water, pages, minutes) reached in steps, with units and limited conversions, target changes that never rewrite history, exact decimals entered in the person's locale, and privacy for who contributed what. The done-condition is that decimal and locale entry tests pass in nl and en.

## Decision

**Completion stays a check-in.** A numeric habit's day completes through the existing check-in machinery: when the sum of active contributions reaches that day's target, `private.habit_numeric_sync` writes one derived check-in (`derived = true`); when an Undo, correction or same-day target change takes the total below, it marks that check-in undone. Streaks, milestones, insights, reminders and pauses are unchanged. A derived check-in cannot be completed, undone or noted directly (`numeric_required`, `numeric_derived`). A target-change sync never celebrates.

**Tracking versions.** `private.habit_tracking` holds dated versions (`mode`, `target`, `unit`, `unit_kind`, `quick_adds`); no row means complete once. The version in effect on a date decides its target and unit, so history never changes. Mode and unit changes apply from tomorrow; a target-only change may apply today, on the next scheduled day or on a chosen date, after an impact preview. A same-day change that flips today between partial and complete needs a separate confirmation (`confirm_status`), and a stale preview is refused (`stale`). Weekly schedules cannot be numeric, in either direction (`numeric_requires_daily`).

**Contributions are never deleted.** `private.habit_contributions` stores positive increments in the day's canonical unit, with the original entry and unit when converted, the contributor, recording time, source and a client id for idempotent retries. Undo (own, within 7 days) and a manager's correction mark a row `undone`; a manager may amend a quantity, keeping the original. Totals are exact decimal sums; excess is shown and never carries over.

**Exact arithmetic.** `numeric(12,3)` in the database; whole thousandths in the browser; the API takes decimal strings (or exact three-decimal numbers). Units: glasses, pages and repetitions (whole numbers), ml, l, min, h, m, km, or a custom label of 1–20 characters. Only l↔ml, h↔min and km↔m convert, exactly; a conversion needing more than three decimals is refused with a rounded preview. Quantities are positive and at most 1,000,000.

**Locale entry.** `parseQuantity(text, locale, unit)` reads only the locale's decimal separator (nl `,`, en `.`) and refuses the other separator, thousands separators, signs, exponents and extra precision with a reason; the form shows the normalized value before saving.

**Privacy.** Contribution rows are readable only through `get_habit_contributions`: the contributor sees their own, the owner and managers see all with attribution, everyone else sees aggregate daily totals. Contributions write no `habit_events` (readable by every viewer); a manager's correction and every tracking change do, plus a Home audit event.

**Notes, reminders, widget.** One plain-text day note (≤ 280) per habit and day, edited with a revision (managers edit, viewers read in a Home). An unmet day's reminder carries a point-in-time progress snapshot; Complete in the notification becomes an Add progress link. A new **Habit progress** widget (`habit-progress`) shows one numeric habit with quick-adds (read-only on a display). Numeric habits create no calendar entries.

**Summaries.** Insights cover 8 weeks and 6 months: total, eligible days, average per eligible day (zero days included) and days that met their target; compatible units merge into the latest unit of that dimension, incompatible or custom units form separate segments.

## Consequences

- Any new write on contributions must take the habit row lock first, then derive the check-in in the same transaction.
- Weekly or monthly numeric targets, intraday charts and Household Display rendering (S43–S44) are out of scope.
- The migration is forward-only; repairing it on production means a new migration. A personal export (S38) and account deletion (S40) must include `habit_contributions` and `habit_day_notes` by owner or contributor.
- **Rollback and compatibility:** the migration adds tables and one column (`habit_checkins.derived`, default false) and re-creates the habit functions listed in it (it drops the old `create_habit` signature). Rolling the app back to S28 code while the migration stays applied is not supported for creating habits; repair forward with a new migration. Existing data is unchanged.
