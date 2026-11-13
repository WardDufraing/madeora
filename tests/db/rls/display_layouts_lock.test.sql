-- S44: Household Display layouts, privacy lock and member actions
-- (supabase/migrations/20261204090000_display_layouts_lock.sql). What a display may read (only
-- shared-display-safe data, nothing while locked), per-display configuration with conflict
-- detection, the lock from a manager's session and on the display with a manager's PIN, chore
-- actions attributed to the member with the display as origin, Realtime signal visibility, and
-- revocation, former members and other Homes.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated, service_role;

create function tests.dl(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.dl_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

create function tests.dl_child(p_child_membership uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select m.user_id from private.home_memberships_all m where m.id = p_child_membership $$;

create function tests.dl_hash(p_seed text) returns text
  language sql immutable
  as $$
    select 'scrypt$15$8$1$' || substr(translate(encode(sha256(convert_to('s' || p_seed, 'UTF8')),
             'base64'), '+/=', '-_'), 1, 22)
      || '$' || substr(translate(encode(sha256(convert_to('k' || p_seed, 'UTF8')), 'base64'),
             '+/=', '-_'), 1, 43)
  $$;

create function tests.dl_key(p_seed text) returns text
  language sql immutable
  as $$ select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex') $$;

create function tests.dl_today() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date $$;

-- A paired display with a registered session, as S43's pairing leaves it (built directly here).
create function tests.dl_display(p_home uuid, p_name text, out display_id uuid, out user_id uuid,
  out session_id uuid)
  language plpgsql security definer set search_path = ''
  as $$
  begin
    user_id := gen_random_uuid();
    session_id := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', user_id, 'authenticated', 'authenticated',
              private.display_alias_email(user_id), '', now(),
              '{"provider": "madeora_display", "providers": [], "madeora_kind": "display"}',
              '{}', now(), now());
    insert into private.household_displays (home_id, user_id, name, device_kind, browser, platform)
      values (p_home, user_id, p_name, 'tablet', 'safari', 'ios')
      returning id into display_id;
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
      values (session_id, user_id, now(), now(), 'aal1');
    insert into private.display_sessions (session_id, display_id) values (session_id, display_id);
  end
  $$;

-- Act as a display in its session, as PostgREST does for a request on p_path.
create function tests.dl_as_display(p_name text, p_path text) returns void
  language plpgsql
  as $$
  begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', tests.dl(p_name || '-user'), 'role', 'authenticated',
                         'aud', 'authenticated', 'session_id', tests.dl(p_name || '-session'),
                         'app_metadata', jsonb_build_object('madeora_kind', 'display'))::text,
      true);
    perform set_config('request.path', p_path, true);
  end
  $$;

create function tests.dl_occ(p_id uuid) returns table (status text, completed_by uuid)
  language sql stable security definer set search_path = ''
  as $$ select o.status, o.completed_by from private.chore_occurrences o where o.id = p_id $$;

create function tests.dl_signal(p_display uuid) returns bigint
  language sql stable security definer set search_path = ''
  as $$ select coalesce((select s.version from public.display_signals s where s.display_id = p_display), 0) $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A ("Thuis") with Bob (Member), Carol (Administrator without
-- capabilities) and Mia (child, PIN for Home A). Alice has a household-device PIN. Erin owns Home B.
-- Home A has a kitchen and a living-room display, Home B one. Chores for Mia, Bob and nobody; a
-- Home shopping list with an item that has a note, and Alice's personal list.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob')),
  ('carol', tests.user_id('carol'));
select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into ids values ('erin', gen_random_uuid());
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (tests.dl('erin'), 'authenticated', 'authenticated', 'erin@displays.madeora.test',
          '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000', now(), '{}', '{}',
          now(), now());
select tests.act_as_user(tests.dl('erin'));
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.dl('home-a'), tests.dl('bob'), 'member'),
  (tests.dl('home-a'), tests.dl('carol'), 'administrator');
