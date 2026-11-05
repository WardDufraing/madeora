# S33 Google Calendar connect and inbound sync: independent review

**Reviewer:** an independent review agent with fresh context (not the implementer). This is an AI review. It is not a GitHub human approval.
**Tree:** uncommitted working tree on `feat/google-calendar-connect`, on top of `1cbc01f`.

**Read:** `/mnt/project-files/wip/S33/s33.diff` (all of it); `plans/steps/S33-brief.md`; `docs/adr/0043-google-calendar-connect.md`; `docs/google-calendar-setup.md` (steps 1–6); `CLAUDE.md`; `docs/product/Modules.md` L25–50 and L178–182; `docs/product/Project-specification.md` L931, L935, L2474–2486 and L2532–2536 (no other lines); `architecture.md` §31 only; the whole of `supabase/migrations/20261119090000_google_calendar.sql` and `tests/db/rls/google-calendar.test.sql`; the S32 `list_calendar`, `get_calendar_upcoming`, `calendar_context_events`, `calendar_level` and `require_calendar_home`; `private.enqueue_job`, `private.notify_user`, `private.require_confirmed_caller`, `private.member_ref`; every file in `packages/google-calendar/src`; `packages/jobs/src/jobs/google-calendar.ts`, `google-sync-store.ts` and the jobs diffs; every new web route, `apps/web/src/google-calendar/*`, `components/google-calendar/*`, the settings and event pages, and the calendar view, widget, notification and env diffs; `docs/provider-cost-register.md` diff; `@madeora/config` `parseEnv`.

**Ran:**

- `pnpm --filter @madeora/google-calendar test`: 4 files, 35 tests passed.
- `apps/web`: `pnpm exec vitest run src/app/api/v1/integrations src/components/google-calendar src/google-calendar`: 4 files, 39 tests passed.
- `packages/jobs`: `pnpm exec vitest run src/jobs/google-calendar.test.ts`: 5 tests passed.
- ESLint on the new and changed files in `apps/web`, `packages/jobs` and `packages/google-calendar`: **4 errors** (see H1). All other files clean.
- `tsc --noEmit` in `apps/web`, `packages/jobs` and `packages/google-calendar`: clean.
- `prettier --check` on every changed `.ts/.tsx/.json/.md/.js` file: clean.
- `git status`, `git diff`, greps.

I did **not** run the database suite (`tests/db/rls/google-calendar.test.sql`), the full Vitest suites, the build or Playwright. `/mnt/project-files/wip/S33/` holds only the diff; there were no implementer logs to read.

**Verdict:** `CHANGES_REQUIRED`

## Findings

### BLOCKER

None.

### HIGH

**H1. ESLint fails on the new warnings component and its test, so the required CI lint check fails.**

- **Where:**
  - `apps/web/src/components/google-calendar/google-warnings.tsx:26`: `react-hooks/rules-of-hooks`. `useTranslations` is called after the early `return null` on line 25.
  - `apps/web/src/components/google-calendar/google-warnings.test.tsx:32`, `:57`, `:67`: `@typescript-eslint/require-await` (async test callbacks with no `await`).
- **Impact:** the PR cannot go green. The hook order rule is also a real defect: the component calls a hook conditionally.
- **Remediation:** call `useTranslations` before the early return. Drop `async` from the three test callbacks, or await something in them. Run ESLint across the workspace again.

### MEDIUM

**M1. Turning a calendar's sync off during a running sync can leave its events stored and its sync token set.**

- **Where:** `supabase/migrations/20261119090000_google_calendar.sql:760-765` (`google_sync_apply_events` reads the calendar with no row lock), `:816-838` (`google_sync_finish_calendar` does not check `sync_enabled` or `available`), against `:603-609` (`set_google_calendar_settings` turns sync off without regard to the lease).
- **How:** the job's `apply_events` reads the calendar as `sync_enabled` before the person's "sync off" commits. The person's transaction deletes the events and clears the token. The job's insert then runs and stores the page again. Its `finish_calendar` then stores a new sync token and `last_synced_at` on the disabled calendar.
- **Impact:** the brief says turning sync off deletes the events and the token. Here they stay stored (hidden, since readers require `sync_enabled`) until the calendar is turned on again. On re-enable the old rows come back with an incremental pass instead of a fresh full pass. This is a narrow race, but it breaks the stated retention rule for private data.
- **Remediation:** in `google_sync_apply_events` and `google_sync_finish_calendar`, lock the calendar row (`select ... for update` or `for share` on `private.google_calendars`) and recheck `sync_enabled and available` after the lock. Return null or false when they no longer hold. Add a DB test that turns sync off between a page and the finish.

