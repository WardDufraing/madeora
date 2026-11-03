# S30c habit-to-goal links: independent review

- **Branch:** `feat/habit-goal-links` (uncommitted working tree on top of `main` at `0c55aec`).
- **Read:** the diff (`s30c.diff`, about 5,400 lines, refreshed once: the e2e spec now calls `test.slow()`); `supabase/migrations/20261115090000_habit_goal_links.sql` in full; the S29/S30/S30b functions it wraps or relies on (`habit_numeric_sync`, `update_habit_tracking` today-sync, `habit_access` / `habit_role` / `habit_may` / `habit_for` / `habit_lock`, `goal_access` / `goal_may` / `goal_for` / `goal_lock`, S30b `add_goal_entry`, `update_goal_entry`, `recheck_goal_outcome`, `create_goal_period`, `roll_goal_series`, `roll_goal_periods`, `sync_goal_periods`, series trash restore); `plans/steps/S30c-brief.md`; `docs/adr/0040-habit-goal-links.md`; spec `docs/product/Project-specification.md` lines 2916–3019 only; `CLAUDE.md`; the routes under `apps/web/src/app/api/v1/goal-links`; `apps/web/src/goals/{schema,data,api,route-helpers}.ts` changes; `goal-links.tsx`, and the changes to `goal-detail.tsx`, `goal-progress.tsx`, `goal-series.tsx`, `goal-history.tsx`, `habit-detail.tsx`; `packages/domain/src/goals/links.ts` and the permission helper; `tests/db/rls/habit-goal-links.test.sql`, `habit-goal-links-concurrency.test.ts`; `tests/e2e/specs/habit-goal-links.spec.ts` (read, not run). Spot-checked `docs/production-migrations.md`: the new consolidated block (lines 44544 onward) is byte-identical to the migration file (`cmp`), the reset version list contains `20261115090000`, and the reset lists name `get_goal_links`, `get_goal_link_candidates`, `create_goal_link`, `change_goal_link_start` and `remove_goal_link`.
- **Ran:**
  - Web unit, route and component tests for goals, goal links, goal series and habits: 166 tests, all green.
  - `tsc --noEmit` for `apps/web`: clean.
  - ESLint (`pnpm exec eslint`) on the changed web paths: clean.
  - Prettier `--check` on every changed or new TS, JSON and MD file: clean.
  - `packages/domain` goals and goal-permission tests: 26 tests, green.
  - en/nl message key parity: no missing keys on either side.
  - DB suite against the throwaway Postgres on `:54377`: `rls/sql-files.test.ts` (every `*.test.sql`), `habit-goal-links-concurrency`, `goals-concurrency`, `recurring-goals-concurrency` and `numeric-habits-concurrency`.
    - The first run, on a database that an e2e run had already written to, failed `habit-goal-links.test.sql` at "And the Home audit" (see L1). With that one assertion scoped to the test's own transaction, the whole file passed.
    - After the coordinator reset the database, the unmodified file and the concurrency test passed (43 tests).
  - Ad-hoc probes in transactions that were rolled back (described where they back a finding).
  - Grant check: no `private` function added here is executable by `anon` or `authenticated`. The five new `public` functions are not executable by `anon`, and every new or wrapped function is `security definer` with `search_path=""`.

**Verdict:** `PASS`

No BLOCKER or HIGH findings. The core works and is tested:

- the derived ledger keyed `(link_id, on_date)`
- synchronous recompute inside the habit lock
- the habit → series → goal lock order
- rebuild on unarchive, restore and new period
- freeze on purge
- the outcome recheck for ended periods
- the `below_linked`, `negative_total` and `linked_unit` guards
- same-context-only links

The MEDIUM items are gaps against the spec's preview and impact wording. They should be fixed, or explicitly accepted by the owner, before or soon after merge.

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

**M1. A confirmation is not stale when the goal's manual entries changed after the preview.**
`supabase/migrations/20261115090000_habit_goal_links.sql:854-862` (create), `:954` (change start) and `:1025` (unlink) only compare the goal or series revision (create) or the link revision (change and unlink), plus the linked amount. S30 manual entries (`add_goal_entry`, `update_goal_entry`) do not bump `goals.revision`. A target change, an achievement or a reopen bumps the goal revision, but change-start and unlink never look at it.
_Verified:_ in a rolled-back transaction, Alice previewed "from the beginning" on `g-km`: total after 24.5, reachedAfter false. She then added 80 manual km and confirmed with the preview's revision and amount. The answer was `created`, and the goal is at 104.5, reached.
_Impact:_ the person confirms numbers they did not see: total, percentage and "target reached". Spec L2932 (selectable start): "Recompute the preview from authoritative data at confirmation and require renewed confirmation if entries, permissions, units, goal state or link availability changed".
_Remediation:_ send and compare a fingerprint of what the preview showed. Either the per-goal `totalBefore` / `reachedBefore` / `achieved` of the impact, or a hash of the whole impact JSON computed in SQL. Answer `stale` on any difference. Add a DB case: "manual entry between preview and confirm → stale".

