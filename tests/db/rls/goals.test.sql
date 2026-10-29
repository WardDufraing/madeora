-- S30: goals core (supabase/migrations/*_goals.sql). Alice owns Home A, where Bob is an Administrator
-- (granted manageHomeGoals part-way) and Carol a Member; Bob owns Home B, which Carol is not in.
-- Covers: nothing reachable as a table; who may create, contribute, correct, achieve and manage;
-- shapes and values (zero/negative targets, precision, discrete and custom units, deadlines);
-- contributions (retries, id reuse, exact decimal sums, above-target totals), set total with stale
-- totals, corrections and reversals with their history and the non-negative total, achievement only
-- by an explicit action, reopening with history, target and unit changes with their confirmations,
-- overdue goals, renewals, archive and trash; the view-only member access; deadline reminders (moments,
-- passed lead times, recipients and opt-outs, late, achieved and stale deliveries); a departed member;
-- personal goals invisible to Home managers; isolation between Homes.

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
  'g-run', 'g-books', 'g-save', 'g-done', 'g-personal', 'g-bad', 'g-b', 'g-renew', 'g-glass', 'g-rem',
  'g-arch', 'g-zero', 'g-rem2', 'g-prem'
]) as n;
insert into ids select 'e' || g, gen_random_uuid() from generate_series(1, 60) g;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.rev(p_name text) returns integer
  language sql security definer as $$ select revision from private.goals where id = tests.i(p_name); $$;
-- plpgsql, so every call takes a fresh snapshot (an inlined SQL function would read the statement's).
create function tests.goal(p_name text) returns jsonb
  language plpgsql as $$ begin return public.get_goal(tests.i(p_name)); end $$;
create function tests.total(p_name text) returns numeric
  language plpgsql as $$ begin return (public.get_goal(tests.i(p_name)) ->> 'total')::numeric; end $$;
create function tests.create(
  p_name text, p_home text, p_kind text, p_target numeric default null, p_unit text default null,
  p_unit_kind text default null, p_initial numeric default null, p_deadline date default null,
  p_renewed text default null
) returns text
  language sql as $$
  select outcome from public.create_goal(tests.i(p_name), case when p_home is null then null else tests.i(p_home) end,
    p_kind, initcap(p_name), null, p_target, p_unit, p_unit_kind, p_initial, p_deadline,
    case when p_home is null then 'Europe/Brussels' end,
    case when p_renewed is null then null else tests.i(p_renewed) end); $$;
create function tests.add(p_id text, p_goal text, p_qty numeric, p_note text default null) returns jsonb
  language sql as $$ select public.add_goal_entry(tests.i(p_id), tests.i(p_goal), 'add', p_qty, p_note, 'app', null); $$;
create function tests.addo(p_id text, p_goal text, p_qty numeric) returns text
  language sql as $$ select tests.add(p_id, p_goal, p_qty) ->> 'outcome'; $$;
create function tests.set_total(p_id text, p_goal text, p_qty numeric, p_expected numeric) returns text
  language sql as $$
  select public.add_goal_entry(tests.i(p_id), tests.i(p_goal), 'total', p_qty, null, 'app', p_expected) ->> 'outcome'; $$;
create function tests.upd(p_id text, p_action text, p_qty numeric default null, p_reason text default null) returns text
  language sql as $$ select public.update_goal_entry(tests.i(p_id), p_action, p_qty, p_reason) ->> 'outcome'; $$;
create function tests.achieve(p_name text, p_achieved boolean, p_reason text default null) returns text
  language sql as $$
  select public.set_goal_achievement(tests.i(p_name), tests.rev(p_name), p_achieved, p_reason) ->> 'outcome'; $$;
create function tests.target(
  p_name text, p_target numeric, p_unit text, p_kind text default 'preset', p_dry boolean default false,
  p_confirm_unit boolean default false, p_confirm_status boolean default false
) returns jsonb
  language sql as $$
  select public.change_goal_target(tests.i(p_name), tests.rev(p_name), p_target, p_unit, p_kind, p_dry,
    p_confirm_unit, p_confirm_status); $$;
create function tests.private_count(p_query text) returns bigint
  language plpgsql security definer as $$
  declare v bigint; begin execute p_query into v; return v; end $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql security definer as $$
  select count(*) from public.notifications where user_id = tests.user_id(p_user) and kind = p_kind; $$;
create function tests.entry_of(p_goal text, p_kind text) returns uuid
  language sql security definer as $$
  select id from private.goal_entries where goal_id = tests.i(p_goal) and kind = p_kind
  order by recorded_at desc, id desc limit 1; $$;
create function tests.reminder_rev(p_name text) returns integer
  language sql security definer as $$
  select coalesce((select revision from private.goal_reminders where goal_id = tests.i(p_name)), 0); $$;
grant execute on function tests.i(text), tests.d(integer), tests.rev(text), tests.goal(text), tests.total(text),
  tests.create(text, text, text, numeric, text, text, numeric, date, text),
  tests.add(text, text, numeric, text), tests.addo(text, text, numeric),
  tests.set_total(text, text, numeric, numeric), tests.upd(text, text, numeric, text),
  tests.achieve(text, boolean, text), tests.target(text, numeric, text, text, boolean, boolean, boolean),
  tests.private_count(text), tests.notices(text, text), tests.entry_of(text, text), tests.reminder_rev(text)
  to authenticated, service_role;

-- Nothing is reachable as a table ---------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.goals', 'The API cannot read goals');
select tests.assert_denied('select * from private.goal_entries', 'Nor entries');
select tests.assert_denied('select * from private.goal_entry_corrections', 'Nor corrections');
select tests.assert_denied('select * from private.goal_achievements', 'Nor achievements');
select tests.assert_denied('select * from private.goal_reminders', 'Nor reminders');
select tests.assert_denied('select * from private.goal_events', 'Nor history');
select tests.assert_denied($$select private.goal_access(null, tests.user_id('alice'))$$, 'Nor the helpers');
select tests.assert_denied($$select private.trash_item_restore_before_goals(null)$$, 'Nor the renamed dispatch');
select tests.assert_denied($$select public.deliver_goal_reminder(gen_random_uuid(), 1, 'lead', now())$$,
  'Reminder delivery is for the service role only');
select tests.act_as_anon();
select tests.assert_denied('select public.get_goals()', 'Nobody signed out reads goals');

-- Creating, and who may -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true((public.get_goals(tests.i('home-a')) ->> 'access') = 'contribute',
  'A member contributes by default');
select tests.assert_true(tests.create('g-bad', 'home-a', 'completion') = 'not_permitted',
  'A member does not create Home goals');
select tests.assert_denied($$select public.get_goals(tests.i('home-b'))$$, 'Not a Home she is not in');
select tests.assert_denied($$select tests.create('g-bad', 'home-b', 'completion')$$,
  'Nor creates in it (42501, like a Home that does not exist)');
select tests.act_as('bob');
select tests.assert_true((public.get_goals(tests.i('home-a')) ->> 'access') = 'contribute',
  'An Administrator without manageHomeGoals contributes but does not manage');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeGoals']);
select tests.act_as('bob');
select tests.assert_true((public.get_goals(tests.i('home-a')) ->> 'access') = 'manage',
  'Granted manageHomeGoals, Bob manages goals');
select tests.assert_true(tests.create('g-run', 'home-a', 'measurable', 100, 'km', 'preset', null, tests.d(30)) = 'created',
  'He creates a measurable Home goal of 100 km with a deadline');
select tests.assert_true(tests.create('g-run', 'home-a', 'measurable', 100, 'km', 'preset', null, tests.d(30)) = 'exists',
  'A retry answers exists');
select tests.act_as('carol');
select tests.assert_true(tests.create('g-run', null, 'completion') = 'id_taken',
  'Someone else reusing the id is refused');

select tests.act_as('alice');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', 0, 'km', 'preset')$$,
  'A zero target is refused', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', -5, 'km', 'preset')$$,
  'A negative target is refused', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', 1.2345, 'km', 'preset')$$,
  'More than three decimals are refused', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', 2.5, 'pages', 'preset')$$,
  'A discrete unit takes whole targets only', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', 10, 'parsecs', 'preset')$$,
  'An unknown preset is refused', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', 10, null, null)$$,
  'A measurable goal needs a unit', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'completion', 10, 'km', 'preset')$$,
  'A completion goal has no target', '22023');
select tests.assert_denied($$select tests.create('g-bad', 'home-a', 'measurable', 10, 'km', 'preset', -1)$$,
  'A negative initial value is refused', '22023');
select tests.assert_true(tests.create('g-bad', 'home-a', 'completion', null, null, null, null, tests.d(-1)) = 'invalid_dates',
  'A deadline in the past is refused');
select tests.assert_true(tests.create('g-books', 'home-a', 'measurable', 20, 'books', 'custom', 12) = 'created',
  'A custom unit label, with initial progress 12 of 20 and no deadline');
select tests.assert_true(tests.total('g-books') = 12 and (tests.goal('g-books') ->> 'status') = 'active',
  'Initial progress is the starting total; without a deadline the goal is just active');
select tests.assert_true(tests.create('g-save', 'home-a', 'measurable', 2000, '€', 'custom') = 'created',
  'A savings goal starting at 0');
select tests.assert_true(tests.create('g-done', 'home-a', 'completion') = 'created', 'A completion goal');
select tests.assert_true(tests.create('g-glass', 'home-a', 'measurable', 8, 'glasses', 'preset') = 'created',
  'A goal in a discrete unit');

-- Contributions ---------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.addo('e1', 'g-run', 0.1) = 'added', 'Carol adds 0.1 km');
select tests.assert_true(tests.addo('e2', 'g-run', 0.2) = 'added', 'and 0.2 km');
select tests.assert_true(tests.total('g-run') = 0.3, 'The sum is exactly 0.3');
select tests.assert_true(tests.addo('e2', 'g-run', 0.2) = 'exists', 'A retry with the same id answers exists');
select tests.assert_true(tests.total('g-run') = 0.3, 'and is counted once');
select tests.act_as('bob');
select tests.assert_true(tests.addo('e2', 'g-run', 0.2) = 'id_taken', 'Bob cannot reuse Carol''s id');
select tests.assert_true((tests.add('e3', 'g-run', 99.7) -> 'goal' ->> 'reached')::boolean,
  'Bob''s 99.7 km reaches 100');
select tests.assert_true((tests.goal('g-run') ->> 'achievedAt') is null and (tests.goal('g-run') ->> 'status') = 'active',
  'Reaching the target achieves nothing by itself');
select tests.assert_true(tests.addo('e4', 'g-run', 25) = 'added' and tests.total('g-run') = 125,
  'Progress beyond the target is kept: 125 of 100');
select tests.act_as('carol');
select tests.assert_denied($$select tests.addo('e5', 'g-run', 0)$$, 'Zero is not a contribution', '22023');
select tests.assert_denied($$select tests.addo('e5', 'g-run', -2)$$, 'Nor a negative amount', '22023');
select tests.assert_denied($$select tests.addo('e5', 'g-run', 0.0001)$$, 'Nor four decimals', '22023');
select tests.assert_denied($$select tests.addo('e5', 'g-glass', 1.5)$$, 'Discrete units take whole amounts', '22023');
select tests.assert_true(tests.addo('e5', 'g-done', 1) = 'not_measurable', 'A completion goal takes no amounts');
select tests.assert_true(tests.set_total('e5', 'g-books', 15, 12) = 'not_permitted', 'Members do not set the total');
select tests.assert_true(
  (select count(*) = 5 from jsonb_array_elements(public.get_goal_entries(tests.i('g-run')) -> 'entries') x
    where x ->> 'by' is not null),
  'Every viewer sees who contributed: the initial value and four contributions');
select tests.assert_true(
  (select x ->> 'action' from jsonb_array_elements(public.get_goal_entries(tests.i('g-run')) -> 'entries') x
    where (x ->> 'id')::uuid = tests.i('e1')) = 'reverse'
  and (select x ->> 'action' from jsonb_array_elements(public.get_goal_entries(tests.i('g-run')) -> 'entries') x
    where (x ->> 'id')::uuid = tests.i('e3')) is null,
  'Carol may reverse her own contribution, not Bob''s');

-- Set total -------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(tests.set_total('e6', 'g-books', 15, 11) = 'stale',
  'Setting the total from a stale value is refused rather than overwriting');
select tests.assert_true(tests.set_total('e6', 'g-books', 15, 12) = 'adjusted' and tests.total('g-books') = 15,
  'Bob sets the total from 12 to 15');
select tests.act_as_owner();
select tests.assert_true((select quantity = 3 and kind = 'adjustment' from private.goal_entries where id = tests.i('e6')),
  'Recorded as the difference, a +3 adjustment');
select tests.act_as('bob');
select tests.assert_true(tests.set_total('e7', 'g-books', 15, 15) = 'unchanged', 'The same total changes nothing');
select tests.assert_true(tests.set_total('e7', 'g-books', 0, 15) = 'adjusted' and tests.total('g-books') = 0,
  'A total may be set to 0');
select tests.assert_true(tests.set_total('e8', 'g-books', 14, 0) = 'adjusted' and tests.total('g-books') = 14,
  'and back');

-- Corrections -----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.upd('e3', 'reverse') = 'not_permitted', 'A member cannot reverse someone else''s entry');
select tests.assert_true(tests.upd('e1', 'amend', 0.5) = 'not_permitted', 'nor amend her own');
select tests.assert_true(tests.upd('e1', 'reverse') = 'reversed' and tests.total('g-run') = 124.9,
  'She reverses her own 0.1 km');
select tests.assert_true(tests.upd('e1', 'reverse') = 'already_reversed', 'Twice changes nothing');
select tests.act_as('bob');
select tests.assert_true(tests.upd('e3', 'amend', 89.7, 'Typo') = 'corrected' and tests.total('g-run') = 114.9,
  'A manager amends an entry with a reason');
select tests.assert_true(tests.upd('e2', 'reverse', null, 'Duplicate') = 'reversed' and tests.total('g-run') = 114.7,
  'and reverses another member''s entry');
select tests.assert_true(tests.upd('e3', 'amend', 89.7) = 'unchanged', 'The same amount changes nothing');
select tests.assert_true(
  (select jsonb_array_length(x -> 'corrections') = 1 and (x -> 'corrections' -> 0 ->> 'before')::numeric = 99.7
     and (x -> 'corrections' -> 0 ->> 'after')::numeric = 89.7 and (x ->> 'originalQuantity')::numeric = 99.7
     and (x -> 'corrections' -> 0 ->> 'reason') = 'Typo'
   from jsonb_array_elements(public.get_goal_entries(tests.i('g-run')) -> 'entries') x
   where (x ->> 'id')::uuid = tests.i('e3')),
  'The entry keeps its original amount and the correction its before, after and reason');
select tests.assert_denied($$select tests.upd('e3', 'amend', 0)$$, 'A contribution cannot be amended to 0', '22023');
select tests.assert_true(tests.upd('e8', 'amend', -20) = 'negative_total',
  'An amendment that would take the total below 0 is refused');
select tests.act_as_owner();
insert into ids select 'books-initial', tests.entry_of('g-books', 'initial');
select tests.act_as('bob');
select tests.assert_true(tests.upd('books-initial', 'amend', 0, 'Counted twice') = 'corrected'
  and tests.total('g-books') = 2,
  'A manager corrects the initial value 12 to 0 (14 - 12)');
select tests.assert_true(tests.upd('e7', 'reverse') = 'reversed' and tests.total('g-books') = 17,
  'Reversing the -15 adjustment brings 15 back');
select tests.assert_true(
  (select count(*) >= 3 from jsonb_array_elements(public.get_goal_events(tests.i('g-run')) -> 'events') x
    where x ->> 'kind' = 'corrected'),
  'Corrections are in the history');

-- Achievement -----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.achieve('g-run', true) = 'not_permitted',
  'A member does not mark a measurable goal achieved');
select tests.assert_true(tests.achieve('g-done', true) = 'achieved', 'but marks a completion goal achieved');
select tests.assert_true(tests.achieve('g-done', true) = 'unchanged', 'A second tap changes nothing');
select tests.assert_true(tests.total('g-done') = 0
  and (tests.goal('g-done') ->> 'achievedByMe')::boolean
  and (tests.goal('g-done') -> 'achievements' -> 0 ->> 'mine')::boolean
  and (tests.goal('g-done') -> 'achievements' -> 0 -> 'total') = 'null'::jsonb,
  'A completion goal shows a total of 0, and its achiever sees that they did it');
select tests.assert_true(tests.achieve('g-done', false) = 'not_permitted', 'She does not reopen it');
select tests.act_as('bob');
select tests.assert_true(tests.achieve('g-save', true) = 'target_not_reached',
  'A measurable goal below its target cannot be marked achieved');
select tests.assert_true(
  (public.set_goal_achievement(tests.i('g-run'), tests.rev('g-run') - 1, true) ->> 'outcome') = 'conflict',
  'An old revision answers conflict');
select tests.assert_true(tests.achieve('g-run', true) = 'achieved', 'Bob marks the run goal achieved at 114.7/100');
select tests.assert_true((tests.goal('g-run') ->> 'status') = 'achieved'
  and (public.get_goals(tests.i('home-a'), 'completed') -> 'counts' ->> 'completed')::integer = 2,
  'It is in the Completed section with the completion goal');
select tests.assert_true(tests.addo('e9', 'g-run', 1) = 'achieved', 'An achieved goal takes no new contributions');
select tests.assert_true(tests.upd('e4', 'amend', 5) = 'corrected' and tests.total('g-run') = 94.7,
  'A correction may take an achieved goal below its target');
select tests.assert_true((tests.goal('g-run') ->> 'status') = 'achieved' and not (tests.goal('g-run') ->> 'reached')::boolean,
  'The achievement stays; the page shows the discrepancy');
select tests.assert_true(tests.achieve('g-run', false, 'Corrected below target') = 'reopened',
  'Bob reopens it with a reason');
select tests.assert_true(
  (select jsonb_array_length(tests.goal('g-run') -> 'achievements') = 1
     and (tests.goal('g-run') -> 'achievements' -> 0 ->> 'reopenedAt') is not null
     and (tests.goal('g-run') -> 'achievements' -> 0 ->> 'total')::numeric = 114.7
     and (tests.goal('g-run') -> 'achievements' -> 0 ->> 'reason') = 'Corrected below target'),
  'The achievement is kept with its total, its reopening and the reason');

-- Target and unit changes -----------------------------------------------------------------------------

select tests.assert_true((tests.target('g-run', 100, 'km') ->> 'outcome') = 'unchanged', 'The same target changes nothing');
select tests.assert_true((tests.target('g-run', 90, 'km', 'preset', true) -> 'impact' ->> 'reachedAfter')::boolean
  and (tests.target('g-run', 90, 'km', 'preset', true) ->> 'outcome') = 'preview',
  'A preview shows 94.7 would reach a 90 km target');
select tests.assert_true((tests.target('g-run', 90, 'km') ->> 'outcome') = 'saved', 'Lowered to 90');
select tests.assert_true((tests.target('g-run', 90000, 'm') ->> 'outcome') = 'confirm_unit',
  'A unit change on a goal with progress needs confirmation');
select tests.assert_true((tests.target('g-run', 90000, 'm', 'preset', false, true) ->> 'outcome') = 'saved'
  and tests.total('g-run') = 94.7,
  'Confirmed, the unit changes; existing numbers are never converted');
select tests.assert_true(
  not exists (select 1 from jsonb_array_elements(public.get_goal_entries(tests.i('g-run')) -> 'entries') x
    where x ->> 'unit' <> 'km')
  and exists (select 1 from jsonb_array_elements(public.get_goal_events(tests.i('g-run')) -> 'events') x
    where x ->> 'kind' = 'target_changed' and (x -> 'details' ->> 'unitBefore') = 'km'
      and (x -> 'details' ->> 'unitAfter') = 'm'),
  'Earlier entries keep the unit they were recorded in, and the history keeps both units');
select tests.assert_true((tests.target('g-run', 90, 'km', 'preset', false, true) ->> 'outcome') = 'saved', 'Back to km');
select tests.assert_true(tests.achieve('g-run', true) = 'achieved', 'Achieved again at 94.7/90');
select tests.assert_true((tests.target('g-run', 120, 'km') ->> 'outcome') = 'confirm_status'
  and (tests.target('g-run', 120, 'km') -> 'impact' ->> 'reopens')::boolean,
  'Extending the target above the total of an achieved goal asks to confirm reopening it');
select tests.assert_true((tests.target('g-run', 120, 'km', 'preset', false, false, true) ->> 'outcome') = 'saved'
  and (tests.goal('g-run') ->> 'achievedAt') is null
  and jsonb_array_length(tests.goal('g-run') -> 'achievements') = 2,
  'Confirmed, it is active again and both achievements stay in the history');
select tests.assert_denied($$select tests.target('g-glass', 7.5, 'glasses')$$, 'A discrete target stays whole', '22023');
select tests.assert_true((tests.target('g-done', 5, 'km') ->> 'outcome') = 'not_measurable',
  'A completion goal has no target');
select tests.act_as('carol');
select tests.assert_true((tests.target('g-run', 50, 'km') ->> 'outcome') = 'not_permitted', 'Members do not change targets');

-- Editing, deadlines, renewing ----------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'invalid_dates' from public.update_goal(tests.i('g-books'), tests.rev('g-books'), 'Books', null, tests.d(-3))),
  'A new deadline in the past is refused');
select tests.act_as_owner();
update private.goals set deadline = tests.d(-2) where id = tests.i('g-books');
select tests.act_as('bob');
select tests.assert_true((tests.goal('g-books') ->> 'status') = 'overdue' and tests.total('g-books') = 17,
  'Past its deadline a goal is overdue and keeps its progress');
select tests.assert_true(
  (select outcome = 'saved' from public.update_goal(tests.i('g-books'), tests.rev('g-books'), 'More books', 'Read', tests.d(-2))),
  'Editing the title keeps the unchanged past deadline');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_goal(tests.i('g-books'), 1, 'Books', null, null)),
  'An old revision answers conflict');
select tests.assert_true(tests.create('g-renew', 'home-a', 'completion', null, null, null, null, null, 'g-done') = 'created'
  and (tests.goal('g-renew') -> 'renewedFrom' ->> 'id')::uuid = tests.i('g-done')
  and (tests.goal('g-renew') ->> 'status') = 'active',
  'Renewing a completed goal creates a new active goal linked to it; the original stays');
select tests.assert_true((tests.goal('g-done') ->> 'status') = 'achieved', 'The original is still achieved');
select tests.act_as('carol');
select tests.assert_denied($$select tests.create('g-bad', null, 'completion', null, null, null, null, null, 'g-b')$$,
  'Nobody renews a goal they cannot see', '22023');

-- Personal goals and isolation ---------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.create('g-personal', null, 'measurable', 10, 'pages', 'preset') = 'created',
  'Carol creates a personal goal');
select tests.assert_true(tests.addo('e10', 'g-personal', 3) = 'added', 'and contributes to it');
select tests.act_as('alice');
select tests.assert_true(tests.goal('g-personal') is null, 'The Home owner never sees Carol''s personal goal');
select tests.assert_true(public.get_goal_entries(tests.i('g-personal')) is null, 'nor its entries');
select tests.assert_true(tests.addo('e11', 'g-personal', 1) = 'not_found', 'nor adds to it');
select tests.assert_true(tests.upd('e10', 'reverse') = 'not_found', 'nor corrects it');
select tests.assert_true(
  (select count(*) = 0 from public.goal_notice_names(array[tests.i('g-personal')])),
  'nor learns its title through notice names');
select tests.act_as('bob');
select tests.assert_true(tests.create('g-b', 'home-b', 'measurable', 5, 'km', 'preset') = 'created',
  'Bob creates a goal in Home B');
select tests.act_as('carol');
select tests.assert_true(tests.goal('g-b') is null, 'Carol, not in Home B, does not see it');
select tests.assert_true(tests.addo('e12', 'g-b', 1) = 'not_found', 'nor contributes to it');
select tests.assert_true((public.set_goal_achievement(tests.i('g-b'), 1, true) ->> 'outcome') = 'not_found',
  'nor achieves it');
select tests.assert_true(
  (select count(*) = 0 from jsonb_array_elements(public.get_goals(null) -> 'goals') x
    where (x ->> 'homeId') is not null),
  'Her personal list holds no Home goals');

-- View-only members, departure -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(public.update_goal_settings(tests.i('home-a'), 'view') = 'not_permitted',
  'A member does not change member access');
select tests.act_as('bob');
select tests.assert_true(public.update_goal_settings(tests.i('home-a'), 'view') = 'saved', 'A manager sets goals to view only');
select tests.act_as('carol');
select tests.assert_true(tests.addo('e13', 'g-save', 5) = 'not_permitted', 'A view-only member does not contribute');
select tests.assert_true(tests.achieve('g-renew', true) = 'not_permitted', 'nor marks a completion goal achieved');
select tests.assert_true(tests.goal('g-save') is not null, 'but still sees the goals');
select tests.act_as('bob');
select tests.assert_true(public.update_goal_settings(tests.i('home-a'), 'contribute') = 'saved', 'Back to contribute');
select tests.act_as('carol');
select tests.assert_true(tests.addo('e14', 'g-save', 750.5) = 'added', 'Carol contributes €750.50');
select tests.act_as_owner();
delete from public.home_memberships where id = tests.i('m-carol-a');
select tests.act_as('carol');
select tests.assert_denied($$select public.get_goals(tests.i('home-a'))$$, 'After leaving, Carol cannot read the Home''s goals');
select tests.assert_true(tests.addo('e15', 'g-save', 1) = 'not_found', 'nor contribute');
select tests.act_as('bob');
select tests.assert_true(
  (select x ->> 'by' is null from jsonb_array_elements(public.get_goal_entries(tests.i('g-save')) -> 'entries') x
    where (x ->> 'id')::uuid = tests.i('e14'))
  and tests.total('g-save') = 750.5,
  'Her contribution stays in the total, shown as a former member');

-- Reminders ---------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(tests.create('g-rem', 'home-a', 'completion') = 'created', 'A goal without a deadline');
select tests.assert_true(
  (public.set_goal_reminders(tests.i('g-rem'), 0, true, 3::smallint, null, '09:00') ->> 'outcome') = 'no_deadline',
  'Reminders need a deadline');
select tests.assert_true(
  (select outcome = 'saved' from public.update_goal(tests.i('g-rem'), tests.rev('g-rem'), 'Rem', null, tests.d(2))),
  'Bob gives it a deadline in two days');
select tests.assert_true(
  exists (select 1 from jsonb_array_elements(public.get_goal_events(tests.i('g-rem')) -> 'events') x
    where x ->> 'kind' = 'edited' and (x -> 'details' -> 'deadlineBefore') = 'null'::jsonb
      and (x -> 'details' ->> 'deadlineAfter') = tests.d(2)::text),
  'The history keeps the old and the new deadline');
select tests.assert_true(
  (select (x ->> 'passed')::boolean from jsonb_array_elements(
     public.set_goal_reminders(tests.i('g-rem'), 0, true, 5::smallint, 1::smallint, '09:00', true) -> 'moments') x
   where x ->> 'kind' = 'lead'),
  'A lead time of five days has already passed: the preview says so');
select tests.assert_true(tests.reminder_rev('g-rem') = 0, 'A preview saves nothing');
select tests.assert_true(
  (public.set_goal_reminders(tests.i('g-rem'), 0, true, 5::smallint, 1::smallint, '09:00') ->> 'outcome') = 'saved',
  'Saved anyway');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.job_outbox where job_name = 'goal-reminder'
     and payload ->> 'goalId' = tests.i('g-rem')::text),
  'Only the overdue moment is queued: the passed lead moment is never sent late');
select tests.act_as('bob');
select tests.assert_true(
  (public.set_goal_reminders(tests.i('g-rem'), tests.reminder_rev('g-rem'), true, 1::smallint, 1::smallint, '09:00')
    ->> 'outcome') = 'saved',
  'One day before instead');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.job_outbox where job_name = 'goal-reminder'
     and payload ->> 'goalId' = tests.i('g-rem')::text and (payload ->> 'revision')::integer = 2),
  'Both moments of the new revision are queued');
select tests.act_as('alice');
select public.set_my_goal_reminders(tests.i('g-rem'), false);
select tests.act_as_service_role();
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), 1, 'lead', now() - interval '1 minute') = 'stale',
  'A job of an old revision does nothing');
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), 2, 'lead', now() + interval '1 hour') = 'not_due',
  'A moment ahead is not due');
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), 2, 'lead', now() - interval '40 minutes') = 'late',
  'A moment more than 30 minutes late is skipped');
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), 2, 'lead', now() - interval '1 minute') = 'notified',
  'A due moment notifies');
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), 2, 'lead', now() - interval '1 minute') = 'notified',
  'A duplicate run');
select tests.act_as_owner();
select tests.assert_true(tests.notices('bob', 'goal.reminder') = 1, 'tells Bob exactly once');
select tests.assert_true(tests.notices('alice', 'goal.reminder') = 0, 'Alice turned this goal''s reminders off');
select tests.assert_true(tests.notices('carol', 'goal.reminder') = 0, 'Carol left the Home');
select tests.act_as('bob');
select tests.assert_true(tests.achieve('g-rem', true) = 'achieved', 'Achieved');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_goal_reminder(tests.i('g-rem'), 2, 'overdue', now() - interval '1 minute') = 'inactive',
  'An achieved goal reminds nobody');
select tests.act_as('bob');
select tests.assert_true(tests.achieve('g-rem', false) = 'reopened', 'Reopened');
select tests.assert_true(tests.reminder_rev('g-rem') = 3 and (tests.goal('g-rem') -> 'reminder' ->> 'enabled')::boolean,
  'Reopening keeps the reminder on and requeues its moments under a new revision');
select tests.assert_true(
  (select outcome = 'saved' from public.update_goal(tests.i('g-rem'), tests.rev('g-rem'), 'Rem', null, null)),
  'Removing the deadline');
select tests.assert_true(not (tests.goal('g-rem') -> 'reminder' ->> 'enabled')::boolean,
  'turns its reminders off');

-- A moved deadline, archive, unarchive and the trash at delivery time.
select tests.assert_true(tests.create('g-rem2', 'home-a', 'completion', null, null, null, null, tests.d(5)) = 'created'
  and (public.set_goal_reminders(tests.i('g-rem2'), 0, true, 1::smallint, 1::smallint, '09:00') ->> 'outcome') = 'saved',
  'A goal with both reminders');
create temporary table rem2 on commit drop as select tests.reminder_rev('g-rem2') as first;
grant select on rem2 to authenticated, service_role;
select tests.assert_true(
  (select outcome = 'saved' from public.update_goal(tests.i('g-rem2'), tests.rev('g-rem2'), 'Rem2', null, tests.d(6)))
  and tests.reminder_rev('g-rem2') > (select first from rem2),
  'Moving the deadline moves the reminder revision');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.job_outbox where job_name = 'goal-reminder'
     and payload ->> 'goalId' = tests.i('g-rem2')::text
     and (payload ->> 'revision')::integer = tests.reminder_rev('g-rem2'))
  and (select bool_and((payload ->> 'at')::timestamptz > now()) from private.job_outbox
     where job_name = 'goal-reminder' and payload ->> 'goalId' = tests.i('g-rem2')::text
     and (payload ->> 'revision')::integer = tests.reminder_rev('g-rem2')),
  'and queues both moments of the new deadline, all ahead');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_goal_reminder(tests.i('g-rem2'), (select first from rem2), 'lead', now() - interval '1 minute') = 'stale',
  'A job for the old deadline does nothing');
select tests.act_as('bob');
select tests.assert_true((select outcome = 'saved' from public.archive_goal(tests.i('g-rem2'), tests.rev('g-rem2'), true)),
  'Archived');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_goal_reminder(tests.i('g-rem2'), tests.reminder_rev('g-rem2'), 'lead', now() - interval '1 minute')
    in ('stale', 'inactive'),
  'An archived goal reminds nobody');
select tests.act_as('bob');
truncate rem2;
insert into rem2 select tests.reminder_rev('g-rem2');
select tests.assert_true((select outcome = 'saved' from public.archive_goal(tests.i('g-rem2'), tests.rev('g-rem2'), false))
  and tests.reminder_rev('g-rem2') > (select first from rem2),
  'Unarchiving requeues its moments under a new revision');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_goal(tests.i('g-rem2'), tests.rev('g-rem2'))), 'Moved to the trash');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_goal_reminder(tests.i('g-rem2'), tests.reminder_rev('g-rem2'), 'lead', now() - interval '1 minute') = 'stale',
  'A goal in the trash reminds nobody');
select tests.act_as_owner();
select tests.assert_true(tests.notices('bob', 'goal.reminder') = 1 and tests.notices('alice', 'goal.reminder') = 0,
  'None of that notified anyone');

-- A personal goal reminds its owner only.
select tests.act_as('bob');
select tests.assert_true(tests.create('g-prem', null, 'completion', null, null, null, null, tests.d(3)) = 'created'
  and (public.set_goal_reminders(tests.i('g-prem'), 0, true, 1::smallint, null, '09:00') ->> 'outcome') = 'saved',
  'Bob''s personal goal with a reminder');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_goal_reminder(tests.i('g-prem'), tests.reminder_rev('g-prem'), 'lead', now() - interval '1 minute') = 'notified',
  'A due moment');
select tests.act_as_owner();
select tests.assert_true(tests.notices('bob', 'goal.reminder') = 2 and tests.notices('alice', 'goal.reminder') = 0
  and tests.notices('carol', 'goal.reminder') = 0,
  'reaches its owner only, never a Home manager');
select tests.act_as('bob');

-- Archive and trash ------------------------------------------------------------------------------------

select tests.assert_true(tests.create('g-arch', 'home-a', 'measurable', 10, 'km', 'preset') = 'created', 'A goal to archive');
select tests.assert_true((select outcome = 'saved' from public.archive_goal(tests.i('g-arch'), tests.rev('g-arch'), true)),
  'Archived');
select tests.assert_true((tests.goal('g-arch') ->> 'status') = 'archived'
  and tests.addo('e16', 'g-arch', 1) = 'archived', 'An archived goal takes no contributions');
select tests.assert_true((select outcome = 'saved' from public.archive_goal(tests.i('g-arch'), tests.rev('g-arch'), false)),
  'Unarchived');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_goal(tests.i('g-arch'), tests.rev('g-arch'))),
  'Moved to the trash');
select tests.assert_true(tests.goal('g-arch') is null, 'It is gone');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
     array[(select entry_id from public.list_trash(tests.i('home-a'), 'goals') where label = 'G-Arch')])),
  'And restored');
select tests.assert_true((tests.goal('g-arch') ->> 'status') = 'active', 'Back as it was');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.goal_notice_names(array[tests.i('g-arch'), tests.i('g-b')])),
  'Notice names only for goals the caller may see: not Home B''s for Alice');
