-- S08: linking and unlinking sign-in methods (supabase/migrations/20261015090000_sign_in_methods.sql).
--
-- Inserts and deletes on auth.identities below are what Supabase Auth itself runs (as its own
-- database role) when someone signs in with Google, links or unlinks a provider, or is deleted.
-- The guard is a trigger, so it applies whoever writes. Fixtures run as the database owner.
--
-- Part of the guard runs when a transaction commits (a deferred constraint trigger). Tests never
-- commit, so this makes it run at the end of every statement instead.
set constraints all immediate;

-- Fixtures ---------------------------------------------------------------------------------------

-- What Supabase Auth's callback writes for a manual link to `p_user` (linkIdentity), before it
-- inserts the identity: the PKCE flow state that targets the account, completed `p_age` ago.
create function tests.complete_link_flow(
  p_user uuid, p_provider text, p_target uuid default null, p_age interval default '0 seconds'
) returns void
  language sql
  as $$
    insert into auth.flow_state (id, user_id, auth_code, provider_type, authentication_method,
                                 created_at, updated_at, auth_code_issued_at, linking_target_id)
      values (gen_random_uuid(), p_user, 'synthetic-code', p_provider, 'oauth', now() - p_age,
              now() - p_age, now() - p_age, coalesce(p_target, p_user))
  $$;

-- A synthetic account with optional password and identities. Returns its id.
create function tests.make_account(
  p_email text, p_confirmed boolean, p_password boolean, p_providers text[]
) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
    v_provider text;
  begin
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (v_id, 'authenticated', 'authenticated', p_email,
              case when p_password then '$2a$10$synthetic.hash.for.tests.only' else '' end,
              case when p_confirmed then now() end, '{}', '{}', now(), now());
    foreach v_provider in array p_providers loop
      -- A second identity needs a link permission, as for a real link.
      if v_provider <> 'email' and exists (select 1 from auth.identities where user_id = v_id) then
        insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
          values (v_id, 'link', v_provider, now() + interval '1 minute');
        perform tests.complete_link_flow(v_id, v_provider);
      end if;
      insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
        values (case when v_provider = 'email' then v_id::text else 'google-sub-' || v_id::text end,
                v_id, jsonb_build_object('sub', v_id, 'email', p_email), v_provider, now(), now());
    end loop;
    return v_id;
  end
  $$;

-- A session for the account whose last password (or other) sign-in happened `p_age` ago.
create function tests.make_session(p_user uuid, p_method text, p_age interval) returns uuid
  language plpgsql
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into auth.sessions (id, user_id, created_at, updated_at)
      values (v_id, p_user, now() - p_age, now() - p_age);
    insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
      values (v_id, now() - p_age, now() - p_age, p_method, gen_random_uuid());
    return v_id;
  end
  $$;

-- Act as a signed-in user whose access token belongs to session `p_session`.
create function tests.act_as_session(p_user uuid, p_session uuid) returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated',
                         'session_id', p_session)::text,
      true
    );
  end
  $$;

create function tests.grant_count(p_user uuid) returns bigint
  language sql security definer set search_path = '' as $$
    select count(*) from private.sign_in_method_grants where user_id = p_user
  $$;

create function tests.google_identity(p_user uuid) returns uuid
  language sql as $$
    select id from auth.identities where user_id = p_user and provider = 'google'
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

create temporary table ids (name text primary key, id uuid not null);
grant all on ids to anon, authenticated;

insert into ids values
  ('pat', tests.make_account('pat@madeora.test', true, true, array['email'])),
  ('gina', tests.make_account('gina@madeora.test', true, false, array['google'])),
  ('both', tests.make_account('both@madeora.test', true, true, array['email', 'google'])),
  ('unconfirmed', tests.make_account('unconfirmed@madeora.test', false, true, array['email'])),
  ('other', tests.make_account('other@madeora.test', true, true, array['email']));

-- 1. First sign-in with Google: a new account gets its first identity -------------------------