**M2. The preview does not show everything the spec and brief list.**
`goal-links.tsx:124-198` (`GoalLinkImpactSummary`) and `goal_link_impact` (`:596-659`).
- The manual baseline is neither returned per goal nor shown. Spec: "manual goal baseline". Brief: "manual part".
- No percentage is shown. Spec: "projected total and percentage". `progressText` is `{total} / {target} {unit}`.
- Ended periods show "its result is recalculated", but no outcome before/after. Brief: "outcome before/after". `outcomeBefore` is returned; there is no `outcomeAfter`, and the UI shows neither.
- The m→km rounding to three decimals is not stated (brief: "shown in the preview"). Only "Converted from m to km" is shown.
_Impact:_ the confirmation is less explicit than the approved requirement. The numbers shown are correct.
_Remediation:_ add `manualTotal` and `outcomeAfter` to each goal of the impact, and render the manual part, the percentage after (capped visually only), and outcome before → after for ended periods. Add "rounded to 0.001 per day" to the units line when the conversion can round.

**M3. Archiving or deleting either side shows no link impact.**
Spec L2922: "Linking, unlinking, changing the effective date, moving to a different goal, **archiving or deleting either side** must show the exact impact before confirmation."
The diff leaves the habit archive and delete dialogs and the goal archive and delete dialogs unchanged. Archiving a habit silently freezes its links, and purging it freezes them for good. Archiving a goal or putting it in the trash silently stops its sync until it comes back.
_Verified:_ by reading. No habit or goal dialog in the diff mentions links, and `linkCount` is not used outside the progress meter.
_Remediation:_ in those confirmations, add one line when `linkCount > 0` (goal) or when the habit has active links (habit). For example, "N linked goals keep their amounts; new quantities stop counting until you unarchive", with the link list from `GET /goal-links?habitId=`.

### LOW