insert into ids values ('m-alice', tests.dl_mid(tests.dl('home-a'), tests.dl('alice'))),
  ('m-bob', tests.dl_mid(tests.dl('home-a'), tests.dl('bob'))),
  ('m-carol', tests.dl_mid(tests.dl('home-a'), tests.dl('carol'))),
  ('m-erin', tests.dl_mid(tests.dl('home-b'), tests.dl('erin')));
select tests.act_as('alice');
insert into ids select 'm-mia', membership_id from public.create_child(
  tests.dl('home-a'), 'Mia', tests.dl('m-alice'), null, '#16a34a', gen_random_uuid());
insert into ids values ('mia', tests.dl_child(tests.dl('m-mia')));
select public.set_child_credential(tests.dl('home-a'), tests.dl('m-mia'), 'pin',
  tests.dl_hash('mia-pin'));
select public.set_my_device_pin(tests.dl_hash('alice-pin'));
insert into ids values ('c-mia', gen_random_uuid()), ('c-bob', gen_random_uuid()),
  ('c-any', gen_random_uuid());
insert into ids select 'o-mia', occurrence_id from public.create_chore(tests.dl('c-mia'),
  tests.dl('home-a'), 'Feed the cat',
  jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.dl('m-mia'))),
  p_due_date => tests.dl_today());
insert into ids select 'o-bob', occurrence_id from public.create_chore(tests.dl('c-bob'),
  tests.dl('home-a'), 'Bins',
  jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(tests.dl('m-bob'))),
  p_due_date => tests.dl_today());
insert into ids select 'o-any', occurrence_id from public.create_chore(tests.dl('c-any'),
  tests.dl('home-a'), 'Dishes', '{"mode": "none", "members": []}', p_due_date => tests.dl_today());
insert into ids values ('l-home', gen_random_uuid()), ('l-mine', gen_random_uuid());
select public.create_shopping_list(tests.dl('l-home'), 'Groceries', tests.dl('home-a'));
select public.create_shopping_list(tests.dl('l-mine'), 'My secret list');
select count(*) from public.add_shopping_items(tests.dl('l-home'), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'name', 'Milk', 'quantity', '2', 'unit', null,
                     'packaging', null, 'notes', 'private note for Bob', 'categoryId', null,
                     'allowDuplicate', false)));
select count(*) from public.add_shopping_items(tests.dl('l-mine'), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'name', 'Birthday gift', 'quantity', null,
                     'unit', null, 'packaging', null, 'notes', null, 'categoryId', null,
                     'allowDuplicate', false)));
select tests.act_as_owner();
insert into ids select 'kitchen', display_id from tests.dl_display(tests.dl('home-a'), 'Keuken') d;
insert into ids select 'kitchen-user', d.user_id from private.household_displays d
  where d.id = tests.dl('kitchen');
insert into ids select 'kitchen-session', ds.session_id from private.display_sessions ds
  where ds.display_id = tests.dl('kitchen');
insert into ids select 'living', display_id from tests.dl_display(tests.dl('home-a'), 'Woonkamer') d;
insert into ids select 'living-user', d.user_id from private.household_displays d
  where d.id = tests.dl('living');
insert into ids select 'living-session', ds.session_id from private.display_sessions ds
  where ds.display_id = tests.dl('living');
insert into ids select 'hall-b', display_id from tests.dl_display(tests.dl('home-b'), 'Gang') d;
insert into ids select 'hall-b-user', d.user_id from private.household_displays d
  where d.id = tests.dl('hall-b');
insert into ids select 'hall-b-session', ds.session_id from private.display_sessions ds
  where ds.display_id = tests.dl('hall-b');
select tests.assert_true(tests.dl('o-any') is not null and tests.dl('hall-b-session') is not null,
  'Fixture: Homes, members, chores, lists and three displays');

-- The board: only the display's own session, only shared-display-safe data -----------------------------------

select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_allowed($$select public.check_request()$$,
  'A display session may call display_board');
