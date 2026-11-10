-- S39: personal data exports and the guided privacy review
-- (supabase/migrations/20261126090000_privacy_exports.sql). Fixtures run as the database owner.

-- Fixtures ---------------------------------------------------------------------------------------

create function tests.pe_account(p_email text) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (v_id, 'authenticated', 'authenticated', p_email,
              '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000',
              now(), '{}', '{}', now(), now());
    perform tests.ensure_session(v_id);
    return v_id;
  end
  $$;

create function tests.pe_grant(p_user uuid) returns void
  language sql
  as $$
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, 'data_export', tests.session_id(p_user), now() + interval '1 minute')
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at
  $$;

-- Runs the build job's steps as the service role: begin, collect every category, finish.
create function tests.pe_build(p_export uuid) returns text
  language plpgsql
  as $$
  declare
    v_begin record;
    v_category text;
    v_summary jsonb := '{}'::jsonb;
  begin
    select * into v_begin from public.begin_data_export(p_export);
    if v_begin.outcome <> 'ok' then
      return v_begin.outcome;
    end if;
    foreach v_category in array v_begin.categories loop
      v_summary := v_summary || jsonb_build_object(
        v_category, public.collect_data_export(p_export, v_category));
    end loop;
    return public.finish_data_export(p_export, 1234, jsonb_build_object('categories', v_summary), false);
  end
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select, insert on ids to anon, authenticated, service_role;

insert into ids values
  ('ann', tests.pe_account('ann-export@madeora.test')),
  ('ben', tests.pe_account('ben-export@madeora.test')),
  ('oak', gen_random_uuid()),
  ('elm', gen_random_uuid()),
  ('pine', gen_random_uuid());

-- Ann owns Oak with Ben; Ann is a Member of Elm (owned by Ben); Pine is Ben's alone.
insert into public.homes (id, name, timezone, creation_request_id) values
  ((select id from ids where name = 'oak'), 'Oak', 'Europe/Brussels', gen_random_uuid()),
  ((select id from ids where name = 'elm'), 'Elm', 'Europe/Brussels', gen_random_uuid()),
  ((select id from ids where name = 'pine'), 'Pine', 'Europe/Brussels', gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'oak'), (select id from ids where name = 'ann'), 'owner'),
  ((select id from ids where name = 'oak'), (select id from ids where name = 'ben'), 'member'),
  ((select id from ids where name = 'elm'), (select id from ids where name = 'ben'), 'owner'),
  ((select id from ids where name = 'elm'), (select id from ids where name = 'ann'), 'member'),
  ((select id from ids where name = 'pine'), (select id from ids where name = 'ben'), 'owner');

-- Ann: a personal list and task; a Home task in Oak with her comment and Ben's comment.
insert into ids values ('ann_list', gen_random_uuid()), ('ann_task', gen_random_uuid()),
  ('oak_list', gen_random_uuid()), ('oak_task', gen_random_uuid()),
  ('ben_list', gen_random_uuid()), ('ben_task', gen_random_uuid());
select tests.act_as_user((select id from ids where name = 'ann'));
select public.create_task_list((select id from ids where name = 'ann_list'), 'Ann personal');
select public.create_task((select id from ids where name = 'ann_task'),
  (select id from ids where name = 'ann_list'), 'Ann private task');
select public.create_task_list((select id from ids where name = 'oak_list'), 'Oak chores',
  (select id from ids where name = 'oak'));
select public.create_task((select id from ids where name = 'oak_task'),
  (select id from ids where name = 'oak_list'), 'Oak shared task', p_home_id => (select id from ids where name = 'oak'));
select public.add_task_comment(gen_random_uuid(), (select id from ids where name = 'oak_task'), 'Ann comment in Oak');
select tests.act_as_user((select id from ids where name = 'ben'));
select public.add_task_comment(gen_random_uuid(), (select id from ids where name = 'oak_task'), 'Ben comment in Oak');
select public.create_task_list((select id from ids where name = 'ben_list'), 'Ben personal');
select public.create_task((select id from ids where name = 'ben_task'),
  (select id from ids where name = 'ben_list'), 'Ben private task');
select tests.act_as_owner();

-- Requesting -------------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied($q$select public.request_personal_export(true, null, array[]::uuid[])$q$,
  'anonymous callers cannot request an export');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied($q$select public.request_personal_export(true, null, array[]::uuid[])$q$,
  'an export needs recent re-authentication');