**M2. Any signed-in person can queue unlimited sync jobs by calling two RPCs directly.**

- **Where:** `supabase/migrations/20261119090000_google_calendar.sql:501-537` (`save_google_calendar_connection`: every same-account call is a "reconnect" that bumps `sync_seq` and queues a new job), `:618-621` (`set_google_calendar_settings`: every off-then-on toggle queues a job). Both are granted to `authenticated` (`:917-927`).
- **How:** the functions are reachable through PostgREST with the person's own session, without going through the OAuth callback. A forged token in the right shape passes the format check. Only `request_google_calendar_sync` has the once-a-minute limit.
- **Impact:** each call creates one outbox row and one Trigger.dev run. Trigger.dev's free plan has a shared $5 a month, and when it is used all jobs stop (emails, reminders), per `docs/provider-cost-register.md`. One person can use it up for everyone. This touches the €0 rule.
- **Remediation:** apply the same `manual_seconds` limit to the queueing in these two functions (skip the enqueue when `sync_requested_at` is recent; the 15-minute automatic run still picks the connection up). Add a DB test that repeated saves and toggles queue at most one run per minute.

**M3. The provider-cost register does not account for the new Trigger.dev usage.**

- **Where:** `docs/provider-cost-register.md`: the Trigger.dev row is unchanged; the Google Cloud row's status still says "Calendar (S33) to be re-checked then" and "sensitive scopes ... (not used)".
- **Impact:** every connected account now gets one `google-calendar-sync` run every 15 minutes, about 2,880 runs a month, each one network-bound and longer than a dispatcher run. The register says the 5-minute dispatcher (about 8,640 short runs) costs about $0.50 a month. At that rate a few dozen connected accounts, or fewer, could use the $5 free budget, after which every job stops. CLAUDE.md requires the free-tier impact to be checked and recorded before a service's usage grows.
- **Remediation:** add an estimate per connected account to the Trigger.dev row, with the point where the $5 runs out and the fallback (for example a longer interval, or skipping runs for connections with no calendar to sync). Update the Google Cloud row's status and its note on sensitive scopes. Ask the owner if the estimate is close to the limit.

### LOW

**L1. A sync request that arrives while a run holds the lease is dropped, and the page keeps saying "Syncing…".**

- **Where:** `packages/google-calendar/src/sync.ts:131` (returns `busy`), migration `:679-682` and `:455-456`.
- **Impact:** Sync now, connect or turning a calendar on during a running sync does nothing. `syncQueued` stays true until the next automatic run, up to 15 minutes later.
- **Remediation:** on `busy`, retry the job later (a retryable error with a delay), or let `google_sync_finish` queue one follow-up run when `sync_requested_at > last_attempt_at`.

**L2. The client accepts up to 2,000 calendars, but the database refuses more than 250.**

- **Where:** `packages/google-calendar/src/client.ts:130` against migration `:705-707`.
- **Impact:** for such an account `google_sync_calendars` raises 22023. The job fails as a store error, keeps the lease until it expires, and never syncs. The person sees no error code.
- **Remediation:** cap the list at 250 in the client (or stop at the page limit and report `too_many_calendars` through `google_sync_finish`).

**L3. An "inactive" connection is queued again every 15 minutes forever.**

- **Where:** migration `:676-678` returns `inactive` before setting `last_attempt_at`, and `queue_google_calendar_syncs` (`:892-899`) selects on `last_attempt_at`.
- **Impact:** a run per slot for an account that can never sync. It adds a little to M3.
- **Remediation:** set `last_attempt_at` (or a status) before returning `inactive`.

