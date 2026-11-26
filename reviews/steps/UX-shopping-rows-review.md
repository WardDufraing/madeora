# Independent review: feat/ui-shopping-rows

Verdict: PASS

Scope: one file, `apps/web/src/components/shopping/shopping-list-view.tsx`, className-only changes (group wrapper, `<ul>`, `ItemRow` `<li>`). No logic, data, auth or i18n change.

## Findings

- LOW, shopping-list-view.tsx:191: The group card repeats the class string of `components/ui/card.tsx` (`rounded-card border border-line bg-surface p-widget-padding shadow-raised`, minus `text-fg`) instead of reusing `Card`. Impact: drift risk only. Remediation: optional follow-up to use `Card`, or leave. Note `text-fg` is not set, so row text relies on the explicit `text-fg` on item spans (already present); no visible effect.
- LOW, shopping-list-view.tsx:621: The completed-items row (`shopping-completed-item`) keeps `px-3 py-2` and no divider, and the completed section is not a card. Impact: slight visual inconsistency with the new active cards; not a defect. Remediation: decide in a later UX step.
- LOW (test gap): no test asserts the visual structure, which is acceptable for a styling change. The existing RTL tests and `tests/e2e/specs/shopping.spec.ts` select by `data-testid` (`shopping-item`, `shopping-item-check`, `shopping-item-edit` and similar) and by text. These are untouched, so selectors are unaffected.

No BLOCKER, HIGH or MEDIUM findings.

## Explicit checks

- Requirements: styling only, within approved frontend strategy B (Tailwind, custom components). Tokens `rounded-card`, `border-line`, `bg-surface`, `p-widget-padding` and `shadow-raised` already exist and are used by `Card`. `divide-line` is used elsewhere in chores. Product spec not touched.
- Card-in-card nesting: `ItemRow` is used only in `shopping-list-view.tsx`, in the active group `<ul>`. The widget body, overview, Ora and the item editor/transfer/repeat components do not render `ItemRow`; the matches there are only `shopping-item-*` test ids or name references. The completed section is a separate `<section>` using its own row component. Item editing is a separate panel. No nested card.
- E2E selectors: `data-testid` values (`shopping-item`, `shopping-active-items`, `data-item-name`) are preserved. `meal-planner.spec.ts` also matches by test id only. Specs not run, as instructed.
- Accessibility, contrast: `border-line` on `bg-surface` is the same pairing used by every Card and by the previous row borders. Dividers are decorative; state is not conveyed by them. Item text colors unchanged.
- Focus ring clipping: the card has no `overflow-hidden`. `first:pt-0` and `last:pb-0` keep content at the card's padding edge (`p-widget-padding`), so buttons and checkbox focus rings (offset a few px) have the padding as room. No clipping risk. The `<ul>` has no `overflow` either.
- Forced-colors: borders and dividers use real `border`/`divide` colors, which map to system colors in forced-colors mode. The card edge relies on the border, not the shadow, so it stays visible.
- RTL: only logical or symmetric utilities (`p-*`, `divide-y`, `first:`/`last:`). Nothing physical added.
- 320px: the row stays `flex-wrap`, the name block is `min-w-0 flex-1`, and the card adds only widget padding horizontally (the previous rows used `px-3` plus a border, so the net width is about the same). Wrapped controls stay inside the card. No horizontal overflow introduced.
- Semantics: `<ul>`/`<li>` kept. `divide-y` is CSS only. The category `<h3>` now sits inside the card above the list; the heading order is unchanged.
- Performance: no runtime change. `shadow-raised` per group is cheap; group count is small.
- Maintainability: smaller row classes, the separation logic is in the parent `<ul>`. The `first:`/`last:` padding resets on the `<li>` couple the row to being rendered inside a divided list, which is worth knowing if `ItemRow` is ever reused elsewhere.
- Security, cross-Home isolation, permissions, secrets, input validation, migrations: not affected.

## Remaining risks

Visual result not verified in a browser by this review (inspection only); a quick screenshot check at 320px, dark mode and forced-colors before merge is advisable.
