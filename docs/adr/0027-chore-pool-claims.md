# ADR 0027: The unassigned chore pool, claims and reassignment requests

- **Status:** Accepted for S21 within the approved architecture (§8 Realtime C, §9, §11, §39), CLAUDE.md (database access A, authorization C, data fetching B, background processing B, forms A, date/time A, €0 budget) and the spec's pool and claim sections (PS L1579–L1718, L1761–L1779). The defaults below are open to correction by the owner. Proposals, volunteer requests, the overview layouts and the chore calendar are proposed as S21b and S21c (brief).
- **Date:** 2026-10-21
- **Step:** S21 (brief: `plans/steps/S21-brief.md`). Builds on S20 (chores, ADR 0026), S14 (notifications, ADR 0018) and the outbox jobs (ADR 0013).

## Context

A chore assigned to nobody waits for a volunteer. Members need to see what is unclaimed this week, claim it in one tap with a short Undo, and give it back. Two members claiming the same occurrence must never both get it. Managers decide who may claim, whether unclaimed chores close at the end of their week, and whether a claim nobody finishes goes back to the pool. Members also need to hand one occurrence over to someone else. Everything stays per Home, and the pool should update while it is open.

## Decision

**One migration, no exposed chore tables.** `20261101090000_chore_pool_claims.sql` adds the claim policy columns on `private.chores`, `private.chore_claimants`, `private.home_chore_settings`, `private.chore_reassignment_requests`, the occurrence status `expired`, the claim columns on occurrences and the event kinds `claimed`, `released` (reason `self`, `undo`, `manager`, `auto`, `departure`), `expired` and `reassigned`. Every read and change is a `security definer` function with the person's session.

**The pool.** An open occurrence with no assignee, not flagged for reassignment, of a chore that is not ended and whose claim mode is not `none`. Every current member sees it; a member who may not claim sees "Not eligible", never who is. An occurrence belongs to the week of its due date, in the Home's timezone, with the week start from the new Home chore setting (Monday unless a chore manager changes it). The pool shows the chosen week and every overdue unassigned occurrence; filters and sorting (category, dates, duration, due date order, only claimable) are client-side over at most 200 rows. Sorting by points comes with S23.

**Claim policies belong to the chore (default picked).** Who may claim (`all` default, `selected` 1–20 current members, `none`), the expiry policy (`overdue` default, `week_end`) and automatic release (off, or 0–720 hours after the end of the due day). They apply to the chore's open occurrences from the moment they change, without series scopes. A change is previewed first; when it closes or releases occurrences at once, or leaves claims the new rule would not allow (they stay), the manager confirms.

**Claim.** `claim_chore_occurrence` locks the chore row (the S20 rule for every chore change), re-checks membership, policy, eligibility, status, assignees and the week cutoff, and makes the claimant the only assignee. Of two claims at once exactly one wins; the other gets `already_claimed` with who has it, and a retry by the winner answers `claimed` again. Unlimited claims, no reservations, no points.

**Undo and release.** Undo is a release with reason `undo`, offered for 10 seconds in a toast (default picked). The claimant may release before submitting; a chore manager may release any claim. Release clears the checklist progress (the events keep who ticked what) and returns the occurrence to the pool, or closes it when its week has ended under `week_end`. A manager changing the assignees in another way ends the claim; a departure returns the departed member's claims to the pool.

**Expiry.** Under `week_end` an occurrence still unclaimed when its week ends becomes `expired` ("Closed, unclaimed"): never completed, distinct from skipped, never reopened (default picked). A claim checks the cutoff itself, so a claim after it fails even before anything closed the occurrence.

**Automatic release.** A self-claimed, open occurrence not in Needs rework is released at its deadline. Both a lazy pass before chore pages read (`advance_chores`) and a delayed outbox job (`chore-claim-release`, keyed by the occurrence and its claim count, so a stale job does nothing) apply it under the chore lock. The former claimant gets an in-app notice in the new optional category `chores`.

**Reassignment requests.** An assignee (or a chore manager, for any assignee) asks another current member to take over one open occurrence, with an optional note of up to 200 characters. One open request per occurrence. The recipient accepts or declines, the requester cancels. When the Home's setting requires it (off by default), an accepted request waits for a chore manager's confirmation. Acceptance and confirmation re-check everything under the chore lock and swap that one assignee on that occurrence only; a handed-over claim becomes an ordinary assignment. Completion, skip, deletion, a changed assignment or a departure invalidates an open request. Every step notifies the people involved in-app.

**Realtime (per-feature mechanism, default picked).** Postgres Changes on `public.chore_pool_signals(home_id, version, changed_at)`: one row per Home, readable by its current members only (RLS), in the `supabase_realtime` publication. A trigger bumps the version once per transaction whenever a chore, an occurrence, its assignees, a claim policy or the chore settings change. No chore content travels. The overview and occurrence pages render the version they read; the client subscribes to the Home's row, and on an event, on (re)subscribing and when the tab becomes visible again compares versions and re-reads the page with the person's session (debounced). The channel is removed when the view unmounts, the Home changes or the person signs out. Delivery and order are never trusted.

**API.** `GET/POST /api/v1/chore-occurrences/:id/claim`, `POST …/release`, `POST …/reassignment-requests`, `GET /api/v1/chore-reassignment-requests?homeId`, `PATCH /api/v1/chore-reassignment-requests/:id`, `GET/PUT /api/v1/chores/:id/claim-policy`, `GET /api/v1/chore-pool?homeId&date`, `GET/PATCH /api/v1/chore-settings?homeId`. Query parameters instead of `/homes/:id/…` match the S20 routes. Same CSRF, JSON, size, session and outcome mapping as S20.

## Consequences

- The concurrency test (`tests/db/rls/chore-pool-concurrency.test.ts`) proves one winner with two real sessions; the e2e test repeats it from two browsers.
- CI's e2e stack now starts Realtime. The local fallback stack has none, so there (`E2E_REALTIME=0`) live checks read the page again; the CI job is the binding check.
- A hosted project needs the `supabase_realtime` publication (present by default); without it the pages still refresh after the person's own changes and on reload.
- Points, vacations, proposals, volunteer requests, the overview layouts, the chore calendar and reminders are not part of S21.

**Handover on behalf of an assignee (S21 follow-up).** A chore manager who is not an assignee may ask a handover on an assignee's behalf (`fromMember`; anyone else gets `not_permitted`); the request records the assignee as `from_user` and the manager as `requested_by`, and the assignee answers or cancels it like any other.
