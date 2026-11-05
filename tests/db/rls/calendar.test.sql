-- S32: native calendar (supabase/migrations/*_calendar.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Alice and Carol are not in.
-- Covers: nothing reachable as a table; the privacy rule (an unshared personal event reveals nothing to
-- anyone else, in every read, the widget, the event page, errors, the trash and the audit log; sharing
-- shows it in full to that Home only, read-only; leaving the Home ends the share); Home calendar levels
-- (view, edit, edit and delete, manage; the creator has no extra right; managers never change their own
-- level); participants; all-day and timed events, timezones and daylight-saving gaps; recurrence with
-- the three edit and delete scopes and their previews, exceptions, splits and rule changes; stale
-- revisions; trash and restore; vacation banners and their toggle; isolation between Homes and forged ids.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;
-- The request id a test created an event with (the stored id is derived from it and the caller).
create temporary table client_ids (name text primary key, id uuid not null) on commit drop;
grant all on client_ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');

insert into ids select n, gen_random_uuid() from unnest(array[
  'e-secret', 'e-shared', 'e-home', 'e-weekly', 'e-weekly-2', 'e-b', 'e-bad', 'e-allday', 'e-daily',
  'e-carol', 'e-gap', 'e-bob-b'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.rev(p_name text) returns integer
  language sql security definer as $$ select revision from private.calendar_events where id = tests.i(p_name); $$;
-- A timed event body in Brussels time.
create function tests.timed(p_title text, p_on date, p_from text, p_to text, p_extra jsonb default '{}')
returns jsonb
  language sql immutable as $$
  select jsonb_build_object('title', p_title, 'allDay', false, 'startsOn', p_on, 'endsOn', p_on,
    'startTime', p_from, 'endTime', p_to, 'timezone', 'Europe/Brussels') || p_extra; $$;
-- Creates with the name's request id and remembers the event's stored id under the name.
create function tests.create(p_name text, p_home text, p_body jsonb) returns text
  language plpgsql as $$
  declare
    v_client uuid;
    v jsonb;
  begin
    select c.id into v_client from client_ids c where c.name = p_name;
    if v_client is null then
      v_client := tests.i(p_name);
      insert into client_ids values (p_name, v_client);
    end if;
    v := public.create_calendar_event(v_client, p_body, tests.i(p_home));
    if v ? 'id' then
      update ids set id = (v ->> 'id')::uuid where name = p_name;
    end if;
    return v ->> 'outcome';
  end $$;
-- Remembers the new series of a 'following' change under p_name, and passes the answer on.
create function tests.adopt(p_name text, p_answer jsonb) returns jsonb
  language plpgsql as $$
  begin
    if p_answer ->> 'outcome' = 'saved' then
      update ids set id = (p_answer ->> 'id')::uuid where name = p_name;
    end if;
    return p_answer;
  end $$;
-- The titles a caller sees in a context over a window.
create function tests.titles(p_home text, p_from date, p_to date) returns text[]
  language plpgsql as $$
  begin
    return (select coalesce(array_agg(o ->> 'title' order by n), '{}')
      from jsonb_array_elements(public.list_calendar(p_from, p_to, tests.i(p_home), 'Europe/Brussels') -> 'occurrences')
        with ordinality as a(o, n));
  end $$;
create function tests.dates(p_home text, p_event text, p_from date, p_to date) returns date[]
  language plpgsql as $$
  begin
    return (select coalesce(array_agg((o ->> 'from')::date order by n), '{}')
      from jsonb_array_elements(public.list_calendar(p_from, p_to, tests.i(p_home), 'Europe/Brussels') -> 'occurrences')
        with ordinality as a(o, n) where (o ->> 'eventId')::uuid = tests.i(p_event));
  end $$;
create function tests.event(p_name text, p_home text default null, p_on date default null) returns jsonb
  language plpgsql as $$
  begin return public.get_calendar_event(tests.i(p_name), tests.i(p_home), p_on, 'Europe/Brussels'); end $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.trash_ids(p_home text) returns text[]
  language plpgsql as $$
  begin return (select coalesce(array_agg(t.label order by t.label), '{}') from public.list_trash(tests.i(p_home), 'calendar', null) t); end $$;
grant execute on function tests.i(text), tests.rev(text), tests.timed(text, date, text, text, jsonb),
  tests.create(text, text, jsonb), tests.adopt(text, jsonb), tests.titles(text, date, date), tests.dates(text, text, date, date),
  tests.event(text, text, date), tests.private_count(text), tests.trash_ids(text)
  to authenticated, service_role;

-- Nothing is reachable as a table ---------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.calendar_events', 'The API cannot read events');
select tests.assert_denied('select * from private.calendar_event_shares', 'Nor shares');
select tests.assert_denied('select * from private.calendar_event_exceptions', 'Nor exceptions');
select tests.assert_denied('select * from private.home_calendar_access', 'Nor calendar levels');
select tests.assert_denied('select * from private.calendar_view_preferences', 'Nor view settings');
select tests.assert_denied($$select private.calendar_level(tests.i('home-a'), tests.user_id('alice'))$$,
  'Nor the helpers');
select tests.assert_denied($$select private.can_see_trash_entry_before_calendar(null, null)$$, 'Nor the renamed rule');
select tests.act_as_anon();
select tests.assert_denied($$select public.list_calendar(current_date, current_date, null)$$,
  'Nobody signed out reads a calendar');

-- Personal events and the privacy rule ------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.create('e-secret', null, tests.timed('Dokter', date '2026-12-01', '09:00', '10:00')) = 'created',
  'Alice adds a personal event');
select tests.assert_true(tests.create('e-secret', null, tests.timed('Dokter', date '2026-12-01', '09:00', '10:00')) = 'exists',
  'A retry answers exists');
select tests.assert_true(tests.create('e-shared', null, tests.timed('Verjaardag', date '2026-12-01', '18:00', '22:00',
  jsonb_build_object('shares', jsonb_build_array(tests.i('home-a'))))) = 'created',
  'And one she shares with Home A');
select tests.assert_true(tests.create('e-bad', null, tests.timed('X', date '2026-12-01', '09:00', '10:00',
  jsonb_build_object('shares', jsonb_build_array(tests.i('home-b'))))) = 'invalid_home',
  'She cannot share with a Home she is not in');
select tests.assert_true(tests.titles(null, date '2026-12-01', date '2026-12-01') = array['Dokter', 'Verjaardag'],
  'Her Personal calendar lists both, in time order');
select tests.assert_true(tests.titles('home-a', date '2026-12-01', date '2026-12-01') = array['Verjaardag'],
  'Home A lists only the shared one');
select tests.assert_true((tests.event('e-shared') -> 'shares') = jsonb_build_array(tests.i('home-a')),
  'The owner sees where it is shared');
select tests.assert_true((tests.event('e-secret', 'home-a')) is null, 'Not the unshared one through Home A');

select tests.act_as('carol');
select tests.assert_true(tests.titles(null, date '2026-11-25', date '2026-12-10') = '{}',
  'Carol''s Personal calendar holds nothing of Alice''s');
select tests.assert_true(tests.titles('home-a', date '2026-12-01', date '2026-12-01') = array['Verjaardag'],
  'Home A shows Carol the shared event, and nothing else: no busy block');
select tests.assert_true((select count(*) from jsonb_array_elements(
    public.list_calendar(date '2026-12-01', date '2026-12-01', tests.i('home-a')) -> 'occurrences')) = 1,
  'Exactly one occurrence that day (the unshared one adds nothing)');
select tests.assert_true((select o ->> 'kind' = 'shared' and (o ->> 'sharedBy')::uuid = tests.i('m-alice-a')
    and o ->> 'startsAt' is not null
  from jsonb_array_elements(public.list_calendar(date '2026-12-01', date '2026-12-01', tests.i('home-a')) -> 'occurrences') o),
  'In full, marked as shared by Alice');
select tests.assert_true(tests.event('e-secret') is null and tests.event('e-secret', 'home-a') is null,
  'The unshared event reads as nothing, in Personal and through the Home');
select tests.assert_true(tests.event('e-shared') is null, 'The shared one is not hers in Personal');
select tests.assert_true((tests.event('e-shared', 'home-a') ->> 'title') is null
  and (tests.event('e-shared', 'home-a') -> 'series' ->> 'title') = 'Verjaardag'
  and (tests.event('e-shared', 'home-a') -> 'shares') = 'null'::jsonb
  and (tests.event('e-shared', 'home-a') ->> 'canEdit')::boolean = false
  and (tests.event('e-shared', 'home-a') ->> 'canDelete')::boolean = false,
  'Through Home A she reads it, without the share list, and may neither edit nor delete it');
select tests.assert_true(
  (public.update_calendar_event(tests.i('e-secret'), 1, tests.timed('Hack', date '2026-12-01', '09:00', '10:00'), null, null) ->> 'outcome') = 'not_found'
  and (public.update_calendar_event(tests.i('e-shared'), 1, tests.timed('Hack', date '2026-12-01', '09:00', '10:00'), null, null) ->> 'outcome') = 'not_found'
  and (public.delete_calendar_event(tests.i('e-secret'), 1, null, null) ->> 'outcome') = 'not_found'
  and (public.delete_calendar_event(tests.i('e-shared'), 1, null, null) ->> 'outcome') = 'not_found'
  and (public.set_calendar_event_shares(tests.i('e-secret'), 1, array[tests.i('home-a')]) ->> 'outcome') = 'not_found'
  and (public.update_calendar_event(gen_random_uuid(), 1, tests.timed('Hack', date '2026-12-01', '09:00', '10:00'), null, null) ->> 'outcome') = 'not_found',
  'Changing, deleting or sharing someone else''s event answers not_found, exactly like a missing id');
select tests.assert_true((select r ->> 'outcome' = 'created' and (r ->> 'id')::uuid <> tests.i('e-secret')
    from (select public.create_calendar_event((select c.id from client_ids c where c.name = 'e-secret'),
      tests.timed('Mine', date '2026-12-01', '09:00', '10:00'), null) as r) x),
  'Reusing someone else''s request id simply creates one''s own event: nothing tells that theirs exists');
select tests.assert_true((public.get_calendar_upcoming(30, 10, tests.i('home-a')) -> 'occurrences') = '[]'::jsonb
  or not exists (select 1 from jsonb_array_elements(public.get_calendar_upcoming(30, 10, tests.i('home-a')) -> 'occurrences') o
    where (o ->> 'eventId')::uuid = tests.i('e-secret')),
  'The widget never holds the unshared event');

select tests.act_as('bob');
select tests.assert_true(tests.titles('home-b', date '2026-12-01', date '2026-12-01') = '{}',
  'Home B, where Alice is not, shows nothing of hers');
select tests.assert_denied($$select public.list_calendar(date '2026-12-10', date '2026-12-01', tests.i('home-b'))$$,
  'A reversed window is refused', '22023');
select tests.assert_denied($$select public.list_calendar(date '2026-01-01', date '2026-12-01', tests.i('home-b'))$$,
  'And one over 62 days', '22023');

-- Unsharing and leaving end the share
select tests.act_as('alice');
select tests.assert_true((public.update_calendar_event(tests.i('e-shared'), tests.rev('e-shared'),
    tests.timed('Verjaardag!', date '2026-12-01', '18:00', '22:00'), null, null) ->> 'outcome') = 'saved'
  and (tests.event('e-shared') -> 'shares') = jsonb_build_array(tests.i('home-a')),
  'A change without shares keeps them (an edit never unshares by leaving them out)');
select tests.assert_true((public.set_calendar_event_shares(tests.i('e-shared'), tests.rev('e-shared'), '{}') ->> 'outcome') = 'saved',
  'Alice stops sharing');
select tests.act_as('carol');
select tests.assert_true(tests.titles('home-a', date '2026-12-01', date '2026-12-01') = '{}'
  and tests.event('e-shared', 'home-a') is null, 'It is gone from Home A at once');
select tests.act_as('bob');
select tests.assert_true(tests.create('e-bob-b', null, tests.timed('Bobs avond', date '2026-12-02', '20:00', '23:00',
  jsonb_build_object('shares', jsonb_build_array(tests.i('home-a'), tests.i('home-b'))))) = 'created',
  'Bob shares a personal event with both his Homes');
select tests.act_as('carol');
select tests.assert_true(tests.titles('home-a', date '2026-12-02', date '2026-12-02') = array['Bobs avond'],
  'Carol sees it in Home A');
select tests.act_as('alice');
select public.remove_home_member(tests.i('home-a'), tests.i('m-bob-a'), 'administrator');
select tests.act_as('carol');
select tests.assert_true(tests.titles('home-a', date '2026-12-02', date '2026-12-02') = '{}',
  'When Bob leaves Home A, his event is no longer shared there');
select tests.act_as('bob');
select tests.assert_true(tests.titles('home-b', date '2026-12-02', date '2026-12-02') = array['Bobs avond']
  and (tests.event('e-bob-b') -> 'shares') = jsonb_build_array(tests.i('home-b')),
  'It stays shared with Home B');
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values (tests.i('home-a'), tests.user_id('bob'), 'administrator');
update ids set id = (select id from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('bob'))
  where name = 'm-bob-a';
select tests.act_as('carol');
select tests.assert_true(tests.titles('home-a', date '2026-12-02', date '2026-12-02') = '{}',
  'Rejoining does not bring the share back');

-- Home events and calendar levels --------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((public.list_calendar(date '2026-12-01', date '2026-12-01', tests.i('home-a')) ->> 'level') = 'edit',
  'A member starts at edit');
select tests.assert_true(tests.create('e-home', 'home-a', tests.timed('Etentje', date '2026-12-05', '19:00', '21:00',
  jsonb_build_object('participants', jsonb_build_array(tests.i('m-carol-a'), tests.i('m-alice-a'))))) = 'created',
  'Carol adds a Home event with participants');
select tests.assert_true(tests.create('e-bad', 'home-a', tests.timed('X', date '2026-12-05', '19:00', '21:00',
  jsonb_build_object('participants', jsonb_build_array(gen_random_uuid())))) = 'invalid_member',
  'A participant must be a current member');
select tests.assert_denied($$select tests.create('e-bad', 'home-a', tests.timed('X', date '2026-12-05', '19:00', '21:00',
  jsonb_build_object('shares', jsonb_build_array(tests.i('home-a')))))$$, 'A Home event has no shares', '22023');
select tests.assert_denied($$select tests.create('e-bad', 'home-b', tests.timed('X', date '2026-12-05', '19:00', '21:00'))$$,
  'Not in a Home she is not in (42501)');
select tests.assert_true((tests.event('e-home', 'home-a') ->> 'canEdit')::boolean
  and not (tests.event('e-home', 'home-a') ->> 'canDelete')::boolean,
  'At edit she may edit but not delete, even her own event');
select tests.assert_true((public.delete_calendar_event(tests.i('e-home'), tests.rev('e-home'), null, null) ->> 'outcome') = 'not_permitted',
  'Deleting is refused');
select tests.assert_true(tests.event('e-home') is null, 'A Home event is not in Personal');
select tests.act_as('alice');
select tests.assert_true((tests.event('e-home', 'home-a') -> 'series' -> 'participants')
    = jsonb_build_array(tests.i('m-carol-a'), tests.i('m-alice-a')),
  'Participants read back as membership ids');
select tests.assert_true(
  (public.update_calendar_event(tests.i('e-home'), tests.rev('e-home'), tests.timed('Etentje bij Alice', date '2026-12-05', '19:00', '21:00'), null, null) ->> 'outcome') = 'saved',
  'The Owner edits a member''s Home event');
select tests.assert_true(public.set_home_calendar_access(tests.i('home-a'), tests.i('m-carol-a'), 'view') = 'ok',
  'The Owner sets Carol to view');
select tests.assert_true(public.set_home_calendar_access(tests.i('home-a'), tests.i('m-alice-a'), 'view') = 'not_permitted',
  'Not her own level');
select tests.act_as('carol');
select tests.assert_true((public.update_calendar_event(tests.i('e-home'), tests.rev('e-home'), tests.timed('Hack', date '2026-12-05', '19:00', '21:00'), null, null) ->> 'outcome') = 'not_permitted'
  and tests.create('e-carol', 'home-a', tests.timed('Mine', date '2026-12-06', '10:00', '11:00')) = 'not_permitted'
  and not (tests.event('e-home', 'home-a') ->> 'canEdit')::boolean,
  'At view, Carol neither edits nor creates, though she created the event (the creator has no extra right)');
select tests.assert_true(public.set_home_calendar_access(tests.i('home-a'), tests.i('m-bob-a'), 'view') = 'not_permitted',
  'A member does not set levels');
select tests.act_as('alice');
select public.set_home_calendar_access(tests.i('home-a'), tests.i('m-carol-a'), 'edit_delete');
select tests.act_as('carol');
select tests.assert_true((tests.event('e-home', 'home-a') ->> 'canDelete')::boolean, 'At edit and delete, she may delete');
select tests.act_as('bob');
select tests.assert_true(public.set_home_calendar_access(tests.i('home-a'), tests.i('m-carol-a'), 'view') = 'not_permitted',
  'An Administrator without manageHomeCalendar does not set levels');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeCalendar']);
select tests.act_as('bob');
select tests.assert_true((public.list_calendar(date '2026-12-01', date '2026-12-01', tests.i('home-a')) ->> 'level') = 'manage'
  and public.set_home_calendar_access(tests.i('home-a'), tests.i('m-carol-a'), 'edit') = 'ok'
  and public.set_home_calendar_access(tests.i('home-a'), tests.i('m-bob-a'), 'view') = 'not_permitted'
  and public.set_home_calendar_access(tests.i('home-a'), tests.i('m-alice-a'), 'view') = 'not_permitted',
  'Granted manageHomeCalendar, Bob manages and sets levels, never his own or a manager''s');
select tests.assert_true(jsonb_array_length(public.list_home_calendar_access(tests.i('home-a')) -> 'members') = 3,
  'A manager lists every member''s level');
select tests.act_as('carol');
select tests.assert_true(jsonb_array_length(public.list_home_calendar_access(tests.i('home-a')) -> 'members') = 1,
  'A member sees only her own');
select tests.act_as_owner();
select tests.assert_true((select count(*) from private.audit_events where action = 'calendar.access.changed'
  and home_id = tests.i('home-a')) = 3, 'Level changes are audited');
select tests.assert_true(not exists (select 1 from private.audit_events where action like 'calendar.%'
    and (subject_id in (tests.i('e-secret'), tests.i('e-shared'), tests.i('e-bob-b')) or details::text like '%Etentje%')),
  'The audit log never holds a personal event, nor any title');

-- All-day and timed events, timezones -----------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.create('e-allday', 'home-a', jsonb_build_object('title', 'Kerstmarkt', 'allDay', true,
  'startsOn', '2026-12-30', 'endsOn', '2027-01-02', 'timezone', 'Europe/Brussels')) = 'created',
  'An all-day event over the new year');
select tests.assert_true(tests.dates('home-a', 'e-allday', date '2027-01-01', date '2027-01-31') = array[date '2026-12-30'],
  'It shows in a window that starts inside it');
select tests.assert_true(tests.create('e-gap', null, tests.timed('Nacht', date '2027-03-28', '02:30', '03:30')) = 'nonexistent_time',
  'A time the clock skips in spring is refused');
select tests.assert_true(tests.create('e-gap', null, tests.timed('Nacht', date '2027-03-28', '04:00', '03:30')) = 'invalid_dates',
  'An end before the start is refused');
select tests.assert_true(tests.create('e-gap', null, jsonb_build_object('title', 'Lang', 'allDay', false,
  'startsOn', '2027-01-01', 'endsOn', '2027-01-20', 'startTime', '10:00', 'endTime', '11:00',
  'timezone', 'Europe/Brussels')) = 'invalid_dates', 'A timed event lasts at most 14 days');
select tests.assert_denied($$select tests.create('e-gap', null, tests.timed('X', date '2027-01-01', '10:00', '11:00',
  '{"timezone": "Mars/Base"}'))$$, 'An unknown timezone is refused', '22023');
select tests.assert_denied($$select tests.create('e-gap', null, tests.timed('', date '2027-01-01', '10:00', '11:00'))$$,
  'A blank title is refused', '22023');
select tests.assert_true(tests.create('e-gap', null, tests.timed('Call', date '2027-01-04', '09:00', '10:00',
  '{"timezone": "America/New_York"}')) = 'created', 'An event in another timezone');
select tests.assert_true((select (o ->> 'startsAt')::timestamptz = timestamptz '2027-01-04 14:00:00+00'
    and (o ->> 'from')::date = date '2027-01-04' and o ->> 'timezone' = 'America/New_York'
  from jsonb_array_elements(public.list_calendar(date '2027-01-04', date '2027-01-04', null, 'Europe/Brussels') -> 'occurrences') o
  where (o ->> 'eventId')::uuid = tests.i('e-gap')), 'It is stored as its own instant, shown in her timezone');
select tests.assert_true(exists (select 1
  from jsonb_array_elements(public.list_calendar(date '2027-01-04', date '2027-01-04', null, 'Pacific/Auckland') -> 'occurrences') o
  where (o ->> 'eventId')::uuid = tests.i('e-gap') and (o ->> 'from')::date = date '2027-01-04') is false,
  'In Auckland the same instant falls on 5 January, outside a window of the 4th');

-- Recurrence and the three scopes -----------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.create('e-weekly', 'home-a', tests.timed('Zwemmen', date '2027-03-15', '18:00', '19:00',
  jsonb_build_object('repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(1),
    'count', 6)))) = 'created', 'A weekly Monday event, six times');
select tests.assert_true(tests.create('e-bad', 'home-a', tests.timed('X', date '2027-03-16', '18:00', '19:00',
  jsonb_build_object('repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(1))))) = 'invalid_dates',
  'A weekly event must start on one of its weekdays');
select tests.assert_true(tests.dates('home-a', 'e-weekly', date '2027-03-01', date '2027-04-30')
    = array[date '2027-03-15', '2027-03-22', '2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19'],
  'Six Mondays');
select tests.assert_true((select (o ->> 'startsAt')::timestamptz = timestamptz '2027-03-29 16:00:00+00'
  from jsonb_array_elements(public.list_calendar(date '2027-03-29', date '2027-03-29', tests.i('home-a')) -> 'occurrences') o
  where (o ->> 'eventId')::uuid = tests.i('e-weekly')), 'After the clocks go forward it stays at 18:00 local');

-- This event
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('Zwemmen', date '2027-03-22', '18:00', '19:00'), 'only', date '2027-03-22', true) ->> 'outcome') = 'preview',
  'A preview for one occurrence');
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('Zwemmen (laat)', date '2027-03-23', '20:00', '21:00'), 'only', date '2027-03-22') ->> 'outcome') = 'saved',
  'One occurrence moves to Tuesday evening with a new title');
select tests.assert_true(tests.dates('home-a', 'e-weekly', date '2027-03-01', date '2027-04-30')
    = array[date '2027-03-15', '2027-03-23', '2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19'],
  'Only that one moved');
select tests.assert_true((tests.event('e-weekly', 'home-a', date '2027-03-22') -> 'occurrence' ->> 'title') = 'Zwemmen (laat)'
  and (tests.event('e-weekly', 'home-a', date '2027-03-22') -> 'occurrence' ->> 'changed')::boolean,
  'The occurrence reads with its change');
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('X', date '2027-03-24', '18:00', '19:00'), 'only', date '2027-03-24') ->> 'outcome') = 'invalid_scope',
  'A date that is not an occurrence is refused');
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly') - 1, tests.timed('X', date '2027-03-15', '18:00', '19:00'), 'all', null) ->> 'outcome') = 'stale', 'An old revision is stale');
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('X', date '2027-03-15', '18:00', '19:00'), null, null) ->> 'outcome') = 'invalid_scope',
  'A recurring event needs a scope');

-- All events: a title change keeps the moved occurrence's own title
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('Zwemles', date '2027-03-15', '18:30', '19:30',
    jsonb_build_object('repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(1),
      'count', 6))), 'all', null) ->> 'outcome') = 'saved', 'All events get a new title and time');
select tests.assert_true(tests.titles('home-a', date '2027-03-15', date '2027-03-23') = array['Zwemles', 'Zwemmen (laat)'],
  'The changed occurrence keeps its own title');

-- This and following
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('Zwemles', date '2027-04-07', '18:30', '19:30',
    jsonb_build_object('repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(3)))), 'following', date '2027-04-05', true, tests.i('e-weekly-2')) -> 'dates') = '["2027-04-05", "2027-04-12", "2027-04-19"]'::jsonb,
  'The preview lists the occurrences from that one on');
select tests.assert_true((public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('Zwemles', date '2027-03-29', '18:30', '19:30',
    jsonb_build_object('repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(1)))), 'following', date '2027-04-05', false, tests.i('e-weekly-2')) ->> 'outcome') = 'invalid_dates',
  'The new part cannot start on or before the old part''s last occurrence');
select tests.assert_true((tests.adopt('e-weekly-2', public.update_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), tests.timed('Zwemles', date '2027-04-07', '18:30', '19:30',
    jsonb_build_object('repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(3),
      'count', 3))), 'following', date '2027-04-05', false, tests.i('e-weekly-2'))) ->> 'outcome') = 'saved',
  'From 5 April it moves to Wednesdays');
select tests.assert_true(tests.dates('home-a', 'e-weekly', date '2027-03-10', date '2027-05-09')
    = array[date '2027-03-15', '2027-03-23', '2027-03-29']
  and tests.dates('home-a', 'e-weekly-2', date '2027-03-10', date '2027-05-09')
    = array[date '2027-04-07', '2027-04-14', '2027-04-21'],
  'The history stays; the new series takes over');

-- Delete scopes
select public.set_home_calendar_access(tests.i('home-a'), tests.i('m-carol-a'), 'edit_delete');
select tests.act_as('carol');
select tests.assert_true((public.delete_calendar_event(tests.i('e-weekly-2'), tests.rev('e-weekly-2'), 'only', date '2027-04-14') ->> 'outcome') = 'deleted',
  'At edit and delete Carol cancels one occurrence');
select tests.assert_true(tests.dates('home-a', 'e-weekly-2', date '2027-03-10', date '2027-05-09')
    = array[date '2027-04-07', '2027-04-21'], 'It is gone, the rest stays');
select tests.assert_true((public.delete_calendar_event(tests.i('e-weekly-2'), tests.rev('e-weekly-2'), 'following', date '2027-04-21', true) -> 'dates')
    = '["2027-04-21"]'::jsonb, 'The preview of this and following');
select tests.assert_true((public.delete_calendar_event(tests.i('e-weekly-2'), tests.rev('e-weekly-2'), 'following', date '2027-04-21') ->> 'outcome') = 'deleted'
  and tests.dates('home-a', 'e-weekly-2', date '2027-03-10', date '2027-05-09') = array[date '2027-04-07'],
  'This and following ends the series');
select tests.assert_true((public.delete_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), 'all', null, true) ->> 'trash')::boolean,
  'Deleting all events previews the trash');
select tests.assert_true((public.delete_calendar_event(tests.i('e-weekly'), tests.rev('e-weekly'), 'all', null) ->> 'outcome') = 'deleted'
  and tests.dates('home-a', 'e-weekly', date '2027-03-10', date '2027-05-09') = '{}',
  'All events go to the trash');
select tests.assert_true(tests.trash_ids('home-a') = array['Zwemles'], 'Carol sees the trash entry');
select tests.act_as('alice');
select public.set_home_calendar_access(tests.i('home-a'), tests.i('m-carol-a'), 'edit');
select tests.act_as('carol');
select tests.assert_true(tests.trash_ids('home-a') = '{}', 'Back at edit, she no longer sees it');
select tests.act_as('alice');
select tests.assert_true(tests.trash_ids('home-a') = array['Zwemles'], 'The Owner does');
select public.restore_trash_entries(array(select entry_id from public.list_trash(tests.i('home-a'), 'calendar', null)));
select tests.assert_true(tests.dates('home-a', 'e-weekly', date '2027-03-10', date '2027-05-09')
    = array[date '2027-03-15', '2027-03-23', '2027-03-29'], 'Restored with its changed occurrence');

-- Rule changes drop exceptions that no longer fit; monthly and daily rules
select tests.assert_true(tests.create('e-daily', null, tests.timed('Medicatie', date '2027-01-31', '08:00', '08:15',
  jsonb_build_object('repeat', jsonb_build_object('frequency', 'monthly', 'interval', 1, 'count', 3)))) = 'created',
  'A monthly event on the 31st');
select tests.assert_true(tests.dates(null, 'e-daily', date '2027-01-30', date '2027-03-31')
    = array[date '2027-01-31', '2027-02-28', '2027-03-31'], 'February falls back to its last day');
select tests.assert_true((public.delete_calendar_event(tests.i('e-daily'), tests.rev('e-daily'), 'only', date '2027-02-28') ->> 'outcome') = 'deleted',
  'One cancelled');
select tests.assert_true((public.update_calendar_event(tests.i('e-daily'), tests.rev('e-daily'), tests.timed('Medicatie', date '2027-01-31', '08:00', '08:15',
    jsonb_build_object('repeat', jsonb_build_object('frequency', 'daily', 'interval', 3, 'count', 20))), 'all', null, true) ->> 'removedChanges')::integer = 1,
  'A new rule previews the change it drops');
select public.update_calendar_event(tests.i('e-daily'), tests.rev('e-daily'), tests.timed('Medicatie', date '2027-01-31', '08:00', '08:15',
    jsonb_build_object('repeat', jsonb_build_object('frequency', 'daily', 'interval', 3, 'count', 20))), 'all', null);
select tests.assert_true(tests.private_count(format('select count(*) from private.calendar_event_exceptions where event_id = %L',
  tests.i('e-daily'))) = 0, 'And drops it');

-- Personal trash is the owner's alone
select tests.assert_true((public.delete_calendar_event(tests.i('e-secret'), tests.rev('e-secret'), null, null) ->> 'outcome') = 'deleted',
  'Alice deletes her personal event');
select tests.act_as('carol');
select tests.assert_true(tests.trash_ids('home-a') = '{}'
  and not exists (select 1 from public.list_trash(null, null, null) t where t.label = 'Dokter'),
  'Nobody else sees its trash entry');

-- Vacations on the Home calendar ---------------------------------------------------------------------

select tests.act_as('alice');
select * from public.create_home_vacation(gen_random_uuid(), tests.i('home-a'), 'Skireis',
  jsonb_build_array(jsonb_build_object('memberId', tests.i('m-alice-a'), 'startsOn', '2027-02-10', 'endsOn', '2027-02-17')));
select tests.assert_true(jsonb_array_length(public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) -> 'vacations') = 1,
  'A vacation shows as a banner');
select tests.assert_true(public.set_calendar_preferences(tests.i('home-a'), false) = 'ok', 'She hides vacations');
select tests.assert_true((public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) -> 'vacations') = '[]'::jsonb
  and not (public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showVacations')::boolean,
  'Hiding them is her own setting');
select tests.act_as('carol');
select tests.assert_true(jsonb_array_length(public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) -> 'vacations') = 1,
  'Carol still sees it');
select tests.assert_true((public.list_calendar(date '2027-02-01', date '2027-02-28', null) -> 'vacations') = '[]'::jsonb,
  'Never on the Personal calendar');

-- Task and chore overlays: the person's own settings, off until they turn them on.
select tests.act_as('carol');
select tests.assert_true(not (public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showTasks')::boolean
  and not (public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showChores')::boolean
  and not (public.list_calendar(date '2027-02-01', date '2027-02-28', null) ->> 'showTasks')::boolean,
  'Overlays start off');
select tests.assert_true(public.set_calendar_preferences(tests.i('home-a'), p_show_chores => true) = 'ok'
  and public.set_calendar_preferences(null, p_show_tasks => true) = 'ok', 'Carol turns on chores here and tasks on her own');
select tests.assert_true((public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showChores')::boolean
  and not (public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showTasks')::boolean
  and (public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showVacations')::boolean
  and (public.list_calendar(date '2027-02-01', date '2027-02-28', null) ->> 'showTasks')::boolean
  and not (public.list_calendar(date '2027-02-01', date '2027-02-28', null) ->> 'showChores')::boolean,
  'Each context keeps its own settings, and an unset value keeps its default');
select tests.act_as('alice');
select tests.assert_true(not (public.list_calendar(date '2027-02-01', date '2027-02-28', tests.i('home-a')) ->> 'showChores')::boolean
  and not (public.list_calendar(date '2027-02-01', date '2027-02-28', null) ->> 'showTasks')::boolean,
  'Nobody else''s settings change');
select tests.assert_denied($$select public.set_calendar_preferences(null, p_show_chores => true)$$,
  'Chores are a Home setting', '22023');
select tests.assert_denied($$select public.set_calendar_preferences(null, p_show_vacations => false)$$,
  'So are vacations', '22023');
select tests.assert_denied($$select public.set_calendar_preferences(tests.i('home-a'))$$, 'Something to save', '22023');
select tests.assert_denied($$select public.set_calendar_preferences(tests.i('home-b'), p_show_tasks => true)$$,
  'Not for a Home she is not in');

-- Reminders ----------------------------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids select n, gen_random_uuid() from unnest(array['e-rem-p', 'e-rem-h', 'e-rem-w']) as n;
create function tests.reminder_jobs(p_event text, p_on date default null) returns bigint
  language sql stable security definer as $$
  select count(*) from private.job_outbox where job_name = 'calendar-event-reminder'
    and payload ->> 'eventId' = tests.i(p_event)::text and (p_on is null or (payload ->> 'on')::date = p_on); $$;
create function tests.reminder_at(p_event text, p_on date) returns timestamptz
  language sql stable security definer as $$
  select private.calendar_reminder_at(e, private.calendar_effective(e, p_on)) from private.calendar_events e
  where e.id = tests.i(p_event); $$;
create function tests.reminder_notices(p_user text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications n where n.user_id = tests.user_id(p_user) and n.kind = 'calendar.reminder'; $$;
-- Puts an event's (first) occurrence at Brussels "now + p_minutes", so its reminder moment is near.
create function tests.start_in(p_event text, p_minutes integer) returns void
  language plpgsql security definer as $$
  declare v_start timestamp := date_trunc('minute', (now() at time zone 'Europe/Brussels')) + make_interval(mins => p_minutes);
  begin
    update private.calendar_events set starts_on = v_start::date, start_time = v_start::time,
      ends_on = (v_start + interval '30 minutes')::date, end_time = (v_start + interval '30 minutes')::time,
      frequency = null, interval_count = null, weekdays = null, repeat_ends_on = null, max_count = null,
      until_date = null
      where id = tests.i(p_event);
  end $$;
grant execute on function tests.reminder_jobs(text, date), tests.reminder_at(text, date),
  tests.reminder_notices(text), tests.start_in(text, integer) to authenticated, service_role;

select tests.act_as('alice');
select tests.assert_denied($$select public.create_calendar_event(gen_random_uuid(),
    tests.timed('Te vroeg', current_date + 5, '10:00', '11:00', '{"reminder": 5}'), null)$$,
  'Only the offered reminder offsets', '22023');
select tests.assert_true(tests.create('e-rem-p', null, tests.timed('Tandarts', current_date + 5, '10:00', '11:00',
  jsonb_build_object('reminder', 15, 'shares', jsonb_build_array(tests.i('home-a'))))) = 'created',
  'A personal event with a reminder, shared with her Home');
select tests.assert_true(tests.reminder_jobs('e-rem-p', current_date + 5) = 1, 'Its reminder is queued');
select tests.assert_true((tests.event('e-rem-p') ->> 'reminder')::integer = 15, 'She sees her reminder');
select tests.assert_true(tests.create('e-rem-h', 'home-a', tests.timed('Loodgieter', current_date + 5, '14:00', '15:00',
  jsonb_build_object('reminder', 60, 'participants', jsonb_build_array(tests.i('m-carol-a'))))) = 'created',
  'A Home event with a participant and a reminder');
select tests.assert_true(tests.create('e-rem-w', 'home-a', tests.timed('Koor', current_date + 1, '20:00', '21:00',
  jsonb_build_object('reminder', 1440, 'repeat', jsonb_build_object('frequency', 'daily', 'interval', 1, 'weekdays', null,
    'endsOn', null, 'count', 5)))) = 'created', 'A daily Home event reminded a day before');
select tests.assert_true(tests.reminder_jobs('e-rem-w') = 1, 'One job: only the next occurrence is queued');
select tests.act_as('carol');
select tests.assert_true((tests.event('e-rem-p', 'home-a') ->> 'reminder') is null,
  'Someone''s shared event never shows its reminder');
select tests.assert_true((tests.event('e-rem-h', 'home-a') ->> 'reminder')::integer = 60, 'A Home event shows its own');

select tests.act_as('alice');
select tests.assert_denied($$select public.deliver_calendar_reminder(tests.i('e-rem-p'), current_date, now())$$,
  'Only the job delivers reminders');

-- Delivery: the personal event reminds its owner only, once, with ids only.
select tests.act_as_owner();
select tests.start_in('e-rem-p', 10);
select tests.act_as_service_role();
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-p'), current_date + 5,
  (((current_date + 5) + time '10:00') at time zone 'Europe/Brussels') - interval '15 minutes') = 'stale',
  'A moved occurrence''s old job is stale');
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-p'),
  (now() at time zone 'Europe/Brussels' + interval '10 minutes')::date,
  tests.reminder_at('e-rem-p', (now() at time zone 'Europe/Brussels' + interval '10 minutes')::date)) = 'notified',
  'The current moment notifies');
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-p'),
  (now() at time zone 'Europe/Brussels' + interval '10 minutes')::date,
  tests.reminder_at('e-rem-p', (now() at time zone 'Europe/Brussels' + interval '10 minutes')::date)) = 'notified',
  'A duplicate run');
select tests.assert_true(tests.reminder_notices('alice') = 1 and tests.reminder_notices('carol') = 0
  and tests.reminder_notices('bob') = 0, 'Its owner only, once: sharing reminds nobody else');
select tests.assert_true((select bool_and(position('Tandarts' in n.params::text) = 0) from public.notifications n
  where n.kind = 'calendar.reminder'), 'The notice carries ids only');

-- A Home event reminds its participants; one not yet due, then due.
select tests.act_as_owner();
select tests.start_in('e-rem-h', 120);
select tests.act_as_service_role();
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-h'),
  (now() at time zone 'Europe/Brussels' + interval '120 minutes')::date,
  tests.reminder_at('e-rem-h', (now() at time zone 'Europe/Brussels' + interval '120 minutes')::date)) = 'not_due',
  'Not before its moment');
select tests.act_as_owner();
select tests.start_in('e-rem-h', 50);
select tests.act_as_service_role();
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-h'),
  (now() at time zone 'Europe/Brussels' + interval '50 minutes')::date,
  tests.reminder_at('e-rem-h', (now() at time zone 'Europe/Brussels' + interval '50 minutes')::date)) = 'notified',
  'Ten minutes after its moment');
select tests.assert_true(tests.reminder_notices('carol') = 1 and tests.reminder_notices('bob') = 0
  and tests.reminder_notices('alice') = 1, 'Its participant only');

-- After delivery the next occurrence is queued; a cancelled or deleted one is stale.
select tests.act_as('alice');
select tests.assert_true((public.delete_calendar_event(tests.i('e-rem-w'), tests.rev('e-rem-w'), 'only', current_date + 2)
  ->> 'outcome') = 'deleted', 'One occurrence cancelled');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-w'), current_date + 2,
  ((current_date + 1) + time '20:00') at time zone 'Europe/Brussels') = 'stale', 'A cancelled occurrence is stale');
select tests.act_as('alice');
select tests.assert_true((public.delete_calendar_event(tests.i('e-rem-h'), tests.rev('e-rem-h'), null, null)
  ->> 'outcome') = 'deleted', 'The Home event goes to the trash');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_calendar_reminder(tests.i('e-rem-h'), current_date, now()) = 'stale',
  'A deleted event reminds nobody');

-- Notice titles: only what the reader may see now.
select tests.act_as('alice');
select tests.assert_true((select array_agg(title order by title) from public.calendar_notice_titles(
  array[tests.i('e-rem-p'), tests.i('e-rem-w'), tests.i('e-bob-b')])) = array['Koor', 'Tandarts'],
  'Her own event and her Home''s, not another Home''s');
select tests.act_as('carol');
select tests.assert_true((select array_agg(title) from public.calendar_notice_titles(array[tests.i('e-rem-p'), tests.i('e-rem-w')]))
  = array['Koor'], 'Never someone''s personal event, shared or not');

-- A fall-back time (it happens twice) is the second one, standard time, as the form says.
select tests.act_as_owner();
insert into ids values ('e-overlap', gen_random_uuid());
select tests.act_as('alice');
select tests.assert_true(tests.create('e-overlap', null, tests.timed('Nachtdienst', date '2026-10-25', '02:30', '03:30')) = 'created',
  'An event at 02:30 on the night the clocks go back');
select tests.assert_true((select (o ->> 'startsAt')::timestamptz = timestamptz '2026-10-25 01:30:00+00'
    from jsonb_array_elements(public.list_calendar(date '2026-10-25', date '2026-10-25', null, 'Europe/Brussels') -> 'occurrences') o
    where (o ->> 'eventId')::uuid = tests.i('e-overlap')),
  'It starts at 02:30 standard time');
