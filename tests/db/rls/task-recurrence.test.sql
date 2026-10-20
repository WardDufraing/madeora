-- S19: recurring tasks (supabase/migrations/*_task_recurrence.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Carol is not in. Covers: nothing reachable
-- as a table; creating a series (any member; assignees by task managers; retries; invalid and ended
-- schedules; no back-fill); occurrences up to today plus one upcoming, created once however often
-- the pages advance, with a catch-up cap; missed occurrences stay open and overdue; occurrence
-- history (statuses, late completion, the actual completer, filters, paging, no future rows,
-- isolation); "this occurrence" edits mark it individually changed; "entire series" and "this and
-- following" edits with dry-run previews, kept and completed occurrences, a split chain and
-- schedule changes removing untouched off-schedule upcoming occurrences; rights (creator, task
-- manager, plain member, assignee, other Homes); deleting this, following and all occurrences, the
-- trash entry, restore (with series_changed and list_unavailable), purge keeping completed
-- history; pause and resume without back-fill; lists in use by a series; member departure; audit.
--
-- Time cannot move inside a test, so "days passing" is simulated by moving a whole chain's dates
-- back as the database owner (tests.shift_back).

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
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');

insert into ids select n, gen_random_uuid() from unnest(array[
  'l-a', 'l-a2', 'l-b', 'l-c', 'lbl-a', 's-daily', 's-weekly', 's-past', 's-carol', 's-b', 's-cap',
  's-pause', 's-del', 's-list', 's-later'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.today_b() returns date
  language sql stable as $$ select (now() at time zone 'Pacific/Auckland')::date; $$;
-- The occurrence of a chain on a date, its revision, and the chain head's revision.
create function tests.occ(p_root text, p_date date) returns uuid
  language sql stable security definer as $$
  select id from private.tasks where series_root_id = tests.i(p_root) and occurrence_date = p_date; $$;
create function tests.rev(p_task uuid) returns integer
  language sql stable security definer as $$ select revision from private.tasks where id = p_task; $$;
create function tests.srev(p_root text) returns integer
  language sql stable security definer as $$
  select revision from private.task_series
  where root_id = tests.i(p_root) and superseded_at is null; $$;
create function tests.occurrences(p_root text, p_open_only boolean default false) returns bigint
  language sql stable security definer as $$
  select count(*) from private.tasks where series_root_id = tests.i(p_root) and deleted_at is null
    and (not p_open_only or completed_at is null); $$;
-- Moves a chain p_days into the past, as if that many days had passed since it was set up.
create function tests.shift_back(p_root text, p_days integer) returns void
  language sql security definer as $$
  update private.task_series set starts_on = starts_on - p_days, active_from = active_from - p_days,
    ends_on = ends_on - p_days, until_date = until_date - p_days, next_date = next_date - p_days,
    last_date = last_date - p_days
  where root_id = tests.i(p_root);
  -- In two steps, so the one-occurrence-per-date index never sees two rows on one date midway.
  update private.tasks set occurrence_date = occurrence_date - p_days - 100000, due_date = due_date - p_days,
    start_date = start_date - p_days
  where series_root_id = tests.i(p_root);
  update private.tasks set occurrence_date = occurrence_date + 100000
  where series_root_id = tests.i(p_root);
  $$;
create function tests.dates(p_root text) returns date[]
  language sql stable security definer as $$
  select coalesce(array_agg(occurrence_date order by occurrence_date), '{}') from private.tasks
  where series_root_id = tests.i(p_root) and deleted_at is null; $$;
grant execute on function tests.dates(text), tests.i(text), tests.today_a(), tests.today_b(), tests.occ(text, date),
  tests.rev(uuid), tests.srev(text), tests.occurrences(text, boolean) to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.task_series', 'The API cannot read series');
select tests.assert_denied('select * from private.task_series_assignees', 'Nor their assignees');
select tests.assert_denied('select * from private.task_series_labels', 'Nor their labels');
select tests.assert_denied('select * from private.task_series_subtasks', 'Nor their checklists');
select tests.assert_denied('select * from private.task_series_removals', 'Nor removals');
select tests.assert_denied(
  $$select private.series_first_on_or_after('daily', 1, null, current_date, current_date)$$,
  'Nor the schedule helpers');
select tests.act_as_anon();
select tests.assert_denied('select public.advance_task_series()', 'Nobody signed out advances series');

-- Lists and a label ----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-a'), 'Chores', tests.i('home-a'))),
  'A Home list');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-a2'), 'Garden', tests.i('home-a'))),
  'A second Home list');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_label(tests.i('lbl-a'), 'Weekly', null, tests.i('home-a'))),
  'A Home label');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-b'), 'Kot', tests.i('home-b'))),
  'A list in Home B');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-c'), 'Mine')), 'A personal list');

-- Creating a series ----------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' and first_task_id is not null and revision = 1
    from public.create_task_series(tests.i('s-daily'), tests.i('l-a'), 'Water plants', 'daily', 1,
      tests.today_a(), p_label_ids => array[tests.i('lbl-a')], p_start_offset => 0,
      p_home_id => tests.i('home-a'))),
  'A plain Member creates a daily series in a Home');
select tests.assert_true(
  (select outcome = 'exists' and first_task_id = tests.occ('s-daily', tests.today_a())
    from public.create_task_series(tests.i('s-daily'), tests.i('l-a'), 'Water plants', 'daily', 1,
      tests.today_a(), p_home_id => tests.i('home-a'))),
  'A retry returns the same series and its first occurrence');
select tests.assert_true(tests.occurrences('s-daily') = 2, 'Today and one upcoming occurrence exist');
select tests.assert_true(
  (select count(*) = 2 from public.list_tasks(tests.i('home-a'), p_when => 'any')
    where recurring and title = 'Water plants'),
  'Both are listed as recurring tasks');
select tests.assert_true(
  (select (t -> 'series' ->> 'frequency') = 'daily' and (t ->> 'occurrenceDate')::date = tests.today_a()
     and (t -> 'series' -> 'can' ->> 'edit')::boolean
     and (t -> 'series' ->> 'nextDate')::date = tests.today_a() + 1
     and jsonb_array_length(t -> 'labels') = 1 and (t ->> 'startDate')::date = tests.today_a()
   from public.get_task(tests.occ('s-daily', tests.today_a())) t),
  'An occurrence knows its series, its scheduled date, labels and start offset');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'Assigned',
    'daily', 1, tests.today_a(), p_assignee_ids => array[tests.i('m-carol-a')], p_home_id => tests.i('home-a'))),
  'A plain Member cannot choose assignees');
select tests.assert_denied(
  $$select * from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'No days', 'weekly', 1,
    tests.today_a(), p_home_id => tests.i('home-a'))$$,
  'A weekly series needs weekdays', '22023');
select tests.assert_denied(
  $$select * from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'Days', 'daily', 1,
    tests.today_a(), p_weekdays => '{1}', p_home_id => tests.i('home-a'))$$,
  'Weekdays only for weekly series', '22023');
select tests.assert_denied(
  $$select * from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'Zero', 'daily', 0,
    tests.today_a(), p_home_id => tests.i('home-a'))$$,
  'An interval of zero is refused', '22023');
select tests.assert_denied(
  $$select * from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'Count', 'daily', 1,
    tests.today_a(), p_max_count => 1000, p_home_id => tests.i('home-a'))$$,
  'More than 999 occurrences is refused', '22023');
select tests.assert_true(
  (select outcome = 'ended' from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'Long ago',
    'daily', 1, tests.today_a() - 20, p_ends_on => tests.today_a() - 10, p_home_id => tests.i('home-a'))),
  'A schedule whose every date has passed creates nothing');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-past'), tests.i('l-a'), 'Feed cat',
    'daily', 1, tests.today_a() - 5, p_home_id => tests.i('home-a'))),
  'A series may start in the past');
select tests.assert_true(tests.dates('s-past') = array[tests.today_a(), tests.today_a() + 1],
  'But nothing is back-filled: it starts today');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.create_task_series(gen_random_uuid(), tests.i('l-b'), 'Sneak',
    'daily', 1, tests.today_a(), p_home_id => tests.i('home-a'))),
  'Another Home''s list is unavailable');
select tests.assert_true(
  (select outcome = 'invalid_label' from public.create_task_series(gen_random_uuid(), tests.i('l-a'), 'Label',
    'daily', 1, tests.today_a(), p_label_ids => array[gen_random_uuid()], p_home_id => tests.i('home-a'))),
  'Labels must be the context''s');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-weekly'), tests.i('l-a'), 'Bins out',
    'weekly', 1, tests.today_a(), p_weekdays => array[extract(isodow from tests.today_a())::smallint],
    p_max_count => 3, p_assignee_ids => array[tests.i('m-carol-a')], p_home_id => tests.i('home-a'))),
  'The Owner creates a weekly series of three, assigned to Carol');
select tests.assert_true(
  (public.get_task(tests.occ('s-weekly', tests.today_a())) -> 'assignees') = jsonb_build_array(tests.i('m-carol-a')),
  'Its first occurrence is assigned to Carol');
select tests.assert_true(tests.occurrences('s-weekly') = 2, 'This week and next week exist');

-- Personal series ------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-carol'), tests.i('l-c'), 'Stretch',
    'daily', 2, (now() at time zone 'UTC')::date, p_today => (now() at time zone 'UTC')::date)),
  'Carol creates a personal series');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.create_task_series(gen_random_uuid(), tests.i('l-c'), 'Mine',
    'daily', 1, (now() at time zone 'UTC')::date, p_assignee_ids => array[tests.i('m-carol-a')])),
  'A personal series has no assignees');
select tests.act_as('alice');
select tests.assert_true(
  public.get_task(tests.occ('s-carol', (now() at time zone 'UTC')::date)) is null,
  'Alice cannot read Carol''s personal occurrence');
select tests.assert_true(
  (select count(*) = 0 from public.list_task_occurrences(tests.occ('s-carol', (now() at time zone 'UTC')::date))),
  'Nor its history');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_task_series(
    tests.occ('s-carol', (now() at time zone 'UTC')::date), 'series', 1, 1, false,
    p_set_content => true, p_title => 'Mine now', p_label_ids => '{}')),
  'Nor change the series');
select tests.assert_true(public.advance_task_series() = 0, 'Advancing her own Personal space touches nothing of Carol''s');

-- Another Home -----------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-b'), tests.i('l-b'), 'Recycling',
    'daily', 1, tests.today_b(), p_home_id => tests.i('home-b'))),
  'Bob creates a series in Home B (its own timezone decides "today")');
select tests.assert_true((tests.dates('s-b'))[1] = tests.today_b(), 'Its first occurrence is today in Auckland');
select tests.act_as('carol');
select tests.assert_denied($$select public.advance_task_series(tests.i('home-b'))$$,
  'Carol cannot advance a Home she is not in');
select tests.assert_true(public.get_task(tests.occ('s-b', tests.today_b())) is null, 'Nor read its occurrences');
select tests.assert_true(
  (select outcome = 'not_found' from public.delete_task_series(tests.occ('s-b', tests.today_b()), 'series', 1, true)),
  'Nor preview deleting it');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_task_series_paused(tests.occ('s-b', tests.today_b()), true, 1)),
  'Nor pause it');

-- Days pass: catching up, missed occurrences ------------------------------------------------------------

select tests.act_as_owner();
select tests.shift_back('s-daily', 3);
select tests.act_as('carol');
select tests.assert_true(public.advance_task_series(tests.i('home-a')) = 3, 'Three days later the page creates three');
select tests.assert_true(tests.occurrences('s-daily') = 5, 'Five occurrences: three days ago up to tomorrow');
select tests.assert_true(public.advance_task_series(tests.i('home-a')) = 0, 'Advancing again creates nothing');
select tests.assert_true(
  (select count(*) = 3 from public.list_tasks(tests.i('home-a'), p_when => 'overdue') where title = 'Water plants'),
  'The three missed occurrences stay open and overdue');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-cap'), tests.i('l-a2'), 'Long trip',
    'daily', 1, tests.today_a(), p_home_id => tests.i('home-a'))),
  'A series for the catch-up cap');
select tests.act_as_owner();
select tests.shift_back('s-cap', 150);
select tests.act_as('alice');
select public.advance_task_series(tests.i('home-a'));
select tests.assert_true(tests.occurrences('s-cap') = 102, 'At most 100 are created per series and call');
select public.advance_task_series(tests.i('home-a'));
select tests.assert_true(tests.occurrences('s-cap') = 152, 'The next call finishes: up to today plus one');
select tests.assert_true(
  (select count(distinct d) = 152 from unnest(tests.dates('s-cap')) d), 'One occurrence per date');

-- History ----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'completed' from public.set_task_completion(tests.occ('s-daily', tests.today_a() - 3), true)),
  'Carol completes the occurrence of three days ago today');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'completed' from public.set_task_completion(tests.occ('s-daily', tests.today_a()), true)),
  'Alice completes today''s for everyone');
select tests.assert_true(
  (select outcome = 'already_completed' from public.set_task_completion(tests.occ('s-daily', tests.today_a()), true)),
  'A second completion is not recorded again');
select tests.assert_true(
  (select array_agg(status order by occurrence_date desc) = array['completed', 'missed', 'missed', 'completed_late']
     and bool_and(total_count = 4)
   from public.list_task_occurrences(tests.occ('s-daily', tests.today_a()))),
  'History: newest first, today completed, two missed, one completed late; nothing in the future');
select tests.assert_true(
  (select completed_by_member = tests.i('m-carol-a') and not completed_by_me and not is_current
   from public.list_task_occurrences(tests.occ('s-daily', tests.today_a())) where status = 'completed_late'),
  'The actual completer is named once, by membership id');
select tests.assert_true(
  (select completed_by_me and is_current
   from public.list_task_occurrences(tests.occ('s-daily', tests.today_a())) where status = 'completed'),
  'And the viewer''s own completion says so');
select tests.assert_true(
  (select count(*) = 2 from public.list_task_occurrences(tests.occ('s-daily', tests.today_a()), 'missed')),
  'The missed filter');
select tests.assert_true(
  (select count(*) = 2 and bool_and(total_count = 2)
   from public.list_task_occurrences(tests.occ('s-daily', tests.today_a()), 'completed')),
  'The completed filter');
select tests.assert_true(
  (select count(*) = 1 and bool_and(total_count = 4)
   from public.list_task_occurrences(tests.occ('s-daily', tests.today_a()), 'all', 3, 1)),
  'Paging keeps the total');
select tests.assert_true(
  (select count(*) = 0 from public.list_task_occurrences(tests.occ('s-weekly', tests.today_a()))
    where occurrence_date > tests.today_a()),
  'Forecast occurrences are never history');
select tests.assert_denied(
  $$select * from public.list_task_occurrences(tests.occ('s-daily', tests.today_a()), 'skipped')$$,
  'Tasks have no skipped filter', '22023');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 4 from public.list_task_occurrences(tests.occ('s-daily', tests.today_a()))),
  'Every member of the Home sees the history');

-- Rights ----------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_task_series(tests.occ('s-daily', tests.today_a() + 1),
    'series', tests.rev(tests.occ('s-daily', tests.today_a() + 1)), tests.srev('s-daily'), true,
    p_set_content => true, p_title => 'Bob was here', p_label_ids => '{}')),
  'An Administrator without manageHomeTasks cannot change another member''s series');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_task_series(tests.occ('s-daily', tests.today_a() + 1),
    'series', tests.srev('s-daily'), true)),
  'Nor delete it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_task_series_paused(tests.occ('s-daily', tests.today_a() + 1),
    true, tests.srev('s-daily'))),
  'Nor pause it');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_task_series(tests.occ('s-weekly', tests.today_a()),
    'series', tests.rev(tests.occ('s-weekly', tests.today_a())), tests.srev('s-weekly'), true,
    p_set_content => true, p_title => 'Bins', p_label_ids => '{}')),
  'An assignee cannot change the whole series');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task(tests.occ('s-weekly', tests.today_a()),
    tests.rev(tests.occ('s-weekly', tests.today_a())), 'Bins out (green)', '{}', null, null,
    tests.today_a())),
  'But edits her own occurrence (this occurrence only)');
select tests.act_as_owner();
select tests.assert_true(
  (select detached from private.tasks where id = tests.occ('s-weekly', tests.today_a())),
  'Which marks it changed on its own');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_task_series(tests.occ('s-daily', tests.today_a() + 1),
    'series', tests.rev(tests.occ('s-daily', tests.today_a() + 1)), tests.srev('s-daily'), true,
    p_assignee_ids => array[tests.i('m-carol-a')])),
  'The series'' creator cannot set its assignees without being a task manager');

-- This occurrence, then the entire series ---------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task(tests.occ('s-daily', tests.today_a() + 1),
    tests.rev(tests.occ('s-daily', tests.today_a() + 1)), 'Water plants (balcony too)', array[tests.i('lbl-a')],
    null, tests.today_a() + 1, tests.today_a() + 1)),
  'Carol changes tomorrow''s occurrence on its own');
select tests.assert_true(
  (select outcome = 'conflict' and revision = tests.srev('s-daily')
    from public.update_task_series(tests.occ('s-daily', tests.today_a() - 1), 'series',
      tests.rev(tests.occ('s-daily', tests.today_a() - 1)), tests.srev('s-daily') + 1, true,
      p_set_content => true, p_title => 'Water', p_label_ids => '{}')),
  'A stale series revision answers conflict');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'scope') = 'series' and (impact ->> 'updated')::integer = 2
     and (impact ->> 'kept')::integer = 1 and (impact ->> 'completed')::integer = 2
     and (impact ->> 'removed')::integer = 0
    from public.update_task_series(tests.occ('s-daily', tests.today_a() - 1), 'series',
      tests.rev(tests.occ('s-daily', tests.today_a() - 1)), tests.srev('s-daily'), true,
      p_set_content => true, p_title => 'Water the plants', p_priority => 'high', p_label_ids => '{}')),
  'The preview: two open occurrences change, the changed one is kept, two completed stay');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 0 from private.tasks where series_root_id = tests.i('s-daily') and title = 'Water the plants'),
  'Nothing at all');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2
    from public.update_task_series(tests.occ('s-daily', tests.today_a() - 1), 'series',
      tests.rev(tests.occ('s-daily', tests.today_a() - 1)), 1, false,
      p_set_content => true, p_title => 'Water the plants', p_priority => 'high', p_label_ids => '{}')),
  'Applying it');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.tasks where series_root_id = tests.i('s-daily') and title = 'Water the plants'
     and priority = 'high' and completed_at is null),
  'The two open, unchanged occurrences took the change');
select tests.assert_true(
  (select title = 'Water plants (balcony too)' from private.tasks where id = tests.occ('s-daily', tests.today_a() + 1)),
  'The individually changed one kept its own');
select tests.assert_true(
  (select bool_and(title = 'Water plants') from private.tasks
    where series_root_id = tests.i('s-daily') and completed_at is not null),
  'Completed occurrences were not rewritten');
select tests.assert_true(
  (select not exists (select 1 from private.task_label_links k join private.tasks t on t.id = k.task_id
     where t.series_root_id = tests.i('s-daily') and t.completed_at is null and not t.detached)),
  'The removed label left the changed occurrences');
select tests.shift_back('s-daily', 2);
select tests.act_as('carol');
select public.advance_task_series(tests.i('home-a'));
select tests.assert_true(
  (select g ->> 'title' = 'Water the plants' and g ->> 'priority' = 'high'
   from public.get_task(tests.occ('s-daily', tests.today_a() + 1)) g),
  'New occurrences come from the changed template');

-- This and following -------------------------------------------------------------------------------------

-- Chain s-daily now: today-5 (completed late), today-4 (open), today-3 (open), today-2 (completed),
-- today-1 (changed on its own), today, today+1.
select tests.act_as_owner();
insert into ids select 'split-at', tests.occ('s-daily', tests.today_a());
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'scope') = 'following' and (impact ->> 'updated')::integer = 2
     and (impact ->> 'completed')::integer = 0
    from public.update_task_series(tests.i('split-at'), 'following', tests.rev(tests.i('split-at')),
      tests.srev('s-daily'), true, p_set_content => true, p_title => 'Water (new pots)', p_priority => 'low',
      p_label_ids => array[tests.i('lbl-a')], p_list_id => tests.i('l-a2'))),
  'Preview of this and following: today and tomorrow');
select tests.assert_true(
  (select outcome = 'saved' and task_id = tests.i('split-at')
    from public.update_task_series(tests.i('split-at'), 'following', tests.rev(tests.i('split-at')),
      tests.srev('s-daily'), false, p_set_content => true, p_title => 'Water (new pots)', p_priority => 'low',
      p_label_ids => array[tests.i('lbl-a')], p_list_id => tests.i('l-a2'))),
  'Applying it splits the series');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 and count(*) filter (where superseded_at is not null) = 1
     and bool_and(created_by = tests.user_id('carol'))
   from private.task_series where root_id = tests.i('s-daily')),
  'Two parts of one chain, the old one superseded, both Carol''s');
select tests.assert_true(
  (select until_date = tests.today_a() - 1 and next_date is null from private.task_series
    where root_id = tests.i('s-daily') and superseded_at is not null),
  'The old part ends yesterday');
select tests.assert_true(
  (select count(*) = 2 and bool_and(t.title = 'Water (new pots)' and t.list_id = tests.i('l-a2'))
   from private.tasks t join private.task_series s on s.id = t.series_id
   where t.series_root_id = tests.i('s-daily') and s.superseded_at is null),
  'Today and tomorrow moved to the new part with the change');
select tests.assert_true(
  (select title = 'Water the plants' from private.tasks where id = tests.occ('s-daily', tests.today_a() - 4)),
  'Earlier occurrences are unchanged');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 6 from public.list_task_occurrences(tests.i('split-at'))),
  'History spans the whole chain');
select tests.assert_true(
  (select outcome = 'scope_unavailable' from public.update_task_series(
    tests.occ('s-daily', tests.today_a() - 4), 'following', tests.rev(tests.occ('s-daily', tests.today_a() - 4)),
    tests.srev('s-daily'), true, p_set_content => true, p_title => 'Old part', p_label_ids => '{}')),
  'This and following is offered only on the current part');

-- Changing the schedule ---------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-list'), tests.i('l-a'), 'Every day',
    'daily', 1, tests.today_a(), p_home_id => tests.i('home-a'))),
  'A daily series to reschedule');
select tests.act_as_owner();
-- Tomorrow's occurrence gets a comment: touched, so a schedule change keeps it.
insert into private.task_comments (id, task_id, author_id, body)
  values (gen_random_uuid(), tests.occ('s-list', tests.today_a() + 1), tests.user_id('alice'), 'Mind the roses');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'kept')::integer = 1 and (impact ->> 'removed')::integer = 0
     and jsonb_array_length(impact -> 'nextDates') = 5
     and (impact -> 'nextDates' ->> 0)::date = tests.today_a()
     and (impact -> 'nextDates' ->> 1)::date = tests.today_a() + 3
    from public.update_task_series(tests.occ('s-list', tests.today_a()), 'series',
      tests.rev(tests.occ('s-list', tests.today_a())), tests.srev('s-list'), true,
      p_set_schedule => true, p_frequency => 'daily', p_interval => 3, p_starts_on => tests.today_a())),
  'Every third day: the commented upcoming occurrence is kept, the next dates follow the new rhythm');
select tests.act_as_owner();
delete from private.task_comments where task_id = tests.occ('s-list', tests.today_a() + 1);
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'removed')::integer = 1 and (impact ->> 'kept')::integer = 0
    from public.update_task_series(tests.occ('s-list', tests.today_a()), 'series',
      tests.rev(tests.occ('s-list', tests.today_a())), tests.srev('s-list'), false,
      p_set_schedule => true, p_frequency => 'daily', p_interval => 3, p_starts_on => tests.today_a())),
  'Without the comment, the untouched upcoming occurrence is removed');
select tests.assert_true(tests.dates('s-list') = array[tests.today_a(), tests.today_a() + 3],
  'Today stays, the next one is in three days');
select tests.assert_true(
  (select outcome = 'ended' from public.update_task_series(tests.occ('s-list', tests.today_a()), 'series',
    tests.rev(tests.occ('s-list', tests.today_a())), tests.srev('s-list'), false,
    p_set_schedule => true, p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() - 9,
    p_ends_on => tests.today_a() - 1)),
  'A schedule that ended already is refused');
select tests.assert_denied(
  $$select * from public.update_task_series(tests.occ('s-list', tests.today_a()), 'series',
    tests.rev(tests.occ('s-list', tests.today_a())), tests.srev('s-list'), false,
    p_set_schedule => true, p_frequency => 'monthly', p_interval => 1, p_weekdays => '{1}',
    p_starts_on => tests.today_a())$$,
  'An invalid schedule is refused', '22023');

-- Moving the start later (S19 review H1 and H2) --------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-later'), tests.i('l-a'), 'Feed the fish',
    'daily', 1, tests.today_a(), p_home_id => tests.i('home-a'))),
  'A daily series whose start will move later');
select tests.act_as_owner();
select tests.shift_back('s-later', 2);
select tests.act_as('alice');
select public.advance_task_series(tests.i('home-a'));
select tests.assert_true(
  tests.dates('s-later') = array[tests.today_a() - 2, tests.today_a() - 1, tests.today_a(), tests.today_a() + 1],
  'Two days later: two missed, today and tomorrow');
select tests.assert_true(
  (select outcome = 'preview' and (impact -> 'nextDates' ->> 0)::date = tests.today_a() + 10
    from public.update_task_series(tests.occ('s-later', tests.today_a()), 'series',
      tests.rev(tests.occ('s-later', tests.today_a())), tests.srev('s-later'), true,
      p_set_schedule => true, p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() + 10)),
  'The preview of a start moved past the next pending date works');
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'removed')::integer = 1
    from public.update_task_series(tests.occ('s-later', tests.today_a()), 'series',
      tests.rev(tests.occ('s-later', tests.today_a())), tests.srev('s-later'), false,
      p_set_schedule => true, p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a() + 10)),
  'Moving the start past the next pending date saves');
select tests.assert_true(
  tests.dates('s-later') = array[tests.today_a() - 2, tests.today_a() - 1, tests.today_a(), tests.today_a() + 10],
  'The past and today stay, tomorrow is gone, the new start is the next occurrence');
select tests.assert_true(
  (select outcome = 'preview' and impact ->> 'scope' = 'following'
    from public.update_task_series(tests.occ('s-later', tests.today_a() - 1), 'following',
      tests.rev(tests.occ('s-later', tests.today_a() - 1)), tests.srev('s-later'), true,
      p_set_content => true, p_title => 'Feed the fish well', p_label_ids => '{}')),
  'This and following from an occurrence before the new start can be previewed');
select tests.assert_true(
  (select outcome = 'saved' and impact ->> 'scope' = 'following' and (impact ->> 'updated')::integer = 3
    from public.update_task_series(tests.occ('s-later', tests.today_a() - 1), 'following',
      tests.rev(tests.occ('s-later', tests.today_a() - 1)), tests.srev('s-later'), false,
      p_set_content => true, p_title => 'Feed the fish well', p_label_ids => '{}')),
  'This and following from an occurrence before the new start splits the series');
select tests.act_as_owner();
select tests.assert_true(
  (select array_agg(title order by occurrence_date) = array['Feed the fish', 'Feed the fish well',
     'Feed the fish well', 'Feed the fish well']
    from private.tasks where series_root_id = tests.i('s-later')),
  'The earlier occurrence keeps its title, this and the later ones carry the change');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' and (impact ->> 'removed')::integer = 3
    from public.delete_task_series(tests.occ('s-later', tests.today_a() - 1), 'following',
      tests.srev('s-later'), false)),
  'Removing this and following from an occurrence before the part''s start works');
select tests.assert_true(tests.dates('s-later') = array[tests.today_a() - 2],
  'Only the earlier occurrence is left outside the trash');

-- Lists used by a series ----------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'has_open_tasks' from public.update_task_list(tests.i('l-a'),
    (select revision from public.list_task_lists(tests.i('home-a')) where id = tests.i('l-a')), 'Chores', true)),
  'Open occurrences keep the list from being archived');
select tests.act_as_owner();
update private.tasks set completed_at = now(), completed_by = tests.user_id('alice')
  where list_id = tests.i('l-a') and completed_at is null;
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'has_series' and open_tasks >= 1 from public.update_task_list(tests.i('l-a'),
    (select revision from public.list_task_lists(tests.i('home-a')) where id = tests.i('l-a')), 'Chores', true)),
  'And so does a series that creates occurrences into it');
select tests.act_as_owner();
update private.tasks set deleted_at = now() where list_id = tests.i('l-a');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'has_series' from public.delete_task_list(tests.i('l-a'),
    (select revision from public.list_task_lists(tests.i('home-a')) where id = tests.i('l-a')))),
  'Deleting it is refused too');
select tests.act_as_owner();
update private.tasks set deleted_at = null where list_id = tests.i('l-a');
update private.tasks set completed_at = null, completed_by = null
  where list_id = tests.i('l-a') and completed_by = tests.user_id('alice') and series_root_id <> tests.i('s-daily');

-- Deleting one occurrence -----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-del'), tests.i('l-a2'), 'Sweep',
    'daily', 1, tests.today_a(), p_home_id => tests.i('home-a'))),
  'A daily series to delete from');
insert into ids select 'e-one', entry_id from public.delete_task(tests.occ('s-del', tests.today_a() + 1))
  where outcome = 'deleted';
select tests.assert_true(tests.i('e-one') is not null, 'One occurrence goes to the trash on its own');
select tests.act_as_owner();
select tests.shift_back('s-del', 1);
select tests.act_as('alice');
select public.advance_task_series(tests.i('home-a'));
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.tasks where series_root_id = tests.i('s-del') and occurrence_date = tests.today_a()
     and deleted_at is not null)
  and (select count(*) = 1 from private.tasks where series_root_id = tests.i('s-del')
     and occurrence_date = tests.today_a() + 1 and deleted_at is null),
  'A day later it is not created again; the next one is');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-one')])),
  'It can be restored on its own');

-- Deleting this and following -------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'completed' from public.set_task_completion(tests.occ('s-del', tests.today_a() - 1), true)),
  'Yesterday''s is completed');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'scope') = 'following' and (impact ->> 'removed')::integer = 2
    from public.delete_task_series(tests.occ('s-del', tests.today_a()), 'following', tests.srev('s-del'), true)),
  'Preview: today and tomorrow would go');
insert into ids select 'e-fol', entry_id from public.delete_task_series(tests.occ('s-del', tests.today_a()),
  'following', tests.srev('s-del'), false) where outcome = 'deleted';
select tests.assert_true(tests.i('e-fol') is not null, 'Removing this and following makes one trash entry');
select tests.act_as_owner();
select tests.assert_true(
  (select until_date = tests.today_a() - 1 and next_date is null from private.task_series
    where root_id = tests.i('s-del')),
  'The series ends yesterday');
select tests.assert_true(
  (select count(*) = 2 from private.tasks where series_root_id = tests.i('s-del') and deleted_at is not null)
  and (select completed_at is not null and deleted_at is null from private.tasks
    where id = tests.occ('s-del', tests.today_a() - 1)),
  'Today and tomorrow are in the trash; the completed one stays');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.list_trash(tests.i('home-a')) where entry_id = tests.i('e-fol')
     and module = 'tasks' and item_type = 'task_series_removal' and label = 'Sweep'),
  'The trash lists it once, by title');
select tests.assert_true(public.advance_task_series(tests.i('home-a')) = 0, 'Nothing is created after the end');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-fol')])),
  'Restoring it');
select tests.act_as_owner();
select tests.assert_true(
  (select until_date is null and next_date is not null from private.task_series where root_id = tests.i('s-del'))
  and tests.occurrences('s-del', true) = 2,
  'Brings back the occurrences and the open end');

-- The series changed meanwhile: only the occurrences come back.
select tests.act_as('alice');
insert into ids select 'e-fol2', entry_id from public.delete_task_series(tests.occ('s-del', tests.today_a()),
  'following', tests.srev('s-del'), false) where outcome = 'deleted';
select tests.assert_true(
  (select outcome = 'saved' from public.update_task_series(tests.occ('s-del', tests.today_a() - 1), 'series',
    tests.rev(tests.occ('s-del', tests.today_a() - 1)), tests.srev('s-del'), false,
    p_set_content => true, p_title => 'Sweep the yard', p_label_ids => '{}')),
  'The series is changed after the removal');
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'series_changed' and options = array['restore_tasks_only']
    from public.restore_trash_entries(array[tests.i('e-fol2')])),
  'Restoring now reports the change');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-fol2')],
    jsonb_build_object(tests.i('e-fol2'), 'restore_tasks_only'))),
  'Bringing back only the occurrences');
select tests.act_as_owner();
select tests.assert_true(
  tests.occurrences('s-del', true) = 2
  and (select until_date = tests.today_a() - 1 from private.task_series where root_id = tests.i('s-del')),
  'They are back; the series keeps its end');

-- Deleting the entire series, restoring, purging ------------------------------------------------------------

select tests.act_as('alice');
insert into ids select 'e-all', entry_id from public.delete_task_series(tests.occ('s-del', tests.today_a()),
  'series', tests.srev('s-del'), false) where outcome = 'deleted';
select tests.assert_true(tests.i('e-all') is not null, 'The entire series goes to the trash');
select tests.assert_true(
  (select public.get_task(tests.occ('s-del', tests.today_a() - 1)) -> 'series' = 'null'::jsonb
     and (public.get_task(tests.occ('s-del', tests.today_a() - 1)) ->> 'completedAt') is not null),
  'Its completed occurrence stays, no longer part of an active series');
select tests.act_as_owner();
select tests.assert_true(tests.occurrences('s-del', true) = 0, 'No open occurrence is left');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-all')])),
  'Restoring the entire series');
select tests.act_as_owner();
select tests.assert_true(
  (select deleted_at is null from private.task_series where root_id = tests.i('s-del'))
  and tests.occurrences('s-del', true) = 2,
  'The series and its open occurrences are back');
select tests.act_as('alice');
insert into ids select 'e-all2', entry_id from public.delete_task_series(tests.occ('s-del', tests.today_a()),
  'series', tests.srev('s-del'), false) where outcome = 'deleted';
select tests.assert_true(
  (select outcome = 'purged' from public.purge_trash_entries(array[tests.i('e-all2')])), 'Purging it');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.task_series where root_id = tests.i('s-del'))
  and not exists (select 1 from private.tasks where series_root_id = tests.i('s-del')),
  'Removes the series and its open occurrences for good');
select tests.assert_true(
  (select count(*) = 1 from private.tasks where title = 'Sweep' and completed_at is not null and series_id is null),
  'The completed occurrence remains as a completed task');

-- Pause and resume -------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_series(tests.i('s-pause'), tests.i('l-a2'), 'Mop',
    'daily', 1, tests.today_a(), p_home_id => tests.i('home-a'))),
  'A series to pause');
select tests.assert_true(
  (select outcome = 'saved' from public.set_task_series_paused(tests.occ('s-pause', tests.today_a()), true,
    tests.srev('s-pause'))),
  'Pausing it');
select tests.act_as_owner();
select tests.shift_back('s-pause', 4);
select tests.act_as('alice');
select public.advance_task_series(tests.i('home-a'));
select tests.assert_true(tests.occurrences('s-pause') = 2, 'Nothing is created while paused');
select tests.assert_true(
  (public.get_task(tests.occ('s-pause', tests.today_a() - 4)) -> 'series' ->> 'paused')::boolean,
  'It reads as paused');
select tests.assert_true(
  (select outcome = 'saved' from public.set_task_series_paused(tests.occ('s-pause', tests.today_a() - 4), false,
    tests.srev('s-pause'))),
  'Resuming it');
select tests.act_as_owner();
select tests.assert_true(
  (select array_agg(occurrence_date order by occurrence_date)
     = array[tests.today_a() - 4, tests.today_a() - 3, tests.today_a(), tests.today_a() + 1]
   from private.tasks where series_root_id = tests.i('s-pause')),
  'Resuming continues from today: the days paused are not created');

-- Member departure -----------------------------------------------------------------------------------------

select tests.act_as_owner();
update private.tasks set completed_at = now(), completed_by = tests.user_id('carol')
  where id = (select id from private.tasks where series_root_id = tests.i('s-weekly')
    order by occurrence_date limit 1);
delete from public.home_memberships
  where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.assert_true(
  (select needs_reassignment from private.task_series where root_id = tests.i('s-weekly'))
  and not exists (select 1 from private.task_series_assignees a join private.task_series s on s.id = a.series_id
    where s.root_id = tests.i('s-weekly')),
  'The leaver''s series assignment ends and the series is flagged');
select tests.assert_true(
  (select bool_and(needs_reassignment) from private.tasks
    where series_root_id = tests.i('s-weekly') and completed_at is null),
  'Its open occurrences are flagged');
select tests.shift_back('s-weekly', 7);
select tests.act_as('alice');
select public.advance_task_series(tests.i('home-a'));
select tests.act_as_owner();
select tests.assert_true(
  (select t.needs_reassignment and not exists (select 1 from private.task_assignees a where a.task_id = t.id)
   from private.tasks t where t.id = tests.occ('s-weekly', tests.today_a() + 7)),
  'The new (third and last) occurrence comes unassigned and flagged');
select tests.act_as('alice');
select tests.assert_true(
  (select completed_by_member is null and not completed_by_me
   from public.list_task_occurrences(tests.occ('s-weekly', tests.today_a() + 7), 'completed')),
  'The departed completer is named by nobody, the completion stays');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task_series(tests.occ('s-weekly', tests.today_a() + 7), 'series',
    tests.rev(tests.occ('s-weekly', tests.today_a() + 7)), tests.srev('s-weekly'), false,
    p_assignee_ids => array[tests.i('m-bob-a')])),
  'The Owner sets new series assignees');
select tests.act_as_owner();
select tests.assert_true(
  not (select needs_reassignment from private.task_series where root_id = tests.i('s-weekly')),
  'Which clears the flag');

-- Audit -------------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select count(*) >= 5 from private.audit_events
    where home_id = tests.i('home-a') and subject_type = 'task_series'
      and action in ('task_series.created', 'task_series.updated', 'task_series.removed',
        'task_series.paused', 'task_series.resumed')),
  'Series changes are audited');
select tests.assert_true(
  not exists (select 1 from private.audit_events where subject_type = 'task_series'
    and (details::text like '%Water%' or details::text like '%Sweep%')),
  'Without titles');
