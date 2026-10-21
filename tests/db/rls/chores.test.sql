-- S20: chores (supabase/migrations/*_chores.sql). Alice owns Home A (Europe/Brussels), where Bob is
-- an Administrator (granted manageHomeChores later) and Carol a Member; Bob owns Home B, which Carol
-- is not in. Covers: nothing reachable as a table; categories (rights, duplicates, archive, delete
-- with impact, another Home's id refused); creating one-off and recurring chores (rights, retries,
-- invalid assignments and checklists, no back-fill); occurrences up to today plus one, created once;
-- rotation by schedule date across misses and skips; completing (anyone, another member's chore,
-- the actual contributor kept apart from who recorded it, mandatory steps, note, twice); ticking
-- steps; skipping and reopening (managers, events kept); "this occurrence", "this and following" and
-- "entire series" edits with dry runs, kept progress, overdue assignees kept and off-schedule
-- removal; pause until a date and resume without back-fill; deleting one, following and all
-- occurrences, the trash entries, restore (with schedule_changed) and purge, history kept; history
-- statuses, snapshots and paging; departure (flags and an empty rotation place); isolation across
-- Homes; audit.
--
-- Time cannot move inside a test, so "days passing" is simulated by moving a chore's dates back as
-- the database owner (tests.chore_shift_back).

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Pacific/Auckland', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m, unnest(array['alice', 'bob', 'carol']) u
  where m.home_id = (select id from ids where name = 'home-a') and m.user_id = tests.user_id(u);
insert into ids select 'm-bob-b', m.id from public.home_memberships m
  where m.home_id = (select id from ids where name = 'home-b') and m.user_id = tests.user_id('bob');
insert into ids select n, gen_random_uuid() from unnest(array[
  'cat-kitchen', 'cat-garden', 'cat-b', 'c-dishes', 'c-rota', 'c-b', 'c-weekly', 'c-pause', 'c-del',
  'c-empty', 'c-fixed'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.occ(p_chore text, p_date date) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) and scheduled_date = p_date; $$;
create function tests.first_occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.orev(p_occurrence uuid) returns integer
  language sql stable security definer as $$ select revision from private.chore_occurrences where id = p_occurrence; $$;
create function tests.srev(p_chore text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_schedules where chore_id = tests.i(p_chore) and superseded_at is null; $$;
create function tests.dates(p_chore text) returns date[]
  language sql stable security definer as $$
  select coalesce(array_agg(scheduled_date order by scheduled_date), '{}') from private.chore_occurrences
  where chore_id = tests.i(p_chore) and deleted_at is null; $$;
create function tests.assignee(p_chore text, p_date date) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(split_part(u.email, '@', 1), ',' order by u.email), '')
  from private.chore_occurrence_assignees a join auth.users u on u.id = a.user_id
  where a.occurrence_id = tests.occ(p_chore, p_date); $$;
create function tests.step(p_occurrence uuid, p_position integer) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrence_steps where occurrence_id = p_occurrence and position = p_position; $$;
-- Moves a chore p_days into the past, as if that many days had passed since it was set up.
create function tests.chore_shift_back(p_chore text, p_days integer) returns void
  language sql security definer as $$
  update private.chore_schedules set starts_on = starts_on - p_days, active_from = active_from - p_days,
    ends_on = ends_on - p_days, until_date = until_date - p_days, next_date = next_date - p_days,
    last_date = last_date - p_days, rotation_from = rotation_from - p_days,
    paused_from = paused_from - p_days, paused_until = paused_until - p_days
  where chore_id = tests.i(p_chore);
  -- In two steps, so the one-occurrence-per-date key never sees two rows on one date midway.
  update private.chore_occurrences set scheduled_date = scheduled_date - p_days - 100000,
    due_date = due_date - p_days
  where chore_id = tests.i(p_chore);
  update private.chore_occurrences set scheduled_date = scheduled_date + 100000
  where chore_id = tests.i(p_chore);
  $$;
create function tests.entry(p_type text) returns uuid
  language sql stable security definer as $$
  select id from private.trash_entries where item_type = p_type and status = 'trashed'
  order by deleted_at desc limit 1; $$;
create function tests.parts(p_chore text) returns bigint
  language sql stable security definer as $$
  select count(*) from private.chore_schedules where chore_id = tests.i(p_chore); $$;
create function tests.step_labels(p_occurrence uuid) returns text
  language sql stable security definer as $$
  select string_agg(label, ',' order by position) from private.chore_occurrence_steps
  where occurrence_id = p_occurrence; $$;
create function tests.rows(p_chore text) returns bigint
  language sql stable security definer as $$
  select count(*) from private.chore_occurrences where chore_id = tests.i(p_chore); $$;
create function tests.flagged(p_occurrence uuid) returns boolean
  language sql stable security definer as $$
  select needs_reassignment from private.chore_occurrences where id = p_occurrence; $$;
create function tests.category_rev(p_category text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_categories where id = tests.i(p_category); $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.chores', 'The API cannot read chores');
select tests.assert_denied('select * from private.chore_occurrences', 'Nor occurrences');
select tests.assert_denied('select * from private.chore_schedules', 'Nor schedules');
select tests.assert_denied('select * from private.chore_categories', 'Nor categories');
select tests.assert_denied('select * from private.chore_occurrence_events', 'Nor events');
select tests.assert_denied(
  $$select private.chore_turn('daily', 1, null, current_date, current_date, current_date)$$,
  'Nor the rotation helper');
select tests.act_as_anon();
select tests.assert_denied($$select public.advance_chores(gen_random_uuid())$$, 'Nobody signed out advances chores');
select tests.act_as('carol');
select tests.assert_denied(
  format($$select * from public.list_chore_occurrences(%L)$$, tests.i('home-b')),
  'Carol cannot list the chores of a Home she is not in');
select tests.assert_denied(
  format($$select * from public.get_chore_context(%L)$$, gen_random_uuid()),
  'A Home that does not exist answers the same');

-- Categories -----------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore_category(tests.i('cat-kitchen'), tests.i('home-a'), 'Kitchen', 'teal')),
  'The Owner creates a category');
select tests.assert_true(
  (select outcome = 'exists' from public.create_chore_category(tests.i('cat-kitchen'), tests.i('home-a'), 'Kitchen', 'teal')),
  'A retry returns it');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.create_chore_category(gen_random_uuid(), tests.i('home-a'), 'KITCHEN', 'red')),
  'A name that reads alike is refused');
select tests.assert_denied(
  format($$select * from public.create_chore_category(gen_random_uuid(), %L, 'Pink', 'hotpink')$$, tests.i('home-a')),
  'Only the label colours', '22023');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore_category(tests.i('cat-garden'), tests.i('home-a'), 'Garden', 'green')),
  'A second category');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_chore_category(gen_random_uuid(), tests.i('home-a'), 'Mine', 'red')),
  'A Member cannot create categories');
select tests.assert_true(
  (select count(*) = 2 from public.list_chore_categories(tests.i('home-a'))),
  'But sees them');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_chore_category(gen_random_uuid(), tests.i('home-a'), 'Bob', 'red')),
  'An Administrator without manageHomeChores cannot either');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore_category(tests.i('cat-b'), tests.i('home-b'), 'Kot', 'red')),
  'Bob creates a category in his own Home');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_category(tests.i('cat-garden'), 1, 'Garden', 'green', true)),
  'The Owner archives a category');
select tests.assert_true(
  (select count(*) = 1 from public.list_chore_categories(tests.i('home-a'))),
  'Archived categories are left out unless asked for');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2 from public.update_chore_category(tests.i('cat-garden'), 1, 'G', 'green', false)),
  'A stale revision is a conflict');

-- Creating chores --------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'Mine',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'A Member cannot create chores');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' and occurrence_id is not null from public.create_chore(tests.i('c-dishes'),
    tests.i('home-a'), 'Dishes', jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    '[{"label": "Wash", "mandatory": true}, {"label": "Dry", "mandatory": false}]', 'Hot water',
    tests.i('cat-kitchen'), 20, p_due_date => tests.today_a())),
  'The Owner creates a one-off chore for Carol with a checklist');
select tests.assert_true(
  (select outcome = 'exists' and occurrence_id = tests.first_occ('c-dishes') from public.create_chore(tests.i('c-dishes'),
    tests.i('home-a'), 'Dishes', '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'A retry returns the same chore and occurrence');
select tests.assert_true(
  (select outcome = 'invalid_category' from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'X',
    '{"mode": "none", "members": []}', p_category_id => tests.i('cat-b'), p_due_date => tests.today_a())),
  'Another Home''s category is refused');
select tests.assert_true(
  (select outcome = 'invalid_category' from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'X',
    '{"mode": "none", "members": []}', p_category_id => tests.i('cat-garden'), p_due_date => tests.today_a())),
  'An archived category is not offered for new chores');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'X',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-bob-b'))), p_due_date => tests.today_a())),
  'A membership of another Home is not an assignee');
select tests.assert_denied(
  format($$select * from public.create_chore(gen_random_uuid(), %L, 'X', %L, p_due_date => %L)$$, tests.i('home-a'),
    jsonb_build_object('mode', 'rotating', 'members', jsonb_build_array(tests.i('m-alice-a'), tests.i('m-bob-a'))),
    tests.today_a()),
  'A one-off chore cannot rotate', '22023');
select tests.assert_denied(
  format($$select * from public.create_chore(gen_random_uuid(), %L, 'X', '{"mode": "none", "members": []}',
    '[{"label": "Wash", "mandatory": true}, {"label": "wash ", "mandatory": false}]', p_due_date => %L)$$,
    tests.i('home-a'), tests.today_a()),
  'Two steps that read alike are refused', '22023');
select tests.assert_denied(
  format($$select * from public.create_chore(gen_random_uuid(), %L, 'X', '{"mode": "none", "members": []}',
    p_minutes => 0, p_due_date => %L)$$, tests.i('home-a'), tests.today_a()),
  'An estimate is positive', '22023');
select tests.assert_true(
  (select outcome = 'ended' from public.create_chore(gen_random_uuid(), tests.i('home-a'), 'Long ago',
    '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() - 20,
    p_ends_on => tests.today_a() - 10)),
  'A schedule whose every date has passed creates nothing');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-rota'), tests.i('home-a'), 'Bins',
    jsonb_build_object('mode', 'rotating', 'members',
      jsonb_build_array(tests.i('m-alice-a'), tests.i('m-bob-a'), tests.i('m-carol-a'))),
    '[{"label": "Take out", "mandatory": true}]', p_frequency => 'daily', p_interval => 1,
    p_starts_on => tests.today_a() - 5)),
  'A daily chore rotating between Alice, Bob and Carol, starting in the past');
select tests.assert_true(tests.dates('c-rota') = array[tests.today_a(), tests.today_a() + 1],
  'Nothing is back-filled: today and one upcoming');
select tests.assert_true(
  tests.assignee('c-rota', tests.today_a()) = 'alice' and tests.assignee('c-rota', tests.today_a() + 1) = 'bob',
  'Turns count from the schedule''s start: the rotation starts with Alice, Bob is next');
select tests.assert_true(
  (select (o -> 'schedule' -> 'next' -> 0 ->> 'date')::date = tests.today_a()
     and o -> 'schedule' -> 'next' -> 2 -> 'assignees' = jsonb_build_array(tests.i('m-carol-a'))
     and jsonb_array_length(o -> 'schedule' -> 'next') = 5
   from public.get_chore_occurrence(tests.occ('c-rota', tests.today_a())) o),
  'The occurrence previews the next dates with whose turn they are');
select public.advance_chores(tests.i('home-a'));
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(tests.dates('c-rota') = array[tests.today_a(), tests.today_a() + 1],
  'Advancing again creates nothing twice');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-b'), tests.i('home-b'), 'Kot chore',
    '{"mode": "none", "members": []}', p_due_date => '2026-10-21')),
  'Bob creates a chore in Home B');

-- Rotation keeps its order through misses and skips --------------------------------------------------

select tests.act_as_owner();
select tests.chore_shift_back('c-rota', 3);
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(
  tests.dates('c-rota') = array[tests.today_a() - 3, tests.today_a() - 2, tests.today_a() - 1, tests.today_a(),
    tests.today_a() + 1],
  'Three days later the missed days stay and today plus one more exist');
select tests.assert_true(
  tests.assignee('c-rota', tests.today_a() - 3) = 'alice' and tests.assignee('c-rota', tests.today_a() - 2) = 'bob'
    and tests.assignee('c-rota', tests.today_a() - 1) = 'carol' and tests.assignee('c-rota', tests.today_a()) = 'alice'
    and tests.assignee('c-rota', tests.today_a() + 1) = 'bob',
  'Missed occurrences keep their member and the order goes on by date');
select tests.assert_true(
  (select count(*) = 3 from public.list_chore_occurrences(tests.i('home-a')) where chore_id = tests.i('c-rota') and overdue),
  'The missed ones are overdue');

-- Completing, ticking, skipping, reopening -------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'steps_incomplete' and open_mandatory = 1
   from public.complete_chore_occurrence(tests.first_occ('c-dishes'), tests.i('m-carol-a'))),
  'A mandatory step must be ticked first');
select tests.assert_true(
  (select outcome = 'saved' and checked and done = 1 and total = 2
   from public.set_chore_step(tests.step(tests.first_occ('c-dishes'), 0), true)),
  'Carol ticks it');
select tests.assert_true(
  (select outcome = 'invalid_contributor' from public.complete_chore_occurrence(tests.first_occ('c-dishes'), tests.i('m-bob-b'))),
  'The contributor must be a member of the chore''s Home');
select tests.assert_true(
  (select outcome = 'completed' and completed_by_me and not contributor_me and contributor_member = tests.i('m-bob-a')
   from public.complete_chore_occurrence(tests.first_occ('c-dishes'), tests.i('m-bob-a'), E'  Done,\n  all   clean ')),
  'Carol records that Bob actually did it');
select tests.assert_true(
  (select o -> 'completion' ->> 'note' = 'Done, all clean'
     and (o -> 'completion' -> 'by' ->> 'member')::uuid = tests.i('m-carol-a')
     and (o -> 'completion' -> 'contributor' ->> 'member')::uuid = tests.i('m-bob-a')
     and o -> 'assignees' = jsonb_build_array(tests.i('m-carol-a'))
   from public.get_chore_occurrence(tests.first_occ('c-dishes')) o),
  'The note is normalized; who recorded it and who did it are kept apart; the assignee stays Carol');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.set_chore_step(tests.step(tests.first_occ('c-dishes'), 1), true)),
  'A completed occurrence''s checklist is part of the record');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'already_completed' and not completed_by_me and contributor_member = tests.i('m-bob-a')
   from public.complete_chore_occurrence(tests.first_occ('c-dishes'), tests.i('m-alice-a'))),
  'A second completion is told who was first and changes nothing');
-- Bob completes Carol's overdue turn for her: any member may, without reassigning it.
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_step(tests.step(tests.occ('c-rota', tests.today_a() - 1), 0), true)),
  'Bob ticks the step on Carol''s turn');
select tests.assert_true(
  (select outcome = 'completed' and contributor_me
   from public.complete_chore_occurrence(tests.occ('c-rota', tests.today_a() - 1), tests.i('m-bob-a'))),
  'And completes it as its contributor');
select tests.assert_true(tests.assignee('c-rota', tests.today_a() - 1) = 'carol', 'It is still Carol''s turn on record');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.skip_chore_occurrence(tests.occ('c-rota', tests.today_a() - 3))),
  'A Member cannot skip');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.reopen_chore_occurrence(tests.first_occ('c-dishes'))),
  'Nor reopen');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'skipped' from public.skip_chore_occurrence(tests.occ('c-rota', tests.today_a() - 3), 'Away')),
  'The Owner skips a missed occurrence with a reason');
select tests.assert_true(
  (select outcome = 'already_skipped' from public.complete_chore_occurrence(tests.occ('c-rota', tests.today_a() - 3), tests.i('m-alice-a'))),
  'A skipped occurrence cannot be completed');
select tests.assert_true(
  tests.assignee('c-rota', tests.today_a()) = 'alice' and tests.assignee('c-rota', tests.today_a() + 1) = 'bob',
  'Skipping changes no later turn');
select tests.assert_true(
  (select outcome = 'reopened' from public.reopen_chore_occurrence(tests.first_occ('c-dishes'))),
  'The Owner reopens the completed one-off');
select tests.assert_true(
  (select o ->> 'status' = 'open' and o -> 'completion' = 'null'::jsonb and jsonb_array_length(o -> 'events') = 2
     and o -> 'events' -> 0 ->> 'note' = 'Done, all clean' and o -> 'events' -> 1 ->> 'kind' = 'reopened'
     and (o -> 'steps' -> 0 ->> 'checked')::boolean
   from public.get_chore_occurrence(tests.first_occ('c-dishes')) o),
  'It is open again with its progress; what was recorded stays in its events');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.first_occ('c-dishes'), tests.i('m-carol-a'))),
  'And can be completed again');

-- History --------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select array_agg(status order by scheduled_date) = array['skipped', 'missed', 'completed', 'due_today']
   from public.list_chore_history(tests.i('c-rota'))),
  'History: skipped, missed, completed and today''s; no future occurrence');
select tests.assert_true(
  (select count(*) = 1 and bool_and(skip_reason = 'Away' and not skipped_by_me and skipped_by_member = tests.i('m-alice-a'))
   from public.list_chore_history(tests.i('c-rota'), 'skipped')),
  'Filtered to skipped, with who skipped it and why');
select tests.assert_true(
  (select count(*) = 1 and bool_and(total_count = 4) from public.list_chore_history(tests.i('c-rota'), 'all', 1, 1)),
  'Paged, with the total');
select tests.assert_denied(
  format($$select * from public.list_chore_history(%L)$$, tests.i('c-b')),
  'Carol cannot read Home B''s history', '22023');
select tests.assert_true(public.get_chore_occurrence(tests.first_occ('c-b')) is null,
  'Nor open its occurrence');
select tests.assert_true(
  (select outcome = 'not_found' from public.complete_chore_occurrence(tests.first_occ('c-b'), tests.i('m-carol-a'))),
  'Nor complete it');

-- One occurrence -----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_chore_occurrence(tests.occ('c-rota', tests.today_a() + 1),
    tests.orev(tests.occ('c-rota', tests.today_a() + 1)), false, p_assignee_ids => array[tests.i('m-carol-a')])),
  'A Member cannot change an occurrence');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_step(tests.step(tests.occ('c-rota', tests.today_a() + 1), 0), true)),
  'A step of tomorrow''s occurrence is ticked');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'removedChecked')::integer = 1 and (impact ->> 'added')::integer = 1
     and (impact ->> 'newlyMandatory')::integer = 1
   from public.update_chore_occurrence(tests.occ('c-rota', tests.today_a() + 1),
     tests.orev(tests.occ('c-rota', tests.today_a() + 1)), true, p_steps => '[{"label": "Rinse", "mandatory": true}]')),
  'The preview names the ticked step that would go and the new mandatory one');
select tests.assert_true(
  (select outcome = 'needs_confirmation' from public.update_chore_occurrence(tests.occ('c-rota', tests.today_a() + 1),
    tests.orev(tests.occ('c-rota', tests.today_a() + 1)), false, p_steps => '[{"label": "Rinse", "mandatory": true}]')),
  'Removing a ticked step needs confirmation');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.occ('c-rota', tests.today_a() + 1),
    tests.orev(tests.occ('c-rota', tests.today_a() + 1)), false, p_due_date => tests.today_a() + 2,
    p_assignee_ids => array[tests.i('m-carol-a')], p_set_minutes => true, p_minutes => 15,
    p_steps => '[{"label": "Rinse", "mandatory": true}]', p_confirm_checklist => true)),
  'Confirmed: this occurrence only changes');
select tests.assert_true(
  (select o ->> 'detached' = 'true' and (o ->> 'dueDate')::date = tests.today_a() + 2
     and o -> 'assignees' = jsonb_build_array(tests.i('m-carol-a')) and (o ->> 'minutes')::integer = 15
     and jsonb_array_length(o -> 'steps') = 1 and (o ->> 'scheduledDate')::date = tests.today_a() + 1
   from public.get_chore_occurrence(tests.occ('c-rota', tests.today_a() + 1)) o),
  'It is individually changed and keeps its scheduled date');

-- Following and entire series ------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_chore_series(tests.occ('c-rota', tests.today_a()), 'series',
    tests.orev(tests.occ('c-rota', tests.today_a())), tests.srev('c-rota'), false, p_set_minutes => true, p_minutes => 5)),
  'An Administrator without manageHomeChores cannot change the series');
select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeChores']) = 'ok',
  'The Owner grants Bob manageHomeChores');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'preview' and impact ->> 'scope' = 'series' and (impact ->> 'updated')::integer = 2
     and (impact ->> 'kept')::integer = 1 and (impact ->> 'completed')::integer = 2
     and (impact ->> 'overdueKept')::integer = 1
   from public.update_chore_series(tests.occ('c-rota', tests.today_a()), 'series',
     tests.orev(tests.occ('c-rota', tests.today_a())), tests.srev('c-rota'), true,
     p_assignment => jsonb_build_object('mode', 'rotating', 'members', jsonb_build_array(tests.i('m-carol-a'), tests.i('m-bob-a'))),
     p_set_minutes => true, p_minutes => 10)),
  'Now he previews a new rotation for the whole series: today and Bob''s overdue turn change '
  '(the overdue one keeps its member), tomorrow''s individually changed one is kept, closed ones untouched');
select tests.assert_true(tests.assignee('c-rota', tests.today_a()) = 'alice', 'A dry run changes nothing');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_series(tests.occ('c-rota', tests.today_a()), 'series',
     tests.orev(tests.occ('c-rota', tests.today_a())), tests.srev('c-rota'), false,
     p_assignment => jsonb_build_object('mode', 'rotating', 'members', jsonb_build_array(tests.i('m-carol-a'), tests.i('m-bob-a'))),
     p_set_minutes => true, p_minutes => 10)),
  'He saves it');
select tests.assert_true(
  tests.assignee('c-rota', tests.today_a()) = 'carol' and tests.assignee('c-rota', tests.today_a() - 2) = 'bob'
    and tests.assignee('c-rota', tests.today_a() + 1) = 'carol',
  'The new rotation starts today with Carol; the overdue and the individually changed occurrences keep theirs');
select tests.assert_true(
  (select (o ->> 'minutes')::integer = 10 from public.get_chore_occurrence(tests.occ('c-rota', tests.today_a() - 2)) o),
  'The overdue one still takes the new estimate');
select tests.assert_true(
  (select o -> 'schedule' -> 'next' -> 1 -> 'assignees' = jsonb_build_array(tests.i('m-bob-a'))
   from public.get_chore_occurrence(tests.occ('c-rota', tests.today_a())) o),
  'And Bob has the turn after');

-- A weekly chore split with "this and following"
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-weekly'), tests.i('home-a'), 'Floors',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-alice-a'))),
    '[{"label": "Sweep", "mandatory": false}]', p_frequency => 'weekly', p_interval => 1,
    p_weekdays => array[extract(isodow from tests.today_a())::smallint], p_starts_on => tests.today_a())),
  'A weekly chore for Alice');
select tests.act_as_owner();
select tests.chore_shift_back('c-weekly', 14);
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(cardinality(tests.dates('c-weekly')) = 4, 'Two weeks later: two past, this week and next');
select public.complete_chore_occurrence(tests.occ('c-weekly', tests.today_a() - 14), tests.i('m-alice-a'));
select tests.assert_true(
  (select outcome = 'scope_unavailable' from public.update_chore_series(tests.occ('c-weekly', tests.today_a() - 14),
    'following', tests.orev(tests.occ('c-weekly', tests.today_a() - 14)), tests.srev('c-weekly'), false,
    p_set_minutes => true, p_minutes => 5)),
  'A completed occurrence cannot start "this and following"');
select tests.assert_true(
  (select outcome = 'saved' and impact ->> 'scope' = 'following' and (impact ->> 'updated')::integer = 2
   from public.update_chore_series(tests.occ('c-weekly', tests.today_a()), 'following',
     tests.orev(tests.occ('c-weekly', tests.today_a())), tests.srev('c-weekly'), false,
     p_assignment => jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
     p_steps => '[{"label": "Mop", "mandatory": true}]')),
  'This and following: Carol from this week, with a new checklist');
select tests.assert_true(
  tests.assignee('c-weekly', tests.today_a() - 7) = 'alice' and tests.assignee('c-weekly', tests.today_a()) = 'carol'
    and tests.assignee('c-weekly', tests.today_a() + 7) = 'carol',
  'Last week''s missed one stays Alice''s');
select tests.assert_true(
  tests.parts('c-weekly') = 2,
  'The schedule was split in two parts');
select tests.assert_true(
  tests.step_labels(tests.occ('c-weekly', tests.today_a() - 7)) = 'Sweep',
  'Earlier occurrences keep their checklist');
-- A schedule change removes upcoming, untouched occurrences that are off the new schedule.
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'removed')::integer = 1 and (impact -> 'selectedRemoved')::boolean is false
   from public.update_chore_series(tests.occ('c-weekly', tests.today_a()), 'series',
     tests.orev(tests.occ('c-weekly', tests.today_a())), tests.srev('c-weekly'), false,
     p_set_schedule => true, p_frequency => 'weekly', p_interval => 2,
     p_weekdays => array[extract(isodow from tests.today_a())::smallint], p_starts_on => tests.today_a())),
  'Every two weeks from this week: next week''s occurrence goes');
select tests.assert_true(
  not (tests.today_a() + 7 = any (tests.dates('c-weekly'))) and tests.today_a() + 14 = any (tests.dates('c-weekly')),
  'And the one in two weeks is created instead');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_chore_series(tests.occ('c-weekly', tests.today_a()), 'series',
     tests.orev(tests.occ('c-weekly', tests.today_a())), 1, false, p_set_minutes => true, p_minutes => 5)),
  'A stale schedule revision is a conflict');

-- Chore-level fields --------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'saved' from public.update_chore(tests.i('c-rota'), 1, 'Bins out', null, tests.i('cat-kitchen'))),
  'The Owner renames the rotating chore and puts it in Kitchen');
select tests.assert_true(
  (select bool_and(title = case when status in ('completed', 'skipped') then 'Bins' else 'Bins out' end)
     and bool_and(category is not distinct from case when status in ('completed', 'skipped') then null else 'Kitchen' end)
   from public.list_chore_history(tests.i('c-rota'))),
  'Closed occurrences keep the title and category they were closed under');

-- Pause ----------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-pause'), tests.i('home-a'), 'Plants',
    '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a())),
  'A daily chore');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'removed')::integer = 2
     and (impact -> 'next' -> 0 ->> 'date')::date = tests.today_a() + 4
   from public.set_chore_paused(tests.i('c-pause'), tests.srev('c-pause'), true, tests.today_a() + 3, true)),
  'Pausing until in three days would remove today''s and tomorrow''s; the next date is after the pause');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_paused(tests.i('c-pause'), tests.srev('c-pause'), true, tests.today_a() + 3)),
  'Paused');
select tests.assert_true(tests.dates('c-pause') = array[tests.today_a() + 4], 'Only the first date after the pause exists');
select tests.assert_true(
  (select (o -> 'schedule' -> 'paused' ->> 'until')::date = tests.today_a() + 3
   from public.get_chore_occurrence(tests.occ('c-pause', tests.today_a() + 4)) o),
  'The occurrence shows the pause');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_paused(tests.i('c-pause'), tests.srev('c-pause'), false)),
  'Resumed');
select tests.assert_true(tests.dates('c-pause') = array[tests.today_a(), tests.today_a() + 4],
  'Today comes back, and nothing between is back-filled beyond the one upcoming date');
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'removed')::integer = 2 and impact -> 'next' = '[]'::jsonb
   from public.set_chore_paused(tests.i('c-pause'), tests.srev('c-pause'), true)),
  'Paused indefinitely: the untouched open occurrences go and no date is planned');
select tests.act_as_owner();
select tests.chore_shift_back('c-pause', 3);
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(cardinality(tests.dates('c-pause')) = 0, 'Days pass and nothing is created while paused');

-- Delete scopes, trash, restore, purge -------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-del'), tests.i('home-a'), 'Windows',
    '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a())),
  'A daily chore to delete');
select tests.act_as_owner();
select tests.chore_shift_back('c-del', 2);
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select public.complete_chore_occurrence(tests.occ('c-del', tests.today_a() - 2), tests.i('m-alice-a'));
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_chore_occurrences(tests.occ('c-del', tests.today_a()), 'occurrence',
    tests.orev(tests.occ('c-del', tests.today_a())), false)),
  'A Member cannot delete');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' and entry_id is not null from public.delete_chore_occurrences(tests.occ('c-del', tests.today_a() - 1),
    'occurrence', tests.orev(tests.occ('c-del', tests.today_a() - 1)), false)),
  'One occurrence goes to the trash');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(
  tests.dates('c-del') = array[tests.today_a() - 2, tests.today_a(), tests.today_a() + 1],
  'And is not created again');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.entry('chore_occurrence')])),
  'It comes back from the trash');
select tests.assert_true(
  (select outcome = 'preview' and impact ->> 'scope' = 'following' and (impact ->> 'removed')::integer = 2
   from public.delete_chore_occurrences(tests.occ('c-del', tests.today_a()), 'following',
     tests.orev(tests.occ('c-del', tests.today_a())), true)),
  'Deleting this and following would take today''s and tomorrow''s');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_chore_occurrences(tests.occ('c-del', tests.today_a()), 'following',
     tests.orev(tests.occ('c-del', tests.today_a())), false)),
  'Deleted');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(tests.dates('c-del') = array[tests.today_a() - 2, tests.today_a() - 1],
  'The schedule ended the day before; nothing new is created');
-- An edit since then means the schedule changed: only the occurrences can come back.
select public.update_chore_series(tests.occ('c-del', tests.today_a() - 1), 'series',
  tests.orev(tests.occ('c-del', tests.today_a() - 1)), tests.srev('c-del'), false, p_set_minutes => true, p_minutes => 9);
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'schedule_changed' and options = array['restore_occurrences_only']
   from public.restore_trash_entries(array[tests.entry('chore_removal')])),
  'Restoring asks: the schedule changed since');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.entry('chore_removal')],
     jsonb_build_object(tests.entry('chore_removal')::text,
       'restore_occurrences_only'))),
  'Only the occurrences come back');
select tests.assert_true(cardinality(tests.dates('c-del')) = 4, 'All four dates are there again');
select tests.assert_true(
  (select outcome = 'deleted' and impact ->> 'scope' = 'series' and (impact ->> 'kept')::integer = 1
   from public.delete_chore_occurrences(tests.occ('c-del', tests.today_a()), 'series',
     tests.orev(tests.occ('c-del', tests.today_a())), false)),
  'Deleting the entire series keeps its history');
select tests.assert_true(
  (select count(*) = 1 from public.list_chores(tests.i('home-a'), true) where id = tests.i('c-del')),
  'The chore is listed as ended');
select tests.assert_true(
  (select count(*) = 1 from public.list_chore_history(tests.i('c-del'), 'completed')),
  'Its completed occurrence stays in its history');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_occurrences(tests.i('home-a')) where chore_id = tests.i('c-del')),
  'And nothing of it is outstanding');
select tests.assert_true(
  (select outcome = 'purged' from public.purge_trash_entries(array[tests.entry('chore_removal')])),
  'Purging the removal');
select tests.assert_true(
  tests.rows('c-del') = 1,
  'Leaves only the history');
-- A recurring chore without any history goes to the trash whole.
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-empty'), tests.i('home-a'), 'Mistake',
    '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a())),
  'A chore created by mistake');
select tests.assert_true(
  (select outcome = 'deleted' and impact ->> 'scope' = 'chore' from public.delete_chore_occurrences(
    tests.occ('c-empty', tests.today_a()), 'series', tests.orev(tests.occ('c-empty', tests.today_a())), false)),
  'Without history the whole chore goes to the trash');
select tests.assert_true(
  (select count(*) = 0 from public.list_chores(tests.i('home-a'), true) where id = tests.i('c-empty')),
  'It is not listed as ended');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.entry('chore')])),
  'And comes back whole');
select tests.assert_true(public.get_chore_occurrence(tests.occ('c-empty', tests.today_a())) is not null,
  'With its occurrence');

-- Category delete ----------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'preview' and chore_count = 2 from public.delete_chore_category(tests.i('cat-kitchen'),
    tests.category_rev('cat-kitchen'), true)),
  'The impact preview counts the chores using it');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_chore_category(tests.i('cat-kitchen'),
    tests.category_rev('cat-kitchen'), false)),
  'Deleted');
select tests.assert_true(
  (select (o -> 'chore' -> 'category') = 'null'::jsonb and o ->> 'closedCategory' = 'Kitchen'
   from public.get_chore_occurrence(tests.first_occ('c-dishes')) o),
  'Its chores are uncategorized; the closed record keeps the name');

-- Departure ------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-fixed'), tests.i('home-a'), 'Laundry',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a())),
  'A daily chore fixed on Carol');
select tests.act_as_owner();
delete from public.home_memberships where id = tests.i('m-carol-a');
select tests.act_as('alice');
select tests.assert_true(
  (select bool_and(needs_reassignment and cardinality(assignee_member_ids) = 0)
   from public.list_chore_occurrences(tests.i('home-a')) where chore_id = tests.i('c-fixed')),
  'Carol''s open occurrences are unassigned and flagged');
select tests.assert_true(
  (select (o -> 'completion' -> 'contributor' ->> 'member') is null and (o -> 'completion' -> 'contributor') is not null
   from public.get_chore_occurrence(tests.first_occ('c-dishes')) o),
  'Her completed record stays, as a former member');
select tests.assert_true(
  (select o -> 'schedule' -> 'members' = jsonb_build_array(null, tests.i('m-bob-a'))
     and (o -> 'schedule' ->> 'needsReassignment')::boolean
     and o -> 'schedule' -> 'next' -> 2 -> 'assignees' = '[]'::jsonb
   from public.get_chore_occurrence(tests.occ('c-rota', tests.today_a())) o),
  'Her rotation place stays empty, so the order does not shift and her turns are unassigned');
select tests.act_as_owner();
select tests.chore_shift_back('c-rota', 2);
select tests.act_as('alice');
select public.advance_chores(tests.i('home-a'));
select tests.assert_true(
  tests.flagged(tests.occ('c-rota', tests.today_a())),
  'A new occurrence on her turn is created unassigned and flagged');

-- Audit ----------------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) >= 1 from private.audit_events where action = 'chore_occurrence.completed'
     and details ->> 'forOther' = 'true'),
  'Completing for someone else is audited (ids and flags only)');
select tests.assert_true(
  not exists (select 1 from private.audit_events where action like 'chore%'
    and (details::text like '%Done%' or details::text like '%Away%' or details::text like '%Bins%')),
  'No note, reason or title reaches the audit log');
