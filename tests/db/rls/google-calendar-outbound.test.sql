-- S34: Google Calendar outbound changes, conflicts and exclusions (supabase/migrations/*_google_calendar_outbound.sql).
-- Alice owns Home A, where Bob is an Administrator and Carol a Member. Alice connects Google with her primary
-- calendar (owner), a family calendar (writer, shared with Home A) and a holidays calendar (reader).
-- Covers: nothing new reachable as a table, the job functions closed to people; the target calendar; only the
-- owner creates, edits, deletes, resolves, retries, discards and restores (others and forged ids get
-- not_found); read-only calendars, stale revisions, DST gaps; one open change per event and merged edits;
-- applying Google's pages during a change (unchanged etag skipped, fields changed on one side merged, the same
-- field changed on both sides kept as a conflict with both versions, a deletion in Google against an edit);
-- no apply, finish, later page or run ever ending a conflict; both choices; "Delete everywhere" waiting for
-- Google and its conflict; the push results (done, retry, failed, a newer version meanwhile); the stricter
-- privacy flag in a conflict; "Remove from Madeora" hiding in every read and surviving a full resync, and
-- restoring; series scopes (dry run, series limits); sync off refused while changes wait.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select n, gen_random_uuid() from unnest(array['lease-1', 'lease-2', 'lease-3', 'lease-4', 'lease-5',
  'req-1', 'req-2', 'req-3', 'req-4']) as n;

create function tests.i(p_name text) returns uuid
  language sql volatile security definer as $$ select id from ids where name = p_name; $$;
create function tests.conn(p_user text) returns uuid
  language sql volatile security definer as $$
  select id from private.google_calendar_connections where user_id = tests.user_id(p_user); $$;
create function tests.cal(p_google_id text) returns uuid
  language sql volatile security definer as $$
  select c.id from private.google_calendars c where c.google_calendar_id = p_google_id; $$;
create function tests.gevent(p_google_id text) returns uuid
  language sql volatile security definer as $$
  select id from private.google_calendar_events where google_event_id = p_google_id; $$;
create function tests.rev(p_google_id text) returns integer
  language sql volatile security definer as $$
  select revision from private.google_calendar_events where google_event_id = p_google_id; $$;
create function tests.row_title(p_google_id text) returns text
  language sql volatile security definer as $$
  select title from private.google_calendar_events where google_event_id = p_google_id; $$;
create function tests.change(p_google_id text) returns jsonb
  language sql volatile security definer as $$
  select to_jsonb(c) from private.google_calendar_changes c where c.google_event_id = p_google_id; $$;
create function tests.newg() returns text
  language sql volatile security definer as $$
  select google_event_id from private.google_calendar_events where id = (select id from ids where name = 'new-1'); $$;
create function tests.description(p_google_id text) returns text
  language sql volatile security definer as $$
  select description from private.google_calendar_events where google_event_id = p_google_id; $$;
create function tests.change_count() returns bigint
  language sql volatile security definer as $$ select count(*) from private.google_calendar_changes; $$;
create function tests.token(p_seed text) returns text
  language sql immutable as $$
  select 'v1.' || rpad(p_seed, 16, 'x') || '.' || rpad(p_seed, 40, 'c') || '.' || rpad(p_seed, 22, 't'); $$;
create function tests.titles(p_home text) returns text[]
  language plpgsql as $$
  begin
    return (select coalesce(array_agg(o ->> 'title' order by o ->> 'title'), '{}')
      from jsonb_array_elements(public.list_calendar(date '2026-12-01', date '2026-12-31', tests.i(p_home),
        'Europe/Brussels') -> 'occurrences') o);
  end $$;
create function tests.state_of(p_title text) returns text
  language plpgsql as $$
  begin
    return (select o ->> 'googleState' from jsonb_array_elements(public.list_calendar(date '2026-12-01',
      date '2026-12-31', null, 'Europe/Brussels') -> 'occurrences') o where o ->> 'title' = p_title limit 1);
  end $$;
-- An event in the shape packages/google-calendar normalizeEvent produces.
create function tests.g(p_id text, p_title text, p_etag text, p_day date, p_extra jsonb default '{}') returns jsonb
  language sql immutable as $$
  select jsonb_build_object('id', p_id, 'etag', p_etag, 'status', 'confirmed', 'title', p_title, 'location', null,
    'description', null, 'allDay', false, 'startsAt', (p_day + time '09:00') at time zone 'Europe/Brussels',
    'endsAt', (p_day + time '10:00') at time zone 'Europe/Brussels', 'timeZone', 'Europe/Brussels', 'private', false,
    'link', 'https://www.google.com/calendar/event?eid=' || p_id) || p_extra; $$;
create function tests.body(p_title text, p_day text, p_start text default '09:00', p_end text default '10:00')
returns jsonb
  language sql immutable as $$
  select jsonb_build_object('title', p_title, 'allDay', false, 'startsOn', p_day, 'endsOn', p_day,
    'startTime', p_start, 'endTime', p_end, 'timezone', 'Europe/Brussels'); $$;
create function tests.apply(p_calendar text, p_lease text, p_events jsonb, p_full boolean default false) returns integer
  language sql as $$ select public.google_sync_apply_events(tests.cal(p_calendar), tests.i(p_lease), p_full, p_events); $$;
grant execute on function tests.i(text), tests.conn(text), tests.cal(text), tests.gevent(text), tests.rev(text),
  tests.row_title(text), tests.change(text), tests.newg(), tests.description(text), tests.change_count(), tests.token(text), tests.titles(text),
  tests.state_of(text), tests.g(text, text, text, date, jsonb), tests.body(text, text, text, text),
  tests.apply(text, text, jsonb, boolean)
  to authenticated, service_role;

-- Setup: Alice connects; the first run lists three calendars and stores events ----------------------------------

select tests.act_as('alice');
select tests.assert_true(public.save_google_calendar_connection('alice@gmail.com', tests.token('a'),
  array['https://www.googleapis.com/auth/calendar.events']) = 'connected', 'Alice connects');
select tests.act_as_service_role();
select tests.assert_true((public.google_sync_begin(tests.conn('alice'), tests.i('lease-1'), 300) ->> 'outcome') = 'ok',
  'The first run starts');
select public.google_sync_calendars(tests.conn('alice'), tests.i('lease-1'), jsonb_build_array(
  jsonb_build_object('id', 'alice@gmail.com', 'name', 'Alice', 'timeZone', 'Europe/Brussels', 'accessRole', 'owner', 'primary', true),
  jsonb_build_object('id', 'family', 'name', 'Familie', 'accessRole', 'writer'),
  jsonb_build_object('id', 'holidays', 'name', 'Feestdagen', 'accessRole', 'reader')));
select tests.act_as('alice');
select tests.assert_true((public.get_google_calendar_connection() ->> 'writeCalendarId')::uuid = tests.cal('alice@gmail.com'),
  'The primary calendar becomes the target for new events');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('family'), true, true, array[tests.i('home-a')]) = 'saved'
  and public.set_google_calendar_settings(tests.cal('holidays'), true, true, '{}') = 'saved',
  'She syncs the family calendar (shared with Home A) and the holidays calendar');
select tests.act_as_service_role();
select tests.apply('alice@gmail.com', 'lease-1', jsonb_build_array(
  tests.g('ev-a', 'Tandarts', '"a1"', date '2026-12-03'),
  tests.g('ev-b', 'Kapper', '"b1"', date '2026-12-04'),
  tests.g('ev-c', 'Garage', '"c1"', date '2026-12-05'),
  tests.g('s_1', 'Yoga', '"s1"', date '2026-12-07', '{"recurringEventId": "s", "originalStart": "2026-12-07T09:00:00+01:00"}'),
  tests.g('s_2', 'Yoga', '"s2"', date '2026-12-14', '{"recurringEventId": "s", "originalStart": "2026-12-14T09:00:00+01:00"}'),
  tests.g('s_3', 'Yoga', '"s3"', date '2026-12-21', '{"recurringEventId": "s", "originalStart": "2026-12-21T09:00:00+01:00"}')), true);
select tests.apply('family', 'lease-1', jsonb_build_array(
  tests.g('fam-1', 'Verjaardag', '"f1"', date '2026-12-10'),
  tests.g('fam-2', 'Etentje', '"g1"', date '2026-12-11')), true);
select tests.apply('holidays', 'lease-1', jsonb_build_array(tests.g('hol-1', 'Kerstmis', '"h1"', date '2026-12-25')), true);
select public.google_sync_finish_calendar(tests.cal(c), tests.i('lease-1'), true, 'tok-' || c, null)
  from unnest(array['alice@gmail.com', 'family', 'holidays']) c;
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-1'), 'ok'), 'The first run ends');

-- Nothing new is reachable as a table; the job functions are the service role's ----------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.google_calendar_changes', 'The API cannot read changes');
select tests.assert_denied('select * from private.google_calendar_exclusions', 'Nor exclusions');
select tests.assert_denied($$select private.google_reconcile(gen_random_uuid(), '{}')$$, 'Nor the helpers');
select tests.assert_denied($$select public.google_push_changes(gen_random_uuid(), gen_random_uuid())$$,
  'A person cannot read the changes to send');
select tests.assert_denied($$select public.google_push_result(gen_random_uuid(), gen_random_uuid(), 1, '{"outcome": "done"}')$$,
  'Nor record Google''s answer');
select tests.act_as_anon();
select tests.assert_denied($$select public.create_google_calendar_event(gen_random_uuid(), gen_random_uuid(), '{}')$$,
  'Nobody signed out creates an event');
select tests.assert_denied($$select public.resolve_google_calendar_conflict(gen_random_uuid(), 'google')$$,
  'Nor resolves a conflict');

-- The target calendar ------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(public.set_google_calendar_write_target(tests.cal('holidays')) = 'read_only',
  'A read-only calendar cannot be the target');
select tests.assert_true(public.set_google_calendar_write_target(tests.cal('family')) = 'saved', 'A writable synced calendar can');
select tests.assert_true((public.get_google_calendar_connection() ->> 'writeCalendarId')::uuid = tests.cal('family'),
  'It becomes the target');
select tests.assert_true(public.set_google_calendar_write_target(null) = 'saved', 'Madeora only is a choice');
select tests.assert_true(public.get_google_calendar_connection() -> 'writeCalendarId' = 'null'::jsonb, 'Then there is none');
select tests.assert_true(public.set_google_calendar_write_target(tests.cal('alice@gmail.com')) = 'saved', 'Back to the primary');
select tests.act_as('bob');
select tests.assert_true(public.set_google_calendar_write_target(tests.cal('family')) = 'not_found',
  'Bob cannot pick Alice''s calendar');

-- Creating an event in Google -----------------------------------------------------------------------------------

select tests.act_as('alice');
insert into ids select 'new-1', (public.create_google_calendar_event(tests.i('req-1'), tests.cal('alice@gmail.com'),
  tests.body('Nieuw', '2026-12-15')) ->> 'eventId')::uuid;
select tests.assert_true(tests.i('new-1') is not null and 'Nieuw' = any (tests.titles(null))
  and tests.state_of('Nieuw') = 'saving', 'Alice creates an event; it shows at once, marked as saving to Google');
select tests.assert_true((public.create_google_calendar_event(tests.i('req-1'), tests.cal('alice@gmail.com'),
  tests.body('Nieuw', '2026-12-15')) ->> 'outcome') = 'exists'
  and (select count(*) from unnest(tests.titles(null)) t where t = 'Nieuw') = 1,
  'The same request again makes no second event');
select tests.assert_true((public.create_google_calendar_event(tests.i('req-2'), tests.cal('holidays'),
  tests.body('X', '2026-12-15')) ->> 'outcome') = 'read_only', 'Not in a read-only calendar');
select tests.assert_true((public.create_google_calendar_event(tests.i('req-2'), tests.cal('alice@gmail.com'),
  tests.body('Gap', '2026-03-29', '02:30', '03:30')) ->> 'outcome') = 'nonexistent_time',
  'A time the clock skips at the DST change is refused');
select tests.assert_denied($$select public.create_google_calendar_event(tests.i('req-2'), tests.cal('alice@gmail.com'),
  tests.body('X', '2026-12-15') || '{"reminder": 15}')$$, 'Reminders are native-only', '22023');
select tests.act_as('carol');
select tests.assert_true((public.create_google_calendar_event(tests.i('req-3'), tests.cal('alice@gmail.com'),
  tests.body('Carol', '2026-12-15')) ->> 'outcome') = 'not_found', 'Carol cannot create in Alice''s calendar');
select tests.act_as_owner();
select tests.assert_true(tests.change((select google_event_id from private.google_calendar_events where id = tests.i('new-1'))) ->> 'action' = 'create'
  , 'A create change waits for Google');

-- Editing, and who may -----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'event', 1,
  tests.body('Hack', '2026-12-03')) ->> 'outcome') = 'not_found', 'Carol cannot edit Alice''s event');
select tests.act_as('bob');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('fam-1'), 'event', 1,
  tests.body('Hack', '2026-12-10')) ->> 'outcome') = 'not_found'
  and (public.delete_google_calendar_event(tests.gevent('fam-1'), 'event', 'madeora', 1) ->> 'outcome') = 'not_found',
  'Bob sees the shared family event but cannot edit or remove it');
select tests.assert_true((public.get_google_calendar_event(tests.gevent('fam-1'), tests.i('home-a')) -> 'change') = 'null'::jsonb
  and not (public.get_google_calendar_event(tests.gevent('fam-1'), tests.i('home-a')) ->> 'editable')::boolean,
  'And his view of it carries no change and is not editable');
select tests.act_as('alice');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'event', tests.rev('ev-a') + 1,
  tests.body('X', '2026-12-03')) ->> 'outcome') = 'stale', 'An edit from an older page is refused');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('hol-1'), 'event', tests.rev('hol-1'),
  tests.body('X', '2026-12-25')) ->> 'outcome') = 'read_only', 'A read-only calendar''s event cannot be edited');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'following', tests.rev('ev-a'),
  tests.body('X', '2026-12-03')) ->> 'outcome') = 'invalid_scope', 'A single event has no series scopes');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'event', tests.rev('ev-a'),
  tests.body('Tandarts', '2026-12-03')) ->> 'outcome') = 'unchanged', 'Saving the same values changes nothing');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'event', tests.rev('ev-a'),
  tests.body('Tandarts Madeora', '2026-12-03')) ->> 'outcome') = 'saved'
  and tests.state_of('Tandarts Madeora') = 'saving', 'Alice renames it; Madeora shows her version, saving');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'event', tests.rev('ev-a'),
  tests.body('Tandarts Madeora', '2026-12-03') || '{"location": "Gent"}') ->> 'outcome') = 'saved',
  'A second edit before Google has it');
select tests.act_as_owner();
select tests.assert_true((select count(*) from private.google_calendar_changes where google_event_id = 'ev-a') = 1
  and (select array_agg(f) from jsonb_array_elements_text(tests.change('ev-a') -> 'fields') f) = array['title', 'location'] and (tests.change('ev-a') -> 'base') ->> 'etag' = '"a1"',
  'Merged into one change, still based on Google''s first version');

-- Google's pages while a change waits ----------------------------------------------------------------------------

select tests.act_as_service_role();
select (public.google_sync_begin(tests.conn('alice'), tests.i('lease-2'), 300) ->> 'outcome');
select tests.apply('alice@gmail.com', 'lease-2', jsonb_build_array(tests.g('ev-a', 'Tandarts', '"a1"', date '2026-12-03')));
select tests.assert_true(tests.row_title('ev-a') = 'Tandarts Madeora', 'Google''s unchanged version does not overwrite the edit');
select tests.apply('alice@gmail.com', 'lease-2', jsonb_build_array(tests.g('ev-a', 'Tandarts', '"a2"', date '2026-12-03',
  '{"description": "Bring card"}')));
select tests.assert_true(tests.row_title('ev-a') = 'Tandarts Madeora'
  and tests.description('ev-a') = 'Bring card'
  and (tests.change('ev-a') ->> 'state') = 'pending' and (tests.change('ev-a') -> 'base') ->> 'etag' = '"a2"',
  'A field only Google changed merges; the change stays, now based on Google''s new version');
select tests.apply('alice@gmail.com', 'lease-2', jsonb_build_array(tests.g('ev-a', 'Tandarts Google', '"a3"', date '2026-12-03',
  '{"description": "Bring card"}')));
select tests.assert_true((tests.change('ev-a') ->> 'state') = 'conflict' and (select array_agg(f) from jsonb_array_elements_text(tests.change('ev-a') -> 'conflict_fields') f) = array['title']
  and (tests.change('ev-a') -> 'theirs') ->> 'title' = 'Tandarts Google' and (tests.change('ev-a') -> 'mine') ->> 'title' = 'Tandarts Madeora'
  and tests.row_title('ev-a') = 'Tandarts Madeora',
  'The same field changed on both sides is a conflict: both versions kept, nothing overwritten');
select tests.apply('alice@gmail.com', 'lease-2', jsonb_build_array(tests.g('ev-a', 'Tandarts Google 2', '"a4"', date '2026-12-03',
  '{"description": "Bring card"}')));
select tests.apply('alice@gmail.com', 'lease-2', jsonb_build_array(tests.g('ev-a', 'Tandarts Madeora', '"a5"', date '2026-12-03',
  '{"description": "Bring card", "location": "Gent"}')));
select tests.assert_true((tests.change('ev-a') ->> 'state') = 'conflict' and (tests.change('ev-a') -> 'theirs') ->> 'etag' = '"a5"',
  'Later pages only update Google''s version; even matching values do not end the conflict');
select public.google_sync_finish_calendar(tests.cal('alice@gmail.com'), tests.i('lease-2'), false, 'tok-2', null);
select tests.assert_true((tests.change('ev-a') ->> 'state') = 'conflict', 'Nor does the pass ending');
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-2'), 'ok'), 'The run ends');
select tests.assert_true((tests.change('ev-a') ->> 'state') = 'conflict', 'Nor the run ending');

select tests.act_as('alice');
select tests.assert_true(tests.state_of('Tandarts Madeora') = 'conflict'
  and (public.get_google_calendar_event(tests.gevent('ev-a')) -> 'change' ->> 'state') = 'conflict'
  and (public.get_google_calendar_event(tests.gevent('ev-a')) -> 'change' -> 'theirs' ->> 'title') = 'Tandarts Madeora'
  and (public.get_google_calendar_event(tests.gevent('ev-a')) -> 'change' -> 'mine' ->> 'title') = 'Tandarts Madeora',
  'Alice sees the conflict with both versions on the event page');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-a'), 'event', tests.rev('ev-a'),
  tests.body('Other', '2026-12-03')) ->> 'outcome') = 'conflict_open'
  and (public.delete_google_calendar_event(tests.gevent('ev-a'), 'event', 'everywhere', tests.rev('ev-a')) ->> 'outcome') = 'conflict_open'
  and public.retry_google_calendar_change((tests.change('ev-a') ->> 'id')::uuid) = 'not_failed'
  and public.discard_google_calendar_change((tests.change('ev-a') ->> 'id')::uuid) = 'in_conflict',
  'While it waits for her choice nothing else changes it: no edit, deletion, retry or discard');
select tests.act_as('bob');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('ev-a') ->> 'id')::uuid, 'madeora') = 'not_found',
  'Bob cannot resolve Alice''s conflict');
select tests.act_as('alice');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('ev-a') ->> 'id')::uuid, 'google') = 'resolved'
  and (tests.change('ev-a') ->> 'id')::uuid is null and tests.row_title('ev-a') = 'Tandarts Madeora',
  'She keeps Google''s version (which now has her title): the change is gone, Google''s values shown');

-- Keep Madeora's version ---------------------------------------------------------------------------------------

select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-b'), 'event', tests.rev('ev-b'),
  tests.body('Kapper Madeora', '2026-12-04')) ->> 'outcome') = 'saved', 'Alice renames another event');
select tests.act_as_service_role();
select (public.google_sync_begin(tests.conn('alice'), tests.i('lease-3'), 300) ->> 'outcome');
select tests.apply('alice@gmail.com', 'lease-3', jsonb_build_array(tests.g('ev-b', 'Kapper Google', '"b2"', date '2026-12-04')));
select tests.act_as('alice');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('ev-b') ->> 'id')::uuid, 'madeora') = 'resolved'
  and (tests.change('ev-b') ->> 'state') = 'pending' and (tests.change('ev-b') -> 'base') ->> 'etag' = '"b2"'
  and (select array_agg(f) from jsonb_array_elements_text(tests.change('ev-b') -> 'fields') f) = array['title'] and tests.row_title('ev-b') = 'Kapper Madeora',
  'Keeping Madeora''s version sends it again, based on Google''s current version (its etag)');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('ev-b') ->> 'id')::uuid, 'madeora') = 'not_in_conflict',
  'Choosing twice changes nothing');

-- Deleted in Google while edited in Madeora ---------------------------------------------------------------------

select tests.assert_true((public.update_google_calendar_event(tests.gevent('ev-c'), 'event', tests.rev('ev-c'),
  tests.body('Garage Madeora', '2026-12-05')) ->> 'outcome') = 'saved', 'Alice edits a third event');
select tests.act_as_service_role();
select tests.apply('alice@gmail.com', 'lease-3', '[{"id": "ev-c", "cancelled": true}]');
select tests.assert_true((tests.change('ev-c') ->> 'state') = 'conflict' and ((tests.change('ev-c') -> 'theirs') ->> 'deleted')::boolean
  and tests.gevent('ev-c') is not null, 'Deleted in Google: a conflict, the event kept until Alice chooses');
select tests.act_as('alice');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('ev-c') ->> 'id')::uuid, 'google') = 'resolved'
  and tests.gevent('ev-c') is null, 'Accepting the deletion removes it');

-- Delete everywhere ----------------------------------------------------------------------------------------------

select tests.assert_true((public.delete_google_calendar_event(tests.gevent('s_1'), 'event', 'everywhere', tests.rev('s_1'),
  true) ->> 'count')::integer = 1, 'The dry run of "this event" lists one occurrence');
select tests.assert_true((public.delete_google_calendar_event(tests.gevent('s_1'), 'event', 'everywhere', tests.rev('s_1'))
  ->> 'outcome') = 'deleting' and tests.gevent('s_1') is not null,
  'Delete everywhere waits for Google: the occurrence stays, marked as deleting');
select tests.assert_true((select count(*) from jsonb_array_elements(public.list_calendar(date '2026-12-01', date '2026-12-31',
  null, 'Europe/Brussels') -> 'occurrences') o where o ->> 'googleState' = 'deleting') = 1, 'The calendar says so');
select tests.act_as_service_role();
select tests.apply('alice@gmail.com', 'lease-3', '[{"id": "s_1", "cancelled": true}]');
select tests.assert_true(tests.gevent('s_1') is null and (tests.change('s_1') ->> 'id')::uuid is null,
  'Google confirming the deletion ends it');
select tests.act_as('alice');
select tests.assert_true((public.delete_google_calendar_event(tests.gevent('fam-1'), 'event', 'everywhere', tests.rev('fam-1'))
  ->> 'outcome') = 'deleting', 'Alice deletes the family birthday everywhere');
select tests.act_as_service_role();
select tests.apply('family', 'lease-3', jsonb_build_array(tests.g('fam-1', 'Verjaardag oma', '"f2"', date '2026-12-10')));
select tests.assert_true((tests.change('fam-1') ->> 'state') = 'conflict' and tests.row_title('fam-1') = 'Verjaardag oma',
  'Changed in Google before the deletion reached it: a conflict, the event shown as Google has it');
select tests.act_as('alice');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('fam-1') ->> 'id')::uuid, 'madeora') = 'resolved'
  and (tests.change('fam-1') ->> 'state') = 'pending' and (tests.change('fam-1') -> 'base') ->> 'etag' = '"f2"',
  '"Delete anyway" sends the deletion again with Google''s current etag');
select tests.assert_true(public.set_google_calendar_settings(tests.cal('family'), false, false, '{}') = 'pending_changes',
  'Sync cannot be turned off while changes wait');

-- The push results ------------------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(public.google_push_changes(tests.conn('alice'), tests.i('lease-1')) is null,
  'Nothing to send without the lease');
select tests.assert_true(jsonb_array_length(public.google_push_changes(tests.conn('alice'), tests.i('lease-3'))) = 3,
  'The run reads the three waiting changes (the new event, the kept edit, the deletion)');
select tests.assert_true(public.google_push_result((tests.change('fam-1') ->> 'id')::uuid, tests.i('lease-1'), 1, '{"outcome": "done"}') is null,
  'No result without the lease');
select tests.assert_denied($$select public.google_push_result((tests.change('fam-1') ->> 'id')::uuid, tests.i('lease-3'), 1, '{"outcome": "maybe"}')$$,
  'A malformed result is refused', '22023');
select tests.assert_true(public.google_push_result((tests.change('fam-1') ->> 'id')::uuid, tests.i('lease-3'), (tests.change('fam-1') ->> 'version')::integer,
  '{"outcome": "done"}') ->> 'state' = 'done' and tests.gevent('fam-1') is null, 'Google confirmed the deletion');
select tests.assert_true(public.google_push_result((tests.change('ev-b') ->> 'id')::uuid, tests.i('lease-3'), (tests.change('ev-b') ->> 'version')::integer,
  '{"outcome": "retry", "code": "google_unavailable"}') ->> 'state' = 'waiting'
  and (tests.change('ev-b') ->> 'state') = 'pending' and (tests.change('ev-b') ->> 'attempts')::integer = 1, 'An outage leaves the change waiting');
select tests.assert_true(public.google_push_result((tests.change('ev-b') ->> 'id')::uuid, tests.i('lease-3'), (tests.change('ev-b') ->> 'version')::integer,
  '{"outcome": "failed", "code": "google_forbidden"}') ->> 'state' = 'failed', 'A refusal fails it');
select tests.act_as('alice');
select tests.assert_true(tests.state_of('Kapper Madeora') = 'failed'
  and (public.get_google_calendar_event(tests.gevent('ev-b')) -> 'change' ->> 'errorCode') = 'google_forbidden',
  'Alice sees it failed, with the reason');
select tests.assert_true(public.retry_google_calendar_change((tests.change('ev-b') ->> 'id')::uuid) = 'queued'
  and (tests.change('ev-b') ->> 'state') = 'pending', 'Try again');
select tests.assert_true(public.discard_google_calendar_change((tests.change('ev-b') ->> 'id')::uuid) = 'discarded'
  and tests.row_title('ev-b') = 'Kapper Google', 'Discarding her change shows Google''s version again');
-- A newer edit while the create was being sent.
select tests.assert_true((public.update_google_calendar_event(tests.i('new-1'), 'event', tests.rev(tests.newg()), tests.body('Nieuw later', '2026-12-15')) ->> 'outcome') = 'saved',
  'Alice renames the new event before Google confirmed it');
select tests.act_as_service_role();
select tests.assert_true(public.google_push_result((tests.change(tests.newg()) ->> 'id')::uuid,
  tests.i('lease-3'), 1, jsonb_build_object('outcome', 'done', 'event', tests.g(tests.newg(), 'Nieuw', '"n1"', date '2026-12-15'))) ->> 'state' = 'waiting',
  'Google confirms the first version');
select tests.assert_true(tests.change(tests.newg()) ->> 'action' = 'update'
  and tests.change(tests.newg()) -> 'fields' = '["title"]'::jsonb and tests.row_title(tests.newg()) = 'Nieuw later',
  'The newer title is kept and becomes an edit of what Google has');

-- Privacy: a conflict never shows a Home a version Google made private ------------------------------------------

select tests.act_as('alice');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('fam-2'), 'event', tests.rev('fam-2'),
  tests.body('Etentje Madeora', '2026-12-11')) ->> 'outcome') = 'saved', 'Alice renames the shared dinner');
select tests.act_as_service_role();
select tests.apply('family', 'lease-3', jsonb_build_array(tests.g('fam-2', 'Etentje privé', '"g2"', date '2026-12-11',
  '{"private": true}')));
select tests.act_as('bob');
select tests.assert_true(not ('Etentje Madeora' = any (tests.titles('home-a'))) and not ('Etentje privé' = any (tests.titles('home-a'))),
  'In conflict, the stricter privacy flag applies: Home A no longer sees it');
select tests.act_as('alice');
select tests.assert_true('Etentje Madeora' = any (tests.titles(null)), 'Alice still does');

-- Series scopes ---------------------------------------------------------------------------------------------------

select tests.assert_true((public.update_google_calendar_event(tests.gevent('s_2'), 'all', tests.rev('s_2'),
  tests.body('Yoga', '2026-12-15')) ->> 'outcome') = 'series_limit', 'A series is not moved to other days from Madeora');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('s_2'), 'following', tests.rev('s_2'),
  tests.body('Yin yoga', '2026-12-14'), true) ->> 'count')::integer = 2,
  'The dry run of "this and following" lists the stored occurrences it affects');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('s_2'), 'following', tests.rev('s_2'),
  tests.body('Yin yoga', '2026-12-14')) ->> 'outcome') = 'saved'
  and (tests.change('s_2') ->> 'series_id') = 's' and (tests.change('s_2') ->> 'scope') = 'following',
  'Alice renames this and following: one series change');
select tests.assert_true(tests.state_of('Yoga') = 'saving', 'Its occurrences show as saving');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('s_3'), 'event', tests.rev('s_3'),
  tests.body('Solo', '2026-12-21')) ->> 'outcome') = 'busy', 'Another change on that series waits for it');
select tests.act_as_service_role();
select tests.assert_true(public.google_push_result((tests.change('s_2') ->> 'id')::uuid, tests.i('lease-3'), 1, '{"outcome": "done"}')
  ->> 'state' = 'done', 'Google confirmed the split; the pull that follows brings the new occurrences');
select public.google_sync_finish(tests.conn('alice'), tests.i('lease-3'), 'ok');

-- Remove from Madeora ---------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true((public.delete_google_calendar_event(tests.gevent('s_2'), 'following', 'madeora', 1) ->> 'outcome') = 'not_found',
  'Bob cannot remove Alice''s events');
select tests.act_as('alice');
select tests.assert_true((public.delete_google_calendar_event(tests.gevent('s_2'), 'following', 'madeora', tests.rev('s_2'))
  ->> 'outcome') = 'removed' and not ('Yoga' = any (tests.titles(null))),
  'Remove from Madeora hides this and following occurrences without touching Google');
select tests.assert_true(public.get_google_calendar_event(tests.gevent('s_3'))
  is null and jsonb_array_length(public.get_calendar_upcoming(30, 10, null, 'Europe/Brussels') -> 'occurrences') >= 0
  and not exists (select 1 from jsonb_array_elements(public.get_calendar_upcoming(30, 10, null, 'Europe/Brussels') -> 'occurrences') o
    where o ->> 'title' = 'Yoga'), 'Nor on its event page or in the widget');
select tests.assert_true((public.delete_google_calendar_event(tests.gevent('hol-1'), 'event', 'madeora', tests.rev('hol-1'))
  ->> 'outcome') = 'removed' and (public.delete_google_calendar_event(tests.gevent('ev-a'), 'event', 'everywhere',
  tests.rev('ev-a')) ->> 'outcome') = 'deleting', 'A read-only event can be removed from Madeora');
select tests.act_as_service_role();
select (public.google_sync_begin(tests.conn('alice'), tests.i('lease-4'), 300) ->> 'outcome');
select tests.apply('alice@gmail.com', 'lease-4', jsonb_build_array(
  tests.g('s_2', 'Yoga', '"s2b"', date '2026-12-14', '{"recurringEventId": "s", "originalStart": "2026-12-14T09:00:00+01:00"}'),
  tests.g('s_3', 'Yoga', '"s3"', date '2026-12-21', '{"recurringEventId": "s", "originalStart": "2026-12-21T09:00:00+01:00"}'),
  tests.g('ev-a', 'Tandarts Madeora', '"a5"', date '2026-12-03', '{"description": "Bring card", "location": "Gent"}')), true);
select public.google_sync_finish_calendar(tests.cal('alice@gmail.com'), tests.i('lease-4'), true, 'tok-4', null);
select tests.act_as('alice');
select tests.assert_true(not ('Yoga' = any (tests.titles(null))), 'A full resync does not show them again');
select tests.assert_true(jsonb_array_length(public.get_google_calendar_connection() -> 'hidden') = 2,
  'Settings lists the two hidden events');
select tests.assert_true(public.restore_google_calendar_event((select (h ->> 'id')::uuid from jsonb_array_elements(
  public.get_google_calendar_connection() -> 'hidden') h where h ->> 'title' = 'Yoga')) = 'restored'
  and 'Yoga' = any (tests.titles(null)), 'Restoring shows them again');
select tests.act_as('carol');
select tests.assert_true(public.restore_google_calendar_event(gen_random_uuid()) = 'not_found', 'A forged id restores nothing');
select tests.assert_true(public.discard_google_calendar_change(gen_random_uuid()) = 'not_found'
  and public.retry_google_calendar_change(gen_random_uuid()) = 'not_found', 'Nor discards or retries');

-- Review fixes: the full-pass window, privacy on "keep Madeora", conflict fields on later pages, a series Google
-- deleted, results during a conflict, and the follow-up run -------------------------------------------------------

select tests.act_as_service_role();
select public.google_sync_finish(tests.conn('alice'), tests.i('lease-4'), 'ok');
select (public.google_sync_begin(tests.conn('alice'), tests.i('lease-5'), 300) ->> 'outcome');
select tests.apply('alice@gmail.com', 'lease-5', jsonb_build_array(
  tests.g('far', 'Verre reis', '"far1"', (now() + interval '500 days')::date),
  tests.g('pv', 'Overleg', '"pv1"', date '2026-12-08'),
  tests.g('cf', 'Etentje', '"cf1"', date '2026-12-09')));
select tests.act_as('alice');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('far'), 'event', tests.rev('far'),
  tests.body('Verre reis (geboekt)', ((now() + interval '500 days')::date)::text)) ->> 'outcome') = 'saved'
  and (public.update_google_calendar_event(tests.gevent('pv'), 'event', tests.rev('pv'),
  tests.body('Overleg Madeora', '2026-12-08')) ->> 'outcome') = 'saved'
  and (public.update_google_calendar_event(tests.gevent('cf'), 'event', tests.rev('cf'),
  tests.body('Etentje Madeora', '2026-12-09') || '{"location": "Gent"}') ->> 'outcome') = 'saved',
  'Alice edits an event beyond the synced window and two others');
select tests.act_as_service_role();
select tests.apply('alice@gmail.com', 'lease-5', jsonb_build_array(
  tests.g('s_2', 'Yoga', '"s2b"', date '2026-12-14', '{"recurringEventId": "s", "originalStart": "2026-12-14T09:00:00+01:00"}'),
  tests.g('s_3', 'Yoga', '"s3"', date '2026-12-21', '{"recurringEventId": "s", "originalStart": "2026-12-21T09:00:00+01:00"}'),
  tests.g('ev-a', 'Tandarts Madeora', '"a5"', date '2026-12-03', '{"description": "Bring card", "location": "Gent"}'),
  tests.g('pv', 'Overleg Google', '"pv2"', date '2026-12-08', '{"private": true}'),
  tests.g('cf', 'Etentje Google', '"cf2"', date '2026-12-09')), true);
select public.google_sync_finish_calendar(tests.cal('alice@gmail.com'), tests.i('lease-5'), true, 'tok-5', null);
select tests.assert_true((tests.change('far') ->> 'state') = 'pending' and tests.gevent('far') is not null,
  'A full pass that did not ask for an event beyond its window does not take it for deleted in Google');
select tests.assert_true((tests.change('pv') ->> 'state') = 'conflict' and (tests.change('cf') ->> 'state') = 'conflict'
  and (select array_agg(f) from jsonb_array_elements_text(tests.change('cf') -> 'conflict_fields') f) = array['title'],
  'Both edited titles conflict; the location only Madeora changed is not a conflict');
select tests.apply('alice@gmail.com', 'lease-5', jsonb_build_array(tests.g('cf', 'Etentje Google', '"cf3"', date '2026-12-09')));
select tests.assert_true((select array_agg(f) from jsonb_array_elements_text(tests.change('cf') -> 'conflict_fields') f) = array['title'],
  'A later page compares with the base, so the location stays out of the conflict');
select tests.assert_true((public.google_push_result((tests.change('cf') ->> 'id')::uuid, tests.i('lease-5'),
  (tests.change('cf') ->> 'version')::int, '{"outcome": "retry", "code": "google_unavailable"}') ->> 'state') = 'conflict'
  and (public.google_push_result((tests.change('cf') ->> 'id')::uuid, tests.i('lease-5'),
  (tests.change('cf') ->> 'version')::int, '{"outcome": "failed", "code": "google_refused"}') ->> 'state') = 'conflict'
  and (tests.change('cf') ->> 'state') = 'conflict', 'A late retry or failure result leaves a conflict as it is');

-- A change made while the run holds the lease: its own run found the lease taken, so the end queues another.
select tests.act_as('alice');
select tests.assert_true((public.update_google_calendar_event(tests.gevent('far'), 'event', tests.rev('far'),
  tests.body('Verre reis (betaald)', ((now() + interval '500 days')::date)::text)) ->> 'outcome') = 'saved',
  'Alice edits again during the run');
select tests.act_as_owner();
create temporary table queued_before on commit drop as
  select count(*) as n from private.job_outbox where job_name = 'google-calendar-sync';
select tests.act_as_service_role();
select tests.assert_true(public.google_sync_finish(tests.conn('alice'), tests.i('lease-5'), 'ok'), 'The run ends');
select tests.act_as_owner();
select tests.assert_true((select count(*) from private.job_outbox where job_name = 'google-calendar-sync')
  > (select n from queued_before), 'A follow-up run is queued for the change made during it');

select tests.act_as('alice');
select tests.assert_true(public.resolve_google_calendar_conflict((tests.change('pv') ->> 'id')::uuid, 'madeora') = 'resolved',
  'Alice keeps Madeora''s version of the event Google made private');
select tests.act_as_owner();
select tests.assert_true((select private_in_google from private.google_calendar_events where google_event_id = 'pv')
  and (select title from private.google_calendar_events where google_event_id = 'pv') = 'Overleg Madeora',
  'Her version shows, still private, so a Home does not see it before Google confirms');

-- A series change Google deleted cannot be restored from Madeora: it fails with the reason, Alice discards it.
insert into private.google_calendar_changes (calendar_id, user_id, action, scope, google_event_id, series_id, fields,
    base, mine, theirs, state, conflict_fields, title)
  select e.calendar_id, tests.user_id('alice'), 'update', 'all', e.google_event_id, 's', array['title'],
    private.google_snapshot(e), private.google_snapshot(e) || '{"title": "Yoga Madeora"}', '{"deleted": true}',
    'conflict', array['title'], 'Yoga Madeora'
  from private.google_calendar_events e where e.google_event_id = 's_3';
select tests.act_as('alice');
select tests.assert_true(public.resolve_google_calendar_conflict((select (c ->> 'id')::uuid from jsonb_array_elements(
  public.get_google_calendar_connection() -> 'changes') c where c ->> 'title' = 'Yoga Madeora'), 'madeora') = 'resolved',
  'Choosing Madeora''s version of a series Google deleted is answered');
select tests.assert_true(exists (select 1 from jsonb_array_elements(public.get_google_calendar_connection() -> 'changes') c
  where c ->> 'title' = 'Yoga Madeora' and c ->> 'state' = 'failed' and c ->> 'errorCode' = 'series_limit'),
  'It fails with the reason instead of returning to a conflict forever');
select tests.assert_true(public.discard_google_calendar_change((select (c ->> 'id')::uuid from jsonb_array_elements(
  public.get_google_calendar_connection() -> 'changes') c where c ->> 'title' = 'Yoga Madeora')) = 'discarded',
  'And Alice discards it');

-- Malformed requests --------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied($$select public.update_google_calendar_event(tests.gevent('s_3'), 'sometimes', 1, tests.body('x', '2026-12-21'))$$,
  'An unknown scope is refused', '22023');
select tests.assert_denied($$select public.delete_google_calendar_event(tests.gevent('s_3'), 'event', 'nowhere', 1)$$,
  'An unknown destination is refused', '22023');
select tests.assert_denied($$select public.resolve_google_calendar_conflict(gen_random_uuid(), 'both')$$,
  'An unknown choice is refused', '22023');
