-- S43: Household Display pairing and identity (supabase/migrations/20261203090000_household_displays.sql).
-- Who may pair, rename, list and revoke displays; single-use, short-lived codes bound to the
-- reviewed request, the Home and the tablet's own secret (replay, substitution, concurrent claims,
-- cross-Home pairing and stale approvals fail safely); the lock-down of a display's session (request
-- check, path allowlist, confirmed-email gate, auth.users guards); revocation and closed Homes.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated, service_role;

create function tests.hd(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.hd_key(p_seed text) returns text
  language sql immutable
  as $$ select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex') $$;

-- Act as a display in a given Supabase Auth session, as PostgREST does for a request on p_path.
create function tests.hd_act_as_display(p_user uuid, p_session uuid, p_path text) returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated',
                         'session_id', p_session,
                         'app_metadata', jsonb_build_object('madeora_kind', 'display'))::text,
      true);
    perform set_config('request.path', p_path, true);
  end
  $$;

create function tests.hd_session(p_user uuid) returns uuid
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

create function tests.hd_user(p_display uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select d.user_id from private.household_displays d where d.id = p_display $$;

create function tests.hd_state() returns text
  language sql stable security definer set search_path = ''
  as $$ select private.request_session_state() $$;

create function tests.hd_realtime_ok() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.request_session_ok() $$;

create function tests.hd_session_ok(p_user uuid, p_session uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$ select private.display_session_ok(p_user, p_session) $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A with Bob (Member) and Carol (Administrator, no capabilities). Erin
-- owns Home B.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob')),
  ('carol', tests.user_id('carol'));

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into ids values ('erin', gen_random_uuid());
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (tests.hd('erin'), 'authenticated', 'authenticated', 'erin@displays.madeora.test',
          '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000', now(), '{}', '{}',
          now(), now());
select tests.act_as_user(tests.hd('erin'));
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.hd('home-a'), tests.hd('bob'), 'member'),
  (tests.hd('home-a'), tests.hd('carol'), 'administrator');

-- The tablet asks for a code (web server only) ------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.display_pairing_start(tests.hd_key('s1'), tests.hd_key('c1'), tests.hd_key('ip1'), '')$$,
  'A visitor cannot create pairing requests directly');
select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.display_pairing_start(tests.hd_key('s1'), tests.hd_key('c1'), tests.hd_key('ip1'), '')$$,
  'A signed-in member cannot create pairing requests directly');
select tests.assert_denied($$select * from public.display_pairing_status(tests.hd_key('s1'))$$,
  'Nor read a request''s status');
select tests.assert_denied($$select * from public.display_pairing_claim(tests.hd_key('s1'))$$,
  'Nor claim one');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome = 'created' and expires_at between now() + interval '9 minutes'
                                                and now() + interval '10 minutes'
   from public.display_pairing_start(tests.hd_key('s1'), tests.hd_key('c1'), tests.hd_key('ip1'),
     'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')),
  'A tablet gets a code that expires within 10 minutes');
select tests.assert_true(
  (select status = 'pending' from public.display_pairing_status(tests.hd_key('s1'))),
  'Its request is pending');
select tests.assert_true(
  (select outcome from public.display_pairing_start(tests.hd_key('s2'), tests.hd_key('c1'),
     tests.hd_key('ip1'), '')) = 'collision',
  'Two pending requests never share a code');
select tests.assert_true(
  (select status from public.display_pairing_status(tests.hd_key('nope'))) = 'unknown',
  'An unknown secret has no request');
select tests.assert_true(
  (select outcome from public.display_pairing_claim(tests.hd_key('s1'))) = 'invalid',
  'A pending request cannot be claimed');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.display_pairing_requests
              where secret_hash = tests.hd_key('s1') and (device_kind <> 'tablet' or browser <> 'safari')),
  'Only device labels are kept from the user agent');

-- Throttle: 30 codes per client address per hour.
select tests.act_as_service_role();
select count(*) from generate_series(3, 31) g,
  lateral public.display_pairing_start(tests.hd_key('t' || g), tests.hd_key('tc' || g),
    tests.hd_key('ip-busy'), '');
select tests.assert_true(
  (select outcome from public.display_pairing_start(tests.hd_key('t32'), tests.hd_key('tc32'),
     tests.hd_key('ip-busy'), '')) = 'created',
  'Fixture: the 30th code from one client is still created');
select tests.assert_true(
  (select outcome from public.display_pairing_start(tests.hd_key('t33'), tests.hd_key('tc33'),
     tests.hd_key('ip-busy'), '')) = 'rate_limited',
  'The 31st code within an hour from one client is refused');

