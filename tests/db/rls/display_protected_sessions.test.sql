-- UX8a: protected-action sessions and ambient timing on Household Displays
-- (supabase/migrations/20261222090000_display_protected_sessions.sql). A matched PIN opens a
-- five-minute session for that member on that display only; while it counts, that member's
-- PIN-gated actions there need no PIN; it never widens what they may do; it ends on expiry, Lock
-- now, privacy lock, revocation, leaving the Home and a changed PIN; the privacy lock still cannot
-- be lifted from the display. The Home's ambient timing is for its managers only.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated, service_role;

create function tests.ps(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.ps_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

create function tests.ps_child(p_child_membership uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$ select m.user_id from private.home_memberships_all m where m.id = p_child_membership $$;

create function tests.ps_hash(p_seed text) returns text
  language sql immutable
  as $$
    select 'scrypt$15$8$1$' || substr(translate(encode(sha256(convert_to('s' || p_seed, 'UTF8')),
             'base64'), '+/=', '-_'), 1, 22)
      || '$' || substr(translate(encode(sha256(convert_to('k' || p_seed, 'UTF8')), 'base64'),
             '+/=', '-_'), 1, 43)
  $$;

create function tests.ps_key(p_seed text) returns text
  language sql immutable
  as $$ select encode(sha256(convert_to(p_seed, 'UTF8')), 'hex') $$;

create function tests.ps_today() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date $$;

create function tests.ps_display(p_home uuid, p_name text) returns uuid
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_user uuid := gen_random_uuid();
    v_display uuid;
  begin
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated',
              private.display_alias_email(v_user), '', now(),
              '{"provider": "madeora_display", "providers": [], "madeora_kind": "display"}',
              '{}', now(), now());
    insert into private.household_displays (home_id, user_id, name, device_kind, browser, platform)
      values (p_home, v_user, p_name, 'tablet', 'safari', 'ios')
      returning id into v_display;
    return v_display;
  end
  $$;

-- A chore for the Home, due today; p_member null: nobody assigned.
create function tests.ps_chore(p_home uuid, p_title text, p_member uuid) returns uuid
  language plpgsql
  as $$
  declare
    v_occurrence uuid;
  begin
    select occurrence_id into v_occurrence from public.create_chore(gen_random_uuid(), p_home,
      p_title,
      case when p_member is null then '{"mode": "none", "members": []}'::jsonb
           else jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(p_member)) end,
      p_due_date => tests.ps_today());
    return v_occurrence;
  end
  $$;

-- PIN check then verification on a display, as the web server does after the PIN matched.
create function tests.ps_pin_complete(p_display uuid, p_occurrence uuid, p_membership uuid)
returns text
  language plpgsql
  as $$
  declare
    v_check uuid;
  begin
    select check_id into v_check from public.display_chore_attempt(p_display, p_occurrence,
      p_membership, true, tests.ps_key('ps'));
    if v_check is null then
      return 'no_check';
    end if;
    return (select outcome from public.display_chore_verified(p_display, v_check));
  end
  $$;

create function tests.ps_try(p_display uuid, p_occurrence uuid, p_membership uuid) returns text
  language sql
  as $$
    select outcome from public.display_chore_attempt(p_display, p_occurrence, p_membership, false,
                                                     tests.ps_key('ps'))
  $$;

create function tests.ps_verification(p_occurrence uuid) returns text
  language sql stable security definer set search_path = ''
  as $$
    select a.verification from private.display_actions a where a.occurrence_id = p_occurrence
    order by a.created_at desc limit 1
  $$;

create function tests.ps_signal(p_display uuid) returns bigint
  language sql stable security definer set search_path = ''
  as $$ select coalesce((select s.version from public.display_signals s where s.display_id = p_display), 0) $$;

create function tests.ps_sessions(p_display uuid) returns bigint
  language sql stable security definer set search_path = ''
  as $$ select count(*) from private.display_unlock_sessions s where s.display_id = p_display $$;

