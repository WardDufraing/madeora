-- S38: account activity history, sign-in alerts and the security report
-- (supabase/migrations/20261124090000_activity_history.sql).
--
-- Inserts into auth.sessions below are what Supabase Auth itself runs at sign-in. Fixtures run as
-- the database owner.

-- Fixtures ---------------------------------------------------------------------------------------

create function tests.ah_account(p_email text) returns uuid
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

-- A sign-in from p_user_agent, `p_age` ago (Supabase Auth inserts the session).
create function tests.ah_sign_in(p_user uuid, p_user_agent text, p_age interval default interval '5 minutes')
returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent)
      values (v_id, p_user, now() - p_age, now() - p_age, 'aal1', p_user_agent);
    return v_id;
  end
  $$;

create function tests.ah_grant(p_user uuid, p_action text) returns void
  language sql
  as $$
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, p_action, tests.session_id(p_user), now() + interval '1 minute')
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant select on ids to authenticated, service_role;

insert into ids values
  ('ann', tests.ah_account('ann-activity@madeora.test')),
  ('ben', tests.ah_account('ben-activity@madeora.test'));

select tests.ensure_session((select id from ids where name = 'ann'));
select tests.ensure_session((select id from ids where name = 'ben'));

-- Device labels ----------------------------------------------------------------------------------