select tests.assert_allowed(
  $q$
    with u as (
      insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data,
                              raw_user_meta_data, created_at, updated_at)
      values ('20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
              'newcomer@madeora.test', now(), '{}', '{}', now(), now())
      returning id
    )
    insert into auth.identities (provider_id, user_id, identity_data, provider)
      select 'google-newcomer', id, '{"email": "newcomer@madeora.test"}', 'google' from u
  $q$,
  'A first Google sign-in creates an account with its Google identity'
);

-- 2. Automatic linking on a matching email is refused --------------------------------------------

select tests.assert_denied(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-attacker', %L, '{"email": "pat@madeora.test"}', 'google')$q$,
    (select id from ids where name = 'pat')
  ),
  'A Google identity is never attached to a confirmed account without a link permission'
);
select tests.assert_true(
  tests.google_identity((select id from ids where name = 'pat')) is null,
  'The refused automatic link left no Google identity on the account'
);

-- An account that never confirmed its email can be taken over by a verified Google identity
-- (Supabase Auth then removes the unconfirmed password): it never was usable.
select tests.assert_allowed(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-unconfirmed', %L, '{"email": "unconfirmed@madeora.test"}', 'google')$q$,
    (select id from ids where name = 'unconfirmed')
  ),
  'A verified Google identity may replace an unconfirmed email account'
);
select tests.assert_allowed(
  format(
    $q$delete from auth.identities where user_id = %L and provider = 'email'$q$,
    (select id from ids where name = 'unconfirmed')
  ),
  'Supabase Auth may remove the unconfirmed email identity in that case'
);

-- 3. Reauthentication: only a fresh password sign-in on a live session gets a permission ----------

insert into ids values
  ('pat_fresh', tests.make_session((select id from ids where name = 'pat'), 'password', interval '1 minute')),
  ('pat_stale', tests.make_session((select id from ids where name = 'pat'), 'password', interval '6 minutes')),
  ('pat_oauth', tests.make_session((select id from ids where name = 'pat'), 'oauth', interval '1 minute')),
  ('other_fresh', tests.make_session((select id from ids where name = 'other'), 'password', interval '1 minute')),
  ('both_fresh', tests.make_session((select id from ids where name = 'both'), 'password', interval '1 minute')),
  ('gina_oauth', tests.make_session((select id from ids where name = 'gina'), 'oauth', interval '1 minute'));

select tests.act_as_anon();
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'Visitors who are not signed in cannot ask for a permission'
);

