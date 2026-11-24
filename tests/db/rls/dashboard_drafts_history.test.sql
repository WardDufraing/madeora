-- UX2-data: dashboard drafts, version history, personal Home views and suggestions
-- (supabase/migrations/20261219090000_dashboard_drafts_history.sql). Alice owns Home A, where Bob is
-- an Administrator (granted manageHomeDashboard) and Carol a Member; Bob owns Home B. Covers:
-- nothing reachable as a table; legacy calls unchanged; drafts private per person and target, never
-- touching the committed layout, kept on conflict, discarded on Done, expired, refused for
-- outsiders/forged Homes, discarded when edit rights are lost; 10-version history from the stored
-- row, restore as a new commit with Undo, history visibility; personal Home views owner-only,
-- 'effective' resolution, independent from the shared default, ending on departure; suggestions
-- and dismissals; eligibility (children); privacy export; account deletion cascade.

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
insert into private.home_admin_capabilities (home_id, user_id, capability) values
  ((select id from ids where name = 'home-a'), tests.user_id('bob'), 'manageHomeDashboard');

create function tests.i(p_name text) returns uuid
  language sql stable security definer as $$ select id from ids where name = p_name; $$;

-- A minimal valid layout whose widgets have the given ids (the application validates the inside).
create function tests.lay(p_ids uuid[] default '{}') returns jsonb
  language sql immutable as $$
  select jsonb_build_object(
    'version', 1,
    'widgets', coalesce((select jsonb_agg(jsonb_build_object('id', i, 'type', 'welcome') order by n)
      from unnest(p_ids) with ordinality as u(i, n)), '[]'::jsonb),
    'placements', jsonb_build_object('lg', '[]'::jsonb, 'md', '[]'::jsonb, 'sm', '[]'::jsonb));
  $$;

create function tests.w(p_n integer) returns uuid
  language sql immutable as $$ select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid; $$;

grant execute on function tests.i(text), tests.lay(uuid[]), tests.w(integer)
  to authenticated, service_role;

-- Nothing reachable --------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_denied('select * from private.dashboard_drafts', 'The API cannot read drafts');
select tests.assert_denied('select * from private.dashboard_member_overrides', 'Nor Home views');
select tests.assert_denied('select * from private.dashboard_layout_versions', 'Nor history');
select tests.assert_denied('select private.commit_dashboard(null, null, null, null, null, null, null)',
  'The commit helper is closed to the API');
select tests.assert_denied('select private.purge_expired_dashboard_drafts(1)', 'So is the purge');
select tests.act_as_anon();
select tests.assert_denied('select * from public.get_dashboard_draft()', 'Signed out: no drafts');
select tests.assert_denied($$select * from public.save_dashboard_draft(tests.lay(), 0)$$,
  'Signed out: no draft saves');
select tests.assert_denied('select * from public.list_dashboard_versions()', 'Signed out: no history');

-- Legacy calls keep their meaning ------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select target = 'personal' and revision = 0 and not has_override and not has_draft
   from public.get_dashboard()),
  'A personal read without a target is the personal dashboard');
select tests.assert_true(
  (select target = 'default' and can_edit from public.get_dashboard(tests.i('home-a'))),
  'A Home read without a target is the shared default');
select tests.assert_denied($$select * from public.get_dashboard(null, 'mine')$$,
  'A Home target without a Home is malformed', '22023');
select tests.assert_denied($$select * from public.get_dashboard(tests.i('home-a'), 'everything')$$,
  'An unknown target is malformed', '22023');
select tests.assert_denied($$select * from public.save_dashboard(tests.lay(), 0, tests.i('home-a'), null, 'effective')$$,
  '"effective" is for reads only', '22023');

-- Personal drafts ----------------------------------------------------------------------------------

select tests.assert_true(
  (select outcome = 'saved' and revision = 1 from public.save_dashboard(tests.lay(array[tests.w(1)]), 0)),
  'Alice commits her personal dashboard');
select tests.assert_true(
  (select outcome = 'saved' and updated_at is not null
   from public.save_dashboard_draft(tests.lay(array[tests.w(1), tests.w(2)]), 1)),
  'An autosave stores a draft');
select tests.assert_true(
  (select outcome = 'saved' from public.save_dashboard_draft(tests.lay(array[tests.w(1), tests.w(2), tests.w(3)]), 1)),
  'A later autosave replaces it');
