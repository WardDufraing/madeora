# UX2d — Home views and shared-default suggestions UI

Planned branch: `feat/ux-home-dashboard-overrides` · Model verdict: see Progress notes · UI on the UX2-data API (ADR 0059).
Sources: `docs/design/dashboard-ux-ui-redesign.md` Decisions 33 and 34, `plans/steps/UX00-redesign-plan-brief.md` (matrix B rows 33/34, section 7),
`plans/steps/UX2-data-brief.md` (data, defaults, suggestion rules).

## Dependency (blocking)

UX2c (presets and history UI, which builds on UX2b edit mode) must be merged into `main` first. Status 2026-11-25: not merged
(main has UX1b and UX2-data only). Until then: brief only, no branch, no code. After the merge: branch from fresh `main`.

## Scope (no new UX decisions)

- Editor/target label: clearly shows **My Home view** vs **Shared Home default**; shared default editable only with `manageHomeDashboard`
  (Owner included); accidental shared edits guarded (explicit target switch, confirmation).
- Home dashboard reads the effective layout (member view if any, else shared default), filtered to widgets/data the member may use.
- Personal Home view creation on first edit; first `mine` save passes the layout that was shown as `p_previous` (UX2-data requirement).
- **Return to shared default / reset my view**: preview + confirmation of what is lost (Decision 33); reset deletes view, history, draft.
- **Suggestions**: subtle dismissible banner when the shared default added widgets; names the additions, preview, **Add to my dashboard**
  (selective, placed through the UX2b reflow/draft flow), dismiss; dismissed ones not repeated; pending ones discoverable in customization.
  Types the member cannot use are filtered out. Voluntary "review latest shared default" path for placement/size changes (never auto-merged).
- Permission/membership changes take effect immediately; restricted widgets hidden without leaking data; Personal context never shows Home views.
- Mobile and desktop breakpoints; light/dark; NL/EN strings; keyboard and screen-reader support (banner is polite live region, not focus-stealing).
- API routes for the UX2-data RPCs not yet added by UX2b/UX2c (views get/save/reset, suggestions list/dismiss), with Zod validation, CSRF, no caching of personalized data.
- Adults only for Home views (children and Household Display accounts excluded), as in UX2-data.

Out of scope: wall-display layout (UX8), changes to `mobile-nav.tsx`, `sidebar.tsx`, `docs/marketing-website-design.md`, any migration unless a gap is found (then ask).

## Done-condition

1. Members without a view see shared-default updates automatically; members with a view keep theirs and get a dismissible suggestion for new widgets.
2. A view never widens access; revocation hides widgets immediately; no cross-Home or cross-member leakage in UI, API or cache.
3. Editing target is always labelled; shared edits need permission; reset/return preview + confirm works.
4. Tests: policy/unit, component (banner, label, reset dialog, selective add), API route auth/forged Home/CSRF, axe; E2E for suggestion and reset flow.

## Merge-conflict notes

`en.json`, `nl.json`, `tests/e2e/support/screens.ts` conflict with parallel phases: merge `main` before the final push.

## Defaults picked (reversible, no approved UX changed)

- **Customize edits what is on screen**: the shared default for someone who may edit it, else My Home view. The other dashboard has its own
  labelled button ("Create my own view" / "Edit shared default"), so the shared default is never edited by an unclear choice and the existing
  Owner/Administrator flows (and their e2e specs) are unchanged. An editing banner always names which dashboard is open.
- Widget settings outside edit mode save to the dashboard on screen when the person may edit it; a member looking at the shared default who
  may not edit it starts their own view from it (revision 0), never changing the shared default.
- The home target gets an optional `view: "default" | "mine"` (none = shared default, as before). Only "mine" sends `p_target`; GET routes take `&view=mine`.
- The first save of a new view passes the shared layout that was on screen as `p_previous` (server-side, from the loaded dashboard), as UX2-data requires.
- "Return to shared default" = `reset_dashboard_override` behind `DELETE /api/v1/dashboard/home-view`, with a preview of the shared default and a
  loss warning (view, its versions, its draft). Dismiss = `POST /api/v1/dashboard/suggestions/dismiss` (max 40 ids).
- Suggestions: banner with Review (selective checkboxes, preview of the resulting arrangement) and Dismiss. Adding opens edit mode on My Home view
  with the widgets (their shared ids kept) at the bottom of every screen size, so it can be cancelled; an existing draft is offered first.
  "Pending shared additions discoverable": the banner stays until added or dismissed; dismissed ones are final (the data layer only grows the known set).
- Widget types a member "cannot use" (review L6): the registry has no per-type permission, so filtering is by dashboard surface (`readLayout`);
  widget content already renders restricted states itself, and a suggestion names only the type.
- Editing the dashboard that is not on screen renders its widgets with the editor's synthetic previews (their content is not loaded).
- Adults only for views (children and Household Display accounts get `canHaveView: false`, as the database decides).
- No migration, no new table: the UX2-data RPCs are enough.

## Files

- New: `dashboard/target-args.ts`, `dashboard/suggestions.ts`, `components/dashboard/home-view-controls.tsx`,
  `app/api/v1/dashboard/home-view/route.ts`, `app/api/v1/dashboard/suggestions/dismiss/route.ts`.
- Changed: `dashboard/{schema,server,api,route-helpers,history-server,view-types}.ts`, dashboard `route`/`draft`/`history`/`undo` routes,
  `dashboard-board.tsx`, `dashboard-section.tsx`, `i18n/messages/{en,nl}.json` (new `DashboardHomeViews` namespace), `tests/e2e/specs/dashboard.spec.ts`.
- Tests: `home-views.test.tsx`, `target-args.test.ts`, `suggestions.test.ts`, `home-view/route.test.ts`, `home-view-targets.test.ts`, e2e member view step.

## Migration and rollback

None. Rollback = revert the PR; stored views and dismissals stay in the database and are ignored by the old UI.

## Progress notes

- 2026-11-25: brief written from docs; waiting for UX2c merge. Model: kept Sonnet (the coordinator and Ward did not ask for Opus in their own words; `switch_model` is for Ward's own request).
- 2026-11-26: UX2c merged (#126); branch `feat/ux-home-dashboard-overrides` from fresh main; UI, routes and tests built.

## Local checks (Ward's testing rule: only relevant tests)

- Typecheck `@madeora/web`: passed. ESLint on dashboard code and routes: passed. Prettier on changed files: passed.
- Vitest: dashboard components, `dashboard/`, dashboard API routes and `(app)` page: 19 files, 266 tests passed. Full suite and e2e: CI.
