# ADR 0053: Ora proactive controls, seven-day history and remembered list choices

- **Status:** Proposed for S47b within the approved architecture (authorization C, database access A, data fetching B, no language model and no free text, 13 Oct 2026).
- **Date:** 2026-11-14
- **Step:** S47b (brief: `plans/steps/S47b-brief.md`; builds on ADR 0052).

## Context

The spec asks for per-person control of Ora's proactive behaviour (Quiet, Balanced, Active, category switches, quiet hours), a bounded seven-day interaction history with a Clear control, and controlled, reviewable long-term memory. Ora has no language model and no free text yet, so there is nothing to infer memories from and no transcript to keep.

## Decision

**Controls are columns on `ora_preferences`** (own row only): `frequency`, `cat_reminders`, `cat_suggestions`, `cat_celebrations`, `quiet_start`, `quiet_end` (both or neither, never equal). They are applied on the server where the prompt is chosen: Quiet never claims the teaser, the suggestions switch hides suggestions and the teaser, and quiet hours (the person's own time zone, crossing midnight allowed) hold the teaser back **before** `claim_ora_teaser` runs, so the day is not used up. The browser mirrors the first two as a courtesy (it does not even ask) but the server decides. In-app access to Ora is never blocked. Active equals Balanced until more prompt kinds exist, because the handoff fixes one unsolicited teaser per person per day.

**History is `ora_interactions`**: one line (closed kind, ≤200-character label) per guided change or Undo, owned by the person and place, tied to the membership (cascade on leaving). RLS shows only rows younger than seven days and only while the person is still a member; inserting a row purges that person's expired rows (security-definer trigger), so no scheduler is needed. Lines are never edited and never authorise anything: they are plain text, with no re-runnable action. "Clear recent interactions" deletes all of the person's own lines in every place and nothing else.

**Memories are `ora_memories`**: personal, one row per person, place and closed key (`task-list`, `shopping-list`), holding a list id and the list's name at save time. They are saved only when the person ticks "Remember this list" in a preview (the consent), by a route that re-checks the action's permission and takes the list and its name from the server's own list of destinations, never from the browser. They preselect a list only while the server still offers it (a deleted, archived or no-longer-editable list is ignored); the preview says so and the person still confirms. They are reviewed and forgotten on the Ora settings page. Nothing is shared with a Home or carried to another place.

## Consequences and limits

- Automatic memory creation and shared Home memories are not built: the first needs a model provider, the second needs a capability the spec does not define (decision for Ward).
- Quiet-hours deferral is evaluated when the page asks; a tab that never reloads after the window ends gets no teaser that day.
- A history line is written by a second call after the module change; if it fails, the change stands without a line.
- Stored labels (titles) live seven days and are visible only to their owner while they belong to the place; account or Home deletion removes them through the existing cascades.
- Rollback: drop the three additions in one migration (columns, two tables, one trigger function); no module data is touched.
