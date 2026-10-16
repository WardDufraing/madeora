# S18 · Tasks core — independent review

- **Branch:** `feat/tasks-core` (working tree against `main` at `7238ebc`)
- **Material reviewed:** the full diff (about 12,200 lines), `done.md`, the spec excerpts (`spec-ranges.md`, `modules-tasks.md`), `CLAUDE.md`, `architecture.md` §4/§9/§36, ADRs 0011, 0017, 0018, 0020, 0021 and the new 0022, `docs/development.md`, `plans/steps/S18-brief.md`, and the earlier migrations the change builds on or redefines (`20261016090000_homes.sql`, `20261019090000_roles_and_ownership.sql`, `20261020090000_ownership_recovery.sql`, `20261024090000_trash_and_recovery.sql`, `20261025090000_dashboards.sql`).
- **What I ran:** `vitest run` for `src/components/tasks`, `src/app/api/v1/tasks`, `src/tasks`, `src/components/ui/use-announcer.test.tsx` and `src/components/trash`. 5 files, 83 tests, all passed. I did **not** run the database tests (`tests/db/rls/tasks.test.sql`, `tasks-concurrency.test.ts`) or Playwright. There is no Docker daemon here, and the PostgreSQL fallback refuses to run as root. Every SQL behaviour below comes from reading the code, with the reasoning given in each finding.
- **Checks done:** en/nl dictionaries have the same keys. Every `private.*` function the migration creates is revoked from `public, anon, authenticated`. The redefined S16/S17 trash dispatch functions keep their `sample` and `dashboard_template` branches exactly as before.

## 1. Verdict

**CHANGES_REQUIRED** (one HIGH finding).

The core is solid: tenant isolation, personal-task privacy, revisions, set-to-state shared completion under a row lock, and the trash conflict design. Database tests cover three roles across two Homes. One binding product rule is not met on the main list view (H1). Several MEDIUM issues should be fixed or explicitly accepted by the owner.

## 2. Findings

### BLOCKER

None.

### HIGH

**H1 — Completing from the task list skips the required warning about unfinished subtasks**

- **Where:** `apps/web/src/components/tasks/task-list.tsx`, the row `Checkbox` `onChange` (about line 184): `setTicked(...)` then `completion.mutate({ task, completed })`.
- **Requirement:** spec "Confirmed simple task subtasks": "The parent task is marked complete only through an explicit authorized parent completion action … **warn about remaining incomplete subtasks before confirming that action**." ADR 0022 also states "Completing with unfinished subtasks asks first."
- **What happens:** the list row (personal list, Home list and All Tasks) completes a task immediately, even when `task.subtasksDone < task.subtasksTotal`. The row already has both numbers. Only `TaskCompletion` on the detail page asks first. The tests only cover the warning on the detail page (`tasks.test.tsx` "asks before completing with open subtasks"; e2e personal journey). Completing from the list is the most common path, and it breaks a binding rule. The ADR also describes the behaviour wrongly.
- **Fix:** in `TaskList`, when `completed && task.subtasksTotal > task.subtasksDone`, open the same confirm dialog that `TaskCompletion` uses (reuse `confirmCompleteTitle` and `confirmCompleteBody`, keep the box unticked until confirmed, and return focus to the checkbox or heading on cancel). Add a component test (row with 1 of 2 subtasks done → dialog → cancel sends nothing → confirm sends `{completed:true}`) and an axe check of the open dialog.

### MEDIUM

**M1 — Reopening a completed task in an archived list puts an open task where All Tasks cannot show it**

- **Where:** `public.set_task_completion` in `supabase/migrations/20261026090000_tasks.sql` (about lines 1132–1170). It never looks at the task's list.
- **Rule it breaks:** `update_task_list` refuses to archive a list with open tasks (`has_open_tasks`), and the ADR says lists are "never emptied silently". The spec says: "do not silently delete, relocate or hide active tasks".
- **How it fails:** archive list L with only completed tasks (allowed). Open L from "Archived lists" in the sidebar, or open a task by its link. The detail page offers **Reopen** (`can.complete`), and `set_task_completion(task, false)` answers `reopened`. The task is now open inside archived L. `list_tasks` with `p_list_id` null filters `l.archived_at is null`, so All Tasks and its counts silently leave it out. New tasks cannot go into L, but the reopened one stays there.
- **Fix:** in `set_task_completion`, when `p_completed = false`, lock the list for share (`private.usable_task_list`). If it is archived or deleted, answer `list_unavailable`, and have the page offer "move to another list first" or "unarchive the list". Add an SQL test (archive, reopen → `list_unavailable`) and a route mapping test.

