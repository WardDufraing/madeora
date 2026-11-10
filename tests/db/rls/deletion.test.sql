-- S40 (part 1): Home deletion ("Close Home") and account deletion with their 30-day recovery,
-- the purge, and "Former member" anonymization
-- (supabase/migrations/20261127090000_account_home_deletion.sql).

create function tests.del_account(p_email text) returns uuid
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
    return v_id;
  end
  $$;

create function tests.del_grant(p_user uuid, p_action text) returns void
  language sql
  as $$
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, p_action, tests.session_id(p_user), now() + interval '1 minute')
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at
  $$;

-- The request check as PostgREST runs it for `p_path`; true when it lets the request through.
create function tests.del_request_ok(p_path text) returns boolean
  language plpgsql
  as $$
  begin
    perform set_config('request.path', p_path, true);
    perform public.check_request();
    return true;
  exception when sqlstate 'PT401' then
    return false;
  end
  $$;

create function tests.del_task(p_home uuid, p_title text, p_assignee uuid, p_done boolean)
returns uuid
  language plpgsql
  as $$
  declare
    v_list uuid := gen_random_uuid();
    v_task uuid := gen_random_uuid();
  begin
    insert into private.task_lists (id, owner_home_id, name) values (v_list, p_home, 'List ' || p_title);
    insert into private.tasks (id, owner_home_id, list_id, title, completed_at, completed_by)
      values (v_task, p_home, v_list, p_title,
              case when p_done then now() end, case when p_done then p_assignee end);
    insert into private.task_assignees (task_id, home_id, user_id) values (v_task, p_home, p_assignee);
    return v_task;
  end
  $$;

-- An open chore occurrence assigned to p_from with a pending request to hand it to p_to.
create function tests.del_chore_request(p_home uuid, p_from uuid, p_to uuid) returns uuid
  language plpgsql
  as $$
  declare
    v_chore uuid := gen_random_uuid();
    v_occurrence uuid := gen_random_uuid();
    v_request uuid := gen_random_uuid();
  begin
    insert into private.chores (id, home_id, kind, title) values (v_chore, p_home, 'one_off', 'Sweep');
    insert into private.chore_occurrences (id, chore_id, home_id, scheduled_date, due_date, status)
      values (v_occurrence, v_chore, p_home, current_date, current_date, 'open');
    insert into private.chore_occurrence_assignees (occurrence_id, home_id, user_id)
      values (v_occurrence, p_home, p_from);
    insert into private.chore_reassignment_requests (id, home_id, occurrence_id, from_user, to_user,
                                                    requested_by)
      values (v_request, p_home, v_occurrence, p_from, p_to, p_from);
    return v_request;
  end
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select on ids to authenticated, service_role;
create temporary table marks (name text primary key, at timestamptz not null) on commit drop;
grant select, insert on marks to authenticated;

insert into ids values
  ('owen', tests.del_account('owen-deletion@madeora.test')),
  ('mia', tests.del_account('mia-deletion@madeora.test')),
  ('zed', tests.del_account('zed-deletion@madeora.test')),
  ('nia', tests.del_account('nia-deletion@madeora.test')),
  ('pine', gen_random_uuid()),
  ('elm', gen_random_uuid());

-- Owen owns Pine (Mia and Zed are members); Zed owns Elm (Mia is a member).
insert into public.homes (id, name, timezone, creation_request_id) values
  ((select id from ids where name = 'pine'), 'Pine', 'Europe/Brussels', gen_random_uuid()),
  ((select id from ids where name = 'elm'), 'Elm', 'Europe/Brussels', gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'pine'), (select id from ids where name = 'owen'), 'owner'),
  ((select id from ids where name = 'pine'), (select id from ids where name = 'mia'), 'member'),
  ((select id from ids where name = 'pine'), (select id from ids where name = 'zed'), 'administrator'),
  ((select id from ids where name = 'elm'), (select id from ids where name = 'zed'), 'owner'),
  ((select id from ids where name = 'elm'), (select id from ids where name = 'mia'), 'member');

