-- S42: child sign-in (supabase/migrations/20261130090000_child_sign_in.sql).
-- Who may manage a child's username, password, PIN and sign-in switches; approved household
-- devices; PIN only on an approved device of the child's Home; lockout and throttles; the session
-- registration steps; and the lock-down of a child's session (request check, path allowlist,
-- confirmed-email gate, auth.users guards). Credentials never reach audit records.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated, service_role;

create temporary table vals (name text primary key, v text) on commit drop;
grant all on vals to anon, authenticated, service_role;

create function tests.cs(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.cs_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

create function tests.cs_offer(p_child_membership uuid, p_guardian uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select o.id from public.child_guardian_offers o
    join private.home_memberships_all m on m.home_id = o.home_id and m.user_id = o.child_user_id
    where m.id = p_child_membership and o.guardian_user_id = p_guardian
  $$;

create function tests.cs_child(p_child_membership uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select m.user_id from private.home_memberships_all m where m.id = p_child_membership $$;

-- A synthetic scrypt hash in the web server's format (never a real secret).
create function tests.cs_hash(p_seed text) returns text
  language sql immutable
  as $$
    select 'scrypt$15$8$1$' || substr(translate(encode(sha256(convert_to('s' || p_seed, 'UTF8')),
             'base64'), '+/=', '-_'), 1, 22)
      || '$' || substr(translate(encode(sha256(convert_to('k' || p_seed, 'UTF8')), 'base64'),
             '+/=', '-_'), 1, 43)
  $$;

create function tests.cs_key(p_seed text) returns text
  language sql immutable
  as $$ select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex') $$;

-- Act as a child in a given Supabase Auth session, as PostgREST does for a request on p_path.
create function tests.cs_act_as_child(p_child uuid, p_session uuid, p_path text) returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_child, 'role', 'authenticated', 'aud', 'authenticated',
                         'session_id', p_session,
                         'app_metadata', jsonb_build_object('madeora_kind', 'child'))::text,
      true);
    perform set_config('request.path', p_path, true);
  end
  $$;

-- A Supabase Auth session for a user, as Supabase Auth's insert would make it.
create function tests.cs_session(p_user uuid) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values (v_id, p_user, now(), now(), 'aal1');
    return v_id;
  end
  $$;

create function tests.cs_session_ok(p_child uuid, p_session uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.child_session_ok(p_child, p_session) $$;

create function tests.cs_state() returns text
  language sql stable security definer set search_path = ''
  as $$ select private.request_session_state() $$;

create function tests.cs_realtime_ok() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.request_session_ok() $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A with Bob (Member) and Carol (Administrator, no capabilities). Erin
-- owns Home B. Alice adds Mia as primary guardian; Bob accepts the secondary role.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob')),
  ('carol', tests.user_id('carol'));

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into ids values ('erin', gen_random_uuid());
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (tests.cs('erin'), 'authenticated', 'authenticated', 'erin@child-sign-in.madeora.test',
          '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000', now(), '{}', '{}',
          now(), now());
select tests.act_as_user(tests.cs('erin'));
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.cs('home-a'), tests.cs('bob'), 'member'),
  (tests.cs('home-a'), tests.cs('carol'), 'administrator');
insert into ids values
  ('m-alice', tests.cs_mid(tests.cs('home-a'), tests.cs('alice'))),
  ('m-bob', tests.cs_mid(tests.cs('home-a'), tests.cs('bob'))),
  ('m-erin-b', tests.cs_mid(tests.cs('home-b'), tests.cs('erin')));

select tests.act_as('alice');
insert into ids select 'm-mia', membership_id from public.create_child(
  tests.cs('home-a'), 'Mia', tests.cs('m-alice'), null, '#16a34a', gen_random_uuid());
insert into ids select 'm-noor', membership_id from public.create_child(
  tests.cs('home-a'), 'Noor', tests.cs('m-alice'), null, '#2563eb', gen_random_uuid());
select tests.assert_true(
  public.assign_child_guardian(tests.cs('home-a'), tests.cs('m-mia'), tests.cs('m-bob'),
    'secondary') = 'offered',
  'Fixture: Alice offers Bob the secondary role');
select tests.act_as('bob');
select public.answer_child_guardian_offer(tests.cs_offer(tests.cs('m-mia'), tests.cs('bob')), true);
insert into ids values ('mia', tests.cs_child(tests.cs('m-mia'))),
  ('noor', tests.cs_child(tests.cs('m-noor')));

-- Usernames: primary guardian only -------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia')$$,
  'A signed-out visitor cannot set a username');

