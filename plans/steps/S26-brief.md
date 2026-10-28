# S26 · Shopping lists — feature brief

**Branch:** `feat/shopping-lists`, from `main` at `88a3946` (S25 merged as PR #42).
**Sources (read only these ranges):** build plan S26; PS L2722–L2792 (shopping widget list selection and quick actions, recurring items, multiple independent lists, moves and copies within a context, structured quantities and units, quick add and reviewed multi-item entry, manual categories and item order, synchronized completion lifecycle); ARCH §8, §9, §11, §36, §40; ADR 0022 (tasks lists pattern), 0027 (Realtime signal pattern), 0031 (recipes).
**Model:** Opus (RLS for list-level access modes, realtime, idempotent recurrence without backlog, concurrent check-offs and transfers).
**Done when (build plan):** two members see each other's check-offs live, scoped to their Home.

## What already exists

Trash (S16) with the dispatch wrapper pattern; dashboard registry (S17); tasks lists show the Personal + Home context pattern (S18); the chore pool's per-Home Realtime signal row (S21, ADR 0027); delegable capabilities (S12). The sidebar's Shopping entry is still an unbuilt section. Nothing about shopping exists.

## Model

- **Lists** (`private.shopping_lists`) belong to exactly one context: a person's Personal space or a Home. Name 1–60 visible characters; duplicate names allowed (the interface shows the list's position and item count so two "Groceries" are distinguishable; nothing is merged). Manual order per context. Active, **Archived** (kept with items and history, out of active selection, widgets and quick-add destinations) or in the **trash** (7 days, restorable with its items). No default list is created; an empty state offers "Create your first list".
- **Categories** (`private.shopping_categories`) belong to one list: name 1–40, distinct within the list (case/accent-insensitive), manual order. Never suggested, inferred or created automatically. Removing one shows how many items it holds and moves them to Uncategorized after confirmation.
- **Items** (`private.shopping_items`): name 1–200 (required); optional quantity (finite, positive, at most 3 decimals, ≤ 100,000; `2`, `0.5`, `1.25`, comma or dot as decimal separator by locale); optional unit (pieces, g, kg, ml, cl, dl, l; a unit needs a quantity); optional packaging description ≤ 40 ("bottles", "pack"); optional notes ≤ 500; optional category of the same list. No conversions, rounding, aggregation or default quantity. Order: position within its group (a category, or Uncategorized). Active or **Completed** (completed at, completed by). Revision for edits.
- **History** (`private.shopping_item_events`): added, edited, completed, reopened, moved in/out, copied, recurred (automatic, no actor), cleared, restored. Ids, kinds, actor, time only. Shown per item ("History": last 20) and as "Completed by {member} · {time}" in the Completed section. Never shown to people who are not current members of the context.

## Who may do what (defaults picked, Ward may override)

| Action                                                                                                    | Personal space | Home member (list access **Edit**, default) | Home member (access **Check off only**) | Home member (access **View only**) | List creator (member) and shopping managers |
| --------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------- | --------------------------------------- | ---------------------------------- | ------------------------------------------- |
| View lists, items, categories, history                                                                    | owner          | yes                                         | yes                                     | yes                                | yes                                         |
| Check / uncheck                                                                                           | owner          | yes                                         | yes                                     |                                    | yes                                         |
| Add, quick add, multi-add, edit, delete items, reorder items, clear completed, move/copy, recurring items | owner          | yes                                         |                                         |                                    | yes                                         |
| Manage categories                                                                                         | owner          | yes                                         |                                         |                                    | yes                                         |
| Create a list in the context                                                                              | owner          | every current member                        |                                         |                                    | yes                                         |
| Rename, set access, archive/restore, delete a list                                                        | owner          |                                             |                                         |                                    | yes                                         |
| Reorder the context's lists                                                                               | owner          |                                             |                                         |                                    | shopping managers                           |