-- A Pine task for Mia and an Elm task she completed (history), a pending invitation link in Pine.
insert into ids values
  ('pine_task', tests.del_task((select id from ids where name = 'pine'), 'Water plants',
                               (select id from ids where name = 'mia'), false)),
  ('elm_open', tests.del_task((select id from ids where name = 'elm'), 'Fix gate',
                              (select id from ids where name = 'mia'), false)),
  ('elm_done', tests.del_task((select id from ids where name = 'elm'), 'Clean gutters',
                              (select id from ids where name = 'mia'), true));
insert into private.home_invitations (home_id, kind, role, token, expires_at, max_admissions,
                                      created_by, creation_request_id)
  values ((select id from ids where name = 'pine'), 'link', 'member', 'pine-link-token-for-tests',
          now() + interval '7 days', 5, (select id from ids where name = 'owen'), gen_random_uuid());

select tests.ensure_session((select id from ids where name = 'owen'));
select tests.ensure_session((select id from ids where name = 'mia'));
select tests.ensure_session((select id from ids where name = 'zed'));

-- Close a Home: who and how ----------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'zed'));
select tests.assert_denied(
  $q$select public.close_home((select id from ids where name = 'pine'), 'Pine')$q$,
  'an Administrator cannot close a Home', '42501');
select tests.assert_denied(
  $q$select * from public.home_closure_summary((select id from ids where name = 'pine'))$q$,
  'an Administrator gets no closure summary', '42501');

select tests.act_as_user((select id from ids where name = 'owen'));
select tests.assert_true(
  (select s.member_count = 3 and s.pending_invitations = 1
   from public.home_closure_summary((select id from ids where name = 'pine')) s),
  'the Owner sees what closing affects (counts only)');
select tests.assert_denied(
  $q$select public.close_home((select id from ids where name = 'pine'), 'Pine')$q$,
  'closing needs a fresh re-authentication', '42501');
select tests.act_as_owner();
select tests.del_grant((select id from ids where name = 'owen'), 'close_home');
select tests.act_as_user((select id from ids where name = 'owen'));
select tests.assert_denied(
  $q$select public.close_home((select id from ids where name = 'pine'), 'pine')$q$,
  'the typed name must match exactly', '22023');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.home_deletions),
  'a refused close changes nothing');

select tests.act_as_user((select id from ids where name = 'owen'));
insert into marks select 'pine_deadline', public.close_home((select id from ids where name = 'pine'), ' Pine ');
select tests.assert_true(
  (select m.at from marks m where m.name = 'pine_deadline')
    between now() + interval '30 days' - interval '1 minute' and now() + interval '30 days' + interval '1 minute',
  'closing starts a 30-day recovery period');
insert into marks select 'again', public.close_home((select id from ids where name = 'pine'), 'Pine');
select tests.act_as_owner();
select tests.assert_true(
  (select m.at from marks m where m.name = 'again') = (select d.purge_after from private.home_deletions d),
  'a repeated close by the Owner returns the same deadline');
select tests.act_as_user((select id from ids where name = 'owen'));

-- Pending: inaccessible to everyone ----------------------------------------------------------------

select tests.assert_row_count('select id from public.homes where name = ''Pine''', 0,
  'the Owner no longer sees the closed Home');
select tests.assert_row_count(
  $q$select id from public.home_memberships where home_id = (select id from ids where name = 'pine')$q$, 0,
  'the Owner has no visible membership in it');
select tests.assert_true(
  (select count(*) = 1 and bool_and(c.home_name = 'Pine') from public.my_closed_homes() c),
  'the Owner sees it among their closed Homes, with the deadline');
select tests.assert_denied(
  $q$select * from public.home_closure_summary((select id from ids where name = 'pine'))$q$,
  'nor can they act in it', '42501');

select tests.act_as_user((select id from ids where name = 'mia'));
select tests.assert_row_count('select id from public.homes', 1, 'a member sees only her open Home');
select tests.assert_row_count('select id from public.home_memberships', 1,
  'and only her membership there');