select tests.assert_true(
  (select (d.device_kind, d.browser, d.platform) = ('phone', 'safari', 'ios')
   from private.device_labels(
     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1') d),
  'an iPhone Safari user agent is a phone, Safari, iOS');
select tests.assert_true(
  (select (d.device_kind, d.browser, d.platform) = ('computer', 'chrome', 'windows')
   from private.device_labels(
     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36') d),
  'a Windows Chrome user agent is a computer, Chrome, Windows');
select tests.assert_true(
  (select (d.device_kind, d.browser, d.platform) = ('computer', 'edge', 'windows')
   from private.device_labels(
     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0') d),
  'Edge is recognised before Chrome');
select tests.assert_true(
  (select (d.device_kind, d.browser, d.platform) = ('unknown', 'other', 'other')
   from private.device_labels(null) d),
  'no user agent: unknown device');

-- Sign-ins and the sweep ---------------------------------------------------------------------------

-- Clear the sign-ins the fixtures made, so the sweep below starts from a known state.
update private.account_security_events set classified_at = now() where kind = 'signed_in';

insert into ids values ('ann_phone', tests.ah_sign_in((select id from ids where name = 'ann'),
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'));

select tests.assert_true(
  (select count(*) = 1 from private.account_security_events e
   where e.session_id = (select id from ids where name = 'ann_phone') and e.kind = 'signed_in'
     and e.device_kind = 'phone' and e.browser = 'safari' and e.platform = 'ios'
     and e.classified_at is null),
  'a new session records a sign-in with device labels, waiting for classification');
select tests.assert_true(
  not exists (select 1 from private.account_activity_events a where a.session_id = (select id from ids where name = 'ann_phone')),
  'an unclassified sign-in is not in the history yet');

-- A sign-in that has not settled is left for the next sweep.
insert into ids values ('ann_fresh', tests.ah_sign_in((select id from ids where name = 'ann'),
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  interval '0 seconds'));

select tests.act_as_service_role();
select tests.assert_true(public.process_sign_in_events(100) = 1, 'the sweep classifies only settled sign-ins');
select tests.act_as_owner();

select tests.assert_true(
  (select a.alerted = false and a.outcome = 'completed' and a.category = 'security'
   from private.account_activity_events a where a.session_id = (select id from ids where name = 'ann_phone')),
  'the account''s first sign-in is recorded and never alerts');

-- Same device again: no alert by default. A new device: a new-device alert.
insert into ids values ('ann_phone2', tests.ah_sign_in((select id from ids where name = 'ann'),
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  interval '4 minutes'));
insert into ids values ('ann_pc', tests.ah_sign_in((select id from ids where name = 'ann'),
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  interval '3 minutes'));

select tests.act_as_service_role();
select tests.assert_true(public.process_sign_in_events(100) = 2, 'two more sign-ins classified');
select tests.act_as_owner();

select tests.assert_true(
  (select a.alerted = false from private.account_activity_events a
   where a.session_id = (select id from ids where name = 'ann_phone2')),
  'a known device does not alert by default');
select tests.assert_true(
  (select a.alerted from private.account_activity_events a
   where a.session_id = (select id from ids where name = 'ann_pc')),
  'a new device alerts by default');
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'ann') and n.kind = 'account.new_device_sign_in'
     and n.params ->> 'browser' = 'chrome' and n.params ->> 'platform' = 'windows'),
  'the new-device alert is a security notice with coarse device labels only');

-- A re-authentication sign-in (S08/S37) is not a sign-in for the person and never alerts.
insert into ids values ('ann_reauth', tests.ah_sign_in((select id from ids where name = 'ann'),
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', interval '3 minutes'));
select private.record_security_event((select id from ids where name = 'ann'), 'reauthenticated',
  (select id from ids where name = 'ann_reauth'));

select tests.act_as_service_role();
select public.process_sign_in_events(100);
select tests.act_as_owner();

select tests.assert_true(
  not exists (select 1 from private.account_activity_events a where a.session_id = (select id from ids where name = 'ann_reauth')),
  'a re-authentication sign-in is left out of the history');
select tests.assert_true(
  (select e.classified_at is not null from private.account_security_events e
   where e.session_id = (select id from ids where name = 'ann_reauth') and e.kind = 'signed_in'),
  'but it is classified, so it is not looked at again');
select tests.assert_true(
  not exists (select 1 from private.account_activity_events a where a.kind = 'reauthenticated'),
  're-authentication itself is not shown');

-- Routine preferences: every sign-in alerts once turned on; the change is a security entry.
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select p.new_device and not p.every_sign_in from public.get_security_alert_preferences() p),
  'defaults: new device on, every sign-in off');
select public.set_security_alert_preferences(true, true);
select tests.assert_true(
  (select p.every_sign_in from public.get_security_alert_preferences() p), 'the choice is saved');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'security_alerts_changed'),
  'changing alert preferences is recorded');

insert into ids values ('ann_phone3', tests.ah_sign_in((select id from ids where name = 'ann'),
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  interval '3 minutes'));
select tests.act_as_service_role();
select public.process_sign_in_events(100);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from public.notifications n
   where n.user_id = (select id from ids where name = 'ann') and n.kind = 'account.signed_in'),
  'with every sign-in on, a known device alerts too');

-- Ordinary callers cannot run the sweep.
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied($q$select public.process_sign_in_events(10)$q$, 'only the job runs the sweep');
select tests.act_as_owner();

-- Unfinished sign-ins: two-factor accounts ----------------------------------------------------------

insert into ids values ('cleo', tests.ah_account('cleo-activity@madeora.test'));
select tests.ensure_session((select id from ids where name = 'cleo'));
insert into private.account_change_grants (user_id, action, session_id, expires_at)
  values ((select id from ids where name = 'cleo'), 'two_factor_enroll',
          tests.session_id((select id from ids where name = 'cleo')), now() + interval '1 minute');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), (select id from ids where name = 'cleo'), null, 'totp', 'unverified',
          now(), now(), 'SYNTHETICSECRET');
update auth.mfa_factors set status = 'verified' where user_id = (select id from ids where name = 'cleo');
-- Opt out of every routine alert: an unfinished sign-in must alert anyway.
insert into private.security_alert_preferences (user_id, new_device, every_sign_in)
  values ((select id from ids where name = 'cleo'), false, false);
update private.account_security_events set classified_at = now() where kind = 'signed_in';