select tests.act_as_owner();
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied($q$select public.request_personal_export(false, array[]::text[], array[]::uuid[])$q$,
  'an empty selection is refused', '22023');
select tests.assert_denied($q$select public.request_personal_export(false, array['passwords'], array[]::uuid[])$q$,
  'an unknown category is refused', '22023');
select tests.assert_denied(
  $q$select public.request_personal_export(false, array['home_contributions'], array[(select id from ids where name = 'pine')])$q$,
  'a Home the person is not in is refused like an unknown one', '22023');
select tests.assert_denied(
  $q$select public.request_personal_export(false, array['home_contributions'], array[]::uuid[])$q$,
  'contributions need at least one Home', '22023');

-- Ann: tasks and her Oak contributions (Oak only).
insert into ids select 'exp1', public.request_personal_export(
  false, array['tasks', 'home_contributions'], array[(select id from ids where name = 'oak')]);
select tests.assert_true(
  (select e.status = 'queued' and e.categories = array['tasks', 'home_contributions']
     and e.home_ids = array[(select id from ids where name = 'oak')] and not e.all_data
   from public.list_my_exports() e where e.id = (select id from ids where name = 'exp1')),
  'the export is queued with its categories and Home scope');
select tests.assert_denied(
  $q$select public.request_personal_export(false, array['tasks'], array[]::uuid[])$q$,
  'only one export is prepared at a time', '54000');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.job_outbox o
   where o.job_name = 'privacy-export-build'
     and o.payload = jsonb_build_object('exportId', (select id from ids where name = 'exp1'))),
  'the build job is queued with the export id only');
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'data_export_requested'),
  'the request appears in the activity history');

-- Ben never sees Ann's exports and cannot cancel or download them.
select tests.pe_grant((select id from ids where name = 'ben'));
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_row_count($q$select * from public.list_my_exports()$q$, 0,
  'another person sees none of the exports');
select tests.assert_denied(
  format('select public.cancel_my_export(%L)', (select id from ids where name = 'exp1')),
  'another person cannot cancel the export', 'P0002');
select tests.assert_denied(
  format('select * from public.authorize_export_download(%L)', (select id from ids where name = 'exp1')),
  'another person cannot download the export', 'P0002');

-- The API roles cannot run the job's functions.
select tests.assert_denied(
  format('select * from public.begin_data_export(%L)', (select id from ids where name = 'exp1')),
  'a signed-in person cannot start a build');
select tests.assert_denied(
  format('select public.collect_data_export(%L, %L)', (select id from ids where name = 'exp1'), 'tasks'),
  'a signed-in person cannot collect export data');
select tests.act_as_owner();

-- Building ---------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_denied(
  format('select public.collect_data_export(%L, %L)', (select id from ids where name = 'exp1'), 'tasks'),
  'nothing is collected before preparation starts', 'P0002');
select tests.assert_true(
  (select b.outcome = 'ok' and b.object_key ~ '^u/[0-9a-f]{64}$'
          and jsonb_array_length(b.homes) = 1
          and (b.homes->0->>'id')::uuid = (select id from ids where name = 'oak')
   from public.begin_data_export((select id from ids where name = 'exp1')) b),
  'the build starts with a key chosen by the database and names the Home scope');
select tests.assert_denied(
  format('select public.collect_data_export(%L, %L)', (select id from ids where name = 'exp1'), 'media'),
  'a category that was not selected is not collected', 'P0002');

create temporary table collected on commit drop as
  select public.collect_data_export((select id from ids where name = 'exp1'), 'tasks') as tasks,
         public.collect_data_export((select id from ids where name = 'exp1'), 'home_contributions') as home;

select tests.assert_true(
  (select jsonb_array_length(c.tasks -> 'files' -> 'tasks/tasks') = 1
     and c.tasks -> 'files' -> 'tasks/tasks' -> 0 ->> 'title' = 'Ann private task'
   from collected c),
  'personal tasks hold only her own personal task');
select tests.assert_true(
  (select c.tasks::text not like '%Oak shared task%' and c.tasks::text not like '%Ben private task%'
   from collected c),
  'Home-owned and other people''s tasks are excluded from a personal export');
