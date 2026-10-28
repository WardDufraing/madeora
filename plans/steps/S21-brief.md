# S21 · Chore pool and volunteering — feature brief

**Branch:** `feat/chore-pool-claims`, from `main` at `7691458` (S20 merged as PR #35). Depends on S20 (merged).
**Sources (read only these ranges):** build plan S21; PS L1579–L1718 (overview, pool, proposals, reminders, eligibility, per-occurrence claims, unlimited claims, self-release, end-of-week expiry, manager digest, automatic release, no reservations, Undo, first-come claims, overview layouts, chore calendar), L1963–L2031 (volunteer requests, request details, roster, withdrawal, adding recipients, expiry, no reopening, correction), L1761–L1779 (request-based reassignment, pool filters and sorting); ARCH §8 (Realtime C), §9, §11, §39; ADR 0018, 0024, 0026.
**Model:** Opus (atomic first-come claims, first-accept-wins offers, Realtime authorization, jobs at week and due boundaries).
**Done when (build plan):** a two-member concurrent-claim test gives exactly one winner.

## Proposed split (decision asked of Ward, 2026-10-21)

The spec ranges hold about twenty confirmed decisions. Proposed, like S19:

- **S21 (this thread): pool and claims.** Unassigned this-week and overdue-unassigned pool with filters and sorting, per-chore "Who may claim?", one-tap claim with Undo, self-release and manager release, end-of-week expiry policy, automatic release after a grace period, Supabase Realtime for the pool, request-based reassignment.
- **S21b: proposals and volunteering.** Member-proposed chores with review, targeted volunteer requests (roster, withdraw, add recipients, expiry at due time, no reopening, correction of an accepted assignment).
- **S21c: overview, calendar and reminders.** Home chore overview widget (member-by-day matrix and daily cards, Week/Day, compact +N), Chores week/month calendar with drag and keyboard rescheduling, optional individual chore reminders, the manager's daily overdue summary.

Work starts on S21 as above either way; if Ward keeps one step, S21b and S21c follow in this thread.

**Ward's answer (2026-10-21): keep S21 as one step.** S21b and S21c below are built on the same branch, in two more migrations, with one full suite and one review at the end.

## S21b · Proposals and volunteer requests (defaults picked, Ward may override)

**Proposals** (PS L1588–L1596). `private.chore_proposals`: title, instructions, category, estimate, checklist (≤ 100 steps), proposed due day; states Pending review → Approved (published) / Rejected (reason 1–500) / Withdrawn. No drafts (optional in the spec). Every current member may propose; chore managers review. A manager may approve their own proposal (spec: only with the management permission, which they have). Approval may revise every field, shows the final values and is confirmed; it creates **one unassigned one-off chore** (claim mode All, expiry Overdue) in one transaction under the proposal's lock with the revision the reviewer saw, so two reviewers cannot publish twice. Duplicates: a person cannot have two pending proposals with the same title (compared like chore titles); reviewers see a "Possible duplicate" mark when another pending proposal or an open chore in the Home has that title, and decline it with a reason. The proposer gets an in-app notice of the decision (category `chores`). Managers find the queue through a "Proposals (n)" link on the Chores page (no notice per proposal). Points: S23 (no suggested points field yet). Separate page and label from the completion approval queue.

**Volunteer requests** (PS L1963–L2031). For an open occurrence in **Needs assignment review** (flagged, no assignee; S22 vacations will add more such cases), a chore manager sends a request to 1–20 selected current members. `private.chore_volunteer_requests` (one open per occurrence) and `private.chore_volunteer_invitations` (Pending / Accepted / Declined / Withdrawn by manager / Expired / Closed, with invitation and response times). While open the occurrence shows **Awaiting volunteer** and is not claimable. **First valid acceptance wins** under the chore lock: the accepter becomes the only assignee, the flag clears, other pending invitations close. Decline needs no reason. A manager withdraws single pending invitations, adds recipients not invited before (same deadline), or cancels the request; a direct assignment, skip, completion, deletion or pause closes it. When nothing stays pending and nobody accepted, the request closes and the occurrence stays in review. **Deadline:** chores are date-only, so the request expires at the **end of the due day** in the Home's timezone (default picked); expiry is lazy (`advance_chores`) and an acceptance at or after the deadline is refused even before that. A changed due date moves the deadline; a request whose deadline passed is never reopened, only a new request after a due date in the future. Invitees see only the chore details (title, due date, instructions, checklist, estimate) and their own invitation, never the reason, the roster or others' answers; managers see the roster. **Correct volunteer assignment:** a manager, before submission, with a reason (1–500) and a preview, returns the occurrence to review or assigns another current member; the accepted invitation stays Accepted; event `assignment_corrected`. Notices (category `chores`): invitation to each invitee, acceptance to the request's manager, correction to the former assignee. No notice per decline.

## S21c · Overview, calendar, reminders and digest (defaults picked, Ward may override)

**Home chore overview widget** (PS L1579–L1587, L1695–L1710). New dashboard widget **Chore schedule** for a Home: layouts **Member-by-day matrix** and **Daily grouped cards**, **Week / Day** switch with previous/next and Today, current Home-local week with today highlighted, Home week start; compact cells with a configurable limit (2, 3 or 5; default 3) and **+N more** that expands in place with a collapse control; a separate **Unassigned this week** section (follows the week; in Day mode says it is filtered to the day and offers the whole week) with Claim. Overdue, pending approval, rework, completed, skipped and expired shown with text, not colour only. The widget's settings hold the default layout and limit; a viewer's own switch is remembered in their browser per widget (per-viewer convenience, default picked). On narrow widths the matrix becomes a day-focused list with the week still selected. Wall displays come with the Household Display step.

**Chores calendar** (PS L1711–L1718). `/homes/:id/chores/calendar`: week and month views, member and category filters, day detail, open an occurrence. Chore managers move one eligible open occurrence (not pending, not in rework, not completed/skipped/expired) to another date and/or member by drag or by a keyboard and touch **Move** dialog; a preview shows old and new date and assignee and the impacts (becomes overdue or not, personal reminders that move or end, open handover or volunteer requests that end) and is confirmed with the revision seen. Only that occurrence changes; series and rotation stay. The main Calendar's **Show chores** overlay comes with the Calendar module step.

**Personal chore reminders** (PS L1597–L1605). Like S19b task reminders: an assignee sets one personal reminder per occurrence, at a date and time or N days (0–30) before the due day at a chosen time (date-only chores, so the time is always the person's choice), in the Home's timezone, previewed by the server. Delivered through the outbox job `chore-reminder` with a revision key, re-checked at delivery (still assignee, occurrence open and not submitted). It ends when the person stops being an assignee (release, handover, correction, departure) and when the occurrence closes; a before-due reminder follows a changed due date, and one whose new moment has passed ends. Occurrence only (no series reminders). Category `reminders`.

**Daily manager summary** (PS L1646–L1655). A chore manager opts in per Home (off by default) and picks a time in their own timezone. An hourly schedule (`chore-digest`) sends at most one in-app notice per Home, manager and local day, only when something qualifies: overdue assigned, overdue unassigned, pending review or rework, needs assignment review, automatic release within 24 hours. The notice carries counts; its link opens a live **Summary** page grouped by state, checked against the reader's rights at opening. Email follows the person's `chores` preferences and quiet hours (S14). It never changes chores.

## Points

Points and late points are S23. Nothing in S21 shows, stores or awards points; the pool and claim views leave the points slot out, and S23 adds it. Claiming and releasing never touch any reward record.

## Model (S21)

- **Claimable chores:** a chore whose assignment is _none_ gets **Who may claim?**: _All members_ (default), _Selected members_ (1–20 current members) or _Nobody (manager assigns)_. Stored on the schedule part (recurring; S19 scopes apply) and copied to each occurrence as it is created (`claim_policy`, plus `chore_occurrence_claimants`), so history keeps the rule that applied. An occurrence is **claimable** when it is open, not pending, not in the trash, has no assignee, is not flagged _Needs reassignment_, its chore is not ended or paused-through-it, its policy allows claims and (for close-after-week) its week has not ended.
- **Expiry policy** per chore (part / occurrence copy): _Stays available as overdue_ (default) or _Closes at the end of its week_. A closing occurrence moves to a new status **`expired`** ("Closed — unclaimed") at the end of its Home-local week (week start from the Home's setting); no completion, no points, distinct from Skipped. Expiry is applied lazily by `advance_chores` (as S20 generation) and by a scheduled job, both idempotent; a claim checks the cutoff itself, so a claim after the cutoff fails even if expiry has not run yet.
- **Claim:** `public.claim_chore_occurrence(occurrence, client_id)`: locks the chore row (S20 rule), re-checks membership, claim policy, eligibility, status, assignee and cutoff, then sets the claimant as the only assignee with `claimed_by`, `claimed_at`, `assignment_origin = 'claim'`. Two claims at once: one winner, the other gets `already_claimed`. A retry by the winner (same client id) returns success, not a second claim. Unlimited claims, no quota.
- **Undo and release:** Undo is a release of the same claim within a short UI window (10 seconds, default picked), a new checked action. **Release** (the claimant, while the occurrence is open, assigned to them by their own claim and not submitted; or a chore manager for any open unsubmitted occurrence) clears the assignee and returns it to the pool or, under close-after-week past its week, to `expired`. Checklist progress is cleared on release so the next claimant does not inherit it (the event log keeps who ticked what); the release dialog warns when there is progress.
- **Automatic release** per chore (default off): a grace of 0–30 days (in hours, default picked) after the due date (end of the due day, Home timezone). A self-claimed, open, unsubmitted, not-in-rework occurrence past that point is released by a scheduled job (idempotent, row-locked) with reason `auto_release`; the former claimant gets an in-app notification under their preferences. Manager-assigned, rotated and fixed occurrences are never auto-released.
- **Events:** S20's append-only `chore_occurrence_events` gains `claimed`, `released` (reason `self`, `undo`, `manager`, `auto`), `expired`, `reassignment_requested`, `reassigned`.
- **Request-based reassignment:** a member asks to move an open, assigned (fixed, rotated or claimed), not pending occurrence from its assignee (themselves, or any assignee if they are a chore manager) to another current member, with an optional note (≤ 200 characters). States Pending → Accepted / Declined / Cancelled / Invalidated, plus **Awaiting manager** when the Home requires manager confirmation (new Home chore setting, default off). One active request per occurrence. Acceptance (and confirmation) re-checks everything under the chore lock and swaps that one assignee on that occurrence only; rotation, series, due date, checklist progress and duration stay. Completion, skip, delete, departure, a manager reassignment or a schedule change invalidates pending requests. Recipient and requester are notified in-app.
- **Permissions (default picked):** every current member sees the pool and claims what is eligible to them; a member sees "Not eligible to claim" for a restricted chore, never the list of who is. Chore managers set claim, expiry and auto-release policies, release any claim, assign directly, confirm reassignments.

## Realtime (per-feature mechanism, default picked)

**Postgres Changes on a minimal per-Home signal row:** `public.chore_pool_signals(home_id, version, changed_at)`, RLS select only for current members of that Home, in the `supabase_realtime` publication. Any claim, release, expiry, assignment, completion or chore change bumps the Home's row in the same transaction. The pool view does an authoritative fetch, subscribes to its Home's row, and on any event, reconnect, tab resume or subscription error invalidates its TanStack queries; the subscription is released on leaving the view, Home switch and sign-out. No chore content travels over Realtime. CI's e2e stack starts with Realtime enabled for the pool test; the database tests cover the signal row's RLS across two Homes.

## Interface (S21)

- **Home › Chores**: new **Unassigned this week** section (Home-local week, today highlighted) and **Overdue unassigned**, with filters category (incl. Uncategorized), date range, duration (incl. Not set), sort due date / title, reset, matching/total counts, "Show only what I can claim". Each row: day, title, category, duration, recurring mark, **Claim** or "Not eligible to claim". Claim shows a toast with **Undo**. Claimed rows show **Release**.
- **Occurrence page:** Claim / Release, policy summary (who may claim, after its week, automatic release time), **Request reassignment** with the request state, accept/decline for the recipient, cancel for the requester, confirm/refuse for managers.
- **Chore editor (manage):** Who may claim?, After its week, Automatic release (off / after N hours).
- **Home settings › Chores:** "Reassignment requests need a chore manager's confirmation".
- nl and en; keyboard, screen-reader announcements for claim, Undo and conflicts; light and dark.

## API (S21)

`/api/v1/chore-occurrences/:id/claim` (POST), `/…/release` (POST), `/…/reassignment-requests` (POST), `/api/v1/chore-reassignment-requests/:id` (PATCH accept/decline/cancel/confirm/refuse), `/api/v1/homes/:id/chore-pool` (GET with filters), `/api/v1/homes/:id/chore-settings` (PATCH). Chore create/edit gain the three policies. Same CSRF, JSON, size, session and outcome mapping as S20.

## Tests (S21)

- **Database:** claim rules (policy all/selected/nobody, assigned, pending, completed, skipped, expired, deleted, ended, flagged, cross-Home id); **two-member concurrent claim gives exactly one winner** (two sessions, real locks); retry idempotency; claim vs release, claim vs expiry at the cutoff, release vs completion; Undo/release rights (manager-assigned not self-releasable); progress cleared on release; expiry at the Home-local week end incl. DST; auto-release job idempotent and its exclusions; per-occurrence isolation for recurring chores; reassignment request lifecycle, manager confirmation, invalidation, concurrent accepts; signal row RLS across two Homes.
- **Unit:** schemas, permission matrix, routes, pool filter/sort, components with axe.
- **Playwright:** two browsers claim the same chore, one wins and the other sees Already claimed without reloading (Realtime); Undo; release; reassignment request accepted; axe and keyboard in both themes.

## Out of scope (S21)

Points (S23); vacations and absences (S22); S21b and S21c above unless Ward keeps one step; main Calendar "Show chores" overlay (Calendar module step); reservations (spec: none).

## As built (differences from the plan above)

- Claim policies belong to the **chore**, not the schedule part, and apply to its open occurrences from the moment they change (no series scopes). A change is previewed; when it closes or releases something at once or leaves claims the new rule would not allow, the manager confirms.
- `claim_chore_occurrence(occurrence)` has no client id: a retry by the winner answers `claimed` again because the claimant is already the claimer.
- Expired occurrences are **final**: never reopened (replaces default 6 below).
- The week of an occurrence is the week of its **due date**; the week start is a new Home chore setting (Monday default; Monday, Saturday or Sunday).
- Notifications use a new optional category **`chores`** (in-app on, email opt-in): claim released (auto/manager), handover requested, answered, confirmation needed, decided, invalidated.
- A handed-over claim becomes an ordinary assignment; a departing member's claims return to the pool (event reason `departure`).
- **Release** sits on the occurrence page, not on overview rows (the overview list has no claimer).
- Pool filters run client-side over at most 200 rows; sort by due date (earliest/latest); duration buckets any / not set / ≤15 / ≤30 / ≤60 / more. Sorting by points comes with S23.
- Endpoints: `GET /api/v1/chore-pool?homeId&date`, `GET/PATCH /api/v1/chore-settings?homeId`, `GET /api/v1/chore-reassignment-requests?homeId`, `GET/PUT /api/v1/chores/:id/claim-policy`, `GET/POST /api/v1/chore-occurrences/:id/claim` (query parameters like S20, instead of `/homes/:id/…`).
- Event kind `reassignment_requested` is not used; requests have their own table and audit rows.
- Automatic release: lazily in `advance_chores` plus the delayed outbox job `chore-claim-release` (keyed by claim count). Expiry is lazy only; the claim checks the cutoff itself.
- E2E: CI's stack now starts Realtime; the local fallback has none (`E2E_REALTIME=0`), so live checks read the page again there.

## As built (S21b and S21c)

- Projected dates of recurring chores show on the calendar and widget as **Planned** and are never movable; only an existing open occurrence (not pending approval, not in rework) moves.
- Moving reuses `update_chore_occurrence` (wrapped) with `dryRun`; its impact adds overdue, reminders moved/ended, handover ended and volunteer request ended.
- The calendar uses the person's own first day of the week (like the task calendar); the widget uses the Home's chore week start.
- Dragging opens the Move dialog on the dropped day (preview and confirm still required); the Move button is the keyboard and touch way.
- The summary hour is in the manager's own timezone, resolved on the server. The summary page lists up to 50 occurrences per group.
- Widget: matrix rows are the Home's members plus "Nobody assigned" for unassigned chores outside the pool; the matrix becomes a day list below about 42rem of widget width.
- Endpoints: `/api/v1/chore-proposals[/:id]`, `/api/v1/chore-occurrences/:id/volunteers`, `…/volunteer-correction`, `/api/v1/chore-volunteer-requests[/:id]`, `…/reminder`, `/api/v1/chore-schedule`, `/api/v1/chore-summary-settings`.

## Defaults picked (Ward may override)

1. Undo window 10 seconds.
2. Releasing clears checklist progress (audit kept).
3. Automatic release grace in hours, 0–720, measured from the end of the due day.
4. Reassignment manager confirmation is a Home setting, off by default.
5. Realtime: Postgres Changes on a per-Home signal row with no chore content.
6. Expired occurrences read "Closed, unclaimed" in history and are never reopened.
7. Claim policies are per chore; the Home's week starts on Monday unless a chore manager changes it.

## Progress

- [x] Brief
- [x] Domain and migration (`20261101090000_chore_pool_claims.sql`)
- [x] Database tests (`chore-pool.test.sql`, `chore-pool-concurrency.test.ts`: one winner)
- [x] API and data layer, job `chore-claim-release`, notifications
- [x] Interface and Realtime (`chore-pool-live.tsx`)
- [x] Playwright (`chore-pool.spec.ts`)
- [x] Docs (ADR 0027, development.md, supabase-migrations.md, background-jobs.md)
- [x] S21b proposals and volunteer requests (`20261102090000_chore_proposals_volunteers.sql`)
- [x] S21c overview widget, chores calendar, reminders, manager summary (`20261103090000_chore_overview_reminders.sql`)
- [x] Playwright (`chore-overview.spec.ts`: proposals, volunteers, calendar, move, reminder, summary, widget)
- [x] Docs (ADR 0028, development.md, supabase-migrations.md, background-jobs.md, trigger-setup.md, cost register)
- [ ] Full suite
- [ ] Independent review