-- Moves a display's session back in time (a transaction's now() does not move).
create function tests.ps_age_session(p_display uuid, p_opened interval, p_left interval) returns void
  language sql security definer set search_path = ''
  as $$
    update private.display_unlock_sessions s
      set opened_at = now() - p_opened, expires_at = now() + p_left
      where s.display_id = p_display
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A with Bob (Member), Carol (Administrator without capabilities) and Mia
-- (child). Alice, Bob and Mia have PINs. Erin owns Home B. Home A has a kitchen and a living-room
-- display, Home B a hall display. The Home requires a PIN for every display action.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob')),
  ('carol', tests.user_id('carol'));
select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into ids values ('erin', gen_random_uuid());
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (tests.ps('erin'), 'authenticated', 'authenticated', 'erin@sessions.madeora.test',
          '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000', now(), '{}', '{}',
          now(), now());
select tests.act_as_user(tests.ps('erin'));
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.ps('home-a'), tests.ps('bob'), 'member'),
  (tests.ps('home-a'), tests.ps('carol'), 'administrator');
insert into ids values ('m-alice', tests.ps_mid(tests.ps('home-a'), tests.ps('alice'))),
  ('m-bob', tests.ps_mid(tests.ps('home-a'), tests.ps('bob'))),
  ('m-carol', tests.ps_mid(tests.ps('home-a'), tests.ps('carol'))),
  ('m-erin', tests.ps_mid(tests.ps('home-b'), tests.ps('erin')));
select tests.act_as('alice');
insert into ids select 'm-mia', membership_id from public.create_child(
  tests.ps('home-a'), 'Mia', tests.ps('m-alice'), null, '#16a34a', gen_random_uuid());
insert into ids values ('mia', tests.ps_child(tests.ps('m-mia')));
select public.set_child_credential(tests.ps('home-a'), tests.ps('m-mia'), 'pin',
  tests.ps_hash('mia-pin'));
select public.set_my_device_pin(tests.ps_hash('alice-pin'));
select public.set_shared_device_pin_rule(tests.ps('home-a'), true);
insert into ids values
  ('o-1', tests.ps_chore(tests.ps('home-a'), 'Dishes', null)),
  ('o-2', tests.ps_chore(tests.ps('home-a'), 'Laundry', null)),
  ('o-3', tests.ps_chore(tests.ps('home-a'), 'Windows', null)),
  ('o-4', tests.ps_chore(tests.ps('home-a'), 'Plants', null)),
  ('o-5', tests.ps_chore(tests.ps('home-a'), 'Hoover', null)),
  ('o-6', tests.ps_chore(tests.ps('home-a'), 'Dust', null)),
  ('o-7', tests.ps_chore(tests.ps('home-a'), 'Towels', null)),
  ('o-mia', tests.ps_chore(tests.ps('home-a'), 'Feed the cat', tests.ps('m-mia'))),
  ('o-bob', tests.ps_chore(tests.ps('home-a'), 'Bins', tests.ps('m-bob')));
select tests.act_as('bob');
select public.set_my_device_pin(tests.ps_hash('bob-pin'));
select tests.act_as_owner();
insert into ids values ('kitchen', tests.ps_display(tests.ps('home-a'), 'Keuken')),
  ('living', tests.ps_display(tests.ps('home-a'), 'Woonkamer')),
  ('hall-b', tests.ps_display(tests.ps('home-b'), 'Gang'));
select tests.assert_true(tests.ps('hall-b') is not null and tests.ps('o-bob') is not null,
  'Fixture: two Homes, members with PINs, chores and three displays');

-- Who may call the new functions ----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied($$select * from public.display_session_state(tests.ps('kitchen'))$$,
  'A member session cannot read a display''s session state');
select tests.assert_denied($$select public.display_end_unlock(tests.ps('kitchen'))$$,
  'Nor end a display''s session');
select tests.assert_denied(
  $$select public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-alice'))$$,
  'Nor lock a display through a session');
select tests.act_as_anon();
select tests.assert_denied($$select * from public.display_session_state(tests.ps('kitchen'))$$,
  'Nor a visitor');

-- No session: the PIN is asked ----------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_true(
  (select count(*) = 1 and bool_and(ambient_after_seconds = 300 and unlocked_membership_id is null
                                    and unlock_seconds_left is null)
   from public.display_session_state(tests.ps('kitchen'))),
  'A fresh display: default ambient timing (five minutes) and no session');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-1'), tests.ps('m-bob'))
  = 'pin_required', 'Without a session, the Home''s PIN rule asks Bob for his PIN');