select tests.assert_true(
  (select jsonb_array_length(layout -> 'widgets') = 1 and has_draft from public.get_dashboard()),
  'The committed dashboard is untouched by drafts; has_draft says one exists');
select tests.assert_true(
  (select jsonb_array_length(layout -> 'widgets') = 3 and base_revision = 1 and current_revision = 1
     and expires_at > now() + interval '29 days'
   from public.get_dashboard_draft()),
  'The draft reads back with its base and the current revision');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.dashboard_drafts where user_id = tests.user_id('alice')),
  'One draft per person and target');

select tests.act_as('bob');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft()),
  'Bob never sees Alice''s personal draft');
select tests.assert_true(
  (select discard_dashboard_draft = 'nothing_to_discard' from public.discard_dashboard_draft()),
  'Nor can he discard it');

-- Another device commits meanwhile: the draft is stale, not lost.
select tests.act_as('alice');
select public.save_dashboard(tests.lay(array[tests.w(9)]), 1);
select tests.assert_true(
  (select base_revision = 1 and current_revision = 2 from public.get_dashboard_draft()),
  'A commit elsewhere makes the draft stale (rebase-or-discard), never overwritten');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 2
   from public.save_dashboard(tests.lay(array[tests.w(1), tests.w(2), tests.w(3)]), 1, null, null, null, true)),
  'Done from the old revision is a conflict');
select tests.assert_true(exists (select 1 from public.get_dashboard_draft()),
  'and the draft survives a failed Done');
select tests.assert_true(
  (select outcome = 'saved' and revision = 3
   from public.save_dashboard(tests.lay(array[tests.w(1), tests.w(2), tests.w(3)]), 2, null, null, null, true)),
  'Done from the current revision commits');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft()),
  'and discards the draft in the same transaction');
select public.save_dashboard_draft(tests.lay(), 3);
select tests.assert_true(
  (select outcome = 'saved' from public.save_dashboard(tests.lay(array[tests.w(4)]), 3)),
  'A plain save (no Done) commits');
select tests.assert_true(exists (select 1 from public.get_dashboard_draft()),
  'and leaves a draft in progress alone');
select tests.assert_true(
  (select discard_dashboard_draft = 'discarded' from public.discard_dashboard_draft()),
  'Cancel discards the draft');
select tests.assert_denied($$select * from public.save_dashboard_draft('{"version": 2}'::jsonb, 0)$$,
  'A malformed draft is refused', '22023');
select tests.assert_denied($$select * from public.save_dashboard_draft(tests.lay(), -1)$$,
  'A negative base revision is refused', '22023');

-- Expiry: an old draft is gone on read and purged in bulk.
select public.save_dashboard_draft(tests.lay(), 4);
select tests.act_as_owner();
update private.dashboard_drafts set updated_at = now() - interval '31 days'
  where user_id = tests.user_id('alice');
select tests.act_as('alice');
select tests.assert_true(
  (select not has_draft from public.get_dashboard()), 'An expired draft does not count');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft()),
  'An expired draft is not offered');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.dashboard_drafts where user_id = tests.user_id('alice')),
  'and was deleted on the way');
insert into private.dashboard_drafts (user_id, home_id, target, layout, base_revision, updated_at)
  values (tests.user_id('carol'), null, 'personal', tests.lay(), 0, now() - interval '40 days');
select tests.assert_true(private.purge_expired_dashboard_drafts(10) = 1,
  'The purge removes expired drafts of anyone');

-- Home drafts and permissions ------------------------------------------------------------------------

select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.save_dashboard_draft(tests.lay(), 0, tests.i('home-a'))),
  'A plain Member cannot draft the shared default');
select tests.assert_true(
  (select outcome = 'saved' from public.save_dashboard_draft(tests.lay(), 0, tests.i('home-a'), 'mine')),
  'but can draft her own Home view');
select tests.assert_denied($$select * from public.save_dashboard_draft(tests.lay(), 0, tests.i('home-b'), 'mine')$$,
  'Not in a Home she does not belong to');
select tests.assert_denied($$select * from public.get_dashboard_draft(tests.i('home-b'), 'mine')$$,
  'Nor read one there');
select tests.assert_denied($$select * from public.get_dashboard_draft(gen_random_uuid())$$,
  'A forged Home id is refused like a foreign one');

