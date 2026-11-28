# UX raised surfaces independent review

Branch: `feat/ui-raised-surfaces` (diff against `origin/main`, 29 files, +36/-36, class strings only).
Reviewer: independent agent, fresh context. The product specification was not read. The change
touches no logic, data, permissions or SQL.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM and three LOW findings, none of which blocks PR readiness.

Checks I ran myself:

- `prettier --check` on all 29 changed files: clean.
- Read every changed line (`git diff -U0`) and the surrounding JSX for each nested or fieldset case.
- Compared against `ui/card.tsx` (`rounded-card border border-line bg-surface p-widget-padding text-fg shadow-raised`).
- I did not run vitest, tsc or the browser. The only test file that mentions these classes is
  `ui/card.test.tsx`, which this diff does not touch, so no test breaks from the class change.

## Explicit checks

- Requirements and consistency: PASS. Panels now match `Card` exactly (same token set, border kept, so
  depth is never the only cue). The divide-y lists take only `shadow-raised`, with no padding change,
  which is correct because their rows own their padding.
- Nested raised surfaces: PASS. I found no changed panel that contains another changed panel or list.
  `task-templates.tsx` has a raised `ul` of raised `li` cards, but the `ul` itself has no surface
  (`flex flex-col gap-3`), so the cards are siblings, not nested. `template-manager.tsx` and
  `category-manager.tsx` `li` rows have no surface, so the raised `ul` is not doubled.
  `chore-volunteers.tsx` has a raised `ul` at line 140 only.
- Dialogs, popovers, overlays: PASS. No dialog, popover, toast, menu or `bg-surface-elevated` element
  was touched; those keep `shadow-overlay`.
- Clipping: PASS. No changed element has `overflow-hidden`. The two `overflow-x-auto` wrappers
  (`chore-calendar-board.tsx:207`, `task-calendar.tsx:244`) are children of panels, not the panels
  themselves, and the shadow is drawn outside the box, so it is not clipped by them.
- Fieldsets: PASS with a note (see L1). `chore-repeats.tsx:186` is the only changed fieldset; it is the
  pause panel and has its own legend, border and background, so the shadow is not odd.
- Forms: `chore-*` forms and filter forms are the panel root, so the shadow attaches to the form
  element. That is fine; `aria-label` and `data-testid` are unchanged.
- 320px: PASS. `widget-padding` is 1.25rem at compact and 1.5rem at the default size
  (`packages/design-tokens/src/scale.ts`). That is 4px more per side than the old `p-4` on wide screens
  and equal on compact. Content width at 320px minus gutter and padding stays above 250px; existing
  `break-words`/`min-w-0` handling is untouched. No new fixed widths.
- Forced colors: PASS. Box shadows are removed in forced-colors mode, but the 1px border remains and
  maps to a system color, so panel edges stay visible. No change needed.
- Accessibility: PASS. No semantic, label, focus or ARIA change. Focus rings use `outline`, so they are
  not affected by box-shadow. Contrast is unchanged (same `bg-surface`).
- Dark theme: the raised token is a 5%-alpha shadow, which is nearly invisible on dark. The border
  carries the edge there, as in `Card`. Not a regression.
- Security, secrets, migrations, input validation, performance: not applicable to class-only edits.
  Box-shadow on static panels has negligible paint cost.
- Tests: no test asserts the old class strings. No new test is needed for a purely visual change, and
  adding class-string assertions would be a change-detector test. Visual check is the owner's manual
  review (see test gaps).

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

**M1. The migration is incomplete within the same folders, so pages now mix flat and raised panels.**
Still on the old `rounded-card border border-line bg-surface` without `shadow-raised`:

- Top-level `p-4` panels: `tasks/task-reminder.tsx:526`, `tasks/task-repeats.tsx:293`,
  `goals/goals-view.tsx:204,242` (outside the declared scope).
- Top-level `divide-y` list: `chores/chore-pool.tsx:233`. Its sibling panel at `:130` and the notices
  at `:212,216` are `p-3`.
- `chore-volunteers.tsx:258,382` (`p-3` panels). The `:382` panel wraps a plain `divide-y` list and is
  the roster for the same page whose list at `:140` is now raised.
- `recipes/recipe-card.tsx`, `recipe-editor.tsx:452`, `recipe-pages.tsx:194`, `recipe-share-panel.tsx:93`,
  `tasks/task-attachments.tsx:386` (`p-3` rows or cards).

Impact: `task-reminder` and `task-repeats` render in the task detail next to panels that are now raised,
and `chore-pool` renders beside the raised claim lists. The page will show two different depths for the
same kind of surface until the rest is migrated. This is a visual inconsistency, not a defect.
Remediation: either migrate the `p-4` and `divide-y` ones listed above in this PR (they are the same
pattern the PR title promises), or list them in the PR description as deferred to a follow-up step, so
the gap is a recorded decision.

**M2. `p-3` surfaces were left alone without a stated rule.**
The diff changes only `p-4` panels, so `p-3` cards (`recipe-card.tsx`, `chore-volunteers.tsx:258`)
keep the tighter padding and no shadow. If the rule is "p-3 is an inner or row surface, never raised",
that is reasonable, but `recipe-card.tsx` is a top-level grid card and `chore-pool.tsx:130` is a
top-level panel. Remediation: state the rule in the PR description, and decide explicitly for the
top-level `p-3` ones.

### LOW

**L1. A fieldset raised with a shadow.**
`chore-repeats.tsx:186`. It is visually a panel, and its legend is `sr-only`, so nothing is clipped by
the legend notch. Browsers render a box-shadow on fieldset correctly. No action, noted because the
brief asked about fieldsets. The pause preview inside it (`:225`) is `bg-surface-sunken`, which stays
distinct from the raised parent.

**L2. `chore-proposals.tsx:220` still uses `p-4` on a sunken panel.**
It is a sunken inner surface, so leaving it flat is right. Noted only because it sits in the same file
as a changed line and shows the `p-4` vs `p-widget-padding` split is deliberate for sunken surfaces.

**L3. Long unchanged class strings.**
Several lines now exceed 100 characters inside JSX attributes. Prettier accepts them and the
repository already carries the same pattern in `card.tsx` consumers. A shared `raised-panel` utility
would remove the repetition across 36 sites, but that is a refactor outside this class-only scope and
is not requested here.

## Remaining risks and test gaps

- No automated visual regression; the shadow and the 4px padding increase are only verified by eye.
  Owner should check one page per module at 320px and in dark mode before merge.
- The `data-testid`-based unit and E2E tests were not run by me. They should be unaffected, since no
  test id, role or text changed.
- Docs/ADR: no change log entry was needed for a class-only visual change that follows an earlier
  approved redesign decision, but the PR description should link the redesign decision it implements
  and name the deferred files from M1.

## Follow-up

M1: the remaining top-level `p-4` panels in `task-reminder.tsx`, `task-repeats.tsx` and `chore-volunteers.tsx` were migrated. `chore-pool.tsx` is covered by PR #151 and `goals-view.tsx` by PR #154. M2: `p-3` surfaces that are list items or compact cards (`recipe-card.tsx`, which keeps its own `card-lift`) stay compact on purpose; only standalone panels use the widget padding.
