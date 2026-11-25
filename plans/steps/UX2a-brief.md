# UX2a — Dashboard widget shell

Branch: `feat/dashboard-widget-header`. Source: `docs/design/dashboard-ux-ui-redesign.md` Decisions 2, 8, 9, 18, 19, 20; `plans/steps/UX00-redesign-plan-brief.md` §3B and §4.
Model: Sonnet (UI only; no migration, RLS, auth or API change; saves reuse the existing `PUT dashboard` route).

## Done condition

Every widget in normal use has the same minimal header (title and one three-dot menu); settings open without edit mode; eligible widgets have Full / Compact / Hide-when-empty; widget content follows its own width. Positions, permissions and Personal/Home privacy are unchanged.

## Scope delivered

- **Header and menu** (`widget-shell.tsx`, normal mode only): Open full view (module path of the widget's own context; only where one exists), Settings (editors only, only types with something to configure), Refresh, Customize dashboard (editors only). Move, Resize and Remove stay in edit mode, so nothing moves or is removed from the menu. Unavailable (left-Home) widgets show no module, settings or refresh item and never leak the Home.
- **Settings without edit mode** (`widget-settings-dialog.tsx`): side panel (bottom sheet on a phone) around the existing `WidgetSettings`, with Apply / Cancel and an unsaved-changes question. Apply saves the **current saved layout with only that widget's config replaced** (placements untouched), against the current revision, so it is a normal checked save (conflict shows "Load the latest version" inside the panel). It is not the edit-mode draft.
- **Empty-state modes** (`widgets.ts`, `widget-empty.tsx`): additive `emptyState` (`full` default | `compact` | `hide`) on notifications, tasks, my/home chores, chore approvals, upcoming events, with a "When there is nothing to show" select in the settings. Only a genuinely empty result uses it: errors, restricted (not a reviewer), list-unavailable and filtered-out tasks keep their own states. `hide` is render-only (CSS `:has` marker on the grid item); edit mode shows a "Hides when empty" badge and the full frame.
- **Size variants**: the widget frame is a named container (`@container/widget`); `WidgetDetail minSize="m|l"` hides secondary content below ~19 rem / ~29 rem of the widget's own width. Applied to the task scope/filter line and notification timestamps. Content is by width tier, not by grid row count.
- `WidgetEntry` carries `type`, `href`, `emptyState` (computed on the server in `renderWidgets`).

## Decisions taken (reversible)

- Hide-when-empty keeps the widget's grid slot reserved (blank gap, no compaction): stable positions, nothing jumps when content appears (Decision 9: "never silently mutate the layout"). If Ward wants hidden widgets to close the gap visually, that is a follow-up (compaction policy, Decision 9 / UX00 §7).
- Settings save immediately on Apply (not auto-save), per Decision 8's open question.
- Only the six widget types above get the empty-state preference now; others render as before (`full`). Adding a type is one registry field plus swapping its `EmptyState` for `WidgetEmpty`.
- Size tiers by container width, so the same snapped size behaves the same on any screen.

## Not in this phase

Gallery, add-here, presets, reflow preview, drafts UI (UX2b+); inline-interaction changes for tasks/shopping/habits (Decision 19 widgets already complete inline; a conflict check with drag is unchanged because edit mode renders bodies `inert`); loading skeletons per widget (the server renders each body in one pass); visual baseline screenshots (no Supabase-backed app here).

## Rollback

Frontend only. Saved configs may now contain `emptyState`; code from before this PR rejects it (`strictObject`) and would show that widget as "unavailable settings → defaults". Revert is safe for layouts that never set it; if a user set it, saving once after revert is not needed because readers fall back to defaults, but the editor would drop the key on next save.

## Local checks (format, lint, typecheck, relevant tests only)

Prettier, ESLint (dashboard, calendar widget) and `tsc` clean; vitest dashboard, dashboard/layout, calendar, i18n, ui: 238 pass. Full suite, build and Playwright run on CI.

## Review

`reviews/steps/UX2a-review.md` (one independent review).

## Review follow-up (verified by the implementer, no second review)

Review: CHANGES_REQUIRED, 0 BLOCKER, 1 HIGH, 3 MEDIUM, 4 LOW (`reviews/steps/UX2a-review.md`).

- HIGH-1 fixed: hide falls back to compact when a Google calendar warning or a missing label/member warning is present, so warnings are never hidden.
- MEDIUM-3 fixed: `widget-empty.test.tsx` covers all three modes and the marker.
- MEDIUM-1 (all widgets hidden shows an empty area, no "N hidden" note) and MEDIUM-2 (reserved slot not checked in a browser; no Supabase-backed app here): accepted for now, listed for Ward. A hidden-widget note needs the server to know emptiness; propose it with the compaction policy decision.
- LOW-1..4 accepted; LOW-4 (rollback) is stated above.
