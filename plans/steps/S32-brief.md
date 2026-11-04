# S32 · Native calendar — feature brief

**Branch:** `feat/native-calendar`, from `main` at `a0fe833` (S31 merged as PR #63).
**Sources (read only these):** build plan S32; Modules.md §4.2 (L25–L50: native events, ownership and participants, personal vs Home visibility, upcoming events widget and day overview, unshared events invisible, three recurring scopes L45); PS L78–L84 (shared Home calendar authorization), L427 (personal calendar overview widget), L632–L636 (Home and personal timezones), L1907–L1913 (vacation banners), L1819 and L1895 (vacation label privacy), L2532–L2536 (§11.2 calendar privacy), L2909–L2914 (numeric habits never on the calendar); Project-entry.md L70; ARCH date/time rules (L349–L355); ADR 0011/0014 (permission engine, capabilities), 0020 (trash), 0021 (dashboards), 0029 (vacations).
**Model:** Opus (thread verdict 4 Nov 2026: leak-proof privacy in RLS, three recurring scopes, separate edit and delete permissions).
**Done when (build plan):** unshared events reveal nothing, not even busy time, in every surface (RLS test).

## Scope

In: native events (personal and Home), sharing a personal event with chosen Homes, participants, all-day and timed events with timezones, recurrence with the three edit and delete scopes and an impact preview, Home calendar permissions with separate edit and delete, main calendar (month, week, day, agenda), Home vacation banners with the **Show Home vacations** toggle, the **Upcoming events** widget (personal, Home and Home-sourced), trash and audit.

Also in (Ward kept one step, decision card 4 Nov 2026): the main calendar's **Show tasks** and **Show chores** overlays (deferred to "the Calendar module step" by S19c and S21; PS L1708, L1712, L2128–L2130) and **event reminders**. Google Calendar is S33–S34. Ora and Household Display surfaces arrive with S43–S47 and must read through the same functions.

## Model

- **Event** (`private.calendar_events`): owned by a person (**personal**) or a Home (**Home event**). Title 1–200 (required); optional location (≤200) and description (≤4000).
- **Time:** all-day (start date and inclusive end date, at most 366 days) or timed (start and end as local date-times plus an IANA timezone, end after start, at most 14 days long). The timezone defaults to the context's (Home scheduling timezone, or the owner's effective personal timezone) and is stored with the event; the stored instant never moves when someone's timezone changes. A local time that does not exist (spring-forward gap) is refused with `nonexistent_time` (the form says so and offers the next valid time); an ambiguous time (fall-back) uses the second of the two (standard time, as PostgreSQL resolves it) and the form says so. A recurring occurrence whose time falls in a gap moves forward by the gap, as PostgreSQL resolves it.
- **Personal events** are visible only to their owner, unless the owner **shares** the event with one or more of their current Homes (`private.calendar_event_shares`). A shared event shows its full details, read-only, to every current member of that Home; only the owner edits or deletes it. When the owner leaves a Home, the share stops showing there (and is removed).
- **Home events** belong to the Home; every current member sees them. **Participants** (0–20) are current members of that Home; a departed member disappears from the list. Personal events have no participants.
- **Recurrence:** the S19 rules (daily, weekly on chosen weekdays, monthly on the day of the month with the last-day fallback, yearly with 29 February → 28 February, every 1–99, ends never, on a date or after 1–999 times), evaluated in the event's timezone on local dates, so a timed series keeps its wall-clock time across DST. Occurrences are computed when read; exceptions (`private.calendar_event_exceptions`, keyed by the original date) hold a moved or changed occurrence, or a cancelled one.
- **Scopes** (Modules.md L45), each with a preview listing the affected occurrences before anything changes:
  - **This event:** an exception for that date (edit) or a cancellation (delete). The rest of the series is untouched.
  - **This and following events:** the series ends the day before; edits start a new series from that date with the changes (earlier occurrences and their exceptions stay); delete just ends it there. Exceptions on or after that date move to the new series (edit) or are removed (delete).
  - **All events:** the series itself changes. Exceptions keep their own changes; when the rule or start changes, exceptions whose date no longer belongs to the new rule are removed (the preview counts them). Delete moves the whole event to the trash.