- **Shopping managers:** the Owner and Administrators granted the new delegable capability `manageHomeShopping`. The list's creator manages their own list while a member (being the creator after leaving grants nothing).
- **List access** (Home lists): `edit` (default), `check`, `view`, set per list by its managers. It applies to members who are not managers or its creator. Personal lists are the owner's alone.
- Engine actions in `packages/domain/src/permissions/shopping.ts`; SQL `private.shopping_access(list, user)` returns `manage` / `edit` / `check` / `view` / null.
- Trash restore follows the S16 generic rule (who deleted it, plus Owner and Administrators with `manageHomeSettings`), as for tasks and recipes.

## Quick add and reviewed multi-item entry

- **Quick add** in an active list: a name field and **Add**. Only the name is needed; optional fields are edited afterwards. A client id makes a retry return the same item. An active item with the same name (case/accent-insensitive) already in the list answers `duplicate` with its name; the form says "Milk is already on the list" with **Add anyway** and **Cancel** (never merged, never summed).
- **Add several** (`…/add-several`): a multiline field (one item per line; blank lines ignored; at most 100 lines). **Review** parses each line client-side into an editable preview row: a leading number and a supported unit are read only when unambiguous (`500 g pasta`, `2 l milk`, `6 apples` → quantity 6, no unit); anything else keeps the whole line as the name and is flagged "Check this line" with the original shown. Rows can be edited (name, quantity, unit, packaging, notes), removed, or the whole batch cancelled. Duplicates within the batch and against active items in the list are marked; each such row offers **Keep as separate item** or **Remove row** (no merge, no update action). Categories are never assigned. **Add N items** commits the remaining rows in one call; each row carries its own client id, so a retry after a partial failure never re-adds rows that succeeded; the answer is per row (`created`, `exists`, `invalid`, `duplicate`).

## Completion lifecycle (Realtime)

- Checking moves an item to the list's **Completed** section at once (newest first) with who and when; unchecking returns it to Active at its old place (position kept). Set-to-state: checking a completed item answers `unchanged` with who completed it; unchecking sends the completion it saw, and a newer completion answers `conflict` (the page reloads the state instead of overwriting).
- **Clear completed** shows the number of items and asks for confirmation; it clears exactly the completed items the person saw (ids sent; ones reopened meanwhile are left alone and reported). Cleared items go to the trash as **one entry** per clear ("3 completed items from Groceries"), restorable for 7 days (they come back as Completed). Unchecking is not recovering.
- **Realtime (per-feature mechanism, default picked):** Postgres Changes on `public.shopping_signals(context_id, version, changed_at)`: one row per context (a Home, or a person's Personal space), readable only by that Home's current members or that person (RLS), carrying no shopping content. A deferred trigger bumps it once per transaction when a list, category, item or recurring rule of the context changes. List, lists overview and widget pages subscribe to the rows of the contexts they show, compare versions on events, on (re)subscribe, on tab visible and every 5 s while visible (ADR 0027 approach), and re-read with the person's session (debounced). The channel ends on unmount, Home change and sign-out.
- **Offline:** an action that fails for lack of connection says so and offers **Try again** (same client id or set-to-state); nothing offline is reported as saved; stale views say "Showing the last loaded state" until a read succeeds.

## Lists, categories and ordering

- `/shopping` (Personal) and `/homes/:id/shopping` (Home): the context's active lists in order with active/completed counts, **New list**, **Archived** (`?view=archived`), Move up/down for those who may reorder. Sidebar Shopping follows the open Home.
- `/shopping/:listId` and `/homes/:id/shopping/:listId`: quick add, items grouped by category in category order then Uncategorized, Move up/down per item and per category, item editor (dialog) with fields, category, repeat, Move/Copy, Delete, History; Completed section (expandable) with Uncheck and Clear completed; list settings (rename, access, categories, archive, delete) for its managers.
- Ordering uses **relative moves** (move up / move down one place, or to a category), applied server-side under the list lock, so two people reordering at once never overwrite each other's order with a stale full order. Changing an item's category puts it at the end of the destination group. Reordering lists never reorders items.
- **Archive** shows the active-item count and that widgets stop showing it; archived lists are read-only until restored. **Delete** asks for the list name, its item count and that dashboard widgets showing it will say so; the list and its items go to the trash as one entry; restore brings them back (and access as it is now, not as it was).

## Moves and copies (same context only)

- From an item: **Move** or **Copy** to another active list of the same context. The dialog shows the destination selector (other active lists of this context only), the item's details, an optional destination category (only that list's categories; default Uncategorized), what happens to the source, and for a completed item the choice **Keep completed** or **Reopen**. A clear duplicate (same name, active, in the destination) is warned: **Add as separate item** or **Cancel**.
- Rechecked at confirmation: both lists active, same context, the source revision, permissions (edit on both), duplicates. Move keeps the item (same id), Copy creates one with a client id (a retry returns the same copy). A copy that keeps completion keeps the source's completion actor and time and records a `copied` event, never a new `completed` one. Personal ↔ Home and cross-Home transfers are refused (`not_permitted`). A copy never copies a recurring rule; moving a recurring item detaches it from its rule (the rule stays on its list).
- After a move, a toast offers **Undo** (moves it back with the same checks).

