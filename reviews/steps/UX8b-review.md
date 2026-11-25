# UX8b independent review: wall-display navigation and ambient content

Branch: `feat/wall-display-navigation-ambient` (diff against `origin/main`, 21 files, +1136/-116).
Reviewer: independent agent, fresh context. Scope read: CLAUDE.md, redesign decisions 35-39,
UX8a brief, UX8b brief sections 1-3, the full diff, and the context files named in the request.
The product specification was not read.

## Verdict: PASS

No BLOCKER or HIGH findings. Five LOW findings, none of which blocks PR readiness.

Checks I ran myself:

- `pnpm exec vitest run src/components/displays src/displays src/app/api/v1/homes/[homeId]/displays`:
  10 files, 101 tests, all pass.
- `pnpm exec tsc --noEmit -p .` (apps/web): clean.
- `eslint` on the touched web folders: clean.
- `prettier --check` on all changed non-SQL files: clean.
- I did not run the database suite. The new SQL test is reviewed by reading only.

## Findings

### BLOCKER

None.

### HIGH

None.

### MEDIUM

None.

### LOW

**L1. An open menu can come back on its own after the offline-stale screen.**
`apps/web/src/components/displays/display-screen.tsx:104` (`menuOpen` state) and `:262-270` (stale timer).

- Impact: going stale (after `OFFLINE_KEEP_MS`, 10 min offline) swaps to the offline branch, which does
  not render `DisplayMenu`. Nothing sets `menuOpen` to false on that path. If the menu was open when
  the screen went stale, it opens again by itself when the connection returns. Its opener is then
  `body`, so focus does not go back to the Menu control. This is unlikely in practice, because the
  60-second idle reset normally closes the menu first. `lockOpen` already behaved the same way
  before this change.
- Remediation: in the stale effect, call `setMenuOpen(false)` (and `setLockOpen(false)`) when
  `setStale(true)` fires. Add a component test for stale, then reconnect.

**L2. The ambient chores count stops at the board's 50-chore cap.**
`display-screen.tsx:398` (`board.chores.length`), with `display_board()` `limit 50`
(`supabase/migrations/20261204090000_display_layouts_lock.sql:345`).

- Impact: a Home with more than 50 chores due today or overdue shows "50 open chores". The Chores view
  quietly shows only those 50, without its usual "+N more" line, because `count` is infinite.
  Shopping is not affected: `remaining` is a true count. The display's Ora line (S47c) has the same
  cap already.
- Remediation: accept it and document it, or have `display_board` return an `open_chores_total`
  count and use that for the ambient count. Both can wait for a later slice.

**L3. "This display is locked again." can be confused with the privacy lock.**
`apps/web/src/i18n/messages/en.json` `DisplayBoard.unlockEnded` (and the NL "Dit scherm is weer vergrendeld.").

- Impact: when a protected-actions session expires or Lock now is used, a screen-reader user hears
  that the display is "locked", but the dashboard stays visible and usable. On this display, "Lock"
  is the separate privacy lock (its own header button and locked screen). The privacy lock also
  triggers the same announcement, because `unlockedId` turns null then too.
- Remediation: use wording that names the session, for example "Protected actions need a PIN again."
  / "Beschermde acties vragen weer een PIN.". Optionally stay silent when the board itself becomes
  locked, because the locked screen already has its own heading.

**L4. The menu's Close button is 40 px, below the 48 px target used elsewhere on the display.**
`apps/web/src/components/ui/dialog.tsx:174` (`size-10`), used by `display-menu.tsx`.

- Impact: decision 38 asks for large touch targets on the wall. The brief's 48 px rule covers header
  controls, so this is a consistency gap, not a broken requirement. Escape and choosing a destination
  also close the menu.
- Remediation: add an optional larger close-button size to `Dialog` (for example `closeSize="large"`)
  and use it for the display menu.

**L5. The privacy note for the ambient counts is not tied to the checkboxes.**
`apps/web/src/components/displays/display-ambient-setting.tsx:86-88`.

- Impact: the note "Counts only, never titles or names. Anyone near a display can see them." is a
  `<p>` inside the fieldset, but not part of its accessible description. Screen readers may skip it
  when a user tabs straight to a checkbox, and it is the warning that matters for this privacy choice.
- Remediation: give the `<p>` an id and point the fieldset's `aria-describedby` at it (or each
  checkbox's, if `Checkbox` supports a description).

## Explicit checks

