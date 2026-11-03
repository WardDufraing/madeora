# S30c · Habit-to-goal links — feature brief

**Branch:** `feat/habit-goal-links`, from `main` at `0c55aec` (S30b merged as PR #57).
**Sources (read only these ranges):** build plan S30c; PS L2916–L3019, the habit-link paragraphs: "Confirmed optional numeric habit-to-goal automatic progress synchronization" (L2916–L2924), "Confirmed selectable historical start for habit-to-goal links" (L2926–L2932), "Confirmed continued habit-to-goal synchronization after achievement" (L2934–L2939), "Confirmed multiple independent goal links per numeric habit" (L2941–L2948), and the linked-series lines of the recurring goal and finalization decisions (L2991–L2995, L2997–L3003); `plans/steps/S29-brief.md`, `S30-brief.md`, `S30b-brief.md` and ADRs 0037–0039 (what this extends).
**Model:** Opus (Ward switched the thread on 29 Oct 2026: derived ledger, recompute on corrections, lock order across habits and goals, RLS).
**Done when (build plan):** the "Habit to goal" journey passes, including a correction that recalculates.

## Model

- **Link** (`private.goal_habit_links`): one numeric habit → one measurable goal **or** one measurable series (then every period of it). Own id, inclusive start date (`starts_on`), state `active` / `removed`, who created it, revision, removal choice. At most one active link per habit and goal (or series): a second attempt answers `already_linked`. Linking is never automatic.
- **Same context only:** a personal habit links to a personal goal of the same person; a Home habit to a goal of the same Home. Every viewer of such a goal can already see the habit, so nothing private leaks through a shared goal, and cross-Home links cannot exist. Personal ↔ Home links are refused (`other_context`).
- **Linked ledger** (`private.goal_link_days`, one row per link and habit day, key `(link_id, on_date)`): the day's active habit total in that day's habit unit, converted into the destination goal's unit, and the goal (period) it counts for. Derived and read-only; never a contribution, never a check-in or target. A day before `starts_on`, a day without recorded quantity, or a day of a series that has no period (missed while paused, before the first period) counts nothing. Each goal counts a habit day once per link; one day may count once in each distinct goal.
- **Goal total** = manual ledger (S30 entries) + linked ledger. The goal shows the breakdown (Manual, From linked habits) and keeps every S30 rule: above-target amounts stay and show as over target; reaching the target never marks achieved; Mark achieved stays explicit.
- **Units:** the same unit, the same dimension (l↔ml, h↔min, km↔m: exact factors; m→km and similar round the day total half-up to 3 decimals, shown in the preview), or the identical custom label. Anything else is incompatible: refused when linking (`incompatible_unit`); a later habit unit version that becomes incompatible counts 0 for those days and the link shows a warning with the number of days. A goal or series with active links cannot change its unit (`linked_unit`); target-only changes are fine and leave linked quantities alone.
- **Sync** is synchronous and transactional: every habit change that already recomputes the day (add, Undo, manager void/amend, any date in the seven-day backdating window or later corrections) also recomputes that day for every active link, in the same transaction. There is no queue, so no pending state: what the goal shows is what is committed. An idempotent retry of a habit contribution changes nothing. A goal that is archived, in the trash, or a period in the trash is not touched while hidden; unarchive, restore (goal or series) and a newly created period recompute their links from the habit's data.
- **Lock order:** habit → series → goal (ascending id within each kind). Goal-side writes never take a habit lock; anything that rebuilds link rows from goal side holds the goal lock, and every habit-side recompute takes the goal lock before reading it, so both sides end equal.
- **Ended periods:** a correction or backdating of a habit day that falls in an ended period recomputes that period's outcome alone (S30b `recheck_goal_outcome`: corrected, outcome_changed, needs review for an explicit achievement taken below target). Nothing moves to another period.
- **Achieved goals** keep syncing (125/100); no second achievement, event or celebration. Manual contributions to an achieved goal stay refused as in S30.
- **Set total** (manager) sets the total, but never below what linked habits contribute (`below_linked`); a correction that would take the manual part below 0 answers `negative_total`.
- **Start choice:** from today (the habit's today: includes entries already made today), from a chosen past date (not before the habit's first start date, not after today), or from the habit's beginning (its first start date). Entering older history is not permission to backdate new entries.
- **Preview first:** create, change start and unlink take `dryRun`. The preview shows habit and goal, start and range, units and conversion, eligible linked amount (historical, from start until today), days not counted (incompatible), manual part, linked before/after, total after and percentage, reached before/after, whether the goal is achieved (no change), and for a series each affected existing period (before/after, ended, outcome before/after). Confirming recomputes; if the amount or the goal/series revision changed, the answer is `stale` with the new preview.
- **Change start date:** the same preview and confirmation; days before the new start drop out, days from it count.
- **Unlink:** choose **keep** (the linked amount of each goal becomes one manual adjustment, source `link`, so the total does not change) or **remove** (the linked amount leaves the goal; ended periods recompute their outcome). Preview per goal. Future habit changes no longer reach the goal. A warning reminds that manual progress representing the same activity should be reviewed.
- **Source gone:** a habit archived or in the trash cannot change, so its link keeps its amounts and shows "source archived / in trash"; restore continues. When the habit is purged, the link keeps its amounts, frozen ("source deleted"), until a manager unlinks it.
- **History:** goal events `link_created`, `link_changed`, `link_removed` (series events the same for series links), with ids, dates and numbers only; Home audit events `goal.link_*` / `goal_series.link_*`. Per-day linked changes write no event (the ledger is the record), like habit contributions.
- **Limits:** 10 active links per goal or series, 10 per habit.

## Who may do what

Creating, changing the start of and removing a link needs **manage** on both sides: the goal (Owner, Administrators with `manageHomeGoals`; personal: the owner) and the habit (Owner, Administrators with `manageHomeHabits`; personal: the owner). Viewers of a goal see its links (habit name, start date, linked amount, state); viewers of a habit see its linked goals. No contributor names reach the goal: only daily totals per link.

## Interface

- **Goal page** (measurable, not a period): progress breakdown (Manual · From linked habits); **Linked habits** section with each link (habit, from date, amount, warning), Link a habit, Change start, Unlink (managers). The link dialog lists the eligible habits (numeric, same context, managed by the person, compatible unit), the start choice, and the preview before Confirm.
- **Series page:** the same Linked habits section for the series; a period's goal page shows its breakdown and the series' links read-only.
- **Habit page:** **Linked goals** (goal or series title with link, from date).
- Over-target totals show as "125 / 100 km · 25 over target".

## API

`GET /api/v1/goal-links?goalId=|seriesId=|habitId=` (exactly one; the links as the person may see them), `GET /api/v1/goal-links/candidates?goalId=|seriesId=` (the eligible habits), `POST /api/v1/goal-links` (`id`, `goalId` or `seriesId`, `habitId`, `start` `today`/`date`/`beginning`, `startDate`, then `preview: true` or the preview's `revision` and `expectedAmount`), `PATCH /api/v1/goal-links/:id` (new start, preview/confirm), `POST /api/v1/goal-links/:id/unlink` (`keep`/`remove`, preview/confirm). A stale confirmation answers 409 with the new revision and preview. Same CSRF, JSON, size, session and outcome mapping as the goal routes.

## Database (`20261115090000_habit_goal_links.sql`)

Tables `goal_habit_links`, `goal_link_days`; `goal_entries.source` gains `link`; goal and series event kinds gain the link kinds. `goal_total` includes the linked ledger. Wrapped (renamed and called, as S30b did): `habit_numeric_sync`, `create_goal_period`, `add_goal_entry` (below_linked), `update_goal_entry` (manual part), `change_goal_target` and `change_goal_series_target` (linked_unit), `archive_goal`, trash restore. `goal_summary_json` gains `manualTotal`, `linkedTotal` and `linkCount`; links are read with `get_goal_links` and `get_goal_link_candidates`.

## Tests

- **Database:** link create (today with earlier same-day entries, chosen date between entries, beginning, older than seven days), preview equals result; several days sum exactly; above-target days; km/m conversion and rounding; incompatible units refused; later incompatible habit unit counts 0 with a warning; two habits into one goal; one habit into a monthly and a yearly series (one entry counts once in each); duplicate link refused; Undo, backdating, manager amend/void recompute; correction in an ended period flips the outcome (corrected) and an explicit achievement keeps it with needs review; achieved goal keeps syncing to 125/100 and no second achievement; set total below linked refused; unit change refused while linked; change start; unlink keep (total unchanged, adjustment) and remove (total drops, outcome recheck), other links untouched; stale preview; archived goal not synced, unarchive recomputes; habit purge freezes; permissions (member, view-only, manager without habit capability, non-member, cross-Home, personal ↔ Home, forged ids). **Concurrency:** habit contribution racing link creation; habit contribution racing goal unarchive; two habits' contributions into one goal.
- **Unit:** schemas, routes, conversion helper, components with axe.
- **Playwright ("Habit to goal"):** create a numeric km habit and a measurable goal, add progress, link from the beginning with the preview, see the breakdown, correct a habit day and see the goal total recalculate, unlink keeping the amount.

## Out of scope (this step)

Pausing a single link (unlink and link again instead), moving a link to another goal (unlink and link), links across contexts (personal ↔ Home), weekly-schedule habits (not numeric), Household Display rendering, Ora, a widget change.

## Defaults picked (Ward may override)

1. Links only within one context (personal ↔ the same person's personal goal, Home ↔ the same Home's goal).
2. Both sides need manage permission to link, change or unlink.
3. Sync runs in the same transaction as the habit change (no job, no pending state).
4. A goal with active links keeps its unit; identical custom labels link, other custom units do not; m→km style conversions round each day to 3 decimals.
5. Set total never goes below the linked amount; achieved goals keep syncing.
6. Unlink asks keep (becomes a manual adjustment) or remove; no link pause.
7. 10 links per goal or series and per habit.

## Progress

- [x] Brief
- [x] Migration
- [x] Database tests
- [x] API and data layer
- [x] Interface
- [x] Unit, route and component tests
- [x] Playwright
- [x] Docs (ADR 0040, user stories, supabase-migrations, production-migrations, roadmap)
- [x] Full suite
- [x] Independent review (PASS; reviews/steps/S30c-review.md; L1 fixed, M1–M3 and L2–L6 for Ward)
