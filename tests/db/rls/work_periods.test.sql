-- UX3a: work periods are personal recurring calendar events flagged `work_period`
-- (supabase/migrations/*_work_periods.sql). Alice owns Home A, where Bob and Carol are members.
-- Covers: the flag in every read; invisibility to Home members (list, event page, upcoming widget)
-- even when Alice looks through her Home; no Home work periods and no sharing; the flag is fixed after
-- creation; a changed or cancelled shift is a native exception; "this and following" keeps the flag.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'member'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');

create function tests.h() returns uuid language sql stable security definer as $$ select id from ids where name = 'home-a'; $$;
-- A weekday 08:00-16:00 shift pattern (Monday 2027-04-05 onward), Brussels time.
create function tests.shift(p_extra jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('title', 'Shift', 'allDay', false, 'startsOn', date '2027-04-05',
    'endsOn', date '2027-04-05', 'startTime', '08:00', 'endTime', '16:00', 'timezone', 'Europe/Brussels',
    'workPeriod', true,
    'repeat', jsonb_build_object('frequency', 'weekly', 'interval', 1, 'weekdays', jsonb_build_array(1, 2, 3, 4, 5)))
    || p_extra; $$;
create function tests.occurrences(p_home uuid) returns jsonb language sql as $$
  select public.list_calendar(date '2027-04-05', date '2027-04-11', p_home, 'Europe/Brussels') -> 'occurrences'; $$;
create function tests.work_count(p_home uuid) returns bigint language sql as $$
  select count(*) from jsonb_array_elements(tests.occurrences(p_home)) o where (o ->> 'workPeriod')::boolean; $$;
create function tests.stored_flag(p_id text) returns boolean language sql security definer as $$
  select work_period from private.calendar_events where id = p_id::uuid; $$;
create function tests.work_series_count() returns bigint language sql security definer as $$
  select count(*) from private.calendar_events where work_period and owner_user_id = tests.user_id('alice'); $$;
grant execute on function tests.work_series_count(), tests.h(), tests.shift(jsonb), tests.occurrences(uuid), tests.work_count(uuid),
  tests.stored_flag(text) to authenticated, service_role;

select tests.act_as('alice');
create temporary table made (name text primary key, id uuid not null, revision integer not null) on commit drop;
grant all on made to authenticated, service_role;
insert into made select 'shift', (r ->> 'id')::uuid, (r ->> 'revision')::integer
  from (select public.create_calendar_event(gen_random_uuid(), tests.shift(), null) as r) x;
insert into made select 'plain', (r ->> 'id')::uuid, (r ->> 'revision')::integer
  from (select public.create_calendar_event(gen_random_uuid(), tests.shift(jsonb_build_object(
    'title', 'Dentist', 'workPeriod', false, 'repeat', null)), null) as r) x;
select tests.assert_true((select count(*) = 2 from made), 'Both a work period and a plain event are created');
select tests.assert_true(tests.work_count(null) = 5, 'Alice sees five work-period occurrences in a week');
select tests.assert_true((select count(*) = 1 from jsonb_array_elements(tests.occurrences(null)) o
    where o ->> 'title' = 'Dentist' and not (o ->> 'workPeriod')::boolean),
  'A plain event reads as not a work period');
select tests.assert_true((public.get_calendar_event((select id from made where name = 'shift'), null,
    date '2027-04-06', 'Europe/Brussels') -> 'series' ->> 'workPeriod') = 'true'
  and (public.get_calendar_event((select id from made where name = 'shift'), null,
    date '2027-04-06', 'Europe/Brussels') -> 'occurrence' ->> 'workPeriod') = 'true',
  'The detail read carries the flag for series and occurrence');
select tests.assert_true(tests.work_count(tests.h()) = 0, 'Through her own Home, Alice sees no work period');

-- Nobody else learns of it ---------------------------------------------------------------------------
select tests.act_as('bob');
select tests.assert_true(tests.work_count(tests.h()) = 0 and jsonb_array_length(tests.occurrences(tests.h())) = 0,
  'A Home member sees nothing: no block, no busy time');
select tests.assert_true(public.get_calendar_event((select id from made where name = 'shift'), tests.h(), null,
    'Europe/Brussels') is null
  and public.get_calendar_event((select id from made where name = 'shift'), null, null, 'Europe/Brussels') is null,
  'The event page is empty for a member, in the Home and in Personal');
select tests.assert_true(jsonb_array_length(public.get_calendar_upcoming(30, 10, tests.h(), 'Europe/Brussels') -> 'occurrences') = 0,
  'The widget shows a member nothing');
select tests.assert_true((public.update_calendar_event((select id from made where name = 'shift'), 1,
    tests.shift(jsonb_build_object('title', 'Hack')), 'all', null) ->> 'outcome') = 'not_found'
  and (public.delete_calendar_event((select id from made where name = 'shift'), 1, 'all', null) ->> 'outcome') = 'not_found',
  'A member cannot change or delete it');

-- Personal only, never shared ------------------------------------------------------------------------
select tests.act_as('alice');
select tests.assert_denied(format('select public.create_calendar_event(gen_random_uuid(), %L::jsonb, %L)',
    tests.shift(), tests.h()),
  'A Home event cannot be a work period', '23514');
select tests.assert_denied(format('select public.create_calendar_event(gen_random_uuid(), %L::jsonb, null)',
    tests.shift(jsonb_build_object('shares', jsonb_build_array(tests.h())))),
  'A work period cannot be created shared', '22023');
select tests.assert_denied(format('select public.set_calendar_event_shares(%L, 1, %L)',
    (select id from made where name = 'shift'), array[tests.h()]),
  'A work period cannot be shared afterwards', '22023');
select tests.assert_denied(format('select public.create_calendar_event(gen_random_uuid(), %L::jsonb, null)',
    tests.shift(jsonb_build_object('workPeriod', 'yes'))),
  'The flag must be a boolean', '22023');
select tests.assert_true(tests.work_count(tests.h()) = 0, 'Still invisible through the Home');

-- The flag is fixed ----------------------------------------------------------------------------------
select tests.assert_true((public.update_calendar_event((select id from made where name = 'shift'), 1,
    tests.shift(jsonb_build_object('title', 'Early shift', 'workPeriod', false)), 'all', null) ->> 'outcome') = 'saved'
  and tests.stored_flag((select id::text from made where name = 'shift')),
  'An edit of the series keeps the flag whatever the body says');
select tests.act_as_owner();
select tests.assert_denied(format('update private.calendar_events set work_period = false where id = %L',
    (select id from made where name = 'shift')),
  'The flag cannot be changed in storage', '22023');

-- Exceptions and splits are native ---------------------------------------------------------------------
select tests.act_as('alice');
select tests.assert_true((public.delete_calendar_event((select id from made where name = 'shift'), 2, 'only', date '2027-04-07') ->> 'outcome') = 'deleted'
  and tests.work_count(null) = 4,
  'Cancelling one shift removes just that occurrence');
select tests.assert_true((public.update_calendar_event((select id from made where name = 'shift'), 3,
    tests.shift(jsonb_build_object('title', 'Early shift', 'startsOn', date '2027-04-08', 'endsOn', date '2027-04-08',
        'startTime', '10:00', 'endTime', '18:00')), 'only', date '2027-04-08') ->> 'outcome') = 'saved',
  'A shift can be moved');
select tests.assert_true((select (o ->> 'changed')::boolean and (o ->> 'workPeriod')::boolean from jsonb_array_elements(tests.occurrences(null)) o
    where o ->> 'from' = '2027-04-08' and o ->> 'title' = 'Early shift'),
  'A moved shift is a changed occurrence and still a work period');
select tests.assert_true(public.update_calendar_event((select id from made where name = 'shift'), 4,
    tests.shift(jsonb_build_object('title', 'Late shift', 'startsOn', date '2027-04-12', 'endsOn', date '2027-04-12')),
    'following', date '2027-04-12', false, gen_random_uuid()) ->> 'outcome' = 'saved',
  'A later change can start a new series');
select tests.assert_true(tests.work_series_count() = 2, 'The new series is also a work period');

-- Never copied into a Home -----------------------------------------------------------------------------
select tests.act_as_owner();
create function tests.copy_ok(p_event text) returns boolean language sql security definer as $$
  select private.copy_item_eligible('calendar_event', p_event::uuid, tests.user_id('alice')); $$;
grant execute on function tests.copy_ok(text) to authenticated, service_role;
select tests.act_as('alice');
select tests.assert_true(tests.copy_ok((select id::text from made where name = 'plain')),
  'A plain personal event can still be copied');
select tests.assert_true(not tests.copy_ok((select id::text from made where name = 'shift')),
  'A work period cannot be copied into a Home');