select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'saved' from public.save_dashboard_draft(tests.lay(array[tests.w(20)]), 0, tests.i('home-a'))),
  'Bob (manageHomeDashboard) drafts the shared default');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft(tests.i('home-a'), 'mine')),
  'His shared-default draft is not his Home-view draft');
select tests.act_as('alice');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft(tests.i('home-a'))),
  'Drafts are per person: Alice does not see Bob''s draft of the same dashboard');

-- Revoking the grant discards his shared-default draft.
select tests.act_as_owner();
delete from private.home_admin_capabilities
  where home_id = tests.i('home-a') and user_id = tests.user_id('bob');
select tests.assert_true(
  not exists (select 1 from private.dashboard_drafts
    where user_id = tests.user_id('bob') and home_id = tests.i('home-a') and target = 'default'),
  'Losing manageHomeDashboard discards the shared-default draft');
-- A draft left behind some other way is refused and discarded on read.
insert into private.dashboard_drafts (user_id, home_id, target, layout, base_revision)
  values (tests.user_id('bob'), tests.i('home-a'), 'default', tests.lay(), 0);
select tests.act_as('bob');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft(tests.i('home-a'))),
  'A shared-default draft its author may no longer commit is not offered');
select tests.assert_true(
  (select not has_draft and not can_edit from public.get_dashboard(tests.i('home-a'))),
  'and get_dashboard does not report it');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.dashboard_drafts
    where user_id = tests.user_id('bob') and home_id = tests.i('home-a') and target = 'default'),
  'and is deleted');
insert into private.home_admin_capabilities (home_id, user_id, capability)
  values (tests.i('home-a'), tests.user_id('bob'), 'manageHomeDashboard');

-- A demotion drops the grant and the draft with it.
select tests.act_as('bob');
select public.save_dashboard_draft(tests.lay(), 0, tests.i('home-a'));
select tests.act_as_owner();
update public.home_memberships set role = 'member'
  where home_id = tests.i('home-a') and user_id = tests.user_id('bob');
select tests.assert_true(
  not exists (select 1 from private.dashboard_drafts
    where user_id = tests.user_id('bob') and home_id = tests.i('home-a') and target = 'default'),
  'A demotion discards the shared-default draft');
update public.home_memberships set role = 'administrator'
  where home_id = tests.i('home-a') and user_id = tests.user_id('bob');
insert into private.home_admin_capabilities (home_id, user_id, capability)
  values (tests.i('home-a'), tests.user_id('bob'), 'manageHomeDashboard');

-- History ------------------------------------------------------------------------------------------

select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 4 and bool_and(saved_by_me) and count(*) filter (where is_current) = 1
     and max(revision) = 4
   from public.list_dashboard_versions()),
  'Every committed personal save is a version; drafts never are');
do $$
begin
  for n in 5..16 loop
    perform public.save_dashboard(tests.lay(array[tests.w(n)]), n - 1);
  end loop;
end
$$;
select tests.assert_true(
  (select count(*) = 10 and min(revision) = 7 and max(revision) = 16 from public.list_dashboard_versions()),
  'Only the 10 most recent versions are kept');
select tests.assert_true(
  (select layout -> 'widgets' -> 0 ->> 'id' = tests.w(16)::text from public.list_dashboard_versions()
   where is_current),
  'A version holds the committed layout');
select tests.act_as('bob');
select tests.assert_true(not exists (select 1 from public.list_dashboard_versions()),
  'Bob sees none of Alice''s personal history');
select tests.assert_true(
  (select outcome = 'not_found' from public.restore_dashboard_version(
    (select id from ids where name = 'home-a'), 1)),
  'An unknown version id is not found');

select tests.act_as('alice');
insert into ids select 'v-alice-10', version_id from public.list_dashboard_versions() where revision = 10;
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.restore_dashboard_version(tests.i('v-alice-10'), 16)),
  'Bob cannot restore Alice''s personal version (and learns nothing about it)');
select tests.act_as('alice');
select tests.assert_true(
  (select outcome = 'conflict' and revision = 16
   from public.restore_dashboard_version(tests.i('v-alice-10'), 15)),
  'A restore from a stale revision is a conflict');
select tests.assert_true(
  (select outcome = 'saved' and revision = 17
   from public.restore_dashboard_version(tests.i('v-alice-10'), 16)),
  'Restoring creates a new commit');
select tests.assert_true(
  (select layout -> 'widgets' -> 0 ->> 'id' = tests.w(10)::text and can_undo from public.get_dashboard()),
  'with the restored layout, and Undo available');
