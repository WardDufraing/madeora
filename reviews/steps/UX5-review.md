# UX5 independent review: Habits redesign (Decisions 62-67)

Branch: feat/habits-redesign vs origin/main. Reviewed from the diff, the files on the branch and
Decisions 62-67. Ran `vitest run src/components/habits/habit-redesign.test.tsx` (16/16 pass). Nothing else was run.

**Verdict: PASS** (no BLOCKER or HIGH). Two MEDIUM findings should be fixed or consciously accepted before merge.

## Findings

### MEDIUM-1: Every completion refetches every visible strip detail read (N+1 fan-out), and the strip flashes to "Loading"
- `habit-week-strip.tsx` useHabitWeek (query key includes `habit.revision` and `habit.today`) and `use-habit-mutation.ts` (`invalidateQueries({ queryKey: habitKeys.all })`).
- Impact: with the week view on, each row issues one `GET /habits/:id` (full detail) read. One tap on any circle invalidates `["habits", ...]`, which includes all `week` queries, so N detail reads refetch, followed by `router.refresh()`. The revision in the key means a changed habit gets a brand-new key with no data, so its strip swaps to the "Loading" text and back (layout shift, and it is noisy for screen-reader users in a list with many habits). The trends view does the same with N calendar reads per month change and per mutation.
- Remediation: key the strip by `[habits, week, id, today]` and use `placeholderData: keepPreviousData` so it never blanks. Longer term, add one batched week/month read (or return the 7 days in the list payload). At minimum, cap or paginate trends when the habit count is large, and limit invalidation to the changed habit (`habitKeys.week(id)`, `calendar(id)`).

### MEDIUM-2: Decision 66 is only partly met in the trends view
- `habit-trends.tsx` (whole file).
- Impact: the "time-range selector" is a month stepper only, with no range such as 4 weeks, 3 months or the year. There is no per-habit detail chart or progressive disclosure: each habit shows a percentage and an "Open" link to the existing habit page. Measurable progress (partial days) is not shown: `combineDays` and `tallyMonth` only know completed, missed and pending, so a numeric partial day counts as missed in "consistency" and in the per-habit rate. The calendar has no partial state for a single habit. The month stepper can walk indefinitely into the future, each step costing N reads.
- Remediation: either record explicitly in the PR and brief that per-habit detail is delivered by the existing habit page (insights plus calendar, `habit-insights.tsx`) and that month is the chosen range, or add a range selector and an inline per-habit expandable detail reusing `HabitInsights`. Treat a partial numeric day as partial (not missed), or document it. Bound forward navigation at the current month.

### LOW-1: Milestone message shows on page load, not on the transition
- `habit-summary.tsx` (`role="status"` paragraph, `finished && celebrations`).
- Impact: a user who opens the page with everything already done hears or sees "all done" immediately. Decision 65 says to reserve celebration for the state transition. Mostly harmless (text only, honours the setting), but it repeats on every refetch or view switch and never clears if undone elsewhere. Also `finished` excludes paused habits correctly, but a day with zero scheduled habits shows nothing, which is fine.
- Remediation: track the previous `done<total` to `done===total` change in a ref, and announce only then.

### LOW-2: Inconsistent accessible naming between strip and trends cells
- `habit-week-strip.tsx` puts `aria-label` on `<li>` with aria-hidden children. Trends cells use sr-only text. Labels on listitems are weakly supported by some screen readers.
- Remediation: use sr-only text spans in both (as the trends view does) so the name is read reliably; keep `aria-current="date"`.

### LOW-3: Row semantics and noise
- `habit-row.tsx`: each row renders an `<h2>` plus a heading link and the menu both open Details (acceptable). The row repeats schedule, status, week progress, streak and who-completed lines, so rows are less "compact" than Decision 63 intends. Paused and ended rows get a state glyph only (correct).
- `habit-check.tsx`: the check button is `disabled={!hydrated}`, which momentarily removes it from the tab order and makes the control look unavailable on first paint; acceptable but could use `aria-disabled`. Undo feedback is only a failure alert; there is no "completed, Undo" toast. The circle is itself the undo, which satisfies "correction" but is worth noting against Decision 65.