select tests.assert_true(
  (select jsonb_array_length(c.home -> 'files' -> 'home_contributions/task_comments') = 1
     and c.home -> 'files' -> 'home_contributions/task_comments' -> 0 ->> 'body' = 'Ann comment in Oak'
     and c.home::text not like '%Ben comment%' and c.home::text not like '%Oak shared task%'
   from collected c),
  'contributions hold only her own comment, not the Home task or other members'' comments');
select tests.assert_true(
  (select c.home::text not like '%' || (select id from ids where name = 'ben')::text || '%'
     and c.tasks::text not like '%' || (select id from ids where name = 'ben')::text || '%'
   from collected c),
  'other people never appear by id');

select tests.assert_true(
  tests.pe_build((select id from ids where name = 'exp1')) = 'ready', 'the export becomes ready');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'ann') and n.kind = 'account.data_export_ready'
     and n.params = '{}'::jsonb),
  'a ready notice without any link or details is sent');

select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select e.status = 'ready' and e.expires_at = e.generated_at + interval '7 days'
   from public.list_my_exports() e where e.id = (select id from ids where name = 'exp1')),
  'a ready export expires 7 days after generation');

-- Downloading ------------------------------------------------------------------------------------

select tests.act_as_owner();
delete from private.account_change_grants where user_id = (select id from ids where name = 'ann');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied(
  format('select * from public.authorize_export_download(%L)', (select id from ids where name = 'exp1')),
  'a download needs a fresh re-authentication');
select tests.act_as_owner();
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select d.object_key ~ '^u/[0-9a-f]{64}$'
   from public.authorize_export_download((select id from ids where name = 'exp1')) d),
  'the requester downloads her ready export');
select tests.assert_true(
  (select e.downloaded_at is not null from public.list_my_exports() e
   where e.id = (select id from ids where name = 'exp1')),
  'the download is recorded');

-- Leaving Oak invalidates the export and removes its file.
select tests.act_as_owner();
create temporary table exp1_key on commit drop as
  select object_key from private.data_exports where id = (select id from ids where name = 'exp1');
delete from public.home_memberships
  where home_id = (select id from ids where name = 'oak') and user_id = (select id from ids where name = 'ben');
select tests.assert_true(
  (select status = 'ready' from private.data_exports where id = (select id from ids where name = 'exp1')),
  'another member leaving does not affect the export');
-- A membership that changed in a way the triggers did not see (here: a stale row id) is caught by
-- the download re-check itself.
update private.data_exports set scope_memberships = array[gen_random_uuid()]
  where id = (select id from ids where name = 'exp1');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select d.object_key is null from public.authorize_export_download((select id from ids where name = 'exp1')) d),
  'after leaving a Home in scope the download is refused');
select tests.assert_true(
  (select e.status = 'invalidated' and e.failure_code = 'access_changed'
   from public.list_my_exports() e where e.id = (select id from ids where name = 'exp1')),
  'the export is invalidated');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.storage_object_deletions d where d.object_key = (select object_key from exp1_key)),
  'the invalidated archive is queued for removal');

-- A late archive (stored after the removal ran) is removed once more after the grace period.
update private.storage_object_deletions set done_at = now()
  where object_key = (select object_key from exp1_key);
select tests.act_as_service_role();
select public.sweep_data_exports(100);
select tests.act_as_owner();
select tests.assert_true(
  (select cleanup_rechecked_at is null from private.data_exports
   where id = (select id from ids where name = 'exp1')),
  'no second removal while a preparation could still be running');
update private.data_exports set ended_at = ended_at - interval '31 minutes'
  where id = (select id from ids where name = 'exp1');
select tests.act_as_service_role();
select public.sweep_data_exports(100);
select tests.act_as_owner();
select tests.assert_true(
  (select e.cleanup_rechecked_at is not null and d.done_at is null
   from private.data_exports e
   join private.storage_object_deletions d on d.object_key = e.object_key
   where e.id = (select id from ids where name = 'exp1')),
  'after the grace period the archive is queued for removal again, once');

-- Membership triggers ----------------------------------------------------------------------------

