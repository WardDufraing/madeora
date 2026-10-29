# S30 goals core: independent review

- **Branch:** `feat/goals` (uncommitted working tree), diff `s30.diff` (11,217 lines; `docs/production-migrations.md` spot-checked: the migration SQL is appended verbatim, and the reset section names the new functions and version `20261113090000`).
- **Reviewer:** an independent agent with fresh context. This is not a GitHub human approval.
- **Inputs:** `plans/steps/S30-brief.md`, `CLAUDE.md`, the relevant parts of `architecture.md`, PS L2916–3019 and L3187–3194, and the habit module for comparison.
- **Checks I ran:** `apps/web` `vitest run src/components/goals src/goals src/app/api/v1/goals`: 3 files, 50 tests passed. `packages/domain` goals and goal-permission tests: 15 passed. `packages/jobs` `goals.test.ts`: 4 passed. `apps/web` `tsc --noEmit`: clean. en/nl message keys: identical sets.
- **Not run:** the database tests (`tests/db/rls/goals.test.sql`, `goals-concurrency.test.ts`) and Playwright (`tests/e2e/specs/goals.spec.ts`). No database was available. The brief's own progress list still has Playwright and the full suite unchecked.

## Verdict: **CHANGES_REQUIRED**

There is one HIGH finding: the contribution ledger does not record units, so a confirmed unit change loses the unit history for good. Everything else is MEDIUM or LOW.

---

## Findings

### HIGH-1: The ledger and history do not record the unit, so a unit change loses the history's meaning

- **Where:**
  - `supabase/migrations/20261113090000_goals.sql:168-188`: `goal_entries` has no unit and no unit kind.
  - `:208-219`: `goal_achievements` stores `total` and `target`, but not their unit.
  - `:956-958`: the `target_changed` event stores only `unitChanged: true`, not the unit before and after. The `impact` object computed at `:927-932` has them but is thrown away.
  - `apps/web/src/components/goals/goal-detail.tsx` (achievement history, about L219-221) and `goal-history.tsx` (entry lines): past totals and entries are drawn with the goal's _current_ unit.
- **Impact:** PS L2972 is binding: "Every measurable-goal contribution records its signed or positive numeric change as appropriate, **unit**, contributing member, timestamp and optional note". The brief lists the ledger fields without the unit, but the specification wins.
  - After the confirmed change from 100 km to 90,000 m that the DB test makes (`goals.test.sql:298-303`), nothing in the database records that the earlier entries and the achievement "114.7 / 100" were in km.
  - The page then shows "114.7 / 100 m" as achievement history. That is misleading, and it cannot be repaired afterwards.
  - S30c also requires "use historical source units … do not retroactively revalue history because a current target or unit changes" (L2921), which needs per-entry units.
  - Fixing this now is one small change. After merge it needs a new migration and an unreliable backfill.
- **Remediation:**
  1. Add `unit text not null` and `unit_kind text not null` to `goal_entries`, filled from the goal on insert (`create_goal`, `add_goal_entry`). Add the same pair (nullable) to `goal_achievements`.
  2. Record `unitBefore`, `unitKindBefore`, `unitAfter` and `unitKindAfter` in the `target_changed` details.
  3. Render entries and achievements with their own unit. Where it differs from the goal's unit, show it, for example as "recorded as km".
  4. Add a DB test: a unit change keeps the old unit on earlier entries and achievements.
  5. Alternatively, get Ward's explicit sign-off that a goal-level unit is enough and note it in ADR 0038. Even then, the event must keep the before and after units.

### MEDIUM-1: History events differ from the brief's list; deadline changes keep no values

- **Where:** `supabase/migrations/20261113090000_goals.sql:251-254` (`goal_events_kind_check`), `:872-873` (`edited` details are `{deadline: bool, timeZone: bool}`).
- **Impact:** The brief's history list names `unit changed`, `deadline changed`, `contributed` and `reversed`. None of these is an event kind.
  - Reversal is folded into `corrected` (with `action`). Contributions live only in the ledger. Unit and deadline changes are booleans on other events.
  - Deadline changes keep neither the old nor the new date, so the history cannot say what the deadline was. PS L2965 asks that "changes and corrections must respect existing activity/history".
  - ADR 0038 does not record this departure from the brief.
