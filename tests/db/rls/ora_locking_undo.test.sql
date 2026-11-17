-- S47d: Ora's locking Undo functions (supabase/migrations/20261210090000_ora_locking_undo.sql).
-- Alice owns Home A where Carol is a plain Member; Bob owns Home B. Covers: signed-out visitors
-- refused; each Undo only while the record is still as Ora left it (revision or completion time),
-- never overwriting someone else's edit; other accounts and plain Members without the module's
-- own right refused; a second Undo answers not_found; the history table accepts the new kinds.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;
create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
grant execute on function tests.i(text) to authenticated, service_role;

create function tests.q(p_sql text) returns boolean
  language plpgsql security definer as $$
  declare v boolean;
  begin execute p_sql into v; return v; end $$;
grant execute on function tests.q(text) to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select n, gen_random_uuid() from unnest(array[
  'l-task', 'l-home-task', 'l-shop', 't-create', 't-edited', 't-home', 't-done', 't-undone',
  't-due', 't-due-edited', 't-due-home', 'i-create', 'i-edited'
]) as n;

-- Signed-out visitors ------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.ora_undo_task_create(gen_random_uuid(), 1)$$,
  'A signed-out visitor cannot undo a task creation');
select tests.assert_denied(
  $$select * from public.ora_undo_shopping_item(gen_random_uuid(), 1)$$,
  'Nor a shopping item');
select tests.assert_denied(
  $$select * from public.ora_undo_task_completion(gen_random_uuid(), now())$$,
  'Nor a completion');
select tests.assert_denied(
  $$select * from public.ora_undo_task_due(gen_random_uuid(), 1, null)$$,
  'Nor a due-date change');

-- Setup as Alice -------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_task_list(tests.i('l-task'), 'Inbox');
select public.create_task_list(tests.i('l-home-task'), 'Chores', tests.i('home-a'));
select public.create_shopping_list(tests.i('l-shop'), 'Weekly');
select public.create_task(tests.i('t-create'), tests.i('l-task'), 'Water plants');
select public.create_task(tests.i('t-edited'), tests.i('l-task'), 'Pay rent');
select public.create_task(tests.i('t-home'), tests.i('l-home-task'), 'Vacuum', null, null, null, null,
  '{}', '{}', tests.i('home-a'));
select public.add_shopping_items(tests.i('l-shop'), jsonb_build_array(
  jsonb_build_object('id', tests.i('i-create'), 'name', 'Milk', 'allowDuplicate', false),
  jsonb_build_object('id', tests.i('i-edited'), 'name', 'Eggs', 'allowDuplicate', false)));

-- Undo of a creation: tasks ---------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.ora_undo_task_create(tests.i('t-create'), 1)),
  'Another account cannot reach Alice''s personal task');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_found' from public.ora_undo_task_create(gen_random_uuid(), 1)),
  'An unknown task is not found');
select tests.assert_true(
  (select outcome = 'deleted' from public.ora_undo_task_create(tests.i('t-create'), 1)),
  'An untouched new task goes to the trash');
select tests.assert_true(
  (select outcome = 'not_found' from public.ora_undo_task_create(tests.i('t-create'), 1)),
  'A second Undo answers not_found');

select tests.assert_true(
  (select outcome = 'saved' from public.update_task(tests.i('t-edited'), 1, 'Pay the rent', '{}')),
  'Alice edits the task after Ora added it (revision 2)');
select tests.assert_true(
  (select outcome = 'conflict' from public.ora_undo_task_create(tests.i('t-edited'), 1)),
  'Undo refuses once the task was edited');
select tests.assert_true(
  tests.q($$select title = 'Pay the rent' from private.tasks where id = tests.i('t-edited') and deleted_at is null$$),
  'The edited task is untouched and not in the trash');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.ora_undo_task_create(tests.i('t-home'), 1)),
  'A plain Member who did not create the Home task cannot trash it');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' from public.ora_undo_task_create(tests.i('t-home'), 1)),
  'The creator can');

-- Undo of a creation: shopping items ---------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.ora_undo_shopping_item(tests.i('i-create'), 1)),
  'Another account cannot reach Alice''s personal item');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' from public.ora_undo_shopping_item(tests.i('i-create'), 1)),
  'An untouched new item goes to the trash');
select tests.assert_true(
  (select outcome = 'not_found' from public.ora_undo_shopping_item(tests.i('i-create'), 1)),
  'A second Undo answers not_found');
select tests.assert_true(
  (select outcome = 'saved' from public.update_shopping_item(tests.i('i-edited'), 1, 'Free-range eggs')),
  'Alice edits the item after Ora added it');
select tests.assert_true(
  (select outcome = 'conflict' from public.ora_undo_shopping_item(tests.i('i-edited'), 1)),
  'Undo refuses once the item was edited');
select tests.assert_true(
  tests.q($$select name = 'Free-range eggs' from private.shopping_items where id = tests.i('i-edited') and deleted_at is null$$),
  'The edited item is untouched');

-- Undo of a completion ------------------------------------------------------------------------------------

