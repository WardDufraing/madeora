# UX2b independent review — `feat/ux-dashboard-edit-mode` (a943481)

Reviewer: independent agent (fresh context; did not write this code). Date: 2026-11-25.
Scope: `git diff origin/main...feat/ux-dashboard-edit-mode` (32 files) against `plans/steps/UX2b-brief.md`
(scope, done-condition 1–7, defaults, Ward's "keep gaps"), redesign doc D2–D7/D25/D30, UX00, UX2-data brief and
migration `20261219090000_dashboard_drafts_history.sql`.

Local runs: `vitest run src/dashboard src/components/dashboard src/app/api/v1/dashboard src/i18n` → 13 files,
215 tests passed. `tsc --noEmit -p .` → clean. E2E not run (no DB); judged by reading.

## Verdict: CHANGES_REQUIRED

One HIGH finding: it needs the owner to confirm it or the code to change. The rest of the work is solid. The API
is thin and correct over the RPCs, the autosave serialises its requests, and Done commits through the atomic
`p_commit_draft`.

## Findings

### HIGH

**H1. Existing saved layouts no longer render unchanged on desktop/tablet (done-condition 6).**
`apps/web/src/dashboard/layout.ts:283-287` (`visiblePlacements`), `layout.ts:219-223` (`readLayout` → `settle`),
rendered by `components/dashboard/dashboard-grid.tsx:35-66` (explicit CSS grid rows, `auto-rows-[88px]`).
Impact: before, normal mode compacted the visible widgets. Now a widget **hidden** with the existing Hide action
leaves an empty band on `lg`/`md`. So does a widget that `readLayout` **drops** (unknown type, wrong surface, a Home
the person left). Any user who hid a widget before UX2b sees their saved dashboard change without editing it. Ward's
recorded answer rests on "existing saved layouts are already compacted, so they render unchanged". That holds only
for layouts with no hidden or dropped widgets. The brief's "Consequence of keep gaps (for Ward)" names the
hidden-widget effect, but no answer from Ward is recorded, and done-condition 6 is not met as written. The changed
test `layout.test.ts` ("desktop keeps the space") locks in the new behaviour.
Remediation: either (a) get Ward's explicit confirmation of the hidden/dropped-widget consequence and record it in
the brief's "Ward's answers" (and reword done-condition 6), or (b) keep gaps only for space the user left in edit
mode. For (b), normal-mode `visiblePlacements` would close only the rows that hidden or dropped widgets free (or
compact as before for them). Add a stability test with a hidden widget on `lg`.

### MEDIUM

**M1. A failed draft check silently overwrites a stored draft.** `dashboard-board.tsx:179-186`. When
`fetchDraft` fails for a transient reason, edit mode opens from the committed layout. The first autosave then
upserts (`save_dashboard_draft` … `on conflict do update`) and replaces an unfinished draft the person could
have resumed. The info alert says "You can still edit" and does not warn that a stored draft may be replaced.
Fix: in that state, hold autosave (status `local`-like) until a re-check succeeds, or retry the check before the
first autosave.

**M2. Edits made while autosave is stopped are not tracked.** `use-draft-autosave.ts:129` returns before
`changed.current = true` while `stopped`. `stop()` runs during Done, reset, apply and keep-mine, and the grid and
keyboard stay interactive while the save is pending. If Done then fails (500/409), `resume()` (`:159-162`) sends
nothing. The status can read "Draft saved" while the screen differs from the server draft (done-condition 2,
"status matches persistence truth"), and leaving the page is not guarded. Fix: mark `changed` (and status
`unsaved`) even while stopped, and send on `resume()`. Or lock editing while `pending`. Add a test.

**M3. Double-activating Done can show a false conflict.** `dashboard-editor.tsx:511-521, 686-695`. `pending` turns
true only after `await autosave.stop()`. While an autosave is in flight, a second click or Enter starts a second
`save` with the same `expectedRevision`. The first commits, and the second answers 409. The board then shows
"saved elsewhere / Load latest" after a successful save. Fix: a local `committing` ref/state set synchronously at
the start of `done()`/`commitNow()`, which disables Done/Cancel/Reset.

**M4. No end-to-end coverage of the new draft flows.** The route tests (`draft/route.test.ts`) mock the RPC
layer. Done-condition 5 allows that ("over the existing DB guarantees", and the UX2-data RPC tests cover the multi-actor
cases). But no Playwright spec exercises autosave → reload → Resume/Discard, Done with `commitDraft`, or a 409 from
a second context. Ten specs were adapted only so that Add opens the gallery. Fix: add one e2e for
reload → Resume → Done, and one for a two-context conflict (Keep mine / Discard).

### LOW

- **L1.** Cancel, Discard after a conflict, and post-reset/apply discard are fire-and-forget
  (`dashboard-board.tsx` `onCancel`, `discardMine`, `onSuccess`). If the call fails, the draft survives silently and
  is offered again next time. That is recoverable, but it does not fully meet done-condition 1's "Cancel … discards
  the draft". A quick Cancel followed by Customize can also race the DELETE against the GET. Consider awaiting the
  discard before allowing Customize.
- **L2.** Navigation that does not go through `<a href>` (a `router.push` Home switcher) bypasses the leave guard
  (`dashboard-editor.tsx:253-273`). Unmount then clears the debounce timer without flushing
  (`use-draft-autosave.ts:142-147`), so the last change made under 800 ms before it is lost.
- **L3.** Brief deviations, all reasonable: the size-preset picker sits in the Selected panel and the list editor,
  not in the edit-mode overflow menu (scope 5). `DELETE /draft` returns `{ discarded }`, not `{ outcome }` (scope 1).
  On a stale draft, the Resume prompt keeps the label "Resume draft" plus an explanation, not a "Keep my draft"
  button (scope 3). Update the brief or align the code.
- **L4.** `keepMine(error.revision ?? 0)` (`dashboard-board.tsx`): a missing revision guarantees another 409.
  Keep-mine also depends on the child effect + `await` running before the parent's `useMutation` options update.
  It works (and is tested), but it is fragile. Passing `expectedRevision` inside the action would be more robust.
- **L5.** `sameLayout` uses `JSON.stringify` (key-order sensitive). It is fine while every layout comes from
  `readLayout` or the editor, but `dirty` could be a false positive for a draft whose JSON key order differs.
- **L6.** Two tabs editing the same dashboard overwrite each other's draft (last autosave wins). Drafts only, never
  the committed layout. Acceptable for MVP; worth a note in the brief.

## Explicit checks

- **Requirements:** scope 1–8 implemented: API, toolbar with Undo/Redo/Reset/Cancel/Done and status, debounced
  autosave, Resume/Discard with a stale-base warning, keep-or-discard on 409, a gallery with search, categories,
  Recommended, Added/ineligible reasons and labelled previews, Add here, presets, reflow, the phone list editor,
  en/nl. Done-condition 1–5 and 7 are met in code, with M2/M3 caveats on 2. **Done-condition 6 is not met (H1).**
- **Cross-Home isolation:** the target comes only from a uuid-validated `homeId`. Every RPC uses the user-session
  client. `dashboard_target` raises 42501 for non-members → 404 (tested). The draft is keyed by
  (user, home, target), so Personal and Home drafts cannot mix. The GET re-reads the layout with
  `readLayout(row.layout, target.kind)`, which drops personal widgets from Home drafts (tested). Pass.
- **Permissions:** `PUT /draft` requires `canEdit` from `get_dashboard` (a plain Member on the Home default → 403),
  then `checkLayout` (no Home a person is not in). The DB re-checks `can_customize_dashboard` (children/displays →
  `not_permitted` → 403 → UI `local`) and `can_save_dashboard_target`. DELETE only touches the caller's own row.
  Done → `save_dashboard(p_commit_draft)` deletes the draft only on `saved`. Pass.
- **CSRF / input validation:** mutations go through `readDashboardMutation` (same-origin check, auth, body size
  limit, `z.strictObject`); `baseRevision` is int ≥ 0; the layout is checked server-side. The GET only reads and is
  `no-store`. Pass.
- **Secrets:** none added; no service-role use. Pass.
- **Migration safety:** no migration, as expected; it uses the existing RPC signatures (optional
  `p_commit_draft`). Existing `PUT /dashboard` callers are unchanged (the flag is optional and sent only when true).
  Pass.
- **Data preservation:** the stored JSON format is unchanged. Rendering of layouts with hidden or dropped widgets
  changed (H1).
- **Race conditions:** a single in-flight autosave with a coalesced follow-up; `stop()` awaits the in-flight
  request before Done, Cancel or a commit, so no draft lands after a commit. StrictMode is safe: the start ref uses
  reference identity, the timer is cleared on unmount, and `doneRequest` is 0 on a fresh session key. Gaps:
  M2, M3, L1, L2.
- **Test coverage:** good unit coverage, including a randomised no-overlap reflow test, presets, slots, stack moves,
  route mapping for 401/400/403/404/CSRF/commitDraft, and board flows for autosave, failure, local, resume, stale
  resume, discard, 409 keep/discard, undo/redo, gallery and the list view. Gaps: M2/M3 untested, no e2e for drafts
  (M4), no stability test with hidden widgets (H1).
- **Accessibility:** a toolbar role, a polite live region with the repeat trick, named "Add widget here" buttons,
  `aria-pressed` on category/view/preset toggles, focus moves to the new widget or to Add after a remove, the
  gallery is a dialog (side panel) with focus return, and axe runs on edit mode, the gallery and the menu.
  Keyboard move/size is kept and the list view works for touch. Pass. Manual screen-reader check still advised.
- **i18n:** en/nl key sets identical (checked by script); dates use `useFormatter`. Pass.
- **Performance:** `emptySlots` is O(rows × cols × widgets) per render; fine at MAX_ROWS 200 and small widget
  counts. `reflow` runs on every drag frame from a fixed base, which is acceptable. `JSON.stringify` diff on every
  render is minor.
- **Maintainability:** the editor is 1,100 lines, but `layout-tools`, `stack-editor`, `widget-gallery` and
  `use-draft-autosave` are split out. Comments are clear. The keep-mine effect chaining is fragile (L4).

## Remaining risks and test gaps

- Owner decision needed on H1 (hidden and dropped widgets leave holes in normal desktop view).
- No real-DB end-to-end check of the route → RPC → UI draft chain or of the two-device conflict (M4). CI e2e results
  for the ten adapted specs are still unknown. `dashboard.spec.ts` hides "Quick actions"; if it later asserts
  normal-mode positions, keep-gaps may affect it.
- Manual checks not done here: a screen-reader pass over the reflow preview and Add here, touch drag on a real
  device, and RTL rendering of the absolutely positioned slot buttons (they use `left`, which matches RGL).

## Implementer follow-up (2026-11-25)

- H1 fixed: `closeUp` (geometry.ts) closes the space of hidden widgets in `visiblePlacements` and of dropped widgets in `readLayout`, matching the old compaction; a gap the person left stays. Tests: hidden widget equals old compaction, gap kept under a hidden widget, dropped widget closes.
- M1 fixed: when the draft check fails the editor keeps no server draft (`localOnly`), with a test.
- M2 fixed: changes made while autosave is paused are marked and sent on `resume`.
- M3 fixed: Done runs once at a time.
- M4, L1–L6: left as follow-ups (e2e for resume/commit/conflict needs CI database).

## Re-review (final diff, 1683da3)

Scope: only the fixes for H1, M1, M2 and M3 (`git show 1683da3`). Local runs on the final tree: the four suites →
13 files, 218 tests passed. `tsc --noEmit` is clean.

- **H1: resolved.** `geometry.ts` adds `closeUp`, which `visiblePlacements` (lg/md) and `readLayout` (dropped
  placements, `lost`) now call. Space freed by hidden or dropped widgets closes. A gap the person left is never in
  the freed set, so it stays. That matches Ward's "keep gaps" and the brief, which is updated. I also ran a
  throwaway randomised check: 3,000 compacted lg layouts, random widgets hidden, `closeUp(shown, hidden)` against
  `compact(shown)`. There were 0 mismatches, so saved (compacted) layouts render exactly as before. The temp file was
  removed and the tree is clean. New tests cover the hidden widget (equals the old compaction), a gap that is kept,
  and a dropped widget.
- **M1: resolved.** When the draft check failed, `draftUnchecked` → `localOnly` puts autosave in `local` from the
  start. No PUT is sent, the status says no draft can be kept, and the leave guard is active. Tested.
- **M2: resolved.** A change made while autosave is paused now sets `changed` and `unsaved` before the early
  return, so `resume()` after a failed Done sends it. Not covered by a new test (LOW test gap).
- **M3: resolved.** The `finishing` ref allows one Done at a time and is released in `finally`, so keep-mine's re-run
  still works. Not covered by a new test (LOW test gap).
- **New LOW (not blocking):** Cancel stays enabled during the short `await autosave.stop()` window before Done's
  mutation turns `pending` on. Pressing Cancel then leaves edit mode while the commit still goes through. Disabling
  Cancel while `finishing` is set would close this. M4 and L1–L6 stand as written above.

**Updated verdict: PASS.** No BLOCKER or HIGH findings remain. Human PR approval and green CI, including e2e, are
still required.
