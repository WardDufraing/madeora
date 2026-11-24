# UX8a independent review: protected-action sessions and ambient timing

- Branch: `feat/display-protected-session` (commit 597174a), diff against `main`
- Reviewer: independent review agent with fresh context. It did not implement this change and edited no code.
- Scope read: the full diff; migrations 20261203090000, 20261204090000 and 20261205090000 for the existing display, PIN, lock and action functions; the route helpers; `display-actions.ts`; the new DB test file; the component and route tests.

## Verdict: PASS

No BLOCKER or HIGH findings. There are three MEDIUM and seven LOW findings. The MEDIUM findings should be fixed or explicitly accepted by the owner before merge. None of them lets anyone lift the privacy lock, act across Homes or Displays, or go beyond what a member is already permitted to do.

## Verification performed

- `vitest run` on the display screen tests, the display routes, the settings route, `src/displays/*` and the i18n message tests: 10 files, 107 tests, all pass.
- `tsc --noEmit` for `apps/web`: clean.
- DB test `tests/db/rls/display_protected_sessions.test.sql`: **not run by this reviewer**. No local Supabase or Postgres cluster was running, and the fallback refuses to run `initdb` as root. I read it in full instead. CI has to provide the evidence for it.
- I checked by hand that the new `display_chore_attempt` and `display_chore_verified` keep everything from 20261205090000 and 20261204090000. No later migration had redefined them. The no-lockout change (no `count_device_pin_failure`) is kept.

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

**M1. Relock on "Lock now" and on entering ambient is best-effort and can silently fail to end the server session**

- File: `apps/web/src/components/displays/display-screen.tsx:252`. Also `relock` at line 136 and `endUnlockHere` in `apps/web/src/displays/api.ts`.
- Impact:
  - `enterAmbient` calls `endUnlockHere()` only when `unlockLeftRef.current !== null`, that is, only when the client already knows about a session.
    - The client misses a session it should know about whenever the `refresh()` after a PIN-verified chore fails. Examples: a 503, or a short offline blip, since `refresh` keeps the old state on `offline`. The display then goes ambient without ending the session.
    - After a tap brings the board back, the session reappears with its remaining time.
    - Decision 37 and done condition 3 require "the session ends on … entering ambient".
  - "Lock now" ignores the result of `endUnlockHere()`. If that call fails:
    - the indicator disappears and the user believes the display is locked;
    - the next refresh (at most one minute later, or a Realtime signal) brings the session back, and the member's PIN-gated actions again run without a PIN.
  - The server cannot detect ambient, so the client is the only enforcer of this rule.
- Remediation:
  - Always call `endUnlockHere()` when entering ambient. It is idempotent and returns `none` on the server.
  - For Lock now: on failure, keep the indicator and show an error, or retry until the server confirms. Do not clear local state optimistically without a retry.
  - Add tests: ambient entry while the client has no known session still calls `/unlock/end`; a failed Lock now is surfaced.

**M2. The "Lock now" control is a small touch target on a wall display**

- File: `apps/web/src/components/displays/display-screen.tsx:469` (`size="sm"`, which is `min-h-8`, 32 px).
- Impact: Decision 37 asks for an "immediately accessible Lock now" with touch accessibility. 32 px meets WCAG 2.5.8 (24 px) but is below the 44 px used for touch kiosks. The nearby manager buttons in the lock dialog use `min-h-14`. The existing Privacy lock button at line 483 has the same problem.
- Remediation: use the `md` size or a minimum height of 44 px for Lock now, and preferably for Privacy lock too.

**M3. Gaps in the DB and component tests for done conditions 3, 5 and 7**

- Files: `tests/db/rls/display_protected_sessions.test.sql`; `apps/web/src/components/displays/display-ambient-setting.tsx` has no test.
- Impact:
  - The child branch of `private.display_unlocked_member` (`child_home_pins`, migration lines 73–77) has no test at all. That includes a child opening a session, and a guardian lock (`pin_locked_until = 'infinity'`) or PIN removal ending one.
  - For adults, "PIN removed" and "PIN locked" are not tested. Only "PIN changed" is.
  - There is no positive test for an Administrator _with_ manageHomeSettings, either for `save_home_display_settings`/`home_display_settings` or for `display_lock_by_session`. Only Owner (allowed) and Administrator without the capability (denied) are covered.
  - `DisplayAmbientSetting` has no RTL+axe test (save, refusal, accessible announcement), although done condition 7 asks for component tests with axe.
  - The ambient view and the in-session lock dialog are not checked with axe.