- **Requirements (done condition 1-7):**
  1. Met. The display opens with `view="dashboard"`. The Menu control sits in the board header only;
     the locked, offline-stale and ambient branches render no header.
  2. Met. The dialog lists Dashboard, Chores and Shopping (min-h-24 targets, `aria-current`), and
     choosing one opens it and closes the menu. Escape (the native `cancel`) and Close give focus back
     to the Menu control (Dialog `restoreFocus`). Tested.
  3. Met. The Chores view reuses the same `choresBody` / `HouseholdChores` path as the widget (same
     `requirePin`, `unlockedMembershipId`, actions and online gate). The Shopping view is read-only,
     with all lists (`listIds=[]`). The Dashboard button moves focus to the h1. Tested. Note that the
     Chores view offers actions whenever `board.actions` is true, which is what
     `display_actions_enabled` lets the server accept. It therefore matches server enforcement, even
     though it ignores a particular widget's `actions:false` when another chores widget leaves actions on.
  4. Met. `enterAmbient` closes the menu and sets `view="dashboard"`. Counts render only for the chosen
     flags. A locked board always carries `NO_AMBIENT_COUNTS`. With both flags off, nothing but the
     clock and the hint is shown. Tested, including checks that no title or name leaks.
  5. Met. `save_home_display_ambient` uses `display_manager_check(..., true)` (Owner, or Admin with
     manageHomeSettings; locks the Home row), takes only booleans with null rejected, writes an audit
     row with the choices, and bumps signals through the existing trigger on
     `private.home_display_settings`, which reaches only that Home's displays. The DB test checks the
     signal and isolation from Home B. The two-argument `save_home_display_settings` is unchanged and
     still works; the DB test checks that it keeps the flags.
  6. Met. `useAnnouncer` is a polite region in every branch. Session open and end are announced (see
     L3 for wording). NL and EN keys are present for all new strings, including `Nav.*`. The tests
     cover axe on the menu, the Chores view and the ambient view with counts.
  7. Met. The new DB test covers permissions, defaults, validation, audit, signal isolation, the
     state function, a revoked display and the old save. Unit and component tests cover the schema,
     route, board, settings form and screen.
- **Cross-Home isolation:** the flags are read per `v_display.home_id` in `display_session_state`
  (service_role only, no grant to authenticated; the DB test confirms a member is denied).
  Managers read and save through `display_manager_check`, so another Home's Owner gets
  `not_found` (tested). The signal reaches only the saved Home's displays (tested).
- **Permissions:** the route requires a session, a manager check, the same-origin (CSRF) check and
  a strict Zod body. The database checks again. The display's chore actions are unchanged: same
  RPCs, same PIN and session rules.
- **Secrets:** none added. The service-role use (`display_session_state`) is unchanged and on the
  allowlist in `auth/service-role.ts`. The `baseline.test.sql` service-role-only list still names
  the function by signature; the signature is unchanged.
- **Input validation:** `z.strictObject` with `z.boolean()` (no coercion; route tests send `1`
  and leave out fields). SQL rejects null and out-of-range values with `22023`. Responses from the
  state and settings functions use `.catch(false)`, so a malformed or missing flag counts as off.
- **Migration safety and rollout:** additive columns `not null default false` (fast in Postgres 11+,
  no rewrite). `home_display_settings` is `create or replace` with the same return type.
  `display_session_state` is dropped and recreated inside the migration transaction with the same
  grants. No SQL depends on it (plpgsql callers carry no dependency, and the only callers are web
  code and tests).
  - Old app, new database: it reads the extra columns and keys through non-strict `z.object`, so they
    are ignored. Its two-argument save still works and leaves the flags alone.
  - New app, old database: the flags fall back to off, but saving fails with 500 until the migration
    runs, so migrate first (as usual).
  - The rollback steps in the header are correct. Dropping the columns discards the managers' choices,
    which is acceptable.
- **Test coverage:** good for the slice. See the gaps below.
- **Accessibility:** the dialog has a name and description, a nav landmark, `aria-current`, focus
  return and heading focus, polite announcements, large targets (min-h-12 header controls, min-h-24
  menu items), an `aria-haspopup` Menu control, and axe passes in tests. See L3, L4 and L5.
- **Performance:** no new requests. The ambient counts are computed from the board already in memory.
  `Number.POSITIVE_INFINITY` used as `count` only feeds `slice` and `Math.min`, which is safe. The
  module views render at most 50 chores and 20 lists of 15 items (server caps).
- **Maintainability:** `choresBody` removes the duplicated chores rendering, and the view state
  is small and local. The doc comment in `settings/route.ts` (line 18) now runs past the usual line
  width; Prettier does not reflow comments, so this is cosmetic.

## Remaining risks and test gaps

- No component test that a board refresh that comes back locked closes the menu and resets the view,
  or that `DisplayLockDialog.onLocked` returns to the dashboard. The code paths exist (lines 134-138
  and 683).
- No test for leaving the offline-stale screen while the menu was open (L1).
- No test that picking "Dashboard" from the menu while on a module view focuses the h1. The
  "Back to the dashboard" button path is tested.
- The DB test does not cover the old two-argument save on a Home with no settings row (an insert
  that should default both flags to false). The column defaults make this low risk.
- The ambient-count cap at 50 chores (L2).
- The DB suite and E2E were not run by this reviewer; they rely on CI.
- Real-device checks that are not automated: the touch-target feel on a wall tablet, and how screen
  readers handle the live region when it remounts between the board, ambient and locked branches
  (the 60 ms delay in `useAnnouncer` should cover this).