select tests.act_as('bob');
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia.k') = 'not_permitted',
  'The secondary guardian cannot set the username (protected identity)');
select tests.act_as('carol');
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia.k') = 'not_permitted',
  'An Administrator who is not a guardian cannot set the username');
select tests.act_as_user(tests.cs('erin'));
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia.k') = 'not_found',
  'Someone from another Home gets not_found');

select tests.act_as('alice');
select tests.assert_denied(
  $$select public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'm')$$,
  'A username needs at least 3 characters', '22023');
select tests.assert_denied(
  $$select public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia@home')$$,
  'A username cannot contain @', '22023');
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'Mia.K') = 'saved',
  'The primary guardian sets the username (stored in lower case)');
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia.k') = 'unchanged',
  'The same username again changes nothing');
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-noor'), 'MIA.K') = 'taken',
  'Usernames are unique regardless of case');

select tests.act_as_owner();
select tests.assert_true(
  (select email from auth.users where id = tests.cs('mia'))
    = 'child-' || tests.cs('mia') || '@children.madeora.invalid',
  'The child gets its internal alias');
select tests.assert_true(private.confirmed_email(tests.cs('mia')) is null,
  'A child never counts as a confirmed adult, even with its confirmed alias');
select tests.assert_true(not private.can_receive_notifications(tests.cs('mia')),
  'A child receives no notifications or email');

-- Credentials --------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  public.set_child_credential(tests.cs('home-a'), tests.cs('m-noor'), 'password',
    tests.cs_hash('noor-pw')) = 'username_required',
  'A password needs a username first');
select tests.assert_denied(
  $$select public.set_child_credential(tests.cs('home-a'), tests.cs('m-mia'), 'password', '1234')$$,
  'Only a scrypt hash is accepted, never a plain secret', '22023');

select tests.act_as('bob');
select tests.assert_true(
  public.set_child_credential(tests.cs('home-a'), tests.cs('m-mia'), 'password',
    tests.cs_hash('mia-pw')) = 'not_permitted',
  'The secondary guardian cannot set the independent password');
select tests.assert_true(
  public.set_child_credential(tests.cs('home-a'), tests.cs('m-mia'), 'pin',
    tests.cs_hash('mia-pin')) = 'saved',
  'The secondary guardian may reset the PIN (routine help)');
select tests.act_as('carol');
select tests.assert_true(
  public.set_child_credential(tests.cs('home-a'), tests.cs('m-mia'), 'pin',
    tests.cs_hash('x')) = 'not_permitted',
  'A non-guardian manager cannot set a PIN');

select tests.act_as('alice');
select tests.assert_true(
  public.set_child_credential(tests.cs('home-a'), tests.cs('m-mia'), 'password',
    tests.cs_hash('mia-pw')) = 'saved',
  'The primary guardian sets the password');

-- Switches ---------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, false)
    = 'not_permitted',
  'The secondary guardian cannot turn on independent sign-in');
select tests.assert_true(
  public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), false, true)
    = 'not_permitted',
  'The secondary guardian cannot turn on PIN sign-in');
select tests.act_as('alice');
select tests.assert_true(
  public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, true) = 'saved',
  'The primary guardian turns both on');
select tests.act_as('bob');
select tests.assert_true(
  public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, false) = 'saved',
  'The secondary guardian may turn PIN sign-in off');
select tests.act_as('alice');
select public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, true);

select tests.act_as('carol');
select tests.assert_denied(
  $$select * from public.child_sign_in_settings(tests.cs('home-a'), tests.cs('m-mia'))$$,
  'A non-guardian cannot read a child''s sign-in settings');
select tests.act_as('bob');
select tests.assert_true(
  (select has_password and has_pin and password_sign_in and pin_sign_in and username = 'mia.k'
   from public.child_sign_in_settings(tests.cs('home-a'), tests.cs('m-mia'))),
  'A guardian sees the username and which credentials exist, never the hashes');

