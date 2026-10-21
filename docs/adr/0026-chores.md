# ADR 0026: Chores, approval and the chore widgets

- **Status:** Accepted for S20 within the approved architecture (§4, §9, §15, §36), CLAUDE.md (database access A, authorization C, data fetching B, forms A, frontend B, date/time A, dashboard layout B, €0 budget) and the spec's chore sections (PS L1719–L1810, L2041–L2125, L2265–L2279, L778–L781; Project-entry L84 "Shared chore"). The owner kept S20 as one step on 21 Oct (core, approval and S20c together); the defaults below are open to correction by the owner.
- **Date:** 2026-10-21
- **Step:** S20 (brief: `plans/steps/S20-brief.md`). Builds on S16 (trash, ADR 0020), S17 (dashboard, ADR 0021), S18 (tasks, ADR 0022) and S19 (recurring tasks, ADR 0023).

## Context

Chores are Home-only recurring or one-off work with an assignment (nobody, fixed members or a rotation), a checklist and a record of who actually did it. Some Homes want a reviewer to approve completions, with a reason and rework when rejected. Managers need templates, a searchable Home-wide history, a limited bulk change of occurrences and dashboard widgets. Everything must be isolated per Home and survive concurrent changes, renames and members leaving.

## Decision

**Two migrations, no exposed tables.** `20261030090000_chores.sql` adds chores, schedule parts, occurrences with their own assignees, checklist and events, categories, approval (`private.chore_submissions`) and the reviewer notification; `20261031090000_chore_templates_history_bulk.sql` adds templates, the Home-wide history, bulk occurrence changes and the widget read. Every read and change is a `security definer` function with the person's session; RLS is on and nothing is granted on the tables.

**Model.** A chore is the stable identity; a recurring chore's schedule is a chain of parts like S19's series (the S19 rule functions unchanged). Occurrences are created lazily (`advance_chores` before every chore read: up to today plus the next one, never back-filled) and keep their original scheduled date, unique per chore. A rotation numbers the rule's dates from the part's first created date, so skips, misses, pending work and pauses never shift whose turn it is; the same function exists in TypeScript with shared vectors. A completed or skipped occurrence keeps a snapshot of the title and category.

**Rights (defaults picked).** Every current member sees every chore, completes any open occurrence and names the actual contributor. Chore managers (the Owner, and Administrators granted the delegable capability `manageHomeChores`) create, edit with the three S19 scopes, pause, skip, reopen, correct, delete, manage categories and templates, and change occurrences in bulk. Reviewers are the Owner and Administrators granted `approveHomeChores`; ordinary completion rights never review. The TypeScript matrix (`packages/domain`) mirrors `private.can_manage_chores` and `private.can_review_chores`.

**Approval.** Off by default, turned on per chore by a chore manager. A completion of such a chore is a submission (Pending approval) with its note, contributor and a snapshot of the checklist; while it waits, nothing else may close it, tick it or skip it, and reopening withdraws it. Rejection needs a reason (1–500 characters) and leaves _Needs rework_ with the attempt kept; a resubmission is a new attempt that needs the mandatory steps again. Approval completes it with the submission's contributor and reported time. Self-approval by a reviewer is permitted, recorded and labelled. A contributor who left blocks approval, not rejection. Turning approval off keeps what waits. Every decision and correction is an event and an audit row.

**Reviewer notifications.** Category `approvals` (optional; in-app on, email opt-in), kind `chore.approval_requested`, naming only the Home. One notice per reviewer while the queue is not empty (deduplicated on the oldest pending submission); the submitter is not notified of their own submission. The link opens the review queue, which re-checks the right.

**Corrections (chore managers).** Who did it, when (entered in the viewer's timezone: a time in a daylight-saving gap is refused, a repeated time takes the earlier instant; at most 5 minutes in the future) and the note, with an optional reason; the values before stay in the event. Point reconciliation comes with points (S23).

**Templates (defaults picked).** Managed and used by chore managers only; anyone else gets no rows, so titles stay hidden. A template holds a title (unique per Home), instructions, a category, an estimate and a checklist, never assignees, a schedule or approval. Duplicating is a prefilled new template; retiring hides it from the new-chore form. Creating a chore from one copies its fields into the editable form, where assignment, schedule and approval are always chosen; the chore is an independent copy. 100 per Home. Suggested points come with S23.

**Home-wide history.** `list_home_chore_history`, strictly one Home, every member. Search (a literal substring of the chore's title as closed or now, the note or the skip reason; at most 100 characters) and combinable filters: member (assigned or did it), chore, a date range on the scheduled date (default) or the completion date in the Home's timezone, state and approval. Newest first, 50 per page. A plain GET form with filter chips that each remove one filter.

**Bulk changes.** `bulk_chore_occurrences`: reassign to one member, skip with a reason, or move the due date, for 1–100 selected occurrences of one Home, each with the revision the manager saw. Each goes through the single-change function under its own chore's lock inside its own subtransaction, so a stale, closed, pending, missing or other-Home one is reported with its reason and the rest apply. A dry run gives the per-occurrence preview (before and after); the interface applies only what the preview showed as eligible and lists the rest. Only the selected occurrences change, never a series or its rotation. Audited once with the number applied. No assignment notification yet (that kind arrives with S21).

**Widgets.** Three types in the S17 registry, on a Home dashboard or bound to one Home on the personal dashboard: My Chores, All Home Chores (everyone's, one member's or unassigned) and Pending Approvals (reviewers only; anyone else sees that it is for reviewers, without titles or counts). Settings: state, a date range relative to the Home's today (so a saved setting keeps its meaning) and 5 / 10 / 15 rows; the widget always names its state, range, whose and sort order. Quick complete where nothing needs a choice (it submits where approval is required); approve and reject in the widget use the same confirmed dialogs as the review queue.

## Consequences

- Chore reads must call `advanceChores(homeId)` first, as the pages and widgets do.
- The rotation rule exists twice (SQL and TypeScript) with shared vectors; change both.
- No Realtime: views refresh after the viewer's own changes and on navigation.
- Hosted projects need both migrations in order (`docs/supabase-migrations.md`).

## Not done here

Points, late policy and rewards (S23); the unassigned pool, claims, proposals and reassignment requests (S21); absences and Home vacations (S22); chore reminders; wall-display presentation; Realtime.