- Remediation:
  - Add DB cases: child session open/use/end via guardian lock and via PIN removal; adult PIN removal (`remove my device PIN`) and adult PIN lockout; Administrator granted manageHomeSettings saves the timing and locks by session.
  - Add an RTL+axe test for `DisplayAmbientSetting`.
  - Add axe checks for the ambient view and the in-session lock dialog.

### LOW

**L1. Focus is lost in the lock dialog when the manager is in session**

- File: `apps/web/src/components/displays/display-lock-dialog.tsx:121`.
- Impact: After the manager is picked, their button unmounts. In session, the PIN field (the element with `focusOnMount`) is not rendered, so focus falls back to the document or dialog. Keyboard and screen-reader users lose their place.
- Remediation: focus the in-session paragraph (`tabIndex={-1}`) or the submit button on mount.

**L2. The ambient view is a `<button>` that contains block content and a live region**

- File: `display-screen.tsx:343–366`.
- Impact:
  - `DisplayClock` renders a `<div>` and `<p>`, and `{status}` is a `<p role="status">`. None of these is allowed inside a `<button>`, whose content model is phrasing content only.
  - The button's accessible name is built from the clock, so it changes every minute, and it contains a live region.
- Remediation: give the button an `aria-label` (`ambientTitle`/`ambientHint`) and render the clock and status as `aria-hidden` siblings, or wrap them in a full-screen container with the button as an overlay.

**L3. The countdown relock can end a newer session**

- File: `display-screen.tsx:136–158`; `public.display_end_unlock`.
- Impact: The client counts down from the server's seconds and calls `/unlock/end` at zero. If another member entered a PIN in the last second or two, or the local count lags, `display_end_unlock` deletes whatever session the display has, including the fresh one. The only result is an extra PIN prompt.
- Remediation:
  - Option 1: when the time runs out, only refresh; the server already treats an expired session as gone.
  - Option 2: pass the expected membership to `display_end_unlock` and delete only a matching row.

**L4. Out-of-order `refresh()` responses can briefly bring back an ended session**

- File: `display-screen.tsx:103–123`.
- Impact: A periodic or Realtime refresh that started before Lock now or ambient can resolve after it and set `unlockLeft` again. The next refresh corrects it, and the server stays authoritative. The display can still show "Unlocked for …" for a moment after Lock now.
- Remediation: add a request sequence number or generation counter, and ignore responses that started before a relock.

**L5. Narrow window for a PIN change between attempt and verify**

- File: `supabase/migrations/20261222090000_display_protected_sessions.sql:79–82, 388`.
- Impact:
  - The check compares `pin_set_at <= s.opened_at`, with `opened_at` taken at _verify_ time.
  - Suppose the PIN changes between `display_chore_attempt` (which returned the old hash) and `display_chore_verified`. The old PIN then opens a session that counts against the new PIN.
  - The window is about one scrypt comparison inside a single request, so it is very small.
- Remediation: in `open_display_unlock`, also require `pin_set_at <= check.created_at`, or open the session with `opened_at = check.created_at`.

**L6. No screen-reader announcement when a session opens or ends**

- File: `display-screen.tsx:454–480`.
- Impact: The indicator is not in a live region. That is correct for the per-second countdown, but nothing is announced when the display becomes unlocked or locks again by itself.
- Remediation: one polite announcement on open and one on end. Never announce each tick.

**L7. Board reads cost more and the rollback order is not documented**

- Files: `apps/web/src/displays/board.ts:260`; the migration header.
- Impact:
  - Every board read (each minute, plus each signal, per display) now makes a second, sequential service-role RPC, and that RPC runs a `delete`.
  - The rollback note does not say that the app (which calls `display_session_state`, `display_lock_by_session` and `display_end_unlock`) must be rolled back before the database. `readDisplaySessionState` does fall back safely, but lock-by-session would return `unavailable`.
- Remediation:
  - Optionally fold the state into `display_board`, or run the two calls in parallel.
  - Add "roll back the app first" to the rollback note.

## Explicit checks

- **Requirements**
  - Condition 1: met. One row per display (PK `display_id`). `expires_at = now() + 5 min`, enforced by a CHECK. It is never extended, and a new PIN replaces the row.
  - Condition 2: met. Session completion is recorded as `'session'`. All other checks still run: active display, unlocked, actions enabled, `display_member` eligibility, `shared_device_pin_needed`. `display_lock_by_session` re-checks `display_lock_manager`.
  - Condition 3: met in the database:
    - expiry via `expires_at`;
    - Lock now via `display_end_unlock`;
    - privacy lock via the trigger on `display_configs` (the config row always exists because `display_config()` upserts it), plus the `locked` check in `display_unlocked_member`;
    - revocation via a trigger, plus `active_display`;
    - leaving the Home via `is_home_member`;
    - PIN removed, changed or locked via the `pin_set_at` and `pin_locked_until` checks;
    - Home closed via `home_is_open`.
      Ambient depends on the client (M1).
  - Condition 4: met. There is no new unlock path, `display_lock_by_session` returns `unchanged` when the display is locked, and no failure counting was added.
  - Condition 5: met. Settings use `display_manager_check(..., true)`, a server-side allow-list check plus a table CHECK, an audit entry, a signal bump through `bump_home_display_signals` limited to that Home's active displays, and a test that Home B's signal is unchanged.
  - Condition 6: met. The display shows the name and an `m:ss` countdown. Lock now moves focus to the `h1` (tested). The ambient view shows only the clock, a hint and the offline status. NL and EN strings are present.
  - Condition 7: met only in part (M3).