-- Finished: the session reaches aal2 (Supabase Auth updates it after the TOTP code).
insert into ids values ('cleo_done', tests.ah_sign_in((select id from ids where name = 'cleo'),
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'));
update auth.sessions set aal = 'aal2' where id = (select id from ids where name = 'cleo_done');
select tests.assert_true(
  (select e.second_step_needed and e.second_step_at is not null from private.account_security_events e
   where e.session_id = (select id from ids where name = 'cleo_done') and e.kind = 'signed_in'),
  'a two-factor sign-in records when its second step is completed');

-- Unfinished and still live, 5 minutes old: waits for its second step.
insert into ids values ('cleo_waiting', tests.ah_sign_in((select id from ids where name = 'cleo'),
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'));
-- Unfinished for 20 minutes: blocked, with a mandatory alert.
insert into ids values ('cleo_unfinished', tests.ah_sign_in((select id from ids where name = 'cleo'),
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', interval '20 minutes'));
-- Unfinished, session already gone (signed out): no need to wait.
insert into ids values ('cleo_gone', tests.ah_sign_in((select id from ids where name = 'cleo'),
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'));
delete from auth.sessions where id = (select id from ids where name = 'cleo_gone');

select tests.act_as_service_role();
select tests.assert_true(public.process_sign_in_events(100) = 3,
  'the sweep waits for a live sign-in still in its two-factor step');
select tests.act_as_owner();

select tests.assert_true(
  (select a.kind = 'signed_in' and a.outcome = 'completed' and not a.alerted
   from private.account_activity_events a where a.session_id = (select id from ids where name = 'cleo_done')),
  'a finished two-factor sign-in is an ordinary sign-in');
select tests.assert_true(
  not exists (select 1 from private.account_activity_events a
              where a.session_id = (select id from ids where name = 'cleo_waiting')),
  'a sign-in still in its two-factor step is not shown yet');
select tests.assert_true(
  (select a.kind = 'sign_in_unfinished' and a.outcome = 'blocked' and a.alerted
   from private.account_activity_events a where a.session_id = (select id from ids where name = 'cleo_unfinished')),
  'a sign-in that never finished two-factor verification is shown as blocked');
select tests.assert_true(
  (select a.kind = 'sign_in_unfinished'
   from private.account_activity_events a where a.source_event_id = (
     select e.id from private.account_security_events e
     where e.session_id = (select id from ids where name = 'cleo_gone') and e.kind = 'signed_in')),
  'an unfinished sign-in whose session ended is classified at once');
select tests.assert_true(
  (select count(*) = 2 from public.notifications n
   where n.user_id = (select id from ids where name = 'cleo') and n.kind = 'account.unfinished_sign_in'),
  'unfinished sign-ins always alert, even with every routine alert off');

-- Secure my account on an unfinished sign-in signs that session out.
insert into ids values ('cleo_unfinished_entry', (select a.id from private.account_activity_events a
  where a.session_id = (select id from ids where name = 'cleo_unfinished')));
select tests.act_as_user((select id from ids where name = 'cleo'));
select tests.assert_true(
  public.respond_to_sign_in((select id from ids where name = 'cleo_unfinished_entry'), 'reported') = 'signed_out',
  'an unfinished sign-in can be secured');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from auth.sessions s where s.id = (select id from ids where name = 'cleo_unfinished')),
  'securing it ended that half-signed-in session');

-- Linking and unlinking Google ----------------------------------------------------------------------

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values ((select id from ids where name = 'cleo')::text, (select id from ids where name = 'cleo'),
          '{}', 'email', now(), now());
insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
  values ((select id from ids where name = 'cleo'), 'link', 'google', now() + interval '1 minute');
insert into auth.flow_state (id, user_id, auth_code, provider_type, authentication_method,
                             created_at, updated_at, auth_code_issued_at, linking_target_id)
  values (gen_random_uuid(), (select id from ids where name = 'cleo'), 'synthetic-code', 'google',
          'oauth', now(), now(), now(), (select id from ids where name = 'cleo'));
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values ('google-sub-cleo', (select id from ids where name = 'cleo'), '{}', 'google', now(), now());
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'cleo') and a.kind = 'google_sign_in_linked'
     and a.category = 'security' and a.outcome = 'completed'),
  'linking Google as a sign-in method is a security entry');
insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
  values ((select id from ids where name = 'cleo'), 'unlink', 'google', now() + interval '1 minute')
  on conflict do nothing;
delete from auth.identities
  where user_id = (select id from ids where name = 'cleo') and provider = 'google';
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'cleo') and a.kind = 'google_sign_in_unlinked'),
  'unlinking Google is a security entry');

