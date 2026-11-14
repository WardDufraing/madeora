# S47b independent review: Ora controls, seven-day history, remembered lists

Reviewer: independent agent, fresh context. Read-only review of `S47b.diff` and touched files. The DB test could not be run (no Postgres); it was read line by line against `tests/db/sql/helpers.sql`.

## Verdict: PASS

No BLOCKER or HIGH findings. Two MEDIUM findings should be fixed in this PR (one is a one-line SQL fix); the rest are LOW.

Counts: BLOCKER 0, HIGH 0, MEDIUM 3, LOW 7.

## Findings

### MEDIUM-1: `*_home_check` lets a row claim a Home scope with `home_id` NULL (membership guarantees bypassed)

- `supabase/migrations/20261208090000_ora_controls_history_memories.sql:55-57` (`ora_interactions_home_check`) and `:141-143` (`ora_memories_home_check`). The pattern is copied from `ora_dismissed_home_check` (S47).
- Check: `(scope='personal' and home_id is null) or (scope <> 'personal' and home_id::text = scope)`. For `scope='<some uuid>', home_id=NULL` the first branch is false and the second is NULL. `false OR NULL` is NULL, and a CHECK treats NULL as pass.
- Impact: through the Data API a member can insert a row with a Home-looking scope and `home_id` NULL. The RLS policies use `home_id is null` to mean personal, so no membership test runs and the composite FK is skipped (MATCH SIMPLE). The row is the person's own, so there is no cross-user leak. It does break two promises: "lines and memories vanish when membership is lost" (the cascade never reaches such a row) and "hidden on lost access" (RLS never checks membership for it). The app's `loadHistory` and `loadRemembered` filter by `scope`, so a person who left a Home could keep and read such a row. RLS must hold for anything exposed directly via Supabase (CLAUDE.md), and the DB test does not cover this case.
- `ora_memories` also grants UPDATE on `user_id, scope, home_id, key`. With the hole above, an update can rewrite scope and home_id freely. S45's palettes table guards this with `keep_ora_home_palette_owner`; this one has no equivalent.
- Fix: change the second branch to `scope <> 'personal' and home_id is not null and home_id::text = scope`. Add DB tests for `insert ... (scope => '<uuid>', home_id => null)` on both tables, denied with 23514. For memories, either add a keep-owner trigger or drop `scope, home_id, key` from the UPDATE grant. The upsert's DO UPDATE names them, so the trigger is the simpler route, as in S45. Optionally fix S47's `ora_dismissed_home_check` in the same migration.

### MEDIUM-2: Proactive controls fail open when settings cannot be read

- `apps/web/src/ora/suggestions/server.ts:51` and `:109` (`(await getOraSettings()) ?? defaultOraSettings`).
- `getOraSettings` returns `null` on a read error or no identity; its own comment says to stay hidden because the person's choice is unknown. Here `null` becomes defaults (Balanced, all categories on, no quiet hours). A transient DB error therefore lets a Quiet user, a user with suggestions off, or a user inside quiet hours get a teaser, and `claim_ora_teaser` then uses up their day. It contradicts the spec ("Quiet: minimal proactive interruptions", quiet hours deferral). The unit tests make `settings = null` the default state, so they never exercise a failed read.
- Fix: in `claimTeaser`, return `{status:"ok", teaser:null, deferred:true}` (or `unavailable`) when settings are `null`. In `loadSuggestions`, return no suggestions when settings are `null`. Update the tests so null no longer means defaults.

### MEDIUM-3: Missing tests for the changed settings route and the client-side suppression

- `apps/web/src/app/api/v1/me/ora/route.ts:40-55` changed, but `route.test.ts` has no case for `frequency`, `categories.*`, or `quietHours` (including `null` writing both columns to null, and 23514 mapping to 400). The column mapping is the only link between the form and the DB.
- `ora-assistant.tsx:226-230` (hide the teaser for `frequency==='quiet'` or suggestions off) and `ora-teaser.tsx:41-44` (`deferred` must not be written to sessionStorage) have no test. The done condition depends on both.
- Fix: add route cases (patch each field; quietHours null; invalid time gives 400). Add an assistant test (quiet or suggestions off means no `/api/v1/ora/teaser` call) and a teaser test (deferred means a second mount asks again).

### LOW-1: Hidden "Remember" tick can still save

