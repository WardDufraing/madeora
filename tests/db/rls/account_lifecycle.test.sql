-- S38 (part 2): temporary deactivation and reactivation, inactivity reminders and the security
-- review on return (supabase/migrations/20261125090000_account_lifecycle.sql).

create function tests.al_account(p_email text) returns uuid
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

create function tests.al_grant(p_user uuid) returns void
  language sql
  as $$
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, 'deactivate_account', tests.session_id(p_user), now() + interval '1 minute')
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at
  $$;

-- The request check as PostgREST runs it for `p_path`; true when it lets the request through.
create function tests.al_request_ok(p_path text) returns boolean
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

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select on ids to authenticated, service_role;

insert into ids values
  ('dana', tests.al_account('dana-lifecycle@madeora.test')),
  ('eli', tests.al_account('eli-lifecycle@madeora.test')),
  ('fay', tests.al_account('fay-lifecycle@madeora.test'));

-- Dana owns Oak; Eli is an Administrator there and owns nothing.
insert into ids values ('oak', gen_random_uuid());
insert into public.homes (id, name, timezone, creation_request_id)
  values ((select id from ids where name = 'oak'), 'Oak', 'Europe/Brussels', gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'oak'), (select id from ids where name = 'dana'), 'owner'),
  ((select id from ids where name = 'oak'), (select id from ids where name = 'eli'), 'administrator');
insert into ids select 'eli_membership', m.id from public.home_memberships m
  where m.user_id = (select id from ids where name = 'eli');

-- Deactivation ----------------------------------------------------------------------------------

select tests.ensure_session((select id from ids where name = 'dana'));
select tests.al_grant((select id from ids where name = 'dana'));
select tests.act_as_user((select id from ids where name = 'dana'));
select tests.assert_true(
  (select count(*) = 1 and bool_and(b.home_name = 'Oak') from public.my_deactivation_blockers() b),
  'a sole Owner sees the Home that blocks deactivation');
select tests.assert_denied($q$select public.deactivate_my_account()$q$,
  'a sole Owner cannot deactivate', 'P0001');
select tests.act_as_owner();
select tests.assert_true(not private.is_deactivated((select id from ids where name = 'dana')),
  'the refused deactivation changed nothing');

select tests.act_as_user((select id from ids where name = 'eli'));
select tests.assert_true(not exists (select 1 from public.my_deactivation_blockers()),
  'an Administrator has no blocker');
select tests.assert_denied($q$select public.deactivate_my_account()$q$,
  'deactivation needs a fresh re-authentication');
select tests.act_as_owner();
select tests.ensure_session((select id from ids where name = 'eli'));
select tests.al_grant((select id from ids where name = 'eli'));
-- Eli has another session elsewhere, and a connected Google Calendar.
insert into ids values ('eli_phone', gen_random_uuid());
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values ((select id from ids where name = 'eli_phone'), (select id from ids where name = 'eli'), now(), now(), 'aal1');
insert into private.google_calendar_connections (user_id, account, refresh_token, scopes)
  values ((select id from ids where name = 'eli'), 'eli@example.com',
          'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA', array['calendar']);

-- Dana has offered Eli ownership of Oak; the offer is still waiting.
select tests.act_as_user((select id from ids where name = 'dana'));
select tests.assert_true(
  (select t.outcome = 'started' from public.start_ownership_transfer(
     (select id from ids where name = 'oak'), (select id from ids where name = 'eli_membership'),
     gen_random_uuid()) t),
  'an ownership offer to Eli is pending');
select tests.act_as_owner();

select tests.act_as_user((select id from ids where name = 'eli'));
select public.deactivate_my_account();
select tests.act_as_owner();

select tests.assert_true(
  not exists (select 1 from private.home_ownership_transfers t
              where t.home_id = (select id from ids where name = 'oak') and t.status = 'pending')
  and exists (select 1 from private.home_ownership_transfers t
              where t.home_id = (select id from ids where name = 'oak') and t.status = 'invalid'),
  'deactivation ends a pending ownership offer to the account');

select tests.assert_true(private.is_deactivated((select id from ids where name = 'eli')),
  'the account is deactivated');
