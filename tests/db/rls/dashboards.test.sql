-- S17: dashboards and templates (supabase/migrations/*_dashboards.sql). Alice owns Home A, where
-- Bob is an Administrator and Carol a Member; Bob owns Home B. Covers: nothing reachable as a table;
-- personal dashboards private to their owner; Home dashboards readable by members only and saved by
-- the Owner or an Administrator granted manageHomeDashboard (revoked grant, plain Member, ex-member
-- and outsider refused, forged ids); optimistic concurrency on first and later saves; Undo; shape and
-- size checks; audit; templates private by default; sharing split by kind; shares ending when the
-- sharer leaves; outsiders seeing nothing; delete to trash, restore with shares, purge; the limit.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to authenticated, service_role;

select tests.act_as('alice');
insert into ids select 'home-a', public.create_home('Thuis', 'Europe/Brussels', gen_random_uuid());
select tests.act_as('bob');
insert into ids select 'home-b', public.create_home('Kot', 'Europe/Amsterdam', gen_random_uuid());
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'administrator'),
  ((select id from ids where name = 'home-a'), tests.user_id('carol'), 'member');
insert into ids select 'm-bob-a', id from public.home_memberships
  where home_id = (select id from ids where name = 'home-a') and user_id = tests.user_id('bob');

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;

-- A minimal valid layout with p_count widgets (the application validates the inside).
create function tests.layout(p_count integer default 1) returns jsonb
  language sql volatile as $$
  select jsonb_build_object(
    'version', 1,
    'widgets', coalesce((select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'type', 'welcome'))
      from generate_series(1, p_count)), '[]'::jsonb),
    'placements', jsonb_build_object('lg', '[]'::jsonb, 'md', '[]'::jsonb, 'sm', '[]'::jsonb));
  $$;

create function tests.widget_count(p_home text default null) returns integer
  language sql stable as $$
  select jsonb_array_length(layout -> 'widgets') from public.get_dashboard(tests.i(p_home));
  $$;

grant execute on function tests.i(text), tests.layout(integer), tests.widget_count(text)
  to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.dashboard_layouts', 'The API cannot read layouts');
select tests.assert_denied('select * from private.dashboard_templates', 'The API cannot read templates');
select tests.assert_denied('select * from private.dashboard_template_shares', 'Nor shares');
select tests.act_as_anon();
select tests.assert_denied('select * from public.get_dashboard()', 'Nobody signed out reads a dashboard');
select tests.assert_denied($$select * from public.save_dashboard(tests.layout(), 0, null)$$,
  'Nobody signed out saves one');

-- Personal dashboards --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select layout is null and revision = 0 and can_edit and not can_undo from public.get_dashboard()),
  'A new account has no saved layout yet: the starter shows, revision 0');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.save_dashboard(tests.layout(2), 0, null)),
  'The first save stores a copy at revision 1');
select tests.assert_true(tests.widget_count() = 2, 'Alice reads back her layout');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 1 from public.save_dashboard(tests.layout(3), 0, null)),
  'A second "first save" (another device) is a conflict, not an overwrite');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.save_dashboard(tests.layout(0), 1, null)),
  'Removing every widget is a valid save');
select tests.assert_true(tests.widget_count() = 0, 'An intentionally empty dashboard stays empty');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2 from public.save_dashboard(tests.layout(1), 1, null)),
  'A save from an old revision is a conflict');

select tests.act_as('bob');
select tests.assert_true(
  (select layout is null and revision = 0 from public.get_dashboard()),
  'Bob sees only his own personal dashboard, never Alice''s');
select tests.assert_true(
  (select outcome = 'saved' from public.save_dashboard(tests.layout(1), 0, null)),
  'Bob''s save creates his own row');
select tests.act_as('alice');
select tests.assert_true(tests.widget_count() = 0, 'Alice''s layout is untouched by Bob''s save');

-- Undo after a reset or template apply.
select tests.assert_true(
  (select outcome = 'saved' and revision = 3
   from public.save_dashboard(tests.layout(4), 2, null, tests.layout(0))),
  'A reset passes what it replaces');
select tests.assert_true((select can_undo from public.get_dashboard()), 'Undo is offered');
select tests.assert_true(
  (select outcome = 'conflict' from public.undo_dashboard_change(2, null)),
  'Undo from an old revision is a conflict');
select tests.assert_true(
  (select outcome = 'saved' and revision = 4 from public.undo_dashboard_change(3, null)),
  'Undo puts the replaced layout back');
select tests.assert_true(tests.widget_count() = 0 and not (select can_undo from public.get_dashboard()),
  'It is back and Undo is used up');
select tests.assert_true(
  (select outcome = 'nothing_to_undo' from public.undo_dashboard_change(4, null)),
  'A second Undo has nothing to undo');
select tests.assert_true(
  (select outcome = 'saved' from public.save_dashboard(tests.layout(1), 4, null, tests.layout(0)))
  and (select outcome = 'saved' from public.save_dashboard(tests.layout(2), 5, null))
  and not (select can_undo from public.get_dashboard()),
  'A plain edit after a reset clears its Undo');

-- Shape and size.
select tests.assert_denied($$select * from public.save_dashboard('[]'::jsonb, 6, null)$$,
  'A layout must be an object', '22023');
select tests.assert_denied(
  $$select * from public.save_dashboard(jsonb_set(tests.layout(), '{version}', '2'), 6, null)$$,
  'Only schema version 1 is accepted', '22023');
select tests.assert_denied(
  $$select * from public.save_dashboard(tests.layout() - 'placements', 6, null)$$,
  'Placements are required', '22023');
select tests.assert_denied(
  $$select * from public.save_dashboard(jsonb_set(tests.layout(), '{padding}', to_jsonb(repeat('x', 70000))), 6, null)$$,
  'A layout larger than 64 KB is refused', '22023');
select tests.assert_denied($$select * from public.save_dashboard(tests.layout(), -1, null)$$,
  'A negative revision is refused', '22023');
select tests.assert_true(
  (select revision = 6 from public.get_dashboard()), 'Refused saves changed nothing');

-- Home dashboards --------------------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select layout is null and revision = 0 and not can_edit from public.get_dashboard(tests.i('home-a'))),
  'A Member reads the Home dashboard but may not edit it');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.save_dashboard(tests.layout(), 0, tests.i('home-a'))),
  'A Member''s save is refused at the database');
select tests.assert_denied($$select * from public.get_dashboard(tests.i('home-b'))$$,
  'Carol cannot read the dashboard of a Home she is not in');
select tests.assert_denied($$select * from public.get_dashboard(gen_random_uuid())$$,
  'A forged Home id answers exactly like a Home she is not in');
select tests.assert_denied($$select * from public.save_dashboard(tests.layout(), 0, tests.i('home-b'))$$,
  'Carol cannot save the dashboard of a Home she is not in');

select tests.act_as('bob');
select tests.assert_true(
  (select not can_edit from public.get_dashboard(tests.i('home-a'))),
  'An Administrator without the grant may not edit');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.save_dashboard(tests.layout(), 0, tests.i('home-a'))),
  'And is refused');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'),
    tests.i('m-bob-a'),
    array['manageHomeDashboard']) = 'not_permitted',
  'An Administrator cannot grant himself the right');

select tests.act_as('alice');
select tests.assert_true((select can_edit from public.get_dashboard(tests.i('home-a'))), 'The Owner may edit');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.save_dashboard(tests.layout(3), 0, tests.i('home-a'))),
  'The Owner saves the Home dashboard');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'),
    tests.i('m-bob-a'),
    array['manageHomeDashboard']) = 'ok',
  'The Owner grants Bob "Manage Home dashboard"');

select tests.act_as('bob');
select tests.assert_true(
  (select can_edit and revision = 1 from public.get_dashboard(tests.i('home-a'))),
  'With the grant, Bob may edit');
select tests.assert_true(
  (select outcome = 'saved' and revision = 2 from public.save_dashboard(tests.layout(1), 1, tests.i('home-a'))),
  'Bob saves');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2
   from public.save_dashboard(tests.layout(5), 1, tests.i('home-a'))),
  'The Owner editing an older copy gets a conflict instead of overwriting Bob''s change');
select tests.assert_true(tests.widget_count('home-a') = 1, 'Bob''s change stands');

select tests.act_as('carol');
select tests.assert_true(tests.widget_count('home-a') = 1, 'Every member sees the shared layout');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.undo_dashboard_change(2, tests.i('home-a'))),
  'A Member cannot undo either');
select tests.assert_true(
  (select layout is null from public.get_dashboard()), 'The Home layout never shows as Carol''s personal one');

select tests.act_as('alice');
select tests.assert_true(
  public.set_administrator_capabilities(tests.i('home-a'),
    tests.i('m-bob-a'),
    '{}') = 'ok',
  'The Owner revokes the grant');
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.save_dashboard(tests.layout(), 2, tests.i('home-a'))),
  'A revoked grant stops Bob at once');

select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 2 from private.audit_events
   where action = 'home_dashboard.saved' and home_id = tests.i('home-a')
     and subject_type = 'home' and not details ? 'layout'),
  'Each Home dashboard save is audited, by count only');
select tests.assert_true(
  not exists (select 1 from private.audit_events where action = 'home_dashboard.saved'
    and home_id is null),
  'Personal saves are not Home audit events');

-- Templates ---------------------------------------------------------------------------------------------

select tests.act_as('alice');
insert into ids select 'tp', template_id
  from public.create_dashboard_template('Mijn ochtend', 'personal', tests.layout(2));
insert into ids select 'th', template_id
  from public.create_dashboard_template('Keukenscherm', 'home', tests.layout(3));
select tests.assert_row_count($$select * from public.list_dashboard_templates()$$, 2,
  'Alice sees her two templates');
select tests.assert_true(
  (select is_mine and shared_home_ids = '{}' from public.list_dashboard_templates() where template_id = tests.i('tp')),
  'A new template is private');
select tests.assert_denied($$select * from public.create_dashboard_template('', 'personal', tests.layout())$$,
  'An empty name is refused', '22023');
select tests.assert_denied($$select * from public.create_dashboard_template(' Padded', 'personal', tests.layout())$$,
  'Untrimmed names are refused', '22023');
select tests.assert_denied($$select * from public.create_dashboard_template('X', 'display', tests.layout())$$,
  'Only personal and home kinds exist', '22023');
select tests.assert_true(public.rename_dashboard_template(tests.i('tp'), 'Ochtend') = 'ok', 'Alice renames');

select tests.act_as('carol');
select tests.assert_row_count($$select * from public.list_dashboard_templates()$$, 0,
  'Carol sees nothing private of Alice''s');
select tests.assert_true(public.rename_dashboard_template(tests.i('tp'), 'Mine') = 'not_found',
  'Carol cannot rename it');
select tests.assert_true(public.share_dashboard_template(tests.i('tp'), tests.i('home-a')) = 'not_found',
  'Nor share it');
select tests.assert_true(public.delete_dashboard_template(tests.i('tp')) is null, 'Nor delete it');

-- Sharing, split by kind.
select tests.act_as('alice');
select tests.assert_true(public.share_dashboard_template(tests.i('tp'), tests.i('home-a')) = 'shared',
  'Alice shares her personal template into Home A');
select tests.assert_true(public.share_dashboard_template(tests.i('tp'), tests.i('home-a')) = 'unchanged',
  'Sharing twice changes nothing');
select tests.assert_true(public.share_dashboard_template(tests.i('tp'), tests.i('home-b')) = 'not_found',
  'She cannot share into a Home she is not in');
select tests.assert_true(public.share_dashboard_template(tests.i('th'), tests.i('home-a')) = 'shared',
  'As Owner she shares a Home template there');

select tests.act_as('carol');
insert into ids select 'tc', template_id
  from public.create_dashboard_template('Carols indeling', 'personal', tests.layout(1));
insert into ids select 'tch', template_id
  from public.create_dashboard_template('Carols Home', 'home', tests.layout(1));
select tests.assert_true(public.share_dashboard_template(tests.i('tc'), tests.i('home-a')) = 'shared',
  'A Member shares a personal template into her Home');
select tests.assert_true(public.share_dashboard_template(tests.i('tch'), tests.i('home-a')) = 'not_permitted',
  'A Member may not share a Home-dashboard template');
select tests.assert_row_count($$select * from public.list_dashboard_templates(tests.i('home-a'))$$, 3,
  'Members see every template shared into the Home');
select tests.assert_true(
  (select not is_mine and shared_home_ids = array[tests.i('home-a')] and name = 'Ochtend'
   from public.list_dashboard_templates() where template_id = tests.i('tp')),
  'Carol sees Alice''s shared template, with its current name');
select tests.assert_true(public.unshare_dashboard_template(tests.i('tp'), tests.i('home-a')) = 'not_found',
  'A Member cannot remove someone else''s share');

select tests.act_as('bob');
select tests.assert_row_count($$select * from public.list_dashboard_templates(tests.i('home-b'))$$, 0,
  'Nothing of Home A shows in Home B');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('bob');
select tests.act_as('bob');
select tests.assert_denied($$select * from public.list_dashboard_templates(tests.i('home-a'))$$,
  'An ex-member cannot list the Home''s templates');
select tests.assert_row_count($$select * from public.list_dashboard_templates()$$, 0,
  'Nor sees them in his own list');
select tests.assert_denied($$select * from public.get_dashboard(tests.i('home-a'))$$,
  'Nor reads its dashboard');

-- A Home dashboard editor may take a share out of their Home.
select tests.act_as('alice');
select tests.assert_true(public.unshare_dashboard_template(tests.i('tc'), tests.i('home-a')) = 'removed',
  'The Owner removes Carol''s share from Home A');
select tests.act_as('carol');
select tests.assert_true(
  (select shared_home_ids = '{}' from public.list_dashboard_templates() where template_id = tests.i('tc')),
  'Carol keeps her template, now private again');
select tests.assert_true(public.share_dashboard_template(tests.i('tc'), tests.i('home-a')) = 'shared',
  'And can share it again');

-- A share ends when the sharer leaves.
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.act_as('alice');
select tests.assert_true(
  not exists (select 1 from public.list_dashboard_templates(tests.i('home-a')) where template_id = tests.i('tc')),
  'Carol''s share left Home A with her');
select tests.act_as('carol');
select tests.assert_true(
  (select shared_home_ids = '{}' from public.list_dashboard_templates() where template_id = tests.i('tc')),
  'Her template is hers alone again');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.dashboard_template_shares where template_id = tests.i('tc')),
  'No share row remains');
select tests.assert_true(
  (select count(*) >= 3 from private.audit_events where subject_type = 'dashboard_template'
     and action in ('dashboard_template.shared', 'dashboard_template.unshared')),
  'Shares and unshares are audited');

-- Delete to the trash, restore with its shares, purge.
select tests.act_as('alice');
insert into ids select 'e-tp', public.delete_dashboard_template(tests.i('tp'));
select tests.assert_true(tests.i('e-tp') is not null, 'Deleting gives a trash entry');
select tests.assert_true(
  not exists (select 1 from public.list_dashboard_templates() where template_id = tests.i('tp')),
  'A deleted template is gone from the list');
select tests.assert_true(
  (select label = 'Ochtend' and module = 'dashboard' and item_type = 'dashboard_template'
   from public.list_trash() where entry_id = tests.i('e-tp')),
  'It is in Alice''s personal trash under its name');
select tests.assert_true(public.share_dashboard_template(tests.i('tp'), tests.i('home-a')) = 'not_found',
  'A template in the trash cannot be shared');
select tests.assert_true(public.delete_dashboard_template(tests.i('tp')) is null, 'Nor deleted twice');
select tests.assert_true(
  (select outcome from public.restore_trash_entries(array[tests.i('e-tp')])) = 'restored',
  'Alice restores it');
select tests.assert_true(
  (select shared_home_ids = array[tests.i('home-a')] from public.list_dashboard_templates()
   where template_id = tests.i('tp')),
  'It comes back shared, as before');
insert into ids select 'e-th', public.delete_dashboard_template(tests.i('th'));
select tests.assert_true(
  (select outcome from public.purge_trash_entries(array[tests.i('e-th')])) = 'purged',
  'Deleting permanently from the trash');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.dashboard_templates where id = tests.i('th'))
  and not exists (select 1 from private.dashboard_template_shares where template_id = tests.i('th')),
  'Purging removes the template and its shares');

-- The per-person limit counts active templates only.
select tests.act_as('bob');
select count(*) from (
  select public.create_dashboard_template('T' || n, 'personal', tests.layout()) from generate_series(1, 50) n
) created;
select tests.assert_true(
  (select outcome = 'limit_reached' from public.create_dashboard_template('One more', 'personal', tests.layout())),
  'The 51st template is refused');
select public.delete_dashboard_template((select template_id from public.list_dashboard_templates() limit 1));
select tests.assert_true(
  (select outcome = 'created' from public.create_dashboard_template('One more', 'personal', tests.layout())),
  'A template in the trash no longer counts');

-- Grants -------------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied($$select private.can_edit_home_dashboard(tests.i('home-a'), tests.user_id('alice'))$$,
  'Private helpers stay closed');
