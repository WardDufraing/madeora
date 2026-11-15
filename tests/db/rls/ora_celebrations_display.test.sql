-- S47c: Ora chore-point celebrations and the display-only Ora widget layout
-- (supabase/migrations/20261209090000_ora_celebrations_display.sql). Alice, Bob and Carol are seeded
-- synthetic accounts. Ledger rows are inserted as the table owner: the awards themselves are the
-- chores module's job and are tested there.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'member');

-- Accounts and ledger lines. Alice: two fresh awards and one that was reversed; Bob: one fresh
-- award; an old award of Alice's (an hour ago) must never be celebrated.
insert into private.point_accounts (id, home_id, user_id) values
  ('00000000-0000-4000-8000-0000000000a1', (select id from ids where name = 'home-a'), tests.user_id('alice')),
  ('00000000-0000-4000-8000-0000000000b1', (select id from ids where name = 'home-a'), tests.user_id('bob'));
insert into private.point_entries
  (id, home_id, account_id, kind, amount, attributed_at, late, available_before, available_after, reserved_after, created_at)
values
  ('00000000-0000-4000-8000-00000000e001', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000a1', 'chore_award', 5, now(), false, 0, 5, 0, now()),
  ('00000000-0000-4000-8000-00000000e002', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000a1', 'chore_award', 3, now(), false, 5, 8, 0, now()),
  ('00000000-0000-4000-8000-00000000e003', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000b1', 'chore_award', 7, now(), false, 0, 7, 0, now());

-- Signed-out visitors ------------------------------------------------------------------------------

select tests.act_as_anon();
select tests.assert_denied(
  $$select public.claim_ora_celebrations((select id from ids where name = 'home-a'))$$,
  'A signed-out visitor cannot claim celebrations'
);
select tests.assert_denied('select entry_id from public.ora_celebrations',
  'A signed-out visitor cannot read celebrations');

-- Own awards, grouped, once -----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (public.claim_ora_celebrations((select id from ids where name = 'home-a')) ->> 'count') = '2',
  'Alice''s two fresh awards are claimed together as one line, and only hers'
);
select tests.assert_row_count('select * from public.ora_celebrations', 2,
  'Two ledger lines are now marked as celebrated for Alice');
select tests.assert_true(
  public.claim_ora_celebrations((select id from ids where name = 'home-a')) is null,
  'Asking again (another tab, device or a retry) celebrates nothing twice'
);
select tests.assert_denied(
  $$select public.claim_ora_celebrations((select id from ids where name = 'home-b'))$$,
  'Alice cannot claim in a Home she does not belong to'
);
select tests.assert_denied(
  $$insert into public.ora_celebrations (home_id, entry_id)
    values ((select id from ids where name = 'home-a'), gen_random_uuid())$$,
  'Nobody writes a celebration row directly'
);

-- Another member's awards are theirs alone -----------------------------------------------------------

select tests.act_as('bob');
select tests.assert_row_count('select * from public.ora_celebrations', 0,
  'Bob does not read Alice''s celebrations');
select tests.assert_true(
  (public.claim_ora_celebrations((select id from ids where name = 'home-a')) ->> 'points') = '7',
  'Bob is celebrated for his own award only (7 points, not Alice''s)'
);

-- Reversed awards, switches ---------------------------------------------------------------------------

select tests.act_as_owner();
insert into private.point_entries
  (id, home_id, account_id, kind, amount, attributed_at, late, available_before, available_after, reserved_after, created_at)
values
  ('00000000-0000-4000-8000-00000000e004', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000a1', 'chore_award', 4, now(), false, 8, 12, 0, now()),
  ('00000000-0000-4000-8000-00000000e005', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000a1', 'chore_award', 2, now() - interval '1 hour', false, 12, 14, 0,
   now() - interval '1 hour');
insert into private.point_entries
  (id, home_id, account_id, kind, amount, attributed_at, reverses_id, available_before, available_after, reserved_after)
values
  ('00000000-0000-4000-8000-00000000e006', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000a1', 'chore_reversal', -4, now(),
   '00000000-0000-4000-8000-00000000e004', 14, 10, 0);

select tests.act_as('alice');
select tests.assert_true(
  public.claim_ora_celebrations((select id from ids where name = 'home-a')) is null,
  'A reversed award and an award older than 15 minutes are never celebrated'
);

select tests.act_as_owner();
insert into private.point_entries
  (id, home_id, account_id, kind, amount, attributed_at, late, available_before, available_after, reserved_after)
values
  ('00000000-0000-4000-8000-00000000e007', (select id from ids where name = 'home-a'),
   '00000000-0000-4000-8000-0000000000a1', 'chore_award', 6, now(), false, 10, 16, 0);
select tests.act_as('alice');
insert into public.ora_preferences (user_id, cat_celebrations) values (tests.user_id('alice'), false)
  on conflict (user_id) do update set cat_celebrations = false;
select tests.assert_true(
  public.claim_ora_celebrations((select id from ids where name = 'home-a')) is null,
  'With the celebrations switch off nothing is claimed'
);
update public.ora_preferences set cat_celebrations = true, frequency = 'quiet'
  where user_id = tests.user_id('alice');
select tests.assert_true(
  public.claim_ora_celebrations((select id from ids where name = 'home-a')) is null,
  'Quiet mode claims nothing either'
);
update public.ora_preferences set frequency = 'balanced' where user_id = tests.user_id('alice');
select tests.assert_true(
  (public.claim_ora_celebrations((select id from ids where name = 'home-a')) ->> 'points') = '6',
  'Nothing was used up while it was switched off: the award is celebrated once it is back on'
);

-- Leaving a Home removes the celebration rows there ---------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
select tests.assert_row_count(
  $$select * from public.ora_celebrations where user_id = tests.user_id('bob')$$, 0,
  'Leaving a Home deletes the person''s celebration rows there'
);

-- The display-only Ora widget layout -------------------------------------------------------------------

select tests.assert_true(
  private.valid_display_layout(
    '{"version":1,"widgets":[{"id":"00000000-0000-4000-8000-000000000009","type":"ora","size":"small","config":{}}]}'::jsonb),
  'A layout may contain the settings-free Ora widget'
);
select tests.assert_true(
  not private.valid_display_layout(
    '{"version":1,"widgets":[{"id":"00000000-0000-4000-8000-000000000009","type":"ora","size":"small","config":{"text":"x"}}]}'::jsonb),
  'The Ora widget takes no settings'
);
select tests.assert_true(
  not private.valid_display_layout(
    '{"version":1,"widgets":[{"id":"00000000-0000-4000-8000-000000000009","type":"chat","size":"small","config":{}}]}'::jsonb),
  'Unknown widget types are still refused'
);
