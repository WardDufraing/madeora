# S33 · Google Calendar connect and inbound sync — feature brief

**Branch:** `feat/google-calendar-connect`, from `main` at `1cbc01f` (S32 merged as PR #64).
**Sources (read only these):** build plan S33; ARCH §31 (Google Calendar integration); Modules.md §4.2 (L25–L50: selected calendars, per-calendar personal and per-Home visibility, unshared events invisible, honest failures) and §4.8 (L178–L182: states shown honestly, native features keep working); PS L2474–L2486 (journey 7: lose authorization, still see native events plus a truthful warning), L2532–L2536 (§11.2 calendar privacy), L931 and L935 (stale sources named with last refresh time); ADR 0042 (native calendar: every reader goes through its functions), ADR 0017 (background jobs).
**Model:** Opus (thread verdict 5 Nov 2026: OAuth tokens, encryption at rest, RLS privacy, idempotent sync jobs).
**Done when (build plan):** tests cover revoked consent, invalid sync token resync and duplicate prevention.

## Scope

In: connecting one Google account per person through Google OAuth (separate from Google sign-in), encrypted refresh tokens, the list of that account's calendars, choosing per calendar whether it syncs, whether it shows on the personal calendar and which of the person's Homes see it, automatic inbound sync (incremental with sync tokens, full resync on an invalid token, a daily full refresh), sync states, Sync now, disconnect, and Google events shown read-only on the personal and Home calendars, the event page and the Upcoming events widget.

Out (S34): writing to Google (create, edit, delete), conflicts, "Remove from Madeora" exclusions, recurrence-scope edits of Google events. Out (later): push notification channels (webhooks), account and Home deletion behaviour (S40), Ora and Household Display surfaces (they read through the same functions).

## Actors and permissions

- **The person who connects** owns the connection, its calendars and their events. Only they see the connection, the calendar list, the settings and the sync state details. Nobody else (Home Owner, staff) can read, change or disconnect it.
- **Home members** see the events of a calendar only after its owner shared that calendar with their Home, in that Home's calendar only, read-only, with the owner named ("Shared by"). A share is tied to the owner's membership, so leaving the Home ends it. Events marked private or confidential in Google are never shown in a Home, only to the owner.
- Unshared calendars and their events reveal nothing to anyone else: no event, time, busy block, count, calendar name or sync state (§11.2, enforced in the database functions).

## Model

- `private.google_calendar_connections`: one row per person (the account's primary calendar id as its label, the encrypted refresh token, granted scopes, `connected` or `authorization_expired`, last sync times and error code, a sync lease).
- `private.google_calendars`: the account's calendars (Google id, name, timezone, access role, primary), with `sync_enabled`, `show_personal`, the sync token, last sync and full refresh times, error code, and whether Google still lists it.
- `private.google_calendar_home_shares`: calendar × Home, keyed to the owner's membership (cascade on leave).
- `private.google_calendar_events`: one row per Google event instance (`singleEvents`), unique per calendar and Google id (duplicate prevention), with etag, Google `updated`, title, location, description, all-day dates (inclusive end) or instants with a timezone, recurring event id, original start, Google visibility, link, and the last-synced snapshot fields S34 compares against.
- No table is granted to an API role; people use security-definer functions with their own session; the sync job uses service-role-only functions that recheck the connection and lease.

## Behaviour

- **Connect:** Settings › Google Calendar › Connect (form POST, same-origin) creates a 10-minute state and PKCE verifier in an encrypted, httpOnly cookie bound to the person, and sends them to Google with the scopes `calendar.calendarlist.readonly` and `calendar.events` (narrowest pair for reading the list and reading and later writing events), offline access and consent. The callback checks the state, the person and the cookie, exchanges the code, requires both scopes, reads the primary calendar id, encrypts the refresh token (AES-256-GCM, the person's id as associated data) and stores it with their session. Reconnecting the same account keeps the calendar choices; another account replaces the old connection. Signing in with Google never connects a calendar.
- **After connecting:** the primary calendar syncs and shows on the personal calendar; no other calendar syncs and nothing is shared with any Home until the person chooses.
- **Sync:** the outbox job `google-calendar-sync` (one per connection) refreshes an access token (kept in memory only), refreshes the calendar list, then syncs each chosen calendar: incremental with its sync token; a full pass (window 30 days back to 365 days ahead, instances expanded) when there is no token, Google answers 410 (invalid token), or the last full pass is over 24 hours old; the full pass deletes rows it did not see. Pages are applied idempotently (upsert on calendar + Google id; cancelled instances and series removed). It is queued on connect, when a calendar is turned on, by Sync now (at most once a minute) and by the outbox dispatcher every 15 minutes for every connected account; a lease stops two runs on one connection.
- **States:** `connected` with each calendar `syncing` (waiting for its first or requested sync), `synced`, `stale` (no successful sync for over an hour), `failed` (with a code) or the whole connection `authorization_expired` (refresh refused: revoked consent, expired testing-mode token). Never shown as synced when it is not. Calendars show a warning naming the calendar and the last successful sync; Home members see only "not up to date" and the time for a shared calendar, not the reason.
- **Authorization expired:** syncing stops, the last-synced events stay visible with the warning, the person gets one in-app notice and a Reconnect button. Native events are never affected.
- **Disconnect:** revokes the token at Google (best effort; the page says when Google could not be reached and links to Google's permissions page), then deletes the connection, its calendars, shares and events.
- **Turning a calendar's sync off** deletes its events, its sync token and its Home shares.

## Limits

20 synced calendars per connection, 5000 events per calendar (more: `failed` with `too_many_events`), title 200, location 200, description 4000 characters (longer Google text is cut).

## Acceptance tests

- RLS (`tests/db/rls/google-calendar.test.sql`): no table reachable; only the owner reads the connection; unshared calendar events invisible in every read (Personal of others, Home, upcoming, event page, forged ids); shared calendar visible to that Home only, read-only, private Google events never in a Home; leaving the Home ends the share; job functions service-role only; lease refuses a second run; full pass removes unseen rows; repeated pages create no duplicates; cancelled instances removed; authorization expired keeps events and reports the state; sync off deletes events; disconnect deletes everything.
- Unit (`packages/google-calendar`): token encryption (tamper, wrong person, wrong key), OAuth URL and state cookie, code exchange errors, event normalisation (all-day exclusive end, timezones, cut text, cancelled); the sync engine with a fake Google: incremental, 410 → full resync, duplicate pages, revoked consent (`invalid_grant`), calendar gone (404), too many events, retryable outage.
- Routes: connect (same-origin, signed in, not configured), callback (bad state, other person, denied, missing scope, no refresh token, success).
- Component: settings page states, calendar warning, Google occurrences in the calendar and widget.
- Playwright: Settings shows Google Calendar as not available when it is not configured, and the calendar keeps working (CI never contacts Google).

## Defaults picked (Ward may override)

1. A separate Google Cloud project "Madeora Calendar" in Testing mode, so the sign-in project never shows Google's unverified-app warning. In Testing, Google ends refresh tokens after 7 days: you reconnect weekly until the app is verified (before public launch, ARCH §31).
2. Polling every 15 minutes (through the existing 5-minute outbox dispatcher, no extra Trigger.dev schedule); push notification channels are left for later.
3. One Google account per person.
4. After connecting: the primary calendar syncs and shows on the personal calendar; nothing is shared with a Home until chosen.
5. Authorization expired: the last-synced events stay visible with a warning (not hidden).
6. Disconnect deletes the imported events and choices; reconnecting starts from the defaults again.

## Progress

- 5 Nov: brief written; model switched to Opus; branch created.
- 5 Nov: database, `@madeora/google-calendar`, the sync job, the web routes, settings page, calendar views, messages (en/nl), notification kind, tests and docs built.
- 5 Nov: full suite run; independent review CHANGES_REQUIRED (1 HIGH lint, 3 MEDIUM); all HIGH and MEDIUM and four LOW fixed and verified (`reviews/steps/S33-review.md`). Waiting for Ward's consent to commit, push and open the PR.

## Files

- Database: `supabase/migrations/20261119090000_google_calendar.sql`, `tests/db/rls/google-calendar.test.sql`, `packages/database/src/database.types.ts`.
- Package `packages/google-calendar/` (config, crypto, normalize, client, sync, tests).
- Jobs: `packages/jobs/src/jobs/google-calendar.ts` (+ test), `google-sync-store.ts`, `services.ts`, `supabase-data.ts`, `registry.ts`, `local.ts`, `testing/fake-services.ts`, `trigger/{tasks,services,run}.ts`.
- Web: `apps/web/src/google-calendar/*`, `app/api/v1/integrations/google-calendar/**` (+ route tests), `app/api/v1/calendar/google-events/[eventId]`, `app/(app)/settings/google-calendar`, `app/(app)/calendar/google/[eventId]`, `app/(app)/homes/[homeId]/calendar/google/[eventId]`, `components/google-calendar/*` (+ tests), `calendar/{shapes,format,testing}.ts`, `components/calendar/{calendar-view,upcoming-events-widget}.tsx`, `components/notifications/notification-list.tsx`, settings card, `env/validate.ts`, messages.
- Domain: `packages/domain/src/notifications/index.ts` (+ test): kind `google_calendar.authorization_expired`.
- E2E: `tests/e2e/specs/google-calendar.spec.ts`.
- Docs: `docs/adr/0043-google-calendar-connect.md`, `docs/google-calendar-setup.md`, `docs/background-jobs.md`, `docs/provider-cost-register.md`, `docs/supabase-migrations.md`, `.env.example` (web, jobs), `plans/roadmap.md`.