- **Remediation:** Store `deadlineBefore` and `deadlineAfter` (dates are not sensitive) in the `edited` details, together with the units from HIGH-1. Then either add the missing kinds, or update the brief and ADR to say that contributions and reversals are covered by the ledger and corrections table.

### MEDIUM-2: Brief-listed reminder tests are missing

- **Where:** `tests/db/rls/goals.test.sql:398-462`.
- **Impact:** The brief's Tests section requires these reminder cases, which are not covered:
  - **Archived goal suppresses delivery.** Only the achieved case is tested (`:452`). An archived goal at delivery time is never exercised.
  - **Deadline change reschedules.** Only deadline _removal_ is tested (`:458-462`). A moved deadline should bump the reminder revision, make the old job answer `stale` and queue new moments; none of this is tested.
  - **Trashed goal at delivery** (should answer `stale`): not tested.
  - **Restore or unarchive requeues reminders:** not tested.
  - **Personal goal reminder:** that it reaches the owner, and that `set_my_goal_reminders` on a personal goal answers 22023, is not tested.
  - **DST:** PS L3018 lists "timezone and daylight-saving boundary" as an acceptance criterion. No moment test crosses a DST change.

  These are the paths behind the "never fire retroactively / stop when archived or deleted" requirement (PS L3016).

- **Remediation:** Add these assertions to `goals.test.sql`. For DST, assert `goal_reminder_moments` for a deadline next to the Europe/Brussels change dates.

### MEDIUM-3: The archived list is unbounded, and the list function recomputes a lot per row

- **Where:** `supabase/migrations/20261113090000_goals.sql:568-611` (`get_goals`). `apps/web/src/components/goals/goal-widget-settings.tsx` also reads `active` and `completed` in full.
- **Impact:**
  - The 100 limit covers only non-archived goals, and completed goals count towards it, so people have to archive. The archived view therefore grows without limit and has no paging.
  - For each row, `goal_summary_json` does a lot of work:
    - it selects the row again (`(select y from private.goals y where y.id = g.id)`);
    - it sums the **whole ledger** (`goal_total`);
    - it checks membership and capability two or three times (`goal_role`, `goal_may` for each action);
    - it reads the reminder and opt-out rows;
    - it calls `goal_for` again on `renewed_from`.
  - The counts CTE also runs `goal_status`/`goal_today` (a `homes` lookup) for every goal in the context.
  - The habits list has the same shape, but goals pile up faster because of renewals and follow-ups, and S30b instances will add more.
- **Remediation:** Page the `archived` view (keyset on `archived_at, id`, about 50 rows) and/or cap `completed`. Pass `g` directly instead of selecting it again. Compute totals with one grouped aggregate over `goal_entries` for the page's goal ids. Work out the viewer's role once per call (it is per context, not per goal).

### LOW-1: A tautological check constraint

`supabase/migrations/20261113090000_goals.sql:158`: `goals_achieved_check check ((achieved_at is null) or (achieved_at is not null))` is always true. It was probably meant as `(achieved_at is null) = (achieved_by is null)`, but `achieved_by` is `on delete set null`, so that version would break when an account is deleted. Remove the constraint, or replace it with something meaningful.

### LOW-2: The same client id raced across two different goals returns 500

`supabase/migrations/20261113090000_goals.sql:1001-1039`: the idempotency lookup is serialized by the _goal_ lock. Two concurrent calls with the same `p_id` on **different** goals each pass the lookup. The second insert then hits the primary key and raises `23505`, which `databaseFailure` maps to 500 `failed`. This is rare, because ids are client UUIDs. Remediation: catch `unique_violation` around the insert and answer `id_taken`. The `create_goal` path has the same race on `p_id` across contexts.

### LOW-3: Restoring from trash ignores the 100-goal limit

`supabase/migrations/20261113090000_goals.sql:1503-1521`: `trash_item_restore` does not recount non-archived goals, unlike `archive_goal` when unarchiving (`:1234-1243`). A context can go above 100 that way. Habits behave the same, so this is low priority. Either add the check (as a trash conflict) or document it.

### LOW-4: The 100 limit counts completed goals (needs an owner decision)

`supabase/migrations/20261113090000_goals.sql:784-787` and `:1237-1240`: achieved goals count towards the limit. The brief's default 7 ("non-archived") says exactly this. But over time, Renew and follow-up (and S30b instances) will force households to archive completed goals before they can create new ones. That works against PS L2979, which wants the Completed section kept as its own place. Ask Ward whether the limit should count only open (not achieved) goals.