-- An export scoped to Elm is invalidated by the membership trigger when Ann leaves Elm.
update private.data_exports set created_at = created_at - interval '1 hour'
  where requester_id = (select id from ids where name = 'ann');
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'exp2', public.request_personal_export(
  false, array['home_contributions'], array[(select id from ids where name = 'elm')]);
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'elm') and user_id = (select id from ids where name = 'ann');
select tests.assert_true(
  (select status = 'invalidated' from private.data_exports where id = (select id from ids where name = 'exp2')),
  'leaving a Home in scope invalidates a queued export');
select tests.act_as_service_role();
select tests.assert_true(
  (select b.outcome = 'skip' from public.begin_data_export((select id from ids where name = 'exp2')) b),
  'an invalidated export is never built');
select tests.act_as_owner();

-- Trash and cancellation -------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'exp3', public.request_personal_export(false, array['tasks'], array[]::uuid[]);
select tests.act_as_service_role();
select tests.assert_true(tests.pe_build((select id from ids where name = 'exp3')) = 'ready', 'exp3 is ready');
select tests.act_as_user((select id from ids where name = 'ann'));
select public.delete_task((select id from ids where name = 'ann_task'));
select tests.assert_true(
  (select e.status = 'invalidated' and e.failure_code = 'data_changed'
   from public.list_my_exports() e where e.id = (select id from ids where name = 'exp3')),
  'moving one''s own item to trash invalidates the export');

-- The daily limit: three requests within 24 hours.
select tests.assert_denied($q$select public.request_personal_export(false, array['account'], array[]::uuid[])$q$,
  'a fourth export within a day', '54000');
select tests.act_as_owner();
update private.data_exports set created_at = created_at - interval '25 hours'
  where requester_id = (select id from ids where name = 'ann');
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'exp4', public.request_personal_export(true, null, array[]::uuid[]);
select tests.assert_true(
  (select e.all_data and e.categories = array['account', 'calendar', 'tasks', 'recipes', 'shopping',
                                             'meals', 'habits_goals', 'media', 'home_contributions']
   from public.list_my_exports() e where e.id = (select id from ids where name = 'exp4')),
  'All eligible data selects every category');
select tests.assert_true(public.cancel_my_export((select id from ids where name = 'exp4')),
  'a queued export can be canceled');
select tests.assert_true(not public.cancel_my_export((select id from ids where name = 'exp4')),
  'canceling twice changes nothing');
select tests.act_as_service_role();
select tests.assert_true(
  (select b.outcome = 'skip' from public.begin_data_export((select id from ids where name = 'exp4')) b),
  'a canceled export is never built');

-- A full build collects every category without error (no Homes left: contributions are empty).
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'exp5', public.request_personal_export(true, null, array[]::uuid[]);
select tests.act_as_service_role();
select tests.assert_true(tests.pe_build((select id from ids where name = 'exp5')) = 'ready',
  'a complete export builds');

-- Failure ----------------------------------------------------------------------------------------

select tests.act_as_owner();
update private.data_exports set created_at = created_at - interval '25 hours'
  where requester_id = (select id from ids where name = 'ann');
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'exp6', public.request_personal_export(false, array['account'], array[]::uuid[]);
select tests.act_as_service_role();
select tests.assert_true(public.fail_data_export((select id from ids where name = 'exp6'), 'storage_unavailable'),
  'a build can fail with a code');
select tests.assert_true(
  public.finish_data_export((select id from ids where name = 'exp6'), 1, '{}'::jsonb, false) = 'discarded',
  'a failed export cannot be finished later');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'ann') and n.kind = 'account.data_export_failed'),
  'the failure is notified in-app');

-- Expiry -----------------------------------------------------------------------------------------

update private.data_exports set expires_at = now() + interval '2 hours'
  where id = (select id from ids where name = 'exp5');
select tests.act_as_service_role();
select public.sweep_data_exports(100);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'ann') and n.kind = 'account.data_export_expiring'),
  'one warning before expiry');
select tests.act_as_service_role();
select public.sweep_data_exports(100);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'ann') and n.kind = 'account.data_export_expiring'),
  'the warning is sent only once');
update private.data_exports set expires_at = now() - interval '1 second'
  where id = (select id from ids where name = 'exp5');
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select e.status = 'expired' from public.list_my_exports() e where e.id = (select id from ids where name = 'exp5')),
  'an export past its expiry shows as expired at once');
select tests.assert_denied(
  format('select * from public.authorize_export_download(%L)', (select id from ids where name = 'exp5')),
  'an expired export cannot be downloaded', 'P0002');