**L4. The widget warning does not show the last sync time.**

- **Where:** `apps/web/src/components/google-calendar/google-warnings.tsx:52` (`compact` drops `when`).
- **Impact:** the brief says warnings name the calendar and the last successful sync, and PS L931 asks for the last-known refresh time where reliably available. The widget shows only the state.
- **Remediation:** keep a short time in the compact form, or confirm with the owner that the widget may leave it out.

**L5. One key serves both refresh tokens and the OAuth state cookie.**

- **Where:** `apps/web/src/app/api/v1/integrations/google-calendar/connect/route.ts:40` and `apps/web/src/google-calendar/server.ts:81`, both with `google.tokenKey`.
- **Impact:** safe today, because the associated data differs per purpose. But a later key rotation or leak affects both.
- **Remediation:** optional. Derive two subkeys (HKDF) from `GOOGLE_CALENDAR_TOKEN_KEY`, or record the choice in ADR 0043.

**L6. External links open a new tab without saying so.**

- **Where:** `apps/web/src/components/google-calendar/google-calendar-actions.tsx:107` (Google permissions page); the Google link on the event page (`apps/web/src/components/google-calendar/google-event-page.tsx:156-157`).
- **Remediation:** add visually hidden text such as "(opens in a new tab)".

**L7. The database test does not check that `google_sync_calendars`, `google_sync_finish_calendar` and `google_sync_finish` are closed to people.**

- **Where:** `tests/db/rls/google-calendar.test.sql:85-89` covers `google_sync_begin`, `google_sync_apply_events` and `queue_google_calendar_syncs` only.
- **Impact:** the grants are correct today (migration `:930-940`), but a later change could open them unnoticed.
- **Remediation:** add `assert_denied` for the other three as `authenticated`.

## Explicit checks

- **Requirements:** met for S33 scope: connect, encrypted tokens, calendar choices per personal view and per Home, incremental and full sync, 410 resync, states, Sync now, disconnect, read-only Google events in the calendar, event page and widget. M1 breaks "sync off deletes its events" in a race. L4 is a small gap against the warning text.
- **Cross-Home isolation and privacy:** good. Every reader goes through `google_context_events`. Personal needs `c.user_id = viewer and show_personal`. A Home needs a share and the viewer's membership, and excludes `private_in_google`. The share's foreign key to `home_memberships` ends it when the owner leaves (tested). Unshared calendars show no event, count, name or state in `list_calendar`, `get_calendar_upcoming`, `get_google_calendar_event` or the warnings (tested for Carol and Bob, including forged ids). The Google link and the exact reason are the owner's only.
- **Permissions:** no table is granted to an API role. Person functions call `require_confirmed_caller` and act only on the caller's own row. Job functions are service-role only and recheck the lease. Private helpers are revoked. Forged calendar ids answer `not_found`. Home ids must be the caller's own Homes. M2 is the one gap (no throttle).
- **OAuth:** state and PKCE S256 sealed in an httpOnly, Lax, callback-path cookie bound to the person, 10 minutes, used once, compared in constant time. The connect POST checks the origin. The callback checks the cookie before reading `error`, requires both scopes and a refresh token, and revokes the grant on failure. Redirects are fixed or relative, so there is no open redirect. Google sign-in never connects a calendar.
- **Secrets:** AES-256-GCM, random 96-bit IV, 128-bit tag, the purpose and person id as associated data, a 32-byte key checked. The token never reaches the browser or a log. Logs carry event names and codes only. The access token stays in memory. Variables are server-only and all-or-none. See L5.
- **Input validation:** Zod on every route body and on Google's answers. The database checks the token shape, scopes, text limits, the event time shape and the link prefix. Malformed pages raise 22023 and apply nothing.
- **Migration safety:** `create or replace` of `list_calendar` and `get_calendar_upcoming` keeps the signatures, grants, order, limits and native output. Native occurrences only gain `source: "madeora"` and `calendar: null`, and the web shapes default both. New tables only; there is no down migration (rollback means dropping the four tables and restoring the S32 bodies).
- **Sync correctness:** idempotent upsert on calendar and Google id, last item per id in a page, cancelled instances and series removed, the full pass removes unseen rows, 410 clears the token and runs a full pass, `invalid_grant` ends as authorization expired with one notice, retryable outages retry, a lost lease stops the run. Gaps: M1, L1, L2.
- **Test coverage (done-condition):**
  - Revoked consent: `packages/google-calendar/src/sync.test.ts` "ends as authorization expired when Google refuses the refresh token (revoked consent)" (and the mid-run 401 and unreadable token cases); `tests/db/rls/google-calendar.test.sql:325-353` (state, events kept, warnings, one notice, no run started or queued, reconnect keeps choices). Covered.
  - Invalid sync token resync: `sync.test.ts` "resyncs the whole window when Google says the sync token is no longer valid (410)"; `google-calendar.test.sql:258-280` (token cleared, `fullDue`, events kept until the full pass replaces them). `client.test.ts` "reports 410, rate limits and 401 by kind". Covered.
  - Duplicate prevention: `sync.test.ts` "repeating the same run changes nothing (duplicate prevention)" and the incremental case with a repeated id; `google-calendar.test.sql:145-165` (same page twice, an id twice in one page, five rows after the full pass) and `:272-275`. Covered.
