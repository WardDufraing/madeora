-- S11: public.home_member_profiles, user_preferences.accent_color, public.home_directory() and the
-- shared name rule (supabase/migrations/*_member_profiles.sql). Alice, Bob and Carol are seeded
-- synthetic accounts. Each person reads and writes only their own Home presentation, only while
-- they are a member; nobody, Owner included, presents someone else; the directory shows a Home's
-- current members to its current members only, with effective values and no account ids; a
-- departure clears the overrides.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

-- Alice owns Home A. Bob owns Home B, where Alice is a Member and Carol an Administrator (fixtures
-- standing in for approved invitations).
select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'member'),
  ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'administrator');

-- Signed-out visitors ------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  'select home_id from public.home_member_profiles',
  'A signed-out visitor cannot read Home profiles'
);
select tests.assert_denied(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))$$,
  'A signed-out visitor cannot list members'
);

-- Global name and accent ---------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_allowed(
  $$insert into public.user_preferences (user_id, display_name, accent_color)
    values (tests.user_id('alice'), 'Alice', '#16a34a')
    on conflict (user_id) do update
      set user_id = excluded.user_id, display_name = excluded.display_name,
          accent_color = excluded.accent_color$$,
  'Alice can save her global display name and accent'
);
select tests.assert_denied(
  $$update public.user_preferences set accent_color = '#16A34A'
    where user_id = tests.user_id('alice')$$,
  'An accent must be lower-case #rrggbb',
  '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set accent_color = 'green'
    where user_id = tests.user_id('alice')$$,
  'An accent must be a hex colour',
  '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'Ali\u200Bce'
    where user_id = tests.user_id('alice')$$,
  'A display name with a zero-width space is refused (S11 name rule)',
  '23514'
);
select tests.assert_denied(
  $$update public.user_preferences set display_name = E'\u3164'
    where user_id = tests.user_id('alice')$$,
  'A display name made only of a Hangul filler is refused',
  '23514'
);
select tests.assert_allowed(
  $$update public.user_preferences set display_name = E'Sam \U0001F31F'
    where user_id = tests.user_id('alice')$$,
  'A display name with an emoji is accepted'
);
update public.user_preferences set display_name = 'Alice' where user_id = tests.user_id('alice');

-- Own Home presentation ---------------------------------------------------------------------------

select tests.assert_allowed(
  $$insert into public.home_member_profiles (home_id, user_id, nickname, accent_color)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'Ali', '#2563eb')
    on conflict (home_id, user_id) do update
      set home_id = excluded.home_id, user_id = excluded.user_id,
          nickname = excluded.nickname, accent_color = excluded.accent_color$$,
  'Alice can set her nickname and accent in Home B the way the app upserts'
);
select tests.assert_row_count(
  'select * from public.home_member_profiles', 1, 'Alice reads her own Home profile'
);
select tests.assert_denied(
  $$insert into public.home_member_profiles (home_id, user_id, nickname)
    values ((select id from ids where name = 'home-b'), tests.user_id('bob'), 'Boss')$$,
  'Alice cannot create a Home profile for Bob'
);
select tests.assert_denied(
  $$update public.home_member_profiles set nickname = E'Al\u200Bi'
    where user_id = tests.user_id('alice')$$,
  'A nickname with a zero-width space is refused',
  '23514'
);
select tests.assert_denied(
  $$update public.home_member_profiles set display_name = E'\u202EecilA'
    where user_id = tests.user_id('alice')$$,
  'A Home display name with a right-to-left override is refused',
  '23514'
);
select tests.assert_denied(
  $$update public.home_member_profiles set nickname = repeat('a', 51)
    where user_id = tests.user_id('alice')$$,
  'A nickname longer than 50 characters is refused',
  '23514'
);
select tests.assert_denied(
  $$update public.home_member_profiles set home_id = (select id from ids where name = 'home-a')
    where user_id = tests.user_id('alice')$$,
  'Alice cannot move her Home B profile into Home A'
);
select tests.assert_denied(
  $$delete from public.home_member_profiles where user_id = tests.user_id('alice')$$,
  'Nobody deletes a Home profile through the API (reset writes nulls)'
);

-- Nobody presents someone else ---------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_row_count(
  'select * from public.home_member_profiles', 0,
  'Bob, Owner of Home B, cannot read Alice''s Home profile'
);
select tests.assert_row_count(
  $$update public.home_member_profiles set nickname = 'Renamed'
    where home_id = (select id from ids where name = 'home-b') returning home_id$$,
  0,
  'The Owner cannot rename a member'
);
select tests.assert_denied(
  $$insert into public.home_member_profiles (home_id, user_id, nickname)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'Renamed')
    on conflict (home_id, user_id) do update set nickname = excluded.nickname$$,
  'The Owner cannot write a member''s profile with an upsert'
);
select tests.assert_denied(
  $$insert into public.home_member_profiles (home_id, user_id, nickname)
    values ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'Intruder')$$,
  'Bob cannot create a profile in a Home he does not belong to'
);
select tests.assert_row_count(
  $$update public.user_preferences set display_name = 'Renamed'
    where user_id = tests.user_id('alice') returning user_id$$,
  0,
  'Bob cannot change Alice''s global display name'
);

select tests.act_as('carol');
select tests.assert_row_count(
  $$update public.home_member_profiles set accent_color = '#000000' returning home_id$$,
  0,
  'An Administrator cannot recolour a member'
);

-- Directory ---------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))$$,
  3,
  'Bob sees the three members of Home B'
);
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))
    where name = 'Ali' and accent_color = '#2563eb' and role = 'member' and not is_self$$,
  1,
  'Alice appears in Home B with her nickname and Home accent'
);
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))
    where is_self and role = 'owner'$$,
  1,
  'Bob is marked as himself'
);
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))
    where role = 'administrator' and name is null and accent_color is null$$,
  1,
  'Carol, with no name or accent, appears without them'
);
select tests.assert_row_count(
  $$select d.* from public.home_directory((select id from ids where name = 'home-b')) d
    join public.home_memberships m on m.id = d.membership_id$$,
  1,
  'Membership ids are returned, but Bob still reads only his own membership row directly'
);
select tests.assert_denied(
  $$select * from public.home_directory((select id from ids where name = 'home-a'))$$,
  'Bob cannot list the members of a Home he does not belong to'
);
select tests.assert_denied(
  $$select * from public.home_directory('00000000-0000-4000-8000-00000000dead')$$,
  'A Home that does not exist is refused the same way'
);
select tests.assert_denied(
  'select * from public.home_directory(null)', 'A missing Home id is refused'
);

select tests.act_as('alice');
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-a'))
    where name = 'Alice' and accent_color = '#16a34a' and is_self$$,
  1,
  'In Home A, Alice has her global name and accent: the Home B nickname stays in Home B'
);

-- The directory's columns never include account ids or contact details.
select tests.assert_true(
  pg_catalog.pg_get_function_result('public.home_directory(uuid)'::regprocedure)
    = 'TABLE(membership_id uuid, role text, joined_at timestamp with time zone, is_self boolean, name text, accent_color text, avatar_file_id uuid)',
  'home_directory returns exactly the directory columns'
);

-- Inheritance and reset -------------------------------------------------------------------------

update public.home_member_profiles set nickname = null, display_name = 'Alice B'
  where home_id = (select id from ids where name = 'home-b');
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))
    where is_self and name = 'Alice B' and accent_color = '#2563eb'$$,
  1,
  'Without a nickname, the Home display name applies; the accent override stays'
);

update public.user_preferences set display_name = 'Alicia', accent_color = '#dc2626'
  where user_id = tests.user_id('alice');
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-a'))
    where is_self and name = 'Alicia' and accent_color = '#dc2626'$$,
  1,
  'A global change reaches Home A, which inherits both'
);
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))
    where is_self and name = 'Alice B' and accent_color = '#2563eb'$$,
  1,
  'A global change leaves Home B''s overrides alone'
);

update public.home_member_profiles set display_name = null
  where home_id = (select id from ids where name = 'home-b');
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))
    where is_self and name = 'Alicia' and accent_color = '#2563eb'$$,
  1,
  'Resetting the name keeps the accent override'
);

-- Departure ---------------------------------------------------------------------------------------

-- Ending Alice's membership of Home B (here as the database owner; the removal flow is S12).
select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('alice');
select tests.assert_row_count(
  $$select * from public.home_member_profiles
    where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('alice')$$,
  0,
  'Leaving a Home deletes the presentation there'
);

select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))$$,
  'A former member can no longer list the Home''s members'
);
select tests.assert_denied(
  $$insert into public.home_member_profiles (home_id, user_id, nickname)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'Back')$$,
  'A former member cannot create a profile in the Home'
);

select tests.act_as('bob');
select tests.assert_row_count(
  $$select * from public.home_directory((select id from ids where name = 'home-b'))$$,
  2,
  'The directory no longer lists Alice'
);

-- Home names use the shared rule too ---------------------------------------------------------------

select tests.assert_denied(
  $$update public.homes set name = E'Ko\u200Bt'
    where id = (select id from ids where name = 'home-b')$$,
  'Home names still refuse a zero-width space',
  '23514'
);
