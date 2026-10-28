# S28b · Personal points and rewards — feature brief

**Why:** The spec requires rewards and points in both personal and Home contexts. S23 built only the Home side. This step is the personal side. Ward decided the boundary on 2026-10-28; it was not in the build plan (that file is not in the repo) and it is not deferred by ADR 0030 or by the S23 brief.
**Branch:** `feat/personal-points-rewards`, from `main` after this brief is on `main`. Sequenced after S28 and before S29/S30 (`plans/roadmap.md`). Depends on S23 (merged as PR #39), S07 (personal context) and S17 (dashboard widgets). It does not depend on habit behaviour. Do not edit S28's files, `plans/steps/S28-brief.md`, or `.github/workflows/set-staging-marker.yml`.
**Sources (read only these ranges):** PS L55–L56 (Personal context belongs to the individual); L91 and L94–L100 (personal space stays distinct with zero Homes; personal records are not moved into a Home; personal widgets never leak onto a Household Display); L657–L666 (category-selective personal export; the listed categories do not name points or rewards); L669–L672 (a personal export covers eligible personal data and does not include Home-owned records just because the person can see them); L713–L718 (account deletion removes personally owned data after the recovery period, L717, and does not erase Home-owned content, L718); L1399–L1578 (Home celebrations, leaderboard, balance privacy, adjustments, departure, no expiry, fulfillment, limits, cancellation, independent reviewer, optional approval, chore points, notifications, weekly targets, weekly overview, chore-card points); L2082–L2101 (chore correction reconciles Home points); L2495–L2502 (MVP includes rewards/points in both contexts); L2957 ("Habit completion does not automatically award reward points unless a separately approved reward rule explicitly allows it"); L2966 and L2984 (goals do not imply automatic rewards); MOD L65–L71; ADR 0030; S23 brief "Out of scope" (L106); ARCH §4, §6, §9, §15, §19, §21, §34, §36, §39, §43.
**Model:** Opus (a second ledger that must be impossible to read or change from a Home, from staff, or from another account).
**Done when:** with zero Homes, a person can hold a personal balance, record a personal reward and redeem it, and no other account, Home role or staff path can read or change that ledger. Home points are unchanged.

## What already exists

- S23 (`supabase/migrations/20261105090000_points_rewards.sql`, ADR 0030, pages under `apps/web/src/app/(app)/homes/[homeId]/points` and `rewards`) is a Home ledger. `point_accounts` (L282), `rewards` (L296), `reward_redemptions` (L331), `point_entries` (L386), `point_preferences` (L447) have `home_id uuid not null`. `point_settings` (L462) has `home_id uuid primary key`, which is also not null. `reward_redemption_events` (L429) has no `home_id` of its own; it hangs off a redemption that has one. Nothing in that migration is personal.
- S23 brief L106 leaves Ora celebrations (S45), display redaction (S43–S44), guardian rules (S41), export and account-deletion anonymization for later. It does not mention personal points, and it does not defer them. ADR 0030 L9 and L39 are the same: Home chore points and Home rewards, with later steps named, and no personal ledger.
- Personal context already exists with zero Homes (S07). Personal and Home tasks, recipes, shopping lists and meals are separate. Notifications may have `home_id` null for an account-level notice (`20261022090000_notifications.sql` L36–L38).
- The sidebar has no Points entry. Home points are reached from the Home points pages and widgets. Personal routes follow `/tasks` beside `/homes/[homeId]/tasks`.

## Model

**Decided by Ward (2026-10-28).** Personal points are strictly personal. One ledger per account, independent of every Home. No conversion to Home points, no mixing, no shared balance, and no Home can see or affect the personal ledger. Deleting a Home does nothing to it. Leaving a Home does nothing to it. `manageHomePoints`, `manageHomeRewards` and `approveHomeRewards` do not apply.

**Rewards, decided by Ward (2026-10-28).** Personal rewards are self-defined only. A user defines their own personal rewards and redeems them against their own balance. No one else defines them. Do not invent a different model, such as a Home defining personal rewards or a shared personal catalog.

**Tables are new.** Do not add nullable `home_id` columns to the S23 tables, and do not store personal rows in them. ARCH §4 says module tables reference `home_id` where that applies; a personal ledger has no Home, so these tables have no `home_id` column at all.

**Account** (`private.personal_point_accounts`): one row per account (`user_id` unique, not null). Cached `balance` is the sum of entries. There is no `reserved` column under the default below (immediate redemption only). Available = balance.

**Ledger** (`private.personal_point_entries`): append-only. Kinds under the defaults below:

| Kind              | Sign | Counts as earned | Source                                              |
| ----------------- | ---- | ---------------- | --------------------------------------------------- |
| `credit`          | +    | yes              | the owner posts points to themself, reason required |
| `correction`      | ±    | yes              | the owner, reason required                          |
| `manual_reversal` | ∓    | yes              | reverses one credit or correction, once             |
| `redemption`      | −    | no (spent)       | immediate redemption of the owner's reward          |
| `refund`          | +    | no (un-spent)    | the owner resolves Unable to fulfill, once          |

No `chore_award` and no `chore_reversal`. Every entry stores the owner, the actor (the same account), the reason where required, the amount, `attributed_at`, available before and after, and links. Nothing is updated or deleted. A client id makes a retry return the same entry. Every change locks this account row and never locks a Home `point_accounts` row in the same transaction.

A redemption or a negative correction never makes the balance negative (`insufficient_points`, nothing partial). There is no "points owed" path, because nothing posts a reversal the owner did not choose.

**Rewards.** Self-defined only, as decided above. Columns follow S23's shape where it does not need another person: name, description, cost, enabled, optional availability window, optional total limit, optional per-period limit, archived flag, revision. Archiving hides the reward and keeps history. Edits do not change past redemptions. At most `POINTS_LIMITS.rewards` (200) active rewards per account. Windows and the per-period limit use the account's effective timezone and week start (S07), never a Home timezone.

**Redemptions:** immediate only. Status is `redeemed` at once, then fulfillment **Pending fulfillment** → **Fulfilled** / **Unable to fulfill**, recorded by the owner. Unable is resolved by **Refund** (one linked `refund`) or **Replacement** (the owner's note, never charged again). No pending request, no reservation, no second reviewer. The Home independent-reviewer rule (PS L1488–L1492) cannot be copied here: a second person is not allowed to see the ledger.

**No expiry, as a default.** PS L1452–L1456 states that _Home_ reward points never expire. The same behaviour is the default for this ledger until Ward says otherwise. No expiry job, no reset.

**Export and deletion, decided by Ward.** This step does not build export or account deletion. The rows are keyed only by the account, so a later personal export and the account-deletion flow can include them without a Home id. PS L658's category list does not name points or rewards; the later export step adds the category, it is not invented here. PS L669–L672 and L717 require eligible personal data to be exportable and, on final deletion, removed. L718 forbids erasing Home-owned content as part of that deletion. `user_id` references `auth.users` `on delete cascade`, so the ledger lives as long as the auth user and goes with it. S40 is not built; if that step removes the auth user at the start of the 30-day recovery (ARCH §36) rather than at the end, it must keep these rows until final deletion instead of relying on the cascade. Do not add a "delete my points" action in S28b.

## Who may do what (defaults picked, Ward may override)

| Action                                                           | The account | Anyone else |
| ---------------------------------------------------------------- | ----------- | ----------- |
| See balance, ledger, rewards, redemptions                        | yes         | no          |
| Post a credit, correction or reversal                            | yes         | no          |
| Create, edit, archive a reward; redeem; mark fulfillment; refund | yes         | no          |
| Read or write through a Home, a Home role, or a staff function   | no          | no          |

"Anyone else" includes another account, a Home Owner, an Administrator, a member with any points capability, a Madeora staff account (ARCH §43), and a Household Display session when those exist (S43). Staff have no function for this ledger. A staff member sees only their own ledger, as themselves, never someone else's. There is no guardian path (children are S41; ARCH §34). The session user is the only owner; a user id in the body is ignored.

RLS is on, grants to `authenticated` are revoked, and every read and write is a `security definer` function that requires `auth.uid()` to be that account. No policy and no function lets staff, a Home owner or an administrator through. The API uses the caller's Supabase session, never the service role.

## Interface

- **Personal points** (`/points`) and **Personal rewards** (`/rewards`), in the Personal context, including when the person has zero Homes. Show available, earned and spent, the ledger, and the reward catalog with Redeem (preview: cost, balance after). The owner manages rewards (create, edit with preview, archive) and the fulfillment states on their own redemptions.
- Do not change `/homes/[homeId]/points`, `/homes/[homeId]/rewards` or the leaderboard. Do not add personal rows to those screens, and do not link a Home page at a personal balance.
- **Widget** on the personal dashboard only: stable id `personal-points` (check the S17 registry for a collision before using it). Available balance and the cheapest of the owner's rewards they can afford. It is not the Home "My points" widget, it is not offered on a Home dashboard, and it must not be readable by a Household Display (PS L100).
- nl and en. Keyboard and screen reader. Light and dark. User-written reward names are not translated.

## API

`GET /api/v1/personal-points`, `POST /api/v1/personal-point-adjustments` (`dryRun`), `POST /api/v1/personal-point-entries/:id/reversal` (`dryRun`), `GET/POST /api/v1/personal-rewards`, `PATCH /api/v1/personal-rewards/:id` (`dryRun` for an edit), `GET/POST /api/v1/personal-reward-redemptions`, `PATCH /api/v1/personal-reward-redemptions/:id` (fulfil, unable, refund, replace; `dryRun`). Same CSRF, JSON, size, session and outcome mapping as S23. Reject a `homeId` argument. Do not extend `GET /api/v1/points`.

**Notifications (default).** Reuse the `points` and `rewards` categories for an account-level notice (`home_id` null). A Home override of those categories does not apply. `points` stays opt-in; `rewards` stays in-app on, as in S23. One notice per ledger entry or redemption event. Params are ids and codes only. Emails do not carry amounts, reward names or reasons. The recipient is the owner and nobody else.

## Database (`20261111090000_personal_points_rewards.sql`)

Provisional. S28's brief names `20261110090000_habits.sql`, which is not in the tree yet. The next committed migration is `20261109090000_meal_planner.sql`. Use `20261111090000_personal_points_rewards.sql` unless that name, or any later `20261111090000_*`, already exists; otherwise take the next free `202611DD090000_` after the habits migration. Do not rename or edit a migration that another step has added.

Tables `personal_point_accounts`, `personal_point_entries`, `personal_rewards`, `personal_reward_redemptions`, `personal_reward_redemption_events`. No `home_id`. No trigger on chores, tasks, habits or goals. A comment in the migration says the rows are personally owned and are in scope for the later personal export and account deletion.

## Tests

- **Database:** the owner reads and writes their ledger and catalog; a second account, a Home Owner, an Administrator with `manageHomePoints`, a non-member, a staff account, and a forged user id cannot. No function returns another person's row. `authenticated` cannot select the tables. A Home points balance is unchanged by a personal credit, redemption or refund. Home deletion and leaving a Home leave the personal ledger in place. Two redemptions racing for the last points: one spends, one gets `insufficient_points`. A retry with the same client id posts once. A reversal posts once. A refund posts once. The cached balance matches the ledger. Zero Homes is enough; no membership fixture is required.
- **Unit:** permission matrix (owner versus everyone else), schemas reject `homeId`, adjustment and cost bounds reuse `POINTS_LIMITS`, components with axe.
- **Playwright:** a person with no Home posts a credit, creates a reward, redeems it and sees the new balance; a second person cannot open that ledger; the Home points page does not show the personal balance. Axe in both themes.

## Acceptance criteria

1. Personal rows have no `home_id` and do not live in `point_accounts`, `point_entries`, `rewards` or the other S23 tables.
2. A person with zero Homes can credit, correct, reverse, define a reward, redeem, mark fulfillment and refund, within the bounds in Defaults.
3. Another account, every Home role, and staff get nothing: no row, no count, no name, no error that reveals that the ledger exists.
4. No API combines the two balances or moves points from one to the other.
5. Home points tests still pass without modification, apart from a count that grows only if this step adds a shared capability (it must not).
6. The migration comment and the account key are enough for a later export and account-deletion step to select these rows by user id.

## Out of scope

Changing the Home ledger, its pages, its capabilities or its widgets (S23). Automatic points from tasks, chores, habits or goals (MOD L70; PS L2966 and L2984 for goals; PS L2957, "Habit completion does not automatically award reward points unless a separately approved reward rule explicitly allows it"; S28 brief L68, "points or rewards for habits"). Numeric habits (S29) and goals (S30). A personal leaderboard or a personal weekly target (the spec's leaderboard and weekly target are Home-scoped: PS L1407–L1426, L1555–L1569, MOD L69). Ora celebrations (S45). Household Display rendering (S43–S44), beyond not offering this widget there. Guardian and child accounts (S41, ARCH §34). Building export or account deletion (S15 cites exports as S38; S08 cites deactivation and deletion as S38–S40; S16 and ADR 0020 cite 30-day account recovery as S40; those citations disagree, and this step does not resolve them). Realtime: the pages refresh after the owner's own change.

## Defaults picked (Ward may override)

1. **How points are earned is not in the spec.** MOD L70 says scoring rules need a supporting specification and that not every completed task awards points. PS L2966 and L2984 do not imply automatic rewards for goals. PS L2957 says habit completion does not automatically award reward points unless a separately approved reward rule explicitly allows it. No such rule exists for personal points. Default: the only credit is an explicit self-posted `credit` with a reason (3–300 characters, preview, confirm). No module posts points into this ledger.
2. Immediate redemption only. No approval queue and no reserved points. Fulfillment and a one-time refund or replacement stay, performed by the owner, reusing the S23 states.
3. Personal points do not expire. The spec's never-expire sentence is about Home points (PS L1452–L1456); this copies it as a default.
4. Optional availability window, total limit and per-period limit, same bounds as `POINTS_LIMITS` and `memberPeriods` in `packages/domain/src/points`. Unlimited when unset. The period uses the account timezone and week start.
5. Name 1–80, description ≤ 500, cost 1–100 000, at most 200 active rewards. Those numbers are S23's `POINTS_LIMITS`, not a spec sentence.
6. Notifications as in the API section: account-level, owner only, Home overrides ignored.
7. Adults only. No guardian read. S41 must not assume a guardian can see this ledger; that question is still open.
8. One step, one migration, one ADR.

## Docs the implementation step writes

This brief does not write them. The implementation step adds the next ADR after S28's (S28's brief expects ADR 0035, so this one is 0036 if 0035 is taken; otherwise the next free number), a `docs/development.md` section, the migration note in `docs/supabase-migrations.md`, a regenerated `docs/production-migrations.md`, and a user-story entry. Do not hand-edit the generated migration bundle. Do not edit `CLAUDE.md`, `architecture.md` or `docs/product/`.

## Risks

- A nullable `home_id` on the S23 tables would let a Home path see personal rows. Separate tables with no `home_id` are the fix.
- A `security definer` function that forgets `auth.uid()` would expose every ledger. Tests must call it as someone else.
- The service role bypasses RLS. The API must not use it for these reads or writes. There is no staff function to add.
- `20261111090000` can collide with S28 or S29 if either lands a migration with that timestamp. The name above is provisional.
- Self-posted credits are a default, not a spec rule. Shipping them without Ward's eye on Default 1 would freeze an earning rule the spec left open.
- Cascade on `auth.users` is wrong if account deletion removes the auth user before the 30-day recovery ends. The deletion step has to check that before relying on the cascade.
- PS L658 does not list a points category. The export step has to add one on purpose; this schema only keeps the rows addressable.

## Progress

- [x] Brief
- [ ] Domain and migration
- [ ] Database tests
- [ ] API and data layer
- [ ] Interface
- [ ] Playwright
- [ ] Docs (ADR, development.md, supabase-migrations.md, production-migrations.md, user stories)
- [ ] Full suite
- [ ] Independent review
