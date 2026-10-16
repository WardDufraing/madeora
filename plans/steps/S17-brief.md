# S17 · Dashboard engine — feature brief

**Branch:** `feat/dashboard-engine`, from `main` at `df85648` (S16 merged as PR #27).
**Sources:** build plan S17; MOD §4.1; PS L425–L443 (editable starter personal dashboard, selected Home widgets on the personal dashboard), L2418–L2421 (dashboard ownership), L2438–L2444 (customization: configurable widgets, personal templates shared into Homes, dedicated edit mode and contextual side panel), L2481 (journey 6) and journeys 1 and 5; ARCH §15 (React Grid Layout strategy B), §14, §9, §4.

**Done when:** the "New adult" journey passes (register, starter dashboard, customize, settings persist); layout edits respect permissions server-side.

## Owner decisions (Ward, 2026-10-16)

- **Home dashboard editors:** the Owner, and Administrators the Owner grants the new delegable capability **`manageHomeDashboard`** ("Manage Home dashboard"). Engine action `home.dashboard.edit`; SQL `private.has_home_capability(home, user, 'manageHomeDashboard')`.
- **Templates, split by target:** any member may share a _personal-dashboard_ template into a Home they belong to, and any member of that Home may apply it to their own personal dashboard. Only Home dashboard editors may share a _Home-dashboard_ template into that Home and apply it to that Home's dashboard.

## Actors and permissions

| Action                                                                   | Who                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| View/edit own personal dashboard, reset, undo, apply a personal template | the account holder only                                          |
| View a Home dashboard                                                    | every current member                                             |
| Edit, reset, undo, apply a template to a Home dashboard                  | Owner; Administrator with `manageHomeDashboard`                  |
| Add a Home-sourced widget to the personal dashboard                      | a current member of that source Home                             |
| Create, rename, delete own templates                                     | the account holder (templates are private by default)            |
| Share a personal-kind template into a Home                               | template owner who is a current member of that Home              |
| Share a Home-kind template into a Home                                   | template owner who may edit that Home's dashboard                |
| Remove a share                                                           | template owner, or an editor of that Home's dashboard            |
| See templates shared into a Home                                         | current members of that Home, while the sharer is still a member |

A Home the person does not belong to answers exactly like one that does not exist.

## Design

1. **Widget registry** (`packages/domain/src/dashboard`, pure): widget types with the surfaces they may appear on (`personal`, `home`, `home-source` = a Home widget on the personal dashboard), default and min/max size per breakpoint, and a Zod config schema. S17 ships only widgets backed by real, existing data (no fabricated content):
   - `welcome` — greeting and today's date (personal: account timezone; Home: Home name and Home timezone). Config: show date.
   - `quick-actions` — links the viewer may use: personal (Create a Home, Join a Home, Notifications, Settings, Trash); Home (Members, Invite people when allowed, Home settings, Home trash).
   - `notifications` — the newest personal notifications. Config: how many (3, 5, 10).
   - `home-members` — a Home's member directory (effective name, colour, optional role). Config: show roles. Home dashboard, or personal dashboard bound to one selected Home.
     Module steps add their own widgets (tasks S18, calendar S32 …) and may add them to the starter layouts.
2. **Layout schema v1** (Zod, shared): `{ version: 1, widgets: [{ id (uuid), type, hidden, config, source?: { homeId } }], placements: { lg, md, sm: [{ id, x, y, w, h }] } }`. Breakpoints by container width: `lg` ≥ 1024 px, 12 columns; `md` ≥ 640 px, 6 columns; `sm`, 1 column. Server validation: known type allowed on that surface, unique ids, every widget placed once in every breakpoint, inside the columns, sizes within the type's bounds, no overlaps, at most 40 widgets, at most 200 rows, config valid for its type. Home dashboards never carry `source`. A personal widget's `source.homeId` must be a current membership, or already present in the saved layout (so an unavailable widget can stay until removed).
3. **Starter layouts** are code constants (`starterVersion`). A person or Home without a saved row sees the current starter; the first save stores a concrete copy, so later starter changes never overwrite a customized dashboard. Personal starter: welcome, quick actions, notifications (no Home widgets). Home starter: welcome, home members, quick actions. Nothing is ever added automatically when joining or leaving a Home.
4. **Database** (one migration, private tables, public security-definer functions, same style as S12–S16):
   - Capability `manageHomeDashboard` added to `private.is_delegable_capability`.
   - `private.dashboard_layouts` (personal owner or Home owner, `layout jsonb`, `revision`, `previous_layout` for one-step Undo of reset / template apply, `updated_by`, `updated_at`; size and shape checks).
   - `public.get_dashboard(p_home_id)`; `public.save_dashboard(p_home_id, p_layout, p_expected_revision, p_previous)` with optimistic concurrency (`saved` / `conflict` / `not_permitted`), row lock, audit for Home dashboards; `public.undo_dashboard_change(p_home_id, p_expected_revision)`.
   - `private.dashboard_templates` (owner, kind `personal`|`home`, name ≤ 80, layout, `deleted_at`) and `private.dashboard_template_shares` (template, Home, shared_by). Functions: `list_dashboard_templates`, `create_dashboard_template`, `rename_dashboard_template`, `share_dashboard_template`, `unshare_dashboard_template`, `delete_dashboard_template` (moves it to the S16 personal trash: module `dashboard`, item type `dashboard_template`, restorable for 7 days, then purged). Max 50 templates per person. Shares end when the sharer leaves the Home. Shares and unshares audited.
5. **API** (`/api/v1/dashboard…`, same CSRF / JSON / size checks as earlier routes, user-session Supabase client so RLS applies):
   - `PUT /api/v1/dashboard` `{ target, layout, expectedRevision }`; `POST /api/v1/dashboard/reset`, `/undo`, `/apply-template` `{ target, expectedRevision, templateId | builtInId }`. 409 `conflict` when someone else saved first.
   - `GET/POST /api/v1/dashboard-templates`, `PATCH/DELETE /api/v1/dashboard-templates/[id]`, `PUT/DELETE /api/v1/dashboard-templates/[id]/shares/[homeId]`.
6. **Interface:**
   - Normal use renders a server-side CSS grid (container queries, no React Grid Layout, nothing draggable), so normal use cannot trigger layout edits and there is no layout shift. Each widget's data is loaded on the server with the viewer's session and fails on its own (a failed widget shows an error state; the rest still render).
   - **Edit mode** (Customize button; Home only for editors) is a client component with React Grid Layout (2.2.4, MIT) wrapped in Madeora components and Tailwind styles: drag handle, resize handle, and a **contextual side panel** with the selected widget's settings, Hide/Show, Remove, and keyboard buttons Move up/down/left/right and Wider/Narrower/Taller/Shorter, each announced in a live region. Draft state is local React state; Save / Cancel; leaving with unsaved changes asks first. Add widgets catalogue in the side panel: descriptions, source-Home selector for Home widgets on the personal dashboard (with explanation when the person has no Homes), preview before adding. Reset to starter with an impact preview, and Undo after reset or template apply. Templates tab: save the current dashboard as a template, apply built-in, own or shared templates (with a preview of which widgets it contains and a confirmation).
   - Home-sourced widgets on the personal dashboard always show their source Home's current name (also in accessible labels and on narrow screens). Lost membership: a neutral "This widget is no longer available" with Remove, no content and no Home name.
   - `/settings/dashboard-templates`: rename, share (checkbox per Home, only eligible Homes enabled), stop sharing, delete to trash.
   - Owner's capability editor lists the new right. nl and en.

## Tests

- **Unit:** layout schema and validator (bounds, overlaps, unknown types, surfaces, config, limits, source rules), starter layouts are valid, keyboard move/resize helpers, engine action and the capability matrix, API routes (CSRF, unauthenticated, invalid, conflict, not found, mapping), components with axe (view grid, edit mode, side panel, catalogue, templates page).
- **Database:** tables unreachable; personal isolation; Home view by members only; Home save by Owner and granted Administrator only (revoked grant, plain Member, ex-member refused); forged Home id; optimistic concurrency conflict; undo; size/shape checks; templates private by default; share rules split by kind; share ends when sharer leaves; viewer outside the Home sees nothing; delete to trash, restore and purge; per-person template limit.
- **Playwright:** "New adult" journey (register, starter dashboard with truthful empty states, customize: remove, add, move and resize by keyboard, hide, save, reload, persists; remove all; reset with Undo); Home dashboard edited by Owner, Member sees no Customize and a forged save is refused; Administrator gains the right; selected Home widget on the personal dashboard labelled with its Home, survives switching Home, becomes unavailable after leaving; template shared into a Home and applied by another member, Home-kind template not appliable by a plain Member; axe and keyboard in both themes.

## Out of scope

Module widgets (S18+), Household Display layouts (S43/S44), Ora suggestions (S45+), contextual highlights beyond empty states (they need module data), offline queueing of layout edits (a failed save keeps the draft and says so).

## Defaults picked (owner may override)

- Breakpoints and columns as above; row height 88 px.
- Limits: 40 widgets per dashboard, 50 templates per person, layout ≤ 64 KB.
- One-step Undo (reset and template apply), not a full history.
- Repeated widget types allowed (e.g. two member widgets from two Homes).
- Built-in templates are the two starter layouts.
