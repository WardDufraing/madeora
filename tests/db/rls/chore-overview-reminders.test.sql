-- S21: the chore schedule, moving one occurrence with its effects, personal chore reminders and the
-- manager's daily summary (supabase/migrations/*_chore_overview_reminders.sql). Alice owns Home A
-- (Europe/Brussels), where Bob is an Administrator (no chore rights) and Carol and Gus Members; Bob
-- owns Home B.
-- Covers: nothing reachable as a table; the schedule (existing and projected dates, range limits,
-- cross-Home); reminders (assignees only, preview, in the past, conflict, the job queued with the
-- revision, a moved due day moves it, an unassigned person loses it while a kept one keeps it,
-- completion ends it, delivery re-checks and notifies once, a stale job, removal); the move impact
-- (overdue, reminders, a handover request; a claimed occurrence: the release follows a moved due day,
-- an immediate release needs confirmation); the summary (managers only, settings, counts, the hourly
-- run sends once per local day and only when something qualifies).

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '32000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'gus@madeora.test', now(), now(), now());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-a'), '32000000-0000-4000-8000-000000000001', 'member');
insert into ids select 'm-' || u || '-a', m.id from public.home_memberships m
  join auth.users x on x.id = m.user_id, unnest(array['alice', 'bob', 'carol', 'gus']) u
  where m.home_id = (select id from ids where name = 'home-a') and x.email = u || '@madeora.test';
insert into ids select n, gen_random_uuid() from unnest(array[
  'c-one', 'c-daily', 'c-both', 'c-b', 'req', 'c-claim'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.today_a() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.first_occ(p_chore text) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = tests.i(p_chore) order by scheduled_date limit 1; $$;
create function tests.occ_rev(p_occurrence uuid) returns integer
  language sql stable security definer as $$ select revision from private.chore_occurrences where id = p_occurrence; $$;
create function tests.reminder(p_occurrence uuid, p_user text) returns text
  language sql stable security definer as $$
  select r.status || ':' || r.revision from private.chore_reminders r join auth.users u on u.id = r.user_id
  where r.occurrence_id = p_occurrence and u.email = p_user || '@madeora.test'; $$;
create function tests.reminder_fire(p_occurrence uuid, p_user text) returns timestamptz
  language sql stable security definer as $$
  select r.fire_at from private.chore_reminders r join auth.users u on u.id = r.user_id
  where r.occurrence_id = p_occurrence and u.email = p_user || '@madeora.test'; $$;
create function tests.reminder_jobs(p_occurrence uuid) returns bigint
  language sql stable security definer as $$
  select count(*) from private.job_outbox where job_name = 'chore-reminder'
    and payload ->> 'occurrenceId' = p_occurrence::text; $$;
create function tests.notices(p_user text, p_kind text) returns bigint
  language sql stable security definer as $$
  select count(*) from public.notifications n join auth.users u on u.id = n.user_id
  where u.email = p_user || '@madeora.test' and n.kind = p_kind; $$;
create function tests.fire_now(p_occurrence uuid) returns void
  language sql security definer as $$
  update private.chore_reminders set fire_at = now() - interval '1 minute' where occurrence_id = p_occurrence; $$;
create function tests.set_summary_day(p_user text, p_day date) returns void
  language sql security definer as $$
  update private.chore_summary_settings s set last_day = p_day, send_hour = 0
  from auth.users u where u.id = s.user_id and u.email = p_user || '@madeora.test'; $$;
create function tests.sd(p_query text) returns boolean
  language plpgsql security definer as $$
  declare
    v_result boolean;
  begin
    execute 'select (' || p_query || ')' into v_result;
    return v_result;
  end $$;
create function tests.set_release(p_chore text, p_hours integer) returns void
  language sql security definer as $$
  update private.chores set auto_release_hours = p_hours where id = tests.i(p_chore); $$;
create function tests.release_jobs(p_occurrence uuid) returns bigint
  language sql stable security definer as $$
  select count(*) from private.job_outbox where job_name = 'chore-claim-release'
    and payload ->> 'occurrenceId' = p_occurrence::text; $$;
create function tests.claimed(p_occurrence uuid) returns boolean
  language sql stable security definer as $$
  select claimed_by is not null from private.chore_occurrences where id = p_occurrence; $$;
grant execute on all functions in schema tests to authenticated, service_role;

-- Nothing reachable ----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.chore_reminders', 'The API cannot read reminders');
select tests.assert_denied('select * from private.chore_summary_settings', 'Nor summary settings');
select tests.assert_denied(
  'select public.deliver_chore_reminder(gen_random_uuid(), gen_random_uuid(), 1)',
  'People cannot deliver reminders');
select tests.assert_denied('select public.send_chore_summaries(10)', 'Nor send summaries');
select tests.act_as_anon();
select tests.assert_denied(
  format($$select public.list_chore_schedule(%L, current_date, current_date)$$, gen_random_uuid()),
  'Signed-out people read no schedule');

-- Chores for the tests ------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-one'), tests.i('home-a'), 'Windows',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'))),
    p_due_date => tests.today_a() + 5)),
  'A one-off chore for Carol in five days');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-daily'), tests.i('home-a'), 'Dishes',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-gus-a'))),
    p_frequency => 'daily', p_interval => 1, p_starts_on => tests.today_a())),
  'A daily chore for Gus');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-both'), tests.i('home-a'), 'Garden',
    jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.i('m-carol-a'), tests.i('m-gus-a'))),
    p_due_date => tests.today_a() + 3)),
  'A one-off chore for Carol and Gus');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-b'), tests.i('home-b'), 'Kot',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a())),
  'Bob has a chore in his own Home');

