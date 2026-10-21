-- S19c: the task calendar window and the widget timing filters (supabase/migrations/
-- *_task_attachments_calendar_widgets.sql). Alice owns Home A, where Carol is a Member; Bob owns
-- Home B. Covers: tasks on their due dates and start dates; completed, overdue and recurring entries;
-- planned dates of a recurring series (not of a paused one, never twice); the filters; archived and
-- deleted lists; the window and entry limits; other Homes and the Personal space; the undated count;
-- list_tasks 'due_today', 'due_week' and 'undated'.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Pacific/Auckland', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');

insert into ids select n, gen_random_uuid() from unnest(array[
  'l-a', 'l-arch', 'l-p', 'l-b', 't-today', 't-week', 't-later', 't-overdue', 't-done', 't-start',
  't-nodue', 't-arch', 't-p', 't-b', 'lbl', 's-daily', 's-paused'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.cal(p_from date, p_to date, p_home uuid, p_status text default 'all',
  p_priorities text[] default null, p_labels uuid[] default null, p_assignee text default 'any',
  p_member uuid default null, p_list uuid default null)
returns jsonb
  language sql as $$
  select public.list_task_calendar(p_from, p_to, p_home, null, p_list, p_status, p_priorities,
    p_labels, p_assignee, p_member); $$;
create function tests.titles(p_calendar jsonb, p_kind text default null, p_role text default null) returns text[]
  language sql immutable as $$
  select coalesce(array_agg(e ->> 'title' order by e ->> 'title'), '{}')
  from jsonb_array_elements(p_calendar -> 'entries') e
  where (p_kind is null or e ->> 'kind' = p_kind) and (p_role is null or e ->> 'role' = p_role); $$;
create function tests.listed(p_when text, p_home uuid) returns text[]
  language sql as $$
  select coalesce(array_agg(title order by title), '{}')
  from public.list_tasks(p_home, null, null, 'all', p_when, false); $$;
grant execute on function tests.i(text), tests.today_a(),
  tests.cal(date, date, uuid, text, text[], uuid[], text, uuid, uuid), tests.titles(jsonb, text, text),
  tests.listed(text, uuid) to authenticated, service_role;

-- Setup ------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_task_list(tests.i('l-a'), 'Chores', tests.i('home-a'));
select public.create_task_list(tests.i('l-arch'), 'Old', tests.i('home-a'));
select public.create_task_list(tests.i('l-p'), 'Mine');
select public.create_task_label(tests.i('lbl'), 'Kitchen', null, tests.i('home-a'));
select public.create_task(tests.i('t-today'), tests.i('l-a'), 'Today', p_due_date => tests.today_a(),
  p_priority => 'high', p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-week'), tests.i('l-a'), 'This week', p_due_date => tests.today_a() + 6,
  p_label_ids => array[tests.i('lbl')], p_assignee_ids => array[tests.i('m-carol-a')],
  p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-later'), tests.i('l-a'), 'Later', p_due_date => tests.today_a() + 7,
  p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-overdue'), tests.i('l-a'), 'Overdue', p_due_date => tests.today_a() - 1,
  p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-done'), tests.i('l-a'), 'Done', p_due_date => tests.today_a() + 1,
  p_home_id => tests.i('home-a'));
select public.set_task_completion(tests.i('t-done'), true);
select public.create_task(tests.i('t-start'), tests.i('l-a'), 'Starts', p_start_date => tests.today_a() + 2,
  p_due_date => tests.today_a() + 4, p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-nodue'), tests.i('l-a'), 'Someday', p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-arch'), tests.i('l-arch'), 'In old list', p_due_date => tests.today_a(),
  p_home_id => tests.i('home-a'));
select public.set_task_completion(tests.i('t-arch'), true);
select public.update_task_list(tests.i('l-arch'), 1, 'Old', true);
select public.create_task(tests.i('t-p'), tests.i('l-p'), 'Personal', p_due_date => current_date);
select public.create_task_series(tests.i('s-daily'), tests.i('l-a'), 'Daily', 'daily', 1, tests.today_a(),
  p_home_id => tests.i('home-a'));
select public.create_task_series(tests.i('s-paused'), tests.i('l-a'), 'Paused', 'weekly', 1, tests.today_a(),
  p_weekdays => '{1,2,3,4,5,6,7}', p_home_id => tests.i('home-a'));
select tests.act_as_owner();
update private.task_series set paused_at = now() where root_id = tests.i('s-paused');
select tests.act_as('bob');
select public.create_task_list(tests.i('l-b'), 'Kot', tests.i('home-b'));
select public.create_task(tests.i('t-b'), tests.i('l-b'), 'Bob''s', p_due_date => current_date,
  p_home_id => tests.i('home-b'));

-- The window -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')), 'task', 'due')
    = array['Daily', 'Daily', 'Done', 'Overdue', 'Paused', 'Paused', 'Starts', 'This week', 'Today'],
  'Due tasks in the window, completed and overdue included, recurring occurrences that exist, not the archived list');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')), 'task', 'start')
    = array['Starts'],
  'A start date in the window is a separate marker');