-- A matched PIN opens a five-minute session for that member on that display -----------------------------------------

select tests.assert_true(
  tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-1'), tests.ps('m-bob')) = 'completed',
  'Bob completes a chore with his PIN');
select tests.assert_true(tests.ps_verification(tests.ps('o-1')) = 'pin', 'Recorded as PIN-verified');
select tests.assert_true(
  (select unlocked_membership_id = tests.ps('m-bob') and unlock_seconds_left between 1 and 300
   from public.display_session_state(tests.ps('kitchen'))),
  'The kitchen now has Bob''s session, with at most five minutes left');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-2'), tests.ps('m-bob'))
  = 'completed', 'Bob''s next PIN-gated chore on the kitchen needs no PIN');
select tests.assert_true(tests.ps_verification(tests.ps('o-2')) = 'session',
  'And it is recorded as done in his session');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.unlock_opened' and subject_id = tests.ps('kitchen')
     and details ->> 'member' = tests.ps('m-bob')::text),
  'Opening the session is audited with the member');
select tests.act_as_service_role();

-- It never widens anything ---------------------------------------------------------------------------------------------

select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-3'), tests.ps('m-alice'))
  = 'pin_required', 'Bob''s session does not let anyone else act without their PIN');
select tests.assert_true(tests.ps_try(tests.ps('living'), tests.ps('o-3'), tests.ps('m-bob'))
  = 'pin_required', 'Nor does it count on another display of the same Home');
select tests.assert_true(tests.ps_try(tests.ps('hall-b'), tests.ps('o-3'), tests.ps('m-bob'))
  = 'not_eligible', 'Nor on another Home''s display');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-mia'), tests.ps('m-bob'))
  = 'completed', 'An adult may still complete a child''s chore, exactly as before');
select tests.assert_true(
  public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-bob')) = 'not_permitted',
  'Bob''s session does not make him a manager who may lock the display');
select tests.assert_true(
  (select unlocked_membership_id is null from public.display_session_state(tests.ps('hall-b'))),
  'Home B''s display sees no session');

-- Expiry and a changed PIN --------------------------------------------------------------------------------------------

select tests.ps_age_session(tests.ps('kitchen'), interval '5 minutes', interval '-1 second');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-3'), tests.ps('m-bob'))
  = 'pin_required', 'After five minutes the PIN is asked again');
select tests.assert_true(
  (select unlocked_membership_id is null from public.display_session_state(tests.ps('kitchen'))),
  'The expired session is gone from the display''s state');
select tests.assert_true(tests.ps_sessions(tests.ps('kitchen')) = 0,
  'And reading the state deleted it');

select tests.assert_true(
  tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-3'), tests.ps('m-bob')) = 'completed',
  'Bob opens a new session with his PIN');
select tests.ps_age_session(tests.ps('kitchen'), interval '1 minute', interval '4 minutes');
select tests.act_as('bob');
select public.set_my_device_pin(tests.ps_hash('bob-new-pin'));
select tests.act_as_service_role();
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-4'), tests.ps('m-bob'))
  = 'pin_required', 'A PIN changed after the session opened ends it');

-- Lock now ----------------------------------------------------------------------------------------------------------------

select tests.assert_true(
  tests.ps_pin_complete(tests.ps('living'), tests.ps('o-4'), tests.ps('m-alice')) = 'completed',
  'Alice opens a session on the living room');
select tests.assert_true(
  (select unlocked_membership_id is not null from public.display_session_state(tests.ps('living'))),
  'The living room has a session');
select tests.assert_true(public.display_end_unlock(tests.ps('living')) = 'ended',
  'Lock now ends it');
select tests.assert_true(public.display_end_unlock(tests.ps('living')) = 'none',
  'A second Lock now has nothing to end');
select tests.assert_true(tests.ps_try(tests.ps('living'), tests.ps('o-5'), tests.ps('m-alice'))
  = 'pin_required', 'After Lock now the PIN is asked again');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.unlock_ended' and subject_id = tests.ps('living')),
  'Lock now is audited once');

-- A manager's session can lock the display (privacy mode); nothing on the display unlocks it ---------------------------

select tests.act_as_service_role();
select tests.assert_true(
  public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-alice')) = 'pin_required',
  'Without her session, Alice must use her PIN to lock the kitchen');