-- The schedule ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied(
  format($$select public.list_chore_schedule(%L, %L, %L)$$, tests.i('home-b'), tests.today_a(), tests.today_a()),
  'Carol cannot read the schedule of a Home she is not in');
select tests.assert_denied(
  format($$select public.list_chore_schedule(%L, %L, %L)$$, tests.i('home-a'), tests.today_a(), tests.today_a() + 42),
  'At most 42 days at once', '22023');
select tests.assert_denied(
  format($$select public.list_chore_schedule(%L, %L, %L)$$, tests.i('home-a'), tests.today_a(), tests.today_a() - 1),
  'The end is not before the start', '22023');
select tests.assert_true(
  (select (s ->> 'canManage')::boolean = false
     and (select count(*) from jsonb_array_elements(s -> 'items') x where x ->> 'title' = 'Dishes') = 7
     and (select count(*) from jsonb_array_elements(s -> 'items') x
          where x ->> 'title' = 'Dishes' and (x ->> 'projected')::boolean and x ->> 'id' is null) >= 5
     and (select bool_and(x -> 'assigneeIds' = jsonb_build_array(tests.i('m-gus-a')))
          from jsonb_array_elements(s -> 'items') x where x ->> 'title' = 'Dishes')
     and (select count(*) from jsonb_array_elements(s -> 'items') x
          where x ->> 'title' = 'Windows' and not (x ->> 'projected')::boolean
            and (x ->> 'date')::date = tests.today_a() + 5) = 1
     and not exists (select 1 from jsonb_array_elements(s -> 'items') x where x ->> 'title' = 'Kot')
   from public.list_chore_schedule(tests.i('home-a'), tests.today_a(), tests.today_a() + 6) s),
  'A week shows the one-off chores and every day of the daily one, later days projected for Gus, and nothing of Home B');
select tests.assert_true(
  tests.sd($q$select count(*) <= 2 from private.chore_occurrences where chore_id = tests.i('c-daily')$q$),
  'Reading the schedule creates no occurrences');