-- A manager checks the code ----------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select * from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c1'))$$,
  'A visitor cannot look a code up');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c1')))
    = 'not_permitted',
  'A Member cannot pair displays');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c1')))
    = 'not_permitted',
  'An Administrator without manageHomeSettings cannot pair displays');
select tests.act_as_user(tests.hd('erin'));
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c1')))
    = 'not_found',
  'A manager of another Home gets not_found for Home A');

select tests.act_as('alice');
insert into ids select 'req-1', request_id
  from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c1'))
  where outcome = 'found' and device_kind = 'tablet' and browser = 'safari';
select tests.assert_true(tests.hd('req-1') is not null,
  'The Owner finds the code and sees the tablet''s description');
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('wrong')))
    = 'invalid_code',
  'A wrong code is refused');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where home_id = tests.hd('home-a') and action = 'display.pairing_failed'
     and details = '{"reason": "invalid_code"}'),
  'A failed attempt is audited in the Home, with its reason only');

-- Approval ---------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-1'),
     tests.hd_key('c1'), 'Keuken')) = 'not_permitted',
  'A Member cannot approve a display');
select tests.act_as_user(tests.hd('erin'));
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-1'),
     tests.hd_key('c1'), 'Keuken')) = 'not_found',
  'Another Home''s manager cannot approve into Home A');
select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-1'), tests.hd_key('c1'), '')$$,
  'A display needs a name', '22023');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-1'),
     tests.hd_key('c-other'), 'Keuken')) = 'invalid_code',
  'Approval refuses a code that does not match the reviewed request (substitution)');

insert into ids select 'disp-1', display_id from public.approve_display_pairing(
  tests.hd('home-a'), tests.hd('req-1'), tests.hd_key('c1'), 'Keuken') where outcome = 'approved';
select tests.assert_true(tests.hd('disp-1') is not null, 'The Owner approves the display');
select tests.assert_true(
  (select outcome = 'approved' and display_id = tests.hd('disp-1')
   from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-1'), tests.hd_key('c1'),
     'Keuken')),
  'The same manager retrying the same approval gets the same display (interrupted response)');

select tests.act_as_owner();
insert into ids values ('disp-1-user', tests.hd_user(tests.hd('disp-1')));
select tests.assert_true(
  (select u.email = 'display-' || u.id || '@displays.madeora.invalid'
          and u.email_confirmed_at is not null and coalesce(u.encrypted_password, '') = ''
          and u.raw_app_meta_data ->> 'madeora_kind' = 'display'
   from auth.users u where u.id = tests.hd('disp-1-user')),
  'The display has its own account: internal alias, no password, display-only kind');
select tests.assert_true(
  not exists (select 1 from private.home_memberships_all where user_id = tests.hd('disp-1-user')),
  'The display is not a member of any Home');
select tests.assert_true(private.confirmed_email(tests.hd('disp-1-user')) is null
  and not private.can_receive_notifications(tests.hd('disp-1-user')),
  'The display is never a confirmed adult and receives no notifications');
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where home_id = tests.hd('home-a') and action = 'display.paired'
     and subject_id = tests.hd('disp-1') and actor_user_id = tests.hd('alice')),
  'Pairing is audited with the approving manager');

-- Concurrent claim and replay: a second manager, another Home, or the same code again.
select tests.act_as_user(tests.hd('erin'));
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-b'), tests.hd_key('c1')))
    = 'already_used',
  'Another Home''s manager finds the code already used');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-b'), tests.hd('req-1'),
     tests.hd_key('c1'), 'Gang')) = 'already_used',
  'And cannot pair the same tablet into Home B (cross-Home)');
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.hd('home-b'), tests.hd('alice'), 'member');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-b'), tests.hd('req-1'),
     tests.hd_key('c1'), 'Keuken')) = 'not_permitted',
  'The approving manager cannot re-point the approval at a Home they do not manage');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.household_displays)
  and (select home_id = tests.hd('home-a') from private.household_displays
       where id = tests.hd('disp-1')),
  'Exactly one display exists, in Home A');

-- The tablet claims its session ----------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(
  (select status from public.display_pairing_status(tests.hd_key('s1'))) = 'approved',
  'The tablet sees its approval');
select tests.assert_true(
  (select outcome = 'ready' and alias_email = 'display-' || tests.hd('disp-1-user') || '@displays.madeora.invalid'
   from public.display_pairing_claim(tests.hd_key('s1'))),
  'The tablet holding the secret gets the display''s alias');
select tests.assert_true(
  (select outcome from public.display_pairing_claim(tests.hd_key('c1'))) = 'invalid',
  'The code is not the claim secret');
