# S18 · Tasks core — feature brief

**Branch:** `feat/tasks-core`, from `main` at `7238ebc` (S17 merged as PR #28).
**Sources:** build plan S18; MOD §4.3; PS L2145–L2158 (independent tasks, basic activity), L2194–L2264 (labels, lists and All Tasks, start/due dates, multiple assignees with shared completion, comments, priority, subtasks), L770–L790 (member departure: tasks stay, become unassigned and flagged), L820–L840 and L2281–L2327 (trash), L2418–L2421 (dashboard ownership); ARCH §4, §9, §36; ADRs 0011, 0017, 0018, 0020, 0021.

**Done when:** create, assign, complete and delete-to-trash work, with RLS tests across Homes.

## Scope

- Named task lists per context (Personal, each Home): create, rename, reorder, archive/unarchive, delete to trash. An **All Tasks** view per context aggregates the active lists the viewer may see.
- Tasks: title, plain-text description, optional start and due **dates** (date-only, in the context's timezone), optional priority (Low, Normal, High, Urgent, or unset), labels, single-level subtasks, comments, basic activity (creator/created, updater/updated, completer/completed).
- Home tasks: zero or more assignees (current members of that Home), one **shared** completion state.
- Filters: status (open/completed), Upcoming / Active / Overdue, hide or show future-start tasks, priority (incl. Unspecified), labels (any of), assignee (me, unassigned, needs reassignment, a member). Sort: due date, priority asc/desc, created; stable tie-break (due date, created, id). 50 tasks per page with "Show more"; the count is the filtered total.
- Moving a task between lists of the **same** context.
- Labels per context: create, rename, colour, remove with an impact count and confirmation (removal detaches, never deletes tasks).
- Delete a task to the trash (with its subtasks, comments, assignees and labels); restore with conflicts; purge.
- Member departure: the leaver's assignments on that Home's tasks end; open tasks they were on are flagged **Needs reassignment** until a task manager sets assignees.
- Quick actions widget gains a Tasks link (personal and Home). No task widgets.

## Not in S18

Recurrence and scopes, occurrence history, reminders, templates, bulk actions, calendar views, attachments, task dashboard widgets (all S19). No assignment notifications (open decision below). No Realtime: views refetch after the person's own changes and on navigation.

## Permissions — default picked (the per-module matrix is open in the spec; Ward may override)

The spec says assignment needs "the Home task-management permission", that there are members with and without completion permission, and that new features get minimum privileges (Administrator capabilities, L391ff). Default:

| Action (Home)                                                                  | Who                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| View lists, tasks, labels, subtasks, comments, activity                        | every current member                                                                     |
| Create a task in an active list                                                | every current member                                                                     |
| Edit a task (title, description, dates, priority, labels, subtasks, move list) | its creator, its assignees, task managers                                                |
| Complete / reopen (shared)                                                     | its creator, its assignees, task managers                                                |
| Set assignees                                                                  | task managers only (spec: "Home task-management permission")                             |
| Delete a task to the trash                                                     | its creator, task managers                                                               |
| Manage lists and labels                                                        | task managers only                                                                       |
| Comment; edit/delete own comment                                               | every current member who can view the task; own comments only                            |
| **Task managers**                                                              | the Owner, and Administrators granted the new delegable capability **`manageHomeTasks`** |
| Restore / purge a task or list from the Home trash                             | S16 generic rule: who deleted it while still a member; Owner and `manageHomeSettings`    |

Personal context: only its owner, for everything; personal tasks have no assignees. A Home the caller is not in answers like one that does not exist.

## Design (summary)

- **One migration** `20261026090000_tasks.sql`: private tables `task_lists`, `tasks`, `task_assignees`, `task_labels`, `task_label_links`, `subtasks`, `task_comments`; `public` `security definer` functions with `search_path = ''`, each re-checking the confirmed caller and current membership; engine actions mirrored by `private.can_manage_home_tasks` / `private.can_edit_task` / `private.can_delete_task`.
- **Optimistic revisions** on tasks, lists, labels, subtasks and comments (`conflict` on a stale revision, as S17). Creates take a client-generated id, so a retry returns the same row and never duplicates (tasks, subtasks, comments).
- **Shared completion** under a row lock: the first completion wins and records the actor once; a second concurrent one reports `already_completed` with the winner. Two-connection race test.
- **Trash:** tasks (`module tasks`, item type `task`) and lists (item type `task_list`) go through `private.trash_move`; the four dispatch functions gain their cases. Task restore conflict `list_unavailable` (its list was deleted or archived meanwhile) with resolution "restore into another list of the same context" (`move_to_list:<listId>`). A list can be deleted only when no active task is in it and archived only when no open task is in it (impact review). Matching names are never a conflict. Purging a list detaches trashed tasks from it.
- **API** under `/api/v1/tasks…`, same CSRF/JSON/size checks, user-session client. **UI** at `/tasks…` and `/homes/{id}/tasks…`, Server Components for reads, TanStack Query mutations with keys scoped by user and context.

## Defaults picked (Ward may override)

1. Permissions as in the table, with the new capability `manageHomeTasks` ("Manage Home tasks").
2. Limits: list name 1–60, label name 1–40, task title 1–200, description ≤ 5 000, comment 1–2 000, subtask title 1–200; ≤ 100 lists and ≤ 100 labels per context, ≤ 20 labels and ≤ 20 assignees per task, ≤ 100 subtasks per task. Names use the S09 visible-name policy; duplicates (case-insensitive, after normalisation) among a context's non-deleted lists or labels are refused; a restore never fails on a name.
3. Label colours: the accent palette ids plus a neutral default; label text is always shown.
4. Label filter matches tasks with **any** of the selected labels.
5. Hide future-start tasks is a filter toggle (on by default in list views, off in Upcoming); remembering it per person is left for later.
6. Comments and subtasks are deleted directly (with confirmation), not via the trash; they go to the trash only with their task.
7. "Today" for Upcoming/Active/Overdue: the Home's timezone for Home tasks, the person's effective timezone for personal tasks.
8. The trash keeps the S16 generic visibility rule; no per-type hook.

## Open decisions for Ward

- **D1 Permission matrix** (above), including whether plain Members may assign on tasks they created.
- **D2 Assignment notifications:** left out; add later through the S14 `notify_user` path (category `tasks`, quiet hours apply)?
- **D3 Subtask ticking by assignees** is included through "assignees may edit"; confirm.