select tests.assert_true(
  (select count(*) = 5 from jsonb_array_elements(
     tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')) -> 'entries') e
   where e ->> 'kind' = 'planned' and e ->> 'title' = 'Daily'),
  'A daily series has planned dates after its existing occurrences (today and tomorrow exist)');
select tests.assert_true(
  not ('Paused' = any (tests.titles(tests.cal(tests.today_a(), tests.today_a() + 6, tests.i('home-a')), 'planned'))),
  'A paused series plans nothing');
select tests.assert_true(
  (select bool_and((e ->> 'taskId') is not null) from jsonb_array_elements(
     tests.cal(tests.today_a(), tests.today_a() + 6, tests.i('home-a')) -> 'entries') e
   where e ->> 'kind' = 'planned'),
  'A planned date opens the series'' latest occurrence');
select tests.assert_true(
  (select count(*) = count(distinct e ->> 'date') from jsonb_array_elements(
     tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')) -> 'entries') e
   where e ->> 'title' = 'Daily' and e ->> 'role' = 'due'),
  'Never an occurrence and a planned date on the same day');
select tests.assert_true(
  (select (e ->> 'overdue')::boolean from jsonb_array_elements(
     tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')) -> 'entries') e
   where e ->> 'title' = 'Overdue'),
  'An open task due before today is overdue');
select tests.assert_true(
  (select (e ->> 'completed')::boolean and not (e ->> 'canComplete')::boolean
   from jsonb_array_elements(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')) -> 'entries') e
   where e ->> 'title' = 'Done'),
  'Completed is shown; a member who may not edit it gets no completion control');
select tests.assert_true(
  (select (e ->> 'canComplete')::boolean from jsonb_array_elements(
     tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a')) -> 'entries') e
   where e ->> 'title' = 'This week'),
  'An assignee may complete from the calendar');
select tests.assert_true(
  (tests.cal(tests.today_a(), tests.today_a() + 6, tests.i('home-a')) ->> 'undated')::integer = 1,
  'Tasks without a due date are counted, never placed');

-- Filters -------------------------------------------------------------------------------------------------

select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'), 'completed')) = array['Done'],
  'Completed only: no planned dates');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'), 'all', array['high'])) = array['Today'],
  'Priority filter');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'), 'all', null, array[tests.i('lbl')])) = array['This week'],
  'Label filter');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'), 'all', null, null, 'me')) = array['This week'],
  'Assigned to me');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'), 'all', null, null, 'member', tests.i('m-carol-a'))) = array['This week'],
  'Assigned to a member');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'), 'all', null, null, 'any', null, tests.i('l-arch'))) = array['In old list'],
  'An archived list chosen explicitly shows its tasks');

-- Boundaries ------------------------------------------------------------------------------------------------

select tests.assert_denied($$select tests.cal(current_date, current_date + 42, tests.i('home-a'))$$,
  'More than 42 days is refused', '22023');
select tests.assert_denied($$select tests.cal(current_date, current_date - 1, tests.i('home-a'))$$,
  'An inverted window is refused', '22023');
select tests.assert_denied($$select tests.cal(current_date, current_date + 6, tests.i('home-b'))$$,
  'Another Home is not permitted');
select tests.assert_true(
  tests.titles(tests.cal(current_date - 1, current_date + 1, null)) = '{}',
  'Carol''s Personal space shows none of Alice''s personal tasks');
select tests.act_as('alice');
select tests.assert_true(
  tests.titles(tests.cal(current_date - 1, current_date + 1, null)) = array['Personal'],
  'Alice''s Personal space shows her personal task only');
select tests.act_as_owner();
update private.task_lists set deleted_at = now() where id = tests.i('l-a');
select tests.act_as('carol');
select tests.assert_true(
  tests.titles(tests.cal(tests.today_a() - 1, tests.today_a() + 6, tests.i('home-a'))) = '{}',
  'A deleted list shows nothing, planned dates included');
select tests.act_as_owner();
update private.task_lists set deleted_at = null where id = tests.i('l-a');

-- The entry limit.
select tests.act_as('alice');
do $$
begin
  for i in 1..510 loop
    perform public.create_task(gen_random_uuid(), tests.i('l-a'), 'Bulk ' || i, p_due_date => tests.today_a() + (i % 7),
      p_home_id => tests.i('home-a'));
  end loop;
end
$$;
select tests.assert_true(
  (select jsonb_array_length(c -> 'entries') = 500 and (c ->> 'truncated')::boolean
   from tests.cal(tests.today_a(), tests.today_a() + 6, tests.i('home-a')) c),
  'At most 500 entries, and it says more exist');
select tests.act_as_owner();
delete from private.tasks where title like 'Bulk %';

-- list_tasks timing filters ------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.listed('due_today', tests.i('home-a')) = array['Daily', 'Paused', 'Today'],
  'Due today: open tasks due today');
select tests.assert_true(
  tests.listed('due_week', tests.i('home-a')) = array['Daily', 'Daily', 'Paused', 'Paused', 'Starts', 'This week', 'Today'],
  'Due in the next 7 days: open, today up to six days ahead');
select tests.assert_true(tests.listed('undated', tests.i('home-a')) = array['Someday'],
  'No due date');
select tests.assert_denied($$select * from public.list_tasks(null, null, null, 'all', 'soon', false)$$,
  'An unknown timing is refused', '22023');
