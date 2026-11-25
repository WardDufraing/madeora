# UX3b review — Calendar redesign (creation dialog, event preview, borderless grid, work periods)

Reviewer: independent agent with fresh context. Diff: `git show 7163508` (`/tmp/claude-0/UX3b.diff`).
I read the code and ran `npx vitest run src/components/calendar` (2 files, 20 tests pass) and ESLint on the touched files (clean). I did not run the full suite, tsc, Playwright or a real browser.

## Verdict: CHANGES_REQUIRED

One HIGH (the existing e2e will break) and several MEDIUM findings, mainly about focus management in the anchored preview and missing tests for the work-period payload. Data, permission and privacy handling is sound: no change to RLS, RPCs or API contracts, every read uses the viewer's session, and work periods stay Personal-only.

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 1 |
| MEDIUM | 6 |
| LOW | 10 |

---

## HIGH

### H1 — The existing calendar e2e will fail: a plain click on an event now opens the preview instead of the event page
- **Where:** `tests/e2e/specs/calendar.spec.ts:163` (`agenda.getByRole("link", { name: /Dentist/ }).click()` then expects `event-shared-by` on the event page) and `:203-208` (clicks Dentist in the Personal agenda, then uses `event-share-home` / `event-share-save` on the event page). Cause: `apps/web/src/components/calendar/event-preview.tsx:84-89` (`preventDefault` on a plain click) used for every occurrence (`calendar-view.tsx` `OccurrenceItem`).
- **Impact:** after hydration, Playwright's click opens the preview, so `event-shared-by` and `event-share-home` are never found and CI goes red. The brief says the existing e2e is "unchanged". That holds for `/calendar/new`, but these two flows now behave differently. Nothing covers the new preview in a real browser.
- **Remediation:** update both steps to open the preview and use `event-preview-open` ("Open full page"), or `goto` the event URL. Preferably add one e2e assertion for each: the preview opens, Escape closes it, and Bea sees no Edit on the shared event. Run the calendar e2e locally before the PR.

## MEDIUM

### M1 — Focus very likely never moves into the anchored panel in a real browser
- **Where:** `event-preview.tsx:146-174` (position computed in `useLayoutEffect` → `setPosition`), `:183` (`panel?.focus()` in `useEffect`), `:224` (`visibility: position ? "visible" : "hidden"`).
- **Impact:** on the first commit the panel is `visibility:hidden`. The layout effect schedules a sync re-render. Because the open came from a discrete click, React flushes passive effects synchronously before that re-render commits. So `panel.focus()` runs while the panel is still hidden, and browsers do not focus `visibility:hidden` elements. Focus stays on the trigger, and screen readers do not announce the dialog. jsdom ignores visibility, so the "Escape and focus return" test passes regardless. This is the done-condition's "keyboard + screen reader focus management".
- **Remediation:** focus after the panel is visible. Options: focus inside the layout effect after setting position (or in an effect keyed on `position`); or position with `opacity-0`/off-screen instead of `visibility:hidden`. Check in a real browser (Playwright) that `document.activeElement` is inside the panel.

### M2 — Closing the panel other than with Escape loses focus, and a non-modal panel stays open after Tab leaves it
- **Where:** `event-preview.tsx:228-235` (sr-only Close button calls `onClose` with no focus return), `:174-200` (no `focusout` handling).
- **Impact:** keyboard users who press the Close button land on `<body>` and have to start again from the top of the page. Tabbing past the panel leaves it open and fixed over other events, which goes against decision 45: "avoid hiding other event controls behind the preview".
- **Remediation:** return focus to the trigger when the Close button closes the panel (not on outside pointer). Close on `focusout` when the new focus is neither the panel nor the trigger. Add a test for each.

### M3 — Work periods take the month cell's three slots and push real events into "+N more"
- **Where:** `calendar-view.tsx:188-191` (work periods sorted first), `:623` (`entries.slice(0, MONTH_CELL_ENTRIES)`, which is 3).
- **Impact:** on a workday the month cell shows "Work 09:00–17:00" and only two real events. With two shifts it shows only one. Decision 43 asks for work blocks to sit *behind* events, with a "concise indicator" in compact month views, so events stay legible. Here the quiet background takes the foreground.
- **Remediation:** in month view, show work as a compact indicator that does not count toward `MONTH_CELL_ENTRIES` (for example a single line "Work 09–17" above the list, excluded from `shown`/`more`). Alternatively, list work periods last in month cells.

