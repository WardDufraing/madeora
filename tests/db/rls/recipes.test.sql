-- S24: recipes core (supabase/migrations/*_recipes.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Carol is not in. Covers: nothing reachable
-- as a table; draft privacy (only the creator, never the Owner, a recipe manager or another Home, in
-- reads, lists, search, tags, widgets, ratings, favorites, locks, deletes and cover reads); the
-- published minimum, destination checks and publish idempotence; personal recipes private to their
-- owner; edit rights (creator while a member, recipe managers; revoked grant); exclusive locks
-- (atomic acquire, locked for others, same person's other session and take-over, expiry, stale save,
-- wrong token, revoked right, delete while locked, release); revisions for drafts; search by name and
-- ingredient ignoring case and accents, literal wildcards, all-tags filter, favorites, sorting with
-- ties; ratings averaged over current members only; widgets; covers (pool, adoption, move on publish,
-- replace, read access); trash and restore with the cover; member departure; audit without content.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Pacific/Auckland', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-carol-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('carol');

insert into ids select n, gen_random_uuid() from unnest(array[
  'd-carol', 'r-alice', 'r-a1', 'r-a2', 'r-a3', 'r-a4', 'r-a5', 'r-b', 'r-cover', 'd-cover',
  'tok-carol', 'tok-carol-2', 'tok-alice', 'tok-bob', 'req-1', 'req-2'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.recipes where id = tests.i(p_name); $$;
-- Recipe content as the API sends it. p_ingredients and p_steps are JSON arrays.
create function tests.rc(
  p_name text, p_ingredients jsonb default '[{"name": "Bloem", "quantity": {"num": 1, "den": 2, "style": "fraction"}, "unit": "kg", "note": null}]',
  p_steps jsonb default '["Meng alles."]', p_tags jsonb default '[]', p_cover uuid default null,
  p_servings integer default 4
) returns jsonb
  language sql immutable as $$
  select jsonb_build_object('name', p_name, 'servings', p_servings, 'servingsLabel', null,
    'prepMinutes', 10, 'cookMinutes', null, 'notes', null, 'tags', p_tags,
    'ingredients', p_ingredients, 'steps', p_steps, 'coverFileId', p_cover);
  $$;
create function tests.empty() returns jsonb
  language sql immutable as $$
  select tests.rc(null, '[]', '[]', '[]', null, null); $$;
create function tests.file_status(p_name text) returns text
  language sql stable security definer as $$ select status from private.stored_files where id = tests.i(p_name); $$;
create function tests.pool_owner(p_name text) returns text
  language sql stable security definer as $$
  select case when p.owner_home_id is not null then 'home:' || p.owner_home_id else 'user:' || p.owner_user_id end
  from private.stored_files f join private.storage_pools p on p.id = f.pool_id where f.id = tests.i(p_name); $$;
-- Opens a cover upload as the current actor and finalizes it as the server would; records the file.
create function tests.cover(p_user text, p_name text, p_recipe uuid default null, p_token uuid default null)
returns text
  language plpgsql as $$
  declare
    v record;
    v_outcome text;
  begin
    perform tests.act_as(p_user);
    select * into v from public.create_recipe_cover_intent('image/jpeg', 2000, gen_random_uuid(), p_recipe, p_token);
    if v.outcome <> 'ok' then
      return v.outcome;
    end if;
    insert into ids values (p_name, v.file_id);
    perform tests.act_as_service_role();
    v_outcome := public.finalize_upload(tests.user_id(p_user), v.file_id, 'image/webp', 1500,
      encode(extensions.digest(p_name, 'sha256'), 'hex'));
    perform tests.act_as(p_user);
    return v_outcome;
  end
  $$;
grant execute on function tests.i(text), tests.rev(text), tests.rc(text, jsonb, jsonb, jsonb, uuid, integer),
  tests.empty(), tests.file_status(text), tests.pool_owner(text), tests.cover(text, text, uuid, uuid)
  to authenticated, service_role;

-- Nothing reachable ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.recipes', 'The API cannot read recipes');
select tests.assert_denied('select * from private.recipe_ingredients', 'Nor ingredients');
select tests.assert_denied('select * from private.recipe_steps', 'Nor steps');
select tests.assert_denied('select * from private.recipe_edit_locks', 'Nor locks');
select tests.assert_denied('select * from private.recipe_favorites', 'Nor favorites');
select tests.assert_denied('select * from private.recipe_ratings', 'Nor ratings');
select tests.assert_denied('select * from private.recipe_cover_uploads', 'Nor cover uploads');
select tests.assert_denied(
  $$select private.can_edit_recipe(null::private.recipes, tests.user_id('alice'))$$,
  'Nor the permission helpers');
select tests.act_as_anon();
select tests.assert_denied('select * from public.list_recipes()', 'Nobody signed out lists recipes');
select tests.assert_denied($$select public.get_recipe(gen_random_uuid())$$, 'Nor reads one');
select tests.assert_denied('select * from public.list_my_recipe_drafts()', 'Nor lists drafts');

-- Drafts: private to their creator ----------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' and status = 'draft'
    from public.create_recipe(tests.i('d-carol'), tests.empty(), tests.i('home-a'))),
  'Carol saves an entirely empty draft meant for Home A');
select tests.assert_true(
  (select outcome = 'exists' from public.create_recipe(tests.i('d-carol'), tests.empty(), tests.i('home-a'))),
  'A retry returns the same draft');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(), tests.empty(), tests.i('home-b'))$$,
  'A draft cannot be meant for a Home she is not in');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(), '{"name": "x"}'::jsonb)$$,
  'Malformed content is refused', '22023');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(),
    tests.rc('Soep', '[{"name": "Zout", "quantity": {"num": 2, "den": 4, "style": "fraction"}, "unit": null, "note": null}]'))$$,
  'An unreduced quantity is refused', '22023');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(),
    tests.rc('Soep', '[{"name": "Zout", "quantity": null, "unit": "bucket", "note": null}]'))$$,
  'An unsupported unit is refused', '22023');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(), tests.rc('Soep', p_tags => '["Vegan", "VEGAN"]'))$$,
  'The same tag twice is refused', '22023');
select tests.assert_true(
  (select count(*) = 1 from public.list_my_recipe_drafts()
    where id = tests.i('d-carol') and destination_home_id = tests.i('home-a') and destination_home_name = 'Thuis'),
  'My drafts shows it with its destination');
select tests.assert_true((public.get_recipe(tests.i('d-carol')) ->> 'status') = 'draft', 'Carol reads it');
select tests.assert_true(
  (select outcome = 'incomplete' from public.publish_recipe(tests.i('d-carol'), 1, tests.i('req-1'), tests.i('home-a'))),
  'An incomplete draft cannot be published');
select tests.assert_true(
  (select outcome = 'draft' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'A draft needs no lock');

-- Everyone else, the Owner and a granted recipe manager included, sees nothing of it.
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeRecipes']);
select tests.act_as_owner();
create function tests.draft_hidden(p_who text) returns void
  language plpgsql as $$
  begin
    perform tests.act_as(p_who);
    perform tests.assert_true(public.get_recipe(tests.i('d-carol')) is null, p_who || ' cannot read the draft');
    perform tests.assert_true((select count(*) = 0 from public.list_recipes(tests.i('home-a'))),
      p_who || ' does not see it in the Home library');
    perform tests.assert_true((select count(*) = 0 from public.list_recipes()), p_who || ' nor in their own');
    perform tests.assert_true(
      (select count(*) = 0 from public.list_my_recipe_drafts() where id = tests.i('d-carol')),
      p_who || ' nor among their drafts');
    perform tests.assert_true(
      (select count(*) = 0 from public.recipe_widget(tests.i('home-a'), 'recent', 5)),
      p_who || ' nor in a widget');
    perform tests.assert_true(
      (select outcome = 'not_found' from public.set_recipe_rating(tests.i('d-carol'), 5)), p_who || ' cannot rate it');
    perform tests.assert_true(public.set_recipe_favorite(tests.i('d-carol'), true) = 'not_found',
      p_who || ' nor favorite it');
    perform tests.assert_true(
      (select outcome = 'not_found' from public.update_recipe(tests.i('d-carol'), 1, tests.rc('Mine now'))),
      p_who || ' nor change it');
    perform tests.assert_true(
      (select outcome = 'not_found' from public.publish_recipe(tests.i('d-carol'), 1, gen_random_uuid(), tests.i('home-a'))),
      p_who || ' nor publish it');
    perform tests.assert_true(
      (select outcome = 'not_found' from public.acquire_recipe_lock(tests.i('d-carol'), gen_random_uuid())),
      p_who || ' nor lock it');
    perform tests.assert_true(
      (select outcome = 'not_found' from public.delete_recipe(tests.i('d-carol'))), p_who || ' nor delete it');
    perform tests.assert_true(
      (select outcome = 'id_taken' from public.create_recipe(tests.i('d-carol'), tests.empty())),
      p_who || ' cannot claim its id');
  end
  $$;
grant execute on function tests.draft_hidden(text) to authenticated, service_role;
select tests.draft_hidden('alice');
select tests.draft_hidden('bob');

-- Carol completes it in two tabs: the second, stale save is refused, not merged.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'destination_unavailable' from public.update_recipe(tests.i('d-carol'), 1,
    tests.rc('Pannenkoeken'), null, tests.i('home-b'))),
  'A draft cannot be redirected to a Home she is not in');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.update_recipe(tests.i('d-carol'), 1,
    tests.rc('Pannenkoeken', p_tags => '["Ontbijt", "Zoet"]'), null, tests.i('home-a'))),
  'She saves the draft');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2 from public.update_recipe(tests.i('d-carol'), 1,
    tests.rc('Pancakes'), null, tests.i('home-a'))),
  'The other tab''s stale save is refused');
select tests.assert_true(
  (select outcome = 'conflict' from public.publish_recipe(tests.i('d-carol'), 1, tests.i('req-1'), tests.i('home-a'))),
  'Publishing a stale draft is refused');
select tests.assert_denied(
  $$select * from public.publish_recipe(tests.i('d-carol'), 2, tests.i('req-1'), tests.i('home-b'))$$,
  'Nor into a Home she is not in');
select tests.act_as('alice');
select tests.assert_true((select count(*) = 0 from public.list_recipe_tags(tests.i('home-a'))),
  'A draft''s tags do not show in the Home');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'published' and revision = 3
    from public.publish_recipe(tests.i('d-carol'), 2, tests.i('req-1'), tests.i('home-a'))),
  'She publishes it to Home A');
select tests.assert_true(
  (select outcome = 'already_published'
    from public.publish_recipe(tests.i('d-carol'), 2, tests.i('req-1'), tests.i('home-a'))),
  'A double click publishes nothing twice');
select tests.assert_true(
  (select count(*) = 0 from public.list_my_recipe_drafts()), 'It left her drafts');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes(tests.i('home-a'))), 'Alice sees it in Home A');
select tests.assert_true(
  (select count(*) = 2 from public.list_recipe_tags(tests.i('home-a'))), 'With its tags');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes()), 'Not in her Personal space');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-b'))), 'Nothing reaches Home B');

-- Personal recipes ------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'incomplete' from public.create_recipe(gen_random_uuid(), tests.rc('Leeg', '[]', '[]'), null, true)),
  'A recipe published at once needs the minimum');
select tests.assert_true(
  (select outcome = 'created' and status = 'published'
    from public.create_recipe(tests.i('r-alice'), tests.rc('Oma''s appeltaart', '[]'), null, true)),
  'Alice publishes a personal recipe with steps only');
select tests.act_as('carol');
select tests.assert_true(public.get_recipe(tests.i('r-alice')) is null, 'Carol cannot read it');
select tests.assert_true(
  (select outcome = 'not_found' from public.acquire_recipe_lock(tests.i('r-alice'), gen_random_uuid())),
  'Nor edit it');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes()), 'Alice sees it in her Personal space');

-- Edit rights and the exclusive lock --------------------------------------------------------------------

select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-bob'))),
  'An Administrator without manageHomeRecipes cannot edit someone else''s recipe');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_recipe(tests.i('d-carol'))), 'Nor delete it');
select tests.assert_true(
  (public.get_recipe(tests.i('d-carol')) #>> '{can,edit}')::boolean = false, 'And is told so');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'acquired' and revision = 3
    from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'The creator takes the lock');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'Taking it again from the same session is harmless');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'locked' and not held_by_me and held_by_member = tests.i('m-carol-a')
    from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-alice'))),
  'The Owner is told Carol is editing');
select tests.assert_true(
  (select outcome = 'locked' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-alice'), true)),
  'And cannot take it over');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.update_recipe(tests.i('d-carol'), 3, tests.rc('Overwrite'), tests.i('tok-alice'))),
  'Nor save without it');
select tests.assert_true(
  (select outcome = 'locked' from public.delete_recipe(tests.i('d-carol'))),
  'Nor delete it while Carol edits');
select tests.assert_true(
  (public.get_recipe(tests.i('d-carol')) #>> '{lock,member}')::uuid = tests.i('m-carol-a'),
  'The recipe says who is editing');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'locked' and held_by_me
    from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol-2'))),
  'Her own other tab is told it is open elsewhere');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol-2'), true)),
  'And may take it over');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.update_recipe(tests.i('d-carol'), 3, tests.rc('Old tab'), tests.i('tok-carol'))),
  'The first tab can no longer save');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.renew_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'Nor renew');
select tests.assert_true(
  (select outcome = 'renewed' from public.renew_recipe_lock(tests.i('d-carol'), tests.i('tok-carol-2'))),
  'The second tab renews');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 3
    from public.update_recipe(tests.i('d-carol'), 2, tests.rc('Stale'), tests.i('tok-carol-2'))),
  'A stale revision is refused even with the lock');
select tests.assert_true(
  (select outcome = 'incomplete' from public.update_recipe(tests.i('d-carol'), 3, tests.rc('Leeg', '[]', '[]'), tests.i('tok-carol-2'))),
  'A published recipe keeps the minimum');
select tests.assert_true(
  (select outcome = 'saved' and revision = 4
    from public.update_recipe(tests.i('d-carol'), 3,
      tests.rc('Pannenkoeken', '[{"name": "Melk", "quantity": {"num": 1, "den": 2, "style": "decimal"}, "unit": "l", "note": null}, {"name": "Zout", "quantity": null, "unit": null, "note": "naar smaak"}]',
        '["Klop.", "Bak."]', '["Ontbijt", "Zoet"]'),
      tests.i('tok-carol-2'))),
  'The save goes through');
select tests.assert_true(public.get_recipe(tests.i('d-carol')) -> 'lock' = 'null'::jsonb, 'And releases the lock');
select tests.assert_true(
  (public.get_recipe(tests.i('d-carol')) -> 'ingredients') = '[
    {"name": "Melk", "quantity": {"num": 1, "den": 2, "style": "decimal"}, "unit": "l", "note": null},
    {"name": "Zout", "quantity": null, "unit": null, "note": "naar smaak"}]'::jsonb,
  'Only the latest content is kept, in order');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.update_recipe(tests.i('d-carol'), 4, tests.rc('Again'), tests.i('tok-carol-2'))),
  'A second save needs the lock again');

-- Expiry: a lock nobody renews stops counting.
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'Carol starts editing again');
select tests.act_as_owner();
update private.recipe_edit_locks set expires_at = now() - interval '1 second' where recipe_id = tests.i('d-carol');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.update_recipe(tests.i('d-carol'), 4, tests.rc('After expiry'), tests.i('tok-carol'))),
  'An expired lock cannot save');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.renew_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'Nor be renewed');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-alice'))),
  'The Owner (a recipe manager) takes the expired lock');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'locked' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'Now Carol waits');
select tests.assert_true(
  (select outcome = 'locked' from public.delete_recipe(tests.i('d-carol'))), 'And cannot delete it');
select tests.act_as('alice');
select tests.assert_true(public.release_recipe_lock(tests.i('d-carol'), tests.i('tok-alice')), 'Alice cancels');
select tests.assert_true(not public.release_recipe_lock(tests.i('d-carol'), tests.i('tok-alice')),
  'Releasing twice changes nothing');

-- A revoked right ends the edit: renew and save are refused.
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeRecipes']);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-bob'))),
  'A granted recipe manager takes the lock');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_recipe(tests.i('d-carol'), 4, tests.rc('Bob was here'), tests.i('tok-bob'))),
  'After the grant is revoked he cannot save');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.renew_recipe_lock(tests.i('d-carol'), tests.i('tok-bob'))),
  'And his lock ends');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'So Carol can edit again');
select tests.assert_true(public.release_recipe_lock(tests.i('d-carol'), tests.i('tok-carol')), 'And stops');

-- Search, tags, sorting -----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-a1'),
    tests.rc('Crème brûlée', '[{"name": "Eieren", "quantity": {"num": 4, "den": 1, "style": "decimal"}, "unit": "piece", "note": null}]',
      '["Bak."]', '["Dessert", "Frans"]'),
    tests.i('home-a'), true)),
  'Alice publishes a Home recipe');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-a2'),
    tests.rc('Pasta pesto', '[{"name": "Basilicum", "quantity": null, "unit": "bunch", "note": null}, {"name": "Pijnboompitten 50%", "quantity": null, "unit": null, "note": null}]',
      '["Kook."]', '["Pasta"]'),
    tests.i('home-a'), true)),
  'And another');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-a3'), tests.rc('Pasta pesto', p_tags => '["dessert"]'), tests.i('home-a'), true)),
  'And one with the same name');

select tests.assert_true(
  (select array_agg(name order by name) = array['Crème brûlée'] from public.list_recipes(tests.i('home-a'), 'CREME')),
  'Search ignores case and accents');
select tests.assert_true(
  (select count(*) = 1 and bool_and(id = tests.i('r-a2') and matched_ingredient = 'Basilicum')
    from public.list_recipes(tests.i('home-a'), 'basil')),
  'An ingredient match says which ingredient');
select tests.assert_true(
  (select count(*) = 1 and bool_and(id = tests.i('r-a2')) from public.list_recipes(tests.i('home-a'), '50%')),
  'A percent sign is matched literally');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-a'), '_')), 'An underscore is no wildcard either');
select tests.assert_true(
  (select array_agg(id order by id) = (select array_agg(x order by x) from unnest(array[tests.i('r-a1'), tests.i('r-a3')]) x)
    from public.list_recipes(tests.i('home-a'), null, array['DESSERT'])),
  'One tag matches regardless of case');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('r-a1')]
    from public.list_recipes(tests.i('home-a'), null, array['dessert', 'frans'])),
  'Several tags must all be there');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-a'), null, array['onbekend'])),
  'An unknown tag matches nothing');
select tests.assert_true(
  (select array_agg(name order by ordinality) = array['Pasta pesto', 'Pasta pesto', 'Pannenkoeken', 'Crème brûlée']
    from public.list_recipes(tests.i('home-a'), null, null, false, 'name_desc') with ordinality),
  'Name sorting, descending');
select tests.assert_true(
  (select array_agg(id order by ordinality) = (
      select array_agg(x order by x) from unnest(array[tests.i('r-a2'), tests.i('r-a3')]) x)
    from public.list_recipes(tests.i('home-a'), 'pasta', null, false, 'name_asc') with ordinality),
  'Equal names are ordered by id, every time');
select tests.assert_true(
  (select max(total_count) = 4 and count(*) = 2
    from public.list_recipes(tests.i('home-a'), null, null, false, 'name_asc', 2, 0)),
  'Pages carry the filtered total');
select tests.assert_denied(
  $$select * from public.list_recipes(tests.i('home-a'), null, null, false, 'popular')$$,
  'An unknown sort is refused', '22023');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-b'), 'pasta')),
  'Searching Home B finds nothing of Home A');
select tests.act_as('carol');
select tests.assert_denied($$select * from public.list_recipes(tests.i('home-b'))$$,
  'Carol cannot list a Home she is not in');

-- Favorites and ratings ------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(public.set_recipe_favorite(tests.i('r-a2'), true) = 'saved', 'Carol favorites a recipe');
select tests.assert_true(public.set_recipe_favorite(tests.i('r-a2'), true) = 'saved', 'Twice is harmless');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('r-a2')] from public.list_recipes(tests.i('home-a'), null, null, true)),
  'Her favorites filter shows it');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-a'), null, null, true)),
  'Alice''s favorites are her own');
select tests.assert_true(
  (select outcome = 'saved' and average = 5 and rating_count = 1 from public.set_recipe_rating(tests.i('r-a2'), 5)),
  'Alice rates it five stars');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and mine = 2 and average = 3.5 and rating_count = 2
    from public.set_recipe_rating(tests.i('r-a2'), 2)),
  'Carol two: the Home sees the average and the count');
select tests.assert_true(
  (public.get_recipe(tests.i('r-a2')) -> 'rating') = '{"mine": 2, "average": 3.50, "count": 2}'::jsonb,
  'The recipe shows her own rating and the average, never who gave what');
select tests.assert_denied($$select * from public.set_recipe_rating(tests.i('r-a2'), 6)$$,
  'Six stars is refused', '22023');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_recipe_rating(tests.i('r-alice'), 4)),
  'Nobody rates a recipe they cannot see');

-- Widgets -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('r-a2')] from public.recipe_widget(tests.i('home-a'), 'favorites', 5)),
  'Favorites mode: her own');
select tests.assert_true(
  (select array_agg(id) = array[tests.i('r-a2')] and bool_and(available = 1)
    from public.recipe_widget(tests.i('home-a'), 'top_rated', 5)),
  'Highest rated: only rated recipes');
select tests.assert_true(
  (select count(*) = 3 and max(available) = 4 from public.recipe_widget(tests.i('home-a'), 'recent', 3)),
  'Recently added: newest first, with how many there are');
select tests.assert_true(
  (select array_agg(id) from public.recipe_widget(tests.i('home-a'), 'random', 1, 'seed-1'))
    = (select array_agg(id) from public.recipe_widget(tests.i('home-a'), 'random', 1, 'seed-1')),
  'Random: the same seed keeps the same pick');
select tests.assert_denied($$select * from public.recipe_widget(tests.i('home-a'), 'trending', 1)$$,
  'An unknown mode is refused', '22023');
select tests.assert_denied($$select * from public.recipe_widget(tests.i('home-b'), 'recent', 1)$$,
  'A widget cannot read another Home');

-- Covers ----------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(tests.cover('carol', 'f-new') = 'ready', 'Carol uploads a cover for a new recipe');
select tests.assert_true(tests.pool_owner('f-new') = 'user:' || tests.user_id('carol'),
  'It is charged to her Personal space until saved');
select tests.assert_true(
  (select count(*) = 1 from public.authorize_file_read(tests.i('f-new'))), 'She can preview it');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 0 from public.authorize_file_read(tests.i('f-new'))), 'Nobody else can');
select tests.assert_true(
  (select outcome = 'invalid_cover' from public.create_recipe(gen_random_uuid(),
    tests.rc('Stolen', p_cover => tests.i('f-new')), tests.i('home-a'), true)),
  'Alice cannot use Carol''s upload');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('d-cover'), tests.rc('Taart', p_cover => tests.i('f-new')),
    tests.i('home-a'))),
  'She saves a draft with it');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 0 from public.authorize_file_read(tests.i('f-new'))), 'A draft''s cover stays private');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'published' from public.publish_recipe(tests.i('d-cover'), 1, tests.i('req-2'), tests.i('home-a'))),
  'She publishes it to Home A');
select tests.assert_true(tests.pool_owner('f-new') = 'home:' || tests.i('home-a'),
  'The cover moved into the Home''s storage');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 from public.authorize_file_read(tests.i('f-new'))), 'Members now see it');
select tests.assert_true(
  (select outcome = 'lock_lost' from public.create_recipe_cover_intent('image/png', 100, gen_random_uuid(), tests.i('d-cover'))),
  'A published recipe''s cover changes only under the lock');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-cover'), tests.i('tok-carol'))),
  'Carol edits it');
select tests.assert_true(tests.cover('carol', 'f-second', tests.i('d-cover'), tests.i('tok-carol')) = 'ready',
  'And uploads a replacement');
select tests.assert_true(tests.pool_owner('f-second') = 'home:' || tests.i('home-a'), 'Into the Home''s storage');
select tests.assert_true(
  (select outcome = 'saved' from public.update_recipe(tests.i('d-cover'), tests.rev('d-cover'),
    tests.rc('Taart', p_cover => tests.i('f-second')), tests.i('tok-carol'))),
  'The save replaces the cover');
select tests.assert_true(tests.file_status('f-new') = 'deleted' and tests.file_status('f-second') = 'ready',
  'The old one is retired, not kept as a version');
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 0 from public.authorize_file_read(tests.i('f-new'))), 'And no longer readable');
select tests.assert_true(
  (select count(*) = 1 from public.authorize_file_read(tests.i('f-second'))), 'The new one is');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.create_recipe_cover_intent('image/png', 100, gen_random_uuid(), tests.i('r-alice'))),
  'Nobody uploads a cover for a recipe they cannot see');
select tests.assert_denied(
  $$select * from public.create_recipe_cover_intent('image/gif', 100, gen_random_uuid())$$,
  'Covers are JPEG, PNG or WebP', '22023');

-- Trash ---------------------------------------------------------------------------------------------

select tests.act_as('carol');
insert into ids select 'e-cover', entry_id from public.delete_recipe(tests.i('d-cover')) where outcome = 'deleted';
select tests.assert_true(tests.i('e-cover') is not null, 'Carol deletes her recipe to the trash');
select tests.assert_true(tests.file_status('f-second') = 'deleted', 'Its cover goes with it');
select tests.act_as('alice');
select tests.assert_true(public.get_recipe(tests.i('d-cover')) is null, 'Nobody reads it in the trash');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-a'), 'taart')), 'Or finds it');
select tests.assert_true(
  (select count(*) = 0 from public.authorize_file_read(tests.i('f-second'))), 'Or its cover');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-cover')])),
  'She restores it');
select tests.assert_true(tests.file_status('f-second') = 'ready'
  and (public.get_recipe(tests.i('d-cover')) ->> 'coverFileId')::uuid = tests.i('f-second'),
  'With its cover');
insert into ids select 'e-cover-2', entry_id from public.delete_recipe(tests.i('d-cover')) where outcome = 'deleted';
select tests.assert_true(
  (select outcome = 'purged' from public.purge_trash_entries(array[tests.i('e-cover-2')])),
  'And deletes it for good');
select tests.act_as_owner();
select tests.assert_true(not exists (select 1 from private.recipes where id = tests.i('d-cover')),
  'The row is gone');
select tests.assert_true(tests.file_status('f-second') = 'purged', 'And the cover with it');

-- A discarded draft goes to its creator's Personal trash.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-a4'), tests.empty(), tests.i('home-a'))),
  'Carol starts another draft for Home A');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_recipe(tests.i('r-a4'))), 'And discards it');
select tests.act_as_owner();
select tests.assert_true(
  (select owner_user_id = tests.user_id('carol') and owner_home_id is null from private.trash_entries
    where subject_id = tests.i('r-a4') and status = 'trashed'),
  'Into her own trash, never the Home''s');

-- Member departure ----------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-a5'), tests.rc('Concept'), tests.i('home-a'))),
  'Carol has a draft meant for Home A');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-carol'))),
  'And is editing a Home recipe');
select tests.assert_true(public.leave_home(tests.i('home-a')) = 'left', 'She leaves Home A');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_recipe(tests.i('d-carol'), tests.rev('d-carol'), tests.rc('Too late'),
    tests.i('tok-carol'))),
  'Her edit can no longer be saved');
select tests.assert_true(public.get_recipe(tests.i('d-carol')) is null, 'Nor can she read the recipe');
select tests.assert_true(
  (select destination_home_id is null and destination_home_name is null and destination_lost
    from public.list_my_recipe_drafts() where id = tests.i('r-a5')),
  'Her draft lost its destination and says so');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_recipe_rating(tests.i('r-a2'), 1)),
  'She cannot rate there any more');
select tests.act_as('alice');
select tests.assert_true(public.get_recipe(tests.i('d-carol')) -> 'lock' = 'null'::jsonb,
  'Her lock ended at once');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes(tests.i('home-a'), 'pannenkoeken')),
  'The recipe she created stays with the Home');
select tests.assert_true(
  (public.get_recipe(tests.i('d-carol')) #>> '{createdBy,member}') is null,
  'Attributed to a former member');
select tests.assert_true(
  (select rating_average = 5 and rating_count = 1 from public.list_recipes(tests.i('home-a'), 'pasta pesto')
    where id = tests.i('r-a2')),
  'Her rating no longer counts');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('d-carol'), tests.i('tok-alice'))),
  'The Owner edits it');

-- Audit: ids and counts only ------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) >= 4 from private.audit_events where home_id = tests.i('home-a') and subject_type = 'recipe'),
  'Home recipe changes are audited');
select tests.assert_true(
  not exists (select 1 from private.audit_events where subject_type = 'recipe'
    and (details::text ilike '%pannenkoek%' or details::text ilike '%pesto%' or details::text ilike '%melk%')),
  'Without names or content');
select tests.assert_true(
  not exists (select 1 from private.audit_events where subject_type = 'recipe' and home_id is null),
  'Personal and draft changes are not');
