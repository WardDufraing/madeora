# UX2b — Dashboard edit mode: drafts UI, gallery, size presets, smart reflow, mobile list editing

Branch: `feat/ux-dashboard-edit-mode` (from fresh `main` **after UX2a merges**) · Model: Opus (draft/revision
concurrency, conflict handling, permission-scoped drafts; project model-choice rule).
Sources: `docs/design/dashboard-ux-ui-redesign.md` Decisions 2–7, 25, 30 and "Highest-priority redesign: widget
customization" (L924–L962); `plans/steps/UX00-redesign-plan-brief.md` §3 rows 3/7, 4/5, 6, 25/30, §4, §7, §8;
`plans/steps/UX2-data-brief.md` (data layer this phase builds on); `plans/steps/UX-redesign-brief.md` (status).

## Status

- 2026-11-25: brief written. **Waiting for UX2a** (widget header / overflow menu) to merge into `main`; no branch or
  code until then.

## What already exists (no new migration expected)

UX2-data (#114, migration `20261219090000`) already ships: `get_dashboard` (+ `has_draft`),
`save_dashboard(..., p_commit_draft)` (atomic Done: commit + discard draft in one transaction, draft kept on
conflict), `get_dashboard_draft` (returns `base_revision` and `current_revision`), `save_dashboard_draft`
(autosave, one per person and target, adults only), `discard_dashboard_draft`, 30-day lazy purge, revocation
trigger, privacy export, RLS/RPC tests. UX2b adds **only the HTTP routes and the UI** on top. If a schema change
turns out to be needed, it gets its own migration, rollback note and multi-actor tests, and is flagged here first.

## Scope

1. **API** (same-origin JSON, Zod-validated, user-session Supabase client, as existing `/api/v1/dashboard`):
   - `GET /api/v1/dashboard/draft?target&homeId` → `{ draft: { layout, baseRevision, currentRevision, updatedAt,
expiresAt } | null }` (layout re-read through `readLayout`).
   - `PUT /api/v1/dashboard/draft` `{ target, homeId?, layout, baseRevision }` → `{ updatedAt }`.
   - `DELETE /api/v1/dashboard/draft` `{ target, homeId? }` → `{ outcome }`.
   - `PUT /api/v1/dashboard` gains optional `commitDraft: true` (Done). Existing callers unchanged.
   - Targets in UX2b: `personal` and Home `default` only. `mine` (My Home view) is UX2d.
2. **Edit mode shell** (Decisions 2, 6): explicit Edit dashboard entry; edit toolbar with Add widget, Undo, Redo,
   Reset layout (confirmed), Cancel, Done; draft status text Saving draft / Draft saved / Save failed / Unsaved
   changes (never "saved" before the server confirms); debounced autosave; `beforeunload` guard while a change is
   not persisted; on entering edit mode with a draft: Resume draft / Discard draft.
3. **Conflicts** (Decision 6 + UX00 §7 rebase-or-discard): if the draft's `baseRevision` ≠ `currentRevision`
   (someone committed since), the Resume prompt says so and offers **Keep my draft** (draft re-based on the current
   revision, then Done replaces the newer layout only by that explicit choice) or **Discard draft**. A `409` on Done
   keeps the draft and offers the same choice; never silent last-write-wins, never a false success.
4. **Gallery** (Decisions 3, 7): `widget-gallery.tsx` side panel on desktop, full-screen sheet on mobile; search;
   categories Today, Planning, Home, Personal, Lifestyle; Recommended (context, eligibility and permissions only;
   no tracking); Added state; ineligible widgets explained, never actionable; synthetic previews visibly labelled
   (reuse `widget-preview.tsx`); multiple instances only for types with meaningful independent configuration.
   **Add widget here** on empty grid slots in edit mode opens the same gallery scoped to that slot. New widget gets
   a visible highlight and focus.
5. **Size presets + snapped resize** (Decision 4): `presetsFor(type, breakpoint)` in `geometry.ts` derived from each
   type's min/max; preset picker in the widget overflow menu (edit mode) and in the list editor; drag resize snaps to
   grid cells (already RGL behaviour); keyboard size controls kept.
6. **Smart reflow with preview** (Decision 5): deterministic `placeWithReflow` in `geometry.ts` returning the new
   placements and the set of moved widgets; only widgets that collide move (pushed down, cascading); live preview
   of all affected widgets before drop for pointer, keyboard and touch; in-session undo/redo stack.
7. **Mobile** (Decisions 25, 30): edits on the `sm` breakpoint change only `sm` placements (never desktop); widget
   membership stays in sync across breakpoints; new widgets are appended to the mobile order; **list editing view**
   (move up/down, size selector, remove) on the same draft as the visual editor.
8. Strings in `en` and `nl`; focus returns to the trigger after every dialog/panel; reduced motion respected.

Out of scope: layout presets/templates UI and 10-version history (UX2c), My Home view and suggestions (UX2d), widget
header, overflow menu and empty-state modes themselves (UX2a; UX2b only adds edit-mode items to that menu), wall
display (UX8). Not editing `mobile-nav.tsx`, `sidebar.tsx`, `docs/marketing-website-design.md`.

## Done-condition

1. Edit mode never changes the committed dashboard until Done; Cancel restores the last committed layout and
   discards the draft; a refresh or closed tab mid-edit offers Resume / Discard.
2. Status text matches persistence truth; a failed autosave or failed Done keeps the draft and says so; a `409`
   (another device committed) never overwrites silently.
3. Gallery add (panel and Add widget here), size presets, snapped resize, keyboard move/size and the reflow preview
   all produce the same deterministic placements; only colliding widgets move; no overlaps (unit-tested).
4. Mobile edits leave desktop placements unchanged and vice versa; list and visual editing share one draft.
5. Draft routes refuse outsiders, forged Home ids, plain Members on the Home default, children and Household
   Display accounts (route tests over the existing DB guarantees); Personal and Home drafts never mix.
6. Existing saved layouts render unchanged in normal mode (layout stability tests); existing callers unaffected.
7. Keyboard / screen-reader / touch paths for every operation; NL and EN; axe clean on edit mode and gallery.

## Defaults picked (reversible; no approved UX changed)

- **Draft retention: 30 days after the last autosave** (set by UX2-data; shown here for Ward as UX00 §7 requires).
- Autosave debounce ~800 ms after the last change; status shows "Unsaved changes" until the server confirms.
- Drafts for adults only (UX2-data). For a child account the editor still works but without a recoverable draft;
  it shows "Unsaved changes" and the leave-page guard instead of claiming a saved draft.
- Toolbar uses **Done** (Decision 6) where the older handoff list says "Save".
- Size preset names: Small, Medium, Large, Wide (only those a type's bounds allow); NL: Klein, Middel, Groot, Breed.
- Category and multi-instance flags added as code metadata in the widget registry (no data change).
- Mobile (`sm`, one column) always stacks without gaps.
- **Gap policy on desktop/tablet (Ward, 2026-11-25): keep gaps.** Only colliding widgets move; a gap the user leaves
  stays, shows Add widget here in edit mode and is empty space in normal mode. No automatic pull-up on Done.

## Ward's answers

- 2026-11-25, desktop gaps: **keep gaps** (no compaction on Done). Existing saved layouts are already compacted, so
  they render unchanged.

## Files

- API: `app/api/v1/dashboard/draft/route.ts` (+ test, new), `app/api/v1/dashboard/route.ts` (`commitDraft` on Done),
  `dashboard/{api,schema,route-helpers}.ts`.
- Geometry: `dashboard/geometry.ts` (reflow, keyboard moves, presets, empty slots; + new `geometry.test.ts`),
  `dashboard/layout.ts` (keep gaps on lg/md, add into a slot; `layout.test.ts`), `dashboard/widgets.ts` (categories,
  multi-instance).
- UI: `components/dashboard/dashboard-editor.tsx` (rewritten: toolbar, undo/redo, autosave, add-here, list view),
  new `use-draft-autosave.ts`, `widget-gallery.tsx`, `stack-editor.tsx`, `layout-tools.tsx` (moved out unchanged);
  `dashboard-board.tsx` (resume / conflict prompts, Done commits the draft); `dashboard-board.test.tsx`.
- i18n `en.json`, `nl.json`; e2e specs that add widgets now open the gallery first (10 specs).

## Consequence of keep gaps (for Ward)

On desktop and tablet a hidden widget now keeps its space in normal mode (it is empty space, as for any gap), where
before the widgets below closed up. The phone still stacks without gaps. Saved layouts are otherwise unchanged.

## Progress notes

- 2026-11-25: docs read (redesign doc D2–D7, D25, D30, handoff; UX00 §3/§4/§7/§8; UX2-data brief; drafts
  migration RPCs; current editor/geometry/API). Opus chosen.
- 2026-11-25: built on fresh main after UX2a merged. Local: format, lint, typecheck clean; dashboard, components,
  API and i18n suites pass (215 + 12 tests). E2E runs on CI. Branch `feat/ux-dashboard-edit-mode`.
