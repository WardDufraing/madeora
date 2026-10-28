# ADR 0034: Meal planner

- **Status:** Accepted for S27 within the approved architecture (§8, §9, §11, §36, §40), CLAUDE.md (database access A, authorization C, realtime C, data fetching B, forms A, date/time A, €0 budget) and the spec's meal-planner sections (PS L2550–L2565, L2662–L2703; Project-entry L85). The defaults below are open to correction by the owner.
- **Date:** 2026-10-28
- **Step:** S27 (brief: `plans/steps/S27-brief.md`). Builds on ADR 0020 (trash), 0021 (dashboard engine), 0031 and 0032 (recipes and sharing) and 0033 (shopping lists).

## Context

The spec asks for a planner per Personal space or Home with configurable meal slots, recipe and custom meals, repeating meals with per-occurrence changes, copying a week, a printable week, a dashboard widget and a reviewed transfer of a date range's ingredients to a shopping list. The "Plan dinner" journey (select a recipe, plan it, transfer its ingredients, check them off) is the done-condition.

## Decision

**One migration, no exposed tables.** `20261109090000_meal_planner.sql` adds `private.meal_settings`, `meal_slots`, `meal_entries`, `meal_series`, `meal_recurrences`, `meal_occurrence_exceptions` and `meal_shopping_transfers`, plus `private.shopping_items.meal_transfer_id`. Every read and change is a `security definer` function run with the person's session; RLS is enabled and nothing on the private tables is granted. Every write takes the context lock (`meal_plan:<context>`), so occupancy is decided one change at a time per context.

**Who does what (defaults picked).** The Personal space is its owner's alone. In a Home every current member views and prints the plan; members plan meals unless the Home's planner member access is set to view only. Meal managers (the Owner and Administrators granted the new delegable capability `manageHomeMeals`) configure slots and that access. Transferring ingredients also needs edit access to the destination shopping list. `private.meal_access` answers `manage` / `edit` / `view` or null; `packages/domain/src/permissions/meals.ts` mirrors it for the interface only.

**Slots.** Breakfast, Lunch and Dinner are created on the first open of a context's planner (`get_meal_plan`, idempotent). At most 8 slots; names up to 30 characters, distinct within the context including the English and Dutch names of unrenamed standard slots. Slots are renamed, moved up or down, added, disabled and re-enabled, never deleted. Disabling needs its impact (meals from today, earlier meals, repeating meals) confirmed with a token; meals stay visible under "Disabled slot", its repeating meals produce nothing while it is disabled and no new meal goes in.

**One meal per date and slot.** A concrete meal is unique by a partial index; repeating occurrences are checked under the context lock. A taken slot answers `occupied` with what is there and a `replaceKey`; replacing is always explicit (a concrete meal goes to the trash, an occurrence is skipped). A recipe meal shows its recipe only when the viewer may see it from the planner's context now (`recipe_visible_in`), otherwise "Recipe unavailable" with nothing of the recipe; the meal is kept.

**Repeating meals are computed, not stored.** A series has segments (`meal_recurrences`: slot, daily / weekdays / weekly, start, optional end). An occurrence is identified by (segment, date) and computed on read, so retries, two devices or an outage never create duplicates or a backlog. Exceptions mark one date `skipped` (Undo restores it) or `detached` (edited or moved: it becomes a concrete meal that remembers its origin). "This and future" from a date at or after today ends the segment the day before and starts a new one, so past occurrences never change. Pause ends the segment today; Resume (from tomorrow on) and End take a date. Creating, resuming or editing a series previews collisions for up to 366 days with a token and needs a skip or replace choice per date; collisions that arise later appear in the slot as an unresolved conflict with both meals listed.

**Today.** For a Home it is the Home's time zone; for the Personal space the app's date, accepted within a day of UTC (`private.task_today`, as for tasks).

**Copy week and transfer use preview tokens.** Copy week maps the source week's concrete meals and occurrences to the same weekday and slot of the target week as standalone meals; unavailable recipes and disabled slots are not copyable, occupied targets need skip or replace, each row has a client id, and a changed plan answers `stale`. The shopping transfer (at most 31 days) lists each actual meal once, skips custom meals and unavailable recipes, and builds one editable row per ingredient, scaled by meal ÷ recipe servings when both exist (with at most 3 decimals and "≈" when rounded), units the shopping list does not know moved to the packaging text. The commit re-checks the token and adds the rows through `add_shopping_items` with client ids, so a retry returns the same items; rows answered as a duplicate can then be added again as separate items with the same transfer id. Each transfer is recorded in `meal_shopping_transfers` and its items link to it. Items never change later when meals or recipes do.

**No Realtime.** The planner refreshes after one's own changes, on focus and every 60 s while visible (TanStack Query), which the spec's collaborative needs here do not exceed.

**Trash and recipes.** Module `meals`, item type `meal_entry`; a restore into a taken slot reports `meal_slot_occupied`. `recipe_delete_impact` gains the counts of planned meals (today onward) and repeating meals using the recipe, as numbers only.

**Interface and API.** The sidebar's Meals opens `/meals` or `/homes/:id/meals` (week or day view, with a Recipes link) and stays active on Recipes; `…/settings`, `…/copy`, `…/shopping` and `…/print` are their own pages. The print page has Include notes off by default, a privacy reminder, re-checks the plan before printing and uses a print stylesheet without navigation or controls, keeping each day together. The dashboard gains a Meal planner widget (Today, a selected day or a compact week). Routes live under `/api/v1/meals/`: `plan`, `recipes`, `entries` (+ `:id`), `occurrences/:recurrenceId/:date` (+ `restore`), `series` (+ `:id`), `slots` (+ `:id`, `impact`, `move`), `settings`, `copy-week` and `shopping-transfer`, with the CSRF, JSON, size, session and outcome mapping of earlier steps. The widget reads `plan`.

## Consequences

- Any new write to the planner must take the context lock, or two people could fill one slot twice.
- A new read that lists meals must include computed occurrences and their exceptions, never only `meal_entries`.
- Occurrences are recomputed on each read; reads are capped at 42 days to keep that cheap.
- Ora meal actions (S45), Household Display presentation (S43–S44), notifications, drag and drop, generated menus, nutrition, pantry, calendar export and cross-context copies or transfers are out of scope.
- The migration is forward-only like every other; repairing it on production means a new migration.