select tests.assert_true(
  not exists (select 1 from auth.sessions s where s.user_id = (select id from ids where name = 'eli')),
  'every session of the account ended, this one too');
select tests.assert_true(
  (select c.status = 'authorization_expired' from private.google_calendar_connections c
   where c.user_id = (select id from ids where name = 'eli')),
  'Google Calendar is paused until it is reconnected');
select tests.assert_true(
  exists (select 1 from private.account_activity_events a
          where a.user_id = (select id from ids where name = 'eli') and a.kind = 'google_calendar.paused'),
  'the pause is in the activity history as the person''s own action');
select tests.assert_true(
  exists (select 1 from private.account_activity_events a
          where a.user_id = (select id from ids where name = 'eli') and a.kind = 'account_deactivated'),
  'deactivation is a security entry');
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'eli') and n.kind = 'account.deactivated'
     and n.email_status in ('queued', 'skipped', 'not_configured')),
  'the account holder gets a security notice');
select tests.assert_true(
  (select m.role = 'administrator' from public.home_memberships m
   where m.user_id = (select id from ids where name = 'eli')),
  'memberships and roles are kept');

-- Notifications: only security notices reach a deactivated account.
select tests.assert_true(
  private.notify_user((select id from ids where name = 'eli'), (select id from ids where name = 'oak'),
    'invitations', 'invitation.accepted', '{}'::jsonb, 'lifecycle-test-1', false) is null,
  'a deactivated account gets no ordinary notifications');
select tests.assert_true(
  not private.effective_notification_channel((select id from ids where name = 'eli'),
    (select id from ids where name = 'oak'), 'storage', 'in_app'),
  'not even Home storage notices');
select tests.assert_true(
  not private.effective_notification_channel((select id from ids where name = 'eli'), null, 'invitations', 'in_app')
  and private.effective_notification_channel((select id from ids where name = 'eli'), null, 'security', 'email'),
  'security notices still go out');

-- Home members see the account as inactive, without a reason.
select tests.act_as_user((select id from ids where name = 'dana'));
select tests.assert_true(
  (select d.is_inactive from public.home_directory((select id from ids where name = 'oak')) d
   where d.role = 'administrator'),
  'Home members see a deactivated member as inactive');
select tests.assert_true(
  (select not d.is_inactive from public.home_directory((select id from ids where name = 'oak')) d
   where d.is_self),
  'an active member is not marked');
select tests.assert_true(
  (select t.outcome = 'invalid_target' from public.start_ownership_transfer(
     (select id from ids where name = 'oak'),
     (select id from ids where name = 'eli_membership'),
     gen_random_uuid()) t),
  'ownership cannot be offered to a deactivated member');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.home_ownership_transfers t
              where t.home_id = (select id from ids where name = 'oak') and t.status = 'pending'),
  'the refused offer left no pending transfer');

-- Signing in again: only the reactivation calls are allowed.
select tests.act_as_user((select id from ids where name = 'eli'));
select tests.assert_true(not tests.al_request_ok('/rpc/home_directory'),
  'a deactivated account''s session is refused by the request check');
select tests.assert_true(not tests.al_request_ok('/homes'), 'table reads are refused too');
select tests.assert_true(tests.al_request_ok('/rpc/my_account_state'), 'it may read its state');
select tests.assert_true(tests.al_request_ok('/rpc/reactivate_my_account'), 'and reactivate');
select tests.assert_true(
  (select s.deactivated_at is not null from public.my_account_state() s),
  'the state says it is deactivated');

-- Reactivation.
select tests.assert_true(public.reactivate_my_account() is not null, 'the account holder reactivates');
select tests.assert_true(not tests.al_request_ok('/rpc/home_directory'),
  'the session that reactivated has ended: the next sign-in is a fresh session');
select tests.act_as_owner();
select tests.ensure_session((select id from ids where name = 'eli'));
select tests.act_as_user((select id from ids where name = 'eli'));
select tests.assert_true(tests.al_request_ok('/rpc/home_directory'), 'a fresh session works');
select tests.act_as_owner();
select tests.assert_true(not private.is_deactivated((select id from ids where name = 'eli')),
  'the account is active again');
