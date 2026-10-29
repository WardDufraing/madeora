# S30 · Goals core — feature brief

**Branch:** `feat/goals`, from `main` at `1eb1d68` (S29 merged as PR #52).
**Sources (read only these ranges):** build plan S30; PS L2916–L3019 (goals) and L3187–L3194 (the goal half of the interactive widgets); `plans/steps/S28-brief.md` and `plans/steps/S29-brief.md` (the habit module this mirrors and S30c links to).
**Model:** Opus (Ward chose it on 29 Oct 2026): a contribution ledger with corrections and concurrency, achievement history, reminders, RLS, and later the habit sync.
**Split (Ward, 29 Oct 2026):** the spec range holds eight approved decisions, split in three: **S30** goals core (this brief), **S30b** recurring weekly/monthly/yearly series with period finalization and target effective periods, **S30c** habit-to-goal links (multiple links per habit, historical start, unlink retain/remove, recompute on corrections), which carries the build plan's done-condition.
**Done when (core):** create, contribute, correct, achieve, reopen, renew and archive work with RLS tests across Homes; concurrent contributions sum exactly; deadline reminders never fire retroactively. (Build plan, for S30c: the "Habit to goal" journey passes, including a correction that recalculates.)

## What already exists

Homes, roles and delegable capabilities (S09/S12), notifications with categories, Home overrides and quiet hours (S14), the outbox and Trigger.dev jobs (S13), trash (S16), dashboard registry (S17), habits with numeric units (S28/S29: unit catalogue, exact decimals, locale entry). Nothing about goals exists.

## Model

- **Context:** a person's Personal space or one Home, like habits. **Timezone:** a Home goal uses the Home's timezone; a personal goal stores its own (the creator's effective timezone, editable). Dates are local calendar dates.
- **Goal:** title (1–80), optional description (≤ 500), type `completion` or `measurable` (fixed after creation), optional deadline (a date), archived flag, revision, optional `renewed_from` (the completed goal it continues).
- **Measurable goals:** target (> 0, ≤ 1,000,000,000, at most 3 decimals) and unit: a preset of the habit catalogue (`glasses`, `pages`, `repetitions`, `ml`, `l`, `min`, `h`, `m`, `km`) or a custom label (1–20 characters, e.g. `books`, `€`). Discrete presets take whole numbers only. Initial progress (default 0) is stored as the first ledger entry (`initial`), so a manual baseline stays identifiable.
- **Ledger** (`goal_entries`, append-only): every change of a measurable goal's progress is an entry with a signed quantity, the contributor, recording time, kind (`initial`, `contribution` = an addition, `adjustment` = a manager's "set total to" recorded as the difference), optional plain-text note (≤ 280), source (`app`, `widget`) and a client id for idempotent retries. Entries are never deleted: a **correction** amends an entry's quantity or reverses it, recorded in `goal_entry_corrections` (before, after, actor, time, optional reason ≤ 200). The total is the exact decimal sum of active entries' current quantities. A change that would make the total negative is refused (`negative_total`). Values above the target are kept and shown; only the bar caps at 100%.
- **Achievement:** reaching the target never changes the state by itself; the goal shows "Target reached" and offers **Mark achieved**. Achieving records a row in `goal_achievements` (when, who, total and target at that moment); **Reopen** marks that row reopened (who, when, optional reason) and the goal is active again. History is never erased. Completion goals: **Mark achieved** is the only progress.
- **States:** Active, Overdue (deadline before today, not achieved; a label, never a failure), Achieved (the Completed section), Archived. A passed deadline changes nothing else.
- **Target and unit changes:** a target change records its before/after in the history; on an achieved goal whose total falls below the new target the answer asks for explicit confirmation (`confirm_status`) and then reopens the achievement (recorded). A unit change on a goal with progress needs `confirm_unit` (the existing numbers are reinterpreted; never converted silently). Stale previews (revision moved) answer `conflict`.
- **Renew / duplicate:** opens the New goal form prefilled from a completed goal (title, type, target, unit, description, context); progress starts at 0, status active; the new goal stores `renewed_from`. A Home goal can be renewed into the same Home or Personal space; any other Home only where the person may create goals (the create call checks the target context).
- **Increase target:** on an achieved measurable goal: **Extend this goal** (target change; the achievement stays in history; if the new target is above the total the goal reopens after `confirm_status`) or **Create a follow-up goal** (the renew form with the new target).
- **Deadline reminders** (`goal_reminders`, one per goal, off by default): needs a deadline; an advance reminder N days before (1–90) and/or an overdue reminder N days after (0–30, 0 = on the day after the deadline), at a local time (default 09:00). The page previews the next moment and says when a lead time has already passed (that one is skipped, never sent late). Recipients: the personal goal's owner; for a Home goal every current member who may view it and has not turned that goal's reminders off for themselves. Category `reminders`, quiet hours and Home overrides as in S14. Delivery: outbox job `goal-reminder` per goal and moment, rechecked at delivery (revision, deadline, achieved, archived, deleted, access); more than 30 minutes late is skipped. Changing the deadline, reminder settings, achieving, archiving or deleting moves the revision so old jobs do nothing; Reopen does not turn reminders back on by itself: the reminder is kept but its next moment is recomputed only when it is still in the future.
- **History** (`goal_events`): created, edited, target changed, unit changed, deadline changed, contributed, adjusted, corrected, reversed, achieved, reopened, archived, unarchived, restored, reminders changed. Ids, codes and numbers only (no note text).
- **Archive and delete:** archive/unarchive (managers) hides the goal from lists, widgets and reminders but keeps everything; delete moves it to the trash for 7 days (S16), restore brings it back unchanged.

## Who may do what (defaults picked, Ward may override)

| Action                                                                                                   | Personal goal | Home member (goal access **Contribute**, default) | Home member (**View only**) | Goal managers |
| -------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------- | --------------------------- | ------------- |
| See goals, progress, contribution history with names and dates                                           | owner         | yes                                               | yes                         | yes           |
| Add a contribution; reverse their own contribution                                                       | owner         | yes                                               |                             | yes           |
| Mark a completion goal achieved                                                                          | owner         | yes                                               |                             | yes           |
| Correct or reverse anyone's entry, "set total", mark a measurable goal achieved, reopen                  | owner         |                                                   |                             | yes           |
| Create, edit, target/unit, deadline, reminders, archive, delete, renew into this Home; set member access | owner         |                                                   |                             | yes           |
| Turn a Home goal's reminders off for oneself                                                             | owner         | yes                                               | yes                         | yes           |

- **Goal managers:** the Owner and Administrators granted the new delegable capability `manageHomeGoals`.
- Engine: `packages/domain/src/permissions/goals.ts`; SQL `private.goal_access(home, user)` returns `manage` / `contribute` / `view` / null.
- Personal goals and their entries are never visible to anyone else, Home managers included. A member who leaves loses access; their past entries stay with their name shown as a former member.

## Interface

- **Goals** in the sidebar: `/goals` (Personal) and `/homes/[homeId]/goals`: Active goals (with Overdue label), a **Completed** section and an **Archived** view; New goal (title, type, target and unit for measurable, initial progress, optional deadline, description, timezone for personal).
- **Goal page** `/goals/[goalId]`: status, progress (value / target unit, percentage, bar capped at 100% with uncapped text and an over-target amount), "Target reached" with **Mark achieved**, **Add progress** (amount with locale decimal entry, resulting total preview, optional note; Undo toast for 10 s), **Set total** (managers), contribution history (who, when, kind, note, corrections; Correct / Reverse where allowed), achievement history, Edit, Change target (with Extend / Follow-up when achieved), Deadline reminders, Archive, Delete, Renew, my reminders on/off (Home).
- **Widgets:** **Goals** (the context's active goals: progress and status; **Add progress** compact editor showing current value, target, unit, entered amount, resulting total and Home; **Mark achieved** for completion goals where allowed; read-only otherwise) and **Goal progress** (one chosen goal; missing or inaccessible goal shows an explicit state). Achieved goals leave the Goals widget; Goal progress keeps showing a chosen achieved goal with "Achieved".

## API

`GET/POST /api/v1/goals` (list with `homeId`, `view=active|completed|archived`, `q`; create), `GET/PATCH/DELETE /api/v1/goals/:id`, `POST /api/v1/goals/:id/target` (preview or apply), `POST /api/v1/goals/:id/entries` (contribute or set total), `GET /api/v1/goals/:id/entries?before=`, `PATCH /api/v1/goal-entries/:id` (amend or reverse), `POST /api/v1/goals/:id/achievement` (achieve or reopen), `POST /api/v1/goals/:id/archive`, `PUT /api/v1/goals/:id/reminders`, `PUT /api/v1/goals/:id/my-reminders`, `GET /api/v1/goals/:id/history`, `PATCH /api/v1/goals/settings` (member access). Same CSRF, JSON, size, session and outcome mapping as the habit routes.

## Database (`20261113090000_goals.sql`)

Tables `goal_settings`, `goals`, `goal_entries`, `goal_entry_corrections`, `goal_achievements`, `goal_reminders`, `goal_reminder_optouts`, `goal_events`; capability `manageHomeGoals`; notification kind `goal.reminder`; trash module `goals`, item type `goal`; audit subject `goal`. Every function is security definer with the person's session; no table is exposed. Every change takes the goal's row lock, so concurrent contributions serialize and the total stays exact.

## Tests

- **Database:** access matrix (owner; contribute/view member; manager; Administrator with and without the capability; non-member; forged ids; departed member); personal goals invisible to Home managers; cross-Home isolation for every read and write; create validation (zero/negative target, precision, discrete unit, custom label); contributions (decimal sums 0.1 + 0.2, retry same id, id reuse), set total, corrections (own reverse, manager amend/reverse anyone's, member refused on others, negative total refused), target reached without achievement, achieve/reopen history, target change with `confirm_status`, unit change with `confirm_unit`, deadline passed (overdue, nothing lost), archive/trash/restore; reminders (deadline required, recipients and opt-out, achieved/archived suppress, late skip, lead already passed skipped, deadline change reschedules). **Concurrency:** two members contributing at once (both counted once), duplicate retry racing.
- **Unit:** schemas, permission matrix, progress math, routes, components with axe.
- **Playwright:** create a measurable goal, add progress twice (decimal), exceed the target, Mark achieved, see it in Completed, reopen; completion goal; Goals widget Add progress.

## Out of scope (this step)

Recurring series and period finalization (S30b), habit-to-goal links and synced progress (S30c), Household Display rendering (S43–S44), push/email action buttons, Ora, points or rewards for goals, milestones/subtasks/dependencies (not approved).

## Defaults picked (Ward may override)

1. Permissions as in the table; Home members contribute by default; managers (`manageHomeGoals`) configure and may set members to view only.
2. Members with contribute access may mark a completion goal achieved; only managers mark a measurable goal achieved and reopen any goal.
3. Contributions are positive; "set total" (managers) records a signed adjustment; the total never goes below 0.
4. Members reverse only their own contributions; managers correct or reverse any entry with an optional reason. No time window.
5. The unit is required for measurable goals (preset or custom label); target cap 1,000,000,000; 3 decimals.
6. Reminders: one advance (1–90 days) and one overdue (0–30 days) moment at one local time; recipients are all viewers of a Home goal minus personal opt-outs.
7. Limits: 100 non-archived goals per context, title 80, description 500, note 280, reason 200.
8. Contribution history with names is visible to every viewer of a Home goal.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests
- [x] API and data layer
- [x] Interface and widgets
- [x] Unit, route and component tests
- [x] Playwright
- [x] Docs (ADR 0038, user stories, notifications, background jobs, development, supabase-migrations, production-migrations, roadmap)
- [x] Full suite
- [x] Independent review
