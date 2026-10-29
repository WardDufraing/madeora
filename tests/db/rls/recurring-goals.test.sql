-- S30b: recurring goals (supabase/migrations/*_recurring_goals.sql). Alice owns Home A, where Bob is an
-- Administrator (granted manageHomeGoals part-way) and Carol a Member; Bob owns Home B, which Carol is
-- not in. Covers: nothing reachable as a table; period bounds (month ends, February in common and leap
-- years, years, weeks by week start across New Year); who may create and manage series; creation with
-- its preview, retries and date rules; rollover at exact boundaries, never twice and never backfilled,
-- with first period, pause, resume, end date and stop; finalization (reached / not reached, the next
-- period at 0, no carry-over); contributions refused after the end; historical corrections by goal
-- managers recomputing that period alone, marked corrected, an explicit achievement kept and flagged
-- for review; target changes effective from the next, the current or a future period with their
-- confirmations, past periods unchanged; period rules on the S30 functions; reminders copied into
-- periods and silent once a period ended; trash and restore of a series; the background rollover and
-- its duplicate run; personal series and Home B invisible to others.

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
insert into ids select n, gen_random_uuid() from unnest(array[
  's-run', 's-cal', 's-leap', 's-year', 's-week', 's-sun', 's-b', 's-carol', 's-rem', 's-done', 's-bad'
]) as n;
insert into ids select 'e' || g, gen_random_uuid() from generate_series(1, 40) g;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.month_start(p_on date) returns date
  language sql immutable as $$ select date_trunc('month', p_on::timestamp)::date; $$;
create function tests.srev(p_name text) returns integer
  language sql security definer as $$ select revision from private.goal_series where id = tests.i(p_name); $$;
create function tests.grev(p_goal uuid) returns integer
  language sql security definer as $$ select revision from private.goals where id = p_goal; $$;
-- plpgsql, so every call takes a fresh snapshot.
create function tests.series(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_goal_series(tests.i(p_name)); end $$;
create function tests.goal(p_goal uuid) returns jsonb
  language plpgsql as $$ begin return public.get_goal(p_goal); end $$;
create function tests.period(p_name text, p_start date) returns private.goals
  language plpgsql security definer as $$
  declare v private.goals;
  begin select * into v from private.goals where series_id = tests.i(p_name) and period_start = p_start; return v; end $$;
create function tests.pid(p_name text, p_start date) returns uuid
  language plpgsql security definer as $$
  begin return (select id from private.goals where series_id = tests.i(p_name) and period_start = p_start); end $$;
-- A check on private rows, run as the owner whoever acts.
create function tests.p(p_sql text) returns boolean
  language plpgsql security definer as $$
  declare v boolean; begin execute p_sql into v; return coalesce(v, false); end $$;
create function tests.rrev(p_goal uuid) returns integer
  language sql security definer as $$ select revision from private.goal_reminders where goal_id = p_goal; $$;
create function tests.periods(p_name text) returns bigint
  language plpgsql security definer as $$
  begin return (select count(*) from private.goals where series_id = tests.i(p_name)); end $$;
create function tests.events(p_goal uuid, p_kind text) returns bigint
  language plpgsql security definer as $$
  begin return (select count(*) from private.goal_events where goal_id = p_goal and kind = p_kind); end $$;
create function tests.roll(p_name text, p_now timestamptz) returns integer
  language sql security definer as $$ select private.roll_goal_series(tests.i(p_name), p_now); $$;
create function tests.mk(
  p_name text, p_home text, p_kind text, p_frequency text, p_target numeric default null,
  p_unit text default null, p_first date default null, p_ends date default null,
  p_week text default 'monday', p_dry boolean default false, p_lead smallint default null
) returns jsonb
  language sql as $$
  select public.create_goal_series(tests.i(p_name), case when p_home is null then null else tests.i(p_home) end,
    p_kind, p_frequency, initcap(p_name), null, p_target, p_unit, case when p_unit is null then null else 'preset' end,
    p_week, coalesce(p_first, tests.today()), p_ends, case when p_home is null then 'Europe/Brussels' end,
    p_lead, case when p_lead is null then null else '09:00'::time end, p_dry); $$;
create function tests.mko(p_name text, p_home text, p_kind text, p_frequency text, p_target numeric default null,
  p_unit text default null, p_first date default null, p_ends date default null) returns text
  language sql as $$ select tests.mk(p_name, p_home, p_kind, p_frequency, p_target, p_unit, p_first, p_ends) ->> 'outcome'; $$;
create function tests.state(p_name text, p_action text) returns text
  language sql as $$ select outcome from public.set_goal_series_state(tests.i(p_name), tests.srev(p_name), p_action); $$;
create function tests.starget(
  p_name text, p_from date, p_target numeric, p_unit text default 'km', p_dry boolean default false,
  p_confirm_unit boolean default false, p_confirm_status boolean default false
) returns jsonb
  language sql as $$
  select public.change_goal_series_target(tests.i(p_name), tests.srev(p_name), p_from, p_target, p_unit, 'preset',
    p_dry, p_confirm_unit, p_confirm_status); $$;
-- Moves a period to other dates and makes the series start no later (setup only).
create function tests.move_period(p_goal uuid, p_start date, p_end date) returns void
  language plpgsql security definer as $$
  begin
    update private.goals set period_start = p_start, period_end = p_end, deadline = p_end where id = p_goal;
    update private.goal_series s set first_period_start = least(s.first_period_start, p_start)
      from private.goals g where g.id = p_goal and s.id = g.series_id;
  end $$;
-- Makes a series start on p_first with no periods yet (setup only), so p_now decides everything.
create function tests.restart(p_name text, p_first date) returns void
  language plpgsql security definer as $$
  begin
    delete from private.goals where series_id = tests.i(p_name);
    update private.goal_series set first_period_start = p_first, next_roll_at = null where id = tests.i(p_name);
    update private.goal_series_targets set effective_from = p_first where series_id = tests.i(p_name);
  end $$;

grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing as a table -----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.goal_series', 'The API cannot read series');
select tests.assert_denied('select * from private.goal_series_targets', 'Nor target schedules');
select tests.assert_denied('select * from private.goal_series_events', 'Nor series history');
select tests.assert_denied($$select private.roll_goal_series(gen_random_uuid(), now())$$, 'Nor the rollover');
select tests.assert_denied($$select private.change_goal_target_before_series(null, null, null, null, null)$$,
  'Nor the moved S30 function');
select tests.assert_denied('select public.roll_goal_periods()', 'The background rollover is the service role''s');
select tests.act_as_anon();
select tests.assert_denied('select public.get_goal_series(gen_random_uuid())', 'Nobody signed out reads a series');

-- Period bounds ------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true((select (period_start, period_end) = ('2027-02-01'::date, '2027-02-28'::date)
  from private.goal_period_bounds('monthly', 'monday', '2027-02-15')), 'February has 28 days in 2027');
select tests.assert_true((select (period_start, period_end) = ('2028-02-01'::date, '2028-02-29'::date)
  from private.goal_period_bounds('monthly', 'monday', '2028-02-29')), 'And 29 in the leap year 2028');
select tests.assert_true((select (period_start, period_end) = ('2026-10-01'::date, '2026-10-31'::date)
  from private.goal_period_bounds('monthly', 'monday', '2026-10-31')), 'The last day of a month is in it');
select tests.assert_true((select (period_start, period_end) = ('2026-12-01'::date, '2026-12-31'::date)
  from private.goal_period_bounds('monthly', 'monday', '2026-12-31')), 'December ends the year');
select tests.assert_true((select (period_start, period_end) = ('2028-01-01'::date, '2028-12-31'::date)
  from private.goal_period_bounds('yearly', 'monday', '2028-02-29')), 'A year is the calendar year');
select tests.assert_true((select (period_start, period_end) = ('2026-12-28'::date, '2027-01-03'::date)
  from private.goal_period_bounds('weekly', 'monday', '2027-01-01')), 'A Monday week crosses New Year as one period');
select tests.assert_true((select (period_start, period_end) = ('2026-12-27'::date, '2027-01-02'::date)
  from private.goal_period_bounds('weekly', 'sunday', '2027-01-01')), 'So does a Sunday week');
select tests.assert_true((select (period_start, period_end) = ('2026-12-26'::date, '2027-01-01'::date)
  from private.goal_period_bounds('weekly', 'saturday', '2027-01-01')), 'And a Saturday week');
select tests.assert_true((select count(*) = 0 from private.goal_period_bounds('daily', 'monday', '2027-01-01')),
  'An unknown frequency has no period');

-- Creating series ----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.mko('s-bad', 'home-a', 'measurable', 'monthly', 100, 'km') = 'not_permitted',
  'A Member does not create Home series');
select tests.act_as('bob');
select tests.assert_true(tests.mko('s-bad', 'home-a', 'measurable', 'monthly', 100, 'km') = 'not_permitted',
  'Nor an Administrator without manageHomeGoals');
select tests.act_as('alice');
select tests.assert_denied($$select tests.mk('s-bad', 'home-a', 'completion', 'weekly')$$,
  'Completion goals do not repeat weekly', '22023');
select tests.assert_denied($$select tests.mk('s-bad', 'home-a', 'measurable', 'monthly')$$,
  'A measurable series needs a target and unit', '22023');
select tests.assert_denied($$select tests.mk('s-bad', 'home-a', 'measurable', 'daily', 5, 'km')$$,
  'An unknown frequency is refused', '22023');
select tests.assert_true(tests.mko('s-bad', 'home-a', 'measurable', 'monthly', 100, 'km',
    tests.month_start(tests.today()) - 1) = 'invalid_dates', 'A first period before the current one is refused (no backfill)');
select tests.assert_true(tests.mko('s-bad', 'home-a', 'measurable', 'monthly', 100, 'km',
    (tests.month_start(tests.today()) + interval '2 months')::date, (tests.month_start(tests.today()) + interval '1 month')::date)
  = 'invalid_dates', 'An end date before the first period is refused');
select tests.assert_true(
  (select r ->> 'outcome' = 'preview' and (r ->> 'startsNow')::boolean
     and (r #>> '{periods,first,start}')::date = tests.month_start(tests.today())
     and (r #>> '{periods,next,start}')::date = (tests.month_start(tests.today()) + interval '1 month')::date
   from tests.mk('s-run', 'home-a', 'measurable', 'monthly', 100, 'km', null, null, 'monday', true) r),
  'The preview shows the first (this month) and next periods');
select tests.assert_true(tests.periods('s-run') = 0, 'A preview saves nothing');
select tests.assert_true(
  (select r ->> 'outcome' = 'created' and (r ->> 'currentGoalId') is not null
   from tests.mk('s-run', 'home-a', 'measurable', 'monthly', 100, 'km') r),
  'Alice creates a monthly series of 100 km; the current period exists at once');
insert into ids select 'g-run-1', tests.pid('s-run', tests.month_start(tests.today()));
select tests.assert_true(tests.mko('s-run', 'home-a', 'measurable', 'monthly', 100, 'km') = 'exists', 'A retry answers exists');
select tests.assert_true(tests.periods('s-run') = 1, 'And makes no second period');
select tests.act_as('carol');
select tests.assert_true(tests.mko('s-run', null, 'completion', 'monthly') = 'id_taken', 'Someone else reusing the id is refused');
select tests.assert_true(
  (select r ->> 'outcome' = 'created' from tests.mk('s-carol', null, 'measurable', 'weekly', 3, 'h', null, null, 'sunday') r),
  'Carol creates a personal weekly series with Sunday weeks');
select tests.assert_true((tests.series('s-carol') ->> 'weekStart') = 'sunday'
  and (select extract(dow from (tests.series('s-carol') #>> '{current,start}')::date) = 0), 'Its period starts on a Sunday');
select tests.act_as('alice');
select tests.assert_true(tests.series('s-carol') is null, 'Nobody else sees a personal series');
select tests.assert_true((select count(*) = 0 from jsonb_array_elements(public.get_goals(null) -> 'series')),
  'Not even in their own Personal space');

select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeGoals']);
select tests.act_as('bob');
select tests.assert_true(tests.mko('s-b', 'home-b', 'measurable', 'yearly', 12, 'km') = 'created', 'Bob creates a series in Home B');
select tests.act_as('carol');
select tests.assert_true(tests.series('s-b') is null, 'Carol does not see Home B''s series');
select tests.assert_true(public.get_goal_series_periods(tests.i('s-b')) is null, 'Nor its periods');
select tests.assert_true((select outcome = 'not_found' from public.set_goal_series_state(tests.i('s-b'), 1, 'pause')),
  'Nor changes it');
select tests.assert_true(public.sync_goal_periods(null, tests.i('s-b')) = 0, 'Nor rolls it');
select tests.assert_denied($$select public.sync_goal_periods(tests.i('home-b'))$$, 'Nor syncs a Home she is not in');

-- Lists and pages ----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 from jsonb_array_elements(public.get_goals(tests.i('home-a')) -> 'goals') g
   where g ->> 'id' = tests.i('g-run-1')::text and g #>> '{period,frequency}' = 'monthly'
     and (g #>> '{period,ended}')::boolean = false),
  'The current period is in Active with its frequency');
select tests.assert_true(
  (select count(*) = 1 from jsonb_array_elements(public.get_goals(tests.i('home-a')) -> 'series') s
   where s ->> 'id' = tests.i('s-run')::text and s #>> '{current,id}' = tests.i('g-run-1')::text
     and s ->> 'access' = 'contribute'),
  'The series is listed with its current period');
select tests.assert_true((tests.series('s-run') -> 'actions' ->> 'manage')::boolean = false
  and jsonb_array_length(tests.series('s-run') -> 'targets') = 1, 'A Member sees the series, without managing it');

-- Finalization -------------------------------------------------------------------------------------------

select tests.assert_true(
  (public.add_goal_entry(tests.i('e1'), tests.i('g-run-1'), 'add', 75, null, 'app', null) ->> 'outcome') = 'added',
  'Carol adds 75 km to this month');
select tests.act_as_owner();
-- This month becomes October 2020, so it has ended in real time.
select tests.move_period(tests.i('g-run-1'), '2020-10-01', '2020-10-31');
select tests.assert_true(tests.roll('s-run', now()) = 1, 'The rollover creates the current month');
insert into ids select 'g-run-2', tests.pid('s-run', tests.month_start(tests.today()));
select tests.assert_true(
  (select outcome = 'not_reached' and outcome_total = 75 and finalized_at is not null and achieved_at is null
   from private.goals where id = tests.i('g-run-1')),
  'October closes at 75/100, target not reached, nothing achieved');
select tests.assert_true(tests.events(tests.i('g-run-1'), 'finalized') = 1, 'Its finalization is in its history');
select tests.assert_true(
  (select target = 100 and private.goal_total(g) = 0 and period_end = (tests.month_start(tests.today()) + interval '1 month')::date - 1
   from private.goals g where id = tests.i('g-run-2')),
  'The new month starts at 0/100: no shortage carried forward');
select tests.assert_true(tests.roll('s-run', now()) = 0 and tests.roll('s-run', now()) = 0
  and tests.periods('s-run') = 2 and tests.events(tests.i('g-run-1'), 'finalized') = 1,
  'A duplicate rollover changes nothing');

select tests.act_as('carol');
select tests.assert_true((tests.goal(tests.i('g-run-1')) ->> 'status') = 'ended'
  and (tests.goal(tests.i('g-run-1')) #>> '{period,outcome}') = 'not_reached'
  and (tests.goal(tests.i('g-run-1')) -> 'actions' ->> 'contribute')::boolean = false,
  'An ended period shows its outcome and takes no contributions');
select tests.assert_true(
  (public.add_goal_entry(tests.i('e2'), tests.i('g-run-1'), 'add', 5, null, 'app', null) ->> 'outcome') = 'period_ended',
  'A late contribution is refused');
select tests.assert_true((public.update_goal_entry(tests.i('e1'), 'reverse') ->> 'outcome') = 'period_ended',
  'A Member cannot reverse her own entry in an ended period');
select tests.assert_true(
  (select e ->> 'action' is null from jsonb_array_elements(public.get_goal_entries(tests.i('g-run-1')) -> 'entries') e
   where e ->> 'id' = tests.i('e1')::text), 'Her entry offers her nothing there');
select tests.assert_true(
  (public.add_goal_entry(tests.i('e3'), tests.i('g-run-1'), 'total', 100, null, 'app', 75) ->> 'outcome') = 'not_permitted',
  'Nor may she set its total');
select tests.assert_true((public.set_goal_achievement(tests.i('g-run-1'), tests.grev(tests.i('g-run-1')), true) ->> 'outcome')
  = 'not_permitted', 'Nor mark it achieved');

select tests.act_as('alice');
select tests.assert_true((public.update_goal_entry(tests.i('e1'), 'amend', 105, 'Forgot a run') ->> 'outcome') = 'corrected',
  'Alice corrects October to 105');
select tests.assert_true(
  tests.p($q$select outcome = 'reached' and outcome_total = 105 and outcome_corrected_at is not null and achieved_at is null
   from private.goals where id = tests.i('g-run-1')$q$),
  'October is now target reached, marked corrected, still not achieved');
select tests.assert_true(tests.events(tests.i('g-run-1'), 'outcome_changed') = 1, 'The flip is in its history');
select tests.assert_true(tests.p($q$select private.goal_total(g) = 0 from private.goals g where g.id = tests.i('g-run-2')$q$),
  'The current month is untouched');
select tests.assert_true((public.set_goal_achievement(tests.i('g-run-1'), tests.grev(tests.i('g-run-1')), true) ->> 'outcome')
  = 'achieved', 'A goal manager confirms the achievement');
select tests.assert_true((public.update_goal_entry(tests.i('e1'), 'amend', 90) ->> 'outcome') = 'corrected',
  'A later correction takes it to 90');
select tests.assert_true(
  tests.p($q$select achieved_at is not null and outcome = 'not_reached' from private.goals where id = tests.i('g-run-1')$q$)
  and (tests.goal(tests.i('g-run-1')) #>> '{period,needsReview}')::boolean
  and tests.events(tests.i('g-run-1'), 'outcome_changed') = 2,
  'The confirmed achievement stays and needs review; the outcome flips back');
select tests.assert_true(
  (public.add_goal_entry(tests.i('e4'), tests.i('g-run-1'), 'add', 10, null, 'app', null) ->> 'outcome') = 'achieved',
  'An achieved period takes nothing');
select tests.assert_true((public.set_goal_achievement(tests.i('g-run-1'), tests.grev(tests.i('g-run-1')), false, 'Short') ->> 'outcome')
  = 'reopened', 'The review: Alice reopens it');
select tests.assert_true(
  (public.add_goal_entry(tests.i('e5'), tests.i('g-run-1'), 'total', 100, null, 'app', 90) ->> 'outcome') = 'adjusted'
  and tests.p($q$select outcome = 'reached' and outcome_total = 100 from private.goals where id = tests.i('g-run-1')$q$),
  'A goal manager may set an ended period''s total; the outcome follows');
select tests.assert_true(
  (public.add_goal_entry(tests.i('e6'), tests.i('g-run-1'), 'add', 1, null, 'app', null) ->> 'outcome') = 'period_ended',
  'But adds no progress to it either');

-- Period rules on the S30 functions ----------------------------------------------------------------------

select tests.assert_true((public.change_goal_target(tests.i('g-run-2'), tests.grev(tests.i('g-run-2')), 50, 'km', 'preset')
  ->> 'outcome') = 'series_period', 'A period''s target is changed from its series');
select tests.assert_denied(format($$select public.update_goal(%L, %s, 'Run', null, '2099-01-01')$$,
    tests.i('g-run-2'), tests.grev(tests.i('g-run-2'))),
  'A period''s deadline comes from its series', '22023');
select tests.assert_true(
  (select outcome = 'saved' from public.update_goal(tests.i('g-run-2'), tests.grev(tests.i('g-run-2')), 'Run this month', null,
     (tests.goal(tests.i('g-run-2')) ->> 'deadline')::date)),
  'Its title is its own');
select tests.assert_denied(format($$select public.set_goal_reminders(%L, 0, true, null, 2::smallint, '09:00')$$,
    tests.i('g-run-2')), 'A period has no overdue reminder', '22023');
select tests.assert_true((public.set_goal_reminders(tests.i('g-run-1'), 0, true, 2::smallint, null, '09:00') ->> 'outcome')
  = 'period_ended', 'Nor reminders once it ended');

-- Target effective periods -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (public.add_goal_entry(tests.i('e7'), tests.i('g-run-2'), 'add', 60, null, 'app', null) ->> 'outcome') = 'added',
  'Carol adds 60 to this month');
select tests.assert_true((tests.starget('s-run', (tests.month_start(tests.today()) + interval '1 month')::date, 50) ->> 'outcome')
  = 'not_permitted', 'A Member does not change targets');
select tests.act_as('alice');
select tests.assert_true(
  (select r ->> 'outcome' = 'preview' and (r #>> '{impact,current}')::boolean = false
     and (r #>> '{impact,targetBefore}')::numeric = 100 and r #>> '{impact,until}' is null
   from tests.starget('s-run', (tests.month_start(tests.today()) + interval '1 month')::date, 50, 'km', true) r),
  'The preview of next month''s target shows the change and that it applies onward');
select tests.assert_true(
  (tests.starget('s-run', (tests.month_start(tests.today()) + interval '1 month')::date, 50) ->> 'outcome') = 'saved'
  and tests.p($q$select target = 100 from private.goals where id = tests.i('g-run-2')$q$),
  'Next month''s target is scheduled; this month keeps 100');
select tests.assert_true((tests.starget('s-run', '2020-10-01', 50) ->> 'outcome') = 'invalid_period',
  'A past period cannot be changed');
select tests.assert_true((tests.starget('s-run', tests.month_start(tests.today()) + 3, 50) ->> 'outcome') = 'invalid_period',
  'Nor a date that does not start a period');
select tests.assert_true((tests.starget('s-run', tests.month_start(tests.today()), 50) ->> 'outcome') = 'confirm_status',
  'Lowering this month to 50 would reach it: confirmation first');
select tests.assert_true(
  (tests.starget('s-run', tests.month_start(tests.today()), 50, 'km', false, false, true) ->> 'outcome') = 'saved'
  and (tests.goal(tests.i('g-run-2')) ->> 'reached')::boolean and (tests.goal(tests.i('g-run-2')) ->> 'achievedAt') is null,
  'Confirmed: this month is reached at 60/50, never achieved by itself');
select tests.assert_true((tests.starget('s-run', tests.month_start(tests.today()), 55) ->> 'outcome') = 'saved',
  'A change that keeps the result needs no confirmation');
select tests.assert_true((tests.starget('s-run', tests.month_start(tests.today()), 55, 'm') ->> 'outcome') = 'confirm_unit',
  'A unit change on a period with progress asks first');
select tests.assert_true((public.set_goal_achievement(tests.i('g-run-2'), tests.grev(tests.i('g-run-2')), true) ->> 'outcome')
  = 'achieved', 'Alice marks this month achieved');
select tests.assert_true((tests.starget('s-run', tests.month_start(tests.today()), 80) ->> 'outcome') = 'confirm_status',
  'Raising it above the progress of an achieved period asks first');
select tests.assert_true(
  (tests.starget('s-run', tests.month_start(tests.today()), 80, 'km', false, false, true) ->> 'outcome') = 'saved'
  and tests.p($q$select achieved_at is null from private.goals where id = tests.i('g-run-2')$q$)
  and tests.p($q$select reopened_at is not null from private.goal_achievements where goal_id = tests.i('g-run-2')$q$),
  'Confirmed: the achievement is reopened and kept in its history');
select tests.assert_true(tests.p($q$select target = 100 from private.goals where id = tests.i('g-run-1')$q$),
  'October keeps its own target');
select tests.assert_true(
  tests.p($q$select array_agg(target order by effective_from) = array[80, 50]::numeric[]
   from private.goal_series_targets where series_id = tests.i('s-run')$q$),
  'The schedule: 80 from this month (replacing 100), 50 from next month');

-- Rollover at the boundaries -----------------------------------------------------------------------------

select tests.assert_true(tests.mko('s-cal', 'home-a', 'measurable', 'monthly', 10, 'km') = 'created', 'A calendar series');
select tests.act_as_owner();
select tests.restart('s-cal', '2030-01-01');
select tests.assert_true(tests.roll('s-cal', '2029-12-31 22:59:59+00') = 0, 'Nothing before its first period');
select tests.assert_true(
  (select next_roll_at = '2029-12-31 23:00:00+00' from private.goal_series where id = tests.i('s-cal')),
  'The next work is its first period''s start, midnight in Brussels');
select tests.assert_true(tests.roll('s-cal', '2030-01-15 12:00+00') = 1
  and (tests.period('s-cal', '2030-01-01')).period_end = '2030-01-31', 'January 2030 is created');
select tests.assert_true(
  (select next_roll_at = '2030-01-31 23:00:00+00' from private.goal_series where id = tests.i('s-cal')),
  'The next work is the end of January (Brussels midnight)');
select tests.assert_true(tests.roll('s-cal', '2030-01-31 22:59:59+00') = 0
  and (tests.period('s-cal', '2030-01-01')).finalized_at is null, 'One second before midnight January is still running');
select tests.assert_true(tests.roll('s-cal', '2030-01-31 23:00:00+00') = 1
  and (tests.period('s-cal', '2030-01-01')).outcome = 'not_reached'
  and (tests.period('s-cal', '2030-02-01')).period_end = '2030-02-28', 'At midnight January closes and February (28 days) starts');
select tests.assert_true(tests.roll('s-cal', '2030-01-31 23:00:00+00') = 0 and tests.periods('s-cal') = 2,
  'Rolling the same moment again changes nothing');
select tests.assert_true(tests.roll('s-cal', '2030-04-10 10:00+00') = 1 and tests.periods('s-cal') = 3
  and (tests.period('s-cal', '2030-03-01')).id is null and (tests.period('s-cal', '2030-02-01')).finalized_at is not null,
  'After a gap only April is created: March is never backfilled');

select tests.act_as('alice');
select tests.assert_true(tests.state('s-cal', 'pause') = 'saved', 'Alice pauses the series');
select tests.assert_true(tests.state('s-cal', 'pause') = 'unchanged', 'Twice is harmless');
select tests.act_as_owner();
select tests.assert_true(tests.roll('s-cal', '2030-05-02 10:00+00') = 0 and (tests.period('s-cal', '2030-04-01')).finalized_at is not null
  and (tests.period('s-cal', '2030-05-01')).id is null, 'Paused: April closes, May is not created');
select tests.act_as('alice');
select tests.assert_true(tests.state('s-cal', 'resume') = 'saved', 'Resumed');
select tests.act_as_owner();
select tests.assert_true(tests.roll('s-cal', '2030-05-20 10:00+00') = 1, 'Resumed: the running month (May) is created');
update private.goal_series set ends_on = '2030-05-31' where id = tests.i('s-cal');
select tests.assert_true(tests.roll('s-cal', '2030-06-02 10:00+00') = 0
  and tests.p($q$select state = 'stopped' and next_roll_at is null from private.goal_series where id = tests.i('s-cal')$q$)
  and (tests.period('s-cal', '2030-06-01')).id is null, 'After its end date the series stops and makes no June');
select tests.act_as('alice');
select tests.assert_true(tests.state('s-cal', 'resume') = 'stopped', 'A stopped series cannot resume');
select tests.assert_true((tests.series('s-cal') ->> 'nextPeriod') is null
  and (tests.series('s-cal') -> 'actions' ->> 'stop')::boolean = false, 'It has no next period and nothing to stop');
select tests.assert_true(
  (select jsonb_array_length(p -> 'periods') = 4 and (p -> 'periods' -> 0 #>> '{period,start}') = '2030-05-01'
   from public.get_goal_series_periods(tests.i('s-cal')) p),
  'Its history: four periods, newest first');

select tests.assert_true(tests.mko('s-leap', 'home-a', 'measurable', 'monthly', 10, 'km') = 'created', 'A leap series');
select tests.assert_true(tests.mko('s-year', 'home-a', 'measurable', 'yearly', 100, 'km') = 'created', 'A yearly series');
select tests.assert_true(
  (select r ->> 'outcome' = 'created' from tests.mk('s-week', 'home-a', 'measurable', 'weekly', 5, 'km') r), 'A weekly series');
select tests.act_as_owner();
select tests.restart('s-leap', '2032-02-01');
select tests.assert_true(tests.roll('s-leap', '2032-02-10 10:00+00') = 1
  and (tests.period('s-leap', '2032-02-01')).period_end = '2032-02-29', 'February 2032 has 29 days');
select tests.assert_true(tests.roll('s-leap', '2032-02-29 22:59:00+00') = 0, 'It still runs on the 29th');
select tests.assert_true(tests.roll('s-leap', '2032-02-29 23:00:00+00') = 1
  and (tests.period('s-leap', '2032-03-01')).id is not null, 'March starts after the 29th');
select tests.restart('s-year', '2030-01-01');
select tests.assert_true(tests.roll('s-year', '2030-06-01 10:00+00') = 1
  and (tests.period('s-year', '2030-01-01')).period_end = '2030-12-31', 'The year 2030');
select tests.assert_true(tests.roll('s-year', '2030-12-31 22:59:00+00') = 0, 'Still 2030 in Brussels');
select tests.assert_true(tests.roll('s-year', '2030-12-31 23:00:00+00') = 1
  and (tests.period('s-year', '2031-01-01')).id is not null and (tests.period('s-year', '2030-01-01')).finalized_at is not null,
  'At the New Year 2030 closes and 2031 starts');
select tests.restart('s-week', '2026-12-28');
select tests.assert_true(tests.roll('s-week', '2027-01-01 12:00+00') = 1
  and (tests.period('s-week', '2026-12-28')).period_end = '2027-01-03', 'The week across New Year is one period');
select tests.assert_true(tests.roll('s-week', '2027-01-03 23:00:00+00') = 1
  and (tests.period('s-week', '2027-01-04')).id is not null, 'The next week starts on Monday 4 January');

select tests.act_as('alice');
select tests.assert_true((tests.starget('s-year', '2032-01-01', 120) ->> 'outcome') = 'saved',
  'A target for a future year is scheduled');
select tests.assert_true((tests.starget('s-year', '2029-01-01', 120) ->> 'outcome') = 'invalid_period',
  'Not one before the series starts');
select tests.act_as_owner();
select tests.assert_true((tests.period('s-year', '2031-01-01')).target = 100 and (tests.period('s-year', '2030-01-01')).target = 100
  and (private.goal_series_target_for(tests.i('s-year'), '2032-01-01')).target = 120,
  'Existing years keep their targets; 2032 will use 120');
select tests.act_as('alice');

-- Reminders ----------------------------------------------------------------------------------------------

select tests.assert_true(
  (select r ->> 'outcome' = 'created' from tests.mk('s-rem', 'home-a', 'completion', 'monthly', null, null, null, null,
     'monday', false, 3::smallint) r), 'A completion series with an advance reminder 3 days before each period ends');
select tests.assert_true(
  tests.p($q$select enabled and lead_days = 3 and overdue_days is null and at_time = '09:00' from private.goal_reminders
   where goal_id = tests.pid('s-rem', tests.month_start(tests.today()))$q$),
  'Its period has the reminder');
select tests.act_as('carol');
select tests.assert_true((public.set_goal_achievement(tests.pid('s-rem', tests.month_start(tests.today())),
    tests.grev(tests.pid('s-rem', tests.month_start(tests.today()))), true) ->> 'outcome') = 'achieved',
  'A Member marks a running completion period achieved');
select tests.act_as_owner();
insert into ids select 'g-rem', tests.pid('s-rem', tests.month_start(tests.today()));
select tests.move_period(tests.i('g-rem'), '2020-03-01', '2020-03-31');
-- Undo the achievement behind the API's back, so the period ends not achieved.
update private.goals set achieved_at = null, achieved_by = null where id = tests.i('g-rem');
update private.goal_achievements set reopened_at = now() where goal_id = tests.i('g-rem');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), tests.rrev(tests.i('g-rem')), 'lead', now()) = 'inactive',
  'An ended period reminds nobody');
select tests.act_as_owner();
select tests.assert_true(tests.roll('s-rem', now()) = 1
  and tests.p($q$select outcome = 'not_reached' from private.goals where id = tests.i('g-rem')$q$),
  'A completion period not achieved by its end closes not reached');
select tests.act_as('carol');
select tests.assert_true((public.set_goal_achievement(tests.i('g-rem'), tests.grev(tests.i('g-rem')), true) ->> 'outcome')
  = 'not_permitted', 'After the end a Member cannot mark it achieved');
select tests.act_as('alice');
select tests.assert_true((public.set_goal_achievement(tests.i('g-rem'), tests.grev(tests.i('g-rem')), true) ->> 'outcome')
  = 'achieved' and tests.p($q$select outcome = 'reached' and outcome_corrected_at is not null from private.goals where id = tests.i('g-rem')$q$),
  'A goal manager may, and the outcome follows, marked corrected');

-- Trash --------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_goal_series(tests.i('s-week'), tests.srev('s-week'))),
  'Bob moves the weekly series to the trash');
select tests.act_as('carol');
select tests.assert_true(tests.series('s-week') is null
  and tests.goal(tests.pid('s-week', '2027-01-04')) is null
  and (select count(*) = 0 from jsonb_array_elements(public.get_goals(tests.i('home-a')) -> 'series') s
       where s ->> 'id' = tests.i('s-week')::text),
  'The series and its periods are gone for everyone');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
     array[(select entry_id from public.list_trash(tests.i('home-a'), 'goals') where label = 'S-Week')])),
  'Alice restores it');
select tests.assert_true(tests.series('s-week') is not null and tests.goal(tests.pid('s-week', '2027-01-04')) is not null,
  'Back with its periods');

-- The background rollover --------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.move_period(tests.i('g-run-2'), '2020-11-01', '2020-11-30');
update private.goal_series set next_roll_at = now() - interval '1 minute' where id = tests.i('s-run');
select tests.act_as_service_role();
select tests.assert_true(public.roll_goal_periods() >= 1, 'The background run creates the due period');
select tests.assert_true(public.roll_goal_periods() = 0, 'A duplicate run creates nothing');
select tests.act_as_owner();
select tests.assert_true(tests.periods('s-run') = 3
  and (select finalized_at is not null and outcome = 'not_reached' and outcome_total = 60 from private.goals where id = tests.i('g-run-2'))
  and (select target = 80 from private.goals g where g.series_id = tests.i('s-run') and g.period_start = tests.month_start(tests.today())),
  'The moved month closed at 60/80, not reached; the new month takes its target from the schedule');