select tests.act_as_service_role();
select public.sweep_data_exports(100);
select tests.act_as_owner();
select tests.assert_true(
  (select e.status = 'expired' and exists (
     select 1 from private.storage_object_deletions d where d.object_key = e.object_key)
   from private.data_exports e where e.id = (select id from ids where name = 'exp5')),
  'the hourly sweep ends the expired export and queues its file for removal');

-- Stale preparation fails.
update private.data_exports set created_at = now() - interval '3 hours', status = 'preparing'
  where id = (select id from ids where name = 'exp6');
update private.data_exports set status = 'preparing', ended_at = null
  where id = (select id from ids where name = 'exp6');
select tests.act_as_service_role();
select public.sweep_data_exports(100);
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'failed' and failure_code = 'timed_out' from private.data_exports
   where id = (select id from ids where name = 'exp6')),
  'a preparation that never finished fails');

-- Deletions outside personal trash ---------------------------------------------------------------

-- Ben (owner of Pine) has a Pine task with his comment.
insert into ids values ('pine_list', gen_random_uuid()), ('pine_task', gen_random_uuid());
select tests.act_as_user((select id from ids where name = 'ben'));
select public.create_task_list((select id from ids where name = 'pine_list'), 'Pine chores',
  (select id from ids where name = 'pine'));
select public.create_task((select id from ids where name = 'pine_task'),
  (select id from ids where name = 'pine_list'), 'Pine task', p_home_id => (select id from ids where name = 'pine'));
select public.add_task_comment(gen_random_uuid(), (select id from ids where name = 'pine_task'), 'Ben comment in Pine');
select tests.act_as_owner();
select tests.pe_grant((select id from ids where name = 'ben'));

-- His contribution deleted outright (not through trash) invalidates his ready export.
select tests.act_as_user((select id from ids where name = 'ben'));
insert into ids select 'bdel', public.request_personal_export(
  false, array['home_contributions'], array[(select id from ids where name = 'pine')]);
select tests.act_as_service_role();
select tests.assert_true(tests.pe_build((select id from ids where name = 'bdel')) = 'ready', 'bdel is ready');
select tests.act_as_owner();
delete from private.task_comments where author_id = (select id from ids where name = 'ben');
select tests.assert_true(
  (select status = 'invalidated' and failure_code = 'data_changed' from private.data_exports
   where id = (select id from ids where name = 'bdel')),
  'deleting a contribution outright invalidates the export');

-- A Home item moved to trash invalidates exports of contributions in that Home.
select tests.act_as_user((select id from ids where name = 'ben'));
insert into ids select 'btrash', public.request_personal_export(
  false, array['home_contributions'], array[(select id from ids where name = 'pine')]);
select tests.act_as_service_role();
select tests.assert_true(tests.pe_build((select id from ids where name = 'btrash')) = 'ready', 'btrash is ready');
select tests.act_as_user((select id from ids where name = 'ben'));
select public.delete_task((select id from ids where name = 'pine_task'));
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'invalidated' and failure_code = 'data_changed' from private.data_exports
   where id = (select id from ids where name = 'btrash')),
  'a Home item moved to trash invalidates exports of contributions in that Home');

-- Deactivation -----------------------------------------------------------------------------------

select tests.act_as_owner();
update private.data_exports set created_at = created_at - interval '25 hours'
  where requester_id = (select id from ids where name = 'ben');
select tests.act_as_user((select id from ids where name = 'ben'));
insert into ids select 'bexp', public.request_personal_export(false, array['tasks'], array[]::uuid[]);
select tests.act_as_owner();
insert into private.account_deactivations (user_id) values ((select id from ids where name = 'ben'));
select tests.assert_true(
  (select status = 'invalidated' and failure_code = 'account_deactivated' from private.data_exports
   where id = (select id from ids where name = 'bexp')),
  'deactivation invalidates every unfinished export');
delete from private.account_deactivations where user_id = (select id from ids where name = 'ben');

-- Home exports -----------------------------------------------------------------------------------

-- Ash: Ben owns it, Ann is a Member. A Home task with Ben's comment, a pet with medical notes, and
-- Ann's personal task (never part of a Home export).
insert into ids values ('ash', gen_random_uuid()), ('ash_list', gen_random_uuid()),
  ('ash_task', gen_random_uuid()), ('ash_pet', gen_random_uuid()), ('ann_task2', gen_random_uuid()),
  ('ann_list2', gen_random_uuid());
