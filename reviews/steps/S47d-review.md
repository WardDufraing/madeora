# S47d independent review: Ora task edits and locking Undo

Verdict: PASS (0 BLOCKER, 0 HIGH, 2 MEDIUM, 5 LOW)

Targeted run: `pnpm exec vitest run src/ora src/components/ora` gave 21 files, 218 tests, all passing. The DB test (tests/db/rls/ora_locking_undo.test.sql) was read, not run.

## Findings

### MEDIUM

M1. A due-date change can be offered for a task the person cannot edit, and the refusal reads as "task gone".

- Where: apps/web/src/ora/actions/server.ts `prepareTaskAction`; `loadTaskEdit` returns `task: null` when `!detail.can.edit`; apps/web/src/components/ora/ora-task-action.tsx `taskGone` shows `failGone`.
- Impact: a Home member who can see a task but is neither creator, assignee nor manager picks it and is told it no longer exists. That is untrue and confusing. ADR 0055 accepts the picker over-listing, but not the wrong message.
- Fix: have `loadTaskEdit` return a distinct reason (`not-editable` or `gone`), or filter the picker by the edit right. List rows may expose `canComplete` (same predicate as `can_edit_task`), so filter due-change picks with it too. Show `failNotPermitted` for that case.

M2. The DB test does not cover several outcome branches or the cases that are specific to this change.

- Where: tests/db/rls/ora_locking_undo.test.sql.
- Missing cases:
  - `ora_undo_task_completion` returning `list_unavailable` (list archived) and `not_permitted` (a plain Member who did not create or get assigned the task).
  - `ora_undo_task_due` returning `invalid` (start_date after the previous due).
  - `ora_undo_shopping_item` returning `not_permitted` (a view-only member, or an archived list).
  - Undo of a deleted (trashed) task or item returning `not_found`.
  - The expected `completed_at` arriving as text with microseconds, as it does through PostgREST and JSON. The test passes a real timestamptz from a table, so the JSON path is untested.
- There is no two-session test that holds the row lock. The same-transaction lock follows from `lock_task` and `lock_shopping_item`, so I did not find a defect, but the claim "an edit between check and write cannot be overwritten" is only evidenced by sequential tests.
- Fix: add the missing assertions. Add a concurrency test if the harness supports two connections; otherwise state the gap in the PR.

### LOW

L1. The completion Undo requires an exact microsecond match, while the module's own reopen truncates to milliseconds (`set_shopping_item_completed` does `date_trunc('milliseconds', ...)`).

- Where: migration lines for `ora_undo_task_completion` (`completed_at is distinct from p_expected_completed_at`).
- Impact: it works today because the string travels unchanged (route returns `nullable(row.completed_at)`; client sends it unchanged; zod `z.iso.datetime({offset:true})` accepts any precision). If anything on that path converts it through a JS `Date`, Undo would always answer `conflict`. This fails safe.
- Fix: add a unit test that a six-digit-fraction string reaches `rpc` untouched, or compare at millisecond precision like the shopping module.

L2. `outcomeOf` maps `invalid_label` (possible from `update_task` inside `ora_undo_task_due`) to `unavailable`. Fix: map it to `changed`, as with `invalid`.

L3. The picker reads 50 rows and then filters (`canComplete`, `!recurring`) and slices to 25. People with many repeating or non-completable tasks may see fewer choices, or none, although others exist. Acceptable for the MVP; note it in the brief or ADR.

L4. A stale doc comment in apps/web/src/ora/actions/types.ts says both reversals "move the new record to the module's Trash" and `UndoResult` "undone" is "Moved to Trash". Reopening and restoring a date are not trash moves.

L5. Undo of an add (`ora_undo_task_create`) compares only the revision. Completing a task, comments, subtasks and attachments do not bump the task revision, so Undo can trash a task that someone completed or added a comment to (it stays recoverable in Trash). This existed before the change. Shopping check-off does bump the revision, so items are fine. Record it as a known limitation in ADR 0055, which says Undo "never overwrites" edits.

## Checks

Requirements: met. Complete-task and change-due have a picker, an exact-effect summary, an action-named confirm button (`confirmComplete` / `confirmDue`) and Undo with a five-minute window. Add-task and add-shopping-item Undo now go through `ora_undo_task_create` and `ora_undo_shopping_item`. No LLM or free text. The change goes through the module's own API (PUT completion, PATCH task) and its own functions. The migration adds no table writes of its own; the `ora_interactions` kind check is widened, and `database.types.ts` is updated.

SECURITY DEFINER functions:

- All four use `set search_path = ''`, qualify every object, call `private.require_confirmed_caller()` first, validate nulls with 22023, and revoke from public and anon with a grant to authenticated only. Anonymous callers are tested as denied.
- Each takes the module's lock (`lock_task` or `lock_shopping_item`, which locks the list first and then the item) and checks the module's right (`can_delete_task`, `can_edit_task`, `shopping_may(edit)`). They then compare the revision or `completed_at` and call the module function. The module functions re-take the same locks in the same transaction, which is re-entrant. Lock order matches the module, so there is no new deadlock path.
- The caller identity is `auth.uid()`; the wrappers never accept a user id from the client.
- The nested calls are safe. `delete_task` and `delete_shopping_item` return `(outcome, entry_id)` and the wrappers select only `outcome`. `update_task` receives the unchanged title, labels, description, start date and priority, so only the date changes. Its `detached` flag only affects series tasks, which the picker excludes.
- The `invalid` guard (start after previous due) runs before `update_task`, so the module's 22023 is not hit.

Cross-Home isolation: `lock_task` and `lock_shopping_item` return null outside the caller's context, so the answer is `not_found`. The TS Undo also compares `homeId` to the Ora context and answers `gone`. Home tasks use the per-task edit right. The DB tests cover another account, and a Member without the right.

Permissions: enforced by the database. The registry gate only controls who sees the tool (see M1 for the message).

Secrets: none added.

Input validation: the zod `strictObject` union is discriminated by step. `undo` is refused for task-edit tools and the task-edit steps are refused for add tools (`invalid`). The `completedAt` ISO datetime and the `previousDue` ISO date are validated. Client-supplied `completedAt` cannot bypass the window because the database requires it to equal the real value.

Migration safety: drop and add of a widened check constraint is safe. The new functions are additive. No rollback note is in the ADR (a rollback is dropping the four functions and restoring the old check, after deleting rows of the new kinds). Add this to the PR.

Test coverage: unit tests cover server `prepare`, `loadTaskEdit` and `undoTaskEdit` (window, place, DB outcomes, failures), the registry, i18n key parity, and the component (task-edit flow). The DB test covers the main paths. See M2 for gaps.

Accessibility: labelled `SelectField` and date field, a checkbox with a text label, `role="alert"` for failures, `role="status"` for the done and loading text, focus moved to the wrapper after done or failed and to the field on validation errors, and an Undo toast with an action. The summary paragraph is not a live region, which is acceptable because confirm is explicit.

Performance: one extra list read (at most 50 rows) on opening, and one task read per pick. Fine.

Maintainability: the logic is mirrored consistently; the branches in `run-input.ts` are clear; the draft keeps in-memory state only.

## Remaining risks and test gaps

- No real two-session lock test (see M2).
- Completing a task does not bump the revision (L5).
- Reopening a task may leave chore-point or celebration side effects. I did not trace these; the module owns them.
- Draft reset: `draft = storedDraft ?? initial` falls back to the first draft after a successful confirm, but it is not shown in that state, so I found no user-visible effect.
