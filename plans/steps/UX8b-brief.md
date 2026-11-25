# UX8b — Wall display UI: dashboard-first navigation and ambient content

Status: in progress. Branch `feat/wall-display-navigation-ambient`. Model: Opus (display privacy and session rules; switched per Ward's model-choice instruction).
Source: `docs/design/dashboard-ux-ui-redesign.md` decisions 35–38 (L459–L505), `plans/steps/UX00-redesign-plan-brief.md` (§3 D, §8 Ward's answers of 2026-11-19), `plans/steps/UX8a-brief.md` (backend this builds on), `plans/steps/UX-redesign-brief.md` (status).
Binding rules kept: S44 privacy lock (only a manager's own signed-in session unlocks; nothing on the display lifts it), the no-lockout rule (display tries never count toward a member's PIN lock), UX8a protected-action sessions (five minutes, never extended, server decides every action). `display_board()` keeps deciding what is shared-display-safe; this step adds no new household data to the board.

## 1. Scope

In:

- **Decision 38, dashboard-first navigation.** The display opens on its dashboard. A compact, always-visible **Menu** control in the header opens a spacious, touch-friendly menu (full-height dialog) with the destinations the display can show: **Dashboard**, **Chores**, **Shopping**. Each opens directly; a module view has an obvious **Dashboard** button to return. Active state is marked (`aria-current`). Destinations do not depend on the layout having a widget for them. The menu closes on ambient, on lock, and after the one-minute idle reset; entering ambient returns to the dashboard.
- **Module views on the display.** Chores: all open chores the board already carries, with member actions (same PIN and protected-session rules as the chores widget) when the display offers actions and is online, otherwise read-only. Shopping: all active Home lists the board already carries, read-only (as the widget). No new data, no new actions.
- **Decision 36, ambient content.** The ambient view becomes a calm at-a-glance screen: large time and date, plus **selected privacy-safe household information** only when a manager turns it on. Two Home settings, both **off by default**: "open chores count" and "shopping items left count". Counts only, never titles, names, assignees or list contents. Settings sit next to the ambient timing on the Household Displays page (same managers, audited, Realtime signal to that Home's displays only).
- **Decision 37 polish.** Screen-reader announcement when a protected-actions session opens or ends (UX8a accepted L6). Lock now and session indicator use large touch targets.
- **Large-target styling (decisions 35/38).** Header controls on the display are at least 48 px high.

Out (later slices, named so nothing is lost):

- Weather in ambient mode: waits for Ward's approval of a specific free provider (€0 rule).
- **D35 one wall layout per Home** (replacing per-display layouts; DB and editor change) and **D39 protected reassignment** (fresh manager auth, cache clearing): own slice **UX8c** (Opus).
- Other module destinations (Calendar, Tasks, Habits, …): the board carries no data for them and `display_board()` decides what is shared-display-safe; adding them needs product rules on what a wall may show. Not invented here.

## 2. Done condition

1. The display opens on its dashboard; a Menu control is always visible in the header (not while locked, offline-stale or ambient, which show no navigation).
2. The menu lists Dashboard, Chores and Shopping with large targets, marks the current one, opens it directly and closes; Escape and the close button close it and return focus to the Menu control.
3. Chores and Shopping views show the board's data; chores actions follow exactly the same PIN/session rules as the widget; a Dashboard button returns to the dashboard and moves focus to the page heading.
4. Ambient: menu closed, view back to dashboard on return; counts appear only for the settings a manager turned on; nothing else from the household is shown; with both off it shows only time and date.
5. Ambient content settings: Owner, or Administrator with manageHomeSettings; booleans only; audited; signal reaches only that Home's displays; other Homes unaffected; the old two-argument save keeps working (rollout safety).
6. Session open/end announced politely; NL and EN strings; axe clean on menu, module views and ambient.
7. DB test (settings permissions, defaults, audit, isolation, state function), web unit/component tests pass locally for the touched files; full suite on CI.

## 3. Decisions taken in this step (reversible, no product change)

- **Destinations = Dashboard, Chores, Shopping** (only what the board already carries).
- **Menu is a dialog**, not a sidebar (decision 38: no permanently expanded sidebar).
- **Module view kept through the 60-second idle reset**, reset to Dashboard on ambient (decision 36: "restore the dashboard").
- **Ambient items are counts, off by default**, two independent toggles. Counts are what Ora on the wall already says (S47c), so no new exposure class.
- **New RPC `save_home_display_ambient`** for all three ambient settings at once; the UX8a two-argument `save_home_display_settings` stays unchanged (an app still on the old version keeps working during rollout; it never touches the new columns).
- **`display_session_state` returns the two flags** (dropped and recreated: return type changes; same grants).

## 4. Implementation

- Migration `supabase/migrations/20261223090000_display_ambient_content.sql`.
- Web: `displays/schema.ts`, `displays/server.ts`, `displays/display-actions.ts`, `displays/board.ts`, `displays/api.ts`, settings route; `display-screen.tsx` (view state, header Menu, module views, ambient content, announcements); new `display-menu.tsx`; `display-ambient-setting.tsx` (two checkboxes); NL/EN messages; DB types.

## 5. Tests

- `tests/db/rls/display_ambient_content.test.sql`.
- Web: route test, schema, board merge, display screen (menu, views, ambient counts on/off, announcements, axe), ambient setting component.

## 6. Progress notes

- 2026-11-25: brief written; scope chosen as above.
- 2026-11-25: migration + DB test pass on the local PostgreSQL fallback (display tests only); DB types regenerated. Web: menu, Chores/Shopping views, ambient counts, settings checkboxes, session announcements. Local: tsc, eslint (touched folders), prettier, vitest for displays, display routes and i18n pass (131 + 40 tests). Full suite left to CI.
