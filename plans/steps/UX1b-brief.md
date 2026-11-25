# UX1b — App shell and navigation

Branch: `feat/redesign-app-shell-navigation`. Model: Sonnet (UI and a device preference only; no RLS, auth or data).
Source: `plans/steps/UX00-redesign-plan-brief.md` §3A row "10, 11, 41, 42" and "26–29", `docs/design/dashboard-ux-ui-redesign.md` Decisions 10, 26, 27, 29, 41.

## Done condition

Desktop: a floating, softly raised sidebar with Dashboard / Calendar / Tasks prominent, pinned shortcuts, an All modules destination, Settings and Help apart, collapsible. Small screens: a bottom bar (Dashboard, Calendar, central Create, Tasks, More) that hides on scroll down and returns on scroll up, with a quick-create menu and the full menu behind More. All existing destinations stay reachable; no routing, permission or data change.

## Scope delivered

- **Icons:** `ModulesIcon`, `PinIcon` (custom SVG).
- **Shortcuts:** device cookie `md-favorites` (allow-listed ids, cap 8, "-" = pinned nothing). Until the person pins something, defaults apply: Home = Chores, Meals, Shopping; Personal = Shopping, Habits, Goals. `FavoritesProvider` shares the list between sidebar, menu and All modules.
- **Sidebar:** raised rounded surface inside the shell, three core items, "Shortcuts" group, All modules link, Settings and Help. Collapsed state and tooltips unchanged.
- **All modules:** `/modules` and `/homes/{id}/modules` (same membership check as other Home pages), searchable, pin/unpin toggles (`aria-pressed`, announced), links follow the open context.
- **Mobile:** bottom bar with scroll-aware hide (`nextScrollState`, pure and tested: top zone 24 px, hide after 32 px down past 96 px, show after 12 px up), always shown when a menu is open or focus is inside. More opens the existing full menu (every destination). Central Create opens a bottom-sheet menu: New task, New event, Add a shopping item. The top-bar hamburger is gone (More replaces it); the workspace switcher stays in the top bar (D28).
- NL and EN strings; e2e specs updated and extended (`tests/e2e/specs/shell.spec.ts`).

## Decisions taken (reversible, no approved UX changed)

- Shortcuts are a **device cookie**, not an account setting: no migration, no privacy surface, same pattern as the sidebar state. Per-account sync is possible later. One list for Personal and Homes (open item in D10: "per-context persistence").
- The bottom bar has the fixed five slots; pinned shortcuts live in the More menu and All modules, not the bar (D26 says "bounded number"). Ward can overrule.
- Create entries open the **existing creation pages** (`/calendar/new`, the Tasks and Shopping pages) because the compact creation dialogs arrive with UX3b / UX4b / UX6. No capability check is shown yet; the destination pages enforce permissions as before.
- The More menu still lists all 13 destinations flat (it is the mobile All modules).

## Not in this phase (UX1c)

Workspace selector inside the desktop sidebar (D11/D41; still in the top bar), editorial hero header, Ora launcher, adaptive canvas width (D42).

## Local checks

Prettier, eslint (shell, preferences, i18n, new routes, e2e spec), `tsc` for web and e2e; vitest: shell, preferences, i18n, token-only and RTL guards (235 pass). E2E not run locally (no Supabase here); CI runs it.

## Rollback

Frontend only. Revert the PR; the leftover `md-favorites` cookie is ignored.
