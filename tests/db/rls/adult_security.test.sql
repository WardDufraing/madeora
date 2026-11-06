-- S37: adult account security (supabase/migrations/20261123090000_adult_security.sql).
--
-- Updates, inserts and deletes on auth.users, auth.mfa_factors, auth.mfa_challenges and
-- auth.sessions below are what Supabase Auth itself runs (as its own role) for a password or email
-- change, two-factor enrolment, a TOTP challenge and a sign-out. The guards are triggers, so they
-- apply whoever writes. Fixtures run as the database owner.

-- Fixtures ---------------------------------------------------------------------------------------

create function tests.sec_account(p_email text, p_confirmed boolean default true) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (v_id, 'authenticated', 'authenticated', p_email,
              -- A standard bcrypt hash at Supabase Auth's default cost (10).
              '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000',
              case when p_confirmed then now() end, '{}', '{}', now(), now());
    insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
      values (v_id::text, v_id, jsonb_build_object('sub', v_id, 'email', p_email), 'email', now(), now());
    return v_id;
  end
  $$;

-- A session whose sign-in methods (amr) happened `p_age` ago, with assurance level p_aal.
create function tests.sec_session(
  p_user uuid, p_methods text[], p_age interval, p_aal text default 'aal1'
) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
    v_method text;
  begin
    insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent)
      values (v_id, p_user, now() - p_age, now() - p_age, p_aal::auth.aal_level,
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15');
    foreach v_method in array p_methods loop
      insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
        values (v_id, now() - p_age, now() - p_age, v_method, gen_random_uuid());
    end loop;
    return v_id;
  end
  $$;

-- A verified (or unverified) TOTP authenticator, added the way Supabase Auth does after the
-- account holder obtained a permission.
create function tests.sec_factor(p_user uuid, p_verified boolean default true) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    perform tests.ensure_session(p_user);
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, 'two_factor_enroll', tests.session_id(p_user), now() + interval '1 minute')
      on conflict (user_id, action) do update set expires_at = excluded.expires_at;
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
      values (v_id, p_user, null, 'totp', 'unverified', now(), now(), 'SYNTHETICSECRET');
    if p_verified then
      update auth.mfa_factors set status = 'verified' where id = v_id;
    end if;
    return v_id;
  end
  $$;

create function tests.act_as_sec(p_user uuid, p_session uuid, p_aal text default 'aal1') returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated',
                         'session_id', p_session, 'aal', p_aal)::text,
      true
    );
  end
  $$;

create function tests.sec_grant(p_user uuid, p_action text, p_session uuid default null)
returns void
  language plpgsql
  as $$
  declare
    -- By default, any session the account already has (the checks here do not depend on which).
    v_session uuid := coalesce(p_session,
      (select s.id from auth.sessions s where s.user_id = p_user order by s.created_at, s.id limit 1));
  begin
    if v_session is null then
      perform tests.ensure_session(p_user);
      v_session := tests.session_id(p_user);
    end if;
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (p_user, p_action, v_session, now() + interval '1 minute')
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at;
  end
  $$;

-- Another live session of the signed-in account: the browser's main session, which a
-- reauthentication names when it asks for a permission.
create function tests.sec_main() returns uuid
  language sql security definer set search_path = '' as $$
    select s.id from auth.sessions s
    where s.user_id = auth.uid() and s.id is distinct from (auth.jwt() ->> 'session_id')::uuid
    order by s.created_at, s.id limit 1
  $$;

-- What Supabase Auth does in one transaction when session p_from changes the password: write the
-- hash, sign out every other session, then commit (here: run the deferred checks at once).
create function tests.sec_change_password(p_user uuid, p_hash text, p_from uuid) returns void
  language plpgsql
  as $$
  begin
    update auth.users set encrypted_password = p_hash where id = p_user;
    delete from auth.sessions where user_id = p_user and id <> p_from;
    set constraints all immediate;
    set constraints all deferred;
  end
  $$;

create function tests.sec_grant_exists(p_user uuid, p_action text) returns boolean
  language sql security definer set search_path = '' as $$
    select exists (select 1 from private.account_change_grants where user_id = p_user and action = p_action)
  $$;

create function tests.sec_events(p_user uuid, p_kind text) returns bigint
  language sql security definer set search_path = '' as $$
    select count(*) from private.account_security_events where user_id = p_user and kind = p_kind
  $$;

create function tests.sec_session_exists(p_session uuid) returns boolean
  language sql security definer set search_path = '' as $$
    select exists (select 1 from auth.sessions where id = p_session)
  $$;

create function tests.sec_factor_count(p_user uuid) returns bigint
  language sql security definer set search_path = '' as $$
    select count(*) from auth.mfa_factors where user_id = p_user
  $$;

create function tests.sec_code_count(p_user uuid) returns bigint
  language sql security definer set search_path = '' as $$
    select count(*) from private.two_factor_recovery_codes where user_id = p_user and used_at is null
  $$;

-- The check the Realtime signal tables' restrictive policies run, as the current actor.
create function tests.sec_request_ok() returns boolean
  language sql security definer set search_path = '' as $$ select private.request_session_ok() $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null);
grant all on ids to anon, authenticated, service_role;
create temporary table codes (code text not null);
grant all on codes to anon, authenticated;

insert into ids values
  ('ann', tests.sec_account('ann@madeora.test')),
  ('tom', tests.sec_account('tom@madeora.test')),
  ('eve', tests.sec_account('eve@madeora.test')),
  ('new', tests.sec_account('new@madeora.test', false));

insert into ids values
  ('tom_factor', tests.sec_factor((select id from ids where name = 'tom')));
-- Tom's automatic first recovery-code permission is not part of these checks.
delete from private.account_change_grants where user_id = (select id from ids where name = 'tom');

insert into ids values
  ('ann_fresh', tests.sec_session((select id from ids where name = 'ann'), array['password'], interval '1 minute')),
  ('ann_stale', tests.sec_session((select id from ids where name = 'ann'), array['password'], interval '6 minutes')),
  ('ann_oauth', tests.sec_session((select id from ids where name = 'ann'), array['oauth'], interval '1 minute')),
  ('ann_phone', tests.sec_session((select id from ids where name = 'ann'), array['password'], interval '2 days')),
  ('tom_aal1', tests.sec_session((select id from ids where name = 'tom'), array['password'], interval '1 minute')),
  ('tom_aal2', tests.sec_session((select id from ids where name = 'tom'), array['password', 'totp'], interval '1 minute', 'aal2')),
  ('tom_old_totp', tests.sec_session((select id from ids where name = 'tom'), array['password'], interval '1 minute', 'aal2')),
  ('eve_fresh', tests.sec_session((select id from ids where name = 'eve'), array['password'], interval '1 minute'));