- **Accessibility:** labelled form, fieldset with legend, announced alerts, axe test for the actions; the Playwright page runs axe. L6 is minor.
- **Performance:** bounded per run (20 calendars, 40 pages of 250, 5000 events) and per sweep (100 connections). There is no time index on `google_calendar_events`; reads scan the context's calendars' rows (at most 5000 each), which is acceptable at this scale.
- **Maintainability:** clear split between pure package, store port, job and routes; limits are mirrored in SQL and TypeScript with comments. H1 must be fixed.

## Remaining risks and test gaps

- Not verified against live Google: whether a windowed full pass (`timeMin`/`timeMax` with `singleEvents=true`) always returns `nextSyncToken`, and how many instances an incremental pass returns for an edited series without an end. If the token is missing, every full pass fails with `google_refused`. If incremental passes expand series widely, they store events outside the window (until the next full pass) and may hit `too_many_events`. Test with a real test account before release.
- A lease of 300 seconds is never renewed. A slow run with many calendars loses the lease partway; progress per calendar is kept, so the next run continues.
- I did not run the database test file; its results depend on the implementer's run.
- The Home-context read uses a `case` in `where`, like S32, and may not use the shares index; not measured.
- Testing mode ends tokens every 7 days, so owners reconnect weekly until Google verifies the app.

## Implementer follow-up (not part of the independent verdict)

No second review round was run, as agreed for this step. The implementer verified each fix:

- **H1 fixed:** `useTranslations` now comes before the early return in `google-warnings.tsx`; the test callbacks are synchronous where they await nothing. ESLint passes for the web app and the Google Calendar package.
- **M1 fixed:** `private.google_leased_calendar` now locks the calendar row (`for update`), and `google_sync_finish_calendar` keeps no token for a calendar that is off or gone. A new database test turns sync off during a run and checks that no event and no token come back.
- **M2 fixed:** connecting and turning a calendar on queue at most one run a minute per person (the poll picks up the rest). The automatic queue now skips accounts with no calendar to sync. New database tests cover both.
- **M3 fixed:** the cost register's Trigger.dev and Google Cloud rows now carry the per-account estimate, the break-even point and the fallback; ADR 0043 notes them too.
- **L2, L3, L6, L7 fixed:** the client refuses more than 250 calendars (unit test); an inactive connection counts as an attempt; external links say "(opens in a new tab)" to screen readers; the database test denies people the other three job functions.
- **L1, L4, L5 recorded as known limits in ADR 0043** rather than changed.

Checks after the fixes: Prettier, ESLint, typecheck, web unit tests (2794), jobs (284), Google Calendar package (36) and the S33 database test all pass. The full browser run had passed 189 of 192, with 3 time-outs in `members.spec.ts` and `roles-and-ownership.spec.ts`, which S33 does not touch. Those two files then passed on their own (6 of 6).
