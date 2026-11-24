# UX2-data — Dashboard drafts, version history and personal Home views (data only)

Branch: `feat/dashboard-drafts-data` · Model: Opus (RLS, privacy, concurrency) · No UI.
Source: `plans/steps/UX00-redesign-plan-brief.md` (matrix B rows 6, 32, 33/34; section 7 privacy rules),
`docs/design/dashboard-ux-ui-redesign.md` Decisions 6, 32, 33, 34. ADR 0059.

## Scope

- Server drafts per person and dashboard target, 30-day retention, rebase-or-discard data, atomic Done.
- 10-version history per target, restore as a new commit (with Undo).
- Personal Home views ("My Home view") next to the shared default, plus suggestion data and dismissals.
- Privacy export, cascades on account / Home / membership deletion, revocation handling, RLS/RPC tests.
- This is the only thread that changes `get_dashboard` / `save_dashboard`; UX2b-UX2d build the UI on them.

Out of scope: any UI, the API routes for the new RPCs (UX2b/UX2c/UX2d add them with the screens that use them),
a scheduled purge job (the lazy purge covers it; a job can call `private.purge_expired_dashboard_drafts` through a
service-role wrapper later), wall-display layout (UX8).

## Done-condition

1. Drafts never change the committed layout; one per person and target; refused for outsiders, forged Homes and
   plain Members on the shared default; discarded when `manageHomeDashboard` is lost; survive a failed Done.
2. History holds the 10 newest commits per target from the stored row; restore makes a new commit; shared-default
   history only for editors, never revealing who saved.
3. A member's Home view is private to them, never changes the shared default, ends when they leave; members
   without one keep getting the shared default; new shared widgets become suggestions until added or dismissed.
4. New tables in the personal export; cascades verified; private schema, grants revoked, typed bindings regenerated.
5. Existing callers unchanged (legacy calls pass no target).

## Defaults picked (reversible, no approved UX changed)

- Targets: `personal` / `default` / `mine`; `effective` for reads. Null target = legacy meaning.
- Separate table for Home views (not a third owner kind of `dashboard_layouts`), keyed to the membership.
- Draft retention **30 days** after the last autosave (`private.dashboard_limit('draft_days')`).
- Adults only for drafts and Home views (children and Household Display accounts excluded).
- Shared-default history visible to editors only (Owner + `manageHomeDashboard`).
- Reset of a Home view deletes the view, its history and its draft (the UI confirms first, Decision 33).
- Personal and Home-view versions store no `saved_by` (always the owner): one cascade path on account deletion.
- Existing saved layouts are backfilled with their current layout as the first history entry.
- Suggestions: the remembered set only grows (every widget the view ever held, what the member was shown when the
  view started, dismissals), capped at 400 keeping on-screen ids. **UX2d must pass the layout it showed (shared
  default or starter) as `p_previous` on the first `mine` save**, and must filter suggested widget types the member
  cannot use (Decision 34 permission scoping; review L6).
- A shared-default draft is exported as metadata only (Home-owned content).

## Files

- `supabase/migrations/20261219090000_dashboard_drafts_history.sql` (new; timestamp reserved with the coordinator)
- `tests/db/rls/dashboard_drafts_history.test.sql` (new multi-actor RLS/RPC tests)
- `tests/db/rls/dashboard-views-concurrency.test.ts` (new: racing first view saves, restore vs save)
- `packages/database/src/database.types.ts` (regenerated)
- `docs/adr/0059-dashboard-drafts-history-overrides.md`, `docs/provider-cost-register.md` (storage note)

## Migration and rollback

Additive tables; three functions re-created with extra defaulted arguments (named-argument callers unaffected);
`collect_data_export` re-created with three extra export files. Deploy order: migration first, web unchanged.
Rollback in ADR 0059. `docs/production-migrations.md` needs the new file added to its ordered list by the owner's
docs commit after merge.

## Progress notes

- 2026-11-19: brief read, Opus chosen, migration drafted.
- 2026-11-24: resumed after an interruption; rebased on main (no new migrations there). Fixed: memberships are the
  view `public.home_memberships` over `private.home_memberships_all` (FKs and triggers target the table);
  competing cascade paths on account deletion (saved_by only on shared-default versions).

## Local checks (Ward's testing rule: only relevant tests)

- Throwaway PostgreSQL 16 cluster with shim + all migrations + seed: migration applies.
- DB tests: new `dashboard_drafts_history`, plus `dashboards`, `dashboards-concurrency`, `baseline`,
  `privacy_exports`, `account_lifecycle`, `deletion`, `homes`, `roles`, `ownership`, `household*`: 13 passed.
- Typecheck + lint: `@madeora/web`, `@madeora/database`, `@madeora/db-tests`: passed. Prettier on changed files: passed.
- Web unit tests for dashboard routes/helpers: 60 passed. Full suite: CI.

## Review

`reviews/steps/UX2-data-review.md`: CHANGES_REQUIRED, 1 HIGH, 2 MEDIUM, 7 LOW. Fixed and verified by the author
(no second full review, per project rule):

- H1 (suggestions reappeared): known set now grows on every view commit, is never pruned to the current default,
  and takes the shown layout (`p_previous`) at view start. Tests: added-then-removed, removed-and-restored default
  widgets, view started from the starter.
- M1: tests added for ownership transfer, Home purge cascade, `has_draft` on `mine`, and a concurrency file.
  Household Display accounts remain covered by code only (`can_customize_dashboard` uses `private.is_display`).
- M2: reset/leave/account-deletion history checks now use the saved view id and check `override_id` orphans.
- L1 cap trims instead of failing; L2 Undo rejects a null/negative revision; L3 ADR reworded (scheduled purge
  job before release); L4 shared-default drafts exported without layout; L5 accepted (MVP scale); L6 handed to
  UX2d; L7 owner adds the migration to `docs/production-migrations.md` after merge.

Re-run after fixes: new SQL tests + 2 concurrency files + related suites, 15 passed; db-tests lint/typecheck passed;
types check up to date.
