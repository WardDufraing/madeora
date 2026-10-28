# S27 · Meal planner — feature brief

**Branch:** `feat/meal-planner`, from `main` at `34cfa13` (S26 merged as PR #43).
**Sources (read only these ranges):** build plan S27; PS L2550–L2565 (meal-planner widgets; date-range shopping transfer), L2662–L2703 (print view, copy week, recurring entries, recipe and custom entries, configurable slots); Project-entry L85 ("Plan dinner" journey); ARCH §8, §9, §11, §36, §40; ADR 0020 (trash), 0021 (dashboards), 0031/0032 (recipes, sharing: "meal-plan impact is added by S27"), 0033 (shopping).
**Model:** Opus (virtual recurring occurrences with exceptions and series splits, occupancy without silent overwrite, copy-week and transfer staleness, RLS and concurrency).
**Done when (build plan):** the "Plan dinner" journey passes end to end: save/select a recipe → plan the meal → transfer selected ingredients → check off the shopping items.

## What already exists

Recipes with sharing (`recipe_visible_in`, exact fraction quantities, `servings` yield), shopping lists with `add_shopping_items` (client ids, duplicate answers, per-row outcomes), trash (S16), dashboard registry (S17), task "today" rule for Personal dates (`private.task_today`: the app passes its date, accepted within a day of UTC), user week-start preference (`monday`/`saturday`/`sunday`). The sidebar's Meals opens Recipes. Nothing about meal planning exists.

## Model

- **Context:** a person's Personal space or a Home, like shopping. Dates are local calendar dates (no times). "Today" is the Home's timezone for a Home and the app's date for the Personal space (task rule). Weeks start on the viewer's week-start preference.
- **Slots** (`private.meal_slots`): per context; stable id; `standard_key` (`breakfast`, `lunch`, `dinner`) or null for custom; optional stored name (null = the translated standard name); position; enabled. The three standard slots are created on the first open of the context's planner (by `get_meal_plan`, idempotent). At most 8 slots; names 1–30 visible characters, distinct within the context (case/accent-insensitive, including the en and nl names of unrenamed standard slots). Rename, reorder (Move up/down), add, disable, re-enable. **Disabling** shows the impact (planned meals from today on, earlier meals, repeating series in the slot) and needs that impact confirmed (token); nothing is deleted or moved: existing meals stay visible under the slot marked "Disabled slot", series in it produce no occurrences while it is disabled (flagged "Its slot is disabled"), and no new meal can be placed in it. Re-enabling restores everything without duplicates.
- **Meals** (`private.meal_entries`): date, slot, and either a **recipe** (durable reference; optional servings 1–99) or a **custom meal** (title 1–120, required). Optional notes ≤ 1000 for both. Revision; created/updated by and at. **One meal per date and slot** (spec: no unrestricted multiple meals per slot), enforced by a unique index for concrete meals and by the context lock for repeating occurrences. Removal goes to the trash (7 days; restore refused with `meal_slot_occupied` if the slot is taken meanwhile).
- **Recipe display:** a recipe meal shows the recipe's current name and link only if the viewer may see that recipe **from the planner's context** now (`recipe_visible_in(recipe, context Home, viewer)`; the Personal space: recipes that live there); otherwise "Recipe unavailable" with no name, ingredients or notes of the recipe. The meal itself is kept (never turned into a custom meal). The recipe picker offers recipes visible in the planner's context.
- **Repeating meals** (`private.meal_series` + segments `private.meal_recurrences`): a recipe or custom meal repeated **daily**, on **chosen weekdays** (at least one), or **weekly** (the start date's weekday), with a start date and optional end date, in one slot. Occurrences are **computed, not stored**: an occurrence's identity is (segment, date), so retries, outages and two devices can never create duplicates or a backlog. **Exceptions** (`private.meal_occurrence_exceptions`, key segment + date): `skipped` (removed occurrence) or `detached` (edited or moved occurrence, now a concrete meal that remembers its origin).
  - **Edit one occurrence:** becomes a concrete meal (detached); the series continues. **Move one occurrence:** the same, at the new date/slot (the dialog explains it). **Remove one:** skipped, with Undo.
  - **Edit this and future** (from a date ≥ today): the current segment ends the day before and a new segment of the same series starts on that date; past occurrences are never rewritten; skipped exceptions on later dates move to the new segment. A segment that has not started yet is edited in place.
  - **Pause:** the current segment ends today (today's occurrence stays as history). **Resume** from a date ≥ tomorrow: preview, then a new segment. **End** from a date: the segment ends the day before.
- **Conflicts:** placing a single meal, rescheduling, starting/resuming/editing a series, or copying a week into an occupied date/slot (concrete or repeating) answers `occupied` with what is there; the person explicitly chooses to keep the existing meal (cancel/skip) or **replace** it (the existing concrete meal goes to the trash; an existing occurrence is skipped). Series previews check the next 366 days (or until the end date); occurrences that collide later, or because another series was created, are shown as an **unresolved conflict** in the slot (both meals listed) with Skip this occurrence, Move it, or Replace the other. Nothing is displaced automatically.
- **Copy week** (same context only): preview of the source week's concrete meals and occurrences mapped to the same weekday and slot of the destination week, with flags: recipe unavailable (not copyable), slot disabled (not copyable), destination occupied (choose skip or replace), each row excludable. Copies are standalone concrete meals (never series), keeping recipe, servings, title and notes. Commit sends a preview token (source and destination fingerprint; changed → `stale`, reload preview) and per-row client ids (retry never duplicates); answer per row (`created`, `exists`, `skipped`, `occupied`, `unavailable`).
- **Date-range shopping transfer** (inclusive range ≤ 31 days): preview lists each actual occurrence once (concrete meals and computed occurrences, never skipped ones), excludes custom meals ("no ingredients") and unavailable recipes (no details), and builds one editable row per ingredient (never merged): scaled by meal servings ÷ recipe servings when both exist (else unscaled, labelled "Not scaled"); exact fractions shown as decimals with at most 3 places, inexact values marked "≈"; recipe units that shopping supports are kept, other units become the item's packaging text (labelled); ingredient notes become item notes. Duplicate active items in the destination list are marked. The destination is one active list of the **same context** with edit access. Commit revalidates everything (preview token), adds rows through the shopping item rules with client ids (`add_shopping_items`), records a `meal_shopping_transfers` row (who, when, list, range, count) and links the items to it. Never automatic; items do not change later if meals or recipes do.
- **Print view:** `…/meals/print?week=` preview of the week (enabled slots in order, plus disabled slots that hold meals, recipe/custom titles, "Recipe unavailable", repeating marks), **Include notes** off by default, a short privacy reminder, Cancel and **Print** (re-reads the week's token first; changed → "The plan changed" with Refresh). Print stylesheet: no navigation or buttons, high contrast, no backgrounds, page breaks between days, long titles wrap. No export file.

## Who may do what (defaults picked, Ward may override)

| Action                                                                | Personal space | Home member (planner access **Edit**, default) | Home member (access **View only**) | Meal managers |
| --------------------------------------------------------------------- | -------------- | ---------------------------------------------- | ---------------------------------- | ------------- |
| View the plan, print it                                               | owner          | yes                                            | yes                                | yes           |
| Add, edit, move, remove meals; repeating meals; copy week             | owner          | yes                                            |                                    | yes           |
| Transfer ingredients (also needs edit access to the destination list) | owner          | yes                                            |                                    | yes           |
| Configure slots, set the Home's planner member access                 | owner          |                                                |                                    | yes           |

- **Meal managers:** the Owner and Administrators granted the new delegable capability `manageHomeMeals`.
- Engine actions in `packages/domain/src/permissions/meals.ts`; SQL `private.meal_access(home, user)` returns `manage` / `edit` / `view` / null.
- Trash restore follows the S16 rule.

## Widget

New widget type **Meal planner** (personal dashboard: Personal space or a bound Home; Home dashboard: that Home). Settings per instance: mode **Today**, **Selected day** (with a date) or **Compact week**. Shows enabled slots in order with each meal (recipe/custom/unavailable distinguished, repeating marked, conflicts flagged) and empty slots; week mode shows each day with short labels and "+N more" on narrow sizes. Quick actions where allowed: add, edit, reschedule and remove through the same meal dialog (with the one/future choice for occurrences); read-only otherwise. Links to the planner and to recipe details when visible.

## API

`GET /api/v1/meals/plan` (`?homeId&from&to`, ≤ 42 days, also opens the planner), `POST /api/v1/meals/entries`, `PATCH/DELETE /api/v1/meals/entries/:id`, `PUT/DELETE /api/v1/meals/occurrences/:recurrenceId/:date` (edit or move one; skip one), `POST /api/v1/meals/occurrences/:recurrenceId/:date/restore` (undo skip), `POST /api/v1/meals/series` (`preview` or create), `PATCH /api/v1/meals/series/:id` (`preview` or `editFuture` / `pause` / `resume` / `end`), `POST /api/v1/meals/slots`, `PATCH /api/v1/meals/slots/:id` (rename, disable with impact token, enable), `GET /api/v1/meals/slots/:id/impact`, `POST /api/v1/meals/slots/:id/move`, `PATCH /api/v1/meals/settings`, `GET/POST /api/v1/meals/copy-week`, `GET/POST /api/v1/meals/shopping-transfer`, `GET /api/v1/meals/recipes` (picker). The widget reads `plan`; no separate widget route. Same CSRF, JSON, size, session and outcome mapping as earlier steps.

## Database (`20261109090000_meal_planner.sql`)

Tables `meal_settings`, `meal_slots`, `meal_entries`, `meal_series`, `meal_recurrences`, `meal_occurrence_exceptions`, `meal_shopping_transfers`; column `shopping_items.meal_transfer_id`; capability `manageHomeMeals`; trash module `meals` with item type `meal_entry`; `recipe_delete_impact` gains the planned-meal count (today onward, concrete and active series; a number only). All access through security-definer functions with the person's session; no table exposed; every write takes the context lock (`meal_plan:<context>`), so occupancy is decided one at a time per context.

## Tests

- **Database:** access matrix (Personal owner; Home member edit/view; manager; Administrator with and without the capability; non-member; forged ids; departed member); cross-Home isolation for every read and write; slots (defaults once, rename/duplicate names, reorder, limit, disable impact and token, disabled slot refuses new meals, re-enable); meals (recipe/custom, empty title refused, occupied answer and explicit replace, revision conflict, move, trash and restore conflict); recipe unavailable (deleted, share removed, other context) reveals nothing; series (daily, weekdays, weekly, end date, collisions preview and decisions, skip/undo, detach edit and move, edit-future split without changing the past, pause/resume, end, two colliding series → unresolved conflict); copy week (mapping, exclusions, occupied skip/replace, recurring source copied as concrete, stale token, idempotent retry); transfer (occurrence counted once, skipped excluded, scaling 4→6, no yield, custom skipped, unavailable recipe, duplicate marking, other-context list refused, archived list, stale token, retry); widget reads; recipe delete impact count. **Concurrency:** two sessions placing a meal in the same empty slot (one wins, one `occupied`); a series create racing a single meal; two identical copy-week commits.
- **Unit:** occurrence computation (weekdays, weekly, end dates, exceptions, segments), week boundaries for each week start, quantity scaling and rounding, unit mapping, permission matrix, schemas, routes, components with axe.
- **Playwright:** "Plan dinner": create a recipe, plan it for dinner, transfer its ingredients to a list, check an item off; custom meal; repeating meal with edit one occurrence; copy week; print preview.

## Out of scope

Ora meal scheduling (S45), Household Display presentation (S43–S44), notifications, Realtime (pages refresh after one's own changes, on focus and every 60 s while visible), drag-and-drop, meal suggestions or generated menus, nutrition, pantry, calendar export, cross-context copies or transfers.

## Defaults picked (Ward may override)

1. Permissions as in the table: Home members plan by default; a Home's meal managers (new `manageHomeMeals`) configure slots and may set the Home's planner to view-only for members.
2. Limits: 8 slots per context, slot names 30, custom titles 120, notes 1000, servings 1–99, 100 active series per context, plan reads ≤ 42 days, transfers ≤ 31 days, series conflict preview 366 days.
3. One meal per date and slot; replacing always explicit; removed meals go to the trash.
4. Repeating occurrences are computed (not stored) with skip/detach exceptions; edits to "this and future" split the series so the past never changes.
5. Disabling a slot keeps its meals visible as "Disabled slot" and stops its series' occurrences until re-enabled; it needs the impact confirmed.
6. Recipe meals show the recipe only when it is visible from the planner's context; otherwise "Recipe unavailable".
7. Transfer: unsupported recipe units go to the item's packaging text; quantities shown with at most 3 decimals ("≈" when rounded); one row per ingredient, never merged.
8. No Realtime for the planner; refresh on own changes, focus and every 60 s.
9. Week start follows the viewer's preference; the sidebar's Meals opens the planner, with a link to Recipes.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests
- [x] API and data layer
- [x] Interface and widget
- [x] Unit, route and component tests
- [x] Playwright
- [x] Docs (ADR 0034, US-027, development, supabase-migrations S27 check, production-migrations)
- [x] Full suite (format, lint, typecheck, unit, build, DB 124, e2e 173)
- [x] Independent review (`reviews/steps/S27-review.md`: CHANGES_REQUIRED, HIGH-1 fixed and verified; MEDIUM-1 and MEDIUM-3 fixed)

## Implementation notes

- **Duplicate marking in the transfer** happens at commit, not in the preview: `add_shopping_items` answers `duplicate` per row, and the result offers "Add again as separate items" for those rows under the same transfer id (client ids keep a retry from duplicating).
- **Print "page breaks between days"** is implemented as `break-inside: avoid` per day (a day never splits across pages) rather than a forced page per day, so a week stays on as few pages as possible.
- **Widget week mode** shows up to 3 meals per day, then "+N more".
- `update_meal_slot` takes `p_name` and `p_enabled` with defaults (null = unchanged); a null `p_enabled` is refused.