-- Household devices ------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.approve_household_device(tests.cs('home-a'), 'Kitchen',
     tests.cs_key('bob-device'))) = 'not_permitted',
  'A Member (even a guardian) cannot approve a household device');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.approve_household_device(tests.cs('home-a'), 'Kitchen',
     tests.cs_key('carol-device'))) = 'not_permitted',
  'An Administrator without manageHomeSettings cannot approve a device');
select tests.act_as_user(tests.cs('erin'));
select tests.assert_true(
  (select outcome from public.approve_household_device(tests.cs('home-a'), 'Kitchen',
     tests.cs_key('erin-device'))) = 'not_found',
  'An outsider cannot approve a device for another Home');
insert into ids select 'device-b', device_id from public.approve_household_device(
  tests.cs('home-b'), 'Hall', tests.cs_key('device-b'));

select tests.act_as('alice');
insert into ids select 'device-a', device_id from public.approve_household_device(
  tests.cs('home-a'), 'Kitchen', tests.cs_key('device-a'));
select tests.assert_true(tests.cs('device-a') is not null, 'The Owner approves a device');
select tests.assert_true(
  (select is_this_device from public.home_household_devices(tests.cs('home-a'),
     tests.cs_key('device-a'))),
  'The device list marks the caller''s own browser');
select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.home_household_devices(tests.cs('home-a'), '')$$,
  'Only managers list a Home''s devices');

-- The sign-in functions are the web server's only ---------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.child_password_attempt('mia.k', tests.cs_key('client'))$$,
  'A visitor cannot fetch a password hash');
select tests.assert_denied(
  $$select * from public.household_device_sign_in(tests.cs_key('device-a'))$$,
  'A visitor cannot list a device''s children directly');
select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.child_pin_attempt(tests.cs_key('device-a'), tests.cs('m-mia'),
    tests.cs_key('client'))$$,
  'A signed-in adult cannot fetch a PIN hash');

-- PIN only on an approved device of the child's Home ----------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(
  (select count(*) = 1 and bool_and(child_name = 'Mia')
   from public.household_device_sign_in(tests.cs_key('device-a')) where child_membership_id is not null),
  'The device screen lists only children with PIN sign-in on and a PIN set');
select tests.assert_true(
  not exists (select 1 from public.household_device_sign_in(tests.cs_key('not-a-device'))),
  'An unknown device sees nothing');
select tests.assert_true(
  (select outcome from public.child_pin_attempt(tests.cs_key('not-a-device'), tests.cs('m-mia'),
     tests.cs_key('c1'))) = 'device_not_approved',
  'A PIN is refused on a device that was never approved');
select tests.assert_true(
  (select outcome from public.child_pin_attempt(tests.cs_key('device-b'), tests.cs('m-mia'),
     tests.cs_key('c1'))) = 'unknown',
  'A PIN is refused on another Home''s device');
select tests.assert_true(
  (select outcome = 'check' and pin_hash = tests.cs_hash('mia-pin')
   from public.child_pin_attempt(tests.cs_key('device-a'), tests.cs('m-mia'), tests.cs_key('c1'))),
  'On an approved device of the child''s Home, the server gets the hash to check');

-- Lockout: the fifth wrong PIN locks it.
select public.child_pin_attempt(tests.cs_key('device-a'), tests.cs('m-mia'), tests.cs_key('c2'))
  from generate_series(1, 4);
select tests.assert_true(
  (select outcome = 'locked' and locked_until > now()
   from public.child_pin_attempt(tests.cs_key('device-a'), tests.cs('m-mia'), tests.cs_key('c2'))),
  'After five unconfirmed tries the PIN is locked');
select tests.assert_true(
  (select outcome from public.child_password_attempt('mia.k', tests.cs_key('c2'))) = 'check',
  'A PIN lock does not lock the password');

select tests.act_as('bob');
select tests.assert_true(
  public.unlock_child_sign_in(tests.cs('home-a'), tests.cs('m-mia')) = 'unlocked',
  'A guardian can lift the lock');

-- The third lock within a day lasts until a guardian unlocks.
select tests.act_as_owner();
select private.count_child_failure(tests.cs('mia'), 'pin', tests.cs('home-a'))
  from generate_series(1, 15);