### LOW-5: The widget does not explain a total that moved in the meantime

`apps/web/src/components/goals/goal-progress.tsx` (`useAddProgress` and `ProgressForm`): the server returns `totalBefore`, but the client never compares it with the total it showed. When another member contributed in between, the toast still says "Added X", and the preview total the person saw was wrong. Nothing is double-counted, because the add is additive. PS L3192 asks to "refresh and explain the new state". Remediation: when `totalBefore` differs from the total shown, say so in the success toast, for example "Total is now Y (others added Z meanwhile)".

### LOW-6: Contributions after achievement are refused (check against S30c)

`supabase/migrations/20261113090000_goals.sql:1018-1020`: `add_goal_entry` answers `achieved` for an achieved goal. That is acceptable for manual progress, and it is tested. But PS L2935-2938 (S30c) requires linked contributions to keep going after achievement ("manually achieve then progress to 125/100"). Note this in ADR 0038 so S30c does not reuse this guard for linked entries.

### LOW-7: Delivery trusts the revision, not the instant

`supabase/migrations/20261113090000_goals.sql:1426-1462`: `deliver_goal_reminder` never checks that `p_at` still equals the moment computed from the current deadline, time and zone. It relies on every change bumping the reminder revision. That holds today:

- a deadline or personal timezone change reschedules;
- reopen, unarchive and restore reschedule;
- a Home timezone cannot be edited.

A future editable Home timezone would quietly break it. Remediation: recompute the moment for `p_kind` and answer `stale` if it differs from `p_at`. This is cheap.

---

## Explicit checks

| Check                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements (brief and PS ranges)    | Mostly met: create, contribute, set total, correct and reverse, explicit Mark achieved, reopen with history, extend or follow-up, renew, archive, trash, member access, reminders and both widgets. Gaps: per-entry unit (HIGH-1) and the history detail (MEDIUM-1). S30b and S30c are correctly left out.                                                                                                                                                                                                                                                                                                                      |
| Cross-Home isolation                  | Pass. Every public function resolves the goal through `goal_for` or `goal_lock`, which apply `goal_may(view)`. A Home the caller is not in answers 42501, mapped to 404. Personal goals are owner-only in `goal_role`. `renewedFrom` is only shown when the viewer can see the source. `goal_notice_names` filters by access. The Goal progress widget refuses a goal from another context (`goal-widgets.tsx`). Tests cover personal invisibility to a Home owner, Home B isolation, a departed member, and notice names.                                                                                                      |
| Permissions (SQL vs TS)               | Pass. `private.goal_access` (is_home_member, then `manageHomeGoals` via `has_home_capability`, then the setting, default `contribute`) matches `goalAccess` in `packages/domain/src/permissions/goals.ts` and the new `home.goals.view` / `home.goals.manage` rules. The roles (`owner`, `administrator`, `member`) match the DB check. Actions follow the brief's table: contributors reverse only their own `contribution`, managers amend or reverse anything, completion achieve needs contribute, measurable achieve and reopen need manage. The server recomputes all of these; the client projection only guides the UI. |
| Secrets                               | Pass. No keys. Delivery is service-role only. Private helpers are revoked from the API roles, including the renamed `*_before_goals` dispatchers, which the `%goal%` pattern catches.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Input validation                      | Pass. Strict Zod schemas: decimal strings of at most 10.3 digits, numbers exact to 3 decimals, plain-text limits, UUID path ids, CSRF, JSON and an 8 KB body limit through the shared helpers. SQL re-checks everything: `valid_goal_quantity`, discrete units, `valid_goal_shape`, plain text, timezone, reminder ranges, and minute-precision times.                                                                                                                                                                                                                                                                          |
| Migration safety and rollback         | Pass. The migration adds tables and functions, and widens existing checks by drop and add. The trash dispatch rename follows the habits pattern. Grants and revokes are explicit, and no existing data changes. ADR 0038 covers rollback (forward-only; old code leaves goals unreachable but harmless). The production-migrations copy is verbatim. LOW-1 is a dead constraint.                                                                                                                                                                                                                                                |
| Concurrency                           | Pass. Every mutation takes `goal_lock` (`FOR UPDATE`) before reading the total. plpgsql runs in READ COMMITTED with a fresh snapshot per statement, so a retry that waited on the lock sees the committed entry and answers `exists`. Set total uses `p_expected_total`, so it answers `stale` rather than overwriting. A partial unique index allows one open achievement. The create limit uses an advisory lock. The concurrency test covers parallel contributions, duplicate ids, set-total vs contribution, and two achieves (not run here). LOW-2 is the cross-goal id race.                                             |
| Reminders                             | Pass on design. Only moments still ahead are queued (`m.at > now()`), so nothing fires retroactively. Each job is keyed by goal, revision and kind. The revision bumps on settings, deadline, zone, reopen, unarchive and restore. Delivery re-checks revision, enabled, trash, achieved, archived and deadline; it skips anything more than 30 minutes late and retries `not_due`. Recipients are re-checked through `goal_may` minus opt-outs, with category `reminders` and quiet hours handled in `notify_user`. Email copy names no goal and no progress. Test gaps are in MEDIUM-2.                                       |
| Test coverage                         | Good unit, route and component coverage (with axe), plus the domain matrix. The DB tests cover most of the brief. Gaps: MEDIUM-2 and HIGH-1 (no unit-history test). DB and Playwright suites were not run here.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Accessibility                         | Pass on review. The progress bar has `aria-valuenow` capped at 100 and an uncapped `aria-valuetext`. Status is shown as text, not colour alone. Icon and compact buttons have contextual `aria-label`s. The resulting total is announced (`aria-live="polite"`). Form alerts are announced, and user text is isolated with `bdi`. Axe runs in component and e2e tests.                                                                                                                                                                                                                                                          |
| Performance                           | MEDIUM-3: the archived list has no bound, and the list does several subqueries per row. Entry and event history are keyset-paged at 50.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Maintainability and habit consistency | Pass. The code mirrors the habit module closely: security-definer RPCs, outcome mapping, route helpers, `Read<T>`, the trash dispatch chain, the outbox job and the domain projection. The habit `parseQuantity` gained optional `limits` in a backward-compatible way (default behaviour unchanged, except that leading zeros no longer count towards the digit cap).                                                                                                                                                                                                                                                          |