insert into public.homes (id, name, timezone, creation_request_id) values
  ((select id from ids where name = 'ash'), 'Ash', 'Europe/Brussels', gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'ash'), (select id from ids where name = 'ben'), 'owner'),
  ((select id from ids where name = 'ash'), (select id from ids where name = 'ann'), 'member');
select tests.act_as_user((select id from ids where name = 'ben'));
select public.create_task_list((select id from ids where name = 'ash_list'), 'Ash chores',
  (select id from ids where name = 'ash'));
select public.create_task((select id from ids where name = 'ash_task'),
  (select id from ids where name = 'ash_list'), 'Ash shared task', p_home_id => (select id from ids where name = 'ash'));
select public.add_task_comment(gen_random_uuid(), (select id from ids where name = 'ash_task'), 'Ben comment in Ash');
select public.create_pet((select id from ids where name = 'ash_pet'), (select id from ids where name = 'ash'), 'Rex');
select tests.act_as_user((select id from ids where name = 'ann'));
select public.create_task_list((select id from ids where name = 'ann_list2'), 'Ann personal 2');
select public.create_task((select id from ids where name = 'ann_task2'),
  (select id from ids where name = 'ann_list2'), 'Ann secret task');
select tests.act_as_owner();
insert into private.pet_medical_details (pet_id, medical_notes)
  values ((select id from ids where name = 'ash_pet'), 'Rex medical note');
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.pe_grant((select id from ids where name = 'ben'));
insert into ids select 'ash_' || (case m.user_id when (select id from ids where name = 'ann') then 'ann' else 'ben' end), m.id
  from public.home_memberships m where m.home_id = (select id from ids where name = 'ash');

-- Without exportHomeData a Member is refused; a Home one is not in looks like no Home at all.
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied(
  format('select public.request_home_export(%L, true, null)', (select id from ids where name = 'ash')),
  'a Member without the Home export permission is refused', '42501');
select tests.assert_denied(
  format('select public.request_home_export(%L, true, null)', (select id from ids where name = 'pine')),
  'a Home the person is not in is refused', '42501');
select tests.assert_true(
  (select not (public.list_home_export_access((select id from ids where name = 'ash')) ->> 'canExport')::boolean
      and not (public.list_home_export_access((select id from ids where name = 'ash')) ->> 'canGrant')::boolean
      and jsonb_array_length(public.list_home_export_access((select id from ids where name = 'ash')) -> 'members') = 1),
  'a Member sees only their own answer');
select tests.assert_true(
  public.set_home_export_access((select id from ids where name = 'ash'),
    (select id from ids where name = 'ash_ann'), true) = 'not_permitted',
  'only the Owner grants the Home export permission');

-- The Owner grants it.
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_true(
  public.set_home_export_access((select id from ids where name = 'ash'),
    (select id from ids where name = 'ash_ann'), true) = 'ok',
  'the Owner grants the Home export permission to a Member');
select tests.assert_true(
  public.set_home_export_access((select id from ids where name = 'ash'),
    (select id from ids where name = 'ash_ben'), false) = 'not_permitted',
  'the Owner''s own permission cannot be changed');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.audit_events a where a.action = 'home.export_access.changed'
          and a.home_id = (select id from ids where name = 'ash')),
  'granting is audited');

-- Ann exports Ash: only Home-owned records she may see.
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'hexp1', public.request_home_export((select id from ids where name = 'ash'), true, null);
select tests.assert_true(
  (select e.kind = 'home' and e.home_ids = array[(select id from ids where name = 'ash')]
          and e.categories = array['home', 'tasks', 'chores', 'calendar', 'recipes', 'shopping',
                                   'meals', 'habits_goals', 'pets', 'photos', 'points']
   from public.list_my_exports() e where e.id = (select id from ids where name = 'hexp1')),
  'a Home export is listed with its Home and every Home category');
select tests.assert_denied(
  format('select public.request_home_export(%L, true, null)', (select id from ids where name = 'ash')),
  'one Home export at a time per Home', '54000');