select tests.act_as_session((select id from ids where name = 'pat'), (select id from ids where name = 'pat_stale'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'A password sign-in older than 5 minutes is not recent enough'
);

select tests.act_as_session((select id from ids where name = 'pat'), (select id from ids where name = 'pat_oauth'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'A Google sign-in is not a password reauthentication'
);

select tests.act_as_user((select id from ids where name = 'pat'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'A token without a session id gets no permission'
);

-- A token naming someone else's session (forged or mixed up) gets nothing.
select tests.act_as_session((select id from ids where name = 'pat'), (select id from ids where name = 'other_fresh'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'Another account''s fresh session does not reauthenticate this account'
);

select tests.act_as_session((select id from ids where name = 'pat'), (select id from ids where name = 'pat_fresh'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('merge', 'google')$q$,
  'Unknown actions are refused',
  '22023'
);
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'github')$q$,
  'Unknown providers are refused',
  '22023'
);
select tests.assert_denied(
  $q$select * from private.sign_in_method_grants$q$,
  'Signed-in people cannot read or write permissions directly'
);

-- A revoked (signed-out) session no longer counts, even with a fresh password claim.
select tests.act_as_owner();
update auth.sessions set not_after = now() - interval '1 second'
  where id = (select id from ids where name = 'pat_fresh');
select tests.act_as_session((select id from ids where name = 'pat'), (select id from ids where name = 'pat_fresh'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  'An ended session cannot reauthenticate'
);
select tests.act_as_owner();
update auth.sessions set not_after = null where id = (select id from ids where name = 'pat_fresh');

select tests.act_as_session((select id from ids where name = 'pat'), (select id from ids where name = 'pat_fresh'));
select tests.assert_row_count(
  $q$select public.authorize_sign_in_method_change('link', 'google')$q$,
  1,
  'A password sign-in from the last 5 minutes gets a link permission'
);
select tests.act_as_owner();
select tests.assert_true(
  tests.grant_count((select id from ids where name = 'pat')) = 1,
  'Asking twice keeps one permission per account and action'
);

-- 4. Linking with a permission: once, for that account and provider only -------------------------

-- Another account's permission does not help pat's attacker, and pat's does not help others:
-- 'other' is even in a finished link flow, but has no permission of its own.
select tests.complete_link_flow((select id from ids where name = 'other'), 'google');
select tests.assert_denied(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-other', %L, '{}', 'google')$q$,
    (select id from ids where name = 'other')
  ),
  'A permission for one account does not allow linking to another'
);

-- A permission alone is not enough: a Google sign-in that Supabase Auth would link by matching
-- email (no manual-link flow for pat) is refused while pat's permission is open, for example
-- after pat cancelled at Google, and the permission stays unused.
select tests.assert_denied(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-pat', %L, '{"email": "pat@madeora.test"}', 'google')$q$,
    (select id from ids where name = 'pat')
  ),
  'An open link permission does not let a plain Google sign-in attach to the account'
);
select tests.assert_true(
  tests.grant_count((select id from ids where name = 'pat')) = 1,
  'The refused sign-in did not use up the permission'
);
-- Neither does a link flow for another account, for another provider, or an old one.
select tests.complete_link_flow((select id from ids where name = 'pat'), 'google', (select id from ids where name = 'other'));
select tests.complete_link_flow((select id from ids where name = 'pat'), 'apple');
select tests.complete_link_flow((select id from ids where name = 'pat'), 'google', null, interval '2 minutes');
select tests.assert_denied(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-pat', %L, '{"email": "pat@madeora.test"}', 'google')$q$,
    (select id from ids where name = 'pat')
  ),
  'Only a link flow that targets this account, for Google, completed just now counts'
);

select tests.complete_link_flow((select id from ids where name = 'pat'), 'google');
select tests.assert_allowed(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-pat', %L, '{"email": "pat.google@madeora.test"}', 'google')$q$,
    (select id from ids where name = 'pat')
  ),
  'With a permission and the manual-link flow, Google links to the existing account'
);
select tests.assert_true(
  tests.grant_count((select id from ids where name = 'pat')) = 0,
  'Linking used up the permission'
);

-- An expired permission is useless.
select tests.act_as_session((select id from ids where name = 'other'), (select id from ids where name = 'other_fresh'));
select public.authorize_sign_in_method_change('link', 'google');
select tests.act_as_owner();
update private.sign_in_method_grants set expires_at = now() - interval '1 second'
  where user_id = (select id from ids where name = 'other');
select tests.assert_denied(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-other', %L, '{}', 'google')$q$,
    (select id from ids where name = 'other')
  ),
  'An expired link permission is refused'
);

-- An unlink permission does not allow linking.
select tests.act_as_session((select id from ids where name = 'other'), (select id from ids where name = 'other_fresh'));
select public.authorize_sign_in_method_change('unlink', 'google');
select tests.act_as_owner();
select tests.assert_denied(
  format(
    $q$insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ('google-other', %L, '{}', 'google')$q$,
    (select id from ids where name = 'other')
  ),
  'An unlink permission cannot be used to link'
);

-- 5. Unlinking ------------------------------------------------------------------------------------

