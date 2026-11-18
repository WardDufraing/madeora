-- Review backlog Part 5 (supabase/migrations/20261214090000_review_low_db.sql): open LOW database
-- findings. Each block names the finding it covers.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to anon, authenticated;

create function tests.lw(p_name text) returns uuid
  language sql stable as $$ select i.id from pg_temp.ids i where i.name = p_name $$;
grant execute on function tests.lw(text) to anon, authenticated, service_role;

create function tests.lw_list_rev(p_id uuid) returns integer
  language sql stable security definer as $$ select revision from private.shopping_lists where id = p_id $$;
create function tests.lw_item_rev(p_id uuid) returns integer
  language sql stable security definer as $$ select revision from private.shopping_items where id = p_id $$;
create function tests.lw_conflict(p_entry uuid) returns text
  language sql stable security definer as $$
  select private.trash_conflict(e) from private.trash_entries e where e.id = p_entry $$;
grant execute on function tests.lw_list_rev(uuid), tests.lw_item_rev(uuid), tests.lw_conflict(uuid)
  to authenticated;

insert into ids values ('display', gen_random_uuid()), ('l-a', gen_random_uuid()), ('l-b', gen_random_uuid()),
  ('i-a', gen_random_uuid()), ('i-c', gen_random_uuid()), ('copy-1', gen_random_uuid());

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());

-- S09-L3, S43-L8: a Household Display never creates a Home, even with a confirmed alias email.
select tests.act_as_owner();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', tests.lw('display'), 'authenticated', 'authenticated',
          'display-low@displays.madeora.test', '', now(),
          '{"provider": "madeora_display", "providers": [], "madeora_kind": "display"}', '{}', now(), now());
select tests.act_as_user(tests.lw('display'));
select tests.assert_denied($$select public.create_home('Scherm', 'Europe/Brussels', gen_random_uuid())$$,
  'A Household Display account cannot create a Home', '42501');

-- Shopping (S26-L2, S26-L1, S26-L5).
select tests.act_as('alice');
select public.create_shopping_list(tests.lw('l-a'), 'Groceries', tests.lw('home-a'));
select public.create_shopping_list(tests.lw('l-b'), 'Market', tests.lw('home-a'));
select public.add_shopping_items(tests.lw('l-a'), jsonb_build_array(
  jsonb_build_object('id', tests.lw('i-a'), 'name', 'Eggs', 'quantity', null, 'unit', null,
    'packaging', null, 'notes', null, 'categoryId', null, 'allowDuplicate', false),
  jsonb_build_object('id', tests.lw('i-c'), 'name', 'Milk', 'quantity', null, 'unit', null,
    'packaging', null, 'notes', null, 'categoryId', null, 'allowDuplicate', false)));
select tests.assert_true(
  (select outcome = 'copied' from public.transfer_shopping_item(tests.lw('i-a'), 'copy', tests.lw('l-b'),
    tests.lw_item_rev(tests.lw('i-a')), null, true, false, tests.lw('copy-1'))),
  'An item of an active list is copied');
select tests.assert_true(
  (select outcome = 'exists' from public.transfer_shopping_item(tests.lw('i-a'), 'copy', tests.lw('l-b'),
    tests.lw_item_rev(tests.lw('i-a')), null, true, false, tests.lw('copy-1'))),
  'A retry of the copy answers exists');
insert into ids select 'entry-c', entry_id from public.delete_shopping_item(tests.lw('i-c'));
select tests.assert_true(tests.lw_conflict(tests.lw('entry-c')) is null,
  'A deleted item of an active list can be restored');
select public.update_shopping_list(tests.lw('l-a'), tests.lw_list_rev(tests.lw('l-a')), 'Groceries', 'edit', true);
select tests.assert_true(
  (select outcome = 'conflict' from public.transfer_shopping_item(tests.lw('i-a'), 'copy', tests.lw('l-b'),
    tests.lw_item_rev(tests.lw('i-a')), null, true, true, gen_random_uuid())),
  'An item of an archived list is not copied (S26-L2)');
select tests.assert_true(tests.lw_conflict(tests.lw('entry-c')) = 'shopping_list_archived',
  'An item is not restored into an archived list (S26-L5)');

