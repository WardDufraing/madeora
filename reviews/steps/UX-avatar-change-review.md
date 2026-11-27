# Independent review: UX avatar change (feat/ui-avatar-change)

Verdict: PASS

Scope reviewed: `git diff origin/main` (avatar-setting.tsx, storage.test.tsx), usages in settings and Home profile pages, tests/e2e/specs/storage.spec.ts, Button component. Inspection only; no e2e or unit run by the reviewer.

## Findings

- LOW, avatar-setting.tsx (disabled while busy): the "Choose a picture" button is `disabled` during upload/clear. A disabled button drops keyboard focus to the document body, so keyboard users lose their place after picking a file. The old file input had the same behaviour, so it is not a regression. Remediation (optional): use `aria-disabled` plus a guarded click, or move focus to the status alert when busy ends.
- LOW, avatar-setting.tsx (input): `aria-hidden="true"` together with `aria-label` is redundant, because hidden elements have no accessible name. The `aria-label` is only there so `getByLabel` / `getByLabelText` keep working. Add a one-line comment saying so, to stop a later cleanup from breaking the tests.
- LOW, avatar-setting.tsx: `useId` still names `inputId`, which is no longer referenced by a label. Harmless.
- LOW, unit test: it asserts a click event reaches the input, not that the picker opens, and it does not cover the disabled state or the uploads-off removal branch. Line 223 of storage.test.tsx already covers removal being available when uploads are off.

No BLOCKER, HIGH or MEDIUM findings.

## Explicit checks

- Accessibility, axe `aria-hidden-focus`: passes. A `tabindex="-1"` element counts as focusable but not tabbable (rule check `focusable-not-tabbable`), and the input is also `disabled` before hydration and while busy. Axe skips aria-hidden subtrees for the `label` rule, so no violation is expected. The e2e suite runs `axeViolations` after the avatar flow, so CI will confirm.
- Keyboard and screen reader: a native `<button>` gives Enter and Space activation. The sr-only input is removed from both the tab order and the accessibility tree, so there is no duplicate "Choose a picture" control. The button keeps its description through `aria-describedby={hintId}`. Status messages (`FormAlert announce`) are untouched and still announced.
- Programmatic `input.click()`: works in Safari and iOS because it runs inside a user-gesture click handler and the input is `sr-only`, not `display:none`. A disabled input ignores `click()`, but the button's disabled state uses the same expression (`!hydrated || busy !== null`), so the two cannot drift.
- Disabled and busy sync: identical conditions on the button, the input and the clear button. The clear button keeps `loading` on its own action.
- Uploads-off branch: removal is still offered through the shared `clearButton` when `currentFileId` is set. It is hidden when there is no picture, which matches the old behaviour.
- Home scope: `AvatarSetting` is used in `settings/page.tsx` (global) and `homes/[homeId]/profile/page.tsx` (home). The change is within the component, so both pick it up. The label text is "Use global picture" for home scope.
- e2e `storage.spec.ts` `choosePicture`: `getByTestId(avatar-setting-*).getByLabel("Choose a picture")` resolves only to the input. Playwright `getByLabel` matches `<label>` association, `aria-labelledby` and the `aria-label` attribute, not button text. The button has no aria-label or labelledby, so strict mode sees one element. `setInputFiles` does not need visibility, so the sr-only aria-hidden input works.
- Unit tests: the existing `getByLabelText("Choose a picture")` uploads still resolve to the input (Testing Library does not filter aria-hidden). The new `getByRole("button", ...)` is unique because the hidden input is excluded from roles.
- i18n: no new strings; it reuses `avatarChoose`, `avatarRemove` and `avatarUseGlobal`.
- Forced-colors and RTL: the button uses the existing Button styles (border for secondary; the ghost variant has no border, the same as other ghost buttons). `flex-wrap` and logical layout hold up in RTL. `sr-only` is position-based and is not affected.
- 320px wrap: `flex flex-wrap gap-3` wraps the two buttons. The button has `whitespace-nowrap`, but the labels are short.
- Privacy and security: the upload flow (`run`, `uploadAvatar`, `clearAvatar`, server checks, input reset after a run) is unchanged. No new endpoints, permissions or data handling.
- Maintainability and performance: the shared `clearButton` removes duplication; no new dependencies.

## Remaining risks and test gaps

- No assertion that the visible button follows the disabled state. A manual 320px, RTL and forced-colors visual check is advised.
- Real-browser picker opening on iOS Safari is not automated; it relies on standard behaviour.