**L1. A DB assertion counts audit rows across the whole database** (`tests/db/rls/habit-goal-links.test.sql:304-305`). `count(*) = 1 from private.audit_events where action = 'goal.link_created'` fails on any database where links were created before. That happened here after an e2e run. _Remediation:_ add `and occurred_at = now()` (the transaction's own rows), or filter by `home_id = tests.i('home-a')` and the subject.

**L2. Multi-series lock order differs from the S30b context sync.**
- `goal_links_after_habit_day` (`:269-272`) locks a habit's linked series by `id`.
- `sync_goal_periods(p_home_id)` (S30b `20261114090000_recurring_goals.sql:~525-533`) rolls due series one by one in `next_roll_at, id` order and keeps each lock.

A habit linked to two series that are both due, with different `next_roll_at` and the opposite id order, can deadlock: a contribution racing a goals-list read. PostgreSQL aborts one side with 40P01, so data stays consistent, but the person gets an error.
The window is small: both series must be due at once with different roll moments. The hourly job uses `skip locked` and is not affected.
_Remediation:_ order the context sync by `s.id` (or use `skip locked` there, as the job does). Alternatively, lock the series on the habit side in the same `next_roll_at, id` order. Document the rule in ADR 0040.

**L3. Changing the start of a link whose one-off goal is archived gives a misleading preview** (`:884-967`).
- Create refuses an archived goal (`archived`), but `change_goal_link_start` does not.
- `goal_link_impact` drops non-syncable goals, so the preview shows 0 → 0 linked, while the stored rows keep the old start until the goal is unarchived.
_Verified:_ by probe. The answer was `preview` with `linkedBefore 0`, `linkedAfter 0` and `syncable false`, and the goal was still at 104.5.
_Remediation:_ answer `archived` for an archived goal, as create does, and hide Change start for archived goals.

**L4. A stale preview stays on screen after the form changes** (`goal-links.tsx:236-240, 300-327, 475-478`).
- `stale` is derived from `send.error`, and `send.error` persists when the person changes the habit, start or unlink mode. Those changes only clear `preview`.
- After a `409 stale`, switching to another habit (or from keep to remove) keeps the old impact visible with a Confirm button.
- Confirm then sends the new choice with the old revision and amount. The server accepts it when the amounts coincide: for example, two habits with 0 from today, or keep versus remove, which both use `amountBefore`.
_Remediation:_ reset the mutation (`send.reset()`) in every `onChange`, or key the shown impact on the request it was made for.

**L5. `remove_goal_link` locks the habit before checking access** (`:999`). It reads the link by id and then takes `for update` on its habit with no permission check. A caller who knows a link id from another Home can briefly lock that Home's habit. Link ids are random UUIDs, so this is a theoretical contention issue only. _Remediation:_ check `goal_for` / `goal_series_for` visibility first, or use the existing pattern (lock through a function that checks view access, falling back to a plain lock only for a trashed habit the caller may see).

**L6. Per-day habit changes leave no trace in the goal history.** This is an owner default in the brief: "the ledger is the record". The spec asks for audit history of "resulting goal adjustments". Only ended-period `outcome_changed` events (with no actor) appear. The current total can change with nothing in the goal's change log to explain it. _Remediation (optional):_ show a "From linked habits, by day" view (the ledger, totals only) on the goal page, or accept explicitly in ADR 0040.

## Explicit checks

- **Requirements (spec L2916–3019, brief, done condition):** met:
  - opt-in links
  - compatible units with exact factors and per-day rounding
  - incompatible units refused, and later incompatible versions counted 0 with a warning
  - the three start choices: today includes earlier-today entries; a chosen date is bounded by the first start and today; beginning includes history older than seven days
  - exact sums and above-target days
  - one entry counted once per goal and once in each distinct goal (monthly plus yearly series)
  - duplicate links refused (`already_linked` plus partial unique indexes)
  - manual plus linked breakdown
  - Undo, backdating, and manager amend and void recomputing in the same transaction
  - the tracking change for today recomputes through the same hook
  - ended-period outcome recheck with needs-review kept for explicit achievements
  - achieved goals keep syncing without a second achievement
  - `below_linked` and `negative_total`
  - `linked_unit` on goals and series
  - change start
  - unlink keep (one `source = 'link'` adjustment per goal, total unchanged) and remove
  - archived and trash sides left alone and rebuilt on return
  - purge freezes
  - limits of 10

  Gaps: M1 (stale rule), M2 (preview items) and M3 (archive or delete impact). The done-condition journey (link with preview, an Undo recalculates, unlink keeps) is covered by `tests/e2e/specs/habit-goal-links.spec.ts`; I read it but did not run it.
- **Cross-Home and personal isolation:**
  - Links require `owner_home_id` equality, or the same personal owner (`other_context`), so no link crosses Homes or exposes a personal habit.
  - Habit and goal visibility are both context-wide (`habit_access` / `goal_access`: any current member sees), so a goal viewer never learns of a habit they could not see.
  - `get_goal_links(habitId)` filters destinations by visibility.
  - Only daily totals are stored; contributors are never named (`createdBy` names the link's creator only).
  - Home B access gives `not_found` / `null` (tested).
- **Permissions:**
  - Create, change and unlink need manage on both sides (`goal_link_manager`), or only on the goal side once the habit is purged.
  - Tested: a member, an Administrator with `manageHomeGoals` only, a non-member, cross-Home, personal ↔ Home. Viewers read links, and candidates are empty for non-managers.
  - Rechecked under the locks after the link is re-read.
  - The client projection (`canManageGoalLink`) mirrors the SQL and is UI-only.
- **Forged ids:**
  - An unknown or invisible habit, goal, series or link gives `not_found`.
  - An id reused for another habit or goal gives `id_taken`; the same retry gives `exists`.
  - A period id passed as a goal gives `series_period`.
  - Zod strict objects and the "exactly one" refines match the SQL 22023 checks.
- **Secrets:** none added. No service-role use.
- **Input validation:**
  - Zod: uuid ids, local-date start, enum start and mode, revision ≥ 1, an `expectedAmount` of at most three decimals and at most 1e9, `preview` or both confirmation fields.
  - SQL rechecks every field and the date bounds.
  - Table checks back the rules: one destination, the removal pair, `source_quantity > 0`, `counted or quantity = 0`.
- **SQL security-definer safety:**
  - Every function has `set search_path = ''` and schema-qualified references.
  - The wrapped S30/S30b `public` functions were renamed, revoked and moved to `private`.
  - The final loop revokes every `private` goal and habit function from API roles (verified on the live catalog).
  - The tables are RLS-enabled with all privileges revoked (tested as denied).
  - The late-bound wrappers (`habit_numeric_sync`, `create_goal_period`, `goal_summary_json`, `trash_item_restore`) are picked up by existing callers, and no `begin atomic` bodies exist that would pin the old ones.
- **Lock order, deadlocks and races:**
  - Habit → series (id order) → goals (id order) on the habit side.
  - Create, change and unlink take the habit first, then the destination.
  - The goal side (unarchive, restore, roll, new period) never takes a habit lock and rebuilds from committed data while holding the goal or series lock.
  - Under READ COMMITTED each later statement sees the other side's commit, so both orders converge. I traced contribution vs unarchive, contribution vs restore, and contribution vs rollover.
  - Concurrency tests cover link vs contribution, unarchive vs contribution, and two habits into one goal.
  - One residual ordering mismatch: L2.
- **Derived ledger under Undo, amend, backdate, unit changes, archive, trash, restore and purge:**
  - Undo, amend, void and backdate recompute the day, and a day falling to 0 deletes its row and rechecks the outcome.
  - Tracking changes only take effect today or later, and today's recompute runs through `habit_numeric_sync`.
  - The goal unit is frozen while linked. Series future targets are checked for compatibility when linking and frozen afterwards.
  - A hidden goal is skipped and rebuilt on its return.
  - A habit in the trash or archived cannot change. A purge sets `habit_id` to null and freezes the rows.
- **Ended-period rechecks:** `goal_link_refresh` rechecks every goal whose rows changed, and unlink rechecks every goal in the impact. Tested: a correction flips the outcome (corrected), and an explicit achievement is kept with needs review.
- **Stale preview handling:** linked amount and revision only (M1). The UI keeps a stale impact across form changes (L4).
- **Migration safety and rollback:**
  - Forward-only and additive. Constraints are widened with drop/add.
  - The renames keep signatures; grants are re-applied.
  - The consolidated production block is byte-identical to the migration, and the reset lists are updated.
  - Rollback is the documented destructive reset. There is no data-preserving down migration, as in earlier steps.
- **Test coverage:**
  - Strong: 577 lines of SQL covering the brief's list, plus 3 races, schema, route, domain and component tests (with axe), and the Playwright journey.
  - Gaps: stale on manual change (M1), change start on an archived goal (L3), the multi-series lock order (L2), habit tracking-unit change for today on a linked habit (covered only through the later incompatible version case).
- **Accessibility:**
  - The section uses `aria-labelledby` headings.
  - Links have visible text with `<bdi>` for names.
  - Warnings use `role="note"`, and stale and failure messages are announced `FormAlert`s.
  - Dialogs reuse the shared accessible `Dialog`, `SelectField` and `TextField` (with min and max on the date).
  - The destructive confirm is a labelled button.
  - axe passes in the component tests and in e2e.
- **i18n:** every new string exists in en and nl (parity checked). ICU plurals are used for day counts, dates go through `texts.date`, and amounts and unit names through the numeric formatter.
- **Performance:**
  - The habit-side hook costs one indexed `exists` when the habit has no links.
  - A full rebuild is linear in the habit's contribution days and runs only on link, change, unarchive, restore or new period.
  - `goal_summary_json` now runs two indexed sums plus a count per goal; fine at MVP scale, but lists call it once per goal.
- **Maintainability:** the wrapper-by-rename pattern adds a layer (as in S30b), but every hook has a comment pointing to the brief and ADR. The conversion rule is mirrored in `packages/domain/src/goals/links.ts`, with a cross-reference.

## Remaining risks and test gaps

- The Playwright spec (`tests/e2e/specs/habit-goal-links.spec.ts`) was not run in this review. CI must run it.
- Spec items left to owner acceptance:
  - identical custom labels link (spec: "reject … custom-unit conversions without an approved mapping"; brief default 4)
  - no per-day history entries (L6)
  - no link pause or move (brief: out of scope)
  - a frozen purged-habit link stays until a manager unlinks
- The habit side holds series and goal row locks for the length of a contribution. With 10 links per habit this is bounded, but a busy shared series serializes contributions of all its linked habits.
- A personal habit and a personal series can use different time zones. Days map to periods by local date, without conversion. This is consistent and deterministic, but around midnight a "today" entry can fall in a period that the series' own today has not reached yet. That is untested.

## Follow-up by the implementer

- L1 fixed: the audit assertion in `tests/db/rls/habit-goal-links.test.sql` now counts only the test goal's rows. Full DB suite re-run: 32 files, 150 tests pass.
- M1–M3 and L2–L6 are left for the owner to fix in a follow-up or accept.