select tests.assert_true(
  (select pin_locked_until = 'infinity' from private.child_home_pins
   where child_user_id = tests.cs('mia') and home_id = tests.cs('home-a')),
  'The third lock within 24 hours lasts until a guardian unlocks');
select tests.act_as('alice');
select public.unlock_child_sign_in(tests.cs('home-a'), tests.cs('m-mia'));

-- Throttles.
select tests.act_as_owner();
insert into private.child_sign_in_attempts (method, device_id, client_key)
  select 'pin', tests.cs('device-a'), tests.cs_key('t' || g) from generate_series(1, 20) g;
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.child_pin_attempt(tests.cs_key('device-a'), tests.cs('m-mia'),
     tests.cs_key('c3'))) = 'rate_limited',
  'Twenty failed tries on a device within an hour throttle the device');
select tests.act_as_owner();
delete from private.child_sign_in_attempts where device_id = tests.cs('device-a');
insert into private.child_sign_in_attempts (method, client_key)
  select 'password', tests.cs_key('busy-client') from generate_series(1, 30);
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.child_password_attempt('mia.k', tests.cs_key('busy-client')))
    = 'rate_limited',
  'Thirty failed tries from one client within 15 minutes throttle that client');
select tests.assert_true(
  (select outcome from public.child_password_attempt('nobody', tests.cs_key('c4'))) = 'unknown',
  'An unknown username gives the same step-1 answer path as a wrong password (no hash)');

-- Registering a session ------------------------------------------------------------------------------------------

select tests.act_as_owner();
update private.child_credentials set password_failures = 0
  where child_user_id = tests.cs('mia');
update private.child_home_pins set pin_failures = 0 where child_user_id = tests.cs('mia');
select tests.act_as_service_role();
insert into ids select 'att-pin', attempt_id from public.child_pin_attempt(
  tests.cs_key('device-a'), tests.cs('m-mia'), tests.cs_key('c5'));
select tests.assert_true(
  (select outcome = 'verified' and child_user_id = tests.cs('mia')
     and alias_email = 'child-' || tests.cs('mia') || '@children.madeora.invalid'
   from public.child_sign_in_verified(tests.cs('att-pin'))),
  'A matched PIN is verified and the server gets the child''s alias');
select tests.assert_true(
  (select outcome from public.child_sign_in_verified(tests.cs('att-pin'))) = 'invalid',
  'An attempt can be verified only once');
select tests.act_as_owner();
select tests.assert_true(
  (select pin_failures = 0 from private.child_home_pins where child_user_id = tests.cs('mia')),
  'Verification clears the wrong-try count');
select tests.act_as_service_role();
insert into ids select 'sess-pin', tests.cs_session(tests.cs('mia'));
select tests.assert_true(
  (select outcome = 'registered' and expires_at <= now() + interval '4 hours'
   from public.child_sign_in_complete(tests.cs('att-pin'), tests.cs('sess-pin'))),
  'The new session is registered as a PIN session of at most 4 hours');
select tests.assert_true(
  (select outcome from public.child_sign_in_complete(tests.cs('att-pin'), tests.cs('sess-pin')))
    = 'invalid',
  'An attempt registers one session only');
insert into ids select 'sess-other', tests.cs_session(tests.cs('alice'));
insert into ids select 'att-pw', attempt_id from public.child_password_attempt(
  'mia.k', tests.cs_key('c6'));
select public.child_sign_in_verified(tests.cs('att-pw'));
select tests.assert_true(
  (select outcome from public.child_sign_in_complete(tests.cs('att-pw'), tests.cs('sess-other')))
    = 'invalid',
  'Another account''s session cannot be registered for the child');
insert into ids select 'sess-pw', tests.cs_session(tests.cs('mia'));
select tests.assert_true(
  (select outcome from public.child_sign_in_complete(tests.cs('att-pw'), tests.cs('sess-pw')))
    = 'registered',
  'A password sign-in registers its session');

-- A child's session is locked down -------------------------------------------------------------------------------

select tests.cs_act_as_child(tests.cs('mia'), tests.cs('sess-pin'), '/rpc/child_me');
select tests.assert_allowed($$select public.check_request()$$,
  'A registered child session may call child_me');
select tests.assert_true(
  (select home_id = tests.cs('home-a') and method = 'pin' and 'viewHomeChores' = any (capabilities)
   from public.child_me()),
  'child_me shows the Home the PIN session reaches and the child''s capabilities');
