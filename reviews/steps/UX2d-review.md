# UX2d independent review: Home views and shared-default suggestions UI

Branch `feat/ux-home-dashboard-overrides` (one commit on `origin/main`). Reviewer: independent agent, read-only except this file.
Evidence: read the diff, the migration functions (`get_dashboard`, `save_dashboard`, `commit_dashboard`, `undo_dashboard_change`, `restore_dashboard_version`, `list_dashboard_versions`, `reset_dashboard_override`, `list_dashboard_suggestions`, `dismiss_dashboard_suggestions`, `dashboard_target`) and every dashboard route. Ran `vitest run src/components/dashboard src/dashboard src/app/api/v1/dashboard`: 18 files, 257 tests, all passed.

## Verdict: PASS

No BLOCKER or HIGH finding. Counts: BLOCKER 0, HIGH 0, MEDIUM 4, LOW 5. The MEDIUM items should be fixed or consciously accepted by the owner before merge; none is a security defect.

## Route-by-route target check (the specific ask)

Every route that takes a `DashboardTarget` was traced. None can silently act on a different dashboard.

| Route                                            | How the target reaches the DB                                                                                                                                                                                                                                                                                                                              | Wrong-dashboard risk |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `PUT /dashboard`                                 | `loadTarget` (mine to `p_target:'mine'`, default sends no `p_target`) then `persistLayout` via `targetArgs`; same target for the permission pre-check and the write                                                                                                                                                                                        | None                 |
| `POST /undo`                                     | `targetArgs`                                                                                                                                                                                                                                                                                                                                               | None                 |
| `POST /reset` (starter)                          | `loadTarget` canEdit check, then `persistLayout` with the same target                                                                                                                                                                                                                                                                                      | None                 |
| `POST /apply-template`                           | same as reset; template kind/Home sharing checked against `target`                                                                                                                                                                                                                                                                                         | None                 |
| `PUT/DELETE/GET /draft`                          | `targetArgs` / `targetFromParams`; DELETE has no pre-check but the DB resolves membership                                                                                                                                                                                                                                                                  | None                 |
| `GET /history`                                   | `listHistory` maps `view` to `p_target` mine/default                                                                                                                                                                                                                                                                                                       | None                 |
| `POST /history/restore`                          | The RPC takes only `p_version_id` and resolves the dashboard from the version. The route first requires the version to be in `listHistory(target)` and `canEdit` of `target`, so a request naming the shared default cannot restore the person's view and the reverse. A version of another member's view returns `not_found` in the DB (`user_id` check). | None                 |
| `DELETE /home-view`, `POST /suggestions/dismiss` | Fixed `'mine'` inside the DB functions, caller's own row only                                                                                                                                                                                                                                                                                              | None                 |

The omitted-field case is safe by construction: `targetArgs` sends `p_target` only for mine, and an absent `p_target` means the shared default. The shared default is always gated by `can_save_dashboard_target`, so a Member who forgets `view` gets 403 (tested).

Revision handling for a not-yet-existing view is correct: `loadDashboard` returns the shared layout at revision 0 with the person's own `can_edit`. `commit_dashboard` inserts with `on conflict do nothing` on revision 0 and returns `conflict` if a view exists. A stale `expectedRevision>0` after a reset in another tab gives `conflict` with revision 0. `p_previous` is sent only when `view==='mine' && expectedRevision===0` and is the layout the server loaded, which is the starter if the Home has no saved default (what the migration comment asks for).

## Findings

### MEDIUM

M1. Missing scope item: "voluntary review latest shared default path for placement/size changes" is not implemented (brief Scope, last Suggestions bullet) and is not listed under "Defaults picked" or as deferred. Members with a view can never pick up layout changes of the shared default except by returning to it and losing the view. Remediation: implement it, or record it explicitly as deferred in the brief and roadmap with owner acknowledgement. Also "pending ones discoverable in customization" is satisfied only by the banner staying; say so.

M2. Test gap for the routes the review focus names. `home-view-targets.test.ts` covers PUT save, draft GET and history GET with `view:"mine"`. There is no route test that undo, reset, apply-template, restore, draft PUT and draft DELETE send `p_target:'mine'` (or omit it for default), and none for the restore guard "version must be in the history of the named target". Those are exactly the paths where a regression would silently hit the wrong dashboard. Remediation: add table-driven tests (target x route, assert the RPC args and that restore refuses a version id that is not in the `list_dashboard_versions` result of the named view). Cheap: the mock harness already exists.

M3. Tests do not prove the "no cross-member leakage / revocation" claims beyond mocks, and there is no test of `loadDashboard` for mine-without-override (recursion into the default, `hasOverride:false`, `canEdit` from the view), `loadSuggestions` (unknown widget dropped, malformed row dropped) or `DashboardSection` composition. `suggestions.test.ts` covers only the pure `withSuggestions`. Remediation: add unit tests for `server.ts` branches with a mocked client, and a DB-level RLS/RPC test (or confirm the earlier migration tests already cover two-member isolation for these RPCs; I did not re-verify them). The brief also says E2E covers suggestion and reset flow; the e2e diff is 16 lines (member view step). Confirm in CI that suggestion banner, dismiss and reset are actually exercised.

