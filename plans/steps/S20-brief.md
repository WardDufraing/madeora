# S20 · Chores core — feature brief

**Branch:** `feat/chores-core`, from `main` at `77c3573` (S19c merged as PR #34). Depends on S18 (merged).
**Scope (Ward, 2026-10-21: keep S20 as one step):** everything below plus what was proposed as S20b (optional approval, self-approval, rejection with Needs rework and resubmission, reviewer notifications, correction/reopen with audit) and S20c (chore templates, searchable Home-wide history, limited bulk occurrence actions, the three chore widgets and the full "Shared chore" journey). Points and late-points policy stay in S23; pool, claims and reassignment requests in S21; absences and Home vacations in S22. Built in order: core first, then approval, then templates/history/bulk/widgets.
**Sources (read only these ranges):** build plan S20; PS L2041–L2125 (widgets, approval, rework, correction, another member's chore, late points, skip, missed rotation, fixed and rotating assignment), L1719–L1810 (categories, bulk, Home-wide history, templates, completion notes, reassignment requests, pool filters, no difficulty, estimated duration, checklists, pauses and vacations), L2265–L2279 (recurring edit and delete scopes), L778–L781 (departure: future recurring assignments cleared, flagged for reassignment); Project-entry L84 ("Shared chore" journey); ARCH §4, §9, §36; ADR 0022, 0023.
**Model:** Opus (rotation, recurrence scopes, concurrency and RLS across many rows).

**Done when (S20 part):** an authorized member creates and assigns a chore, another member completes it naming the actual contributor, and the chore's history shows it to members of that Home only (RLS tests across two Homes); rotation, skip, checklist and recurrence-scope tests pass. The full journey with widgets is part of this step too.

## Model

- **Chores are Home-only** (no Personal chores). A chore (`private.chores`) is the stable identity: title, instructions, category, kind (`one_off` / `recurring`), revision, creator, ended/deleted state.
- **Schedule parts** (`private.chore_schedules`, recurring chores only) work like S19 task series parts: rule (daily / weekly with ISO weekdays / monthly / yearly, every N, ends never / on date / after N; the S19 rule functions and fall-backs are reused unchanged), anchor, active-from, until, next/last date, pause, superseded. A "this and following" change ends the current part the day before and starts a new head part. Each part carries the **assignment** (mode `none` / `fixed` / `rotating`; fixed members, or an ordered rotation), the **checklist template** (ordered steps, label + mandatory flag) and the **estimated duration**.
- **Occurrences** (`private.chore_occurrences`) belong to a chore (and a part for recurring ones), keep their **original scheduled date** (unique per chore, deleted rows included, so retries, races and splits never duplicate), a due date, their own assignees, their own checklist copy with its own progress, their own duration snapshot, and on completion or skip a snapshot of the chore title and category name (history never rewritten by a rename). One-off chores have exactly one occurrence.
- **Generation (lazy, as S19):** every occurrence up to today plus one upcoming; `public.advance_chores(home)` runs before chore pages read; idempotent, row-locked per part, catch-up cap 50 parts × 100 occurrences per call. A missed occurrence stays open, overdue and assigned to its original member (spec "missed rotating chore"); nothing is shifted, skipped or reassigned automatically. No back-fill on create, reschedule, resume or restore.
- **Rotation (default picked):** a part numbers its schedule dates 0, 1, 2, … from where its rotation starts (the first date created: never a date before today) (every date of the rule counts, including dates suppressed by a pause); the date's number modulo the rotation size picks the participant. So skips, misses, pending work and pauses never shift the order; the upcoming sequence is a pure function of the rule and the order and is previewed before saving. A change of the rotation ("this and following" or "entire series") starts the new order at the first affected occurrence; the form pre-orders the list so the person whose turn is next stays first.
- **Departure (spec L778–L781):** a departing member's assignments on open occurrences end and those occurrences are flagged _Needs reassignment_; their fixed-assignment slot ends; a rotation slot stays in the order as an empty slot, so the order does not shift, and every occurrence that falls on it is created unassigned and flagged; the part is flagged for rotation repair. Completed and skipped records keep their attribution ("a former member").

## States and actions (S20)

| State     | Meaning                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| Open      | outstanding; **Overdue** when its due date is before today in the Home timezone    |
| Completed | closed with actual contributor, submitter, reported completion time, optional note |
| Skipped   | closed without completion or points; skip time, actor, optional reason             |

S20b adds Pending approval and Needs rework.

- **Complete:** all mandatory checklist steps must be ticked (also enforced in the database). The person names the **actual contributor** (any current member; the submitter by default and preselected only when they are an assignee or the chore is unassigned; otherwise an explicit choice is required). Optional **completion note**: plain text, 1–500 characters after whitespace normalization, kept with that occurrence only. Completing someone else's chore never changes its assignees or the rotation. Simultaneous completions record one; the second is told it is already done.
- **Skip** (chore managers): optional reason up to 500 characters; never completes; schedule and rotation unchanged.
- **Reopen** a completed or skipped occurrence (chore managers, default picked; S20b adds correction of details and the audit trail with point reconciliation).
- **Checklist:** members who may complete an occurrence tick and untick its steps; each occurrence starts unchecked.

## Edits and scopes (spec L2265–L2279)

- **Chore-level fields** (title, instructions, category) belong to the chore: an edit shows at once on open occurrences; completed and skipped records keep their snapshots. No scope dialog (default picked: one chore identity).
- **Occurrence and series fields** (due date, assignment, checklist, duration; schedule for series only) take the S19 scopes: _This occurrence_ (only this one, it becomes individually changed), _This and following_ (split), _Entire series_ (head part and its open, not individually changed occurrences). Completed and skipped occurrences are never changed. Overdue open occurrences keep their assignee in series edits (missed work stays with the original member). Occurrences with ticked steps keep their checklist and are listed as kept. Schedule changes remove open, untouched upcoming occurrences that are off the new schedule. The impact preview is the same function in dry-run mode.
- **Removed or newly mandatory steps** on an outstanding occurrence with progress are listed in the preview and need explicit confirmation (`confirmChecklist`).
- **Pause** (chore managers): until a chosen date (inclusive) or indefinitely; no occurrence is created for a date in the pause; untouched upcoming occurrences inside it are removed; resume (or the end date passing) continues from today, no back-fill.
- **Delete:** _this occurrence_ (open only) to the trash; _this and following_ ends the schedule the day before and moves those open occurrences to the trash in one entry; _entire series_ ends the chore and moves its open occurrences to the trash in one entry — completed and skipped history stays and the chore is listed as Ended. A one-off chore is deleted as a whole. Restore conflicts: `series_changed` → `restore_occurrences_only`; a chore in the trash or ended blocks restoring an occurrence (`chore_unavailable`).

## Categories (spec L1719–L1724)

Home-scoped, 1–40 characters, unique per Home (case- and space-insensitive), colour from the existing label colour set, ordered, archived (retired: not offered for new choices, still shown) or deleted after an impact preview that detaches it from its chores (snapshots stay). At most one per chore; Uncategorized is valid and filterable. 50 per Home.

## Permissions (default picked; the per-module matrix is open in the spec)

New delegable capability **`manageHomeChores`** (Owner always; Administrators when granted).

| Action                                                                          | Who                              |
| ------------------------------------------------------------------------------- | -------------------------------- |
| See chores, occurrences, checklists, notes, history                             | every current member of the Home |
| Complete an occurrence (including another member's), tick steps                 | every current member             |
| Create, edit (any scope), pause, delete chores; skip; reopen; manage categories | chore managers                   |

S21 adds member proposals and claiming. Personal context: a Chores page that lists the person's Homes.

## Interface

- **Home › Chores** (`/homes/[homeId]/chores`): open occurrences grouped Overdue / Today / Upcoming (next 7 days), plus Needs reassignment; filters assignee (me / anyone / member / unassigned), category (incl. Uncategorized). Rows show title, category name and colour dot, due date, assignee(s) or "Unassigned", checklist progress, duration and "Repeats" marks (text + icon, never colour alone). Quick complete only when the chore has no mandatory steps.
- **Occurrence page** (`/homes/[homeId]/chores/[occurrenceId]`): instructions, checklist, Complete dialog (contributor, note), Skip and Reopen, Edit with scope dialog and preview, Pause/Resume, Delete with scope and preview, Repeats section with the next five dates and assignees, and the chore's history (newest first, 50 per page, filter all / completed / skipped / missed).
- **New chore** and **Manage** (`/homes/[homeId]/chores/manage`): chore list (active and ended) and categories. Rotation editor with keyboard move up/down; upcoming assignee preview.
- `/chores` in Personal: the person's Homes with links. Nav `chores` becomes Home-aware and built. nl and en.

## API

`/api/v1/chores` (POST create), `/api/v1/chores/:id` (PATCH chore fields), `/api/v1/chore-occurrences/:id/completion` (PUT complete, DELETE reopen), `/…/skip` (POST), `/…/steps/:stepId` (PUT checked), `/…` (PATCH this-occurrence edit), `/…/series` (POST following/entire with `dryRun`), `/…/delete` (POST scope with `dryRun`), `/api/v1/chores/:id/paused` (PUT), `/api/v1/chores/:id/history` (GET), `/api/v1/chore-categories` (+ `/:id`, reorder). Same CSRF, JSON, size, session and outcome mapping as tasks.

## Tests

- **Unit:** rotation math and upcoming preview (TypeScript, shared vectors with the database), schemas, permission matrix, routes (CSRF, unauthenticated, invalid, conflict, not found, scopes, dry run), components with axe.
- **Database:** nothing reachable as a table; create one-off and recurring (fixed, rotating, none); generation up to today plus one, no back-fill, cap; rotation order across misses, skips and pause; complete with contributor (another member's chore), note, mandatory steps; simultaneous complete vs complete and complete vs skip; skip and reopen rights; checklist ticking rights; scopes this / following / entire (completed untouched, kept, off-schedule removal, overdue keeps assignee); pause until date and resume; delete scopes, trash restore with conflicts, purge; categories (duplicate, cross-Home id refused, delete with preview); departure (fixed and rotating); permission matrix across two Homes and three roles; history statuses, paging and isolation.
- **Concurrency:** two advances create each occurrence once; two completions; series edit vs completion.
- **Playwright:** manager creates a rotating weekly chore with a mandatory step; another member completes it for someone else; history shows the contributor; skip; edit this and following; delete and restore; axe and keyboard in both themes.

## Out of scope

Points, late policy, rewards (S23); pool, claims, eligibility, proposals, volunteer and reassignment requests, chore reminders (S21); absences and vacations (S22); Realtime; difficulty (spec: none).

## Defaults picked (Ward may override)

1. Chore managers (Owner, Administrators granted `manageHomeChores`) create, edit, skip, reopen, pause and delete; every member completes any occurrence and names the contributor.
2. Rotation counts schedule dates from the part's first created date (skips, misses and pauses never shift it); departed participants leave an empty, flagged slot.
3. Title, instructions and category are chore-level (no scope); due date, assignment, checklist and duration use the three scopes.
4. Deleting the entire series ends the chore and keeps its completed and skipped history visible; only open occurrences go to the trash.
5. Limits: 500 active chores per Home, 50 categories, 30 checklist steps, 20 assignees or rotation slots, duration 1 minute to 24 hours, title 200, instructions 2000, note and skip reason 500.
6. Overdue open occurrences keep their assignee in series edits.
7. Ward kept S20 as one step: approval, rework, corrections, templates, Home-wide history, bulk actions and the three widgets are in it.
8. Approval: all members see submissions, notes and rejection reasons; the submitter is not notified of their own submission; while pending, single-occurrence edits, skip and delete are blocked and reopen withdraws.
9. Corrections are by chore managers, entered in the viewer's timezone (a DST gap is refused, an overlap takes the earlier instant), always audited.
10. Templates are managed and used by chore managers only; duplicating prefills a new template.
11. Home history: the date basis defaults to scheduled; search is a literal substring.
12. Bulk applies only the eligible preview items; no assignment notification until S21.
13. Widget date ranges are relative to the Home's today; Pending Approvals shows a neutral state to non-reviewers.

## Progress

- [x] Brief
- [x] Domain (permissions, rotation, schemas)
- [x] Migration and database tests
- [x] API and data layer
- [x] Interface
- [x] Playwright
- [x] Docs (ADR 0026, development.md, supabase-migrations.md)
- [x] Full suite
- [x] Independent review (reviews/steps/S20-review.md): PASS, no BLOCKER or HIGH; four MEDIUM findings proposed as a follow-up
