# UX8a — Wall display: protected-action sessions and ambient timing

Status: built, reviewed, PR open (see section 8). Branch `feat/display-protected-session`. Model: Opus (PIN/session security).
Source: `plans/steps/UX00-redesign-plan-brief.md` (§3 D, §7 HIGH, §8 Ward's answers), `docs/design/dashboard-ux-ui-redesign.md` decisions 36 and 37 (L471–L493).
Binding rules kept: S44 privacy lock (`20261204090000_display_layouts_lock.sql`: only a manager's own signed-in session unlocks) and the no-lockout rule (`20261205090000_display_pin_no_lockout.sql`: display tries never count toward a member's PIN lock).

## 1. Scope

In:

- **Decision 37, "protected actions only" (Ward, 19 Nov):** a member's PIN that matches on a display opens a **five-minute protected-actions session** for that member on that display. While it lasts, that member's PIN-gated actions on that display need no PIN: completing a chore that needs a PIN (Home rule, member rule or chore rule), and, for a manager, turning on privacy mode. Unlocked-state indicator with countdown and **Lock now**.
- **Decision 36, ambient timing and idle logic:** a per-Home setting (1, 2, 5, 10, 15 or 30 minutes; default 5) for its managers; after that long without a touch or key the display shows a simple ambient view (time and date only). A deliberate tap brings the dashboard back.

Out (later slices): weather (waits for Ward's approval of a provider, €0 rule), privacy-safe household items in the ambient view, ambient visual design beyond the minimum, the per-Home wall layout (D35), dashboard-first navigation (D38), protected reassignment (D39). No explicit "Unlock" button: a session opens from a PIN the member already types for an action (decision 37: "a successful PIN entry opens a short-lived five-minute unlock session rather than prompting for every action").

## 2. Done condition

1. A matched PIN on a display opens a session for that member on that display only; it lasts exactly five minutes from the PIN and is never extended.
2. During the session, the server accepts that member's PIN-gated chore completion without a PIN (recorded as verification `session`) and a manager's privacy lock without a PIN. Every other check still runs on each action: display active and unlocked, actions on, member still a member and eligible, manager capability. No one else and no other display benefits.
3. The session ends on expiry, Lock now, entering ambient, privacy lock (remote or on the display), revocation; it stops counting when the member leaves the Home or their PIN is removed, changed or locked.
4. Nothing on the display lifts the privacy lock. Wrong tries still never lock a member's PIN.
5. Ambient timing: managers only (Owner, or Administrator with manageHomeSettings), offered values only, audited, reaches the Home's displays through their Realtime signal; other Homes unaffected.
6. Display shows who is unlocked and the time left, Lock now returns focus to the page heading; ambient view hides all household data; NL and EN strings.
7. Multi-actor DB tests, route tests, component tests (RTL + axe) pass; full suite on CI.

## 3. Decisions taken in this step (reversible, no product change)

- **One session per display.** A newer matched PIN replaces it (the indicator always names one person).
- **Fixed five minutes, not sliding.** Safer and matches "short-lived five-minute".
- **Seconds-left, not timestamps, to the tablet.** The display counts down `secondsLeft` from each board read, so a wrong tablet clock does not matter; the server keeps the real expiry and decides every action.
- **Session state rides on the board read.** The web server adds `ambientAfterSeconds` and `unlock` to the board from a service-role call (`display_session_state`) for the display named by its own session. `display_board()` is not redefined (keeps the diff small next to parallel UX branches). If the state cannot be read, the screen gets the default timing and no session: it then asks for PINs (safe side).
- **Ambient setting is per Home** (decision 36: "configurable for the Home"), in a new `private.home_display_settings` row, not in the per-display `display_configs`.
- **Ambient view content:** time and date only (no Home name, no lock message). A small position shift each minute, without animation, against static-image persistence; no claims about device brightness or sleep.
- **Existing 60-second idle reset kept** (clears a member selection and typed PIN); ambient is separate and longer.
- **Privacy/export:** `display_unlock_sessions` holds at most one short-lived row per display (deleted on expiry reads, Lock now, lock, revoke; stale rows purged after a day), like `display_checks`, so it is not exported. `home_display_settings` is Home configuration like `display_configs`, which is not in the export either. Both cascade on Home deletion; the session row also cascades on account and display deletion.

## 4. Implementation

- Migration `supabase/migrations/20261222090000_display_protected_sessions.sql`: tables `private.display_unlock_sessions`, `private.home_display_settings`; `display_actions.verification` allows `session`; helpers `display_unlocked_member`, `open_display_unlock`; triggers ending a session on lock and revoke; signal trigger on the Home setting; `home_display_settings` / `save_home_display_settings` (managers); service-role `display_session_state`, `display_end_unlock`, `display_lock_by_session`; `display_chore_attempt` (session stands in for a missing PIN) and `display_chore_verified` (matched PIN opens the session) redefined from their latest versions. Rollback notes in the migration header.
- Web: `displays/display-actions.ts` (session state, end, lock by session), `displays/board.ts` (adds state to the board), `displays/schema.ts` (ambient choices), `displays/server.ts` (manager read), routes `POST /api/v1/display/unlock/end`, `POST /api/v1/display/lock` with `pin: null`, `POST /api/v1/homes/{homeId}/displays/settings`; `display-screen.tsx` (indicator, countdown, Lock now, ambient), `display-lock-dialog.tsx` and `household-chores.tsx` (skip PIN in session, fall back to PIN when the server says the session is gone), `display-ambient-setting.tsx` on the Household Displays page; NL/EN messages; DB types regenerated.

## 5. Tests

- `tests/db/rls/display_protected_sessions.test.sql` (multi-actor): grants; no session → PIN asked; matched PIN opens a session (audited); session completes as `session`; no effect for other members, other displays, other Homes; does not make a Member a manager; expiry; changed PIN; Lock now (audited once); lock by session for a manager, refused for Carol/Erin; lock ends the session; locked display refuses actions and cannot be unlocked by a session call; remote lock ends it; former member; revoke; ambient setting permissions, validation, signal to the right Home only, audit, values per Home.
- Web: route tests (lock with/without PIN, pin-required, unlock/end CSRF/identity/revoked, settings route), board merge, schema, display screen (indicator + axe, countdown, Lock now + focus, auto relock, no PIN in session, PIN after server refusal, lock dialog in session, ambient entry ends session and hides data, touches keep the board).

## 6. Progress notes

- 2026-11-19: brief read, Opus chosen; migration drafted.
- 2026-11-24: rebased on main (no overlap in display files); migration + DB test pass on the local PostgreSQL fallback (display tests only); types regenerated; web code and tests done. Local: typecheck, lint, prettier, relevant vitest files pass (101 + 70 tests). Full suite left to CI per the testing rule.

## 7. Independent review

See `reviews/steps/UX8a-review.md` (one review; BLOCKER/HIGH fixes verified by the author).

## 8. PR

See section 7 and the PR link in the thread.
