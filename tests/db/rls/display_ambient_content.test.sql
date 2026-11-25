-- UX8b: privacy-safe counts in the ambient view of Household Displays
-- (supabase/migrations/20261223090000_display_ambient_content.sql). Both choices are off by
-- default; only the Home's managers change them, audited, through save_home_display_ambient; the
-- change reaches only that Home's displays; the display reads them through display_session_state
-- (service_role only); the UX8a two-argument save keeps working and leaves them alone.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated, service_role;

create function tests.ac(p_name text) returns uuid
  language sql stable
  as $$ select i.id from pg_temp.ids i where i.name = p_name $$;

create function tests.ac_mid(p_home uuid, p_user uuid) returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select m.id from private.home_memberships_all m where m.home_id = p_home and m.user_id = p_user
  $$;

create function tests.ac_display(p_home uuid, p_name text) returns uuid
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

create function tests.ac_signal(p_display uuid) returns bigint
  language sql stable security definer set search_path = ''
  as $$ select coalesce((select s.version from public.display_signals s where s.display_id = p_display), 0) $$;

create function tests.ac_audits(p_home uuid) returns bigint
  language sql stable security definer set search_path = ''
  as $$
    select count(*) from private.audit_events e
    where e.home_id = p_home and e.action = 'display.settings_changed'
  $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;

-- Fixtures: Alice owns Home A with Bob (Member) and Carol (Administrator without capabilities).
-- Erin owns Home B. Home A has a kitchen display, Home B a hall display.
insert into ids values ('alice', tests.user_id('alice')), ('bob', tests.user_id('bob')),
  ('carol', tests.user_id('carol'));
select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into ids values ('erin', gen_random_uuid());
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (tests.ac('erin'), 'authenticated', 'authenticated', 'erin@ambient.madeora.test',
          '$2a$10$abcdefghijklmnopqrstuuSyntheticHashForTestsOnly000000', now(), '{}', '{}',
          now(), now());
select tests.act_as_user(tests.ac('erin'));
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  (tests.ac('home-a'), tests.ac('bob'), 'member'),
  (tests.ac('home-a'), tests.ac('carol'), 'administrator');
insert into ids values ('m-carol', tests.ac_mid(tests.ac('home-a'), tests.ac('carol')));
insert into ids values ('kitchen', tests.ac_display(tests.ac('home-a'), 'Keuken')),
  ('hall-b', tests.ac_display(tests.ac('home-b'), 'Gang'));

-- Who may call --------------------------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select public.save_home_display_ambient(tests.ac('home-a'), 300, true, true)$$,
  'A visitor cannot save ambient choices');
select tests.act_as('bob');
select tests.assert_true(
  public.save_home_display_ambient(tests.ac('home-a'), 300, true, true) = 'not_permitted',
  'A Member cannot save them');
select tests.assert_denied($$select public.home_display_settings(tests.ac('home-a'))$$,
  'Nor read them', '42501');
select tests.act_as('carol');
select tests.assert_true(
  public.save_home_display_ambient(tests.ac('home-a'), 300, true, true) = 'not_permitted',
  'An Administrator without manageHomeSettings cannot save them');
select tests.act_as_user(tests.ac('erin'));
select tests.assert_true(
  public.save_home_display_ambient(tests.ac('home-a'), 300, true, true) = 'not_found',
  'Another Home''s Owner cannot save them');
select tests.act_as('alice');
select tests.assert_denied($$select * from public.display_session_state(tests.ac('kitchen'))$$,
  'A member session cannot read a display''s state');

-- Defaults ------------------------------------------------------------------------------------------------------

select tests.assert_true(
  public.home_display_settings(tests.ac('home-a'))
    = '{"ambient_after_seconds": 300, "ambient_show_chores": false, "ambient_show_shopping": false}'::jsonb,
  'By default: five minutes and no household counts');
select tests.act_as_service_role();
select tests.assert_true(
  (select count(*) = 1 and bool_and(not ambient_show_chores and not ambient_show_shopping
                                    and ambient_after_seconds = 300)
   from public.display_session_state(tests.ac('kitchen'))),
  'A display gets both choices off by default');

-- Validation ----------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  $$select public.save_home_display_ambient(tests.ac('home-a'), 45, true, false)$$,
  'A timing outside the offered choices is refused', '22023');
select tests.assert_denied(
  $$select public.save_home_display_ambient(tests.ac('home-a'), 300, null, false)$$,
  'A missing choice is refused', '22023');

-- Saving --------------------------------------------------------------------------------------------------------

select tests.act_as_owner();
create temporary table signal_before on commit drop as
  select tests.ac_signal(tests.ac('kitchen')) as kitchen, tests.ac_signal(tests.ac('hall-b')) as hall;
select tests.act_as('alice');
select tests.assert_true(
  public.save_home_display_ambient(tests.ac('home-a'), 600, true, false) = 'saved',
  'The Owner turns on the chores count with ten minutes');
select tests.assert_true(
  public.save_home_display_ambient(tests.ac('home-a'), 600, true, false) = 'unchanged',
  'Saving the same values changes nothing');
select tests.act_as_owner();
select tests.assert_true(
  (select tests.ac_signal(tests.ac('kitchen')) > kitchen and tests.ac_signal(tests.ac('hall-b')) = hall
   from signal_before),
  'The change reaches Home A''s displays through their signal, not Home B''s');
select tests.assert_true(tests.ac_audits(tests.ac('home-a')) = 1
  and (select (e.details ->> 'ambient_show_chores')::boolean
              and not (e.details ->> 'ambient_show_shopping')::boolean
       from private.audit_events e
       where e.home_id = tests.ac('home-a') and e.action = 'display.settings_changed'),
  'The change is audited once, with the choices');
select tests.act_as_service_role();
select tests.assert_true(
  (select ambient_show_chores and not ambient_show_shopping and ambient_after_seconds = 600
   from public.display_session_state(tests.ac('kitchen')))
  and (select not ambient_show_chores and not ambient_show_shopping
       from public.display_session_state(tests.ac('hall-b'))),
  'Home A''s display shows the chores count; Home B''s keeps the defaults');

-- The UX8a save keeps working and leaves the choices alone ------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(public.save_home_display_settings(tests.ac('home-a'), 900) = 'saved',
  'The previous two-argument save still changes the timing');
select tests.assert_true(
  public.home_display_settings(tests.ac('home-a'))
    = '{"ambient_after_seconds": 900, "ambient_show_chores": true, "ambient_show_shopping": false}'::jsonb,
  'and keeps the chosen counts');

-- A manager by capability ---------------------------------------------------------------------------------------

select tests.assert_true(
  public.set_administrator_capabilities(tests.ac('home-a'), tests.ac('m-carol'),
                                        array['manageHomeSettings']) = 'ok',
  'Alice grants Carol manageHomeSettings');
select tests.act_as('carol');
select tests.assert_true(
  public.save_home_display_ambient(tests.ac('home-a'), 900, false, true) = 'saved',
  'An Administrator with manageHomeSettings changes the choices');
select tests.assert_true(
  public.home_display_settings(tests.ac('home-a'))
    = '{"ambient_after_seconds": 900, "ambient_show_chores": false, "ambient_show_shopping": true}'::jsonb,
  'and reads them back');

-- A revoked display gets nothing --------------------------------------------------------------------------------

select tests.act_as('alice');
select public.revoke_household_display(tests.ac('home-a'), tests.ac('kitchen'));
select tests.act_as_service_role();
select tests.assert_true(
  (select count(*) = 0 from public.display_session_state(tests.ac('kitchen'))),
  'A revoked display gets no state');
