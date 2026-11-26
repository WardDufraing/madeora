# Review: personal starter without the Welcome widget (feat/ui-starter-without-welcome, PR #133)

Verdict: PASS

Scope: `starter.ts`, new `starter.fixture.ts`, `starter.test.ts`, the four test files switched to the fixture, `dashboard.spec.ts`, `preferences.spec.ts` (diff `origin/main...origin/feat/ui-starter-without-welcome`). Static review only; vitest and Playwright were not run in this review.

## Checks

- Requirements and scope: UI default only. Welcome stays in the catalogue, and the home starter keeps it. No product behaviour, permission or data change. Pass.
- Existing stored layouts: `starterLayout()` is used only when no row is stored (`server.ts`, `stored === null`), on reset (`reset/route.ts`), for built-in templates and for gallery recommendations. Stored layouts are read unchanged, so saved dashboards keep Welcome. Pass.
- Unsaved starter viewers: a person who has only ever seen the generated starter (`isStarter: true`, never saved) loses Welcome on next load. This is the intended effect of the change. Noted in LOW-4.
- Layout validity, personal starter:
  - lg (12 columns): Actions (0,0,6x2), Notifications (0,2,6x4), Tasks (6,0,6x4), Events (6,4,6x4). The two columns do not overlap, and each column is gapless (left spans rows 0-6, right 0-8). The ragged bottom (2 rows) is smaller than the old one (4 rows).
  - md: single column 6 wide, y = 0, 2, 6, 10, with heights 2, 4, 4, 4. No overlap, no gap.
  - sm: `stacked()` with heights 3, 4, 5, 4. No overlap, no gap.
  - Each breakpoint places each of the 4 widgets exactly once. Pass.
- Tests: the existing suites that need Welcome use `legacyPersonalStarterLayout`, with identical ids and placements to the old starter. `starter.test.ts` covers the widget types and one placement per widget per breakpoint. Reset dialog and recommendation expectations are updated consistently. Pass, with MEDIUM-1.
- E2E consistency:
  - `dashboard.spec.ts`: Welcome count 0 on the starter. Remove "My upcoming events", then add Welcome. Stored order becomes `quick-actions, notifications, tasks, welcome`, matching the expectation. The removal loop lists the four remaining widgets (Notifications, Welcome, Quick actions, Personal tasks). The reset dialog text is "Quick actions, Notifications, Tasks" (a substring of the full list).
  - Template step: Calm mornings is saved after removing Quick actions, so it contains Notifications, Tasks, My upcoming events. `templateContains` joins all names and `getByText` matches substrings, so "Contains: Notifications, Tasks" holds.
  - "Widget unavailable" test now hides Quick actions instead of Welcome. Fine.
  - `preferences.spec.ts`: the Welcome text assertion is dropped, and the heading is asserted with an anchored regex when there is no display name. Pass, with LOW-3.
- Accessibility: the page `h1` greeting remains, so the page keeps a heading and landmark structure. Fewer widgets means less duplicate content for screen readers. Quick actions links stay as the first widget. The keyboard e2e still covers move, resize, hide, remove and add. Pass.
- i18n: no message keys added or removed. `greeting` and the `welcome` widget strings stay in use for Welcome. No hard-coded user-facing text. Pass.
- Security, permissions, cross-Home isolation: untouched. Pass.

## Findings

No BLOCKER or HIGH findings.

- MEDIUM-1 (`layout.test.ts` line 169, `starter.test.ts`): `checkLayout(personalStarterLayout, personal).ok` now runs against the legacy fixture. Nothing runs the real validator (`checkLayout` / `readLayout`) or an overlap and bounds check on the shipped `personalStarterLayout`. The geometry above is correct by hand, but a later edit to `starter.ts` could ship an invalid or overlapping starter without a failing test. Remediation: in `starter.test.ts`, assert `checkLayout(personalStarterLayout, personal).ok` and `readLayout(...)` round-trip for both starters, and assert no pairwise overlap per breakpoint.
- LOW-1 (`starter.fixture.ts`): a hand-copied fixture can drift from the layout rules and the catalogue. It is only exercised by the tests above, which is its purpose. Remediation: none now. The fixture header comment is clear.
- LOW-2 (`starter.ts`, lg): the left column ends at row 6 and the right at row 8. Remediation: optional, for example Notifications h=6 or Actions h=4 to balance. Cosmetic.
- LOW-3 (`preferences.spec.ts`): the anchored regex assumes the greeting has no trailing text without a display name. This was not run here. Remediation: confirm in CI, or loosen the anchor if the heading includes a comma.
- LOW-4 (UX): first-time people lose the "Welcome to Madeora" explanatory card on the starter. The heading and Quick actions remain the orientation. Remediation: mention in the PR description. If onboarding text matters, track it as a follow-up.
- LOW-5 (`dashboard.spec.ts` line 99): the comment is a long line. Prettier does not wrap comments. Remediation: none needed.

## Remaining risks and test gaps

- No automated check that the shipped starter passes the layout validator (MEDIUM-1).
- E2E and unit tests were not executed in this review. CI must be green before merge.
- This is an AI review and is not a substitute for the human approval required by CLAUDE.md.