- **Cross-Home isolation**: met. The session row stores `home_id`, which is joined to the display's Home. Membership refs are resolved inside the display's Home. Tests cover another display in the same Home, another Home's display and another Home's manager. Settings signals reach only the right Home.
- **Permissions**
  - All new display RPCs are granted to `service_role` only and are listed in `SERVICE_ROLE_RPCS`. The display ID always comes from the display's own server-side session (`requireDisplay`), never from the client.
  - The settings RPCs are `authenticated` only and are checked in the database. The route also checks `home.updateSettings` and uses `readMemberMutation` (same-origin / CSRF).
  - The client's `unlockedMembershipId` only guides the UI. The server decides, and the UI falls back to asking for the PIN on `pin-required`.
- **Secrets**: met. No new secrets. PIN hashes are still compared on the server only, and no session token reaches the client. The client receives only the membership ref and the seconds left.
- **Input validation**: met. Zod strict schemas (`pin` nullable, `ambientAfterSeconds` from the allow-list, `{}` for unlock/end) with body-size caps, re-validated in SQL (`22023`, and a CHECK constraint). The RPC output is parsed with Zod in `readDisplaySessionState` and `getHomeDisplaySettings`.
- **Migration safety (incl. rollback)**: met. The changes add things or widen the `verification` constraint (existing rows stay valid). The `create or replace` functions are faithful supersets. Tables are in `private` with `revoke all`. A rollback is documented, including the conversion `'session' → 'pin'` before the old constraint is restored. Missing: the app-first ordering (L7).
- **Test coverage**: good multi-actor DB coverage of the main paths, plus route tests (lock by session, unlock/end incl. 401/400/503/cross-site, settings) and RTL+axe on the unlocked board. The gaps are listed in M3.
- **Accessibility**: Lock now returns focus correctly. The ambient view has no animation, and its periodic shift is a static jump (good for reduced motion). Issues: M2, L1, L2, L6.
- **Performance**: acceptable. See L7. The new table is tiny and keyed by `display_id`. Clean-up deletes are bounded.
- **Maintainability**: good. The SQL is clear and commented in the style of the repository, the code is typed end to end, the `database.types.ts` changes match the functions, and the i18n test is updated.

## Remaining risks and test gaps

- Ending the session on ambient cannot be enforced by the server; it depends on the display client (M1). A display that never reports going ambient keeps the session for up to five minutes. That is acceptable because that same device is the only place the session can be used.
- The DB test file was not executed in this review. Merge readiness depends on the CI Supabase run.
- The child session path, adult PIN removal and lockout, Administrator-with-capability positive paths, the ambient setting component and axe checks on the ambient view are untested (M3).
- There is no E2E (Playwright) coverage of the PIN → session → Lock now → ambient flow on a paired display.

---

## Author's handling (verified by the author; no second full review, per project rule)

- **M1** fixed: entering ambient always asks the server to end the session (`display-screen.tsx` `enterAmbient`); Lock now retries once and then re-reads the board, so a session that could not be ended shows again instead of staying open unseen.
- **M2** fixed: Lock now is a 48 px target (`min-h-12`).
- **M3** fixed: DB tests added for a child's session (own chores only; ends when the guardian removes the PIN), an adult PIN locked elsewhere (and lifted), a removed adult PIN, and an Administrator with manageHomeSettings reading and saving the timing. New RTL + axe test `display-ambient-setting.test.tsx`. Display DB tests pass on the local PostgreSQL fallback; DB types check up to date.
- **L1** fixed: in a session the lock dialog focuses its confirm button.
- **L3** fixed: at zero the screen only clears its countdown and re-reads the board; it no longer ends a session someone else opened.
- **L2, L4, L5, L6, L7** accepted as LOW for now (noted in the brief): ambient button markup, out-of-order refresh, the narrow PIN-change window, screen-reader announcements on open/end, and the extra per-board call; the rollback order (app first) is added to the migration notes in the brief.