select tests.assert_true(not exists (select 1 from public.my_closed_homes()),
  'a member has no closed Home to restore');
select tests.assert_denied(
  $q$select public.restore_home((select id from ids where name = 'pine'))$q$,
  'a member cannot restore', '42501');

select tests.act_as_owner();
select tests.assert_true(
  private.home_role((select id from ids where name = 'pine'), (select id from ids where name = 'zed')) is null
  and not private.is_home_member((select id from ids where name = 'pine'), (select id from ids where name = 'mia')),
  'every permission helper sees no membership in the closed Home');
select tests.assert_true(
  (select count(*) = 3 from private.home_memberships_all m
   where m.home_id = (select id from ids where name = 'pine')),
  'the memberships themselves are kept for restoration');
select tests.assert_denied(
  $q$insert into public.home_memberships (home_id, user_id, role)
     values ((select id from ids where name = 'pine'), (select id from ids where name = 'nia'), 'member')$q$,
  'no membership can be written into a closed Home', '44000');
select tests.assert_true(
  (select i.end_reason = 'home_closed' from private.home_invitations i
   where i.token = 'pine-link-token-for-tests'),
  'pending invitations end for good');
select tests.assert_true(
  (select count(*) = 3 from public.notifications n
   where n.kind = 'home.deletion_started' and n.home_id is null and n.category = 'security'
     and n.params ->> 'homeName' = 'Pine' and n.email_status = 'queued'),
  'every member, the Owner included, gets an in-app notice and an email without the Home id');
select tests.assert_true(
  exists (select 1 from private.audit_events a
          where a.action = 'home.deletion_requested' and a.home_id = (select id from ids where name = 'pine')),
  'closing is audited');

-- Restore ----------------------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'owen'));
select tests.assert_denied(
  $q$select public.restore_home((select id from ids where name = 'pine'))$q$,
  'restoring needs a fresh re-authentication', '42501');
select tests.act_as_owner();
select tests.del_grant((select id from ids where name = 'owen'), 'close_home');
select tests.act_as_user((select id from ids where name = 'owen'));
select public.restore_home((select id from ids where name = 'pine'));
select tests.assert_row_count('select id from public.homes where name = ''Pine''', 1,
  'the restored Home is visible again');
select tests.act_as_user((select id from ids where name = 'zed'));
select tests.assert_true(
  (select m.role = 'administrator' from public.home_memberships m
   where m.home_id = (select id from ids where name = 'pine')),
  'roles come back as they were');
select tests.act_as_owner();
select tests.assert_true(
  (select i.end_reason = 'home_closed' from private.home_invitations i
   where i.token = 'pine-link-token-for-tests'),
  'ended invitations stay ended after restoration');
select tests.assert_true(
  (select count(*) = 3 from public.notifications n where n.kind = 'home.restored'),
  'every member is told about the restoration');

-- Purge after the deadline -------------------------------------------------------------------------

select tests.del_grant((select id from ids where name = 'owen'), 'close_home');
select tests.act_as_user((select id from ids where name = 'owen'));
select public.close_home((select id from ids where name = 'pine'), 'Pine');
select tests.act_as_owner();
update private.home_deletions set requested_at = now() - interval '31 days',
  purge_after = now() - interval '1 day';
select tests.del_grant((select id from ids where name = 'owen'), 'close_home');
select tests.act_as_user((select id from ids where name = 'owen'));
select tests.assert_denied(
  $q$select public.restore_home((select id from ids where name = 'pine'))$q$,
  'no restoration after the deadline', 'P0001');
select tests.assert_denied($q$select public.purge_due_deletions(10)$q$,
  'members cannot run the purge', '42501');
select tests.act_as_owner();
set local role service_role;
select tests.assert_true(
  (public.purge_due_deletions(10) ->> 'homes')::integer = 1,
  'the purge deletes the Home whose recovery period ended');