-- Reminders ------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'not_assignee' from public.set_chore_reminder(tests.first_occ('c-one'), 'relative', 0,
    false, p_days_before => 1, p_time => '18:00')),
  'Only an assignee sets a reminder, not even the Owner for someone else');
select tests.act_as('carol');
select tests.assert_denied(
  format($$select * from public.set_chore_reminder(%L, 'relative', 0, false, p_days_before => 31, p_time => '18:00')$$,
    tests.first_occ('c-one')),
  'At most 30 days before', '22023');
select tests.assert_true(
  (select outcome = 'in_past' from public.set_chore_reminder(tests.first_occ('c-one'), 'absolute', 0, false,
    p_local_at => (tests.today_a() - 1) + time '09:00')),
  'Not at a moment that has passed');
select tests.assert_true(
  (select outcome = 'preview' and fire_at = ((tests.today_a() + 4) + time '18:00') at time zone 'Europe/Brussels'
     and revision = 0
   from public.set_chore_reminder(tests.first_occ('c-one'), 'relative', 0, true, p_days_before => 1,
     p_time => '18:00')),
  'The preview gives the moment in the Home''s timezone, the day before at 18:00');
select tests.assert_true(
  (select tests.reminder(tests.first_occ('c-one'), 'carol') is null and tests.reminder_jobs(tests.first_occ('c-one')) = 0),
  'A preview saves and queues nothing');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.set_chore_reminder(tests.first_occ('c-one'), 'relative',
    0, false, p_days_before => 1, p_time => '18:00')),
  'Carol sets it');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 from private.job_outbox where job_name = 'chore-reminder'
    and payload = jsonb_build_object('occurrenceId', tests.first_occ('c-one'), 'userId', tests.user_id('carol'),
      'revision', 1) and available_at = tests.reminder_fire(tests.first_occ('c-one'), 'carol')$q$),
  'Its delivery is queued for that moment with ids and the revision only');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 1 from public.set_chore_reminder(tests.first_occ('c-one'), 'relative',
    0, false, p_days_before => 2, p_time => '08:00')),
  'A change on an old revision is a conflict');
select tests.assert_true(
  (select (r -> 'reminder' ->> 'daysBefore')::integer = 1 and r -> 'reminder' ->> 'time' = '18:00'
     and (r ->> 'canSet')::boolean and (r ->> 'revision')::integer = 1 and r ->> 'timeZone' = 'Europe/Brussels'
   from public.get_chore_reminder(tests.first_occ('c-one')) r),
  'She reads it back');
select tests.act_as_user('32000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select r -> 'reminder' = 'null'::jsonb and not (r ->> 'canSet')::boolean
   from public.get_chore_reminder(tests.first_occ('c-one')) r),
  'Gus sees no reminder of Carol''s and cannot set one there');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_reminder(tests.first_occ('c-both'), 'relative', 0, false,
    p_days_before => 0, p_time => '07:00')),
  'Carol also sets one on the shared chore');
select tests.act_as_user('32000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select outcome = 'saved' from public.set_chore_reminder(tests.first_occ('c-both'), 'absolute', 0, false,
    p_local_at => (tests.today_a() + 2) + time '20:00')),
  'And Gus his own');

-- Moving reports the effects, then applies them.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'remindersMoved')::integer = 1
     and (impact ->> 'remindersEnded')::integer = 0 and not (impact ->> 'overdue')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-one'), tests.occ_rev(tests.first_occ('c-one')), true,
     p_due_date => tests.today_a() + 6)),
  'Moving Windows a day later moves Carol''s reminder');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.first_occ('c-one'),
    tests.occ_rev(tests.first_occ('c-one')), false, p_due_date => tests.today_a() + 6)),
  'Alice moves it');