select tests.assert_true(
  (select b ->> 'home_name' = 'Thuis' and b ->> 'display_name' = 'Keuken'
          and not (b ->> 'locked')::boolean and b -> 'layout' = 'null'::jsonb
          and (b ->> 'actions')::boolean
          and jsonb_array_length(b -> 'chores') = 3 and jsonb_array_length(b -> 'members') = 4
          and jsonb_array_length(b -> 'shopping') = 1
          and b -> 'shopping' -> 0 ->> 'name' = 'Groceries'
          and b -> 'shopping' -> 0 -> 'items' -> 0 ->> 'name' = 'Milk'
          and (b -> 'shopping' -> 0 ->> 'remaining')::int = 1
   from (select public.display_board() b) x),
  'The kitchen display sees its Home''s chores, members and Home shopping list (default layout)');
select tests.assert_true(
  (select b::text not like '%My secret list%' and b::text not like '%Birthday gift%'
          and b::text not like '%private note%' and b::text not like '%scrypt%'
          and b::text not like '%' || tests.dl('alice') || '%'
          and b::text not like '%@%'
   from (select public.display_board() b) x),
  'Never a personal list, an item note, a PIN hash, an account id or an email address');
select tests.assert_true(
  (select count(*) = 0 from jsonb_array_elements(public.display_board() -> 'chores') c
   where c ->> 'title' not in ('Feed the cat', 'Bins', 'Dishes')),
  'Only Home A''s chores');

select tests.dl_as_display('hall-b', '/rpc/display_board');
select tests.assert_true(
  (select b ->> 'home_name' = 'Kot' and jsonb_array_length(b -> 'chores') = 0
          and jsonb_array_length(b -> 'shopping') = 0
          and jsonb_array_length(b -> 'members') = 1
   from (select public.display_board() b) x),
  'Home B''s display sees nothing of Home A (multi-Home isolation)');

select tests.dl_as_display('kitchen', '/rpc/display_signals');
select tests.assert_denied($$select public.check_request()$$,
  'A display session still cannot read tables through the API', 'PT403');

select tests.act_as('alice');
select tests.assert_denied($$select public.display_board()$$,
  'A member session cannot read a display board');
select tests.act_as_anon();
select tests.assert_denied($$select public.display_board()$$, 'Nor a visitor');

-- Realtime signals --------------------------------------------------------------------------------------------

-- The chore and shopping signals move at commit (deferred); fire them now, as a commit would.
set constraints all immediate;
select tests.act_as('bob');
select count(*) from public.complete_chore_occurrence(tests.dl('o-bob'), tests.dl('m-bob'), null);
select tests.act_as_owner();
select tests.assert_true(
  tests.dl_signal(tests.dl('kitchen')) >= 1 and tests.dl_signal(tests.dl('living')) >= 1
  and tests.dl_signal(tests.dl('hall-b')) = 0,
  'A chore change in Home A moves the signals of Home A''s displays only');
select tests.act_as('bob');
select count(*) from public.reopen_chore_occurrence(tests.dl('o-bob'));

select tests.dl_as_display('kitchen', '');
select tests.assert_row_count($$select 1 from public.display_signals$$, 1,
  'A display''s Realtime sees its own signal row only');
select tests.assert_true(
  (select display_id = tests.dl('kitchen') from public.display_signals),
  'And it is its own');
select tests.act_as('alice');
select tests.assert_row_count($$select 1 from public.display_signals$$, 0,
  'A member sees no display signals');

-- Configuration ------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_denied(
  $$select public.household_display_config(tests.dl('home-a'), tests.dl('kitchen'))$$,
  'A Member cannot read a display''s configuration', '42501');
select tests.act_as('carol');
select tests.assert_denied(
  $$select public.household_display_config(tests.dl('home-a'), tests.dl('kitchen'))$$,
  'Nor an Administrator without manageHomeSettings', '42501');
select tests.act_as_user(tests.dl('erin'));
select tests.assert_denied(
  $$select public.household_display_config(tests.dl('home-a'), tests.dl('kitchen'))$$,
  'Nor another Home''s manager', '42501');