-- tom_old_totp: a fresh password, but the TOTP step was long ago.
insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
  values ((select id from ids where name = 'tom_old_totp'), now() - interval '1 hour',
          now() - interval '1 hour', 'totp', gen_random_uuid());

-- 1. Reauthentication permissions -----------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $q$select public.authorize_account_change('password', tests.sec_main())$q$,
  'Visitors who are not signed in get no permission'
);

select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_stale'));
select tests.assert_denied(
  $q$select public.authorize_account_change('password', tests.sec_main())$q$,
  'A password sign-in older than 5 minutes is not a recent reauthentication'
);

select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_oauth'));
select tests.assert_allowed(
  $q$select public.authorize_account_change('password', tests.sec_main())$q$,
  'A fresh Google sign-in is a reauthentication too (Google-only accounts)'
);
select tests.act_as_owner();
delete from private.account_change_grants where user_id = (select id from ids where name = 'ann');
delete from private.account_security_events where user_id = (select id from ids where name = 'ann');

select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'eve_fresh'));
select tests.assert_denied(
  $q$select public.authorize_account_change('email', tests.sec_main())$q$,
  'Another account''s fresh session does not reauthenticate this account'
);

select tests.act_as_sec((select id from ids where name = 'ann'), null);
select tests.assert_denied(
  $q$select public.authorize_account_change('email', tests.sec_main())$q$,
  'A token without a session id gets no permission'
);

select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_denied(
  $q$select public.authorize_account_change('email', null)$q$,
  'A permission must name the browser session it is for'
);
select tests.assert_denied(
  format($q$select public.authorize_account_change('email', %L)$q$, (select id from ids where name = 'ann_fresh')),
  'The reauthentication session itself is not the browser session'
);
select tests.assert_denied(
  format($q$select public.authorize_account_change('email', %L)$q$, (select id from ids where name = 'eve_fresh')),
  'Another account''s session cannot be named'
);
select tests.assert_denied(
  format($q$select public.authorize_account_change('email', %L)$q$, gen_random_uuid()),
  'A session that does not exist cannot be named'
);

select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_denied(
  $q$select public.authorize_account_change('delete_everything', tests.sec_main())$q$,
  'An unknown action is refused',
  '22023'
);
select tests.assert_denied(
  $q$select public.authorize_account_change('two_factor_disable', tests.sec_main())$q$,
  'Turning off two-factor sign-in that is off is refused'
);
select tests.assert_allowed(
  $q$select public.authorize_account_change('password', tests.sec_main())$q$,
  'A fresh password sign-in gets a password permission'
);
select tests.act_as_owner();
select tests.assert_true(
  tests.sec_grant_exists((select id from ids where name = 'ann'), 'password'),
  'The permission is stored for this account and action'
);
select tests.assert_true(
  tests.sec_events((select id from ids where name = 'ann'), 'reauthenticated') = 1,
  'The reauthentication is recorded'
);

-- With two-factor sign-in, the password alone is not enough.
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal1'));
select tests.assert_denied(
  format($q$select public.authorize_account_change('password', %L)$q$, (select id from ids where name = 'tom_old_totp')),
  'With two-factor sign-in on, a password-only session gets no permission'
);
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'Linking Google also needs the second factor when it is on (ADR 0010)'
);
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_old_totp'), 'aal2');
select tests.assert_denied(
  format($q$select public.authorize_account_change('password', %L)$q$, (select id from ids where name = 'tom_aal1')),
  'A TOTP verification from an hour ago is not recent'
);
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal2'), 'aal2');
select tests.assert_denied(
  $q$select public.authorize_account_change('two_factor_enroll', tests.sec_main())$q$,
  'Two-factor sign-in cannot be turned on twice'
);
select tests.assert_allowed(
  $q$select public.authorize_account_change('password', tests.sec_main())$q$,
  'A fresh password and TOTP sign-in gets a permission'
);
select tests.assert_allowed(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'and so does a Google link'
);

-- 2. Password changes --------------------------------------------------------------------------

select tests.act_as_owner();
-- At commit, only the session the permission was given to may be left signed in. These run first,
-- before any other password write of this file is waiting for its commit-time check.
insert into ids values
  ('eve_main', tests.sec_session((select id from ids where name = 'eve'), array['password'], interval '1 day')),
  ('eve_thief', tests.sec_session((select id from ids where name = 'eve'), array['password'], interval '1 day'));
select tests.sec_grant((select id from ids where name = 'eve'), 'password', (select id from ids where name = 'eve_main'));
select tests.assert_denied(
  format($q$select tests.sec_change_password(%L, '$2a$10$thiefthiefthiefthiefthiefthiefthiefthiefthiefthiefthief', %L)$q$,
         (select id from ids where name = 'eve'), (select id from ids where name = 'eve_thief')),
  'Another session of the account cannot use the permission (it would keep the wrong session)'
);
select tests.assert_true(
  tests.sec_session_exists((select id from ids where name = 'eve_main')),
  'and nothing changed: the owner''s session is still there'
);
select tests.sec_grant((select id from ids where name = 'eve'), 'password', (select id from ids where name = 'eve_main'));
select tests.assert_allowed(
  format($q$select tests.sec_change_password(%L, '$2a$10$ownerownerownerownerownerownerownerownerownerownerowner', %L)$q$,
         (select id from ids where name = 'eve'), (select id from ids where name = 'eve_main')),
  'The session the permission was given to changes the password; the others are signed out'
);
-- A reset leaves only the reset session; a reset that another session would survive is refused.
insert into ids values
  ('eve_link', tests.sec_session((select id from ids where name = 'eve'), array['otp'], interval '1 minute')),
  ('eve_thief2', tests.sec_session((select id from ids where name = 'eve'), array['password'], interval '1 minute'));
select tests.assert_denied(
  format($q$select tests.sec_change_password(%L, '$2a$10$notresetnotresetnotresetnotresetnotresetnotresetnotres', %L)$q$,
         (select id from ids where name = 'eve'), (select id from ids where name = 'eve_thief2')),
  'A reset link opened elsewhere does not let a signed-in session change the password'
);
select tests.assert_allowed(
  format($q$select tests.sec_change_password(%L, '$2a$10$linklinklinklinklinklinklinklinklinklinklinklinklinkl', %L)$q$,
         (select id from ids where name = 'eve'), (select id from ids where name = 'eve_link')),
  'The reset session itself changes the password'
);
-- Eve signs in again for the checks below.
insert into ids values
  ('eve_again', tests.sec_session((select id from ids where name = 'eve'), array['password'], interval '1 minute'));
