# S32 Native calendar: independent review

**Reviewer:** an independent review agent with fresh context (not the implementer). This is an AI review. It is not a GitHub human approval.
**Tree:** uncommitted working tree on `feat/native-calendar`, on top of `a0fe833`.

**Read:** `plans/steps/S32-brief.md`; `docs/adr/0042-native-calendar.md`; `CLAUDE.md`; `docs/product/Modules.md` L25–50; `docs/product/Project-specification.md` L78–84, 427, 632–636, 1708, 1712, 1907–1913, 2128–2130 and 2532–2536 (no other lines); `architecture.md` L340–360; the whole of `supabase/migrations/20261118090000_calendar.sql`; the privacy, DST and recurrence sections of `tests/db/rls/calendar.test.sql`; `apps/web/src/calendar/{schema,data,route-helpers,time}.ts`; `apps/web/src/app/api/v1/calendar/events/[eventId]/route.ts` and `.../calendar/route.ts`; `apps/web/src/components/calendar/{event-form,event-pages,calendar-toggles}.tsx` (the parts that matter) and an accessibility scan of `calendar-view.tsx`; the home edit page; `packages/domain/src/permissions/{calendar,home}.ts`; `packages/jobs/src/jobs/calendar.ts` and the jobs, email, notification and widget diffs; and the earlier migrations I needed (`trash_move`, `notify_user`, `enqueue_job`, `series_first_on_or_after`, `vacation_summary`, `has_home_capability`).

**Ran:**

- A throwaway PostgreSQL 16 cluster (in `/tmp`, deleted afterwards), used only to check how PostgreSQL resolves daylight-saving gaps and overlaps with `timestamp ... at time zone`.
- `git status` and `git diff HEAD -- <paths>`.
- Greps.
- I read the implementer's logs in `/mnt/project-files/wip/S32/`.

I did **not** run the DB suite, Vitest, typecheck, lint, the build or Playwright myself.

**Verdict:** `CHANGES_REQUIRED`

## Findings

### BLOCKER

None.

### HIGH

**H1. Editing your own shared personal event from a Home calendar silently unshares it from every Home.**

- **Where:**
  - `apps/web/src/components/calendar/event-actions.tsx:54`
  - `apps/web/src/components/calendar/event-pages.tsx:199-205` and `:313-324`
  - `apps/web/src/components/calendar/event-form.tsx:306-307`
  - `supabase/migrations/20261118090000_calendar.sql:1281-1283` and `:1311-1313`
- **How it happens:**
  1. The owner opens their own shared event in `/homes/H/calendar`. There `kind = 'personal'` and `canEdit = true`.
  2. Edit leads to `/homes/H/calendar/events/X/edit`.
  3. `EventForm` gets `homeId = H`, so it treats the event as a Home event. It shows Home members as participant checkboxes and sends `participants`. It never sends `shares`, because of `!homeId && withRepeat`.
  4. `update_calendar_event` reads the missing `shares` as `'{}'` (`calendar_json_ids`). For scope `all` it calls `calendar_set_shares(v_event, '{}')`. For `following` the new series gets no shares.
- **Impact:**
  - Any change made from the Home calendar removes the event from every Home it was shared with, with no warning.
  - If the owner ticks a participant, the request fails with a generic 22023 "invalid".
  - The share is the owner's explicit privacy choice, and this is a core flow. Nothing in Playwright or the component tests edits from the Home context.
- **Remediation:**
  - Send the owner of a personal event to the Personal edit page (`editEventPath(null, …)` when `kind === 'personal'`). Or decide the form's mode from the event (`event.homeId`), not the page context: no participants for a personal event, and `shares` taken from `event.shares`.
  - In SQL, treat a missing `shares` key as "keep the current shares" (see M3).
  - Add an RLS test and an E2E test: the owner edits a shared event from the Home calendar and the share is still there afterwards.

**H2. Client-chosen ids make it possible to test whether an unshared or hidden event still exists.**

- **Where:**
  - `supabase/migrations/20261118090000_calendar.sql:969-977` (create returns `id_taken`)
  - `:1257-1259` (`following` with `p_new_id` returns `id_taken`)
  - `tests/db/rls/calendar.test.sql:141`, which asserts this behaviour as intended