select tests.assert_true(
  public.household_display_config(tests.dl('home-b'), tests.dl('kitchen')) is null,
  'Erin cannot reach Home A''s display through her own Home');

select tests.act_as('alice');
select tests.assert_true(
  (select c -> 'layout' = 'null'::jsonb and (c ->> 'revision')::int = 1
          and c ->> 'orientation' = 'auto' and (c ->> 'applied')::boolean
          and jsonb_array_length(c -> 'shopping_lists') = 1
   from (select public.household_display_config(tests.dl('home-a'), tests.dl('kitchen')) c) x),
  'The Owner sees the kitchen''s defaults, applied, and the Home''s lists (not her personal one)');

select tests.assert_denied(
  $$select * from public.save_household_display_config(tests.dl('home-a'), tests.dl('kitchen'), 1,
      '{"version": 1, "widgets": [{"id": "6f1c1b2e-1111-4111-8111-111111111111", "type": "calendar", "size": "small", "config": {}}]}',
      'auto', 'auto', 'comfortable', 'auto')$$,
  'A widget outside the display catalogue is refused', '22023');
select tests.assert_denied(
  $$select * from public.save_household_display_config(tests.dl('home-a'), tests.dl('kitchen'), 1,
      '{"version": 1, "widgets": [{"id": "6f1c1b2e-1111-4111-8111-111111111111", "type": "clock", "size": "small", "config": {}}, {"id": "6f1c1b2e-1111-4111-8111-111111111111", "type": "chores", "size": "large", "config": {}}]}',
      'auto', 'auto', 'comfortable', 'auto')$$,
  'Duplicate widget ids are refused', '22023');
select tests.assert_denied(
  $$select * from public.save_household_display_config(tests.dl('home-a'), tests.dl('kitchen'), 1,
      null, 'sideways', 'auto', 'comfortable', 'auto')$$,
  'An unknown orientation is refused', '22023');

select tests.assert_true(
  (select outcome = 'saved' and revision = 2
   from public.save_household_display_config(tests.dl('home-a'), tests.dl('kitchen'), 1,
     '{"version": 1, "widgets": [{"id": "6f1c1b2e-1111-4111-8111-111111111111", "type": "chores", "size": "large", "config": {"actions": false, "count": 10}}]}',
     'portrait', 'dark', 'compact', '24h')),
  'The Owner saves a portrait kitchen layout with read-only chores');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2
   from public.save_household_display_config(tests.dl('home-a'), tests.dl('kitchen'), 1,
     null, 'auto', 'auto', 'comfortable', 'auto')),
  'A second manager''s edit from the old revision is a conflict, never a silent overwrite');
select tests.assert_true(
  (select not (c ->> 'applied')::boolean and c ->> 'orientation' = 'portrait'
   from (select public.household_display_config(tests.dl('home-a'), tests.dl('kitchen')) c) x),
  'Until the display reads it, the change shows as not applied yet');
select tests.assert_true(
  (select c -> 'layout' = 'null'::jsonb and (c ->> 'revision')::int = 1
   from (select public.household_display_config(tests.dl('home-a'), tests.dl('living')) c) x),
  'The living-room display keeps its own configuration');
select tests.act_as_user(tests.dl('erin'));
select tests.assert_true(
  (select outcome from public.save_household_display_config(tests.dl('home-b'), tests.dl('kitchen'), 2,
     null, 'auto', 'auto', 'comfortable', 'auto')) = 'not_found',
  'Another Home''s manager cannot change it through their own Home');

select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_true(
  (select b ->> 'orientation' = 'portrait' and b ->> 'theme' = 'dark'
          and b -> 'layout' -> 'widgets' -> 0 ->> 'type' = 'chores'
          and not (b ->> 'actions')::boolean and jsonb_array_length(b -> 'members') = 0
   from (select public.display_board() b) x),
  'The kitchen shows its new layout; with actions off it gets no member list');
