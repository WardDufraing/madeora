# UX review: chore pool restyle

- **Branch:** `feat/ui-chore-pool`
- **Reviewer:** independent review agent with fresh context. Input: `git diff origin/main...HEAD` (one file, 5 lines changed) and the neighbouring components.
- **Verdict:** **PASS**
- This is an AI review. It is not a GitHub human code-review approval.

## Scope

Class-only change in `apps/web/src/components/chores/chore-pool.tsx`: `shadow-raised` on the filter details, the two empty-state paragraphs and the day list cards; `p-3` becomes `p-4` on the details and paragraphs; row padding `p-3` becomes `px-4 py-3`.

## Findings

| ID  | Severity | Finding                                                                                                                                                                                                                                                                                                                                                      | Remediation                                                                                                                   |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| L1  | LOW      | The `ul` has `rounded-card` but no `overflow-hidden`. When the first or last row is today, its square `bg-accent-subtle` corners can show against the rounded inner border edge (about 13px radius). This was already the case before the diff. The shadow does not change it, because it is only `0 1px 2px` and sits outside the border. Not a regression. | Optional follow-up: `overflow-hidden` on the `ul`. Check that the focus ring on the row links is not clipped before doing so. |
| L2  | LOW      | `chores-overview.tsx` uses `p-widget-padding` for its cards. The pool uses literal `p-4`. If the token is 16px they match; a later token change would drift.                                                                                                                                                                                                 | Prefer `p-widget-padding` on the details and paragraphs. `card.tsx` and the overview already use it. Not blocking.            |

## Checks

- **Requirements:** class-only restyle; no behaviour, data, copy or markup change.
- **Consistency:** `shadow-raised` with `rounded-card border border-line bg-surface` is the same recipe as `ui/card.tsx`, the overview widgets and `task-list.tsx`. Applied uniformly to every card-like surface in the pool.
- **Depth is not the only cue:** the `border-line` border is kept on every card, so forced-colors mode (where `box-shadow` is dropped) still shows card edges.
- **Forced colors:** the today row's `bg-accent-subtle` is removed in forced-colors mode. This was already the case before the diff. The row still carries the day group heading and its own text. Other components add a `forced-colors:border-[Highlight]` cue (for example `task-list.tsx`). Optional consistency follow-up, not a regression.
- **320px width:** `px-4` costs 8px more horizontal space per row than before. Rows are `flex-wrap` with `min-w-0` on the text block, so content wraps rather than overflows. No fixed widths are added.
- **Today highlight inside the shadowed card:** see L1. Visually fine in the middle of the list.
- **Accessibility:** no change to semantics, focus order or names. Row padding is larger, so touch targets are no smaller. The shadow is non-essential decoration.
- **Dark mode:** the raised shadow token is defined for light and both dark selectors in `packages/design-tokens/tokens.css`.
- **Tests:** no existing test in `chore-pool.test.tsx` asserts on these classes, so none need updating. A class-only change warrants no new test.
- **Security, isolation, migrations, performance:** not affected. No dependencies added. The product specification is unchanged.

## Remaining risks and test gaps

- No visual or screenshot check was run by this review. 320px and forced-colors conclusions are from reading the classes.
- L1 and L2 are optional polish.
