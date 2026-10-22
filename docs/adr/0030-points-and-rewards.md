# ADR 0030: Points and rewards

- **Status:** Accepted for S23 within the approved architecture (§4, §8 Realtime C, §9, §15), CLAUDE.md (database access A, authorization C, data fetching B, forms A, date/time A, dashboard layout B, €0 budget) and the spec's sections on points, rewards and the leaderboard (PS L1399–L1578) and on correcting completed chores (PS L2082–L2101). The defaults below are open to correction by the owner.
- **Date:** 2026-10-22
- **Step:** S23 (brief: `plans/steps/S23-brief.md`). Builds on ADR 0026 (chores), 0027 (pool and claims), 0028 (proposals, volunteers, overview) and 0029 (vacations).

## Context

Completed chores should earn points that members spend on rewards the Home defines. Points are money-like: they must never be paid twice, lost on a retry, spent twice in a race or shown to people who may not see them. Chores can be approved later, corrected, reopened or deleted, and members leave and rejoin.

## Decision

**One migration, no exposed tables.** `20261105090000_points_rewards.sql` adds `private.point_accounts`, `point_entries`, `rewards`, `reward_redemptions`, `reward_redemption_events`, `point_preferences` and `point_settings`, the points columns on chores, templates and occurrences, the notification categories `points` and `rewards`, and three delegable capabilities. Every read and change is a `security definer` function run with the person's session; changes return `(outcome, impact, revision)` and `dryRun` runs the same checks under the same locks and returns the impact before writing anything, so a preview shows what confirming would do at that moment.

**Chore points.** One base value per chore (0–1000) and a late policy: full (default), reduced to a fixed amount, or zero. Every occurrence snapshots them when it is created (a `before insert` trigger), so a later change to the chore is prospective. A completion is late when the Home-local date of its reported completion time is after the due date; the review time never counts, so a delayed approval pays what an on-time completion earned.

**An append-only ledger with cached accounts.** One account per Home and account (not per membership): it is kept when the membership ends, so rejoining restores the balance, and another Home never sees it. Entries are never edited; the account caches its balance and its reserved points; available = balance − reserved.

**Reconciliation, never editing.** After any change to an occurrence that can affect its award (status, contributor, completion time, deletion, due date, points snapshot), `private.reconcile_chore_points` computes the award it should carry and, only when that differs from the live award, posts a reversal and the new award in the same transaction. Reconciliation runs under the occurrence's row lock, so retries, replays and concurrent approvals post nothing twice; unique indexes allow one reversal per entry and one redemption and one refund entry per redemption. A chore manager's correction or reopen that changes awarded points also needs `manageHomePoints`; correcting a completed occurrence's points snapshot needs both and a reason.

**Negative balances.** A manual debit or a redemption never takes available points below zero (`insufficient_points`, nothing partial). A chore reversal is posted in full so the ledger stays true; it never touches reserved points or fulfilled rewards, and an account it leaves below zero shows as owed.

**Rewards and redemptions.** Immediate (default) or approval-required. Redeeming checks membership, enabled, window, total and per-member capacity and available points atomically under the reward's lock and then the account's; the client sends the cost it saw and a changed cost is refused. A pending request reserves its cost and capacity; approval by a different current member with `approveHomeRewards` (never the requester, the Owner included) turns the reservation into one entry; rejection, cancellation and leaving release it exactly once. Archiving or disabling a reward keeps pending requests (a reviewer confirms approving an unavailable reward). Fulfillment (Pending, Fulfilled, Unable) is tracked apart; Unable is resolved by a refund (one linked entry, capacity not returned) or a replacement (never charged again). History is append-only in `reward_redemption_events`.

**Lock order:** rewards and manual adjustments take the Home row's key-share lock first, then reward → redemption → account, matching leaving and removal (Home row, then rewards, redemptions, accounts). Chore paths keep the chore modules' order (chore → occurrence) and take the Home row and account afterwards, as their history writes already did; a chore change racing a departure of its contributor can therefore abort with a deadlock error (retried by the person; nothing partial is written). Making every chore path take the Home row first is a later change to the chore modules.

**Rights (defaults picked).** Every current member sees their own balance and ledger, the enabled catalog, redeems, requests, cancels their own pending request, sees the leaderboard when it is on and sets their own participation and weekly target. `manageHomeRewards`: catalog, limits, leaderboard settings, fulfillment, resolutions, cancelling someone else's request (with a reason). `approveHomeRewards`: approving or rejecting someone else's request. `manageHomePoints`: every member's balance and ledger, bonuses, corrections and reversals (reason 3–300 characters, previewed). Approving chores or rewards never grants balance access. The permission matrix is mirrored in `@madeora/domain/points` for the interface only.

**Leaderboard and weekly views.** Off by default per Home; periods week (Home chore week), month and all time in the Home timezone. Ranked by earned points in the period, then completed occurrences, then a shared rank shown in name order. One per-member participation switch covers the leaderboard and the shared weekly overview; a personal weekly target is hidden unless the member shares it. No balance, reservation, redemption or reason is ever shown there.

**Notifications.** `points` (chore awards and reversals) is optional and opt-in on every channel. `rewards` (requests to reviewers; decisions, fulfillment and resolutions to the requester; manual adjustments to the account holder) is optional, in-app on by default. One notice per ledger entry or redemption event, so retries never repeat it.

**Interface and API.** Points, Rewards (with an approvals view) and Leaderboard pages per Home; points fields on the chore and template forms; a points panel, a reopen preview and a points correction on the occurrence page; three dashboard widgets (Weekly points, Leaderboard, My points). Route Handlers under `/api/v1/points`, `/point-adjustments`, `/point-entries/:id/reversal`, `/point-preferences`, `/point-settings`, `/leaderboard`, `/weekly-points`, `/rewards`, `/reward-redemptions` and `/chore-occurrences/:id/points`, with the same CSRF, JSON, size, session and outcome mapping as S20–S22. Another member's ledger is `/api/v1/points/accounts/:accountId` (by account, so a former member's account stays reachable for points managers) instead of the brief's `/points/members/:membershipId`.

## Consequences

- Balances can always be rebuilt from the ledger; the cached totals are checked against it by the database tests.
- Members who leave keep their points in that Home; nothing transfers between Homes and points never expire.
- Ora's celebrations and grouping (S45), display redaction (S43–S44), guardian rules (S41) and export are later steps.
- The migration is forward-only like every other; repairing it on production means a new migration.
