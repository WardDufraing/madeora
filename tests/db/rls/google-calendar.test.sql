-- S33: Google Calendar connect and inbound sync (supabase/migrations/*_google_calendar.sql). Alice owns Home A,
-- where Bob is an Administrator and Carol a Member; Bob owns Home B.
-- Covers: nothing reachable as a table, the job functions closed to people; only the owner reads, changes or
-- disconnects a connection; the privacy rule (an unshared calendar reveals nothing to anyone else in the
-- calendar, the widget, the event page, the warnings or forged ids; a shared calendar shows in that Home only,
-- read-only, without events private in Google; leaving the Home ends the share); the lease (one run at a
-- time, nothing applied without it); duplicate prevention (repeated pages, repeated ids in a page, a full
-- pass); cancelled instances and series; the full pass removing what it did not see; an invalid sync token
-- clearing the token for a full resync; calendars Google no longer lists; revoked consent (authorization
-- expired: events kept, warnings, one notice, no more runs, reconnect); the automatic queue; turning sync off;
-- disconnect and replacing the account; malformed input.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');
insert into ids select n, gen_random_uuid() from unnest(array['lease-1', 'lease-2', 'lease-3', 'lease-4',
  'lease-5', 'lease-6', 'lease-7', 'lease-8', 'lease-b', 'lease-c']) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.conn(p_user text) returns uuid
  language sql stable security definer as $$
  select id from private.google_calendar_connections where user_id = tests.user_id(p_user); $$;
create function tests.cal(p_user text, p_google_id text) returns uuid
  language sql stable security definer as $$
  select c.id from private.google_calendars c where c.user_id = tests.user_id(p_user) and c.google_calendar_id = p_google_id; $$;
create function tests.gevent(p_google_id text) returns uuid
  language sql stable security definer as $$
  select id from private.google_calendar_events where google_event_id = p_google_id; $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
-- A token in the stored shape (the real one is encrypted by the app).
create function tests.token(p_seed text) returns text
  language sql immutable as $$
  select 'v1.' || rpad(p_seed, 16, 'x') || '.' || rpad(p_seed, 40, 'c') || '.' || rpad(p_seed, 22, 't'); $$;
-- The titles a caller sees in a context over December 2026.
create function tests.titles(p_home text) returns text[]
  language plpgsql as $$
  begin
    return (select coalesce(array_agg(o ->> 'title' order by n), '{}')
      from jsonb_array_elements(public.list_calendar(date '2026-12-01', date '2026-12-31', tests.i(p_home),
        'Europe/Brussels') -> 'occurrences') with ordinality as a(o, n));
  end $$;
create function tests.warnings(p_home text) returns jsonb
  language plpgsql as $$
  begin
    return public.list_calendar(date '2026-12-01', date '2026-12-31', tests.i(p_home), 'Europe/Brussels') -> 'googleWarnings';
  end $$;
-- Events in the shape packages/google-calendar normalizeEvent produces.
create function tests.timed(p_id text, p_title text, p_from timestamptz, p_to timestamptz, p_extra jsonb default '{}')
returns jsonb
  language sql immutable as $$
  select jsonb_build_object('id', p_id, 'etag', '"' || p_id || '-1"', 'updated', '2026-11-01T10:00:00Z',
    'status', 'confirmed', 'title', p_title, 'allDay', false, 'startsAt', p_from, 'endsAt', p_to,
    'timeZone', 'Europe/Brussels', 'private', false, 'link', 'https://www.google.com/calendar/event?eid=' || p_id) || p_extra; $$;
create function tests.all_day(p_id text, p_title text, p_from date, p_to date) returns jsonb
  language sql immutable as $$
  select jsonb_build_object('id', p_id, 'etag', '"' || p_id || '-1"', 'status', 'confirmed', 'title', p_title,
    'allDay', true, 'startsOn', p_from, 'endsOn', p_to, 'private', false); $$;
grant execute on function tests.i(text), tests.conn(text), tests.cal(text, text), tests.gevent(text),
  tests.private_count(text), tests.token(text), tests.titles(text), tests.warnings(text),
  tests.timed(text, text, timestamptz, timestamptz, jsonb), tests.all_day(text, text, date, date)
  to authenticated, service_role;

-- Nothing is reachable as a table; the job functions are the service role's ------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.google_calendar_connections', 'The API cannot read connections');
select tests.assert_denied('select * from private.google_calendars', 'Nor calendars');
select tests.assert_denied('select * from private.google_calendar_home_shares', 'Nor shares');
select tests.assert_denied('select * from private.google_calendar_events', 'Nor events');
select tests.assert_denied($$select private.google_context_events(tests.user_id('alice'), null)$$, 'Nor the helpers');
select tests.assert_denied($$select private.queue_google_calendar_sync(gen_random_uuid(), 'x')$$, 'Nor the queue helper');
select tests.assert_denied($$select public.google_sync_begin(gen_random_uuid(), gen_random_uuid(), 60)$$,
  'A person cannot start a sync run');
select tests.assert_denied($$select public.google_sync_apply_events(gen_random_uuid(), gen_random_uuid(), true, '[]')$$,
  'Nor write events');
select tests.assert_denied($$select public.google_sync_calendars(gen_random_uuid(), gen_random_uuid(), '[]')$$,
  'Nor write the calendar list');
select tests.assert_denied($$select public.google_sync_finish_calendar(gen_random_uuid(), gen_random_uuid(), true, 't', null)$$,
  'Nor end a calendar''s pass');
select tests.assert_denied($$select public.google_sync_finish(gen_random_uuid(), gen_random_uuid(), 'ok')$$,
  'Nor end a run');
select tests.assert_denied($$select public.queue_google_calendar_syncs(10)$$, 'Nor queue the automatic sync');
select tests.act_as_anon();
select tests.assert_denied($$select public.get_google_calendar_connection()$$, 'Nobody signed out reads a connection');
select tests.assert_denied($$select public.save_google_calendar_connection('a@b.c', tests.token('a'), array['x'])$$,
  'Nor stores one');

-- Connecting ------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(public.get_google_calendar_connection() is null, 'Alice has no connection yet');
select tests.assert_denied($$select public.save_google_calendar_connection('alice@gmail.com', 'plain-token', array['x'])$$,
  'A token that is not in the encrypted shape is refused', '22023');
select tests.assert_true(public.save_google_calendar_connection('alice@gmail.com', tests.token('a'),
  array['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'])
  = 'connected', 'Alice connects her Google account');
select tests.assert_true((public.get_google_calendar_connection() ->> 'status') = 'connected'
  and (public.get_google_calendar_connection() ->> 'syncQueued')::boolean
  and not (public.get_google_calendar_connection() ? 'token')
  and position(tests.token('a') in public.get_google_calendar_connection()::text) = 0,
  'She sees it connected, a sync queued, and never the token');
select tests.assert_true(public.request_google_calendar_sync() = 'too_soon', 'Sync now waits a minute after the queued run');
select tests.act_as('carol');
select tests.assert_true(public.get_google_calendar_connection() is null, 'Carol does not see Alice''s connection');
select tests.assert_true(public.request_google_calendar_sync() = 'not_connected', 'Nor can she sync it');
select tests.assert_true(public.disconnect_google_calendar() is null, 'Nor disconnect it');
select tests.act_as_owner();
select tests.assert_true(tests.private_count($$select count(*) from private.job_outbox
  where job_name = 'google-calendar-sync' and payload ->> 'connectionId' = '$$ || tests.conn('alice') || $$'$$) = 1,
  'Connecting queued one sync run, with the connection id only');
select tests.act_as('alice');
select tests.assert_true(public.save_google_calendar_connection('alice@gmail.com', tests.token('a'),
  array['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'])
  = 'reconnected', 'Connecting the same account again at once is a reconnect');
select tests.act_as_owner();
select tests.assert_true(tests.private_count($$select count(*) from private.job_outbox
  where job_name = 'google-calendar-sync' and payload ->> 'connectionId' = '$$ || tests.conn('alice') || $$'$$) = 1,
  'But it queues no second run within the minute (calling it in a loop cannot flood the job queue)');

-- The sync run: the lease and the calendar list -----------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-1'), 300) ->> 'token') = tests.token('a'),
  'The job starts a run and receives the encrypted token');
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-2'), 300) ->> 'outcome') = 'busy',
  'A second run on the same connection is refused while the lease holds');
select tests.assert_true((public.google_sync_begin(gen_random_uuid(), tests.i('lease-2'), 300) ->> 'outcome') = 'missing',
  'An unknown connection is missing');
select tests.assert_true(public.google_sync_calendars(tests.conn('alice'), tests.i('lease-2'), '[]') is null,
  'Nothing is applied without the lease');
select tests.assert_denied($$select public.google_sync_calendars(tests.conn('alice'), tests.i('lease-1'), '[{"id": 1}]')$$,
  'A malformed calendar list is refused', '22023');
select tests.assert_true(jsonb_array_length(public.google_sync_calendars(tests.conn('alice'), tests.i('lease-1'), jsonb_build_array(
    jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'timeZone', 'Europe/Brussels', 'accessRole', 'owner', 'primary', true),
    jsonb_build_object('id', 'family@group.calendar.google.com', 'name', 'Familie', 'accessRole', 'writer'),
    jsonb_build_object('id', 'busy@group.calendar.google.com', 'name', 'Druk', 'accessRole', 'freeBusyReader')))) = 1,
  'On the first list only the primary calendar syncs');
select tests.assert_true((public.google_sync_calendars(tests.conn('alice'), tests.i('lease-1'), jsonb_build_array(
    jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'accessRole', 'owner', 'primary', true),
    jsonb_build_object('id', 'family@group.calendar.google.com', 'name', 'Familie', 'accessRole', 'writer'),
    jsonb_build_object('id', 'busy@group.calendar.google.com', 'name', 'Druk', 'accessRole', 'freeBusyReader'))) -> 0 ->> 'fullDue')::boolean,
  'Listing again changes nothing, and the first pass is a full one');

-- Events: duplicate prevention ---------------------------------------------------------------------------------

select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-1'), true, jsonb_build_array(
    tests.timed('ev-dentist', 'Tandarts', '2026-12-03 09:00+01', '2026-12-03 10:00+01'),
    tests.all_day('ev-trip', 'Reis', date '2026-12-10', date '2026-12-12'),
    tests.timed('ev-secret', 'Geheim', '2026-12-04 20:00+01', '2026-12-04 21:00+01', '{"private": true}'),
    tests.timed('series_20261205', 'Yoga', '2026-12-05 18:00+01', '2026-12-05 19:00+01', '{"recurringEventId": "series"}'),
    tests.timed('series_20261212', 'Yoga', '2026-12-12 18:00+01', '2026-12-12 19:00+01', '{"recurringEventId": "series"}'))) = 5,
  'A page of five events is stored');
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-1'), true, jsonb_build_array(
    tests.timed('ev-dentist', 'Tandarts', '2026-12-03 09:00+01', '2026-12-03 10:00+01'),
    tests.timed('ev-dentist', 'Tandarts', '2026-12-03 09:00+01', '2026-12-03 10:00+01'),
    tests.all_day('ev-trip', 'Reis', date '2026-12-10', date '2026-12-12'))) = 5,
  'The same page again, and an id twice in one page, create no duplicates');
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'family@group.calendar.google.com'), tests.i('lease-1'), true, '[]') is null,
  'A calendar that does not sync takes no events');
select tests.assert_denied($$select public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-1'), true,
    jsonb_build_array(jsonb_build_object('id', 'bad', 'status', 'confirmed', 'allDay', false, 'startsAt', 'not a time')))$$,
  'A malformed event refuses the page', '22023');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-1'), true, 'token-1', null),
  'The full pass ends with a sync token');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendar_events$$) = 5,
  'Still exactly five events after the full pass');
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-1'), 'ok'), 'The run ends');
select tests.assert_true(not public.google_sync_finish(tests.conn('alice'), tests.i('lease-1'), 'ok'),
  'Its lease is released, so a late repeat changes nothing');

-- Privacy: unshared calendars reveal nothing -----------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.titles(null) = array['Tandarts', 'Geheim', 'Yoga', 'Reis', 'Yoga'],
  'Alice sees her Google events on her personal calendar, in time order');
select tests.assert_true((public.list_calendar(date '2026-12-01', date '2026-12-31', null, 'Europe/Brussels')
  -> 'occurrences' -> 0 ->> 'source') = 'google'
  and (public.list_calendar(date '2026-12-01', date '2026-12-31', null, 'Europe/Brussels') -> 'occurrences' -> 0 ->> 'calendar') = 'Alice',
  'Marked as Google events, with the calendar name');
select tests.assert_true(tests.titles('home-a') = '{}', 'Home A shows none of them before she shares');
select tests.assert_true(jsonb_array_length(tests.warnings(null)) = 0, 'Her synced calendar raises no warning');
select tests.assert_true((public.get_google_calendar_event(tests.gevent('ev-dentist')) ->> 'link') like 'https://www.google.com/%',
  'Her event page has the Google link');
select tests.assert_true(public.get_google_calendar_event(tests.gevent('ev-dentist'), tests.i('home-a')) is null,
  'Not through Home A');

select tests.act_as('carol');
select tests.assert_true(tests.titles(null) = '{}' and tests.titles('home-a') = '{}',
  'Carol sees nothing of Alice''s calendar, personally or in Home A');
select tests.assert_true(jsonb_array_length(public.get_calendar_upcoming(30, 10, tests.i('home-a')) -> 'occurrences') = 0
  and jsonb_array_length(tests.warnings('home-a')) = 0,
  'Not in the widget, and no warning or calendar name hints at it');
select tests.assert_true(public.get_google_calendar_event(tests.gevent('ev-dentist')) is null
  and public.get_google_calendar_event(tests.gevent('ev-dentist'), tests.i('home-a')) is null,
  'A forged event id answers like one that does not exist');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'alice@gmail.com'), true, true,
  array[tests.i('home-a')]) = 'not_found', 'She cannot share Alice''s calendar');
select tests.act_as('bob');
select tests.assert_true(public.get_google_calendar_event(tests.gevent('ev-dentist'), tests.i('home-b')) is null,
  'Bob sees nothing through his own Home either');

-- Sharing with a Home ----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'alice@gmail.com'), true, true,
  array[tests.i('home-b')]) = 'invalid_home', 'Alice cannot share with a Home she is not in');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'busy@group.calendar.google.com'), true, false,
  '{}') = 'unavailable', 'A busy-only calendar cannot sync');
select tests.assert_denied($$select public.set_google_calendar_settings(tests.cal('alice', 'alice@gmail.com'), false, true, '{}')$$,
  'A calendar that does not sync cannot show anywhere', '22023');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'alice@gmail.com'), true, true,
  array[tests.i('home-a')]) = 'saved', 'Alice shares her calendar with Home A');
select tests.assert_true((public.get_google_calendar_connection() -> 'calendars' -> 0 -> 'homes') = jsonb_build_array(tests.i('home-a')),
  'Her settings show the share');
select tests.act_as('carol');
select tests.assert_true(tests.titles('home-a') = array['Tandarts', 'Yoga', 'Reis', 'Yoga'],
  'Carol sees the shared events in Home A, without the one private in Google');
select tests.assert_true(tests.titles(null) = '{}', 'And still nothing on her personal calendar');
select tests.assert_true((public.list_calendar(date '2026-12-01', date '2026-12-31', tests.i('home-a'))
  -> 'occurrences' -> 0) @> jsonb_build_object('kind', 'shared', 'sharedBy', tests.i('m-alice-a'), 'source', 'google'),
  'Shown as Alice''s shared Google event');
select tests.assert_true((public.get_google_calendar_event(tests.gevent('ev-dentist'), tests.i('home-a')) ->> 'title') = 'Tandarts'
  and (public.get_google_calendar_event(tests.gevent('ev-dentist'), tests.i('home-a')) -> 'link') = 'null'::jsonb,
  'She can open it, without Alice''s Google link');
select tests.assert_true(public.get_google_calendar_event(tests.gevent('ev-secret'), tests.i('home-a')) is null,
  'The event private in Google stays hidden, also by id');
select tests.act_as('bob');
select tests.assert_true(tests.titles('home-b') = '{}', 'Home B shows nothing of it');

-- Incremental changes: cancelled instances and series --------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-3'), 300) ->> 'outcome') = 'ok',
  'A new run starts once the lease is free');
select tests.assert_true((public.google_sync_calendars(tests.conn('alice'), tests.i('lease-3'), jsonb_build_array(
    jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'accessRole', 'owner', 'primary', true),
    jsonb_build_object('id', 'family@group.calendar.google.com', 'name', 'Familie', 'accessRole', 'writer'))) -> 0) @>
  '{"syncToken": "token-1", "fullDue": false}', 'The next pass is incremental, from the stored token');
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), false, jsonb_build_array(
    jsonb_build_object('id', 'ev-dentist', 'cancelled', true),
    jsonb_build_object('id', 'series', 'cancelled', true),
    tests.all_day('ev-trip', 'Reis naar zee', date '2026-12-10', date '2026-12-12') || '{"etag": "\"ev-trip-2\""}')) = 2,
  'A cancelled event and a cancelled series are removed, a changed one updated');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), false, 'token-2', null),
  'The pass stores the next token');
select tests.act_as('carol');
select tests.assert_true(tests.titles('home-a') = array['Reis naar zee'], 'Home A shows the change');

-- A full pass removes what Google no longer has; an invalid token starts a full resync ---------------------------

select tests.act_as_service_role();
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), true, jsonb_build_array(
    tests.all_day('ev-trip', 'Reis naar zee', date '2026-12-10', date '2026-12-12') || '{"etag": "\"ev-trip-2\""}')) = 2,
  'A full pass sees only the trip');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), true, 'token-3', null),
  'The full pass ends');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendar_events$$) = 1,
  'Ending it removes the event it did not see');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), false, null,
  'sync_token_invalid'), 'Google answered that the token is no longer valid');
select tests.assert_true((public.google_sync_calendars(tests.conn('alice'), tests.i('lease-3'), jsonb_build_array(
    jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'accessRole', 'owner', 'primary', true),
    jsonb_build_object('id', 'family@group.calendar.google.com', 'name', 'Familie', 'accessRole', 'writer'))) -> 0) @>
  '{"syncToken": null, "fullDue": true}', 'The token is cleared, so the next pass is a full resync');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendar_events$$) = 1,
  'The events stay until that full pass replaces them');
select tests.act_as('alice');
select tests.assert_true((tests.warnings(null) -> 0 ->> 'state') = 'failed', 'Alice is told the calendar failed to sync');
select tests.act_as('carol');
select tests.assert_true((tests.warnings('home-a') -> 0) @> jsonb_build_object('state', 'out_of_date', 'calendar', 'Alice',
  'own', false, 'sharedBy', tests.i('m-alice-a')), 'Carol sees only that the shared calendar is not up to date');
select tests.act_as_service_role();
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), true, jsonb_build_array(
    tests.all_day('ev-trip', 'Reis naar zee', date '2026-12-10', date '2026-12-12') || '{"etag": "\"ev-trip-2\""}',
    tests.timed('ev-new', 'Etentje', '2026-12-20 19:00+01', '2026-12-20 22:00+01'))) = 2,
  'The full resync stores both events once');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-3'), true, 'token-4', null),
  'And ends');
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-3'), 'ok'), 'The run ends');
select tests.act_as('alice');
select tests.assert_true(jsonb_array_length(tests.warnings(null)) = 0, 'The warning is gone');

-- Stale ---------------------------------------------------------------------------------------------------------

select tests.act_as_owner();
update private.google_calendars set last_synced_at = now() - interval '2 hours' where id = tests.cal('alice', 'alice@gmail.com');
select tests.act_as('alice');
select tests.assert_true((tests.warnings(null) -> 0) @> jsonb_build_object('state', 'stale', 'own', true),
  'A calendar not synced for over an hour is stale, never shown as synced');
select tests.act_as_owner();
update private.google_calendars set last_synced_at = now() where id = tests.cal('alice', 'alice@gmail.com');

-- A calendar Google no longer lists -----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'family@group.calendar.google.com'), true, false,
  array[tests.i('home-a')]) = 'saved', 'Alice turns on the family calendar, shared with Home A only');
select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-4'), 300) ->> 'outcome') = 'ok', 'A run starts');
select tests.assert_true(jsonb_array_length(public.google_sync_calendars(tests.conn('alice'), tests.i('lease-4'), jsonb_build_array(
    jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'accessRole', 'owner', 'primary', true),
    jsonb_build_object('id', 'family@group.calendar.google.com', 'name', 'Familie', 'accessRole', 'writer')))) = 2,
  'Both calendars sync');
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'family@group.calendar.google.com'), tests.i('lease-4'), true,
    jsonb_build_array(tests.timed('fam-1', 'Kerstdiner', '2026-12-25 18:00+01', '2026-12-25 23:00+01'))) = 1,
  'The family calendar gets its event');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'family@group.calendar.google.com'), tests.i('lease-4'), true, 'f-1', null),
  'Its pass ends');
select tests.act_as('alice');
select tests.assert_true(not ('Kerstdiner' = any (tests.titles(null))), 'It does not show on her personal calendar (not chosen)');
select tests.act_as('carol');
select tests.assert_true('Kerstdiner' = any (tests.titles('home-a')), 'It shows in Home A');
select tests.act_as_service_role();
select tests.assert_true(jsonb_array_length(public.google_sync_calendars(tests.conn('alice'), tests.i('lease-4'), jsonb_build_array(
    jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'accessRole', 'owner', 'primary', true)))) = 1,
  'Google no longer lists the family calendar');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendar_events where google_event_id = 'fam-1'$$) = 0
  and tests.private_count($$select count(*) from private.google_calendar_home_shares where calendar_id = '$$
    || tests.cal('alice', 'family@group.calendar.google.com') || $$'$$) = 0,
  'Its events and shares are removed');
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-4'), 'ok'), 'The run ends');
select tests.act_as('alice');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'family@group.calendar.google.com'), true, false, '{}')
  = 'unavailable', 'It cannot be turned on again while Google does not list it');

-- Revoked consent: authorization expired -------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-5'), 300) ->> 'outcome') = 'ok', 'A run starts');
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-5'), 'authorization_expired'),
  'Google refused the refresh token: the run ends as authorization expired');
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-6'), 300) ->> 'outcome') = 'expired',
  'No run starts while the authorization is expired');
select tests.assert_true(public.queue_google_calendar_syncs(10) = 0, 'Nor is one queued automatically');
select tests.act_as('alice');
select tests.assert_true((public.get_google_calendar_connection() ->> 'status') = 'authorization_expired'
  and not (public.get_google_calendar_connection() ->> 'canSyncNow')::boolean, 'Her settings say so, without Sync now');
select tests.assert_true(public.request_google_calendar_sync() = 'authorization_expired', 'Sync now answers the same');
select tests.assert_true(tests.titles(null) = array['Reis naar zee', 'Etentje'], 'The last synced events stay visible');
select tests.assert_true((tests.warnings(null) -> 0 ->> 'state') = 'authorization_expired', 'With a truthful warning');
select tests.assert_true(tests.private_count($$select count(*) from public.notifications
  where kind = 'google_calendar.authorization_expired' and user_id = tests.user_id('alice')$$) = 1,
  'She is told once in the notification centre');
select tests.act_as('carol');
select tests.assert_true((tests.warnings('home-a') -> 0 ->> 'state') = 'out_of_date'
  and tests.private_count($$select count(*) from public.notifications where kind like 'google_calendar%'
    and user_id <> tests.user_id('alice')$$) = 0,
  'Carol sees only that it is not up to date, and gets no notice');
select tests.act_as('alice');
select tests.assert_true(public.save_google_calendar_connection('alice@gmail.com', tests.token('b'), array['x']) = 'reconnected',
  'Alice reconnects the same account');
select tests.assert_true((public.get_google_calendar_connection() ->> 'status') = 'connected'
  and (public.get_google_calendar_connection() -> 'calendars' -> 0 -> 'homes') = jsonb_build_array(tests.i('home-a')),
  'Connected again, her choices kept');

-- The automatic sync queue ----------------------------------------------------------------------------------------

select tests.act_as_owner();
update private.google_calendar_connections set last_attempt_at = now() - interval '20 minutes', sync_requested_at = null
  where id = tests.conn('alice');
select tests.act_as_service_role();
select tests.assert_true(public.queue_google_calendar_syncs(10) = 1, 'A connection whose last run is over 15 minutes old is queued');
select tests.assert_true(public.queue_google_calendar_syncs(10) = 0, 'Calling again queues nothing twice');
select tests.act_as('carol');
select tests.assert_true(public.save_google_calendar_connection('carol@gmail.com', tests.token('e'), array['x']) = 'connected',
  'Carol connects');
select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('carol'), tests.i('lease-c'), 300) ->> 'outcome') = 'ok', 'A run starts');
select tests.assert_true(jsonb_array_length(public.google_sync_calendars(tests.conn('carol'), tests.i('lease-c'), jsonb_build_array(
    jsonb_build_object('id', 'carol@gmail.com', 'name', 'Carol', 'accessRole', 'owner', 'primary', true)))) = 1,
  'Her calendar is listed');
select tests.assert_true(public.google_sync_finish(tests.conn('carol'), tests.i('lease-c'), 'ok'), 'The run ends');
select tests.act_as('carol');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('carol', 'carol@gmail.com'), false, false, '{}') = 'saved',
  'She turns its sync off, so nothing of hers syncs');
select tests.act_as_owner();
update private.google_calendar_connections set last_attempt_at = now() - interval '20 minutes', sync_requested_at = null
  where id = tests.conn('carol');
select tests.act_as_service_role();
select tests.assert_true(public.queue_google_calendar_syncs(10) = 0,
  'A listed connection with no calendar to sync is not queued (no runs spent on it)');
select tests.act_as('carol');
select tests.assert_true(public.disconnect_google_calendar() = tests.token('e'), 'Carol disconnects again');

-- Leaving the Home ends a share -----------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(public.save_google_calendar_connection('bob@gmail.com', tests.token('c'), array['x']) = 'connected', 'Bob connects');
select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('bob'), tests.i('lease-b'), 300) ->> 'outcome') = 'ok',
  'A run for Bob starts');
select tests.assert_true(jsonb_array_length(public.google_sync_calendars(tests.conn('bob'), tests.i('lease-b'), jsonb_build_array(
    jsonb_build_object('id', 'bob@gmail.com', 'name', 'Bob', 'accessRole', 'owner', 'primary', true)))) = 1,
  'His primary calendar syncs');
select tests.assert_true(public.google_sync_apply_events(tests.cal('bob', 'bob@gmail.com'), tests.i('lease-b'), true,
    jsonb_build_array(tests.timed('bob-1', 'Voetbal', '2026-12-06 10:00+01', '2026-12-06 12:00+01'))) = 1,
  'His calendar syncs');
select tests.act_as('bob');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('bob', 'bob@gmail.com'), true, true,
  array[tests.i('home-a'), tests.i('home-b')]) = 'saved', 'He shares it with Home A and Home B');
select tests.act_as('carol');
select tests.assert_true('Voetbal' = any (tests.titles('home-a')), 'Carol sees it in Home A');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('bob');
select tests.act_as('carol');
select tests.assert_true(not ('Voetbal' = any (tests.titles('home-a'))), 'Once Bob leaves Home A, the share ends there');
select tests.act_as('bob');
select tests.assert_true('Voetbal' = any (tests.titles('home-b')), 'His other Home keeps it');

-- Turning sync off, replacing the account, disconnecting -------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-8'), 300) ->> 'outcome') = 'ok',
  'A run starts');
select tests.act_as('alice');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('alice', 'alice@gmail.com'), false, false, '{}') = 'saved',
  'Alice turns her calendar''s sync off while the run is going');
select tests.act_as_service_role();
select tests.assert_true(public.google_sync_apply_events(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-8'), false,
    jsonb_build_array(tests.timed('late-1', 'Te laat', '2026-12-20 10:00+01', '2026-12-20 11:00+01'))) is null,
  'The run''s next page is not applied to the turned-off calendar');
select tests.assert_true(public.google_sync_finish_calendar(tests.cal('alice', 'alice@gmail.com'), tests.i('lease-8'), false, 'late-token', null),
  'Its pass ends');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendars
  where id = '$$ || tests.cal('alice', 'alice@gmail.com') || $$' and sync_token is null$$) = 1
  and tests.private_count($$select count(*) from private.google_calendar_events where google_event_id = 'late-1'$$) = 0,
  'And keeps no sync token and no event for it');
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-8'), 'ok'), 'The run ends');
select tests.act_as('alice');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendar_events e
  join private.google_calendars c on c.id = e.calendar_id where c.user_id = tests.user_id('alice')$$) = 0
  and tests.private_count($$select count(*) from private.google_calendar_home_shares where user_id = tests.user_id('alice')$$) = 0,
  'Its events and shares are removed');
select tests.act_as('bob');
select tests.assert_true(public.save_google_calendar_connection('bob.work@gmail.com', tests.token('d'), array['x']) = 'replaced',
  'Bob connects another account instead');
select tests.assert_true(tests.private_count($$select count(*) from private.google_calendars where user_id = tests.user_id('bob')$$) = 0
  and tests.private_count($$select count(*) from private.google_calendar_events where google_event_id = 'bob-1'$$) = 0,
  'The old account''s calendars and events are gone');
select tests.act_as('alice');
select tests.assert_true(public.disconnect_google_calendar() = tests.token('b'), 'Disconnecting hands the app the token to revoke');
select tests.assert_true(public.get_google_calendar_connection() is null
  and tests.private_count($$select count(*) from private.google_calendars where user_id = tests.user_id('alice')$$) = 0,
  'Everything of the connection is gone');
select tests.assert_true(public.disconnect_google_calendar() is null, 'Disconnecting again does nothing');
select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.i('lease-7'), tests.i('lease-7'), 300) ->> 'outcome') = 'missing',
  'A queued run for a removed connection finds nothing');
