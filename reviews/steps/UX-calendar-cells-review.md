# Independent review: UX calendar cells (feat/ui-calendar-cells)

Scope: `git diff origin/main...origin/feat/ui-calendar-cells`, one file: `apps/web/src/components/calendar/calendar-view.tsx` (`MonthGrid` table and cell classes, `OccurrenceItem` event chip). Read-only review; no source edited. CI and tests were not run by the reviewer. Contrast figures below were computed by the reviewer with `deriveAccent` and `neutral` from `packages/design-tokens/src`.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM and three LOW items are recommended follow-ups.

## Findings

### MEDIUM-1: `fg-muted` on `accent-subtle` drops below 4.5:1 for some accents (new chip background)

Event chips now sit on `bg-accent-subtle` and keep `text-fg-muted` for the time (`when`, L~517) and the notes line (`text-helper text-fg-muted`, L~521). Before, they were on surface or page. Computed `fgMuted` on `accentSubtle`:

- Default purple: light 5.30, dark 5.45 (pass).
- Dark theme, white accent: 3.70 (fail). Dark theme, yellow `#ffe066`: 4.14 (fail).
- Light theme: all tried accents pass (4.68 to 6.18).

`fg` on `accentSubtle` passes everywhere (8.3 to 17.9). The spec allows personal accents, so light accents in dark mode are reachable. Note the work-period chip already has `text-fg-muted` on `accent-subtle` (same exposure, pre-existing), so this widens an existing gap rather than opening a new class of one.
Remediation: use `text-fg` (with weight or opacity-free differentiation) for the time and notes inside chips, or add a token test that guards `fgMuted` on `accentSubtle`.

### MEDIUM-2: `border-accent` is used for today's cell and the chip start edge; light accents make both invisible

`accent` is explicitly not held to 3:1 against surfaces (accent.ts doc comment: "a white accent on a white card is allowed"; `accentEdge` exists for this). Computed `accent` on `surface`: white accent 1.00, yellow 1.30 (light theme); black accent 1.21 (dark theme). Therefore:

- Today's cell (`border-accent ring-1 ring-accent`) is indistinguishable from the neighbouring `border-line` cells for those accents; the only remaining cue is the filled number pill, which has the same problem (existing: `bg-accent text-on-accent`, text is fine but the pill shape is not).
- The chip's solid 3px start border (`border-accent`) disappears against `accent-subtle`, so chips lose the "solid start edge" the change intends.

The work-period chip correctly uses `border-accent-edge`. `accentEdge` on surface is at least 3.37 for every tried accent.
Remediation: use `border-accent-edge` and `ring-accent-edge` for the today cell and `border-accent-edge` for the chip start border. Keep `bg-accent` for the number fill.

### MEDIUM-3: work-period chip vs event chip differ only by edge dash and label

Both are now `bg-accent-subtle` with a thick accent-family start border: work = `border-s-4 border-dashed border-accent-edge`, event = `border-s-[3px] border-accent` (solid), same padding and radius. Differences left: dashed vs solid on a 3 to 4px edge, a bold "Work" label, and event chips having a title. Before this change the event chip had no fill, so fill itself separated them. The dashed edge survives forced-colors and the "Work" label is text, so the distinction is not colour-only and meets WCAG 1.4.1, but at a glance, especially at the 3px width and with a rounded corner (see LOW-3), it is weak, and the decision-43 intent ("quiet block behind the day") is lost.
Remediation: make the work chip visually quieter than events, for example transparent or `bg-page` with a dashed edge on all sides (or `border border-dashed border-accent-edge`), leaving `accent-subtle` to events; or keep both and add an icon or `font-semibold` label to work only (label exists).

### LOW-1: today in forced-colors relies on border colour alone

`ring-1` is a box-shadow and is removed in forced-colors; the `bg-accent` number pill loses its fill and `on-accent` text is forced. The diff sets `forced-colors:border-[Highlight]` for today vs `[CanvasText]` for others, both 1px, so today differs only by Highlight vs CanvasText colour. `aria-current="date"` helps assistive tech but not sighted forced-colors users.
Remediation: add `forced-colors:border-2` (and compensate padding, or use `outline: 2px solid Highlight`) for the today cell.

