-- S45: public.ora_preferences and public.ora_home_palettes
-- (supabase/migrations/20261206090000_ora_settings.sql). Alice, Bob and Carol are seeded synthetic
-- accounts. Each person reads and writes only their own Ora settings, a Home colour only while they
-- are a member, values must be well-formed, and a departure deletes the Home colour.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

-- Alice owns Home A. Bob owns Home B, where Alice is a Member and Carol an Administrator.
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
select tests.assert_denied('select user_id from public.ora_preferences',
  'A signed-out visitor cannot read Ora settings');
select tests.assert_denied('select home_id from public.ora_home_palettes',
  'A signed-out visitor cannot read Ora colours');

-- Own settings --------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_row_count('select * from public.ora_preferences', 0,
  'Without a row Alice has the defaults (no row yet)');
select tests.assert_allowed(
  $$insert into public.ora_preferences (user_id, enabled, motion, personal_palette)
    values (tests.user_id('alice'), false, 'reactions', 'denim')
    on conflict (user_id) do update
      set user_id = excluded.user_id, enabled = excluded.enabled, motion = excluded.motion,
          personal_palette = excluded.personal_palette$$,
  'Alice can save her Ora settings the way the app upserts'
);
select tests.assert_row_count('select * from public.ora_preferences', 1,
  'Alice reads her own row');
select tests.assert_true(
  (select not enabled and motion = 'reactions' and intro is null and personal_palette = 'denim'
     from public.ora_preferences where user_id = tests.user_id('alice')),
  'The saved values come back; the introduction is still unseen'
);
select tests.assert_allowed(
  $$update public.ora_preferences set intro = 'skipped' where user_id = tests.user_id('alice')$$,
  'Alice can record that she skipped the introduction'
);
select tests.assert_denied(
  $$update public.ora_preferences set motion = 'wild' where user_id = tests.user_id('alice')$$,
  'An unknown motion mode is refused', '23514'
);
select tests.assert_denied(
  $$update public.ora_preferences set intro = 'later' where user_id = tests.user_id('alice')$$,
  'An unknown introduction state is refused', '23514'
);
select tests.assert_denied(
  $$update public.ora_preferences set personal_palette = 'Heather'
    where user_id = tests.user_id('alice')$$,
  'A palette must be one of the nine stable keys', '23514'
);
select tests.assert_denied(
  $$update public.ora_preferences set created_at = now() where user_id = tests.user_id('alice')$$,
  'Alice cannot write the timestamps'
);
select tests.assert_denied(
  $$delete from public.ora_preferences where user_id = tests.user_id('alice')$$,
  'Nobody deletes a row through the API'
);
select tests.assert_denied(
  $$insert into public.ora_preferences (user_id) values (tests.user_id('bob'))$$,
  'Alice cannot create settings for Bob'
);

-- Nobody reads or sets someone else's ----------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_preferences', 0,
  'Bob cannot read Alice''s Ora settings');
select tests.assert_row_count(
  $$update public.ora_preferences set enabled = true returning user_id$$, 0,
  'Bob cannot change Alice''s Ora settings'
);

-- Per-Home colour -----------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_allowed(
  $$insert into public.ora_home_palettes (home_id, user_id, palette)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'olive')
    on conflict (home_id, user_id) do update
      set home_id = excluded.home_id, user_id = excluded.user_id, palette = excluded.palette$$,
  'Alice can choose her colour in Home B'
);
select tests.assert_allowed(
  $$insert into public.ora_home_palettes (home_id, user_id, palette)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'cocoa')
    on conflict (home_id, user_id) do update
      set home_id = excluded.home_id, user_id = excluded.user_id, palette = excluded.palette$$,
  'Alice can change it again'
);
select tests.assert_true(
  (select palette = 'cocoa' from public.ora_home_palettes
    where home_id = (select id from ids where name = 'home-b')),
  'The change is stored'
);
select tests.assert_denied(
  $$insert into public.ora_home_palettes (home_id, user_id, palette)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'pink')
    on conflict (home_id, user_id) do update set palette = excluded.palette$$,
  'An unknown palette is refused', '23514'
);
select tests.assert_denied(
  $$insert into public.ora_home_palettes (home_id, user_id, palette)
    values ((select id from ids where name = 'home-b'), tests.user_id('bob'), 'brick')$$,
  'Alice cannot choose Bob''s colour'
);
select tests.assert_denied(
  $$update public.ora_home_palettes set home_id = (select id from ids where name = 'home-a')
    where user_id = tests.user_id('alice')$$,
  'A colour cannot be moved to another Home'
);
select tests.assert_denied(
  $$delete from public.ora_home_palettes where user_id = tests.user_id('alice')$$,
  'Nobody deletes a Home colour through the API'
);

select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_home_palettes', 0,
  'Bob, Owner of Home B, cannot read a member''s Ora colour');
select tests.assert_row_count(
  $$update public.ora_home_palettes set palette = 'brick' returning home_id$$, 0,
  'The Owner cannot recolour a member''s Ora'
);
select tests.assert_denied(
  $$insert into public.ora_home_palettes (home_id, user_id, palette)
    values ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'brick')$$,
  'Bob cannot set a colour in a Home he does not belong to'
);

select tests.act_as('carol');
select tests.assert_row_count('select * from public.ora_home_palettes', 0,
  'An Administrator cannot read a member''s Ora colour');

-- Leaving a Home deletes the colour there ---------------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-b') and user_id = tests.user_id('alice');
select tests.assert_row_count(
  $$select * from public.ora_home_palettes
    where home_id = (select id from ids where name = 'home-b')$$,
  0,
  'Leaving a Home deletes the Ora colour there'
);

select tests.act_as('alice');
select tests.assert_denied(
  $$insert into public.ora_home_palettes (home_id, user_id, palette)
    values ((select id from ids where name = 'home-b'), tests.user_id('alice'), 'brick')$$,
  'A former member cannot choose a colour in the Home'
);
select tests.assert_row_count('select * from public.ora_preferences', 1,
  'Her personal settings are untouched by leaving a Home');
