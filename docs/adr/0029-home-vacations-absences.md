# ADR 0029: Home vacations and temporary chore absences

- **Status:** Accepted for S22 within the approved architecture (§8 Realtime C, §9, §11), CLAUDE.md (database access A, authorization C, data fetching B, background processing B, forms A, date/time A, dashboard layout B, €0 budget) and the spec's sections on Home vacations (PS L1804–L1962) and temporary chore absences (PS L2032–L2039). The defaults below are open to correction by the owner.
- **Date:** 2026-10-21
- **Step:** S22 (brief: `plans/steps/S22-brief.md`). Builds on ADR 0026 (chores), ADR 0027 (pool and claims) and ADR 0028 (proposals, volunteers, overview).

## Context

A Home goes away together, or one member is away for a while. Chores should not pile up on people who are not there, rotations should pass turns on fairly, and a manager should decide what a person cannot decide automatically. The spec asks for member-scoped vacations with participant approval, a Home-wide pause, vacation-aware rotation, a per-occurrence override and a planning-only absence period.

## Decision

**One migration, no exposed tables.** `20261104090000_home_vacations.sql` adds `private.home_vacations`, `home_vacation_participants`, `home_vacation_date_proposals`, `home_vacation_events`, `chore_vacation_decisions` and `chore_absences`, the occurrence status `paused` and the occurrence columns `substitute_for` and `vacation_review`. Every read and change is a `security definer` function run with the person's session; reminder delivery is for `service_role` only. Changes return `(outcome, impact, revision)`; `dryRun` runs the same code and rolls it back inside the function, so the preview is exactly what confirming does. Lock order: the Home's advisory lock, then the vacation, then chores.

**Vacations.** One bounded record per Home with an optional name (empty is the generic "Home vacation"). Its dates are the envelope of the accepted participants' own dates; its status is derived (Cancelled, else Upcoming, Active or Ended against the Home-local today). Participants are Pending, Accepted, Declined, Withdrawn or Expired. A chore manager adds members directly; any other member records their own stay and suggests others, who are invited. An invitation expires at the start of its start day (lazily; an acceptance at or after it answers `expired`). A participant changes their own dates; others propose dates (one pending proposal per participant, a newer one supersedes it). Every change carries the revision the person saw.

**Rights (defaults picked).** Vacations use the existing chore manager capability (`manageHomeChores`). Every current member sees vacations, names, dates and participants; invitations and date proposals are visible to their recipient, the proposer and chore managers; history to chore managers and the creator. The table in the brief is the permission matrix, mirrored in `@madeora/domain/vacations` for the interface only.

**Effects on chores.** Applied once per occurrence however many vacations overlap, when an occurrence is created and again for existing open future occurrences whenever a vacation changes.

- _Away_ is an Accepted participation covering the date, with the participant's own dates.
- _Rotation:_ a rotating occurrence whose turn member is away passes to the next available member in rotation order; the order and baseline turns never change and the returning member owes nothing. Nobody available: unassigned and flagged Needs assignment review. The occurrence records whom it substitutes for.
- _Home-wide pause:_ a chore manager confirms it after a preview; it stores the dates on which every current member was an accepted participant. A date stays paused only while it is in that set and everyone is still away in that vacation, so it shrinks at once and never grows without a new confirmation; two partial vacations never combine. Recurring occurrences on paused dates get the status Paused (Home vacation): not open, not overdue, not claimable, no reminders (personal reminders on them end), no auto-release. They reopen when the date is no longer paused and still today or later; past dates stay paused.
- Only untouched future occurrences change automatically. Fixed, claimed, manager-assigned and one-off work of an away member, chores overdue before the vacation, and work pending approval or in rework are listed in the vacation's affected-chores review. A chore manager decides Keep, Skip, Reassign or (one-off chores) Reschedule once per occurrence and source; a decision is never re-asked. One-off chores on paused dates without a decision are flagged Needs vacation review.
- _Override:_ assigning an away member to one occurrence (occurrence edit, calendar move or a review reassignment) answers `409 member-away` unless the person confirms (`confirmAway`); the preview names who is away.

**Absences.** A member registers their own, a chore manager anyone's: inclusive dates and an optional private reason (at most 200 characters), visible to that member and chore managers only. A planning signal only: nothing changes automatically; the absence's review lists the member's affected occurrences and planned dates, and a chore manager decides Keep, Skip or Reassign.

**Reminder and notices.** An optional pre-vacation reminder (1–30 days before the start, 09:00 Home time) is the outbox job `vacation-reminder`, keyed by vacation, start and lead days; delivery re-checks the vacation and tells each chore manager (category `reminders`) the counts of open decisions and claimed chores. Creating, editing, ending or cancelling a vacation sends nothing; only an invitation and a date proposal notify their recipient (category `chores`).

**Interface and API.** Home › Vacations (requests, active, upcoming, history, New vacation with preview), the vacation page (actions by role, Home-wide pause, affected chores, history), Chores › Absences, a paused-today notice and vacation marks on the chores calendar, the occurrence page's vacation state, and the optional "Home vacation" dashboard widget (scope labels only, never who is away). Routes: `GET/POST /api/v1/vacations`, `GET/PATCH /api/v1/vacations/:id`, `POST /api/v1/vacations/:id/participants`, `GET /api/v1/vacations/:id/review`, `GET /api/v1/vacations/days`, `PATCH /api/v1/vacation-participants/:id`, `PATCH /api/v1/vacation-date-proposals/:id`, `POST /api/v1/chore-vacation-decisions`, `GET/POST /api/v1/chore-absences`, `PATCH /api/v1/chore-absences/:id`, `GET /api/v1/chore-absences/:id/review`. Same CSRF, JSON, size, session and outcome mapping as S20 and S21.

## Consequences

- One more Trigger.dev task (`vacation-reminder`), at most a few runs per vacation, well inside the free plan.
- Rotation, pause and overlapping vacations are proved in `home-vacations.test.sql`; the races (two managers deciding, two acceptances, acceptance against withdrawal) with real sessions in `home-vacations-concurrency.test.ts`.
- Not in S22: habit and meal pause switches (S27, S28), main Calendar banners (S32), display privacy (S43–S44), pet care in the reminder (S31), guardian rules (S41), points (S23). Bulk changes do not warn about away members yet; the Home history filter has no Paused state.