- **How it happens:** `create_calendar_event` with the id of someone else's event answers `id_taken` (409). For a missing id it answers `created` (201). Two people know such ids:
  - Anyone the event was shared with earlier sees its id in URLs and API answers.
  - Anyone who saw it in a notification link.
- **Impact:**
  - After the owner unshares, a former viewer can keep checking whether the event still exists, including while it is in the trash (the row stays until purge).
  - Any user with an editable recurring event can run the same test through `following`.
  - This breaks the brief's leak rules ("not its … existence … in any function … error or API answer"; "a forged or foreign event id gets the same `not_found` as a missing one"), which are part of the step's done condition.
- **Remediation:**
  - Scope idempotency to the caller. Store `id = uuid_v5/md5(caller_id || client_id)`, or keep a separate `(created_by, client_key)` unique key with server-generated ids. A foreign id then never collides, and a retry by the same caller still answers `exists`.
  - Do the same for `p_new_id`.
  - Change the RLS assertion so that a known foreign id behaves exactly like a fresh one.
  - If the owner instead accepts this residual oracle, record that in ADR 0042 and the brief.

### MEDIUM

**M1. Ambiguous (fall-back) times resolve to the second instant, while the form promises the first.**

- **Where:**
  - `apps/web/src/i18n/messages/en.json:6014` and `nl.json:6014` ("the first one is used")
  - ADR 0042 L13 and the brief
  - All SQL instant maths: `calendar_start_at`/`calendar_end_at` (`calendar.sql:451-461`) and `calendar_reminder_at` (`:1554-1567`)
- **Check:** I confirmed on PostgreSQL 16 that `timestamp '2026-10-25 02:30' at time zone 'Europe/Amsterdam'` gives `01:30+00`. That is the later instant, standard time (CET). The first one would be `00:30+00` (CEST).
- **Impact:**
  - The stored instant, the reminder moment and any view in another timezone (Personal view, `inOwnZone`) are an hour later than the UI says.
  - There is no DB test for the overlap case. `architecture.md` §19 requires an explicit, tested DST policy for reminders.
- **Same gap for recurring occurrences:** an occurrence of a recurring series can land in a spring-forward gap (a weekly 02:30 event on the last Sunday of March). PostgreSQL silently shifts it. An occurrence of 02:30–03:30 becomes zero-length (start equals end), and its `to` date is computed as earlier than `from`. No policy covers this and no test checks it.
- **Remediation:**
  - Resolve ambiguous times explicitly in SQL to the earlier offset, for example by comparing `(ts at time zone z)` with `((ts - interval '1 hour') at time zone z) + interval '1 hour'` and taking the earlier valid one. Alternatively, change the copy and the ADR to "the second one", with owner sign-off.
  - Define and test the behaviour for gap occurrences in a recurring series.

**M2. A reminder chain that fails once stops for good.**

- **Where:** `calendar.sql:1612-1633` and `:1672-1721`, and `packages/jobs/src/jobs/calendar.ts`.
- **How it happens:**
  - The next reminder is queued only by the triggers (on an event change) or at the end of a delivery.
  - A job that exhausts its 5 attempts (database outage, not-due retries spent) is dead. Its idempotency key stays in the outbox.
  - There is no hourly sweep like the one other reminder modules have (`REMINDER_ADVANCE_BATCH`).
- **Impact:** every later occurrence of that series silently never reminds anyone, until someone edits the event.
- **Remediation:** add a periodic "advance" that calls `schedule_calendar_reminder` for events with a reminder and no pending job. Or make a dead job requeue its successor. Test both.

**M3. PATCH behaves like PUT: optional fields left out of the body are wiped.**

- **Where:** `apps/web/src/calendar/schema.ts`, the `eventFieldsSchema` fields `location`, `description`, `reminder`, `participants` and `shares` (all `.optional()`), and `calendar.sql:812-886` and `:1302-1313`.
- **Impact:**
  - A `PATCH` with scope `all` that leaves out `shares`, `participants`, `reminder`, `location` or `description` clears them. This is the cause behind H1.
  - The routes are meant to be stable HTTP contracts for later mobile clients. Silent data loss is the wrong default.
