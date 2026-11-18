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
select tests.assert_true(tests.lw_conflict(tests.lw('entry-c')) = 'shopping_list_unavailable',
  'An item is not restored into an archived list (S26-L5)');