select tests.assert_true(
  tests.reminder(tests.first_occ('c-one'), 'carol') = 'scheduled:2'
    and tests.reminder_fire(tests.first_occ('c-one'), 'carol')
      = ((tests.today_a() + 5) + time '18:00') at time zone 'Europe/Brussels'
    and tests.reminder_jobs(tests.first_occ('c-one')) = 2,
  'The before-due reminder follows the new due day with a new revision and job');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'remindersEnded')::integer = 1
     and (impact ->> 'remindersMoved')::integer = 0 and (impact ->> 'overdue')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-one'), tests.occ_rev(tests.first_occ('c-one')), true,
     p_due_date => tests.today_a() - 1)),
  'Moving it into the past would make it overdue and end the reminder');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'remindersEnded')::integer = 1
   from public.update_chore_occurrence(tests.first_occ('c-both'), tests.occ_rev(tests.first_occ('c-both')), true,
     p_assignee_ids => array[tests.i('m-gus-a')])),
  'Taking Carol off Garden would end her reminder there');
select tests.assert_true(
  (select outcome = 'saved' from public.update_chore_occurrence(tests.first_occ('c-both'),
    tests.occ_rev(tests.first_occ('c-both')), false, p_assignee_ids => array[tests.i('m-gus-a')])),
  'Alice leaves only Gus on Garden');
set constraints all immediate;
select tests.assert_true(
  tests.reminder(tests.first_occ('c-both'), 'carol') = 'ended:2'
    and tests.reminder(tests.first_occ('c-both'), 'gus') = 'scheduled:1',
  'Carol''s reminder ended; Gus, kept on the list, keeps his');
set constraints all deferred;

-- Delivery.
select tests.fire_now(tests.first_occ('c-both'));
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_chore_reminder(tests.first_occ('c-both'), tests.user_id('carol'), 1) = 'stale',
  'A job for an older revision does nothing');
select tests.assert_true(
  public.deliver_chore_reminder(tests.first_occ('c-both'), '32000000-0000-4000-8000-000000000001'::uuid, 1) = 'notified',
  'Gus is reminded');
select tests.assert_true(
  public.deliver_chore_reminder(tests.first_occ('c-both'), '32000000-0000-4000-8000-000000000001'::uuid, 1) = 'stale',
  'A duplicate run reminds nobody twice');
select tests.assert_true(
  tests.notices('gus', 'chore.reminder') = 1 and tests.notices('carol', 'chore.reminder') = 0,
  'One notice, for Gus only');
select tests.assert_true(
  tests.sd($q$select n.category = 'reminders' and n.params ->> 'occurrenceId' = tests.first_occ('c-both')::text
     and not (n.params::text like '%Garden%')
   from public.notifications n where n.kind = 'chore.reminder'$q$),
  'In the reminders category, without the title');

-- Completion ends what is left.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'completed' from public.complete_chore_occurrence(tests.first_occ('c-one'), tests.i('m-carol-a'))),
  'Carol completes Windows');
select tests.assert_true(
  tests.reminder(tests.first_occ('c-one'), 'carol') = 'ended:3', 'Her reminder there ends');
select tests.assert_true(
  (select outcome = 'occurrence_closed' from public.set_chore_reminder(tests.first_occ('c-one'), 'relative', 3,
    false, p_days_before => 0, p_time => '09:00')),
  'And none can be set on a completed chore');

-- Removal.
select tests.act_as_user('32000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.set_chore_reminder(tests.first_occ('c-daily'), 'relative', 0,
    false, p_days_before => 0, p_time => '23:59')),
  'Gus sets a reminder on today''s dishes');
select tests.assert_true(
  (select outcome = 'removed' and revision = 2 from public.remove_chore_reminder(tests.first_occ('c-daily'), 1)),
  'And removes it');
select tests.assert_true(
  (select r -> 'reminder' = 'null'::jsonb and (r ->> 'revision')::integer = 2
   from public.get_chore_reminder(tests.first_occ('c-daily')) r),
  'It is gone');