select tests.act_as('alice');
select tests.assert_true(
  (select (c ->> 'applied')::boolean
   from (select public.household_display_config(tests.dl('home-a'), tests.dl('kitchen')) c) x),
  'Once the display read it, the change shows as applied');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-bob'), false, tests.dl_key('c1'))) = 'actions_off',
  'With actions off, the server refuses member actions on that display');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' and revision = 3
   from public.save_household_display_config(tests.dl('home-a'), tests.dl('kitchen'), 2,
     null, 'auto', 'auto', 'comfortable', 'auto')),
  'Restoring the defaults is a save of the default layout');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.configured' and subject_id = tests.dl('kitchen')
     and actor_user_id = tests.dl('alice'))
  and (select count(*) = 1 from private.audit_events
       where action = 'display.config_reset' and subject_id = tests.dl('kitchen')),
  'Configuration changes are audited');

-- Privacy lock from a manager's session --------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  public.set_household_display_lock(tests.dl('home-a'), tests.dl('kitchen'), true, null)
    = 'not_permitted',
  'A Member cannot lock a display');
select tests.act_as('alice');
select tests.assert_denied(
  $$select public.set_household_display_lock(tests.dl('home-a'), tests.dl('kitchen'), true, ' padded ')$$,
  'A welcome message follows the visible-text rule', '22023');
select tests.assert_true(
  public.set_household_display_lock(tests.dl('home-a'), tests.dl('kitchen'), true, 'Welkom!')
    = 'saved',
  'The Owner locks the kitchen display remotely with a welcome message');

select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_true(
  (select (b ->> 'locked')::boolean and b ->> 'lock_message' = 'Welkom!'
          and not (b ? 'home_name') and not (b ? 'display_name') and not (b ? 'chores')
          and not (b ? 'members') and not (b ? 'shopping') and not (b ? 'layout')
          and b::text not like '%Thuis%' and b::text not like '%Dishes%'
          and b::text not like '%Milk%' and b::text not like '%Mia%'
   from (select public.display_board() b) x),
  'The locked display gets the lock screen only: no Home or display name, chores, members or lists');
select tests.dl_as_display('living', '/rpc/display_board');
select tests.assert_true(not (public.display_board() ->> 'locked')::boolean,
  'Locking the kitchen does not lock the living room');

-- "Restart": a new registered session for the same display is still locked.
select tests.act_as_owner();
insert into ids values ('kitchen-session-old', tests.dl('kitchen-session'));
update pg_temp.ids set id = gen_random_uuid() where name = 'kitchen-session';
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (tests.dl('kitchen-session'), tests.dl('kitchen-user'), now(), now(), 'aal1');
insert into private.display_sessions (session_id, display_id)
  values (tests.dl('kitchen-session'), tests.dl('kitchen'));
select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_true((public.display_board() ->> 'locked')::boolean,
  'The lock survives a restart (it lives on the server)');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-bob'), false, tests.dl_key('c1'))) = 'display_locked',
  'No member action while locked');

-- On the display: nothing unlocks it --------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-alice'), tests.dl_key('c1'))$$,
  'A member session cannot call the display''s lock functions');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-alice'),
     tests.dl_key('c1'))) = 'unchanged',
  'Even a manager''s PIN on the display does nothing to a locked display (no on-display unlock)');
select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_true((public.display_board() ->> 'locked')::boolean,
  'So the kitchen stays locked');

select tests.act_as('alice');
select tests.assert_true(
  public.set_household_display_lock(tests.dl('home-a'), tests.dl('kitchen'), false, 'Welkom!')
    = 'saved',
  'The Owner unlocks it from her own session');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.unlocked' and subject_id = tests.dl('kitchen')
     and details ->> 'via' = 'manager_session' and actor_user_id = tests.dl('alice'))
  and (select count(*) = 1 from private.audit_events
       where action = 'display.locked' and subject_id = tests.dl('kitchen')),
  'Locking and unlocking are audited');
select tests.assert_true(
  (select lock_message = 'Welkom!' and not locked from private.display_configs
   where display_id = tests.dl('kitchen')),
  'The welcome message is kept for next time');