-- Google-only account: Google is its last usable method, with or without a permission.
select tests.assert_denied(
  format($q$delete from auth.identities where id = %L$q$,
         tests.google_identity((select id from ids where name = 'gina'))),
  'The last usable sign-in method cannot be removed'
);
select tests.act_as_session((select id from ids where name = 'gina'), (select id from ids where name = 'gina_oauth'));
select tests.assert_denied(
  $q$select public.authorize_sign_in_method_change('unlink', 'google')$q$,
  'A Google-only account cannot reauthenticate with a password'
);
select tests.act_as_owner();
-- Even a permission obtained some other way does not remove the last method.
insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
  values ((select id from ids where name = 'gina'), 'unlink', 'google', now() + interval '5 minutes');
select tests.assert_denied(
  format($q$delete from auth.identities where id = %L$q$,
         tests.google_identity((select id from ids where name = 'gina'))),
  'An unlink permission never removes the last usable method'
);
select tests.assert_true(
  tests.google_identity((select id from ids where name = 'gina')) is not null,
  'The Google-only account still has Google'
);

-- An email identity whose password is gone is not a usable fallback.
select tests.act_as_owner();
update auth.users set encrypted_password = '' where id = (select id from ids where name = 'both');
insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
  values ((select id from ids where name = 'both'), 'unlink', 'google', now() + interval '5 minutes');
select tests.assert_denied(
  format($q$delete from auth.identities where id = %L$q$,
         tests.google_identity((select id from ids where name = 'both'))),
  'Google cannot be removed when the remaining email method has no password'
);
update auth.users set encrypted_password = '$2a$10$synthetic.hash.for.tests.only'
  where id = (select id from ids where name = 'both');
delete from private.sign_in_method_grants where user_id = (select id from ids where name = 'both');

-- With a usable password but no permission: refused.
select tests.assert_denied(
  format($q$delete from auth.identities where id = %L$q$,
         tests.google_identity((select id from ids where name = 'both'))),
  'Google cannot be unlinked without a fresh unlink permission'
);

-- A link permission does not allow unlinking.
select tests.act_as_session((select id from ids where name = 'both'), (select id from ids where name = 'both_fresh'));
select public.authorize_sign_in_method_change('link', 'google');
select tests.act_as_owner();
select tests.assert_denied(
  format($q$delete from auth.identities where id = %L$q$,
         tests.google_identity((select id from ids where name = 'both'))),
  'A link permission cannot be used to unlink'
);

-- With a permission and a usable password: allowed, once.
select tests.act_as_session((select id from ids where name = 'both'), (select id from ids where name = 'both_fresh'));
select public.authorize_sign_in_method_change('unlink', 'google');
select tests.act_as_owner();
select tests.assert_row_count(
  format($q$delete from auth.identities where id = %L returning id$q$,
         tests.google_identity((select id from ids where name = 'both'))),
  1,
  'Google is unlinked after reauthentication when a usable password remains'
);
select tests.assert_true(
  not exists (
    select 1 from private.sign_in_method_grants
    where user_id = (select id from ids where name = 'both') and action = 'unlink'
  ),
  'Unlinking used up the permission'
);

-- The email/password method itself is never removed through this path.
insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
  values ((select id from ids where name = 'pat'), 'unlink', 'google', now() + interval '5 minutes');
select tests.assert_denied(
  format($q$delete from auth.identities where user_id = %L and provider = 'email'$q$,
         (select id from ids where name = 'pat')),
  'The email and password method cannot be removed'
);

-- 6. Deleting an account still removes all of its identities -----------------------------------

select tests.assert_allowed(
  format($q$delete from auth.users where id = %L$q$, (select id from ids where name = 'gina')),
  'Deleting a Google-only account works'
);
select tests.assert_allowed(
  format($q$delete from auth.users where id = %L$q$, (select id from ids where name = 'pat')),
  'Deleting an account with email and Google identities works'
);
select tests.assert_true(
  not exists (
    select 1 from auth.identities
    where user_id in (select id from ids where name in ('gina', 'pat'))
  ),
  'The deleted accounts left no identities behind'
);