### M4 — The "this and following" work-period fix and the work filter have no tests
- **Where:** `event-form.tsx:354-356` (sends `workPeriod: event.series.workPeriod` on a following split); `calendar-view.tsx:79, 150-161, 255-265` (`work=0`, Personal-only toggle, `calendarHref` carrying the flag).
- **Impact:** the brief says this closes the UX3a known gap, but no test proves the PATCH body carries `workPeriod: true` for a work series split, or leaves it out for `only`/`all`. Nothing tests that the toggle is absent in a Home calendar, that `work=0` hides the blocks, or that the work label and dashed-edge item render (the existing "labels a work period" test renders the preview with `source="google"` and `workPeriod`, a combination the data never produces). The bottom-sheet (narrow) mode is untested too.
- **Remediation:** add an `EventForm` edit test (work series, scope `following` → body contains `workPeriod: true`; scope `all` → no `workPeriod`). Add a calendar-view/render test for the toggle (Personal only) and for filtering. Add one narrow-mode test with `matchMedia` mocked to match, which should render a modal `dialog` with a close button.

### M5 — The preview shows no date
- **Where:** `event-preview.tsx:106-117` (header shows `title` + `when`), `calendar-view.tsx` `preview.when` (time only: "09:00–10:00", "All day", "Continues").
- **Impact:** decision 45 asks for "title, date/time". In the bottom sheet and the anchored panel, nothing says which day it is. This matters for multi-day events ("All day continues") and for screen-reader users who reached the event by tabbing.
- **Remediation:** pass the occurrence date (or the `from`–`to` range) formatted on the server, and show it with the time.

### M6 — Edit leaves the calendar for the full edit page (brief default 2): needs explicit owner confirmation
- **Where:** `event-preview.tsx` Edit link (`editEventPath`), brief "Defaults chosen" 2. Also related: default 1 (no time grid, while decision 43 talks about day/week time-grid views).
- **Impact:** decisions 44 and 45 refer to "approved adaptive creation/edit dialogs" and to not navigating away unnecessarily. Editing through the page loses view, scroll and filters (Back restores most of it). The defaults are flagged honestly, but they change approved UX and need Ward's go before merge, not only a "flag if wrong" note.
- **Remediation:** get the owner's decision on defaults 1 and 2 (and 3, URL-only filter) in the PR. If edit-in-dialog is wanted, the `EventForm` `onDone`/`onCancel` hooks added here already make it small.

## LOW

1. **Test-id collision:** `event-preview.tsx:280` uses `data-testid="event-preview"`, which `event-form.tsx:654` already uses for the affected-occurrences preview (asserted in `calendar.spec.ts:240`). Rename the new one (for example `event-peek`).
2. **Query retries and key:** `event-preview.tsx:255-273`. A 404/401 is retried three times (TanStack default), so "Loading details…" shows for about 7 s before the error. Set `retry: (n, e) => …` to skip retries on 4xx, or `retry: false`. The key is ad hoc; add a `calendarKeys.event(eventId, on, homeId)` factory beside `calendarKeys.all`. It is correctly covered by the `calendarKeys.all` invalidation in `use-calendar-mutation.ts:25` and cleared on sign-out (`auth-sync.tsx`).
3. **Brief versus code:** the detail is read as soon as the preview opens (`enabled: readable`), not on "More details" as the brief says. Either choice is fine, but make the brief match. As built, every click costs one GET.
4. **Weekend tone:** `calendar-view.tsx:574-577` hard-codes Saturday and Sunday (locale-dependent; in some regions the weekend is Friday and Saturday). The old outside-month tint was dropped, so outside days now differ only by muted text.
5. **Tab stops:** `AddOnDayButton` (`calendar-view.tsx:654`) adds up to 42 invisible-until-focused links to a month's tab order. Consider `tabIndex={-1}` plus one keyboard route (the header's New event already exists), or accept it and document it.
6. **Extra server work on every calendar view:** `calendar-view.tsx:99` awaits `calendarCreateData` *after* `readCalendar` (a waterfall). `readGoogleConnection` is not wrapped in `cache()`, so each Personal calendar view now does an extra DB read. Start it in parallel with `readCalendar`, gated on the same create right, or load the dialog's data lazily.
7. **No confirmation after saving from the dialog:** `calendar-client.tsx:118` closes the dialog silently. Screen-reader users get no "Event added". Use the existing toast (`AppToasts`) or a live region.
8. **Import placement:** `calendar-view.tsx:17` puts a relative import inside the `@/` group; move it to the `./` group with the others.
9. **Serialised names:** `calendar-view.tsx:202` sends the whole Home directory's names to the client to label participants. Members can already see these, so there is no new exposure, but sending only the ids that appear in the window's occurrences would be tighter.
10. **Small cleanups:** a needless `cx()` around a static string (`event-preview.tsx:376`). There is one `matchMedia` subscription per event chip (`useSyncExternalStore` in every `EventPreview`); this works but a shared hook or a single subscription in `CalendarClient` would be cheaper on busy months. `untitledGoogle` is also used for an untitled Madeora event (`:82`).