delete from auth.sessions where id = (select id from ids where name = 'eve_link');

select tests.assert_denied(
  format($q$update auth.users set encrypted_password = '$2a$10$attackerattackerattackerattackerattackerattackerattac'
            where id = %L$q$, (select id from ids where name = 'eve')),
  'A password change without reauthentication is refused'
);
select tests.sec_grant((select id from ids where name = 'eve'), 'password');
select tests.assert_allowed(
  format($q$update auth.users set encrypted_password = '$2a$10$neweveneweveneweveneweveneweveneweveneweveneweveneweve'
            where id = %L$q$, (select id from ids where name = 'eve')),
  'With the permission, the password changes'
);
select tests.assert_true(
  not tests.sec_grant_exists((select id from ids where name = 'eve'), 'password'),
  'The permission was used up'
);
select tests.assert_denied(
  format($q$update auth.users set encrypted_password = '$2a$10$againagainagainagainagainagainagainagainagainagainagain'
            where id = %L$q$, (select id from ids where name = 'eve')),
  'A second change needs a new permission'
);
-- An expired permission is not used.
insert into private.account_change_grants (user_id, action, session_id, expires_at)
  values ((select id from ids where name = 'eve'), 'password', (select id from ids where name = 'eve_fresh'),
          now() - interval '1 second');
select tests.assert_denied(
  format($q$update auth.users set encrypted_password = '$2a$10$expiredexpiredexpiredexpiredexpiredexpiredexpiredexpir'
            where id = %L$q$, (select id from ids where name = 'eve')),
  'An expired permission does not allow a password change'
);
-- A permission for another action does not count.
select tests.sec_grant((select id from ids where name = 'eve'), 'email');
select tests.assert_denied(
  format($q$update auth.users set encrypted_password = '$2a$10$wrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrong'
            where id = %L$q$, (select id from ids where name = 'eve')),
  'An email permission does not allow a password change'
);
delete from private.account_change_grants where user_id = (select id from ids where name = 'eve');

-- A password-reset link opened in the last hour ("otp" sign-in) allows the reset.
insert into ids values
  ('eve_reset', tests.sec_session((select id from ids where name = 'eve'), array['otp'], interval '5 minutes'));
select tests.assert_allowed(
  format($q$update auth.users set encrypted_password = '$2a$10$resetresetresetresetresetresetresetresetresetresetreset'
            where id = %L$q$, (select id from ids where name = 'eve')),
  'A password reset through the emailed link is allowed'
);
delete from auth.sessions where id = (select id from ids where name = 'eve_reset');

-- Supabase Auth's own flows that are not password changes.
select tests.assert_allowed(
  format($q$update auth.users set encrypted_password = '$2a$10$signupsignupsignupsignupsignupsignupsignupsignupsignupsi'
            where id = %L$q$, (select id from ids where name = 'new')),
  'An account that never confirmed its email is left to Supabase Auth''s sign-up flow'
);
select tests.sec_grant((select id from ids where name = 'tom'), 'password');
update auth.users set encrypted_password = '$2a$06$lowcostlowcostlowcostlowcostlowcostlowcostlowcostlowco'
  where id = (select id from ids where name = 'tom');
select tests.assert_allowed(
  format($q$update auth.users set encrypted_password = '$2a$10$rehashedrehashedrehashedrehashedrehashedrehashedrehash'
            where id = %L$q$, (select id from ids where name = 'tom')),
  'Supabase Auth may rewrite a non-standard hash at sign-in'
);
select tests.assert_allowed(
  format($q$update auth.users set last_sign_in_at = now() where id = %L$q$, (select id from ids where name = 'ann')),
  'Other updates (a sign-in) are untouched'
);

-- 3. Email changes -------------------------------------------------------------------------------

select tests.assert_denied(
  format($q$update auth.users set email_change = 'thief@madeora.test', email_change_token_new = 'x'
            where id = %L$q$, (select id from ids where name = 'ann')),
  'Starting an email change without reauthentication is refused'
);
select tests.sec_grant((select id from ids where name = 'ann'), 'email');
select tests.assert_allowed(
  format($q$update auth.users set email_change = 'ann.new@madeora.test', email_change_token_new = 'x'
            where id = %L$q$, (select id from ids where name = 'ann')),
  'With the permission, an email change starts'
);
select tests.assert_denied(
  format($q$update auth.users set email_change = 'other@madeora.test', email_change_token_new = 'y'
            where id = %L$q$, (select id from ids where name = 'ann')),
  'Replacing the pending address needs a new permission'
);

select tests.act_as_sec((select id from ids where name = 'eve'), (select id from ids where name = 'eve_again'));
select tests.assert_true(
  public.cancel_my_email_change() is false,
  'Cancelling without a pending change changes nothing'
);
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_true(public.cancel_my_email_change(), 'The account holder cancels the pending change');
select tests.act_as_owner();
select tests.assert_true(
  (select coalesce(email_change, '') = '' and email = 'ann@madeora.test'
     from auth.users where id = (select id from ids where name = 'ann')),
  'After cancelling, the old address is still the account email'
);

-- Completion (Supabase Auth moves the confirmed address into email) is allowed and recorded.
select tests.sec_grant((select id from ids where name = 'ann'), 'email');
update auth.users set email_change = 'ann.new@madeora.test' where id = (select id from ids where name = 'ann');
select tests.assert_allowed(
  format($q$update auth.users set email = 'ann.new@madeora.test', email_change = ''
            where id = %L$q$, (select id from ids where name = 'ann')),
  'Confirming the new address completes the change'
);
select tests.assert_true(
  tests.sec_events((select id from ids where name = 'ann'), 'email_changed') = 1,
  'The completed change is recorded'
);

-- 4. Two-factor authenticators ------------------------------------------------------------------

select tests.assert_denied(
  format($q$insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
            values (gen_random_uuid(), %L, 'totp', 'unverified', now(), now())$q$,
         (select id from ids where name = 'ann')),
  'An authenticator cannot be added without reauthentication'
);
select tests.sec_grant((select id from ids where name = 'ann'), 'two_factor_enroll');
select tests.assert_denied(
  format($q$insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
            values (gen_random_uuid(), %L, 'phone', 'unverified', now(), now())$q$,
         (select id from ids where name = 'ann')),
  'Only authenticator apps are offered'
);
insert into ids values ('ann_factor', tests.sec_factor((select id from ids where name = 'ann'), false));
select tests.assert_true(
  tests.sec_grant_exists((select id from ids where name = 'ann'), 'recovery_codes'),
  'Adding an authenticator gives the one-time permission for the first recovery codes'
);
select tests.assert_allowed(
  format($q$delete from auth.mfa_factors where id = %L$q$, (select id from ids where name = 'ann_factor')),
  'An unfinished setup can always be removed'
);

