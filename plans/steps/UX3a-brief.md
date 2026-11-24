# UX3a — Work periods as flagged native calendar events (backend only)

Source: `plans/steps/UX00-redesign-plan-brief.md` (Ward's answer 2026-11-19: work periods are flagged native recurring events, no new module; the §4.2 rule that unshared events, including busy status, are invisible to other Home members applies). No UI in this slice.

## Scope and decisions
- New column `private.calendar_events.work_period boolean not null default false` (migration `20261221090000_work_periods.sql`, one file, additive).
- A shift pattern is a recurring event; a changed or cancelled shift is a native recurrence exception; the flag lets the UI draw a background block.
- **Personal only, never shared** (default chosen, strictest reading of §4.2): check constraint (no Home, has owner), trigger refusing any share row (22023).
- **Flag fixed at creation**: trigger refuses changes (22023); `update ... 'all'` never writes the column. Known, accepted gap: a "this and following" split takes the flag from the request body, so an owner could flip their own later series; no privacy effect (still personal, shares refused).
- `create_calendar_event` reads `workPeriod` through `calendar_values` (redefined with one added line); every occurrence and detail read exposes `workPeriod` through `calendar_occurrence_json` (redefined with one added key). Functions otherwise unchanged.
- Upcoming widget and list reads still return work periods (flagged); the UI slice decides how to show or filter them.
- Web contract: `eventFieldsSchema.workPeriod` (optional), `createEventSchema` refuses work period with a Home or shares, `occurrenceSchema.workPeriod` (default false).

## Rollback
Drop the two triggers, the constraint and the column; restore `calendar_values` and `calendar_occurrence_json` from `20261118090000_calendar.sql`. Flagged rows become ordinary personal events.

## Tests
- `tests/db/rls/work_periods.test.sql` (16 assertions): flag in list and detail, invisibility to Home members (list, page, widget, change/delete), Alice through her Home sees none, Home work period refused, share refused (create and afterwards), non-boolean flag refused, flag fixed, cancel and move one shift, split keeps series flagged.
- `apps/web/src/calendar/schema.test.ts` work-period case.
- Local: ran the new SQL test on a throwaway Postgres 16 with the shim and all migrations (pass); calendar unit tests, tsc, eslint, prettier pass. Full suite on CI.

## Files
migration, `tests/db/rls/work_periods.test.sql`, `apps/web/src/calendar/{schema,shapes,testing,schema.test}.ts`, `apps/web/src/ora/overview/fixtures.ts`.