reset role;
select tests.assert_true(
  not exists (select 1 from public.homes where id = (select id from ids where name = 'pine'))
  and not exists (select 1 from private.tasks where id = (select id from ids where name = 'pine_task'))
  and not exists (select 1 from private.home_memberships_all where home_id = (select id from ids where name = 'pine')),
  'the Home goes with its data and memberships');
select tests.assert_true(
  exists (select 1 from private.audit_events a
          where a.action = 'home.purged' and a.home_id = (select id from ids where name = 'pine')),
  'the purge is audited (id only)');
select tests.assert_true(
  not exists (select 1 from public.notifications n
              where n.params ->> 'homeId' = (select id from ids where name = 'pine')::text),
  'the closing and restoring notices, which name the Home, go with it');
set constraints all immediate;
set constraints all deferred;

-- Account deletion ------------------------------------------------------------------------------

-- Zed owns Elm: blocked.
select tests.del_grant((select id from ids where name = 'zed'), 'delete_account');
select tests.act_as_user((select id from ids where name = 'zed'));
select tests.assert_denied($q$select public.request_account_deletion()$q$,
  'a Home Owner cannot delete the account', 'P0001');

-- Mia, a member of Elm, has asked Zed to take over a chore.
select tests.act_as_owner();
insert into ids values ('mia_request', tests.del_chore_request((select id from ids where name = 'elm'),
  (select id from ids where name = 'mia'), (select id from ids where name = 'zed')));
select tests.act_as_user((select id from ids where name = 'mia'));
select tests.assert_denied($q$select public.request_account_deletion()$q$,
  'account deletion needs a fresh re-authentication', '42501');
select tests.act_as_owner();
select tests.del_grant((select id from ids where name = 'mia'), 'delete_account');
select tests.act_as_user((select id from ids where name = 'mia'));
insert into marks select 'mia_deadline', public.request_account_deletion();
select tests.assert_true(
  (select m.at from marks m where m.name = 'mia_deadline')
    between now() + interval '30 days' - interval '1 minute' and now() + interval '30 days' + interval '1 minute',
  'deletion starts a 30-day recovery period');
select tests.act_as_owner();

select tests.assert_true(private.is_deactivated((select id from ids where name = 'mia')),
  'the account is suspended');
select tests.assert_true(
  not exists (select 1 from auth.sessions s where s.user_id = (select id from ids where name = 'mia')),
  'every session ended');
select tests.assert_true(
  (select t.needs_reassignment from private.tasks t where t.id = (select id from ids where name = 'elm_open')),
  'her open Home task is flagged for reassignment');
select tests.assert_true(
  private.is_home_member((select id from ids where name = 'elm'), (select id from ids where name = 'mia')),
  'her membership is kept during the recovery period');
select tests.assert_true(
  not exists (select 1 from public.notifications n
              where n.user_id = (select id from ids where name = 'zed')
                and (n.kind like 'account.%' or n.kind like 'chore.%')),
  'other members are not told, not even about the chore request it ended');
select tests.assert_true(
  (select r.status = 'invalidated' and r.invalid_reason = 'assignment_changed'
   from private.chore_reassignment_requests r where r.id = (select id from ids where name = 'mia_request')),
  'her open chore request ends with a neutral reason, not "member left"');
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'mia') and n.kind = 'account.deletion_requested'
     and n.email_status = 'queued'),
  'the account holder is told, with an email');

-- Signing in again: the session may only read the state and cancel.
select tests.ensure_session((select id from ids where name = 'mia'));
select tests.act_as_user((select id from ids where name = 'mia'));
select tests.assert_true(
  not tests.del_request_ok('/rpc/list_tasks') and tests.del_request_ok('/rpc/my_account_state')
  and tests.del_request_ok('/rpc/reactivate_my_account'),
  'a session of an account pending deletion can only read its state and cancel');
select tests.assert_true(
  (select s.deletion_purge_after is not null and s.deactivated_at is not null from public.my_account_state() s),
  'the state says until when the account can be recovered');