select tests.act_as_service_role();
select tests.assert_true(
  (select b.outcome = 'ok' and b.kind = 'home'
          and (b.homes -> 0 ->> 'id')::uuid = (select id from ids where name = 'ash')
   from public.begin_data_export((select id from ids where name = 'hexp1')) b),
  'the build of a Home export starts with its Home');
create temporary table hcollected on commit drop as
  select public.collect_data_export((select id from ids where name = 'hexp1'), 'tasks') as tasks,
         public.collect_data_export((select id from ids where name = 'hexp1'), 'home') as home,
         public.collect_data_export((select id from ids where name = 'hexp1'), 'pets') as pets;
select tests.act_as_owner();
select tests.assert_true(
  (select jsonb_array_length(c.tasks -> 'files' -> 'tasks/tasks') = 1
          and c.tasks -> 'files' -> 'tasks/tasks' -> 0 ->> 'title' = 'Ash shared task'
          and c.tasks -> 'files' -> 'tasks/comments' -> 0 ->> 'author' <> 'someone_else'
          and c.tasks::text not like '%Ann secret task%'
          and c.tasks::text not like '%' || (select id from ids where name = 'ben')::text || '%'
   from hcollected c),
  'Home tasks are exported with member names, without personal tasks or account ids');
select tests.assert_true(
  (select jsonb_array_length(c.home -> 'files' -> 'home/members') = 2
          and c.home::text like '%"you"%'
   from hcollected c),
  'the members list names the Home''s members');
select tests.assert_true(
  (select jsonb_array_length(c.pets -> 'files' -> 'pets/pets') = 1
          and not (c.pets -> 'files' ? 'pets/medical_details')
   from hcollected c),
  'pet medical details stay out without medical access');
select tests.act_as_service_role();
select tests.assert_true(
  (select (public.collect_data_export((select id from ids where name = 'hexp1'), 'pets')
           -> 'files' -> 'pets/medical_details' -> 0 ->> 'medical_notes') is null),
  'still no medical details');
select tests.act_as_owner();

-- The Owner's export includes medical details (the Owner manages pet medical access).
select tests.act_as_user((select id from ids where name = 'ben'));
insert into ids select 'hexp2', public.request_home_export((select id from ids where name = 'ash'), false, array['pets']);
select tests.act_as_service_role();
select tests.assert_true(
  (select b.outcome = 'ok' from public.begin_data_export((select id from ids where name = 'hexp2')) b),
  'the Owner''s build starts');
select tests.assert_true(
  (select public.collect_data_export((select id from ids where name = 'hexp2'), 'pets')
          -> 'files' -> 'pets/medical_details' -> 0 ->> 'medical_notes' = 'Rex medical note'),
  'the Owner''s export includes pet medical details');
select tests.act_as_owner();

-- Every Home category collects without error, as the Owner and as a granted Member.
select tests.assert_true(
  (select bool_and(jsonb_typeof(private.collect_home_category(u.id, (select id from ids where name = 'ash'), c) -> 'files') = 'object')
   from unnest(private.home_export_categories()) c,
        (select id from ids where name in ('ann', 'ben')) u),
  'every Home category collects');

-- A chore in trash stays out with its occurrences and submissions.
insert into ids values ('ash_chore', gen_random_uuid());
insert into private.chores (id, home_id, kind, title, deleted_at)
  values ((select id from ids where name = 'ash_chore'), (select id from ids where name = 'ash'),
          'one_off', 'Trashed chore', now());
insert into private.chore_occurrences (id, chore_id, home_id, scheduled_date, due_date, status,
                                       skipped_at, skip_reason)
  values (gen_random_uuid(), (select id from ids where name = 'ash_chore'),
          (select id from ids where name = 'ash'), current_date, current_date, 'skipped', now(),
          'Trashed chore reason');
select tests.assert_true(
  private.collect_home_category((select id from ids where name = 'ben'),
    (select id from ids where name = 'ash'), 'chores')::text not like '%Trashed chore%',
  'a trashed chore''s occurrences stay out of a Home export');

-- Gaining medical access while preparing keeps the export; the ready archive then holds medical
-- details, so losing that access blocks the download and invalidates it.
insert into private.pet_medical_access (home_id, user_id, level)
  values ((select id from ids where name = 'ash'), (select id from ids where name = 'ann'), 'view');
select tests.act_as_service_role();
select tests.assert_true(
  public.finish_data_export((select id from ids where name = 'hexp1'), 1, '{}'::jsonb, false) = 'ready',
  'gaining access while preparing does not discard the export');