- `ora-action.tsx` around `confirm()` (`if (draft.remember)`) versus the checkbox shown only when `listId !== remembered`. If the person ticks Remember on list A and then selects the already-remembered list, the checkbox is hidden but `draft.remember` stays true. The save is a no-op re-save of the same list and the done text says "Remembered", so the harm is small, but the consent control is no longer what drives the action.
- Fix: send `remember: draft.remember && listId !== remembered`, or reset `remember` when `listId` changes.

### LOW-2: `forgotten` state in `OraMemories` is never cleared

- `ora-memories.tsx:30,44-46`. The component stays mounted across `router.refresh()`. If the person forgets a memory, saves the same place and key again from the panel (the panel lives on the same page), and the page refreshes, the new memory stays hidden by the old `forgotten` key. Real but narrow.
- Fix: derive from server props only (after `router.refresh()` the props are authoritative), or drop the key from `forgotten` when the props contain it again.

### LOW-3: No row cap or rate limit on history inserts

- Migration lines 82-102 (insert policy/grant) and `route.ts` POST. Only expired rows are purged, so an authenticated user (or a script using their session) can add unlimited 200-character rows in seven days. This affects only their own quota, but it is unbounded storage on a free tier. The history POST also trusts the client to say a change happened; a user can write their own false "Added the task X" lines. That is self-inflicted and low impact, but the spec says never to claim completion before the action succeeds.
- Fix: cap per-user rows (a check in the purge/insert trigger, e.g. 200) or prune to the newest N. Optionally rate-limit the route.

### LOW-4: Quiet-hours time inputs fail silently

- `ora-settings-form.tsx:239-241`. An equal start and end, or a cleared value, is ignored with no message; the controlled input snaps back. Keyboard and screen-reader users get no explanation. Add an inline `aria-live` hint (or `aria-invalid` plus help text) when start equals end.

### LOW-5: Deferred teaser re-asks on every mount during quiet hours

- `ora-teaser.tsx:41-44`. The state is not remembered when deferred, so each navigation or remount sends `POST /api/v1/ora/teaser` (two settings reads plus a time-zone lookup). Cheap, but consider a short sessionStorage "deferred-until" timestamp.

### LOW-6: Redundant work and cache hygiene

- `memories/route.ts:470` calls `prepareAction`, which itself runs `loadRemembered`, only to obtain `destinations`; an extra query per save. The `getOraSettings` React `cache()` is a no-op in route handlers, so `claimTeaser` and `loadSuggestions` each read settings (two reads per teaser). Acceptable at this scale; note for later.
- Stale `ora_memories.list_id` (no FK to the module list) is ignored while not offered, which is correct and tested; the settings page keeps showing the old list name until forgotten, which is acceptable.

### LOW-7: Copy and reminders/celebrations switches

- `categoriesHint` says "Turning a kind off hides those prompts everywhere", but only Suggestions has an effect today (the brief defers the others to S47c). Vacuously true now, but the done condition says category switches change what Ora raises. Consider one line of copy ("Reminders and celebrations apply when Ora starts offering them"), or accept as a documented deferral (it is in the brief and ADR).

## Explicit checks