## Remaining risks and test gaps

1. The DB RLS suite, the concurrency suite and Playwright have not been run by this review or, per the brief, by the full suite. CI must be green before PR readiness.
2. The reminder paths in MEDIUM-2 are untested: archived, trashed, moved deadline, restore and unarchive requeue, personal recipient, DST.
3. A Home timezone edit would bypass revision-based retirement of reminders (LOW-7).
4. LOW-4 (should completed goals count towards the limit?) is an owner decision.
5. Per-entry units (HIGH-1) also matter for S30c's habit-link ledger. Settle the column design before S30c starts.

## Fixes after review (implementer, verified 2026-10-29)

- **HIGH-1 fixed.** `goal_entries` and `goal_achievements` now store `unit` and `unit_kind` at the time they were recorded; `target_changed` events keep the unit before and after; the entry list, the correction dialog and the achievement history render each record in its own unit. Tests: DB assertion that earlier entries keep `km` after a confirmed change to `m` and that the event keeps both units; component test that an entry recorded in another unit shows it ("Starting value: 5 mi").
- **MEDIUM-1 fixed.** `edited` events keep the old and new deadline; ADR 0038 lists the recorded event kinds and why contributions and reversals live in the ledger. DB assertion added.
- **MEDIUM-2 fixed.** DB tests added for a moved deadline (new revision, both moments queued ahead, an old job does nothing), archived at delivery, unarchive requeueing, a trashed goal at delivery, and a personal goal reminding only its owner. A daylight-saving boundary test is not added (the moments reuse the S28 timezone helpers, which have them).
- **MEDIUM-3 accepted as a known limit** (archived view unpaged), recorded in ADR 0038.
- **LOW-1 fixed** (the always-true check is removed). **LOW-2 fixed** (`on conflict (id) do nothing` answers `id_taken` instead of a 500). LOW-3 to LOW-7 are recorded as known limits in ADR 0038; LOW-4 is the brief's default 7, open to Ward.
- Re-run after the fixes: DB suite (fallback) 30 files / 142 tests passed; web goal tests 50 passed; Playwright goals, shell and roles specs passed (roles-and-ownership is timing-flaky with parallel workers in this container and passes serially); format, lint and typecheck clean.