**M2 — Every task listing scans the whole tasks table across all tenants; the new indexes are never used**

- **Where:** `private.is_context` (about line 333) is a `language sql … set search_path = ''` function. It is used as the context predicate in `list_tasks` (line 1263), `list_task_lists`, `list_task_labels`, `task_list_name_taken`, `task_label_name_taken`, `reorder_task_lists`, and the count/position subqueries in `create_task_list` and `create_task_label`.
- **Why the indexes are skipped:** PostgreSQL never inlines a SQL function that has a `SET` clause (`proconfig` is not null). The planner therefore sees an opaque per-row function call. It cannot use `tasks_home_idx`, `tasks_user_idx`, `task_lists_home_idx` or `task_labels_home_idx`. Even if the function were inlined, the body `coalesce(case … end, false)` is not indexable.
- **Impact:** every Tasks page load, "Show more" request and list or label create runs a sequential scan of `private.tasks` (and of `task_lists` or `task_labels`) for **every** Home and person, followed by the window count. Cost grows with total platform data, not with the viewer's Home. ADR 0022 presents the listing as bounded ("Listing stays small"), but only the result size is bounded, not the query cost.
- **Fix:** write the context predicate inline, for example `((p_home_id is null and t.owner_user_id = v_user_id) or (p_home_id is not null and t.owner_home_id = p_home_id))`, or branch into two queries. Drop the `set` clause from `is_context` only if it stays in non-WHERE uses. Confirm with `EXPLAIN` in a DB test or a note that `tasks_home_idx` and `task_lists_home_idx` are used.

**M3 — Trash rights for tasks do not match the task permission matrix**

- **Where:** S16 `private.can_see_trash_entry`, reused unchanged ("No fourth per-type hook", ADR 0022 and brief default 8).
- **Spec:** "recheck current ownership, Home permissions, and record-level rights before restore or permanent deletion". The spec decision on Home file permanent deletion takes the same principle: whoever may delete may also purge, and nobody else.
- **The mismatch, both directions (traced):**
  - An Administrator granted only `manageHomeSettings` (not `manageHomeTasks`) cannot edit or delete a Home task, but can see, restore and **permanently purge** any trashed task or task list in that Home.
  - An Administrator granted `manageHomeTasks` can delete any task, but cannot see or restore one deleted by someone else. The SQL test asserts the related case: "An Administrator without manageHomeSettings does not see another member's deleted task".
  - A former task manager whose grant was revoked can still restore what they deleted (deleter rule), although they can no longer delete it.
- **Status:** the brief documents this as a default. It is a permission decision the spec does not leave open in this direction.
- **Fix:** add a per-type visibility hook so that, for `module = 'tasks'`, restore and purge need `can_delete_task` (for a list, `can_manage_tasks`) evaluated now. Or get the owner's explicit acceptance under D1 and record it in ADR 0022.

**M4 — Who reopened a shared task is neither recorded nor shown**

- **Where:** `set_task_completion` (reopen sets `completed_at` and `completed_by` to null and does not touch `updated_by` or `updated_at`); `TaskCompletion` and the activity section in `task-detail.tsx`.
- **Spec:** "Confirmed multiple Home task assignees with shared completion": "Show who actually completed **or reopened** the shared task and when".
- **What happens:** after a reopen, the detail page says only "Not completed". Basic activity keeps the previous editor as "Last updated". A personal reopen is not audited at all (`audit_task` skips personal), and in a Home only the restricted audit trail knows the actor.
- **Fix:** keep `reopened_at` and `reopened_by` (shown as membership ids, like the completer), or at least set `updated_by` and `updated_at` on completion changes, and show "Reopened by X on …". If the owner wants to keep this out of S18, record it as an explicit deferral in ADR 0022.

### LOW

**L1 — Renaming a list can deadlock with reordering lists**

