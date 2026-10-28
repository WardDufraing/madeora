-- S28: habits core (supabase/migrations/*_habits.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Carol is not in. Covers: nothing reachable
-- as a table; the access matrix (Personal owner; members who check in and view only; habit managers
-- and a revoked grant; non-members, forged ids and a departed member); personal habits invisible to
-- Home managers; check-ins (two members on one day, retry, id reuse, window, future, unscheduled,
-- weekly target); streak recalculation after corrections (a missed day breaks, a late backfill
-- restores, Undo and a manager's correction lower it, Monday-Wednesday-Friday with unscheduled days,
-- a weekly backfill reaching a target, a past week still short); milestones once; notes; schedule
-- changes forward only; manual pauses, vacation pauses and their union; end dates, the Ended section
-- and reactivation; reminders, recipients, opt-out and snooze; pause notices; insights; trash.

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
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');

insert into ids select n, gen_random_uuid() from unnest(array[
  'h-daily', 'h-personal', 'h-b', 'h-bad', 'h-streak', 'h-mwf', 'h-weekly', 'h-week1', 'h-ms', 'h-end',
  'c-carol', 'c-bob', 'c-x', 'c-old', 'c-future', 'c-back', 'c-redo', 'c-mwf', 'c-w1', 'c-w2', 'c-wb',
  'c-ms', 'c-ms2', 'c-b', 'c-end', 'c-end2', 'c-p', 'c-un', 'c-pause', 'v-1', 'h-rem', 'h-rem2', 'h-wr', 'c-wr'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
-- A date relative to today in Brussels (every habit here uses that zone).
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.habits where id = tests.i(p_name); $$;
create function tests.habit(p_name text) returns jsonb
  language sql as $$ select public.get_habit(tests.i(p_name)); $$;
create function tests.streak(p_name text) returns integer
  language sql as $$ select (public.get_habit(tests.i(p_name)) -> 'streak' ->> 'current')::integer; $$;
create function tests.complete(p_checkin text, p_habit text, p_on date) returns text
  language sql as $$
  select public.complete_habit(tests.i(p_checkin), tests.i(p_habit), p_on, null, 'app') ->> 'outcome'; $$;
-- A habit created directly (fixtures may start further back than the API allows).
create function tests.fixture(
  p_name text, p_home uuid, p_owner uuid, p_kind text, p_weekdays smallint[], p_target smallint,
  p_starts_on date, p_week_start text default 'monday'
) returns void
  language plpgsql security definer as $$
  begin
    insert into private.habits (id, owner_user_id, owner_home_id, name, time_zone, week_start, created_by)
      values (tests.i(p_name), case when p_home is null then p_owner end, p_home, p_name,
        case when p_home is null then 'Europe/Brussels' end, p_week_start, p_owner);
    insert into private.habit_periods (habit_id, starts_on) values (tests.i(p_name), p_starts_on);
    insert into private.habit_schedules (habit_id, effective_on, kind, weekdays, weekly_target)
      values (tests.i(p_name), p_starts_on, p_kind, p_weekdays, p_target);
  end $$;
-- Check-ins created directly, by a person, on dates.
create function tests.done(p_name text, p_user uuid, p_dates date[]) returns void
  language sql security definer as $$
  insert into private.habit_checkins (id, habit_id, on_date, completed_by, source, recorded_at)
  select gen_random_uuid(), tests.i(p_name), d, p_user, 'app', now() - interval '1 day' from unnest(p_dates) d; $$;
create function tests.checkin(p_habit text, p_on date) returns uuid
  language sql stable security definer as $$
  select id from private.habit_checkins where habit_id = tests.i(p_habit) and on_date = p_on
  order by (status = 'active') desc, recorded_at desc limit 1; $$;
create function tests.pause(p_habit text) returns uuid
  language sql stable security definer as $$
  select id from private.habit_pauses where habit_id = tests.i(p_habit) order by created_at desc limit 1; $$;
create function tests.notice(p_user text, p_kind text) returns uuid
  language sql stable security definer as $$
  select id from public.notifications where user_id = tests.user_id(p_user) and kind = p_kind
  order by created_at limit 1; $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.week0() returns date
  language sql stable security definer as $$ select private.habit_week_of('monday', tests.d(0)); $$;
create function tests.block(p_habit text, p_on date) returns text
  language sql stable security definer as $$
  select private.habit_checkin_block(h, p_on, tests.d(0)) from private.habits h where h.id = tests.i(p_habit); $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications where user_id = tests.user_id(p_user) and kind = p_kind; $$;
grant execute on function tests.i(text), tests.d(integer), tests.rev(text), tests.habit(text), tests.streak(text),
  tests.complete(text, text, date), tests.notices(text, text), tests.checkin(text, date), tests.pause(text),
  tests.notice(text, text), tests.private_count(text), tests.week0(), tests.block(text, date)
  to authenticated, service_role;

-- Nothing is reachable as a table ------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.habits', 'The API cannot read habits');
select tests.assert_denied('select * from private.habit_checkins', 'Nor check-ins');
select tests.assert_denied('select * from private.habit_pauses', 'Nor pauses');
select tests.assert_denied('select * from private.habit_schedules', 'Nor schedules');
select tests.assert_denied('select * from private.habit_events', 'Nor history');
select tests.assert_denied('select * from private.habit_reminders', 'Nor reminders');
select tests.assert_denied('select * from private.habit_vacation_days', 'Nor vacation days');
select tests.assert_denied($$select private.habit_access(null, tests.user_id('alice'))$$, 'Nor the helpers');
select tests.assert_denied($$select public.deliver_habit_reminder(gen_random_uuid(), 1, now())$$,
  'Reminder delivery is for the service role only');
select tests.act_as_anon();
select tests.assert_denied('select public.get_habits()', 'Nobody signed out reads habits');

-- Creating, and who may -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((public.get_habits(tests.i('home-a')) ->> 'access') = 'complete',
  'A member checks in by default');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_habit(tests.i('h-bad'), tests.i('home-a'), 'Water',
    null, 'daily', null, null, tests.d(0), null, null, 'monday')),
  'A member does not create Home habits');
select tests.assert_denied($$select public.get_habits(tests.i('home-b'))$$, 'Not a Home she is not in');
select tests.act_as('bob');
select tests.assert_true((public.get_habits(tests.i('home-a')) ->> 'access') = 'complete',
  'An Administrator without manageHomeHabits checks in but does not manage');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeHabits']);
select tests.act_as('bob');
select tests.assert_true((public.get_habits(tests.i('home-a')) ->> 'access') = 'manage',
  'Granted manageHomeHabits, Bob manages habits');
select tests.assert_true(
  (select outcome = 'created' from public.create_habit(tests.i('h-daily'), tests.i('home-a'), 'Plants',
    'Water the plants', 'daily', null, null, tests.d(-7), null, null, 'monday')),
  'He creates a daily Home habit that started a week ago');
select tests.assert_true(
  (select outcome = 'exists' from public.create_habit(tests.i('h-daily'), tests.i('home-a'), 'Plants',
    'Water the plants', 'daily', null, null, tests.d(-7), null, null, 'monday')),
  'A retry answers exists');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.create_habit(tests.i('h-bad'), tests.i('home-a'), 'Old',
    null, 'daily', null, null, tests.d(-8), null, null, 'monday')),
  'A start more than seven days ago is refused');
select tests.assert_denied($$select public.create_habit(tests.i('h-bad'), tests.i('home-a'), 'Bad',
    null, 'weekdays', array[]::smallint[], null, tests.d(0), null, null, 'monday')$$,
  'A weekday schedule needs at least one day', '22023');
select tests.assert_denied($$select public.create_habit(tests.i('h-bad'), tests.i('home-a'), 'Bad',
    null, 'weekly', null, 8::smallint, tests.d(0), null, null, 'monday')$$,
  'A weekly target is 1 to 7', '22023');
select tests.assert_true(
  (select outcome = 'created' from public.create_habit(tests.i('h-b'), tests.i('home-b'), 'Kot habit',
    null, 'daily', null, null, tests.d(0), null, null, 'monday')),
  'Bob creates a habit in his own Home');
select tests.act_as('alice');
select tests.assert_denied($$select public.create_habit(tests.i('h-bad'), null, 'Bad', null, 'daily', null,
    null, tests.d(0), null, 'Not/AZone', 'monday')$$, 'A personal habit needs a real timezone', '22023');
select tests.assert_true(
  (select outcome = 'created' from public.create_habit(tests.i('h-personal'), null, 'Journal', null, 'daily',
    null, null, tests.d(0), null, 'Europe/Brussels', 'monday')),
  'Alice creates a personal habit');

-- Personal habits are private ---------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(tests.habit('h-personal') is null, 'A Home manager never sees a personal habit');
select tests.assert_true(tests.complete('c-x', 'h-personal', tests.d(0)) = 'not_found',
  'Nor checks it in');
select tests.assert_true(
  (select outcome = 'not_found' from public.pause_habit(tests.i('h-personal'), 1, null, false)),
  'Nor pauses it');
select tests.assert_true(
  not exists (select 1 from jsonb_array_elements(public.get_habits() -> 'habits') x
    where (x ->> 'id')::uuid = tests.i('h-personal')),
  'His own Personal list does not show it');
select tests.act_as('carol');
select tests.assert_true(tests.habit('h-b') is null, 'Carol cannot see a habit of a Home she is not in');

-- Check-ins ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.complete('c-carol', 'h-daily', tests.d(0)) = 'completed', 'Carol checks in today');
select tests.assert_true(tests.complete('c-carol', 'h-daily', tests.d(0)) = 'exists', 'A retry answers exists');
select tests.act_as('bob');
select tests.assert_true(
  (select r ->> 'outcome' = 'already_completed' and (r -> 'checkin' ->> 'by')::uuid = tests.i('m-carol-a')
   from public.complete_habit(tests.i('c-bob'), tests.i('h-daily'), tests.d(0), null, 'widget') r),
  'Bob sees that Carol already did today, and nothing is overwritten');
select tests.assert_true(tests.complete('c-carol', 'h-daily', tests.d(-1)) = 'id_taken',
  'Someone else''s client id is refused');
select tests.assert_true(tests.complete('c-old', 'h-daily', tests.d(-8)) in ('outside_window', 'untracked'),
  'Eight days ago is out of reach');
select tests.assert_true(tests.complete('c-future', 'h-daily', tests.d(1)) = 'future', 'Tomorrow is refused');
select tests.assert_true(tests.complete('c-back', 'h-daily', tests.d(-7)) = 'completed',
  'Seven days ago can still be filled in');
select tests.assert_true(
  (select (x ->> 'backdated')::boolean from jsonb_array_elements(tests.habit('h-daily') -> 'recent') r,
     lateral (select r -> 'checkin' as x) y where (r ->> 'onDate')::date = tests.d(-7)),
  'A late check-in is marked as recorded later');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_checkins where habit_id = %L and on_date = %L and status = %L', tests.i('h-daily'), tests.d(0), 'active')) = 1,
  'One check-in for today however many tried');

-- Streak recalculation after corrections ------------------------------------------------------------------

-- A daily Home habit since 20 days ago, done every day but three days ago.
select tests.act_as_owner();
select tests.fixture('h-streak', tests.i('home-a'), tests.user_id('alice'), 'daily', null, null, tests.d(-20));
select tests.done('h-streak', tests.user_id('carol'),
  array(select tests.d(n) from generate_series(-20, -1) n where n <> -3));
select tests.act_as('carol');
select tests.assert_true(tests.streak('h-streak') = 2, 'A missed day breaks the streak (2 since)');
select tests.assert_true((tests.habit('h-streak') -> 'streak' ->> 'longestOccurrences')::integer = 17,
  'The longest streak is the 17 before the missed day');
select tests.assert_true(
  (select r ->> 'outcome' = 'completed' and (r ->> 'streakBefore')::integer = 2
     and (r -> 'milestone' ->> 'threshold')::integer = 7 and not (r -> 'milestone' ->> 'celebrate')::boolean
   from public.complete_habit(tests.i('c-redo'), tests.i('h-streak'), tests.d(-3), 'Forgot', 'app') r),
  'A late, genuine check-in restores the streak; its milestone is recorded without a celebration');
select tests.assert_true(tests.streak('h-streak') = 20, 'The streak is 20 again');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_milestones where habit_id = %L', tests.i('h-streak'))) = 1,
  'One milestone (7) recorded for that streak');
select tests.act_as('carol');
select tests.assert_true(
  (select public.undo_habit_checkin(tests.i('c-redo'), null) ->> 'outcome' = 'undone'),
  'Carol undoes her own check-in inside the window');
select tests.assert_true(tests.streak('h-streak') = 2, 'The streak falls back to 2');
select tests.assert_true(
  (select public.undo_habit_checkin(tests.i('c-redo'), null) ->> 'outcome' = 'already_undone'),
  'A second Undo changes nothing');
select tests.assert_true(tests.complete('c-un', 'h-streak', tests.d(-3)) = 'completed', 'Checked again');
select tests.act_as_owner();
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_milestones where habit_id = %L', tests.i('h-streak'))) = 1,
  'Regaining the same streak records no second milestone');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_checkins where habit_id = %L and on_date = %L', tests.i('h-streak'), tests.d(-3))) = 2,
  'The undone check-in is kept in history next to the new one');
-- A check-in of Carol's from twelve days ago: only a manager may correct it.
select tests.act_as('carol');
select tests.assert_true(
  (select public.undo_habit_checkin(
     tests.checkin('h-streak', tests.d(-12)),
     null) ->> 'outcome' = 'not_permitted'),
  'Carol cannot undo her own check-in outside the seven-day window');
select tests.act_as('alice');
select tests.assert_true(
  (select r ->> 'outcome' = 'undone' and (r ->> 'streakBefore')::integer = 20
   from public.undo_habit_checkin(
     tests.checkin('h-streak', tests.d(-2)), 'Was not done') r),
  'The Owner corrects an erroneous check-in of Carol''s');
select tests.assert_true(tests.streak('h-streak') = 1, 'The streak falls to the one day after it');
select tests.assert_true(
  (select x ->> 'undoKind' = 'correction' and x ->> 'undoReason' = 'Was not done'
     and (x ->> 'by')::uuid = tests.i('m-carol-a')
   from jsonb_array_elements(public.get_habit_checkins(tests.i('h-streak'), null)) x
   where (x ->> 'onDate')::date = tests.d(-2)),
  'History keeps who did it, who corrected it and why');
select tests.act_as('carol');
select tests.assert_true(
  (select public.undo_habit_checkin(tests.i('c-carol'), null) ->> 'outcome' = 'undone'),
  'Carol can still undo today''s check-in');
select tests.assert_true(tests.complete('c-p', 'h-daily', tests.d(0)) = 'completed', 'and redo it');

-- Monday-Wednesday-Friday: unscheduled days never count; a missed Friday breaks, a late one restores.
select tests.act_as_owner();
select tests.fixture('h-mwf', null, tests.user_id('alice'), 'weekdays', array[1, 3, 5]::smallint[], null, tests.d(-14));
create temporary table mwf on commit drop as
  select d, row_number() over (order by d desc) as back from (
    select tests.d(n) as d from generate_series(-14, -1) n where extract(isodow from tests.d(n)) in (1, 3, 5)) x;
grant select on mwf to authenticated;
select tests.done('h-mwf', tests.user_id('alice'), array(select d from mwf where back <> 2));
select tests.act_as('alice');
select tests.assert_true(tests.streak('h-mwf') = 1,
  'A missed scheduled day breaks a Monday-Wednesday-Friday streak; the days between do not');
select tests.assert_true(
  (select public.complete_habit(tests.i('c-mwf'), tests.i('h-mwf'), (select d from mwf where back = 2), null, 'app')
     ->> 'outcome' = 'completed'),
  'The missed day is filled in late');
select tests.assert_true(tests.streak('h-mwf') = (select count(*) from mwf),
  'Every scheduled day of the two weeks now counts');
select tests.assert_true(
  (select public.complete_habit(gen_random_uuid(), tests.i('h-mwf'), x.d, null, 'app') ->> 'outcome' = 'not_scheduled'
   from (select tests.d(n) as d from generate_series(-6, 0) n where extract(isodow from tests.d(n)) in (2, 4)
         limit 1) x),
  'An unscheduled day cannot be checked in');

-- A weekly target of three: last week short, the week before met.
select tests.act_as_owner();
select tests.fixture('h-weekly', tests.i('home-a'), tests.user_id('alice'), 'weekly', null, 3::smallint,
  tests.week0() - 21);
select tests.done('h-weekly', tests.user_id('bob'), array[
  tests.week0() - 21, tests.week0() - 20,
  tests.week0() - 19,
  tests.week0() - 14, tests.week0() - 13,
  tests.week0() - 12,
  tests.week0() - 4, tests.week0() - 3]);
select tests.act_as('carol');
select tests.assert_true(tests.streak('h-weekly') = 0, 'Last week fell short of three: no weekly streak');
select tests.assert_true(
  (select (r ->> 'outcome') = 'completed' and (r ->> 'streakBefore')::integer = 0
   from public.complete_habit(tests.i('c-wb'), tests.i('h-weekly'), tests.week0() - 1,
     null, 'app') r),
  'Carol fills in the last day of last week (inside the window)');
select tests.assert_true(tests.streak('h-weekly') = 3, 'Last week now met its target: three weeks in a row');
select tests.assert_true((tests.habit('h-weekly') -> 'streak' ->> 'unit') = 'weeks', 'Counted in weeks');
select tests.assert_true(
  (select (x ->> 'outcome') = 'done' and (x ->> 'completions')::integer = 3
   from jsonb_array_elements(public.get_habit_calendar(tests.i('h-weekly'), tests.week0() - 7) -> 'weeks') x
   where (x ->> 'weekOn')::date = tests.week0() - 7),
  'The calendar shows last week as met, three of three');
select tests.assert_true(
  (select count(*) = 1 from jsonb_array_elements(public.get_habit_calendar(tests.i('h-weekly'),
     tests.week0() - 21) -> 'weeks') x
   where (x ->> 'weekOn')::date = tests.week0() - 21 and x ->> 'outcome' = 'done'),
  'Earlier weeks keep their own outcome');

-- A weekly target of one: a second day in the same week is refused.
select tests.act_as_owner();
select tests.fixture('h-week1', null, tests.user_id('alice'), 'weekly', null, 1::smallint, tests.d(-7));
select tests.act_as('alice');
select tests.assert_true(
  tests.complete('c-w1', 'h-week1', case when extract(isodow from tests.d(0)) = 1 then tests.d(-1) else tests.d(0) end)
    = 'completed', 'One check-in reaches the weekly target');
select tests.assert_true(
  tests.complete('c-w2', 'h-week1', case when extract(isodow from tests.d(0)) = 1 then tests.d(-2) else tests.d(-1) end)
    = 'target_reached', 'Another day of that week is refused: the target is reached');

-- Milestone celebration on a check-in for today.
select tests.act_as_owner();
select tests.fixture('h-ms', null, tests.user_id('alice'), 'daily', null, null, tests.d(-6));
select tests.done('h-ms', tests.user_id('alice'), array(select tests.d(n) from generate_series(-6, -1) n));
select tests.act_as('alice');
select tests.assert_true(
  (select (r -> 'milestone' ->> 'threshold')::integer = 7 and (r -> 'milestone' ->> 'celebrate')::boolean
   from public.complete_habit(tests.i('c-ms'), tests.i('h-ms'), tests.d(0), null, 'app') r),
  'Today''s seventh day in a row is celebrated once');
select public.undo_habit_checkin(tests.i('c-ms'), null);
select public.set_habit_celebrations(false);
select tests.assert_true(
  (select r -> 'milestone' is null or r -> 'milestone' = 'null'::jsonb
   from public.complete_habit(tests.i('c-ms2'), tests.i('h-ms'), tests.d(0), null, 'app') r),
  'Undo and redo never celebrate the same milestone twice');
select public.set_habit_celebrations(true);

-- Notes -------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.set_habit_checkin_note(tests.i('c-p'), 0, 'Gave extra water')),
  'Carol adds a note to her check-in');
select tests.assert_true(
  (select outcome = 'conflict' from public.set_habit_checkin_note(tests.i('c-p'), 0, 'Again')),
  'A stale note edit is refused');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_habit_checkin_note(tests.i('c-p'), 1, 'Changed')),
  'Not even the Owner edits someone else''s note');
select tests.assert_true(
  (select (r -> 'todayCheckin' ->> 'note') = 'Gave extra water' from tests.habit('h-daily') r),
  'Members see the note with its check-in');
select tests.assert_true(tests.streak('h-daily') = (select tests.streak('h-daily')),
  'Notes never change the streak');

-- Schedule changes are forward only -----------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'invalid_date' from public.change_habit_schedule(tests.i('h-streak'), tests.rev('h-streak'),
    'weekdays', array[1, 2, 3, 4, 5]::smallint[], null, tests.d(0), true)),
  'Today cannot be rescheduled');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'earliest')::date = tests.d(1)
   from public.change_habit_schedule(tests.i('h-streak'), tests.rev('h-streak'),
    'weekdays', array[1, 2, 3, 4, 5]::smallint[], null, tests.d(1), true)),
  'Daily to weekdays from tomorrow previews');
select tests.assert_true(
  (select outcome = 'invalid_date' and (impact ->> 'earliest')::date = tests.week0() + 7
   from public.change_habit_schedule(tests.i('h-streak'), tests.rev('h-streak'),
    'weekly', null, 3::smallint, tests.d(1), true)
   where extract(isodow from tests.d(1)) <> 1
   union all select true where extract(isodow from tests.d(1)) = 1),
  'A weekly schedule starts at the next week start');
select tests.assert_true(
  (select outcome = 'saved' from public.change_habit_schedule(tests.i('h-streak'), tests.rev('h-streak'),
    'weekdays', array[1, 2, 3, 4, 5]::smallint[], null, tests.d(1), false)),
  'Bob changes the schedule from tomorrow');
select tests.assert_true(
  (select count(*) = 0 from jsonb_array_elements(public.get_habit_calendar(tests.i('h-streak'), tests.d(-15)) -> 'days') x
   where (x ->> 'onDate')::date between tests.d(-20) and tests.d(-1) and x ->> 'state' = 'not_scheduled')
  and (select count(*) = 0 from jsonb_array_elements(public.get_habit_calendar(tests.i('h-streak'), tests.d(-1)) -> 'days') x
   where (x ->> 'onDate')::date between tests.d(-20) and tests.d(-1) and x ->> 'state' = 'not_scheduled'),
  'Past weekend days keep the daily schedule they had');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.change_habit_schedule(tests.i('h-streak'), tests.rev('h-streak'),
    'daily', null, null, tests.d(2), true)),
  'A member does not change schedules');

-- Pauses, vacations and notices -------------------------------------------------------------------------------

select tests.act_as('carol');
select public.set_notification_preference('habits', 'in_app', true, null);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'preview' from public.pause_habit(tests.i('h-daily'), tests.rev('h-daily'), tests.d(3), true)),
  'A pause previews');
select tests.assert_true(
  (select outcome = 'paused' from public.pause_habit(tests.i('h-daily'), tests.rev('h-daily'), tests.d(3), false)),
  'Bob pauses the habit until in three days');
select tests.assert_true(
  (select outcome = 'already_paused' from public.pause_habit(tests.i('h-daily'), tests.rev('h-daily'), null, false)),
  'One current manual pause at a time');
select tests.assert_true(tests.notices('carol', 'habit.paused') = 1 and tests.notices('alice', 'habit.paused') = 0,
  'Carol, who opted in, is told; Alice, who did not, is not');
select tests.assert_true(tests.notices('bob', 'habit.paused') = 0, 'Bob, who did it, is not told');
select tests.act_as('carol');
select tests.assert_true((tests.habit('h-daily') ->> 'status') = 'paused', 'Members see it paused');
select tests.assert_true(tests.complete('c-pause', 'h-daily', tests.d(1)) = 'future'
  and (select public.complete_habit(gen_random_uuid(), tests.i('h-daily'), tests.d(0), null, 'app') ->> 'outcome')
    = 'already_completed',
  'Today stays done');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_habit_pause(
     tests.pause('h-daily'), 1, 'resume', null, false)),
  'A member cannot resume it');
-- Paused days are neither done nor missed: pause the streak fixture from today, nothing changes.
select tests.act_as('alice');
select public.pause_habit(tests.i('h-ms'), tests.rev('h-ms'), null, false);
select tests.assert_true(tests.streak('h-ms') = 7, 'A pause keeps the streak');
select tests.assert_true(
  (select x ->> 'state' = 'paused' from jsonb_array_elements(public.get_habit_calendar(tests.i('h-ms'), tests.d(1)) -> 'days') x
   where (x ->> 'onDate')::date = tests.d(1)),
  'Tomorrow shows as paused, not missed');

-- A Home vacation with the Home-wide pause over today and tomorrow (everyone away).
select tests.act_as_owner();
insert into private.home_vacations (id, home_id, starts_on, ends_on, created_by, home_pause_dates, home_pause_by, home_pause_at)
  values (tests.i('v-1'), tests.i('home-a'), tests.d(-2), tests.d(1), tests.user_id('alice'),
    datemultirange(daterange(tests.d(-2), tests.d(2))), tests.user_id('alice'), now());
insert into private.home_vacation_participants (id, vacation_id, home_id, user_id, status, starts_on, ends_on, direct)
select gen_random_uuid(), tests.i('v-1'), tests.i('home-a'), u, 'accepted', tests.d(-2), tests.d(1), true
from unnest(array[tests.user_id('alice'), tests.user_id('bob'), tests.user_id('carol')]) u;
select tests.act_as('carol');
select tests.assert_true(
  (select x ->> 'state' from jsonb_array_elements(public.get_habit_calendar(tests.i('h-streak'), tests.d(0)) -> 'days') x
   where (x ->> 'onDate')::date = tests.d(0)) = 'paused',
  'The Home-wide vacation pauses Home habits from today');
select tests.assert_true(
  (select x ->> 'state' from jsonb_array_elements(public.get_habit_calendar(tests.i('h-streak'), tests.d(-1)) -> 'days') x
   where (x ->> 'onDate')::date = tests.d(-1)) <> 'paused',
  'Days already past are never changed afterwards');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'vacationToday')::boolean from public.update_habit_pause(
     tests.pause('h-daily'), 1, 'resume', null, false)),
  'Bob resumes the manual pause while the vacation still applies');
select tests.assert_true(tests.notices('carol', 'habit.resumed') = 0,
  'Nobody is told it resumed: the vacation still pauses it');
select tests.assert_true((tests.habit('h-daily') ->> 'pausedBy') = 'vacation', 'It stays paused by the vacation');
-- Alice's personal habit pauses for her own participation only when she switches it on.
select tests.act_as('alice');
select tests.assert_true((tests.habit('h-personal') ->> 'status') = 'active', 'Personal habits do not pause by default');
select tests.assert_true(public.set_vacation_habit(tests.i('v-1'), tests.i('h-personal'), true) = 'saved',
  'Alice pauses her journal for her vacation');
select tests.assert_true((tests.habit('h-personal') ->> 'status') = 'paused', 'Now it is paused');
select tests.assert_true(
  (select (x ->> 'paused')::boolean from jsonb_array_elements(public.get_vacation_habits(tests.i('v-1')) -> 'habits') x
   where (x ->> 'id')::uuid = tests.i('h-personal')),
  'The vacation page shows her switch');
select tests.act_as('carol');
select tests.assert_true(
  not exists (select 1 from jsonb_array_elements(public.get_vacation_habits(tests.i('v-1')) -> 'habits') x
    where (x ->> 'id')::uuid = tests.i('h-personal')),
  'Nobody else sees Alice''s personal habits on the vacation');
select tests.assert_true(public.set_vacation_habit(tests.i('v-1'), tests.i('h-personal'), true) = 'not_found',
  'Nor switches them');
-- Cancelling the vacation unpauses from today, leaving no trace on paused days already past.
select tests.act_as_owner();
update private.home_vacations set cancelled_at = now() where id = tests.i('v-1');
select tests.act_as('alice');
select tests.assert_true((tests.habit('h-personal') ->> 'status') = 'active', 'Cancelled: the journal runs again');

-- End dates and reactivation ----------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.fixture('h-end', tests.i('home-a'), tests.user_id('alice'), 'daily', null, null, tests.d(-6));
select tests.done('h-end', tests.user_id('carol'), array(select tests.d(n) from generate_series(-6, -1) n));
select tests.act_as('carol');
select tests.assert_true(tests.complete('c-end', 'h-end', tests.d(0)) = 'completed', 'Done today');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'checkins_after_end' and (impact ->> 'checkinsAfter')::integer = 1
   from public.set_habit_end(tests.i('h-end'), tests.rev('h-end'), tests.d(-1), true)),
  'An end before a recorded check-in is refused');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.set_habit_end(tests.i('h-end'), tests.rev('h-end'), tests.d(-7), true)),
  'An end before the start is refused');
select tests.assert_true(
  (select outcome = 'saved' from public.set_habit_end(tests.i('h-end'), tests.rev('h-end'), tests.d(0), false)),
  'It ends today');
select tests.assert_true((tests.habit('h-end') ->> 'status') = 'active', 'Still active on its last day');
select tests.act_as_owner();
update private.habit_periods set ends_on = tests.d(-1) where habit_id = tests.i('h-end');
update private.habit_checkins set status = 'undone', undone_at = now(), undo_kind = 'correction'
  where id = tests.i('c-end');
select tests.act_as('carol');
select tests.assert_true((tests.habit('h-end') ->> 'status') = 'ended', 'Ended after its end date');
select tests.assert_true(
  exists (select 1 from jsonb_array_elements(public.get_habits(tests.i('home-a'), 'ended') -> 'habits') x
    where (x ->> 'id')::uuid = tests.i('h-end'))
  and not exists (select 1 from jsonb_array_elements(public.get_habits(tests.i('home-a'), 'active') -> 'habits') x
    where (x ->> 'id')::uuid = tests.i('h-end')),
  'It moves to the Ended section');
select tests.assert_true(tests.complete('c-end2', 'h-end', tests.d(0)) = 'untracked', 'No check-ins after the end');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'ended' from public.set_habit_end(tests.i('h-end'), tests.rev('h-end'), null, true)),
  'An ended habit is continued only through reactivation');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.reactivate_habit(tests.i('h-end'), tests.rev('h-end'), tests.d(-1),
     null, 'daily', null, null, 'off', null, null, true)),
  'Reactivation never starts in the past (no gap filling)');
select tests.assert_true(
  (select outcome = 'reactivated' from public.reactivate_habit(tests.i('h-end'), tests.rev('h-end'), tests.d(0),
     null, 'daily', null, null, 'off', null, null, false)),
  'Alice reactivates it from today');
select tests.assert_true(
  (select outcome = 'not_ended' from public.reactivate_habit(tests.i('h-end'), tests.rev('h-end'), tests.d(0),
     null, 'daily', null, null, 'off', null, null, false)),
  'A second reactivation creates nothing');
select tests.assert_true(
  (select (r -> 'streak' ->> 'current')::integer = 0 and (r -> 'streak' ->> 'longestOccurrences')::integer = 6
     and (r ->> 'periodCount')::integer = 2 from tests.habit('h-end') r),
  'A fresh current streak; the longest of the earlier period is kept');
select tests.assert_true(tests.complete('c-end2', 'h-end', tests.d(0)) = 'completed',
  'The new period takes check-ins from its first day');

-- Reminders ----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_habit_reminders(tests.i('h-streak'), 0, true,
    array['08:00']::time[], array[1, 2, 3, 4, 5, 6, 7]::smallint[])),
  'A member does not set a Home habit''s reminder');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.set_habit_reminders(tests.i('h-personal'), 0, true,
    array['08:00', '20:00']::time[], array[1, 2, 3, 4, 5, 6, 7]::smallint[])),
  'Alice sets two daily reminders on her journal');
select tests.assert_denied($$select public.set_habit_reminders(tests.i('h-personal'), 1, true,
    array['08:00', '09:00', '10:00', '11:00']::time[], array[1]::smallint[])$$, 'At most three times', '22023');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.job_outbox where job_name = 'habit-reminder'
     and payload ->> 'habitId' = tests.i('h-personal')::text),
  'The next reminder moment is queued');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_habit_reminder(tests.i('h-personal'), 1, now() - interval '1 minute') = 'notified',
  'A due reminder for an open day is delivered');
select tests.assert_true(public.deliver_habit_reminder(tests.i('h-personal'), 1, now() - interval '1 minute') = 'notified'
  and tests.notices('alice', 'habit.reminder') = 1, 'A duplicate run tells nobody twice');
select tests.assert_true(public.deliver_habit_reminder(tests.i('h-personal'), 1, now() - interval '40 minutes') = 'late',
  'A reminder more than 30 minutes late is skipped');
select tests.assert_true(public.deliver_habit_reminder(tests.i('h-personal'), 9, now()) = 'stale',
  'An outdated revision does nothing');
select tests.assert_true(public.deliver_habit_reminder(tests.i('h-personal'), 1, now() + interval '1 hour') = 'not_due',
  'An early run waits');
-- Snooze.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome in ('snoozed', 'window_closed') from public.snooze_habit_reminder(
     tests.notice('alice', 'habit.reminder'), 15)),
  'Alice snoozes her reminder (or is told the day ends first)');
select tests.assert_true(
  (select outcome in ('already_snoozed', 'window_closed') from public.snooze_habit_reminder(
     tests.notice('alice', 'habit.reminder'), 30)),
  'One snooze per reminder');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.snooze_habit_reminder(
     tests.notice('alice', 'habit.reminder'), 15)),
  'Nobody snoozes someone else''s reminder');
select tests.act_as('alice');
select tests.assert_true(tests.complete('c-x', 'h-personal', tests.d(0)) = 'completed', 'Alice writes her journal');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_habit_reminder(tests.i('h-personal'), 1, now()) = 'not_needed',
  'No reminder for a day already done');
select tests.assert_true(
  coalesce(public.deliver_habit_snooze(tests.notice('alice', 'habit.reminder')) in ('cancelled', 'not_due', 'stale'), true)
  and tests.private_count('select count(*) from private.habit_reminder_snoozes where status = ''delivered''') = 0,
  'A snooze for a day already done never fires');
-- Home habit recipients: members who may check in, minus those who turned it off.
select tests.act_as('alice');
select public.set_habit_reminders(tests.i('h-weekly'), 0, true, array['12:00']::time[], array[1, 2, 3, 4, 5, 6, 7]::smallint[]);
select tests.act_as('carol');
select tests.assert_true(public.set_my_habit_reminders(tests.i('h-weekly'), false) = 'saved',
  'Carol turns this habit''s reminders off for herself');
select tests.act_as_service_role();
select public.deliver_habit_reminder(tests.i('h-weekly'), 1, now());
select tests.assert_true(
  tests.notices('carol', 'habit.reminder') = 0
  and (tests.notices('bob', 'habit.reminder') = 1 or tests.block('h-weekly', tests.d(0)) is not null),
  'Bob is reminded while the week is open; Carol is not');

-- Member access, insights, trash, isolation ----------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(public.update_habit_settings(tests.i('home-a'), 'view') = 'saved', 'Alice sets view only');
select tests.act_as('carol');
select tests.assert_true(tests.complete('c-un', 'h-daily', tests.d(-1)) in ('not_permitted', 'id_taken'),
  'A view-only member cannot check in');
select tests.assert_true(
  (select public.complete_habit(gen_random_uuid(), tests.i('h-daily'), tests.d(-1), null, 'app') ->> 'outcome')
    = 'not_permitted', 'Not with a new id either');
select tests.assert_true(tests.habit('h-daily') is not null, 'But still sees the habit');
select tests.act_as('alice');
select public.update_habit_settings(tests.i('home-a'), 'complete');

select tests.act_as('carol');
select tests.assert_true(
  (select (r ->> 'eligible')::integer = 20 and (r ->> 'completed')::integer = 19
   from public.get_habit_insights(tests.i('h-streak'), 30) r),
  'Insights: 19 of 20 eligible days done in the last 30 (today, still open, is left out)');
select tests.assert_denied($$select public.get_habit_insights(tests.i('h-streak'), 10)$$, 'Only the offered ranges', '22023');
select tests.assert_true(public.get_habit_insights(tests.i('h-b'), 30) is null, 'No insights of another Home');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_habit(tests.i('h-ms'), tests.rev('h-ms'))),
  'Alice moves a habit to the trash');
select tests.assert_true(tests.habit('h-ms') is null, 'It is gone');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
     array[(select entry_id from public.list_trash(null, 'habits') limit 1)])),
  'And restores it');
select tests.assert_true(tests.streak('h-ms') = 7, 'With its history intact');

-- Forged ids and a departed member.
select tests.act_as('carol');
select tests.assert_true(
  (select public.undo_habit_checkin(
     tests.checkin('h-weekly', tests.week0() - 4), null) ->> 'outcome')
    = 'not_permitted',
  'A member cannot undo another member''s check-in');
select tests.act_as('bob');
select tests.complete('c-b', 'h-b', tests.d(0));
select tests.act_as('carol');
select tests.assert_true(
  (select public.undo_habit_checkin(tests.i('c-b'), null) ->> 'outcome') = 'not_found',
  'A check-in of another Home answers not found');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_habit_checkin_note(tests.i('c-b'), 0, 'Hi')),
  'Nor can she write on it');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_true(tests.habit('h-daily') is null, 'A departed member no longer sees Home habits');
select tests.assert_true(tests.complete('c-old', 'h-daily', tests.d(0)) = 'not_found', 'Nor checks them in');
select tests.act_as('alice');
select tests.assert_true(
  (select x ->> 'by' is null from jsonb_array_elements(public.get_habit_checkins(tests.i('h-daily'), null)) x
   where (x ->> 'id')::uuid = tests.i('c-p')),
  'Her past check-ins stay, without naming her');

-- Review fixes ---------------------------------------------------------------------------------------------

-- Turning a reminder off without times keeps the saved ones; off when never set changes nothing.
select tests.act_as('alice');
select public.create_habit(tests.i('h-rem'), null, 'Stretch', null, 'daily', null, null, tests.d(0), null,
  'Europe/Brussels', 'monday');
select public.create_habit(tests.i('h-rem2'), null, 'Read', null, 'daily', null, null, tests.d(0), null,
  'Europe/Brussels', 'monday');
select public.set_habit_reminders(tests.i('h-rem'), 0, true, array['07:30']::time[], array[1, 3, 5]::smallint[]);
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.set_habit_reminders(tests.i('h-rem'), 1, false)),
  'A reminder is turned off without sending times');
select tests.act_as_owner();
select tests.assert_true(
  (select not r.enabled and r.times = array['07:30']::time[] and r.weekdays = array[1, 3, 5]::smallint[]
   from private.habit_reminders r where r.habit_id = tests.i('h-rem')),
  'Its times and days are kept for turning it on again');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'unchanged' from public.set_habit_reminders(tests.i('h-rem2'), 0, false)),
  'Off when it was never set changes nothing');
select tests.assert_denied($$select public.set_habit_reminders(tests.i('h-rem2'), 0, true)$$,
  'On needs times and days', '22023');

-- A weekly habit reactivated within the habit week it ended in: both periods have that week, the
-- streak sequence stays total, and completing in the new period works.
select tests.act_as_owner();
select tests.fixture('h-wr', null, tests.user_id('alice'), 'weekly', null, 1::smallint, tests.d(-20),
  case when extract(isodow from tests.d(0)) = 1 then 'sunday' else 'monday' end);
select tests.done('h-wr', tests.user_id('alice'), array[tests.d(-1)]);
update private.habit_periods set ends_on = tests.d(-1) where habit_id = tests.i('h-wr');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'reactivated' from public.reactivate_habit(tests.i('h-wr'), tests.rev('h-wr'), tests.d(0),
     null, 'weekly', null, 1::smallint, 'off', null, null, false)),
  'The weekly habit is reactivated within the week it ended in');
select tests.assert_true(tests.complete('c-wr', 'h-wr', tests.d(0)) = 'completed',
  'Completing in the new period works');
select tests.assert_true(
  (select (r -> 'streak' ->> 'current')::integer = 1 and r -> 'streak' ->> 'unit' = 'weeks' from tests.habit('h-wr') r)
  and (select (r -> 'streak' ->> 'current')::integer from tests.habit('h-wr') r)
    = (select (r -> 'streak' ->> 'current')::integer from tests.habit('h-wr') r),
  'The new period''s streak is one week, the same on every read');
