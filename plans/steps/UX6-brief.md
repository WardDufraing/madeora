# UX6: Shopping redesign

Source: `docs/design/dashboard-ux-ui-redesign.md` decisions 68–71, `plans/steps/UX00-redesign-plan-brief.md`. UI only; no API, RLS or migration change.

## Scope (done)

- **List switcher (71):** `ShoppingListSwitcher` on the list page uses the existing `AdaptiveSwitcher` (chips up to 5 lists, searchable picker above that or on narrow screens). Labels show items left; same-name lists get `#position`. Active state = check + `aria-pressed`. `+ New list` sits next to it (and stays in the empty overview). Personal/Home name shown above it. If the other lists cannot be read, the list still shows.
- **Inline quick-add (69):** the existing name field plus Add stays; a new "Add details" disclosure offers quantity, unit, and category (when the list has categories). Quantity parsed with `parseShoppingQuantity`; unit without quantity is refused client-side. Focus stays in the field after adding; duplicates still ask first.
- **Completed (70, 68):** a checked item stays in place for 1.5 s shown as done (muted, line-through, "✓ Done" text, Undo button), then moves to Completed. Completed is collapsed by default with its count in the summary. A remaining/total line sits above the list.

## Decisions / defaults

- Switching a list is a client navigation to that list's page (no new page type). The overview page is kept (archive, reorder).
- Undo of a lingering row uses the completion time from the server answer (reopen needs `seenCompletedAt`).
- Not done (no approved decision / out of scope): category grouping toggle (ungrouped option), contextual inline item editing (Decision 72 not approved).
- Touched i18n: `Shopping.*` en/nl only (6 new keys + switcher keys). No change to mobile-nav, sidebar, marketing doc, screens.ts.

## Files

`components/shopping/{shopping-list-switcher,quick-add,shopping-list-view,shopping-list-page}.tsx`, `shopping.test.tsx`, `i18n/messages/{en,nl}.json`.

## Tests (local)

prettier, eslint, tsc clean; vitest `components/shopping` 21 pass. Full suite on CI.

## Review

`reviews/steps/UX6-review.md`: PASS (0 BLOCKER/HIGH). Fixed MEDIUM: linger timer now starts after the server answer; Undo falls back to the item's own completion time. Deferred (documented): focus after a row moves into collapsed Completed, grouped/ungrouped toggle, LOW items.
