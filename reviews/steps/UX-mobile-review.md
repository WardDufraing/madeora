# UX mobile polish review (feat/ui-mobile-polish vs origin/main)

Verdict: **PASS** (no BLOCKER or HIGH findings; two MEDIUM items to address or accept before merge).

Scope reviewed: `git diff origin/main` (41 class-only source files plus
`tests/e2e/specs/mobile-screens.spec.ts`). I did not run the suite; findings come from reading the diff
and the support code.

## Findings

### MEDIUM-1: the spec gives each test a 30-minute timeout and swallows failures

`tests/e2e/specs/mobile-screens.spec.ts`, `test.setTimeout(30 * 60_000)` and the `page.goto` loop.

- Impact: the config default is 60 s. A hung navigation, with no navigation timeout of its own, can hold a
  CI worker for 30 minutes per test. There are four tests, so one stall can exhaust the 60-minute `e2e`
  job. The spec also covers about 100 screens in one test, so one failure reports every problem at once
  but the test cannot be retried per screen.
- Related: `if (status >= 400) continue` and `.waitFor(...).catch(() => undefined)` silently skip a
  screen that returns an error or never renders an h1. A regression to a 500 turns the check green.
- Remediation: set a bounded timeout (about 10 minutes), pass `{ timeout: 30_000 }` to `goto`, and fail
  (push to `problems`) on status >= 400 or a missing h1 instead of skipping. Better, generate one test
  per screen with `test.step` or per-screen tests, so a failure points at one path.

### MEDIUM-2: CI cost, and whether it belongs in CI as it stands

- Impact: the stated runtime is about 2.5 minutes locally, on top of a CI e2e job that already runs the
  desktop axe walk. Four full walks (320 and 390 px, light and dark) on the 2-worker runner will probably
  run longer than 2.5 minutes. Dark mode adds little for overflow and target size, which are
  geometry checks and do not depend on colour.
- Remediation: run both widths in light only (halves the cost), or run 320 px only in CI and 390 px
  on demand. Using `MOBILE_AUDIT_DIR` for screenshots is fine as an opt-in. Keep the console guard
  (it is inherited from `../support/browser`, so console errors and hydration warnings fail the test,
  which is good).

### LOW-1: the role label loses its separator on phones

`apps/web/src/app/(app)/homes/[homeId]/members/page.tsx`, around line 93: `<RoleLabel />` is plain
text, not a pill link, with both neighbouring dots hidden below `sm`. It then reads as "Ann's flat
Owner", with only a 0.5rem gap, beside the bold home name. The brief said dots are hidden only next to
pill links. This one sits between a name and a plain label.

Remediation: keep the dot between the home name and `RoleLabel` visible (hide only the dot after it),
or give `RoleLabel` a visible treatment. The same check on the other 52 hidden dots found no other
case of a hidden dot adjacent to non-link text.

### LOW-2: the spec skips inline links by a heuristic

The test treats an `<a>` as inline text, which WCAG 2.5.8 exempts, when its parent has other text, and
skips it. This is reasonable, but it also skips links inside the `p` rows that hold the home name
and a link (the text content differs, and `link-action` has `min-height: 2.5rem`). Acceptable, but the
comment should say why, so a future reader does not think the heuristic hides defects.

### LOW-3: test count in the report

The change description says 5/5 passed locally; the file defines four tests (two widths by two themes).
The fifth is presumably the `setup` project. No action beyond accuracy in the PR text.

## Explicit checks

- **Requirements / no behaviour or text change:** PASS. Changes are Tailwind class tweaks only
  (`min-w-0`, `flex-col sm:flex-row`, `items-center gap-y-1`, `max-sm:hidden`, tab sizing, `truncate`).
  No strings, handlers, data or routes changed.
- **Dot separators and accessibility:** PASS with LOW-1. All 53 separators are `aria-hidden="true"`, so
  hiding them below `sm` changes nothing for assistive technology. Visually, each remaining link is a
  `link-action` with `min-height: 2.5rem` and padding, so the links stay distinct without the dot. They
  also keep `gap-x-2 gap-y-1` spacing when they wrap.
- **RTL safety:** PASS. No `left`, `right`, `ml-`, `mr-`, `pl-`, `pr-` or `text-left`/`text-right`
  classes were added. The changes use `px-`, `gap-`, `flex-row` and `min-[360px]:` utilities, which are
  logical or symmetric.
- **Design tokens:** PASS. No arbitrary colour values. The only arbitrary variant is the `min-[360px]:`
  breakpoint in `mobile-nav.tsx`, a size and not a colour. It is a bespoke breakpoint outside the usual
  scale; acceptable, but worth a token if it recurs.
- **Mobile nav:** PASS. `min-w-0` plus `truncate` on tab labels prevents overflow at 320 px, and the
  tabs keep `min-h-14` and the Create button keeps `min-h-12 min-w-12` (above the 24 px minimum). Truncated
  labels are still the accessible name, so nothing is lost for screen readers. Truncation could clip a
  long Dutch label ("Kalender" and similar are short; not verified for every locale).
- **Cross-Home isolation, permissions, secrets, input validation, migrations:** not affected. No data
  access, auth, SQL or configuration changes. The spec creates its own account and Home through the
  existing support helpers, with synthetic data; no credentials are embedded.
- **Test quality:** see MEDIUM-1, MEDIUM-2. Positives: console and hydration guard inherited, animations
  settled before measuring, clipped containers excluded from the overflow search, checkbox and radio
  measured via their label, `excludedScreens` not needed (the spec reuses the shared screen lists, so
  it follows new screens automatically, although the spec does not exclude the two staff-only pages
  the acceptance spec drops; they are not in `personalScreens` or `homeScreens`, so this is fine).
- **Accessibility:** improved (target sizes, no horizontal scroll). The spec adds the 24 px rule
  (WCAG 2.2 SC 2.5.8) as an automated check. It does not replace manual review.
- **Performance:** no runtime impact on the product. CI time is covered in MEDIUM-2.
- **Maintainability:** the dot-hiding pattern is repeated 53 times as inline markup. A small
  `Separator` component would remove the repetition, but this is out of scope for a class-only change.

## Remaining risks and test gaps

- Locales other than `en` were not audited. Longer Dutch words may still wrap or truncate in the nav.
- The check covers 320 and 390 px only and portrait only; landscape phone widths are untested.
- Screens that need a record id (one task, one recipe) and states that need data (long lists, long
  names) are not covered by the audit.
- Independent review is not a substitute for the required human PR approval.
