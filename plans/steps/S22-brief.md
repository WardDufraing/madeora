# S22 · Home vacations and absences — feature brief

**Branch:** `feat/home-vacations`, from `main` at `17955dc` (S21 merged as PR #36). Depends on S21 (merged).
**Sources (read only these ranges):** build plan S22; PS L1804–L1962 (recurring pauses and Home vacations, member-scoped vacations and participant approval, invitation expiry, individual participant dates, date-change approval, withdrawal, statuses, silent updates, early ending, overlapping vacations, pre-vacation reminders, names, widget, calendar banners, non-recurring, module switches, one-time chore handling, vacation-aware rotation, per-occurrence override, no-available-participant resolution), L2032–L2039 (temporary chore absence periods); ARCH §8, §9, §11; ADR 0026–0028.
**Model:** Opus (vacation-aware rotation, Home-wide pause intervals, concurrency between invitations, expiry and edits).
**Done when (build plan):** rotation and pause tests cover overlapping vacations.

Ward kept S21 as one step, so S22 is one step as well: one branch, one migration, one full suite, one review.

## What already exists

- The **individual recurring chore pause** (until a date or indefinitely, resume) was built in S20 (`set_chore_paused`). S22 adds nothing to it except that it combines with vacations (both suppress; the stricter wins).
- Occurrences are created lazily (`advance_chores`): every date up to today plus one upcoming per recurring chore. "Future occurrences" are therefore mostly not stored yet; vacation rules are applied when an occurrence is created and re-applied to existing open future occurrences whenever vacations change.
- **Needs assignment review** (S21b) is the existing flagged-and-unassigned state, with assign, skip and volunteer requests as resolutions.

## Model

**Vacation** (`private.home_vacations`): one bounded, non-recurring record per Home. Optional name (trimmed, 1–80 characters, plain text; empty means the generic "Home vacation"). Overall dates are the **envelope** of the accepted participants' dates (kept on the row, recomputed on every change; kept as they were when nobody is left). Status is derived, never picked: **Cancelled** (explicit, final), else **Upcoming / Active / Ended** against the Home-local today. Optional pre-vacation reminder (off, or 1–30 days before the start). Optional confirmed **Home-wide chore pause** (below). Append-only history (`private.home_vacation_events`).

**Participants** (`private.home_vacation_participants`): one row per member per vacation attempt, each with its own inclusive dates inside the Home timezone. States **Pending / Accepted / Declined / Withdrawn / Expired**, separate from the vacation's status. A member added by a chore manager, or the creator themselves, is Accepted at once; a member suggested by a non-manager creator is Pending until they accept. A pending invitation expires at the start of its proposed start day (Home timezone): applied lazily, and an acceptance at or after that moment fails with `expired`. A re-invitation is a new row with a future start; expired, declined and withdrawn rows are never revived.

**Date changes** (`private.home_vacation_date_proposals`): a participant changes **their own** dates directly. A chore manager changes directly the dates of participants a manager added. For a participant who joined through an invitation (or created the vacation themselves), a change by someone else is a **proposal** to that participant (one pending per participant; a newer one supersedes it; withdrawing ends it). Until they accept, their accepted dates stay in force.

**Who may do what (defaults picked):**

| Action                                                | Any member                        | Creator                                     | Participant (self) | Chore manager                   |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------- | ------------------ | ------------------------------- |
| Create a vacation                                     | for themselves (+ suggest others) |                                             |                    | for any members, added directly |
| Invite more / withdraw a pending invitation           |                                   | yes                                         |                    | yes                             |
| Add or remove participants directly                   |                                   |                                             |                    | yes                             |
| Accept / decline invitation, answer a date proposal   |                                   |                                             | yes                |                                 |
| Withdraw self, change own dates                       |                                   |                                             | yes                |                                 |
| Rename                                                |                                   | yes                                         |                    | yes                             |
| End early / shorten                                   |                                   |                                             |                    | yes                             |
| Cancel                                                |                                   | when they are the only accepted participant |                    | yes                             |
| Home-wide pause, reminder, chore decisions, overrides |                                   |                                             |                    | yes                             |

Vacation management uses the existing **chore manager** capability (`manageHomeChores`); no new capability. Every current member sees the Home's vacations (name, dates, status, participants with their own dates). Pending invitations and date proposals are visible to their recipient, the proposer and chore managers. History is visible to chore managers and the creator. Guardian rules come with S41.

**Effects on chores** (applied once per occurrence, however many vacations overlap):

- **Away** = an Accepted participation in a non-cancelled vacation covering that date, using the participant's own dates (never the envelope, pending invitations or unaccepted proposals).
- **Home-wide pause** = a chore manager confirmed it on a vacation after a preview; it stores the dates on which every current member was an accepted participant of that vacation at confirmation. A date is paused only while it is in that confirmed set **and** every current member is still away in that vacation. So withdrawals, shortening or a new member shrink it at once; it never grows without a new confirmation. Two partial vacations never combine into a Home pause.
- **Recurring occurrences on a Home-paused date** get the new status **Paused (Home vacation)**: not open, not overdue, not claimable, no reminders, no auto-release, no points. Generated ones are created paused (so cancelling the vacation brings them back). When the date is no longer paused and still today or later, they reopen; past paused dates stay paused (no backfill).
- **Rotation:** for a rotating occurrence whose turn member is away, the turn passes to the next available member in the rotation order (the order and the baseline turns never change; the returning member owes nothing). Nobody available: unassigned and flagged **Needs assignment review**. The occurrence records whom it substituted for.
- These automatic rules touch only **untouched** future occurrences (today or later): open, not claimed, not in rework, no ticked step, not changed on their own, no open handover or volunteer request, no recorded vacation decision, and still as generated (or as a vacation rule left them). Anything a person changed is protected.
- **Fixed, claimed, manager-assigned and one-off work** of an away member is never changed automatically; it appears in the vacation's **affected chores** review for a chore manager: **Keep**, **Skip** or **Reassign** (to a current member). Decisions are recorded per occurrence and source (`private.chore_vacation_decisions`) and never re-asked or reverted.
- **One-off chores on Home-paused dates:** mandatory review **Keep original date / Reschedule / Skip** (individually or in bulk). Undecided ones are flagged **Needs vacation review**: not claimable, no auto-release, not shown as overdue.
- Chores **overdue before the vacation**, pending approval and Needs rework are listed as protected or for review, never changed.
- **Override:** a chore manager assigning an away member to one occurrence gets a warning (`member_away`) and must confirm; the occurrence is then protected. Eligibility is never relaxed.

**Temporary absences** (`private.chore_absences`): a member registers their own (a chore manager may register one for any member): inclusive dates, optional private reason (≤ 200). A planning signal only: nothing changes automatically. The member and chore managers see an **affected chores** review (existing occurrences assigned to them in the range, their overdue ones, and planned dates of their recurring chores marked Planned) where a chore manager decides Keep, Skip or Reassign. Edit, end early and remove re-open the review for newly affected occurrences only. Reason and dates visible to the member and chore managers only.

**Pre-vacation reminder** (optional, off by default, set by a chore manager per vacation: 1–30 days before the start, at 09:00 Home time): an outbox job `vacation-reminder` keyed by vacation, start and lead days. At delivery the database re-checks (not cancelled, start still ahead, same start and lead days) and tells each chore manager (category `reminders`, preferences and quiet hours apply) the counts of open decisions and claimed chores in the period, with a link to the review. Nothing changes.

**Silent rule:** creating, editing, ending or cancelling vacations sends no notifications. Only actionable requests notify (category `chores`): an invitation to its invitee, a date proposal to its recipient. Skips and reassignments made in a review notify like the existing actions.

## Interface

- **Home › Vacations** (`/homes/:id/vacations`): my pending invitations and date proposals on top (Accept / Decline with a personal impact preview), then Active, Upcoming, and History (Ended, Cancelled). **New vacation**: name, dates, participants (members: themselves plus suggestions with proposed dates; managers: any members with individual dates), reminder (managers), preview, confirm.
- **Vacation page** (`/homes/:id/vacations/:vacationId`): status, dates, participants with their own dates and states; actions by role (above), each consequential one previewed and confirmed with the revision seen; Home-wide pause (preview of paused dates, affected chores, then confirm); affected chores review with decisions; history.
- **Absences** (`/homes/:id/chores/absences`): my absences and, for managers, everyone's; create, edit, end early, remove; review with decisions.
- **Chores**: a notice when the Home is paused today; occurrence page shows Paused (Home vacation), "Substitute for … (vacation)", Needs vacation review; the chores calendar marks vacation days ("Home vacation", "N away"); assigning an away member warns.
- **Dashboard widget "Home vacation"** (optional, in the catalog): the active vacation, else the next upcoming one, its dates, status, scope ("Whole Home away", "N members away", "You are away") and whether chores are paused; calm empty state; link to the vacation.
- nl and en; keyboard and screen reader; light and dark.

## API

`GET/POST /api/v1/vacations?homeId` (list; create with `dryRun`), `GET/PATCH /api/v1/vacations/:id` (rename, end early, cancel, reminder, Home pause on/off; `dryRun`), `POST /api/v1/vacations/:id/participants` (add or invite), `PATCH /api/v1/vacation-participants/:id` (accept, decline, withdraw, change dates, propose dates, remove, withdraw invitation; `dryRun`), `PATCH /api/v1/vacation-date-proposals/:id` (accept, decline, withdraw), `GET /api/v1/vacations/:id/review`, `GET/POST /api/v1/chore-absences?homeId`, `PATCH /api/v1/chore-absences/:id`, `GET /api/v1/chore-absences/:id/review`, `POST /api/v1/chore-vacation-decisions`. Same CSRF, JSON, size, session and outcome mapping as S20/S21.

## Tests

- **Database:** status derivation at first/last day and in a different timezone; permissions per action (member, creator, participant, manager, non-member, other Home); invitation expiry at the start day and the boundary race with acceptance; date proposals (accept, decline, supersede, withdraw); withdrawal and empty roster; envelope; three-person rotation with one away, staggered dates, **two overlapping vacations**, all away (review), return without catch-up, protected occurrences untouched, override; Home-wide pause confirmation, shrink on withdrawal, no growth without confirmation, **overlapping vacations with one pausing**, cancel and shorten resuming only future dates, no backfill; one-off review (keep, reschedule, skip, defer flag); absences review; reminder delivery and dedupe; concurrency: two acceptances / acceptance vs expiry, two managers deciding the same occurrence.
- **Unit:** domain status and permission matrix, schemas, routes, components with axe.
- **Playwright:** member creates a self vacation and the rotation passes to the next member; manager creates a whole-Home vacation, confirms the pause, reviews one-off chores; invitation accept and decline; widget; axe in both themes.

## Out of scope (with the step that brings it)

Shared-habit and meal-planning pause switches (S27, S28: the modules do not exist yet); main Calendar banners and the "Show Home vacations" toggle (S32); wall and shared display privacy (S43–S44: the widget already shows only scope labels); pet-care items in the reminder (S31); guardian and child rules (S41); points (S23).

## Defaults picked (Ward may override)

1. Vacations are managed with the chore manager capability; no new capability.
2. Every member sees vacations with names and participants; invitations, proposals and history are limited as above.
3. Home-wide pause is stored as the confirmed full-absence dates and only shrinks automatically.
4. Recurring occurrences on paused dates get status Paused (Home vacation); personal reminders on them end.
5. Pre-vacation reminder at 09:00 Home time, to every chore manager.
6. Invitations and date proposals notify under category `chores`.
7. Absences: a member registers their own, a chore manager anyone's.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests
- [x] API, data layer, job
- [x] Interface
- [x] Playwright
- [x] Docs (ADR 0029, development.md, supabase-migrations.md, background-jobs.md, trigger-setup.md, provider-cost-register.md)
- [x] Full suite
- [x] Independent review (CHANGES_REQUIRED: H1 fixed and verified; M1, M2 fixed; rest open below)

## As built

- **Migration** `supabase/migrations/20261104090000_home_vacations.sql`: tables, status `paused`, occurrence columns `substitute_for` and `vacation_review`, rule application inside `advance_chores` and on every vacation change, the wrapped `update_chore_occurrence` (`member_away` unless `p_confirm_away`), reviews, decisions, absences, the reminder outbox job and delivery, widget/day reads.
- **Domain** `packages/domain/src/vacations` (limits, derived statuses, permission projection); notification kinds `vacation.invited`, `vacation.dates_proposed`, `vacation.reminder` (domain, email texts, notification list).
- **Job** `vacation-reminder` (`packages/jobs`: job, service, Supabase call, Trigger.dev task, fake and tests).
- **Web** `apps/web/src/vacations/*` (types, schemas, zod-parsed reads, `vacationAnswer`), 11 route files under `api/v1`, pages Vacations, vacation detail, Absences, absence review; components in `components/vacations/`; chores changes (Paused state, vacation events, occurrence note, calendar marks, paused-today notice, away warning in occurrence edit **and calendar move**); dashboard widget `home-vacation`; nl/en messages (Vacations namespace).
- **Tests** `tests/db/rls/home-vacations.test.sql` (overlapping vacations in rotation and pause), `tests/db/rls/home-vacations-concurrency.test.ts`, `apps/web/src/app/api/v1/vacations/vacations.test.ts`, `apps/web/src/components/vacations/vacations.test.tsx`, additions to `chores.test.tsx`, `chore-schedule.test.tsx`, `dashboard-board.test.tsx`, `layout.test.ts`, domain and jobs tests, `tests/e2e/specs/home-vacations.spec.ts`.
- **Known gaps (left for later steps or Ward):** bulk reassign does not warn about away members; overview lists may show undecided vacation-review one-offs as overdue; personal reminders on paused occurrences end (default 4); habit/meal switches deferred (S27/S28); the Home history filter has no Paused state; the paused-today notice links to the vacations list, not the vacation; a skipped or reassigned item leaves the affected-chores list (only Keep stays with its decision line); an occurrence page's "Next dates" shows baseline rotation turns, not vacation substitutes; the Accepted/Declined announcement is lost when the answered request leaves the page (same as S21 volunteer offers).
- **Open review findings for Ward (not blocking):** M3 participation/date changes do not bump the vacation revision, so a pause confirmation can cover more dates than previewed; M4 the database still allows date changes and proposal answers on an Ended vacation (the UI does not); M5 undecided one-off vacation-review chores can show as overdue; M6 test gaps (shortening a paused vacation, no-backfill, overlapping vacations where only one pauses, last-day status in another timezone, a real acceptance-versus-expiry race); L1–L7 in `reviews/steps/S22-review.md`.