-- On the display: locking needs a manager's own PIN -----------------------------------------------------------

select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_true(
  (select jsonb_array_length(m) = 1 and m -> 0 ->> 'membership_id' = tests.dl('m-alice')::text
   from (select public.display_board() -> 'lock_managers' m) x),
  'The display offers the Home''s managers only for locking it');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-bob'),
     tests.dl_key('c1'))) = 'not_permitted',
  'A Member cannot lock the display');
select tests.assert_true(
  (select outcome from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-mia'),
     tests.dl_key('c1'))) = 'not_permitted',
  'Nor a child');
select tests.assert_true(
  (select outcome from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-carol'),
     tests.dl_key('c1'))) = 'not_permitted',
  'Nor an Administrator without manageHomeSettings');
select tests.assert_true(
  (select outcome from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-erin'),
     tests.dl_key('c1'))) = 'not_permitted',
  'Nor another Home''s manager');
insert into ids select 'lock-check', check_id from public.display_lock_attempt(
  tests.dl('kitchen'), tests.dl('m-alice'), tests.dl_key('c1'))
  where outcome = 'check' and pin_hash = tests.dl_hash('alice-pin');
select tests.assert_true(tests.dl('lock-check') is not null,
  'Alice''s lock asks the web server to compare her PIN');
select tests.assert_true(
  public.display_lock_verified(tests.dl('living'), tests.dl('lock-check')) = 'invalid',
  'A check from the kitchen cannot be used on another display');
select tests.assert_true(
  public.display_lock_verified(tests.dl('kitchen'), tests.dl('lock-check')) = 'saved',
  'After the PIN matched, the kitchen is locked');
select tests.assert_true(
  public.display_lock_verified(tests.dl('kitchen'), tests.dl('lock-check')) = 'invalid',
  'A check is used once');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.locked' and subject_id = tests.dl('kitchen')
     and details ->> 'via' = 'display_pin' and details ->> 'member' = tests.dl('m-alice')::text),
  'The on-display lock is audited with the manager who confirmed it');
select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_true(
  (select (b ->> 'locked')::boolean and b ->> 'lock_message' = 'Welkom!' and not (b ? 'lock_managers')
   from (select public.display_board() b) x),
  'Locked, with its message, and no names at all');
select tests.act_as('alice');
select public.set_household_display_lock(tests.dl('home-a'), tests.dl('kitchen'), false, null);

-- Member actions ---------------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_denied(
  $$select * from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'), tests.dl('m-bob'), false, tests.dl_key('c1'))$$,
  'A member session cannot act through a display''s functions');

select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-bob'),
     tests.dl('m-mia'), false, tests.dl_key('c1'))) = 'not_eligible',
  'A child cannot be named for someone else''s chore');
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-erin'), false, tests.dl_key('c1'))) = 'not_eligible',
  'A member of another Home is refused');
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('hall-b'), tests.dl('o-any'),
     tests.dl('m-erin'), false, tests.dl_key('c1'))) = 'not_eligible',
  'Another Home''s display cannot reach Home A''s chores');

insert into ids select 'a-any', action_id from public.display_chore_attempt(
  tests.dl('kitchen'), tests.dl('o-any'), tests.dl('m-bob'), false, tests.dl_key('c1'))
  where outcome = 'completed';
select tests.assert_true(tests.dl('a-any') is not null,
  'Bob completes the dishes on the kitchen display');
select tests.assert_true(
  (select status = 'completed' and completed_by = tests.dl('bob') from tests.dl_occ(tests.dl('o-any'))),
  'Attributed to Bob, not to the display');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'chore_occurrence.display_completed' and subject_id = tests.dl('o-any')
     and details ->> 'display_id' = tests.dl('kitchen')::text
     and details ->> 'member' = tests.dl('m-bob')::text
     and details ->> 'verification' = 'attributed'),
  'The audit records the member and, separately, the display as the device origin');
