# ADR 0040: Habit-to-goal links

- **Status:** Accepted for S30c within the approved architecture (§4, §6, §9, §15, §19, §21, §34, §36, §39, §43), CLAUDE.md (database access A, authorization C, forms A, internationalization A, date/time A, €0 budget) and the spec's habit-to-goal decisions (PS L2916–L2948, L2991–L3003). The defaults below are open to correction by the owner.
- **Date:** 2026-10-29
- **Step:** S30c (brief: `plans/steps/S30c-brief.md`), on top of numeric habits (ADR 0037), goals (ADR 0038) and recurring goals (ADR 0039).

## Context

The spec lets a numeric habit feed a measurable goal (or every period of a recurring series) automatically, from a chosen historical start, with one habit able to feed several goals independently, and with synchronization continuing after a goal is achieved. Corrections to the habit must recalculate the goal. The done-condition is that the "Habit to goal" journey passes, including a correction that recalculates.

## Decision

**A link is its own row.** `private.goal_habit_links` joins one numeric habit to one measurable goal or one measurable series, with an inclusive start date, a state (`active` / `removed`), a revision and the removal choice. At most one active link per habit and goal (or series); 10 active links per goal, series or habit. Links stay inside one context: a personal habit links only to the same person's personal goals, a Home habit only to the same Home's goals (`other_context`), so every viewer of a goal can already see the habit and nothing private crosses a context.

**Derived linked ledger.** `private.goal_link_days` holds one row per link and habit day: the day's active habit total in that day's habit unit, converted to the goal's unit (same unit or identical custom label as is; same preset dimension by exact factor, rounded half up to 3 decimals; otherwise counted 0 and reported as an uncounted day), and the goal or period it counts for. It is rebuilt, never edited, and is not a goal entry, check-in or contribution. A goal's total (`private.goal_total`) is its manual ledger plus its linked ledger, so every S30/S30b rule (over target, explicit Mark achieved, finalization and outcome rechecks of ended periods) applies to the sum.

**Synchronous sync.** `habit_numeric_sync` (the S29 function every habit quantity change already calls) is wrapped: after the day's check-in is derived it recomputes that day for every active link, in the same transaction. There is no queue and no pending state. Goal-side changes that make a goal visible again (unarchive, trash restore, a newly created period) rebuild its links from committed habit data under the goal lock. Hidden goals (archived, in the trash) are not touched. Achieved goals keep syncing without a second achievement. A correction in an ended period rechecks that period's outcome only.

**Lock order** is habit → series → goal, ascending ids within each kind. Goal-side writes never take a habit lock; habit-side recomputes lock the goal before reading it, so both sides converge.

**Preview and confirm.** Creating a link, changing its start and unlinking take a preview (`dry_run`) that reports the amount before and after, the uncounted days and, per affected goal or period, linked and total amounts before and after, reached before and after, achieved and outcome. Confirmation sends the preview's revision and amount; a mismatch answers `stale` with the new preview.

**Unlink** keeps the linked amount as one manual adjustment per goal (entry source `link`, total unchanged) or removes it (total drops; ended periods recheck their outcome). A goal or series with active links cannot change its unit (`linked_unit`), and Set total never goes below the linked part (`below_linked`).

**Permissions.** Creating, changing and removing a link needs manage on both the goal and the habit (`canManageGoalLink`, mirrored by `private.goal_link_manager`). Viewers of a goal see its links (habit, start date, amount, state); viewers of a habit see the goals it counts toward. Only daily totals per link reach the goal, never contributor names.

**Interface and API.** The goal and series pages get a Linked habits section (Link a habit, Change start, Unlink, each with a preview) and the goal's progress shows Manual · From linked habits; a period's page shows its series' links read-only. The habit page lists Counts toward goals. Routes: `GET/POST /api/v1/goal-links`, `GET /api/v1/goal-links/candidates`, `PATCH /api/v1/goal-links/:id`, `POST /api/v1/goal-links/:id/unlink`.

## Consequences

- Any new habit write that changes a day's quantity must go through `habit_numeric_sync`, or linked goals go out of date. Any new way to make a hidden goal visible again must call `private.goal_links_refresh_goal` (or `_series`).
- Any new write that takes both a habit and a goal lock must take the habit's first.
- Known limits, accepted for this step: no pausing a link or moving it to another goal (unlink and link again); no personal ↔ Home links; a purged habit leaves its link frozen with its amounts until a manager unlinks it.
- A personal export (S38) and account deletion (S40) must include links and the linked ledger.
- **Rollback and compatibility:** the migration adds two tables and functions, widens the goal entry source and the goal and series event kinds, and wraps `habit_numeric_sync`, `create_goal_period`, `goal_summary_json`, `add_goal_entry`, `update_goal_entry`, `change_goal_target`, `change_goal_series_target`, `archive_goal` and the trash restore (old versions renamed `*_before_links` in `private`). It changes no existing data; goals without links behave as before. It is forward-only; repairing it on production means a new migration. Rolling the app back to S30b code while it stays applied keeps linked amounts in goal totals, with no way to see or remove the links.
