# ADR 0004: Design tokens, icons and base components

- **Status:** Accepted within the owner-approved frontend (B), icon (C) and animation (A) strategies in `architecture.md` §12, §16 and §17. It records how S04 applies them; it changes no approved decision.
- **Date:** 2026-10-13
- **Step:** S04, design tokens and base components

## Context

The specification's UI / UX Style Guide (`docs/product/Project-specification.md`) gives suggested colour tokens, type scale, spacing, radii, component rules and the page-only atmospheric background. `docs/design/design-decisions.md` adds that the mockup's purple stands for the user's chosen accent and must never be hard-coded. Later steps (S05 shell, S11 personal accents, S17 dashboard, every module) build on these foundations.

## Decision

### Tokens: `packages/design-tokens`

- **Source of truth in TypeScript**, with no DOM dependency, so a future native app can reuse the values (`architecture.md` §12). Generated `tokens.css` (CSS custom properties) and `tailwind.css` (the Tailwind v4 theme) are committed; a test fails when they are out of date (`pnpm --filter @madeora/design-tokens generate`).
- **Themes:** light is the default; with no explicit choice the operating system's dark mode applies; `data-theme="light"` or `"dark"` on an element forces a theme for it and its children. The S05 theme switch sets this attribute on `<html>`, and S11 sets accent properties there too: the atmospheric background is declared with each theme, so it follows a theme forced on an element, but it is drawn from the accent of the element that carries the theme.
- **Accent:** every accent colour (`accent`, `accent-hover`, `accent-pressed`, `on-accent`, `accent-subtle`, `accent-fg`, `focus`, `accent-edge`) is derived from one solid colour by `deriveAccent(colour, theme)`. It guarantees 4.5:1 for text on the accent and for accent-coloured text, 3:1 for the focus ring and for `accent-edge` on every surface, and hover/pressed states that only ever increase contrast. If a colour cannot carry readable text, the fill is nudged just far enough. The fill itself is not held to 3:1 against surfaces (a white accent on a white card is allowed), so controls whose shape depends on the fill, such as a checked checkbox, draw `accent-edge` around it. The spec's purples (`#8057F5` light, `#936BFF` dark) are only the default input. S11 will apply a person's accent by setting the same custom properties from `deriveAccent`.
- **Values from the spec** where it gives them (page, sidebar, surfaces, text, border, accent). **New values** where it asks for something without giving a value: a `line-control` border for inputs and checkboxes (the spec's border colour is about 1.2:1 on white, too faint to identify a control under WCAG 1.4.11), and success, warning, danger and info colours. Tests check every pair used for text or controls in both themes. On the default dark accent, text is dark rather than white, because white on `#936BFF` is only 3.6:1.
- **No hard-coded colours anywhere else:** Tailwind's default palette is removed (`--color-*: initial`), so classes such as `bg-purple-500` produce nothing. Tailwind still accepts arbitrary values (`bg-[red]`), so a test scans the web app, the build fixtures and the icon sources for hex values, colour functions, palette names, and every CSS named colour in arbitrary values, CSS declarations and string literals. CSS system colours (`Highlight`, `Canvas`, …) are allowed, for forced-colours styles. A browser test also checks that every colour painted on the preview, in both themes, is a token value.
- **Typography:** the system sans-serif stack until a production font is chosen and licensed (the spec leaves this open). Sizes: page title 30px, section title 18px, body 15px, helper 13px. Spacing uses Tailwind's 4px scale; radii are 10px for controls and 16px for cards, and 6px for the 20px checkbox box, where a control radius would look round.
- **Atmospheric background:** two very faint radial washes on `body` only, built from the accent token and a cool blue, fading into the page colour. It is removed under `prefers-reduced-transparency` and forced colours. A browser test checks that no other element has a background image.
- **Motion:** duration and easing tokens; all durations become 0ms under `prefers-reduced-motion`. CSS transitions and one enter keyframe cover S04. Motion for React (approved) is not installed yet, because nothing here needs it; the first complex animation adds it.

### Icons: `packages/icons`

- Original SVG sources in `packages/icons/svg/` (24×24 grid, 2px round stroke, `currentColor`), inventory and provenance in `packages/icons/README.md`.
- A generator turns them into typed React components. Its reader accepts only the standard Madeora root element and flat `path`, `circle`, `line`, `polyline` and `rect` elements with numeric or path-command values, so scripts, event handlers, `href`, styles, `url(...)` and entities cannot get in. Icons are decorative (`aria-hidden`) unless given a `title`.

### Components: `apps/web/src/components/ui/`

- Button, TextField, Checkbox, Card, Dialog, Toast (provider and hook), EmptyState, LoadingState, ErrorState. They live in the web app, not a shared package, because only one app uses them (`architecture.md` §12: share tokens, not DOM components).
- Native elements first: `<button>`, `<input>`, and `<dialog>` with `showModal()`, which gives focus containment, inertness and Escape handling from the browser. Focus returns to the opener when a dialog closes or unmounts. The checkbox keeps a visible check mark in forced-colours (High Contrast) mode by using system colours there.
- Toasts announce each message once, when shown, through live regions that exist before it arrives (polite, or assertive for errors); dismissing a toast never re-announces an older one. They pause on hover or focus. Errors and toasts with an action (such as Undo) stay until dismissed, so keyboard and screen-reader users can reach the action (WCAG 2.2.1). When a focused toast closes, focus moves to the next toast or back to where it was. Optional tone labels let screen readers hear the tone, which the icon shows visually.
- Every visible or announced string is a prop, so S05's `next-intl` can translate it. Components take no data and make no access decisions.
- A development-only preview at `/dev/components` (404 when `APP_ENV=production`, decided per request, `noindex`) is used for visual review and the browser tests.

### Tests

- **jsdom (Vitest + Testing Library + axe-core 4.13.0):** behaviour and accessibility structure of every component. jsdom loads no CSS and cannot compute colours, so these tests do not vary the theme and do not check contrast; both themes are covered in Chromium.
- **Chromium (Playwright + the same axe-core):** the preview page, an open dialog and every toast tone in light and dark, including colour contrast; only token colours painted, in both themes; replacing the accent tokens recolours every accent use and leaves no default accent colour painted anywhere; system dark mode; forced colours (background and checkbox check mark); reduced transparency; reduced motion; dialog focus; toast keyboard dismissal.
- **Server-env boundary (S03 review L2):** `pnpm test:boundary` runs the real `next build` on two tiny fixture apps. A Client Component importing `@madeora/config/env/server` must fail with the `server-only` error; the same app importing `env/public` must build. CI runs it in the quality job. For earlier feedback, the ESLint rule `madeora/no-server-env-in-client` (in `packages/config/eslint`) flags a file starting with `"use client"` that imports `@madeora/config/env/server` or `server-only` directly; indirect imports are left to the build check.

## Consequences

- New colours are added only in `packages/design-tokens`, with a contrast test, and regenerated. Components use token utilities (`bg-accent`, `text-fg`, `border-line-control`, …).
- New icons are added as SVG files that pass the strict reader, then generated, with an inventory row.
- `axe-core` (MPL-2.0, no dependencies, no install script) is a development dependency only; no service or cost is involved.
- Open, not decided here: the production font, Ora's fixed colours and the brand mark colour (`docs/design/design-decisions.md`), and user-chosen accents with their picker and warnings (S11).
