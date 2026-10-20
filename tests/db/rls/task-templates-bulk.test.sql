-- S19b: task templates and bulk task actions (supabase/migrations/*_task_reminders_templates_bulk.sql).
-- Alice owns Home A, where Bob is an Administrator (granted manageHomeTasks later) and Carol a
-- Member; Bob owns Home B, which Carol is not in.
-- Templates: nothing reachable as a table; who may create, edit and delete (task managers) and use
-- (every member); names (invalid, duplicate, confusing duplicate) and limits; retries; a deleted
-- label left out and disclosed; creating a task from a template (one transaction with its checklist,
-- all open; retry and double submit; stale template; archived list; labels re-checked; other Homes);
-- later template edits and deletion never touch tasks made from it; leaving the Home removes access,
-- not the templates; Personal templates are private.
-- Bulk: each action (complete, priority, labels add/remove/replace, move); dry run; mixed rights and
-- states in one selection (partial success); retries answer 'unchanged' (one completion, no new
-- revision); a stale revision is a conflict; other contexts and invisible tasks; an occurrence
-- changes alone; limits and invalid input.

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
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');

insert into ids select n, gen_random_uuid() from unnest(array[
  'l-a', 'l-a2', 'l-arch', 'l-b', 'l-c', 'lbl-1', 'lbl-2', 'lbl-gone', 'lbl-b', 'tpl', 'tpl-2', 'tpl-p',
  'tpl-b', 'n1', 'n2', 'n3', 'n4', 'n-p', 'b1', 'b2', 'b3', 'b4', 'b-other', 'b-b', 'b-p', 's1'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.rev(p_task uuid) returns integer
  language sql stable security definer as $$ select revision from private.tasks where id = p_task; $$;
create function tests.trev(p_tpl uuid) returns integer
  language sql stable security definer as $$ select revision from private.task_templates where id = p_tpl; $$;
create function tests.labels(p_task uuid) returns uuid[]
  language sql stable security definer as $$
  select coalesce(array_agg(label_id order by label_id), '{}') from private.task_label_links where task_id = p_task; $$;
create function tests.sorted(p uuid[]) returns uuid[]
  language sql immutable as $$ select coalesce(array_agg(x order by x), '{}') from unnest(p) as x; $$;
create function tests.revs(variadic p_names text[]) returns jsonb
  language sql stable security definer as $$
  select jsonb_object_agg(t.id, t.revision) from private.tasks t
  where t.id in (select id from ids where name = any (p_names)); $$;
grant execute on function tests.i(text), tests.rev(uuid), tests.trev(uuid), tests.labels(uuid),
  tests.sorted(uuid[]), tests.revs(text[]) to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.task_templates', 'The API cannot read templates');
select tests.act_as_anon();
select tests.assert_denied('select public.list_task_templates()', 'Nobody signed out lists templates');

-- Lists and labels -----------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_task_list(tests.i('l-a'), 'Chores', tests.i('home-a'));
select public.create_task_list(tests.i('l-a2'), 'Garden', tests.i('home-a'));
select public.create_task_list(tests.i('l-arch'), 'Old', tests.i('home-a'));
select public.create_task_label(tests.i('lbl-1'), 'Kitchen', null, tests.i('home-a'));
select public.create_task_label(tests.i('lbl-2'), 'Weekly', null, tests.i('home-a'));
select public.create_task_label(tests.i('lbl-gone'), 'Soon gone', null, tests.i('home-a'));
select tests.act_as('bob');
select public.create_task_list(tests.i('l-b'), 'Kot', tests.i('home-b'));
select public.create_task_label(tests.i('lbl-b'), 'Kot', null, tests.i('home-b'));
select tests.act_as('carol');
select public.create_task_list(tests.i('l-c'), 'Mine');

-- Templates: creating --------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted'
   from public.create_task_template(tests.i('tpl'), 'Cleaning', 'Clean kitchen', p_home_id => tests.i('home-a'))),
  'A plain Member cannot create a Home template (task managers manage them)');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' and revision = 1
   from public.create_task_template(tests.i('tpl'), 'Cleaning', 'Clean kitchen', 'Wipe everything',
     'high', array[tests.i('lbl-1'), tests.i('lbl-gone')], array['Counters', 'Sink', 'Floor'],
     tests.i('home-a'))),
  'The Owner creates a Home template with labels and an ordered checklist');
select tests.assert_true(
  (select outcome = 'exists' from public.create_task_template(tests.i('tpl'), 'Cleaning', 'Clean kitchen',
     p_home_id => tests.i('home-a'))),
  'A retry answers exists');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.create_task_template(tests.i('tpl-2'), 'CLEANING',
     'Other', p_home_id => tests.i('home-a'))),
  'A confusingly similar name in the same Home is refused');
select tests.assert_denied(
  $$select public.create_task_template(tests.i('tpl-2'), '   ', 'Title', p_home_id => tests.i('home-a'))$$,
  'An empty name is invalid', '22023');
select tests.assert_denied(
  $$select public.create_task_template(tests.i('tpl-2'), 'Name', 'Title',
    p_subtasks => array(select 'item ' || g from generate_series(1, 101) g), p_home_id => tests.i('home-a'))$$,
  'More than 100 checklist items is invalid', '22023');
select tests.assert_true(
  (select outcome = 'invalid_label' from public.create_task_template(tests.i('tpl-2'), 'Kot labels', 'T',
     p_label_ids => array[tests.i('lbl-b')], p_home_id => tests.i('home-a'))),
  'Another Home''s label is refused');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task_template(tests.i('tpl-2'), 'Garden', 'Mow',
     p_home_id => tests.i('home-a'))),
  'An Administrator without manageHomeTasks cannot either');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_template(tests.i('tpl-b'), 'Cleaning', 'Hoover',
     p_home_id => tests.i('home-b'))),
  'The same name is fine in another Home');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_template(tests.i('tpl-p'), 'Cleaning', 'My own',
     p_subtasks => array['One'])),
  'Carol has her own Personal templates');

-- Templates: reading ---------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(name = 'Cleaning' and subtask_count = 3 and label_count = 2)
   from public.list_task_templates(tests.i('home-a'))),
  'Every member sees the Home''s templates');
select tests.assert_true(
  (select count(*) = 1 and bool_and(id = tests.i('tpl-p')) from public.list_task_templates()),
  'Her Personal templates are hers only');
select tests.assert_true(public.get_task_template(tests.i('tpl-b')) is null,
  'Another Home''s template does not exist for her');
select tests.assert_denied($$select public.list_task_templates(tests.i('home-b'))$$,
  'Nor can she list them', '42501');
select tests.act_as('alice');
select tests.assert_true(public.get_task_template(tests.i('tpl-p')) is null, 'A Personal template is private');
select public.delete_task_label(tests.i('lbl-gone'), 1);
select tests.act_as('carol');
select tests.assert_true(
  (select (t ->> 'omittedLabels')::integer = 1 and (t -> 'labelIds') = jsonb_build_array(tests.i('lbl-1'))
     and (t -> 'subtasks') = '["Counters", "Sink", "Floor"]'::jsonb and not (t ->> 'canManage')::boolean
   from public.get_task_template(tests.i('tpl')) t),
  'A label deleted since is left out and counted, so the preview can say so');

-- Creating a task from a template ---------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created'
   from public.create_task_from_template(tests.i('n1'), tests.i('tpl'), 1, tests.i('l-a'),
     'Clean kitchen', 'Wipe everything', 'high', array[tests.i('lbl-1')], array['Counters', 'Sink', 'Floor'],
     p_due_date => current_date + 1)),
  'Carol (any member) creates a task from the reviewed preview');
select tests.act_as_owner();
select tests.assert_true(
  (select t.owner_home_id = tests.i('home-a') and t.completed_at is null and t.priority = 'high'
     and t.created_by = tests.user_id('carol') and t.series_id is null
   from private.tasks t where t.id = tests.i('n1'))
  and (select array_agg(title order by position) = array['Counters', 'Sink', 'Floor']
         and bool_and(completed_at is null)
       from private.subtasks where task_id = tests.i('n1'))
  and tests.labels(tests.i('n1')) = array[tests.i('lbl-1')]
  and not exists (select 1 from private.task_assignees where task_id = tests.i('n1')),
  'An independent open task, its checklist in order and open, the confirmed labels, no assignees');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'exists'
   from public.create_task_from_template(tests.i('n1'), tests.i('tpl'), 1, tests.i('l-a'),
     'Clean kitchen', null, null, '{}', array['Counters', 'Sink', 'Floor'])),
  'A double submit answers exists');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 3 from private.subtasks where task_id = tests.i('n1')),
  'No second checklist');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'invalid_label'
   from public.create_task_from_template(tests.i('n2'), tests.i('tpl'), 1, tests.i('l-a'),
     'Clean', null, null, array[tests.i('lbl-gone')], '{}')),
  'Labels are checked again at confirmation');
select tests.act_as_owner();
select tests.assert_true(not exists (select 1 from private.tasks where id = tests.i('n2')),
  'Nothing was created');
select tests.act_as('alice');
select public.update_task_list(tests.i('l-arch'), 1, 'Old', true);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'list_unavailable'
   from public.create_task_from_template(tests.i('n2'), tests.i('tpl'), 1, tests.i('l-arch'),
     'Clean', null, null, '{}', array['A'])),
  'An archived list is refused');
select tests.assert_true(
  (select outcome = 'list_unavailable'
   from public.create_task_from_template(tests.i('n2'), tests.i('tpl'), 1, tests.i('l-c'),
     'Clean', null, null, '{}', array['A'])),
  'A list of another context (her Personal space) is refused');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.subtasks where task_id = tests.i('n2')),
  'No checklist was left behind');

-- Template edits never reach tasks made from it
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2
   from public.update_task_template(tests.i('tpl'), 1, 'Cleaning', 'Clean the kitchen', null, null,
     array[tests.i('lbl-2')], array['Only this'])),
  'The Owner edits the template');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2
   from public.update_task_template(tests.i('tpl'), 1, 'Cleaning', 'X', p_label_ids => '{}')),
  'A stale edit is refused');
select tests.act_as_owner();
select tests.assert_true(
  (select title = 'Clean kitchen' from private.tasks where id = tests.i('n1'))
  and (select count(*) = 3 from private.subtasks where task_id = tests.i('n1')),
  'The task made earlier is unchanged');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'template_changed' and revision = 2
   from public.create_task_from_template(tests.i('n2'), tests.i('tpl'), 1, tests.i('l-a'),
     'Clean kitchen', null, null, '{}', '{}')),
  'A preview of an older version is refused with the current revision');
select tests.assert_true(
  (select outcome = 'not_permitted'
   from public.update_task_template(tests.i('tpl'), 2, 'Mine now', 'X', p_label_ids => '{}')),
  'A plain Member cannot edit it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_task_template(tests.i('tpl'), 2)),
  'Nor delete it');

-- Rights through the capability
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeTasks']);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.update_task_template(tests.i('tpl'), 2, 'cleaning',
     'Clean', p_label_ids => '{}')) is not true,
  'Keeping its own name is no duplicate');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_template(tests.i('tpl-2'), 'Garden', 'Mow',
     p_home_id => tests.i('home-a'))),
  'With manageHomeTasks, Bob creates Home templates');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.update_task_template(tests.i('tpl-2'), 1, 'Cleaning',
     'Mow', p_label_ids => '{}')),
  'Renaming onto another template''s name is refused');

-- Deleting
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_task_template(tests.i('tpl'), tests.trev(tests.i('tpl')))),
  'The Owner deletes the template');
select tests.act_as_owner();
select tests.assert_true(
  (select deleted_at is null from private.tasks where id = tests.i('n1')),
  'The task made from it stays');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_found'
   from public.create_task_from_template(tests.i('n2'), tests.i('tpl'), 2, tests.i('l-a'), 'X', null, null,
     '{}', '{}')),
  'A deleted template cannot be used');

-- Leaving the Home
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_true(public.get_task_template(tests.i('tpl-2')) is null,
  'After leaving, Carol no longer sees the Home''s templates');
select tests.act_as_owner();
select tests.assert_true(exists (select 1 from private.task_templates where id = tests.i('tpl-2')),
  'They stay with the Home');
insert into public.home_memberships (home_id, user_id, role)
  values (tests.i('home-a'), tests.user_id('carol'), 'member');

-- Personal: from her own template, into her own list
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created'
   from public.create_task_from_template(tests.i('n-p'), tests.i('tpl-p'), 1, tests.i('l-c'), 'My own',
     null, null, '{}', array['One'])),
  'A Personal task from a Personal template');
select tests.assert_true(
  (select outcome = 'list_unavailable'
   from public.create_task_from_template(tests.i('n3'), tests.i('tpl-p'), 1, tests.i('l-a'), 'My own',
     null, null, '{}', '{}')),
  'Never into a Home list');

-- Bulk actions ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select public.create_task(tests.i('b1'), tests.i('l-a'), 'Carol one', p_home_id => tests.i('home-a'),
  p_label_ids => array[tests.i('lbl-1')]);
select public.add_subtask(gen_random_uuid(), tests.i('b1'), 'Unfinished');
select public.create_task(tests.i('b2'), tests.i('l-a'), 'Carol two', p_home_id => tests.i('home-a'));
select public.create_task_series(tests.i('s1'), tests.i('l-a'), 'Daily', 'daily', 1,
  (now() at time zone 'Europe/Brussels')::date, p_home_id => tests.i('home-a'));
select tests.act_as_owner();
insert into ids select 'occ', id from private.tasks where series_root_id = tests.i('s1')
  order by occurrence_date limit 1;
select tests.act_as('alice');
select public.create_task(tests.i('b3'), tests.i('l-a'), 'Alice''s, shared', p_home_id => tests.i('home-a'),
  p_assignee_ids => array[tests.i('m-bob-a'), (select id from public.home_memberships
    where home_id = tests.i('home-a') and user_id = tests.user_id('alice'))]);
select public.create_task(tests.i('b4'), tests.i('l-a'), 'Alice''s, not Carol''s', p_home_id => tests.i('home-a'));
select tests.act_as('bob');
select public.create_task(tests.i('b-b'), tests.i('l-b'), 'Home B', p_home_id => tests.i('home-b'));
select tests.act_as('carol');
select public.create_task(tests.i('b-p'), tests.i('l-c'), 'Personal');

-- Complete: a mixed selection
select tests.assert_true(
  (select jsonb_object_agg(r.task_id, r.outcome) = jsonb_build_object(
       tests.i('b1'), 'will_change', tests.i('b2'), 'will_change', tests.i('occ'), 'will_change',
       tests.i('b4'), 'not_permitted', tests.i('b-b'), 'not_found', tests.i('b-p'), 'not_found')
     and bool_or(r.task_id = tests.i('b1') and r.open_subtasks = 1)
     and bool_or(r.task_id = tests.i('occ') and r.recurring)
   from public.bulk_update_tasks(array[tests.i('b1'), tests.i('b2'), tests.i('occ'), tests.i('b4'),
     tests.i('b-b'), tests.i('b-p')], 'complete', null, true, tests.i('home-a')) r),
  'The preview: her tasks will change (with an unfinished checklist and a recurring one flagged); not Alice''s; other contexts do not exist here');
select tests.act_as_owner();
select tests.assert_true(not exists (select 1 from private.tasks where id in (tests.i('b1'), tests.i('b2'))
  and completed_at is not null), 'The preview changed nothing');
select tests.act_as('carol');
select tests.assert_denied(
  $$select public.bulk_update_tasks(array[tests.i('b1')], 'complete', null, false, tests.i('home-a'))$$,
  'A real run needs the revisions from the preview', '22023');
select tests.act_as('alice');
select public.update_task(tests.i('b2'), 1, 'Carol two, renamed', '{}');
select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_object_agg(r.task_id, r.outcome) = jsonb_build_object(
       tests.i('b1'), 'changed', tests.i('b2'), 'conflict', tests.i('occ'), 'changed',
       tests.i('b4'), 'not_permitted')
   from public.bulk_update_tasks(array[tests.i('b1'), tests.i('b2'), tests.i('occ'), tests.i('b4')],
     'complete', jsonb_build_object(tests.i('b1'), 1, tests.i('b2'), 1, tests.i('occ'), 1, tests.i('b4'), 1),
     false, tests.i('home-a')) r),
  'Partial success: completed, changed since the preview (not overwritten), not permitted');
select tests.act_as_owner();
select tests.assert_true(
  (select completed_by = tests.user_id('carol') from private.tasks where id = tests.i('b1'))
  and (select completed_at is null and title = 'Carol two, renamed' from private.tasks where id = tests.i('b2'))
  and (select count(*) = 1 from private.audit_events where action = 'task.completed' and subject_id = tests.i('b1')),
  'Completed by Carol, once; the conflicting task was left as it is');
select tests.assert_true(
  (select count(*) = 1 from private.tasks where series_root_id = tests.i('s1') and completed_at is not null)
  and (select paused_at is null and deleted_at is null from private.task_series where id = tests.i('s1')),
  'Only the selected occurrence was completed; the series goes on');
select tests.act_as('carol');
select tests.assert_true(
  (select bool_and(r.outcome = 'unchanged')
   from public.bulk_update_tasks(array[tests.i('b1'), tests.i('occ')], 'complete',
     jsonb_build_object(tests.i('b1'), 1, tests.i('occ'), 1), false, tests.i('home-a')) r),
  'A retry answers unchanged');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events where action = 'task.completed' and subject_id = tests.i('b1')),
  'and records no second completion');

-- Priority
select tests.act_as('carol');
select tests.assert_true(
  (select bool_and(r.outcome = 'changed')
   from public.bulk_update_tasks(array[tests.i('b2'), tests.i('occ')], 'priority',
     tests.revs('b2', 'occ'), false, tests.i('home-a'), p_priority => 'urgent') r),
  'Priority for two tasks');
select tests.act_as_owner();
select tests.assert_true(
  (select bool_and(priority = 'urgent') from private.tasks where id in (tests.i('b2'), tests.i('occ')))
  and (select detached from private.tasks where id = tests.i('occ')),
  'Both are urgent; the occurrence is now changed on its own');
select tests.act_as('carol');
select tests.assert_true(
  (select bool_and(r.outcome = 'changed')
   from public.bulk_update_tasks(array[tests.i('b2')], 'priority', tests.revs('b2'), false,
     tests.i('home-a'), p_priority => null) r),
  'Back to unspecified');

-- Labels: add, remove, replace
select tests.assert_true(
  (select bool_and(r.outcome = case when r.task_id = tests.i('b2') then 'changed' else 'unchanged' end)
   from public.bulk_update_tasks(array[tests.i('b1'), tests.i('b2')], 'labels', tests.revs('b1', 'b2'),
     false, tests.i('home-a'), p_label_mode => 'add', p_label_ids => array[tests.i('lbl-1')]) r),
  'Adding a label the first task already has leaves it unchanged');
select tests.assert_true(
  (select bool_and(r.outcome = 'changed')
   from public.bulk_update_tasks(array[tests.i('b1'), tests.i('b2')], 'labels', tests.revs('b1', 'b2'),
     false, tests.i('home-a'), p_label_mode => 'add', p_label_ids => array[tests.i('lbl-2')]) r),
  'Adding a second label');
select tests.assert_true(
  tests.labels(tests.i('b1')) = tests.sorted(array[tests.i('lbl-1'), tests.i('lbl-2')]),
  'Existing labels were kept');
select public.bulk_update_tasks(array[tests.i('b1')], 'labels', tests.revs('b1'), false, tests.i('home-a'),
  p_label_mode => 'remove', p_label_ids => array[tests.i('lbl-1')]);
select tests.assert_true(tests.labels(tests.i('b1')) = array[tests.i('lbl-2')], 'Removing only that one');
select public.bulk_update_tasks(array[tests.i('b1'), tests.i('b2')], 'labels', tests.revs('b1', 'b2'), false,
  tests.i('home-a'), p_label_mode => 'replace', p_label_ids => array[tests.i('lbl-1')]);
select tests.assert_true(
  tests.labels(tests.i('b1')) = array[tests.i('lbl-1')] and tests.labels(tests.i('b2')) = array[tests.i('lbl-1')],
  'Replacing sets exactly those');
select tests.assert_true(
  (select bool_and(r.outcome = 'invalid_label')
   from public.bulk_update_tasks(array[tests.i('b1')], 'labels', tests.revs('b1'), false, tests.i('home-a'),
     p_label_mode => 'add', p_label_ids => array[tests.i('lbl-b')]) r),
  'Another Home''s label is refused for every task');

-- Move
select tests.assert_true(
  (select bool_and(r.outcome = 'changed')
   from public.bulk_update_tasks(array[tests.i('b1'), tests.i('b2')], 'move', tests.revs('b1', 'b2'), false,
     tests.i('home-a'), p_list_id => tests.i('l-a2')) r),
  'Moving to another list of the Home');
select tests.act_as_owner();
select tests.assert_true(
  (select bool_and(list_id = tests.i('l-a2')) from private.tasks where id in (tests.i('b1'), tests.i('b2')))
  and (select count(*) = 1 from private.subtasks where task_id = tests.i('b1')),
  'They moved with their checklist');
select tests.act_as('carol');
select tests.assert_true(
  (select bool_and(r.outcome = 'list_unavailable')
   from public.bulk_update_tasks(array[tests.i('b1')], 'move', tests.revs('b1'), false, tests.i('home-a'),
     p_list_id => tests.i('l-arch')) r),
  'Never into an archived list');
select tests.assert_true(
  (select bool_and(r.outcome = 'list_unavailable')
   from public.bulk_update_tasks(array[tests.i('b1')], 'move', tests.revs('b1'), false, tests.i('home-a'),
     p_list_id => tests.i('l-c')) r),
  'Nor into her Personal list (no cross-context moves)');
select tests.assert_true(
  (select bool_and(r.outcome = 'list_unavailable')
   from public.bulk_update_tasks(array[tests.i('b-p')], 'move', tests.revs('b-p'), false, null,
     p_list_id => tests.i('l-a')) r),
  'Nor from her Personal space into a Home');

-- Limits and context
select tests.assert_denied(
  $$select public.bulk_update_tasks(array(select gen_random_uuid() from generate_series(1, 101)),
    'complete', null, true, tests.i('home-a'))$$,
  'At most 100 tasks', '22023');
select tests.assert_denied(
  $$select public.bulk_update_tasks(array[tests.i('b1')], 'delete', null, true, tests.i('home-a'))$$,
  'Only the four actions', '22023');
select tests.assert_denied(
  $$select public.bulk_update_tasks(array[tests.i('b-b')], 'complete', null, true, tests.i('home-b'))$$,
  'A Home she is not in', '42501');