select tests.assert_denied(
  format($q$delete from auth.mfa_factors where id = %L$q$, (select id from ids where name = 'tom_factor')),
  'A verified authenticator cannot be removed without reauthentication'
);

-- Per-account attempt limit: 10 challenges per 15 minutes.
insert into auth.mfa_challenges (id, factor_id, created_at, ip_address)
  select gen_random_uuid(), (select id from ids where name = 'tom_factor'), now(), '127.0.0.1'
  from generate_series(1, 10);
select tests.assert_denied(
  format($q$insert into auth.mfa_challenges (id, factor_id, created_at, ip_address)
            values (gen_random_uuid(), %L, now(), '127.0.0.1')$q$,
         (select id from ids where name = 'tom_factor')),
  'The 11th challenge within 15 minutes is refused'
);
select tests.assert_allowed(
  format($q$update auth.mfa_challenges set verified_at = now()
            where id = (select id from auth.mfa_challenges where factor_id = %L limit 1)$q$,
         (select id from ids where name = 'tom_factor')),
  'A code is accepted'
);
select tests.assert_denied(
  format($q$update auth.mfa_challenges set verified_at = now()
            where id = (select id from auth.mfa_challenges where factor_id = %L and verified_at is null limit 1)$q$,
         (select id from ids where name = 'tom_factor')),
  'A second successful verification within 90 seconds (a replayed code) is refused'
);
update auth.mfa_challenges set created_at = now() - interval '20 minutes'
  where factor_id = (select id from ids where name = 'tom_factor');
select tests.assert_allowed(
  format($q$insert into auth.mfa_challenges (id, factor_id, created_at, ip_address)
            values (gen_random_uuid(), %L, now(), '127.0.0.1')$q$,
         (select id from ids where name = 'tom_factor')),
  'After 15 minutes new challenges are possible again'
);
-- A challenge can only succeed within 30 seconds of being created, so one challenge cannot be
-- used for unlimited guesses (Supabase Auth records no wrong code).
update auth.mfa_challenges set verified_at = verified_at - interval '5 minutes'
  where factor_id = (select id from ids where name = 'tom_factor') and verified_at is not null;
insert into auth.mfa_challenges (id, factor_id, created_at, ip_address)
  values (gen_random_uuid(), (select id from ids where name = 'tom_factor'), now() - interval '31 seconds', '127.0.0.1');
select tests.assert_denied(
  format($q$update auth.mfa_challenges set verified_at = now()
            where factor_id = %L and verified_at is null and created_at < now() - interval '30 seconds'$q$,
         (select id from ids where name = 'tom_factor')),
  'A right code on a challenge older than 30 seconds is refused'
);
select tests.assert_allowed(
  format($q$update auth.mfa_challenges set verified_at = now()
            where id = (select id from auth.mfa_challenges
                        where factor_id = %L and verified_at is null and created_at > now() - interval '1 minute'
                        order by created_at desc limit 1)$q$,
         (select id from ids where name = 'tom_factor')),
  'A fresh challenge succeeds'
);

-- 5. Recovery codes ------------------------------------------------------------------------------

select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal1'));
select tests.assert_denied(
  $q$select public.create_two_factor_recovery_codes()$q$,
  'A session that has not passed the second factor cannot create recovery codes'
);
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal2'), 'aal2');
select tests.assert_denied(
  $q$select public.create_two_factor_recovery_codes()$q$,
  'Creating recovery codes needs the permission'
);
select tests.act_as_owner();
select tests.sec_grant((select id from ids where name = 'tom'), 'recovery_codes', (select id from ids where name = 'tom_old_totp'));
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal2'), 'aal2');
select tests.assert_denied(
  $q$select public.create_two_factor_recovery_codes()$q$,
  'A permission given to another session of the account does not count'
);
select tests.act_as_owner();
select tests.sec_grant((select id from ids where name = 'tom'), 'recovery_codes', (select id from ids where name = 'tom_aal2'));
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal2'), 'aal2');
insert into codes select public.create_two_factor_recovery_codes();
select tests.assert_true(
  (select count(distinct code) = 10 and bool_and(code ~ '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$')
     from codes),
  'Ten distinct codes in the XXXX-XXXX-XXXX form are returned once'
);
select tests.assert_denied(
  $q$select public.create_two_factor_recovery_codes()$q$,
  'The permission was used up'
);
select tests.act_as_owner();
select tests.assert_true(
  not exists (
    select 1 from private.two_factor_recovery_codes c, codes
    where c.code_hash = convert_to(replace(codes.code, '-', ''), 'UTF8')
  ),
  'Only verifiers are stored, never the codes'
);

-- Regenerating replaces the set and sends a notice.
select tests.sec_grant((select id from ids where name = 'tom'), 'recovery_codes', (select id from ids where name = 'tom_aal2'));
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal2'), 'aal2');
create temporary table old_codes as select code from codes;
grant all on old_codes to authenticated;
delete from codes;
insert into codes select public.create_two_factor_recovery_codes();
select tests.act_as_owner();
select tests.assert_true(
  exists (select 1 from public.notifications
          where user_id = (select id from ids where name = 'tom')
            and kind = 'account.recovery_codes_regenerated' and category = 'security'),
  'Regenerating recovery codes sends a security notice'
);

-- Redeeming: wrong, old and right codes, from the half-signed-in session.
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal1'));
select tests.assert_true(
  public.redeem_two_factor_recovery_code((select code from old_codes limit 1)) = 'invalid',
  'A code from the replaced set no longer works'
);
select tests.assert_true(
  public.redeem_two_factor_recovery_code('ZZZZ-ZZZZ-ZZZZ') = 'invalid',
  'A wrong code is refused'
);
select tests.assert_true(
  public.redeem_two_factor_recovery_code(lower((select code from codes order by code limit 1))) = 'ok',
  'A valid code works (in any case, with or without dashes)'
);
select tests.act_as_owner();
select tests.assert_true(
  tests.sec_factor_count((select id from ids where name = 'tom')) = 0
    and tests.sec_code_count((select id from ids where name = 'tom')) = 0,
  'Redeeming removes the lost authenticator and every remaining code'
);
select tests.assert_true(
  tests.sec_session_exists((select id from ids where name = 'tom_aal1'))
    and not tests.sec_session_exists((select id from ids where name = 'tom_aal2')),
  'Only the redeeming session stays signed in'
);
select tests.assert_true(
  exists (select 1 from public.notifications
          where user_id = (select id from ids where name = 'tom') and kind = 'account.recovery_code_used'),
  'Using a recovery code sends a security notice'
);
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal1'));
select tests.assert_true(
  public.redeem_two_factor_recovery_code((select code from codes order by code limit 1)) = 'not_needed',
  'A used code cannot be replayed'
);

