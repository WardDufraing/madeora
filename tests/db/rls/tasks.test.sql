-- S18: tasks core (supabase/migrations/*_tasks.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Carol is not in. Covers: nothing
-- reachable as a table; personal tasks private to their owner; Home lists and labels managed by task
-- managers only (Owner, Administrator granted manageHomeTasks; revoked grant, plain Member refused);
-- creating as any member, retries and forged ids; edit, complete and delete rights (creator,
-- assignee, manager, plain member); assignees only current members of the same Home; shared
-- completion recorded once with the actual actor; optimistic revisions; date and priority rules;
-- filters with the Home's own "today"; subtasks and comments; cross-Home and cross-context refusals;
-- delete to the trash, restore with subtasks and comments, the list-unavailable conflict and its
-- resolution, purge; archive and delete impact rules; member departure flags open tasks; audit.

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
insert into ids select 'm-bob-b', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('bob');

-- Names for client-generated ids.
insert into ids select n, gen_random_uuid() from unnest(array[
  'l-carol', 'l-a1', 'l-a2', 'l-a3', 'l-b', 'lbl-a', 'lbl-b', 't-carol', 't1', 't2', 't3', 't-b',
  't-due', 't-late', 't-soon', 's1', 's2', 'c1', 'c2'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.rev(p_task text) returns integer
  language sql stable security definer as $$ select revision from private.tasks where id = tests.i(p_task); $$;
create function tests.list_rev(p_list text) returns integer
  language sql stable security definer as $$ select revision from private.task_lists where id = tests.i(p_list); $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
grant execute on function tests.i(text), tests.rev(text), tests.list_rev(text), tests.today_a() to authenticated, service_role;

-- Nothing reachable ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.tasks', 'The API cannot read tasks');
select tests.assert_denied('select * from private.task_lists', 'Nor lists');
select tests.assert_denied('select * from private.task_assignees', 'Nor assignees');
select tests.assert_denied('select * from private.task_labels', 'Nor labels');
select tests.assert_denied('select * from private.subtasks', 'Nor subtasks');
select tests.assert_denied('select * from private.task_comments', 'Nor comments');
select tests.assert_denied(
  $$select private.can_edit_task(null::private.tasks, tests.user_id('alice'))$$,
  'Nor the permission helpers');
select tests.act_as_anon();
select tests.assert_denied('select * from public.list_tasks()', 'Nobody signed out lists tasks');
select tests.assert_denied($$select public.get_task(gen_random_uuid())$$, 'Nor reads one');

-- Personal tasks ---------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-carol'), 'Errands')),
  'Carol creates a personal list');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t-carol'), tests.i('l-carol'), 'Dentist',
    'Call before noon', null, tests.today_a() + 3, 'high')),
  'And a personal task with a due date and priority');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.create_task(gen_random_uuid(), tests.i('l-carol'),
    'Shared?', null, null, null, null, '{}', array[tests.i('m-carol-a')])),
  'A personal task has no assignees');
select tests.assert_true(
  (select count(*) = 1 from public.list_tasks()), 'Carol sees her personal task');

select tests.act_as('alice');
select tests.assert_true((select count(*) = 0 from public.list_tasks()), 'Alice does not see it');
select tests.assert_true(public.get_task(tests.i('t-carol')) is null, 'Nor read it by id');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_task_completion(tests.i('t-carol'), true)),
  'Nor complete it');
select tests.assert_true(
  (select outcome = 'not_found' from public.delete_task(tests.i('t-carol'))), 'Nor delete it');
select tests.assert_true(
  (select outcome = 'not_found' from public.add_task_comment(gen_random_uuid(), tests.i('t-carol'), 'Hi')),
  'Nor comment on it');
select tests.assert_true(
  (select count(*) = 0 from public.list_task_lists()), 'Nor see her personal list');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.create_task(gen_random_uuid(), tests.i('l-carol'), 'Sneak')),
  'Nor add a task to it');

-- Home lists --------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task_list(gen_random_uuid(), 'Mine', tests.i('home-a'))),
  'A plain Member cannot create Home lists');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task_list(gen_random_uuid(), 'Mine', tests.i('home-a'))),
  'Nor an Administrator without the grant');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-a1'), 'Renovation', tests.i('home-a'))),
  'The Owner creates a Home list');
select tests.assert_true(
  (select outcome = 'exists' from public.create_task_list(tests.i('l-a1'), 'Renovation', tests.i('home-a'))),
  'A retry returns the same list');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.create_task_list(gen_random_uuid(), 'RENOVATION', tests.i('home-a'))),
  'A confusing duplicate name is refused');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-a2'), 'Errands', tests.i('home-a'))),
  'The same name as Carol''s personal list is fine in the Home');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-a3'), 'Garden', tests.i('home-a'))),
  'A third list');
select tests.assert_true(
  (select outcome = 'id_taken' from public.create_task_list(tests.i('l-carol'), 'Forged', tests.i('home-a'))),
  'Someone else''s list id cannot be claimed');
select tests.assert_denied(
  $$select * from public.create_task_list(gen_random_uuid(), ' ', tests.i('home-a'))$$,
  'A blank name is refused', '22023');
select tests.assert_true(
  public.reorder_task_lists(array[tests.i('l-a3'), tests.i('l-a1')], tests.i('home-a')) = 'saved',
  'The Owner reorders lists');
select tests.assert_true(
  (select array_agg(id order by "position") = array[tests.i('l-a3'), tests.i('l-a1'), tests.i('l-a2')]
    from public.list_task_lists(tests.i('home-a'))),
  'Named lists come first in the given order');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_task_list(tests.i('l-a1'), 99, 'Renovation', false)),
  'A stale rename answers conflict');

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 3 from public.list_task_lists(tests.i('home-a'))), 'Every member sees the Home lists');
select tests.assert_denied($$select * from public.list_task_lists(tests.i('home-b'))$$,
  'A Home Carol is not in answers like one that does not exist');
select tests.assert_denied($$select * from public.list_task_lists(gen_random_uuid())$$,
  'The same answer for a Home that does not exist');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_task_list(tests.i('l-a1'), 1, 'Mine', false)),
  'A plain Member cannot rename a Home list');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-b'), 'Kot list', tests.i('home-b'))),
  'Bob creates a list in his own Home');

-- Labels ------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_label(tests.i('lbl-a'), 'Urgent-ish', 'red', tests.i('home-a'))),
  'The Owner creates a Home label');
select tests.assert_denied(
  $$select * from public.create_task_label(gen_random_uuid(), 'Bad colour', '#ff0000', tests.i('home-a'))$$,
  'Only known colour names', '22023');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task_label(gen_random_uuid(), 'Mine', null, tests.i('home-a'))),
  'A plain Member cannot create Home labels');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_label(tests.i('lbl-b'), 'Kot label', null, tests.i('home-b'))),
  'Bob labels his own Home');

-- Creating Home tasks -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t1'), tests.i('l-a1'), 'Paint the hall',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A plain Member creates a Home task');
select tests.assert_true(
  (select outcome = 'exists' from public.create_task(tests.i('t1'), tests.i('l-a1'), 'Paint the hall',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A retried create returns the same task');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task(gen_random_uuid(), tests.i('l-a1'), 'Assign',
    null, null, null, null, '{}', array[tests.i('m-carol-a')], tests.i('home-a'))),
  'But cannot assign while creating');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.create_task(gen_random_uuid(), tests.i('l-b'), 'Elsewhere',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A list of another Home is refused');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.create_task(gen_random_uuid(), tests.i('l-carol'), 'Mixed',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'So is a personal list for a Home task');
select tests.assert_true(
  (select outcome = 'invalid_label' from public.create_task(gen_random_uuid(), tests.i('l-a1'), 'Labelled',
    null, null, null, null, array[tests.i('lbl-b')], '{}', tests.i('home-a'))),
  'A label of another Home is refused');
select tests.assert_denied(
  $$select * from public.create_task(gen_random_uuid(), tests.i('l-a1'), 'Reversed', null,
    tests.today_a() + 5, tests.today_a(), null, '{}', '{}', tests.i('home-a'))$$,
  'A start date after the due date is refused', '22023');
select tests.assert_denied(
  $$select * from public.create_task(gen_random_uuid(), tests.i('l-a1'), 'Odd', null, null, null,
    'critical', '{}', '{}', tests.i('home-a'))$$,
  'Only the four priorities', '22023');
select tests.assert_denied(
  $$select * from public.create_task(gen_random_uuid(), tests.i('l-b'), 'In B', null, null, null, null,
    '{}', '{}', tests.i('home-b'))$$,
  'Carol cannot create tasks in a Home she is not in');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t-b'), tests.i('l-b'), 'Kot task',
    null, null, null, null, '{}', '{}', tests.i('home-b'))),
  'Bob creates a task in Home B');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t2'), tests.i('l-a1'), 'Fix the tap',
    null, null, null, 'urgent', array[tests.i('lbl-a')], array[tests.i('m-carol-a'), tests.i('m-bob-a')],
    tests.i('home-a'))),
  'The Owner creates a task with two assignees and a label');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t3'), tests.i('l-a2'), 'Buy bulbs',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'And an unassigned task');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.create_task(gen_random_uuid(), tests.i('l-a1'), 'Foreign',
    null, null, null, null, '{}', array[tests.i('m-bob-b')], tests.i('home-a'))),
  'A membership of another Home is not an eligible assignee');
select tests.assert_true(
  public.get_task(tests.i('t-b')) is null, 'Alice, a stranger to Home B, cannot read its task');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_task(tests.i('t-b'), 1, 'Hijack', '{}')),
  'Nor edit it');
select tests.assert_true(
  (select outcome = 'id_taken' from public.create_task(tests.i('t-b'), tests.i('l-a1'), 'Forged id',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'Nor take over its id');

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.task_assignees where task_id = tests.i('t2')), 'Two assignees stored');
select tests.assert_true(
  (select count(*) = 1 from private.audit_events where action = 'task.created' and subject_id = tests.i('t2')
    and details = '{"assignees": 2}'::jsonb),
  'Creation is audited with a count, not names');

-- Reading -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 3 and max(total_count) = 3 from public.list_tasks(tests.i('home-a'))),
  'All Tasks shows the three Home tasks with an accurate total');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('t2')] from public.list_tasks(tests.i('home-a'), p_assignee => 'me')),
  'Assigned to me');
select tests.assert_true(
  (select assignee_member_ids @> array[tests.i('m-carol-a'), tests.i('m-bob-a')] and assigned_to_me
    from public.list_tasks(tests.i('home-a')) where id = tests.i('t2')),
  'Assignees are named by membership id');
select tests.assert_true(
  (select count(*) = 1 from public.list_tasks(tests.i('home-a'), tests.i('l-a2'))), 'One list at a time');
select tests.assert_true(
  (select bool_and(can_complete = (id = tests.i('t1') or id = tests.i('t2'))) from public.list_tasks(tests.i('home-a'))),
  'Each row says whether the viewer may complete it: her own and her assigned task only');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('t2')] from public.list_tasks(tests.i('home-a'),
    p_label_ids => array[tests.i('lbl-a')])),
  'Filter by label');
select tests.assert_true(
  (select (public.get_task(tests.i('t2')) -> 'can') = '{"edit": true, "complete": true, "assign": false,
    "delete": false, "comment": true}'::jsonb),
  'An assignee may edit and complete but not assign or delete');
select tests.assert_true(
  (select (public.get_task(tests.i('t3')) -> 'can' ->> 'edit')::boolean = false),
  'A plain Member may not edit someone else''s unassigned task');
select tests.assert_true(
  (select public.get_task(tests.i('t2')) -> 'createdBy' = jsonb_build_object('me', false, 'member', tests.i('m-alice-a'))),
  'The creator is named by membership id');
select tests.assert_denied($$select * from public.list_tasks(tests.i('home-b'))$$,
  'Carol cannot list Home B tasks');
select tests.assert_denied($$select * from public.list_tasks(tests.i('home-a'), p_limit => 51)$$,
  'A page holds at most 50 tasks', '22023');
select tests.assert_denied($$select * from public.list_tasks(tests.i('home-a'), p_status => 'weird')$$,
  'Unknown filters are refused', '22023');

-- Edit rights ----------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.update_task(tests.i('t2'), 1, 'Fix the kitchen tap',
    array[tests.i('lbl-a')], 'Washer is worn', null, tests.today_a() + 1, 'urgent')),
  'An assignee edits the task');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2 from public.update_task(tests.i('t2'), 1, 'Old copy', '{}')),
  'A stale edit answers conflict and changes nothing');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_task(tests.i('t3'), 1, 'Not mine', '{}')),
  'A plain Member cannot edit someone else''s unassigned task');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_task_completion(tests.i('t3'), true)),
  'Nor complete it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_task(tests.i('t2'))),
  'An assignee who did not create the task cannot delete it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_task_assignees(tests.i('t2'), 2, array[tests.i('m-carol-a')])),
  'A plain Member cannot change assignees');
select tests.assert_true(
  (select outcome = 'saved' from public.move_task(tests.i('t1'), 1, tests.i('l-a2'))),
  'The creator moves her task to another list');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.move_task(tests.i('t1'), 2, tests.i('l-carol'))),
  'But not into her personal space');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.move_task(tests.i('t1'), 2, tests.i('l-b'))),
  'Nor into another Home');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_task_assignees(tests.i('t2'), 2, array[tests.i('m-bob-a')])),
  'An Administrator without the grant cannot change assignees');
select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeTasks']) = 'ok',
  'The Owner grants Bob "Manage Home tasks"');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' and revision = 3 from public.set_task_assignees(tests.i('t2'), 2,
    array[tests.i('m-carol-a'), tests.i('m-bob-a'), tests.i('m-alice-a')])),
  'With the grant, Bob sets three assignees');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.set_task_assignees(tests.i('t2'), 3, array[tests.i('m-bob-b')])),
  'A member of another Home is refused');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task(tests.i('t3'), 1, 'Buy LED bulbs', '{}', p_priority => 'low')),
  'A task manager edits any task');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(gen_random_uuid(), 'Bob''s list', tests.i('home-a'))),
  'And manages lists');
select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]) = 'ok',
  'The Owner revokes the grant');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_task_assignees(tests.i('t2'), 3, '{}')),
  'The revoked grant ends the right at once');

-- Shared completion -----------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'completed' and completed_by_me from public.set_task_completion(tests.i('t2'), true)),
  'One assignee completes the task for everyone');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'already_completed' and not completed_by_me and completed_by_member = tests.i('m-carol-a')
    from public.set_task_completion(tests.i('t2'), true)),
  'A second completion changes nothing and names the actual completer');
select tests.assert_true(
  (select public.get_task(tests.i('t2')) -> 'completedBy' = jsonb_build_object('me', false, 'member', tests.i('m-carol-a'))),
  'The detail shows Carol as the completer, not every assignee');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events where action = 'task.completed' and subject_id = tests.i('t2')),
  'Completion is recorded once, not once per assignee');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'reopened' from public.set_task_completion(tests.i('t2'), false)), 'The Owner reopens it');
select tests.assert_true(
  (select public.get_task(tests.i('t2')) -> 'completedBy' = 'null'::jsonb), 'Reopening clears the completer');

-- Dates and filters, with Home A's own today ---------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t-late'), tests.i('l-a3'), 'Overdue one',
    null, null, tests.today_a() - 1, null, '{}', '{}', tests.i('home-a'))),
  'A task due yesterday');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t-soon'), tests.i('l-a3'), 'Starts later',
    null, tests.today_a() + 2, tests.today_a() + 4, null, '{}', '{}', tests.i('home-a'))),
  'A task starting in two days');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t-due'), tests.i('l-a3'), 'Due today',
    null, tests.today_a(), tests.today_a(), 'high', '{}', '{}', tests.i('home-a'))),
  'A task starting and due today');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('t-late')] and bool_and(overdue)
    from public.list_tasks(tests.i('home-a'), p_when => 'overdue', p_today => '2000-01-01')),
  'Overdue uses the Home''s timezone, whatever date the caller claims');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('t-soon')] and bool_and(upcoming)
    from public.list_tasks(tests.i('home-a'), p_when => 'upcoming')),
  'Upcoming: start in the future');
select tests.assert_true(
  (select bool_and(id <> tests.i('t-late') and id <> tests.i('t-soon')) and bool_or(id = tests.i('t-due'))
    from public.list_tasks(tests.i('home-a'), p_when => 'active')),
  'Active: started or no start, not overdue; due today is still active');
select tests.assert_true(
  (select not bool_or(id = tests.i('t-soon')) from public.list_tasks(tests.i('home-a'), p_hide_future => true)),
  'Hiding future-start tasks');
select tests.assert_true(
  (select (array_agg(id))[1] = tests.i('t2')
    from public.list_tasks(tests.i('home-a'), p_sort => 'priority_desc')),
  'Urgent sorts first');
select tests.assert_true(
  (select array_agg(id order by id) = (select array_agg(x order by x) from unnest(array[tests.i('t1'), tests.i('t-late'), tests.i('t-soon')]) x)
    from public.list_tasks(tests.i('home-a'), p_priorities => array['unset'])),
  'Filter Unspecified priority');
select tests.assert_true(
  (select outcome = 'completed' from public.set_task_completion(tests.i('t-soon'), true)),
  'A future-start task can be completed before it starts');

-- Subtasks --------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.add_subtask(tests.i('s1'), tests.i('t2'), 'Buy a washer')),
  'An assignee adds a subtask');
select tests.assert_true(
  (select outcome = 'exists' from public.add_subtask(tests.i('s1'), tests.i('t2'), 'Buy a washer')),
  'A retry adds nothing');
select tests.assert_true(
  (select outcome = 'created' from public.add_subtask(tests.i('s2'), tests.i('t2'), 'Fit it')), 'And another');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.add_subtask(gen_random_uuid(), tests.i('t3'), 'Nope')),
  'Not on a task she may not edit');
select tests.assert_true(
  (select outcome = 'saved' from public.set_subtask_completion(tests.i('s1'), true)), 'Ticks one');
select tests.assert_true(
  (select outcome = 'saved' from public.set_subtask_completion(tests.i('s2'), true)), 'Ticks the other');
select tests.assert_true(
  (select public.get_task(tests.i('t2')) ->> 'completedAt' is null),
  'All subtasks done does not complete the parent');
select tests.assert_true(
  (select subtasks_done = 2 and subtasks_total = 2 from public.list_tasks(tests.i('home-a')) where id = tests.i('t2')),
  'Progress is counted');
select tests.assert_true(
  public.reorder_subtasks(tests.i('t2'), array[tests.i('s2'), tests.i('s1')]) = 'saved', 'Reorders');
select tests.assert_true(
  (select (public.get_task(tests.i('t2')) -> 'subtasks' -> 0 ->> 'id')::uuid = tests.i('s2')), 'In the new order');
select tests.assert_true(
  (select outcome = 'conflict' from public.rename_subtask(tests.i('s1'), 1, 'Stale')),
  'A stale subtask rename answers conflict');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.add_subtask(gen_random_uuid(), tests.i('t-carol'), 'Peek')),
  'A personal task''s checklist is invisible to others');

-- Comments --------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.add_task_comment(tests.i('c1'), tests.i('t3'), E'Which shop?\nThe big one.')),
  'A member who may only view the task can comment');
select tests.assert_true(
  (select outcome = 'exists' from public.add_task_comment(tests.i('c1'), tests.i('t3'), E'Which shop?\nThe big one.')),
  'A repeated send adds nothing');
select tests.assert_denied($$select * from public.add_task_comment(gen_random_uuid(), tests.i('t3'), E' \n ')$$,
  'A blank comment is refused', '22023');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.update_task_comment(tests.i('c1'), 1, 'Which shop?')),
  'She edits her own comment');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_task_comment(tests.i('c1'), 1, 'Older edit')),
  'A stale edit does not overwrite the newer one');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.add_task_comment(tests.i('c2'), tests.i('t3'), 'The big one')),
  'Alice replies');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_task_comment(tests.i('c1'), 2, 'Changed by Alice')),
  'Nobody edits another member''s comment, not even the Owner');
select tests.assert_true(
  public.delete_task_comment(tests.i('c1')) = 'not_permitted', 'Nor deletes it');
select tests.assert_true(
  (select array_agg(id order by created_at, id) = array[tests.i('c1'), tests.i('c2')]
     and bool_and(author_me = (id = tests.i('c2'))) and max(total_count) = 2
    from public.list_task_comments(tests.i('t3'))),
  'Comments are chronological with their author');
select tests.assert_true(
  (select edited_at is not null and author_member = tests.i('m-carol-a')
    from public.list_task_comments(tests.i('t3')) where id = tests.i('c1')),
  'An edited comment says so and names its author by membership');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 0 from public.list_task_comments(tests.i('t-carol'))), 'Personal comments stay private');

-- Delete to the trash and restore -----------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.add_subtask(gen_random_uuid(), tests.i('t1'), 'Buy paint')),
  'The creator adds a subtask to her task');
select tests.assert_true(
  (select outcome = 'created' from public.add_task_comment(gen_random_uuid(), tests.i('t1'), 'White?')),
  'And a comment');
insert into ids select 'e-t1', entry_id from public.delete_task(tests.i('t1')) where outcome = 'deleted';
select tests.assert_true(tests.i('e-t1') is not null, 'The creator deletes her task to the trash');
select tests.assert_true(public.get_task(tests.i('t1')) is null, 'It is gone from reading');
select tests.assert_true(
  (select count(*) = 0 from public.list_tasks(tests.i('home-a'), p_status => 'all') where id = tests.i('t1')),
  'And from the lists');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_task_completion(tests.i('t1'), true)),
  'A trashed task cannot be completed');
select tests.assert_true(
  (select count(*) = 1 from public.list_trash(tests.i('home-a')) where entry_id = tests.i('e-t1')
     and module = 'tasks' and item_type = 'task' and label = 'Paint the hall'),
  'Carol sees it in the Home trash');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 0 from public.list_trash(tests.i('home-a')) where entry_id = tests.i('e-t1')),
  'An Administrator without manageHomeSettings does not see another member''s deleted task');
select tests.assert_true(
  (select outcome = 'not_found' from public.restore_trash_entries(array[tests.i('e-t1')])),
  'Nor restore it');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.list_trash(tests.i('home-a')) where entry_id = tests.i('e-t1')),
  'The Owner sees it');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-t1')])),
  'Carol restores it');
select tests.assert_true(
  (select jsonb_array_length(public.get_task(tests.i('t1')) -> 'subtasks') = 1
     and (public.get_task(tests.i('t1')) ->> 'commentCount')::integer = 1),
  'Its subtask and comment came back with it');

-- The list was deleted meanwhile: a real conflict, resolved by choosing another list.
insert into ids select 'e-t1b', entry_id from public.delete_task(tests.i('t1')) where outcome = 'deleted';
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'has_tasks' and active_tasks = 1
    from public.delete_task_list(tests.i('l-a2'), tests.list_rev('l-a2'))),
  'A list with active tasks cannot be deleted: the impact review asks for them first');
select tests.assert_true(
  (select outcome = 'saved' from public.move_task(tests.i('t3'), tests.rev('t3'), tests.i('l-a1'))),
  'The Owner moves the remaining task away');
select tests.assert_true(
  (select outcome = 'has_open_tasks' and open_tasks = 2
    from public.update_task_list(tests.i('l-a1'), 1, 'Renovation', true)),
  'A list with open tasks cannot be archived');
insert into ids select 'e-l-a2', entry_id
  from public.delete_task_list(tests.i('l-a2'), tests.list_rev('l-a2'))
  where outcome = 'deleted';
select tests.assert_true(tests.i('e-l-a2') is not null, 'The now empty list goes to the trash');
select tests.assert_true(
  (select count(*) = 0 from public.list_task_lists(tests.i('home-a'), true) where id = tests.i('l-a2')),
  'And is no longer listed');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'list_unavailable' and options = array['move_to_list']
    from public.restore_trash_entries(array[tests.i('e-t1b')])),
  'Restoring the task now reports that its list is unavailable');
select tests.assert_true(
  (select outcome = 'needs_resolution'
    from public.restore_trash_entries(array[tests.i('e-t1b')],
      jsonb_build_object(tests.i('e-t1b'), 'move_to_list:' || tests.i('l-carol')))),
  'A list of another context is not a valid destination');
select tests.assert_true(
  (select outcome = 'needs_resolution'
    from public.restore_trash_entries(array[tests.i('e-t1b')],
      jsonb_build_object(tests.i('e-t1b'), 'move_to_list:not-a-uuid'))),
  'Nor is a malformed one');
select tests.assert_true(
  (select outcome = 'restored'
    from public.restore_trash_entries(array[tests.i('e-t1b')],
      jsonb_build_object(tests.i('e-t1b'), 'move_to_list:' || tests.i('l-a3')))),
  'Choosing an active list of the Home restores it there');
select tests.assert_true(
  (select (public.get_task(tests.i('t1')) -> 'list' ->> 'id')::uuid = tests.i('l-a3')), 'In the chosen list');

-- A list restored is listed again; purging a list leaves trashed tasks without one.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-l-a2')])), 'The list comes back');
select tests.assert_true(
  (select outcome = 'saved' from public.move_task(tests.i('t-due'), tests.rev('t-due'), tests.i('l-a2'))),
  'A task goes into it');
insert into ids select 'e-tdue', entry_id from public.delete_task(tests.i('t-due')) where outcome = 'deleted';
insert into ids select 'e-l-a2b', entry_id
  from public.delete_task_list(tests.i('l-a2'), tests.list_rev('l-a2'))
  where outcome = 'deleted';
select tests.assert_true(
  (select outcome = 'purged' from public.purge_trash_entries(array[tests.i('e-l-a2b')])), 'The list is purged');
select tests.act_as_owner();
select tests.assert_true(
  (select list_id is null and deleted_at is not null from private.tasks where id = tests.i('t-due')),
  'Its trashed task lost the list');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'list_unavailable'
    from public.restore_trash_entries(array[tests.i('e-tdue')])),
  'And asks for a destination when restored');
select tests.assert_true(
  (select outcome = 'purged' from public.purge_trash_entries(array[tests.i('e-tdue')])), 'Purging the task');
select tests.act_as_owner();
select tests.assert_true(not exists (select 1 from private.tasks where id = tests.i('t-due')), 'Removes it for good');

-- Reopening needs an active list (review M1); who reopened is recorded (review M4) ---------------------

select tests.act_as('alice');
insert into ids select n, gen_random_uuid() from unnest(array['l-arch', 't-arch']) as n;
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list(tests.i('l-arch'), 'Old projects', tests.i('home-a'))),
  'A list for the archive case');
select tests.assert_true(
  (select outcome = 'created' from public.create_task(tests.i('t-arch'), tests.i('l-arch'), 'Done long ago',
    null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'With one task');
select tests.assert_true(
  (select outcome = 'completed' from public.set_task_completion(tests.i('t-arch'), true)), 'Completed');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task_list(tests.i('l-arch'), 1, 'Old projects', true)),
  'A list with only completed tasks can be archived');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.set_task_completion(tests.i('t-arch'), false)),
  'Reopening a task inside an archived list is refused');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task_list(tests.i('l-arch'), 2, 'Old projects', false)),
  'Unarchiving the list');
select tests.assert_true(
  (select outcome = 'reopened' from public.set_task_completion(tests.i('t-arch'), false)), 'Then it reopens');
select tests.assert_true(
  (select public.get_task(tests.i('t-arch')) -> 'reopenedBy' = jsonb_build_object('me', true, 'member', tests.i('m-alice-a'))
     and public.get_task(tests.i('t-arch')) ->> 'reopenedAt' is not null),
  'The reopener is recorded and named');

-- Labels: removal detaches ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select task_count = 1 from public.list_task_labels(tests.i('home-a')) where id = tests.i('lbl-a')),
  'The impact count of the label');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task_label(tests.i('lbl-a'), 1, 'Soon', 'orange')),
  'Renaming a label');
select tests.assert_true(
  (select outcome = 'conflict' from public.delete_task_label(tests.i('lbl-a'), 1)),
  'Removal with the revision from before the rename answers conflict');
select tests.assert_true(
  (select outcome = 'deleted' and detached = 1 from public.delete_task_label(tests.i('lbl-a'), 2)),
  'Removal detaches it from its task');
select tests.assert_true(
  (select jsonb_array_length(public.get_task(tests.i('t2')) -> 'labels') = 0
     and public.get_task(tests.i('t2')) ->> 'title' = 'Fix the kitchen tap'),
  'The task stays, without the label');

-- Member departure ----------------------------------------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships
  where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.assert_true(
  (select needs_reassignment from private.tasks where id = tests.i('t2')),
  'An open task the leaver was assigned to is flagged for reassignment');
select tests.assert_true(
  not exists (select 1 from private.task_assignees where user_id = tests.user_id('carol')),
  'Her assignments ended');
select tests.assert_true(
  (select count(*) = 2 from private.task_assignees where task_id = tests.i('t2')),
  'The other assignees stay');
select tests.assert_true(
  (select created_by = tests.user_id('carol') from private.tasks where id = tests.i('t1')),
  'Her Home task stays in the Home with its attribution');
select tests.act_as('alice');
select tests.assert_true(
  (select public.get_task(tests.i('t1')) -> 'createdBy' = jsonb_build_object('me', false, 'member', null)),
  'A departed creator is named by nobody');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('t2')]
    from public.list_tasks(tests.i('home-a'), p_assignee => 'needs_reassignment')),
  'The reassignment queue');
select tests.assert_true(
  (select outcome = 'saved' from public.set_task_assignees(tests.i('t2'), tests.rev('t2'), array[tests.i('m-alice-a')])),
  'The Owner reassigns it');
select tests.assert_true(
  (select public.get_task(tests.i('t2')) -> 'needsReassignment' = 'false'::jsonb), 'And the flag is cleared');
select tests.act_as('carol');
select tests.assert_true(public.get_task(tests.i('t1')) is null, 'The leaver no longer reads Home tasks');
select tests.assert_denied($$select * from public.list_tasks(tests.i('home-a'))$$, 'Nor lists them');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_task_comment(tests.i('c1'), 2, 'After leaving')),
  'Nor edits her old comment there');
select tests.assert_true(
  (select count(*) = 1 from public.list_tasks()), 'Her personal task is untouched');