select tests.assert_true(
  tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-5'), tests.ps('m-alice')) = 'completed',
  'Alice opens a session on the kitchen with her PIN');
select tests.assert_true(
  public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-carol')) = 'not_permitted',
  'An Administrator without manageHomeSettings cannot lock through it');
select tests.assert_true(
  public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-erin')) = 'not_permitted',
  'Nor another Home''s manager');
select tests.assert_true(
  public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-alice')) = 'saved',
  'In her session, Alice locks the kitchen without typing her PIN again');
select tests.assert_true(tests.ps_sessions(tests.ps('kitchen')) = 0,
  'Locking the display ends its session');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-6'), tests.ps('m-alice'))
  = 'display_locked', 'No member action while locked');
select tests.assert_true(
  public.display_lock_by_session(tests.ps('kitchen'), tests.ps('m-alice')) = 'unchanged',
  'And a session call cannot unlock it');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.locked' and subject_id = tests.ps('kitchen')
     and details ->> 'via' = 'display_session'),
  'The lock is audited as done in a session');
select tests.act_as('alice');
select public.set_household_display_lock(tests.ps('home-a'), tests.ps('kitchen'), false, null);

-- A session opened, then the privacy lock from a manager's own session ends it
select tests.act_as_service_role();
select tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-6'), tests.ps('m-alice'));
select tests.act_as('alice');
select public.set_household_display_lock(tests.ps('home-a'), tests.ps('kitchen'), true, null);
select tests.assert_true(tests.ps_sessions(tests.ps('kitchen')) = 0,
  'A remote privacy lock ends the display''s session too');
select public.set_household_display_lock(tests.ps('home-a'), tests.ps('kitchen'), false, null);

-- Leaving the Home and revocation ---------------------------------------------------------------------------------------

select tests.act_as('bob');
select public.set_my_device_pin(tests.ps_hash('bob-pin'));
select tests.act_as_service_role();
select tests.assert_true(
  tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-bob'), tests.ps('m-bob')) = 'completed',
  'Bob opens a session again');
select tests.act_as('bob');
select public.leave_home(tests.ps('home-a'));
select tests.act_as_service_role();
select tests.assert_true(
  (select unlocked_membership_id is null from public.display_session_state(tests.ps('kitchen'))),
  'A former member''s session no longer counts');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-7'), tests.ps('m-bob'))
  = 'not_eligible', 'And he cannot act');

select tests.assert_true(
  tests.ps_pin_complete(tests.ps('living'), tests.ps('o-7'), tests.ps('m-alice')) = 'completed',
  'Alice opens a session on the living room');
select tests.act_as('alice');
select public.revoke_household_display(tests.ps('home-a'), tests.ps('living'));
select tests.assert_true(tests.ps_sessions(tests.ps('living')) = 0,
  'Revoking the display ends its session');
select tests.act_as_service_role();
select tests.assert_true(
  (select count(*) = 0 from public.display_session_state(tests.ps('living'))),
  'A revoked display has no state at all');
select tests.assert_true(public.display_lock_by_session(tests.ps('living'), tests.ps('m-alice'))
  = 'display_not_active', 'Nor can it lock itself through a session');

-- The Home's ambient timing ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_denied($$select public.home_display_settings(tests.ps('home-a'))$$,
  'An Administrator without manageHomeSettings cannot read the display settings', '42501');
select tests.assert_true(public.save_home_display_settings(tests.ps('home-a'), 600) = 'not_permitted',
  'Nor change them');
select tests.act_as_user(tests.ps('erin'));
select tests.assert_denied($$select public.home_display_settings(tests.ps('home-a'))$$,
  'Another Home''s manager cannot read them', '42501');
select tests.assert_true(public.save_home_display_settings(tests.ps('home-a'), 600) = 'not_found',
  'Nor change them');
select tests.act_as('alice');
select tests.assert_true(
  (public.home_display_settings(tests.ps('home-a')) ->> 'ambient_after_seconds')::int = 300,
  'The Owner sees the default of five minutes');
select tests.assert_denied($$select public.save_home_display_settings(tests.ps('home-a'), 45)$$,
  'A timing outside the offered choices is refused', '22023');