---

## Explicit checks

| Check | Result |
|---|---|
| Requirements (done-condition 1–4) | (1) Creation dialog over the calendar: yes. View, date, filters and scroll kept. Prefill from the "+": yes. Full screen below `sm`: yes (classes on the native dialog). `/calendar/new` still works, and the links work without JS or with a modified click. (2) Borderless grid: yes. (3) Preview: built. Edit appears only on `canEdit`, Escape works, the panel stays inside the viewport. Real-browser focus is likely broken (M1/M2) and the date is missing (M5). (4) Work blocks: labelled "Work" plus a dashed edge (not colour alone), filterable via `work=0`, Personal only. Month slot handling is off (M3). |
| Personal vs Home / privacy | OK. The preview shows only fields already rendered in the list, plus `GET /api/v1/calendar/events/:id?homeId=&on=` with the viewer's session (server `readEvent`, not found when not visible). Participants are shown only in a Home context. The reminder is null on shared events from the server. Edit is gated on server `canEdit` and the edit page re-checks. No privileged client. |
| Work-period handling | Create: `workPeriod: true` only for new Personal Madeora-target events, with shares forced to `[]` and the sharing UI hidden (the DB and `createEventSchema` also refuse). Edit: the checkbox is hidden (flag fixed); the shares fieldset is hidden for work series; "this and following" now sends the series' flag (closes the UX3a gap). Home events send `workPeriod:false` on a split, which is harmless. Untested (M4). The toggle appears only in Personal. |
| Mis-send risk in dialog | None found. Same `EventForm`, same CSRF-protected `sendCalendarRequest`/Google paths. `onDone` replaces only navigation. Dirty question on Cancel, close and Escape. |
| Server/client boundary | OK. All props passed to client components are serialisable (strings, arrays, plain objects, `ReactNode` children from server). Async `OccurrenceItem`/`MonthGrid` server components render as children of the client `CalendarClient`, which is valid. `calendar-client.tsx` imports only types from server modules. |
| Hydration / progressive enhancement | OK. Triggers are real `<Link href>`s. Modified clicks and no-JS use the pages. `useSyncExternalStore` server snapshot `false` gives no mismatch. `aria-expanded` is rendered on the server. |
| TanStack keys vs invalidation | OK: `["calendar","event",id,on,homeId]` is under `calendarKeys.all`, which every calendar mutation invalidates, and `queryClient.clear()` runs on identity change. Minor: retries and the key factory (L2). |
| Accessibility | Dialog semantics are good (native modal, labelled, discard alertdialog, focus restore on the sheet and the creation dialog). Anchored panel: `role="dialog"` with `aria-label`, Escape returns focus, but initial focus likely fails (M1), focus is lost on the Close button, and the panel persists after Tab leaves (M2). Work items are labelled in text. Axe passes in jsdom. |
| RTL | OK. Logical `border-s-4`. Panel placement mirrors on `direction: rtl`. `<bdi>` on user text. |
| i18n | 16 keys added in both en and nl, parity OK, wording fine. |
| Secrets / input validation | None involved. The detail response is Zod-parsed (`eventDetailSchema`). |
| Migration safety | No migration. Rollback is a revert. |
| Tests | 10 new unit tests plus a `format` case pass. Gaps: M4, the e2e break (H1), and no real-browser focus test. |
| Performance | Extra serial server read per calendar view (L6). Per-chip `matchMedia` listeners (L10). |
| Maintainability | Reasonable: one dialog, small hooks on `EventForm`. Test-id collision (L1); ad-hoc query key (L2). |
| Rules (CLAUDE.md) | Custom components only, no new dependencies, no lint suppressions, strict TS (ESLint clean; tsc not run by me). |

## Remaining risks

- Behaviour in a real browser (focus, positioning near the viewport edges, the bottom sheet on iOS Safari with `dvh`) has not been checked. jsdom cannot show M1.
- The dashboard Upcoming widget, Ora overviews and other list readers still receive work periods (UX3a says they are flagged) and show them as ordinary events. This is outside this slice, but owner-visible.
- Defaults 1 (no time grid), 2 (edit via page) and 3 (URL-only filter) are product/UX choices still awaiting the owner (M6).
- The brief notes that merging `main` before the push will conflict in en.json, nl.json and screens.ts. Re-run i18n parity and the screens e2e after the merge.