select tests.assert_true(
  (select reason = 'restore' from public.list_dashboard_versions() where revision = 17),
  'The restore is recorded as such');
select tests.assert_true(
  (select outcome = 'saved' from public.undo_dashboard_change(17)),
  'Undo of a restore works');
select tests.assert_true(
  (select layout -> 'widgets' -> 0 ->> 'id' = tests.w(16)::text from public.get_dashboard()),
  'and brings back the replaced layout');
select tests.assert_true(
  (select reason = 'undo' and is_current from public.list_dashboard_versions() where revision = 18),
  'Undo is a version too');

-- Shared-default history: editors only.
select tests.act_as('bob');
select public.save_dashboard(tests.lay(array[tests.w(30)]), 0, tests.i('home-a'));
select tests.assert_true(
  (select count(*) = 1 and bool_and(saved_by_me) from public.list_dashboard_versions(tests.i('home-a'))),
  'An editor lists the shared-default history');
insert into ids select 'v-home-1', version_id from public.list_dashboard_versions(tests.i('home-a'));
select tests.act_as('alice');
select tests.assert_true(
  (select count(*) = 1 and not bool_or(saved_by_me) from public.list_dashboard_versions(tests.i('home-a'))),
  'The Owner sees it too, without who saved it');
select tests.act_as('carol');
select tests.assert_denied($$select * from public.list_dashboard_versions(tests.i('home-a'))$$,
  'A plain Member does not see shared-default history');
select tests.assert_true(
  (select outcome = 'not_permitted' from public.restore_dashboard_version(tests.i('v-home-1'), 1)),
  'Nor restore it');
select tests.act_as('alice');
select tests.assert_denied($$select * from public.list_dashboard_versions(tests.i('home-b'))$$,
  'Alice cannot list Home B''s history');
select tests.act_as_owner();
select tests.assert_true(
  (select count(*) = 1 from private.audit_events
   where action = 'home_dashboard.saved' and home_id = tests.i('home-a')),
  'Shared-default commits stay audited');

-- Personal Home views ------------------------------------------------------------------------------

-- The shared default now has widgets 30, 31.
select tests.act_as('bob');
select public.save_dashboard(tests.lay(array[tests.w(30), tests.w(31)]), 1, tests.i('home-a'));
select tests.act_as('carol');
select tests.assert_true(
  (select target = 'default' and not has_override and not can_edit
   from public.get_dashboard(tests.i('home-a'), 'effective')),
  'Without a view, "effective" is the shared default');
select tests.assert_true(
  (select target = 'mine' and layout is null and revision = 0 and can_edit
   from public.get_dashboard(tests.i('home-a'), 'mine')),
  'Her view does not exist yet');
select tests.assert_true(
  (select outcome = 'saved' and revision = 1
   from public.save_dashboard(tests.lay(array[tests.w(31), tests.w(40)]), 0, tests.i('home-a'), null, 'mine', true)),
  'A member creates her own Home view (Done)');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft(tests.i('home-a'), 'mine')),
  'Done discarded her Home-view draft');
select tests.assert_true(
  (select target = 'mine' and has_override and revision = 1
   from public.get_dashboard(tests.i('home-a'), 'effective')),
  'Now "effective" is her view');
select tests.assert_true(
  (select outcome = 'conflict' from public.save_dashboard(tests.lay(), 0, tests.i('home-a'), null, 'mine')),
  'A second "first save" of a view is a conflict');
select tests.assert_true(
  (select jsonb_array_length(layout -> 'widgets') = 2 and revision = 2
   from public.get_dashboard(tests.i('home-a'))),
  'The shared default is unchanged by her view');

select tests.act_as('bob');
select tests.assert_true(
  (select target = 'default' and not has_override from public.get_dashboard(tests.i('home-a'), 'effective')),
  'Other members still get the shared default');
select tests.assert_true(
  (select layout is null from public.get_dashboard(tests.i('home-a'), 'mine')),
  'and never see Carol''s view');
select tests.assert_true(not exists (select 1 from public.list_dashboard_suggestions(tests.i('home-a'))),
  'No suggestions without a view of one''s own');

-- Shared-default changes reach members without a view; members with one get suggestions.
select public.save_dashboard(tests.lay(array[tests.w(30), tests.w(31), tests.w(32), tests.w(33)]), 2, tests.i('home-a'));
select tests.act_as('carol');
select tests.assert_true(
  (select jsonb_array_length(layout -> 'widgets') = 2 from public.get_dashboard(tests.i('home-a'), 'effective')),
  'A shared-default change never rewrites her view');
