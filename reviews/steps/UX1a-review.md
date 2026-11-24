# UX1a independent review

Verdict: PASS (BLOCKER 0, HIGH 0, MEDIUM 3, LOW 3)

Checked: tokens (depth, radius, spacing, motion, canvas, priority, reduced-motion zeroing), Card/Button/fields, Dialog/CreateDialog/Popover/OverflowMenu/AdaptiveSwitcher, shadow-card rename (no remaining uses in apps/ or packages/), Dialog consumers, tests (ran `vitest run src/components/ui`: 82 passed). No product behaviour, data, permission or dependency change found in UX1a files.

## MEDIUM

1. create-dialog.tsx:~83 (Cancel button `onClick={onClose}`): Cancel bypasses the `dirty` guard, so typed input is discarded silently via Cancel while the close button and Escape ask first. Inconsistent with the unsaved-changes decision. Remediation: route Cancel through the Dialog's request-close (e.g. expose a `requestClose` through context/render prop, or have CreateDialog handle dirty itself) and add a test "Cancel with input asks first" (create-dialog.test.tsx:87 only covers the clean case).
2. adaptive-switcher.tsx:~118 / popover.tsx trigger `aria-label={label}`: the picker trigger shows the selected item's name, but its accessible name is the static `pickerLabel`, so the visible text is not in the accessible name (WCAG 2.5.3 Label in Name; voice-control users saying the visible name fail). Remediation: let Popover take an optional accessible name that includes the visible text (e.g. `${pickerLabel}: ${selected.label}`) or use `aria-labelledby` pointing at hidden label plus the visible span.
3. overflow-menu.tsx onMenuKeyDown: with zero enabled items `list.length` is 0 and `% 0` gives NaN (harmless as `undefined`, but focus then stays on the menu container with no way to move). Also no typeahead. Remediation: guard `list.length === 0`; typeahead optional.

## LOW

1. popover.tsx useEffect(open) focuses the first control; the panel `role="dialog"` is non-modal with `aria-haspopup="dialog"`, acceptable, but Tab out is only detected via `relatedTarget`; focus leaving to the document (null relatedTarget, e.g. window blur) keeps it open. Acceptable; note for UX3 when calendar preview reuses it.
2. popover.tsx / overflow-menu.tsx: absolute positioning with no collision handling; a menu near the viewport edge or inside an `overflow-hidden` widget (WidgetFrame has `overflow-hidden`) will be clipped. This matters for UX2a widget-header menus. Remediation: render in a portal or the top layer (`popover` attribute) in UX2a.
3. Branch diff vs local `main` also contains unrelated commits (Google Calendar syncNotStarted, trigger-project-ref, many docs commits). These appear to be commits already merged upstream (local main is behind), not UX1a edits; confirm the PR is opened against current `origin/main` so the PR diff only contains UX1a.

## Notes (no action)

- Dialog: focus return to opener, StrictMode handling, alertdialog focus on "Keep editing", reset of `confirming` on reopen are correct. `discardPrompt` optional with `dirty`: if omitted the guard silently does nothing (type-level coupling would be safer; LOW-ish).
- Motion tokens zero under reduced motion; animations and press-feedback read them. Canvas is page-background only. Priority tokens alias status tones; colour is not the sole cue in AdaptiveSwitcher (check icon plus aria-pressed).
- Tokens-only colours respected in new components; no suppressions or new deps observed.

## Remaining risks

- No visual baseline or browser-level focus/axe test of side drawer and sheet sizes (jsdom only).
- Popover/menu clipping inside overflow-hidden containers (see LOW 2).

## Resolution (author)

MEDIUM 1 fixed (Cancel now uses the guarded close, test added). MEDIUM 2 fixed (picker trigger name includes the selected item). MEDIUM 3 fixed (guard for no enabled items). LOW 1–2 deferred to UX2a/UX3 (portal/top layer when a menu sits in an `overflow-hidden` widget). LOW 3: PR is opened against current `origin/main`.
