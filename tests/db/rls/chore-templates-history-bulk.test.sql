-- S20: chore templates, the Home-wide chore history, bulk occurrence actions and the chore widgets'
-- reads (supabase/migrations/*_chore_templates_history_bulk.sql). Alice owns Home A, where Bob is an
-- Administrator (granted manageHomeChores) and Carol a Member; Bob owns Home B. Covers: templates
-- for chore managers only, with validation, retries, unique titles, retiring and an archived
-- category; the history with search (LIKE characters taken literally), member, chore, date, state
-- and approval filters, the completed basis and paging; bulk reassign, due date and skip with a
-- preview that changes nothing, per-occurrence results (stale, closed, pending, other Home) and
-- non-managers refused; the widget reads by view and state; isolation everywhere.

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
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m,
  unnest(array['alice', 'bob', 'carol']) u
  where m.home_id = (select id from ids where name = 'home-a') and m.user_id = tests.user_id(u);
insert into ids select 'm-bob-b', m.id from public.home_memberships m
  where m.home_id = (select id from ids where name = 'home-b') and m.user_id = tests.user_id('bob');
insert into ids select n, gen_random_uuid() from unnest(array[
  't-bath', 'cat-wet', 'c-dishes', 'c-floor', 'c-pct', 'c-late', 'c-check', 'c-b']) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.orev(p_chore text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_occurrences where id = tests.occ(p_chore); $$;
create function tests.trev(p_template text) returns integer
  language sql stable security definer as $$
  select revision from private.chore_templates where id = tests.i(p_template); $$;
create function tests.item(p_chore text) returns jsonb
  language sql stable security definer as $$
  select jsonb_build_object('id', tests.occ(p_chore), 'revision', tests.orev(p_chore)); $$;
create function tests.ostatus(p_chore text) returns text
  language sql stable security definer as $$
  select status from private.chore_occurrences where id = tests.occ(p_chore); $$;
create function tests.odue(p_chore text) returns date
  language sql stable security definer as $$
  select due_date from private.chore_occurrences where id = tests.occ(p_chore); $$;
create function tests.oassignees(p_chore text) returns text
  language sql stable security definer as $$
  select coalesce(string_agg(u.name, ',' order by u.name), '') from private.chore_occurrence_assignees a,
    unnest(array['alice', 'bob', 'carol']) u (name)
  where a.occurrence_id = tests.occ(p_chore) and a.user_id = tests.user_id(u.name); $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable ---------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied('select * from private.chore_templates', 'The API cannot read templates');
select tests.assert_denied($$select private.chore_template_limit()$$, 'Nor the private helpers');

-- Templates ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeChores']) = 'ok',
  'The Owner makes Bob a chore manager');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore_category(tests.i('cat-wet'), tests.i('home-a'), 'Wet rooms', 'teal')),
  'A category to use');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_chore_template(tests.i('t-bath'), tests.i('home-a'), 'Bathroom')),
  'A Member cannot create templates');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_templates(tests.i('home-a'))),
  'Nor see them');
select tests.act_as('bob');
select tests.assert_denied(
  format($$select * from public.create_chore_template(gen_random_uuid(), %L, '  ')$$, tests.i('home-a')),
  'A template needs a title', '22023');
select tests.assert_denied(
  format($$select * from public.create_chore_template(gen_random_uuid(), %L, 'X',
    p_steps => '[{"id": "%s", "label": "A", "mandatory": true}]')$$, tests.i('home-a'), gen_random_uuid()),
  'Template steps carry no ids', '22023');
select tests.assert_denied(
  format($$select * from public.create_chore_template(gen_random_uuid(), %L, 'X', p_minutes => 0)$$, tests.i('home-a')),
  'An estimate is positive', '22023');
select tests.assert_true(
  (select outcome = 'invalid_category' from public.create_chore_template(gen_random_uuid(), tests.i('home-a'),
    'X', p_category_id => gen_random_uuid())),
  'A category of no Home is refused');
select tests.assert_true(
  (select outcome = 'created' and revision = 1 from public.create_chore_template(tests.i('t-bath'), tests.i('home-a'),
    'Bathroom', 'Top to bottom', tests.i('cat-wet'), 30,
    '[{"label": "Mirror", "mandatory": false}, {"label": "Toilet", "mandatory": true}]')),
  'A chore manager creates a template');
select tests.assert_true(
  (select outcome = 'exists' from public.create_chore_template(tests.i('t-bath'), tests.i('home-a'), 'Bathroom')),
  'A retry is told it exists');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.create_chore_template(gen_random_uuid(), tests.i('home-a'), 'BATHROOM')),
  'Titles are unique per Home, whatever the case');
select tests.assert_true(
  (select title = 'Bathroom' and category_name = 'Wet rooms' and minutes = 30 and not retired
     and steps = '[{"label": "Mirror", "mandatory": false}, {"label": "Toilet", "mandatory": true}]'::jsonb
   from public.list_chore_templates(tests.i('home-a'))),
  'It lists with its fields and checklist');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'id_taken' from public.create_chore_template(tests.i('t-bath'), tests.i('home-a'), 'Other')),
  'Another person''s id is taken, not theirs');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_category(tests.i('cat-wet'), 1, 'Wet rooms', 'teal', true)),
  'The category is archived');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.update_chore_template(tests.i('t-bath'), 1,
    'Bathroom', 'Top to bottom', tests.i('cat-wet'), 25, '[{"label": "Toilet", "mandatory": true}]')),
  'An archived category stays on a template that had it');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2 from public.update_chore_template(tests.i('t-bath'), 1, 'Bathroom')),
  'A stale revision is a conflict');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_template(tests.i('t-bath'), tests.trev('t-bath'),
    'Bathroom', p_retired => true)),
  'Retiring a template');
select tests.assert_true(
  (select outcome = 'invalid_category' from public.update_chore_template(tests.i('t-bath'), tests.trev('t-bath'),
    'Bathroom', p_category_id => tests.i('cat-wet'))),
  'Removing the archived category means it cannot be chosen again');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_templates(tests.i('home-a'))),
  'A retired template is hidden by default');
select tests.assert_true(
  (select retired and category_id is null from public.list_chore_templates(tests.i('home-a'), true)),
  'Listed when asked, retired, with what was saved');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_template(tests.i('t-bath'), tests.trev('t-bath'),
    'Bathroom', p_retired => false)),
  'And reinstated');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_chore_template(tests.i('t-bath'), tests.trev('t-bath'), 'Mine')),
  'A Member cannot change templates');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_templates(tests.i('home-b'))),
  'Home B has its own templates');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 4 from private.audit_events where subject_type = 'chore_template'),
  'Each template change is audited');

-- Chores to read and change ----------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-dishes'), tests.i('home-a'), 'Dishes',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_due_date => tests.today_a() - 2)),
  'An overdue one-off chore for Carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-floor'), tests.i('home-a'), 'Floor',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'An unassigned one due today');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-pct'), tests.i('home-a'), '100% clean_up',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-alice-a'))),
    p_due_date => tests.today_a() + 3)),
  'One with LIKE characters in its title, for Alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-late'), tests.i('home-a'), 'Windows',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_due_date => tests.today_a() - 1, p_requires_approval => true)),
  'One that needs approval');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-check'), tests.i('home-a'), 'Plants',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-bob-a'))),
    p_due_date => tests.today_a())),
  'One for Bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-b'), tests.i('home-b'), 'Kot dishes',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'A chore in Home B');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.occ('c-dishes'), tests.i('m-carol-a'),
    'Used the 50% soap')),
  'Carol completes the dishes with a note');
select tests.assert_true(
  (select outcome = 'submitted' from public.complete_chore_occurrence(tests.occ('c-late'), tests.i('m-carol-a'))),
  'And submits the windows');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'rejected' from public.review_chore_submission(tests.occ('c-late'), tests.orev('c-late'),
    'reject', 'Streaks')),
  'Alice rejects it: Needs rework');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'submitted' from public.complete_chore_occurrence(tests.occ('c-late'), tests.i('m-carol-a'))),
  'Carol resubmits');

-- The Home-wide history -----------------------------------------------------------------------------

select tests.assert_true(
  (select count(*) = 5 and min(total_count) = 5 from public.list_home_chore_history(tests.i('home-a'))),
  'Every member sees every occurrence of the Home, never Home B''s');
select tests.assert_true(
  (select string_agg(title, ',' order by title) = '100% clean_up'
   from public.list_home_chore_history(tests.i('home-a'), p_search => '100%')),
  'A % in the search is taken literally');
select tests.assert_true(
  (select count(*) = 0 from public.list_home_chore_history(tests.i('home-a'), p_search => 'clea_')),
  'So is an underscore');
select tests.assert_true(
  (select string_agg(title, ',') = 'Dishes' from public.list_home_chore_history(tests.i('home-a'), p_search => '50% SOAP')),
  'The completion note is searched, case-insensitively');
select tests.assert_true(
  (select string_agg(title, ',' order by title) = 'Dishes,Windows'
   from public.list_home_chore_history(tests.i('home-a'), p_member => tests.i('m-carol-a'))),
  'By member: assigned to or done by them');
select tests.assert_true(
  (select count(*) = 0 from public.list_home_chore_history(tests.i('home-a'), p_member => tests.i('m-bob-b'))),
  'A membership of another Home matches nothing');
select tests.assert_true(
  (select string_agg(title, ',') = 'Floor' from public.list_home_chore_history(tests.i('home-a'),
    p_chore_id => tests.i('c-floor'))),
  'By chore');
select tests.assert_true(
  (select string_agg(title, ',' order by title) = 'Floor,Plants'
   from public.list_home_chore_history(tests.i('home-a'), p_state => 'due_today')),
  'By state: due today');
select tests.assert_true(
  (select string_agg(title || ':' || status || ':' || attempts || ':' || rejected, ',') = 'Windows:pending_approval:2:1'
   from public.list_home_chore_history(tests.i('home-a'), p_approval => 'rejected')),
  'By approval: had a rejected attempt, with its attempts');
select tests.assert_true(
  (select count(*) = 4 from public.list_home_chore_history(tests.i('home-a'), p_approval => 'none')),
  'Never submitted');
select tests.assert_true(
  (select string_agg(title, ',') = 'Dishes' and bool_and(contributor_member = tests.i('m-carol-a'))
   from public.list_home_chore_history(tests.i('home-a'), p_basis => 'completed',
     p_from => tests.today_a(), p_to => tests.today_a())),
  'On the completed basis: completed today, whatever the scheduled date');
select tests.assert_true(
  (select count(*) = 0 from public.list_home_chore_history(tests.i('home-a'),
    p_from => tests.today_a() + 10)),
  'A scheduled date range');
select tests.assert_true(
  (select count(*) = 2 and min(total_count) = 5 from public.list_home_chore_history(tests.i('home-a'),
    p_offset => 3, p_limit => 3)),
  'Pages keep the total');
select tests.assert_denied(
  format($$select * from public.list_home_chore_history(%L, p_state => 'bogus')$$, tests.i('home-a')),
  'An unknown state is refused', '22023');
select tests.assert_denied(
  format($$select * from public.list_home_chore_history(%L, p_from => %L, p_to => %L)$$,
    tests.i('home-a'), tests.today_a(), tests.today_a() - 1),
  'A range that ends before it starts is refused', '22023');
select tests.assert_denied(
  format($$select * from public.list_home_chore_history(%L, p_search => %L)$$, tests.i('home-a'), repeat('x', 101)),
  'A search is at most 100 characters', '22023');
select tests.assert_denied(
  format($$select * from public.list_home_chore_history(%L)$$, tests.i('home-b')),
  'Another Home''s history is refused');

-- The widget reads ---------------------------------------------------------------------------------------

select tests.assert_true(
  (select string_agg(title || ':' || status, ',') = 'Windows:pending_approval'
   from public.list_chore_widget(tests.i('home-a'), 'mine', 'outstanding')),
  'Mine, outstanding: the pending one (the completed dishes are not)');
select tests.assert_true(
  (select string_agg(title, ',') = 'Dishes' and bool_and(contributor_me)
   from public.list_chore_widget(tests.i('home-a'), 'mine', 'completed', tests.today_a(), tests.today_a())),
  'Mine, completed today');
select tests.assert_true(
  (select string_agg(title, ',' order by title) = '100% clean_up,Floor,Plants,Windows'
   from public.list_chore_widget(tests.i('home-a'), 'all', 'outstanding')),
  'All Home chores, outstanding');
select tests.assert_true(
  (select string_agg(title, ',') = 'Floor'
   from public.list_chore_widget(tests.i('home-a'), 'all', 'outstanding', p_unassigned => true)),
  'Unassigned only');
select tests.assert_true(
  (select string_agg(title, ',') = 'Plants' and not bool_or(assigned_to_me)
   from public.list_chore_widget(tests.i('home-a'), 'all', 'outstanding', p_member => tests.i('m-bob-a'))),
  'One member''s');
select tests.assert_true(
  (select string_agg(title, ',') = '100% clean_up'
   from public.list_chore_widget(tests.i('home-a'), 'all', 'outstanding', tests.today_a() + 1, tests.today_a() + 7)),
  'A due-date range');
select tests.assert_true(
  (select count(*) = 2 and min(total_count) = 4
   from public.list_chore_widget(tests.i('home-a'), 'all', 'outstanding', p_limit => 2)),
  'A limit keeps the total');
select tests.assert_denied(
  format($$select * from public.list_chore_widget(%L, 'mine', 'outstanding', p_member => %L)$$,
    tests.i('home-a'), tests.i('m-bob-a')),
  'Mine names no other member', '22023');
select tests.assert_denied(
  format($$select * from public.list_chore_widget(%L, 'all', 'outstanding', p_limit => 21)$$, tests.i('home-a')),
  'At most 20 rows', '22023');
select tests.assert_denied(
  format($$select * from public.list_chore_widget(%L, 'all', 'outstanding')$$, tests.i('home-b')),
  'Another Home''s widget is refused');
select tests.act_as('alice');
select tests.assert_true(
  (select string_agg(title, ',') = 'Windows' from public.list_chore_widget(tests.i('home-a'), 'all', 'pending_approval')),
  'Pending approval');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_widget(tests.i('home-a'), 'all', 'rework')),
  'Resubmitted: no longer Needs rework');
select tests.assert_true(
  (select count(*) = 0 from public.list_chore_widget(tests.i('home-a'), 'all', 'overdue')),
  'Nothing open is overdue now');

-- Bulk actions ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select bool_and(outcome = 'not_permitted') and count(*) = 2 from public.bulk_chore_occurrences(tests.i('home-a'),
    'skip', jsonb_build_array(tests.item('c-floor'), tests.item('c-pct')), false)),
  'A Member gets every item refused');
select tests.act_as('bob');
select tests.assert_denied(
  format($$select * from public.bulk_chore_occurrences(%L, 'reassign', '[]', false, %L)$$,
    tests.i('home-a'), tests.i('m-carol-a')),
  'At least one item', '22023');
select tests.assert_denied(
  format($$select * from public.bulk_chore_occurrences(%L, 'reassign', %L, false)$$,
    tests.i('home-a'), jsonb_build_array(tests.item('c-floor'))),
  'Reassigning names a member', '22023');
select tests.assert_denied(
  format($$select * from public.bulk_chore_occurrences(%L, 'skip', %L, false)$$,
    tests.i('home-a'), jsonb_build_array(tests.item('c-floor'), tests.item('c-floor'))),
  'Each occurrence once', '22023');
select tests.assert_denied(
  format($$select * from public.bulk_chore_occurrences(%L, 'due_date', %L, false, p_due_date => %L, p_reason => 'x')$$,
    tests.i('home-a'), jsonb_build_array(tests.item('c-floor')), tests.today_a()),
  'Only skipping has a reason', '22023');
select tests.assert_denied(
  format($$select * from public.bulk_chore_occurrences(%L, 'skip', '[{"id": "x", "revision": 1}]', false)$$,
    tests.i('home-a')),
  'Item ids are uuids', '22023');

select tests.assert_true(
  (select string_agg(b.outcome, ',' order by b.ordinality) = 'preview,preview,occurrence_closed,pending_approval,not_found'
   from public.bulk_chore_occurrences(tests.i('home-a'), 'reassign',
     jsonb_build_array(tests.item('c-floor'), tests.item('c-pct'), tests.item('c-dishes'), tests.item('c-late'),
       jsonb_build_object('id', tests.occ('c-b'), 'revision', 1)),
     true, tests.i('m-carol-a')) with ordinality b),
  'A preview reports each item in order: closed, pending and other-Home ones too');
select tests.assert_true(
  tests.oassignees('c-floor') = '' and tests.oassignees('c-pct') = 'alice',
  'A preview changes nothing');
select tests.assert_true(
  (select assignees_before = '{}'::uuid[] and assignees_after = array[tests.i('m-carol-a')] and title = 'Floor'
   from public.bulk_chore_occurrences(tests.i('home-a'), 'reassign', jsonb_build_array(tests.item('c-floor')),
     true, tests.i('m-carol-a'))),
  'It shows who before and after');

create temporary table stale on commit drop as select tests.item('c-pct') as item;
grant all on stale to authenticated;
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.occ('c-pct'), tests.orev('c-pct'), false,
    p_due_date => tests.today_a() + 4)),
  'Alice changes one in the meantime');
select tests.act_as('bob');
select tests.assert_true(
  (select string_agg(b.outcome, ',' order by b.ordinality) = 'saved,conflict'
   from public.bulk_chore_occurrences(tests.i('home-a'), 'reassign',
     jsonb_build_array(tests.item('c-floor'), (select item from stale)), false, tests.i('m-carol-a')) with ordinality b),
  'Applying: the stale one is a conflict, the other still applies');
select tests.assert_true(
  tests.oassignees('c-floor') = 'carol' and tests.oassignees('c-pct') = 'alice',
  'Only the fresh one was reassigned');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.bulk_chore_occurrences(tests.i('home-a'), 'reassign',
    jsonb_build_array(tests.item('c-pct')), false, tests.i('m-bob-b'))),
  'A member of another Home is refused per item');
select tests.assert_true(
  (select outcome = 'saved' and due_before = tests.today_a() + 4 and due_after = tests.today_a() + 6
   from public.bulk_chore_occurrences(tests.i('home-a'), 'due_date', jsonb_build_array(tests.item('c-pct')),
     false, p_due_date => tests.today_a() + 6)),
  'Moving a due date');
select tests.assert_true(tests.odue('c-pct') = tests.today_a() + 6, 'It moved');
select tests.assert_true(
  (select string_agg(b.outcome, ',' order by b.ordinality) = 'skipped,occurrence_closed'
   from public.bulk_chore_occurrences(tests.i('home-a'), 'skip',
     jsonb_build_array(tests.item('c-check'), tests.item('c-dishes')), false, p_reason => 'Away') with ordinality b),
  'Skipping: the completed one is reported');
select tests.assert_true(
  tests.ostatus('c-check') = 'skipped' and tests.ostatus('c-dishes') = 'completed',
  'Only the open one was skipped');
select tests.assert_true(
  (select o -> 'skip' ->> 'reason' = 'Away'
   from public.get_chore_occurrence(tests.occ('c-check')) o),
  'The skip reason is recorded');
select tests.assert_true(
  (select outcome = 'conflict' from public.bulk_chore_occurrences(tests.i('home-a'), 'skip',
    jsonb_build_array(jsonb_build_object('id', tests.occ('c-floor'), 'revision', 1)), false)),
  'A retry with the revision seen before is a conflict, never a second change');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 3 from private.audit_events where action = 'chore_occurrence.bulk'),
  'An applied bulk action is audited once with what it changed; previews and no-ops never');
