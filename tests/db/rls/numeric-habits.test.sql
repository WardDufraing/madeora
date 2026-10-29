-- S29: numeric habits (supabase/migrations/*_numeric_habits.sql). Alice owns Home A, where Bob is an
-- Administrator granted manageHomeHabits and Carol a Member; Bob owns Home B, which Carol is not in.
-- Covers: nothing reachable as a table; creating and validating a tracking (units, precision, discrete
-- units, presets, weekly refusal); contributions (retry, id reuse, window, future, positive-only,
-- exact decimal sums, excess without carryover, completion once); conversions and precision;
-- Undo, voiding and amending across the threshold with streak recalculation; contribution
-- privacy; binary calls on numeric days; paused, unscheduled, ended and archived days; tracking
-- changes (today with and without a status flip, stale totals, next day, future dates, units,
-- history kept); presets; the daily note; daily totals; weekly and monthly summaries including mixed
-- units; progress-aware reminders and snoozes; isolation between Homes and personal habits.

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
  'n-water', 'n-ml', 'n-cups', 'n-h', 'n-day', 'n-end', 'n-end2', 'n-arch', 'n-b', 'n-bad', 'n-wk', 'n-mix',
  'n-per', 'n-rem'
]) as n;
insert into ids select 'k' || g, gen_random_uuid() from generate_series(1, 120) g;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.rev(p_name text) returns integer
  language sql security definer as $$ select revision from private.habits where id = tests.i(p_name); $$;
-- plpgsql, so every call takes a fresh snapshot (an inlined SQL function would read the statement's).
create function tests.habit(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_habit(tests.i(p_name)); end $$;
create function tests.streak(p_name text) returns integer
  language plpgsql as $$
  begin return (public.get_habit(tests.i(p_name)) -> 'streak' ->> 'current')::integer; end $$;
-- Adds progress; the client id is the name of a prepared id.
create function tests.add(p_id text, p_habit text, p_qty numeric, p_on date default null, p_unit text default null)
returns jsonb
  language sql as $$
  select public.add_habit_contribution(tests.i(p_id), tests.i(p_habit), p_qty, p_on, p_unit, 'app', null); $$;
create function tests.addo(p_id text, p_habit text, p_qty numeric, p_on date default null, p_unit text default null)
returns text
  language sql as $$ select tests.add(p_id, p_habit, p_qty, p_on, p_unit) ->> 'outcome'; $$;
create function tests.upd(p_id text, p_action text, p_qty numeric default null, p_reason text default null)
returns text
  language sql as $$
  select public.update_habit_contribution(tests.i(p_id), p_action, p_qty, p_reason) ->> 'outcome'; $$;
create function tests.total(p_habit text, p_on date) returns numeric
  language sql security definer as $$ select private.habit_contribution_total(tests.i(p_habit), p_on); $$;
create function tests.progress(p_habit text) returns jsonb
  language plpgsql as $$ begin return public.get_habit(tests.i(p_habit)) -> 'progress'; end $$;
create function tests.active_checkins(p_habit text, p_on date) returns bigint
  language sql security definer as $$
  select count(*) from private.habit_checkins
  where habit_id = tests.i(p_habit) and on_date = p_on and status = 'active'; $$;
create function tests.checkin(p_habit text, p_on date) returns uuid
  language sql security definer as $$
  select id from private.habit_checkins where habit_id = tests.i(p_habit) and on_date = p_on
  order by (status = 'active') desc, recorded_at desc limit 1; $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.notice(p_user text, p_kind text) returns uuid
  language sql security definer as $$
  select id from public.notifications where user_id = tests.user_id(p_user) and kind = p_kind
  order by created_at desc limit 1; $$;
-- A numeric habit created for a person or Home with a tracking.
create function tests.numeric_habit(
  p_name text, p_home text, p_target numeric, p_unit text, p_kind text, p_quick numeric[] default null,
  p_starts_on date default null, p_ends_on date default null
) returns text
  language sql as $$
  select outcome from public.create_habit(tests.i(p_name), case when p_home is null then null else tests.i(p_home) end,
    initcap(p_name), null, 'daily', null, null, coalesce(p_starts_on, tests.d(-7)), p_ends_on,
    case when p_home is null then 'Europe/Brussels' end, 'monday', p_target, p_unit, p_kind, p_quick); $$;
-- A personal habit created directly (fixtures may start further back than the API allows).
create function tests.fixture(p_name text, p_owner uuid, p_starts_on date) returns void
  language plpgsql security definer as $$
  begin
    insert into private.habits (id, owner_user_id, name, time_zone, week_start, created_by)
      values (tests.i(p_name), p_owner, p_name, 'Europe/Brussels', 'monday', p_owner);
    insert into private.habit_periods (habit_id, starts_on) values (tests.i(p_name), p_starts_on);
    insert into private.habit_schedules (habit_id, effective_on, kind) values (tests.i(p_name), p_starts_on, 'daily');
  end $$;
-- Tracking versions as a manager sees them in the detail.
create function tests.tracking(p_habit text, p_on date) returns jsonb
  language sql security definer as $$
  select to_jsonb(t) from private.habit_tracking t
  where t.habit_id = tests.i(p_habit) and t.effective_on <= p_on order by t.effective_on desc limit 1; $$;
-- The numeric days of the detail by date.
create function tests.numday(p_habit text, p_on date) returns jsonb
  language plpgsql as $$
  declare v jsonb;
  begin
    select x into v from jsonb_array_elements(public.get_habit(tests.i(p_habit)) -> 'numericRecent') x
      where (x ->> 'onDate')::date = p_on;
    return v;
  end $$;
create function tests.change(
  p_habit text, p_target numeric, p_unit text default 'glasses', p_kind text default 'preset', p_when text default 'today',
  p_on date default null, p_total numeric default null, p_confirm_status boolean default false,
  p_confirm_unit boolean default false, p_dry boolean default false, p_mode text default 'numeric',
  p_quick numeric[] default null
) returns text
  language sql as $$
  select outcome from public.change_habit_tracking(tests.i(p_habit), tests.rev(p_habit), p_mode, p_target, p_unit,
    p_kind, p_quick, p_when, p_on, p_total, p_confirm_status, p_confirm_unit, p_dry); $$;
grant execute on function tests.i(text), tests.d(integer), tests.rev(text), tests.habit(text), tests.streak(text),
  tests.add(text, text, numeric, date, text), tests.addo(text, text, numeric, date, text),
  tests.upd(text, text, numeric, text), tests.total(text, date), tests.progress(text),
  tests.active_checkins(text, date), tests.checkin(text, date), tests.private_count(text),
  tests.notice(text, text), tests.numeric_habit(text, text, numeric, text, text, numeric[], date, date),
  tests.tracking(text, date), tests.numday(text, date),
  tests.change(text, numeric, text, text, text, date, numeric, boolean, boolean, boolean, text, numeric[])
  to authenticated, service_role;

-- Nothing is reachable as a table ---------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.habit_tracking', 'The API cannot read tracking versions');
select tests.assert_denied('select * from private.habit_contributions', 'Nor contributions');
select tests.assert_denied('select * from private.habit_day_notes', 'Nor day notes');
select tests.assert_denied($$select private.habit_unit_info('ml', 'preset')$$, 'Nor the helpers');
select tests.assert_denied($$select private.get_habit_before_numeric(gen_random_uuid())$$, 'Nor the renamed originals');
select tests.act_as_anon();
select tests.assert_denied($$select public.add_habit_contribution(gen_random_uuid(), gen_random_uuid(), 1)$$,
  'Nobody signed out adds progress');

-- Creating a numeric habit --------------------------------------------------------------------------------

select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeHabits']);
select tests.act_as('carol');
select tests.assert_true(tests.numeric_habit('n-bad', 'home-a', 8, 'glasses', 'preset') = 'not_permitted',
  'A member does not create a numeric Home habit');
select tests.act_as('bob');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 0, 'glasses', 'preset')$$,
  'A zero target is refused', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', -3, 'glasses', 'preset')$$,
  'A negative target is refused', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 2.5, 'glasses', 'preset')$$,
  'Glasses are whole numbers', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 1.2345, 'l', 'preset')$$,
  'At most three decimals', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 2000001, 'ml', 'preset')$$,
  'A target above the limit is refused', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 5, 'furlongs', 'preset')$$,
  'An unknown preset unit is refused', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 5, '', 'custom')$$,
  'A custom label cannot be empty', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 5, repeat('x', 21), 'custom')$$,
  'A custom label has at most 20 characters', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 8, 'glasses', 'preset', array[1, 2, 3, 4, 5, 6]::numeric[])$$,
  'At most five presets', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 8, 'glasses', 'preset', array[1, 1]::numeric[])$$,
  'Presets are distinct', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 8, 'glasses', 'preset', array[0.5]::numeric[])$$,
  'A preset follows the unit''s precision', '22023');
select tests.assert_denied($$select tests.numeric_habit('n-bad', 'home-a', 8, 'glasses', 'preset', array[0]::numeric[])$$,
  'A zero preset is refused', '22023');
select tests.assert_denied($$select public.create_habit(tests.i('n-bad'), tests.i('home-a'), 'Weekly', null, 'weekly',
    null, 3::smallint, tests.d(0), null, null, 'monday', 8, 'glasses', 'preset', null)$$,
  'A weekly schedule cannot be numeric', '22023');
select tests.assert_denied($$select public.create_habit(tests.i('n-bad'), tests.i('home-a'), 'Plain', null, 'daily',
    null, null, tests.d(0), null, null, 'monday', null, 'glasses', 'preset', null)$$,
  'A unit without a target is refused', '22023');
select tests.assert_true(tests.numeric_habit('n-water', 'home-a', 8, 'glasses', 'preset', array[1, 2]::numeric[]) = 'created',
  'Bob creates a daily Home habit of 8 glasses that started a week ago');
select tests.assert_true(tests.numeric_habit('n-water', 'home-a', 8, 'glasses', 'preset', array[1, 2]::numeric[]) = 'exists',
  'A retry answers exists');
select tests.assert_true(
  (select tests.habit('n-water') -> 'tracking' ->> 'mode' = 'numeric'
     and (tests.habit('n-water') -> 'tracking' ->> 'target')::numeric = 8
     and tests.habit('n-water') -> 'tracking' ->> 'unit' = 'glasses'
     and (tests.habit('n-water') -> 'progress' ->> 'total')::numeric = 0),
  'The habit says how it is tracked and starts the day at 0');

-- Contributions ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.addo('k1', 'n-water', 3) = 'added', 'Carol adds 3 glasses');
select tests.assert_true(tests.addo('k1', 'n-water', 3) = 'exists', 'A retry answers exists and adds nothing');
select tests.assert_true(tests.total('n-water', tests.d(0)) = 3, 'The total is 3');
select tests.assert_true(
  (tests.habit('n-water') ->> 'todayState') = 'pending' and tests.active_checkins('n-water', tests.d(0)) = 0,
  'Partial progress is not a completion');
select tests.act_as('bob');
select tests.assert_true(tests.addo('k1', 'n-water', 1) = 'id_taken', 'Someone else''s client id is refused');
select tests.assert_denied($$select tests.add('k2', 'n-water', 0)$$, 'Zero is not progress', '22023');
select tests.assert_denied($$select tests.add('k2', 'n-water', -1)$$, 'Nor is a negative amount', '22023');
select tests.assert_denied($$select tests.add('k2', 'n-water', 2.5)$$, 'A fraction of a glass is refused', '22023');
select tests.assert_denied($$select tests.add('k2', 'n-water', 1000001)$$, 'Nor an absurd amount', '22023');
select tests.assert_true(tests.addo('k2', 'n-water', 1, tests.d(1)) = 'future', 'Tomorrow is refused');
select tests.assert_true(tests.addo('k2', 'n-water', 1, tests.d(-8)) = 'outside_window', 'Eight days ago is refused');
select tests.assert_true(
  (select public.add_habit_contribution(tests.i('k2'), tests.i('n-water'), 1, null, null, 'app', 99) ->> 'outcome') = 'stale',
  'A form read at another revision is refused');
select tests.assert_true(tests.addo('k2', 'n-water', 5) = 'added', 'Bob adds 5 more');
select tests.assert_true(
  (tests.habit('n-water') ->> 'todayState') = 'completed' and tests.active_checkins('n-water', tests.d(0)) = 1
  and (tests.habit('n-water') -> 'progress' ->> 'met')::boolean,
  'Reaching 8/8 completes the day once');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_checkins where habit_id = %L and on_date = %L and derived and completed_by is null',
    tests.i('n-water'), tests.d(0))) = 1,
  'The completion is a derived check-in that names nobody');
select tests.assert_true(tests.streak('n-water') = 1, 'The streak counts one day');
select tests.act_as('carol');
select tests.assert_true(tests.addo('k3', 'n-water', 2) = 'added', 'Carol adds 2 more after the target');
select tests.assert_true(
  (tests.progress('n-water') ->> 'total')::numeric = 10 and (tests.progress('n-water') ->> 'above')::boolean
  and tests.active_checkins('n-water', tests.d(0)) = 1,
  '10/8 shows the actual total and is still one completion');
select tests.assert_true(tests.total('n-water', tests.d(1)) = 0 and tests.total('n-water', tests.d(-1)) = 0,
  'Excess never carries to another day');
select tests.assert_true(tests.addo('k4', 'n-water', 8, tests.d(-1)) = 'added', 'Yesterday can be filled in later');
select tests.assert_true(tests.total('n-water', tests.d(-1)) = 8 and tests.total('n-water', tests.d(0)) = 10
  and tests.streak('n-water') = 2, 'Each day keeps its own total; the streak counts two days');
select tests.assert_true(tests.addo('k5', 'n-water', 1, tests.d(-7)) = 'added',
  'Seven days back is still inside the window');

-- Personal habits stay private; Home isolation -----------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.numeric_habit('n-ml', null, 2000, 'ml', 'preset', array[250, 500]::numeric[]) = 'created',
  'Alice creates a personal habit of 2000 mL');
select tests.assert_true(tests.numeric_habit('n-cups', null, 0.3, 'cups', 'custom') = 'created',
  'And one in a custom unit');
select tests.assert_true(tests.addo('k6', 'n-cups', 0.1) = 'added', '0.1 cups');
select tests.assert_true(tests.addo('k7', 'n-cups', 0.2) = 'added', '0.2 cups');
select tests.assert_true(tests.total('n-cups', tests.d(0)) = 0.3, '0.1 + 0.2 is exactly 0.3');
select tests.assert_true((tests.habit('n-cups') ->> 'todayState') = 'completed', 'and completes the day');
select tests.act_as('bob');
select tests.assert_true(tests.habit('n-ml') is null, 'A Home manager never sees a personal numeric habit');
select tests.assert_true(tests.addo('k8', 'n-ml', 100) = 'not_found', 'Nor adds progress to it');
select tests.assert_true(public.get_habit_contributions(tests.i('n-ml'), tests.d(0)) is null, 'Nor reads its contributions');
select tests.assert_true(public.get_habit_daily_totals(tests.i('n-ml')) is null, 'Nor its daily totals');
select tests.assert_true(
  (select outcome = 'not_found' from public.change_habit_tracking(tests.i('n-ml'), 1, 'numeric', 3000, 'ml', 'preset',
    null, 'next', null, null, false, false, false)), 'Nor changes its tracking');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_habit_day_note(tests.i('n-ml'), tests.d(0), 0, 'x')), 'Nor its notes');
select tests.act_as('carol');
select tests.assert_denied($$select tests.numeric_habit('n-b', 'home-b', 8, 'glasses', 'preset')$$,
  'Carol cannot create in a Home she is not in');
select tests.act_as('bob');
select tests.assert_true(tests.numeric_habit('n-b', 'home-b', 8, 'glasses', 'preset') = 'created',
  'Bob creates a numeric habit in his own Home');
select tests.act_as('carol');
select tests.assert_true(tests.habit('n-b') is null and tests.addo('k9', 'n-b', 1) = 'not_found',
  'Carol cannot see or add to a habit of another Home');

-- Conversions and precision ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.addo('k10', 'n-ml', 1.5, null, 'l') = 'added' and tests.total('n-ml', tests.d(0)) = 1500,
  '1.5 L is recorded as 1500 mL');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_contributions where id = %L and entered_unit = %L and entered_quantity = 1.5',
    tests.i('k10'), 'l')) = 1, 'What was typed is kept');
select tests.assert_true(tests.addo('k11', 'n-ml', 0.001, null, 'l') = 'added' and tests.total('n-ml', tests.d(0)) = 1501,
  '0.001 L is exactly 1 mL');
select tests.assert_true(tests.addo('k12', 'n-ml', 3, null, 'glasses') = 'unit_mismatch',
  'Glasses never convert to millilitres');
select tests.assert_denied($$select tests.add('k12', 'n-ml', 3, null, 'furlongs')$$, 'An unknown unit is refused', '22023');
select tests.assert_denied($$select tests.add('k12', 'n-ml', 0.0005, null, 'l')$$, 'Too many decimals are refused', '22023');
select tests.assert_true(tests.addo('k12', 'n-cups', 1, null, 'ml') = 'unit_mismatch', 'A custom unit never converts');
select tests.assert_true(tests.addo('k12', 'n-ml', 250, null, 'ml') = 'added' and tests.total('n-ml', tests.d(0)) = 1751,
  'Entering the habit''s own unit is a plain entry');
select tests.assert_true(tests.numeric_habit('n-h', null, 2, 'h', 'preset') = 'created', 'Alice creates a habit in hours');
select tests.assert_true(
  (select r ->> 'outcome' = 'precision' and (r ->> 'converted')::numeric = 0.333 from tests.add('k13', 'n-h', 20, null, 'min') r),
  '20 minutes is not an exact number of hours: refused with the rounded value');
select tests.assert_true(tests.addo('k13', 'n-h', 30, null, 'min') = 'added' and tests.total('n-h', tests.d(0)) = 0.5,
  '30 minutes is 0.5 h');
select tests.assert_true(tests.addo('k14', 'n-h', 90, null, 'min') = 'added', '90 minutes are added');
select tests.assert_true(tests.total('n-h', tests.d(0)) = 2, 'and make 2 hours');
select tests.assert_true((tests.habit('n-h') ->> 'todayState') = 'completed', 'which complete the day');

-- Binary calls on a numeric day ------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select public.complete_habit(gen_random_uuid(), tests.i('n-water'), tests.d(-2), null, 'app') ->> 'outcome') = 'numeric_required',
  'A single tap never completes a numeric day');
select tests.act_as('bob');
select tests.assert_true(
  public.undo_habit_checkin(tests.checkin('n-water', tests.d(0)), null) ->> 'outcome' = 'numeric_derived',
  'The derived completion cannot be undone directly, not even by a manager');
select tests.assert_true(
  (select outcome = 'numeric_derived' from public.set_habit_checkin_note(tests.checkin('n-water', tests.d(0)), 0, 'x')),
  'Nor noted');

-- Undo, voiding and amending across the threshold ---------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.upd('k1', 'undo') = 'undone', 'Carol undoes her own 3 glasses');
select tests.assert_true(
  tests.total('n-water', tests.d(0)) = 7 and tests.active_checkins('n-water', tests.d(0)) = 0
  and (tests.habit('n-water') ->> 'todayState') = 'pending' and tests.streak('n-water') = 1,
  '7/8 reopens the day and recalculates the streak');
select tests.assert_true(tests.upd('k1', 'undo') = 'already_undone', 'A second undo changes nothing');
select tests.assert_true(tests.upd('k2', 'undo') = 'not_permitted', 'She cannot undo Bob''s contribution');
select tests.assert_true(tests.upd('k2', 'void') = 'not_permitted', 'A member cannot void anything');
select tests.assert_true(tests.upd('k2', 'amend', 4) = 'not_permitted', 'Nor amend');
select tests.assert_true(tests.addo('k15', 'n-water', 1) = 'added'
  and tests.active_checkins('n-water', tests.d(0)) = 1 and tests.streak('n-water') = 2,
  '8/8 again completes the day with one active check-in');
select tests.act_as('bob');
select tests.assert_true(tests.upd('k3', 'void', null, 'Typed twice') = 'corrected', 'Bob voids Carol''s 2 glasses');
select tests.assert_true(tests.total('n-water', tests.d(0)) = 6 and tests.active_checkins('n-water', tests.d(0)) = 0,
  'The day falls back below the target');
select tests.assert_denied($$select tests.upd('k2', 'amend', 2.5)$$, 'An amended quantity follows the unit', '22023');
select tests.assert_denied($$select tests.upd('k2', 'amend', 0)$$, 'Not zero', '22023');
select tests.assert_true(tests.upd('k2', 'amend', 6.0004) = 'precision', 'Nor excess precision');
select tests.assert_true(tests.upd('k2', 'amend', 7) = 'corrected', 'Bob amends 5 to 7');
select tests.assert_true(tests.total('n-water', tests.d(0)) = 8 and tests.active_checkins('n-water', tests.d(0)) = 1,
  'The amended total completes the day again');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_contributions where id = %L and original_quantity = 5 and quantity = 7',
    tests.i('k2'))) = 1, 'The first quantity is kept');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_events where habit_id = %L and kind = %L',
    tests.i('n-water'), 'contribution_corrected')) = 2,
  'Both corrections are in the history, and contributions alone are not');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_events where habit_id = %L and kind in (%L, %L)',
    tests.i('n-water'), 'checked_in', 'undone')) = 0,
  'A completion by total writes no check-in events that name a person');

-- Who sees the contributions --------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select (r ->> 'all')::boolean is false and jsonb_array_length(r -> 'contributions') = 3
     and not exists (select 1 from jsonb_array_elements(r -> 'contributions') c where not (c ->> 'mine')::boolean)
   from public.get_habit_contributions(tests.i('n-water'), tests.d(0)) r),
  'A member sees only her own contributions');
select tests.assert_true(
  (select (r ->> 'total')::numeric = 8 from public.get_habit_contributions(tests.i('n-water'), tests.d(0)) r),
  'But the day''s total is everyone''s');
select tests.act_as('bob');
select tests.assert_true(
  (select (r ->> 'all')::boolean and jsonb_array_length(r -> 'contributions') = 4
     and exists (select 1 from jsonb_array_elements(r -> 'contributions') c where (c ->> 'by')::uuid = tests.i('m-carol-a'))
   from public.get_habit_contributions(tests.i('n-water'), tests.d(0)) r),
  'A manager reviews all of them, with who added each');
select tests.act_as('alice');
select tests.assert_true(
  (select jsonb_array_length(r -> 'contributions') = 4 from public.get_habit_contributions(tests.i('n-water'), tests.d(0)) r),
  'So does the Owner');
select tests.act_as('carol');
select tests.assert_true(
  not exists (select 1 from jsonb_array_elements(tests.habit('n-water') -> 'recent') x
    where x::text like '%' || tests.i('m-bob-a')::text || '%' and (x -> 'checkin' ->> 'derived')::boolean is not true
      and x ->> 'onDate' = tests.d(0)::text),
  'The detail names nobody for today''s derived completion');
select tests.assert_true(
  (tests.habit('n-water') -> 'recent' -> 0 -> 'checkin' ->> 'by') is null,
  'The completion by total has no person');

-- Paused, unscheduled, ended and archived days ----------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  tests.numeric_habit('n-day', 'home-a', 3, 'repetitions', 'preset', null, tests.d(-7)) = 'created', 'A second Home habit');
select tests.act_as_owner();
-- Only today's weekday is scheduled, so every other day of the week is not.
update private.habit_schedules set kind = 'weekdays', weekdays = array[extract(isodow from tests.d(0))::smallint]
  where habit_id = tests.i('n-day');
select tests.act_as('bob');
select tests.assert_true(tests.addo('k16', 'n-day', 1, tests.d(-1)) = 'not_scheduled', 'An unscheduled day takes no progress');
select tests.assert_true(tests.addo('k16', 'n-day', 1, tests.d(-7)) = 'added', 'The same weekday a week ago does');
select tests.assert_true(
  (select outcome = 'saved' from public.set_habit_day_note(tests.i('n-day'), tests.d(-7), 0, 'Late start')),
  'A past scheduled day takes a note');
select tests.assert_true(
  (select outcome = 'not_scheduled' from public.set_habit_day_note(tests.i('n-day'), tests.d(-1), 0, 'x')),
  'An unscheduled day takes none');
select tests.assert_true(
  (select outcome = 'paused' from public.pause_habit(tests.i('n-day'), tests.rev('n-day'), null, false)), 'Bob pauses it');
select tests.assert_true(tests.addo('k17', 'n-day', 1) = 'paused', 'A paused day takes no progress');
select tests.assert_true(
  (select outcome = 'paused' from public.set_habit_day_note(tests.i('n-day'), tests.d(0), 0, 'x')), 'Nor a note');
select tests.assert_true(
  (select outcome = 'today_ineligible' and (impact ->> 'nextDate')::date > tests.d(0)
   from public.change_habit_tracking(tests.i('n-day'), tests.rev('n-day'), 'numeric', 4, 'repetitions', 'preset', null,
     'today', null, 0, false, false, false)),
  'A target cannot apply today on a paused day: the next valid date is offered');
select tests.assert_true(tests.numeric_habit('n-end', 'home-a', 8, 'glasses', 'preset', null, tests.d(-7), tests.d(-3)) = 'created',
  'A habit that ended three days ago');
select tests.assert_true(tests.addo('k18', 'n-end', 1, tests.d(-5)) = 'added', 'Its last days still take late progress');
select tests.assert_true(tests.addo('k19', 'n-end', 1, tests.d(-2)) = 'untracked' and tests.addo('k19', 'n-end', 1) = 'untracked',
  'Nothing after the end date');
select tests.assert_true(tests.change('n-end', 9) = 'ended', 'An ended habit''s tracking is not changed');
select tests.assert_true(tests.numeric_habit('n-arch', 'home-a', 8, 'glasses', 'preset') = 'created', 'Another habit');
select tests.assert_true(
  (select outcome = 'saved' from public.archive_habit(tests.i('n-arch'), tests.rev('n-arch'), true)), 'Bob archives it');
select tests.assert_true(tests.addo('k20', 'n-arch', 1) = 'archived', 'An archived habit takes no progress');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_habit(tests.i('n-wk'), tests.i('home-a'), 'Weekly run', null, 'weekly',
    null, 3::smallint, tests.d(0), null, null, 'monday')), 'A weekly habit');
select tests.assert_true(tests.change('n-wk', 5, 'km', 'preset', 'next') = 'numeric_requires_daily',
  'It cannot become numeric');
select tests.assert_true(
  (select outcome = 'numeric_requires_daily' from public.change_habit_schedule(tests.i('n-water'), tests.rev('n-water'),
    'weekly', null, 3::smallint, tests.d(0) + 7, false)),
  'And a numeric habit cannot become weekly');

-- Changing the tracking -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.change('n-water', 10) = 'not_permitted', 'A member does not change the target');
select tests.act_as('bob');
select tests.assert_true(tests.total('n-water', tests.d(0)) = 8, 'Today stands at 8/8');
select tests.assert_true(tests.change('n-water', 8, 'glasses', 'preset', 'today', null, 8) = 'unchanged', 'An unchanged target is a no-op');
select tests.assert_true(tests.change('n-water', 10, 'glasses', 'preset', 'today', null, 8, false, false, true) = 'preview',
  'Raising the target to 10 previews first');
select tests.assert_true(
  (select (impact -> 'today' ->> 'statusChange')::boolean and (impact -> 'today' ->> 'total')::numeric = 8
   from public.change_habit_tracking(tests.i('n-water'), tests.rev('n-water'), 'numeric', 10, 'glasses', 'preset', null,
     'today', null, 8, false, false, true)),
  'It says the day would turn from complete to partial');
select tests.assert_true(tests.change('n-water', 10, 'glasses', 'preset', 'today', null, 5) = 'stale',
  'A preview of another total is stale');
select tests.assert_true(tests.change('n-water', 10, 'glasses', 'preset', 'today', null, 8) = 'confirm_status',
  'Flipping today''s status needs its own confirmation');
select tests.assert_true(tests.total('n-water', tests.d(0)) = 8 and tests.active_checkins('n-water', tests.d(0)) = 1,
  'Nothing changed meanwhile');
select tests.assert_true(
  (select outcome = 'conflict' from public.change_habit_tracking(tests.i('n-water'), 99, 'numeric', 10, 'glasses', 'preset',
    null, 'today', null, 8, true, false, false)), 'A stale revision conflicts');
select tests.assert_true(tests.change('n-water', 10, 'glasses', 'preset', 'today', null, 8, true) = 'saved', 'Confirmed, it is saved');
select tests.assert_true(
  (tests.progress('n-water') ->> 'target')::numeric = 10 and not (tests.progress('n-water') ->> 'met')::boolean
  and tests.active_checkins('n-water', tests.d(0)) = 0 and tests.total('n-water', tests.d(0)) = 8,
  'The day is 8/10 and incomplete; the contributions are untouched');
select tests.assert_true((tests.numday('n-water', tests.d(-1)) ->> 'target')::numeric = 8
  and (tests.numday('n-water', tests.d(-1)) ->> 'met')::boolean,
  'Yesterday keeps its own target and stays complete');
select tests.assert_true(tests.streak('n-water') = 1, 'The streak follows');
select tests.assert_true(tests.change('n-water', 8, 'glasses', 'preset', 'today', null, 8, true) = 'saved',
  'Lowering it again completes the day (confirmed)');
select tests.assert_true(tests.active_checkins('n-water', tests.d(0)) = 1 and tests.streak('n-water') = 2,
  'One completion, and the streak is back');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_milestones where habit_id = %L', tests.i('n-water'))) = 0,
  'Never a milestone for a target change');
select tests.assert_true(tests.change('n-water', 7, 'glasses', 'preset', 'today', null, 8) = 'saved',
  '8/8 to 8/7 stays complete: no extra confirmation');
select tests.assert_true(tests.change('n-water', 8, 'glasses', 'preset', 'today', null, 8) = 'saved', 'And back');
select tests.assert_true(
  (select outcome = 'invalid_date' from public.change_habit_tracking(tests.i('n-water'), tests.rev('n-water'), 'once', null,
    null, null, null, 'today', null, 8, false, false, false)), 'A mode change cannot apply today');
select tests.assert_true(tests.change('n-water', 8, 'pages', 'preset', 'today', null, 8) = 'invalid_date',
  'Nor a unit change');
select tests.assert_true(tests.change('n-water', 9, 'glasses', 'preset', 'date', tests.d(-1)) = 'invalid_date', 'Nor a past date');
select tests.assert_true(tests.change('n-water', 9, 'glasses', 'preset', 'next') = 'saved',
  'The next scheduled day gets a new target');
select tests.assert_true(
  (tests.progress('n-water') ->> 'target')::numeric = 8
  and (tests.habit('n-water') -> 'nextTracking' ->> 'target')::numeric = 9
  and (tests.habit('n-water') -> 'nextTracking' ->> 'effectiveOn')::date = tests.d(1),
  'Today keeps its target; the next version starts tomorrow');
select tests.assert_true(tests.change('n-water', 12, 'glasses', 'preset', 'date', tests.d(5)) = 'saved'
  and tests.private_count(format('select count(*) from private.habit_tracking where habit_id = %L', tests.i('n-water'))) = 4,
  'A later date adds a version after tomorrow''s');
select tests.assert_true(tests.change('n-water', 9, 'glasses', 'preset', 'date', tests.d(1)) = 'saved'
  and tests.private_count(format('select count(*) from private.habit_tracking where habit_id = %L', tests.i('n-water'))) = 3,
  'Changing tomorrow replaces it and everything after it');
-- Mode and unit changes apply from tomorrow.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and impact ->> 'relation' = 'compatible'
     and (impact -> 'converted' ->> 'target')::numeric = 2 and (impact -> 'converted' ->> 'exact')::boolean
     and (impact -> 'converted' -> 'quickAdds') = '[0.25, 0.5]'::jsonb
   from public.change_habit_tracking(tests.i('n-ml'), tests.rev('n-ml'), 'numeric', 2, 'l', 'preset', array[0.25, 0.5]::numeric[],
     'next', null, null, false, false, true)),
  'Litres convert from millilitres exactly in the preview');
select tests.assert_true(
  (select outcome = 'saved' from public.change_habit_tracking(tests.i('n-ml'), tests.rev('n-ml'), 'numeric', 2, 'l', 'preset',
    array[0.25, 0.5]::numeric[], 'next', null, null, false, false, false)), 'Switching to litres from the next day is saved');
select tests.assert_true(
  tests.progress('n-ml') ->> 'unit' = 'ml' and (tests.progress('n-ml') ->> 'total')::numeric = 1751,
  'Today stays in millilitres');
select tests.assert_true(
  (select outcome = 'confirm_unit' and impact ->> 'relation' = 'incompatible'
   from public.change_habit_tracking(tests.i('n-ml'), tests.rev('n-ml'), 'numeric', 5, 'cups', 'custom', null,
     'date', tests.d(3), null, false, false, false)),
  'Moving to an unrelated label needs the owner to confirm the new target');
select tests.assert_true(
  (select outcome = 'saved' from public.change_habit_tracking(tests.i('n-ml'), tests.rev('n-ml'), 'numeric', 5, 'cups', 'custom',
    null, 'date', tests.d(3), null, false, true, false)), 'Confirmed, it is saved');
select tests.assert_true(
  (select count(*) = 3 from jsonb_array_elements(tests.habit('n-ml') -> 'trackings')),
  'The history lists every version');

-- Presets -------------------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_habit_quick_adds(tests.i('n-water'), tests.rev('n-water'), array[1, 3]::numeric[])),
  'A member does not edit presets');
select tests.act_as('bob');
select tests.assert_denied($$select public.set_habit_quick_adds(tests.i('n-water'), tests.rev('n-water'), array[1, 2, 3, 4, 5, 6]::numeric[])$$,
  'At most five', '22023');
select tests.assert_denied($$select public.set_habit_quick_adds(tests.i('n-water'), tests.rev('n-water'), array[1, 1.5]::numeric[])$$,
  'A fraction of a glass', '22023');
select tests.assert_true(
  (select outcome = 'saved' from public.set_habit_quick_adds(tests.i('n-water'), tests.rev('n-water'), array[1, 3]::numeric[])),
  'Bob replaces the presets');
select tests.assert_true(
  (tests.habit('n-water') -> 'tracking' -> 'quickAdds') = '[1.000, 3.000]'::jsonb
  and (tests.habit('n-water') -> 'nextTracking' -> 'quickAdds') = '[1.000, 3.000]'::jsonb,
  'Today''s version and the next one with the same unit follow');
select tests.act_as('carol');
select tests.assert_true(
  (select public.add_habit_contribution(tests.i('k21'), tests.i('n-water'), 1, null, null, 'widget', 1) ->> 'outcome') = 'stale',
  'A widget showing the old presets is refused');
select tests.assert_true(
  (select public.add_habit_contribution(tests.i('k21'), tests.i('n-water'), 1, null, null, 'widget', tests.rev('n-water')) ->> 'outcome') = 'added',
  'With the current revision it adds');

-- The day note ----------------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_habit_day_note(tests.i('n-water'), tests.d(0), 0, 'Hi')),
  'Contributing is not the right to edit the note');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.set_habit_day_note(tests.i('n-water'), tests.d(0), 0, 'Hot day')),
  'Bob adds a note');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 1 from public.set_habit_day_note(tests.i('n-water'), tests.d(0), 0, 'Other')),
  'A stale editor is told');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.set_habit_day_note(tests.i('n-water'), tests.d(0), 1, 'Hot day, extra')),
  'He edits it');
select tests.assert_true(tests.upd('k21', 'void') = 'corrected', 'A correction follows');
select tests.assert_true(tests.numday('n-water', tests.d(0)) ->> 'note' = 'Hot day, extra', 'The note stays');
select tests.act_as('carol');
select tests.assert_true(tests.numday('n-water', tests.d(0)) ->> 'note' = 'Hot day, extra', 'Everyone who sees the habit reads it');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' and revision = 3 from public.set_habit_day_note(tests.i('n-water'), tests.d(0), 2, '')),
  'Clearing keeps counting');
select tests.assert_true(
  (select outcome = 'unchanged' and revision = 3 from public.set_habit_day_note(tests.i('n-water'), tests.d(0), 3, null)),
  'Clearing nothing changes nothing');
select tests.assert_denied($$select public.set_habit_day_note(tests.i('n-water'), tests.d(0), 3, repeat('a', 281))$$,
  'A note has at most 280 characters', '22023');
select tests.assert_true(
  (select outcome = 'future' from public.set_habit_day_note(tests.i('n-water'), tests.d(1), 0, 'x')), 'Not for tomorrow');
select tests.assert_true(
  (select outcome = 'untracked' from public.set_habit_day_note(tests.i('n-water'), tests.d(-30), 0, 'x')), 'Nor before the start');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.set_habit_day_note(tests.i('n-cups'), tests.d(0), 0, 'Private')),
  'Alice notes her own day');

-- Daily totals ------------------------------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(r -> 'days') = 8 and not (r ->> 'hasMore')::boolean
     and (r -> 'days' -> 0 ->> 'onDate')::date = tests.d(0)
   from public.get_habit_daily_totals(tests.i('n-water')) r),
  'A week''s days, newest first, from the start of the habit');
select tests.assert_true(
  (select jsonb_array_length(r -> 'days') = 3 and (r ->> 'hasMore')::boolean
   from public.get_habit_daily_totals(tests.i('n-water'), null, 3) r), 'A page of three says there are more');
select tests.assert_true(
  (select (r -> 'days' -> 0 ->> 'onDate')::date = tests.d(-3)
   from public.get_habit_daily_totals(tests.i('n-water'), tests.d(-2), 3) r), 'The next page starts the day before');
select tests.assert_denied($$select public.get_habit_daily_totals(tests.i('n-water'), null, 0)$$, 'A page has 1 to 62 days', '22023');
select tests.assert_true(
  (select (x ->> 'total')::numeric = 8 and (x ->> 'met')::boolean
   from jsonb_array_elements((public.get_habit_daily_totals(tests.i('n-water')) -> 'days')) x
   where (x ->> 'onDate')::date = tests.d(-1)), 'Yesterday shows 8 of 8');
select tests.assert_true(public.get_habit_daily_totals(tests.i('n-b')) is null, 'Not another Home''s totals');

-- Summaries -----------------------------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select jsonb_array_length(r -> 'numeric' -> 'periods') = 14
   from public.get_habit_insights(tests.i('n-water'), 30) r), 'Eight weeks and six months');
select tests.assert_true(
  (select (p -> 'segments' -> 0 ->> 'average')::numeric
       = round((p -> 'segments' -> 0 ->> 'total')::numeric / (p -> 'segments' -> 0 ->> 'eligibleDays')::numeric, 3)
     and (p ->> 'soFar')::boolean
   from public.get_habit_insights(tests.i('n-water'), 30) r, jsonb_array_elements(r -> 'numeric' -> 'periods') p
   where p ->> 'kind' = 'week' and (p ->> 'startsOn')::date = (tests.d(0) - (extract(isodow from tests.d(0))::integer - 1))),
  'The running week is labelled so far and its average counts every eligible day');
select tests.assert_true(
  (select sum((s ->> 'total')::numeric) > 0 and sum((s ->> 'metDays')::integer) >= 1
   from public.get_habit_insights(tests.i('n-water'), 30) r, jsonb_array_elements(r -> 'numeric' -> 'periods') p,
     jsonb_array_elements(p -> 'segments') s where p ->> 'kind' = 'month'),
  'The months add actual quantities and count target-met days');
select tests.assert_true(public.get_habit_insights(tests.i('n-wk'), 30) -> 'numeric' = 'null'::jsonb,
  'A habit that was never numeric has no quantity summary');
-- Mixed units: compatible units add up in the latest unit; unrelated labels stay apart.
select tests.act_as_owner();
select tests.fixture('n-mix', tests.user_id('alice'), tests.d(-6));
insert into private.habit_tracking (habit_id, effective_on, mode, target, unit, unit_kind) values
  (tests.i('n-mix'), tests.d(-6), 'numeric', 1000, 'ml', 'preset'),
  (tests.i('n-mix'), tests.d(-3), 'numeric', 1, 'l', 'preset'),
  (tests.i('n-mix'), tests.d(-1), 'numeric', 2, 'cups', 'custom');
insert into private.habit_contributions (id, habit_id, on_date, quantity, contributed_by, source) values
  (tests.i('k100'), tests.i('n-mix'), tests.d(-5), 500, tests.user_id('alice'), 'app'),
  (tests.i('k101'), tests.i('n-mix'), tests.d(-2), 1.5, tests.user_id('alice'), 'app'),
  (tests.i('k102'), tests.i('n-mix'), tests.d(-1), 3, tests.user_id('alice'), 'app');
select tests.act_as('alice');
select tests.assert_true(
  (select coalesce(sum(case when s ->> 'unit' = 'l' then (s ->> 'total')::numeric * 1000
        when s ->> 'unit' = 'ml' then (s ->> 'total')::numeric end), 0) = 2000
     and coalesce(sum(case when s ->> 'unit' = 'cups' then (s ->> 'total')::numeric end), 0) = 3
     and coalesce(sum(case when s ->> 'unit' = 'cups' then (s ->> 'metDays')::integer end), 0) >= 1
   from public.get_habit_insights(tests.i('n-mix'), 30) r, jsonb_array_elements(r -> 'numeric' -> 'periods') p,
     jsonb_array_elements(p -> 'segments') s where p ->> 'kind' = 'month'),
  'Millilitres and litres add up exactly; cups are never mixed with them');
select tests.assert_true(
  (select count(distinct s ->> 'unit') = 3 or count(distinct s ->> 'unit') >= 2
   from public.get_habit_insights(tests.i('n-mix'), 30) r, jsonb_array_elements(r -> 'numeric' -> 'periods') p,
     jsonb_array_elements(p -> 'segments') s where p ->> 'kind' = 'week'),
  'Weeks that span unrelated units are split by unit');
select tests.assert_true(
  (select (x ->> 'target')::numeric = 1000 and x ->> 'unit' = 'ml'
   from jsonb_array_elements(public.get_habit_daily_totals(tests.i('n-mix')) -> 'days') x
   where (x ->> 'onDate')::date = tests.d(-5)),
  'A past day keeps the target and unit of its time');

-- Reminders ---------------------------------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.numeric_habit('n-rem', null, 2000, 'ml', 'preset', array[250]::numeric[]) = 'created', 'A reminder habit');
select tests.assert_true(
  (select outcome = 'saved' from public.set_habit_reminders(tests.i('n-rem'), 0, true, array['08:00']::time[],
    array[1, 2, 3, 4, 5, 6, 7]::smallint[])), 'With a daily reminder');
select tests.assert_true(tests.addo('k30', 'n-rem', 750) = 'added', 'Alice drinks 750 mL');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_habit_reminder(tests.i('n-rem'), 1, now() - interval '1 minute') = 'notified',
  'The reminder for an incomplete day is sent');
select tests.assert_true(
  (select params -> 'progress' ->> 'total' = '750.000' and (params -> 'progress' ->> 'target')::numeric = 2000
     and params -> 'progress' ->> 'unit' = 'ml'
   from public.notifications where user_id = tests.user_id('alice') and kind = 'habit.reminder'
   order by created_at desc limit 1),
  'It carries a point-in-time 750 / 2000 mL snapshot');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome in ('snoozed', 'window_closed') from public.snooze_habit_reminder(tests.notice('alice', 'habit.reminder'), 15)),
  'She snoozes it');
select tests.assert_true(tests.addo('k31', 'n-rem', 1250) = 'added' and (tests.habit('n-rem') ->> 'todayState') = 'completed',
  'She reaches 2000 / 2000');
select tests.assert_true(
  tests.private_count(format('select count(*) from private.habit_reminder_snoozes where habit_id = %L and status = %L',
    tests.i('n-rem'), 'pending')) = 0, 'Reaching the target cancels the pending snooze');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_habit_reminder(tests.i('n-rem'), 1, now()) = 'not_needed', '2000 / 2000: no reminder');
select tests.act_as('alice');
select tests.assert_true(tests.addo('k32', 'n-rem', 250) = 'added', 'She drinks more: 2250 / 2000');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_habit_reminder(tests.i('n-rem'), 1, now()) = 'not_needed', 'Still no reminder');
select tests.act_as('alice');
select tests.assert_true(tests.upd('k31', 'undo') = 'undone' and (tests.habit('n-rem') ->> 'todayState') = 'pending',
  'Undoing 1250 mL brings the day below the target');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_habit_reminder(tests.i('n-rem'), 1, now()) = 'notified',
  'The next reminder moment follows the existing eligibility');

-- Binary habits keep working -------------------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_habit(tests.i('n-per'), null, 'Journal', null, 'daily', null, null,
    tests.d(0), null, 'Europe/Brussels', 'monday')), 'A habit that completes once');
select tests.assert_true(
  (select public.complete_habit(tests.i('k40'), tests.i('n-per'), tests.d(0), null, 'app') ->> 'outcome') = 'completed',
  'It is still completed with one tap');
select tests.assert_true(tests.addo('k41', 'n-per', 1) = 'not_numeric', 'And takes no quantity');
select tests.assert_true(tests.habit('n-per') -> 'tracking' ->> 'mode' = 'once' and tests.habit('n-per') -> 'progress' = 'null'::jsonb,
  'It says it completes once');
