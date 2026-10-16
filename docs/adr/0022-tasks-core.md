# ADR 0022: Tasks core: lists, shared completion under a lock, and tasks as the first trash module

- **Status:** Accepted for S18 within the approved architecture (§4, §9, §36), CLAUDE.md (database access A, authorization C, data fetching B, forms A, frontend B, date/time A, €0 budget) and the spec decisions of 13 October 2026 on tasks (independent tasks, basic activity, labels, lists and All Tasks, start and due dates, multiple assignees with shared completion, comments, priority, subtasks) and of 12 October 2026 on member departure (the task reassignment rule) and trash. The defaults below are open to correction by the owner.
- **Date:** 2026-10-16
- **Step:** S18 (brief: `plans/steps/S18-brief.md`). Builds on S16 (trash), S17 (dashboard), S12 (delegable Administrator capabilities) and S11 (membership ids as the Home-member identifier).

## Context

People keep tasks in their Personal space and in each Home, in named lists with an All Tasks view. A Home task can have several assignees and one shared completion: any assignee completes it for everyone, and the person who did is recorded. Tasks have optional start and due dates (calendar dates in the context's timezone), an optional priority, labels, a single-level checklist and plain-text comments. Deleting a task puts it in the S16 trash with everything attached. The spec leaves the per-module permission matrix open, but says assignment needs "the Home task-management permission" and that new features get minimum privileges. Recurrence, reminders, templates, attachments, bulk actions, calendar views and task widgets follow in S19.

## Decision

**Data.** One migration (`20261026090000_tasks.sql`) adds private tables `task_lists`, `tasks`, `task_assignees`, `task_labels`, `task_label_links`, `subtasks` and `task_comments`, none reachable through the API (RLS on, grants revoked). Every list, task and label has exactly one owner, a person or a Home. Public `security definer` functions with an empty `search_path` are the only way in; each one checks the confirmed caller and their current membership. A Home the caller is not in answers 42501 "not permitted", exactly like a Home that does not exist. A task, list, label, subtask or comment they may not see answers `not_found`, exactly like a missing one.

**Who may do what (default, owner may override).** In the Personal space, its owner does everything; personal tasks have no assignees. In a Home:

- every current member views lists, tasks, labels, subtasks and comments, creates tasks in an active list, and comments;
- a task's creator, its assignees and task managers edit it (content, labels, subtasks, its list) and complete or reopen it;
- its creator and task managers delete it;
- only task managers set assignees and manage lists and labels.

Task managers are the Owner and Administrators the Owner grants the new delegable capability **`manageHomeTasks`** ("Manage Home tasks"). A member edits and deletes only their own comments; nobody moderates others' comments, because moderation is not specified. The typed engine (`packages/domain` `home.tasks.*` and `decideTaskAction`) and SQL (`private.can_manage_tasks`, `private.can_edit_task`, `private.can_delete_task`) make the same decisions. Policy-matrix tests cover the engine; pgTAP-style tests cover the database for three roles across two Homes.

**People are membership ids.** Home answers name people by their current membership id (S11's Home-member identifier), plus an "is me" flag. A departed member or a deleted account reads as nobody ("a former member"), so attribution stays without exposing account ids or granting anything.

**Assignees are current members by construction.** `task_assignees` has a foreign key to the task's Home and one to `home_memberships (home_id, user_id)` with `on delete cascade`, so an assignment ends with the membership. A `before delete` trigger on memberships first flags the leaver's open tasks **Needs reassignment** (spec: the task stays in the Home, unassigned, and is flagged). A task manager clears the flag by setting assignees, and a "Needs reassignment" filter lists those tasks.

**Shared completion under a row lock.** `set_task_completion(task, completed)` sets a state, not a toggle, under the task's row lock. Of two simultaneous completions, one records the actor, the time and one audit event. The other answers `already_completed` and names the real completer, which the page reports. Reopening clears the completer, records who reopened it and when (shown in the status and the activity), and leaves subtasks as they are. Reopening needs the task's list to be active: a task in an archived list answers `list_unavailable`, so no open task hides in an archived list. Completing all subtasks never completes the task. Completing with unfinished subtasks asks first, from the task page and from every list row.

**Optimistic revisions and safe retries.** Tasks, lists, labels, subtasks and comments carry a `revision`. An edit names the revision it started from; a stale one answers `conflict` (HTTP 409 with the current revision) and changes nothing. Creates take a client-generated id with `insert … on conflict (id) do nothing`, so a retried or doubled request returns `exists` instead of creating a second record (tasks, lists, labels, subtasks, comments). Name checks and per-context limits take a per-context advisory lock, always before any row lock of that context (create, rename, reorder), so these requests queue instead of deadlocking.

**Dates.** Start and due dates are `date` columns, never instants. Upcoming, Active and Overdue are computed against "today" in the Home's own timezone (from `homes.timezone`, whoever views it). For the Personal space they use the person's effective timezone, which the app passes, accepted only within a day of the UTC date. The start date never locks a task.

**Listing stays small (S17 review M2).** Queries over a table write the context condition inline (`(p_home_id is null and owner_user_id = me) or owner_home_id = p_home_id`) rather than through a function, so PostgreSQL can use the per-Home and per-person indexes and does not scan other contexts' rows. `list_tasks` returns at most 50 rows of small fields (no descriptions, no comment bodies), with the filtered total and per-row `can_complete`. It supports status, timing, hide-future, priority (including Unspecified), labels (any of), assignee and sort, with a stable tie-break of due date, creation and id. Comments page 100 at a time. The page renders the first page on the server; "Show more" uses TanStack Query keyed by account, context, filters and render time.

**Trash: the first real module.** Deleting a task (`delete_task`) or an empty list (`delete_task_list`) marks it deleted and calls `private.trash_move` (module `tasks`, item types `task` and `task_list`). Subtasks, comments, labels and assignees never leave the task, so they come back with it. The four dispatch functions gain their cases:

- A task's real restore conflict is `list_unavailable`: its list was deleted, archived or purged meanwhile. The resolution `move_to_list:<listId>` restores it into another active list of the same context. `trash_restore_one` now accepts one argument after a colon in a resolution.
- `trash_item_restore` locks the list for share and checks it again. A list deleted between the check and the restore is turned into `needs_resolution`, so no active task can end up in an unusable list (two-connection test).
- A list has no conflict: matching names never are one, and duplicate names are refused only when a person creates or renames.
- Purging a list leaves its trashed tasks without a list; restoring one of them asks for a destination.

Restore and purge rights keep the S16 generic rule the owner set as the default for this step: the person who deleted it, while still a member, plus the Owner and Administrators with `manageHomeSettings`. No fourth per-type hook was added. **Owner decision open:** this differs from the task rights in two ways. An Administrator with only `manageHomeSettings` can restore or permanently delete Home tasks they could not delete. An Administrator with `manageHomeTasks` cannot restore a task someone else deleted.

**Lists are never emptied silently.** Archiving a list with open tasks answers `has_open_tasks` with their count. Deleting one with active tasks answers `has_tasks`. The page states the count and asks the person to move, complete or delete the tasks first. Both checks run under the list's row lock, which task creation and moves take for share.

**Interface.** `/tasks` and `/homes/{id}/tasks` (lists, All Tasks, filters as a GET form, new task, the list), `…/tasks/{taskId}` (status and completer, content, assignees, subtasks, comments, activity, move, delete) and `…/tasks/manage` (lists and labels, task managers only). The sidebar's Tasks follows the open Home, and Quick actions gains a Tasks link. React Hook Form and Zod handle the task form. Labels use a searchable checkbox multi-select and show their name next to an optional accent-palette dot, so colour never carries meaning alone. Priority, dates and status are text. After delete, complete and dialog close, focus moves to a deliberate place (S17 M3). A live region empties before every message, so a repeated identical message is announced again (S17 L5). Everything is in `en` and `nl`.

## Defaults chosen (owner may correct)

1. The permission table above and the capability `manageHomeTasks`.
2. Limits: list name 60, label name 40, task and subtask title 200, description 5,000, comment 2,000 characters; 100 lists and 100 labels per context; 20 labels and 20 assignees per task; 100 subtasks per task; 50 tasks per page.
3. Label colours are the accent palette ids, or none (neutral).
4. The label filter matches any of the chosen labels.
5. Hiding tasks that start later is a filter that is on by default. Remembering it per person is not built.
6. Comments and subtasks are deleted directly after confirmation. They go to the trash only with their task.
7. No assignment notifications (an open decision for the owner); no Realtime: views refetch after the person's own changes.

8. Accepted after review (low impact):
   - an `id_taken` answer shows that a random id is in use somewhere;
   - a retried create or comment whose text was edited in between keeps the first version (`exists`);
   - when a member leaves, their name goes from the assignee lists of completed tasks too, while the completer is kept;
   - the race tests rely on overlapping sessions with `pg_sleep`, like the S16/S17 ones.

## Consequences

- S19 adds recurrence, reminders, templates, attachments (passing exclusive files to `trash_move`), bulk actions, calendar views and task widgets. Nothing here pre-empts them: recurrence will hang occurrences off `tasks`, and widgets read through `list_tasks`.
- `list_tasks` builds a `can_complete` per row through `private.can_edit_task`; fine at 50 rows, revisit with an index-only rewrite if large Homes need it.
- The migration is additive except for the redefinition of the S16 dispatch functions, `trash_restore_one` and `trash_conflict_options`, and the widened check constraints on `trash_entries` and `audit_events`. It must be applied to `madeora-preview` and `madeora-production` before code that uses it runs there (`docs/supabase-migrations.md`).
