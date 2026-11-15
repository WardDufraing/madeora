# ADR 0055: Ora task edits and locking Undo

- **Status:** Proposed for S47d within the approved architecture (authorization C, database access A, the 13 Oct 2026 decision that Ora has no language model and no free text).
- **Date:** 2026-11-15
- **Step:** S47d (brief: `plans/steps/S47d-brief.md`).

## Decision

**Two more guided changes, both edits of an existing task:** `complete-task` and `change-task-due`. They follow ADR 0052: a server `prepare` step lists what the person may pick (their open tasks here, read with their own session; completing offers only tasks the task module says they can complete, a due-date change leaves out repeating tasks), the person sees the exact effect and confirms a button named for it, and the browser makes the change through the task module's own API (`PUT /api/v1/tasks/:id/completion`, `PATCH /api/v1/tasks/:id`), which checks identity, membership, CSRF, the task's edit right and its revision again. Ora adds no write path. A due-date change needs the whole task (the module's update saves all content), so a second `task` step returns the picked task as it is now (title, description, dates, priority, labels, revision); the browser sends it back unchanged except for the date, and a task someone changed in between answers 409 and is reloaded, never overwritten.

**Undo is now one locking database call per change.** The S47a Undo read the revision and then deleted in a second call, so an edit between the two could be trashed with the record (the accepted limitation recorded in ADR 0052). Four security-definer functions replace that: `ora_undo_task_create`, `ora_undo_shopping_item`, `ora_undo_task_completion` and `ora_undo_task_due`. Each takes the module's own row lock (`private.lock_task`, `private.lock_shopping_item`), checks the caller's right the way the module does (`can_delete_task`, `can_edit_task`, `shopping_may`), compares what Ora left behind (revision, or `completed_at` for a completion) and only then calls the module's own function (`delete_task`, `delete_shopping_item`, `set_task_completion(false)`, `update_task` with the old date). The lock is held to the end of the transaction, so whoever edits first wins and the other side gets `conflict`, answered to the person as "changed". They write nothing themselves; granted to signed-in users only. A second Undo answers `not_found` (adds) or `conflict` (completion, due date). The Undo window stays five minutes: it is read from the record's creation time (adds), the completion time (completion) or the task's last update (due date), and the server refuses earlier than the database call; the database call is the authority on "nobody changed it".

**Undo of a completion** reopens only the completion Ora made: the expected `completed_at` must still be the task's. A task someone else had already completed gets no Undo (nothing of Ora's to undo) and says so. **Undo of a due date** restores the previous date (or none) through `update_task`, so validation, labels and revision rules are the module's.

**History:** four new kinds (`task-completed`, `task-completion-undone`, `task-due-changed`, `task-due-restored`); the table's kind check is widened in the same migration. Lines hold the task title for seven days, personal to the person, as before.

**Permissions:** both tools are offered in Personal space and in a Home where the person may view tasks (`home.tasks.view`). The right to edit a particular task (creator, assignee or task manager) is decided per task by the database, so the picker lists only tasks the module reports the person can complete (the same predicate as the edit right) and the database still decides at the change. This was chosen over inventing a Home-wide edit capability the specification does not define.

## Not in this step

Recurring tasks and series occurrences (a due-date change of one occurrence has series rules; completing one is allowed and uses the module's own function), meal-to-shopping, multi-record updates, deletion, rescheduling beyond the due date, reminders content, celebrations beyond chore points. Recorded in `plans/steps/S47d-brief.md`.

## Open values

1. Both tools are non-quick (listed under "Browse all actions", not as opening buttons), to keep the panel's first screen short.
2. The picker shows at most 25 open tasks (due soonest, from the person's visible tasks).
3. Reopening can answer `list_unavailable` when the list was archived meanwhile; shown as "changed".

## Known limits and rollback

- The picker reads 50 rows, then filters and shows at most 25, so a person with many repeating or non-completable tasks may see fewer choices.
- The revision of a task does not change when it is completed or gets a comment, subtask or attachment, so Undo of an added task can still trash a task someone completed or commented on meanwhile (it stays restorable from Trash). Pre-existing; the lock closes only the edit race.
- A completion Undo needs the exact completion time; a mismatch answers "changed".
- Rollback: drop the four `ora_undo_*` functions, delete history rows of the four new kinds, restore the old kind check; the app then falls back to the previous build.