### LOW-4: Editor details
- `habit-form-dialog.tsx`: "reminders" are not in the editor (they live in `habit-reminder-actions.tsx` elsewhere), so the "advanced section" holds description, dates, week start and timezone. This matches existing data rules, but note it against Decision 67 wording. Edit mode only changes name, description and timezone, with a hint saying the rest changes elsewhere (existing behaviour, not a regression). The `endsOn < startsOn` check duplicates schema validation (server still validates).
- `habit-day-marks.ts` extraction from `habit-insights.tsx` is a clean refactor with no behaviour change. The unrelated e2e spec edit is the correct consequence of hiding the start date.

## Explicit checks
- **Requirements:** 62 yes (summary, checklist, View trends toggle, empty state with New Habit for managers). 63 yes (binary circle, numeric progress with quick add via `NumericToday compact`, details and edit in `OverflowMenu`). 64 yes (seven cells, mark plus text per state, partial and future distinct, future dashed and never missed, numeric fill with a numeric label). 65 mostly (motion-safe transitions, inline milestone, partial vs met distinguished; see LOW-1). 66 partial (MEDIUM-2). 67 yes (name first, More options with `aria-expanded` and `aria-controls`, same layout for edit, side drawer, discard prompt tested).
- **Cross-Home isolation:** no new data paths. Trends and strip use the existing per-habit endpoints (`habitEndpoint(id)` and `calendar`), which authorize per habit server-side. Query keys are per habit id, and `homeId` is carried through links and the list key. The `habitKeys.all` invalidation is unchanged. No leakage risk found.
- **Permissions:** the completion control renders only when `access !== "view"`, the habit is not archived and `todayBlock === null`; otherwise a read-only glyph. The Edit menu item is manager-only and not for archived habits; New Habit is manager-only. Client gating is UI guidance only, and the server remains authoritative (unchanged endpoints). View-only behaviour is tested.
- **Input validation:** the form still runs `createHabitSchema` and `updateHabitSchema` client-side with unchanged server validation. The month value comes from internal state (derived via `addDays`), not user text, before going into the `?month=` query.
- **Test coverage:** good for the new units (summary, row, strip cell derivation, combineDays, tallyMonth, trends open, editor, discard, axe on the empty state). Gaps: no test for reduced motion, a failed trends read, mixed loaded and failed calendars, month navigation, the Personal vs Home link paths, nl locale rendering, or the milestone transition. No axe run on the populated list, strip or trends. E2E only gets the start-date click fix. Messages: en.json and nl.json have identical line counts (8694); no key-parity test was run by me, so confirm CI's parity check.
- **Accessibility:** state is never colour-only (marks plus text), buttons are 44px, `aria-pressed` on mode toggles, `aria-current` for today, table caption plus sr-only day names, `aria-live` on the month label. Concerns: LOW-2; the mark glyphs for paused (`‖`) and untracked (`·`) are terse but named in text; the numeric fill relies on the label.
- **Performance:** see MEDIUM-1. The list itself is not virtualized (unchanged). The 60s list polling plus per-row strip reads multiply under the week view.
- **Maintainability:** well split (marks, check, row, strip, summary, trends), pure helpers exported and unit-tested, comments explain intent. `habits-view.tsx` is long but readable. `mode` state is local and not URL-addressable, so View trends is not deep-linkable and resets on navigation (acceptable).

## Remaining risks
- Scale: many habits multiply detail and calendar reads (MEDIUM-1), and the Home or personal Supabase request budget on the free tier is untested under this fan-out.
- Consistency numbers in trends treat numeric partial days as missed; users may read this as punitive, against Decision 66's tone.
- No visual or e2e check of the redesigned list, strip and trends beyond jsdom tests; run a manual light and dark, mobile and keyboard pass before release.
