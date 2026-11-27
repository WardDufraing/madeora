# Independent review: feat/ui-wall-display

Verdict: PASS

Scope: `git diff origin/main...HEAD`, two files, className-only changes. No logic, data, auth, i18n or test change.

- `display-screen.tsx`: the unlock chip border `border-line` to `border-accent-edge` (line 565); `shadow-raised` on the widget `<section>` (line 614) and on the module view `<section>` (line 633).
- `display-widgets.tsx`: chore `<ul>` `gap-2` to `gap-3` (line 92); chore `<li>` `bg-surface` to `bg-page` (line 96).

## Findings

- MEDIUM, display-widgets.tsx:96: `bg-page` on a `bg-surface` card is a weak surface step, and the row border does not make up for it. Computed from `packages/design-tokens/src/neutral.ts`:

  | Pair                     | Light  | Dark   |
  | ------------------------ | ------ | ------ |
  | page vs surface          | 1.12:1 | 1.10:1 |
  | `line` vs row (`page`)   | 1.10:1 | 1.34:1 |
  | `line` vs card (surface) | 1.23:1 | 1.22:1 |

  Impact: the rows are distinguishable only as a faint tint plus a hairline border. In light mode the tint is barely visible on a wall tablet at distance. Text is not affected (`fg` on `page` is 16.0:1 light and 17.4:1 dark; `fg-muted` on `page` is 5.5:1 light and 7.7:1 dark, both above the 4.5:1 floor). There is no WCAG 1.4.11 failure, because the rows are not controls and carry no state; the row grouping is also given by spacing, order and the `ul`/`li` structure. The change is still low-contrast chrome. Remediation: accept as a visual choice, or use `bg-surface-sunken` (already used in `display-layout-preview.tsx:45`), or keep `bg-surface` with `border-line-control`, if the owner wants clearer rows on a display. This is not blocking.

- LOW, display-screen.tsx:565: `border-accent-edge` on `bg-accent-subtle` is an improvement. `accentEdge` is derived to reach 3:1 on every page surface (`packages/design-tokens/src/accent.ts:73`, tested in `accent.test.ts:49`), so the chip outline now meets 1.4.11. The chip text uses `text-fg` on `accent-subtle`, already tested at 4.5:1. The chip is not the only unlock signal (it has text and a countdown). No issue.
- LOW, display-screen.tsx:614 and 633, shadow in forced-colors: `shadow-raised` is a box-shadow, which forced-colors removes. The cards keep `border border-line`, which maps to a system colour in forced-colors, so the card edge stays visible. The nested chore rows keep their border too, and the `bg-page` vs `bg-surface` tint collapses to `Canvas`. Rows then read by border only. `globals.css:43` already drops the decorative background for `forced-colors` and `prefers-reduced-transparency`. No regression; the same pattern is used by `Card`, the shopping, chores and meals cards. Remediation: none.
- LOW, widget cards use `overflow-hidden`: an outer `box-shadow` is not clipped by the element's own overflow, only by an ancestor. The raised shadow is 1px offset and 2px blur, so a grid gap or the page padding is enough. Not verified in a browser.
- LOW (test gap): `display-screen.test.tsx` and `displays.test.tsx` select by `data-testid` (`display-chore-list`, `display-unlocked`, `display-view-*`) and by text. All testids are preserved, so existing tests are unaffected. No test asserts the classes, which is acceptable for a styling change. Tests were not run by this review.

## Explicit checks

- Requirements: styling only, within approved frontend strategy B (Tailwind, custom components) and the existing elevation role `raised` ("for widget cards", `scale.ts`). `docs/product/` is not touched; the diff touches two files under `apps/web`. The change adds no new tokens or dependencies.
- Privacy of the wall display: no data, props, fields or text change. The same chore title and due label are rendered. Nothing new is exposed to the display, and the ambient view is a separate early-return render (`display-screen.tsx:398`) that does not use these cards, so ambient/static-image persistence behaviour is unchanged.
- Cross-Home isolation, permissions, secrets, input validation, migrations: not affected.
- Contrast, light and dark: see the table. Text passes AA on `page` in both themes. Dark mode gets a slightly better row border contrast (1.34:1) than light (1.10:1).
- Forced-colors: borders carry the structure (see above). No colour is conveyed by shadow alone. Fine.
- Accessibility: semantics unchanged (`section` with `aria-label` or `aria-labelledby`, `ul`/`li`). `gap-3` slightly increases separation. Focus styles unchanged. No touch-target change; the rows are non-interactive.
- Wall-display and ambient impact: one cheap two-layer shadow per widget card and no blur filter, so no meaningful repaint cost on long-running tablets. A shadow is static, so there is no burn-in or animation concern. Compact mode (`p-3`) is unchanged.
- RTL: no physical utilities added. `text-start` is kept.
- Performance and maintainability: no runtime change. The widget card string still duplicates `Card` styling (pre-existing pattern).

## Remaining risks

- The visual result was not verified in a browser (inspection and computed contrast only). A screenshot check in light mode on a display-sized viewport, dark mode and forced-colors is advisable before merge.
- The MEDIUM about the `bg-page` row tint is a design decision for the owner.

## Follow-up

The MEDIUM finding was addressed: chore rows now use `bg-surface-sunken`.
