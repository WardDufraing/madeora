# Independent review: UX auth card (feat/ui-auth-card)

Diff: `apps/web/src/app/(auth)/layout.tsx` only (4 lines). Inspect-only review; e2e not run.

## Verdict: PASS

No BLOCKER, HIGH or MEDIUM findings.

## Findings

- LOW, layout.tsx:20 (`gap-8`, `size-10`): the logo mark grew 36px to 40px and the page-title wordmark (2rem) is now the largest text on the page, larger than the form heading below it, if the form uses a page-title or section-title heading. Impact: possible heading hierarchy competition (visual only; the brand row is `aria-hidden`, so the document outline and the single h1 are unaffected). Remediation: confirm visually against the design spec; no code change required.
- LOW, layout.tsx:21 (`text-section-title` "M" in `rounded-card`): `rounded-card` is 1.25rem, which on a 2.5rem (40px) square renders a full circle, not a rounded square as described. Impact: cosmetic mismatch with the "square" intent. Remediation: use `rounded-control` (0.75rem) if a squircle is intended; otherwise accept.
- LOW, layout.tsx:24 (`p-6 sm:p-10`): at 320px the card inner width is 320 - 32 (px-4) - 48 - 2 (border) = 238px (was 246px). Impact: no overflow, since `sm:p-10` applies only from 640px, where the card is capped by `max-w-md` (448px, inner 366px). Tight but acceptable for the existing forms. Remediation: none; confirm the 320px visual check on sign-up (the longest form) if not already covered.

## Explicit checks

- Requirements: purely presentational, no behaviour or copy change. The product specification, `architecture.md` and CLAUDE.md are untouched. OK.
- Token validity: `text-page-title` is defined. `packages/design-tokens/tailwind.css:46` maps `--text-page-title` (with line-height) to `--md-text-page-title` (2rem / 2.5rem) in `tokens.css:6`. `text-section-title`, `border-accent-edge`, `bg-accent-subtle`, `text-accent-fg` and `rounded-card` are also defined (tailwind.css:21-24, 48; radius at :55). No hardcoded colours. OK.
- Contrast: I computed accent-fg on accent-subtle. Light #7551df on #f0ebfe is 4.51:1. Dark #a281fe on #2d2b4c is 4.55:1. Both pass 4.5:1 for text, and they are close to the limit. The personal accents are covered by `packages/design-tokens/src/accent.test.ts:43-49`, which asserts `accentFg` and `accentEdge` against `accentSubtle` and the surfaces (text 4.5, UI 3). The mark is a 1.19rem bold glyph and decorative, so even without that it is exempt from WCAG 1.4.3. Signed-out auth pages use the default accent. OK.
- Axe: the brand row is `aria-hidden`, so axe skips it for contrast. Auth pages are covered in light and dark by `tests/e2e/specs/auth.spec.ts:577-597` (sign-in, sign-up, forgot-password, reset-password, auth/confirm, plus sign-up errors). The card background and padding are unchanged in kind, so no new contrast pairs arise. OK (not executed here; CI must run it).
- Forced colors: system colours override the background and text (Canvas/CanvasText). The border remains visible, so the mark stays discernible. The element is decorative anyway. OK.
- RTL: only logical or symmetric utilities are used (`gap`, `items-center`, `px`, `p`). No physical left/right. OK.
- E2E selectors: nothing in `tests/e2e/specs` or `apps/web/src` selects the "M" mark or the "Madeora" wordmark by text, role or class (grep found only unrelated "Madeora staff" strings). Heading and landmark selectors (`main#main`) are unchanged. OK.
- Security: the `getAuthState()` display redirect (layout.tsx:17) is unchanged. No new data, secrets or inputs. OK.
- Maintainability: token utilities only, no new CSS or dependencies. OK.
- Accessibility, general: the brand row stays `aria-hidden`; no new interactive elements or focus changes. Reduced motion is not affected.

## Remaining risks and test gaps

- No visual regression or dedicated 320px test exists for the auth card; this is manual only.
- Contrast margin of the default accent-fg on accent-subtle is about 0.01 to 0.05 above the 4.5 threshold; any future token tweak should rerun `accent.test.ts`.