- **Requirements:** Spec L1383-1398 and L889-927 are met for what exists. Quiet never claims the teaser; suggestions off hides both; quiet hours defer without consuming the day (the claim comes after the check, and the test proves 23:30 defers and 07:00 claims). Clear removes all of the person's lines and leaves records and memories alone. Expiry is by RLS plus purge-on-insert. Memories are explicit, personal, reviewable and forgettable. Defaults and deferrals are written down in the brief and ADR 0053. Active equals Balanced is disclosed in the UI copy. Reminders and celebrations are stored and shown but inert (LOW-7).
- **Cross-Home isolation:** All three new tables use `user_id = auth.uid()`, plus a membership check for Home rows, and no policy lets an Owner see another member's rows. Routes resolve context from the database (`resolveOraToolContext`), and the memory save takes list id and name from the server's own destinations, not the client. Gap: MEDIUM-1.
- **Permissions:** The memory route re-checks the action permission (`findInputTool`) and the list through `prepareAction`; a forged `listId` gives 404; a foreign Home gives 403. History DELETE ignores any body fields (strict empty object) and is scoped by RLS and `user_id`. No privileged client is used anywhere.
- **Column grants and upsert:** `ora_preferences`: INSERT and UPDATE on the six new columns, `user_id` already granted, so the app upsert (`ON CONFLICT (user_id) DO UPDATE SET user_id, ...`) works. `ora_memories`: INSERT and UPDATE grants cover every column the upsert names (`scope, home_id, key, list_id, list_name`; `user_id` defaults, and is also granted); SELECT is granted (needed for the conflict arbiter and the UPDATE policy); the `updated_at` trigger sets its column without a grant. `ora_interactions` has no UPDATE grant and the test asserts that. The updated policies pair USING and WITH CHECK. Correct.
- **Secrets:** None added. Logs carry only event names and error codes; labels and list names are not logged.
- **Input validation and CSRF:** Every mutation uses `checkJsonMutation` and `readJsonBody` with a 1 KB cap and strict Zod objects (`homeId` uuid or null, closed enums, label 1-200 trimmed). DB checks mirror them (kind, key, label length, time regex, pair and not-equal). The PATCH 23514 maps to 400. GET history is read-only. The route tests cover cross-origin, extra fields, unknown kinds, and a foreign Home.
- **Migration safety:** Additive only (new columns with defaults and checks; two new tables). The ALTER adds NOT NULL columns with constant defaults (no table rewrite on current Postgres). Rollback in ADR 0053 is accurate. The `security definer` purge function sets `search_path=''`, schema-qualifies, and has EXECUTE revoked; it deletes only the inserting user's expired rows. Gap: MEDIUM-1; the hand-written `database.types.ts` follows the S45/S47 form (confirm the CI types-drift check, if any, passes).
- **DB test `tests/db/rls/ora_controls_history_memories.test.sql`:** Read against the helpers (`assert_row_count` wraps in a CTE so `delete ... returning` is valid; `assert_denied` defaults to 42501; the 23514 cases are correct because the RLS WITH CHECK runs before constraints and the member passes it). I found no SQL or logic error that would fail in CI: setup (Alice as Member of Bob's Home), the app-shaped upserts, constraint cases, Bob/Carol isolation, the 8-day fixture with the trigger disabled and re-enabled before the purge assertion, clear-isolation counts (Alice 0, Bob 1), and the leave-cascade through `public.home_memberships` (same shape as S45's test). Residual risks: the ALTER TABLE DISABLE TRIGGER step assumes no pending trigger events (none expected; all RI triggers are immediate); `act_as_owner` must be the table owner. Missing cases: MEDIUM-1, and a membership-loss test where the person is still in the same transaction as the lines (covered indirectly by the cascade assertion).
- **Test coverage:** Strong unit coverage for settings schema and `inQuietHours` (midnight wrap, time zone, boundaries), the history, memories and teaser servers, both routes, and the components (axe on memories, focus after forget and clear). Gaps are in MEDIUM-3.
- **Accessibility:** Frequency radios in a fieldset with legends; category and quiet switches are labelled `role="switch"` inputs; time inputs have visible labels; the live region for "Recent interactions cleared" exists before it is filled; focus returns to a stable container after Clear and after Forget; Forget buttons have unique accessible names. Silent rejection in the time inputs is LOW-4.
- **Performance:** Index `(user_id, created_at desc)` serves the history read and the membership cascade; the purge is a single indexed delete per insert; the extra queries per teaser or preview are small (LOW-5, LOW-6).
- **Maintainability:** Clean separation (types, client, server, routes), closed key sets mirrored in DB checks, an ADR and a brief that document defaults and limits. The two `*_home_check` copies of the same pattern are the main hazard.

## Remaining risks and test gaps

- A history line is written by a second call, so a failed call means a missing line (documented).
- Quiet-hours deferral is evaluated per page load (documented).
- Data-export and account-deletion handling: the tables cascade from `auth.users`, but no export path includes history or memories. Confirm the data-export step (if built) lists them.
- Not covered by tests: MEDIUM-1 forged scope, null settings fail-open (MEDIUM-2), route mapping for the new columns, teaser suppression in the assistant, a failed `rememberList` path in the preview UI (message exists, no test), `OraHistory` hidden after membership loss at the UI level (DB covers it).
- No Playwright coverage in this PR (by design per the brief).

## Fix notes (implementing thread, verified once, no second review round)

- MEDIUM-1 fixed: `*_home_check` on interactions, memories and (S47) dismissals now requires `home_id is not null` for a Home scope; a keep-place trigger on `ora_memories`; DB tests added for both holes.
- MEDIUM-2 fixed: unknown settings fail closed (no suggestions, no teaser claimed); test added.
- MEDIUM-3 fixed: route cases for frequency, categories, quiet hours and bad windows; assistant tests for Quiet or suggestions-off (no teaser request) and for a deferred teaser (not remembered, asked again).
- LOW-1 fixed (remember only when the tick is visible). LOW-2..7 left; harmless and noted in the review.
