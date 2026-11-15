# S47c · Ora celebrations, display-only Ora and "why am I seeing this" — feature brief

**Branch:** `feat/ora-celebrations-display` from `main` (S47b merged, PR #86).
**Model:** Sonnet. Same pattern as S47a/b (own-row table, one security-definer claim function, no new write path into any module).
**Order reading:** the build plan has no step between S47 and S48; S47a and S47b delivered part of S47, so S47c continues it before S48.
**Sources:** PS L921–L926 (celebrations), L1360–L1365 (display-only Ora), L1056 (explanations), L1399–L1405; ADR 0054.
**Done when:** a really awarded chore point is celebrated once, quietly, only for the person who earned it and only when Ora, the category, Quiet and quiet hours allow; a suggestion explains itself on request; a display can show a display-only Ora with nothing to press or type.

## Scope (S47c)

1. **Celebrations** for chore-point awards: `public.ora_celebrations` + `claim_ora_celebrations`, `POST /api/v1/ora/celebrations`, small dismissible note beside the Ora button (Home only).
2. **"Why am I seeing this?"** on suggestions (panel and teaser).
3. **Display-only Ora**: new `ora` display widget (no settings, no actions), database layout check updated, shown from the display's own counts.

## Deferred to S47d (by choice, to keep this PR reviewable)

More guided actions (complete task, change due date, recurring, meal to shopping, multi-record updates, deletion) with a locking Undo function; reminders content; celebrations on the wall display and for milestones or leaderboard positions. Ward decides whether S47d is built before S48.

## Defaults picked (Ward may change)

1. Only chore-point awards are celebrated (the one authoritative, idempotent event that exists).
2. An award counts for 15 minutes after it is posted; note stays 15 seconds.
3. Several awards close together become one line without a chore name.
4. The wall Ora shows counts it already has, no celebrations, no motion.
5. Active = Balanced for celebrations too (as in S47b).

## Status

- [x] ADR 0054, migration `20261209090000_ora_celebrations_display.sql`, types, DB test `tests/db/rls/ora_celebrations_display.test.sql` (run alone against a throwaway local PostgreSQL 16: passes)
- [x] Server `ora/celebrations`, route, `ora-celebration.tsx`, `ora-why.tsx`, display `ora` widget, i18n en/nl
- [x] Local: prettier, eslint (touched dirs, max-warnings 0), tsc, unit/component/route tests for ora, components/ora, components/displays, displays, api/v1/ora, i18n: pass
- Not run locally by design: full suite, build, Playwright (CI)
- [x] Independent review: PASS (0 BLOCKER, 0 HIGH, 3 MEDIUM, 6 LOW) -> `reviews/steps/S47c-review.md`. Fixed: M1 (a claimed celebration is kept if the panel opens mid-request), M2 (plural copy for an unnamed single award), M3 (partial index for the 15-minute window), L5 (schema max 20). Accepted and recorded in ADR 0054: unnamed single award SQL title path has no DB test, no pruning, note timer, stacking on tiny screens, live-region mount.
- [x] CI E2E on PR #89 failed three times on different tests each run (storage upload, calendar, invitations, numeric habits), always a 5 s "not found yet" assertion wait; main's last green run was 29 min, mine 22–36 min, and per-test durations did not rise with this change, so it is runner variance. Fix: default assertion wait 5 s -> 15 s (`tests/e2e/playwright.config.ts`), the calendar test now waits for the preference save before reloading (a real race), and the celebration note asks at most once a minute per tab and Home (less load).
