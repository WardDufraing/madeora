# UX6 independent review: Shopping redesign (decisions 68-71)

Branch: feat/redesign-shopping. Scope reviewed: diff of quick-add.tsx, shopping-list-page.tsx, shopping-list-switcher.tsx (new), shopping-list-view.tsx, shopping.test.tsx, en/nl messages, UX6-brief. Static review only; tests not run.

## Verdict: PASS

No BLOCKER or HIGH findings. UI-only: no API, RLS, schema or permission change. The Personal/Home context is passed through unchanged. The added `listShoppingLists` call uses the user-session client and RPC, so RLS applies. Rights still come from `shoppingRights(list)`. Additional MEDIUM and LOW findings below should be addressed or consciously deferred.

## Checks

- Requirements: switcher (chips/picker, + New list), optional details, lingering then collapsed Completed with count, text cues, Undo: met. Not done and declared in the brief: ungrouped/grouped toggle (decision 68), which is a gap against "allow users to switch to simple ungrouped list".
- Cross-Home isolation / permissions: unchanged. Undo is gated by `rights.check`. Quick-add by `rights.edit`.
- Secrets / input validation: quantity and unit are validated client-side with the shared parser. The server still validates (strict schemas); no trust added.
- Migration safety: none.
- i18n: all new keys exist in en and nl (switcher*, progress, doneLabel, quickAdd*Details). Reused keys (fieldInvalidQuantity, fieldUnitNeedsQuantity, uncheckItem, undo, unitNone) exist in both locales.
- Timers/state: cleanup on unmount present; `stopLingering` uses refs and functional setState, so no stale-closure bug in the timeout.

## Findings

### MEDIUM

1. shopping-list-view.tsx (toggle ~L111-126, CompletedSection `<details>` ~L490): focus is lost when the item leaves the active list. The linger timer unmounts the row (and the focused checkbox/Undo) and mounts it inside a collapsed `<details>`. Focus falls to `<body>`. Decision 70 and 69 require preserving focus and scroll while tapping through. Keyboard and screen-reader users lose their place after every check. Remediation: when the lingering row unmounts and it held focus, move focus to the next active row's checkbox (or the quick-add field/list heading when none). Add a test.
2. shopping-list-view.tsx (timer started in `toggle`, ~L112): the linger starts at click, before the server answer, and a refused/failed check is only reverted via `onRevert`. The linger is only 1.5 s, and Undo/checkbox are disabled until the answer (`completedAt === null`) arrives. On a slow network the user cannot undo, and the row may move into Completed (its row there has no `seenCompletedAt` from the answer, so a reopen sends the item's older null `completedAt`, which can end in `reopenConflict`). Remediation: start the timer from the answer (onSuccess) or keep the row lingering while `complete.busy`; pass the answer's `completedAt` through to Completed rows.
3. shopping-list-view.tsx (ItemRow disabled logic ~L291-298, L476): if the completion answer has `completedAt: null` (outcome "unchanged" where the item was meanwhile reopened, or the answer is null) the checkbox and Undo stay disabled until the row moves out; the user sees a done row they cannot undo. Remediation: fall back to `item.completedAt`, or enable the control and let the server's seenCompletedAt check arbitrate.
4. quick-add.tsx (details state): quantity, unit and category persist in state while the Details disclosure is closed but are silently not sent (`if (details)`). A remembered category the user cannot see is applied to nothing, which is confusing, and the "kept for the next item" promise is invisible. Also a stale `categoryId` (category deleted by another member via live refresh) is sent and fails server-side as "invalid" with a generic error. Remediation: send the extras regardless of disclosure, or reset them on collapse; validate `categoryId` against the current `categories` prop before sending.

### LOW

5. quick-add.tsx L47: `useShoppingTexts({ byId: new Map(), selfId: null })` is a hack to obtain `unit()` (new Map every render, shape coupling to `MemberNames`). Remediation: export a `useUnitLabel` hook or reuse the unit key map.
6. quick-add.tsx: `quantityError` is not cleared when the quantity or unit changes, so the error persists after correcting input until the next submit. Clear on change; link via `aria-describedby` (confirm TextField does this for `error`).
7. shopping-list-switcher.tsx L271-281: labels such as "Groceries #2 (3)" put counts in the accessible name; screen readers read "Groceries (3)" ambiguously. Remediation: add visually distinct count with `sr-only` text ("3 left") or use an `aria-label`. `#index` is positional and shifts when lists are reordered.
8. shopping-list-switcher.tsx / page: when the current list is archived or absent from the non-archived list, no chip is active (picker shows `label`). Add the current list to the items as a fallback. A second RPC per page render duplicates data work with the overview; acceptable.
9. shopping-list-page.tsx L63-66: the workspace line duplicates the back-link and PageHeader context partly; "Home name" without a Personal/Home label may be unclear. Low impact.
10. Switcher picker mode: `+ New list` sits beside the picker rather than inside it (acceptable per decision 71, still discoverable).
11. Reduced motion: no animation is added, so nothing to honour; line-through plus "Done" text plus sr-only prefix is a sound non-colour cue. Note the row has the "Done" cue twice for screen readers (sr-only prefix and visible text), which is verbose. Drop one.
12. Page-level progress text: "{remaining} of {total} left to buy" counts completed items in total; fine, but it lacks a plural/ICU form for nl "Nog 1 van 1 te kopen" (acceptable).

## Test gaps

- No test for Undo on a lingering row, i.e. the `seenCompletedAt` from the answer being sent on reopen (the core semantic called out in the brief).
- No test for failure/refusal during linger (revert clears timer), timer cleanup on unmount, or re-check during linger. The linger test uses real time (1.5 s + 3 s timeout); prefer fake timers to keep the suite fast and deterministic.
- No nl rendering test of new keys, no axe check on the switcher, picker mode (>5 lists / narrow) or the opened Details panel, no test that Undo is hidden without `rights.check`.
- No test for the duplicate "Add anyway" path retaining details.
- ShoppingListPage composition (switcher failure fallback) is untested.

## Remaining risks

Focus handling (item 1) and slow-network undo (item 2) are the main usability risks for in-store use. No security risk found.
