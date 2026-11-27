# Independent review: UX goal cards (feat/ui-goal-cards)

Diff reviewed: `git diff origin/main...HEAD` (1 file, 2 lines). Read-only review; no source edited.

## Verdict: PASS

No BLOCKER or HIGH findings. One LOW observation and one LOW test-gap note.

## Change

`apps/web/src/components/goals/goals-view.tsx` (`GoalCard` line 204, `SeriesCard` line 242): `p-4` becomes `p-widget-padding` and `shadow-raised` is added. Class-only; no markup, logic, data or copy changes.

## Findings

### LOW

1. **No automated visual or class assertion.** `goals.test.tsx` and the e2e specs query the cards by `data-testid` and text only, so a regression to the old classes would not be caught. Consistent with how the sibling card changes were handled (shopping, chores, meals); acceptable for a class-only change.
2. **Card padding grows on narrow screens.** Before, 16px everywhere. Now `--md-space-widget-padding` is 1.5rem (24px) and 1.25rem (20px) at max-width 40rem (`packages/design-tokens/tokens.css:20,218`). Intended and token-driven, no action needed.

## Explicit checks

- **Consistency:** the new class string matches the sibling cards exactly (`rounded-card border border-line bg-surface p-widget-padding shadow-raised`): `shopping-list-view.tsx:191`, `chores-overview.tsx:351`, `ui/card.tsx:38`, `meal-planner.tsx:179`. Both goal cards are updated together, so the goal list and series list stay consistent.
- **Grid at md:grid-cols-2:** unchanged (`grid gap-3 md:grid-cols-2`). Cards remain `h-full` inside `li`, so row heights still equalise. The shadow is 0 1px 2px with no spread, so it is not clipped by the 12px gap. Titles are wrapped in `<bdi>`; there is no fixed width, so longer padding only reduces text width slightly.
- **320px:** content width is about 320 - 2x16 gutter = 288px, minus 2px border and 2x20px padding = about 246px for text. Titles and the status row use `flex-wrap`, and the grid is a single column below `md`, so there is no overflow risk beyond what long unbroken titles already had (not introduced here).
- **Forced-colors:** the border (`border-line`) stays and is forced to a system color, so card boundaries remain visible when box shadows are removed by the UA. `bg-surface` is overridden by the UA. Nothing relies on the shadow to convey information. No `forced-colors:` variant is needed.
- **Dark and light themes:** `--md-shadow-raised` is defined for light (`tokens.css:93`) and dark (`:143`, `:192`); it is a semantic token, no hardcoded colors.
- **Accessibility:** no change to semantics. `article` with `aria-labelledby`, h2/h3 heading links, focus outlines are unaffected. The shadow is decorative. The link has no new overlay or hit-area change. Contrast is unchanged (same `bg-surface`, `text-fg`, `text-fg-muted`).
- **Motion and performance:** no animation or transitions added; a static box shadow is negligible.
- **Tests:** no test relies on `p-4`; the e2e `goal-card` and `goal-series-card` test ids are unchanged. I did not run the suite in this review.
- **Security, tenant isolation, permissions, secrets, input validation, migrations:** not affected (class-only change; no data, auth or SQL touched).
- **Product specification:** `docs/product/` untouched.

## Remaining risks and test gaps

- No visual regression coverage for the card styling.
- Local CI commands (prettier, lint, typecheck, test, build) were not executed by this reviewer; rely on the PR's CI result.
