# Review: PageHeader actions slot (feat/ui-page-header-row)

Verdict: PASS

Scope: `page-header.tsx`, `page-header.test.tsx`, `calendar-view.tsx`, `tasks-overview.tsx` (diff `origin/main...HEAD`).

## Checks

- Requirements and scope: UI layout only, no product behaviour change. Pass.
- Heading semantics: one `h1` per page. Tasks previously used its own `h1`, now uses `PageHeader`, so there is still exactly one. `NewTask` adds an `sr-only` `h2`, which is unchanged. Pass.
- RTL: only logical or direction-neutral utilities (`justify-between`, `flex-wrap`, `items-end`, gap). Actions sit at the inline end in both directions. Pass.
- Narrow widths and long Dutch labels: the outer row and the actions wrapper both use `flex-wrap`, so the actions drop under the title and then wrap among themselves. Pass.
- `NewEventButton` inside `CalendarClient`: it is still a child of `<CalendarClient>`, so `useCalendarClient()` resolves. `data-testid="calendar-new-event"` is unchanged and `calendar-redesign.test.tsx` covers click, dialog and href. E2E only references `calendar-new-event` through that test id (none in `tests/e2e`). Pass.
- E2E specs: `tasks.spec.ts` queries `heading level 1 name "Tasks"`, still satisfied. No spec depends on the old toolbar position or the old header DOM. Pass.
- Archived lists: `current?.archived ? null : <NewTask/>` yields `actions={null}`, and `PageHeader` falls back to the plain title block with no empty action area. Behaviour is the same as before. Pass.
- Security, permissions, cross-Home isolation: untouched. `canCreate` and `canManage` gating is preserved. Pass.

## Findings

No BLOCKER or HIGH findings.

- MEDIUM: none.
- LOW-1 (`tasks-overview.tsx`, around the `PageHeader` call): the tasks title changes from `font-semibold` to `font-bold`, and the bottom margin from `mb-6` to `mb-8`. This is a small visual change and consistent with the other pages. Remediation: none needed, but mention it in the PR description.
- LOW-2 (`page-header.tsx`): `centered` combined with `actions` places the heading at the start of the row, not centred. No caller combines them today. Remediation: document the limitation in the prop comment, or ignore `actions` when `centered`.
- LOW-3 (`page-header.test.tsx`, "same row" test): it asserts DOM nesting rather than layout, and relies on `closest("div")`, which is brittle. Remediation: acceptable. Optionally assert the wrapper has the `flex` class, or leave the layout to the Playwright visual check.
- LOW-4 (coverage): there is no test for the archived-list case (no "New task") or for the calendar `canCreate=false` case in the header. Both are simple null-branch cases covered indirectly. Remediation: add one test for the null-actions path per view, or an E2E assertion on an archived list.
- LOW-5 (`tasks-overview.tsx` line 2): the `@/components/shell/page-header` import comes before `next-intl`. Remediation: confirm that ESLint import ordering and Prettier pass in CI.

## Remaining risks and test gaps

- No visual or Playwright check of wrapping at 320px with Dutch labels ("Nieuwe taak", "Vanuit sjabloon") was run in this review. Static analysis of the classes indicates it wraps correctly.
- `items-end` aligns the buttons to the subtitle baseline when the subtitle wraps onto several lines. This is cosmetic.
- This is an AI review and is not a substitute for the human approval required by CLAUDE.md.