select tests.act_as_owner();
create temporary table signal_before on commit drop as
  select tests.ps_signal(tests.ps('kitchen')) as kitchen, tests.ps_signal(tests.ps('hall-b')) as hall;
select tests.act_as('alice');
select tests.assert_true(public.save_home_display_settings(tests.ps('home-a'), 600) = 'saved',
  'The Owner sets ten minutes');
select tests.assert_true(public.save_home_display_settings(tests.ps('home-a'), 600) = 'unchanged',
  'Saving the same value changes nothing');
select tests.act_as_owner();
select tests.assert_true(
  (select tests.ps_signal(tests.ps('kitchen')) > kitchen and tests.ps_signal(tests.ps('hall-b')) = hall
   from signal_before),
  'The change reaches Home A''s displays through their signal, not Home B''s');
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'display.settings_changed' and home_id = tests.ps('home-a')),
  'The change is audited');
select tests.act_as_service_role();
select tests.assert_true(
  (select ambient_after_seconds = 600 from public.display_session_state(tests.ps('kitchen')))
  and (select ambient_after_seconds = 300 from public.display_session_state(tests.ps('hall-b'))),
  'Home A''s displays wait ten minutes, Home B''s keep the default');

select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.ps('home-a'), tests.ps('m-carol'),
                                        array['manageHomeSettings']) = 'ok',
  'Alice grants Carol manageHomeSettings');
select tests.act_as('carol');
select tests.assert_true(
  (public.home_display_settings(tests.ps('home-a')) ->> 'ambient_after_seconds')::int = 600
  and public.save_home_display_settings(tests.ps('home-a'), 900) = 'saved',
  'An Administrator with manageHomeSettings reads and changes the timing');

-- A child's session, and PINs removed or locked ---------------------------------------------------------------

select tests.act_as('alice');
insert into ids values
  ('o-mia-2', tests.ps_chore(tests.ps('home-a'), 'Tidy room', tests.ps('m-mia'))),
  ('o-mia-3', tests.ps_chore(tests.ps('home-a'), 'Make bed', tests.ps('m-mia'))),
  ('o-mia-4', tests.ps_chore(tests.ps('home-a'), 'Pack bag', tests.ps('m-mia'))),
  ('o-8', tests.ps_chore(tests.ps('home-a'), 'Mop', null)),
  ('o-9', tests.ps_chore(tests.ps('home-a'), 'Iron', null)),
  ('o-10', tests.ps_chore(tests.ps('home-a'), 'Fold', null));
select tests.act_as_service_role();
select tests.assert_true(
  tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-mia-2'), tests.ps('m-mia')) = 'completed',
  'Mia completes her chore with her Home PIN');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-mia-3'), tests.ps('m-mia'))
  = 'completed', 'In her session, her next chore needs no PIN');
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-8'), tests.ps('m-mia'))
  = 'not_eligible', 'Her session never lets her complete a chore that is not hers');
select tests.act_as('alice');
select public.clear_child_credential(tests.ps('home-a'), tests.ps('m-mia'), 'pin');
select tests.act_as_service_role();
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-mia-4'), tests.ps('m-mia'))
  = 'pin_required', 'Once her guardian removes her PIN, her session no longer counts');

select tests.assert_true(
  tests.ps_pin_complete(tests.ps('kitchen'), tests.ps('o-8'), tests.ps('m-alice')) = 'completed',
  'Alice opens a session on the kitchen');
select tests.act_as_owner();
update private.member_device_pins set pin_locked_until = now() + interval '15 minutes'
  where user_id = tests.ps('alice');
select tests.act_as_service_role();
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-9'), tests.ps('m-alice'))
  = 'pin_required', 'A PIN locked elsewhere ends the session''s effect');
select tests.act_as_owner();
update private.member_device_pins set pin_locked_until = null where user_id = tests.ps('alice');
select tests.act_as_service_role();
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-9'), tests.ps('m-alice'))
  = 'completed', 'Lifted again, the still-running session counts');
select tests.act_as_owner();
delete from private.member_device_pins where user_id = tests.ps('alice');
select tests.act_as_service_role();
select tests.assert_true(tests.ps_try(tests.ps('kitchen'), tests.ps('o-10'), tests.ps('m-alice'))
  = 'pin_required', 'A removed PIN ends it');