- **Remediation:** either make these fields required in the update contract, or have SQL tell "key absent" (keep) apart from "null or empty" (clear).

**M4. Reading a calendar expands every event the person can see, whatever the window.**

- **Where:** `calendar.sql:567-577` (`calendar_context_events`), used by `list_calendar` and `get_calendar_upcoming`.
- **Impact:**
  - A Home with thousands of events pays for every one on every read: a plpgsql `calendar_window` per event, then up to about 64 `calendar_effective` calls per event, each doing a nested rule check and an exception lookup.
  - This happens on every calendar page and every Upcoming widget render, including the personal dashboard.
- **Remediation:**
  - Pre-filter on `starts_on <= p_to + 1` and `(until_date is null or until_date >= p_from - span - 1)`. For single events use `ends_on >= p_from - 1`.
  - Keep the events that have a moved exception inside the window.
  - Add a supporting index.

### LOW

- **L1. Cancellations escape the exceptions limit.** `calendar.sql:1414-1420`: cancelling one occurrence (`only` delete) inserts exceptions without checking the limit of 500 per series, while edits check it (`:1205-1210`).
- **L2. Timezone lookup on every read.** `calendar.sql:94-98`: `calendar_valid_zone` scans `pg_timezone_names` (it enumerates the tz database) on every Personal list, upcoming and detail read. Consider an `IMMUTABLE` cache table or `pg_timezone_names` materialised at migration time.
- **L3. The client and the database accept different timezone sets.** The client uses `Intl` (`schema.ts:57-68`) and the database uses `pg_timezone_names`. A zone that one accepts and the other refuses ends in a generic 400 "invalid".
- **L4. Departed participants mark every one-occurrence edit as changed.** `calendar.sql:1195`: `v.participants <> v_event.participants` compares the submitted current members with a stored array that may still hold departed members. Every `only` edit of such a Home event then creates a `participants` exception even when nothing changed. Compare against the current members only.
- **L5. Unchecked casts.** These go against the CLAUDE.md "no unchecked casts" rule:
  - `apps/web/src/calendar/api.ts`: `record.error as CalendarErrorCode`, with no membership check
  - `route-helpers.ts`, `resultOf`: `data as Record<string, unknown>`

  Narrow them with a Zod enum or a guard.

- **L6. Undocumented condition for vacation banners.** `calendar.sql:637-638`: a banner shows only for a vacation with at least one accepted participant. That is reasonable, but the brief's "confirmed" is not defined anywhere. State it in ADR 0042.

## Explicit checks

- **Requirements:** Present: events, personal and Home visibility, sharing, separate edit and delete levels, the creator getting no extra right, the three scopes with previews, the stale-revision check, vacation banners with their toggle, the task and chore overlays, the widget, trash, reminders and nl/en strings. Gaps:
  - H1 breaks the "Personal event: see, edit, delete, share — its owner only" flow in the Home context.
  - M1 contradicts the stated rule for ambiguous times.