-- Rate limit: 5 wrong codes in 15 minutes stop even a right one.
select tests.act_as_owner();
insert into ids values
  ('eve_factor', tests.sec_factor((select id from ids where name = 'eve'))),
  ('eve_aal2', tests.sec_session((select id from ids where name = 'eve'), array['password', 'totp'], interval '1 minute', 'aal2'));
select tests.sec_grant((select id from ids where name = 'eve'), 'recovery_codes', (select id from ids where name = 'eve_aal2'));
select tests.act_as_sec((select id from ids where name = 'eve'), (select id from ids where name = 'eve_aal2'), 'aal2');
delete from codes;
insert into codes select public.create_two_factor_recovery_codes();
select tests.act_as_sec((select id from ids where name = 'eve'), (select id from ids where name = 'eve_again'));
select public.redeem_two_factor_recovery_code('WRONG' || g::text) from generate_series(1, 5) g;
select tests.assert_true(
  public.redeem_two_factor_recovery_code((select code from codes limit 1)) = 'rate_limited',
  'After 5 wrong codes in 15 minutes, redemption is blocked'
);
select tests.act_as_owner();
select tests.assert_true(
  tests.sec_factor_count((select id from ids where name = 'eve')) = 1,
  'A blocked attempt changes nothing'
);

-- Turning 2FA off with a permission removes the recovery codes too.
select tests.sec_grant((select id from ids where name = 'eve'), 'two_factor_disable');
select tests.assert_allowed(
  format($q$delete from auth.mfa_factors where id = %L$q$, (select id from ids where name = 'eve_factor')),
  'With the permission, the authenticator is removed'
);
select tests.assert_true(
  tests.sec_code_count((select id from ids where name = 'eve')) = 0
    and tests.sec_events((select id from ids where name = 'eve'), 'two_factor_disabled') = 1,
  'Its recovery codes go with it, and the change is recorded'
);

-- 6. Sessions ----------------------------------------------------------------------------------------

-- Only the sessions made above (not the standing session of the shared test helpers).
delete from auth.sessions where id = tests.session_id((select id from ids where name = 'ann'));
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_row_count(
  $q$select * from public.list_my_sessions()$q$, 4,
  'The account holder sees their own sessions only'
);
select tests.assert_true(
  (select is_current from public.list_my_sessions() limit 1)
    and (select count(*) = 1 from public.list_my_sessions() where is_current),
  'The current session comes first and is the only one marked current'
);
select tests.assert_true(
  public.revoke_my_session((select id from ids where name = 'eve_again')) is false,
  'Another account''s session cannot be signed out'
);
select tests.act_as_owner();
select tests.assert_true(
  tests.sec_session_exists((select id from ids where name = 'eve_again')),
  'and it is still signed in'
);
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_denied(
  format($q$select public.revoke_my_session(%L)$q$, (select id from ids where name = 'ann_fresh')),
  'The current session is signed out with the ordinary sign-out',
  '22023'
);
select tests.assert_true(
  public.revoke_my_session((select id from ids where name = 'ann_stale')),
  'The account holder signs out another of their sessions'
);
select tests.assert_true(
  public.revoke_my_session((select id from ids where name = 'ann_stale')) is false,
  'A session already gone reports false (expired between the list and the click)'
);
select tests.assert_true(
  public.revoke_my_session((select id from ids where name = 'ann_oauth'), true),
  'A suspicious session is reported and signed out'
);
select tests.act_as_owner();
select tests.assert_true(
  not tests.sec_session_exists((select id from ids where name = 'ann_oauth'))
    and tests.sec_events((select id from ids where name = 'ann'), 'session_reported') = 1
    and exists (select 1 from public.notifications
                where user_id = (select id from ids where name = 'ann') and kind = 'account.session_reported'),
  'Reporting signs the session out, records it and sends a notice'
);

-- 7. Request-level enforcement (PostgREST's pre-request function) ------------------------------------

select tests.act_as_anon();
select tests.assert_allowed($q$select public.check_request()$q$, 'Visitors pass (RLS decides)');
select tests.act_as_service_role();
select tests.assert_allowed($q$select public.check_request()$q$, 'The service role (jobs) passes');
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_allowed($q$select public.check_request()$q$, 'A live session passes');
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_stale'));
select tests.assert_denied(
  $q$select public.check_request()$q$, 'A signed-out session''s token is refused at once', 'PT401'
);
select tests.act_as_sec((select id from ids where name = 'ann'), null);
select tests.assert_denied(
  $q$select public.check_request()$q$, 'A token without a session is refused', 'PT401'
);
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'eve_again'));
select tests.assert_denied(
  $q$select public.check_request()$q$, 'A token naming another account''s session is refused', 'PT401'
);

select tests.act_as_owner();
insert into ids values
  ('ann_factor2', tests.sec_factor((select id from ids where name = 'ann'))),
  ('ann_browser', tests.sec_session((select id from ids where name = 'ann'), array['password'], interval '1 minute'));
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_fresh'));
select tests.assert_denied(
  $q$select public.check_request()$q$,
  'With two-factor sign-in on, a session that has not passed it is refused', 'PT401'
);
select tests.assert_true(
  not tests.sec_request_ok(),
  'and the Realtime signal tables refuse it too'
);
select set_config('request.path', '/rpc/redeem_two_factor_recovery_code', true);
select tests.assert_allowed(
  $q$select public.check_request()$q$, 'except the recovery-code call of the two-factor page'
);
-- The reauthentication session is aal1 (the code is verified on the browser's own session), so
-- asking for a permission must get through; the permission itself still needs that code.
select set_config('request.path', '/rpc/authorize_account_change', true);
select tests.assert_allowed(
  $q$select public.check_request()$q$, 'and the account-change permission call of a reauthentication'
);
select set_config('request.path', '/rpc/authorize_sign_in_method_change', true);
select tests.assert_allowed(
  $q$select public.check_request()$q$, 'and the sign-in method permission call of a reauthentication'
);
select tests.assert_denied(
  format(
    $q$select public.authorize_account_change('password', %L::uuid)$q$,
    (select id from ids where name = 'ann_browser')
  ),
  'but without a recent code on either session it grants nothing', '42501'
);
select set_config('request.path', '/rpc/list_my_sessions', true);
select tests.assert_denied(
  $q$select public.check_request()$q$, 'Nothing else is exempt', 'PT401'
);

-- 8. Sign out everywhere ---------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids values
  ('ann_aal2', tests.sec_session((select id from ids where name = 'ann'), array['password', 'totp'], interval '1 minute', 'aal2'));
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_aal2'), 'aal2');
select tests.assert_allowed($q$select public.check_request()$q$, 'An aal2 session passes');
select tests.assert_true(public.sign_out_everywhere() >= 2, 'Sign out everywhere ends every session');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 0 from auth.sessions where user_id = (select id from ids where name = 'ann'))
    and tests.sec_session_exists((select id from ids where name = 'eve_again')),
  'including this one, and nobody else''s'
);
select tests.act_as_sec((select id from ids where name = 'ann'), (select id from ids where name = 'ann_aal2'), 'aal2');
select tests.assert_denied(
  $q$select public.check_request()$q$, 'Its old token no longer works', 'PT401'
);
select tests.assert_denied(
  $q$select public.sign_out_everywhere()$q$, 'and cannot do anything more'
);

