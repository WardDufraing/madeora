# S04 · Design tokens and base components — feature brief

**Branch:** `feat/design-tokens-base-components` from `main` @ d812a25 (S01, S02, S03 merged).
**Sources:** build-plan S04 and its "Done when"; `docs/design/design-decisions.md` (purple is only the accent placeholder; Ora card has a solid surface); PS "UI / UX Style Guide" (L3213–L3300: visual principles, colour foundations, atmospheric background, typography and spacing, component rules); PS accent sections L487–L520 (derived hover/pressed/focus, contrast, no element gradients, reduced transparency); ARCH §5, §12 (strategy B), §16 (icons C), §17 (motion A), §21, §29 (testing A); CLAUDE.md frontend B, icon C, animation A, testing A, €0 rule. Carry-overs: S01 review risk 7 (first automated axe check), S00 risk 5 (cite design-decisions.md), S03 review L2 (automate the `next build` check that client code cannot import server env).

## Actors and permissions

None. S04 is presentational only: no data, no auth, no Home scope. Components take labels and callbacks as props and never decide access.

## Scope

1. **`packages/design-tokens`** (platform-neutral TypeScript, no DOM):
   - Colour tokens for light and dark from the spec table (page, sidebar, surface, elevated surface, text, secondary text, border), plus what the spec asks for but leaves unvalued: a control-border token that meets 3:1 for input and checkbox outlines (WCAG 1.4.11; the spec's `#E6E9F1` border is for card edges only), and semantic success / warning / danger / info colours with readable text on them.
   - Accent tokens: `accent`, `accent-hover`, `accent-pressed`, `on-accent`, `accent-subtle`, `focus-ring`, all derived from one solid accent by `deriveAccent(hex, theme)`. The spec purples (`#8057F5` light, `#936BFF` dark) are only the default input. WCAG contrast helpers.
   - Typography (system sans-serif stack; spec says the production font is chosen and licensed separately), spacing (4px grid), radius (card 16px, control 10px), elevation, icon sizes, motion durations and easing.
   - The page-only atmospheric background: two low-opacity radial washes built from the accent and a cool blue, fading into the page base, switched off under `prefers-reduced-transparency` and forced colours.
   - Generated `tokens.css` (CSS custom properties; light default, dark via `prefers-color-scheme` or `data-theme="dark"`, `data-theme="light"` forces light; reduced motion sets durations to 0) with a `--check` that fails when it is out of date, like the DB types check.
2. **Tailwind wiring** in `apps/web`: Tailwind's default colour palette is removed (`--color-*: initial`), so classes like `bg-purple-500` do not exist; only Madeora tokens are available as utilities.
3. **`packages/icons`**: original SVG sources (24×24, 2px round stroke, `currentColor`) for close, check, info, success, warning, error and a spinner; a generator with a strict element/attribute allowlist (no scripts, event handlers, `href`, external references or styles) that writes typed React components; decorative by default (`aria-hidden`), labelled when given a title; icon inventory with provenance.
4. **Base components** in `apps/web/src/components/ui/` (one app uses them, so no shared UI package yet, ARCH §12): Button (primary, secondary, ghost, destructive; loading), TextField (visible label, description, error, required), Checkbox (≥24px target, description, error), Card, Dialog (native `<dialog>`, focus into the dialog, Escape, focus returns to the opener), Toast (provider + hook, polite live region, tone shown by icon and text not colour alone, dismiss button, optional action, pauses on hover/focus), EmptyState, LoadingState, ErrorState. Every visible string comes in as a prop, so S05's `next-intl` can supply them.
5. **Motion**: tokens plus CSS transitions only. Motion for React is approved but nothing here needs it; the first complex animation adds it.
6. **Dev-only component preview** at `/dev/components`, returning 404 when `APP_ENV=production`, used for Playwright and visual review.
7. **Tests:** Testing Library + axe-core (jsdom) for every component, rendered under both themes; Playwright with axe-core (real Chromium, includes colour contrast) on the preview page in light and dark; Playwright accent test: replacing the accent tokens recolours every accent use; a repo test that fails on hex/rgb/hsl colour literals or Tailwind palette colour names outside `packages/design-tokens`; token contrast tests in both themes.
8. **S03 L2 carry-over:** an automated fixture build: a tiny Next.js app whose `"use client"` component imports `@madeora/config/env/server` must fail `next build` with the `server-only` error; plus an ESLint rule that flags the direct import in `"use client"` files. Added to CI.
9. Docs: ADR 0004 (tokens, icons, components, motion), design section in `docs/development.md`, icon inventory, README package list.

## Out of scope

App shell, sidebar, theme switcher, next-intl (S05); user-chosen accents, picker and contrast warnings (S11); Ora's look and the brand mark colour (open in design-decisions.md); production font choice; Motion for React; dashboard widgets.

## Defaults picked (no owner question needed)

- **System font stack** until a production font is chosen and licensed (spec leaves it open).
- **Semantic colours and the control-border token** are new values, chosen for contrast; the spec says exact hex values stay flexible.
- **Dev preview route** instead of Storybook (no new tool), not served in production.
- **axe-core 4.13.0** (MPL-2.0, no install script, no dependencies; 4.14.0 is under two weeks old).
- **Toasts auto-dismiss after 6 s by default**, pause while hovered or focused, and can be made persistent; errors default to persistent.

## Acceptance tests

1. Every component passes Testing Library behaviour tests and axe with no violations in light and dark (jsdom), and the preview page passes axe including colour contrast in real Chromium in both themes.
2. Replacing the accent tokens on the page recolours the primary button, checked checkbox and focus ring; a source scan finds no hard-coded colours outside the tokens package.
3. Token contrast: body and secondary text ≥ 4.5:1 on page and surfaces, on-accent text ≥ 4.5:1 on accent, focus ring and control borders ≥ 3:1, in both themes; `deriveAccent` keeps on-accent ≥ 4.5:1 for a spread of accents.
4. Reduced motion zeroes the motion durations; the atmospheric background disappears under reduced transparency.
5. Icon generator refuses SVGs with scripts, event handlers, `href`, `style` or unknown elements; generated files are up to date.
6. The server-env fixture build fails with the `server-only` error; the lint rule flags the import.
7. Format, lint, typecheck, unit tests, build, E2E all pass.
