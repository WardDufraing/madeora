# UX3b — Calendar redesign (UI on UX3a)

Source: `docs/design/dashboard-ux-ui-redesign.md` decisions 43 (work blocks), 44 (borderless), 45 (event preview) and the adaptive creation rule; `plans/steps/UX00-redesign-plan-brief.md` §3–4; `UX3a-brief.md` (data). Model: Sonnet (UI only; no RLS, auth or migration). No data, permission or privacy change: every read and write still goes through the existing calendar API and RPCs.

## Done-condition

Create and cancel without leaving the calendar (view, date, filters, scroll kept); prefill from the grid; full screen on phones; preview with Edit / More details, no clipping, keyboard path; borderless grid; work periods drawn as quiet labelled blocks with a filter; `/calendar/new` and the event pages stay for deep links.

## What was built

- `calendar-client.tsx`: `CalendarClient` (one new-event `Dialog`, large, full screen below `sm`, unsaved-changes question) plus `NewEventButton` and `AddOnDayButton`. Both are real links to `/calendar/new?date=`; a plain click opens the dialog, a modified click or no JavaScript uses the page.
- `event-form.tsx`: optional `onDone`, `onCancel`, `onDirtyChange` (page behaviour unchanged when absent). New personal events get a **work period** checkbox (hidden for Home events and Google targets; hides sharing; sends `workPeriod: true, shares: []`). "This and following" now sends the series' own `workPeriod` (the UX3a known gap).
- `event-preview.tsx`: event chips are links that open a preview: anchored panel on wide screens (kept inside the viewport, closes on Escape/outside click/scroll, focus returns), bottom sheet below 40rem. It shows the time, place and notes from the list at once; the event is read as soon as the preview opens (one GET per open) and "More details" shows it: the viewer's session (`GET /api/v1/calendar/events/:id`) for repeat, reminder, participants and description; **Edit appears only when that read says `canEdit`**. Google events have no read endpoint: preview plus "Open full page" only.
- `calendar-view.tsx`: borderless month/week grid (hairline above each week, weekend tone, round today marker, hover "+" per day); work periods first in each day, tinted with a dashed edge and the word "Work" (not colour alone); `?work=0` hides them (link in the Personal calendar, kept across navigation via `calendarHref`).
- `event-pages.tsx`: `calendarCreateData` gives the dialog the new-event page's own data.
- i18n: 15 Calendar keys in en and nl.

## Defaults chosen (flag if wrong)

1. **No time grid.** The repo's day/week views are lists and a table (S32); a real hour grid with background blocks would be a new view. Work blocks are therefore tinted labelled rows (day, agenda), cell entries (week) and compact chips (month), listed before ordinary events. A time-grid follow-up needs Ward's go.
2. **Edit from the preview opens the existing edit page**, not a second dialog (smaller, reuses the checked page). Edit-in-dialog is a follow-up.
3. **Work filter is the URL (`work=0`)**, not a stored preference: a stored toggle needs a DB column and API.
4. **No "selected date" tint** beyond today (the selected date is today by default; the hover/focus styles cover the rest).
5. Work periods are created only through the new-event form (checkbox); there is no separate "add work schedule" wizard or template (decision text: follow-up UX).
6. No new e2e: the existing calendar e2e uses `/calendar/new` directly and the `calendar-event` test ids, both unchanged. CI runs them.

## Tests

`calendar-redesign.test.tsx` (10): dialog open/save/close without `router.push`, prefill from a day, discard question and keep, no dialog without create right, work period payload (unshared), preview content and axe, Edit only when `canEdit`, Escape and focus return, Google event not read, work label. `format.test.ts`: `work=0` in the address. Local: those plus the whole `components/calendar`, `calendar` and `i18n` suites (79 pass), tsc, eslint, prettier. Full suite on CI.

## Review (reviews/steps/UX3b-review.md) and fixes

First verdict CHANGES_REQUIRED (0 BLOCKER, 1 HIGH, 6 MEDIUM, 10 LOW). Fixed: H1 e2e steps now go through the preview (`event-peek-*` ids, also asserts Escape and no Edit for Bea); M1 focus moves in once the panel is visible; M2 Close returns focus, Tab-out closes; M3 work periods list last in month cells (first in lists); M4 tests for "this and following" flag, no box on edit, narrow sheet; M5 date shown in the preview; L1 ids renamed, L2 no retries, L8 import order. Left as noted: M6 defaults 1-3 await Ward; L3-L7, L9, L10 (weekend days fixed Sat/Sun, 42 tab stops, one extra server read, no save toast, whole name map, per-chip matchMedia) are low and accepted.

## Rollback

Revert the PR: no migration, no data shape change.

## Progress notes

- 2026-11-25: built on Sonnet; merge `main` before the final push (en.json, nl.json, screens.ts conflict with parallel phases).
