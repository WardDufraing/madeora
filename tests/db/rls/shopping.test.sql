-- S26: shopping lists (supabase/migrations/*_shopping_lists.sql). Alice owns Home A, where Bob is an
-- Administrator and Carol a Member; Bob owns Home B, which Carol is not in. Covers: nothing reachable
-- as a table; the access matrix (Personal owner; members under each list access; the list's creator;
-- shopping managers and a revoked grant; non-members and forged ids); lists (create retry, limits,
-- rename, access, archive read-only, order by relative moves, delete and restore with items);
-- categories (distinct names, removal keeps items); items (quick add, duplicates, multi-row adds with
-- per-row outcomes and retries, fields, edit conflicts, relative item moves); completion (set-to-state,
-- stale uncheck); clear completed and its trash entry; transfers (move, copy, same list, other
-- contexts, archived destination, duplicate, completed keep/reopen, copy retry); recurring items
-- (daily, weekly, monthly on the 31st, no duplicate while active, missed days give one item, pause
-- and resume, stop, archived list, removed category); history; the widget; the Realtime signal.

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
  'l-groceries', 'l-market', 'l-carol', 'l-personal', 'l-personal-2', 'l-b', 'l-view',
  'c-dairy', 'c-fruit', 'c-other',
  'i-milk', 'i-bread', 'i-apples', 'i-eggs', 'i-pasta', 'i-copy', 'i-p', 'i-b', 'i-batch-1',
  'i-batch-2', 'i-batch-3', 'i-batch-4', 'i-dup', 'i-view', 'i-rec', 'i-rec-2', 'i-rec-3',
  'r-daily', 'r-weekly', 'r-monthly', 'r-personal'
]) as n;

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;
create function tests.item_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.shopping_items where id = tests.i(p_name); $$;
create function tests.list_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.shopping_lists where id = tests.i(p_name); $$;
create function tests.rule_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.shopping_recurrences where id = tests.i(p_name); $$;
-- One add row as the API sends it.
create function tests.row(
  p_id uuid, p_name text, p_quantity text default null, p_unit text default null,
  p_allow boolean default false, p_category uuid default null
) returns jsonb
  language sql immutable as $$
  select jsonb_build_object('id', p_id, 'name', p_name, 'quantity', p_quantity, 'unit', p_unit,
    'packaging', null, 'notes', null, 'categoryId', p_category, 'allowDuplicate', p_allow);
  $$;
-- One item's outcome for a single-row add.
create function tests.add(p_list text, p_row jsonb) returns text
  language sql as $$
  select outcome from public.add_shopping_items(tests.i(p_list), jsonb_build_array(p_row));
  $$;
-- Moves a rule's next due day into the past, as if the days since had gone by unseen.
create function tests.age_rule(p_name text, p_days integer) returns void
  language sql security definer as $$
  update private.shopping_recurrences set next_on = next_on - p_days where id = tests.i(p_name);
  $$;
create function tests.active_from_rule(p_name text) returns bigint
  language sql stable security definer as $$
  select count(*) from private.shopping_items
  where recurrence_id = tests.i(p_name) and deleted_at is null and completed_at is null;
  $$;
create function tests.cat_rev(p_name text) returns integer
  language sql stable security definer as $$ select revision from private.shopping_categories where id = tests.i(p_name); $$;
create function tests.item_json(p_id uuid) returns jsonb
  language sql stable security definer as $$ select to_jsonb(i) from private.shopping_items i where i.id = p_id; $$;
create function tests.rule_json(p_name text) returns jsonb
  language sql stable security definer as $$ select to_jsonb(r) from private.shopping_recurrences r where r.id = tests.i(p_name); $$;
-- The rule's active item, and how many items it ever made.
create function tests.rule_item(p_name text) returns uuid
  language sql stable security definer as $$
  select id from private.shopping_items
  where recurrence_id = tests.i(p_name) and completed_at is null and deleted_at is null; $$;
create function tests.rule_items(p_name text) returns bigint
  language sql stable security definer as $$
  select count(*) from private.shopping_items where recurrence_id = tests.i(p_name); $$;
create function tests.item_named(p_list text, p_item text) returns uuid
  language sql stable security definer as $$
  select id from private.shopping_items where list_id = tests.i(p_list) and name = p_item; $$;
create function tests.due(p_frequency text, p_weekdays smallint[], p_month_day smallint, p_start date, p_from date)
returns date
  language sql stable security definer as $$
  select private.shopping_due_on_or_after(p_frequency, p_weekdays, p_month_day, p_start, p_from); $$;
create function tests.brussels_today() returns date
  language sql stable as $$ select (now() at time zone 'Europe/Brussels')::date; $$;
create function tests.signal(p_context uuid) returns bigint
  language sql stable security definer as $$
  select coalesce((select version from public.shopping_signals where context_id = p_context), 0); $$;
grant execute on function tests.i(text), tests.item_rev(text), tests.list_rev(text), tests.rule_rev(text),
  tests.row(uuid, text, text, text, boolean, uuid), tests.add(text, jsonb), tests.age_rule(text, integer),
  tests.active_from_rule(text), tests.signal(uuid), tests.cat_rev(text), tests.item_json(uuid),
  tests.rule_json(text), tests.rule_item(text), tests.rule_items(text), tests.item_named(text, text),
  tests.due(text, smallint[], smallint, date, date), tests.brussels_today()
  to authenticated, service_role;

-- Nothing reachable ------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.shopping_lists', 'The API cannot read lists');
select tests.assert_denied('select * from private.shopping_items', 'Nor items');
select tests.assert_denied('select * from private.shopping_categories', 'Nor categories');
select tests.assert_denied('select * from private.shopping_recurrences', 'Nor recurring rules');
select tests.assert_denied('select * from private.shopping_item_events', 'Nor history');
select tests.assert_denied('select * from private.shopping_clears', 'Nor clears');
select tests.assert_denied(
  $$select private.shopping_access(null::private.shopping_lists, tests.user_id('alice'))$$,
  'Nor the permission helpers');
select tests.assert_denied($$insert into public.shopping_signals (context_id, user_id)
  values (tests.user_id('alice'), tests.user_id('alice'))$$, 'Nobody writes a signal');
select tests.act_as_anon();
select tests.assert_denied('select * from public.list_shopping_lists()', 'Nobody signed out lists lists');
select tests.assert_denied($$select public.get_shopping_list(gen_random_uuid())$$, 'Nor reads one');
select tests.assert_denied('select * from public.shopping_signals', 'Nor reads a signal');

-- Lists -------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_list(tests.i('l-carol'), 'Drogist', tests.i('home-a'))),
  'Every member creates a list in the Home');
select tests.assert_true(
  (select outcome = 'exists' from public.create_shopping_list(tests.i('l-carol'), 'Drogist', tests.i('home-a'))),
  'A retry returns the same list');
select tests.assert_denied(
  $$select * from public.create_shopping_list(gen_random_uuid(), 'X', tests.i('home-b'))$$,
  'Not in a Home she is not in');
select tests.assert_denied(
  $$select * from public.create_shopping_list(gen_random_uuid(), '  ', tests.i('home-a'))$$,
  'A blank name is refused', '22023');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_list(tests.i('l-groceries'), 'Groceries', tests.i('home-a'))),
  'Alice creates Groceries');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_list(tests.i('l-market'), 'Groceries', tests.i('home-a'))),
  'Two lists may share a name (nothing is merged)');
select tests.assert_true(
  (select outcome = 'id_taken' from public.create_shopping_list(tests.i('l-carol'), 'Mine', tests.i('home-a'))),
  'Another person''s list id is taken, not reused');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_list(tests.i('l-personal'), 'Mijn lijst')),
  'Alice creates a personal list');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_list(tests.i('l-personal-2'), 'Tweede')),
  'And a second one');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_list(tests.i('l-b'), 'Kot', tests.i('home-b'))),
  'Bob creates a list in Home B');

select tests.act_as('carol');
select tests.assert_row_count(
  $$select * from public.list_shopping_lists(tests.i('home-a'))$$, 3, 'Carol sees the Home''s three lists');
select tests.assert_true(
  (select array_agg(id order by "position") = array[tests.i('l-carol'), tests.i('l-groceries'), tests.i('l-market')]
    from public.list_shopping_lists(tests.i('home-a'))),
  'In the order they were created');
select tests.assert_true(
  (select access = 'manage' from public.list_shopping_lists(tests.i('home-a')) where id = tests.i('l-carol')),
  'She manages her own list');
select tests.assert_true(
  (select access = 'edit' from public.list_shopping_lists(tests.i('home-a')) where id = tests.i('l-groceries')),
  'And edits Alice''s (default member access)');
select tests.assert_true(public.get_shopping_list(tests.i('l-personal')) is null,
  'Alice''s personal list is invisible to her');
select tests.assert_true(public.get_shopping_list(tests.i('l-b')) is null, 'So is Home B''s');
select tests.assert_denied($$select * from public.list_shopping_lists(tests.i('home-b'))$$,
  'Home B cannot even be listed');
select tests.assert_true(
  (select outcome = 'not_found' from public.update_shopping_list(tests.i('l-b'), 1, 'Mijn', 'edit', false)),
  'A forged list id of another Home is not found');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_shopping_list(tests.i('l-groceries'), 1, 'Mine', 'edit', false)),
  'A member cannot rename someone else''s list');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_shopping_list(tests.i('l-groceries'), 1)),
  'Nor delete it');
select tests.assert_true(public.move_shopping_list(tests.i('l-groceries'), 'up') = 'not_permitted',
  'Only shopping managers reorder the Home''s lists');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_shopping_list(tests.i('l-groceries'), 1, 'Mine', 'edit', false)),
  'An Administrator without manageHomeShopping does not manage it');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array['manageHomeShopping']);
select tests.act_as('bob');
select tests.assert_true(public.move_shopping_list(tests.i('l-market'), 'up') = 'saved',
  'Granted manageHomeShopping, Bob reorders the lists');
select tests.assert_true(
  (select array_agg(id order by "position") = array[tests.i('l-carol'), tests.i('l-market'), tests.i('l-groceries')]
    from public.list_shopping_lists(tests.i('home-a'))),
  'Market moved one place up, nothing else changed');
select tests.assert_true(public.move_shopping_list(tests.i('l-carol'), 'up') = 'unchanged',
  'The first list cannot move further up');
select tests.assert_true(
  (select outcome = 'saved' from public.update_shopping_list(tests.i('l-market'), 1, 'Markt', 'view', false)),
  'And manages any list: Market is now view only for members');
select tests.act_as('alice');
select public.set_administrator_capabilities(tests.i('home-a'), tests.i('m-bob-a'), array[]::text[]);
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_shopping_list(tests.i('l-market'), tests.list_rev('l-market'), 'Markt', 'edit', false)),
  'A revoked grant ends it at once');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 1 from public.update_shopping_list(tests.i('l-b'), 7, 'Kot', 'edit', false)),
  'A stale revision answers conflict with the current one');

-- Categories ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_category(tests.i('c-dairy'), tests.i('l-groceries'), 'Zuivel')),
  'Editors create categories');
select tests.assert_true(
  (select outcome = 'duplicate_name' from public.create_shopping_category(gen_random_uuid(), tests.i('l-groceries'), 'ZUÏVEL')),
  'A name that reads the same (case, accents) is refused, never merged') ;
select tests.assert_true(
  (select outcome = 'created' from public.create_shopping_category(tests.i('c-fruit'), tests.i('l-groceries'), 'Fruit')),
  'A second category');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.create_shopping_category(gen_random_uuid(), tests.i('l-market'), 'X')),
  'Not on a view-only list');
select tests.assert_true(public.move_shopping_category(tests.i('c-fruit'), 'up') = 'saved', 'Categories reorder');
select tests.assert_true(
  (select jsonb_path_query_array(public.get_shopping_list(tests.i('l-groceries')), '$.categories[*].name')
    = '["Fruit", "Zuivel"]'::jsonb),
  'Fruit now comes first');

-- Items ---------------------------------------------------------------------------------------------

select tests.assert_true(tests.add('l-groceries', tests.row(tests.i('i-milk'), 'Melk', '2', null, false, tests.i('c-dairy'))) = 'created',
  'Quick add with a quantity and category');
select tests.assert_true(tests.add('l-groceries', tests.row(tests.i('i-milk'), 'Melk')) = 'exists',
  'A retry returns the same item');
select tests.assert_true(tests.add('l-groceries', tests.row(tests.i('i-dup'), 'melk')) = 'duplicate',
  'An active item that reads the same is a duplicate');
select tests.assert_true(tests.add('l-groceries', tests.row(tests.i('i-dup'), 'melk', null, null, true)) = 'created',
  'Kept on purpose, it becomes a separate item');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'Pasta', '500', 'g')) = 'created',
  '500 g pasta');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'Water', '1.25', 'l')) = 'created',
  'A decimal litre amount');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'X', '0')) = 'invalid', 'Zero is refused');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'X', '1.2345')) = 'invalid',
  'More than three decimals is refused, never rounded');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'X', null, 'kg')) = 'invalid',
  'A unit needs a quantity');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'X', '1', 'bushel')) = 'invalid',
  'An unsupported unit is refused');
select tests.assert_true(tests.add('l-groceries', tests.row(gen_random_uuid(), 'X', null, null, false, tests.i('home-a'))) = 'invalid',
  'A category of another list is refused');
select tests.assert_true(tests.add('l-groceries', jsonb_build_object('id', gen_random_uuid(), 'name', 'X', 'quantity', 2)) = 'invalid',
  'A quantity must arrive as a decimal string, never a float');
select tests.assert_denied($$select * from public.add_shopping_items(tests.i('l-groceries'), '[{"name": "X"}]')$$,
  'A row without an id is malformed', '22023');

-- Several at once: per-row outcomes, and a retry never adds a row twice.
select tests.assert_true(
  (select array_agg(outcome order by ord) = array['created', 'created', 'duplicate', 'invalid']
    from public.add_shopping_items(tests.i('l-groceries'), jsonb_build_array(
      tests.row(tests.i('i-batch-1'), 'Brood'), tests.row(tests.i('i-batch-2'), '6 appels'),
      tests.row(tests.i('i-batch-3'), 'brood'), tests.row(tests.i('i-batch-4'), ''))) with ordinality as x (id, outcome, ord)),
  'Four rows: two added, an in-batch duplicate and an invalid row answered on their own');
select tests.assert_true(
  (select array_agg(outcome order by ord) = array['exists', 'exists', 'created', 'created']
    from public.add_shopping_items(tests.i('l-groceries'), jsonb_build_array(
      tests.row(tests.i('i-batch-1'), 'Brood'), tests.row(tests.i('i-batch-2'), '6 appels'),
      tests.row(tests.i('i-batch-3'), 'brood', null, null, true), tests.row(tests.i('i-batch-4'), 'Kaas'))) with ordinality as x (id, outcome, ord)),
  'The retry: the added rows answer exists, the corrected rows are added');

select tests.assert_true(
  (select outcome = 'saved' from public.update_shopping_item(tests.i('i-milk'), tests.item_rev('i-milk'),
    'Melk', 2, null, 'flessen', 'Halfvol', tests.i('c-dairy'))),
  'Edit: 2 bottles of milk, with notes');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_shopping_item(tests.i('i-milk'), 1, 'Melk', 3, null, null, null, null)),
  'A stale edit answers conflict');
select tests.assert_true(
  (select outcome = 'invalid_category' from public.update_shopping_item(tests.i('i-milk'), tests.item_rev('i-milk'),
    'Melk', 2, null, 'flessen', 'Halfvol', gen_random_uuid())),
  'A category of another list is refused');
select tests.assert_denied(
  $$select * from public.update_shopping_item(tests.i('i-milk'), tests.item_rev('i-milk'), 'Melk', -1, null, null, null, null)$$,
  'A negative quantity is malformed', '22023');

-- Relative moves within a group.
select tests.add('l-groceries', tests.row(tests.i('i-eggs'), 'Eieren', '12', null, false, tests.i('c-dairy')));
select tests.assert_true(public.move_shopping_item(tests.i('i-eggs'), 'up') = 'saved', 'Eggs move above milk');
select tests.assert_true(
  (select array_agg(x ->> 'name' order by (x ->> 'position')::integer) = array['Eieren', 'Melk']
    from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'items') x
    where x ->> 'categoryId' = tests.i('c-dairy')::text),
  'Within Dairy the order is eggs, milk');
select tests.assert_true(public.move_shopping_item(tests.i('i-eggs'), 'up') = 'unchanged',
  'The first of a group cannot move up into another group');

-- Access modes ------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.add('l-market', tests.row(tests.i('i-view'), 'Kaas'));
select tests.act_as('carol');
select tests.assert_true((public.get_shopping_list(tests.i('l-market')) ->> 'access') = 'view',
  'Carol has view-only access to Market');
select tests.assert_true(tests.add('l-market', tests.row(gen_random_uuid(), 'X')) = 'not_permitted',
  'She cannot add to it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_shopping_item_completed(tests.i('i-view'), true)),
  'Nor check items off');
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-market'), tests.list_rev('l-market'), 'Markt', 'check', false);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'completed' and (completed_by ->> 'me')::boolean
    from public.set_shopping_item_completed(tests.i('i-view'), true)),
  'With check-off access she checks it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_shopping_item(tests.i('i-view'), tests.item_rev('i-view'),
    'Brie', null, null, null, null, null)),
  'But still cannot edit it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.delete_shopping_item(tests.i('i-view'))), 'Nor delete it');

-- Completion -------------------------------------------------------------------------------------

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'completed' from public.set_shopping_item_completed(tests.i('i-milk'), true)), 'Bob checks milk');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'unchanged' and (completed_by ->> 'me')::boolean = false
    from public.set_shopping_item_completed(tests.i('i-milk'), true)),
  'Checking it again changes nothing and says it was someone else');
select tests.assert_true(
  (select count(*) = 1 from public.shopping_item_history(tests.i('i-milk')) where kind = 'completed'),
  'One completion in the history');
select tests.assert_true(
  (select outcome = 'conflict' from public.set_shopping_item_completed(tests.i('i-milk'), false, now() - interval '1 hour')),
  'Unchecking a completion she did not see answers conflict');
select tests.assert_true(
  (select outcome = 'reopened' from public.set_shopping_item_completed(tests.i('i-milk'), false,
    (select completed_at from public.set_shopping_item_completed(tests.i('i-milk'), true)))),
  'Unchecking the completion she saw reopens it');
select tests.assert_true(
  (select (x ->> 'position')::integer = (tests.item_json(tests.i('i-milk')) ->> 'position')::integer
    and x ->> 'completedAt' is null
    from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'items') x where x ->> 'id' = tests.i('i-milk')::text),
  'It is back in Active at its old place');

-- Clear completed ---------------------------------------------------------------------------------

select public.set_shopping_item_completed(tests.i('i-batch-1'), true);
select public.set_shopping_item_completed(tests.i('i-batch-2'), true);
select tests.assert_true(
  (select outcome = 'cleared' and cleared = 2 and skipped = 1
    from public.clear_completed_shopping_items(tests.i('l-groceries'),
      array[tests.i('i-batch-1'), tests.i('i-batch-2'), tests.i('i-milk')])),
  'Clearing clears the two completed items it saw and leaves the active one alone');
select tests.assert_true(
  (select count(*) = 0 from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'items') x
    where x ->> 'id' in (tests.i('i-batch-1')::text, tests.i('i-batch-2')::text)),
  'They are gone from the list');
select tests.assert_true(
  (select count(*) = 1 from public.list_trash(tests.i('home-a')) where item_type = 'shopping_clear'),
  'And in the trash as one entry');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
    array[(select entry_id from public.list_trash(tests.i('home-a')) where item_type = 'shopping_clear')])),
  'Restoring the clear');
select tests.assert_true(
  (select count(*) = 2 from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'items') x
    where x ->> 'id' in (tests.i('i-batch-1')::text, tests.i('i-batch-2')::text) and x ->> 'completedAt' is not null),
  'Brings both back as Completed');

-- Transfers ---------------------------------------------------------------------------------------

select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-market'), tests.list_rev('l-market'), 'Markt', 'edit', false);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'same_list' from public.transfer_shopping_item(tests.i('i-eggs'), 'move', tests.i('l-groceries'),
    tests.item_rev('i-eggs'))),
  'Moving to the same list is refused');
select tests.assert_true(
  (select outcome = 'destination_unavailable' from public.transfer_shopping_item(tests.i('i-eggs'), 'move', tests.i('l-b'),
    tests.item_rev('i-eggs'))),
  'A list of a Home she is not in is not a destination');
select tests.act_as('alice');
select tests.add('l-personal', tests.row(tests.i('i-p'), 'Shampoo'));
select tests.assert_true(
  (select outcome = 'not_permitted'
    from public.transfer_shopping_item(tests.i('i-p'), 'copy', tests.i('l-groceries'), tests.item_rev('i-p'),
      null, true, false, gen_random_uuid())),
  'Personal to Home is refused');
select tests.assert_true(
  (select outcome = 'not_permitted'
    from public.transfer_shopping_item(tests.i('i-eggs'), 'copy', tests.i('l-personal'), tests.item_rev('i-eggs'),
      null, true, false, gen_random_uuid())),
  'And Home to Personal');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'moved' from public.transfer_shopping_item(tests.i('i-eggs'), 'move', tests.i('l-market'),
    tests.item_rev('i-eggs'))),
  'Eggs move to Market, Uncategorized there');
select tests.assert_true(
  (select x ->> 'categoryId' is null and x ->> 'quantity' = '12'
    from jsonb_array_elements(public.get_shopping_list(tests.i('l-market')) -> 'items') x where x ->> 'id' = tests.i('i-eggs')::text),
  'Same item, quantity kept, no category taken along');
-- A completed item copied keeping completion: the source's actor and time, recorded as a copy.
select tests.assert_true(
  (select outcome = 'copied' from public.transfer_shopping_item(tests.i('i-batch-1'), 'copy', tests.i('l-market'),
    tests.item_rev('i-batch-1'), null, true, false, tests.i('i-copy'))),
  'Copying completed bread to Market');
select tests.assert_true(
  (select x ->> 'completedAt' is not null and (x -> 'completedBy' ->> 'me')::boolean
    from jsonb_array_elements(public.get_shopping_list(tests.i('l-market')) -> 'items') x where x ->> 'id' = tests.i('i-copy')::text),
  'The copy keeps the source''s completion (Carol completed it)');
select tests.assert_true(
  (select array_agg(kind) = array['copied'] from public.shopping_item_history(tests.i('i-copy'))),
  'Recorded as a copy, never as a new completion');
select tests.assert_true(
  (select outcome = 'exists' from public.transfer_shopping_item(tests.i('i-batch-1'), 'copy', tests.i('l-market'),
    tests.item_rev('i-batch-1'), null, true, false, tests.i('i-copy'))),
  'A retry of the copy answers exists');
select tests.assert_true(
  (select outcome = 'duplicate' from public.transfer_shopping_item(tests.i('i-view'), 'copy', tests.i('l-groceries'),
    tests.item_rev('i-view'), null, true, false, gen_random_uuid())),
  'Copying Kaas next to an active Kaas warns of a duplicate');
select tests.assert_true(
  (select outcome = 'copied' from public.transfer_shopping_item(tests.i('i-view'), 'copy', tests.i('l-groceries'),
    tests.item_rev('i-view'), tests.i('c-dairy'), false, true, gen_random_uuid())),
  'Allowed on purpose, reopened, into a chosen category');
select tests.assert_true(
  (select outcome = 'conflict' from public.transfer_shopping_item(tests.i('i-eggs'), 'move', tests.i('l-groceries'), 1)),
  'A stale move answers conflict');
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-market'), tests.list_rev('l-market'), 'Markt', 'edit', true);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'destination_unavailable' from public.transfer_shopping_item(tests.i('i-dup'), 'move', tests.i('l-market'),
    tests.item_rev('i-dup'))),
  'An archived list is not a destination');
select tests.assert_true(tests.add('l-market', tests.row(gen_random_uuid(), 'X')) = 'not_permitted',
  'An archived list is read only');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.set_shopping_item_completed(tests.i('i-eggs'), true)),
  'Even for checking off');
select tests.assert_row_count($$select * from public.list_shopping_lists(tests.i('home-a'), true)$$, 1,
  'It is under Archived');
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-market'), tests.list_rev('l-market'), 'Markt', 'edit', false);

-- Removing a category keeps its items -------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'deleted' and moved_items = 2 from public.delete_shopping_category(tests.i('c-dairy'),
    tests.cat_rev('c-dairy'))),
  'Removing Dairy moves its two items to Uncategorized');
select tests.assert_true(
  (select count(*) filter (where x ->> 'categoryId' = tests.i('c-dairy')::text) = 0
      and count(*) filter (where x ->> 'id' = tests.i('i-milk')::text and x ->> 'categoryId' is null) = 1
    from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'items') x),
  'Nothing deleted, nothing lost');

-- Recurring items ---------------------------------------------------------------------------------

select tests.add('l-groceries', tests.row(tests.i('i-rec'), 'Yoghurt', '1', 'l'));
select tests.assert_true(
  (select outcome = 'created' and next_on = tests.brussels_today() + 1
    from public.start_shopping_recurrence(tests.i('i-rec'), tests.i('r-daily'), 'daily')),
  'Daily yoghurt: next due tomorrow (the Home''s timezone)');
select tests.assert_true(
  (select outcome = 'already_repeating' from public.start_shopping_recurrence(tests.i('i-rec'), gen_random_uuid(), 'daily')),
  'An item repeats under one rule only');
select tests.assert_denied(
  $$select * from public.start_shopping_recurrence(tests.i('i-rec'), gen_random_uuid(), 'weekly', array[]::smallint[])$$,
  'Weekly needs a weekday', '22023');
select tests.assert_denied(
  $$select * from public.start_shopping_recurrence(tests.i('i-rec'), gen_random_uuid(), 'monthly', null, 32::smallint)$$,
  'A day of month above 31 is malformed', '22023');
select tests.age_rule('r-daily', 1);
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 0,
  'Due, but the item is still active: nothing new');
select tests.assert_true(tests.active_from_rule('r-daily') = 1, 'Still exactly one active yoghurt');
select public.set_shopping_item_completed(tests.i('i-rec'), true);
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 0,
  'Completed before it is due again: nothing until the next due day');
select tests.age_rule('r-daily', 5);
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 1, 'Days later one new item, never a backlog');
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 0, 'Reading again makes nothing more');
select tests.assert_true(tests.active_from_rule('r-daily') = 1, 'One active yoghurt');
select tests.assert_true(
  (select count(*) = 1 from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'items') x
    where x ->> 'id' = tests.i('i-rec')::text and x ->> 'completedAt' is not null),
  'The completed one keeps its completion');
select tests.assert_true(
  (select (x ->> 'quantity')::numeric = 1 and x ->> 'unit' = 'l' and x ->> 'created_by' is null
    from tests.item_json(tests.rule_item('r-daily')) x),
  'Made from the rule''s details, by nobody');
select tests.assert_true(
  (select array_agg(kind) = array['recurred'] from public.shopping_item_history(
    tests.rule_item('r-daily'))),
  'Its history says it recurred, with no actor');
select tests.assert_true(
  (tests.rule_json('r-daily') ->> 'next_on')::date > tests.brussels_today(),
  'The next due day moved past today');

-- Pause, resume, stop.
select tests.assert_true(
  (select outcome = 'saved' from public.update_shopping_recurrence(tests.i('r-daily'), tests.rule_rev('r-daily'), 'pause')),
  'Pause');
select public.set_shopping_item_completed(
  tests.rule_item('r-daily'), true);
select tests.age_rule('r-daily', 10);
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 0, 'Paused: nothing is made');
select tests.assert_true(
  (select outcome = 'saved' and next_on = tests.brussels_today()
    from public.update_shopping_recurrence(tests.i('r-daily'), tests.rule_rev('r-daily'), 'resume')),
  'Resume restarts from today, never catching up');
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 1, 'Today''s one item');
select tests.assert_true(
  (select outcome = 'conflict' from public.update_shopping_recurrence(tests.i('r-daily'), 1, 'stop')),
  'A stale change answers conflict');
select tests.assert_true(
  (select outcome = 'saved' from public.update_shopping_recurrence(tests.i('r-daily'), tests.rule_rev('r-daily'), 'stop')),
  'Stop repeating');
select tests.assert_true(
  tests.rule_items('r-daily') = 3,
  'Its items and their history stay');
select tests.assert_true(
  (select jsonb_array_length(public.get_shopping_list(tests.i('l-groceries')) -> 'recurrences') = 0),
  'A stopped rule is no longer shown');

-- Weekly on chosen weekdays, monthly on the 31st.
select tests.add('l-groceries', tests.row(tests.i('i-rec-2'), 'Volkorenbrood'));
select tests.assert_true(
  (select outcome = 'created' and extract(isodow from next_on) in (1, 4)
    from public.start_shopping_recurrence(tests.i('i-rec-2'), tests.i('r-weekly'), 'weekly', array[1, 4]::smallint[])),
  'Weekly bread on Mondays and Thursdays');
select tests.add('l-groceries', tests.row(tests.i('i-rec-3'), 'Batterijen', null, null, false, tests.i('c-fruit')));
select tests.assert_true(
  (select outcome = 'created' from public.start_shopping_recurrence(tests.i('i-rec-3'), tests.i('r-monthly'), 'monthly', null, 31::smallint)),
  'Monthly supplies on the 31st');
select tests.assert_true(
  tests.due('monthly', null, 31::smallint, null, date '2027-02-01') = date '2027-02-28'
  and tests.due('monthly', null, 31::smallint, null, date '2028-02-10') = date '2028-02-29'
  and tests.due('monthly', null, 31::smallint, null, date '2027-03-01') = date '2027-03-31'
  and tests.due('monthly', null, 15::smallint, null, date '2027-03-16') = date '2027-04-15'
  and tests.due('monthly', null, 31::smallint, null, date '2027-04-30') = date '2027-04-30',
  'The 31st falls on the last day of shorter months') ;
select tests.assert_true(
  tests.due('weekly', array[1, 4]::smallint[], null, null, date '2027-03-30') = date '2027-04-01'
  and tests.due('weekly', array[7]::smallint[], null, date '2027-04-20', date '2027-03-30') = date '2027-04-25'
  and tests.due('daily', null, null, null, date '2027-03-28') = date '2027-03-28',
  'Weekdays and a start date are honoured');

-- A removed category: the rule continues Uncategorized, flagged.
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_shopping_category(tests.i('c-fruit'),
    tests.cat_rev('c-fruit'))),
  'Removing the category the supplies rule used');
select tests.assert_true(
  (select (x ->> 'categoryLost')::boolean and x ->> 'categoryId' is null
    from jsonb_array_elements(public.get_shopping_list(tests.i('l-groceries')) -> 'recurrences') x
    where x ->> 'id' = tests.i('r-monthly')::text),
  'The rule is flagged, never given another category');
select tests.assert_true(
  (select outcome = 'saved' from public.update_shopping_recurrence(tests.i('r-monthly'), tests.rule_rev('r-monthly'),
    'schedule', 'monthly', null, 1::smallint, null, tests.i('i-rec-3'))),
  'Saving the schedule from its item clears the flag and moves it to the 1st');
select tests.assert_true(
  (select not (r ->> 'category_lost')::boolean and (r ->> 'month_day')::integer = 1 from tests.rule_json('r-monthly') r),
  'Applied from the next occurrence');

-- An archived list makes nothing; restoring it restarts from today.
select public.set_shopping_item_completed(tests.i('i-rec-2'), true);
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-groceries'), tests.list_rev('l-groceries'), 'Groceries', 'edit', true);
select tests.age_rule('r-weekly', 30);
select tests.act_as('carol');
select tests.assert_true(public.advance_shopping(tests.i('home-a')) = 0, 'Archived: no new items');
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-groceries'), tests.list_rev('l-groceries'), 'Groceries', 'edit', false);
select tests.assert_true(
  (tests.rule_json('r-weekly') ->> 'next_on')::date >= tests.brussels_today(),
  'Unarchiving restarts the rule from today');
select tests.assert_true(public.advance_shopping(tests.i('home-a')) <= 1, 'At most one item, never the missed weeks');

-- Read-only members cannot manage rules.
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-groceries'), tests.list_rev('l-groceries'), 'Groceries', 'view', false);
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.update_shopping_recurrence(tests.i('r-weekly'), tests.rule_rev('r-weekly'), 'pause')),
  'A view-only member cannot pause a rule');
select tests.act_as('alice');
select public.update_shopping_list(tests.i('l-groceries'), tests.list_rev('l-groceries'), 'Groceries', 'edit', false);

-- Personal lists: the owner's timezone, and private ---------------------------------------------------

select tests.act_as('alice');
select tests.add('l-personal', tests.row(gen_random_uuid(), 'Thee'));
select tests.assert_true(
  (select outcome = 'created' from public.start_shopping_recurrence(
    tests.item_named('l-personal', 'Thee'),
    tests.i('r-personal'), 'daily', null, null, null, 'Pacific/Auckland')),
  'A personal rule takes the person''s timezone');
select tests.assert_true(
  tests.rule_json('r-personal') ->> 'time_zone' = 'Pacific/Auckland',
  'Kept with the rule');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_shopping_item_completed(tests.i('i-p'), true)),
  'Nobody else can touch a personal item');
select tests.assert_true(
  (select count(*) = 0 from public.shopping_item_history(tests.i('i-p'))), 'Or read its history');

-- Widget ------------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(w -> 'lists') = 2 and (w ->> 'unavailable')::integer = 1
    from public.shopping_widget(array[tests.i('l-groceries'), tests.i('l-market'), tests.i('l-b')], tests.i('home-a'), 15) w),
  'Combined: two of Home A''s lists, the forged one counted as unavailable, never shown');
select tests.assert_true(
  (select bool_and(x ->> 'listId' in (tests.i('l-groceries')::text, tests.i('l-market')::text))
    from jsonb_array_elements((public.shopping_widget(array[tests.i('l-groceries'), tests.i('l-market')], tests.i('home-a'), 15)) -> 'items') x),
  'Every row names its source list');
select tests.assert_true(
  (select count(*) = 0 from jsonb_array_elements((public.shopping_widget(array[tests.i('l-groceries')], tests.i('home-a'), 15)) -> 'items') x
    where x ->> 'id' = tests.i('i-batch-1')::text),
  'Completed items are not shown');
select tests.assert_denied(
  $$select public.shopping_widget(array[tests.i('l-b')], tests.i('home-b'), 5)$$, 'Not for a Home she is not in');
select tests.assert_denied(
  $$select public.shopping_widget(array[tests.i('l-groceries'), tests.i('l-groceries')], tests.i('home-a'), 5)$$,
  'A list chosen twice is malformed', '22023');

-- Deleting and restoring a list --------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'deleted' from public.delete_shopping_list(tests.i('l-market'), tests.list_rev('l-market'))),
  'Alice deletes Market');
select tests.act_as('carol');
select tests.assert_true(public.get_shopping_list(tests.i('l-market')) is null, 'It is gone for everyone');
select tests.assert_true(
  (select outcome = 'not_found' from public.set_shopping_item_completed(tests.i('i-eggs'), true)),
  'Its items too');
select tests.assert_true(
  (select (w ->> 'unavailable')::integer = 1 from public.shopping_widget(array[tests.i('l-market')], tests.i('home-a'), 5) w),
  'A widget showing it says it is no longer available');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'restored' from public.restore_trash_entries(
    array[(select entry_id from public.list_trash(tests.i('home-a')) where item_type = 'shopping_list')])),
  'Restoring Market');
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) >= 2 from jsonb_array_elements(public.get_shopping_list(tests.i('l-market')) -> 'items') x),
  'Comes back with its items');

-- History, departure, signal ---------------------------------------------------------------------------

select tests.assert_true(
  (select bool_and(actor is null or (actor ->> 'me')::boolean or actor ->> 'member' is not null)
    from public.shopping_item_history(tests.i('i-milk'))),
  'History names people by membership id or as me');
select tests.act_as('bob');
select tests.assert_row_count($$select * from public.shopping_signals where context_id = tests.i('home-b')$$, 0,
  'No signal row before a commit (moves are deferred to commit)');
-- Firing the deferred triggers now, as a commit would: each changed context moves exactly once for
-- the whole transaction, and a context with no shopping change gets nothing.
select tests.act_as_owner();
set constraints all immediate;
select tests.assert_true(tests.signal(tests.i('home-a')) = 1, 'Home A''s signal moved once for all its changes');
select tests.assert_true(tests.signal(tests.i('home-b')) = 1, 'Home B''s signal moved once for its own list');
select tests.assert_true(tests.signal(tests.user_id('alice')) = 1, 'Alice''s Personal signal moved once');
select tests.assert_true(tests.signal(tests.user_id('carol')) = 0,
  'Carol, with no Personal lists, has no signal: nothing from Home A leaks into it');
set constraints all deferred;
select tests.act_as('bob');
select tests.act_as_owner();
insert into public.shopping_signals (context_id, home_id) values (tests.i('home-a'), tests.i('home-a'))
  on conflict do nothing;
insert into public.shopping_signals (context_id, user_id) values (tests.user_id('alice'), tests.user_id('alice'))
  on conflict do nothing;
select tests.act_as('carol');
select tests.assert_row_count($$select * from public.shopping_signals where context_id = tests.i('home-a')$$, 1,
  'A member reads her Home''s signal');
select tests.assert_row_count($$select * from public.shopping_signals where context_id = tests.user_id('alice')$$, 0,
  'Not someone else''s Personal signal');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('carol');
select tests.assert_row_count($$select * from public.shopping_signals where context_id = tests.i('home-a')$$, 0,
  'After leaving, not even the signal');
select tests.assert_true(public.get_shopping_list(tests.i('l-carol')) is null,
  'Her own list stays with the Home and is no longer hers to see');
select tests.act_as('alice');
select tests.assert_true((public.get_shopping_list(tests.i('l-carol')) ->> 'access') = 'manage',
  'The Owner still manages it');
select tests.act_as('bob');
select tests.assert_true((public.get_shopping_list(tests.i('l-carol')) ->> 'access') = 'edit',
  'A member without the grant edits it (the creator''s rights ended with her membership)');
-- Rejoining later is a new membership: her list is visible again under member access, not hers to manage.
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role, created_at)
  values (tests.i('home-a'), tests.user_id('carol'), 'member', now() + interval '1 second');
select tests.act_as('carol');
select tests.assert_true((public.get_shopping_list(tests.i('l-carol')) ->> 'access') = 'edit',
  'Rejoining does not bring back the creator''s rights');

-- Audit keeps ids and counts, never names.
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) > 0 and bool_and(details::text not like '%Groceries%' and details::text not like '%Melk%')
    from private.audit_events where subject_type = 'shopping_list'),
  'Audit events carry no list or item names');
