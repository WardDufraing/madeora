# Independent review: UX touch targets (feat/ui-touch-targets)

Diff reviewed: `git diff origin/main` (2 files: `apps/web/src/components/ui/button.tsx`, `button.test.tsx`). Inspection only; nothing was run.

## Verdict: PASS

No BLOCKER or HIGH findings. Two LOW/MEDIUM notes, neither blocking.

## Findings

### MEDIUM - Test proves class names only, not the 44px hit area

`apps/web/src/components/ui/button.test.tsx:10-17` asserts `min-h-9` and `after:-inset-y-1` strings. jsdom has no layout or hit-testing, so a typo in the pseudo-element utilities (for example `after:content-['']` dropped) would still partly pass. Remediation (optional, can be a follow-up): add one Playwright check that `document.elementFromPoint` 3px above a visible small button resolves to that button. Not blocking because the class contract is simple and Tailwind generates all three utilities used.

### LOW - Pseudo-element can add 4px of scrollable overflow at the bottom edge of scroll containers

`button.tsx:39`. An absolutely positioned child extending past the bottom of an `overflow-auto/y-auto` ancestor extends its scroll area. Checked every `overflow-*` ancestor in `apps/web/src`: dashboard widget body (`dashboard-grid.tsx:125`, has `pb-6`), dialog body (`dialog.tsx:158`, has panel padding), task panel, Ora assistant, mobile nav and sidebar all keep padding at the end, and `adaptive-switcher.tsx` list rows are plain `<button>`s, not this component. `overflow-hidden` ancestors are progress bars, covers and cards, none contain a `Button`. No clipping or scrollbar regression found. Remediation: none; keep padding below a small button when it is the last child of a scroller.

### LOW - Hit areas of vertically adjacent small buttons touch exactly at 4px gaps

Stacks and wrapped rows use `gap-1` (4px) or `gap-2` (`mark-read-buttons.tsx:45`, `chore-schedule-widget.tsx:308-329`, `shopping-widget-settings.tsx:95-97`, `list-actions.tsx:144`, `shopping-list-view.tsx:355`). With a 4px extension per side, neighbouring tap areas meet at the midpoint at gap-1 and never overlap visible pixels. Gaps smaller than 4px (none found among `size="sm"` usages; `gap-0.5` is only used for chips and plain list rows) would let the later DOM sibling take taps in the overlap. Remediation: none now; consider a code comment that small buttons need at least 4px vertical spacing.

## Explicit checks

- Requirements: matches the stated change (36px visible, 44px tap area, no layout shift because the pseudo-element is absolute). `md` unchanged at `min-h-11`.
- Caller conflicts: no `size="sm"` caller passes `absolute`, `fixed`, `sticky`, `inset`, `z-*` or translate classes via `className`. `cx` is a plain joiner (no tailwind-merge), so a future caller passing `absolute` would lose to `relative` (Tailwind orders `relative` after `absolute`); none exist today. No separate Link-as-button helper exists (`grep` for `buttonClass` and exported size types found nothing outside `ui/button`).
- Focus ring: global `:focus-visible` outline is on the button border box and is unaffected by the transparent pseudo-element. Press feedback `transform: scale` scales the pseudo-element with the button, consistent.
- Forced-colors / RTL: pseudo-element has no background or border, so it is invisible in forced-colors; `inset-x-0` is symmetric, RTL-safe.
- axe: axe `target-size` measures the element box, not pseudo-elements; no change. jsdom axe test (`axeViolations`) unaffected.
- Disabled / loading: native `disabled` buttons and `aria-disabled` loading buttons both swallow clicks across the whole 44px area; opacity applies to the pseudo-element but it is transparent. Loading still ignores clicks via `handleClick`.
- E2E / Playwright: actionability hit-test is at the element centre, inside the button; the extension belongs to the button so interception checks pass. No specs in `tests/e2e/specs` use bounding-box geometry of small buttons (only width of sidebar/surface and a link box in `shell.spec.ts:152`, not a `Button`).
- Cross-Home isolation, permissions, secrets, input validation, migrations: not affected (presentational change only).
- Accessibility: improves pointer target size; no name/role/focus-order change.
- Performance / maintainability: negligible; one comment explains intent.

## Remaining risks and test gaps

- No real-browser hit-test of the extended area (see MEDIUM).
- Future tight vertical layouts below 4px gap would silently overlap hit areas.
