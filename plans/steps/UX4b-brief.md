# UX4b — Tasks workspace (UI on UX4a)

Source: `docs/design/dashboard-ux-ui-redesign.md` decisions 46–55 and "Tasks: visible primary creation action"; `plans/steps/UX00-redesign-plan-brief.md` (UX4 rows); `plans/steps/UX4a-brief.md` (atomic list + first task). Branch `feat/redesign-tasks-workspace`. Model: Sonnet (UI on existing data, no auth/RLS changes).

## Scope (all web UI; no migration, no new API)

- **Views (D46):** `?view=today|upcoming|all|lists` plus the existing Calendar view. Today is the default landing view. Old addresses keep working: no `view` but a `list` → Lists; no `view` but any filter parameter → All.
  - Today: groups Overdue, Due today, No due date (all open, started tasks).
  - Upcoming: groups Next 7 days (`due_week`) and Starts later (`upcoming`).
  - All: every list, with the existing filters. Lists: list switcher + that list's tasks, with the filters.
- **+ New Task (D46, D55, fix):** always visible in the page header, also in the empty states. Opens a dialog with the quick form (title, list, due date, priority) and a **More options** button that reveals the full form (description, start date, labels, repeat, assignees). Zero lists: the dialog asks for a list name (explicit confirmation text) and posts to `POST /api/v1/task-lists/with-first-task`; a viewer who may not create lists sees the existing "ask a manager" message. "From template" stays.
- **Inline quick-add (D55):** "Add a task" in every group; the Today group presets today's date; a list's group presets that list.
- **Rows (D47, D49–D53):** compact separated rows; slim priority bar with text label (never colour alone); "Overdue · N days"; subtask count + small progress bar; completion highlight (reduced-motion safe) and undo; completed rows stay in place for a few seconds, then move to a collapsed Completed section (count, expand, reopen). The server supplies the Completed section for All and Lists; Today and Upcoming keep the ones completed in this visit.
- **Side panel (D48):** `?task=<id>` renders the existing task detail beside the list (desktop) or as a bottom sheet (narrow). Same server sections as the full page, so permissions and read-only states are unchanged. Escape and Close return focus to the row; view, filters, list and scroll are kept (`scroll={false}`). The full page `/tasks/<id>` stays ("Open full page").
- **List switcher (D54):** `AdaptiveSwitcher` in the Lists view with a **+ New list** dialog (existing create-list endpoint) and the archived-lists disclosure.

## Out of scope / gaps for Ward

- Completed-task display preference (D51 "keep visible or group") needs a stored preference; not built, see Gaps.
- Bulk select, filters, templates, recurrence, reminders, attachments, comments: unchanged.
- Not touched: `mobile-nav.tsx`, `sidebar.tsx`, `docs/marketing-website-design.md`, `PageHeader`.

## Progress notes

- 2026-11-25: brief written, started.