-- An account created with Google (its first identity) is not a link.
with u as (
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
                          raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), 'authenticated', 'authenticated', 'gina-activity@madeora.test', now(),
          '{}', '{}', now(), now())
  returning id
)
insert into auth.identities (provider_id, user_id, identity_data, provider)
  select 'google-gina-activity', id, '{}', 'google' from u;
select tests.assert_true(
  not exists (select 1 from private.account_activity_events a
              join auth.users u on u.id = a.user_id
              where u.email = 'gina-activity@madeora.test' and a.kind = 'google_sign_in_linked'),
  'signing up with Google is not recorded as a link');

-- S37 events are mirrored -----------------------------------------------------------------------------

select private.record_security_event((select id from ids where name = 'ann'), 'password_changed', null);
select private.record_security_event((select id from ids where name = 'ann'), 'recovery_code_failed', null);
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'password_changed'
     and a.category = 'security' and a.outcome = 'completed'),
  'a password change appears in Security');
select tests.assert_true(
  (select a.outcome = 'blocked' from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'recovery_code_failed'),
  'a refused recovery code is shown as blocked');

-- Home memberships (from the Home audit trail) ---------------------------------------------------------

insert into ids values ('home', gen_random_uuid());
insert into public.homes (id, name, timezone, creation_request_id)
  values ((select id from ids where name = 'home'), 'Maple House', 'Europe/Brussels', gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home'), (select id from ids where name = 'ben'), 'owner'),
  ((select id from ids where name = 'home'), (select id from ids where name = 'ann'), 'member');

-- Ben (owner) promotes Ann, then removes her.
select tests.act_as_user((select id from ids where name = 'ben'));
select set_config('role', 'none', true);
update public.home_memberships set role = 'administrator'
  where home_id = (select id from ids where name = 'home') and user_id = (select id from ids where name = 'ann');
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home') and user_id = (select id from ids where name = 'ann');
select tests.act_as_owner();

select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'home_membership.joined'
     and a.home_name = 'Maple House' and a.category = 'home_memberships'),
  'joining a Home is recorded with the Home''s name');
select tests.assert_true(
  (select a.actor = 'home_manager' and a.details = '{"from": "member", "to": "administrator"}'::jsonb
   from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'home_membership.role_changed'),
  'a role change shows the roles and "a Home manager", never who');
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'home_membership.removed'
     and a.actor = 'home_manager'),
  'being removed is recorded');
select tests.assert_true(
  not exists (select 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ben') and a.kind like 'home_membership.%'
     and a.created_at > now() - interval '1 minute' and a.kind <> 'home_membership.joined'),
  'the manager''s own history does not get entries about Ann');

-- Profile ---------------------------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
insert into public.user_preferences (user_id, display_name) values ((select id from ids where name = 'ann'), 'Ann');
update public.user_preferences set display_name = 'Annie' where user_id = (select id from ids where name = 'ann');
update public.user_preferences set locale = 'nl' where user_id = (select id from ids where name = 'ann');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'profile.name_changed'
     and a.actor = 'self'),
  'setting and changing the account name are recorded; other preferences are not');

-- Integrations ----------------------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
select public.record_integration_failure('google_calendar');
select public.record_integration_failure('google_calendar');
select tests.assert_denied($q$select public.record_integration_failure('spotify')$q$, 'unknown provider', '22023');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.account_activity_events a
   where a.user_id = (select id from ids where name = 'ann') and a.kind = 'google_calendar.connect_failed'
     and a.outcome = 'failed' and a.category = 'integrations'),
  'a failed connection is recorded once a minute at most');

