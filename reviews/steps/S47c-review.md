# S47c independent review: Ora celebrations, "why am I seeing this", display-only Ora

Reviewer: independent agent, fresh context. Scope: staged diff (/tmp/S47c.diff).

## Verdict: PASS

No BLOCKER or HIGH. Counts: BLOCKER 0, HIGH 0, MEDIUM 3, LOW 6. The MEDIUM items should be fixed or consciously accepted (recorded in ADR 0054) before merge; none is a security defect.

## Findings

### MEDIUM

M1. Claimed-then-discarded celebration (in-flight race). apps/web/src/components/ora/ora-celebration.tsx:532-552.
Impact: the database claim is committed on the RPC, but the response is dropped when the effect cleans up (`cancelled = true`) because the person opened the Ora panel (`hidden` flips), switched Home, or navigated while the request was in flight. The award is then permanently marked celebrated and never shown. This contradicts the ADR statement "an award is never claimed and then hidden behind it" and the done condition's "celebrated once" (it becomes zero times). The same loss occurs on any network failure after the commit (client.ts returns null) and when the server fails the JSON after the RPC succeeded; the ADR's "known limit" does not cover these.
Remediation: do not discard a received celebration on cleanup. Either store it in state regardless of `cancelled` (only guard against a Home mismatch, already handled by `shown.homeId === homeId`), or accept and document it. Prefer the former; it is a one-line change plus a test (open the panel during an in-flight claim, close it, the note appears).

M2. Single-award title can be NULL, giving wrong copy; the SQL title path is untested. supabase/migrations/20261209090000_ora_celebrations_display.sql:1338-1344 (diff lines), apps/web/src/components/ora/ora-celebration.tsx:580-582, en.json/nl.json `celebration.several`.
Impact: the title subquery uses inner joins to private.chore_occurrences and private.chores; `occurrence_id` is `on delete set null` (a deleted chore or occurrence) so a single award returns `title: null` with `count: 1`. The UI then shows `several` with count 1: "1 chores done and 5 points earned" (the `{count}` is not an ICU plural; Dutch "1 taken klaar"). Separately, the DB test never exercises a title: the seeded entries have no occurrence, so the correct title (closed_title versus chore title), the NULL title for one award, and TS's rule that count > 1 hides the title are not covered at the SQL level. The columns do resolve (statement planned fine), but the value is unproven.
Remediation: (a) make the `several` message plural-aware (`{count, plural, one {# chore done} other {# chores done}}`) in en and nl, or render a count-1 untitled case with its own string; (b) add a DB test with one award tied to a real occurrence (title returned, closed_title preferred) and one single award without an occurrence (title null, count 1).

M3. Per-poll cost grows with ledger history; no supporting index for the 15-minute filter. SQL `eligible` CTE.
Impact: the planner can only use point_entries_account_idx (account_id, seq desc) and filters `created_at` afterwards. With `limit 20` never filled (the normal case: no recent awards), every 90 s per open tab walks the person's whole account history, plus a NOT EXISTS probe per row that passes. Fine at household scale today, grows unbounded with time and with active tabs (also one RPC plus settings and timezone reads per poll).
Remediation: add a bound that the index can use, for example `e.seq > (select max(seq) ...)` is awkward; simplest is an index `(account_id, created_at desc) where kind = 'chore_award'` or `(home_id, created_at)`; or note it as accepted at MVP scale in the ADR. Consider also not polling when no chore-points feature is enabled for the Home.

### LOW

L1. Live region inserted with its content. ora-celebration.tsx:565-575. `role="status"` that mounts already containing text is announced unreliably by several screen readers. Remediation: render a persistent (empty) `role="status"` wrapper and put the note inside it, or at least test with a screen reader; keep the 15 s timer.

L2. Auto-dismiss without pause (WCAG 2.2.1/2.2.2 spirit). The note disappears after 15 s even while its Dismiss button has keyboard focus or the pointer is over it. It is non-essential and sound for focus (it does not steal it), so LOW. Remediation: pause the timer on hover/focus-within, or lengthen it.

L3. Visual overlap. The celebration note sits at bottom 9.5rem and the teaser at 5rem, but the teaser is a multi-line card (text, buttons, now plus an expanding "why" paragraph) well taller than 4.5rem; both can appear together (teaser and celebration are independent) and overlap on small screens. Remediation: stack them in one fixed flex column, or hide the teaser while a celebration is shown (or vice versa).

L4. ora_celebrations rows are never pruned. One row per celebrated award, forever (the table is only needed for the 15-minute window). Remediation: delete rows older than, say, a day opportunistically inside the claim function, or add a retention note to the ADR.

L5. Limit 20 silently splits a burst. With more than 20 eligible awards, 20 are claimed now (newest first) and the remainder celebrate as a second note on the next poll within the window. The zod answer also caps count at 100 although the function can never return more than 20. Harmless; document or align the schema (max 20).

