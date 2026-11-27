# Independent review: feat/ui-dashboard-airy (UX dashboard airy)

Scope: `git diff origin/main` (3 source edits: `GRID_GAP` 16 to 20 in `apps/web/src/dashboard/widgets.ts`, `gap-4` to `gap-5` and the `WidgetFrame` header/content padding in `apps/web/src/components/dashboard/dashboard-grid.tsx`). Inspection only; nothing was run.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM and two LOW notes.

## Explicit checks

- Requirements: purely visual spacing change; no product behavior, permission or data change. Product specification untouched.
- GRID_GAP consistency: every consumer reads the constant. `dashboard-editor.tsx` uses it for RGL `margin` (l.854), `colWidth` (l.598) and the empty-slot overlay left/top/width/height (l.944-947). The read-only grid's `gap-5` (20px, `grid-gap` in Tailwind scale) equals `GRID_GAP`, and `auto-rows-[88px]` equals `ROW_HEIGHT`. No remaining hard-coded 16 or `gap-4` tied to the grid (grep of `src/dashboard`, editor, grid; the only other `ROW_HEIGHT`/`GRID_GAP` users are the files above).
- Saved layout semantics: layouts store grid units (x, y, w, h), not px, so existing saved layouts, presets and history remain valid; only rendered px change (a h-row widget is now h*88+(h-1)*20 px, +4px per extra row).
- Heights vs new header: no widget has `minH: 1`; the smallest is `minH: 2`. Header chrome grew from 52px (pt-5 20 + 28px line + pb-1 4) to 61px (20 + 28 + pb-3 12 + 1px border) and content top padding from 12 to 16px, i.e. +13px chrome; at h=2 the row grows +4px, so the content area drops from about 102px to about 93px (article border 2px, bottom padding 24px). Content already lives in `overflow-auto`, so it scrolls rather than clips, but an h=2 widget with a two-line title (320px, long Home name) leaves about 65px.
- a11y: border uses `border-line` token (maps to a system colour in forced-colors, still visible); `mx-6` is symmetric so RTL is unaffected (logical-property lint not triggered); title width unchanged (24px inset both sides, actions stay shrink-0); no focus ring lives in the header; article keeps `overflow-hidden` as before, no new focus clipping. 320px: the 1-column grid gets 4px more vertical gap only; no horizontal change.
- Container queries: `@max-[19rem]/widget` and `@max-[29rem]/widget` (one use). At 12 columns the total gap rises by 44px, so each column is about 3.7px narrower; widgets sitting within a few px of 19rem/29rem could flip variant. Unlikely to matter, noted below.
- E2E: `dashboard.spec.ts`, `dashboard-presets-history.spec.ts`, `task-attachments-calendar-widgets.spec.ts` contain no bounding-box, gap, or pixel-geometry assertions (grep: no `boundingBox`/`toHaveCSS`/gap/transform hits); `shell.spec.ts` boundingBox checks concern sidebar/tooltip only. Selectors are role/test-id based. Low regression risk. Not executed per instructions.
- Cross-Home isolation, permissions, secrets, input validation, migration safety: not affected.
- Tests: no test was added or changed. `widget-frame.test.tsx` has no assertion on the divider; acceptable for a styling change but see LOW-2.

## Findings

- MEDIUM-1 (`apps/web/src/components/dashboard/dashboard-grid.tsx` l.120, l.125): h=2 widgets (e.g. entries in `widgets.ts` l.360-371, 429-431) lose about 9px of content height and about 65px remain with a wrapped title. Impact: possible new inner scrolling in compact widgets (quick add, small calendar/summary) at lg/md. Remediation: verify visually at the smallest sizes (lg h=2, sm h=2, 320px, long Home title); if content now scrolls, raise those widgets' default/min h to 3 in `widgets.ts` (a data-only change, saved layouts are unit-based so clamping applies) or trim `pt-4` to `pt-3`.
- MEDIUM-2 (`dashboard-editor.tsx` l.879): in edit mode the header also holds action buttons; with the taller header and a wrapped title, h=2 widgets have little room beneath. Remediation: same visual check in edit mode, including keyboard move/resize overlay alignment with the new gap (math is constant-driven so should align).
- LOW-1: container-query thresholds (`@max-[19rem]/widget`, `@max-[29rem]/widget`) see narrower columns by about 3.7px at 12 columns; confirm the affected widget does not change variant at default sizes.
- LOW-2: `widget-frame.test.tsx` does not cover the header divider; optional.

## Remaining risks / test gaps

No visual regression screenshots; the e2e suite was not run in this review. Confirm CI (unit, e2e dashboard specs, axe) is green before merge. Human approval remains required.
