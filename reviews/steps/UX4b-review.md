# UX4b review: Tasks workspace (feat/redesign-tasks-workspace)

Verdict: CHANGES_REQUIRED

Counts: BLOCKER 0, HIGH 1, MEDIUM 3, LOW 4

Checked: `git diff origin/main...HEAD`, brief, redesign decisions 46-55. Ran `vitest run src/components/tasks src/tasks` (146 pass) and `tsc --noEmit` (clean). nl/en message keys have parity. E2E not runnable locally, specs read for logic errors.

No change to data, permissions or Personal/Home privacy: no migration, no new API, all reads go through the viewer's session and existing RPCs. `?task=` is validated with `z.uuid()`, and the detail still checks `task.value.homeId !== homeId` (panel shows a neutral message); RLS unchanged. Row hrefs are built with URLSearchParams-derived text, no injection.

## HIGH

H1. Unchanged e2e spec will fail: `tests/e2e/specs/acceptance-ora-change.spec.ts:60-76` (also :41).
The test adds "Book the boiler service" through Ora with due date 2030-05-01 (preview filled at line ~52, kept after edit, line ~58 "confirmed (edited) values"), then `other.goto("/tasks")` / `other.reload()` and expects a `task-row` for it. `/tasks` now defaults to Today, where a 2030 task is in no group (it is only in All). `toBeVisible` will time out. The brief said existing e2e specs are updated; this one was missed. A grep of all specs that visit `/tasks` or `/homes/*/tasks` without `view` is needed (`acceptance-states.spec.ts:82` works only because the task has no due date and shows in "No due date").
Remediation: use `/tasks?view=all` in this spec (lines 41, 60, and the reloads), or assert in Upcoming.

## MEDIUM

M1. Upcoming omits tasks: `apps/web/src/tasks/views.ts:44-52` (`viewGroups.upcoming`).
Groups are `due_week` (today..today+6) and `upcoming` (start date after today). A task due in 3 weeks with no future start date appears in neither Today nor Upcoming, only in All. "Upcoming" silently hides open work, and `due_week` also repeats "Due today" tasks from the Today view. Matches the brief literally, but the brief is the gap.
Remediation: add a "Later" group (needs a RPC/filter, or fetch `when=any` open with due after today+6), or have the owner confirm the narrower meaning and say so in the empty state. At minimum record it as a gap.

M2. Escape discards work in the side panel: `apps/web/src/components/tasks/task-panel.tsx:378-388`.
The document-level handler closes the panel on Escape from any target except an open `<dialog>`. Escape in the comment box, subtask field, an inline "Add a task" form in the list, or an open native select closes the panel (router.push) and loses the typed draft; the panel is also intentionally non-modal on desktop so focus is often in the list.
Remediation: only handle Escape when the target is inside the panel and not a text input/textarea/select with a value, or when `event.target` is body or the panel/row link; do not handle it for the list's inline forms.

M3. Focus lost on "More options": `apps/web/src/components/tasks/task-form.tsx` (`!showAll` block, `aria-expanded={false}` button).
Pressing the button unmounts it, so keyboard focus drops to `body` inside the dialog, and `aria-expanded={false}` is meaningless on a button that disappears. The keyboard e2e (`tasks.spec.ts:~329`) clicks it with the mouse, so this is not exercised.
Remediation: move focus to the first newly revealed field (description) after expanding, or keep the button as a toggle with `aria-expanded`/`aria-controls`.

## LOW

L1. `apps/web/src/components/tasks/task-list.tsx:279-283`: `completedCount` adds settled in-visit tasks that are not in `completed.tasks`. After a refresh the server total already includes them, so when the completed first page is full (50) or the task falls outside it, the count is one too high per task. Compare ids against the server total differently, or drop the addition once `loadedAt` changed after the completion.

L2. `apps/web/src/components/tasks/task-panel.tsx:390-405`: on narrow screens the bottom sheet covers the list with a backdrop but there is no focus trap or `inert` on the list behind, so Tab reaches hidden controls and the aside is not `role="dialog"`/`aria-modal`. Add `inert` on the list column below `lg` or make the sheet a modal dialog.

L3. `apps/web/src/components/tasks/tasks-overview.tsx:75` plus `task-detail.tsx:62`: `advanceSeries` runs twice and `getTask`/list lookups repeat when the panel opens (overview plus `TaskDetailPage`). Harmless correctness-wise, extra RPCs on every row click. Pass a flag to skip it in the panel variant.

L4. Test gaps: `task-panel.test.tsx` and `tasks.test.tsx` cover rendering and completion retention, but nothing tests the Escape rule with focus in an input (M2), the Completed count after refresh (L1), the Today-with-no-lists flow in the overview, or `parseTaskView` for repeated `?view=` values beyond the array case. `acceptance-states.spec.ts` was not updated or re-reasoned for the dialog flow (looks fine on reading: the title stays and the row appears once; the "Add task" role name does not collide with "Add a task").

## E2E logic read-through (edited specs)

- tasks.spec, task-recurrence, task-reminders-templates-bulk, task-attachments, calendar: the `view=all` navigations, "More options" clicks before Due date only where needed (Due date and Priority are in the quick form: `calendar.spec.ts` and reminders `addTask` correctly skip it), Escape-after-add, "Open full page" hops and the `?task=` id extraction are consistent with the implementation. `page.getByTestId("live-region").filter(...)` is robust to the several announcers per page.
- Personal journey: "Buy bulbs" (due 2026-10-10) is overdue, so it is visible in Today after `/tasks`, restore and `goto("/tasks")` steps work.
- `?status=all` addresses resolve to the All view by the legacy rule, matching the spec edits.

## Explicit checks

- Requirements: all UX4b scope items present except the Upcoming gap (M1); completed-display preference documented as out of scope.
- Cross-Home isolation / permissions: unchanged; panel keeps the homeId guard; New list / create-list controls follow `canManage`, server still enforces.
- Secrets/input validation: `task` uuid-validated, view parsed by zod enum; first-list name validated client-side and by the existing endpoint.
- Migration safety: none.
- Accessibility: priority is text plus bar, overdue is text, reduced motion respected, live announcements kept; see M2, M3, L2.
- Performance: Today/Upcoming issue 2-3 parallel list RPCs; acceptable. See L3.
- Maintainability: `task-list.tsx` grew to ~600 lines with retention state; acceptable but a candidate for extraction of the retention logic into a hook.
