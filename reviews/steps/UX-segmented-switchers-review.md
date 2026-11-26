# Independent review: UX segmented switchers (feat/ui-segmented-switchers)

Scope: `segmented` / `segment` utilities in `apps/web/src/app/globals.css`, class changes in calendar, tasks, chores, goals, points, dashboard components. Read-only review; no source edited. CI / tests were not run by the reviewer.

## Verdict: PASS

No BLOCKER or HIGH findings. Four MEDIUM/LOW items below are recommended follow-ups, none block.

## Findings

### MEDIUM-1: touch target reduced from 40px to 36px

`globals.css` `segment` and `link-action` use `min-height: 2.25rem` (36px); the replaced controls were `min-h-10` (40px) and `Button md` is `min-h-11` (44px). Still above WCAG 2.2 AA 2.5.8 (24px) but a regression against the prior app baseline, and the spec asks for accessible touch targets on shared/wall devices. The pill sits inside a track with 0.25rem padding and gap, so spacing is adequate.
Remediation: raise to `2.5rem` (or 2.75rem on `pointer: coarse`) for both utilities.

### MEDIUM-2: chore-schedule-widget toggles (`aria-pressed`) rely on fill tint alone

`apps/web/src/components/chores/chore-schedule-widget.tsx` ~L291-293 and ~L478-481: pressed = `bg-accent text-on-accent`, unpressed = `bg-accent-subtle text-accent-fg`, both `font-semibold`. Before there was a weight-free but underline-vs-fill difference; now the only visual difference is colour (fill luminance). `aria-pressed` covers assistive tech, but sighted colour-blind users have a weak cue (WCAG 1.4.1). Also no forced-colors fallback for these two (they are not `segment`).
Remediation: reuse `segment` with `aria-pressed` selector support, or add a non-colour cue (weight 500 vs 600, check icon, or border) plus forced-colors Highlight.

### LOW-1: non-colour current-state cue in `segment` is weak

`globals.css` `segment[aria-current="page"]`: only font-weight 500 to 600 plus fill. Fill contrast against the page track is carried by the solid accent (a very light accent is allowed to have low fill contrast against surfaces per `accent.ts` comment; `accentEdge` exists for this). In a light-accent theme the pill may be hard to distinguish from the track by shape.
Remediation: add `border: 1px solid var(--color-accent-edge)` (or box-shadow inset) on the current segment. Forced-colors case is handled correctly (Highlight/HighlightText).

### LOW-2: `link-action` and `segment` lack explicit forced-colors border

Unselected `segment` and all `link-action` pills have no border; in forced-colors mode background tints are removed, so `link-action` links render as plain LinkText with no underline (`text-decoration-line: none`), losing the link affordance outside colour. Browser LinkText colour usually differs from ButtonText, but it is colour only.
Remediation: inside `@media (forced-colors: active)` add `border: 1px solid ButtonText` (or restore underline) to `link-action`.

## Checks

- aria-current: all switchers (calendar, chore calendar, tasks calendar, TaskViewSwitch, goals, leaderboard) set `aria-current="page"` on the current link; the utility styles off that attribute, so style and semantics cannot drift. Hover vs current ordering is correct (current rule comes later, same specificity).
- Contrast: `on-accent` on `accent` is guaranteed 4.5:1 by `deriveAccent` (accent.ts L56-58). `accent-fg` is derived against surfaces plus `accentSubtle` (accent.ts L71), so `link-action` and the unpressed chore buttons pass. `fg-muted` on `--color-page` and `fg` on `accent-subtle` (hover) are neutral tokens documented as 4.5:1 on the page surfaces (scale.ts); not recomputed numerically by me.
- Forced-colors: current segment handled (Highlight). See LOW-2 for the rest.
- RTL: `padding-inline`, `inline-flex`, `gap` only; no physical left/right. Pass.
- E2E: no spec under `tests/e2e` references the removed classes, underline styling, or the `min-h-10` utilities; the `data-testid`s (`calendar-view-*`, `goals-view-*`, `task-view-switch`) are retained. `shell.spec.ts` L178-183 asserts font-weight 600 on the sidebar link, unrelated to these files.
- Leftover underline-styled controls in changed files: none are switcher controls. Remaining `underline` uses are entry/title text links with `hover:underline` (calendar-view L329, L534; task-calendar L210, L300, L449; chore-calendar-board) and the "+N more" link at calendar-view L668 (inline in a month cell, intentionally text-style). Unchanged `event-preview.tsx` L396 still uses `text-accent-fg underline` (outside this diff; consider migrating for consistency).
- `link-action` in dashboard widgets: every use in `widget-content.tsx` (L107, 242, 296, 349, 436, 615, 720) is a standalone link in its own `<p>`/`<li>`/EmptyState action, not inline within a sentence. Appropriate. Pill with `white-space: nowrap` could overflow in very narrow widgets with long translated labels (nl); `flex-wrap` parents mitigate for most, EmptyState action less so.
- Dead code: `cx` imports removed where unused (chore-calendar-page, task-view-switch); still used in calendar-view and task-calendar. `navLink`/`linkClass` constants kept as thin aliases; fine.
- Leaderboard `<nav className="segmented">` places Links directly under the nav (no list); acceptable but differs from the other switchers' `<ul>` pattern.

## Remaining risks / test gaps

- No visual/axe test covers `segmented` in dark mode, with extreme accents (very light/dark), or forced-colors emulation; recommend a Playwright check with `forcedColors: 'active'` and an axe run on a switcher page.
- Touch-target sizes not asserted by any test.
- Long nl/other-locale labels not tested for wrapping inside `.segmented` (wraps via flex-wrap but pill radius on a wrapped track may look odd).
