# UX4a — Atomic list + first task (backend slice)

Source: `plans/steps/UX00-redesign-plan-brief.md` (UX4 note: `tasks_list_check` needs a list, silent list creation is forbidden).

## Scope

- Migration `20261220090000_atomic_list_first_task.sql`: `public.create_task_list_with_task(...)`. Calls the existing `create_task_list` and `create_task` inside one transaction; a refused task rolls the list back (sub-transaction, `MD001`). Same permissions as before: lists need a task manager (Home) or the owner (Personal).
- `POST /api/v1/task-lists/with-first-task` (`{ homeId, list:{id,name}, task:{id,title,...} }`), zod-validated, same CSRF/auth helpers. No recurrence. No UI.
- Outcomes: `created` (201), `exists` (200 retry), `list_id_taken`/`task_id_taken` (409 `id-taken`), `duplicate_name`, `limit_reached`, `not_permitted`, `invalid_label`, `invalid_assignee`.

## Decisions / defaults

- Retry = list AND task both exist, made by the caller, task in that list; otherwise a reused list id is `list_id_taken`.
- Migration timestamp 20261220090000 (UX2-data uses 20261219090000).
- Rollback: drop the function (no schema change).

## Files

migration; `tasks/schema.ts`, `tasks/route-helpers.ts`, `api/v1/task-lists/with-first-task/route(.test).ts`, `packages/database/src/database.types.ts`, `tests/db/rls/atomic-list-first-task.test.sql`.

## Tests

Local: prettier, eslint, tsc, vitest for task routes (182 pass). DB test written but not run locally (no Docker, initdb refuses root); CI runs it.