insert into ids select 'sess-alice', tests.hd_session(tests.hd('alice'));
select tests.assert_true(
  public.display_pairing_complete(tests.hd_key('s1'), tests.hd('sess-alice')) = 'invalid',
  'Another account''s session cannot be registered for the display');
insert into ids select 'sess-1', tests.hd_session(tests.hd('disp-1-user'));
select tests.assert_true(
  public.display_pairing_complete(tests.hd_key('s1'), tests.hd('sess-1')) = 'registered',
  'The display''s new session is registered');
insert into ids select 'sess-replay', tests.hd_session(tests.hd('disp-1-user'));
select tests.assert_true(
  public.display_pairing_complete(tests.hd_key('s1'), tests.hd('sess-replay')) = 'invalid'
  and (select outcome from public.display_pairing_claim(tests.hd_key('s1'))) = 'invalid'
  and (select status from public.display_pairing_status(tests.hd_key('s1'))) = 'unknown',
  'A claimed request cannot be replayed');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-1'),
     tests.hd_key('c1'), 'Keuken')) = 'already_used',
  'Once claimed, even the approving manager cannot approve the request again');

-- A display's session is locked down ------------------------------------------------------------------------

select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-1'), '/rpc/display_me');
select tests.assert_allowed($$select public.check_request()$$,
  'A registered display session may call display_me');
select tests.assert_true(
  (select display_id = tests.hd('disp-1') and display_name = 'Keuken' and home_name = 'Thuis'
          and home_timezone = 'Europe/Brussels'
   from public.display_me()),
  'display_me shows the display and its Home');
select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-1'), '/rpc/home_household_displays');
select tests.assert_denied($$select public.check_request()$$,
  'A display session cannot call any other function', 'PT403');
select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-1'), '/homes');
select tests.assert_denied($$select public.check_request()$$,
  'A display session cannot read tables', 'PT403');
select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-1'), '/rpc/graphql');
select tests.assert_denied($$select public.check_request()$$,
  'A display session cannot use GraphQL', 'PT403');
select tests.assert_denied(
  $$select * from public.home_household_displays(tests.hd('home-a'))$$,
  'Functions behind require_confirmed_caller refuse a display (no manager rights inherited)');
select tests.assert_denied(
  $$select * from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c1'))$$,
  'A display cannot pair other displays');
select tests.assert_row_count($$select 1 from public.homes$$, 0,
  'RLS shows a display no Home row');
select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-1'), '');
select tests.assert_true(tests.hd_state() = 'display_session' and not tests.hd_realtime_ok(),
  'A live display session has its own state, so Realtime policies refuse it');

-- A session Madeora did not register (issued some other way) is not active.
select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-replay'), '/rpc/display_me');
select tests.assert_denied($$select public.check_request()$$,
  'A display session Madeora did not register is refused', 'PT401');
select tests.assert_denied($$select * from public.display_me()$$,
  'display_me refuses an unregistered session');

-- A member cannot use display functions.
select tests.act_as('alice');
select tests.assert_denied($$select * from public.display_me()$$,
  'display_me refuses an ordinary member session');

-- Guards on the display's Supabase Auth rows.
select tests.act_as_owner();
select tests.assert_denied(
  $$update auth.users set encrypted_password = '$2a$10$x' where id = tests.hd('disp-1-user')$$,
  'A display can never get a Supabase Auth password');
select tests.assert_denied(
  $$update auth.users set email = 'me@example.com' where id = tests.hd('disp-1-user')$$,
  'A display''s address cannot change');
select tests.assert_denied(
  $$update auth.users set raw_app_meta_data = '{"provider": "email"}' where id = tests.hd('disp-1-user')$$,
  'A display cannot stop being a display');
select tests.assert_denied(
  $$update auth.users set raw_app_meta_data = raw_app_meta_data || '{"madeora_kind": "display"}' where id = tests.hd('bob')$$,
  'An adult account cannot be turned into a display');
select tests.assert_denied(
  $$insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    values ('g-1', tests.hd('disp-1-user'), '{}', 'google', now(), now())$$,
  'A display cannot link a sign-in provider');
select tests.assert_allowed(
  $$update auth.users set last_sign_in_at = now() where id = tests.hd('disp-1-user')$$,
  'Supabase Auth can still record a display''s sign-in');

-- Managers: list, rename, limits ------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_denied($$select * from public.home_household_displays(tests.hd('home-a'))$$,
  'A Member cannot list displays');