select tests.act_as_owner();
create function tests.sec_notified(p_user uuid, p_kind text) returns boolean
  language sql security definer set search_path = '' as $$
    select exists (select 1 from public.notifications n where n.user_id = p_user and n.kind = p_kind)
  $$;
grant execute on function tests.sec_notified(uuid, text) to anon, authenticated, service_role;

-- 9. Second factor on the browser's own session ---------------------------------------------------

-- The app verifies the code on the browser's session, so a password reauthentication in a separate
-- session plus a fresh TOTP claim on the main session is enough; a stale one is not.
select tests.act_as_owner();
insert into ids values
  ('rae', tests.sec_account('rae@madeora.test'));
insert into ids values
  ('rae_factor', tests.sec_factor((select id from ids where name = 'rae'))),
  ('rae_main', tests.sec_session((select id from ids where name = 'rae'), array['password', 'totp'], interval '1 minute', 'aal2')),
  ('rae_old', tests.sec_session((select id from ids where name = 'rae'), array['password'], interval '1 day', 'aal2')),
  ('rae_pw', tests.sec_session((select id from ids where name = 'rae'), array['password'], interval '1 minute'));
delete from private.account_change_grants where user_id = (select id from ids where name = 'rae');
insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
  values ((select id from ids where name = 'rae_old'), now() - interval '1 day', now() - interval '1 day', 'totp', gen_random_uuid());
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_pw'));
select tests.assert_denied(
  format($q$select public.authorize_account_change('backup_email', %L)$q$, (select id from ids where name = 'rae_old')),
  'A main session whose code was verified long ago does not count'
);
select tests.assert_allowed(
  format($q$select public.authorize_account_change('backup_email', %L)$q$, (select id from ids where name = 'rae_main')),
  'A fresh code on the main session completes the reauthentication'
);

-- 10. Trusted devices ------------------------------------------------------------------------------

select tests.act_as_owner();
create function tests.sec_trust_count(p_user uuid) returns bigint
  language sql security definer set search_path = '' as $$
    select count(*) from private.trusted_devices
    where user_id = p_user and revoked_at is null and expires_at > now()
  $$;
grant execute on function tests.sec_trust_count(uuid) to anon, authenticated, service_role;

select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_pw'));
select tests.assert_denied(
  $q$select public.trust_this_device(repeat('a', 43), 'computer', 'firefox', 'linux')$q$,
  'A session that has not passed the second factor cannot trust its device'
);
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_old'), 'aal2');
select tests.assert_denied(
  $q$select public.trust_this_device(repeat('a', 43), 'computer', 'firefox', 'linux')$q$,
  'nor one that passed it long ago'
);
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select tests.assert_denied(
  $q$select public.trust_this_device('short', 'computer', 'firefox', 'linux')$q$,
  'A short token is refused', '22023'
);
select tests.assert_true(
  (select e between now() + interval '29 days' and now() + interval '31 days'
     from (select public.trust_this_device(repeat('t', 43), 'computer', 'firefox', 'linux') as e offset 0) t),
  'Trust lasts 30 days'
);
select tests.assert_true(
  tests.sec_notified((select id from ids where name = 'rae'), 'account.device_trusted'),
  'and the account is told'
);
select tests.assert_row_count($q$select * from public.list_my_trusted_devices() where is_current$q$, 1,
  'The device is listed as this one');

-- A new sign-in on that browser (aal1): refused until the trusted token is used.
select tests.act_as_owner();
insert into ids values
  ('rae_next', tests.sec_session((select id from ids where name = 'rae'), array['password'], interval '1 second'));
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_next'));
select set_config('request.path', '/rpc/list_my_sessions', true);
select tests.assert_denied($q$select public.check_request()$q$, 'Before the token: the second factor is required', 'PT401');
select set_config('request.path', '/rpc/use_trusted_device', true);
select tests.assert_allowed($q$select public.check_request()$q$, 'The page may present the token');
select tests.assert_true(
  not public.use_trusted_device(repeat('x', 43), 'firefox', 'linux'),
  'A wrong token is refused'
);
select tests.assert_true(
  not public.use_trusted_device(repeat('t', 43), 'chrome', 'linux'),
  'A different browser is asked for the code again'
);
select tests.assert_true(
  public.use_trusted_device(repeat('t', 43), 'firefox', 'linux'),
  'The right token on the same browser and platform passes the second factor'
);
select tests.assert_true(public.session_is_trusted(), 'The session now counts as trusted');
select set_config('request.path', '/rpc/list_my_sessions', true);
select tests.assert_allowed($q$select public.check_request()$q$, 'Afterwards the session works');
select tests.assert_true(tests.sec_request_ok(), 'and so does Realtime');
select tests.assert_denied(
  format($q$select public.authorize_account_change('password', %L)$q$, (select id from ids where name = 'rae_next')),
  'Trust never exempts a sensitive change (no fresh code)'
);
-- Another account's token does nothing.
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_aal1'));
select tests.assert_true(
  not public.use_trusted_device(repeat('t', 43), 'firefox', 'linux'),
  'Trust is account-specific'
);

-- Revoking trust takes effect at once.
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select tests.assert_true(
  public.revoke_trusted_device((select id from public.list_my_trusted_devices() limit 1)),
  'The account holder revokes the trust'
);
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_next'));
select tests.assert_denied($q$select public.check_request()$q$, 'The trusted session needs the code again', 'PT401');

