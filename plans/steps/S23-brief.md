# S23 · Points and rewards — feature brief

**Branch:** `feat/points-and-rewards`, from `main` at `a6b2982` (S22 merged as PR #37, chore-pool fix as PR #38). Depends on S20 (merged).
**Sources (read only these ranges):** build plan S23; PS L1399–L1578 (Ora celebrations, leaderboard opt-out, tie-breaking, periods, balance privacy, bonuses and adjustments, points on departure, no expiry, unable-to-fulfill resolution, fulfillment tracking, availability and limits, cancellation, independent reviewer, optional approval, uniform base points, per-occurrence snapshot, delayed approval timing, pending approval lifetime, points notifications, celebration presentation and grouping, weekly targets, shared weekly overview, chore-card points and weekly widget), L2082–L2101 (correction and reversal reconcile points, another member's chore, late-completion policy; part of the S20 range); ARCH §4, §8, §9, §15; ADR 0026–0029.
**Model:** Opus (ledger consistency, reservations, concurrency between redemption, approval, adjustment, departure and chore reconciliation; balance privacy).
**Done when (build plan):** point preservation and redemption tests pass; balances stay private.

Ward kept S20, S21 and S22 as one step each, so S23 is one step: one branch, one migration, one full suite, one review.

## What already exists

- Chores (S20–S22) record completions, submissions, approvals, corrections and reopens as append-only events, with the reported completion time kept apart from the review time. Nothing awards points yet; the pool, cards and templates leave a points slot.
- Pending chore approvals already never expire, and reviewers already get the 24-hour then daily grouped reminder (S20/S21c). Nothing to add there.
- Notifications (S14) with categories, preferences, quiet hours and email jobs; dashboard engine (S17) with the widget registry.
- Ora's shell is S45. There is no Ora presence yet.

## Model

**Chore points.** Each chore has one base value (`points`, integer 0–1000, default 0) and a late policy: **full** (default), **reduced** (a fixed amount 0..points, no rounding needed) or **zero**. Stored on the chore (not per schedule part: the spec says one value per chore) and editable by chore managers; a change is prospective and previewed (how many already-created open occurrences keep their old value). Every occurrence **snapshots** points, policy and reduced amount when it is created (a `before insert` trigger, so every path that creates occurrences is covered). Templates carry suggested points and policy.

**Lateness:** a completion is late when the Home-local date of its reported completion time is after the occurrence's due date (occurrences are date-only). Award = snapshot points if on time; if late, full / reduced amount / 0. The review time never counts.

**Ledger** (`private.point_entries`, append-only, one per Home account). Kinds and signs:

| Kind              | Sign | Counts as earned | Source                                                                       |
| ----------------- | ---- | ---------------- | ---------------------------------------------------------------------------- |
| `chore_award`     | +    | yes              | an occurrence completed (immediately or on approval)                         |
| `chore_reversal`  | −    | yes (negative)   | reopen, correction, deletion, points correction; links the award it reverses |
| `bonus`           | +    | yes              | points manager, reason required                                              |
| `correction`      | ±    | yes              | points manager, reason required                                              |
| `manual_reversal` | ∓    | yes              | reverses one bonus/correction, once, linked                                  |
| `redemption`      | −    | no (spent)       | an immediate redemption, or an approval                                      |
| `refund`          | +    | no (un-spent)    | Unable-to-fulfill resolved by refund, once, linked                           |

Every entry stores Home, member account, actor, reason, amount, `attributed_at` (completion time for chore entries, the original's time for a reversal, otherwise creation time), available and reserved before and after, and links. Nothing is ever updated or deleted.

**Accounts** (`private.point_accounts`): one per Home and account (not per membership), with cached `balance` (sum of entries) and `reserved` (sum of pending requests). **Available = balance − reserved.** Earned = sum of earned kinds; spent = redemptions − refunds. Every change locks the account row; lock order is always chore → reward → account, so nothing deadlocks.

**Chore reconciliation** (`private.reconcile_chore_points`, run by an `after` trigger on occurrence changes to status, contributor, completion time, deletion or the points snapshot): computes the award the occurrence should carry now (completed, not deleted, a contributor, award > 0) and compares it with the one it carries. Different → reverse the old one and post the new one, in the same transaction. Idempotent by construction: retries, concurrent approvals and replays post nothing twice (a partial unique index allows one live award per occurrence). A contributor cleared by account deletion changes nothing.

**Negative balances.** A manual debit or a redemption never makes available points negative (`insufficient_points`, nothing partial). A chore reversal is posted in full because the ledger must stay true: it never touches reserved points or fulfilled rewards; if it takes available below zero the account shows **Points owed**, cannot redeem until it is back above the cost, and points managers see it flagged in the balances list, where a positive correction is the explicit resolution. Reopen and correction previews show this before confirmation.

**Rewards** (`private.rewards`): name (1–80), description (≤ 500, plain), cost (1–100 000), redemption mode **immediate** (default) or **approval required**, enabled, optional availability window (first and last day, inclusive, Home timezone), optional total limit (1–10 000), optional per-member limit (1–100 per **week** (the Home chore week), **month**, **year** or **ever**). Archiving replaces deletion: an archived reward disappears from the catalog but keeps history, outstanding fulfillment and pending requests. Edits are previewed (pending requests and redemptions affected) and never change pending reservations, cost snapshots or completed history. At most 200 active rewards per Home.

**Redemptions** (`private.reward_redemptions`): requester, reward, cost and name snapshot, status **Pending** → **Redeemed** (immediately or approved) / **Rejected** / **Cancelled**. Request and immediate redemption check membership, enabled, window, total and per-member capacity (pending and redeemed count; rejected and cancelled do not; a refund does not give capacity back) and available points atomically under the reward and account locks. A pending request reserves its cost and its capacity. Client ids make a retry return the same redemption.

- **Approve:** a different current member with `approveHomeRewards`; never the requester, whatever their role. Rechecks state and requester membership; converts the reservation into a `redemption` entry once. A reward archived, disabled or outside its window since the request needs explicit confirmation (`reward_unavailable` until confirmed); otherwise reject or cancel. No eligible reviewer: the request stays pending and says so.
- **Reject** (reviewer, optional reason ≤ 300) or **cancel** (the requester, or a rewards manager with a required reason 3–300): releases the reservation exactly once.
- **Departure:** leaving or removal cancels that member's pending requests and releases their reservations once (reason "left the Home", recorded); the account stays with its balance and history; rejoining with the same account restores it; another Home never sees it.

**Fulfillment** (redeemed only): **Pending fulfillment** → **Fulfilled** / **Unable to fulfill** (optional notes ≤ 300), by rewards managers. A mistaken state can be corrected (back to pending or to the other state, reason required) until a resolution is recorded. **Unable to fulfill** is resolved explicitly by **Refund** (a linked `refund` entry, once) or **Replacement** (description ≤ 200, a responsible current member; its own Pending / Fulfilled / Unable; never charged again; an unable replacement is resolved again the same way). All of it is append-only in `private.reward_redemption_events`.

**Leaderboard** (optional per Home, off by default; rewards managers turn it on and pick the default period, monthly initially). Periods **week** (Home chore week start), **month** (calendar month) in the Home timezone, and **all time** (since the Home's first ledger entry). Rank by earned points attributed in the period, then by completed occurrences in the period (by actual contributor and completion time; bonuses never add to it), then a shared rank (1, 1, 3) shown in name order. Only current members who participate appear; opting out (any time, per Home, no approval, kept through leaving and rejoining) removes the member from every leaderboard view, count and widget. No balances, reserved points, redemptions or reasons ever appear.

**Weekly target** (personal, optional, per Home): a nonnegative number of points per Home week, pausable, removable; 0 means off. Hidden from others unless the member turns on **Share my target** (off by default). No bonus, penalty or notification.

## Who may do what (defaults picked, Ward may override)

Three new delegable capabilities (Owner always; Administrators when granted):

| Action                                                                                              | Any member | `manageHomeRewards` | `approveHomeRewards` | `manageHomePoints`           |
| --------------------------------------------------------------------------------------------------- | ---------- | ------------------- | -------------------- | ---------------------------- |
| See own balance, ledger, requests, target                                                           | yes        |                     |                      |                              |
| See the enabled catalog; redeem or request                                                          | yes        |                     |                      |                              |
| Cancel own pending request                                                                          | yes        |                     |                      |                              |
| Leaderboard (when on); own participation and target                                                 | yes        |                     |                      |                              |
| Create, edit, archive rewards; limits and availability                                              |            | yes                 |                      |                              |
| Leaderboard on/off and default period                                                               |            | yes                 |                      |                              |
| Fulfillment queue, fulfil, unable, refund, replacement                                              |            | yes                 |                      |                              |
| Cancel someone else's pending request (reason)                                                      |            | yes                 |                      |                              |
| Approve or reject others' requests                                                                  |            |                     | yes (never own)      |                              |
| See every member's balance and ledger                                                               |            |                     |                      | yes                          |
| Bonus, correction, reversal of a manual entry                                                       |            |                     |                      | yes                          |
| Correct a completed occurrence's points; reopen or correct a completion that changes awarded points |            |                     |                      | yes, plus `manageHomeChores` |

Chore point values and late policy stay with chore managers (`manageHomeChores`). Ordinary completion, chore review or reward approval never imply balance access or adjustment. Every action rechecks membership and capability at commit.

## Notifications

- New optional category **`points`**, **opt-in** (in-app off by default, email opt-in): a chore award (amount and resulting balance) and a chore reversal (tactful wording). One notification per ledger entry (dedupe key = entry id).
- New optional category **`rewards`** (in-app on, email opt-in): a new request to every eligible reviewer except the requester; approved, rejected or cancelled by a manager to the requester; fulfilled, unable, refund or replacement to the requester; a manual adjustment or its reversal to the member.
- Emails never carry reward names, amounts or reasons (generic text with a link). Leaderboards and targets never notify.
- **Ora's transient celebration, its grouping window and the leaderboard celebrations come with S45** (Ora shell); S23 delivers the notification-center records and their plain-language text, which is the spec's fallback when Ora is unavailable.

## Interface

- **Points** (`/homes/:id/points`): available, reserved, earned and spent, "Points owed" when negative; my ledger; my weekly target; leaderboard participation with the explanation; for points managers, every member's balances (flagged when owed) and a member ledger with **Bonus**, **Correction** and **Reverse** (preview, reason, confirm).
- **Rewards** (`/homes/:id/rewards`): catalog with cost, eligibility, window, remaining capacity and next eligible time; Redeem (preview: cost, available after) or Request; my requests with Cancel; for reviewers the approval queue (blocker shown when they are the requester); for rewards managers, Manage rewards (create, edit with preview, archive) and the fulfillment queue with resolutions.
- **Leaderboard** (`/homes/:id/leaderboard`, when on): week / month / all time, metric and period labels, empty state; settings for rewards managers.
- **Chores:** cards, the pool (with sort by points) and the occurrence page show base points and the late policy; the occurrence page shows expected, pending and earned points and the ledger lines; the approval queue shows the reported time and the resulting award; chore create/edit and templates get points and late policy; a points correction on the occurrence page; reopen and correction previews show the point change.
- **Dashboard widgets** (Home and Home-source): **Weekly points** (personal: earned this week, pending, possible from my open chores, target progress; or shared overview: each participating member's earned, pending and possible, shared targets only, and the unassigned pool's possible points as a separate total; no ranking), **Leaderboard** (period, top 5/10; calm state when off), **My points** (available, reserved and the cheapest rewards I can afford).
- nl and en; keyboard and screen reader; light and dark.

## API

`GET /api/v1/points?homeId` (my summary and ledger), `GET /api/v1/points/members?homeId`, `GET /api/v1/points/members/:membershipId?homeId`, `POST /api/v1/point-adjustments` (`dryRun`), `POST /api/v1/point-entries/:id/reversal` (`dryRun`), `GET/PUT /api/v1/point-preferences?homeId` (participation, target), `GET/PUT /api/v1/point-settings?homeId` (leaderboard), `GET /api/v1/leaderboard?homeId&period`, `GET/POST /api/v1/rewards?homeId`, `GET/PATCH /api/v1/rewards/:id` (edit, archive; `dryRun`), `GET/POST /api/v1/reward-redemptions?homeId`, `PATCH /api/v1/reward-redemptions/:id` (approve, reject, cancel, fulfil, unable, correct, refund, replace, replacement outcome; `dryRun`), `PUT /api/v1/chore-occurrences/:id/points` (`dryRun`); chore and template payloads gain the points fields. Same CSRF, JSON, size, session and outcome mapping as S20–S22.

## Tests

- **Database:** snapshot at creation and prospective edits; on-time, reduced, zero late awards in another timezone and at the day boundary; delayed approval keeps the reported time; another member's completion pays the contributor; correction of contributor and time, reopen, deletion and points correction reconcile without duplicates; **point preservation** on leave, removal and rejoin, no transfer across Homes; reserved release on departure exactly once; immediate redemption, approval (independent reviewer, Owner as requester blocked), rejection, cancellation by requester and by manager; limits (total, per member per week at the boundary, window); archived or disabled reward while pending; fulfillment and refund once, replacement; bonus, correction, insufficient points, reversal once; **privacy**: another member, an approver without points rights, a non-member and another Home never read a balance or ledger; leaderboard ranking, ties, periods, opt-out; concurrency: two redemptions racing for the last points and the last capacity, approval vs cancellation, two approvals, adjustment vs redemption, approval vs departure.
- **Unit:** domain award and lateness, periods, ranking, permission matrix, schemas, routes, components with axe.
- **Playwright:** a member completes a chore and sees the points; another member cannot see that balance; immediate redemption; approval-required request approved by a second member while the requester cannot approve; leaderboard with an opted-out member; widgets; axe in both themes.

## Out of scope (with the step that brings it)

Ora's transient celebrations, grouping and leaderboard celebrations (S45); wall and shared display redaction (S43–S44: widgets already show only authorized data); guardian and child rules (S41); export (no export exists yet); account deletion anonymization beyond today's "Former member" handling (account lifecycle step).

## Defaults picked (Ward may override)

1. One step, like S20–S22.
2. Three new delegable capabilities: `manageHomeRewards`, `approveHomeRewards`, `manageHomePoints` (table above).
3. Points 0–1000 per chore; reduced late points as a fixed amount; stored per chore, not per schedule part.
4. Chore reversals may leave a balance owed (never reserved points, never fulfilled rewards); manual debits and redemptions never go negative.
5. Per-member limit periods: week, month, year, ever; capacity is not returned by a refund.
6. One participation switch covers the leaderboard and the shared weekly overview; target sharing is separate and off by default.
7. `points` notifications are opt-in; `rewards` notifications are on in-app.
8. Ora's transient celebration and grouping wait for S45.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests
- [x] API and data layer
- [x] Interface
- [x] Playwright
- [x] Docs (ADR 0030, development.md, supabase-migrations.md, production-migrations.md)
- [x] Full suite
- [x] Independent review

## As built

- Migration `20261105090000_points_rewards.sql`; domain `packages/domain/src/points`; client `apps/web/src/points`, `src/components/points`; pages Points, Rewards (+ approvals), Leaderboard; three widgets.
- **Route deviations from the API list above:** another member's ledger is `GET /api/v1/points/accounts/:accountId?homeId` (by account, so a former member's account stays reachable) instead of `/points/members/:membershipId`; the list is `GET /api/v1/points/accounts?homeId`. There is no `GET /api/v1/rewards/:id` (the catalog list carries everything). `GET /api/v1/weekly-points?homeId` serves the widget. `GET /api/v1/chore-occurrences/:id/points?preview=reopen|correct` serves the reopen and correction previews.
- Docs: ADR 0030, development.md, supabase-migrations.md (S23 check), production-migrations.md regenerated (also adds S22, which was missing, and fixes `$$` collapsed to `$` in the old bundle), notifications.md, user-stories.md (US-022).
- Fixes found by the full suite: the approvals list failed to parse (a SQL `null` action flag; now always true/false, with a test); the success message of a redeem or adjustment now shows as a toast, so it survives the control leaving the page; a deadlock between approving and leaving the Home (rewards and adjustments now lock the Home row first); a concurrency test that depended on which member won a race.
- Full suite before review: format, lint, typecheck, unit (1989), build, DB fallback (107 + SQL), E2E fallback (165; one expected count updated in roles-and-ownership.spec.ts for the three new capabilities).
- Independent review (`reviews/steps/S23-review.md`): **PASS**, no BLOCKER/HIGH. Fixed after review: ADR 0030 statements that did not match the code (dryRun, unique index, archiving, lock order) and a new SQL check that cached balances match the ledger. Not done (MEDIUM/LOW, left for Ward): extra Playwright coverage (immediate redemption, opted-out leaderboard, widgets, dark-theme axe), SQL tests for removal and deletion, a chore-change-vs-departure deadlock in the chore modules' lock order, and the owner decisions listed in the review.