- **Cross-Home isolation and privacy:** A personal event the caller may not see answers `null` or `not_found` in every path I checked:
  - list, upcoming, detail, update, delete and shares (`lock_calendar_event` answers foreign events exactly like missing ones)
  - trash (`can_see_trash_entry`: personal entries are the owner's alone)
  - audit (Home events only, ids only; the trash audit carries ids only)
  - notice titles (owner, or a current Home member for Home events)
  - reminders (owner only for personal events; `notify_user` drops non-members)
  - email copy (no title)
  - overlays (the viewer's own task and chore functions)

  A shared event shows in its own Home only, and leaving the Home cascades the share away. The one remaining oracle is the id-existence answer in H2.

- **Permissions:** The SQL `calendar_level`, `calendar_can_edit` and `calendar_can_delete` match `permissions/calendar.ts`. Managers cannot change their own level or another manager's. Restoring from the trash needs delete level. The edit and delete checks happen after the lock and before any body-dependent outcome.
- **Secrets:** None added. `deliver_calendar_reminder` is granted to `service_role` only. Every function has `search_path = ''`. The private helpers (`%calendar%` and the renamed trash functions) are revoked from public, anon and authenticated, and no table is granted.
- **Input validation:** Zod checks at the routes and is rechecked in SQL (`calendar_values`, `calendar_json_ids`, `calendar_time_problem`, table CHECKs). The update contract and the missing-key handling are covered in M3. Weekday duplicates are stopped by Zod only (SQL does not dedupe; low risk).
- **Migration safety:** The migration only adds things. It rewrites the audit, trash and capability CHECK lists with the full previous lists, and wraps the trash functions with the established rename pattern. No data backfill. Rollback means dropping the new objects and restoring the renamed functions; the implementer should document that in `docs/production-migrations.md`. I did not review that file because it was excluded from the diff.
- **Test coverage:** The RLS suite is broad (leak matrix, levels, scopes, gap time, cross-zone display, trash, reminders, notice titles). Missing:
  - the fall-back overlap
  - gap occurrences inside a series
  - editing a shared event from the Home context (H1)
  - recovery after a dead reminder job
  - a foreign-id create (the current assertion codifies H2)
- **Accessibility:** Month and week use a `<table>` with a caption. There are `aria-current` page and date markers, a labelled nav and view list, a `role="status"` notice for a partial read, toggles in a `<fieldset>` with a legend, state in words and not colour, and `bdi` around user content. Axe runs in the component tests and the E2E spec. I found no issues.
- **Performance:** See M4 and L2. The 1000-occurrence cap is applied only after every event has been expanded.
- **Maintainability:** The code is well commented and consistent with earlier modules. The trash function chain is getting deep (pets, then pet care, then calendar). The casts are in L5.

## Remaining risks and test gaps

- I did not run the DB suite, Vitest, the build or Playwright. The pass claims rest on the implementer's logs (`db.log` shows `rls/calendar.test.sql` passing).
- The order of reminders when an occurrence is moved, and the 15-day look-back, are documented limits (ADR consequences). An occurrence moved more than 15 days later is never reminded.
- Ora, Household Display and Google sync must read through these functions. Any new path that reads `private.calendar_events` directly would skip `calendar_can_see`.
- Banners include the participant names that `vacation_summary` returns. That is fine for members; the wall-display privacy rule (PS L1910) still has to be applied when displays arrive.
- Load on large Homes is not measured (M4).

## Implementer's follow-up (fixes verified by the implementer, not re-reviewed)

- **H1 fixed.** `update_calendar_event` keeps a personal event's current shares when the body has no `shares`. The Edit link and the edit page send a personal event to the personal space (`/calendar/events/:id/edit`) even when it is opened from a Home's calendar. Tests: `tests/db/rls/calendar.test.sql` ("A change without shares keeps them"), `calendar.test.tsx` (the Edit link of a personal event shown in a Home).
- **H2 fixed.** An event's stored id is derived from the caller and the client's request id (`private.calendar_event_id`, version-4-shaped), for created events and for the new series of "this and following". A retry still finds the same event; another person's id never collides, so creating never reveals whether their event exists. The `id_taken` answer on create is gone. The DB test now asserts that reusing someone else's request id simply creates one's own event.
- **M1 fixed in wording, and tested.** PostgreSQL resolves a fall-back time to the second instant (standard time). The form (nl/en), the ADR and the brief now say so, and a DB test pins 02:30 on 25 October 2026 in Brussels to 01:30 UTC. A recurring occurrence in a spring-forward gap moves forward by the gap; the ADR and brief say so.
- **M3:** shares are the case that caused H1, and they are fixed. The other fields still follow full-replacement semantics: the form always sends them.
- **M2, M4 and the LOW findings** are left open and recorded as remaining risks for Ward. M2: no sweep re-queues a reminder chain after a dead job. M4: reads expand every event of the context.
- **Re-run after the fixes:** the calendar SQL suite and all 42 SQL files; the generated-types check; format, lint, typecheck and unit tests; Playwright for the calendar, dashboard and roles specs. The results are in `/mnt/project-files/wip/S32/suite2.txt`.
