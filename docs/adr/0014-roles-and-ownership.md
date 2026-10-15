# ADR 0014: Roles, Administrator rights, removal, leaving and ownership transfer

- **Status:** Accepted for S12 within the approved architecture (§4, §5, §6, §8, §9) and CLAUDE.md (authorization strategy C, database access strategy A). Defaults chosen without asking, listed below, are open to correction by the owner.
- **Date:** 2026-10-15
- **Step:** S12, role management and ownership (brief: `plans/steps/S12-brief.md`)

## Context

S09 gave every Home exactly one Owner, Administrators and Members, but no way to change a role, delegate a right, remove someone, leave or hand the Home over. The spec requires all of these ("Confirmed exactly one Home Owner", "Confirmed Home ownership transfer", "Confirmed customizable Administrator permissions", "Confirmed Home member-removal authority" and its reaffirmation, "Confirmed voluntary Home departure", "Confirmed guided transfer-or-close for departing Home Owner", "Confirmed privacy-minimized Home history after adult departure"). The rules must hold in the database, not only in the app, and under concurrent requests.

## Decision

**Writes only through functions.** Memberships, Administrator rights and transfers still have no direct API write path. Every change goes through a `security definer` function (empty `search_path`, execute for `authenticated` only) that re-checks the caller's confirmed account, current membership and authority itself: `change_home_member_role`, `set_administrator_capabilities`, `remove_home_member`, `leave_home`, `start_ownership_transfer`, `cancel_ownership_transfer`, `respond_to_ownership_transfer`. Reads: `home_capabilities` (the Owner sees every grant in the Home, others only their own) and `home_ownership_transfer` (only the sender and the recipient). The API routes run the TypeScript engine first (`decideHomeAction`, and the new target-aware `decideMemberAction`) and then the function, which decides again.

**One lock per Home.** Each of those functions first locks the Home's row with `private.lock_home`, in a statement of its own, and only then reads roles. All membership changes in one Home therefore run one at a time with fresh data (in READ COMMITTED an expression evaluated together with the lock would still see the snapshot from before the wait). `decide_join_request` (S10) takes the same lock. One lock order (Home first) avoids deadlocks.

**Exactly one Owner.** S09's partial unique index (at most one Owner) and deferred constraint trigger (at least one) are unchanged. Nobody can set or remove the Owner role directly; only an accepted transfer moves it, demoting the former Owner to Member and promoting the recipient in one transaction. Two-session tests race acceptance against removal, departure, cancellation and a second start.

**Administrator rights.** `private.home_admin_capabilities` holds individual grants (`manageHomeSettings`, `manageInvitations`, `removeMembers`) with a foreign key to the membership (`on delete cascade`). A trigger refuses grants to anyone who is not an Administrator; another deletes them when the role changes away from Administrator, whatever made the change. `private.has_home_capability` is the one SQL rule (the Owner always; an Administrator only with the grant). It now backs Home settings RLS (`homes_update_manager`) and `can_manage_invitations` (Administrators manage Member invitations and join requests only, never Administrator ones). The S10 invitation and join-request lists are replaced so that each row is returned only to someone who may manage its role: an Administrator never sees the Owner's Administrator links and codes, the emails they were sent to, or the people applying to become Administrator. Only the Owner grants or revokes rights and changes roles; no right reaches an Owner-only power.

**Stale confirmations fail safely.** Role change and removal carry the target's role as the person saw it (`expectedRole`); if it changed meanwhile the answer is `stale` (HTTP 409) and nothing happens. Rights can only be set while the target is an Administrator at that moment.

**Removal and leaving.** The Owner removes Members and Administrators; an Administrator with `removeMembers` removes Members only; nobody removes the Owner or themselves. Members and Administrators leave at any time; the Owner cannot leave (409 `owner-must-transfer`) and gets the guided page: choose a successor, or read that closing a Home comes later (S40). Access ends at once because every page and API request reads the membership from the database (S09); there are no Realtime subscriptions yet.

**Transfers.** One pending transfer per Home (partial unique index), to an existing member other than the Owner; a repeated `requestId` returns the transfer it started. Only the recipient accepts or declines; the Owner cancels. A transfer ends as `invalid` when the recipient leaves or is removed, or the sender stops being the Owner (a change of the recipient's role between Member and Administrator does not affect it), and as `expired` after 7 days. The sender sees a declined, expired or invalid outcome on the Home dashboard for 7 days; a departed recipient is shown as "a former member".

**Privacy after departure.** When a membership ends, all the person's join requests in that Home (whatever their state) and the email invitation they accepted (which hold their email and name snapshot) are deleted; the Home profile already goes with the membership (S11). The audit log records `home_membership.removed`, `.left` or `.ended`, role and rights changes and every transfer transition (including a transfer that becomes invalid because its recipient left, was removed or deleted their account), with ids only. Later modules follow the same rule: attribute history by membership id and show "Former member" with no live profile link.

## Defaults chosen (owner may correct)

A new Administrator starts with no rights; three rights only; the former Owner becomes a Member after a transfer; a pending transfer expires after 7 days; transfers are visible to the Owner and the recipient only; departure deletes the join-request and invitation snapshots; role changes, saving rights and removal each ask for confirmation. Verified ownership recovery is a later step (decision put to the owner); until then an Owner who loses their account uses normal account recovery.

## Consequences

- From S12 an Administrator needs the "Manage invitations" right to manage Member invitations and join requests (before S12 only the Owner could), and "Manage Home settings" to rename the Home.
- The migration must be applied to `madeora-preview` and `madeora-production` by the owner (`docs/supabase-migrations.md`, with a check for S12).
- Notifications about removal and transfers come with S14; until then states show in the app.
- Rollback: `docs/supabase-migrations.md`, "If you need to undo S12" (tested: it restores the S11 schema except the audit trigger's end reason and the audit subject list, and the S12 file applies again afterwards).
