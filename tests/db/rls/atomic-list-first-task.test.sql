-- UX4a: public.create_task_list_with_task (supabase/migrations/*_atomic_list_first_task.sql).
-- Alice owns Home A where Carol is a plain Member; Bob is outside it.
-- Covers: both created together; retry; forged/taken ids; a refused task leaves no list;
-- duplicate name; permissions (lists need a task manager); personal context; signed-out caller;
-- audit entries only for committed work.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select n, gen_random_uuid() from unnest(array[
  'l1', 'l2', 'l3', 'l4', 'l5', 'l-p', 't1', 't2', 't3', 't4', 't5', 't-p', 't-x'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.lists_in_a() returns bigint
  language sql stable security definer as $$
  select count(*) from private.task_lists
  where owner_home_id = (select id from ids where name = 'home-a'); $$;
create function tests.has_list(p_name text) returns boolean
  language sql stable security definer as $$
  select exists (select 1 from private.task_lists where id = tests.i(p_name)); $$;
create function tests.has_task(p_name text) returns boolean
  language sql stable security definer as $$
  select exists (select 1 from private.tasks where id = tests.i(p_name)); $$;
create function tests.task_in_home_list(p_task text, p_list text) returns boolean
  language sql stable security definer as $$
  select exists (select 1 from private.tasks t join private.task_lists l on l.id = t.list_id
    where t.id = tests.i(p_task) and l.id = tests.i(p_list)
      and l.owner_home_id = tests.i('home-a') and t.owner_home_id = tests.i('home-a')); $$;
create function tests.task_is_personal_of(p_task text, p_user text) returns boolean
  language sql stable security definer as $$
  select exists (select 1 from private.tasks
    where id = tests.i(p_task) and owner_user_id = tests.user_id(p_user) and owner_home_id is null); $$;
grant execute on function tests.i(text), tests.lists_in_a(), tests.has_list(text), tests.has_task(text),
  tests.task_in_home_list(text, text), tests.task_is_personal_of(text, text)
  to authenticated, service_role;

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' and list_revision = 1 and task_revision = 1
    from public.create_task_list_with_task(tests.i('l1'), 'Errands', tests.i('t1'), 'Buy milk',
      null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A task manager creates a list and its first task together');
select tests.assert_true(
  tests.task_in_home_list('t1', 'l1'),
  'The task sits in the new list of the Home');
select tests.assert_true(
  (select outcome = 'exists' from public.create_task_list_with_task(tests.i('l1'), 'Errands', tests.i('t1'),
    'Buy milk', null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A retry returns the same pair');
select tests.assert_true(
  tests.lists_in_a() = 1 and tests.has_task('t1'),
  'And makes nothing new');
select tests.assert_true(
  (select outcome = 'list_id_taken' from public.create_task_list_with_task(tests.i('l1'), 'Errands',
    tests.i('t2'), 'Other', null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'An existing list id is refused when the task is not the earlier one');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.create_task_list_with_task(tests.i('l2'), 'errands',
    tests.i('t2'), 'Other', null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A confusing duplicate list name is refused');
select tests.assert_true(
  not tests.has_list('l2')
    and not tests.has_task('t2'),
  'And nothing is created');

-- A refused first task leaves no list behind.
select tests.assert_true(
  (select outcome = 'task_id_taken' from public.create_task_list_with_task(tests.i('l3'), 'Garden',
    tests.i('t1'), 'Reuses a task id', null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A task id that exists is refused');
select tests.assert_true(
  not tests.has_list('l3'),
  'And the list made a moment before is undone');
select tests.assert_true(
  (select outcome = 'invalid_label' from public.create_task_list_with_task(tests.i('l3'), 'Garden',
    tests.i('t3'), 'Water', null, null, null, null, array[gen_random_uuid()], '{}', tests.i('home-a'))),
  'An unknown label is refused');
select tests.assert_true(
  (select outcome = 'invalid_assignee' from public.create_task_list_with_task(tests.i('l3'), 'Garden',
    tests.i('t3'), 'Water', null, null, null, null, '{}', array[gen_random_uuid()], tests.i('home-a'))),
  'An unknown assignee is refused');
select tests.assert_true(
  (select outcome = 'task_id_taken' from public.create_task_list_with_task(tests.i('l5'), 'Other',
    tests.i('t1'), 'Again', null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'Reusing the own task id with a new list is refused, not reported as success');
select tests.assert_true(
  not tests.has_list('l5'),
  'And leaves no list');
select tests.assert_true(tests.lists_in_a() = 1, 'Still only the first list in the Home');
select tests.assert_denied(
  $$select * from public.create_task_list_with_task(gen_random_uuid(), 'Bad', gen_random_uuid(), ' ',
    null, null, null, null, '{}', '{}', tests.i('home-a'))$$,
  'An invalid title is refused with an error', '22023');
select tests.assert_true(tests.lists_in_a() = 1, 'And creates no list');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 0 from private.audit_events
    where subject_id in (tests.i('l3'), tests.i('t3'))),
  'Undone work leaves no audit entry');
select tests.assert_true(
  (select count(*) = 2 from private.audit_events
    where subject_id in (tests.i('l1'), tests.i('t1'))),
  'Committed work is audited once each');

-- Permissions: lists need a task manager.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_task_list_with_task(tests.i('l4'), 'Mine',
    tests.i('t4'), 'Try', null, null, null, null, '{}', '{}', tests.i('home-a'))),
  'A plain member cannot create a Home list, so no task either');
select tests.assert_true(
  not tests.has_task('t4'), 'Nothing is left');

-- Another person's Home and the personal space.
select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.create_task_list_with_task(gen_random_uuid(), 'Sneak', gen_random_uuid(), 'x',
    null, null, null, null, '{}', '{}', tests.i('home-a'))$$,
  'Someone outside the Home is refused');
select tests.assert_true(
  (select outcome = 'created' from public.create_task_list_with_task(tests.i('l-p'), 'Personal',
    tests.i('t-p'), 'Mine', null, null, null, null, '{}', '{}')),
  'The personal space has no manager rule');
select tests.assert_true(
  tests.task_is_personal_of('t-p', 'bob'),
  'The task is Bob''s own');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'list_id_taken' from public.create_task_list_with_task(tests.i('l-p'), 'Personal',
    tests.i('t-x'), 'Forged', null, null, null, null, '{}', '{}')),
  'Alice cannot reuse Bob''s list id');

select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.create_task_list_with_task(gen_random_uuid(), 'x', gen_random_uuid(), 'x')$$,
  'Signed out callers are refused');