-- Zed removes Mia from Elm meanwhile; that stands after the cancellation.
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'elm') and user_id = (select id from ids where name = 'mia');
select tests.act_as_user((select id from ids where name = 'mia'));
select public.reactivate_my_account();
select tests.act_as_owner();
select tests.assert_true(
  not private.is_deactivated((select id from ids where name = 'mia'))
  and not exists (select 1 from private.account_deletions),
  'cancelling restores the account');
select tests.assert_true(
  not private.is_home_member((select id from ids where name = 'elm'), (select id from ids where name = 'mia')),
  'a membership removed during the recovery period is not reinstated');
select tests.assert_true(
  exists (select 1 from public.notifications n
          where n.user_id = (select id from ids where name = 'mia') and n.kind = 'account.deletion_canceled'),
  'the account holder is told the deletion was cancelled');

-- Final deletion: Mia rejoins Elm, asks again, and the period ends.
insert into public.home_memberships (home_id, user_id, role)
  values ((select id from ids where name = 'elm'), (select id from ids where name = 'mia'), 'member');
select tests.ensure_session((select id from ids where name = 'mia'));
select tests.del_grant((select id from ids where name = 'mia'), 'delete_account');
select tests.act_as_user((select id from ids where name = 'mia'));
select public.request_account_deletion();
select tests.act_as_owner();
update private.account_deletions set requested_at = now() - interval '31 days',
  purge_after = now() - interval '1 day';
-- A request still open at the purge (made for her by a manager meanwhile) ends without notices too.
insert into ids values ('mia_request_2', tests.del_chore_request((select id from ids where name = 'elm'),
  (select id from ids where name = 'mia'), (select id from ids where name = 'zed')));
select tests.ensure_session((select id from ids where name = 'mia'));
select tests.act_as_user((select id from ids where name = 'mia'));
select tests.assert_denied($q$select public.reactivate_my_account()$q$,
  'no cancellation after the deadline', 'P0001');
select tests.act_as_owner();
set local role service_role;
select tests.assert_true(
  (public.purge_due_deletions(10) ->> 'accounts')::integer = 1,
  'the purge deletes the account whose recovery period ended');
reset role;
select tests.assert_true(
  not exists (select 1 from auth.users where id = (select id from ids where name = 'mia'))
  and not exists (select 1 from private.home_memberships_all where user_id = (select id from ids where name = 'mia')),
  'the account and its memberships are gone');
select tests.assert_true(
  not exists (select 1 from public.notifications n
              where n.user_id = (select id from ids where name = 'zed') and n.kind like 'chore.%'),
  'the final deletion sends other members no chore notices');
set constraints all immediate;
set constraints all deferred;
select tests.assert_true(
  (select t.completed_at is not null and t.completed_by is null from private.tasks t
   where t.id = (select id from ids where name = 'elm_done')),
  'completed Home history is kept without the person (shown as Former member)');
select tests.assert_true(
  exists (select 1 from private.tasks t where t.id = (select id from ids where name = 'elm_open')),
  'Home-owned tasks stay in the Home');

-- An Owner whose only Home is closed may delete the account; the closed Home goes with it.
select tests.act_as_owner();
select tests.ensure_session((select id from ids where name = 'zed'));
select tests.del_grant((select id from ids where name = 'zed'), 'close_home');
select tests.act_as_user((select id from ids where name = 'zed'));
select public.close_home((select id from ids where name = 'elm'), 'Elm');
select tests.act_as_owner();
select tests.del_grant((select id from ids where name = 'zed'), 'delete_account');
select tests.act_as_user((select id from ids where name = 'zed'));
select public.request_account_deletion();
select tests.act_as_owner();
update private.account_deletions set requested_at = now() - interval '31 days',
  purge_after = now() - interval '1 day';
set local role service_role;
select tests.assert_true(
  (public.purge_due_deletions(10) ->> 'accounts')::integer = 1,
  'an Owner of only a closed Home is purged');
reset role;
select tests.assert_true(
  not exists (select 1 from public.homes where id = (select id from ids where name = 'elm')),
  'the closed Home they owned is purged with the account');