select tests.assert_true(
  (select array_agg(widget_id order by widget_id) = array[tests.w(32), tests.w(33)]
     and bool_and(widget ->> 'type' = 'welcome')
   from public.list_dashboard_suggestions(tests.i('home-a'))),
  'Only new widgets are suggested (not 30, which she saw when her view started)');
select tests.assert_true(
  (select dismiss_dashboard_suggestions = 'dismissed'
   from public.dismiss_dashboard_suggestions(tests.i('home-a'), array[tests.w(32), gen_random_uuid()])),
  'She dismisses one (unknown ids are ignored)');
select tests.assert_true(
  (select array_agg(widget_id) = array[tests.w(33)] from public.list_dashboard_suggestions(tests.i('home-a'))),
  'and it is not offered again');
select public.save_dashboard(tests.lay(array[tests.w(31), tests.w(40), tests.w(33)]), 1, tests.i('home-a'), null, 'mine');
select tests.assert_true(not exists (select 1 from public.list_dashboard_suggestions(tests.i('home-a'))),
  'Adding the suggested widget settles it');
select tests.act_as_owner();
select tests.assert_true(
  (select known_default_widget_ids @> array[tests.w(32)] and not (known_default_widget_ids @> array[tests.w(40)])
   from private.dashboard_member_overrides
   where home_id = tests.i('home-a') and user_id = tests.user_id('carol')),
  'Remembered ids are pruned to the shared default');
select tests.act_as('bob');
select tests.assert_true(
  (select dismiss_dashboard_suggestions = 'no_override'
   from public.dismiss_dashboard_suggestions(tests.i('home-a'), array[tests.w(33)])),
  'Dismissing without a view does nothing');
select tests.assert_denied($$select * from public.list_dashboard_suggestions(gen_random_uuid())$$,
  'Suggestions of a forged Home are refused');

-- View history, Undo and restore are the owner's.
select tests.act_as('carol');
select tests.assert_true(
  (select count(*) = 2 and bool_and(saved_by_me) from public.list_dashboard_versions(tests.i('home-a'), 'mine')),
  'Her view has its own history');
insert into ids select 'v-carol-1', version_id from public.list_dashboard_versions(tests.i('home-a'), 'mine')
  where revision = 1;
select tests.act_as('bob');
select tests.assert_true(
  (select outcome = 'not_found' from public.restore_dashboard_version(tests.i('v-carol-1'), 2)),
  'Nobody else restores her view''s versions');
select tests.act_as('carol');
select tests.assert_true(
  (select outcome = 'saved' and revision = 3 from public.restore_dashboard_version(tests.i('v-carol-1'), 2)),
  'She restores one of hers');
select tests.assert_true(
  (select outcome = 'saved' from public.undo_dashboard_change(3, tests.i('home-a'), 'mine')),
  'and can undo it');

-- Reset returns to the shared default.
select public.save_dashboard_draft(tests.lay(), 4, tests.i('home-a'), 'mine');
select tests.assert_true(
  (select reset_dashboard_override = 'reset' from public.reset_dashboard_override(tests.i('home-a'))),
  'She resets her view');
select tests.assert_true(
  (select target = 'default' and not has_override from public.get_dashboard(tests.i('home-a'), 'effective')),
  'and sees the shared default again');
select tests.assert_true(not exists (select 1 from public.get_dashboard_draft(tests.i('home-a'), 'mine')),
  'Her view draft went with it');
select tests.act_as_owner();
select tests.assert_true(
  not exists (select 1 from private.dashboard_layout_versions v
    join private.dashboard_member_overrides o on o.id = v.override_id
    where o.user_id = tests.user_id('carol')),
  'and so did its history');
select tests.act_as('carol');
select tests.assert_true(
  (select reset_dashboard_override = 'nothing_to_reset' from public.reset_dashboard_override(tests.i('home-a'))),
  'Resetting twice is harmless');
select tests.assert_denied($$select public.reset_dashboard_override(tests.i('home-b'))$$,
  'Not in a foreign Home');

