# Independent review: UX modules card grid (feat/ui-modules-card-grid)

Scope: `apps/web/src/components/shell/all-modules.tsx` (cards with a `role="switch"` "Shortcut" toggle replacing the pin button), `all-modules.test.tsx`, en/nl messages, `tests/e2e/specs/shell.spec.ts`. Read-only review; no source edited. CI / tests were not run by the reviewer.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM and three LOW items are recommended follow-ups, none block.

## Findings

### MEDIUM-1: switch hit area is 44x24px; the visible "Shortcut" label is not part of the target

`all-modules.tsx` L98-L125: the `<button role="switch">` is `h-6 w-11`. It meets WCAG 2.2 AA 2.5.8 (24px minimum) exactly, but is well below the 44px baseline used elsewhere in the app (`min-h-12` on the old pin button, `min-h-14` on the card link). The row has `py-2` and a text label beside it, but neither is clickable, so users on wall/shared touch devices must hit a 24px-tall target. This is a regression against the replaced 48x48 button.
Remediation: make the whole footer row the hit area (a `<label>`-like wrapper or `onClick` on the row is not enough for semantics; simplest is a `min-h-11` button with the track drawn as an inner span, or an `::after` inset-y hit-area extension), keeping a single focusable switch.

### MEDIUM-2: forced-colors thumb contrast

L117 and L121: pinned track is `Highlight`, thumb is `ButtonText`. In Windows high-contrast themes `ButtonText` on `Highlight` can be low contrast (e.g. white on cyan in the Night Sky/Black themes), so the thumb may be hard to see; the position still conveys state but the control becomes ambiguous. System-colour pairing should be `Highlight` with `HighlightText`.
Remediation: when pinned use `forced-colors:bg-[HighlightText]` on the thumb (keep `ButtonText` for the unpinned thumb), and add a Playwright check with `forcedColors: "active"`.

### LOW-1: dead `id` on the visible label

L98 sets `id={`shortcut-${item.id}`}` but nothing references it (no `aria-labelledby` / `aria-describedby`). Either remove it or use it (`aria-describedby`). The accessible name (`aria-label`, "Pin Shopping to shortcuts" / "{module} vastzetten in snelkoppelingen") contains the visible text ("Shortcut" / "Snelkoppeling") case-insensitively, so WCAG 2.5.3 Label in Name is satisfied in both locales.

### LOW-2: thumb travel is asymmetric (4px left gap, 2px right gap)

Track is `w-11` (44px) with a 1px border, so the inner width is 42px; thumb is `size-4` (16px) at `translate-x-1` (4px) off and `translate-x-6` (24px) on, leaving 4px vs 2px of clearance. Use `translate-x-[22px]` (or a track of `w-12`/travel 5.5) for symmetry. RTL mirroring is correct (`rtl:-translate-x-*` with the flex start flipping to the inline-start edge).

### LOW-3: test gaps

Unit and e2e changes are mechanical selector swaps (`button`/`aria-pressed` to `switch`/`aria-checked`); both still assert persistence via cookie and reload, and axe runs on the page. Missing: keyboard toggling (Space/Enter), an nl-locale check of the switch name, and a forced-colors / touch-target assertion. Native `<button>` makes keyboard behaviour inherent, so the risk is low.

## Checks

- Switch semantics: `role="switch"` on a native `<button type="button">` with `aria-checked` bound to state; state also communicated by fill and thumb position (not colour alone). Pass.
- Accessible name: provided via `aria-label` with module name, so each switch is unique in the list. Pass.
- Focus: global `:focus-visible` rule exists in `globals.css` L37; the card has no `overflow-hidden`, so the ring is not clipped. Pass.
- Reduced motion: transitions are gated with `motion-safe:`. Pass.
- RTL: thumb translation mirrored via `rtl:`; no other physical left/right. Pass (see LOW-2 on symmetry).
- Forced colors: track border `ButtonText`, pinned track `Highlight`; see MEDIUM-2.
- i18n: `modules.shortcut` added to both en.json and nl.json; keys in parity; tone consistent with existing "Shortcut"/"snelkoppeling" wording and `pinToggle`. Pass.
- Card link: `min-h-14`, icon tile `aria-hidden`; the core-section default styling path (`className ?? ...`) is unchanged for non-card use. Pass.
- No data/permission/Home-isolation impact: purely presentational, favourites remain the existing cookie mechanism.
- Dependencies: none added; `PinIcon` import removed from this file.

## Remaining risks / test gaps

- Off-state track (`bg-page` with `border-line-control`) and thumb (`bg-surface`) non-text contrast (WCAG 1.4.11) was not computed numerically; with extreme accents the pinned thumb vs `bg-accent` contrast is also unverified. State remains perceivable via thumb position.
- No visual regression coverage in dark mode or with long nl labels in a narrow card grid.