- **Where:** `update_task_list` (line 539) and `reorder_task_lists` (line 570).
- **How:** `update_task_list` locks the list row (`lock_task_list … for update`) and **then** takes the context advisory lock. `reorder_task_lists` takes the advisory lock **then** updates every list row of the context. A concurrent rename and reorder in the same context wait on each other. PostgreSQL aborts one with 40P01, which `databaseFailure` maps to a 500 "failed".
- **Fix:** take the advisory lock before the row lock in `update_task_list`, or lock rows in id order inside `reorder_task_lists`.

**L2 — `id_taken` reveals that an id exists in a context the caller cannot see**

- **Where:** `create_task_list`, `create_task_label`, `create_task`, `add_subtask` and `add_task_comment` (for example line 944).
- **How:** a create naming an id that exists in another Home answers `id_taken` (HTTP 409 `id-taken`). A fresh id would answer `created`. The SQL test even asserts this for Home B's task. It contradicts the ADR's "a task … they may not see answers not_found, exactly like a missing one". Ids are random UUIDs, so the practical risk is small, but ids do appear in shared URLs.
- **Fix:** accept as is and correct the ADR wording, or answer with a neutral outcome that does not tell existing ids apart from fresh ones.

**L3 — A retry with edited content silently keeps the first version**

- **Where:** `NewTask` and `TaskComments` keep the draft id after a failed send (correct for retries).
- **How:** if the first request actually reached the database (for example a network failure after commit) and the person edits the title or body before retrying, the database answers `exists`. The UI announces success, resets the form, and the stored record has the old content.
- **Fix:** on `exists`, compare the stored fields (or return them) and say "already saved; your later changes were not applied", or use a new id once the person edits after a definitive failure.

**L4 — Focus is lost after inline edits**

- **Where:** saving or cancelling the inline comment edit (`task-comments.tsx`), list rename (`task-manage.tsx`), label edit and subtask rename (`task-subtasks.tsx`).
- **How:** each unmounts the focused field with `setEditing(null)` or `setRenaming(null)` and does not move focus, so keyboard and screen-reader users land on `<body>`. The step's constraint ("focus moved deliberately") is met for delete, complete and dialogs, but not here.
- **Fix:** return focus to the row's Edit or Rename button, or to the section heading, as `TaskContent` already does.

**L5 — Invalid inline edits fail silently or show the wrong message**

- The comment edit, list rename, label edit and subtask rename forms do nothing when the value fails validation (`if (parsed.success) …` with no else). There is no error and nothing is announced.
- `TaskSubtasks.add` always shows `fieldRequired`, even for too-long or invalid-character titles (`task-subtasks.tsx:144`).
- The spec requires "accessible validation" for comments and names.
- **Fix:** show the field error (`fieldRequired`, `fieldTooLong`, `fieldInvalidCharacters`) through the field's `error` prop, as the create forms do.

**L6 — Departure erases the assignee list of completed tasks**

- **Where:** the `task_assignees → home_memberships` foreign key with `on delete cascade`.
- **How:** it removes the leaver from completed tasks too. The completer and creator are kept, so the attribution the spec names survives, but the record of who was assigned to finished work is lost.
- **Fix:** accept and document as a default, or keep historical assignee rows for completed tasks with a nullable membership reference.

**L7 — `listTasks` turns every 22023 into an empty page**

- **Where:** `apps/web/src/tasks/data.ts:131`.
- **How:** any malformed-request refusal becomes "nothing matches", for example a future bug in parameter mapping or an offset over the database limit. That hides real defects from logs and from the person.
- **Fix:** log `tasks.list_invalid` before answering empty, or let only known filter problems through.

**L8 — The concurrency tests rely on timing, not a barrier**

- **Where:** `tests/db/rls/tasks-concurrency.test.ts`.
- **How:** the two sessions start through `Promise.all` and hold the lock with `pg_sleep(0.3)`. Nothing guarantees they overlap. The expected outcomes would also pass if the calls ran one after the other, so a regression that dropped the row lock could pass on a slow runner.
- **Fix:** have session A take the lock and signal (for example with an advisory-lock handshake or a `pg_stat_activity` wait check) before session B starts, and assert that B was actually blocked.

**L9 — The brief claims refetch on focus, which is not built**

- `S18-brief.md` says "views refetch after own mutations and on focus". With `staleTime: Infinity` and server-rendered pages, nothing refetches on focus. ADR 0022 states it correctly ("refetch after the person's own changes").
- **Fix:** align the brief.