-- A credential change ends every trust.
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select public.trust_this_device(repeat('u', 43), 'computer', 'firefox', 'linux');
select tests.act_as_owner();
select tests.assert_true(tests.sec_trust_count((select id from ids where name = 'rae')) = 1, 'Trusted again');
select private.record_security_event((select id from ids where name = 'rae'), 'password_changed', null);
select tests.assert_true(tests.sec_trust_count((select id from ids where name = 'rae')) = 0,
  'A password change ends the trust of every device');

-- 11. Backup email ---------------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids values
  ('tom_s11', tests.sec_session((select id from ids where name = 'tom'), array['password', 'totp'], interval '1 minute', 'aal2'));
create function tests.sec_email_id(p_user uuid) returns uuid
  language sql security definer set search_path = '' as $$
    select e.id from private.security_emails e where e.user_id = p_user order by e.created_at limit 1
  $$;
create function tests.sec_token_left(p_user uuid) returns boolean
  language sql security definer set search_path = '' as $$
    select exists (select 1 from private.security_emails e where e.user_id = p_user and e.token is not null)
  $$;
grant execute on function tests.sec_email_id(uuid) to anon, authenticated, service_role;
grant execute on function tests.sec_token_left(uuid) to anon, authenticated, service_role;
create function tests.sec_backup_token(p_user uuid) returns text
  language sql security definer set search_path = '' as $$
    select e.token from private.security_emails e
    where e.user_id = p_user and e.kind = 'backup_verify' order by e.created_at desc limit 1
  $$;
grant execute on function tests.sec_backup_token(uuid) to anon, authenticated, service_role;

select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_pw'));
select tests.assert_denied(
  $q$select public.request_backup_email('rae.backup@example.test')$q$,
  'Adding a backup address needs this session''s permission (it is the main one''s)'
);
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select tests.assert_true(public.request_backup_email('RAE@madeora.test ') = 'same_as_primary',
  'The backup address must differ from the sign-in address');
select tests.assert_true(public.request_backup_email('not an address') = 'invalid', 'A malformed address is refused');
select tests.assert_true(public.request_backup_email(' Rae.Backup@Example.test') = 'sent',
  'With the permission, a link goes to the new address');
select tests.assert_true(
  (select backup_email is null and backup_email_pending = 'r•••@example.test' from public.my_account_security()),
  'It is pending, masked, and not yet a recovery method'
);
select tests.assert_denied(
  $q$select public.request_backup_email('second@example.test')$q$,
  'The permission was used up'
);
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_s11'), 'aal2');
select tests.assert_true(
  public.confirm_backup_email(tests.sec_backup_token((select id from ids where name = 'rae'))) = 'invalid',
  'Another account cannot confirm the link'
);
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select tests.assert_true(public.confirm_backup_email('wrong') = 'invalid', 'A wrong link does nothing');
select tests.assert_true(
  public.confirm_backup_email(tests.sec_backup_token((select id from ids where name = 'rae'))) = 'confirmed',
  'The account holder confirms it'
);
select tests.assert_true(
  (select backup_email = 'r•••@example.test' and backup_email_pending is null from public.my_account_security()),
  'Now it is the verified backup address'
);
select tests.assert_true(
  public.confirm_backup_email(tests.sec_backup_token((select id from ids where name = 'rae'))) = 'invalid',
  'The link works once'
);
select tests.assert_true(
  tests.sec_notified((select id from ids where name = 'rae'), 'account.backup_email_changed'),
  'The sign-in address is told'
);
-- The email job reads the link once; afterwards only the hash is kept.
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome = 'ok' and recipient_email = 'rae.backup@example.test'
     from public.get_security_email(tests.sec_email_id((select id from ids where name = 'rae')))),
  'The job gets the address and link to send'
);
select public.record_security_email(tests.sec_email_id((select id from ids where name = 'rae')), 'sent');
select tests.act_as_owner();
select tests.assert_true(
  not tests.sec_token_left((select id from ids where name = 'rae')),
  'and the link''s secret is erased once sent'
);
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select tests.assert_denied($q$select public.get_security_email(gen_random_uuid())$q$,
  'Signed-in users cannot read security emails');

-- Another account cannot take the same backup address.
select tests.act_as_owner();
select tests.sec_grant((select id from ids where name = 'tom'), 'backup_email', (select id from ids where name = 'tom_s11'));
select tests.act_as_sec((select id from ids where name = 'tom'), (select id from ids where name = 'tom_s11'), 'aal2');
select public.request_backup_email('rae.backup@example.test');
select tests.assert_true(
  public.confirm_backup_email(tests.sec_backup_token((select id from ids where name = 'tom'))) = 'unavailable',
  'An address that is another account''s backup cannot be confirmed'
);

-- 12. Account recovery codes -----------------------------------------------------------------------

select tests.act_as_owner();
create temporary table account_codes (code text not null);
grant all on account_codes to anon, authenticated, service_role;

select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
select tests.assert_denied($q$select public.create_account_recovery_codes()$q$,
  'Creating account recovery codes needs the permission');
select tests.act_as_owner();
select tests.sec_grant((select id from ids where name = 'rae'), 'account_recovery_codes', (select id from ids where name = 'rae_main'));
select tests.act_as_sec((select id from ids where name = 'rae'), (select id from ids where name = 'rae_main'), 'aal2');
insert into account_codes select public.create_account_recovery_codes();
select tests.assert_true(
  (select count(distinct code) = 10
          and bool_and(code ~ '^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$')
     from account_codes),
  'Ten distinct 16-character codes, distinct in form from the two-factor codes'
);
select tests.assert_true(
  (select account_recovery_codes_left = 10 from public.my_account_security()),
  'The account shows how many are left'
);

-- 13. Account recovery (lost password and mailbox) ------------------------------------------------

select tests.act_as_owner();
create function tests.sec_recovery_token(p_user uuid, p_kind text) returns text
  language sql security definer set search_path = '' as $$
    select e.token from private.security_emails e
    where e.user_id = p_user and e.kind = p_kind order by e.created_at desc limit 1
  $$;
create function tests.sec_recovery(p_user uuid, out id uuid, out status text, out ready_at timestamptz)
  language sql security definer set search_path = '' as $$
    select r.id, r.status, r.ready_at from private.account_recoveries r
    where r.user_id = p_user order by r.created_at desc limit 1
  $$;
grant execute on function tests.sec_recovery_token(uuid, text) to anon, authenticated, service_role;
grant execute on function tests.sec_recovery(uuid) to anon, authenticated, service_role;

