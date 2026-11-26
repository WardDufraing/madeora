# Review: task rows as soft cards (feat/ui-task-cards)

Verdict: PASS

Scope: `apps/web/src/components/tasks/task-list.tsx` (diff `origin/main...origin/feat/ui-task-cards`, 4 class changes). Rows go from divider rows to `rounded-card border border-line bg-surface p-3 ps-4 shadow-raised`; the `ul` elements get `gap-2` (the completed `ul` also `mt-2`). No behaviour, markup or test-id change.

## Checks

- Structure and hooks: `data-testid="task-row"`, `data-task-id`, `aria-current`, the bulk and complete checkboxes and the undo button are untouched. Pass.
- Ring and shadow: `shadow-raised` is a Tailwind theme shadow (`--shadow-raised`), so it composes with `ring-1 ring-inset` through Tailwind's box-shadow variables. The inset ring draws inside the 1px border, so a selected or retained card shows the accent ring next to the grey border. It is visible (accent-edge is 3:1 on surfaces by token tests). Pass.
- Checkbox focus ring: no `overflow-hidden` on the card, and there is 12px of padding on every side, so the focus outline is not clipped. Pass.
- Bulk-select mode: two checkboxes in a row as before; the padding change adds about 2px on the end side only. Pass.
- RTL: only logical utilities (`ps-4`, `start-0`). `p-3` plus `ps-4` is the same override pattern already in use. Pass.
- Nested cards: `TaskList` is rendered directly in the page (`tasks-overview.tsx`), not inside a `Card`, so there is no card-in-card. Dashboard and calendar use `CompactTaskList`, which is unchanged. Pass.
- E2E: every spec that touches rows (`tasks.spec.ts`, `task-recurrence.spec.ts`, `task-reminders-templates-bulk.spec.ts`, `task-attachments-calendar-widgets.spec.ts`, `calendar.spec.ts`, `acceptance-*.spec.ts`) locates them by `getByTestId("task-row")` plus text or role, never by CSS class or geometry. Unaffected. Pass.
- Flaky keyboard/dark/light axe tests: the change adds no timing, focus or DOM difference. The axe runs happen with an open row on a white or dark surface, where text-fg and muted text keep the same contrast as before (the card background equals the old effective background). The only visual addition is a static border and shadow. I do not see a path by which this makes the flakes better or worse. The flake is more likely from `motion-safe:transition-colors` on the `li` (pre-existing, unchanged) being sampled mid-transition when a row is added or retained; that would be worth a separate look. Pass (no effect).
- Small screens: `p-3` plus a 1px border keeps the content width within about 2px of the old `pe-2` layout. The row stays `flex` with `min-w-0` on the text block. `gap-2` makes long lists a little taller (50 rows per page, 8px each). Pass.
- Security, permissions, cross-Home isolation, i18n: untouched. Pass.

## Findings

No BLOCKER or HIGH findings.

- MEDIUM-1 (contrast of the Completed section, pre-existing, not a regression): `opacity-80` fades the whole card, so muted text on the `li` ends up at 80% of `fgMuted` over a surface that is itself blended 80% with the page. Computed from `packages/design-tokens/src/neutral.ts`:
  - Light: `#586368` blended to about `#798286` on about `#fcfcfd` gives 3.83:1, below the 4.5:1 AA text minimum (full opacity is 6.18:1). Main already had 3.6 to 3.9:1 (against page or white), so this change is neutral to slightly better.
  - Dark: about `#7f8b90` on about `#12191d` gives 5.07:1, which passes (main: 4.98 to 5.32).
  - No e2e axe run expands the Completed section, so CI does not see it. Remediation (follow-up): drop `opacity-80` and rely on `line-through` and `text-fg-muted` (already 6.18:1 and 7.05:1), or fade only the border and shadow.
- LOW-1 (priority bar vs the corner radius): `rounded-card` is 1.25rem. The bar sits at `start-0` inside the border and begins 10px from the top and bottom (`inset-y-2.5`). At 10px down, the inner curve is about 2px in from the edge, so the top and bottom ends of the 4 to 6px bar can poke over the curved border by about 2px (rounded-full ends soften it, and there is no clipping). Remediation: `inset-y-4`, or clip the bar with an `overflow-hidden` wrapper (careful: not on the `li`, because that would clip the checkbox focus ring), after a visual check at 320px and in RTL.
- LOW-2 (forced-colors): the border survives, but the ring and shadow are dropped, so a selected or retained card is not distinguishable by ring alone (`aria-current` still marks it for assistive technology). The ring behaviour was the same before, but the new border now makes every card look "selected" in forced-colors. The priority bar background is also overridden. Remediation: `forced-colors:border-[Highlight]` when selected or retained.
- LOW-3 (tests): no component or visual test covers the new classes. Acceptable for a class-only change.

## Remaining risks and test gaps

- No browser, screenshot or e2e run was done; visual points (corner overlap, 320px, RTL, forced-colors) are from class lists, tokens and arithmetic.
- This is an AI review and is not a substitute for the human approval required by CLAUDE.md.