-- Reading -----------------------------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_categories => array['home_memberships'])$q$, 3,
  'category filter');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_outcomes => array['blocked'])$q$, 1, 'outcome filter');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_kinds => array['password_changed'])$q$, 1,
  'search by matching kinds');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_text => 'maple')$q$, 3, 'search by Home name');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_text => '%')$q$, 0, 'search wildcards are literal');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_home_id => (select id from ids where name = 'home'))$q$, 3,
  'Home filter');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_from => now() + interval '1 hour')$q$, 0, 'date range');
select tests.assert_true(
  (select bool_and(not a.is_current_member) from public.list_my_activity(p_categories => array['home_memberships']) a),
  'a Home the person left is marked as no longer theirs');
select tests.assert_row_count($q$select * from public.list_my_activity_homes()$q$, 1, 'Homes in the history');

-- Keyset paging: two pages of 2 cover the first 4 entries without overlap.
create temporary table page1 on commit drop as select * from public.list_my_activity(p_limit => 2);
select tests.assert_row_count(
  $q$select * from public.list_my_activity(
       p_before_created_at => (select created_at from page1 order by created_at, id limit 1),
       p_before_id => (select id from page1 order by created_at, id limit 1),
       p_limit => 2) p where p.id in (select id from page1)$q$, 0,
  'the next page does not repeat the first');
select tests.assert_denied(
  $q$select * from public.list_my_activity(p_before_id => gen_random_uuid())$q$, 'half a cursor', '22023');

-- Only one's own history.
select tests.act_as_owner();
create temporary table ann_entries on commit drop as
  select a.id from private.account_activity_events a where a.user_id = (select id from ids where name = 'ann');
grant select on ann_entries to authenticated;
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_denied($q$select * from private.account_activity_events$q$, 'the table is not reachable');
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_limit => 100) a where a.id in (select id from ann_entries)$q$, 0,
  'another account never sees Ann''s entries');
select tests.assert_true((select count(*) > 0 from ann_entries), 'Ann has entries to hide');
select tests.act_as_anon();
select tests.assert_denied($q$select * from public.list_my_activity()$q$, 'anon has no history');
select tests.act_as_owner();

-- Responses to sign-ins -----------------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  public.respond_to_sign_in(
    (select a.id from public.list_my_activity(p_kinds => array['signed_in']) a
     where a.device_kind = 'phone' order by a.created_at limit 1), 'confirmed') = 'confirmed',
  'This was me');
select tests.assert_true(
  public.respond_to_sign_in(
    (select a.id from public.list_my_activity(p_kinds => array['signed_in']) a
     where a.browser = 'chrome' limit 1), 'reported') = 'signed_out',
  'Secure my account signs the other live session out');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from auth.sessions s where s.id = (select id from ids where name = 'ann_pc')),
  'the reported session is gone');
select tests.assert_true(
  (select count(*) = 1 from private.account_security_events e
   where e.session_id = (select id from ids where name = 'ann_pc') and e.kind = 'session_reported'),
  'the report is a security event');

insert into ids select 'ann_phone_entry', a.id from private.account_activity_events a
  where a.session_id = (select id from ids where name = 'ann_phone');
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_denied(
  $q$select public.respond_to_sign_in((select id from ids where name = 'ann_phone_entry'), 'confirmed')$q$,
  'nobody answers for another account', 'P0002');
select tests.act_as_owner();

-- Security report -------------------------------------------------------------------------------------------

select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied(
  $q$select public.request_security_report(current_date - 7, current_date, 'Europe/Brussels')$q$,
  'a report needs recent re-authentication');
select tests.act_as_owner();
select tests.ah_grant((select id from ids where name = 'ann'), 'security_report');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied(
  $q$select public.request_security_report(current_date, current_date - 1, 'Europe/Brussels')$q$,
  'an inverted range', '22023');