select tests.act_as_owner();
select tests.assert_true(
  (select e.access_snapshot -> 'gates' ? 'pet_medical' from private.data_exports e
   where e.id = (select id from ids where name = 'hexp1')),
  'the ready export records the medical access it may hold');
select tests.assert_true(
  exists (select 1 from public.notifications n
          where n.user_id = (select id from ids where name = 'ann')
            and n.kind = 'account.data_export_ready'
            and n.home_id = (select id from ids where name = 'ash')),
  'the ready notice of a Home export names its Home (it leads to the Home''s export page)');
delete from private.pet_medical_access
  where home_id = (select id from ids where name = 'ash') and user_id = (select id from ids where name = 'ann');
select tests.assert_true(
  (select status = 'ready' from private.data_exports where id = (select id from ids where name = 'hexp1')),
  'losing module access is caught at the next check');
select tests.pe_grant((select id from ids where name = 'ann'));
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select d.object_key is null
   from public.authorize_export_download((select id from ids where name = 'hexp1')) d),
  'no download after losing pet medical access');
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'invalidated' and failure_code = 'access_changed' from private.data_exports
   where id = (select id from ids where name = 'hexp1')),
  'losing module access invalidates the Home export');

-- A queued export has collected nothing: data changes leave it; cancelling it is audited.
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'hexp3', public.request_home_export((select id from ids where name = 'ash'), false, array['tasks']);
select tests.act_as_owner();
select tests.assert_true(
  not private.end_data_export((select id from ids where name = 'hexp3'), 'invalidated', 'data_changed'),
  'a data change does not void a queued export');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(public.cancel_my_export((select id from ids where name = 'hexp3')),
  'the requester cancels a Home export');
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from private.audit_events a where a.action = 'home.export.canceled'
          and a.home_id = (select id from ids where name = 'ash')),
  'cancelling a Home export is audited');

-- Revoking the permission ends Ann's Home export; Ben's stays.
select tests.act_as_user((select id from ids where name = 'ann'));
insert into ids select 'hexp4', public.request_home_export((select id from ids where name = 'ash'), false, array['tasks']);
select tests.act_as_user((select id from ids where name = 'ben'));
select public.set_home_export_access((select id from ids where name = 'ash'),
  (select id from ids where name = 'ash_ann'), false);
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'invalidated' and failure_code = 'access_changed' from private.data_exports
   where id = (select id from ids where name = 'hexp4')),
  'revoking the Home export permission invalidates the export');
select tests.assert_true(
  (select status = 'preparing' from private.data_exports where id = (select id from ids where name = 'hexp2')),
  'the Owner''s export is unaffected by the revoke');

-- A member leaving makes a Home export (which names its members) out of date.
delete from public.home_memberships
  where home_id = (select id from ids where name = 'ash') and user_id = (select id from ids where name = 'ann');
select tests.assert_true(
  (select status = 'invalidated' and failure_code = 'data_changed' from private.data_exports
   where id = (select id from ids where name = 'hexp2')),
  'another member leaving invalidates the Home export');

-- Guided privacy review --------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_row_count($q$select * from public.my_privacy_review()$q$, 0, 'no review yet');
select tests.assert_denied($q$select public.save_my_privacy_review('step', 'homes')$q$,
  'no step before the review starts', 'P0002');
select public.save_my_privacy_review('start');
select public.save_my_privacy_review('step', 'devices');
select tests.assert_true(
  (select r.step = 'devices' and r.completed_at is null from public.my_privacy_review() r),
  'the review is resumable at the step reached');
select tests.assert_denied($q$select public.save_my_privacy_review('step', 'passwords')$q$,
  'an unknown step is refused', '22023');
select public.save_my_privacy_review('finish');
select tests.assert_true(
  (select r.completed_at is not null from public.my_privacy_review() r), 'the review is completed');
select public.save_my_privacy_review('start');
select tests.assert_true(
  (select r.step = 'profile' and r.completed_at is null from public.my_privacy_review() r),
  'the review can be restarted');
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_row_count($q$select * from public.my_privacy_review()$q$, 0,
  'another person never sees the review');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'privacy_review_started')
  and (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'privacy_review_completed'),
  'starting and finishing the review appear in the activity history');
