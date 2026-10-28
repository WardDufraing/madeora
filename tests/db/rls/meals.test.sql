-- S27: meal planner (supabase/migrations/*_meal_planner.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Carol is not in. Covers: nothing reachable
-- as a table; slots (standard ones once, custom, names, limit, order, disable impact); the access
-- matrix (Personal owner; members with edit and view access; meal managers and a revoked grant;
-- non-members, forged ids and a departed member); meals (recipe and custom, occupied slot and explicit
-- replace, revisions, moves, disabled slot, trash and restore); recipe visibility from the planner's
-- context (other Home, shared then unshared, Personal); repeating meals (collision preview and
-- decisions, skip and undo, edit and move one, edit this and future without changing the past, pause,
-- resume, end, weekdays and weekly, two series colliding later); copy week (mapping, unavailable
-- recipe, occupied skip and replace, repeating source copied as meals, stale token, retry);
-- ingredient transfers (occurrences once, custom and unavailable meals, other-context list, stale
-- token, retry); the recipe delete impact.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Brussels', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');

insert into ids select n, gen_random_uuid() from unnest(array[
  'r-lasagne', 'r-kiwi', 'r-shared', 'r-personal', 'r-noyield',
  's-snacks', 's-x1', 's-x2', 's-x3', 's-x4', 's-x5', 's-personal',
  'e-pizza', 'e-bob', 'e-shared', 'e-lasagne', 'e-p', 'e-b', 'e-view', 'e-occ', 'e-move', 'e-x',
  'e-copy-1', 'e-copy-2', 'e-copy-3', 'e-copy-4', 'e-trash',
  'se-daily', 'se-lunch', 'se-late-1', 'se-late-2', 'se-b', 'se-bad',
  'l-a', 'l-a2', 'l-personal', 'l-b', 't-1', 't-2', 'i-1', 'i-2', 'i-3'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
-- A date relative to Home A's today.
create function tests.d(p_days integer) returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date + p_days; $$;
create function tests.slot(p_home uuid, p_key text) returns uuid
  language sql stable security definer as $$
  select id from private.meal_slots where owner_home_id = p_home and standard_key = p_key; $$;
create function tests.entry_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.meal_entries where id = tests.i(p_name); $$;
create function tests.series_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.meal_series where id = tests.i(p_name); $$;
create function tests.slot_rev(p_id uuid) returns integer
  language sql stable security definer as $$ select revision from private.meal_slots where id = p_id; $$;
-- The meals (entries and occurrences) in one slot and date of a plan answer.
create function tests.at(p_plan jsonb, p_on date, p_slot uuid) returns jsonb
  language sql immutable as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select x from jsonb_array_elements(p_plan -> 'entries') x
      where (x ->> 'date')::date = p_on and (x ->> 'slotId')::uuid = p_slot
    union all
    select x from jsonb_array_elements(p_plan -> 'occurrences') x
      where (x ->> 'date')::date = p_on and (x ->> 'slotId')::uuid = p_slot
  ) y; $$;
create function tests.plan(p_home text, p_from integer, p_to integer) returns jsonb
  language sql as $$ select public.get_meal_plan(tests.i(p_home), tests.d(p_from), tests.d(p_to)); $$;
create function tests.current_recurrence(p_series text) returns uuid
  language sql stable security definer as $$
  select id from private.meal_recurrences where series_id = tests.i(p_series)
  order by seq desc limit 1; $$;
create function tests.first_recurrence(p_series text) returns uuid
  language sql stable security definer as $$
  select id from private.meal_recurrences where series_id = tests.i(p_series)
  order by seq limit 1; $$;
grant execute on function tests.i(text), tests.d(integer), tests.slot(uuid, text), tests.entry_rev(text),
  tests.series_rev(text), tests.slot_rev(uuid), tests.at(jsonb, date, uuid), tests.plan(text, integer, integer),
  tests.current_recurrence(text), tests.first_recurrence(text)
  to authenticated, service_role;

-- Recipes: Home A's Lasagne (serves 4) and one without a yield, Home B's Kiwi (shared with A later
-- as r-shared), Alice's Personal recipe.
insert into private.recipes (id, owner_user_id, owner_home_id, status, name, name_key, servings, published_at, created_by)
values
  (tests.i('r-lasagne'), null, tests.i('home-a'), 'published', 'Lasagne', 'lasagne', 4, now(), tests.user_id('alice')),
  (tests.i('r-noyield'), null, tests.i('home-a'), 'published', 'Soep', 'soep', null, now(), tests.user_id('alice')),
  (tests.i('r-kiwi'), null, tests.i('home-b'), 'published', 'Kiwi', 'kiwi', 2, now(), tests.user_id('bob')),
  (tests.i('r-shared'), null, tests.i('home-b'), 'published', 'Gedeeld', 'gedeeld', 2, now(), tests.user_id('bob')),
  (tests.i('r-personal'), tests.user_id('alice'), null, 'published', 'Eigen', 'eigen', 1, now(), tests.user_id('alice'));
insert into private.recipe_ingredients (recipe_id, position, name, name_key, quantity_num, quantity_den, quantity_style, unit, note)
values
  (tests.i('r-lasagne'), 0, 'Pasta', 'pasta', 500, 1, 'decimal', 'g', null),
  (tests.i('r-lasagne'), 1, 'Melk', 'melk', 1, 2, 'fraction', 'l', 'vol'),
  (tests.i('r-lasagne'), 2, 'Oregano', 'oregano', 1, 1, 'decimal', 'tsp', null),
  (tests.i('r-noyield'), 0, 'Prei', 'prei', 2, 1, 'decimal', 'piece', null);
insert into private.recipe_shares (recipe_id, home_id, can_edit, shared_by)
  values (tests.i('r-shared'), tests.i('home-a'), false, tests.user_id('bob'));

-- Nothing reachable ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.meal_entries', 'The API cannot read meals');
select tests.assert_denied('select * from private.meal_slots', 'Nor slots');
select tests.assert_denied('select * from private.meal_series', 'Nor series');
select tests.assert_denied('select * from private.meal_recurrences', 'Nor segments');
select tests.assert_denied('select * from private.meal_occurrence_exceptions', 'Nor exceptions');
select tests.assert_denied('select * from private.meal_settings', 'Nor settings');
select tests.assert_denied('select * from private.meal_shopping_transfers', 'Nor transfers');
select tests.assert_denied($$select private.meal_access(null, tests.user_id('alice'))$$, 'Nor the helpers');
select tests.act_as_anon();
select tests.assert_denied('select public.get_meal_plan()', 'Nobody signed out reads a plan');

-- Opening and slots -------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(tests.plan('home-a', 0, 6) -> 'slots') = 3
    and (tests.plan('home-a', 0, 6) -> 'slots' -> 0 ->> 'standardKey') = 'breakfast'
    and (tests.plan('home-a', 0, 6) -> 'slots' -> 2 ->> 'standardKey') = 'dinner'),
  'The first open creates Breakfast, Lunch and Dinner, once, in that order');
select tests.assert_true((tests.plan('home-a', 0, 0) ->> 'access') = 'edit', 'A member plans by default');
select tests.assert_denied($$select public.get_meal_plan(tests.i('home-b'))$$, 'Not a Home she is not in');
select tests.assert_denied($$select public.get_meal_plan(tests.i('home-a'), tests.d(0), tests.d(42))$$,
  'At most 42 days at once', '22023');
select tests.assert_denied($$select public.get_meal_plan(tests.i('home-a'), tests.d(3), tests.d(1))$$,
  'A range ends after it starts', '22023');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_meal_slot(tests.i('s-snacks'), 'Snacks', tests.i('home-a'))),
  'A member does not configure slots');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_meal_settings(tests.i('home-a'), 0, 'view')),
  'Nor the member access');

select tests.act_as('bob');
select tests.assert_true((tests.plan('home-a', 0, 0) ->> 'access') = 'edit',
  'An Administrator without manageHomeMeals plans but does not manage');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeMeals']);
select tests.act_as('bob');
select tests.assert_true((tests.plan('home-a', 0, 0) ->> 'access') = 'manage',
  'Granted manageHomeMeals, Bob manages the planner');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_slot(tests.i('s-snacks'), 'Snacks', tests.i('home-a'))),
  'Bob adds Snacks');
select tests.assert_true(
  (select outcome = 'exists' from public.create_meal_slot(tests.i('s-snacks'), 'Snacks', tests.i('home-a'))),
  'A retry returns the same slot');
select tests.assert_true(
  (select outcome = 'name_taken' from public.create_meal_slot(gen_random_uuid(), 'snacks', tests.i('home-a'))),
  'Names are distinct regardless of case');
select tests.assert_true(
  (select outcome = 'name_taken' from public.create_meal_slot(gen_random_uuid(), 'avondeten', tests.i('home-a'))),
  'A custom name cannot read like an unrenamed standard slot (nl)');
select tests.assert_true(
  (select outcome = 'name_taken' from public.create_meal_slot(gen_random_uuid(), 'DINNER', tests.i('home-a'))),
  'Nor like one in English');
select tests.assert_denied($$select * from public.create_meal_slot(gen_random_uuid(), ' ', tests.i('home-a'))$$,
  'A blank name is refused', '22023');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_meal_slot(gen_random_uuid(), 'Brunch', tests.i('home-a'))),
  'Once the grant is revoked he no longer configures slots');

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_slot(tests.slot(tests.i('home-a'), 'dinner'),
    tests.slot_rev(tests.slot(tests.i('home-a'), 'dinner')), 'Avondmaal', true)),
  'The Owner renames Dinner');
select tests.assert_true(
  (select (s ->> 'name') = 'Avondmaal' and (s ->> 'standardKey') = 'dinner'
    from jsonb_array_elements(tests.plan('home-a', 0, 0) -> 'slots') s
    where (s ->> 'id')::uuid = tests.slot(tests.i('home-a'), 'dinner')),
  'It keeps its identity');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_meal_slot(tests.slot(tests.i('home-a'), 'dinner'), 1, null, true)),
  'A rename from an old revision conflicts');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_slot(tests.slot(tests.i('home-a'), 'dinner'),
    tests.slot_rev(tests.slot(tests.i('home-a'), 'dinner')), null, true)),
  'And it goes back to the standard name');
select tests.assert_denied($$select * from public.update_meal_slot(tests.i('s-snacks'), tests.slot_rev(tests.i('s-snacks')), null, true)$$,
  'A custom slot always has a name', '22023');
select public.create_meal_slot(tests.i(n), 'Extra ' || n, tests.i('home-a')) from unnest(array['s-x1', 's-x2', 's-x3', 's-x4']) n;
select tests.assert_true(
  (select outcome = 'limit_reached' from public.create_meal_slot(tests.i('s-x5'), 'Extra 5', tests.i('home-a'))),
  'At most 8 slots');
select tests.assert_true(public.move_meal_slot(tests.i('s-snacks'), 'up') = 'saved', 'Snacks moves up one place');
select tests.assert_true(
  (select (tests.plan('home-a', 0, 0) -> 'slots' -> 2 ->> 'id')::uuid = tests.i('s-snacks')
    and (tests.plan('home-a', 0, 0) -> 'slots' -> 3 ->> 'standardKey') = 'dinner'),
  'Before Dinner now');
select tests.assert_true(public.move_meal_slot(tests.slot(tests.i('home-a'), 'breakfast'), 'up') = 'unchanged',
  'The first slot cannot move up');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_slot(tests.i('s-x4'), tests.slot_rev(tests.i('s-x4')), 'Extra s-x4', false)),
  'An empty slot is disabled without an impact review');

-- Personal planner: its own slots, its owner manages.
select tests.assert_true(
  (select jsonb_array_length(public.get_meal_plan(null, current_date, current_date) -> 'slots') = 3
    and (public.get_meal_plan(null, current_date, current_date) ->> 'access') = 'manage'),
  'The Personal space has its own three slots and its owner manages them');

-- Meals -------------------------------------------------------------------------------------------

select tests.act_as('bob');
select public.get_meal_plan(tests.i('home-b')) is not null;

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_entry(tests.i('e-pizza'), tests.d(1),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), null, 'Pizza afhalen', 'Om 19u')),
  'Carol plans a custom meal');
select tests.assert_true(
  (select outcome = 'exists' from public.create_meal_entry(tests.i('e-pizza'), tests.d(1),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), null, 'Pizza afhalen', 'Om 19u')),
  'A retry returns the same meal');
select tests.assert_denied(
  $$select * from public.create_meal_entry(gen_random_uuid(), tests.d(2), tests.slot(tests.i('home-a'), 'dinner'),
    tests.i('home-a'), null, '   ')$$,
  'An empty custom title is refused', '22023');
select tests.assert_denied(
  $$select * from public.create_meal_entry(gen_random_uuid(), tests.d(2), tests.slot(tests.i('home-a'), 'dinner'),
    tests.i('home-a'), tests.i('r-lasagne'), 'Both')$$,
  'A meal is a recipe or a custom title, never both', '22023');
select tests.assert_true(
  (select outcome = 'recipe_unavailable' from public.create_meal_entry(gen_random_uuid(), tests.d(2),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), tests.i('r-kiwi'))),
  'Another Home''s recipe cannot be planned');
select tests.assert_true(
  (select outcome = 'recipe_unavailable' from public.create_meal_entry(gen_random_uuid(), tests.d(2),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), tests.i('r-personal'))),
  'Nor someone''s Personal recipe');
select tests.assert_true(
  (select outcome = 'slot_unavailable' from public.create_meal_entry(gen_random_uuid(), tests.d(2),
    tests.i('s-x4'), tests.i('home-a'), null, 'Niet hier')),
  'Nor anything in a disabled slot');
select tests.assert_true(
  (select outcome = 'slot_unavailable' from public.create_meal_entry(gen_random_uuid(), tests.d(2),
    tests.slot(tests.i('home-b'), 'dinner'), tests.i('home-a'), null, 'Vals')),
  'Nor in another context''s slot');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_entry(tests.i('e-shared'), tests.d(2),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), tests.i('r-shared'), null, null, 3)),
  'A recipe shared with the Home can be planned');
select tests.assert_true(
  (select (m -> 0 -> 'recipe' ->> 'name') = 'Gedeeld' and (m -> 0 ->> 'servings')::integer = 3
    from tests.at(tests.plan('home-a', 0, 6), tests.d(2), tests.slot(tests.i('home-a'), 'dinner')) m),
  'And shows with its name and the chosen servings');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'occupied' and jsonb_array_length(occupied -> 'occupants') = 1
    and (occupied -> 'occupants' -> 0 ->> 'id')::uuid = tests.i('e-pizza')
    from public.create_meal_entry(tests.i('e-bob'), tests.d(1), tests.slot(tests.i('home-a'), 'dinner'),
      tests.i('home-a'), tests.i('r-lasagne'))),
  'An occupied slot answers what is there; nothing is overwritten');
select tests.assert_true(
  (select outcome = 'occupied' from public.create_meal_entry(tests.i('e-bob'), tests.d(1),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), tests.i('r-lasagne'), p_replace => 'wrong')),
  'A replace that does not name what is there is refused');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_entry(tests.i('e-bob'), tests.d(1),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), tests.i('r-lasagne'),
    p_replace => 'e' || tests.i('e-pizza')::text || '.1')),
  'Replacing explicitly works');
select tests.act_as_owner();
select tests.assert_true(
  (select deleted_at is not null from private.meal_entries where id = tests.i('e-pizza'))
    and exists (select 1 from private.trash_entries where subject_id = tests.i('e-pizza') and status = 'trashed'),
  'The replaced meal went to the trash');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_meal_entry(tests.i('e-bob'), 7, tests.d(1),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('r-lasagne'))),
  'An edit from an old revision conflicts');
select tests.assert_true(
  (select outcome = 'occupied' from public.update_meal_entry(tests.i('e-bob'), 1, tests.d(2),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('r-lasagne'))),
  'Moving onto another meal answers occupied');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.update_meal_entry(tests.i('e-bob'), 1, tests.d(3),
    tests.slot(tests.i('home-a'), 'lunch'), tests.i('r-lasagne'), null, 'Met salade', 6)),
  'Moving to a free slot and date saves');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_entry(tests.i('e-bob'), 2, tests.d(3),
    tests.slot(tests.i('home-a'), 'lunch'), null, 'Restjes')),
  'A recipe meal can become a custom one explicitly');

-- Recipe visibility from the planner's context.
select tests.act_as_owner();
update private.recipe_shares set suspended_at = now() where recipe_id = tests.i('r-shared');
select tests.act_as('carol');
select tests.assert_true(
  (select (m -> 0 -> 'recipe') = 'null'::jsonb and (m -> 0 ->> 'type') = 'recipe'
    and (m -> 0 ->> 'id')::uuid = tests.i('e-shared')
    from tests.at(tests.plan('home-a', 0, 6), tests.d(2), tests.slot(tests.i('home-a'), 'dinner')) m),
  'A share that ended leaves the meal as an unavailable recipe, with no name');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_entry(tests.i('e-shared'), 1, tests.d(2),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('r-shared'), null, 'Notitie', 3)),
  'Its notes can still be edited without choosing another recipe');

-- View-only members.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_settings(tests.i('home-a'), 0, 'view')),
  'The Owner sets the planner to view only');
select tests.act_as('carol');
select tests.assert_true((tests.plan('home-a', 0, 0) ->> 'access') = 'view', 'Carol now views only');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_meal_entry(tests.i('e-view'), tests.d(5),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), null, 'Nee')),
  'And cannot plan');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_meal_entry(tests.i('e-shared'), 2)),
  'Nor remove');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_meal_settings(tests.i('home-a'), 0, 'edit')),
  'Settings are revision checked');
select public.update_meal_settings(tests.i('home-a'), 1, 'edit');

-- Trash and restore.
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_entry(tests.i('e-trash'), tests.d(4),
    tests.slot(tests.i('home-a'), 'breakfast'), tests.i('home-a'), null, 'Pannenkoeken')),
  'Carol plans breakfast');
insert into ids select 'trash-1', entry_id from public.delete_meal_entry(tests.i('e-trash'), 1);
select tests.assert_true((select id is not null from ids where name = 'trash-1'), 'Removing a meal puts it in the trash');
select tests.assert_true(
  (select jsonb_array_length(m) = 0 from tests.at(tests.plan('home-a', 0, 6), tests.d(4),
    tests.slot(tests.i('home-a'), 'breakfast')) m),
  'It is gone from the plan');
select public.create_meal_entry(tests.i('e-x'), tests.d(4), tests.slot(tests.i('home-a'), 'breakfast'),
  tests.i('home-a'), null, 'Yoghurt');
select tests.assert_true(
  (select outcome <> 'restored' and conflict = 'meal_slot_occupied'
    from public.restore_trash_entries(array[tests.i('trash-1')])),
  'A restore into a taken slot is refused');
select public.delete_meal_entry(tests.i('e-x'), 1);
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(array[tests.i('trash-1')])),
  'Once it is free the meal comes back');

-- Isolation and forged ids.
select tests.act_as('bob');
select public.create_meal_entry(tests.i('e-b'), tests.d(1), tests.slot(tests.i('home-b'), 'dinner'),
  tests.i('home-b'), tests.i('r-kiwi'));
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_meal_entry(tests.i('e-b'), 1, tests.d(1),
    tests.slot(tests.i('home-b'), 'dinner'), null, 'Gekaapt')),
  'Another Home''s meal is not found');
select tests.assert_true(
  (select outcome = 'not_found' from public.delete_meal_entry(tests.i('e-b'), 1)), 'Nor removable');
select tests.assert_true(
  (select outcome = 'not_found' from public.meal_slot_impact(tests.slot(tests.i('home-b'), 'dinner'))),
  'Nor its slots');
select tests.assert_true(
  (select outcome = 'id_taken' from public.create_meal_entry(tests.i('e-b'), tests.d(6),
    tests.slot(tests.i('home-a'), 'dinner'), tests.i('home-a'), null, 'Id')),
  'Another Home''s meal id cannot be claimed');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_entry(tests.i('e-p'), current_date,
    (select (s ->> 'id')::uuid from jsonb_array_elements(public.get_meal_plan(null) -> 'slots') s
      where s ->> 'standardKey' = 'lunch'), null, tests.i('r-personal'))),
  'Alice plans her Personal recipe in her Personal space');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_meal_entry(tests.i('e-p'), 1, current_date,
    gen_random_uuid(), null, 'Nee')),
  'Nobody else reaches a Personal meal');

-- Slot disable impact.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'impact_required' and (impact ->> 'futureMeals')::integer = 1
    from public.update_meal_slot(tests.slot(tests.i('home-a'), 'dinner'),
      tests.slot_rev(tests.slot(tests.i('home-a'), 'dinner')), null, false)),
  'Disabling a slot with meals needs its impact reviewed first');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_slot(tests.slot(tests.i('home-a'), 'dinner'),
    tests.slot_rev(tests.slot(tests.i('home-a'), 'dinner')), null, false,
    (select impact ->> 'token' from public.meal_slot_impact(tests.slot(tests.i('home-a'), 'dinner'))))),
  'With the reviewed impact it is disabled');
select tests.assert_true(
  (select jsonb_array_length(m) = 1 from tests.at(tests.plan('home-a', 0, 6), tests.d(2),
    tests.slot(tests.i('home-a'), 'dinner')) m),
  'Its meals stay visible');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_slot(tests.slot(tests.i('home-a'), 'dinner'),
    tests.slot_rev(tests.slot(tests.i('home-a'), 'dinner')), null, true)),
  'And re-enabling it changes nothing else');

-- Repeating meals ---------------------------------------------------------------------------------

-- Daily dinner from day 2 to day 8: day 2 already holds the shared-recipe meal.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'ok' and jsonb_array_length(preview -> 'collisions') = 1
    and (preview -> 'collisions' -> 0 ->> 'date')::date = tests.d(2)
    and jsonb_array_length(preview -> 'nextDates') = 3
    from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'daily', null, tests.d(2),
      tests.i('home-a'), tests.d(8))),
  'The preview shows the next dates and the one collision');
select tests.assert_true(
  (select outcome = 'invalid_date' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'),
    'daily', null, tests.d(-1), tests.i('home-a'))),
  'A series never starts in the past');
select tests.assert_denied(
  $$select * from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'weekly',
    array[1, 3]::smallint[], tests.d(2), tests.i('home-a'))$$,
  'Weekly has exactly one weekday', '22023');
select tests.assert_denied(
  $$select * from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'weekdays',
    array[]::smallint[], tests.d(2), tests.i('home-a'))$$,
  'Chosen weekdays need at least one', '22023');
select tests.assert_true(
  (select outcome = 'conflicts' and jsonb_array_length(collisions) = 1
    from public.create_meal_series(tests.i('se-daily'), tests.slot(tests.i('home-a'), 'dinner'), 'daily',
      null, tests.d(2), 'stale', tests.i('home-a'), tests.d(8), null, 'Stamppot')),
  'A save without the current preview token answers the collisions; nothing saved');
select tests.assert_denied(
  $$select * from public.create_meal_series(tests.i('se-daily'), tests.slot(tests.i('home-a'), 'dinner'), 'daily',
    null, tests.d(2),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'daily',
      null, tests.d(2), tests.i('home-a'), tests.d(8))),
    tests.i('home-a'), tests.d(8), null, 'Stamppot')$$,
  'Every collision needs a choice', '22023');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_series(tests.i('se-daily'),
    tests.slot(tests.i('home-a'), 'dinner'), 'daily', null, tests.d(2),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'daily',
      null, tests.d(2), tests.i('home-a'), tests.d(8))),
    tests.i('home-a'), tests.d(8), null, 'Stamppot', null, null,
    jsonb_build_object(tests.d(2)::text, 'skip'))),
  'With the collision decided (skip) the series starts');
select tests.assert_true(
  (select jsonb_array_length(m) = 1 and (m -> 0 ->> 'kind') = 'entry'
    from tests.at(tests.plan('home-a', 0, 9), tests.d(2), tests.slot(tests.i('home-a'), 'dinner')) m)
  and (select jsonb_array_length(m) = 1 and (m -> 0 ->> 'kind') = 'occurrence' and (m -> 0 ->> 'title') = 'Stamppot'
    from tests.at(tests.plan('home-a', 0, 9), tests.d(3), tests.slot(tests.i('home-a'), 'dinner')) m)
  and (select jsonb_array_length(m) = 0
    from tests.at(tests.plan('home-a', 0, 9), tests.d(9), tests.slot(tests.i('home-a'), 'dinner')) m),
  'The existing meal stays, occurrences fill the other days until the end date');
select tests.assert_true(
  (select count(*) = 6 from jsonb_array_elements(tests.plan('home-a', 0, 30) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-daily')),
  'Six occurrences, computed (never stored), never more on a re-read');

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'occupied' and (occupied -> 'occupants' -> 0 ->> 'kind') = 'occurrence'
    from public.create_meal_entry(gen_random_uuid(), tests.d(3), tests.slot(tests.i('home-a'), 'dinner'),
      tests.i('home-a'), null, 'Ertussen')),
  'A repeating occurrence occupies its slot like any meal');
select tests.assert_true(public.skip_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(4)) = 'skipped',
  'Carol removes one occurrence');
select tests.assert_true(public.skip_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(4)) = 'skipped',
  'Removing it again is harmless');
select tests.assert_true(public.skip_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(9)) = 'not_found',
  'A day the series does not have is not found');
select tests.assert_true(
  (select jsonb_array_length(m) = 0 from tests.at(tests.plan('home-a', 0, 9), tests.d(4),
    tests.slot(tests.i('home-a'), 'dinner')) m),
  'It is gone from that day only');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(4))),
  'Undo brings it back');
select tests.assert_true(
  (select outcome = 'saved' from public.edit_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(5),
    tests.i('e-occ'), tests.d(5), tests.slot(tests.i('home-a'), 'dinner'), null, 'Stamppot met worst', 'Extra')),
  'Editing one occurrence makes it a meal of its own');
select tests.assert_true(
  (select outcome = 'exists' from public.edit_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(5),
    tests.i('e-occ'), tests.d(5), tests.slot(tests.i('home-a'), 'dinner'), null, 'Stamppot met worst', 'Extra')),
  'A retry returns that meal');
select tests.assert_true(
  (select jsonb_array_length(m) = 1 and (m -> 0 ->> 'kind') = 'entry'
    and (m -> 0 -> 'origin' ->> 'seriesId')::uuid = tests.i('se-daily')
    from tests.at(tests.plan('home-a', 0, 9), tests.d(5), tests.slot(tests.i('home-a'), 'dinner')) m),
  'It shows once, remembering its series');
select tests.assert_true(
  (select outcome = 'occupied' from public.edit_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(6),
    tests.i('e-move'), tests.d(3), tests.slot(tests.i('home-a'), 'lunch'), null, 'Stamppot')),
  'Moving one occurrence onto another meal answers occupied');
select tests.assert_true(
  (select outcome = 'saved' from public.edit_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(6),
    tests.i('e-move'), tests.d(6), tests.slot(tests.i('home-a'), 'lunch'), null, 'Stamppot')),
  'Moving it to a free slot works and the series continues');

-- Edit this and future from day 7: days 3–6 keep their old details.
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_series(tests.i('se-daily'), tests.series_rev('se-daily'),
    'edit_future', tests.d(7),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'daily',
      null, tests.d(7), tests.i('home-a'), tests.d(8), tests.i('se-daily'))),
    null, tests.slot(tests.i('home-a'), 'dinner'), 'daily', null, tests.d(8), null, 'Hutspot')),
  'Changing this and future occurrences from day 7');
select tests.assert_true(
  (select (m -> 0 ->> 'title') = 'Stamppot' from tests.at(tests.plan('home-a', 0, 9), tests.d(3),
    tests.slot(tests.i('home-a'), 'dinner')) m)
  and (select (m -> 0 ->> 'title') = 'Hutspot' from tests.at(tests.plan('home-a', 0, 9), tests.d(7),
    tests.slot(tests.i('home-a'), 'dinner')) m),
  'Earlier occurrences are never rewritten; later ones use the new details');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_meal_series(tests.i('se-daily'), 1, 'pause')),
  'A change from an old revision conflicts');
select tests.assert_true(public.skip_meal_occurrence(tests.current_recurrence('se-daily'), tests.d(8)) = 'skipped',
  'Day 8 is removed before the pause');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_series(tests.i('se-daily'), tests.series_rev('se-daily'), 'pause')),
  'Pausing the series');
select tests.assert_true(
  (select count(*) = 0 from jsonb_array_elements(tests.plan('home-a', 1, 30) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-daily'))
  and (select count(*) = 1 from jsonb_array_elements(tests.plan('home-a', 1, 30) -> 'entries') x
    where (x ->> 'id')::uuid = tests.i('e-occ')),
  'Stops future occurrences; the edited meal stays');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_series(tests.i('se-daily'), tests.series_rev('se-daily'),
    'resume', tests.d(7),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'daily',
      null, tests.d(7), tests.i('home-a'), tests.d(8), tests.i('se-daily'))))),
  'Resuming from day 7');
select tests.assert_true(
  (select count(*) = 1 and min(x ->> 'date') = tests.d(7)::text
    from jsonb_array_elements(tests.plan('home-a', 1, 30) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-daily')),
  'Brings back day 7 only: never a backlog, and day 8 stays removed');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_series(tests.i('se-daily'), tests.series_rev('se-daily'),
    'edit_future', tests.d(7),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'dinner'), 'daily',
      null, tests.d(7), tests.i('home-a'), tests.d(8), tests.i('se-daily'))),
    null, tests.slot(tests.i('home-a'), 'dinner'), 'daily', null, tests.d(8), null, 'Hutspot')),
  'Changing it again after the resume keeps working');
select tests.assert_true(
  (select count(*) = 1 from jsonb_array_elements(tests.plan('home-a', 1, 30) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-daily')),
  'And day 8 is still removed');
select tests.assert_true(
  (select outcome = 'saved' from public.update_meal_series(tests.i('se-daily'), tests.series_rev('se-daily'),
    'end', tests.d(8))),
  'Ending it from day 8');
select tests.assert_true(
  (select count(*) = 1 from jsonb_array_elements(tests.plan('home-a', 1, 30) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-daily'))
  and not exists (select 1 from jsonb_array_elements(tests.plan('home-a', 0, 0) -> 'series') s
    where (s ->> 'id')::uuid = tests.i('se-daily')),
  'Leaves day 7 and drops it from the open series');

-- Monday, Wednesday and Friday lunch.
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_series(tests.i('se-lunch'),
    tests.slot(tests.i('home-a'), 'lunch'), 'weekdays', array[1, 3, 5]::smallint[], tests.d(10),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'lunch'),
      'weekdays', array[1, 3, 5]::smallint[], tests.d(10), tests.i('home-a'), tests.d(23))),
    tests.i('home-a'), tests.d(23), tests.i('r-lasagne'), null, null, 4)),
  'A recipe on chosen weekdays');
select tests.assert_true(
  (select count(*) = 6 and bool_and(extract(isodow from (x ->> 'date')::date) in (1, 3, 5))
    from jsonb_array_elements(tests.plan('home-a', 10, 23) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-lunch')),
  'Only on those weekdays, two weeks long');
create temporary table first_lunch on commit drop as
  select min((x ->> 'date')::date) as on_date from jsonb_array_elements(tests.plan('home-a', 10, 23) -> 'occurrences') x
  where (x ->> 'seriesId')::uuid = tests.i('se-lunch');
grant all on first_lunch to authenticated;
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_entry(gen_random_uuid(), (select on_date from first_lunch),
    tests.slot(tests.i('home-a'), 'lunch'), tests.i('home-a'), null, 'Uit eten',
    p_replace => 'o' || tests.current_recurrence('se-lunch') || '.' || (select on_date from first_lunch) || '.1')),
  'Replacing one occurrence with a meal skips just that occurrence');
select tests.assert_true(
  (select count(*) = 5 from jsonb_array_elements(tests.plan('home-a', 10, 23) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-lunch')),
  'The series keeps its other days');

-- Two series that only collide after the first one's preview horizon: an unresolved conflict.
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_series(tests.i('se-late-1'),
    tests.slot(tests.i('home-a'), 'breakfast'), 'daily', null, tests.d(400),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'breakfast'),
      'daily', null, tests.d(400), tests.i('home-a'))),
    tests.i('home-a'), null, null, 'Muesli')),
  'A series from day 400');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_series(tests.i('se-late-2'),
    tests.slot(tests.i('home-a'), 'breakfast'), 'daily', null, tests.d(20),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'breakfast'),
      'daily', null, tests.d(20), tests.i('home-a'))),
    tests.i('home-a'), null, null, 'Brood')),
  'And one from day 20 (its preview ends before day 400)');
select tests.assert_true(
  (select jsonb_array_length(m) = 2 from tests.at(tests.plan('home-a', 400, 401), tests.d(400),
    tests.slot(tests.i('home-a'), 'breakfast')) m),
  'On day 400 both show: a visible unresolved conflict, nothing displaced');
select tests.assert_true(
  public.skip_meal_occurrence(tests.current_recurrence('se-late-2'), tests.d(400)) = 'skipped',
  'Skipping one occurrence resolves that day');

-- A colliding series decided by replacing: the other series' occurrence is skipped, not deleted.
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_meal_series(tests.i('se-b'),
    tests.slot(tests.i('home-a'), 'lunch'), 'weekly',
    array[extract(isodow from tests.d(10))::smallint], tests.d(10),
    (select preview ->> 'token' from public.preview_meal_series(tests.slot(tests.i('home-a'), 'lunch'),
      'weekly', array[extract(isodow from tests.d(10))::smallint], tests.d(10), tests.i('home-a'), tests.d(10))),
    tests.i('home-a'), tests.d(10), null, 'Soep',
    p_decisions => (select jsonb_object_agg(c ->> 'date', 'replace')
      from public.preview_meal_series(tests.slot(tests.i('home-a'), 'lunch'), 'weekly',
        array[extract(isodow from tests.d(10))::smallint], tests.d(10), tests.i('home-a'), tests.d(10)) p,
        jsonb_array_elements(p.preview -> 'collisions') c))),
  'A weekly series replacing what is there on its one day');
select tests.assert_true(
  (select jsonb_array_length(m) = 1 and (m -> 0 ->> 'title') = 'Soep'
    from tests.at(tests.plan('home-a', 10, 10), tests.d(10), tests.slot(tests.i('home-a'), 'lunch')) m),
  'Only the new one shows that day');

-- Copy week -----------------------------------------------------------------------------------------

-- Source week: days 28–34. A custom dinner on day 28, a recipe lunch on day 29, an unavailable
-- (shared then paused) recipe on day 30, and the destination (days 35–41) has a meal on day 35.
select tests.act_as('carol');
select public.create_meal_entry(tests.i('e-copy-1'), tests.d(28), tests.slot(tests.i('home-a'), 'dinner'),
  tests.i('home-a'), null, 'Wok', 'Pittig');
select public.create_meal_entry(tests.i('e-copy-2'), tests.d(29), tests.slot(tests.i('home-a'), 'lunch'),
  tests.i('home-a'), tests.i('r-lasagne'), null, null, 6);
select tests.act_as_owner();
update private.recipe_shares set suspended_at = null where recipe_id = tests.i('r-shared');
select tests.act_as('carol');
select public.create_meal_entry(tests.i('e-copy-3'), tests.d(30), tests.slot(tests.i('home-a'), 'dinner'),
  tests.i('home-a'), tests.i('r-shared'));
select tests.act_as_owner();
update private.recipe_shares set suspended_at = now() where recipe_id = tests.i('r-shared');
select tests.act_as('carol');
select public.create_meal_entry(tests.i('e-copy-4'), tests.d(35), tests.slot(tests.i('home-a'), 'dinner'),
  tests.i('home-a'), null, 'Al gepland');
select tests.assert_true(
  (select outcome = 'ok'
    and (select count(*) from jsonb_array_elements(preview -> 'rows') r where r ->> 'status' = 'unavailable') = 1
    and (select (r ->> 'date')::date = tests.d(35) and jsonb_array_length(r -> 'occupants') = 1
      from jsonb_array_elements(preview -> 'rows') r where r ->> 'key' = 'e:' || tests.i('e-copy-1'))
    and (select bool_and((r ->> 'repeating')::boolean) from jsonb_array_elements(preview -> 'rows') r
      where r ->> 'key' like 'o:%')
    from public.preview_meal_copy(tests.d(28), tests.d(35), tests.i('home-a'))),
  'The preview maps each meal to the same weekday, flags the unavailable recipe and the taken slot');
select tests.assert_denied($$select * from public.preview_meal_copy(tests.d(28), tests.d(30), tests.i('home-a'))$$,
  'Weeks are whole weeks apart', '22023');
select tests.assert_true(
  (select outcome = 'stale' from public.copy_meal_week(tests.d(28), tests.d(35), 'old',
    jsonb_build_array(jsonb_build_object('key', 'e:' || tests.i('e-copy-2'), 'id', gen_random_uuid())),
    tests.i('home-a'))),
  'A stale preview copies nothing');
create temporary table copy_token on commit drop as
  select preview ->> 'token' as token from public.preview_meal_copy(tests.d(28), tests.d(35), tests.i('home-a'));
grant all on copy_token to authenticated;
create temporary table copy_result on commit drop as
  select * from public.copy_meal_week(tests.d(28), tests.d(35), (select token from copy_token),
    jsonb_build_array(
      jsonb_build_object('key', 'e:' || tests.i('e-copy-1'), 'id', tests.i('t-1'), 'replace', false),
      jsonb_build_object('key', 'e:' || tests.i('e-copy-2'), 'id', tests.i('t-2')),
      jsonb_build_object('key', 'e:' || tests.i('e-copy-3'), 'id', gen_random_uuid())),
    tests.i('home-a'));
grant all on copy_result to authenticated;
select tests.assert_true(
  (select outcome = 'done'
    and (select r ->> 'outcome' from jsonb_array_elements(results) r where (r ->> 'id')::uuid = tests.i('t-1')) = 'occupied'
    and (select r ->> 'outcome' from jsonb_array_elements(results) r where (r ->> 'id')::uuid = tests.i('t-2')) = 'created'
    and (select r ->> 'outcome' from jsonb_array_elements(results) r where r ->> 'key' = 'e:' || tests.i('e-copy-3')) = 'unavailable'
    from copy_result),
  'Per row: a taken slot is kept unless replaced, the unavailable recipe is not copied');
select tests.assert_true(
  (select (m -> 0 ->> 'servings')::integer = 6 and (m -> 0 -> 'recipe' ->> 'name') = 'Lasagne'
    and (m -> 0 -> 'origin') = 'null'::jsonb
    from tests.at(tests.plan('home-a', 36, 36), tests.d(36), tests.slot(tests.i('home-a'), 'lunch')) m),
  'The copy keeps recipe and servings and is a standalone meal');
select tests.assert_true(
  (select outcome = 'done'
    and (select r ->> 'outcome' from jsonb_array_elements(results) r where (r ->> 'id')::uuid = tests.i('t-2')) = 'exists'
    from public.copy_meal_week(tests.d(28), tests.d(35), (select token from copy_token),
      jsonb_build_array(jsonb_build_object('key', 'e:' || tests.i('e-copy-2'), 'id', tests.i('t-2'))),
      tests.i('home-a'))),
  'A retry with the original preview never copies twice');
select tests.assert_true(
  (select (select r ->> 'outcome' from jsonb_array_elements(results) r where (r ->> 'id')::uuid = tests.i('t-1')) = 'created'
    from public.copy_meal_week(tests.d(28), tests.d(35),
      (select preview ->> 'token' from public.preview_meal_copy(tests.d(28), tests.d(35), tests.i('home-a'))),
      jsonb_build_array(jsonb_build_object('key', 'e:' || tests.i('e-copy-1'), 'id', tests.i('t-1'), 'replace', true)),
      tests.i('home-a'))),
  'Replacing explicitly copies over the taken slot');
select tests.assert_true(
  (select (m -> 0 ->> 'title') = 'Wok' and (m -> 0 ->> 'notes') = 'Pittig'
    from tests.at(tests.plan('home-a', 35, 35), tests.d(35), tests.slot(tests.i('home-a'), 'dinner')) m),
  'With its notes');

-- Ingredient transfer -------------------------------------------------------------------------------

select tests.act_as('alice');
select public.create_shopping_list(tests.i('l-a'), 'Boodschappen', tests.i('home-a'));
select public.create_shopping_list(tests.i('l-personal'), 'Eigen', null);
select tests.act_as('bob');
select public.create_shopping_list(tests.i('l-b'), 'Kot', tests.i('home-b'));
select tests.act_as('carol');
-- Days 28–30: the custom Wok, the Lasagne lunch for 6, the unavailable shared recipe.
select tests.assert_true(
  (select outcome = 'ok'
    and (select count(*) from jsonb_array_elements(preview -> 'meals') m where m ->> 'status' = 'included') = 1
    and (select count(*) from jsonb_array_elements(preview -> 'meals') m where m ->> 'status' = 'custom') >= 1
    and (select count(*) from jsonb_array_elements(preview -> 'meals') m
      where m ->> 'status' = 'unavailable' and m -> 'recipe' = 'null'::jsonb) = 1
    and (select jsonb_array_length(m -> 'recipe' -> 'ingredients') = 3 and (m ->> 'servings')::integer = 6
      from jsonb_array_elements(preview -> 'meals') m where m ->> 'status' = 'included')
    from public.preview_meal_ingredients(tests.d(28), tests.d(30), tests.i('home-a'))),
  'The preview includes the visible recipe with its ingredients and leaves out the rest without details');
select tests.assert_true(
  (select count(*) from jsonb_array_elements(
    (select preview -> 'meals' from public.preview_meal_ingredients(tests.d(10), tests.d(23), tests.i('home-a')))) m
    where m ->> 'key' like 'o:' || tests.current_recurrence('se-lunch') || ':%' and m ->> 'status' = 'included')
  = (select count(*) from jsonb_array_elements(tests.plan('home-a', 10, 23) -> 'occurrences') x
    where (x ->> 'seriesId')::uuid = tests.i('se-lunch')),
  'Each repeating occurrence counts once, exactly as the plan shows it');
select tests.assert_denied($$select * from public.preview_meal_ingredients(tests.d(0), tests.d(31), tests.i('home-a'))$$,
  'At most 31 days', '22023');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.transfer_meal_ingredients(tests.i('t-1'), tests.d(28), tests.d(30),
    tests.i('l-personal'), 'x', '[]'::jsonb, tests.i('home-a'))),
  'Never into a list of another context');
select tests.assert_true(
  (select outcome = 'list_unavailable' from public.transfer_meal_ingredients(gen_random_uuid(), tests.d(28), tests.d(30),
    tests.i('l-b'), 'x', '[]'::jsonb, tests.i('home-a'))),
  'Nor another Home''s list');
select tests.assert_true(
  (select outcome = 'stale' from public.transfer_meal_ingredients(gen_random_uuid(), tests.d(28), tests.d(30),
    tests.i('l-a'), 'old', jsonb_build_array(jsonb_build_object('id', tests.i('i-1'), 'name', 'Pasta')),
    tests.i('home-a'))),
  'A stale preview adds nothing');
select tests.assert_true(
  (select outcome = 'done'
    and (select count(*) from jsonb_array_elements(results) r where r ->> 'outcome' = 'created') = 3
    from public.transfer_meal_ingredients(tests.i('t-2'), tests.d(28), tests.d(30), tests.i('l-a'),
      (select preview ->> 'token' from public.preview_meal_ingredients(tests.d(28), tests.d(30), tests.i('home-a'))),
      jsonb_build_array(
        jsonb_build_object('id', tests.i('i-1'), 'name', 'Pasta', 'quantity', '750', 'unit', 'g'),
        jsonb_build_object('id', tests.i('i-2'), 'name', 'Melk', 'quantity', '0.75', 'unit', 'l', 'notes', 'vol'),
        jsonb_build_object('id', tests.i('i-3'), 'name', 'Oregano', 'quantity', '1.5', 'packaging', 'tsp')),
      tests.i('home-a'))),
  'Confirmed rows become ordinary shopping items');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 3 from private.shopping_items where meal_transfer_id = tests.i('t-2'))
    and (select item_count = 3 and created_by = tests.user_id('carol')
      from private.meal_shopping_transfers where id = tests.i('t-2')),
  'Linked to an attributable transfer record');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'done'
    and (select count(*) from jsonb_array_elements(results) r where r ->> 'outcome' = 'exists') = 3
    from public.transfer_meal_ingredients(tests.i('t-2'), tests.d(28), tests.d(30), tests.i('l-a'), 'whatever',
      jsonb_build_array(
        jsonb_build_object('id', tests.i('i-1'), 'name', 'Pasta', 'quantity', '750', 'unit', 'g'),
        jsonb_build_object('id', tests.i('i-2'), 'name', 'Melk', 'quantity', '0.75', 'unit', 'l', 'notes', 'vol'),
        jsonb_build_object('id', tests.i('i-3'), 'name', 'Oregano', 'quantity', '1.5', 'packaging', 'tsp')),
      tests.i('home-a'))),
  'A retry adds nothing twice');
select tests.assert_true(
  (select count(*) = 1 from public.add_shopping_items(tests.i('l-a'),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', 'Pasta'))) where outcome = 'duplicate'),
  'The items are active on the list');

-- Recipe delete impact -----------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select (impact ->> 'plannedMeals')::integer >= 2 and (impact ->> 'repeatingMeals')::integer = 1
    from public.recipe_delete_impact(tests.i('r-lasagne'))),
  'Deleting a recipe shows how many planned and repeating meals refer to it');

-- A departed member ---------------------------------------------------------------------------------

select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_denied($$select public.get_meal_plan(tests.i('home-a'))$$, 'After leaving she reads nothing');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_meal_entry(tests.i('e-copy-2'), 1, tests.d(29),
    tests.slot(tests.i('home-a'), 'lunch'), null, 'Weg')),
  'And changes nothing');
select tests.assert_true(
  public.skip_meal_occurrence(tests.current_recurrence('se-lunch'), tests.d(10)) = 'not_found',
  'Nor its repeating meals');