- **Concurrency:** every change carries the event revision; a stale one is refused with `stale` and nothing changes.
- **Limits:** 5000 events per person and per Home (series count once), 500 exceptions per series, 20 participants, 20 Homes shared.

## Permission matrix (proposed default; PS L78–L84 asks for edit and delete to be separate)

| Action                                                   | Owner                         | Administrator                                                             | Member                                           |
| -------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| See Home events and personal events shared with the Home | yes                           | yes                                                                       | yes                                              |
| Create and edit Home events (every scope)                | yes                           | with calendar access _edit_ or _edit and delete_, or `manageHomeCalendar` | with calendar access _edit_ or _edit and delete_ |
| Delete Home events (every scope), restore from trash     | yes                           | with calendar access _edit and delete_, or `manageHomeCalendar`           | with calendar access _edit and delete_           |
| Set members' calendar access                             | yes                           | with `manageHomeCalendar`, never their own                                | no                                               |
| Personal event: see, edit, delete, share                 | its owner only, in every role |                                                                           |                                                  |

- **Calendar access** is a per-member, per-Home level: _view_, _edit_ (default for every new member) or _edit and delete_. The creator of a Home event has no extra rights (PS L79). Changes are audited and effective on the next request; leaving resets it (rejoining starts at _edit_).
- Home permissions never reach a personal event that is not shared, and sharing never gives anyone else edit rights.

## Leak rules (the done condition)

For a personal event not shared with a Home, nobody but its owner receives anything: not its title, time, busy status, count, existence, recurrence, exception, trash entry or audit entry, in any function, page, widget, error or API answer. A forged or foreign event id gets the same `not_found` as a missing one. Home event lists contain only Home events and events shared with that Home, never "busy" blocks. The Home calendar does not say how many personal events a member has. Removing a share or leaving the Home hides the event on the next request.

## Interface

- **Calendar** in the personal nav (`/calendar`) and each Home's nav (`/homes/[homeId]/calendar`): month, week, day and agenda views; previous, today, next; the address holds the view, so it works without JavaScript; the week starts on the viewer's week-start setting. Times show in the context timezone (personal: the viewer's; Home: the Home's), with the event's own timezone shown when it differs. Shared personal events in a Home calendar are marked "Shared by {name}". Small screens get the agenda list.
- **Show Home vacations** (Home calendar only, default on, remembered per person and Home): each confirmed, non-cancelled vacation is an all-day banner over its inclusive dates, overlapping vacations as separate banners, with the label the vacation page already shows that viewer (custom name, or the scope label). Banners are not draggable; each links to the vacation's page, which applies its own rules (built: every member, since every member may open a vacation's page). Hiding changes nothing about the vacations.
- **Event page** (`/calendar/events/[eventId]` and `/homes/[homeId]/calendar/events/[eventId]`, with `?on=YYYY-MM-DD` for an occurrence): details, participants, sharing (owner), Edit and Delete with the scope choice and impact preview.
- **New / edit form** (React Hook Form + Zod): title, all-day, start, end, timezone (shown, changeable to any IANA zone), location, description, repeat (the S19 repeat fields), participants (Home), share with Homes (personal).
- **Member management:** a "Calendar" control (View · Edit · Edit and delete) for whoever may set it; `manageHomeCalendar` in the capability toggles.
- **Widget `upcoming-events`** (personal: personal events; Home: Home events and shared ones; Home-sourced on the personal dashboard): the next 3, 5 or 10 occurrences within 7, 14 or 30 days, with an "Add event" link where allowed. Added to the personal starter layout only (PS L427 asks for a personal calendar overview; the Home starter is unchanged), for people without a saved layout.
- nl and en strings, keyboard and axe tests.

## API

`GET /api/v1/calendar?homeId=&from=&to=` (occurrences in a window), `POST /api/v1/calendar/events`, `GET/PATCH/DELETE /api/v1/calendar/events/:id` (PATCH and DELETE take `scope`, `on` and `revision`, and `dryRun` for the preview), `POST /api/v1/calendar/events/:id/restore` through the shared trash, `PUT /api/v1/calendar/events/:id/shares`, `GET/PUT /api/v1/homes/:homeId/calendar-access`, `PUT /api/v1/homes/:homeId/calendar-preferences`. Same CSRF, JSON, size, session and outcome mapping as the earlier routes.

