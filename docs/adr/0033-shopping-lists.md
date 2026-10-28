# ADR 0033: Shopping lists

- **Status:** Accepted for S26 within the approved architecture (§8, §9, §11, §36, §40), CLAUDE.md (database access A, authorization C, realtime C, data fetching B, forms A, €0 budget) and the spec's shopping sections (PS L2722–L2792). The defaults below are open to correction by the owner.
- **Date:** 2026-10-28
- **Step:** S26 (brief: `plans/steps/S26-brief.md`). Builds on ADR 0020 (trash), 0021 (dashboard engine), 0022 (tasks core) and 0027 (chore pool signal).

## Context

The spec asks for several independent shopping lists per Personal space or Home, structured quantities and units, quick add and reviewed multi-item entry, manual categories and item order, a synchronized completion lifecycle, moves and copies within one context, recurring items without backlog, and a widget that shows one list or several combined. Two members checking items off in the same shop must see each other's changes without reloading.

## Decision

**One migration, no exposed tables.** `20261108090000_shopping_lists.sql` adds `private.shopping_lists`, `shopping_categories`, `shopping_items`, `shopping_item_events`, `shopping_recurrences` and `shopping_clears`, plus `public.shopping_signals`. Every read and change is a `security definer` function run with the person's session; RLS is enabled and nothing on the private tables is granted.

**Who does what (defaults picked).** Every current Home member creates lists. A list is managed (rename, access, archive, delete) by its creator while they are a member and by shopping managers: the Owner and Administrators granted the new delegable capability `manageHomeShopping`. Each Home list has a member access mode, `edit` (default), `check` (check off only) or `view`, applied to members who are neither managers nor its creator. Reordering a context's lists is for managers. Personal lists are the owner's alone. `private.shopping_access` answers `manage` / `edit` / `check` / `view` or null and the TypeScript engine (`packages/domain/src/permissions/shopping.ts`) mirrors it for the interface only.

**Fields and limits.** Names: lists 60, categories 40 (distinct within a list, case and accent insensitive), items 200. Quantity is positive, at most 3 decimals and 100,000; units are pieces, g, kg, ml, cl, dl, l, and a unit needs a quantity; packaging 40, notes 500. Nothing is converted, rounded, summed or merged. Limits: 50 lists per context, 500 items and 30 categories per list, 100 rows per multi-add, 50 recurring rules per list.

**Duplicates warn, never merge.** Quick add, Add several and transfers answer `duplicate` for an active item of the same name; the person keeps it as a separate item or cancels. Every create carries a client id, so a retry returns the same row (`exists`); Add several answers per row.

**Completion is set-to-state.** Checking a completed item answers `unchanged`; unchecking sends the completion it saw and a newer one answers `conflict`. Clear completed sends the ids the person saw and makes one trash entry per clear; restored items come back completed.

**Ordering by relative moves.** Lists, categories and items move up or down one place under the list or context lock, so two people reordering never overwrite each other with a stale full order. No drag and drop in this step.

**Transfers stay in one context.** Move keeps the item id; Copy makes a new item from a client id and records a `copied` event, keeping a kept completion's actor and time. Personal ↔ Home and cross-Home transfers are refused. Moving a repeating item detaches it from its rule; a copy never copies the rule. A move offers Undo, which re-reads the item's revision and moves it back with the same checks.

**Recurring items are applied lazily.** A rule (daily, chosen weekdays, or a day of the month that falls back to the month's last day) keeps the item's fields, its list and the context's time zone. `advance_shopping` runs under each rule's row lock whenever the context's shopping pages, routes or widgets are read: if the rule's item is still active nothing happens, otherwise one item is created and the next due date moves past today. Missed days give one item, never a backlog. No background job and no notification, because a read is the first moment a new item matters. Resume and restoring a list restart from today.

**Realtime by signal, not by content.** `public.shopping_signals(context_id, version, changed_at)` has one row per Home or Personal space, readable only by that Home's current members or that person, with no shopping content. A deferred constraint trigger bumps it once per transaction when a list, category, item or rule of the context changes. Pages and widgets subscribe with `context_id=eq.<id>`, compare versions on events, on (re)subscribe, on tab focus and every 5 s while visible (ADR 0027), and re-read with the person's session. The channel ends on unmount, Home change and sign-out.

**Trash.** Module `shopping` with item types `shopping_list` (with its items), `shopping_item` and `shopping_clear`; restore follows the S16 rule. A restore that would pass a limit or whose list is gone reports a conflict (`shopping_list_limit`, `shopping_item_limit`, `shopping_list_unavailable`).

**Interface and API.** `/shopping` and `/homes/:id/shopping` list a context's lists; `…/:listId` shows quick add, items by category then Uncategorized, a Completed section, the item editor (fields, repeat, move or copy, delete, history) and list settings; `…/:listId/add-several` reviews multi-line entry before anything is saved. The dashboard gains a Shopping widget (up to 5 lists combined, 5/10/15 items, an explicit quick-add list). Routes live under `/api/v1/shopping/`: `lists`, `lists/:id` (+ `move`, `categories`, `items`, `clear-completed`), `categories/:id`, `items/:id` (+ `completion`, `move`, `transfer`, `history`, `recurrence`), `recurrences/:id` and `widget`, with the CSRF, JSON, size, session and outcome mapping of earlier steps.

## Consequences

- A new shopping write must change a row whose trigger bumps the context's signal, or open pages will only catch up on the 5 s check.
- Recurring items appear when someone opens the context's shopping pages or a widget, not at midnight; a future notification about them would need a scheduled job.
- The signal tells a member only that something in the context changed and when, never what.
- Recipe-ingredient transfers (S27), Ora actions (S45), Household Display presentation (S43–S44), notifications, sharing across contexts and an "update existing item" choice on duplicates are out of scope.
- The migration is forward-only like every other; repairing it on production means a new migration.