-- A handover request in the move impact.
select tests.act_as_user('32000000-0000-4000-8000-000000000001');
select tests.assert_true(
  (select outcome = 'requested' from public.request_chore_reassignment(tests.i('req'), tests.first_occ('c-both'),
    tests.i('m-carol-a'), null)),
  'Gus asks Carol to take over Garden');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'handoverEnded')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-both'), tests.occ_rev(tests.first_occ('c-both')), true,
     p_assignee_ids => array[tests.i('m-alice-a')])),
  'Assigning someone else would end the open handover request');
select tests.assert_true(
  (select outcome = 'preview' and not (impact ->> 'handoverEnded')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-both'), tests.occ_rev(tests.first_occ('c-both')), true,
     p_due_date => tests.today_a() + 4)),
  'Moving only the date keeps it');

-- The daily summary ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_chore_summary_setting(tests.i('home-a'), true, 8,
    'Europe/Brussels', 0)),
  'A Member cannot turn on the manager summary');
select tests.assert_true(
  (select not (s ->> 'canManage')::boolean and s ? 'counts' = false from public.get_chore_summary(tests.i('home-a')) s),
  'Nor read the Summary page');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_chore_summary_setting(tests.i('home-a'), true, 8,
    'Europe/Brussels', 0)),
  'Nor an Administrator without chore rights');
select tests.act_as('alice');
select tests.assert_denied(
  format($$select * from public.set_chore_summary_setting(%L, true, 8, 'Not/AZone', 0)$$, tests.i('home-a')),
  'The timezone must be real', '22023');
select tests.assert_true(
  (select (s ->> 'enabled')::boolean = false and (s ->> 'revision')::integer = 0
   from public.get_chore_summary_setting(tests.i('home-a')) s),
  'The summary is off by default');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.set_chore_summary_setting(tests.i('home-a'), true, 7,
    'America/New_York', 0)),
  'Alice turns it on for 07:00 in her own timezone');
select tests.assert_true(
  (select outcome = 'conflict' from public.set_chore_summary_setting(tests.i('home-a'), false, 7, 'America/New_York', 0)),
  'A stale revision is a conflict');

-- Something qualifies: Garden made overdue.
select tests.act_as_owner();
update private.chore_occurrences set due_date = tests.today_a() - 2 where id = tests.first_occ('c-both');
select tests.act_as('alice');
select tests.assert_true(
  (select (s -> 'counts' ->> 'overdueAssigned')::integer = 1
     and (select count(*) from jsonb_array_elements(s -> 'items') x
          where x ->> 'id' = tests.first_occ('c-both')::text and x ->> 'group' = 'overdueAssigned') = 1
   from public.get_chore_summary(tests.i('home-a')) s),
  'The Summary page lists the overdue chore');
select tests.set_summary_day('alice', null);
select tests.act_as_service_role();
select tests.assert_true(public.send_chore_summaries(50) >= 1, 'The hourly run sends the summary');
select tests.assert_true(public.send_chore_summaries(50) = 0, 'Once per local day');
select tests.assert_true(
  tests.sd($q$select count(*) = 1 and bool_and(n.category = 'chores'
     and (n.params ->> 'overdueAssigned')::integer = 1 and not (n.params::text like '%Garden%'))
   from public.notifications n join auth.users u on u.id = n.user_id
   where u.email = 'alice@madeora.test' and n.kind = 'chore.manager_summary'$q$),
  'One notice with counts, no titles, in the chores category');

-- Nothing qualifies: no notice, the day still counts as handled.
select tests.act_as_owner();
update private.chore_occurrences set due_date = tests.today_a() + 4 where id = tests.first_occ('c-both');
select tests.set_summary_day('alice', tests.today_a() - 3);
select tests.act_as_service_role();
select tests.assert_true(public.send_chore_summaries(50) = 0, 'Nothing to report sends nothing');
select tests.assert_true(
  tests.sd($q$select last_day is not null and last_day > tests.today_a() - 3 from private.chore_summary_settings
    where user_id = tests.user_id('alice')$q$),
  'The day is recorded anyway');