## Database (`20261118090000_calendar.sql`)

Tables above plus `private.home_calendar_access` and `private.calendar_view_preferences`; capability `manageHomeCalendar`; `private.calendar_access(home, user)`; security-definer functions for every read and write (no table grants); trash item type `calendar_event`; Home audit events with ids only (`calendar.event.created|updated|deleted|restored`, `calendar.access.changed`; never for personal events).

## Tests

- **Database (RLS, multi-actor):** the leak suite (owner, another member of the same Home, a member of another Home, a stranger, a forged id) over every read function, the widget, trash and audit; share and unshare; leaving the Home; Home edit vs delete levels; creator without rights; manager rules (not their own level); cross-Home ids; all three scopes for edit and delete, including exceptions, splits and rule changes; stale revision; DST gap and overlap; limits.
- **Unit:** recurrence and occurrence expansion (DST, month ends, leap day), schemas, permission matrix, routes, components with axe.
- **Playwright:** create a personal event, share it with a Home, a second member sees it with "Shared by"; an unshared event is invisible to that member; a weekly Home event edited "This and following"; a Member with _edit_ cannot delete; vacation banner toggle.

## Defaults picked (Ward may override)

1. Calendar access levels and defaults as in the matrix (every member may create and edit Home events, nobody but the Owner deletes until granted).
2. Personal events are shared per event; Home members see full details read-only.
3. The personal calendar shows personal events only; Home events stay in each Home's calendar (and the Home-sourced widget).
4. Deleting "this event" or "this and following" asks for confirmation after the preview and is not in the trash; deleting the whole event goes to the 7-day trash.
5. Show tasks and Show chores are off until the person turns them on, remembered per calendar (Personal, or each Home); the overlays show every task status and every chore state, without their own filters (those stay in the Tasks and Chores calendars).
6. Reminders: one per event (at the start, 15 minutes, 1 hour or 1 day before; 08:00 for all-day events), in the `reminders` category. A personal event reminds its owner only, even when shared; a Home event reminds its participants, or its creator without participants.

## Progress

- 4 Nov: brief written; model switched to Opus; branch created.
- 4 Nov: independent review CHANGES_REQUIRED (2 HIGH: shares lost on an edit from a Home calendar; existence check through client ids). Both fixed (shares kept, edit in the personal space; event ids derived from caller and request id); fall-back wording corrected. Open: M2 reminder chain has no sweep, M4 reads expand all events (`reviews/steps/S32-review.md`).
- 4 Nov: Ward kept one step; overlays and reminders added (database, job `calendar-event-reminder`, notification kind `calendar.reminder`, email templates, form, notices).
- 4 Nov: database (`20261118090000_calendar.sql`) and RLS suite (`tests/db/rls/calendar.test.sql`) pass locally; permission engine (`permissions/calendar.ts`), contracts, routes, pages, form, widget, member card, trash labels, nl/en, ADR 0042 and the Playwright spec (`tests/e2e/specs/calendar.spec.ts`) written. Unit, route and component tests pass.

## Files

- Database: `supabase/migrations/20261118090000_calendar.sql`, `tests/db/rls/calendar.test.sql`, `packages/database/src/database.types.ts`.
- Domain: `packages/domain/src/permissions/calendar.ts` (+ test), `home.ts` (capability, actions), `notifications/index.ts` (kind and path).
- Jobs and email: `packages/jobs/src/jobs/calendar.ts` (+ test), services, data port, registry, Trigger.dev task, notification email content; `packages/email/src/notification-messages.ts`.
- Web: `apps/web/src/calendar/*` (schema, shapes, data, api, format, time, route helpers), `apps/web/src/components/calendar/*`, pages under `app/(app)/calendar` and `app/(app)/homes/[homeId]/calendar`, routes under `app/api/v1/calendar` and `app/api/v1/homes/[homeId]/calendar-access`, notifications (server and list), the member page card, dashboard registry, starter and widget wiring, trash labels, nav, i18n.
- Docs: `docs/adr/0042-native-calendar.md`, `plans/roadmap.md`.