L6. Test-quality nits. (a) route.test.ts mocks `@/homes/server` but the route resolves context through `@/ora/tools/server`; the mock may be dead, so the "foreign Home" case depends on how resolveOraToolContext uses it, worth confirming it really exercises the not-member path. (b) The client component test never asserts that nothing is claimed while the tab is hidden, nor the 90 s interval/visibility behaviour. (c) The display widget test proves "nothing to press or type" for the component, but no test proves the display board data (DisplayBoard / board data function) is unchanged; the claim "no new data exposure" rests on the diff not touching it, which holds in this diff. (d) The client-side `claimCelebration` shares its name with the server function; rename for grep-ability (maintainability only).

## Explicit checks

- Requirements: met. A chore award celebrated once per person and ledger entry (primary key plus ON CONFLICT DO NOTHING), only the owner's account (join on `a.user_id = v_user`), only unreversed and within 15 minutes, gated by Ora enabled, category switch, Quiet (SQL and TS) and quiet hours (TS, deferred without claiming). "Why am I seeing this?" on request in panel and teaser. Display-only Ora widget has no controls and uses only counts the board already provides. Caveat: M1 (can be zero times).
- Cross-Home isolation: good. The function checks membership (`private.is_home_member`) first and filters `e.home_id = p_home_id` and the account in that Home; the table row has a membership FK, RLS select requires own row plus current membership; no insert/update/delete grants. DB test covers foreign Home (denied), other member's rows invisible, and cleanup on leaving. Not tested: the same person's award in a second Home never being claimed through the first (the code is correct; add a test if cheap).
- Permissions / security definer: `set search_path = ''`, all objects schema-qualified (`auth.uid()`, `private.*`, `public.*`, `pg_catalog.jsonb_build_object`), execute revoked from public and anon, granted to authenticated, `auth.uid()` null refused with 42501. Matches the S47/S47b pattern. Reading the private ledger is limited to the caller's own account. The function writes only the caller's rows. No privilege escalation found.
- Data-modifying CTE semantics: correct. `claimed` is referenced by the main query, so it always runs; `eligible` is materialised once; under READ COMMITTED a concurrent claimer blocks on the conflicting insert and then skips it, so exactly one caller gets each entry. `HAVING count(*) > 0` without GROUP BY is valid: the query is a single-group aggregate and returns zero rows (v_result stays NULL) when nothing was claimed. The scalar title subquery inside the aggregate is uncorrelated and valid. 15-minute window uses `created_at` (posting time), correct for late approvals. Reversed awards excluded through `reverses_id` of any kind (covers chore_reversal and manual_reversal); a reversal after celebration is not retracted, acceptable.
- Secrets: none added. Input validation: route has origin and size checks, strict zod body (uuid or null), uncached; DB parameters typed and membership-checked; answer re-validated with zod on the server. Errors logged without data.
- Migration safety: additive (new table, new function, `create or replace` of valid_display_layout keeping all prior rules and adding one type). Existing layouts stay valid; rollback by reverting the function and dropping the table (note: layouts saved with the `ora` widget would then fail the old check on next save; document). Migration timestamp follows the previous one.
- Privacy of wall display and children: the wall widget shows only Home-level counts already delivered to the display (no person, balance, ranking); celebrations are personal, never on the wall, never about another member. Open question for the owner (not a finding): whether child accounts are meant to receive Ora celebrations; the function treats every authenticated member alike, consistent with S47/S47b.
- Test coverage: good on privacy (own versus other member, reversed, old, switches, quiet mode, anon, foreign Home, direct write, membership removal, layout validation) and on TS gating. Gaps: titles (M2), concurrency (cannot be proven by one-transaction SQL tests; reasoning above is sound), the 20-row limit, second-Home isolation, in-flight cancellation (M1), hidden-tab behaviour.
- Accessibility: no focus change, polite status, dismiss button, character honours the system reduced-motion setting, widget has `role="img"` with a name and passes axe. Concerns L1 to L3.
- i18n: en and nl added for celebration, why text, display widget names and strings, with plurals for points and counts; `several` count not pluralised (M2). Dutch copy reads fine.
- Performance: M3; otherwise one small poll per 90 s per visible tab, skipped when hidden or panel open.
- Maintainability: follows the S47a/b pattern; quiet-hours and switch logic split between TS and SQL is intentional and documented; ADR and brief present.

## Remaining risks

- A celebration can be lost (M1, network failure after commit); by design nothing is retried.
- Polling cost with long ledgers (M3).
- Quiet hours are enforced only in the server action; a user calling the RPC directly can claim during quiet hours (self-inflicted, no exposure).
- Awards not followed by a page load, visible tab or poll within 15 minutes are never celebrated (documented in the ADR).
- Full suite, build and Playwright were not run locally; rely on CI.
