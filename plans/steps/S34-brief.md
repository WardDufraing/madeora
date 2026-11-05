# S34 · Google outbound and conflicts — feature brief

**Branch:** `feat/google-calendar-outbound-conflicts`, from `main` at `c12388a` (S33 merged as PR #65, fix PR #66).
**Sources (read only these):** build plan S34; Modules.md §4.2 (L25–L50: create in the configured target calendar, edits sync, ask-to-resolve conflicts, two-choice deletion with exclusions, three recurrence scopes, provider limits reported honestly); ARCH §31; PS §10 (L2497) and §11.2 (L2532–L2536); ADR 0042 (native calendar), ADR 0043 (S33 connect and inbound sync).
**Model:** Opus (thread verdict 5 Nov 2026: outbound writes, conflict storage with human-only resolution, concurrency with the sync lease, recurrence splits and DST).
**Done when (build plan):** the "Google Calendar" journey passes and no conflict resolves itself.
**Testing rule (Ward, from S34):** locally only format, lint, typecheck and the tests this change touches, output to log files; the full suite runs on GitHub CI after the PR opens.

## Scope

In: creating events from Madeora in a Google calendar (single and repeating), editing Google events from Madeora (title, place, description, time) with the three recurrence scopes, field-level conflict detection with both versions stored until the person chooses, the two-choice deletion ("Remove from Madeora" with an exclusion record and restore, "Delete everywhere" confirmed by Google), honest pending, failed and conflict states, safe retry, DST-correct times and series splits.

Out: Home events written to Google; editing a Google series' repeat rule or attendees from Madeora (shown as "change this in Google Calendar"); push channels (webhooks); account and Home deletion behaviour (S40); Ora and Household Display surfaces (they read through the same functions).

## Model (database)

- `google_calendar_connections.write_calendar_id`: the configured target calendar ("New events go to"), a synced calendar the person can write (Google access role owner or writer). Set to the primary calendar on the first list; cleared when that calendar stops syncing or disappears.
- `private.google_calendar_changes`: one open change per Google event (or per series for series-wide changes): action `create` / `update` / `delete`, scope `event` / `following` / `all`, the new values, the base (the Google version the person edited, with its etag), state `pending` / `conflict` / `failed`, the error code, and for a conflict the Google version and the fields in conflict. Removed once Google confirms.
- `private.google_calendar_exclusions`: "Remove from Madeora" records (one event, a whole series, or a series from one occurrence on), with a title and date for the restore list. The sync keeps storing the event rows; every read leaves excluded ones out, so a resync never shows them again.
- No table granted to an API role. People act through security-definer functions with their own session (owner only); the job through service-role functions that recheck the connection's lease.

## Behaviour

- **Create:** with Google connected and a target set, the new-event form of the Personal calendar offers "Save to": Madeora or a writable synced Google calendar (default: the target). Saving to Google creates the event in Madeora at once (marked "Saving to Google…") and queues it; the job inserts it in Google with an id Madeora chose, so a retry never makes a second event (Google's 409 for an existing id counts as done). Repeating events become an RRULE (daily, weekly on weekdays, monthly with the last-day fallback through `BYMONTHDAY`/`BYSETPOS`, yearly with 29 Feb → 28 Feb, interval, until or count). Timed events are sent as local time plus the IANA zone, so a series keeps its wall-clock time across DST; a time in a DST gap is refused as for native events. Participants, reminders and per-event Home sharing are native-only (a Google event is shared through its calendar's Home shares).
- **Edit (owner only, writable calendar):** this event (single or one occurrence: Google instance patch), this and following (Google series split: the old series gets `UNTIL` just before the occurrence, a new series starts there with the change; refused for a rule with `COUNT` because Google cannot keep the count safely), all events (patch the series; times change the time of day and length, not the date). Moving a series to other days is refused with "change this in Google Calendar". Every scope shows the affected occurrences first (dry run). The page carries the etag the person saw; a newer one answers "changed meanwhile, reload".
- **Conflicts (field-level):** fields are title, place, description and time. When Google changed the event since the base and the person's change is still open, fields changed on only one side merge automatically; a field changed on both sides to different values is a conflict. Nothing is overwritten: the change goes to `conflict` with both versions, the event shows "Changed in Madeora and in Google Calendar", and only the owner chooses "Keep Madeora's version" or "Keep Google's version". Deleted in Google while edited in Madeora: "Restore in Google" or "Accept the deletion". Edited in Google while "Delete everywhere" waits: "Delete anyway" or "Keep the event". A chosen Madeora version is sent with Google's current etag, so another Google change in between makes a new conflict instead of an overwrite. Conflicts are never resolved by the job, a timer or a retry. While in conflict an event is shown with the stricter of the two Google privacy flags, so a Home never sees a version made private.
- **Delete:** "Remove from Madeora" writes an exclusion (no Google call) and hides the event from every Madeora view; Settings lists hidden events with Restore. "Delete everywhere" asks for confirmation naming the Google calendar, keeps the event visible as "Deleting from Google…" until Google confirms, and on failure shows "Couldn't delete in Google" with Try again or Remove from Madeora instead; never a silent local-only fallback. Scopes as for edit.
- **States per event:** synced, saving (pending), deleting, conflict, failed (with the reason: no permission in Google, event gone, Google unavailable, authorization expired, provider limitation). Failed changes offer Try again and Discard my change (the event returns to Google's version). The calendar states of S33 add "N changes waiting" for the owner.
- **Job:** the existing `google-calendar-sync` run pushes open changes first (inside the lease, with `If-Match` etags), then pulls. On 412 it reads the event and merges or stores a conflict; 404/410 on update is "deleted in Google"; 404/410 on delete is done; 401 ends as authorization expired (changes wait); 5xx/429/network leave the change pending with a code for the next run; 403/400 fail it. A change made while a run holds the lease queues a follow-up run when that run ends. Making a change queues a run (at most one waiting run per connection).
- **Settings:** "New events go to" (writable synced calendars or Madeora only); turning a calendar's sync off is refused while it has open changes (the page says why); disconnect warns how many changes are not yet in Google and drops them.

## Defaults picked (Ward may override)

1. An event saved to Google is a Google event shown in Madeora (Google holds it; Madeora shows and edits it), not a native event with a Google copy. So participants, reminders and per-event Home sharing stay native-only; Google's own reminders apply.
2. Only personal events go to Google; Home calendar events stay in Madeora.
3. The target calendar defaults to the primary calendar; "Madeora only" is an option.
4. "Remove from Madeora" hides the event everywhere in Madeora, including the Homes that see its calendar.
5. Conflicts are detected per field (title, place, description, time) and resolved per event with two choices.
6. Series limits reported, not guessed: this-and-following is refused for counted series, and moving a series to other days or changing its repeat rule is done in Google.

## Acceptance tests

- RLS (`tests/db/rls/google-calendar-outbound.test.sql`): no new table reachable; only the owner creates, edits, deletes, resolves, retries, discards, restores; Home members and strangers get `not_found` for forged ids; read-only calendars refuse; stale etag refused; one open change per event, merged edits; apply during a pending change: unchanged etag skipped, disjoint fields merged, same field → conflict with both versions, cancellation → deleted-in-Google conflict, delete+cancel → done; a conflict never changes state through apply, finish or a later page; keep-Google applies Google's version; keep-Madeora requeues with Google's etag; exclusions hide in every read (list, upcoming, event page, Home) and survive a full resync; restore shows again; privacy flag stricter in conflict; job functions service-role only and lease-checked; sync-off refused with open changes.
- Unit (`packages/google-calendar`): RRULE building (all frequencies, last-day fallback, 29 Feb, until for timed across DST, count), UNTIL for splits (timed in UTC across DST, all-day), series shift of time of day, field diff/merge; the push engine with a fake Google: create with chosen id and 409, patch with If-Match, 412 merge vs conflict, 404 on update and delete, 403 failed, 5xx pending, 401 expiry, split and truncate, count refused.
- Routes: create, update (scopes, dry run), delete (destinations), resolve, retry, discard, restore, write target; signed in, same-origin, validation.
- Component: event page states (pending, conflict with both versions, failed), delete dialog with the two choices, form target choice.
- Playwright: the Google Calendar journey with a seeded connection (CI never contacts Google): create to Google shows "Saving to Google", a Google-side change arrives, an edit on both sides shows the conflict and stays unresolved until a choice, Remove from Madeora hides it and Restore brings it back.

## Progress

- 5 Nov: brief written; model switched to Opus; branch created.
- 5 Nov: independent review CHANGES_REQUIRED (2 high, 6 medium, 7 low, `reviews/steps/S34-review.md`); both highs, five mediums and four lows fixed with tests, verified locally.
- 5 Nov: migration, push engine, recurrence, job wiring, routes, UI, tests and docs built. Local checks (format, lint, typecheck; the google-calendar package and jobs tests; both Google DB test files; the web route, component and i18n tests) pass. Full suite, build and Playwright run on CI.

## Built differently from the plan above

- Playwright covers edit (pending), a seeded conflict that stays until "Keep Google's version", and "Remove from Madeora" on a read-only calendar. CI has no Google client, so the Settings page says "not available" and the new-event form offers no Google target there: creating to Google and Restore are covered by route, component and database tests instead.
- A failed "Delete everywhere" offers Try again and Discard (keeps the event); "Remove from Madeora" stays available from Delete.
- Disconnect's confirmation says waiting changes are lost, without the count.
- Single-event edits save at once; only series scopes show the affected occurrences first. A series change shows in Madeora after Google has it.
- After the review: a new repeating event cannot be edited while it waits for Google; "Keep Madeora's version" of a series Google deleted fails with the reason (no series recreation); a split at the first occurrence replaces the old series.
- Open for Ward: a calendar Google stops listing drops its waiting changes and conflicts (its events already leave Madeora in S33).
- `graphify` is not installed in this environment, so the graph was not rebuilt.

## Files

- `supabase/migrations/20261120090000_google_calendar_outbound.sql`; `tests/db/rls/google-calendar-outbound.test.sql`
- `packages/google-calendar/src/{recurrence,push}.ts` (+ tests), `client.ts`, `sync.ts`, `index.ts`, `sync.test.ts`
- `packages/jobs/src/google-sync-store.ts`, `testing/fake-services.ts`, `jobs/google-calendar.test.ts`; `packages/database/src/database.types.ts`
- Routes: `apps/web/src/app/api/v1/calendar/google-events/route.ts`, `[eventId]/route.ts`, `google-events.test.ts`; `integrations/google-calendar/{target,changes/[changeId],hidden/[exclusionId]}/route.ts`, `calendars/[calendarId]/route.ts`
- Web: `google-calendar/{api,schema,shapes,data,route-helpers}.ts`, `calendar/{shapes,testing,time}.ts`; `components/google-calendar/{google-event-actions,google-event-form,google-edit-page,google-event-page,google-calendar-actions}.tsx` (+ `google-event-actions.test.tsx`); `components/calendar/{event-form,event-pages,calendar-view,upcoming-events-widget}.tsx`; `app/(app)/calendar/google/[eventId]/edit/page.tsx`, `settings/google-calendar/page.tsx`; `i18n/messages/{en,nl}.json`, `i18n/messages.test.ts`
- E2E: `tests/e2e/specs/google-calendar.spec.ts`
- Docs: `docs/adr/0044-google-calendar-outbound-conflicts.md`, `docs/google-calendar-setup.md`, `docs/supabase-migrations.md`, `docs/background-jobs.md`, `plans/roadmap.md`, `plans/steps/S34-brief.md`