select tests.assert_true(
  (select c.status = 'authorization_expired' from private.google_calendar_connections c
   where c.user_id = (select id from ids where name = 'eli')),
  'Google Calendar stays paused until the person reconnects it');
select tests.assert_true(
  exists (select 1 from private.account_activity_events a
          where a.user_id = (select id from ids where name = 'eli') and a.kind = 'account_reactivated')
  and exists (select 1 from public.notifications n
              where n.user_id = (select id from ids where name = 'eli') and n.kind = 'account.reactivated'),
  'reactivation is recorded and notified');

select tests.act_as_user((select id from ids where name = 'dana'));
select tests.assert_true(
  (select t.outcome = 'started' from public.start_ownership_transfer(
     (select id from ids where name = 'oak'),
     (select id from ids where name = 'eli_membership'),
     gen_random_uuid()) t),
  'once reactivated, the member can be offered ownership again');
select tests.act_as_owner();

select tests.act_as_user((select id from ids where name = 'fay'));
select tests.assert_denied($q$select public.reactivate_my_account()$q$,
  'an active account has nothing to reactivate', 'P0002');
select tests.act_as_owner();

-- Two-factor: a trusted browser does not get a deactivated account past the second step. --------

create function tests.al_trust(p_user uuid) returns void
  language sql
  as $$
    insert into private.trusted_devices (user_id, token_hash, kind, browser, platform, expires_at)
      values (p_user, extensions.digest(gen_random_uuid()::text, 'sha256'), 'computer', 'firefox',
              'linux', now() + interval '30 days');
    insert into private.trusted_sessions (session_id, device_id)
      select tests.session_id(p_user), d.id from private.trusted_devices d
      where d.user_id = p_user and d.revoked_at is null
      order by d.created_at desc limit 1
      on conflict (session_id) do update set device_id = excluded.device_id;
  $$;

insert into ids values ('gus', tests.al_account('gus-lifecycle@madeora.test'));
select tests.ensure_session((select id from ids where name = 'gus'));
insert into private.account_change_grants (user_id, action, session_id, expires_at)
  values ((select id from ids where name = 'gus'), 'two_factor_enroll',
          tests.session_id((select id from ids where name = 'gus')), now() + interval '1 minute');
insert into ids values ('gus_factor', gen_random_uuid());
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values ((select id from ids where name = 'gus_factor'), (select id from ids where name = 'gus'),
          null, 'totp', 'unverified', now(), now(), 'SYNTHETICSECRET');
update auth.mfa_factors set status = 'verified' where id = (select id from ids where name = 'gus_factor');
select tests.al_trust((select id from ids where name = 'gus'));
select tests.al_grant((select id from ids where name = 'gus'));

select tests.act_as_user((select id from ids where name = 'gus'));
select tests.assert_true(tests.al_request_ok('/rpc/home_directory'),
  'while active, the trusted browser skips the code');
select public.deactivate_my_account();
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.trusted_devices d
              where d.user_id = (select id from ids where name = 'gus') and d.revoked_at is null),
  'deactivation stops trusting every browser');

-- Even a browser that is still trusted (defence in depth) needs the code to reactivate.
select tests.ensure_session((select id from ids where name = 'gus'));
select tests.al_trust((select id from ids where name = 'gus'));
select tests.act_as_user((select id from ids where name = 'gus'));
select tests.assert_true(not tests.al_request_ok('/rpc/reactivate_my_account'),
  'a trusted browser without the second step cannot reactivate');
select set_config('request.jwt.claims',
  (current_setting('request.jwt.claims')::jsonb || '{"aal": "aal2"}')::text, true);
select tests.assert_true(tests.al_request_ok('/rpc/reactivate_my_account'),
  'after the second step it may reactivate');
select tests.act_as_owner();

-- Ordinary callers cannot touch another account's state.
select tests.act_as_user((select id from ids where name = 'fay'));
select tests.assert_denied($q$select * from private.account_deactivations$q$,
  'the deactivation table is private');