## 3. Explicit checks

| Check                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements            | Mostly met. Lists and All Tasks, personal and Home tasks, optional start and due dates (date-only, Home timezone for "today"), priority with unset distinct from Normal, labels with impact count, single-level subtasks, multiple assignees with one shared completion, chronological comments, basic activity, delete to trash, restore conflict `list_unavailable`, and the reassignment flag on departure. Gaps: H1 (no warning from the list view), M4 (reopen actor), M1 (archived-list invariant). Out-of-scope items (recurrence, reminders, attachments, widgets, bulk actions) are correctly left out. No product behaviour is invented beyond documented defaults. |
| Cross-Home isolation    | Good. Every public function rechecks the confirmed caller and current membership. A Home the caller is not in raises 42501 "not permitted", which the routes map to 404 like a missing Home. Lists, labels and assignees are bound to the task's context (`usable_task_list`, `valid_task_labels`, `member_users` with the `home_id` foreign key). SQL tests cover a foreign list, label, assignee and task id, and another Home's reads and edits. Small existence oracle in L2.                                                                                                                                                                                             |
| Personal-task privacy   | Good. `in_task_context` / `is_context` restrict personal rows to `owner_user_id`. Personal tasks refuse assignees. Comments, subtasks, trash and reads are all tested as invisible to other users, including Home Owners.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Permissions             | The engine (`packages/domain` `home.tasks.*`, `decideTaskAction`) and SQL (`can_manage_tasks`, `can_edit_task`, `can_delete_task`) agree. The matrix is tested on both sides. Grant and revoke of `manageHomeTasks` take effect at once. Trash rights diverge from the task matrix (M3). Comment ownership is strictly enforced and no moderation is assumed.                                                                                                                                                                                                                                                                                                                 |
| Revoked membership      | Good. Assignments end with the membership through the foreign key. The leaver loses reads and comment edits (tested). Departed people read as "former member" with no account id exposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SECURITY DEFINER safety | Good. Every function uses `set search_path = ''` with schema-qualified names. Private tables have RLS on and all grants revoked. Every new private helper is revoked from the API roles (verified by script). Public functions are granted to `authenticated` only, and `anon` is denied (tested).                                                                                                                                                                                                                                                                                                                                                                            |
| Secrets / logging       | No secrets. `logTasks` logs only the event and error code, and a test asserts that no title or id is logged. Audit details hold ids and counts only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CSRF / HTTP             | Every mutation goes through `checkJsonMutation` (same origin, JSON, size cap), then a verified identity, then a strict Zod schema. Answers are `Cache-Control: no-store`. Tested for three representative routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Input validation        | Strict Zod contracts mirror the database limits. Name rules reuse the S09 visible-name policy, plain text bans control characters, and dates are `z.iso.date()`. The database revalidates everything, including date order, priority, colour and limits. Inline client forms have gaps (L5).                                                                                                                                                                                                                                                                                                                                                                                  |
| Migration safety        | Additive tables and functions. Redefined S16/S17 functions keep earlier branches byte for byte (compared). `trash_restore_one` changes only the colon-argument resolution match. The dropped and re-added check constraints are widened supersets. A new `before delete` trigger on `home_memberships` runs on every leave, removal or recovery; it is tested for direct deletes, but there is no test with Home deletion or account deletion cascades while tasks exist. Rollout notes are in `docs/supabase-migrations.md`.                                                                                                                                                 |
| Concurrency             | Shared completion is set-to-state under `FOR UPDATE`, which correctly turns the loser into `already_completed` with the real completer. Edits use revisions. Creates are idempotent by id, with `on conflict do nothing` plus a re-read. List archive and delete versus task create, move and restore are serialized by list row locks, and a restore that loses the race becomes `needs_resolution`. Weak spots: L1 (deadlock) and L8 (test timing).                                                                                                                                                                                                                         |
| Test coverage           | Broad: policy-matrix unit tests, route tests (CSRF, 401, 404 masking, mapping, no logging of content), component tests with axe, SQL RLS tests for three roles and two Homes, a concurrency test, and e2e journeys including the keyboard in both themes. Missing: list-view completion with open subtasks (H1), reopen in an archived list (M1), trash rights for task managers versus `manageHomeSettings` (M3), cascade with Home or account deletion, and a query-plan check (M2).                                                                                                                                                                                        |
| Accessibility           | Good overall. Labels as text plus a decorative dot (colour never alone), priority and overdue in text, checkboxes with accessible names, a polite live region that announces repeated messages (tested), deliberate focus after delete, complete and dialog close, Move up/down buttons instead of drag, and `bdi` for user text. Gaps: L4 and L5.                                                                                                                                                                                                                                                                                                                            |
| Performance             | Results are capped (50 rows, 100 comments, offset limit 10,000) with small row payloads. The query cost is not bounded by tenant (M2). Per-row `can_edit_task` and subqueries over 50 rows are acceptable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Maintainability         | Clear, consistently commented code that follows S16/S17 patterns. The contract lives in `schema.ts` / `api.ts`, and outcome mapping is centralized in `route-helpers.ts`. Limits are duplicated between `task_limit` and `TASK_LIMITS`, and both point at each other. Docs and the ADR are updated.                                                                                                                                                                                                                                                                                                                                                                           |
| Scope / €0              | Within scope. No new dependency or service. Product specification files are not in the diff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Defaults the change picked where the requirements leave room