M4. Silent view creation from widget settings (`dashboard-board.tsx:137-146`). A member looking at the shared default who changes a widget's settings outside edit mode creates a personal view (revision 0) with no confirmation and only the generic "saved" notice. This is permitted by the brief, but it is a one-way side effect that detaches the member from future shared-default updates, which is the key product consequence of decision 33/34. Remediation: show a clear notice ("This created your own Home view") or confirm first, and cover it with a component test asserting the notice.

### LOW

L1. `p_previous` is the server's current layout, not the layout the client displayed. If the shared default changes between render and first save, widgets added in that window are treated as seen and never suggested. The DB already adds the stored default's ids to `known_default_widget_ids` regardless of `p_previous`, so the client-sent value would not fully fix it; accept and document. (`api/v1/dashboard/route.ts:43`)

L2. `p_previous` on the first save is also stored as `previous_layout`, so `canUndo` becomes true and Undo returns the view to a copy of the old shared layout, while the view still exists. Not "undo to no view". Harmless, but surprising; consider a note in the UX or passing it only when Undo semantics are wanted.

L3. "Dismiss" on the banner dismisses all suggested widgets in one click with no confirmation, and it is final (`home-view-controls.tsx:210`). The label does not say it is permanent. Suggest "Dismiss" helper text or "Do not suggest again" wording on the banner button (the dialog already uses it).

L4. Choosing "Add to my dashboard" while an older draft of the view exists: the additions are only kept in `pendingEdit.initial` and are lost if the person resumes the draft (`dashboard-board.tsx:276-330`). The brief says "an existing draft is offered first", so this matches intent, but the dialog does not say the additions will not be included on Resume. Add a sentence or merge the additions on resume.

L5. Input parsing inconsistency: body `view:"default"` is accepted, query `view=default` returns 400; `history` rejects unknown params but `draft` GET ignores them. Cosmetic.

## Explicit checks

- Requirements: done-condition (1) met (default visible without a view; suggestions only for members with a view; dismiss is per view). (2) met in code, with the test caveats in M3. (3) met: label `HomeViewLabel`, editing banner names the target, shared edits require `can_edit` from the DB, return flow previews and confirms and states what is lost. (4) mostly met; see M2, M3. Missing item: M1.
- Cross-Home isolation: all new endpoints use the person's own session and DB functions that call `dashboard_target` (42501 for non-members, mapped to 404). The Home id for suggestions comes from the page scope. No cache problem: `loadDashboard` uses request-scoped `cache` keyed on `(kind, homeId, view)`; JSON responses are no-store. No service-role client was introduced.
- Permissions: the view never widens access (`can_customize_dashboard` excludes children and displays; widgets are rendered by `renderWidgets` with the viewer's scope). `canEditShared` and `canHaveView` come from the DB `can_edit`, so a revoked Administrator loses the shared-edit button on next render; the server enforces it regardless. Suggestions name only widget types; they are not filtered per permission (registry has no per-type permission, documented). The shared layout and preview are sent to client for a member with a view; the shared default is readable by all members, and widget config is display settings only (LOW risk, worth a one-line confirmation that no widget config can hold member-restricted data).
- Secrets: none added. Input validation: new routes use strict Zod (uuid homeId, 1 to 40 uuid widget ids, strict objects), size-bounded body, same-origin CSRF check via `readDashboardMutation`; tests cover cross-origin, malformed, oversized, 401, 404.
- Migration safety: no migration added; only existing RPCs used with p_target values the migration defines. Rollback = revert.
- Accessibility: banner is a labelled `section`, dialogs use the shared `Dialog` with a close label, checkboxes are in a `fieldset` with a screen-reader legend, hooks run before the early return. Axe test runs only on the label/Customize state (`home-views.test.tsx:214`); the suggestions banner, review dialog, return dialog and editing alert are not axe-checked (gap, MEDIUM-adjacent; add them).
- i18n: `DashboardHomeViews` exists in both `en.json` and `nl.json` with identical keys (33 each) and ICU plurals; no hard-coded user-facing strings found in the new components.
- Performance: Home page does `get_dashboard` x2 (default, mine; the nested default call is deduplicated by `cache`) plus one suggestions RPC for members with a view. Acceptable.
- Maintainability: `target-args.ts` centralizes target to RPC arguments and is unit tested; `dashboard-board.tsx` grows by about 300 lines of session/target state (`EditSource`, `pendingEdit`, `settingsOrigin`); consider extracting a hook later. Regression check: Owner/Administrator editing the shared default is unchanged (Customize edits what is on screen, no `p_target` for default, existing e2e specs retained).

## Remaining risks and test gaps

- No automated proof (beyond mocks) that a member's view and suggestions are invisible to other members, or that revoking a member or changing a role hides things on the next render; rely on the earlier migration tests and CI e2e.
- Race behavior in L1, L2, L4 untested.
- Editing the shared default while the person's own view is on screen renders the editor with synthetic previews (documented); not tested here.
- Voluntary "review latest shared default" path absent (M1).

## Author response (after the single review round)

M1: deferred and recorded in `plans/steps/UX2d-brief.md` (needs a UX decision). M2: added table-driven route tests (`home-view-targets.test.ts`).
M3: added `dashboard/server.test.ts` and axe checks of the review dialog, return dialog and editing banner; DB-level isolation for these RPCs stays covered by
the UX2-data RLS tests, and the member-view e2e step runs in CI. M4: a notice now says the view was created (component test). L3: banner button reads "Do not suggest again".
L1, L2, L4: accepted and documented in the brief. L5: cosmetic, left.
