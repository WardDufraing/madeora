# Review: card-lift hover utility (feat/ui-card-lift)

Verdict: PASS

Scope: `apps/web/src/app/globals.css` (new `@utility card-lift`), `recipe-card.tsx`, `pets-view.tsx` (diff `origin/main...origin/feat/ui-card-lift`).

## Checks

- Tailwind syntax: installed `tailwindcss` is 4.3.3. I compiled the utility with `compile()` from the workspace package. It emits `.card-lift` with the nested `@media (hover: hover) { &:hover {...} }` and `&:active` intact, as native CSS nesting. The existing `press-feedback` and `link-inline` utilities already use `&:` nesting. Nested `@media` inside `@utility` is supported in v4. Pass.
- Tokens: `--md-motion-shift-sm` (0.25rem), `--md-shadow-overlay` (light, dark and forced-dark variants), `--md-duration-fast` (120ms) and `--md-ease-standard` all exist in `packages/design-tokens/tokens.css`. Under `prefers-reduced-motion: reduce` the shift token is 0rem and the duration token is 0ms, and `tokens.test.ts` asserts the shift token. The lift therefore becomes `translateY(0)` and the shadow change is instant, as the comment claims. `--md-shadow-overlay` is not changed under reduced motion, which is the intended behaviour. Pass.
- Recipe stretched link: the article was already `relative`, so the `::after` (`absolute inset-0`) is still positioned against the article. The transform makes the article a stacking context, which does not change the `::after` containing block. The hit area moves with the card, so it is still the whole card. Pass.
- Focus-visible: the recipe outline is drawn on the link's `::after` and moves with the card. The pets outline is on the link and moves with it. Both stay visible. Pass.
- Layout shift: transforms and box-shadow do not affect layout. The 2px travel (0.125rem) is a whole pixel, so text is not blurred. Pass.
- Touch devices: `@media (hover: hover)` keeps the lift off touch-only devices, so there is no sticky hover. Pass.
- Performance: the transition covers `box-shadow`, `transform` and `border-color`. Only the hovered card is animated, so paint cost is small. Pass.
- Security, permissions, cross-Home isolation, i18n and RTL: untouched. Pass.

## Findings

No BLOCKER or HIGH findings.

- MEDIUM: none.
- LOW-1 (`globals.css`, `card-lift` hover): the lift is 2px and the pointer can sit on the bottom 2px of the card. The card moves up, the pointer leaves it, the lift is undone and the card moves back, which can flicker. It is unlikely and short. Remediation: none needed; if it shows up, put the hover on a wrapper and the transform on the child.
- LOW-2 (forced-colors): box-shadow is dropped, so only the 2px lift remains as a cue on the recipe card (the pet card also keeps its `hover:border-line-control`). Remediation: optionally add `border-color: Highlight` under `@media (forced-colors: active)`. Not required.
- LOW-3 (`--md-shadow-overlay`): it is the overlay-sized shadow (8px/20px and 32px/64px blurs) on a small card. It can look heavy and can be painted over by later sibling cards in the grid, because the card has no z-index. Remediation: consider a lighter card-level shadow token, or `hover:z-10`, after a visual check.
- LOW-4 (recipe card): the whole article lifts on hover, including non-link areas, which matches the stretched link. Inner interactive controls, if added later, would also trigger the lift. Remediation: none now.
- LOW-5 (tests): no test covers the utility or its class on the two cards. Remediation: acceptable for a CSS-only change; an existing component test could assert `card-lift` is present.

## Remaining risks and test gaps

- No browser or visual run was done, so the hover feel, the shadow weight and the forced-colors rendering are checked from the CSS only.
- Next.js (lightningcss) lowering of the nested output was not run through a full `next build` in this review.
- This is an AI review and is not a substitute for the human approval required by CLAUDE.md.
