# UX2c — Layout presets and 10-version history UI

Branch: `feat/ux-dashboard-presets-history` (from fresh `main` after UX2b #125 merged) · Model: Opus (restore
concurrency, permission-scoped history; project model-choice rule).
Sources: `docs/design/dashboard-ux-ui-redesign.md` Decisions 31 and 32; `plans/steps/UX00-redesign-plan-brief.md`
matrix rows 31/32, UX2c row, §7, decision note "template sharing and apply stay unchanged; presets add duplicate and
preview-then-confirm restore on top"; `plans/steps/UX2-data-brief.md` (history data, #114); `plans/steps/UX2b-brief.md`.

## Status

- 2026-11-25 08:26: brief drafted, waiting for UX2b.
- 2026-11-25 22:00: UX2b merged; built on fresh `main`.

## Scope correction (from the docs, no approved UX changed)

The first draft of this brief assumed a new presets table. UX00 maps Decision 31 onto the **existing S17
templates** (save, name, share into Homes, apply with Undo, 50 per person) and says "none (templates exist)" for
data. History data (`private.dashboard_layout_versions`, `list_dashboard_versions`, `restore_dashboard_version`)
already shipped in UX2-data. So **UX2c has no migration**: it adds the routes and the UI on top.

## Scope

1. **History (Decision 32)**: "Version history" in edit mode's layout panel opens a dialog with the last 10 committed
   versions, newest first: date and time, why (Saved / Undo / Restored an earlier version), on a Home "by you" or "by
   another editor" (never who), what changed against the version before (added / removed widgets, rearranged), a
   "no longer available" note for versions with dropped widgets, and a desktop/phone preview. Restore asks for
   confirmation (with preview, "stays in the history, undo once", unsaved-edits warning), commits as a new version,
   drops the edit draft, and the normal Undo then works once.
2. **Presets (Decision 31)**: template apply and Reset now show a desktop/phone preview of the arrangement in the
   confirmation; templates page has "Preview layout" per template and **Duplicate** (own) / **Save a copy** (shared
   with you) into a new private template under a free name ("X (copy)", "X (copy 2)"); saving or renaming a
   template refuses a name the person already uses (case-insensitive).
3. **API** (same-origin JSON, Zod, user-session Supabase, like the other dashboard routes):
   - `GET /api/v1/dashboard/history?homeId` → `{ versions }` (preview = widget id/type/hidden + places, never
     settings). 403 for a Member who may not edit, 404 for a foreign Home.
   - `POST /api/v1/dashboard/history/restore { target, versionId, expectedRevision }` → `{ revision }`; the version
     must be in that target's history (else 404), 409 with revision on conflict.
   - `POST /api/v1/dashboard-templates/:id/duplicate { name }` → `201 { id, dropped }`; 404 for an invisible
     template, 409 at the limit.
   - `GET /api/v1/dashboard-templates` also answers each template's `preview`.
4. en + nl strings; keyboard, focus and screen-reader paths (preview has an sr-only list in reading order; toggles
   use `aria-pressed` / `aria-expanded`).

Out of scope: My Home view / suggestions (UX2d), wall layouts (UX8), multiple switchable dashboards, any schema change.
Not touched: `mobile-nav.tsx`, `sidebar.tsx`, `docs/marketing-website-design.md`.

## Done-condition

History and presets usable in edit mode; restore never loses the replaced layout (new commit + Undo); outsiders,
forged Homes and plain Members refused; versions of one dashboard cannot be restored through another; previews never
carry widget settings; tests pass; one independent review in `reviews/steps/UX2c-review.md`; CI green.

## Defaults picked (reversible)

- Restore uses the revision the history showed as current (not the draft's base), so a stale draft never blocks it.
- Preview draws boxes with widget names only (no content), desktop (`lg`) and phone (`sm`).
- Copy names are numbered; the original name is shortened to keep 80 characters.
- Unique template names are checked in the UI only (per kind on the dashboard, all own templates on the templates
  page); the database still allows duplicates, so older data keeps working.

## Files

- New: `dashboard/preview.ts` (+ test), `dashboard/history-server.ts`, `app/api/v1/dashboard/history/route.ts`,
  `…/history/restore/route.ts` (+ shared test), `app/api/v1/dashboard-templates/[templateId]/duplicate/route.ts`,
  `components/dashboard/layout-preview.tsx`, `version-history.tsx` (+ test),
  `tests/e2e/specs/dashboard-presets-history.spec.ts`.
- Changed: `dashboard/{api,schema,view-types}.ts`, `dashboard-templates/route.ts` (+ test), `dashboard-editor.tsx`,
  `dashboard-board.tsx` (+ test), `layout-tools.tsx`, `template-manager.tsx` (+ test), `use-template-options.ts`,
  settings templates page, `en.json`, `nl.json`.

## Migration and rollback

No migration. Rollback = revert the PR; the history data keeps being written by the database either way.

## Local checks (Ward's testing rule)

- Prettier, ESLint (web + e2e spec), `tsc --noEmit` (web, e2e): clean.
- Vitest, dashboard components, dashboard lib, dashboard + templates routes, i18n: 16 files, 254 tests passed.
- E2E (new spec) and the full suite: CI.

## Review

(pending)