select tests.assert_denied(
  $q$select public.request_security_report(current_date - 400, current_date, 'Europe/Brussels')$q$,
  'beyond retention', '22023');
select tests.assert_denied(
  $q$select public.request_security_report(current_date - 1, current_date, 'Mars/Olympus')$q$,
  'an unknown timezone', '22023');

create temporary table report on commit drop as
  select public.request_security_report(current_date - 7, (now() at time zone 'Europe/Brussels')::date,
                                        'Europe/Brussels') as id;
grant select on report to authenticated;

select tests.assert_true(
  (select r.status = 'ready' from public.list_my_security_reports() r where r.id = (select id from report)),
  'the report is ready');
select tests.assert_true(
  (select count(*) >= 3 from public.security_report_rows((select id from report))),
  'the download has the security events');
select tests.assert_true(
  not exists (select 1 from public.security_report_rows((select id from report)) r
              where r.kind in ('security_report_requested', 'security_report_downloaded')),
  'the snapshot never contains its own request or downloads');
select tests.assert_true(
  not exists (select 1 from public.security_report_rows((select id from report)) r
              where r.kind like 'home_membership.%' or r.kind like 'profile.%'),
  'only security events');

select tests.act_as_user((select id from ids where name = 'ben'));
select tests.act_as_owner();
select tests.ah_grant((select id from ids where name = 'ben'), 'security_report');
select tests.act_as_user((select id from ids where name = 'ben'));
select tests.assert_denied(
  $q$select * from public.security_report_rows((select id from report))$q$,
  'another account cannot download it', 'P0002');
select tests.assert_true(
  not public.discard_security_report((select id from report)), 'or discard it');
select tests.act_as_owner();

-- Without a fresh permission the download is refused.
delete from private.account_change_grants where user_id = (select id from ids where name = 'ann');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied(
  $q$select * from public.security_report_rows((select id from report))$q$,
  'downloading needs recent re-authentication too');
select tests.assert_true(public.discard_security_report((select id from report)), 'discard early');
select tests.act_as_owner();
select tests.ah_grant((select id from ids where name = 'ann'), 'security_report');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied(
  $q$select * from public.security_report_rows((select id from report))$q$,
  'a discarded report cannot be downloaded', 'P0002');

-- At most 3 a day.
select public.request_security_report(current_date - 1, (now() at time zone 'UTC')::date, 'UTC');
select public.request_security_report(current_date - 1, (now() at time zone 'UTC')::date, 'UTC');
select tests.assert_denied(
  $q$select public.request_security_report(current_date - 1, (now() at time zone 'UTC')::date, 'UTC')$q$,
  'a fourth report within a day', '54000');
select tests.act_as_owner();

-- Expired reports cannot be downloaded.
update private.security_reports set expires_at = now() - interval '1 second'
  where user_id = (select id from ids where name = 'ann') and discarded_at is null;
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_true(
  (select bool_and(r.status in ('expired', 'discarded')) from public.list_my_security_reports() r),
  'expired reports say so');
select tests.act_as_owner();

-- Retention ---------------------------------------------------------------------------------------------------

update private.account_activity_events set created_at = now() - interval '13 months'
  where user_id = (select id from ids where name = 'ann') and kind = 'password_changed';
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_row_count(
  $q$select * from public.list_my_activity(p_kinds => array['password_changed'])$q$, 0,
  'entries beyond retention are not listed');
select tests.act_as_owner();
select tests.act_as_service_role();
select tests.assert_true(public.purge_account_activity() >= 1, 'the purge removes them');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.account_activity_events a
              where a.user_id = (select id from ids where name = 'ann') and a.kind = 'password_changed'),
  'gone after the purge');
select tests.act_as_user((select id from ids where name = 'ann'));
select tests.assert_denied($q$select public.purge_account_activity()$q$, 'only the job purges');
select tests.act_as_owner();
