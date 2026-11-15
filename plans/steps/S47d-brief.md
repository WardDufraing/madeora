# S47d · More Ora guided actions and a locking Undo — feature brief

**Branch:** `feat/ora-more-guided-actions` from `main` (S47c merged, PR #89).
**Model:** Sonnet (verdict given in thread). Same pattern as S47a to S47c; the one concurrency piece is four small functions that lock a row and call the module's own function.
**Sources:** build plan S47; ADR 0052 (limitation this step closes), ADR 0054 (deferred list), ADR 0055 (this step); PS L872 to L928 (guided workflows, Quick Undo).
**Done when:** the person can complete a task or change a due date from Ora with an editable preview, an action-named confirm button and Undo; Undo never overwrites anyone's later edit, including one made in the milliseconds between check and delete.

## Scope

1. `complete-task` and `change-task-due` (tool kind `action`, Personal and Home), picker of open tasks, preview, confirm, result, Undo (toast if Ora is closed), history lines.
2. Locking Undo: `ora_undo_task_create`, `ora_undo_shopping_item`, `ora_undo_task_completion`, `ora_undo_task_due`; the S47a Undo now uses the first two.
3. History kinds widened (migration `20261210090000_ora_locking_undo.sql`).

## Deferred (by choice, to keep this PR reviewable)

Meal to shopping, recurring and series changes, multi-record updates, deletion, reminders content, celebrations for milestones or on the wall display. Ward decides whether any of these becomes S47e before S48.

## Defaults picked (Ward may change)

1. Only tasks, only two edits: the two most common ones, both exactly reversible by the module's own functions. Deletions stay out (Trash already covers them).
2. Repeating tasks can be completed but their due date cannot be changed from Ora (a series occurrence has its own rules).
3. No new Home capability: the database decides per task whether the person may edit it; the picker may list a task they then cannot change, and the answer says so.
4. Undo window stays five minutes.
5. Both tools are under "Browse all actions", not opening buttons.

## Status

- [x] ADR 0055, migration, types (regenerated from a migrated throwaway PostgreSQL 16, `--check` clean), DB test `tests/db/rls/ora_locking_undo.test.sql`
- [x] Server `ora/actions` (prepare, task, undo steps), tool catalogue, client calls, `ora-task-action.tsx`, i18n en/nl
- [x] Local: prettier, eslint (touched dirs, max-warnings 0), tsc, unit/component/route tests for ora, components/ora, api/v1/ora, i18n, displays: pass; DB: the new test plus tasks and shopping tests pass on a throwaway PostgreSQL 16 (a mutated copy of the new test fails as it should)
- Not run locally by design: full suite, build, Playwright (CI)
- [x] Independent review: PASS (0 BLOCKER, 0 HIGH, 2 MEDIUM, 5 LOW) -> `reviews/steps/S47d-review.md`. Fixed: M1 (picker lists only tasks the person can edit, clearer message), L2 (`invalid_label` shown as changed), L4 (stale comment), L3/L5 and rollback recorded in ADR 0055. Not done: M2 extra DB branches and a two-session lock test (the lock is the module's own `lock_task`, covered by the existing concurrency tests of that module); L1 accepted.