These are documented in the brief and ADR 0022 and are reasonable unless noted:

- The permission matrix and the new `manageHomeTasks` capability, including no assigning by plain creators (D1).
- Limits: 60/40/200/5,000/2,000 characters; 100 lists or labels per context; 20 labels or assignees per task; 100 subtasks; 50 rows per page.
- The label filter matches any chosen label.
- Hiding future-start tasks is a URL filter, on by default, and not remembered.
- Comments and subtasks are deleted directly after confirmation, without the trash.
- No assignment notifications (D2), and assignees may tick subtasks (D3).
- Home "today" uses the Home's timezone; the personal "today" is supplied by the client and accepted only within ±1 day of the UTC date.
- Sort ties are broken by due date, then creation, then id.
- A departure flags the task even when other assignees remain. This is reasonable but goes slightly beyond the spec, which says such tasks "become unassigned and are flagged".
- The trash keeps the S16 generic rights: see M3, which needs explicit owner acceptance.

## 4. Remaining risks and test gaps

- Database tests and Playwright were not run in this review. Their results come from CI and the implementer.
- The `home_memberships` before-delete trigger runs inside Home-deletion and account-deletion cascades (S40). There is no test with tasks present, so the interaction with the `ON DELETE SET NULL` and `CASCADE` actions on the same task rows is unverified.
- Query cost at realistic multi-tenant volume (M2) is unmeasured. Add an `EXPLAIN` assertion or a seeded-volume check.
- Task restore keeps the S16 rights model (M3) until the owner decides.
- The concurrency tests depend on timing (L8).
- Personal "today" comes from the client within ±1 day. It only affects the person's own view, but a test of the boundary rejection is missing.
- Labels deleted while a task is in the trash are simply detached. Nothing tells the person on restore. This is acceptable, but not covered by a test.
- Open owner decisions D1–D3 (brief) still stand.

## Implementer's response (after the review; verified by the implementer, no second full review)

- **H1 fixed:** a list row with unfinished subtasks opens the same confirmation as the task page. Cancel sends nothing and leaves the box unticked; confirm completes. Component test with axe added.
- **M1 fixed:** `set_task_completion` refuses to reopen a task in an archived or deleted list (`list_unavailable`). SQL test added.
- **M2 fixed:** the context condition is written inline in every table query. `EXPLAIN` shows `tasks_home_idx` used for a Home listing.
- **M3 not changed, raised to the owner:** the trash rights are the S16 rule the owner set as the default for this step. The two differences are recorded in ADR 0022 as an open owner decision.
- **M4 fixed:** reopening records `reopened_by` and `reopened_at`. The status line and activity show who reopened it and when. SQL and component tests added.
- **L1 fixed:** list and label renames take the context lock before the row lock.
- **L4 fixed:** focus goes to the section heading after saving or cancelling an inline edit.
- **L5 fixed:** an invalid inline edit or new subtask now says why (required or too long).
- **L7 fixed:** an invalid listing filter is logged by code.
- **L9 fixed:** the brief no longer claims refetch on focus.
- **L2, L3, L6, L8 accepted:** low impact, documented in ADR 0022 (defaults, item 8).