select tests.assert_true(
  public.rename_household_display(tests.hd('home-a'), tests.hd('disp-1'), 'Gang') = 'not_permitted',
  'A Member cannot rename a display');
select tests.act_as_user(tests.hd('erin'));
select tests.assert_true(
  public.rename_household_display(tests.hd('home-b'), tests.hd('disp-1'), 'Gang') = 'not_found',
  'Another Home''s manager cannot rename Home A''s display through Home B');
select tests.act_as('alice');
select tests.assert_true(
  (select status = 'active' and name = 'Keuken' and paired_at is not null and last_seen_at is not null
   from public.home_household_displays(tests.hd('home-a')) where display_id = tests.hd('disp-1')),
  'The Owner sees the display as active, with when it was paired and last seen');
select tests.assert_true(
  public.rename_household_display(tests.hd('home-a'), tests.hd('disp-1'), 'Hal') = 'saved'
  and public.rename_household_display(tests.hd('home-a'), tests.hd('disp-1'), 'Hal') = 'unchanged',
  'The Owner renames the display');

-- Carol gets manageHomeSettings and can then pair a second display, independently.
select tests.act_as_owner();
insert into private.home_admin_capabilities (home_id, user_id, capability, granted_by)
  values (tests.hd('home-a'), tests.hd('carol'), 'manageHomeSettings', tests.hd('alice'));
select tests.act_as_service_role();
select public.display_pairing_start(tests.hd_key('s-two'), tests.hd_key('c-two'), tests.hd_key('ip2'), '');
select tests.act_as('carol');
insert into ids select 'req-2', request_id
  from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-two'));
insert into ids select 'disp-2', display_id from public.approve_display_pairing(
  tests.hd('home-a'), tests.hd('req-2'), tests.hd_key('c-two'), 'Woonkamer') where outcome = 'approved';
select tests.assert_true(tests.hd('disp-2') is not null,
  'An Administrator with manageHomeSettings pairs a second display');
select tests.assert_true(
  (select count(*) = 2 from public.home_household_displays(tests.hd('home-a')) where status = 'active'),
  'Two displays in one Home are listed independently');

-- Stale approval: the tablet asked for a new code after the manager reviewed the old one.
select tests.act_as_service_role();
select public.display_pairing_start(tests.hd_key('s-stale'), tests.hd_key('c-stale'), tests.hd_key('ip3'), '');
select tests.act_as('alice');
insert into ids select 'req-stale', request_id
  from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-stale'));
select tests.act_as_service_role();
select tests.assert_true(public.display_pairing_cancel(tests.hd_key('s-stale')),
  'The tablet cancels its code to get a new one');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-stale'),
     tests.hd_key('c-stale'), 'Oud')) = 'expired',
  'A stale approval of a cancelled code is refused');

-- Expired code.
select tests.act_as_service_role();
select public.display_pairing_start(tests.hd_key('s-old'), tests.hd_key('c-old'), tests.hd_key('ip3'), '');
select tests.act_as('alice');
insert into ids select 'req-old', request_id
  from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-old'));
select tests.act_as_owner();
update private.display_pairing_requests set expires_at = now() - interval '1 second'
  where id = tests.hd('req-old');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-old')))
    = 'expired'
  and (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-old'),
         tests.hd_key('c-old'), 'Oud')) = 'expired',
  'An expired code can be neither checked nor approved');
select tests.act_as_service_role();
select tests.assert_true(
  (select status from public.display_pairing_status(tests.hd_key('s-old'))) = 'expired',
  'The tablet sees its code expired');

-- Claim window: an approval not claimed within 10 minutes cannot be claimed.
select public.display_pairing_start(tests.hd_key('s-late'), tests.hd_key('c-late'), tests.hd_key('ip3'), '');
select tests.act_as('alice');
insert into ids select 'req-late', request_id
  from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-late'));
insert into ids select 'disp-late', display_id from public.approve_display_pairing(
  tests.hd('home-a'), tests.hd('req-late'), tests.hd_key('c-late'), 'Laat');
select tests.act_as_owner();
update private.display_pairing_requests set approved_at = now() - interval '11 minutes'
  where id = tests.hd('req-late');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_pairing_claim(tests.hd_key('s-late'))) = 'invalid'
  and (select status from public.display_pairing_status(tests.hd_key('s-late'))) = 'expired',
  'An approval left unclaimed past the claim window cannot be claimed');

-- Limit: at most 10 active displays per Home.
select tests.act_as_service_role();
select public.display_pairing_start(tests.hd_key('s-many'), tests.hd_key('c-many'), tests.hd_key('ip4'), '');
select tests.act_as('alice');
insert into ids select 'req-many', request_id
  from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-many'));
