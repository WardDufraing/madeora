# Independent review: UX empty-state medallion (feat/ui-empty-states)

Diff: `apps/web/src/components/ui/states.tsx`, `apps/web/src/components/ui/states.test.tsx`. Inspect only; e2e not run.

## Verdict: PASS

No BLOCKER or HIGH findings. Two LOW and two informational notes.

## Findings

### LOW-1: medallion lacks `shrink-0` (states.tsx, `medallion` const, line 16)

The circle is a flex item of a column flex container. Today the frame has no height constraint, so it cannot be squashed. If a caller ever gives the state a fixed height, the 48px circle could become an oval. Remediation: add `shrink-0` to the `medallion` classes.

### LOW-2: danger contrast is not covered by a token test (packages/design-tokens/src)

`accent-fg` on `accent-subtle` is asserted at 4.5:1 for every accent, in both themes, in `accent.test.ts` (it loops over `[...surfaces, t.accentSubtle]`), so personal accents are covered. `danger` on `danger-subtle` has no assertion. I computed it by hand:

| Pair                         | Ratio  |
| ---------------------------- | ------ |
| light `#b42318` on `#fbf2f1` | 5.97:1 |
| dark `#f97066` on `#342729`  | 5.13:1 |

Both clear 3:1 (non-text) and 4.5:1 (text). Remediation (optional, separate change): add a danger/danger-subtle assertion to `tokens.test.ts`.

### INFO-1: height growth in 2-row widgets

A 2-row widget is 2 x 88 + 20 = 196px tall. After the title bar and body padding, about 98px remains for content. The body is `min-h-0 flex-1 overflow-auto` (dashboard-grid.tsx:125), so overflow scrolls and never clips.

Growth is about +60px for EmptyState (48 circle + mb-1 + gap-2) and about +28px for ErrorState (the old icon was 24px). EmptyState already used `py-10` (80px of padding) plus title and description, and ErrorState used `py-8`. Both already exceeded 98px at 2 rows, so this is not a new overflow class, only more scroll distance.

Widgets with minH 2 that render a full EmptyState or ErrorState will scroll slightly more: the Tasks/Chores/Ora/Points/Photos widgets in `widget-content.tsx` and the per-module widget files. The compact and `hide` modes of `WidgetEmpty` do not use `EmptyState`, so they are unchanged. The `full` mode is the only one affected, and it is the intended friendly state.

Optional follow-up: let `EmptyState` take a compact prop that drops the medallion when the container is under about 3 rows. This is not blocking.

### INFO-2: card-in-card

`EmptyState` already drew its own bordered card (`rounded-card border border-line bg-page`) inside widgets. The medallion does not change that.

## Explicit checks

- **Tokens defined:** `bg-danger-subtle`, `text-danger`, `bg-accent-subtle`, `text-accent-fg` and `rounded-pill` all exist in `packages/design-tokens/tailwind.css` and `tokens.css` (light and dark, and the follow-the-system block).
- **Contrast:** see LOW-2 and the accent test above. The icon is decorative; both pairs are well above 3:1.
- **Accessible names:** `createIcon` renders `aria-hidden` and `focusable=false` when no `title` is passed, and both usages pass none. The wrapper `<span>` has no text, so accessible names and descriptions are unchanged. `role="alert"` on `ErrorState` is unaffected.
- **Selectors:** no e2e spec or unit test depends on the icon being the first child. The only `svg` queries are in `states.test.tsx` (the loading state, and the new test). `widget-empty.test.tsx` does not query the icon.
- **Forced colours:** the icon uses `stroke="currentColor"`, which maps to a system text colour. The circle background is removed, which is harmless because it carries no information. The shape difference (info versus error) distinguishes the states without colour.
- **RTL:** the layout is centred and symmetric, with no directional classes.
- **Reduced motion:** no animation or transition was added.
- **Test:** meaningful (aria-hidden on both, distinct shapes, medallion classes). It asserts class names, which is slightly implementation-coupled, but it is acceptable for a purely visual change.
- **Maintainability:** a small shared `medallion` constant, with a clear comment. Minor inconsistency: `mb-1` on top of `gap-2`. Consider `gap-3` or a single spacing mechanism.

## Remaining risks and test gaps

- No visual or e2e check of 2-row widgets with the full empty state (not run, by instruction).
- No automated check of danger/danger-subtle contrast (LOW-2).