### LOW-2: `border-s-[3px]` chip edge in forced-colors and chip fill

In forced-colors the `accent-subtle` fill is dropped, so chips are an unfilled box with a coloured start border; this is acceptable, but the start border colour is system-forced (not asserted by any test). No test covers forced-colors for the grid.

### LOW-3: rounded corners with a one-sided thick border

`rounded-control` plus `border-s-[3px]` renders a curved, tapering start border (and same for work chip `border-s-4 border-dashed`, where the dashes taper on the curve). Cosmetic; with RTL the logical `border-s` mirrors correctly. Consider `rounded-s-none` or an inset `box-shadow`/pseudo-element bar if it looks uneven.

## Checks

- Contrast (default accent): `fg` on `accent-subtle` 15.4 light / 12.3 dark; `fg-muted` on `bg-page` 5.50 light / 7.75 dark (day numbers of outside-month days; the `outside && date !== today` rule keeps today on `fg`/`on-accent`); `fg` on `bg-page` 16.0 / 17.4. The weekend and outside-month cells on `bg-page` versus `bg-surface` differ by only 1.12 / 1.10, but that is decoration backed by a `border-line` outline. Pass for neutrals; see MEDIUM-1 for extreme accents.
- Today not colour-only: border weight (1px line to 1px accent plus 1px ring, so about 2px), filled number, and `aria-current="date"` on the link. Adequate except for the cases in MEDIUM-2 and LOW-1.
- Hover: chip `hover:bg-accent-subtle` was removed (background already subtle) and replaced with `hover:underline`; day number keeps `hover:bg-accent-subtle` on a surface or page cell (still visible). Focus styles unchanged.
- Banner rows: banner `<tr>` rows share the table, with `colSpan` on the same columns, so alignment holds under `border-separate`. `border-spacing-1` adds 4px gaps between banner row and week row and between columns; the banner `td` (`px-1 py-0.5`) and empty spacer `td`s still line up with the day columns because `colSpan` cells span the spacing. Pass.
- Week view `h-48` vs month `h-28`: heights are minimums on `td`, so rows grow with content. Month cap is `MONTH_CELL_ENTRIES = 3`; each chip is now taller (`py-0.5` plus a possible notes line), so 3 chips with notes exceed 112px and rows grow unevenly between weeks (not clipped, no overflow hidden). Worth a visual check, not a defect.
- Outer ring: `ring-1` is outside the cell, but `border-spacing-1` (4px) also applies at the table edge, so the `overflow-x-auto` wrapper does not clip it.
- Mobile / agenda / day views: `OccurrenceItem` is shared (`item()` at L~175), so the new chip style also applies in agenda, day and list views, not only the month grid. Not mentioned in the change scope; looks consistent but should be eyeballed.
- E2E: `tests/e2e/specs/calendar.spec.ts` uses `calendar-event` only for counts in the agenda view (L154, L264) and `calendar-overlay`/`calendar-list-day`; no class, CSS or screenshot assertions. `task-attachments-calendar-widgets.spec.ts` L240 to L262 uses `calendar-day` but that testid belongs to `task-calendar.tsx` (untouched). No spec uses `calendar-grid` or `calendar-work-period`. `data-testid`, `data-date`, `data-kind`, `data-source` attributes are retained. No unit test imports `calendar-view`. No e2e impact expected.
- RTL: only `border-s`, `px`, `text-start`, `justify-between`; `border-spacing` is symmetric. Pass (see LOW-3 for the curved edge).
- Tokens: no hardcoded colours except the system colours `Highlight` / `CanvasText` under `forced-colors:`; all other colours via tokens. `cx` is already imported and used.

## Remaining risks / test gaps

- No axe, dark-mode, extreme-accent or forced-colors check covers the calendar grid; recommend a token test asserting `fgMuted` on `accentSubtle` >= 4.5 for the accent range, and a Playwright `forcedColors: 'active'` screenshot or computed-border assertion for today.
- No visual regression test for month rows with 3 notes-bearing chips.
