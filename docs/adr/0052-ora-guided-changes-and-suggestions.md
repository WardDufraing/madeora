# ADR 0052: Ora guided changes, Quick Undo, suggestions and the daily teaser

- **Status:** Proposed for S47 within the approved architecture (authorization C, database access A, data fetching B, the 13 Oct 2026 decision that Ora has no language model and no free text).
- **Date:** 2026-11-13
- **Step:** S47 (brief: `plans/steps/S47-brief.md`).

## Context

After S45 (shell and read-only tools) and S46 (overviews), Ora must be able to help change things: an editable preview, a confirm button named for the change, Undo in the result, one unsolicited teaser per person per day, contextual suggestions that stay quiet once dismissed, and unfinished drafts kept in memory (spec "guided workflows", "Quick Undo", "smart suppression", handoff "teasers").

## Decision

**Ora never writes through its own path.** A guided change is a tool of kind `action` (`add-task`, `add-shopping-item`), listed and checked by the same registry and permission engine as every tool (Personal, or a Home where the role allows `home.tasks.create` / `home.shopping.create`). The server step `prepare` returns only the destinations the person may use (active task lists; shopping lists with edit or manage access). After the person confirms, the browser makes the change through the module's own API (`POST /api/v1/tasks`, `POST /api/v1/shopping/lists/:id/items`), which checks identity, membership, CSRF and RLS again. A permission that changed since the preview therefore refuses the write, and no second write path exists. Ids are made once per draft so a retry never adds twice; a duplicate shopping item asks the person before it is added anyway.

**Undo is a server step that re-checks.** `undo` moves the new record to the module's Trash (the supported safe reversal; nothing is hard-deleted). It refuses with a truthful answer when the record is in another place than Ora is in (`gone`), was edited by anyone since (`changed`: the revision the change left it at no longer matches), is older than five minutes (`expired`), or the database refuses (`not-permitted`). A second Undo answers `gone`. The revision check and the delete are two calls, and the delete RPCs take no expected revision, so an edit made in the milliseconds between them would also be trashed. The record lands in Trash and can be restored, so this is accepted for S47 and recorded as a known limitation; a single reviewed RPC that locks the row and checks the revision is follow-up work (S47b). Undo is not bound to the author: anyone the module lets delete the record can use it within the window, and the delete RPCs still enforce that. A confirmation still running when the person switches Home loses its result message (the record is created); and the daily teaser is consumed when the server grants it, so a lost response or a Home switch can cost that day's teaser, never add a second one.

**The Undo window is five minutes** (`UNDO_WINDOW_MS`), chosen here because the spec asks for a specified window and gives none. When Ora is closed at the moment of success, the result and Undo appear as a toast instead.

**Drafts are React state in the panel**, bound to the context (the panel is rebuilt for another Home or Personal), never saved or sent, and discarded on Cancel or success.

**Suggestions are read-only offers computed from an overview read with the person's own session** (today's open items, complete readings only). One kind exists (`today-overview`). A dismissal is a row per person, place and kind holding the dismissed situation (the date); the same situation stays quiet on every surface, a new day may be offered again. Rows belong to the membership and go with it.

**The daily teaser is claimed in the database.** `claim_ora_teaser(date)` (security definer, granted to signed-in users only) returns true once per person per local date across Homes and devices, never while teasers are muted or Ora is off, and refuses dates more than a day from the real one. It is called only when there is a suggestion to show, so a quiet day does not use it up. The mute is `ora_preferences.teasers_muted` (personal, all Homes, until turned back on) and is a setting on the Ora settings page.

## Not in this step

Seven-day interaction history, long-term memories, celebrations, display-only Ora, the capabilities guide beyond "What Ora can do", more actions (complete a task, change a due date, meals to shopping), and quiet-hours or Quiet/Balanced/Active frequency controls. They are listed in `plans/steps/S47-brief.md` as follow-up work.

## Open values

1. Undo window of five minutes.
2. Only two guided changes exist; the catalogue is intentionally small (spec: bounded workflow catalogue).
3. The teaser day is the person's local date in the place Ora is in when it asks; the day boundary for a person who changes time zone mid-day is the date the server computes at that moment.