-- Leaving a Home ends the view, its history and the drafts there.
select public.save_dashboard(tests.lay(array[tests.w(50)]), 0, tests.i('home-a'), null, 'mine');
select public.save_dashboard_draft(tests.lay(), 1, tests.i('home-a'), 'mine');
select tests.act_as_owner();
delete from public.home_memberships where home_id = tests.i('home-a') and user_id = tests.user_id('carol');
select tests.assert_true(
  not exists (select 1 from private.dashboard_member_overrides where user_id = tests.user_id('carol'))
  and not exists (select 1 from private.dashboard_drafts
    where user_id = tests.user_id('carol') and home_id is not null),
  'Leaving a Home deletes the member''s view and drafts there');
select tests.act_as('carol');
select tests.assert_denied($$select * from public.get_dashboard(tests.i('home-a'), 'mine')$$,
  'An ex-member reads nothing of the Home');
select tests.assert_denied($$select * from public.save_dashboard(tests.lay(), 0, tests.i('home-a'), null, 'mine')$$,
  'and cannot recreate a view there');
select tests.act_as_owner();
insert into public.home_memberships (home_id, user_id, role)
  values (tests.i('home-a'), tests.user_id('carol'), 'member');

-- Eligibility: children cannot draft or keep a view.
insert into public.child_profiles (user_id, created_by, creation_request_id)
  values (tests.user_id('carol'), tests.user_id('alice'), gen_random_uuid());
select tests.act_as('carol');
select tests.assert_denied($$select * from public.save_dashboard_draft(tests.lay(), 0)$$,
  'A child account cannot keep drafts');
select tests.assert_denied($$select * from public.save_dashboard(tests.lay(), 0, tests.i('home-a'), null, 'mine')$$,
  'nor a personal Home view');
select tests.act_as_owner();
select tests.assert_true(
  not private.can_customize_dashboard(tests.user_id('carol'))
  and private.can_customize_dashboard(tests.user_id('alice')),
  'Customizing is for adults only, whatever path reaches it');
select tests.act_as_owner();
delete from public.child_profiles where user_id = tests.user_id('carol');

-- Privacy export -------------------------------------------------------------------------------------

select tests.act_as('carol');
select public.save_dashboard(tests.lay(array[tests.w(60)]), 0, null);
select public.save_dashboard(tests.lay(array[tests.w(61)]), 0, tests.i('home-a'), null, 'mine');
select public.save_dashboard_draft(tests.lay(array[tests.w(62)]), 1, tests.i('home-a'), 'mine');
select tests.act_as_owner();
insert into private.data_exports (id, requester_id, categories, all_data, scope_memberships, status)
  values (gen_random_uuid(), tests.user_id('carol'), array['account'], false,
    array[(select id from public.home_memberships
           where home_id = tests.i('home-a') and user_id = tests.user_id('carol'))], 'preparing');
insert into ids select 'export-carol', id from private.data_exports
  where requester_id = tests.user_id('carol');
select tests.act_as_service_role();
create temporary table export_out on commit drop as
  select public.collect_data_export(tests.i('export-carol'), 'account') -> 'files' f;
select tests.assert_true(
  (select jsonb_array_length(f -> 'account/dashboard_drafts') = 1
     and f -> 'account/dashboard_drafts' -> 0 ->> 'home' = 'Thuis'
     and jsonb_array_length(f -> 'account/dashboard_home_views') = 1
     and jsonb_array_length(f -> 'account/dashboard_history') = 2
     and f ? 'account/dashboard_layout' and f ? 'account/profile'
   from export_out),
  'The personal export holds her drafts, Home views and personal history next to the old files');
select tests.assert_true(
  (select not (f::text like '%' || tests.w(30)::text || '%') from export_out),
  'and nothing of the shared default or its history');

-- Account deletion cascades ---------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids values ('carol', tests.user_id('carol'));
delete from auth.users where id = tests.i('carol');
select tests.assert_true(
  not exists (select 1 from private.dashboard_drafts where user_id = tests.i('carol'))
  and not exists (select 1 from private.dashboard_member_overrides where user_id = tests.i('carol')),
  'Deleting an account deletes its drafts and views');
select tests.assert_true(
  (select count(*) = 0 from private.dashboard_layout_versions v
   left join private.dashboard_layouts d on d.id = v.layout_id
   where v.layout_id is not null and d.id is null),
  'and leaves no orphaned history');
select tests.assert_true(
  (select bool_and(saved_by is distinct from tests.i('carol')) from private.dashboard_layout_versions),
  'Shared history forgets the deleted author');
