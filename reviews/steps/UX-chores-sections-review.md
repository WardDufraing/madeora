# Review: chores status groups as raised cards (feat/ui-chores-sections)

Verdict: PASS

Scope: `apps/web/src/components/chores/chores-overview.tsx` (diff `origin/main...origin/feat/ui-chores-sections`, 3 class changes). Class-only change, no behaviour change.

## Checks

- Structure and hooks: the `<section>`, `aria-labelledby`, `h2` id (`chores-${group.id}`), `data-testid="chores-group-*"` and `chore-row` are untouched. Only `className` changed. Pass.
- E2E: `chores.spec.ts`, `chore-overview.spec.ts` and `chore-pool.spec.ts` select by test id (`chores-group-today`, `chores-group-upcoming`, `chores-group-reassign`, `chore-row`), not by CSS class or layout. Unaffected. Pass.
- Tokens: `rounded-card`, `border-line`, `bg-surface`, `shadow-raised` and `p-widget-padding` all exist and are used on other cards (dashboard widgets, template manager, auth card). Padding is 1.5rem, and 1.25rem in the compact scale. Pass.
- Contrast: same surface and text tokens as the existing cards. Heading is now `font-bold`, which does not reduce contrast. Pass.
- Forced-colors: the card boundary is a real `border border-line`, which is kept in forced-colors mode, and `divide-line` hairlines are borders too. Only the shadow is lost, which is acceptable. Pass.
- Row spacing: `py-3 first:pt-0 last:pb-0` with `divide-y` gives even rhythm and no double padding at the card edges. The `mb-3` on the heading replaces the old `gap-2`. Pass.
- RTL: only logical-neutral utilities (`p-*`, `py-*`). No left/right classes. Pass.
- Nesting: the group card contains no nested bordered box any more (the `ul` border was removed), so there is no card-in-card. Pass.
- Security, permissions, cross-Home isolation, i18n: untouched. Pass.

## Findings

No BLOCKER or HIGH findings.

- MEDIUM: none.
- LOW-1 (visual coherence with the pool, `chore-pool.tsx`): the pool section still renders its sub-groups (`pool-*`, `h3`) as a bordered `ul` without shadow, and a `font-semibold` h2 with no card. The status groups are now raised cards while the pool below them is not, so the page mixes two styles. Remediation: in a follow-up, give the pool sub-groups the same card treatment (or confirm the difference is intended).
- LOW-2 (small screens): `p-widget-padding` is 1.25rem to 1.5rem on all widths, plus the page gutter, so row content has about 40 to 48px less width on a 320px screen. The row is `flex-wrap`, so it wraps rather than overflows, but titles and action buttons wrap sooner. Remediation: optionally use a smaller padding below `sm` (for example `p-4 sm:p-widget-padding`) after a visual check at 320px.
- LOW-3 (heading weight): the h2 is `font-bold` here, and `font-semibold` on the pool h2 and other section headings. Remediation: align weights, or treat the change as the new standard for card titles.
- LOW-4 (tests): no component or visual test covers the new classes. Acceptable for a styling change.

## Remaining risks and test gaps

- No browser, screenshot or e2e run was done. Visual checks (320px width, dark theme, RTL, forced-colors) were made from the class list and tokens only.
- This is an AI review and is not a substitute for the human approval required by CLAUDE.md.
