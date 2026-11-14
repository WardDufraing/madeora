# S47b · Ora controls, seven-day history and remembered lists — feature brief

**Branch:** `feat/ora-history-memories-controls` from `main` (S47a merged, PR #85).
**Model:** Sonnet. Additive per-person tables with plain own-row RLS; no new write path into any module.
**Order reading:** the build plan lists S47 as one step before S48 ("Acceptance suite ... depends on: everything above"). S47a delivered the "Ora change" journey; the rest of S47 is still owed, so it comes before S48. S47 is therefore finished by S47b (this PR) and S47c (below).
**Sources:** PS L889–L927 (history, memories), L1383–L1398 (frequency, categories, quiet hours), Ora design handoff; ADR 0052 (S47a) and ADR 0053 (this step).
**Done when:** frequency, category switches and quiet hours change what Ora raises; the panel shows and clears a seven-day history that expires and hides on lost access; a remembered list choice is saved with consent, preselects the list, can be reviewed and forgotten, and is never shared.

## Scope of this PR (S47b)

1. **Proactive controls** (settings page + `ora_preferences` columns): Quiet / Balanced / Active, three category switches (reminders, suggestions, celebrations), quiet hours in the person's own time zone (may cross midnight). Applied: Quiet never claims the teaser; Suggestions off hides in-panel suggestions and the teaser; quiet hours hold the teaser back **without using up the day** and the client asks again on a later load. Reminders and celebrations switches are stored and shown now; they take effect when those prompts exist (S47c).
2. **Seven-day history** (`ora_interactions`): one line per guided change or Undo, panel section "Recent" (last five in this place), **Clear recent interactions** (all the person's lines everywhere; touches no record or memory). Expiry: RLS hides rows older than seven days; the next insert purges them. Lines of a Home vanish when the person stops being a member.
3. **Remembered list choices** (`ora_memories`): in a guided change's preview the person can tick "Remember this list for next time". It preselects that list next time (only while it is still offered by the server), is disclosed in the preview and the result, and is listed with a **Forget** button on the Ora settings page. Personal, per place, closed key set (`task-list`, `shopping-list`).

## Deferred (S47c, by choice, to keep this PR reviewable)

Celebrations (need module completion events and de-duplication), display-only Ora on wall displays (needs the S44 display data path), more actions (complete task, change due date, recurring, meal to shopping, multi-record updates, deletion, with a locking Undo RPC), "explain this suggestion", reminders category content.

## Defaults picked (Ward may change)

1. **Memories are explicit, not automatic.** Automatic saving needs inference, which needs a language model (not approved; free text and LLM wait for Ward's provider decision). So there is no "auto-memory" switch; the tick box is the consent. **Home memories** (shared) are not built: who may set them is not in the spec and I did not invent a capability. A memory is personal and scoped to one place.
2. **Active = Balanced today.** The handoff caps unsolicited teasers at one per person per day; with one suggestion kind there is nothing more for Active to add. The mode and its text exist so more kinds follow it.
3. **Quiet hours use the person's own time zone** (profile/regional setting), not the Home's.
4. **Clear recent interactions clears everywhere**, not only the place being viewed.
5. **History labels store the typed title/name** (≤200 chars) for seven days, visible only to the person while they belong to that place.
6. **"Correct" a memory = Forget and choose again** (a memory is one list choice; a separate edit control adds nothing).

## Known limits (also in ADR 0053)

- A quiet-hours deferral is per page load: a person who never reloads after quiet hours end sees no teaser that day.
- The history line is written by a separate call after the module change; if it fails, the change stands and the line is missing.
- Pre-existing, not touched: E2E on `main` has flaky/failing tests (members, pet-care, `roles:163`); not caused by or blocking this step.

## Status

- [x] Scoping and brief, ADR 0053
- [x] Migration `20261208090000_ora_controls_history_memories.sql`, database types, DB RLS test `tests/db/rls/ora_controls_history_memories.test.sql`
- [x] Server: settings, suggestions/teaser controls, `ora/history`, `ora/memories`, routes `/api/v1/ora/history`, `/api/v1/ora/memories`
- [x] UI: settings cards (frequency, categories, quiet hours), memories card, "Recent" in the panel, remember tick box, i18n en/nl
- [x] Local: prettier, eslint (touched dirs), tsc, relevant unit/component/route tests (ora, components/ora, api/v1/ora, i18n)
- Not run locally by design: full suite, build, DB RLS test (no Postgres server here; CI runs it), Playwright.
