# Review: Mobile bottom tab bar pill (feat/ui-mobile-tab-bar)

Verdict: PASS (re-review of the final diff; first pass was CHANGES_REQUIRED)

## Re-review

- Earlier HIGH-1 (overflow at 320px): resolved. Each tab `li` now has `min-w-0 flex-1` and the pill is `w-full max-w-14`, so the pill shrinks instead of forcing 64px per tab. The Create `li` keeps its natural width (about 64-68px), leaving about 55px per tab at 320px.
- Earlier MEDIUM-1 (forced-colors outlines on every pill): resolved. `border border-transparent` and `forced-colors:border-[Highlight]` now apply only to the current pill, so inactive pills and More have no forced-colors outline.
- New LOW-5: the link keeps `min-width: auto`, so a label wider than its slot (English "Dashboard", about 60px at 13px against about 55px at 320px) may spill 2-3px each side of its centred box. Neighbouring labels are shorter, so no collision is expected; the label is not clipped (no overflow hidden). Confirm visually at 320px in `en` and `nl`, or add `min-w-0` and `truncate`-free wrapping if it looks tight.
- The earlier LOW-1 to LOW-4 are unchanged and non-blocking. The 320px Playwright check suggested in LOW-2 is still recommended.
- Not run: browser, tests, lint, typecheck.

## Original review (first pass)

Scope: `apps/web/src/components/shell/mobile-nav.tsx` (diff `origin/main...origin/feat/ui-mobile-tab-bar`, one file, +17/-10). No test files changed.

## Checks

- Requirements and scope: visual change only; no behaviour, routing, permission or Home-isolation change. Pass.
- Current tab not marked by colour alone: `aria-current="page"` and `font-semibold text-fg` remain on the link, plus the pill. Pass.
- Accessible names: the icon pill is `aria-hidden`, the visible label span is unchanged, so link and button names ("Dashboard", "Calendar", "Tasks", "More") are unchanged. Unit and e2e queries by name still match. Pass.
- Touch target: the whole `Link`/`button` keeps `min-h-14` (56px) and `flex-1` width. Pass.
- Contrast: `text-fg` (#10181c) on `accent-subtle` (#f0ebfe) in light and `#f1f5f6` on `#2d2b4c` in dark are well above 4.5:1. `fg-muted` (#586368) on `sidebar` (#fff) is about 6:1; on the hover pill it is still above 4.5:1. Dark `fg-muted` (#9aa7ad) on `#060a0c` is high. The pill itself is non-text decoration; the state does not depend on its contrast (weight and `aria-current` carry it). Pass.
- RTL: only symmetric utilities (`w-14`, `justify-center`, `px-1`); no physical left/right. Pass.
- Reduced motion: transition is `motion-safe:` only. Pass.
- Create button: unchanged, so it is not inside a pill. Pass.
- E2E: `shell.spec.ts` "small screens" (390px) asserts list item texts, `aria-current` on Dashboard, axe, Create sheet, More dialog and focus return. All use roles and names; none depends on the removed top bar. Still valid. Nothing else in `tests/e2e` uses the bottom bar except `members.spec.ts` (375px) and `ora.spec.ts` (390px), which I did not find to depend on the bar's markup. Pass.
- Unit tests: `mobile-nav.test.tsx` still asserts items and `aria-current`. Pass (see LOW-2 on coverage).

## Findings

No BLOCKER.

- HIGH-1 (layout at 320px, `mobile-nav.tsx` `tabClass` and the `ul` `mx-auto flex max-w-xl gap-1 px-2`): each tab `li` is `flex-1` with default `min-width: auto`, so its minimum is the link's content: pill `w-14` (56px) plus `px-1` (8px) = 64px. Four tabs need 256px, the Create button `li` needs about 64-68px (`min-w-12`, `px-3`, "Create" at 13px semibold), the four `gap-1` take 16px and `px-2` takes 16px. Total is about 352-356px, versus 288px of content width at 320px and 328px at 360px. At 320px the row overflows by about 35px, so the "More" button is clipped or pushed off screen (in RTL, Dashboard). At 360px it overflows by about 24px. The old bar had only a 24px icon, so it fit. This is a static estimate; no browser run. 320px is the WCAG 1.4.10 reflow width and the spec requires responsive layout. The existing e2e viewports (375/390) would not catch it. Remediation: let the pill shrink (`w-full max-w-14` plus `min-w-0` on the `li` and link), or use `w-12`, or drop `gap-1`/`px-2` at narrow widths; then add a Playwright check at 320px that `More` is within the viewport (`boundingBox().x + width <= 320`) in `en` and `nl`.
- MEDIUM-1 (forced-colors, `mobile-nav.tsx` pill `border border-transparent`): in forced-colors mode transparent borders are repainted with a system colour, so all five pills (inactive and More) get a visible outline, and the active one differs only by `Highlight` versus the default border colour. This weakens the current-tab signal for those users, who then rely on weight and `aria-current` only. Remediation: apply the border only when active (`active && "border border-[Highlight]"`, or `forced-colors:border-transparent` on inactive pills), and check in a forced-colors Playwright emulation.
- LOW-1 (hover): `group-hover:bg-accent-subtle` also applies on touch devices after a tap (sticky hover on some browsers) and makes a tapped inactive tab look like the current one until it navigates. Remediation: wrap in `@media (hover: hover)` (Tailwind `hover:` already does this in v4 via `group-hover` only if configured; confirm) or accept.
- LOW-2 (tests): no unit test covers the pill (that the icon wrapper is `aria-hidden`, or that More has one), and none asserts the 320px fit. Remediation: add an assertion that link names have no extra text from the icon wrapper, and the 320px e2e from HIGH-1.
- LOW-3 (consistency): the active pill is `bg-accent-subtle` and the hover pill is the same colour, so hover and current look identical. Remediation: use a slightly different hover surface, or keep as is since weight differs.
- LOW-4 (docs): the removed top bar indicator was a documented decision in the old comment; confirm the redesign decision notes (decisions 26/27/29) mention the pill so docs and code agree.

## Remaining risks and test gaps

- No browser or visual check was run; HIGH-1 comes from class arithmetic and should be confirmed at 320/360px in `en` and `nl` before merge.
- Nothing was run (tests, lint, typecheck), as this review inspects the diff only.
- This is an AI review and is not a substitute for the human approval required by CLAUDE.md.
