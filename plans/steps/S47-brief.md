# S47 · Ora suggestions and actions — feature brief

**Branch:** `feat/ora-actions-undo` from `main` (S46 merged, PR #84).
**Model:** Sonnet. The writes reuse the existing module APIs and database functions (no new write path); the new database objects are two columns, one small table and one claim function.
**Sources:** build plan S47; PS L872–L928 (workflows, suggestions, history, memories, celebrations), L987–L1327 (suppression, Quick Undo, preview, drafts), L1383–L1406 (frequency, proactive); Ora design handoff and review; design-decisions.
**Done when:** the "Ora change" journey passes without free text.

## Scope of this PR (S47a)

1. **Guided changes** (tool kind `action`): `add-task` and `add-shopping-item`, Personal or Home, editable preview inside the bubble/sheet, confirm button named for the action, result with Undo (toast if Ora is closed), failure keeps the preview with Retry, duplicates ask first, in-memory drafts.
2. **Quick Undo**: server step that re-checks place, revision (anyone's later edit blocks it), window (5 minutes) and permission; moves to Trash; truthful answers for changed, gone, expired and not permitted.
3. **Suggestions**: one deterministic kind (`today-overview`), shown in the panel, dismissible, suppressed per person/place/kind/situation in the database.
4. **Daily teaser**: at most one per person per day across Homes and devices (`claim_ora_teaser`), personal mute (Ora settings page), small note beside the button, never modal.

## Deferred to a follow-up step (S47b), by choice, to keep this PR reviewable

Seven-day history with Clear, long-term memories and their management, celebrations, display-only Ora, more actions (complete task, change due date, recurring, meal to shopping, multi-record updates, deletion), proactive frequency/quiet hours/category toggles, "explain this suggestion". The build plan's S47 line lists these; Ward decides whether they become S47b or later.

## Defaults picked (Ward may change)

1. Two actions only, both additive and cleanly reversible by Trash. Edits and deletions need per-module reversal rules and come later.
2. Undo window 5 minutes (spec asks for a specified window and gives none).
3. Change execution goes through the module APIs from the browser after confirmation, not through a second server write path; Ora's tools layer still lists/prepares/undoes with the permission engine.
4. Teaser content = the same `today-overview` suggestion (the only kind).
5. A dismissal covers the day it was made for; tomorrow it may be offered again.
6. Settings page gets a "Suggestions from Ora" switch (mute teasers); the mute does not hide in-panel suggestions (handoff).

## Status

- [x] Scoping and brief, ADR 0052
- [x] Migration `20261207090000_ora_suggestions.sql`, types, DB RLS test `tests/db/rls/ora_suggestions.test.sql`
- [x] Server: `ora/actions`, `ora/suggestions`, routes `/api/v1/ora/suggestions`, `/api/v1/ora/teaser`, tool catalogue
- [x] UI: `ora-action.tsx`, suggestions in `ora-content.tsx`, `ora-teaser.tsx`, settings switch, i18n en/nl
- [x] Local checks: prettier, eslint (touched dirs, max-warnings 0), tsc, relevant unit/component tests (ora, api/v1, i18n, settings): all pass; boundary check passes
- Not run locally by design: full suite, build, DB (needs Supabase), Playwright (CI runs them). No Playwright spec added; the component tests cover the journey.
- [x] Independent review: CHANGES_REQUIRED (1 BLOCKER, 1 HIGH, 4 MEDIUM, 4 LOW) -> reviews/steps/S47-review.md. Fixed the BLOCKER (missing column grant), focus handling, DB test, date validation; the HIGH (Undo is two calls) is a documented limitation in ADR 0052.
