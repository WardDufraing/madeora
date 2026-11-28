# UX child sign-in tile restyle: independent review

- **Branch:** `feat/ui-child-sign-in` (commit `e3fc177`) against `origin/main`.
- **Read:** the full diff (2 files, 5 lines changed, class names only), both components in full around the changed buttons, the existing uses of `rounded-card`, `shadow-raised` and `border-accent-edge` in other components, and the tests in `child-sign-in.test.tsx` and `shared-device.test.tsx`.
- **Not run:** no tests, build or browser were run. Findings come from reading the code.

**Verdict:** `PASS`

No BLOCKER or HIGH findings.

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

None.

### LOW

1. **Hover style also applies to disabled tiles.** `household-pin-sign-in.tsx` (child tiles) and the chore tiles in `household-chores.tsx` use `disabled={!hydrated}`. The new `hover:border-accent-edge hover:bg-accent-subtle` still shows on a disabled button before hydration. The old style had the same hover background, so this is not a regression. Remediation (optional): `enabled:hover:...`.
2. **Tile border uses `border-line`.** A tile boundary can fall under the 3:1 non-text contrast that WCAG 1.4.11 asks of a control boundary. `shadow-raised` and the text label carry the affordance, and the border was already `border-line` before this change. Other controls use `border-line-control`. Optional follow-up for the design-token owner, out of scope here.
3. **No test covers the restyle.** The changes are class-only, so existing behavior tests still apply. This is acceptable for a visual change. A visual or axe check in the Playwright smoke would be a nice-to-have.

## Explicit checks

- **Requirements and scope:** class-only. There are no logic, data, route or permission changes. The product specification is untouched. PASS.
- **Color is never the only identity cue:** the dot is `aria-hidden` and the child's name (`<bdi>{name}</bdi>`) is always rendered inside the same button. The button's accessible name is the name alone. The dot is not used as a key. React keys are `membershipId` and `occurrenceId`. Members with no accent color render a plain empty dot with the same name. Enlarging the dot from `size-4` to `size-6` does not change this. PASS.
- **Touch targets:** `min-h-14` (56px) is kept, with `w-full` and `py-3`. The tiles are larger than the 44px minimum. PASS.
- **Hover vs focus-visible:** hover changes the border and background. Focus uses a separate `outline-2 outline-offset-2 outline-focus` ring. They do not conflict, the outline is not a border, and the focus indicator stays visible when the border changes. PASS.
- **320px:** the grid is `grid-cols-1` below `sm`, with `px-4`, `gap-3`, a `shrink-0` dot and a name that can wrap. Nothing is fixed-width, so no horizontal overflow is expected. The extra 8px of the dot is negligible. PASS (by reading, not measured).
- **Forced colors:** shadows are dropped and the tile keeps its 1px border, which the system recolors. The dot loses its fill, which is harmless because it is decorative and the name is present. Hover and focus are visible through the border and outline. Other components add `forced-colors:` overrides only for selected states, and these tiles have no selected state. PASS.
- **Privacy on a shared device:** no new data is shown. The list of names and accent colors was already visible, and a larger dot does not reveal more. Selecting a name still grants nothing by itself, and the PIN flow is unchanged. PASS.
- **Tokens and consistency:** `rounded-card`, `shadow-raised` and `accent-edge` are already used by other components (`card.tsx`, `meal-planner.tsx`, `adaptive-switcher.tsx`). No new tokens or dependencies. PASS.
- **RTL and i18n:** `text-start`, `gap-3` and logical alignment are retained. No physical-direction classes were added. PASS.
- **Secrets, input validation, migrations, performance:** not applicable.
- **Maintainability:** the two files carry the same long class string. This is existing duplication and not worth abstracting in this change.

## Remaining risks and test gaps

- No visual regression or axe run was done for this change.
- Contrast of `border-accent-edge` on `bg-accent-subtle` was not measured in light and dark themes. The same pair is used elsewhere.
