-- S25: recipe sharing, impact-reviewed deletion and import support
-- (supabase/migrations/*_recipe_sharing_import.sql). Alice owns Home A (Bob Administrator, Carol
-- Member) and Home C (alone); Bob owns Home B, where Carol is a Member. Covers: nothing reachable as
-- a table; who may share (origin recipe managers only, into their own Homes, published only);
-- visibility in lists, search, tags, widgets, details and cover reads for destination members only;
-- origin privacy in a destination; view-only and editing shares and the one lock across Homes;
-- per-context ratings and favorites; unsharing by origin and by destination managers; departures;
-- impact review, stale reviews and delete rights for shared recipes; paused shares through the trash
-- and reinstating them; import sources, duplicates and the import rate limit; audit without content.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
insert into ids select 'home-c', public.create_home('Atelier', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Pacific/Auckland', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member'),
  ((select id from ids where name = 'home-b'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');
insert into ids select 'm-alice-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('alice');

insert into ids select n, gen_random_uuid() from unnest(array[
  'r-c', 'r-carol', 'p-alice', 'd-alice', 'r-src', 'd-carol', 'd-bob', 'tok-bob', 'tok-alice',
  'tok-bob-2'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.recipes where id = tests.i(p_name); $$;
create function tests.rc(p_name text, p_tags jsonb default '[]', p_source jsonb default null) returns jsonb
  language sql immutable as $$
  select jsonb_build_object('name', p_name, 'servings', 4, 'servingsLabel', null,
    'prepMinutes', 10, 'cookMinutes', null, 'notes', null, 'tags', p_tags,
    'ingredients', '[{"name": "Bloem", "quantity": {"num": 1, "den": 2, "style": "fraction"}, "unit": "kg", "note": null}]'::jsonb,
    'steps', '["Meng alles."]'::jsonb, 'coverFileId', null)
    || case when p_source is null then '{}'::jsonb else jsonb_build_object('source', p_source) end;
  $$;
create function tests.cover(p_user text, p_name text, p_recipe uuid, p_token uuid) returns text
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
grant execute on function tests.i(text), tests.rev(text), tests.rc(text, jsonb, jsonb),
  tests.cover(text, text, uuid, uuid) to authenticated, service_role;

-- Nothing reachable ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.recipe_shares', 'The API cannot read shares');
select tests.assert_denied('select * from private.recipe_import_attempts', 'Nor import attempts');
select tests.assert_denied(
  $$select private.can_share_recipe(null::private.recipes, tests.user_id('alice'))$$,
  'Nor the new permission helpers');
select tests.act_as_anon();
select tests.assert_denied($$select public.share_recipe(gen_random_uuid(), gen_random_uuid(), false)$$,
  'Nobody signed out shares');
select tests.assert_denied($$select public.begin_recipe_import()$$, 'Nor imports');
select tests.assert_denied($$select * from public.find_recipe_duplicates()$$, 'Nor looks for duplicates');

-- Who may share --------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-c'), tests.rc('Stoofvlees', '["Winter"]'),
    tests.i('home-c'), true)),
  'Alice publishes a recipe in Home C, where she is alone');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('d-alice'), tests.rc('Concept'))),
  'And keeps a private draft');
select tests.assert_true(public.share_recipe(tests.i('d-alice'), tests.i('home-a'), false) = 'not_permitted',
  'A draft cannot be shared');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-c'), false) = 'destination_unavailable',
  'Nor shared into its own origin');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-b'), false) = 'destination_unavailable',
  'Nor into a Home she does not belong to (a forged Home id)');
select tests.assert_true(public.share_recipe(tests.i('r-c'), gen_random_uuid(), false) = 'destination_unavailable',
  'Nor into one that does not exist');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipe_shares(tests.i('r-c')) where state <> 'available'),
  'It is shared nowhere yet');
select tests.assert_true(
  (select array_agg(home_id order by home_id) = array[tests.i('home-a')]
    from public.list_recipe_shares(tests.i('r-c')) where state = 'available'),
  'She may share it with Home A only (never its origin, never a Home she is not in)');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-a'), false) = 'shared',
  'She shares it with Home A, view only');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-a'), false) = 'unchanged',
  'A repeat changes nothing');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.recipe_shares where recipe_id = tests.i('r-c')),
  'One share, never two');

select tests.act_as('bob');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-b'), false) = 'not_permitted',
  'Bob, who sees it in Home A, cannot share it onward');
select tests.assert_true((select count(*) = 0 from public.list_recipe_shares(tests.i('r-c'))),
  'Nor see where it is shared');
select tests.assert_true(public.unshare_recipe(tests.i('r-c'), tests.i('home-a')) = 'not_permitted',
  'Nor remove it from Home A without manageHomeRecipes');
select tests.act_as('carol');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-b'), false) = 'not_permitted',
  'Nor can Carol');
select tests.assert_true(public.share_recipe(gen_random_uuid(), tests.i('home-b'), false) = 'not_found',
  'An unknown recipe is not found');

-- Visibility ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes(tests.i('home-a')) where id = tests.i('r-c') and shared_in),
  'Carol finds it in Home A''s library, marked as shared in');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes(tests.i('home-a'), 'stoof')),
  'And by searching');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes(tests.i('home-a'), null, array['winter'])),
  'And by its tag');
select tests.assert_true(
  (select recipe_count = 1 from public.list_recipe_tags(tests.i('home-a')) where tag = 'Winter'),
  'Its tags count in Home A');
select tests.assert_true(
  (select count(*) = 1 from public.recipe_widget(tests.i('home-a'), 'recent', 5) where id = tests.i('r-c')),
  'Home A''s widget shows it');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-b')) where id = tests.i('r-c')),
  'Home B, where it is not shared, does not');
select tests.assert_true(public.get_recipe(tests.i('r-c')) is null,
  'Where it lives (Home C) she sees nothing of it');
select tests.assert_true(public.get_recipe(tests.i('r-c'), tests.i('home-c')) is null,
  'Not even naming Home C');
select tests.assert_true(public.get_recipe(tests.i('r-c'), tests.i('home-b')) is null,
  'Nor from Home B');
select tests.assert_true(
  (select (d ->> 'sharedIn')::boolean and d ->> 'homeId' is null and d ->> 'contextHomeId' = tests.i('home-a')::text
      and (d #>> '{createdBy,member}') is null and not (d #>> '{createdBy,me}')::boolean
      and (d #>> '{updatedBy,member}') is null
      and not (d #>> '{can,edit}')::boolean and not (d #>> '{can,delete}')::boolean
      and not (d #>> '{can,share}')::boolean and not (d #>> '{can,unshareHere}')::boolean
      and (d ->> 'shareCount')::integer = 0
    from public.get_recipe(tests.i('r-c'), tests.i('home-a')) d),
  'From Home A it reads as shared in, naming neither its origin nor its people, with no rights to change it');
select tests.act_as('alice');
select tests.assert_true(
  (select not (d ->> 'sharedIn')::boolean and d ->> 'homeId' = tests.i('home-c')::text
      and (d #>> '{can,share}')::boolean and (d #>> '{can,delete}')::boolean
      and (d ->> 'shareCount')::integer = 1
    from public.get_recipe(tests.i('r-c')) d),
  'Where it lives, Alice sees it is hers to share and delete, shared with one Home');

-- Covers follow the canonical recipe.
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-alice'))),
  'Alice takes the lock to add a cover');
select tests.assert_true(tests.cover('alice', 'f-c', tests.i('r-c'), tests.i('tok-alice')) = 'ready', 'Uploads it');
select tests.assert_true(
  (select outcome = 'saved' from public.update_recipe(tests.i('r-c'), tests.rev('r-c'),
    tests.rc('Stoofvlees', '["Winter"]') || jsonb_build_object('coverFileId', tests.i('f-c')), tests.i('tok-alice'))),
  'And saves it');
select tests.act_as('carol');
select tests.assert_true((select count(*) = 1 from public.authorize_file_read(tests.i('f-c'))),
  'Carol, in Home A, may read the cover');
select tests.act_as_owner();
select tests.assert_true(
  (select p.owner_home_id = tests.i('home-c') from private.stored_files f
    join private.storage_pools p on p.id = f.pool_id where f.id = tests.i('f-c')),
  'Charged to its origin''s storage, never copied');

-- Editing across Homes ------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob'), false, tests.i('home-a'))),
  'A view-only share lets nobody in Home A edit');
select tests.act_as('alice');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-a'), true) = 'updated',
  'Alice lets Home A''s recipe managers edit it');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob'), false, tests.i('home-a'))),
  'Bob, an Administrator without manageHomeRecipes, still cannot');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeRecipes']);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob'), false, tests.i('home-a'))),
  'Carol, a plain member, cannot either');
select tests.act_as('bob');
select tests.assert_true(
  (select (d #>> '{can,edit}')::boolean and not (d #>> '{can,delete}')::boolean
      and not (d #>> '{can,share}')::boolean and (d #>> '{can,unshareHere}')::boolean
    from public.get_recipe(tests.i('r-c'), tests.i('home-a')) d),
  'Now Bob may edit it and remove it from Home A, never delete or share it');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob'), false, tests.i('home-a'))),
  'Bob takes the one lock from Home A');
select tests.assert_true(
  (select outcome = 'not_found' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob'), false, tests.i('home-b'))),
  'Naming a Home it is not shared with finds nothing');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'locked' and not held_by_me and held_by_member is null
    from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-alice'))),
  'From Home C, Alice is told someone else is editing, not who (Bob is not in Home C)');
select tests.assert_true(
  (select outcome = 'locked' and held_by_member = tests.i('m-bob-a')
    from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-alice'), false, tests.i('home-a'))),
  'From Home A, where they both belong, she is told it is Bob');
select tests.assert_true(
  (select (d -> 'lock') is not null and (d #>> '{lock,member}') is null and not (d #>> '{lock,mine}')::boolean
    from public.get_recipe(tests.i('r-c')) d),
  'Its page in Home C says only that someone is editing');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' from public.update_recipe(tests.i('r-c'), tests.rev('r-c'),
    tests.rc('Stoofvlees met bier', '["Winter"]') || jsonb_build_object('coverFileId', tests.i('f-c')), tests.i('tok-bob'))),
  'Bob saves a change from Home A');
select tests.act_as('alice');
select tests.assert_true((public.get_recipe(tests.i('r-c')) ->> 'name') = 'Stoofvlees met bier',
  'Alice sees the same recipe changed: one canonical record');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob-2'), false, tests.i('home-a'))),
  'Bob edits again');
select tests.act_as('alice');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-a'), false) = 'updated',
  'Alice makes the share view-only again');
select tests.act_as_owner();
select tests.assert_true(not exists (select 1 from private.recipe_edit_locks where recipe_id = tests.i('r-c')),
  'Bob''s lock ends at once');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome in ('not_permitted', 'lock_lost') from public.update_recipe(tests.i('r-c'), tests.rev('r-c'),
    tests.rc('Overschreven'), tests.i('tok-bob-2'))),
  'And his later save changes nothing');

-- Ratings and favorites per viewing context ------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and average = 5 and rating_count = 1
    from public.set_recipe_rating(tests.i('r-c'), 5, tests.i('home-a'))),
  'Carol rates it 5 from Home A');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_recipe_rating(tests.i('r-c'), 1)),
  'She cannot rate it where she cannot see it');
select tests.act_as('alice');
select tests.assert_true(
  (select average = 2 and rating_count = 1 from public.set_recipe_rating(tests.i('r-c'), 2)),
  'From Home C, Alice''s 2 is the only rating that counts (Carol is not in Home C)');
select tests.assert_true(
  (select (d #>> '{rating,average}')::numeric = 3.5 and (d #>> '{rating,count}')::integer = 2
    from public.get_recipe(tests.i('r-c'), tests.i('home-a')) d),
  'From Home A, both count');
select tests.assert_true(public.set_recipe_favorite(tests.i('r-c'), true) = 'saved', 'Alice favorites it in Home C');
select tests.assert_true(
  (select count(*) = 1 from public.list_recipes(tests.i('home-c'), null, null, true)),
  'It is among her favorites there');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-a'), null, null, true)),
  'But not in Home A');
select tests.act_as('carol');
select tests.assert_true(public.set_recipe_favorite(tests.i('r-c'), true, tests.i('home-a')) = 'saved',
  'Carol favorites it in Home A (a destination-only favorite)');
select tests.assert_true(
  (select count(*) = 1 from public.recipe_widget(tests.i('home-a'), 'favorites', 5)),
  'Her Home A favorites widget shows it');
select tests.assert_true(public.set_recipe_favorite(tests.i('r-c'), true, tests.i('home-b')) = 'not_found',
  'Not in Home B, where it is not shared');

-- Delete: impact review --------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.recipe_delete_impact(tests.i('r-c'))),
  'A destination member gets no impact review');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_recipe(tests.i('r-c'))),
  'And cannot delete the canonical recipe');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_recipe(tests.i('r-c'))),
  'Nor can a destination recipe manager');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'ok'
      and jsonb_array_length(impact -> 'shares') = 1
      and impact #>> '{shares,0,homeName}' = 'Thuis'
      and (impact ->> 'favoriteCount')::integer = 2
      and not (impact ->> 'beingEdited')::boolean
    from public.recipe_delete_impact(tests.i('r-c'))),
  'Alice''s review names Home A, counts two favorites and nobody editing');
select tests.assert_true(
  (select outcome = 'impact_review_required' from public.delete_recipe(tests.i('r-c'))),
  'Deleting a shared recipe without a review is refused');
select tests.assert_true(
  (select outcome = 'stale_impact' from public.delete_recipe(tests.i('r-c'), 'not-the-token')),
  'So is a review that does not match');
create temporary table tokens (name text primary key, token text not null) on commit drop;
grant all on tokens to authenticated;
insert into tokens select 'old', impact ->> 'token' from public.recipe_delete_impact(tests.i('r-c'));
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-a'), true) = 'updated',
  'Alice changes the share after reviewing');
select tests.assert_true(
  (select outcome = 'stale_impact' from public.delete_recipe(tests.i('r-c'), (select token from tokens where name = 'old'))),
  'The old review is stale');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('r-c'), tests.i('tok-bob'), false, tests.i('home-a'))),
  'Bob starts editing from Home A');
select tests.act_as('alice');
select tests.assert_true(
  (select (impact ->> 'beingEdited')::boolean from public.recipe_delete_impact(tests.i('r-c'))),
  'The fresh review says someone is editing');
select tests.assert_true(
  (select outcome = 'locked' from public.delete_recipe(tests.i('r-c'),
    (select impact ->> 'token' from public.recipe_delete_impact(tests.i('r-c'))))),
  'And the delete waits for him: his work is never discarded');
select tests.act_as('bob');
select public.release_recipe_lock(tests.i('r-c'), tests.i('tok-bob'));
select tests.act_as('alice');
insert into ids select 'e-c', entry_id from public.delete_recipe(tests.i('r-c'),
  (select impact ->> 'token' from public.recipe_delete_impact(tests.i('r-c')))) where outcome = 'deleted';
select tests.assert_true(tests.i('e-c') is not null, 'With a fresh review, Alice deletes it everywhere');
select tests.assert_true(
  (select outcome = 'not_found' from public.delete_recipe(tests.i('r-c'))), 'A repeat finds nothing');
select tests.act_as('carol');
select tests.assert_true(public.get_recipe(tests.i('r-c'), tests.i('home-a')) is null, 'Home A no longer sees it');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes(tests.i('home-a')) where id = tests.i('r-c')), 'Or lists it');
select tests.assert_true((select count(*) = 0 from public.authorize_file_read(tests.i('f-c'))), 'Or its cover');
select tests.act_as_owner();
select tests.assert_true(
  (select suspended_at is not null from private.recipe_shares where recipe_id = tests.i('r-c')),
  'The share is paused, not removed');

-- Restore: shares stay paused until reinstated.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('e-c')])), 'Alice restores it');
select tests.act_as('carol');
select tests.assert_true(public.get_recipe(tests.i('r-c'), tests.i('home-a')) is null,
  'Home A does not get it back silently');
select tests.act_as('alice');
select tests.assert_true(
  (select state = 'paused' and can_edit from public.list_recipe_shares(tests.i('r-c')) where home_id = tests.i('home-a')),
  'Alice sees the share as paused');
select tests.assert_true(public.share_recipe(tests.i('r-c'), tests.i('home-a'), false) = 'shared',
  'And reinstates it (rechecked like a new share), view only');
select tests.act_as('carol');
select tests.assert_true((public.get_recipe(tests.i('r-c'), tests.i('home-a')) ->> 'sharedIn')::boolean,
  'Now Home A sees it again');

-- Unsharing --------------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(public.unshare_recipe(tests.i('r-c'), tests.i('home-a')) = 'unshared',
  'Bob, a recipe manager of Home A, removes it from Home A');
select tests.assert_true(public.unshare_recipe(tests.i('r-c'), tests.i('home-a')) = 'not_found',
  'After which he no longer sees it');
select tests.act_as('carol');
select tests.assert_true(public.get_recipe(tests.i('r-c'), tests.i('home-a')) is null, 'Neither does Carol');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.recipe_favorites where recipe_id = tests.i('r-c') and context_home_id = tests.i('home-a')),
  'Home A''s favorites of it are gone');
select tests.assert_true(
  exists (select 1 from private.recipe_favorites where recipe_id = tests.i('r-c') and context_home_id = tests.i('home-c')),
  'Home C''s stay');
select tests.assert_true(exists (select 1 from private.recipes where id = tests.i('r-c') and deleted_at is null),
  'The recipe itself stays');
select tests.act_as('alice');
select tests.assert_true(public.unshare_recipe(tests.i('r-c'), tests.i('home-a')) = 'not_shared',
  'Alice removing it again finds nothing to remove');

-- Personal recipes ---------------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('p-alice'), tests.rc('Oma''s soep'), null, true)),
  'Alice publishes a Personal recipe');
select tests.assert_true(public.share_recipe(tests.i('p-alice'), tests.i('home-a'), false) = 'shared',
  'And shares it with Home A');
select tests.act_as('carol');
select tests.assert_true(public.get_recipe(tests.i('p-alice')) is null, 'Carol cannot read it as Alice''s own');
select tests.assert_true((public.get_recipe(tests.i('p-alice'), tests.i('home-a')) ->> 'name') = 'Oma''s soep',
  'She reads it in Home A');
select tests.assert_true(
  (select count(*) = 0 from public.list_recipes() where id = tests.i('p-alice')),
  'It never appears in Carol''s own Personal library');

-- Shared recipes need a manager to delete -------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-carol'), tests.rc('Pannenkoeken'), tests.i('home-a'), true)),
  'Carol publishes a recipe in Home A');
select tests.assert_true(public.share_recipe(tests.i('r-carol'), tests.i('home-b'), false) = 'not_permitted',
  'Being its creator does not let her share it');
select tests.act_as('bob');
select tests.assert_true(public.share_recipe(tests.i('r-carol'), tests.i('home-b'), false) = 'shared',
  'Bob, a recipe manager of Home A who is in Home B, shares it there');
select tests.act_as('carol');
select tests.assert_true(not (public.get_recipe(tests.i('r-carol')) #>> '{can,delete}')::boolean,
  'Now Carol, its creator, may no longer delete it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_recipe(tests.i('r-carol'))), 'And is refused');
select tests.assert_true((public.get_recipe(tests.i('r-carol')) #>> '{can,edit}')::boolean, 'But still edits it');

-- Departures ------------------------------------------------------------------------------------------

-- The creator leaves the origin: the destination keeps it.
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_true(public.get_recipe(tests.i('r-carol')) is null, 'Carol left Home A: its recipe is not hers to see there');
select tests.assert_true(
  (select (d ->> 'sharedIn')::boolean and not (d #>> '{can,edit}')::boolean
    from public.get_recipe(tests.i('r-carol'), tests.i('home-b')) d),
  'In Home B she still sees it, with no rights over it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_recipe(tests.i('r-carol'))), 'And cannot delete it');

-- A destination editor leaves the destination: their lock ends.
select tests.act_as('alice');
select tests.assert_true(public.share_recipe(tests.i('p-alice'), tests.i('home-a'), true) = 'updated',
  'Alice lets Home A''s recipe managers edit her Personal recipe');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('p-alice'), tests.i('tok-bob'), false, tests.i('home-a'))),
  'Bob edits it from Home A');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('bob');
select tests.assert_true(not exists (select 1 from private.recipe_edit_locks where recipe_id = tests.i('p-alice')),
  'Bob leaves Home A: his lock ends at once');
select tests.act_as('bob');
select tests.assert_true(public.get_recipe(tests.i('p-alice'), tests.i('home-a')) is null, 'And he no longer sees it');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_recipe(tests.i('p-alice'), tests.rev('p-alice'), tests.rc('x'), tests.i('tok-bob'))),
  'Nor saves it');

-- Import sources and duplicates ------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(), tests.rc('X', p_source => '{"url": "javascript:alert(1)", "name": null}'))$$,
  'A source must be an http(s) URL', '22023');
select tests.assert_denied(
  $$select * from public.create_recipe(gen_random_uuid(), tests.rc('X', p_source => '{"url": "https://a.example/ b", "name": null}'))$$,
  'Without spaces', '22023');
select tests.assert_true(
  (select outcome = 'created' from public.create_recipe(tests.i('r-src'),
    tests.rc('Lasagne', p_source => '{"url": "https://recepten.example/lasagne", "name": "Recepten.example"}'),
    tests.i('home-a'), true)),
  'Alice saves an imported recipe into Home A');
select tests.assert_true(
  (select d #>> '{source,url}' = 'https://recepten.example/lasagne' and d #>> '{source,name}' = 'Recepten.example'
    from public.get_recipe(tests.i('r-src')) d),
  'It keeps its source');
select tests.assert_true(
  (select outcome = 'acquired' from public.acquire_recipe_lock(tests.i('r-src'), tests.i('tok-alice'))), 'She edits it');
select tests.assert_true(
  (select outcome = 'saved' from public.update_recipe(tests.i('r-src'), tests.rev('r-src'),
    tests.rc('Lasagne', p_source => '{"url": "https://elders.example/", "name": "Elders"}'), tests.i('tok-alice'))),
  'A save that sends another source');
select tests.assert_true(
  (public.get_recipe(tests.i('r-src')) #>> '{source,url}') = 'https://recepten.example/lasagne',
  'Never changes it');
select tests.assert_true(
  (select count(*) = 1 from public.find_recipe_duplicates(tests.i('home-a'), 'Iets anders', 'https://recepten.example/lasagne')
    where id = tests.i('r-src') and match = 'source'),
  'The same source URL is a likely duplicate in Home A');
select tests.assert_true(
  (select count(*) = 1 from public.find_recipe_duplicates(tests.i('home-a'), '  LASAGNE ', null) where match = 'name'),
  'So is the same name, ignoring case and spaces');
select tests.assert_true(
  (select count(*) = 0 from public.find_recipe_duplicates(null, 'Lasagne', 'https://recepten.example/lasagne')),
  'Not in her Personal space, where it does not live');
select tests.act_as('bob');
select tests.assert_true(
  (select count(*) = 1 from public.create_recipe(tests.i('d-bob'), tests.rc('Lasagne'), tests.i('home-b')) where outcome = 'created'),
  'Bob keeps a draft named Lasagne');
select tests.assert_true(
  (select count(*) = 1 from public.find_recipe_duplicates(tests.i('home-b'), 'Lasagne', null) where id = tests.i('d-bob')),
  'His own draft counts for him');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 0 from public.find_recipe_duplicates(tests.i('home-b'), 'Lasagne', null)),
  'Never someone else''s draft');
select tests.assert_denied(
  $$select * from public.find_recipe_duplicates(tests.i('home-c'), 'Lasagne', null)$$,
  'Nor a Home she is not in');

-- Import rate limit -----------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select bool_and(public.begin_recipe_import() = 'ok') from generate_series(1, 20)),
  'Carol starts 20 imports in an hour');
select tests.assert_true(public.begin_recipe_import() = 'rate_limited', 'The 21st waits');
select tests.act_as('alice');
select tests.assert_true(public.begin_recipe_import() = 'ok', 'Others are not affected');

-- Audit -------------------------------------------------------------------------------------------------

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) >= 1 from private.audit_events
    where home_id = tests.i('home-a') and action = 'recipe.shared_in' and subject_id = tests.i('r-c')),
  'Home A records that a recipe was shared in');
select tests.assert_true(
  not exists (select 1 from private.audit_events
    where subject_type = 'recipe' and (details ? 'name' or details ? 'homeId' or details ? 'destinationHomeId'
      or details::text ilike '%stoof%' or details::text ilike '%Thuis%')),
  'Audit keeps no content and names no other Home');