select tests.act_as_anon();
select public.start_account_recovery('nobody@madeora.test');
select public.start_account_recovery('tom@madeora.test');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.account_recoveries
              where user_id in ((select id from ids where name = 'tom'))),
  'An unknown address, or an account without a verified backup address, starts nothing (same answer)'
);
select tests.act_as_anon();
select public.start_account_recovery(' RAE@madeora.test');
select tests.act_as_owner();
select tests.assert_true(
  (tests.sec_recovery((select id from ids where name = 'rae'))).status = 'link_sent'
    and tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_link') is not null
    and exists (select 1 from private.security_emails e
                where e.user_id = (select id from ids where name = 'rae') and e.kind = 'recovery_link'
                  and e.to_email = 'rae.backup@example.test'),
  'For the account with a backup address, the link goes to that address'
);
select tests.act_as_anon();
select tests.assert_true(
  (select outcome = 'invalid' from public.continue_account_recovery('wrong', (select code from account_codes limit 1))),
  'A wrong link does nothing'
);
select tests.assert_true(
  (select outcome = 'invalid' from public.continue_account_recovery(
     tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_link'), 'AAAA-AAAA-AAAA-AAAA')),
  'A wrong code does nothing'
);
select tests.assert_true(
  (select outcome = 'invalid' from public.continue_account_recovery(
     tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_link'), (select code from codes limit 1))),
  'A two-factor recovery code is not an account recovery code'
);
select tests.assert_true(
  (select outcome = 'waiting' and ready_at > now() + interval '71 hours'
     from public.continue_account_recovery(
       tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_link'),
       (select code from account_codes order by code limit 1), true)),
  'The link plus one account recovery code start the 72-hour wait'
);
select tests.assert_true(
  (select outcome = 'invalid' from public.continue_account_recovery(
     tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_link'),
     (select code from account_codes order by code limit 1 offset 1))),
  'The link works once'
);
select tests.act_as_owner();
select tests.assert_true(
  tests.sec_notified((select id from ids where name = 'rae'), 'account.recovery_started')
    and exists (select 1 from private.security_emails e
                where e.user_id = (select id from ids where name = 'rae') and e.kind = 'recovery_started')
    and exists (select 1 from private.job_outbox o
                where o.job_name = 'account-recovery-ready' and o.available_at > now() + interval '71 hours')
    and tests.sec_trust_count((select id from ids where name = 'rae')) = 0,
  'Both addresses and the app are told, the end of the wait is scheduled, and trust ends'
);
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_account_recovery_ready((tests.sec_recovery((select id from ids where name = 'rae'))).id,
                                        (tests.sec_recovery((select id from ids where name = 'rae'))).ready_at) = 'not_ready',
  'Nothing can be finished before the wait is over'
);
-- The wait is over.
select tests.act_as_owner();
update private.account_recoveries set ready_at = now() - interval '1 minute'
  where user_id = (select id from ids where name = 'rae');
select tests.act_as_service_role();
select tests.assert_true(
  public.deliver_account_recovery_ready((tests.sec_recovery((select id from ids where name = 'rae'))).id,
                                        (tests.sec_recovery((select id from ids where name = 'rae'))).ready_at) = 'notified',
  'At the end of the wait, a link to finish goes to the backup address'
);
select tests.act_as_anon();
select tests.assert_true(public.finish_account_recovery('wrong') = 'invalid', 'A wrong finishing link does nothing');
select tests.act_as_owner();
update auth.users set recovery_token = 'old-reset'
  where id = (select id from ids where name = 'rae');
insert into auth.one_time_tokens (user_id, token_type, token_hash, relates_to)
  values ((select id from ids where name = 'rae'), 'recovery_token', 'old-reset', 'rae@madeora.test');
select tests.act_as_anon();
select tests.assert_true(
  public.finish_account_recovery(tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_ready')) = 'completed',
  'The finishing link completes the recovery'
);
select tests.act_as_owner();
select tests.assert_true(
  (select email = 'rae.backup@example.test' from auth.users where id = (select id from ids where name = 'rae'))
    and (select identity_data ->> 'email' = 'rae.backup@example.test' from auth.identities
         where user_id = (select id from ids where name = 'rae') and provider = 'email')
    and not exists (select 1 from auth.sessions where user_id = (select id from ids where name = 'rae'))
    and tests.sec_factor_count((select id from ids where name = 'rae')) = 0
    and not exists (select 1 from private.account_recovery_codes where user_id = (select id from ids where name = 'rae'))
    and not exists (select 1 from private.backup_emails where user_id = (select id from ids where name = 'rae')),
  'The backup address is the sign-in address, every session ended, the lost authenticator and the recovery material are gone'
);
select tests.assert_true(
  (select encrypted_password = '' and recovery_token = '' from auth.users
    where id = (select id from ids where name = 'rae'))
    and not exists (select 1 from auth.one_time_tokens where user_id = (select id from ids where name = 'rae')),
  'and the old password and every outstanding reset link stop working'
);
select tests.act_as_anon();
select tests.assert_true(
  public.finish_account_recovery(tests.sec_recovery_token((select id from ids where name = 'rae'), 'recovery_ready')) = 'invalid',
  'The finishing link works once'
);

-- The account holder can stop a recovery they did not ask for.
select tests.act_as_owner();
insert into ids values
  ('sam2', tests.sec_account('sam2@madeora.test'));
insert into ids values
  ('sam2_s', tests.sec_session((select id from ids where name = 'sam2'), array['password'], interval '1 minute'));
insert into private.backup_emails (user_id, email, verified_at)
  values ((select id from ids where name = 'sam2'), 'sam2.backup@example.test', now());
select tests.act_as_anon();
select public.start_account_recovery('sam2@madeora.test');
select tests.act_as_sec((select id from ids where name = 'sam2'), (select id from ids where name = 'sam2_s'));
select tests.assert_true(public.cancel_account_recovery(), 'The account holder cancels it');
select tests.act_as_anon();
select tests.assert_true(
  (select outcome = 'invalid' from public.continue_account_recovery(
     tests.sec_recovery_token((select id from ids where name = 'sam2'), 'recovery_link'), 'AAAA-AAAA-AAAA-AAAA')),
  'and its link no longer works'
);
-- At most 3 links a day per account.
select public.start_account_recovery('sam2@madeora.test') from generate_series(1, 5);
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 3 from private.security_emails
   where user_id = (select id from ids where name = 'sam2') and kind = 'recovery_link'),
  'Recovery links are limited to 3 a day per account'
);