select tests.cs_act_as_child(tests.cs('mia'), tests.cs('sess-pin'), '/rpc/home_children');
select tests.assert_denied($$select public.check_request()$$,
  'A child session cannot call any other function', 'PT403');
select tests.cs_act_as_child(tests.cs('mia'), tests.cs('sess-pin'), '/homes');
select tests.assert_denied($$select public.check_request()$$,
  'A child session cannot read tables', 'PT403');
select tests.cs_act_as_child(tests.cs('mia'), tests.cs('sess-pin'), '/rpc/graphql');
select tests.assert_denied($$select public.check_request()$$,
  'A child session cannot use GraphQL', 'PT403');
select tests.assert_denied(
  $$select * from public.child_sign_in_settings(tests.cs('home-a'), tests.cs('m-mia'))$$,
  'Functions behind require_confirmed_caller refuse a child');

-- An unregistered session (issued some other way) is not active.
insert into ids select 'sess-rogue', tests.cs_session(tests.cs('mia'));
select tests.cs_act_as_child(tests.cs('mia'), tests.cs('sess-rogue'), '/rpc/child_me');
select tests.assert_denied($$select public.check_request()$$,
  'A child session Madeora did not register is refused', 'PT401');
select tests.assert_denied($$select * from public.child_me()$$,
  'child_me refuses an unregistered session');

-- Realtime policies use request_session_ok(): false for a child.
select tests.cs_act_as_child(tests.cs('mia'), tests.cs('sess-pin'), '');
select tests.assert_true(tests.cs_state() = 'child_session' and not tests.cs_realtime_ok(),
  'A live child session has its own state, so Realtime policies refuse it');

-- Turning things off ends access at once.
select tests.act_as('bob');
select public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, false);
select tests.assert_true(not tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pin')),
  'Turning PIN sign-in off ends the PIN session');
select tests.assert_true(tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pw')),
  'The password session is not affected by the PIN switch');
select public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), false, false);
select tests.assert_true(not tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pw')),
  'Turning password sign-in off ends the password session');
select tests.act_as('alice');
select public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, true);
select tests.assert_true(not tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pin')),
  'An ended PIN session does not come back when the switch is turned on again');
select tests.assert_true(tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pw')),
  'A password session follows the switch while it is still registered');

-- Revoking the device.
select tests.act_as_service_role();
insert into ids select 'att-pin2', attempt_id from public.child_pin_attempt(
  tests.cs_key('device-a'), tests.cs('m-mia'), tests.cs_key('c7'));
select public.child_sign_in_verified(tests.cs('att-pin2'));
insert into ids select 'sess-pin2', tests.cs_session(tests.cs('mia'));
select public.child_sign_in_complete(tests.cs('att-pin2'), tests.cs('sess-pin2'));
select tests.assert_true(tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pin2')),
  'Fixture: a second PIN session');
select tests.act_as('carol');
select tests.assert_true(
  public.revoke_household_device(tests.cs('home-a'), tests.cs('device-a')) = 'not_permitted',
  'An Administrator without manageHomeSettings cannot revoke a device');
select tests.act_as('alice');
select tests.assert_true(
  public.revoke_household_device(tests.cs('home-a'), tests.cs('device-a')) = 'revoked',
  'The Owner revokes the device');
select tests.assert_true(not tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pin2')),
  'Revoking the device ends its PIN sessions');
select tests.act_as_owner();
select tests.assert_true(not exists (select 1 from auth.sessions where id = tests.cs('sess-pin2')),
  'The revoked device''s Supabase Auth session is gone too');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.child_pin_attempt(tests.cs_key('device-a'), tests.cs('m-mia'),
     tests.cs_key('c8'))) = 'device_not_approved',
  'A revoked device cannot use a PIN any more');

-- Sign-in turned off: the right credential still says so, after it was checked.
select tests.act_as('alice');
select public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), false, false);
select tests.act_as_service_role();
insert into ids select 'att-off', attempt_id from public.child_password_attempt(
  'mia.k', tests.cs_key('c9'));
select tests.assert_true(
  (select outcome from public.child_sign_in_verified(tests.cs('att-off'))) = 'not_enabled',
  'A correct password while independent sign-in is off gets not_enabled, no session');