-- More fixtures (review M1). Helpers read private rows the API does not expose.
select tests.act_as_owner();
create function tests.lw_habit_rev(p_id uuid) returns integer
  language sql stable security definer as $$ select revision from private.habits where id = p_id $$;
create function tests.lw_occ(p_chore uuid) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrences where chore_id = p_chore and deleted_at is null and status = 'open'
  order by due_date limit 1 $$;
create function tests.lw_occ_rev(p_occ uuid) returns integer
  language sql stable security definer as $$ select revision from private.chore_occurrences where id = p_occ $$;
create function tests.lw_step(p_occ uuid, p_position integer) returns uuid
  language sql stable security definer as $$
  select id from private.chore_occurrence_steps where occurrence_id = p_occ and position = p_position $$;
create function tests.lw_entry(p_type text) returns uuid
  language sql stable security definer as $$
  select id from private.trash_entries where item_type = p_type and status = 'trashed'
  order by deleted_at desc limit 1 $$;
grant execute on all functions in schema tests to authenticated, service_role;

insert into ids values ('child', gen_random_uuid()), ('h-old', gen_random_uuid()), ('c-steps', gen_random_uuid()),
  ('c-series', gen_random_uuid()), ('event', gen_random_uuid());

-- A child account never creates a Home either (S09-L3).
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', tests.lw('child'), 'authenticated', 'authenticated',
          'child-low@children.madeora.test', '', now(), '{}', '{}', now(), now());
insert into public.child_profiles (user_id, creation_request_id) values (tests.lw('child'), gen_random_uuid());
select tests.act_as_user(tests.lw('child'));
select tests.assert_denied($$select public.create_home('Kamer', 'Europe/Brussels', gen_random_uuid())$$,
  'A child account cannot create a Home', '42501');

-- S12-L2: an expired pending transfer is hidden from its recipient, and shown to its sender as expired.
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values (tests.lw('home-a'), tests.user_id('bob'), 'member');
insert into private.home_ownership_transfers (home_id, from_user_id, to_user_id, created_at, expires_at,
                                             creation_request_id)
  values (tests.lw('home-a'), tests.user_id('alice'), tests.user_id('bob'), now() - interval '9 days',
          now() - interval '2 days', gen_random_uuid());
select tests.act_as('bob');
select tests.assert_true((select count(*) = 0 from public.home_ownership_transfer(tests.lw('home-a'))),
  'The recipient no longer sees a transfer that expired');
select tests.act_as('alice');
select tests.assert_true(
  (select state = 'expired' and is_sender from public.home_ownership_transfer(tests.lw('home-a'))),
  'The sender sees it as expired');

-- S38-L1: a reported sign-in stays reported.
select tests.act_as_owner();
insert into private.account_activity_events (id, user_id, category, kind, outcome, session_id)
  values (tests.lw('event'), tests.user_id('alice'), 'security', 'signed_in', 'completed', null);
select tests.act_as('alice');
select tests.assert_true(public.respond_to_sign_in(tests.lw('event'), 'reported') = 'reported',
  'Alice reports a sign-in');
select tests.assert_true(public.respond_to_sign_in(tests.lw('event'), 'confirmed') = 'reported',
  'A later "This was me" does not undo the report');
select tests.act_as_owner();
select tests.assert_true(
  (select response = 'reported' from private.account_activity_events where id = tests.lw('event'))
  and (select count(*) = 1 from private.account_security_events
       where user_id = tests.user_id('alice') and kind = 'session_reported'),
  'The report is recorded once');

-- S28-L1: a restored habit counts toward the 100 habits of its context.
select tests.act_as('alice');
select public.create_habit(tests.lw('h-old'), tests.lw('home-a'), 'Old habit', null, 'daily', null, null,
  current_date, null, null, 'monday');
select public.delete_habit(tests.lw('h-old'), tests.lw_habit_rev(tests.lw('h-old')));
do $$
declare
  v_outcome text;
  v_n integer := 0;
begin
  loop
    v_n := v_n + 1;
    if v_n > 200 then
      raise exception 'the habit limit was never reached';
    end if;
    select c.outcome into v_outcome from public.create_habit(gen_random_uuid(), tests.lw('home-a'),
      'Filler ' || v_n, null, 'daily', null, null, current_date, null, null, 'monday') c;
    exit when v_outcome = 'too_many';
  end loop;