-- A former manager gets nothing.
select tests.act_as_owner();
update private.chore_occurrences set due_date = tests.today_a() - 2 where id = tests.first_occ('c-both');
insert into private.chore_summary_settings (home_id, user_id, enabled, send_hour, time_zone)
  values (tests.i('home-a'), tests.user_id('carol'), true, 0, 'Europe/Brussels');
select tests.act_as_service_role();
select public.send_chore_summaries(50);
select tests.assert_true(tests.notices('carol', 'chore.manager_summary') = 0,
  'A setting of someone without chore rights sends nothing');

-- A claimed occurrence with automatic release: a moved due day queues the release for the new
-- deadline, and a move that releases it at once needs confirmation.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_chore(tests.i('c-claim'), tests.i('home-a'), 'Bins',
    '{"mode": "none", "members": []}', p_due_date => tests.today_a() + 2)),
  'An unassigned chore in two days');
select tests.set_release('c-claim', 1);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'claimed' from public.claim_chore_occurrence(tests.first_occ('c-claim'))),
  'Carol claims it');
select tests.assert_true(tests.release_jobs(tests.first_occ('c-claim')) = 1, 'Its release is queued');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' and not (impact ->> 'releaseNow')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-claim'), tests.occ_rev(tests.first_occ('c-claim')), false,
     p_due_date => tests.today_a() + 6)),
  'Moving it later releases nothing now');
select tests.assert_true(
  tests.release_jobs(tests.first_occ('c-claim')) = 2
    and tests.sd(format($q$exists (select 1 from private.job_outbox where job_name = 'chore-claim-release'
      and payload ->> 'occurrenceId' = %L
      and available_at = ((%L::date + 1)::timestamp at time zone 'Europe/Brussels') + interval '1 hour')$q$,
      tests.first_occ('c-claim'), tests.today_a() + 6)),
  'and queues the release for the new deadline');
select tests.assert_true(
  (select outcome = 'preview' and (impact ->> 'releaseNow')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-claim'), tests.occ_rev(tests.first_occ('c-claim')), true,
     p_due_date => tests.today_a() - 2)),
  'The preview of a move into the past says the claim goes back to the pool now');
select tests.assert_true(
  (select outcome = 'needs_confirmation' and (impact ->> 'releaseNow')::boolean
   from public.update_chore_occurrence(tests.first_occ('c-claim'), tests.occ_rev(tests.first_occ('c-claim')), false,
     p_due_date => tests.today_a() - 2)),
  'Without confirmation it is not made');
select tests.assert_true(
  tests.sd(format($q$(select due_date = %L::date from private.chore_occurrences where id = %L)$q$,
    tests.today_a() + 6, tests.first_occ('c-claim')))
    and tests.claimed(tests.first_occ('c-claim')),
  'Nothing changed');
select tests.assert_true(
  (select outcome = 'saved'
   from public.update_chore_occurrence(tests.first_occ('c-claim'), tests.occ_rev(tests.first_occ('c-claim')), false,
     p_due_date => tests.today_a() - 2, p_confirm_release => true)),
  'Confirmed, it is moved');
select tests.assert_true(tests.release_jobs(tests.first_occ('c-claim')) = 3,
  'and its release is queued for the moment already passed');

select tests.act_as_owner();
-- DST (Europe/Brussels: the clocks go back on 2026-10-25 and forward on 2027-03-28). The pure time
-- functions answer the same wall-clock rule on both sides of each change.
select tests.assert_true(
  tests.sd($q$private.chore_release_at(
    jsonb_populate_record(null::private.chore_occurrences,
      jsonb_build_object('due_date', '2026-10-24', 'claimed_by', gen_random_uuid())),
    jsonb_populate_record(null::private.chores, '{"auto_release_hours": 24}'::jsonb),
    'Europe/Brussels') = '2026-10-25 22:00+00'::timestamptz$q$),
  'Release 24 h after the end of a due day that precedes the clocks going back: 23:00 local');
