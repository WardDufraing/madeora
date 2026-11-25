# UX5 — Habits redesign (daily list, weekly strip, trends, progressive editor)

Source: `docs/design/dashboard-ux-ui-redesign.md` Decisions 62–67; `UX00-redesign-plan-brief.md` (row "62–67"). UI only: no migration, no API change, no RLS change. Branch `feat/habits-redesign`.

## Scope (what changed)

- **Daily list (D62, D63):** `habits-view.tsx` now shows a summary band (done today of scheduled, longest current streak, inline "all done" message only when the viewer keeps celebrations on), a Today / This week switch, a **View trends** button and **+ New habit**. Habits are compact rows (`habit-row.tsx`): a round one-tap check (`habit-check.tsx`) for habits completed once, progress meter + quick adds for numeric habits (reuses `NumericToday`), schedule/status/streak lines, and a `⋮` menu (Details, Edit for managers) instead of persistent icons. Empty state carries the New habit action.
- **Weekly strip (D64):** `habit-week-strip.tsx`, seven cells of the habit's own week (its week start). Marks: ✓ done, ◐ partial (numeric), ✗ missed, ○ pending/open, – not scheduled, ‖ paused, empty dashed cell for upcoming (never missed). Numeric days also get a proportional fill. Each cell has a text `aria-label`.
- **Micro-celebrations (D65):** check fill eases in with `motion-safe` only; the existing toast with Undo and milestone text are unchanged; the day-complete message is inline text in a polite status region.
- **Trends (D66):** `habit-trends.tsx`, opened from View trends: consistency %, habit count, longest streak, month calendar combining all habits (all / some / none done, pending, nothing scheduled, upcoming, each with mark + text), month selector, and a per-habit list linking to the habit page (existing insights, charts and calendar stay there as the progressive per-habit detail).
- **Progressive editor (D67):** `habit-form-dialog.tsx` opens as a side drawer (bottom sheet on small screens) on the name, then schedule and tracking; description, start/end date, week start and timezone sit behind **More options** (opens by itself when a hidden field is invalid). Unsaved-changes question via the shared `Dialog` `dirty` prop. Edit reuses the layout (name, description, timezone; schedule changes stay on the habit page with their preview).

## Decisions / defaults picked

- Week strip data: the list RPC has no per-day data, so the strip (only in "This week" mode) reads each habit's detail endpoint via TanStack Query (up to 100 reads, only on demand, 30 s stale). Trends read each habit's month calendar the same way. A batched RPC would be cheaper but needs a migration; flagged, not built.
- Trends are page-level client state (no new route) so scroll position and context survive.
- Reminders stay on the habit page (their API is separate); "advanced options" holds the fields the create call already takes.
- Summary progress bar is decorative (`aria-hidden`); the text carries the number.
- Left untouched: widgets (`habit-today.tsx`, `habit-widget-body.tsx`), habit detail page, numeric flows, `mobile-nav.tsx`, `sidebar.tsx`, `docs/marketing-website-design.md`.

## Files

New: `habit-check.tsx`, `habit-row.tsx`, `habit-week-strip.tsx`, `habit-summary.tsx`, `habit-trends.tsx`, `habit-day-marks.ts`, `habit-redesign.test.tsx`. Changed: `habits-view.tsx`, `habit-form-dialog.tsx`, `habit-insights.tsx` (marks moved out), `en.json`, `nl.json` (Habits keys), `tests/e2e/specs/habits.spec.ts` (More options click). `tests/e2e/support/screens.ts` not touched.

## Tests

Local (per standing rule): prettier, eslint, `tsc --noEmit`, vitest for `components/habits`, `i18n`, `dashboard`, `shell` (233 pass). New tests cover summary counts and milestone, one-tap complete, view-only rows, menu + edit, numeric row, empty state, strip cells (upcoming never missed, partial numeric), trends combination and tally, trends view with axe, progressive editor (defaults, More options, discard prompt). Full suite, build and e2e run on CI.

## Progress notes

- 2026-11-25: started on Sonnet (UI only); implemented; local checks green.