select tests.act_as_service_role();
select tests.assert_true(
  public.display_chore_undo(tests.dl('living'), tests.dl('a-any')) = 'invalid',
  'Another display cannot undo it');
select tests.assert_true(public.display_chore_undo(tests.dl('kitchen'), tests.dl('a-any')) = 'undone',
  'The kitchen display can undo it');
select tests.assert_true(
  (select status = 'open' from tests.dl_occ(tests.dl('o-any'))), 'The chore is open again');

insert into ids select 'mia-check', check_id from public.display_chore_attempt(
  tests.dl('kitchen'), tests.dl('o-mia'), tests.dl('m-mia'), true, tests.dl_key('c1'))
  where outcome = 'check' and pin_hash = tests.dl_hash('mia-pin');
select tests.assert_true(tests.dl('mia-check') is not null,
  'Mia confirms her chore with her PIN (compared by the web server)');
select tests.assert_true(
  (select outcome from public.display_chore_verified(tests.dl('living'), tests.dl('mia-check'))) = 'invalid',
  'Her check cannot be used on another display');
select tests.assert_true(
  (select outcome = 'completed' and action_id is not null
   from public.display_chore_verified(tests.dl('kitchen'), tests.dl('mia-check'))),
  'After the PIN matched, the chore is completed as Mia');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'chore_occurrence.display_completed' and subject_id = tests.dl('o-mia')
     and details ->> 'verification' = 'pin'),
  'Recorded as PIN-verified');

-- Required PIN: the Home's rule applies on displays too.
select tests.act_as('alice');
select public.set_shared_device_pin_rule(tests.dl('home-a'), true);
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-bob'), false, tests.dl_key('c1'))) = 'pin_required',
  'When the Home requires a PIN, a display action without one is refused');
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-bob'), true, tests.dl_key('c1'))) = 'pin_not_set',
  'A member without a PIN is told so');
select tests.act_as('alice');
select public.set_shared_device_pin_rule(tests.dl('home-a'), false);

-- A former member: Bob leaves Home A; his cached selection is refused.
select tests.act_as('bob');
select public.leave_home(tests.dl('home-a'));
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-bob'), false, tests.dl_key('c1'))) = 'not_eligible',
  'A former member''s cached selection is rejected');

-- Alice locks the living room on the display with her PIN.
insert into ids select 'lock-check-2', check_id from public.display_lock_attempt(
  tests.dl('living'), tests.dl('m-alice'), tests.dl_key('c1')) where outcome = 'check';
select tests.assert_true(
  public.display_lock_verified(tests.dl('living'), tests.dl('lock-check-2')) = 'saved',
  'Alice locks the living room on the display with her PIN');
select tests.dl_as_display('living', '/rpc/display_board');
select tests.assert_true((public.display_board() ->> 'locked')::boolean, 'The living room is locked');

-- Revocation ---------------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.revoke_household_display(tests.dl('home-a'), tests.dl('kitchen'));
select tests.dl_as_display('kitchen', '/rpc/display_board');
select tests.assert_denied($$select public.check_request()$$,
  'A revoked display''s token is refused', 'PT401');
select tests.assert_denied($$select public.display_board()$$,
  'And its board is refused');
select tests.act_as_service_role();
select tests.assert_true(
  (select outcome from public.display_chore_attempt(tests.dl('kitchen'), tests.dl('o-any'),
     tests.dl('m-alice'), false, tests.dl_key('c1'))) = 'display_not_active',
  'A revoked display cannot act');
select tests.assert_true(
  (select outcome from public.display_lock_attempt(tests.dl('kitchen'), tests.dl('m-alice'),
     tests.dl_key('c1'))) = 'display_not_active',
  'Nor lock itself');
select tests.act_as('alice');
select tests.assert_true(
  public.household_display_config(tests.dl('home-a'), tests.dl('kitchen')) is null
  and public.set_household_display_lock(tests.dl('home-a'), tests.dl('kitchen'), false, null) = 'not_found',
  'Its configuration is gone from managers'' reach');