select public.create_task(tests.i('t-done'), tests.i('l-task'), 'Call mum');
select public.create_task(tests.i('t-undone'), tests.i('l-task'), 'Book dentist');
create temporary table stamps (name text primary key, at timestamptz not null);
grant all on stamps to authenticated;
insert into stamps select 'done', completed_at from public.set_task_completion(tests.i('t-done'), true);
insert into stamps select 'undone', completed_at from public.set_task_completion(tests.i('t-undone'), true);

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found'
     from public.ora_undo_task_completion(tests.i('t-done'), (select at from stamps where name = 'done'))),
  'Another account cannot reach the task');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'conflict'
     from public.ora_undo_task_completion(tests.i('t-done'), (select at - interval '1 second' from stamps where name = 'done'))),
  'A completion that is not the one Ora made is left alone');
select tests.assert_true(
  tests.q($$select completed_at is not null from private.tasks where id = tests.i('t-done')$$),
  'And the task is still completed');
select tests.assert_true(
  (select outcome = 'reopened'
     from public.ora_undo_task_completion(tests.i('t-done'), (select at from stamps where name = 'done'))),
  'The matching completion is undone: the task is open again');
select tests.assert_true(
  tests.q($$select completed_at is null from private.tasks where id = tests.i('t-done')$$),
  'It is really open');
select tests.assert_true(
  (select outcome = 'conflict'
     from public.ora_undo_task_completion(tests.i('t-done'), (select at from stamps where name = 'done'))),
  'A second Undo finds it open and changes nothing');
-- Someone reopened it first.
select public.set_task_completion(tests.i('t-undone'), false);
select tests.assert_true(
  (select outcome = 'conflict'
     from public.ora_undo_task_completion(tests.i('t-undone'), (select at from stamps where name = 'undone'))),
  'Undo after someone else reopened it changes nothing');

-- Undo of a due-date change ------------------------------------------------------------------------------

select public.create_task(tests.i('t-due'), tests.i('l-task'), 'Renew passport', 'Bring photos', null,
  date '2027-03-01', 'high');
select public.create_task(tests.i('t-due-edited'), tests.i('l-task'), 'Book flights', null, null,
  date '2027-04-01');
select public.create_task(tests.i('t-due-home'), tests.i('l-home-task'), 'Clean gutters', null, null,
  date '2027-05-01', null, '{}', '{}', tests.i('home-a'));
-- Ora's change: the task's own update with a new date (revision 2).
select public.update_task(tests.i('t-due'), 1, 'Renew passport', '{}', 'Bring photos', null,
  date '2027-03-15', 'high');
select public.update_task(tests.i('t-due-edited'), 1, 'Book flights', '{}', null, null, date '2027-04-15');
select public.update_task(tests.i('t-due-home'), 1, 'Clean gutters', '{}', null, null, date '2027-05-15');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.ora_undo_task_due(tests.i('t-due'), 2, date '2027-03-01')),
  'Another account cannot reach the task');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.ora_undo_task_due(tests.i('t-due-home'), 2, date '2027-05-01')),
  'A plain Member who may not edit the Home task cannot change its date back');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.ora_undo_task_due(tests.i('t-due'), 2, date '2027-03-01')),
  'The old due date is put back');
select tests.assert_true(
  tests.q($$select due_date = date '2027-03-01' and title = 'Renew passport' and description = 'Bring photos'
     and priority = 'high' and revision = 3 from private.tasks where id = tests.i('t-due')$$),
  'Only the date changed: title, description and priority are as they were');
select tests.assert_true(
  (select outcome = 'conflict' from public.ora_undo_task_due(tests.i('t-due'), 2, date '2027-03-01')),
  'A second Undo finds the task at a newer revision and changes nothing');
select tests.assert_true(
  (select outcome = 'saved' from public.update_task(tests.i('t-due-edited'), 2, 'Book the flights', '{}', null, null, date '2027-04-15')),
  'Someone edits the task after Ora''s change');
select tests.assert_true(
  (select outcome = 'conflict' from public.ora_undo_task_due(tests.i('t-due-edited'), 2, date '2027-04-01')),
  'Undo refuses and keeps their edit');
select tests.assert_true(
  tests.q($$select due_date = date '2027-04-15' and title = 'Book the flights'
     from private.tasks where id = tests.i('t-due-edited')$$),
  'Their edit, and the new date, stand');
select tests.assert_true(
  (select outcome = 'saved' from public.ora_undo_task_due(tests.i('t-due-home'), 2, null)),
  'The date can be put back to "no date"');
select tests.assert_true(
  tests.q($$select due_date is null from private.tasks where id = tests.i('t-due-home')$$),
  'And is empty');

-- History lines for the new changes -----------------------------------------------------------------------

select tests.assert_allowed(
  $$insert into public.ora_interactions (scope, kind, label) values
      ('personal', 'task-completed', 'Call mum'),
      ('personal', 'task-completion-undone', 'Call mum'),
      ('personal', 'task-due-changed', 'Renew passport'),
      ('personal', 'task-due-restored', 'Renew passport')$$,
  'The history accepts the four new kinds');
select tests.assert_denied(
  $$insert into public.ora_interactions (scope, kind, label) values ('personal', 'task-deleted', 'x')$$,
  'But not an unknown kind', '23514');
