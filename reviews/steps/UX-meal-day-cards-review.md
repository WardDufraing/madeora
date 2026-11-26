# Independent review: UX meal day cards (feat/ui-meal-day-cards)

Diff: `git diff origin/main`, single file `apps/web/src/components/meals/meal-planner.tsx` (4 lines of class changes plus a `cx` wrapper).

## Verdict: PASS

No BLOCKER or HIGH findings.

## Findings

- **LOW** `meal-planner.tsx:178-181`: `p-widget-padding` is 1.5rem on wide screens and 1.25rem at the compact breakpoint (`tokens.css:20,218`), up from 1rem. At 320px width in day view, the card content width shrinks by 16-32px. The `<bdi>` slot names, recipe links and the `flex-wrap` heading should still wrap, but a visual check at 320px is advisable (not run here). Remediation: none required; confirm in the manual visual pass.
- **LOW** `meal-planner.tsx:180`: in `forced-colors: active`, borders are forced to system colours and `shadow-raised` is dropped, so the today border emphasis disappears. Today is still signalled by the "Today" badge text (line 189-193), so nothing is lost. Remediation: optional `forced-colors:` border override; not needed.
- **LOW** `meal-planner.tsx:279-281`: `last:pb-0` and `first:pt-0` on `li` are correct with `divide-y` (divider is `border-top` on every non-first child). With a single slot there is no divider. Hidden or disabled slots do not render extra `li` elements. No issue; noted for completeness.

## Explicit checks

- **Requirements**: purely visual. Tokens `shadow-raised`, `p-widget-padding`, `border-accent-edge`, `border-line` and `divide-line` all exist in `packages/design-tokens/tailwind.css` and `tokens.css`. The product specification is untouched. No behaviour, data or API change.
- **Accessibility, contrast**: `accentEdge` is derived by `towardsContrast` to reach at least 3:1 (CONTRAST.ui) on every page surface, and this is tested in `packages/design-tokens/src/accent.test.ts:49`. That covers light/dark surfaces and light personal accents. `border-accent-edge` is already used the same way on other cards (chores, notifications, bulk actions). A 3:1 minimum meets WCAG 1.4.11 for the border. `divide-line` (#e4e8ea) is decorative, since rows are separated by spacing and headings, so the lower contrast is acceptable and unchanged from the previous `border-line`.
- **Today not by colour alone**: the Today badge text is retained, and the heading plus section label provide semantics. The border is only reinforcement.
- **Forced colors**: see the LOW finding. Borders still render in forced colours, and the badge carries the signal.
- **RTL**: only symmetric utilities (`p-`, `border`, `divide-y`) are used. No physical left/right classes.
- **Focus rings**: not affected. No overflow clipping was added, so link focus outlines inside the card remain visible, and the card has no `overflow-hidden`.
- **E2E selectors**: `tests/e2e/specs/meal-planner.spec.ts:50-53` uses `[data-testid^="meal-day-"]` plus a "Today" text filter. The `data-testid` and `aria-labelledby` are unchanged, and no test depends on class names or borders.
- **Nesting and structure**: `section` > `h2` + `ul` > `li` is unchanged. `SlotRow` still renders `li`, so the `divide-y` child selector applies directly.
- **Performance**: static class strings only. `cx` is already used in the file. The ternary adds no cost. All class names are literal, so Tailwind extraction picks them up.
- **Maintainability**: the conditional border is minimal and readable. `divide-y` replaces the per-row `border-t first:border-t-0 pt-2` logic, which removes duplication.
- **Security, permissions, cross-Home isolation, input validation, migrations, secrets**: not applicable, since there are no data or logic changes.
- **Test coverage**: no unit test is added. This is a class-only styling change and the existing e2e tests exercise the same selectors. A visual regression test is not in the project's scope.

## Remaining risks and test gaps

- No visual verification at 320px, in dark mode or with a light personal accent was performed (inspection only, per instructions).
- E2E was not run, by instruction.