select tests.assert_true(
  tests.sd($q$private.chore_release_at(
    jsonb_populate_record(null::private.chore_occurrences,
      jsonb_build_object('due_date', '2027-03-27', 'claimed_by', gen_random_uuid())),
    jsonb_populate_record(null::private.chores, '{"auto_release_hours": 24}'::jsonb),
    'Europe/Brussels') = '2027-03-28 23:00+00'::timestamptz$q$),
  'Release 24 h after the end of a due day that precedes the clocks going forward: 01:00 local');
select tests.assert_true(
  tests.sd($q$private.chore_release_at(
    jsonb_populate_record(null::private.chore_occurrences,
      jsonb_build_object('due_date', '2026-10-25', 'claimed_by', gen_random_uuid())),
    jsonb_populate_record(null::private.chores, '{"auto_release_hours": 0}'::jsonb),
    'Europe/Brussels') = '2026-10-25 23:00+00'::timestamptz$q$),
  'The day that has 25 hours ends at local midnight');
select tests.assert_true(
  tests.sd($q$private.chore_release_at(
    jsonb_populate_record(null::private.chore_occurrences,
      jsonb_build_object('due_date', '2027-03-28', 'claimed_by', gen_random_uuid())),
    jsonb_populate_record(null::private.chores, '{"auto_release_hours": 0}'::jsonb),
    'Europe/Brussels') = '2027-03-28 22:00+00'::timestamptz$q$),
  'The day that has 23 hours ends at local midnight');
select tests.sd($q$(select 1 = 1 from (select set_config('tests.dst_home', home_id::text, true)
  from private.chore_occurrences where id = tests.first_occ('c-claim')) x)$q$);
create function tests.set_zone() returns void
  language plpgsql security definer as $$
  begin
    update public.homes set timezone = 'Europe/Brussels' where id = current_setting('tests.dst_home')::uuid;
  end $$;
select tests.set_zone();
select tests.assert_true(
  tests.sd($q$private.chore_volunteer_deadline(
    jsonb_populate_record(null::private.chore_occurrences,
      jsonb_build_object('due_date', '2026-10-25', 'home_id', current_setting('tests.dst_home'))))
    = '2026-10-25 23:00+00'::timestamptz$q$),
  'A volunteer request ends at the end of the due day in the Home''s zone, 25-hour day included');
select tests.assert_true(
  tests.sd($q$private.chore_volunteer_deadline(
    jsonb_populate_record(null::private.chore_occurrences,
      jsonb_build_object('due_date', '2027-03-28', 'home_id', current_setting('tests.dst_home'))))
    = '2027-03-28 22:00+00'::timestamptz$q$),
  'and on the 23-hour day');
-- A week that starts on the transition Sunday still counts seven calendar days.
select tests.assert_true(
  private.chore_week_start('sunday', date '2026-10-25') = date '2026-10-25'
  and private.chore_week_start('sunday', date '2026-10-31') = date '2026-10-25'
  and private.chore_week_start('monday', date '2026-10-25') = date '2026-10-19'
  and private.chore_week_start('sunday', date '2027-03-28') = date '2027-03-28'
  and private.chore_week_start('sunday', date '2027-04-03') = date '2027-03-28'
  and private.chore_week_start('sunday', date '2027-04-04') = date '2027-04-04',
  'Weeks around the clock changes keep their calendar boundaries');
-- A reminder "1 day before" at a time inside the repeated hour keeps its local wall-clock time.
select tests.assert_true(
  private.reminder_local(date '2026-10-26', 1, time '02:30') = timestamp '2026-10-25 02:30'
  and private.reminder_local(date '2027-03-29', 1, time '02:30') = timestamp '2027-03-28 02:30',
  'A days-before reminder is a local wall-clock time, also in the repeated and the skipped hour');