select tests.act_as_owner();

-- Inactivity ------------------------------------------------------------------------------------

insert into private.account_inactivity (user_id, last_active_at)
  values ((select id from ids where name = 'fay'), now() - interval '13 months')
  on conflict (user_id) do update set last_active_at = excluded.last_active_at,
    reminders_sent = 0, last_reminder_at = null, review_due = false;
update private.account_inactivity set last_active_at = now()
  where user_id in ((select id from ids where name = 'dana'), (select id from ids where name = 'eli'));

select tests.act_as_service_role();
select tests.assert_true(public.send_inactivity_reminders(100) >= 1, 'an inactive account is reminded');
select public.send_inactivity_reminders(100);
select tests.act_as_owner();
select tests.assert_true(
  (select i.reminders_sent = 1 from private.account_inactivity i
   where i.user_id = (select id from ids where name = 'fay')),
  'not twice within the reminder interval');
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'fay') and n.kind = 'account.inactivity_reminder'
     and n.params = '{}'::jsonb and n.home_id is null),
  'the reminder names no Home, person or date');

-- Bounded: after the interval it repeats, at most three in all.
update private.account_inactivity set last_reminder_at = now() - interval '4 months'
  where user_id = (select id from ids where name = 'fay');
select tests.act_as_service_role();
select public.send_inactivity_reminders(100);
select tests.act_as_owner();
update private.account_inactivity set last_reminder_at = now() - interval '4 months'
  where user_id = (select id from ids where name = 'fay');
select tests.act_as_service_role();
select public.send_inactivity_reminders(100);
select tests.act_as_owner();
update private.account_inactivity set last_reminder_at = now() - interval '4 months'
  where user_id = (select id from ids where name = 'fay');
select tests.act_as_service_role();
select public.send_inactivity_reminders(100);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 3 from public.notifications n
   where n.user_id = (select id from ids where name = 'fay') and n.kind = 'account.inactivity_reminder'),
  'at most three reminders in all');
select tests.assert_true(
  (select m.role is null from (select 1) one
   left join public.home_memberships m on m.user_id = (select id from ids where name = 'fay'))
  and not private.is_deactivated((select id from ids where name = 'fay')),
  'inactivity changes nothing about the account');

-- A deactivated account is not reminded.
insert into private.account_deactivations (user_id) values ((select id from ids where name = 'dana'));
update private.account_inactivity set last_active_at = now() - interval '13 months'
  where user_id = (select id from ids where name = 'dana');
select tests.act_as_service_role();
select public.send_inactivity_reminders(100);
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from public.notifications n
              where n.user_id = (select id from ids where name = 'dana') and n.kind = 'account.inactivity_reminder'),
  'a deactivated account gets no inactivity reminder');
delete from private.account_deactivations where user_id = (select id from ids where name = 'dana');

-- Coming back: the visit resets the count and asks for a security review, once.
select tests.act_as_user((select id from ids where name = 'fay'));
select tests.assert_true(public.touch_my_activity(), 'returning after the threshold asks for a review');
select tests.assert_true((select s.review_due from public.my_account_state() s), 'the review is due');
select tests.assert_true(public.touch_my_activity(), 'still due on the next page');
select public.complete_security_review();
select tests.assert_true(not public.touch_my_activity(), 'not asked again once reviewed');
select tests.act_as_owner();
select tests.assert_true(
  (select i.reminders_sent = 0 and i.last_active_at > now() - interval '1 minute'
   from private.account_inactivity i where i.user_id = (select id from ids where name = 'fay')),
  'the visit resets the reminders');
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'fay') and a.kind = 'security_review_completed'),
  'the completed review is recorded');

-- A recent visitor is not asked.
select tests.act_as_user((select id from ids where name = 'dana'));
select tests.assert_true(not public.touch_my_activity(), 'an active account has no review');
select tests.act_as_owner();

-- Only the job sends reminders.
select tests.act_as_user((select id from ids where name = 'fay'));
select tests.assert_denied($q$select public.send_inactivity_reminders(10)$q$,
  'ordinary callers cannot send reminders');
select tests.act_as_owner();
