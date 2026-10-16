# ADR 0021: Dashboard engine: versioned layouts, server-checked edits and templates split by target

- **Status:** Accepted for S17 within the approved architecture (§15 dashboard layout strategy B, §14, §9), CLAUDE.md (database access A, authorization C, frontend B, icons C, €0 budget) and the owner's decisions of 16 October 2026 on who edits a Home dashboard ("Owner + granted Administrators") and who shares and applies templates ("split by target").
- **Date:** 2026-10-16
- **Step:** S17 (brief: `plans/steps/S17-brief.md`). Builds on S12 (delegable Administrator capabilities) and S16 (trash).

## Context

Every adult has a personal dashboard with an editable starter layout, and every Home has one shared dashboard. Widgets are draggable and resizable in a dedicated edit mode, with a contextual side panel; normal use must never change the layout. People can save layouts as templates and share them into Homes. The modules that will provide most widgets (tasks, calendar, meals) arrive in later steps, so S17 ships the engine and only widgets backed by data that exists today: Welcome, Quick actions, Notifications and Home members.

## Decision

**One versioned layout per dashboard, stored as JSON and checked twice.** `private.dashboard_layouts` holds one row per person (personal) or per Home, with `layout jsonb`, a `revision`, `previous_layout` for one Undo, and who saved it when. Layout schema v1 (`apps/web/src/dashboard/layout.ts`): `{ version: 1, widgets: [{ id, type, hidden, config, source? }], placements: { lg, md, sm } }`, one placement per widget per breakpoint. The server checks every save against the widget registry (`widgets.ts`): known type allowed on that dashboard, unique ids, every widget placed once per breakpoint, inside the columns and 200 rows, within its type's size bounds, no overlaps, at most 40 widgets, settings valid for the type. The database checks shape, version and size (64 KB) again. Readers are lenient (`readLayout`): unknown types and broken settings are dropped or defaulted, and the page says so.

**No row means the starter layout.** A dashboard nobody saved reads as revision 0 and shows the starter layout from code; the first save inserts. A reset stores a copy of the starter, so a later change to the starter never alters anyone's saved dashboard.

**Breakpoints by the dashboard's own width.** `lg` ≥ 1024 px (12 columns), `md` ≥ 640 px (6), `sm` (1), rows of 88 px with 16 px gaps. Normal use is a server-rendered CSS grid with container queries, so nothing shifts on hydration and nothing can be dragged. Widgets follow the phone layout's order for keyboard and screen readers. Edit mode alone loads React Grid Layout (2.2.4, MIT) and edits the breakpoint that fits the current width; each breakpoint keeps its own arrangement.

**Edit mode.** A draft in local state until Save; Cancel and leaving the page (unload and in-app links) ask first when something changed. Every drag and resize has a keyboard and button equivalent (arrow keys move, Shift with arrows resizes, plus Move and Wider/Narrower/Taller/Shorter buttons), computed with React Grid Layout's own functions so both paths agree, and announced in a live region. Widget content is inert while arranging. The side panel holds the selected widget's settings, Hide/Show and Remove; the catalogue (with a source-Home selector on the personal dashboard); and templates, reset and Undo.

**Optimistic concurrency.** Saves carry the revision the draft started from. The database updates only when it matches (`save_dashboard`), so two people saving the same Home dashboard, or one person on two devices, never silently overwrite each other: the second gets 409 `conflict` and keeps their draft until they choose "Load the latest version". Two concurrent first saves resolve the same way (insert … on conflict do nothing).

**One-step Undo.** Reset and template apply keep the replaced layout in `previous_layout`; `undo_dashboard_change` swaps it back once. Ordinary saves clear it. This is not a history.

**Who may edit (owner decision).** Personal dashboards: their owner only. Home dashboards: every current member may view; the Owner, and Administrators the Owner granted the new delegable capability `manageHomeDashboard`, may edit, reset, undo and apply templates. Engine actions `home.dashboard.view` and `home.dashboard.edit`; SQL `private.can_edit_home_dashboard`. Every function re-checks the caller's current membership and right; the Customize button is only a convenience. A Home the caller is not in answers like one that does not exist.

**Selected Home widgets.** On the personal dashboard a Home widget is bound to one Home (`source.homeId`), which must be a current membership when saved, or already be in the saved layout. Its title always names the Home. When the person leaves that Home, the widget stays in the layout but renders a neutral "Widget unavailable" state, with neither the Home's name nor its data (the database refuses the data too), until they remove it.

**Templates, split by target (owner decision).** `private.dashboard_templates` (owner, kind `personal` | `home`, name ≤ 80, layout) are private until shared. Any member may share a personal-kind template into a Home they belong to, and any member of that Home may apply it to their own personal dashboard. Only someone who may edit a Home's dashboard may share a Home-kind template into it or apply one there. Shares end when the sharer leaves the Home (trigger on membership delete). A template is a copy: widget ids are regenerated on every apply, and Home-bound widgets are left out of templates (a template must not carry a Home the next person may not belong to), with the count reported. At most 50 templates per person. Deleting moves a template to the S16 personal trash (module `dashboard`, item type `dashboard_template`), restorable with its shares for 7 days. Shares, unshares and Home dashboard saves are audited without names or layouts.

## Consequences

- Each module step adds its widget types to `widgets.ts`, a body in `components/dashboard/widget-content.tsx` and its texts; the validator, catalogue and editor pick them up. New types need size bounds per breakpoint and a settings schema with defaults.
- A schema change to the layout needs `version: 2` and a reader that upgrades v1; the database accepts only known versions.
- Right-to-left layouts are not mirrored yet: edit mode positions from the left while CSS grid in an RTL document starts on the right. Only `en` and `nl` ship today; mirror placements when an RTL locale is approved.
- The migration must be applied to the hosted `madeora-preview` and `madeora-production` databases before code that uses it runs there (`docs/supabase-migrations.md`).