-- New credentials end that method's sessions.
select tests.act_as('alice');
select public.set_child_sign_in_access(tests.cs('home-a'), tests.cs('m-mia'), true, false);
select tests.assert_true(tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pw')),
  'Fixture: the password session is usable');
select public.set_child_credential(tests.cs('home-a'), tests.cs('m-mia'), 'password',
  tests.cs_hash('mia-pw-2'));
select tests.assert_true(not tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pw')),
  'A new password ends the password sessions');

-- Guards on the child's Supabase Auth rows -----------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_denied(
  $$update auth.users set encrypted_password = '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000'
    where id = tests.cs('mia')$$,
  'A child can never get a Supabase Auth password');
select tests.assert_denied(
  $$update auth.users set email_change = 'mia@example.com' where id = tests.cs('mia')$$,
  'A child''s address change is refused');
select tests.assert_denied(
  $$update auth.users set email = 'mia@example.com' where id = tests.cs('mia')$$,
  'A child''s address is only its alias');
select tests.assert_denied(
  $$insert into auth.identities (provider_id, user_id, identity_data, provider)
    values ('google-123', tests.cs('mia'), '{}', 'google')$$,
  'A child cannot link Google');
select tests.assert_allowed(
  $$update auth.users set last_sign_in_at = now() where id = tests.cs('mia')$$,
  'Supabase Auth''s own bookkeeping on the child still works');

-- Audit records never hold a secret -----------------------------------------------------------------------------

select tests.assert_true(
  not exists (select 1 from private.audit_events e
              where e.details::text like '%scrypt%' or e.details::text like '%mia.k%'),
  'No hash or username is written to the audit trail');
select tests.assert_true(
  (select count(*) from private.audit_events e
   where e.action in ('child.password_set', 'child.pin_set', 'child.sign_in_access_changed',
                      'child.signed_in', 'household_device.approved', 'household_device.revoked',
                      'child.sign_in_unlocked', 'child.username_set')) >= 8,
  'Credential, switch, device and sign-in events are audited');

-- Signing out everywhere.
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.end_child_sign_ins(tests.cs('home-a'), tests.cs('m-mia'))) = 'ended',
  'A guardian can sign the child out everywhere');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.end_child_sign_ins(tests.cs('home-a'), tests.cs('m-mia')))
    = 'not_permitted',
  'A non-guardian cannot');

