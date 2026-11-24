# ADR 0059: Dashboard drafts, version history and personal Home views (data layer)

- **Status:** Accepted. Implements the data part of redesign phase UX2 (`plans/steps/UX2-data-brief.md`; `plans/steps/UX00-redesign-plan-brief.md` section 7; redesign Decisions 6, 32, 33, 34). Extends ADR 0021 (dashboard engine).
- **Date:** 2026-11-24
- **Decided by:** Ward approved the redesign decisions and the supersession of "Home dashboard layout is shared" (2026-11-19, `docs/design/design-decisions.md`). The engineering choices below are reversible and change no approved UX.

## Decisions

1. **Three dashboard targets.** `personal`, `default` (a Home's shared default, the S17 Home dashboard) and `mine` (a member's personal view of one Home). Existing callers pass no target and keep their behaviour; `effective` (reads only) answers the member's view when one exists, otherwise the shared default.
2. **Personal Home views live in their own table** (`private.dashboard_member_overrides`), not as a third owner kind of `dashboard_layouts`. A query on the shared default can then never pick up a member's private view by mistake. The view is keyed to the membership (foreign key to `private.home_memberships_all` with `on delete cascade`), so leaving, removal, Home deletion and account deletion end it.
3. **Drafts are server rows** (`private.dashboard_drafts`), one per person and target, never browser storage (Decision 6). A draft stores the revision it started from; when the target has moved on, the UI offers rebase-or-discard. `save_dashboard(..., p_commit_draft => true)` commits and discards the draft in one transaction (Done); on a conflict the draft stays. Retention: **30 days after the last autosave**, enforced on read and by a bounded purge on every autosave.
4. **Losing edit rights discards a shared-default draft.** Triggers on a revoked `manageHomeDashboard` grant and on role changes, plus a check on every read and commit.
5. **History** (`private.dashboard_layout_versions`) keeps the 10 newest committed layouts per target, written inside the commit from the stored row. Restore is a new commit with one-step Undo. Shared-default history is listed only to people who may edit it, and never says who saved a version (only "saved by me").
6. **Suggestions** (Decision 34) are computed: shared-default widgets missing from a member's view, minus the widgets the view already knew when it started and those dismissed. No separate table.
7. **Adults only.** Child and Household Display accounts cannot keep drafts or views (`private.can_customize_dashboard`).
8. **Privacy export.** The personal export's account category adds `account/dashboard_drafts`, `account/dashboard_home_views` and `account/dashboard_history` (personal and own Home-view history; shared-default history is Home data).

## Consequences

- `get_dashboard`, `save_dashboard` and `undo_dashboard_change` changed signature (new defaulted arguments); every existing app call uses named arguments and keeps working. UX2b-UX2d build the UI on these functions.
- Rollback: drop the three new tables and the new functions, restore the three S17 functions from `20261025090000_dashboards.sql` and `public.collect_data_export` from `20261126090000_privacy_exports.sql`. Drafts, history and Home views are lost; committed personal and shared-default layouts are untouched.
