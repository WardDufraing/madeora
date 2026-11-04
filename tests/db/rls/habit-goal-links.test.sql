-- S30c: habit-to-goal links (supabase/migrations/*_habit_goal_links.sql). Alice owns Home A, where Bob
-- is an Administrator (granted manageHomeGoals first, then also manageHomeHabits) and Carol a Member;
-- Bob owns Home B, which Carol is not in. Covers: nothing reachable as a table; who may link (both
-- sides managed, one context only, cross-Home); units (same, converted, incompatible, a later
-- incompatible habit version); the three start choices with their preview, stale confirmation and
-- retries; exact sums, above-target amounts, one entry counted once in each of several goals, two
-- habits into one goal; habit Undo, backdating, a manager's amend and void recomputing; achievement
-- kept explicit and syncing after it; set total and corrections never taking the manual part below 0;
-- unit changes refused while linked; series: current periods, a past period finalized and corrected
-- by a habit correction (explicit achievement kept, needs review), new periods counting; changing the
-- start; unlinking with keep and remove; archived and trashed goals left alone and rebuilt on return;
-- a habit in the trash and purged; personal links and privacy.

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
  'h-run', 'h-walk', 'h-odd', 'h-tmp', 'h-p', 'h-b', 'h-once',
  'g-km', 'g-m', 'g-l', 'g-small', 'g-tmp', 'g-p', 'g-b', 'g-done',
  's-mon', 's-year', 's-old', 's-done',
  'l-1', 'l-2', 'l-3', 'l-4', 'l-5', 'l-6', 'l-7', 'l-8', 'l-9', 'l-10', 'l-11', 'l-12', 'l-13', 'l-14',
  'old-entry'
]) as n;
insert into ids select 'k' || g, gen_random_uuid() from generate_series(1, 60) g;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.month_start(p_on date) returns date
  language sql immutable as $$ select date_trunc('month', p_on::timestamp)::date; $$;
create function tests.grev(p_name text) returns integer
  language sql security definer as $$ select revision from private.goals where id = tests.i(p_name); $$;
create function tests.srev(p_name text) returns integer
  language sql security definer as $$ select revision from private.goal_series where id = tests.i(p_name); $$;
create function tests.lrev(p_name text) returns integer
  language sql security definer as $$ select revision from private.goal_habit_links where id = tests.i(p_name); $$;
create function tests.hrev(p_name text) returns integer
  language sql security definer as $$ select revision from private.habits where id = tests.i(p_name); $$;
-- plpgsql, so every call takes a fresh snapshot.
create function tests.goal(p_goal uuid) returns jsonb
  language plpgsql as $$ begin return public.get_goal(p_goal); end $$;
create function tests.g(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_goal(tests.i(p_name)); end $$;
create function tests.total(p_goal uuid) returns numeric
  language plpgsql security definer as $$
  begin return private.goal_total((select g from private.goals g where g.id = p_goal)); end $$;
create function tests.linked(p_goal uuid) returns numeric
  language plpgsql security definer as $$
  begin return private.goal_linked_total((select g from private.goals g where g.id = p_goal)); end $$;
create function tests.links(p_kind text, p_name text) returns jsonb
  language plpgsql as $$
  begin
    return case p_kind when 'goal' then public.get_goal_links(p_goal_id => tests.i(p_name))
      when 'series' then public.get_goal_links(p_series_id => tests.i(p_name))
      else public.get_goal_links(p_habit_id => tests.i(p_name)) end;
  end $$;
create function tests.link(p_kind text, p_name text, p_link text) returns jsonb
  language plpgsql as $$
  declare v jsonb;
  begin
    select x into v from jsonb_array_elements(tests.links(p_kind, p_name) -> 'links') x where (x ->> 'id')::uuid = tests.i(p_link);
    return v;
  end $$;
create function tests.p(p_sql text) returns boolean
  language plpgsql security definer as $$
  declare v boolean; begin execute p_sql into v; return coalesce(v, false); end $$;
create function tests.n(p_sql text) returns numeric
  language plpgsql security definer as $$
  declare v numeric; begin execute p_sql into v; return v; end $$;
-- The habit's active quantity on the dates from p_from to p_to (inclusive).
create function tests.hsum(p_habit text, p_from date, p_to date) returns numeric
  language sql security definer as $$
  select coalesce(sum(quantity), 0) from private.habit_contributions
  where habit_id = tests.i(p_habit) and status = 'active' and on_date between p_from and p_to; $$;
create function tests.period(p_series text, p_on date) returns uuid
  language plpgsql security definer as $$
  begin return (select id from private.goals where series_id = tests.i(p_series)
    and p_on between period_start and period_end and deleted_at is null); end $$;
-- The ended period of a series (the one before today's).
create function tests.past(p_series text) returns uuid
  language plpgsql security definer as $$
  begin return (select id from private.goals where series_id = tests.i(p_series) and period_end < tests.d(0)); end $$;
create function tests.prev(p_goal uuid) returns integer
  language sql security definer as $$ select revision from private.goals where id = p_goal; $$;
create function tests.trash(p_name text) returns uuid
  language sql security definer as $$
  select id from private.trash_entries where subject_id = tests.i(p_name) and status = 'trashed' limit 1; $$;
create function tests.add(p_id text, p_habit text, p_qty numeric, p_on date default null) returns text
  language sql as $$
  select public.add_habit_contribution(tests.i(p_id), tests.i(p_habit), p_qty, p_on, null, 'app', null) ->> 'outcome'; $$;
create function tests.upd(p_id text, p_action text, p_qty numeric default null) returns text
  language sql as $$ select public.update_habit_contribution(tests.i(p_id), p_action, p_qty, null) ->> 'outcome'; $$;
create function tests.numeric_habit(p_name text, p_home text, p_unit text) returns text
  language sql as $$
  select outcome from public.create_habit(tests.i(p_name), case when p_home is null then null else tests.i(p_home) end,
    initcap(substr(p_name, 3)), null, 'daily', null, null, tests.d(-7), null,
    case when p_home is null then 'Europe/Brussels' end, 'monday', 5, p_unit, 'preset', null); $$;
-- Moves a habit's start (and its first schedule and tracking) back (setup only).
create function tests.backdate(p_name text, p_starts_on date) returns void
  language plpgsql security definer as $$
  begin
    update private.habit_periods set starts_on = p_starts_on where habit_id = tests.i(p_name);
    update private.habit_schedules set effective_on = p_starts_on where habit_id = tests.i(p_name);
    update private.habit_tracking set effective_on = p_starts_on where habit_id = tests.i(p_name);
  end $$;
-- A contribution older than the seven-day entry window (setup only).
create function tests.old(p_id text, p_habit text, p_qty numeric, p_on date, p_by text) returns void
  language plpgsql security definer as $$
  begin
    insert into private.habit_contributions (id, habit_id, on_date, quantity, contributed_by, source)
      values (tests.i(p_id), tests.i(p_habit), p_on, p_qty, tests.user_id(p_by), 'app');
  end $$;
create function tests.goal_new(p_name text, p_home text, p_target numeric, p_unit text, p_initial numeric default null,
  p_kind text default 'measurable') returns text
  language sql as $$
  select outcome from public.create_goal(tests.i(p_name), case when p_home is null then null else tests.i(p_home) end,
    p_kind, initcap(substr(p_name, 3)), null, p_target, p_unit, case when p_unit is null then null else 'preset' end,
    p_initial, null, case when p_home is null then 'Europe/Brussels' end, null); $$;
create function tests.series_new(p_name text, p_home text, p_frequency text, p_target numeric, p_unit text) returns text
  language sql as $$
  select public.create_goal_series(tests.i(p_name), tests.i(p_home), 'measurable', p_frequency, initcap(substr(p_name, 3)),
    null, p_target, p_unit, 'preset', 'monday', tests.d(0), null, null, null, null, false) ->> 'outcome'; $$;
-- Links (preview or confirm with what the preview showed). p_dest: 'g-…' a goal, 's-…' a series.
create function tests.mk(p_link text, p_habit text, p_dest text, p_start text default 'beginning',
  p_date date default null, p_dry boolean default false, p_amount numeric default null, p_rev integer default null)
returns jsonb
  language plpgsql as $$
  declare
    v_goal uuid := case when p_dest like 'g-%' then tests.i(p_dest) end;
    v_series uuid := case when p_dest like 's-%' then tests.i(p_dest) end;
    v_preview jsonb;
  begin
    if p_dry then
      return public.create_goal_link(tests.i(p_link), tests.i(p_habit), v_goal, v_series, p_start, p_date, true);
    end if;
    v_preview := public.create_goal_link(tests.i(p_link), tests.i(p_habit), v_goal, v_series, p_start, p_date, true);
    if v_preview ->> 'outcome' <> 'preview' and p_amount is null and p_rev is null then
      return v_preview;
    end if;
    return public.create_goal_link(tests.i(p_link), tests.i(p_habit), v_goal, v_series, p_start, p_date, false,
      coalesce(p_rev, (v_preview ->> 'revision')::integer),
      coalesce(p_amount, (v_preview -> 'impact' ->> 'amountAfter')::numeric));
  end $$;
-- Previews a link, adds manual progress, then confirms with the preview's numbers; rolled back.
create function tests.mk_after_manual(p_link text, p_habit text, p_goal text, p_quantity numeric) returns text
  language plpgsql as $$
  declare v_preview jsonb;
  begin
    begin
      v_preview := public.create_goal_link(tests.i(p_link), tests.i(p_habit), tests.i(p_goal), null, 'beginning',
        null, true);
      perform public.add_goal_entry(gen_random_uuid(), tests.i(p_goal), 'add', p_quantity);
      raise exception using errcode = 'P0001', message = public.create_goal_link(tests.i(p_link), tests.i(p_habit),
        tests.i(p_goal), null, 'beginning', null, false, (v_preview ->> 'revision')::integer,
        (v_preview -> 'impact' ->> 'amountAfter')::numeric) ->> 'outcome';
    exception when sqlstate 'P0001' then
      return sqlerrm;
    end;
  end $$;
create function tests.mko(p_link text, p_habit text, p_dest text, p_start text default 'beginning', p_date date default null)
returns text
  language sql as $$ select tests.mk(p_link, p_habit, p_dest, p_start, p_date) ->> 'outcome'; $$;
create function tests.unlink(p_link text, p_mode text) returns jsonb
  language plpgsql as $$
  declare v_preview jsonb := public.remove_goal_link(tests.i(p_link), p_mode, true);
  begin
    if v_preview ->> 'outcome' <> 'preview' then
      return v_preview;
    end if;
    return public.remove_goal_link(tests.i(p_link), p_mode, false, (v_preview ->> 'revision')::integer,
      (v_preview -> 'impact' ->> 'amountBefore')::numeric);
  end $$;
create function tests.restart(p_link text, p_start text, p_date date default null) returns jsonb
  language plpgsql as $$
  declare v_preview jsonb := public.change_goal_link_start(tests.i(p_link), p_start, p_date, true);
  begin
    if v_preview ->> 'outcome' <> 'preview' then
      return v_preview;
    end if;
    return public.change_goal_link_start(tests.i(p_link), p_start, p_date, false, (v_preview ->> 'revision')::integer,
      (v_preview -> 'impact' ->> 'amountAfter')::numeric);
  end $$;

grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing as a table -----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.goal_habit_links', 'The API cannot read links');
select tests.assert_denied('select * from private.goal_link_days', 'Nor the linked ledger');
select tests.assert_denied($$select private.goal_link_refresh(gen_random_uuid())$$, 'Nor the recompute');
select tests.assert_denied($$select private.add_goal_entry_before_links(null, null, null, null)$$,
  'Nor the moved S30 function');
select tests.assert_denied($$select private.habit_numeric_sync_before_links(null, null, null, null)$$,
  'Nor the moved S29 sync');
select tests.act_as_anon();
select tests.assert_denied($$select public.get_goal_links(gen_random_uuid())$$, 'Nobody signed out reads links');
select tests.assert_denied($$select public.create_goal_link(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())$$,
  'Nor creates them');

-- Units --------------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(private.goal_link_convert(2.5, 'km', 'preset', 'm', 'preset') = 2500, 'km become m exactly');
select tests.assert_true(private.goal_link_convert(1234.5675, 'm', 'preset', 'km', 'preset') = 1.235,
  'm become km rounded half up to three decimals');
select tests.assert_true(private.goal_link_convert(90, 'min', 'preset', 'h', 'preset') = 1.5, 'min become h');
select tests.assert_true(private.goal_link_convert(3, 'pages', 'preset', 'pages', 'preset') = 3, 'The same unit as is');
select tests.assert_true(private.goal_link_convert(3, 'laps', 'custom', 'laps', 'custom') = 3, 'The same custom label as is');
select tests.assert_true(private.goal_link_convert(3, 'laps', 'custom', 'rounds', 'custom') is null, 'Another custom label never');
select tests.assert_true(private.goal_link_convert(3, 'km', 'preset', 'l', 'preset') is null, 'Another dimension never');
select tests.assert_true(private.goal_link_convert(3, 'km', 'custom', 'km', 'preset') is null,
  'A custom label that looks like a preset is not one');

-- Fixtures -----------------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeGoals']);
select tests.assert_true(tests.numeric_habit('h-run', 'home-a', 'km') = 'created', 'Alice creates a Home km habit');
select tests.assert_true(tests.numeric_habit('h-walk', 'home-a', 'km') = 'created', 'And a second one');
select tests.assert_true(tests.numeric_habit('h-p', null, 'km') = 'created', 'And a personal one');
select tests.assert_true(tests.goal_new('g-km', 'home-a', 100, 'km', 5) = 'created', 'A Home goal of 100 km starting at 5');
select tests.assert_true(tests.goal_new('g-m', 'home-a', 50000, 'm') = 'created', 'A goal in m');
select tests.assert_true(tests.goal_new('g-l', 'home-a', 10, 'l') = 'created', 'A goal in l');
select tests.assert_true(tests.goal_new('g-small', 'home-a', 10, 'km') = 'created', 'A goal of 10 km');
select tests.assert_true(tests.goal_new('g-p', null, 100, 'km') = 'created', 'A personal goal');
select tests.assert_true(tests.goal_new('g-done', 'home-a', null, null, null, 'completion') = 'created', 'A completion goal');
select tests.act_as_owner();
select tests.backdate('h-run', tests.d(-40));
select tests.old('old-entry', 'h-run', 10, tests.d(-20), 'alice');
select tests.act_as('alice');
select tests.assert_true(tests.add('k1', 'h-run', 2.5, tests.d(-3)) = 'added', 'Backdated progress');
select tests.assert_true(tests.add('k2', 'h-run', 3, tests.d(-1)) = 'added', 'Yesterday');
select tests.assert_true(tests.add('k3', 'h-run', 1.5) = 'added', 'Today, before any link');
select tests.act_as('carol');
select tests.assert_true(tests.add('k4', 'h-run', 2.5) = 'added', 'Carol adds today too');

-- Who may link -------------------------------------------------------------------------------------------

select tests.assert_true(tests.mko('l-1', 'h-run', 'g-km') = 'not_permitted', 'A member cannot link');
select tests.assert_true(tests.links('goal', 'g-km') -> 'links' = '[]'::jsonb, 'Nor did anything happen');
select tests.assert_true(public.get_goal_link_candidates(tests.i('g-km')) -> 'habits' = '[]'::jsonb,
  'A member is offered no habits');
select tests.act_as('bob');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-km') = 'not_permitted',
  'An Administrator with manageHomeGoals alone cannot link a habit they do not manage');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-b') = 'not_found', 'Nor to a goal that does not exist');
select tests.act_as('alice');
select tests.assert_true(tests.mko('l-1', 'h-p', 'g-km') = 'other_context', 'A personal habit never counts for a Home goal');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-p') = 'other_context', 'Nor a Home habit for a personal goal');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-l') = 'incompatible_unit', 'km never count as l');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-done') = 'not_measurable', 'A completion goal has no quantity');
select tests.assert_true(
  (select array_agg(x ->> 'id' order by x ->> 'name') from jsonb_array_elements(
    public.get_goal_link_candidates(tests.i('g-km')) -> 'habits') x)
  = array[tests.i('h-run')::text, tests.i('h-walk')::text],
  'The candidates are the Home''s km habits Alice manages');
select tests.assert_true(public.get_goal_link_candidates(tests.i('g-l')) -> 'habits' = '[]'::jsonb,
  'No habit is offered for a goal in l');
select tests.act_as('bob');
select tests.assert_true(tests.goal_new('g-b', 'home-b', 10, 'km') = 'created', 'Bob has a goal in Home B');
select tests.act_as('alice');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-b') = 'not_found', 'Alice cannot reach Home B');
select tests.assert_true(public.get_goal_link_candidates(tests.i('g-b')) is null, 'Nor list its candidates');

-- Start choices and preview --------------------------------------------------------------------------------

select tests.assert_true((tests.mk('l-1', 'h-run', 'g-km', 'today', null, true) -> 'impact' ->> 'amountAfter')::numeric = 4,
  'From today counts what was entered earlier today (1.5 + 2.5)');
select tests.assert_true((tests.mk('l-1', 'h-run', 'g-km', 'date', tests.d(-3), true) -> 'impact' ->> 'amountAfter')::numeric
  = 9.5, 'From a date counts that day on (2.5 + 3 + 4)');
select tests.assert_true((tests.mk('l-1', 'h-run', 'g-km', 'date', tests.d(-2), true) -> 'impact' ->> 'amountAfter')::numeric
  = 7, 'A date between entries starts there');
select tests.assert_true(tests.mk('l-1', 'h-run', 'g-km', 'date', tests.d(-41), true) ->> 'outcome' = 'invalid_start',
  'Not before the habit started');
select tests.assert_true(tests.mk('l-1', 'h-run', 'g-km', 'date', tests.d(1), true) ->> 'outcome' = 'invalid_start',
  'Nor after today');
select tests.assert_denied($$select public.create_goal_link(tests.i('l-1'), tests.i('h-run'), tests.i('g-km'), null, 'date')$$,
  'A chosen date needs the date', '22023');
select tests.assert_denied($$select public.create_goal_link(tests.i('l-1'), tests.i('h-run'), tests.i('g-km'), tests.i('s-mon'))$$,
  'One destination only', '22023');
select tests.assert_true((select
    (x -> 'impact' ->> 'amountAfter')::numeric = 19.5
    and (x -> 'impact' ->> 'startsOn')::date = tests.d(-40)
    and (x -> 'impact' -> 'goals' -> 0 ->> 'totalBefore')::numeric = 5
    and (x -> 'impact' -> 'goals' -> 0 ->> 'totalAfter')::numeric = 24.5
    and (x -> 'impact' -> 'goals' -> 0 ->> 'manualTotal')::numeric = 5
    and (x -> 'impact' -> 'goals' -> 0 ->> 'reachedAfter')::boolean = false
    and x -> 'impact' -> 'habit' ->> 'unit' = 'km'
    and x -> 'impact' -> 'destination' ->> 'unit' = 'km'
    and x ->> 'outcome' = 'preview'
  from (select tests.mk('l-1', 'h-run', 'g-km', 'beginning', null, true) as x) y),
  'From the beginning includes older history outside the seven-day entry window (10 + 9.5), on top of the 5 manual');
select tests.assert_true(tests.p($$select not exists (select 1 from private.goal_habit_links)$$), 'A preview links nothing');
select tests.assert_true(tests.mk('l-1', 'h-run', 'g-km', 'beginning', null, false, 18) ->> 'outcome' = 'stale',
  'A confirmation with another amount than the preview is stale');
select tests.assert_true(tests.mk('l-1', 'h-run', 'g-km', 'beginning', null, false, null, tests.grev('g-km') + 1) ->> 'outcome'
  = 'stale', 'So is one with another revision');
select tests.assert_true(tests.mk_after_manual('l-1', 'h-run', 'g-km', 80) = 'stale',
  'And one after manual progress changed what the preview showed (total, reached)');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-km') = 'created', 'Alice links Run to the goal from the beginning');
select tests.assert_true(tests.total(tests.i('g-km')) = 24.5 and tests.linked(tests.i('g-km')) = 19.5,
  'The total is the manual 5 plus 19.5 from the habit');
select tests.assert_true((select (x ->> 'manualTotal')::numeric = 5 and (x ->> 'linkedTotal')::numeric = 19.5
    and (x ->> 'total')::numeric = 24.5 and (x ->> 'linkCount')::integer = 1 and x ->> 'achievedAt' is null
  from (select tests.g('g-km') as x) y), 'The goal shows the breakdown');
select tests.assert_true(tests.mko('l-1', 'h-run', 'g-km') = 'exists', 'A retry is harmless');
select tests.assert_true(tests.total(tests.i('g-km')) = 24.5, 'And counts nothing twice');
select tests.assert_true(tests.mko('l-2', 'h-run', 'g-km') = 'already_linked', 'A second link to the same goal is refused');
select tests.assert_true(tests.p($$select count(*) = 1 from private.goal_events
  where goal_id = tests.i('g-km') and kind = 'link_created'$$), 'The goal''s history records the link once');
select tests.assert_true(tests.p($$select count(*) = 1 from private.audit_events
  where action = 'goal.link_created' and subject_id = tests.i('g-km')$$),
  'And the Home audit');

-- One entry, several goals; two habits, one goal -------------------------------------------------------------

select tests.assert_true(tests.mko('l-2', 'h-run', 'g-m') = 'created', 'Run also counts for the goal in m');
select tests.assert_true(tests.total(tests.i('g-m')) = 19500, 'Converted exactly into m');
select tests.act_as('carol');
select tests.assert_true(tests.add('k5', 'h-run', 1.25) = 'added', 'Carol runs 1.25 km more today');
select tests.assert_true(tests.total(tests.i('g-km')) = 25.75 and tests.total(tests.i('g-m')) = 20750,
  'One entry counts exactly once in each goal');
select tests.assert_true(tests.add('k5', 'h-run', 1.25) = 'exists' and tests.total(tests.i('g-km')) = 25.75,
  'An offline retry of the same entry changes nothing');
select tests.assert_true((select (x ->> 'amount')::numeric = 20.75 and x -> 'actions' ->> 'manage' = 'false'
    and x -> 'habit' ->> 'name' = 'Run' and x ->> 'source' = 'active' and not (x ? 'contributors')
  from (select tests.link('goal', 'g-km', 'l-1') as x) y), 'A member sees the link and its amount, without managing it');
select tests.assert_true(jsonb_array_length(tests.links('habit', 'h-run') -> 'links') = 2,
  'The habit lists its two linked goals');
select tests.act_as('alice');
select tests.assert_true(tests.add('k6', 'h-walk', 3) = 'added', 'Alice walks 3 km');
select tests.assert_true(tests.mko('l-3', 'h-walk', 'g-km', 'today') = 'created', 'Walk counts for the same goal from today');
select tests.assert_true(tests.total(tests.i('g-km')) = 28.75, 'Two habits add up in one goal');

-- Habit changes recompute ----------------------------------------------------------------------------------

select tests.assert_true(tests.upd('k3', 'undo') = 'undone', 'Alice undoes her 1.5 km');
select tests.assert_true(tests.total(tests.i('g-km')) = 27.25 and tests.total(tests.i('g-m')) = 19250,
  'Undo leaves both goals');
select tests.assert_true(tests.add('k7', 'h-run', 4, tests.d(-6)) = 'added', 'Backdated six days');
select tests.assert_true(tests.total(tests.i('g-km')) = 31.25, 'Backdating reaches the goal');
select tests.assert_true(tests.upd('old-entry', 'amend', 12) = 'corrected', 'Alice corrects the old 10 km to 12');
select tests.assert_true(tests.total(tests.i('g-km')) = 33.25 and tests.total(tests.i('g-m')) = 25250,
  'A correction outside the entry window recomputes too');
select tests.assert_true(tests.upd('k1', 'void') = 'corrected', 'Alice voids the 2.5 km');
select tests.assert_true(tests.total(tests.i('g-km')) = 30.75, 'Voided progress leaves the goal');
select tests.assert_true(tests.p($$select manual = 5 from (select sum(quantity) as manual from private.goal_entries
  where goal_id = tests.i('g-km') and status = 'active') x$$), 'The manual part never moved');
select tests.assert_true(tests.p($$select count(*) = 0 from private.goal_entries where source = 'link'$$),
  'Linked amounts are never written as entries');

-- Manual part, units ----------------------------------------------------------------------------------------

select tests.assert_true(public.add_goal_entry(tests.i('k8'), tests.i('g-km'), 'total', 20, null, 'app', 30.75) ->> 'outcome'
  = 'below_linked', 'Set total never goes below what the habits count');
select tests.assert_true(public.add_goal_entry(tests.i('k8'), tests.i('g-km'), 'total', 35.75, null, 'app', 30.75) ->> 'outcome'
  = 'adjusted', 'Above it, the manual part changes (5 → 10)');
select tests.assert_true(tests.total(tests.i('g-km')) = 35.75 and (tests.g('g-km') ->> 'manualTotal')::numeric = 10,
  'Manual 10, linked 25.75');
select tests.assert_true(public.update_goal_entry(tests.i('k8'), 'amend', -6) ->> 'outcome' = 'negative_total',
  'A correction cannot take the manual part below 0, even though the habits keep the total above it');
select tests.assert_true(public.update_goal_entry(tests.i('k8'), 'amend', -5) ->> 'outcome' = 'corrected',
  'Down to 0 is fine');
select tests.assert_true(public.change_goal_target(tests.i('g-km'), tests.grev('g-km'), 100, 'm', 'preset', false, true, true)
  ->> 'outcome' = 'linked_unit', 'A linked goal keeps its unit');
select tests.assert_true(public.change_goal_target(tests.i('g-km'), tests.grev('g-km'), 120, 'km', 'preset', false, true, true)
  ->> 'outcome' = 'saved', 'Its target may change');
select tests.assert_true(tests.total(tests.i('g-km')) = 25.75, 'Which leaves the quantities alone');

-- A later incompatible habit unit --------------------------------------------------------------------------

select tests.assert_true(tests.numeric_habit('h-odd', 'home-a', 'km') = 'created', 'Another km habit');
select tests.act_as_owner();
update private.habit_tracking set effective_on = tests.d(-10) where habit_id = tests.i('h-odd');
update private.habit_periods set starts_on = tests.d(-10) where habit_id = tests.i('h-odd');
update private.habit_schedules set effective_on = tests.d(-10) where habit_id = tests.i('h-odd');
insert into private.habit_tracking (habit_id, effective_on, mode, target, unit, unit_kind)
  values (tests.i('h-odd'), tests.d(-2), 'numeric', 500, 'ml', 'preset'), (tests.i('h-odd'), tests.d(0), 'numeric', 5, 'km', 'preset');
select tests.act_as('alice');
select tests.assert_true(tests.add('k9', 'h-odd', 250, tests.d(-2)) = 'added', 'A day recorded in ml');
select tests.assert_true(tests.add('k10', 'h-odd', 2) = 'added', 'And 2 km today');
select tests.assert_true(tests.goal_new('g-tmp', 'home-a', 10, 'km') = 'created', 'A fresh km goal');
select tests.assert_true((select (x -> 'impact' ->> 'amountAfter')::numeric = 2 and (x -> 'impact' ->> 'uncountedDays')::integer = 1
  from (select tests.mk('l-4', 'h-odd', 'g-tmp', 'beginning', null, true) as x) y),
  'The preview counts the km day and shows the ml day that cannot count');
select tests.assert_true(tests.mko('l-4', 'h-odd', 'g-tmp') = 'created', 'Linked anyway');
select tests.assert_true((select (x ->> 'amount')::numeric = 2 and (x ->> 'uncountedDays')::integer = 1
  from (select tests.link('goal', 'g-tmp', 'l-4') as x) y), 'The link warns about the day that does not count');

-- Achievement ------------------------------------------------------------------------------------------------

select tests.assert_true(tests.mko('l-5', 'h-walk', 'g-small', 'today') = 'created', 'Walk counts for 10 km from today');
select tests.assert_true(tests.add('k11', 'h-walk', 8) = 'added' and tests.total(tests.i('g-small')) = 11,
  'Walk reaches 11 of 10 km');
select tests.assert_true((select x ->> 'achievedAt' is null and (x ->> 'reached')::boolean and x ->> 'status' = 'active'
  from (select tests.g('g-small') as x) y), 'Reaching the target never marks it achieved');
select tests.assert_true(public.set_goal_achievement(tests.i('g-small'), tests.grev('g-small'), true) ->> 'outcome' = 'achieved',
  'Alice marks it achieved');
select tests.assert_true(tests.add('k12', 'h-walk', 1.5) = 'added' and tests.total(tests.i('g-small')) = 12.5,
  'An achieved goal keeps counting above its target');
select tests.assert_true(tests.upd('k11', 'undo') = 'undone' and tests.total(tests.i('g-small')) = 4.5,
  'Undo takes it below the target');
select tests.assert_true((select x ->> 'achievedAt' is not null from (select tests.g('g-small') as x) y)
  and tests.p($$select count(*) = 1 from private.goal_achievements where goal_id = tests.i('g-small') and reopened_at is null$$)
  and tests.p($$select count(*) = 1 from private.goal_events where goal_id = tests.i('g-small') and kind = 'achieved'$$),
  'Without revoking the achievement or recording another one');

-- Series -----------------------------------------------------------------------------------------------------

select tests.assert_true(tests.series_new('s-mon', 'home-a', 'monthly', 100, 'km') = 'created', 'A monthly km series');
select tests.assert_true(tests.series_new('s-year', 'home-a', 'yearly', 1000, 'km') = 'created', 'A yearly one');
select tests.assert_true(tests.mko('l-6', 'h-run', 's-mon') = 'created', 'Run counts for the monthly series');
select tests.assert_true(tests.mko('l-7', 'h-run', 's-year', 'date', tests.d(-6)) = 'created',
  'And for the yearly one from six days ago');
select tests.assert_true(tests.total(tests.period('s-mon', tests.d(0))) = tests.hsum('h-run', tests.month_start(tests.d(0)), tests.d(0)),
  'The current month counts only its own days');
select tests.assert_true(tests.total(tests.period('s-year', tests.d(0)))
  = tests.hsum('h-run', greatest(tests.d(-6), date_trunc('year', tests.d(0)::timestamp)::date), tests.d(0)),
  'The current year counts from the link''s start');
select tests.act_as('carol');
select tests.assert_true(tests.add('k13', 'h-run', 2) = 'added', 'Carol runs 2 km');
select tests.assert_true(tests.total(tests.period('s-mon', tests.d(0)))
    = tests.hsum('h-run', tests.month_start(tests.d(0)), tests.d(0))
  and tests.total(tests.period('s-year', tests.d(0)))
    = tests.hsum('h-run', greatest(tests.d(-6), date_trunc('year', tests.d(0)::timestamp)::date), tests.d(0))
  and tests.total(tests.i('g-m')) = 1000 * tests.hsum('h-run', tests.d(-40), tests.d(0)),
  'One entry counts once in the month, once in the year and once in the m goal');
select tests.act_as('alice');
select tests.assert_true(public.change_goal_series_target(tests.i('s-mon'), tests.srev('s-mon'), tests.month_start(tests.d(40)),
  100, 'm', 'preset') ->> 'outcome' = 'linked_unit', 'A linked series keeps its unit');
select tests.assert_true(public.create_goal_link(tests.i('l-8'), tests.i('h-run'), tests.period('s-mon', tests.d(0)), p_dry_run => true)
  ->> 'outcome' = 'series_period', 'A single period is linked through its series');

-- A past period, finalized and then corrected through the habit ------------------------------------------------

select tests.assert_true(tests.series_new('s-old', 'home-a', 'monthly', 25, 'km') = 'created', 'A monthly 25 km series');
select tests.act_as_owner();
-- Its first period becomes last month (ended); the habit got 30 km there, outside the entry window.
update private.goals set period_start = tests.month_start(tests.month_start(tests.d(0)) - 1),
    period_end = tests.month_start(tests.d(0)) - 1, deadline = tests.month_start(tests.d(0)) - 1
  where series_id = tests.i('s-old');
update private.goal_series set first_period_start = tests.month_start(tests.month_start(tests.d(0)) - 1) where id = tests.i('s-old');
update private.goal_series_targets set effective_from = tests.month_start(tests.month_start(tests.d(0)) - 1)
  where series_id = tests.i('s-old');
select private.roll_goal_series(tests.i('s-old'), now());
select tests.old('k14', 'h-run', 30, tests.month_start(tests.d(0)) - 5, 'alice');
select tests.act_as('alice');
select tests.assert_true(tests.p($$select outcome = 'not_reached' and finalized_at is not null from private.goals
  where series_id = tests.i('s-old') and period_end < tests.d(0)$$), 'Last month closed not reached');
select tests.assert_true((select
    exists (select 1 from jsonb_array_elements(x -> 'impact' -> 'goals') g where (g ->> 'ended')::boolean
      and (g ->> 'linkedAfter')::numeric >= 30 and g ->> 'outcomeBefore' = 'not_reached' and (g ->> 'reachedAfter')::boolean
      and g ->> 'outcomeAfter' = 'reached')
    and exists (select 1 from jsonb_array_elements(x -> 'impact' -> 'goals') g where not (g ->> 'ended')::boolean)
  from (select tests.mk('l-9', 'h-run', 's-old', 'beginning', null, true) as x) y),
  'The preview shows the ended period that would reach its target, and the current one');
select tests.assert_true(tests.mko('l-9', 'h-run', 's-old') = 'created', 'Alice links it from the beginning');
select tests.assert_true(tests.p($$select outcome = 'reached' and outcome_corrected_at is not null from private.goals
  where series_id = tests.i('s-old') and period_end < tests.d(0)$$), 'Last month''s result is corrected to reached');
select tests.assert_true(tests.p($$select count(*) = 1 from private.goal_events e join private.goals g on g.id = e.goal_id
  where g.series_id = tests.i('s-old') and g.period_end < tests.d(0) and e.kind = 'outcome_changed' and e.actor is null$$),
  'Recorded once, naming nobody');
select tests.assert_true(public.set_goal_achievement(tests.past('s-old'), tests.prev(tests.past('s-old')), true)
  ->> 'outcome' = 'achieved', 'Alice marks last month achieved');
select tests.assert_true(tests.upd('k14', 'void') = 'corrected', 'Then voids the 30 km run');
select tests.assert_true(tests.p($$select outcome = 'not_reached' and achieved_at is not null from private.goals
  where series_id = tests.i('s-old') and period_end < tests.d(0)$$)
  and (select (x -> 'period' ->> 'needsReview')::boolean from (select tests.goal(tests.past('s-old')) as x) y),
  'The habit correction recalculates last month alone: not reached, the achievement kept for review');
select tests.assert_true(tests.total(tests.period('s-old', tests.d(0))) = tests.hsum('h-run', tests.month_start(tests.d(0)), tests.d(0)),
  'Nothing moved into the current month');

-- A new period counts its series' links ------------------------------------------------------------------------

select tests.act_as_owner();
delete from private.goals where series_id = tests.i('s-mon') and period_start = tests.month_start(tests.d(0));
update private.goal_series set next_roll_at = now() - interval '1 minute' where id = tests.i('s-mon');
select tests.act_as('alice');
select public.sync_goal_periods(tests.i('home-a'));
select tests.assert_true(tests.total(tests.period('s-mon', tests.d(0))) = tests.hsum('h-run', tests.month_start(tests.d(0)), tests.d(0)),
  'A period created later counts the days already recorded in it');

-- Changing the start ---------------------------------------------------------------------------------------------

select tests.assert_true((select (x -> 'impact' ->> 'amountBefore')::numeric
      = tests.n($$select sum(quantity) from private.goal_link_days where link_id = tests.i('l-1')$$)
    and (x -> 'impact' ->> 'amountAfter')::numeric = tests.hsum('h-run', tests.d(0), tests.d(0))
    and (x -> 'impact' ->> 'startsOnBefore')::date = tests.d(-40)
  from (select public.change_goal_link_start(tests.i('l-1'), 'today', null, true) as x) y),
  'The preview shows what moving the start to today leaves');
select tests.assert_true(public.change_goal_link_start(tests.i('l-1'), 'today', null, false, tests.lrev('l-1'), 1)
  ->> 'outcome' = 'stale', 'A stale amount is refused');
select tests.assert_true(tests.restart('l-1', 'today') ->> 'outcome' = 'saved', 'Alice moves it');
select tests.assert_true(tests.linked(tests.i('g-km')) = tests.hsum('h-run', tests.d(0), tests.d(0)) + tests.hsum('h-walk', tests.d(0), tests.d(0)),
  'Only today''s runs (and the walk) count now');
select tests.assert_true(tests.total(tests.i('g-m')) = 1000 * tests.hsum('h-run', tests.d(-40), tests.d(0)),
  'The other link is untouched');
select tests.assert_true(tests.restart('l-1', 'today') ->> 'outcome' = 'unchanged', 'The same start again changes nothing');

-- Unlinking --------------------------------------------------------------------------------------------------------

select tests.assert_true((select (x -> 'impact' ->> 'amountBefore')::numeric = tests.total(tests.i('g-m'))
    and (x -> 'impact' -> 'goals' -> 0 ->> 'totalAfter')::numeric = tests.total(tests.i('g-m'))
  from (select public.remove_goal_link(tests.i('l-2'), 'keep', true) as x) y), 'Keeping changes no total');
select tests.assert_true(tests.unlink('l-2', 'keep') ->> 'outcome' = 'removed', 'Alice unlinks the m goal, keeping the amount');
select tests.assert_true(tests.linked(tests.i('g-m')) = 0
  and tests.total(tests.i('g-m')) = 1000 * tests.hsum('h-run', tests.d(-40), tests.d(0))
  and tests.p($$select count(*) = 1 from private.goal_entries where goal_id = tests.i('g-m') and source = 'link'
    and kind = 'adjustment'$$), 'The amount became one manual adjustment');
select tests.assert_true(tests.add('k15', 'h-run', 1) = 'added'
  and tests.total(tests.i('g-m')) = 1000 * (tests.hsum('h-run', tests.d(-40), tests.d(0)) - 1),
  'Later runs no longer reach it');
select tests.assert_true(tests.mko('l-10', 'h-run', 'g-m', 'today') = 'created', 'It can be linked again');
select tests.assert_true(tests.unlink('l-10', 'remove') ->> 'outcome' = 'removed', 'And removed with its amount');
select tests.assert_true(tests.linked(tests.i('g-m')) = 0
  and tests.total(tests.i('g-m')) = 1000 * (tests.hsum('h-run', tests.d(-40), tests.d(0)) - 1), 'Removing takes the amount out');
select tests.assert_true(tests.unlink('l-6', 'remove') ->> 'outcome' = 'removed', 'Alice removes the monthly link');
select tests.assert_true(tests.total(tests.period('s-mon', tests.d(0))) = 0
  and tests.total(tests.period('s-year', tests.d(0)))
    = tests.hsum('h-run', greatest(tests.d(-6), date_trunc('year', tests.d(0)::timestamp)::date), tests.d(0)),
  'The month loses it; the year keeps its own link');
select tests.assert_true(tests.unlink('l-6', 'remove') ->> 'outcome' = 'not_found', 'A removed link is gone');
select tests.assert_true(tests.p($$select count(*) = 1 from private.goal_series_events where series_id = tests.i('s-mon')
  and kind = 'link_removed'$$), 'The series records it');

-- Archived and trashed goals ---------------------------------------------------------------------------------------

select tests.assert_true((select outcome from public.archive_goal(tests.i('g-km'), tests.grev('g-km'), true)) = 'saved',
  'Alice archives the km goal');
select tests.assert_true(tests.add('k16', 'h-run', 5) = 'added', 'And runs 5 km');
select tests.assert_true(tests.linked(tests.i('g-km')) = tests.hsum('h-run', tests.d(0), tests.d(0)) - 5 + tests.hsum('h-walk', tests.d(0), tests.d(0)),
  'An archived goal is left alone');
select tests.assert_true((select outcome from public.archive_goal(tests.i('g-km'), tests.grev('g-km'), false)) = 'saved',
  'She unarchives it');
select tests.assert_true(tests.linked(tests.i('g-km')) = tests.hsum('h-run', tests.d(0), tests.d(0)) + tests.hsum('h-walk', tests.d(0), tests.d(0)),
  'Which catches up with the habit');
select tests.assert_true((select outcome from public.delete_goal(tests.i('g-tmp'), tests.grev('g-tmp'))) = 'deleted',
  'Alice deletes the fresh goal');
select tests.assert_true(tests.add('k17', 'h-odd', 1) = 'added', 'Then adds 1 km to its habit');
select tests.assert_true(tests.linked(tests.i('g-tmp')) = 2, 'A goal in the trash is left alone');
select tests.assert_true((select outcome from public.restore_trash_entries(array[
    tests.trash('g-tmp')])) = 'restored', 'She restores it');
select tests.assert_true(tests.linked(tests.i('g-tmp')) = 3, 'And it catches up');

-- A habit in the trash and purged ----------------------------------------------------------------------------------

select tests.assert_true((select outcome from public.delete_habit(tests.i('h-odd'), tests.hrev('h-odd'))) = 'deleted',
  'Alice deletes the habit');
select tests.assert_true((select x ->> 'source' = 'trash' and (x ->> 'amount')::numeric = 3
  from (select tests.link('goal', 'g-tmp', 'l-4') as x) y), 'Its link keeps the amount and shows the habit in the trash');
select tests.assert_true(public.change_goal_link_start(tests.i('l-4'), 'today', null, true) ->> 'outcome' = 'source_unavailable',
  'Its start cannot change');
select tests.assert_true((select outcome from public.purge_trash_entries(array[
    tests.trash('h-odd')])) = 'purged', 'She purges it');
select tests.assert_true((select x ->> 'source' = 'deleted' and x -> 'habit' = 'null'::jsonb and (x ->> 'amount')::numeric = 3
  from (select tests.link('goal', 'g-tmp', 'l-4') as x) y) and tests.total(tests.i('g-tmp')) = 3,
  'The link stays frozen with its amount');
select tests.assert_true(tests.unlink('l-4', 'keep') ->> 'outcome' = 'removed' and tests.total(tests.i('g-tmp')) = 3
  and tests.linked(tests.i('g-tmp')) = 0, 'A goal manager keeps it as a manual adjustment');

-- Bob once he also manages habits ----------------------------------------------------------------------------------

select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeGoals', 'manageHomeHabits']);
select tests.act_as('bob');
select tests.assert_true(tests.link('goal', 'g-small', 'l-5') -> 'actions' ->> 'manage' = 'true', 'Bob may now manage links');
select tests.assert_true(tests.unlink('l-5', 'remove') ->> 'outcome' = 'removed', 'And removes one');
select tests.act_as('carol');
select tests.assert_true(tests.unlink('l-3', 'remove') ->> 'outcome' = 'not_permitted', 'Carol cannot');
select tests.assert_true(tests.restart('l-3', 'beginning') ->> 'outcome' = 'not_permitted', 'Nor change a start');

-- Personal links and privacy -----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(tests.add('k18', 'h-p', 6) = 'added', 'Alice runs alone');
select tests.assert_true(tests.mko('l-11', 'h-p', 'g-p', 'today') = 'created' and tests.total(tests.i('g-p')) = 6,
  'Her personal habit counts for her personal goal');
select tests.act_as('bob');
select tests.assert_true(public.get_goal_links(p_habit_id => tests.i('h-p')) is null, 'Nobody else sees a personal habit''s links');
select tests.assert_true(public.get_goal_links(p_goal_id => tests.i('g-p')) is null, 'Nor a personal goal''s');
select tests.assert_true(public.remove_goal_link(tests.i('l-11'), 'remove', true) ->> 'outcome' = 'not_found',
  'Nor can touch them');
select tests.assert_true(tests.mko('l-12', 'h-run', 'g-b') = 'other_context', 'Bob cannot carry Home A''s habit into Home B');
select tests.act_as('carol');
select tests.assert_true(public.get_goal_links(p_goal_id => tests.i('g-b')) is null, 'Carol sees nothing of Home B');
select tests.assert_true(public.change_goal_link_start(tests.i('l-11'), 'today', null, true) ->> 'outcome' = 'not_found',
  'Nor of Alice''s personal links');
