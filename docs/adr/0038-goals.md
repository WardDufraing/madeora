# ADR 0038: Goals core

- **Status:** Accepted for S30 within the approved architecture (§4, §6, §9, §15, §19, §21, §34, §36, §39, §43), CLAUDE.md (database access A, authorization C, background processing B, forms A, internationalization A, date/time A, dashboard layout B, €0 budget) and the spec's goal decisions (PS L2916–L3019, L3187–L3194). The defaults below are open to correction by the owner.
- **Date:** 2026-10-29
- **Step:** S30 (brief: `plans/steps/S30-brief.md`). Ward split the goal decisions into S30 (this core), S30b (recurring series) and S30c (habit-to-goal links). Reuses the S29 unit catalogue and exact-decimal rules (ADR 0037).

## Context

The spec asks for measurable and completion goals in a Personal space or a Home, collaborative contributions with attribution, an explicit Mark achieved with a kept history, guided renewal, optional deadlines with reminders, and interactive widgets. The done-condition for this core is that create, contribute, correct, achieve, reopen, renew and archive work with RLS tests across Homes, concurrent contributions sum exactly, and deadline reminders never fire retroactively.

## Decision

**Context and timezone.** A goal belongs to one person's Personal space or one Home. A Home goal uses the Home's timezone; a personal goal stores its own (the creator's effective timezone by default). Deadlines are local calendar dates; Overdue is a label, never a failure, and changes nothing else.

**Progress is a ledger.** `private.goal_entries` is append-only: `initial` (the baseline), `contribution` (positive) and `adjustment` (a manager's "set total", stored as the signed difference). A correction amends or reverses an entry and is recorded in `goal_entry_corrections` with before, after, actor and optional reason. The total is the exact decimal sum (`numeric(13,3)`) of active entries; anything that would make it negative is refused (`negative_total`). Values above the target are kept and shown; only the bar stops at 100%. Client ids make retries idempotent; reusing an id for different content is `id_taken`. Every entry and achievement records the goal's unit at that moment, so a later confirmed unit change never rewrites what was recorded; the history keeps the old and new target, unit and deadline.

**Achievement is explicit.** Reaching the target only shows "Target reached". Mark achieved records a `goal_achievements` row (who, when, total and target then); Reopen marks it reopened with an optional reason. History is never erased. A target change that drops an achieved goal below its target needs `confirm_status` and then reopens it; a unit change on a goal with progress needs `confirm_unit` (numbers are reinterpreted, never converted). Renew opens the New goal form prefilled from a completed goal and stores `renewed_from`; the create call checks the target context.

**Access.** `private.goal_access(home, user)` answers `manage`, `contribute`, `view` or null; `packages/domain/src/permissions/goals.ts` makes the same decisions. Managers are the Owner and Administrators granted the new delegable capability `manageHomeGoals`. Members contribute by default (they add, reverse their own and achieve completion goals); a manager can set the Home's goals to view only. Personal goals are their owner's alone. Every function is security definer with the person's session; no table is exposed; every change takes the goal's row lock first, so concurrent contributions serialize.

**Reminders.** One reminder setting per goal, off by default, requires a deadline: an advance moment 1–90 days before and/or an overdue moment 0–30 days after, at one local time. A moment already passed when saved is skipped, never sent late. Delivery is the outbox job `goal-reminder` per goal and moment, rechecked at delivery (revision, deadline, state, access, opt-out); more than 30 minutes late is skipped. Recipients are the owner, or every current viewer of a Home goal who has not opted out. Category `reminders` (kind `goal.reminder`), quiet hours and Home overrides as in S14.

**Interface.** Goals in the sidebar for Personal and each Home (Active with Overdue, Completed, Archived), a goal page with progress, Add progress (locale decimals, resulting total, Undo for 10 s), Set total, entry history with Correct/Reverse, achievement and event history, target, reminders, archive, delete and renew. Two widgets: **Goals** (active goals with compact Add progress and Mark achieved) and **Goal progress** (one chosen goal, with explicit missing and achieved states). Trash module `goals`.

## Consequences

- Any new write on goal entries must take the goal row lock first and keep the ledger append-only.
- The history records the event kinds `created`, `edited` (title, description, deadline with its old and new date, timezone), `target_changed` (target and unit before and after), `adjusted`, `corrected`, `achieved`, `reopened`, `archived`, `unarchived`, `restored` and `reminders_changed`. Contributions and reversals are read from the entry ledger rather than duplicated as events.
- Known limits, accepted for this step: the Archived view lists all archived goals of a context without paging; restoring a goal from the trash does not recheck the 100-goal limit; achieved goals count toward that limit; the compact Add progress editor refuses a stale "set total" but does not explain a total that moved before an addition; an achieved goal takes no new contributions (S30c must decide how linked habits behave then); reminder delivery trusts the reminder revision, so any future change of a Home's timezone must also move it.
- S30b (recurring series, period finalization) and S30c (habit-to-goal links with recompute) build on these tables; Household Display rendering (S43–S44) is out of scope.
- A personal export (S38) and account deletion (S40) must include goals, entries, corrections, achievements and events by owner or contributor.
- **Rollback and compatibility:** the migration adds tables and functions, re-creates `private.is_delegable_capability` to add `manageHomeGoals`, and widens the audit subject, trash module and trash item-type checks; it changes no existing data. It is forward-only; repairing it on production means a new migration. Rolling the app back to S29 code while it stays applied leaves goals unreachable but harmless.