-- A child in two Homes: identity-wide credentials need the primary guardian of every Home ---------------
-- (spec "identity-level guardians": a Home-only guardian is denied a global reset; a Home guardian
-- resets only that Home's PIN).

create temporary table link (code text) on commit drop;
grant all on link to anon, authenticated;
select tests.act_as('alice');
insert into link select code from public.create_child_link_code(tests.cs('home-a'), tests.cs('m-mia'));
select tests.act_as_user(tests.cs('erin'));
insert into ids select 'm-mia-b', membership_id from public.redeem_child_link_code(
  tests.cs('home-b'), (select code from link), '#2563eb');
select tests.assert_true(tests.cs('m-mia-b') is not null,
  'Fixture: Erin links Mia into Home B and becomes her primary guardian there');

select tests.assert_true(
  public.set_child_username(tests.cs('home-b'), tests.cs('m-mia-b'), 'mia.erin') = 'not_permitted',
  'A Home-only primary guardian cannot change the identity-wide username');
select tests.assert_true(
  public.set_child_credential(tests.cs('home-b'), tests.cs('m-mia-b'), 'password',
    tests.cs_hash('erin-pw')) = 'not_permitted',
  'A Home-only primary guardian cannot reset the identity-wide password');
select tests.assert_true(
  public.clear_child_credential(tests.cs('home-b'), tests.cs('m-mia-b'), 'password')
    = 'not_permitted',
  'Nor remove it');
select tests.assert_true(
  (select not can_manage_identity and active_sessions = 0
   from public.child_sign_in_settings(tests.cs('home-b'), tests.cs('m-mia-b'))),
  'Home B''s guardian is told they cannot manage the identity, and sees no Home A sessions');

select tests.act_as('alice');
select tests.assert_true(
  public.set_child_username(tests.cs('home-a'), tests.cs('m-mia'), 'mia.alice') = 'not_permitted',
  'Home A''s primary guardian cannot change it alone any more either');
select tests.assert_true(
  (select not can_manage_identity
   from public.child_sign_in_settings(tests.cs('home-a'), tests.cs('m-mia'))),
  'Home A''s guardian sees the same restriction');

-- PINs are per Home.
select tests.act_as_user(tests.cs('erin'));
select tests.assert_true(
  public.set_child_credential(tests.cs('home-b'), tests.cs('m-mia-b'), 'pin',
    tests.cs_hash('erin-pin')) = 'saved',
  'Home B''s guardian sets a PIN for Home B');
select tests.act_as_owner();
select tests.assert_true(
  (select pin_hash = tests.cs_hash('mia-pin') from private.child_home_pins
   where home_id = tests.cs('home-a') and child_user_id = tests.cs('mia'))
  and (select pin_hash = tests.cs_hash('erin-pin') from private.child_home_pins
       where home_id = tests.cs('home-b') and child_user_id = tests.cs('mia')),
  'Home A''s PIN is untouched by Home B''s');
update private.child_home_pins set pin_locked_until = now() + interval '1 hour', pin_failures = 2
  where home_id = tests.cs('home-a') and child_user_id = tests.cs('mia');
update private.child_credentials set password_locked_until = now() + interval '1 hour'
  where child_user_id = tests.cs('mia');
select tests.act_as_user(tests.cs('erin'));
select tests.assert_true(
  public.clear_child_credential(tests.cs('home-b'), tests.cs('m-mia-b'), 'pin') = 'cleared',
  'Home B''s guardian removes Home B''s PIN');
select tests.assert_true(
  public.unlock_child_sign_in(tests.cs('home-b'), tests.cs('m-mia-b')) = 'unchanged',
  'Home B''s guardian cannot lift Home A''s PIN lock or the identity-wide password lock');
select tests.act_as_owner();
select tests.assert_true(
  (select pin_locked_until > now() from private.child_home_pins
   where home_id = tests.cs('home-a') and child_user_id = tests.cs('mia'))
  and (select password_locked_until > now() from private.child_credentials
       where child_user_id = tests.cs('mia')),
  'Both locks are still in place');
select tests.act_as('bob');
select tests.assert_true(
  public.unlock_child_sign_in(tests.cs('home-a'), tests.cs('m-mia')) = 'unlocked',
  'Home A''s secondary guardian lifts Home A''s PIN lock');
select tests.act_as_owner();
select tests.assert_true(
  (select pin_locked_until is null from private.child_home_pins
   where home_id = tests.cs('home-a') and child_user_id = tests.cs('mia'))
  and (select password_locked_until > now() from private.child_credentials
       where child_user_id = tests.cs('mia')),
  'Only the PIN lock was lifted; the password lock needs identity authority');

-- Ending sessions from one Home reaches only what that guardian may end.
select tests.act_as_owner();
update private.child_credentials set password_locked_until = null, password_failures = 0
  where child_user_id = tests.cs('mia');
select tests.act_as_service_role();
insert into ids select 'att-pw3', attempt_id from public.child_password_attempt(
  'mia.k', tests.cs_key('c9'));
select public.child_sign_in_verified(tests.cs('att-pw3'));
insert into ids select 'sess-pw3', tests.cs_session(tests.cs('mia'));
select public.child_sign_in_complete(tests.cs('att-pw3'), tests.cs('sess-pw3'));
select tests.act_as_user(tests.cs('erin'));
select tests.assert_true(
  (select ended = 0 from public.end_child_sign_ins(tests.cs('home-b'), tests.cs('m-mia-b'))),
  'Home B''s guardian cannot end the child''s password session in Home A');
select tests.assert_true(tests.cs_session_ok(tests.cs('mia'), tests.cs('sess-pw3')),
  'The password session still works in Home A');

-- A step-2 call without a step-1 'check' verifies nothing.
select tests.act_as_owner();
insert into private.child_sign_in_attempts (id, method, child_user_id, client_key)
  values ('00000000-0000-4000-8000-0000000000aa', 'password', tests.cs('mia'), tests.cs_key('x'));
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.child_sign_in_verified('00000000-0000-4000-8000-0000000000aa'))
    = 'invalid',
  'Only an attempt that step 1 answered with ''check'' can be verified');
