-- S19b: task reminders (supabase/migrations/*_task_reminders_templates_bulk.sql). Alice owns Home A
-- (Europe/Brussels), where Bob is an Administrator (without manageHomeTasks) and Carol a Member; Bob
-- owns Home B, which Carol is not in. Covers: nothing reachable as a table; setting a reminder at a
-- date and time or before the due date (dry run, revision conflicts, past times, no due date,
-- completed tasks, rights, other Homes); the job in the outbox at the reminder's time; DST gap and
-- repeated hour; who will be reminded; delivery re-checks (stale revision, not due, completed,
-- deleted, nobody left) and dedupe; assignees and the setter as recipients; quiet hours deferring
-- only the email; the category's preferences and Home overrides; a changed or removed due date putting
-- the reminder on hold and its review; removal; recurring series scopes this / following / entire
-- (completed untouched, own reminders kept, "no reminder" kept, occurrences created before their
-- reminder, the hourly advance); titles in the notification centre only for visible tasks.
--
-- Time cannot move inside a test, so "the reminder's time has come" is simulated by moving its
-- fire_at into the past as the database owner (tests.due_now).

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
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');

insert into ids select n, gen_random_uuid() from unnest(array[
  'l-a', 'l-b', 'l-c', 't1', 't-nodue', 't-done', 't-shared', 't-quiet', 't-muted', 't-left', 't-due',
  't-del', 't-b', 't-p', 't-dst', 's1', 's2'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.rem(p_task uuid) returns private.task_reminders
  language sql stable security definer as $$ select * from private.task_reminders where task_id = p_task; $$;
create function tests.rrev(p_task uuid) returns integer
  language sql stable security definer as $$
  select coalesce((select revision from private.task_reminders where task_id = p_task), 0); $$;
create function tests.trev(p_root text) returns integer
  language sql stable security definer as $$
  select coalesce((select revision from private.task_series_reminders where root_id = tests.i(p_root)), 0); $$;
create function tests.occ(p_root text, p_date date) returns uuid
  language sql stable security definer as $$
  select id from private.tasks where series_root_id = tests.i(p_root) and occurrence_date = p_date; $$;
-- As if the reminder's time had come: its fire time moves a minute into the past.
create function tests.due_now(p_task uuid) returns void
  language sql security definer as $$
  update private.task_reminders set fire_at = now() - interval '1 minute' where task_id = p_task; $$;
create function tests.reminded(p_task uuid) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications
  where category = 'reminders' and kind = 'task.reminder' and params ->> 'taskId' = p_task::text; $$;
create function tests.reminded_user(p_task uuid, p_user text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications
  where kind = 'task.reminder' and params ->> 'taskId' = p_task::text and user_id = tests.user_id(p_user); $$;
grant execute on function tests.i(text), tests.today_a(), tests.rem(uuid), tests.rrev(uuid), tests.trev(text),
  tests.occ(text, date), tests.reminded(uuid), tests.reminded_user(uuid, text) to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.task_reminders', 'The API cannot read reminders');
select tests.assert_denied('select * from private.task_series_reminders', 'Nor series reminder templates');
select tests.assert_denied($$select private.zoned_dst_case(now()::timestamp, 'UTC')$$, 'Nor the helpers');
select tests.assert_denied($$select public.deliver_task_reminder(gen_random_uuid(), 1)$$,
  'A signed-in person cannot deliver reminders (the job does)');
select tests.assert_denied($$select public.advance_reminder_series(10)$$, 'Nor run the hourly advance');
select tests.act_as_anon();
select tests.assert_denied($$select public.get_task_reminder(gen_random_uuid())$$, 'Nobody signed out reads reminders');

-- Lists and tasks ------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_task_list(tests.i('l-a'), 'Chores', tests.i('home-a'));
select tests.act_as('bob');
select public.create_task_list(tests.i('l-b'), 'Kot', tests.i('home-b'));
select public.create_task(tests.i('t-b'), tests.i('l-b'), 'Home B task', p_due_date => current_date + 5,
  p_home_id => tests.i('home-b'));
select tests.act_as('carol');
select public.create_task_list(tests.i('l-c'), 'Mine');
select public.create_task(tests.i('t1'), tests.i('l-a'), 'Bins out', p_due_date => tests.today_a() + 3,
  p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-nodue'), tests.i('l-a'), 'Someday', p_home_id => tests.i('home-a'));
select public.create_task(tests.i('t-p'), tests.i('l-c'), 'Dentist', p_due_date => current_date + 10);

-- Setting a reminder ----------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'preview' and revision = 0
     and fire_at = ((tests.today_a() + 2) + time '09:00') at time zone 'Europe/Brussels' and dst is null
   from public.set_task_reminder(tests.i('t1'), 'this', 'relative', 0, p_days_before => 1,
     p_time => '09:00', p_dry_run => true)),
  'The dry run resolves 1 day before the due date at 09:00 in the Home''s timezone');
select tests.assert_true(tests.rrev(tests.i('t1')) = 0, 'The dry run wrote nothing');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1
   from public.set_task_reminder(tests.i('t1'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00')),
  'Carol, the task''s creator, sets the reminder');
select tests.assert_true(
  (select status = 'scheduled' and own and mode = 'relative' and time_zone = 'Europe/Brussels'
   from tests.rem(tests.i('t1'))),
  'It is scheduled, in the Home''s zone');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 and bool_and(o.available_at = (tests.rem(tests.i('t1'))).fire_at)
     and bool_and(o.payload = jsonb_build_object('taskId', tests.i('t1'), 'revision', 1))
   from private.job_outbox o where o.idempotency_key = 'task-reminder:' || tests.i('t1') || ':1'),
  'The task-reminder job waits in the outbox for the reminder''s time, with ids only');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 1
   from public.set_task_reminder(tests.i('t1'), 'this', 'relative', 0, p_days_before => 2, p_time => '09:00')),
  'A change from a stale revision is refused with the current one');
select tests.assert_true(
  (select outcome = 'in_past'
   from public.set_task_reminder(tests.i('t1'), 'this', 'absolute', 1,
     p_local_at => (now() at time zone 'Europe/Brussels') - interval '1 hour')),
  'A time already past is refused');
select tests.assert_true(
  (select outcome = 'needs_due_date'
   from public.set_task_reminder(tests.i('t-nodue'), 'this', 'relative', 0, p_days_before => 0, p_time => '09:00')),
  'A before-due reminder needs a due date');
select tests.assert_true(
  (select outcome = 'saved'
   from public.set_task_reminder(tests.i('t-nodue'), 'this', 'absolute', 0,
     p_local_at => (tests.today_a() + 4) + time '18:30')),
  'A task without a due date can have a reminder at a date and time');
select tests.assert_denied(
  $$select public.set_task_reminder(tests.i('t1'), 'this', 'relative', 1, p_days_before => 31, p_time => '09:00')$$,
  'More than 30 days before is invalid', '22023');
select tests.assert_denied(
  $$select public.set_task_reminder(tests.i('t1'), 'series', 'absolute', 1, p_local_at => now()::timestamp,
    p_expected_series_revision => 0)$$,
  'A series reminder is always before the due date', '22023');

-- Who may set it, and isolation
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted'
   from public.set_task_reminder(tests.i('t1'), 'this', 'relative', 1, p_days_before => 0, p_time => '08:00')),
  'An Administrator without manageHomeTasks cannot change a reminder on someone else''s task');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_found'
   from public.set_task_reminder(tests.i('t-b'), 'this', 'relative', 0, p_days_before => 0, p_time => '08:00')),
  'A task in a Home Carol is not in does not exist for her');
select tests.assert_true(public.get_task_reminder(tests.i('t-b')) is null, 'Nor can she read its reminder');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved'
   from public.set_task_reminder(tests.i('t1'), 'this', 'relative', 1, p_days_before => 1, p_time => '08:00')),
  'The Owner (a task manager) may change it');

-- What the editor reads
select tests.act_as('carol');
select tests.assert_true(
  (select (r -> 'reminder' ->> 'time') = '08:00' and (r -> 'reminder' ->> 'revision')::integer = 2
     and (r -> 'recipients') = jsonb_build_array(tests.i('m-alice-a'))
     and not (r ->> 'recipientsAreAssignees')::boolean
     and (r -> 'channels' ->> 'inApp')::boolean and not (r -> 'channels' ->> 'email')::boolean
     and (r ->> 'canEdit')::boolean and (r ->> 'timeZone') = 'Europe/Brussels'
   from public.get_task_reminder(tests.i('t1')) r),
  'The editor shows the reminder, who it reminds (no assignees: who set it) and how Carol would receive it');

-- Personal: the person's zone
select tests.assert_denied(
  $$select public.set_task_reminder(tests.i('t-p'), 'this', 'relative', 0, p_days_before => 1,
    p_time => '09:00', p_time_zone => 'Mars/Olympus')$$,
  'A Personal reminder needs a real timezone', '22023');
select tests.assert_true(
  (select outcome = 'saved'
     and fire_at = ((current_date + 9) + time '09:00') at time zone 'America/New_York'
   from public.set_task_reminder(tests.i('t-p'), 'this', 'relative', 0, p_days_before => 1,
     p_time => '09:00', p_time_zone => 'America/New_York')),
  'A Personal reminder uses the person''s own timezone');

-- DST -------------------------------------------------------------------------------------------------

select public.create_task(tests.i('t-dst'), tests.i('l-c'), 'Clocks', p_due_date => date '2027-10-31');
select tests.assert_true(
  (select outcome = 'preview' and dst = 'gap' and fire_at = timestamptz '2027-03-28 01:30:00+00'
   from public.set_task_reminder(tests.i('t-dst'), 'this', 'absolute', 0,
     p_local_at => timestamp '2027-03-28 02:30', p_time_zone => 'Europe/Brussels', p_dry_run => true)),
  '02:30 does not exist when the clocks go forward: it moves forward by the gap (03:30) and says so');
select tests.assert_true(
  (select outcome = 'preview' and dst = 'overlap' and fire_at = timestamptz '2027-10-31 01:30:00+00'
   from public.set_task_reminder(tests.i('t-dst'), 'this', 'relative', 0, p_days_before => 0,
     p_time => '02:30', p_time_zone => 'Europe/Brussels', p_dry_run => true)),
  '02:30 happens twice when the clocks go back: the second (standard time) is used and it says so');
select tests.assert_true(
  (select outcome = 'preview' and dst is null and fire_at = timestamptz '2027-10-30 22:00:00+00'
   from public.set_task_reminder(tests.i('t-dst'), 'this', 'relative', 0, p_days_before => 0,
     p_time => '00:00', p_time_zone => 'Europe/Brussels', p_dry_run => true)),
  'An ordinary time that day is just that time');

-- Delivery --------------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(public.deliver_task_reminder(tests.i('t1'), 2) = 'not_due',
  'A reminder whose time has not come is not delivered');
select tests.assert_true(public.deliver_task_reminder(tests.i('t1'), 1) = 'stale',
  'The job of an older revision does nothing');
select tests.act_as_owner();
select tests.due_now(tests.i('t1'));
select tests.act_as_service_role();
select tests.assert_true(public.deliver_task_reminder(tests.i('t1'), 2) = 'notified', 'At its time it is delivered');
select tests.assert_true(public.deliver_task_reminder(tests.i('t1'), 2) = 'stale', 'A second run does nothing');
select tests.act_as_owner();
select tests.assert_true(
  tests.reminded(tests.i('t1')) = 1 and tests.reminded_user(tests.i('t1'), 'alice') = 1
  and (select status = 'sent' and delivered_at is not null from tests.rem(tests.i('t1'))),
  'Without assignees, the member who set it (Alice) is reminded once; the reminder is sent');
select tests.assert_true(
  (select n.home_id = tests.i('home-a') and n.params = jsonb_build_object('taskId', tests.i('t1'),
     'dueDate', tests.today_a() + 3) and n.dedupe_key = 'task-reminder:' || tests.i('t1') || ':2'
   from public.notifications n where n.kind = 'task.reminder' and n.params ->> 'taskId' = tests.i('t1')::text),
  'The notification carries ids and the due date only, keyed by task and revision');

-- Completed and deleted tasks are not reminded
select tests.act_as('carol');
select public.create_task(tests.i('t-done'), tests.i('l-a'), 'Done early', p_due_date => tests.today_a() + 2,
  p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-done'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select public.set_task_completion(tests.i('t-done'), true);
select tests.assert_true(
  (select outcome = 'task_completed'
   from public.set_task_reminder(tests.i('t-done'), 'this', 'relative', 1, p_days_before => 0, p_time => '09:00')),
  'A completed task cannot get a new reminder');
select public.create_task(tests.i('t-del'), tests.i('l-a'), 'Gone', p_due_date => tests.today_a() + 2,
  p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-del'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select public.delete_task(tests.i('t-del'));
select tests.act_as_owner();
select tests.due_now(tests.i('t-done'));
select tests.due_now(tests.i('t-del'));
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_task_reminder(tests.i('t-done'), 1) = 'not_sent'
  and public.deliver_task_reminder(tests.i('t-del'), 1) = 'not_sent',
  'A task completed or deleted before the reminder is not reminded');
select tests.act_as_owner();
select tests.assert_true(tests.reminded(tests.i('t-done')) = 0 and tests.reminded(tests.i('t-del')) = 0
  and (tests.rem(tests.i('t-done'))).status = 'not_sent', 'Nothing was sent, and it says so');

-- Assignees are reminded, once each
select tests.act_as('alice');
select public.create_task(tests.i('t-shared'), tests.i('l-a'), 'Shared', p_due_date => tests.today_a() + 2,
  p_assignee_ids => array[tests.i('m-bob-a'), tests.i('m-carol-a')], p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-shared'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select tests.assert_true(
  (select (r -> 'recipients') @> jsonb_build_array(tests.i('m-bob-a'), tests.i('m-carol-a'))
     and jsonb_array_length(r -> 'recipients') = 2 and (r ->> 'recipientsAreAssignees')::boolean
   from public.get_task_reminder(tests.i('t-shared')) r),
  'The editor names both assignees');
select tests.act_as_owner();
select tests.due_now(tests.i('t-shared'));
select tests.act_as_service_role();
select public.deliver_task_reminder(tests.i('t-shared'), 1);
select tests.act_as_owner();
select tests.assert_true(
  tests.reminded_user(tests.i('t-shared'), 'bob') = 1 and tests.reminded_user(tests.i('t-shared'), 'carol') = 1
  and tests.reminded_user(tests.i('t-shared'), 'alice') = 0,
  'Each assignee is reminded once; the setter is not added');
-- Even if the job is replayed with the reminder made deliverable again, nobody is notified twice.
update private.task_reminders set status = 'scheduled' where task_id = tests.i('t-shared');
select tests.act_as_service_role();
select public.deliver_task_reminder(tests.i('t-shared'), 1);
select tests.act_as_owner();
select tests.assert_true(tests.reminded(tests.i('t-shared')) = 2, 'The dedupe key keeps it at one per person');

-- Quiet hours: in-app at once, email at the end of the window
select tests.act_as('carol');
select public.set_notification_preference('reminders', 'email', true, null);
select public.set_notification_quiet_hours(true,
  ((now() at time zone 'UTC') - interval '1 hour')::time, ((now() at time zone 'UTC') + interval '1 hour')::time,
  'UTC');
select public.create_task(tests.i('t-quiet'), tests.i('l-a'), 'Quiet', p_due_date => tests.today_a() + 2,
  p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-quiet'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select tests.act_as_owner();
select tests.due_now(tests.i('t-quiet'));
select tests.act_as_service_role();
select public.deliver_task_reminder(tests.i('t-quiet'), 1);
select tests.act_as_owner();
select tests.assert_true(
  (select n.during_quiet_hours and n.show_in_app and n.email_status = 'queued'
   from public.notifications n where n.kind = 'task.reminder' and n.params ->> 'taskId' = tests.i('t-quiet')::text),
  'During quiet hours the reminder appears in the app at once (marked)');
select tests.assert_true(
  (select o.available_at > now() + interval '30 minutes'
   from private.job_outbox o join public.notifications n on o.idempotency_key = 'notification-email:' || n.id
   where n.kind = 'task.reminder' and n.params ->> 'taskId' = tests.i('t-quiet')::text),
  'Its email waits for the end of the window');

-- Preferences: switched off for Home A only
select tests.act_as('bob');
select public.set_notification_preference('reminders', 'in_app', false, tests.i('home-a'));
select tests.act_as('alice');
select public.create_task(tests.i('t-muted'), tests.i('l-a'), 'Muted', p_due_date => tests.today_a() + 2,
  p_assignee_ids => array[tests.i('m-bob-a')], p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-muted'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select tests.act_as('bob');
select tests.assert_true(
  (select not (r -> 'channels' ->> 'inApp')::boolean from public.get_task_reminder(tests.i('t-muted')) r),
  'The editor tells Bob his reminders are off in this Home');
select tests.act_as_owner();
select tests.due_now(tests.i('t-muted'));
select tests.act_as_service_role();
select tests.assert_true(public.deliver_task_reminder(tests.i('t-muted'), 1) = 'notified', 'The reminder runs');
select tests.act_as_owner();
select tests.assert_true(tests.reminded(tests.i('t-muted')) = 0,
  'Bob switched reminders off for Home A, so nothing reaches him');

-- Nobody left to remind
select tests.act_as('carol');
select public.create_task(tests.i('t-left'), tests.i('l-a'), 'Left behind', p_due_date => tests.today_a() + 2,
  p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-left'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.due_now(tests.i('t-left'));
select tests.act_as_service_role();
select tests.assert_true(public.deliver_task_reminder(tests.i('t-left'), 1) = 'not_sent',
  'Carol set it and left the Home; with no assignees nobody is reminded');
select tests.act_as_owner();
select tests.assert_true(tests.reminded(tests.i('t-left')) = 0, 'Not even Carol');
insert into public.home_memberships (home_id, user_id, role)
  values (tests.i('home-a'), tests.user_id('carol'), 'member');
update ids set id = (select id from public.home_memberships where home_id = tests.i('home-a')
  and user_id = tests.user_id('carol')) where name = 'm-carol-a';

-- Personal reminders go to the owner, without a Home
select tests.due_now(tests.i('t-p'));
select tests.act_as_service_role();
select public.deliver_task_reminder(tests.i('t-p'), 1);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 and bool_and(n.home_id is null) from public.notifications n
   where n.kind = 'task.reminder' and n.params ->> 'taskId' = tests.i('t-p')::text
     and n.user_id = tests.user_id('carol')),
  'A Personal reminder reaches its owner, with no Home');

-- Due date changes -----------------------------------------------------------------------------------

select tests.act_as('carol');
select public.create_task(tests.i('t-due'), tests.i('l-a'), 'Moving', p_due_date => tests.today_a() + 3,
  p_home_id => tests.i('home-a'));
select public.set_task_reminder(tests.i('t-due'), 'this', 'relative', 0, p_days_before => 1, p_time => '09:00');
select public.update_task(tests.i('t-due'), 1, 'Moving', '{}', p_due_date => tests.today_a() + 6);
select tests.assert_true(
  (select status = 'needs_review' and fire_at is null and revision = 2 from tests.rem(tests.i('t-due'))),
  'A changed due date puts the before-due reminder on hold (a new revision)');
select tests.assert_true(
  (select (r -> 'reminder' ->> 'status') = 'needs_review'
     and (r -> 'reminder' ->> 'reviewFireAt')::timestamptz
       = ((tests.today_a() + 5) + time '09:00') at time zone 'Europe/Brussels'
   from public.get_task_reminder(tests.i('t-due')) r),
  'The editor shows when it would come with the new due date');
select tests.act_as_owner();
update private.task_reminders set fire_at = now() - interval '1 minute' where task_id = tests.i('t-due');
select tests.act_as_service_role();
select tests.assert_true(public.deliver_task_reminder(tests.i('t-due'), 1) = 'stale',
  'The job queued for the old time does nothing');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and revision = 3
     and fire_at = ((tests.today_a() + 5) + time '09:00') at time zone 'Europe/Brussels'
   from public.review_task_reminder(tests.i('t-due'), 'follow', 2)),
  'Carol moves it with the due date');
select tests.assert_true(
  (select outcome = 'not_needed' from public.review_task_reminder(tests.i('t-due'), 'follow', 3)),
  'A reminder not on hold needs no review');
select public.update_task(tests.i('t-due'), 2, 'Moving', '{}');
select tests.assert_true(
  (select outcome = 'needs_due_date' from public.review_task_reminder(tests.i('t-due'), 'follow', 4)),
  'With the due date removed it cannot follow');
select tests.assert_true(
  (select outcome = 'deleted' from public.review_task_reminder(tests.i('t-due'), 'remove', 4)),
  'She removes it instead');
select tests.assert_true(tests.rem(tests.i('t-due')) is null, 'It is gone');
select tests.assert_true(
  (select outcome = 'deleted' from public.remove_task_reminder(tests.i('t-nodue'), 'this', 1)),
  'Removing a reminder');
select tests.assert_true(tests.rem(tests.i('t-nodue')) is null, 'It is gone too');

-- Recurring series -----------------------------------------------------------------------------------

-- Home C's zone is chosen so that it is about 01:00 there now: any time from 02:00 today on is still
-- to come, whenever the test runs (Etc/GMT+N is N hours behind UTC).
select tests.act_as('carol');
insert into ids select 'home-c', public.create_home('Vroeg',
  'Etc/GMT' || (select case when n >= 0 then '+' || n else n::text end
    from (select case when h - 1 > 12 then h - 1 - 24 else h - 1 end as n
          from (select extract(hour from now() at time zone 'UTC')::integer as h) x) y),
  gen_random_uuid());
insert into ids select 'l-x', gen_random_uuid();
select public.create_task_list(tests.i('l-x'), 'Plants', tests.i('home-c'));
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.i('home-c'), tests.user_id('bob'), 'member');
create function tests.today_c() returns date
  language sql stable security definer as $$
  select (now() at time zone (select timezone from public.homes where id = tests.i('home-c')))::date; $$;
grant execute on function tests.today_c() to authenticated, service_role;
select tests.assert_true(
  (select extract(hour from now() at time zone timezone) between 0 and 1 from public.homes
   where id = tests.i('home-c')),
  'setup: it is around 01:00 in Home C');

select tests.act_as('carol');
select public.create_task_series(tests.i('s1'), tests.i('l-x'), 'Water plants', 'daily', 1, tests.today_c(),
  p_home_id => tests.i('home-c'));
select tests.assert_true(
  tests.occ('s1', tests.today_c()) is not null and tests.occ('s1', tests.today_c() + 1) is not null
  and tests.occ('s1', tests.today_c() + 2) is null,
  'setup: today and one upcoming occurrence');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted'
   from public.set_task_reminder(tests.occ('s1', tests.today_c()), 'series', 'relative', 0,
     p_days_before => 1, p_time => '20:00', p_expected_series_revision => 0)),
  'A plain member may not change Carol''s series reminder');
select tests.assert_true(
  (select outcome = 'saved'
   from public.set_task_reminder(tests.occ('s1', tests.today_c() + 1), 'this', 'relative', 0,
     p_days_before => 0, p_time => '07:00')) is not true,
  'Nor the reminder of her occurrence (not its creator, assignee or a task manager)');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'updated')::integer = 1 and (impact ->> 'past')::integer = 1
   from public.set_task_reminder(tests.occ('s1', tests.today_c()), 'series', 'relative', 0,
     p_days_before => 1, p_time => '20:00', p_expected_series_revision => 0, p_dry_run => true)),
  'The preview: tomorrow''s occurrence gets it (today 20:00), today''s time has passed');
select tests.assert_true(tests.trev('s1') = 0 and tests.occ('s1', tests.today_c() + 2) is null
  and tests.rem(tests.occ('s1', tests.today_c() + 1)) is null,
  'The preview changed nothing and created nothing');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 and (impact ->> 'updated')::integer = 1
     and (impact ->> 'past')::integer = 1
   from public.set_task_reminder(tests.occ('s1', tests.today_c()), 'series', 'relative', 0,
     p_days_before => 1, p_time => '20:00', p_expected_series_revision => 0)),
  'Carol sets a reminder for the entire series');
select tests.assert_true(
  tests.occ('s1', tests.today_c() + 2) is not null and tests.occ('s1', tests.today_c() + 3) is null,
  'Occurrences are now created in time for their reminder (up to today + days before + 1)');
select tests.assert_true(
  (select status = 'scheduled' and not own and days_before = 1
     and fire_at = ((tests.today_c() + 1) + time '20:00')
       at time zone (select timezone from public.homes where id = tests.i('home-c'))
   from tests.rem(tests.occ('s1', tests.today_c() + 2))),
  'A new occurrence starts with the series'' reminder, resolved for its own date');
select tests.assert_true(tests.rem(tests.occ('s1', tests.today_c())) is null,
  'Today''s occurrence, whose time had passed, got nothing');

-- This occurrence: its own, kept by later series changes; completed ones never change
select tests.assert_true(
  (select outcome = 'saved'
   from public.set_task_reminder(tests.occ('s1', tests.today_c() + 2), 'this', 'relative',
     tests.rrev(tests.occ('s1', tests.today_c() + 2)), p_days_before => 0, p_time => '07:00')),
  'One occurrence gets its own reminder');
select public.set_task_completion(tests.occ('s1', tests.today_c() + 1), true);
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'kept')::integer = 1 and (impact ->> 'completed')::integer = 1
     and (impact ->> 'updated')::integer = 0
   from public.set_task_reminder(tests.occ('s1', tests.today_c()), 'series', 'relative', 0,
     p_days_before => 1, p_time => '21:00', p_expected_series_revision => 1)),
  'An entire-series change keeps the occurrence''s own reminder and never touches a completed one');
select tests.assert_true(
  (select time_of_day = '07:00' and own from tests.rem(tests.occ('s1', tests.today_c() + 2)))
  and (select time_of_day = '20:00' from tests.rem(tests.occ('s1', tests.today_c() + 1))),
  'They kept what they had');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2
   from public.set_task_reminder(tests.occ('s1', tests.today_c()), 'series', 'relative', 0,
     p_days_before => 1, p_time => '21:00', p_expected_series_revision => 1)),
  'A stale series revision is refused');
select tests.assert_true(
  (select outcome = 'scope_unavailable'
   from public.set_task_reminder(tests.occ('s1', tests.today_c() + 1), 'following', 'relative', 0,
     p_days_before => 1, p_time => '21:00', p_expected_series_revision => 2)),
  '"This and following" is not offered from a completed occurrence');

-- Following: from this occurrence on
select public.create_task_series(tests.i('s2'), tests.i('l-x'), 'Feed cat', 'daily', 1, tests.today_c(),
  p_home_id => tests.i('home-c'));
select public.set_task_reminder(tests.occ('s2', tests.today_c()), 'series', 'relative', 0,
  p_days_before => 0, p_time => '23:00', p_expected_series_revision => 0);
select tests.assert_true(
  (select outcome = 'saved' and (impact ->> 'updated')::integer = 1
   from public.set_task_reminder(tests.occ('s2', tests.today_c() + 1), 'following', 'relative', 0,
     p_days_before => 0, p_time => '22:00', p_expected_series_revision => 1)),
  'A following change from tomorrow''s occurrence');
select tests.assert_true(
  (select time_of_day = '23:00' from tests.rem(tests.occ('s2', tests.today_c())))
  and (select time_of_day = '22:00' from tests.rem(tests.occ('s2', tests.today_c() + 1))),
  'Today''s occurrence keeps its reminder; tomorrow''s changed');

-- Removing: this occurrence ("no reminder" sticks), then the series
select tests.assert_true(
  (select outcome = 'deleted'
   from public.remove_task_reminder(tests.occ('s2', tests.today_c() + 1), 'this',
     tests.rrev(tests.occ('s2', tests.today_c() + 1)))),
  'Removing the reminder of one occurrence');
select tests.assert_true((tests.rem(tests.occ('s2', tests.today_c() + 1))).status = 'off',
  'It is remembered as "no reminder" for that occurrence');
select public.set_task_reminder(tests.occ('s2', tests.today_c()), 'series', 'relative', 0,
  p_days_before => 0, p_time => '23:30', p_expected_series_revision => 2);
select tests.assert_true((tests.rem(tests.occ('s2', tests.today_c() + 1))).status = 'off'
  and (tests.rem(tests.occ('s2', tests.today_c()))).time_of_day = '23:30',
  'A later series change leaves it without a reminder');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'updated')::integer = 1 and (impact ->> 'kept')::integer = 1
   from public.remove_task_reminder(tests.occ('s2', tests.today_c()), 'series',
     tests.rrev(tests.occ('s2', tests.today_c())), p_expected_series_revision => 3, p_dry_run => true)),
  'Removing the series reminder previews its impact');
select tests.assert_true(
  (select outcome = 'deleted'
   from public.remove_task_reminder(tests.occ('s2', tests.today_c()), 'series',
     tests.rrev(tests.occ('s2', tests.today_c())), p_expected_series_revision => 3)),
  'Removing the series reminder');
select tests.assert_true(
  tests.rem(tests.occ('s2', tests.today_c())) is null and tests.trev('s2') = 4,
  'Today''s occurrence lost it; the template is off (and its revision keeps growing)');

-- The hourly advance creates occurrences in time for their reminder
select tests.act_as_owner();
update private.task_series_reminders set days_before = 3 where root_id = tests.i('s1');
select tests.act_as_service_role();
select tests.assert_true(public.advance_reminder_series(50) >= 1, 'The hourly advance creates occurrences');
select tests.act_as_owner();
select tests.assert_true(
  tests.occ('s1', tests.today_c() + 4) is not null and tests.occ('s1', tests.today_c() + 5) is null
  and (select status = 'scheduled' from tests.rem(tests.occ('s1', tests.today_c() + 4))),
  'Up to today + 3 + 1, each with its reminder');
select tests.act_as_service_role();
select tests.assert_true(public.advance_reminder_series(50) = 0, 'Run again, there is nothing to do');

-- The notification centre's titles ---------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 and bool_and(title = 'Bins out')
   from public.task_reminder_titles(array[tests.i('t1'), tests.i('t-b'), tests.i('t-del')])),
  'Titles only for tasks Carol can see now (not another Home''s, not a deleted one)');
select tests.assert_denied(
  $$select public.task_reminder_titles(array(select gen_random_uuid() from generate_series(1, 101)))$$,
  'At most 100 at a time', '22023');