end $$;
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'habit_limit' and options = '{}'::text[]
   from public.restore_trash_entries(array[tests.lw_entry('habit')])),
  'A habit is not restored past the habit limit');

-- S20-L1: making a step mandatory on an occurrence with progress needs confirmation.
select public.create_chore(tests.lw('c-steps'), tests.lw('home-a'), 'Dishes',
  '{"mode": "none", "members": []}', '[{"label": "Wash", "mandatory": true}, {"label": "Dry", "mandatory": false}]',
  p_due_date => current_date + 1);
select public.set_chore_step(tests.lw_step(tests.lw_occ(tests.lw('c-steps')), 0), true);
select tests.assert_true(
  (select outcome = 'needs_confirmation' and (impact ->> 'newlyMandatory')::integer = 1
   from public.update_chore_occurrence(tests.lw_occ(tests.lw('c-steps')), tests.lw_occ_rev(tests.lw_occ(tests.lw('c-steps'))),
     false, p_steps => jsonb_build_array(
       jsonb_build_object('id', tests.lw_step(tests.lw_occ(tests.lw('c-steps')), 0), 'label', 'Wash', 'mandatory', true),
       jsonb_build_object('id', tests.lw_step(tests.lw_occ(tests.lw('c-steps')), 1), 'label', 'Dry', 'mandatory', true)))),
  'A newly mandatory step on an occurrence with progress asks for confirmation');
select tests.assert_true(
  (select outcome = 'saved'
   from public.update_chore_occurrence(tests.lw_occ(tests.lw('c-steps')), tests.lw_occ_rev(tests.lw_occ(tests.lw('c-steps'))),
     false, p_steps => jsonb_build_array(
       jsonb_build_object('id', tests.lw_step(tests.lw_occ(tests.lw('c-steps')), 0), 'label', 'Wash', 'mandatory', true),
       jsonb_build_object('id', tests.lw_step(tests.lw_occ(tests.lw('c-steps')), 1), 'label', 'Dry', 'mandatory', true)),
     p_confirm_checklist => true)),
  'With the confirmation it is saved');

-- Follow-up M-1: an occurrence waiting for a vacation review is not overdue in the detail.
select tests.act_as_owner();
update private.chore_occurrences set due_date = current_date - 3, vacation_review = true
  where id = tests.lw_occ(tests.lw('c-steps'));
select tests.act_as('alice');
select tests.assert_true(
  (public.get_chore_occurrence(tests.lw_occ(tests.lw('c-steps'))) ->> 'overdue')::boolean = false,
  'A vacation-review occurrence is not shown overdue');

-- S20-L4: restoring an entire chore-series removal counts toward the chore limit.
-- A completed occurrence first, so removing the series ends the chore instead of deleting it.
select public.create_chore(tests.lw('c-series'), tests.lw('home-a'), 'Plants', '{"mode": "none", "members": []}',
  p_frequency => 'daily', p_interval => 1, p_starts_on => current_date - 2);
select public.advance_chores(tests.lw('home-a'));
select public.complete_chore_occurrence(tests.lw_occ(tests.lw('c-series')),
  (select id from public.home_memberships where home_id = tests.lw('home-a') and user_id = tests.user_id('alice')));
select public.delete_chore_occurrences(tests.lw_occ(tests.lw('c-series')), 'series',
  tests.lw_occ_rev(tests.lw_occ(tests.lw('c-series'))), false);
select tests.assert_true(tests.lw_entry('chore_removal') is not null, 'The series removal is in the trash');
do $$
declare
  v_outcome text;
  v_n integer := 0;
begin
  loop
    v_n := v_n + 1;
    if v_n > 1000 then
      raise exception 'the chore limit was never reached';
    end if;
    select c.outcome into v_outcome from public.create_chore(gen_random_uuid(), tests.lw('home-a'),
      'Filler ' || v_n, '{"mode": "none", "members": []}', p_due_date => current_date) c;
    exit when v_outcome = 'limit_reached';
  end loop;
end $$;
select tests.assert_true(
  (select outcome = 'needs_resolution' and conflict = 'chore_limit'
   from public.restore_trash_entries(array[tests.lw_entry('chore_removal')])),
  'An ended chore series is not restored past the chore limit');
