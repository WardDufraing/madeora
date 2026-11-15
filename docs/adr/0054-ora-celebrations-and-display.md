# ADR 0054: Ora celebrations, "why am I seeing this" and display-only Ora

- **Status:** Proposed for S47c within the approved architecture (authorization C, database access A, the 13 Oct 2026 decision that Ora has no language model and no free text).
- **Date:** 2026-11-14
- **Step:** S47c (brief: `plans/steps/S47c-brief.md`).

## Decision

**Celebrations are a presentation of the ledger, claimed in the database.** The only celebrated event is a chore-point award: a `chore_award` line in `private.point_entries` (it exists only once the module has really awarded the points, so a pending approval, a failure or an unfulfilled claim is never cheered). `public.claim_ora_celebrations(home)` (security definer, signed-in users only, caller must belong to the Home) looks only at the caller's own account in that Home, awards posted in the last 15 minutes and not reversed, writes one row per entry to `public.ora_celebrations` (primary key person + entry) and answers one grouped line `{count, points, title}`; the title is given only when exactly one award is covered. Because the claim and the de-duplication are one statement, two tabs or devices asking at once cannot both cheer the same award, a refresh or retry cheers nothing twice, and several awards close together become one note (spec: group repetitive messages, idempotent on the ledger identity). The function claims nothing while Ora is disabled, Quiet is chosen or the celebrations switch is off; the server holds the request back, without claiming, during the person's quiet hours and when their settings cannot be read, so the cheer can still appear later within the 15 minutes. Nothing is granted: no points, no rewards.

**Privacy.** A celebration is personal: only the person's own award and its amount, no balance, no other member, no ranking. Personal space has no Home ledger and celebrates nothing. Rows are readable only by their owner while they belong to the Home, and go with the membership. The wall display shows no celebration in this step.

**The UI asks, it does not decide.** A small dismissible note beside the Ora button (`role="status"`, no focus change, gone after 15 seconds) asks on load, when the tab becomes visible and every 90 seconds while visible. It does not ask while the Ora panel is open, so an award is never claimed and then hidden behind it. With reduced motion the character component keeps still. Known limit: an award earned and not followed by a page load, visible tab or the next 90-second check within 15 minutes is not celebrated.

**"Why am I seeing this?"** is a button on each suggestion (panel and teaser). It shows a fixed, factual line (open things today in this place, from what the person may see; where to switch suggestions off). It is on request only and invents nothing.

**Display-only Ora is a settings-free layout widget** (`ora`). It renders the character without motion and one line made from counts the display already receives (open chores, unfinished shopping items), or "All quiet for now". It has no text entry, microphone, buttons, links, history or personal content, and no actions, and it does not change what a display may read (the board data function is unchanged; the database layout check only accepts the new type with an empty configuration). A display's layout still decides whether it appears; a member disabling Ora never affects it.

## Not in this step

More guided actions (complete a task, change a due date, recurring, meal to shopping, multi-record updates, deletion) with a locking Undo function that checks the revision and deletes in one call; reminders content; celebrations beyond chore-point awards (milestones, leaderboard positions) and on the wall display.

## Review follow-up (accepted limits)

Celebration rows are not pruned (one small row per celebrated award, removed with the membership). A burst of more than 20 awards is split over two notes. The note disappears after 15 seconds even while focused. The teaser and a celebration may stack closely on very small screens. A single award whose chore was deleted is shown as an unnamed award.