## Recurring items

- In the item editor, **Repeat**: daily, weekly (chosen weekdays, at least one), or monthly (day 1–31; months without that day use their last day), with an optional start date and a readable preview of the next three dates. The rule keeps the item's name, quantity, unit, packaging, notes and category, its list, and the context's timezone (Home: the Home's; Personal: the person's effective timezone when saved).
- **Due:** at the start of each due day in that timezone, at most one active item from the rule: if one is still active, nothing happens (no duplicate, no quantity change, no reset); otherwise a new item is created (marked "Repeats"), with event `recurred` and no actor. Completed items stay in Completed with their own completion. Missed days (nobody looked, outage) produce **one** item, never a backlog; the next due date moves past today.
- **Applied lazily** whenever the context's shopping pages or widgets are read (`advance_shopping`, under the rule's row lock, idempotent: two readers at once create one item). No background job (default picked: nothing is delivered or notified on recurrence, so a read is the first moment it matters).
- Edit (revision-checked; "applies from the next occurrence"; past items unchanged), **Pause**/**Resume** (resume restarts from today, never catches up), **Stop repeating** (keeps the items and their history). List archived or deleted: no new items; restored: restarts from today. Category removed: the rule continues Uncategorized and is flagged "Its category was removed" until edited.
- Shown with a "Repeats" label and next due date on the item; permissions as editing items.

## Widget

- New widget type **Shopping** (personal dashboard: Personal lists or a bound Home; Home dashboard: that Home). Settings: one list, or several (up to 5) **combined**, from the active lists the viewer may see in that context; display order as chosen; up to 5/10/15 items; a **quick-add destination** (one of the selected lists, required to show quick add in combined mode). Rows: check/uncheck (when allowed), name, quantity, and the source list's name in combined mode (with its position when names coincide); **Open list**. Completed items are not shown. Quick add only to the configured destination and only with edit access.
- A selected list archived, deleted or no longer visible is left out with "A selected list is no longer available. Choose lists in the widget settings." (never another list instead). Empty selection prompts to choose lists. Live with the same signal.

## API

`GET/POST /api/v1/shopping/lists` (`?homeId&archived`), `GET/PATCH/DELETE /api/v1/shopping/lists/:id` (detail with `?homeId`; rename/access/archive; to trash), `POST /api/v1/shopping/lists/:id/move` `{ direction }`, `POST /api/v1/shopping/lists/:id/categories` (create), `PATCH/DELETE /api/v1/shopping/categories/:id` (rename or move; remove, answering how many items moved to Uncategorized), `POST /api/v1/shopping/lists/:id/items` (`{ items: [...] }`, one or several), `POST /api/v1/shopping/lists/:id/clear-completed` `{ itemIds }`, `PATCH/DELETE /api/v1/shopping/items/:id` (edit, including its category; to trash), `PUT /api/v1/shopping/items/:id/completion` `{ completed, seenCompletedAt }`, `POST /api/v1/shopping/items/:id/move` `{ direction }`, `POST /api/v1/shopping/items/:id/transfer` `{ mode, destinationListId, ... }`, `GET /api/v1/shopping/items/:id/history`, `POST /api/v1/shopping/items/:id/recurrence` (start), `PATCH /api/v1/shopping/recurrences/:id` (edit schedule, pause, resume, stop), `GET /api/v1/shopping/widget` (`?homeId&listIds&limit`). Same CSRF, JSON, size, session and outcome mapping as earlier steps.

## Database (`20261108090000_shopping_lists.sql`)

Tables `shopping_lists`, `shopping_categories`, `shopping_items`, `shopping_item_events`, `shopping_recurrences`, `shopping_clears`; `public.shopping_signals` (RLS, Realtime publication); capability `manageHomeShopping`; trash module `shopping` with item types `shopping_list`, `shopping_item`, `shopping_clear`; membership-departure handling (nothing to transfer: lists belong to the Home; creator rights end with membership). All access through security-definer functions with the person's session; no table exposed.

## Tests

- **Database:** access matrix (Personal owner; Home member with each access mode; list creator; manager; Administrator with and without the capability; non-member; forged Home and list ids; departed creator); cross-Home isolation for every read and write, signals included; categories (distinct names, removal moves items to Uncategorized); quick add duplicate and idempotent retry; multi-add per-row results and retry; completion set-to-state, stale uncheck conflict; clear completed and trash restore; list archive (read-only, out of widget), delete and restore with items; transfers (move/copy, same-list refused, Personal↔Home and cross-Home refused, archived destination, duplicate, completed keep/reopen, idempotent copy); recurrence (daily, weekly weekdays, monthly 31st in shorter months, still-active item prevents a duplicate, missed days give one item, pause/resume, stop, archived list, category removed); widget reads. **Concurrency:** two sessions check the same item (one completion event); two concurrent `advance_shopping` (one item); two concurrent transfers of the same item.
- **Unit:** quantity parsing and formatting (nl and en decimals), multi-line parsing, schedule computation (31st, weekdays, DST-irrelevant date math), permission matrix, schemas, routes, components with axe.
- **Playwright:** two members of a Home: one checks off an item, the other sees it move to Completed without reloading (CI with Realtime; the fallback re-reads); quick add, add several with review, category, move to another list; widget combined view with source labels.

## Out of scope

Recipe-ingredient transfers to shopping (S27, with the meal planner's date-range transfer), Ora actions (S45), Household Display presentation (S43–S44), notifications about shopping changes, cross-Home or personal-to-Home transfers and sharing (not approved), bulk transfers, an "update existing item" option on duplicates.

## Defaults picked (Ward may override)

1. Permissions as in the table: every Home member creates lists; list creator and shopping managers (new `manageHomeShopping`) manage a list; per-list member access Edit (default), Check off only, or View only.
2. Units: pieces, g, kg, ml, cl, dl, l; quantity up to 3 decimals and 100,000; packaging ≤ 40; notes ≤ 500; names 200; list names 60; category names 40.
3. Limits: 50 non-deleted lists per context, 500 items per list, 30 categories per list, 100 lines per multi-add, 50 recurring rules per list.
4. Duplicates are warned (quick add, multi-add, transfers) with keep-separate or cancel; no "update existing item" action in this step.
5. Clear completed makes one trash entry per clear; restored items come back Completed.
6. Recurring items are applied lazily on read (no background job, no notification); missed occurrences collapse into one item.
7. Reordering is by Move up/down buttons (relative moves), not drag-and-drop; no full-order overwrite.
8. Realtime via one signal row per context (Home or Personal space), refreshing the page; the Personal signal lets one person's devices stay in sync.
9. Widget: up to 5 lists combined, 5/10/15 items, explicit quick-add destination.

## Progress

- [x] Brief
- [x] Domain and migration
- [x] Database tests
- [x] API and data layer
- [x] Interface and widget
- [x] Unit, route and component tests
- [x] Playwright
- [x] Docs
- [x] Full suite
- [x] Independent review (CHANGES_REQUIRED: H1 and M1–M3 fixed and verified; L1–L9 open)