select tests.act_as_owner();
-- disp-1, disp-2 and disp-late are active: seven more real ones reach the limit of 10.
insert into ids select 'acct-' || g, gen_random_uuid() from generate_series(1, 7) g;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', i.id, 'authenticated', 'authenticated',
         'display-' || i.id || '@displays.madeora.invalid', '', now(),
         '{"madeora_kind": "display"}', '{}', now(), now()
  from pg_temp.ids i where i.name like 'acct-%';
insert into private.household_displays (home_id, user_id, name, device_kind, browser, platform)
  select tests.hd('home-a'), i.id, 'Extra', 'tablet', 'safari', 'ios'
  from pg_temp.ids i where i.name like 'acct-%';
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.approve_display_pairing(tests.hd('home-a'), tests.hd('req-many'),
     tests.hd_key('c-many'), 'Teveel')) = 'limit_reached',
  'An 11th active display is refused');

-- Wrong-code throttle: 10 wrong codes per manager per 15 minutes.
select tests.act_as('carol');
select count(*) from generate_series(1, 10) g,
  lateral public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('guess' || g));
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-many')))
    = 'rate_limited',
  'After 10 wrong codes even a right one is refused for a while');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome from public.check_display_pairing_code(tests.hd('home-a'), tests.hd_key('c-many')))
    = 'found',
  'The throttle is per manager');

-- Revocation -------------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  public.revoke_household_display(tests.hd('home-a'), tests.hd('disp-1')) = 'not_permitted',
  'A Member cannot revoke a display');
select tests.act_as_user(tests.hd('erin'));
select tests.assert_true(
  public.revoke_household_display(tests.hd('home-b'), tests.hd('disp-1')) = 'not_found',
  'Another Home''s manager cannot revoke Home A''s display');
select tests.act_as('alice');
select tests.assert_true(
  public.revoke_household_display(tests.hd('home-a'), tests.hd('disp-1')) = 'revoked'
  and public.revoke_household_display(tests.hd('home-a'), tests.hd('disp-1')) = 'unchanged',
  'The Owner revokes the lost display');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from auth.users where id = tests.hd('disp-1-user'))
  and not exists (select 1 from auth.sessions where user_id = tests.hd('disp-1-user'))
  and (select ended_at is not null from private.display_sessions where session_id = tests.hd('sess-1')),
  'Revoking deletes the display''s account with every session');
select tests.hd_act_as_display(tests.hd('disp-1-user'), tests.hd('sess-1'), '/rpc/display_me');
select tests.assert_denied($$select public.check_request()$$,
  'The revoked display''s old token is refused', 'PT401');
select tests.act_as('alice');
select tests.assert_true(
  (select status = 'revoked' and revoked_at is not null
   from public.home_household_displays(tests.hd('home-a')) where display_id = tests.hd('disp-1')),
  'The revoked display stays listed as revoked');
select tests.assert_true(
  public.rename_household_display(tests.hd('home-a'), tests.hd('disp-1'), 'Terug') = 'not_found',
  'A revoked display cannot be renamed');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.revoked' and subject_id = tests.hd('disp-1')),
  'Revocation is audited');

-- Closing the Home refuses every display session at once; purging it deletes the accounts.
select tests.act_as_service_role();
select public.display_pairing_claim(tests.hd_key('s-two'));
insert into ids select 'disp-2-user', tests.hd_user(tests.hd('disp-2'));
insert into ids select 'sess-2', tests.hd_session(tests.hd('disp-2-user'));
select tests.assert_true(
  public.display_pairing_complete(tests.hd_key('s-two'), tests.hd('sess-2')) = 'registered',
  'Fixture: the second display is signed in');
select tests.assert_true(tests.hd_session_ok(tests.hd('disp-2-user'), tests.hd('sess-2')),
  'Fixture: its session is usable');
select tests.act_as_owner();
insert into private.home_deletions (home_id, requested_by, purge_after)
  values (tests.hd('home-a'), tests.hd('alice'), now() + interval '30 days');
select tests.assert_true(not tests.hd_session_ok(tests.hd('disp-2-user'), tests.hd('sess-2')),
  'A closed Home''s displays are refused at once');
select private.purge_home(tests.hd('home-a'));
select tests.assert_true(
  not exists (select 1 from auth.users where id = tests.hd('disp-2-user'))
  and not exists (select 1 from auth.users u where u.raw_app_meta_data ->> 'madeora_kind' = 'display'
                    and u.id in (select id from pg_temp.ids where name like 'acct-%')),
  'Purging the Home deletes its displays'' accounts');
