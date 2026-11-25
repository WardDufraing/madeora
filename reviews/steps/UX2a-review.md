# UX2a independent review (feat/dashboard-widget-header)

Verdict: CHANGES_REQUIRED

Counts: BLOCKER 0, HIGH 1, MEDIUM 3, LOW 4

Evidence: `vitest run src/components/dashboard` 4 files / 76 tests pass (log /tmp/ux2a-vitest.log). Diff read in full; no source edited.

## Findings

### HIGH-1 Hide-when-empty also hides warnings that live in the same widget
- `dashboard-grid.tsx` (`[&:has([data-widget-empty=hide])]:hidden` on the `<li>`), `upcoming-events-widget.tsx:~54-62`, `widget-content.tsx:~397-407` (tasks).
- The marker hides the whole grid item, not just the empty message. In upcoming events the `GoogleWarnings` block ("a Google calendar is not up to date, so 'nothing ahead' may not be true") is rendered inside the same widget and is hidden together with it. In tasks, `labelsMissing` / `memberMissing` warnings (the saved filter references a deleted label or member) sit next to the empty state and are hidden as well. This breaks the done condition "never hide errors / restricted / filtered states", and the existing comment in the calendar widget says the warning exists exactly so an empty result is not trusted.
- Remediation: only emit `mode="hide"` (the marker) when no warning is present (for example pass `mode={warnings.length > 0 ? "compact" : config.emptyState}`, and the same when `missingLabels > 0 || missingMember`). Add tests for each (Google warning + hide, missing label + hide) asserting no `data-widget-empty="hide"` marker. Also treat the tasks `filtered` path the same way for a degraded filter.

### MEDIUM-1 Hidden widget leaves no access to its own menu and may leave a blank dashboard
- `dashboard-grid.tsx`. A hidden empty widget removes its menu (Settings, Customize). Recovery is only through the board-level Customize button (exists, acceptable) but there is no indication that anything is hidden in normal mode. If every visible widget is hidden-when-empty, the grid renders an empty area while the "no widgets" `emptyState` node is not shown (it keys off placements, not rendered content). Remediation: add a quiet "N widgets hidden while empty" note (also gives screen-reader users the state), or at least test/handle the all-hidden case.

### MEDIUM-2 Reserved blank slot is a visible layout regression on mobile
- With `hide` the grid slot stays reserved (documented decision). On the single-column phone layout the item is `display:none` but its grid row template/placement still reserves height only if the rows are fixed; confirm in a browser that a phone does not show a large gap. The brief states the gap is intended but never verified visually (no screenshot). Remediation: verify at phone and desktop widths before merge, or document the observed result.

### MEDIUM-3 `:has` marker is the only contract between server components and the client grid and is untested end to end
- `dashboard-board.test.tsx` only asserts a class string contains the selector; jsdom cannot evaluate `:has`/container queries. Nothing proves hide works, nor that `compact` does not hide. Remediation: add one Playwright smoke (empty notifications with `hide`) or at least a unit test of `WidgetEmpty` for each mode (full: no marker, compact: `data-widget-empty="compact"` and no `hide`, hide: marker). Currently `WidgetEmpty` has no direct test.

### LOW-1 `WidgetDetail minSize` hides the task scope/filter line below ~19rem, so on narrow widgets the user cannot see why a list looks short (filters). Acceptable per spec (secondary content) but the `filtered` empty state still explains itself; consider keeping scope for filtered-empty. 
### LOW-2 Refresh gives no pending/announce feedback (`widget-shell.tsx`, `useTransition` result discarded). Add `aria-busy` or a polite status.
### LOW-3 `hasSettings` is a deny-list (`noSettingsTypes`): a new widget type gets a Settings item by default even when it has nothing to configure; prefer an allow-list or derive from the registry (empty strict object). Also a widget whose only settings are the empty state is correctly covered.
### LOW-4 Rollback: old code rejects `emptyState` (`strictObject`) so a user who set it sees "unavailable settings" until resave. Documented in the brief; accepted, but mention in the PR body.

## Checks
- Requirements (menu on every normal widget, Open/Settings/Refresh/Customize): PASS. Move/Resize/Remove not in menu: PASS.
- Settings without edit mode, side panel, Apply/Cancel, discard prompt, error kept in panel: PASS. Apply saves current layout with only that widget's config; placements unchanged; uses `revision` (not stale `baseRevision`) when not editing: PASS (test asserts expectedRevision and placements).
- Permissions: Settings and Customize gated by `canEdit` in UI; real enforcement stays in the unchanged PUT route plus RLS; no new API. PASS.
- Home isolation / privacy: `href` computed server-side from the widget's own context; unavailable (left-Home) widgets get `href: null`, no settings, no refresh, generic title; no Home name leaked. Hidden-layout widgets are not rendered (existing). PASS.
- Hidden state vs errors/restricted/filtered: error and list-unavailable use `ErrorState`; filtered keeps `full`; restricted chore approvals keeps own state; BUT warnings are hidden with the widget (HIGH-1). FAIL until fixed.
- Accessibility: OverflowMenu has per-widget label ("Actions for X"), axe test with menu open passes; dialog titled per widget, Close/Cancel/Apply, discard confirm; `display:none` hide removes content from the a11y tree consistently; no announcement of hidden/reappearing widgets (LOW). Mostly PASS.
- i18n: en and nl keys added in matching sets, dynamic `settingEmptyState_*` keys registered in messages.test; Dutch wording reads naturally. PASS.
- Types/config: additive `emptyState` default `full`, `emptyStateModeOf` safe on odd config. PASS.
- Tests: good coverage of menu, settings save, failure, discard, edit badge; gaps listed in MEDIUM-3 and HIGH-1.
- Performance/maintainability: server-computed entry fields are cheap; container-query tiers are simple; `WidgetSettings` wrapper split is clean.
- Rollback: frontend only, documented. PASS with LOW-4.

## Remaining risks
- Visual behaviour of hide gaps, container-query tiers and `:has` is unverified outside jsdom (no browser check, no screenshot).
- Older cached clients saving a layout without `emptyState` simply fall back to `full` (safe).
