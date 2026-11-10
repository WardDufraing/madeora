# ADR 0049: Account and Home deletion with a 30-day recovery period

- **Status:** Accepted for S40 (part 1) within the approved architecture (§7 identity, §11 background jobs), CLAUDE.md (authorization C, database access A, background processing B, €0 budget), ADR 0047 (reauthentication) and ADR 0048 (exports). The open values in the brief (`plans/steps/S40-brief.md`) are open to correction by the owner.
- **Date:** 2026-11-10
- **Step:** S40 (brief: `plans/steps/S40-brief.md`). Category deletion and personal-to-Home transfers are proposed as follow-up parts.

## Context

The spec asks for confirmed Madeora account deletion and confirmed Home deletion, each with a recovery period before data is removed for good, essential notices to the people affected, correct Home history afterwards (former members shown without their identity) and no route by which a closed Home or deleted account stays reachable.

## Decision

**A closed Home disappears through one choke point.** `public.home_memberships` becomes a `security_invoker`, `security_barrier` view over the renamed table `private.home_memberships_all`, filtered by `private.home_is_open(home_id)`, with `cascaded check option`. Every membership helper, RLS policy, RPC and job already reads memberships, so a Home in `private.home_deletions` stops existing for all of them at once without editing each one. The table keeps its triggers, constraints and own-rows RLS. The seven RLS policies that referred to the table were recreated against the view (policies bind to the table, not its name). **From now on, new triggers and foreign keys on memberships go on `private.home_memberships_all`**; the view accepts neither.

**Closing a Home.** `close_home(home, typed name)` is for the Owner only, needs the exact Home name and a fresh `authorize_account_change('close_home')`. It ends pending invitations (`home_closed`), join requests, ownership transfers and recoveries, invalidates the Home's exports, records the deadline (now + 30 days), audits it and sends every member a `security` notice and email that carries the Home's name and deadline (members can no longer read the Home itself). `restore_home` (Owner, fresh confirmation, before the deadline) removes the row: members, roles and content return; ended invitations do not.

**Deleting an account reuses deactivation.** `request_account_deletion` needs the word DELETE (or VERWIJDER), a fresh `authorize_account_change('delete_account')` and no Home where the person is the only Owner. It marks open tasks and chores for reassignment in every Home without telling anyone else (open chore handover requests end with the neutral reason `assignment_changed`, released claims with `unavailable`; spec: no alerts to other members, the reason stays private), writes `private.account_deletions` plus the S38 deactivation row, and suspends the account (trusted devices, transfers, Google Calendar paused, every session ended). Signing in then only allows `my_account_state` and `reactivate_my_account`, which cancels the deletion before the deadline.

**Purge by the hourly job.** `task-reminder-advance` calls `purge_due_deletions(20)` (service role only). Each Home or account is removed in its own sub-transaction with `for update skip locked`, and the deferred constraint checks run inside it (`set constraints all immediate`), so a failure stays with its item; it is counted and recorded on the row, and rows that failed before go to the back of the queue. A Home is purged by deleting its memberships first (their triggers update tasks that still need the Home), then the Home; foreign keys cascade its content, and stored files queue their objects for removal. An account is purged by ending its memberships (departure rules, still without notices to others) and then deleting `auth.users`: personal data cascades, attribution columns become null, and the person is shown as "Former member". Audit rows keep the bare ids.

## Consequences

- Closing is not leaving: a closed Home blocks nothing for its Owner except that it is invisible; an Owner whose only owned Home is pending deletion can delete their account, and that Home is purged with the account.
- Members' personal items shared with a Home stay theirs; only the share ends with the purge.
- During an account's recovery period, other members only see the account as inactive; its shares stay in place until the purge.
- Notification params for closed Homes contain the Home's id and name; `purge_home` deletes those notices with the Home.
- The confirmation word is checked by the HTTP route; called directly, `request_account_deletion` still needs the fresh re-authentication.
- The `close_home` re-authentication grant is per action, not per Home (single use, short-lived).
- Google Calendar tokens are removed with the account at the purge, without a call to Google's revoke endpoint.
- No new service, dependency or paid plan was added. `docs/production-migrations.md` is updated by the owner's docs-only push.
