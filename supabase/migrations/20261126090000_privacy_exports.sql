-- S39: personal and Home data exports and the optional guided privacy review.
--
-- Spec: Project-specification.md "Confirmed central privacy dashboard and optional guided review",
-- "Confirmed comprehensive, category-selective personal data exports", "Confirmed personal data
-- export", "Confirmed export preparation and ready notifications", "Confirmed export package
-- structure", "Confirmed generated export expiration" (12-13 October 2026).
--
-- An adult asks for All eligible data or chosen categories, optionally scoped to some of their
-- current Homes for their own contributions there. The request needs a fresh re-authentication
-- ('data_export'). A background job (privacy-export-build) collects each category through the
-- service-role functions below, which re-check the request every time, writes one ZIP to private
-- storage under a key the database chose, and marks it ready for 7 days. Downloading needs a fresh
-- re-authentication again and re-checks that nothing the export depended on changed; otherwise the
-- export is invalidated and its file removed. Nobody but the requester ever sees an export.
--
-- What a personal export contains: the requester's personally owned records (owner_user_id), their
-- own settings, and, for selected Homes, only their own contributions (their comments, check-ins,
-- submissions, entries, ratings). Home-owned records, other people's identities, credentials,
-- tokens, security secrets and audit internals are never included. Items in trash are left out.
--
-- Part 2 (spec "Confirmed Home data export permissions"): a Home export holds the Home-owned
-- records the requester may see now, module by module, and needs the separate Home permission
-- exportHomeData: the Owner always, and Administrators or Members the Owner granted it to. Personal
-- items shared into the Home are not Home-owned and stay out. The same pipeline, limits (per Home
-- and requester) and rechecks apply, plus: losing the permission or the Home ends the export.

-- Settings (values awaiting Ward's approval, plans/steps/S39-brief.md) ---------------------------

create function private.data_export_lifetime() returns interval
  language sql immutable set search_path = '' as $$ select interval '7 days' $$;

create function private.data_export_daily_limit() returns integer
  language sql immutable set search_path = '' as $$ select 3 $$;

-- The one in-app warning before an export expires.
create function private.data_export_warning_lead() returns interval
  language sql immutable set search_path = '' as $$ select interval '24 hours' $$;

-- A preparation that has not finished after this long failed (its job died or was dropped).
create function private.data_export_preparation_limit() returns interval
  language sql immutable set search_path = '' as $$ select interval '2 hours' $$;

-- Personal export categories, in the order the app shows them.
create function private.personal_export_categories() returns text[]
  language sql immutable set search_path = '' as $$
  select array['account', 'calendar', 'tasks', 'recipes', 'shopping', 'meals', 'habits_goals',
               'media', 'home_contributions']::text[];
  $$;

-- Home export categories, in the order the app shows them.
create function private.home_export_categories() returns text[]
  language sql immutable set search_path = '' as $$
  select array['home', 'tasks', 'chores', 'calendar', 'recipes', 'shopping', 'meals',
               'habits_goals', 'pets', 'photos', 'points']::text[];
  $$;

-- Home export permission (exportHomeData) ----------------------------------------------------------

-- Who the Owner allowed to export the Home's data. The Owner always may (no row). A grant belongs
-- to the membership: it ends with it and never reappears on a later re-join.
create table private.home_export_grants (
  home_id uuid not null,
  user_id uuid not null,
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz not null default now(),
  constraint home_export_grants_pkey primary key (home_id, user_id),
  constraint home_export_grants_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);

alter table private.home_export_grants enable row level security;
revoke all on table private.home_export_grants from public;

comment on table private.home_export_grants is
  'S39: Administrators or Members the Owner allowed to export Home data (exportHomeData). Via functions only.';

create function private.can_export_home(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null and exists (
    select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id = p_user_id
      and (m.role = 'owner' or exists (
        select 1 from private.home_export_grants g
        where g.home_id = m.home_id and g.user_id = m.user_id)));
  $$;

revoke all on function private.can_export_home(uuid, uuid) from public;

-- Re-authentication: one more action --------------------------------------------------------------

alter table private.account_change_grants drop constraint account_change_grants_action_check;
alter table private.account_change_grants
  add constraint account_change_grants_action_check check (action in (
    'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
    'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account',
    'data_export'
  ));

-- As S38, with one more action: 'data_export' (request and download a personal data export).
create or replace function public.authorize_account_change(p_action text, p_session_id uuid)
returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_expires_at timestamptz;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_action is null or p_action not in (
      'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
      'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account',
      'data_export'
    ) then
      raise exception 'unknown action' using errcode = '22023';
    end if;
    if not private.is_recent_reauthentication(v_user_id, v_session_id, p_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if p_session_id is null or p_session_id = v_session_id
       or not private.session_is_live(v_user_id, p_session_id) then
      raise exception 'unknown session' using errcode = '42501', hint = 'session_required';
    end if;
    if p_action = 'two_factor_enroll' and private.has_two_factor(v_user_id) then
      raise exception 'two-factor sign-in is already on' using errcode = '42501';
    end if;
    if p_action in ('two_factor_disable', 'recovery_codes')
       and not private.has_two_factor(v_user_id) then
      raise exception 'two-factor sign-in is off' using errcode = '42501';
    end if;

    perform private.lock_sign_in_methods(v_user_id);
    v_expires_at := pg_catalog.now() + private.account_change_grant_lifetime();
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (v_user_id, p_action, p_session_id, v_expires_at)
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at,
            created_at = pg_catalog.now();
    perform private.record_security_event(v_user_id, 'reauthenticated', v_session_id);
    return v_expires_at;
  end
  $$;

-- Object deletions: one more reason ---------------------------------------------------------------

alter table private.storage_object_deletions drop constraint storage_object_deletions_reason_check;
alter table private.storage_object_deletions
  add constraint storage_object_deletions_reason_check
    check (reason in ('processed', 'expired', 'failed', 'purged', 'owner_deleted', 'export'));

-- Exports -----------------------------------------------------------------------------------------

create table private.data_exports (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'personal' constraint data_exports_kind_check
    check (kind in ('personal', 'home')),
  -- The exported Home (kind 'home' only). Deleting the Home deletes the export and its file.
  home_id uuid references public.homes (id) on delete cascade,
  categories text[] not null constraint data_exports_categories_check
    check (cardinality(categories) between 1 and 20
           and categories <@ case kind when 'home' then private.home_export_categories()
                                       else private.personal_export_categories() end),
  -- Whether the person chose "All eligible data" (recorded in the manifest).
  all_data boolean not null,
  -- The selected Homes, as the membership rows at request time: a later departure (the row goes)
  -- or re-join (a new row) breaks the match, so the export is never served after access changed.
  scope_memberships uuid[] not null default '{}' constraint data_exports_scope_check
    check (cardinality(scope_memberships) <= 50),
  status text not null default 'queued' constraint data_exports_status_check
    check (status in ('queued', 'preparing', 'ready', 'failed', 'canceled', 'expired', 'invalidated')),
  -- Chosen by the database when preparation starts; never shown to anyone.
  object_key text constraint data_exports_key_check check (object_key ~ '^u/[0-9a-f]{64}$'),
  size_bytes bigint constraint data_exports_size_check check (size_bytes >= 0),
  -- What the archive holds (counts per category, exclusions, partial parts); no other people.
  summary jsonb constraint data_exports_summary_check
    check (summary is null or (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 16384)),
  partial boolean not null default false,
  failure_code text constraint data_exports_failure_check
    check (failure_code is null or failure_code ~ '^[a-z][a-z_]{0,47}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  generated_at timestamptz,
  expires_at timestamptz,
  warned_at timestamptz,
  ended_at timestamptz,
  downloaded_at timestamptz,
  -- When the sweep removed the archive once more after the export ended (see sweep_data_exports).
  cleanup_rechecked_at timestamptz,
  -- Home exports: private.home_export_access when preparation began, widened at finish.
  access_snapshot jsonb,
  constraint data_exports_home_check check ((kind = 'home') = (home_id is not null)),
  constraint data_exports_ready_check check (
    status <> 'ready' or (object_key is not null and generated_at is not null and expires_at is not null)
  )
);

create index data_exports_requester_idx on private.data_exports (requester_id, created_at desc);
create index data_exports_home_idx on private.data_exports (home_id, requester_id) where kind = 'home';
create index data_exports_open_idx on private.data_exports (status, expires_at)
  where status in ('queued', 'preparing', 'ready');
create index data_exports_recheck_idx on private.data_exports (ended_at)
  where object_key is not null and cleanup_rechecked_at is null
    and status in ('failed', 'canceled', 'expired', 'invalidated');

alter table private.data_exports enable row level security;
revoke all on table private.data_exports from public;

comment on table private.data_exports is
  'S39: personal data export requests and their archives. Read only via list_my_exports.';

-- An account's own deleted export leaves no object behind.
create function private.queue_export_object_on_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if old.object_key is not null then
      perform private.queue_object_deletion(old.object_key, 'export');
    end if;
    return null;
  end
  $$;

create trigger madeora_queue_export_object_on_delete
  after delete on private.data_exports
  for each row execute function private.queue_export_object_on_delete();

-- Ends an export that is not finished or still downloadable: its file (if any) is queued for removal.
create function private.end_data_export(p_export_id uuid, p_status text, p_code text default null)
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_key text;
  begin
    update private.data_exports e
      set status = p_status, ended_at = pg_catalog.now(),
          failure_code = coalesce(p_code, e.failure_code)
      where e.id = p_export_id and e.status in ('queued', 'preparing', 'ready')
        -- A queued export has collected nothing yet: data changes don't affect it.
        and (p_code is distinct from 'data_changed' or e.status <> 'queued')
      returning e.object_key into v_key;
    if not found then
      return false;
    end if;
    if v_key is not null then
      perform private.queue_object_deletion(v_key, 'export');
    end if;
    return true;
  end
  $$;

revoke all on function private.end_data_export(uuid, text, text) from public;

-- What a Home export's chosen categories let the requester see right now: the module gates held
-- and the ids of the item-level records (recipes, shopping lists, point accounts, redemptions)
-- visible to them. Only arrays, so "still sees at least what the export held" is jsonb containment.
create function private.home_export_access(p_home uuid, p_me uuid, p_categories text[])
returns jsonb
  language sql stable security definer set search_path = '' as $$
    select pg_catalog.jsonb_build_object(
      'gates', pg_catalog.to_jsonb(array_remove(array[
        case when 'chores' = any (p_categories) and private.can_review_chores(p_home, p_me)
             then 'chore_review' end,
        case when 'calendar' = any (p_categories)
               and private.calendar_level_allows(private.calendar_level(p_home, p_me), 'view')
             then 'calendar' end,
        case when 'meals' = any (p_categories) and private.meal_access(p_home, p_me) is not null
             then 'meals' end,
        case when 'habits_goals' = any (p_categories) and private.habit_access(p_home, p_me) is not null
             then 'habits' end,
        case when 'habits_goals' = any (p_categories) and private.goal_access(p_home, p_me) is not null
             then 'goals' end,
        case when 'pets' = any (p_categories) and private.pet_access(p_home, p_me) is not null
             then 'pets' end,
        case when 'pets' = any (p_categories) and private.pet_medical_can_view(p_home, p_me)
             then 'pet_medical' end,
        case when 'photos' = any (p_categories) and private.photo_access(p_home, p_me) is not null
             then 'photos' end,
        case when 'points' = any (p_categories) and private.can_manage_rewards(p_home, p_me)
             then 'rewards_manage' end
      ], null)),
      'recipes', (select coalesce(pg_catalog.jsonb_agg(r.id), '[]') from private.recipes r
                  where 'recipes' = any (p_categories) and r.owner_home_id = p_home
                    and private.can_see_recipe(r, p_me)),
      'lists', (select coalesce(pg_catalog.jsonb_agg(l.id), '[]') from private.shopping_lists l
                where 'shopping' = any (p_categories) and l.owner_home_id = p_home
                  and private.shopping_access(l, p_me) is not null),
      'accounts', (select coalesce(pg_catalog.jsonb_agg(a.id), '[]') from private.point_accounts a
                   where 'points' = any (p_categories) and a.home_id = p_home
                     and private.can_view_point_account(a, p_me)),
      'redemptions', (select coalesce(pg_catalog.jsonb_agg(x.id), '[]')
                      from private.reward_redemptions x
                      where 'points' = any (p_categories) and x.home_id = p_home
                        and private.can_see_redemption(x, p_me)))
  $$;

revoke all on function private.home_export_access(uuid, uuid, text[]) from public;

-- Whether everything the export depended on still holds: the account is active, every selected
-- Home membership is the same row as at request time and, for a Home export, the requester may
-- still export that Home and still has the module and record access the export was built with.
create function private.data_export_intact(p_export private.data_exports) returns boolean
  language sql stable security definer set search_path = '' as $$
    select not private.is_deactivated(p_export.requester_id)
      and pg_catalog.cardinality(p_export.scope_memberships) = (
        select pg_catalog.count(*) from public.home_memberships m
        where m.id = any (p_export.scope_memberships) and m.user_id = p_export.requester_id
      )
      and (p_export.kind = 'personal' or private.can_export_home(p_export.home_id, p_export.requester_id))
      -- A Home export also needs the module and record access it was built with (PS: export
      -- permission and underlying data access at generation and download time).
      and (p_export.kind = 'personal' or p_export.access_snapshot is null
           or private.home_export_access(p_export.home_id, p_export.requester_id, p_export.categories)
                @> p_export.access_snapshot)
  $$;

revoke all on function private.data_export_intact(private.data_exports) from public;

-- The Homes in scope right now (only while the export is intact).
create function private.data_export_homes(p_export private.data_exports) returns uuid[]
  language sql stable security definer set search_path = '' as $$
    select coalesce(pg_catalog.array_agg(m.home_id), '{}') from public.home_memberships m
    where m.id = any (p_export.scope_memberships) and m.user_id = p_export.requester_id
  $$;

revoke all on function private.data_export_homes(private.data_exports) from public;

-- Invalidation: leaving or being removed from a Home in scope, deactivation, and moving one's own
-- items to trash end every unfinished or downloadable export they affect.
create function private.invalidate_exports_on_membership_end() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    for v_id in
      select e.id from private.data_exports e
      where e.requester_id = old.user_id and old.id = any (e.scope_memberships)
        and e.status in ('queued', 'preparing', 'ready')
    loop
      perform private.end_data_export(v_id, 'invalidated', 'access_changed');
    end loop;
    -- A Home export names the Home's members: anyone leaving makes it out of date.
    for v_id in
      select e.id from private.data_exports e
      where e.kind = 'home' and e.home_id = old.home_id and e.status in ('queued', 'preparing', 'ready')
    loop
      perform private.end_data_export(v_id, 'invalidated', 'data_changed');
    end loop;
    return null;
  end
  $$;

create trigger madeora_invalidate_exports_on_membership_end
  after delete on public.home_memberships
  for each row execute function private.invalidate_exports_on_membership_end();

-- Losing exportHomeData (a revoked grant, or no longer the Owner) ends that person's Home exports.
create function private.invalidate_home_exports_on_permission_loss() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    if tg_op = 'UPDATE' then
      if new.role = 'owner' then
        -- The Owner may always export; an older grant must not come back on a later demotion.
        delete from private.home_export_grants g
          where g.home_id = new.home_id and g.user_id = new.user_id;
      end if;
    end if;
    if private.can_export_home(old.home_id, old.user_id) then
      return null;
    end if;
    for v_id in
      select e.id from private.data_exports e
      where e.kind = 'home' and e.home_id = old.home_id and e.requester_id = old.user_id
        and e.status in ('queued', 'preparing', 'ready')
    loop
      perform private.end_data_export(v_id, 'invalidated', 'access_changed');
    end loop;
    return null;
  end
  $$;

create trigger madeora_invalidate_home_exports_on_revoke
  after delete on private.home_export_grants
  for each row execute function private.invalidate_home_exports_on_permission_loss();

create trigger madeora_invalidate_home_exports_on_role_change
  after update of role on public.home_memberships
  for each row when (old.role is distinct from new.role)
  execute function private.invalidate_home_exports_on_permission_loss();

create function private.invalidate_exports_of_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_user uuid;
  begin
    if tg_table_name = 'trash_entries' then
      v_user := new.owner_user_id;
      if v_user is null and new.owner_home_id is not null then
        -- A Home item moved to trash leaves that Home's exports and takes the contributions made
        -- to it out of every personal export that holds contributions in that Home.
        for v_id in
          select e.id from private.data_exports e
          where e.status in ('queued', 'preparing', 'ready')
            and ((e.kind = 'home' and e.home_id = new.owner_home_id)
              or (e.kind = 'personal' and 'home_contributions' = any (e.categories)
                  and new.owner_home_id = any (private.data_export_homes(e))))
        loop
          perform private.end_data_export(v_id, 'invalidated', 'data_changed');
        end loop;
        return null;
      end if;
    else
      v_user := new.user_id;
    end if;
    if v_user is null then
      return null;
    end if;
    for v_id in
      select e.id from private.data_exports e
      where e.requester_id = v_user and e.status in ('queued', 'preparing', 'ready')
    loop
      perform private.end_data_export(
        v_id, 'invalidated',
        case tg_table_name when 'trash_entries' then 'data_changed' else 'account_deactivated' end);
    end loop;
    return null;
  end
  $$;

create trigger madeora_invalidate_exports_on_deactivation
  after insert on private.account_deactivations
  for each row execute function private.invalidate_exports_of_user();

create trigger madeora_invalidate_exports_on_trash
  after insert on private.trash_entries
  for each row execute function private.invalidate_exports_of_user();

-- Data deleted outright (not through trash) ends the exports it was in: the personal exports of the
-- person it belonged to and the exports of the Home that owned it. The trigger arguments name the
-- row's person column ('' for none) and, for rows that belong to someone through their parent, the
-- parent table, foreign key and parent person column. Edits that rewrite a record's own parts
-- (recipe ingredients and steps, habit schedules, task labels) are not deletions of data.
create function private.invalidate_exports_on_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_row jsonb := pg_catalog.to_jsonb(old);
    v_parent jsonb;
    v_user uuid;
    v_home uuid;
  begin
    if tg_argv[1] <> '' then
      -- Identifiers come from the trigger definitions below, never from data.
      execute pg_catalog.format('select pg_catalog.to_jsonb(p) from private.%I p where p.id = $1', tg_argv[1])
        into v_parent using (v_row ->> tg_argv[2])::uuid;
    end if;
    v_user := coalesce(
      case when tg_argv[0] <> '' then (v_row ->> tg_argv[0])::uuid end,
      case when tg_argv[3] <> '' then (v_parent ->> tg_argv[3])::uuid end);
    v_home := coalesce((v_row ->> 'owner_home_id')::uuid, (v_row ->> 'home_id')::uuid,
                       (v_parent ->> 'owner_home_id')::uuid, (v_parent ->> 'home_id')::uuid);
    for v_id in
      select e.id from private.data_exports e
      where e.status in ('queued', 'preparing', 'ready')
        and ((v_user is not null and e.kind = 'personal' and e.requester_id = v_user)
          or (v_home is not null and e.kind = 'home' and e.home_id = v_home))
    loop
      perform private.end_data_export(v_id, 'invalidated', 'data_changed');
    end loop;
    return null;
  end
  $$;

revoke all on function private.invalidate_exports_on_delete() from public;

do $$
  declare
    v_spec text[];
  begin
    -- table, person column, parent table, foreign key, parent person column
    foreach v_spec slice 1 in array array[
      ['task_comments', 'author_id', 'tasks', 'task_id', 'owner_user_id'],
      ['habit_checkins', 'completed_by', 'habits', 'habit_id', 'owner_user_id'],
      ['habit_contributions', 'contributed_by', 'habits', 'habit_id', 'owner_user_id'],
      ['goal_entries', 'contributed_by', 'goals', 'goal_id', 'owner_user_id'],
      ['recipe_ratings', 'user_id', 'recipes', 'recipe_id', 'owner_user_id'],
      ['recipe_favorites', 'user_id', '', '', ''],
      ['personal_point_entries', 'user_id', '', '', ''],
      ['personal_rewards', 'user_id', '', '', ''],
      ['personal_reward_redemptions', 'user_id', '', '', ''],
      ['chore_submissions', 'contributor_id', '', '', ''],
      ['calendar_events', 'owner_user_id', '', '', ''],
      ['task_lists', 'owner_user_id', '', '', ''],
      ['tasks', 'owner_user_id', '', '', ''],
      ['task_series', 'owner_user_id', '', '', ''],
      ['recipes', 'owner_user_id', '', '', ''],
      ['shopping_lists', 'owner_user_id', '', '', ''],
      ['meal_slots', 'owner_user_id', '', '', ''],
      ['meal_entries', 'owner_user_id', '', '', ''],
      ['habits', 'owner_user_id', '', '', ''],
      ['goals', 'owner_user_id', '', '', ''],
      ['goal_series', 'owner_user_id', '', '', ''],
      ['photos', 'owner_user_id', '', '', ''],
      ['photo_albums', 'owner_user_id', '', '', ''],
      ['calendar_event_exceptions', '', 'calendar_events', 'event_id', 'owner_user_id'],
      ['subtasks', '', 'tasks', 'task_id', 'owner_user_id'],
      ['task_attachments', '', 'tasks', 'task_id', 'owner_user_id'],
      ['shopping_items', '', 'shopping_lists', 'list_id', 'owner_user_id'],
      ['shopping_categories', '', 'shopping_lists', 'list_id', 'owner_user_id'],
      ['meal_recurrences', '', 'meal_slots', 'slot_id', 'owner_user_id'],
      ['habit_day_notes', '', 'habits', 'habit_id', 'owner_user_id'],
      ['photo_album_items', '', 'photo_albums', 'album_id', 'owner_user_id'],
      ['point_entries', '', 'point_accounts', 'account_id', 'user_id'],
      ['reward_redemptions', '', 'point_accounts', 'account_id', 'user_id'],
      ['chores', '', '', '', ''],
      ['chore_occurrences', '', '', '', ''],
      ['chore_categories', '', '', '', ''],
      ['rewards', '', '', '', ''],
      ['pets', '', '', '', ''],
      ['pet_medical_entries', '', 'pets', 'pet_id', '']
    ] loop
      execute pg_catalog.format(
        'create trigger madeora_invalidate_exports_on_delete after delete on private.%I '
        'for each row execute function private.invalidate_exports_on_delete(%L, %L, %L, %L)',
        v_spec[1], v_spec[2], v_spec[3], v_spec[4], v_spec[5]);
    end loop;
  end
$$;

-- Requesting -------------------------------------------------------------------------------------

-- Asks for a personal export of the caller's own data: p_all ("All eligible data") or the chosen
-- p_categories, and exactly the Homes in p_home_ids (only Homes the caller is a member of now; empty:
-- none). Needs this session's fresh 'data_export' permission. 3 requests a day, and one being
-- prepared at a time.
create function public.request_personal_export(p_all boolean, p_categories text[], p_home_ids uuid[])
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_all boolean := coalesce(p_all, false);
    v_categories text[];
    v_scope uuid[];
    v_id uuid;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if not private.has_account_change_grant(v_user_id, 'data_export', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if v_all then
      v_categories := private.personal_export_categories();
    else
      select pg_catalog.array_agg(c order by pg_catalog.array_position(private.personal_export_categories(), c))
        into v_categories
        from (select distinct pg_catalog.unnest(p_categories) as c) s;
      if v_categories is null or not (v_categories <@ private.personal_export_categories()) then
        raise exception 'unknown or empty categories' using errcode = '22023', hint = 'categories';
      end if;
    end if;
    if p_home_ids is null or pg_catalog.cardinality(p_home_ids) > 50 then
      raise exception 'too many Homes' using errcode = '22023', hint = 'homes';
    end if;

    -- Only the caller's current memberships; an unknown Home is refused like a foreign one, so the
    -- answer reveals nothing about Homes the caller is not in.
    select coalesce(pg_catalog.array_agg(m.id), '{}') into v_scope
      from public.home_memberships m
      where m.user_id = v_user_id and m.home_id = any (p_home_ids);
    if pg_catalog.cardinality(v_scope) <> (select pg_catalog.count(distinct h) from pg_catalog.unnest(p_home_ids) h) then
      raise exception 'unknown Home' using errcode = '22023', hint = 'homes';
    end if;
    -- Chosen explicitly, contributions need a Home; with All eligible data they are simply empty.
    if 'home_contributions' = any (v_categories) and pg_catalog.cardinality(v_scope) = 0 and not v_all then
      raise exception 'contributions need a Home' using errcode = '22023', hint = 'homes';
    end if;

    -- One request at a time per account, so the limits below cannot be raced.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('data_export:' || v_user_id::text, 0));
    if exists (
      select 1 from private.data_exports e
      where e.requester_id = v_user_id and e.kind = 'personal' and e.status in ('queued', 'preparing')
    ) then
      raise exception 'an export is being prepared' using errcode = '54000', hint = 'in_progress';
    end if;
    if (select pg_catalog.count(*) from private.data_exports e
        where e.requester_id = v_user_id and e.kind = 'personal'
          and e.created_at > pg_catalog.now() - interval '24 hours')
       >= private.data_export_daily_limit() then
      raise exception 'too many exports' using errcode = '54000', hint = 'daily_limit';
    end if;

    insert into private.data_exports (requester_id, categories, all_data, scope_memberships)
      values (v_user_id, v_categories, v_all, v_scope)
      returning id into v_id;
    perform private.enqueue_job(
      'privacy-export-build', 1, 'privacy-export:' || v_id::text,
      pg_catalog.jsonb_build_object('exportId', v_id), private.request_correlation_id());
    perform private.record_account_activity(v_user_id, 'privacy', 'data_export_requested', 'pending');
    return v_id;
  end
  $$;

revoke all on function public.request_personal_export(boolean, text[], uuid[]) from public, anon;
grant execute on function public.request_personal_export(boolean, text[], uuid[]) to authenticated;

-- Asks for an export of one Home's data: p_all (every Home category) or the chosen p_categories.
-- Needs the Home permission exportHomeData (the Owner, or a granted Administrator or Member) and
-- this session's fresh 'data_export' permission. 3 requests a day and one being prepared at a time,
-- per Home and requester. A Home the caller is not in is refused like one that does not exist.
create function public.request_home_export(p_home_id uuid, p_all boolean, p_categories text[])
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_all boolean := coalesce(p_all, false);
    v_categories text[];
    v_membership uuid;
    v_id uuid;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    select m.id into v_membership from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_user_id;
    if v_membership is null then
      raise exception 'unknown Home' using errcode = '42501', hint = 'homes';
    end if;
    if not private.can_export_home(p_home_id, v_user_id) then
      raise exception 'not permitted to export this Home' using errcode = '42501', hint = 'not_permitted';
    end if;
    if not private.has_account_change_grant(v_user_id, 'data_export', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if v_all then
      v_categories := private.home_export_categories();
    else
      select pg_catalog.array_agg(c order by pg_catalog.array_position(private.home_export_categories(), c))
        into v_categories
        from (select distinct pg_catalog.unnest(p_categories) as c) s;
      if v_categories is null or not (v_categories <@ private.home_export_categories()) then
        raise exception 'unknown or empty categories' using errcode = '22023', hint = 'categories';
      end if;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('data_export:' || v_user_id::text, 0));
    if exists (
      select 1 from private.data_exports e
      where e.requester_id = v_user_id and e.kind = 'home' and e.home_id = p_home_id
        and e.status in ('queued', 'preparing')
    ) then
      raise exception 'an export is being prepared' using errcode = '54000', hint = 'in_progress';
    end if;
    if (select pg_catalog.count(*) from private.data_exports e
        where e.requester_id = v_user_id and e.kind = 'home' and e.home_id = p_home_id
          and e.created_at > pg_catalog.now() - interval '24 hours'
          -- Home exports voided by another member's change don't use up the person's requests.
          and not (e.status = 'invalidated' and e.failure_code = 'data_changed'))
       >= private.data_export_daily_limit() then
      raise exception 'too many exports' using errcode = '54000', hint = 'daily_limit';
    end if;

    insert into private.data_exports (requester_id, kind, home_id, categories, all_data, scope_memberships)
      values (v_user_id, 'home', p_home_id, v_categories, v_all, array[v_membership])
      returning id into v_id;
    perform private.enqueue_job(
      'privacy-export-build', 1, 'privacy-export:' || v_id::text,
      pg_catalog.jsonb_build_object('exportId', v_id), private.request_correlation_id());
    perform private.record_account_activity(v_user_id, 'privacy', 'data_export_requested', 'pending');
    perform private.audit('home.export.requested', p_home_id, 'home', p_home_id,
      pg_catalog.jsonb_build_object('categories', v_categories));
    return v_id;
  end
  $$;

revoke all on function public.request_home_export(uuid, boolean, text[]) from public, anon;
grant execute on function public.request_home_export(uuid, boolean, text[]) to authenticated;

-- Who may export a Home's data: every member for the Owner (who grants it), only the caller's own
-- answer otherwise. 42501 for a Home the caller is not in.
create function public.list_home_export_access(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner boolean;
  begin
    if not private.is_home_member(p_home_id, v_user_id) then
      raise exception 'not a member' using errcode = '42501';
    end if;
    v_owner := exists (select 1 from public.home_memberships m
                       where m.home_id = p_home_id and m.user_id = v_user_id and m.role = 'owner');
    return pg_catalog.jsonb_build_object(
      'canGrant', v_owner,
      'canExport', private.can_export_home(p_home_id, v_user_id),
      'members', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'membershipId', m.id,
            'isSelf', m.user_id = v_user_id,
            'role', m.role,
            'granted', private.can_export_home(p_home_id, m.user_id),
            'canChange', v_owner and m.role <> 'owner')
          order by m.created_at, m.id)
        from public.home_memberships m
        where m.home_id = p_home_id and (v_owner or m.user_id = v_user_id)), '[]'::jsonb));
  end
  $$;

revoke all on function public.list_home_export_access(uuid) from public, anon;
grant execute on function public.list_home_export_access(uuid) to authenticated;

-- The Owner grants or revokes exportHomeData for an Administrator or Member. Works at once (a
-- revoke ends that person's Home exports) and is audited. Outcomes: 'ok', 'unchanged',
-- 'not_found', 'not_permitted'. 42501 for a Home the caller is not in.
create function public.set_home_export_access(p_home_id uuid, p_membership_id uuid, p_granted boolean)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_before boolean;
  begin
    if p_membership_id is null or p_granted is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.is_home_member(p_home_id, v_user_id) then
      raise exception 'not a member' using errcode = '42501';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if not exists (select 1 from public.home_memberships m
                   where m.home_id = p_home_id and m.user_id = v_user_id and m.role = 'owner') then
      return 'not_permitted';
    end if;
    select * into v_target from public.home_memberships m where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    if v_target.role = 'owner' then
      return 'not_permitted';
    end if;
    v_before := private.can_export_home(p_home_id, v_target.user_id);
    if v_before = p_granted then
      return 'unchanged';
    end if;
    if p_granted then
      insert into private.home_export_grants (home_id, user_id, granted_by)
        values (p_home_id, v_target.user_id, v_user_id);
    else
      delete from private.home_export_grants g where g.home_id = p_home_id and g.user_id = v_target.user_id;
    end if;
    perform private.audit('home.export_access.changed', p_home_id, 'user', v_target.user_id,
      pg_catalog.jsonb_build_object('granted', p_granted));
    return 'ok';
  end
  $$;

revoke all on function public.set_home_export_access(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_home_export_access(uuid, uuid, boolean) to authenticated;

-- The caller's own exports, newest first. A Home in the scope is named only while the caller is
-- still its member; an export never reveals more than its own requester already knows.
create function public.list_my_exports()
returns table (
  id uuid, kind text, status text, categories text[], all_data boolean, home_ids uuid[],
  home_count integer, partial boolean, size_bytes bigint, summary jsonb, failure_code text,
  created_at timestamptz, generated_at timestamptz, expires_at timestamptz,
  downloaded_at timestamptz
)
  language sql stable security definer set search_path = '' as $$
    select e.id, e.kind,
           case when e.status = 'ready' and e.expires_at <= pg_catalog.now() then 'expired'
                else e.status end,
           e.categories, e.all_data,
           (select coalesce(pg_catalog.array_agg(m.home_id), '{}') from public.home_memberships m
             where m.id = any (e.scope_memberships) and m.user_id = e.requester_id),
           pg_catalog.cardinality(e.scope_memberships),
           e.partial,
           case when e.status = 'ready' then e.size_bytes end,
           case when e.status = 'ready' then e.summary end,
           e.failure_code, e.created_at, e.generated_at, e.expires_at, e.downloaded_at
    from (
      -- The 20 newest of each list: personal exports, and each Home's exports.
      select x.*, pg_catalog.row_number() over (
               partition by x.kind, x.home_id order by x.created_at desc) as rank
      from private.data_exports x
      where x.requester_id = auth.uid()
    ) e
    where e.rank <= 20
    order by e.created_at desc
  $$;

revoke all on function public.list_my_exports() from public, anon;
grant execute on function public.list_my_exports() to authenticated;

-- Cancels a queued or preparing export, or deletes a ready one before it expires.
create function public.cancel_my_export(p_export_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if not exists (select 1 from private.data_exports e
                   where e.id = p_export_id and e.requester_id = v_user_id) then
      raise exception 'no such export' using errcode = 'P0002';
    end if;
    if private.end_data_export(p_export_id, 'canceled') then
      perform private.record_account_activity(v_user_id, 'privacy', 'data_export_canceled', 'cancelled');
      perform private.audit('home.export.canceled', e.home_id, 'home', e.home_id)
        from private.data_exports e where e.id = p_export_id and e.kind = 'home';
      return true;
    end if;
    return false;
  end
  $$;

revoke all on function public.cancel_my_export(uuid) from public, anon;
grant execute on function public.cancel_my_export(uuid) to authenticated;

-- Downloading: the caller's own ready, unexpired export, from a live session with a fresh
-- 'data_export' permission, and only while everything it depended on still holds. Otherwise the
-- export is invalidated (its file removed) and 'export_invalidated' tells the app to offer a fresh
-- one. Returns the object key for the web server to sign a short GET link; never to a browser.
create function public.authorize_export_download(p_export_id uuid)
returns table (object_key text, generated_at timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_export private.data_exports;
  begin
    if v_user_id is null or v_session_id is null
       or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    select * into v_export from private.data_exports e
      where e.id = p_export_id and e.requester_id = v_user_id
      for update;
    if not found or v_export.status <> 'ready' then
      raise exception 'no such export' using errcode = 'P0002';
    end if;
    if v_export.expires_at <= pg_catalog.now() then
      -- The hourly sweep ends it and removes the file.
      raise exception 'export expired' using errcode = 'P0002', hint = 'export_expired';
    end if;
    if not private.has_account_change_grant(v_user_id, 'data_export', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if not private.data_export_intact(v_export) then
      perform private.end_data_export(v_export.id, 'invalidated', 'access_changed');
      -- The invalidation must stick although the caller gets an error: report it as a result.
      return query select null::text, null::timestamptz;
      return;
    end if;
    update private.data_exports e set downloaded_at = pg_catalog.now() where e.id = v_export.id;
    perform private.record_account_activity(v_user_id, 'privacy', 'data_export_downloaded', 'completed');
    if v_export.kind = 'home' then
      perform private.audit('home.export.downloaded', v_export.home_id, 'home', v_export.home_id);
    end if;
    return query select v_export.object_key, v_export.generated_at;
  end
  $$;

revoke all on function public.authorize_export_download(uuid) from public, anon;
grant execute on function public.authorize_export_download(uuid) to authenticated;

-- Collectors (service role, through the build job) ------------------------------------------------

-- Another person never appears by identity: 'you' for the requester, 'someone_else' otherwise.
create function private.export_person(p_id uuid, p_me uuid) returns text
  language sql immutable set search_path = '' as $$
  select case when p_id is null then null when p_id = p_me then 'you' else 'someone_else' end;
  $$;

-- A ready stored file as an archive attachment: where it goes in the ZIP and what to fetch.
create function private.export_media(p_file_id uuid, p_folder text) returns jsonb
  language sql stable security definer set search_path = '' as $$
    select pg_catalog.jsonb_build_object(
      'fileId', f.id,
      'path', p_folder || '/' || f.id::text || case f.content_type
        when 'image/webp' then '.webp' when 'image/jpeg' then '.jpg' when 'image/png' then '.png'
        when 'image/gif' then '.gif' when 'image/heic' then '.heic' when 'application/pdf' then '.pdf'
        when 'text/plain' then '.txt' else '.bin' end,
      'objectKey', f.object_key,
      'size', f.size_bytes,
      'contentType', f.content_type)
    from private.stored_files f
    where f.id = p_file_id and f.status = 'ready' and f.object_key is not null
  $$;

revoke all on function private.export_media(uuid, text) from public;

-- The rows of one category for one export: {"files": {"folder/name": [rows]}, "media": [...]}.
create function private.collect_personal_category(p_me uuid, p_homes uuid[], p_category text)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_files jsonb := '{}'::jsonb;
    v_media jsonb := '[]'::jsonb;
  begin
    if p_category = 'account' then
      v_files := pg_catalog.jsonb_build_object(
        'account/profile', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'email', u.email, 'display_name', p.display_name, 'locale', p.locale,
            'date_format', p.date_format, 'time_format', p.time_format, 'week_start', p.week_start,
            'number_format', p.number_format, 'measurement_system', p.measurement_system,
            'timezone', p.timezone, 'accent_color', p.accent_color,
            'avatar_file', p.avatar_file_id, 'account_created_at', u.created_at,
            'updated_at', p.updated_at)), '[]')
          from auth.users u left join public.user_preferences p on p.user_id = u.id
          where u.id = p_me),
        'account/home_profiles', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home', h.name, 'role', m.role, 'joined_at', m.created_at,
            'nickname', hp.nickname, 'display_name', hp.display_name,
            'accent_color', hp.accent_color, 'avatar_file', hp.avatar_file_id)
            order by h.name), '[]')
          from public.home_memberships m
          join public.homes h on h.id = m.home_id
          left join public.home_member_profiles hp on hp.home_id = m.home_id and hp.user_id = m.user_id
          where m.user_id = p_me and m.home_id = any (p_homes)),
        'account/notification_preferences', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home', h.name, 'category', n.category, 'channel', n.channel, 'enabled', n.enabled,
            'updated_at', n.updated_at) order by h.name nulls first, n.category, n.channel), '[]')
          from public.notification_preferences n left join public.homes h on h.id = n.home_id
          where n.user_id = p_me and (n.home_id is null or n.home_id = any (p_homes))),
        'account/quiet_hours', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home', h.name, 'enabled', q.enabled, 'start_time', q.start_time,
            'end_time', q.end_time, 'time_zone', q.time_zone, 'updated_at', q.updated_at)), '[]')
          from public.notification_quiet_hours q left join public.homes h on h.id = q.home_id
          where q.user_id = p_me and (q.home_id is null or q.home_id = any (p_homes))),
        'account/home_preferences', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home', h.name,
            'calendar_show_vacations', c.show_vacations, 'calendar_show_tasks', c.show_tasks,
            'calendar_show_chores', c.show_chores,
            'points_participate', pp.participates, 'points_target', pp.target,
            'points_target_paused', pp.target_paused, 'points_share_target', pp.share_target)
            order by h.name), '[]')
          from public.homes h
          left join private.calendar_view_preferences c on c.home_id = h.id and c.user_id = p_me
          left join private.point_preferences pp on pp.home_id = h.id and pp.user_id = p_me
          where h.id = any (p_homes) and (c.user_id is not null or pp.user_id is not null)),
        'account/privacy_review', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', r.step, 'started_at', r.started_at, 'completed_at', r.completed_at)), '[]')
          from private.privacy_reviews r where r.user_id = p_me));
      v_files := v_files || pg_catalog.jsonb_build_object(
        'account/security_alerts', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'new_device', a.new_device, 'every_sign_in', a.every_sign_in,
            'updated_at', a.updated_at)), '[]')
          from private.security_alert_preferences a where a.user_id = p_me),
        'account/habit_settings', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'celebrations', x.celebrations, 'updated_at', x.updated_at)), '[]')
          from private.habit_user_settings x where x.user_id = p_me),
        'account/dashboard_layout', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'layout', d.layout, 'updated_at', d.updated_at)), '[]')
          from private.dashboard_layouts d where d.owner_user_id = p_me),
        -- The in-app inbox: what kind of notice and when; its details can name other people, so
        -- they stay out (listed in the README).
        'account/notifications', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home', h.name, 'category', n.category, 'kind', n.kind, 'created_at', n.created_at,
            'read_at', n.read_at) order by n.created_at, n.id), '[]')
          from public.notifications n left join public.homes h on h.id = n.home_id
          where n.user_id = p_me and (n.home_id is null or n.home_id = any (p_homes))),
        'account/reminder_opt_outs', (
          select coalesce(pg_catalog.jsonb_agg(o.r order by o.at), '[]') from (
            select pg_catalog.jsonb_build_object(
                     'habit_id', x.habit_id, 'created_at', x.created_at) r, x.created_at at
            from private.habit_reminder_optouts x join private.habits h on h.id = x.habit_id
            where x.user_id = p_me and h.deleted_at is null
              and (h.owner_user_id = p_me or h.owner_home_id = any (p_homes))
            union all
            select pg_catalog.jsonb_build_object(
                     'goal_id', x.goal_id, 'created_at', x.created_at), x.created_at
            from private.goal_reminder_optouts x join private.goals g on g.id = x.goal_id
            where x.user_id = p_me and g.deleted_at is null
              and (g.owner_user_id = p_me or g.owner_home_id = any (p_homes))) o));
      select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
        select private.export_media(p.avatar_file_id, 'account/avatars') m
        from public.user_preferences p where p.user_id = p_me and p.avatar_file_id is not null
        union all
        select private.export_media(hp.avatar_file_id, 'account/avatars')
        from public.home_member_profiles hp
        where hp.user_id = p_me and hp.home_id = any (p_homes) and hp.avatar_file_id is not null
      ) s where m is not null;

    elsif p_category = 'calendar' then
      v_files := pg_catalog.jsonb_build_object(
        'calendar/events', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', e.id, 'title', e.title, 'location', e.location, 'description', e.description,
            'all_day', e.all_day, 'starts_on', e.starts_on, 'ends_on', e.ends_on,
            'start_time', e.start_time, 'end_time', e.end_time, 'timezone', e.timezone,
            'frequency', e.frequency, 'interval_count', e.interval_count, 'weekdays', e.weekdays,
            'repeat_ends_on', e.repeat_ends_on, 'max_count', e.max_count, 'until_date', e.until_date,
            'reminder_minutes', e.reminder_minutes, 'created_at', e.created_at,
            'updated_at', e.updated_at) order by e.starts_on, e.id), '[]')
          from private.calendar_events e
          where e.owner_user_id = p_me and e.deleted_at is null),
        'calendar/event_changes', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'event_id', x.event_id, 'original_date', x.original_date, 'cancelled', x.cancelled,
            'title', x.title, 'location', x.location, 'description', x.description,
            'all_day', x.all_day, 'starts_on', x.starts_on, 'ends_on', x.ends_on,
            'start_time', x.start_time, 'end_time', x.end_time, 'updated_at', x.updated_at)
            order by x.event_id, x.original_date), '[]')
          from private.calendar_event_exceptions x
          join private.calendar_events e on e.id = x.event_id
          where e.owner_user_id = p_me and e.deleted_at is null));

    elsif p_category = 'tasks' then
      v_files := pg_catalog.jsonb_build_object(
        'tasks/lists', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', l.id, 'name', l.name, 'position', l.position, 'archived_at', l.archived_at,
            'created_at', l.created_at, 'updated_at', l.updated_at) order by l.position, l.id), '[]')
          from private.task_lists l where l.owner_user_id = p_me and l.deleted_at is null),
        'tasks/tasks', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', t.id, 'list_id', t.list_id, 'title', t.title, 'description', t.description,
            'start_date', t.start_date, 'due_date', t.due_date, 'priority', t.priority,
            'completed_at', t.completed_at, 'series_id', t.series_id,
            'occurrence_date', t.occurrence_date,
            'labels', (select coalesce(pg_catalog.jsonb_agg(lb.name order by lb.name), '[]')
                       from private.task_label_links ll join private.task_labels lb on lb.id = ll.label_id
                       where ll.task_id = t.id),
            'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]')
          from private.tasks t where t.owner_user_id = p_me and t.deleted_at is null),
        'tasks/subtasks', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'task_id', s.task_id, 'title', s.title, 'position', s.position,
            'completed_at', s.completed_at, 'created_at', s.created_at)
            order by s.task_id, s.position), '[]')
          from private.subtasks s join private.tasks t on t.id = s.task_id
          where t.owner_user_id = p_me and t.deleted_at is null),
        'tasks/comments', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'task_id', c.task_id, 'author', private.export_person(c.author_id, p_me),
            'body', c.body, 'created_at', c.created_at, 'edited_at', c.edited_at)
            order by c.created_at, c.id), '[]')
          from private.task_comments c join private.tasks t on t.id = c.task_id
          where t.owner_user_id = p_me and t.deleted_at is null),
        'tasks/recurring', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', s.id, 'list_id', s.list_id, 'title', s.title, 'description', s.description,
            'priority', s.priority, 'frequency', s.frequency, 'interval_count', s.interval_count,
            'weekdays', s.weekdays, 'starts_on', s.starts_on, 'ends_on', s.ends_on,
            'max_count', s.max_count, 'until_date', s.until_date, 'paused_at', s.paused_at,
            'created_at', s.created_at) order by s.created_at, s.id), '[]')
          from private.task_series s
          where s.owner_user_id = p_me and s.deleted_at is null and s.superseded_at is null),
        'tasks/attachments', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'task_id', a.task_id, 'name', a.display_name, 'file', a.file_id, 'added_at', a.added_at)
            order by a.added_at, a.id), '[]')
          from private.task_attachments a join private.tasks t on t.id = a.task_id
          where t.owner_user_id = p_me and t.deleted_at is null and a.removed_at is null));
      v_files := v_files || pg_catalog.jsonb_build_object(
        'tasks/templates', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', x.id, 'name', x.name, 'title', x.title, 'description', x.description,
            'priority', x.priority, 'labels', x.label_ids, 'subtasks', x.subtasks,
            'created_at', x.created_at, 'updated_at', x.updated_at) order by x.created_at, x.id), '[]')
          from private.task_templates x where x.owner_user_id = p_me),
        'tasks/recurring_attachments', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'recurring_task', a.root_id, 'file', a.file_id, 'name', a.display_name,
            'added_at', a.added_at) order by a.added_at, a.id), '[]')
          from private.task_series_attachments a
          where a.owner_user_id = p_me and a.removed_at is null));
      select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
        select private.export_media(a.file_id, 'tasks/files') m
        from private.task_attachments a join private.tasks t on t.id = a.task_id
        where t.owner_user_id = p_me and t.deleted_at is null and a.removed_at is null
        union all
        select private.export_media(a.file_id, 'tasks/files')
        from private.task_series_attachments a
        where a.owner_user_id = p_me and a.removed_at is null
      ) s where m is not null;

    elsif p_category = 'recipes' then
      v_files := pg_catalog.jsonb_build_object(
        'recipes/recipes', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', r.id, 'status', r.status, 'name', r.name, 'servings', r.servings,
            'servings_label', r.servings_label, 'prep_minutes', r.prep_minutes,
            'cook_minutes', r.cook_minutes, 'notes', r.notes, 'tags', r.tags,
            'source_url', r.source_url, 'source_name', r.source_name, 'cover_file', r.cover_file_id,
            'ingredients', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'name', i.name, 'quantity_num', i.quantity_num,
                              'quantity_den', i.quantity_den, 'unit', i.unit, 'note', i.note)
                              order by i.position), '[]')
                            from private.recipe_ingredients i where i.recipe_id = r.id),
            'steps', (select coalesce(pg_catalog.jsonb_agg(st.body order by st.position), '[]')
                      from private.recipe_steps st where st.recipe_id = r.id),
            'created_at', r.created_at, 'updated_at', r.updated_at) order by r.name, r.id), '[]')
          from private.recipes r where r.owner_user_id = p_me and r.deleted_at is null),
        'recipes/my_ratings', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'recipe_id', x.recipe_id, 'stars', x.stars, 'updated_at', x.updated_at)
            order by x.recipe_id), '[]')
          from private.recipe_ratings x join private.recipes r on r.id = x.recipe_id
          where x.user_id = p_me and r.owner_user_id = p_me and r.deleted_at is null),
        'recipes/my_favourites', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'recipe_id', x.recipe_id, 'created_at', x.created_at) order by x.recipe_id), '[]')
          from private.recipe_favorites x join private.recipes r on r.id = x.recipe_id
          where x.user_id = p_me and r.owner_user_id = p_me and r.deleted_at is null));
      select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
        select private.export_media(r.cover_file_id, 'recipes/covers') m
        from private.recipes r
        where r.owner_user_id = p_me and r.deleted_at is null and r.cover_file_id is not null
      ) s where m is not null;

    elsif p_category = 'shopping' then
      v_files := pg_catalog.jsonb_build_object(
        'shopping/lists', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', l.id, 'name', l.name, 'position', l.position, 'archived_at', l.archived_at,
            'created_at', l.created_at, 'updated_at', l.updated_at) order by l.position, l.id), '[]')
          from private.shopping_lists l where l.owner_user_id = p_me and l.deleted_at is null),
        'shopping/items', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'list_id', i.list_id, 'name', i.name, 'quantity', i.quantity, 'unit', i.unit,
            'packaging', i.packaging, 'notes', i.notes, 'position', i.position,
            'completed_at', i.completed_at, 'created_at', i.created_at)
            order by i.list_id, i.position, i.id), '[]')
          from private.shopping_items i join private.shopping_lists l on l.id = i.list_id
          where l.owner_user_id = p_me and l.deleted_at is null and i.deleted_at is null));

    elsif p_category = 'meals' then
      v_files := pg_catalog.jsonb_build_object(
        'meals/slots', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', s.id, 'name', coalesce(s.name, s.standard_key), 'position', s.position,
            'enabled', s.enabled) order by s.position, s.id), '[]')
          from private.meal_slots s where s.owner_user_id = p_me),
        'meals/entries', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'on_date', e.on_date, 'slot_id', e.slot_id,
            'recipe_id', case when r.owner_user_id = p_me then e.recipe_id end,
            'title', coalesce(e.title, case when r.owner_user_id = p_me then r.name end),
            'notes', e.notes, 'servings', e.servings, 'created_at', e.created_at)
            order by e.on_date, e.slot_id, e.id), '[]')
          from private.meal_entries e left join private.recipes r on r.id = e.recipe_id
          where e.owner_user_id = p_me and e.deleted_at is null),
        'meals/recurring', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'series_id', x.series_id, 'slot_id', x.slot_id,
            'recipe_id', case when r.owner_user_id = p_me then x.recipe_id end,
            'title', coalesce(x.title, case when r.owner_user_id = p_me then r.name end),
            'notes', x.notes, 'servings', x.servings, 'cadence', x.cadence,
            'weekdays', x.weekdays, 'start_on', x.start_on, 'end_on', x.end_on)
            order by x.series_id, x.seq), '[]')
          from private.meal_recurrences x
          join private.meal_series s on s.id = x.series_id
          left join private.recipes r on r.id = x.recipe_id
          where s.owner_user_id = p_me));

    elsif p_category = 'habits_goals' then
      v_files := pg_catalog.jsonb_build_object(
        'habits_goals/habits', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', h.id, 'name', h.name, 'description', h.description, 'time_zone', h.time_zone,
            'week_start', h.week_start, 'archived_at', h.archived_at,
            'schedules', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                            'effective_on', s.effective_on, 'kind', s.kind, 'weekdays', s.weekdays,
                            'weekly_target', s.weekly_target) order by s.effective_on), '[]')
                          from private.habit_schedules s where s.habit_id = h.id),
            'created_at', h.created_at, 'updated_at', h.updated_at) order by h.created_at, h.id), '[]')
          from private.habits h where h.owner_user_id = p_me and h.deleted_at is null),
        'habits_goals/check_ins', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'habit_id', c.habit_id, 'on_date', c.on_date, 'status', c.status, 'note', c.note,
            'recorded_at', c.recorded_at) order by c.habit_id, c.on_date, c.id), '[]')
          from private.habit_checkins c join private.habits h on h.id = c.habit_id
          where h.owner_user_id = p_me and h.deleted_at is null),
        'habits_goals/amounts', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'habit_id', c.habit_id, 'on_date', c.on_date, 'quantity', c.quantity,
            'entered_quantity', c.entered_quantity, 'entered_unit', c.entered_unit,
            'status', c.status, 'recorded_at', c.recorded_at) order by c.habit_id, c.on_date, c.id), '[]')
          from private.habit_contributions c join private.habits h on h.id = c.habit_id
          where h.owner_user_id = p_me and h.deleted_at is null),
        'habits_goals/day_notes', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'habit_id', n.habit_id, 'on_date', n.on_date, 'note', n.note, 'updated_at', n.updated_at)
            order by n.habit_id, n.on_date), '[]')
          from private.habit_day_notes n join private.habits h on h.id = n.habit_id
          where h.owner_user_id = p_me and h.deleted_at is null),
        'habits_goals/goals', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', g.id, 'kind', g.kind, 'title', g.title, 'description', g.description,
            'time_zone', g.time_zone, 'target', g.target, 'unit', g.unit, 'deadline', g.deadline,
            'achieved_at', g.achieved_at, 'archived_at', g.archived_at, 'series_id', g.series_id,
            'period_start', g.period_start, 'period_end', g.period_end, 'outcome', g.outcome,
            'created_at', g.created_at, 'updated_at', g.updated_at) order by g.created_at, g.id), '[]')
          from private.goals g where g.owner_user_id = p_me and g.deleted_at is null),
        'habits_goals/goal_entries', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'goal_id', x.goal_id, 'kind', x.kind, 'quantity', x.quantity, 'unit', x.unit,
            'note', x.note, 'status', x.status, 'recorded_at', x.recorded_at)
            order by x.goal_id, x.recorded_at, x.id), '[]')
          from private.goal_entries x join private.goals g on g.id = x.goal_id
          where g.owner_user_id = p_me and g.deleted_at is null),
        'habits_goals/recurring_goals', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', s.id, 'kind', s.kind, 'frequency', s.frequency, 'title', s.title,
            'description', s.description, 'time_zone', s.time_zone,
            'first_period_start', s.first_period_start, 'ends_on', s.ends_on, 'state', s.state,
            'created_at', s.created_at) order by s.created_at, s.id), '[]')
          from private.goal_series s where s.owner_user_id = p_me and s.deleted_at is null),
        'habits_goals/personal_points', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', x.kind, 'amount', x.amount, 'reason', x.reason, 'attributed_at', x.attributed_at,
            'available_after', x.available_after) order by x.seq), '[]')
          from private.personal_point_entries x where x.user_id = p_me),
        'habits_goals/personal_rewards', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', x.id, 'name', x.name, 'description', x.description, 'cost', x.cost,
            'enabled', x.enabled, 'archived_at', x.archived_at, 'created_at', x.created_at)
            order by x.created_at, x.id), '[]')
          from private.personal_rewards x where x.user_id = p_me),
        'habits_goals/personal_redemptions', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'reward', x.reward_name, 'cost', x.cost, 'redeemed_at', x.redeemed_at,
            'fulfillment', x.fulfillment, 'resolution', x.resolution) order by x.seq), '[]')
          from private.personal_reward_redemptions x where x.user_id = p_me),
        'habits_goals/habit_reminders', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'habit_id', r.habit_id, 'enabled', r.enabled, 'times', r.times,
            'weekdays', r.weekdays, 'updated_at', r.updated_at) order by r.habit_id), '[]')
          from private.habit_reminders r join private.habits h on h.id = r.habit_id
          where h.owner_user_id = p_me and h.deleted_at is null),
        'habits_goals/goal_reminders', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'goal_id', r.goal_id, 'enabled', r.enabled, 'lead_days', r.lead_days,
            'overdue_days', r.overdue_days, 'at_time', r.at_time, 'updated_at', r.updated_at)
            order by r.goal_id), '[]')
          from private.goal_reminders r join private.goals g on g.id = r.goal_id
          where g.owner_user_id = p_me and g.deleted_at is null));

    elsif p_category = 'media' then
      v_files := pg_catalog.jsonb_build_object(
        'media/photos', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', p.id, 'file', p.file_id, 'width', p.width, 'height', p.height,
            'created_at', p.created_at) order by p.created_at, p.id), '[]')
          from private.photos p where p.owner_user_id = p_me and p.deleted_at is null),
        'media/albums', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', a.id, 'name', a.name, 'created_at', a.created_at,
            'photos', (select coalesce(pg_catalog.jsonb_agg(i.photo_id order by i.added_at), '[]')
                       from private.photo_album_items i join private.photos p on p.id = i.photo_id
                       where i.album_id = a.id and p.owner_user_id = p_me and p.deleted_at is null))
            order by a.created_at, a.id), '[]')
          from private.photo_albums a where a.owner_user_id = p_me and a.deleted_at is null));
      select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
        select private.export_media(p.file_id, 'media/photos') m
        from private.photos p where p.owner_user_id = p_me and p.deleted_at is null
      ) s where m is not null;

    elsif p_category = 'home_contributions' then
      -- Only the requester's own rows in Homes they selected and still belong to. The Home-owned
      -- item they belong to is referenced by id only; its content stays with the Home.
      v_files := pg_catalog.jsonb_build_object(
        'home_contributions/homes', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', h.id, 'home', h.name) order by h.name), '[]')
          from public.homes h where h.id = any (p_homes)),
        'home_contributions/task_comments', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', t.owner_home_id, 'task_id', c.task_id, 'body', c.body,
            'created_at', c.created_at, 'edited_at', c.edited_at) order by c.created_at, c.id), '[]')
          from private.task_comments c join private.tasks t on t.id = c.task_id
          where c.author_id = p_me and t.owner_home_id = any (p_homes) and t.deleted_at is null),
        'home_contributions/chore_submissions', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', s.home_id, 'occurrence_id', s.occurrence_id, 'attempt', s.attempt,
            'note', s.note, 'status', s.status, 'submitted_at', s.submitted_at,
            'decided_at', s.decided_at) order by s.submitted_at, s.id), '[]')
          from private.chore_submissions s
          where s.home_id = any (p_homes)
            and (s.submitted_by = p_me or s.contributor_id = p_me)),
        'home_contributions/habit_check_ins', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', h.owner_home_id, 'habit_id', c.habit_id, 'on_date', c.on_date,
            'status', c.status, 'note', c.note, 'recorded_at', c.recorded_at)
            order by c.recorded_at, c.id), '[]')
          from private.habit_checkins c join private.habits h on h.id = c.habit_id
          where c.completed_by = p_me and h.owner_home_id = any (p_homes) and h.deleted_at is null),
        'home_contributions/habit_amounts', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', h.owner_home_id, 'habit_id', c.habit_id, 'on_date', c.on_date,
            'quantity', c.quantity, 'status', c.status, 'recorded_at', c.recorded_at)
            order by c.recorded_at, c.id), '[]')
          from private.habit_contributions c join private.habits h on h.id = c.habit_id
          where c.contributed_by = p_me and h.owner_home_id = any (p_homes) and h.deleted_at is null),
        'home_contributions/goal_entries', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', g.owner_home_id, 'goal_id', x.goal_id, 'kind', x.kind,
            'quantity', x.quantity, 'unit', x.unit, 'note', x.note, 'status', x.status,
            'recorded_at', x.recorded_at) order by x.recorded_at, x.id), '[]')
          from private.goal_entries x join private.goals g on g.id = x.goal_id
          where x.contributed_by = p_me and g.owner_home_id = any (p_homes) and g.deleted_at is null),
        'home_contributions/points', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', x.home_id, 'kind', x.kind, 'amount', x.amount, 'reason', x.reason,
            'attributed_at', x.attributed_at, 'available_after', x.available_after)
            order by x.home_id, x.seq), '[]')
          from private.point_entries x join private.point_accounts a on a.id = x.account_id
          where a.user_id = p_me and x.home_id = any (p_homes)),
        'home_contributions/reward_redemptions', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', x.home_id, 'reward', x.reward_name, 'cost', x.cost, 'status', x.status,
            'requested_at', x.requested_at, 'decided_at', x.decided_at,
            'redeemed_at', x.redeemed_at, 'fulfillment', x.fulfillment)
            order by x.requested_at, x.id), '[]')
          from private.reward_redemptions x join private.point_accounts a on a.id = x.account_id
          where a.user_id = p_me and x.home_id = any (p_homes)),
        'home_contributions/recipe_ratings', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', r.owner_home_id, 'recipe_id', x.recipe_id, 'stars', x.stars,
            'updated_at', x.updated_at) order by x.updated_at, x.recipe_id), '[]')
          from private.recipe_ratings x join private.recipes r on r.id = x.recipe_id
          where x.user_id = p_me and r.owner_home_id = any (p_homes) and r.deleted_at is null),
        'home_contributions/recipe_favourites', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'home_id', r.owner_home_id, 'recipe_id', x.recipe_id, 'created_at', x.created_at)
            order by x.created_at, x.recipe_id), '[]')
          from private.recipe_favorites x join private.recipes r on r.id = x.recipe_id
          where x.user_id = p_me and r.owner_home_id = any (p_homes) and r.deleted_at is null));
    else
      raise exception 'unknown category' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('files', v_files, 'media', v_media);
  end
  $$;

revoke all on function private.collect_personal_category(uuid, uuid[], text) from public;

-- The build job's functions ----------------------------------------------------------------------

-- How a Home export names a person: 'you', their name in the Home's directory, 'member' when they
-- have none, or 'former_member' once they left. Never an account id or an email address.
create function private.export_member(p_home_id uuid, p_user_id uuid, p_me uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then null
    when p_user_id = p_me then 'you'
    else coalesce((
      select coalesce(hp.nickname, hp.display_name, up.display_name, 'member')
      from public.home_memberships m
      left join public.home_member_profiles hp on hp.home_id = m.home_id and hp.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      where m.home_id = p_home_id and m.user_id = p_user_id), 'former_member')
  end
  $$;

revoke all on function private.export_member(uuid, uuid, uuid) from public;

-- The rows of one Home category for one export, as the requester may see them now: only records
-- the Home owns (personal items shared into it stay out), each module's own visibility applied.
-- An empty file means nothing the requester may see; a module they cannot see gives no files.
create function private.collect_home_category(p_me uuid, p_home uuid, p_category text)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_files jsonb := '{}'::jsonb;
    v_media jsonb := '[]'::jsonb;
  begin
    if not private.is_home_member(p_home, p_me) then
      raise exception 'not a member' using errcode = 'P0002';
    end if;

    if p_category = 'home' then
      v_files := pg_catalog.jsonb_build_object(
        'home/profile', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'name', h.name, 'timezone', h.timezone, 'created_at', h.created_at)), '[]')
          from public.homes h where h.id = p_home),
        'home/members', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'name', private.export_member(p_home, m.user_id, p_me), 'role', m.role,
            'joined_at', m.created_at) order by m.created_at, m.id), '[]')
          from public.home_memberships m where m.home_id = p_home),
        'home/vacations', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', v.id, 'name', v.name, 'starts_on', v.starts_on, 'ends_on', v.ends_on,
            'cancelled_at', v.cancelled_at, 'created_at', v.created_at)
            order by v.starts_on, v.id), '[]')
          from private.home_vacations v where v.home_id = p_home));

    elsif p_category = 'tasks' then
      v_files := pg_catalog.jsonb_build_object(
        'tasks/lists', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', l.id, 'name', l.name, 'archived_at', l.archived_at, 'created_at', l.created_at)
            order by l.position, l.id), '[]')
          from private.task_lists l where l.owner_home_id = p_home and l.deleted_at is null),
        'tasks/tasks', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', t.id, 'list_id', t.list_id, 'title', t.title, 'description', t.description,
            'start_date', t.start_date, 'due_date', t.due_date, 'priority', t.priority,
            'assignees', (select coalesce(pg_catalog.jsonb_agg(
                            private.export_member(p_home, a.user_id, p_me) order by a.assigned_at), '[]')
                          from private.task_assignees a where a.task_id = t.id),
            'completed_at', t.completed_at,
            'completed_by', private.export_member(p_home, t.completed_by, p_me),
            'recurring_task', t.series_root_id, 'occurrence_date', t.occurrence_date,
            'created_by', private.export_member(p_home, t.created_by, p_me),
            'created_at', t.created_at) order by t.created_at, t.id), '[]')
          from private.tasks t where t.owner_home_id = p_home and t.deleted_at is null),
        'tasks/subtasks', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'task_id', s.task_id, 'title', s.title, 'completed_at', s.completed_at)
            order by s.task_id, s.position), '[]')
          from private.subtasks s join private.tasks t on t.id = s.task_id
          where t.owner_home_id = p_home and t.deleted_at is null),
        'tasks/comments', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'task_id', c.task_id, 'author', private.export_member(p_home, c.author_id, p_me),
            'body', c.body, 'created_at', c.created_at, 'edited_at', c.edited_at)
            order by c.created_at, c.id), '[]')
          from private.task_comments c join private.tasks t on t.id = c.task_id
          where t.owner_home_id = p_home and t.deleted_at is null),
        'tasks/recurring', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', s.root_id, 'title', s.title, 'description', s.description,
            'priority', s.priority, 'frequency', s.frequency, 'interval_count', s.interval_count,
            'weekdays', s.weekdays, 'starts_on', s.starts_on, 'ends_on', s.ends_on,
            'paused_at', s.paused_at) order by s.created_at, s.id), '[]')
          from private.task_series s
          where s.owner_home_id = p_home and s.deleted_at is null and s.superseded_at is null),
        'tasks/attachments', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'task_id', a.task_id, 'file', a.file_id, 'name', a.display_name,
            'added_by', private.export_member(p_home, a.added_by, p_me), 'added_at', a.added_at)
            order by a.added_at, a.id), '[]')
          from private.task_attachments a join private.tasks t on t.id = a.task_id
          where t.owner_home_id = p_home and t.deleted_at is null and a.removed_at is null));
      select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
        select private.export_media(a.file_id, 'tasks/files') m
        from private.task_attachments a join private.tasks t on t.id = a.task_id
        where t.owner_home_id = p_home and t.deleted_at is null and a.removed_at is null
      ) s where m is not null;

    elsif p_category = 'chores' then
      v_files := pg_catalog.jsonb_build_object(
        'chores/categories', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', c.id, 'name', c.name, 'archived_at', c.archived_at) order by c.position, c.id), '[]')
          from private.chore_categories c where c.home_id = p_home),
        'chores/chores', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', c.id, 'kind', c.kind, 'title', c.title, 'instructions', c.instructions,
            'category_id', c.category_id, 'requires_approval', c.requires_approval,
            'points', c.points, 'ended_at', c.ended_at, 'created_at', c.created_at)
            order by c.created_at, c.id), '[]')
          from private.chores c where c.home_id = p_home and c.deleted_at is null),
        'chores/occurrences', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', o.id, 'chore_id', o.chore_id, 'scheduled_date', o.scheduled_date,
            'due_date', o.due_date, 'status', o.status,
            'assignees', (select coalesce(pg_catalog.jsonb_agg(
                            private.export_member(p_home, a.user_id, p_me)), '[]')
                          from private.chore_occurrence_assignees a where a.occurrence_id = o.id),
            'completed_at', o.completed_at,
            'completed_by', private.export_member(p_home, o.completed_by, p_me),
            'note', o.note, 'skipped_at', o.skipped_at, 'skip_reason', o.skip_reason,
            'approved_at', o.approved_at, 'points', o.points)
            order by o.scheduled_date, o.id), '[]')
          from private.chore_occurrences o join private.chores c on c.id = o.chore_id
          where o.home_id = p_home and o.deleted_at is null and c.deleted_at is null),
        -- Submissions are seen by reviewers; others only see their own.
        'chores/submissions', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'occurrence_id', s.occurrence_id, 'attempt', s.attempt,
            'contributor', private.export_member(p_home, s.contributor_id, p_me),
            'submitted_at', s.submitted_at, 'note', s.note, 'status', s.status,
            'decided_at', s.decided_at, 'reason', s.reason) order by s.seq), '[]')
          from private.chore_submissions s
            join private.chore_occurrences o on o.id = s.occurrence_id
            join private.chores c on c.id = o.chore_id
          where s.home_id = p_home and o.deleted_at is null and c.deleted_at is null
            and (private.can_review_chores(p_home, p_me) or s.contributor_id = p_me)));

    elsif p_category = 'calendar' then
      if private.calendar_level_allows(private.calendar_level(p_home, p_me), 'view') then
        v_files := pg_catalog.jsonb_build_object(
          'calendar/events', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', e.id, 'title', e.title, 'location', e.location, 'description', e.description,
              'all_day', e.all_day, 'starts_on', e.starts_on, 'ends_on', e.ends_on,
              'start_time', e.start_time, 'end_time', e.end_time, 'timezone', e.timezone,
              'frequency', e.frequency, 'interval_count', e.interval_count, 'weekdays', e.weekdays,
              'repeat_ends_on', e.repeat_ends_on, 'max_count', e.max_count,
              'participants', (select coalesce(pg_catalog.jsonb_agg(
                                 private.export_member(p_home, u, p_me)), '[]')
                               from pg_catalog.unnest(e.participants) u
                               where private.is_home_member(p_home, u)),
              'created_at', e.created_at) order by e.starts_on, e.id), '[]')
            from private.calendar_events e where e.home_id = p_home and e.deleted_at is null),
          'calendar/event_changes', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'event_id', x.event_id, 'original_date', x.original_date, 'cancelled', x.cancelled,
              'title', x.title, 'location', x.location, 'description', x.description,
              'all_day', x.all_day, 'starts_on', x.starts_on, 'ends_on', x.ends_on,
              'start_time', x.start_time, 'end_time', x.end_time)
              order by x.event_id, x.original_date), '[]')
            from private.calendar_event_exceptions x
            join private.calendar_events e on e.id = x.event_id
            where e.home_id = p_home and e.deleted_at is null));
      end if;

    elsif p_category = 'recipes' then
      v_files := pg_catalog.jsonb_build_object(
        'recipes/recipes', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', r.id, 'name', r.name, 'servings', r.servings,
            'servings_label', r.servings_label, 'prep_minutes', r.prep_minutes,
            'cook_minutes', r.cook_minutes, 'notes', r.notes, 'tags', r.tags,
            'source_url', r.source_url, 'source_name', r.source_name, 'cover_file', r.cover_file_id,
            'ingredients', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'name', i.name, 'quantity_num', i.quantity_num,
                              'quantity_den', i.quantity_den, 'unit', i.unit, 'note', i.note)
                              order by i.position), '[]')
                            from private.recipe_ingredients i where i.recipe_id = r.id),
            'steps', (select coalesce(pg_catalog.jsonb_agg(st.body order by st.position), '[]')
                      from private.recipe_steps st where st.recipe_id = r.id),
            'published_at', r.published_at, 'created_at', r.created_at)
            order by r.name, r.id), '[]')
          from private.recipes r
          where r.owner_home_id = p_home and private.can_see_recipe(r, p_me)));
      select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
        select private.export_media(r.cover_file_id, 'recipes/covers') m
        from private.recipes r
        where r.owner_home_id = p_home and r.cover_file_id is not null
          and private.can_see_recipe(r, p_me)
      ) s where m is not null;

    elsif p_category = 'shopping' then
      v_files := pg_catalog.jsonb_build_object(
        'shopping/lists', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', l.id, 'name', l.name, 'archived_at', l.archived_at, 'created_at', l.created_at)
            order by l.position, l.id), '[]')
          from private.shopping_lists l
          where l.owner_home_id = p_home and private.shopping_access(l, p_me) is not null),
        'shopping/categories', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', c.id, 'list_id', c.list_id, 'name', c.name) order by c.list_id, c.position), '[]')
          from private.shopping_categories c join private.shopping_lists l on l.id = c.list_id
          where l.owner_home_id = p_home and private.shopping_access(l, p_me) is not null),
        'shopping/items', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'list_id', i.list_id, 'category_id', i.category_id, 'name', i.name,
            'quantity', i.quantity, 'unit', i.unit, 'packaging', i.packaging, 'notes', i.notes,
            'completed_at', i.completed_at,
            'completed_by', private.export_member(p_home, i.completed_by, p_me),
            'created_at', i.created_at) order by i.list_id, i.position, i.id), '[]')
          from private.shopping_items i join private.shopping_lists l on l.id = i.list_id
          where l.owner_home_id = p_home and private.shopping_access(l, p_me) is not null
            and i.deleted_at is null));

    elsif p_category = 'meals' then
      if private.meal_access(p_home, p_me) is not null then
        v_files := pg_catalog.jsonb_build_object(
          'meals/slots', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', s.id, 'name', s.name, 'standard', s.standard_key, 'enabled', s.enabled)
              order by s.position, s.id), '[]')
            from private.meal_slots s where s.owner_home_id = p_home),
          'meals/entries', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'on_date', e.on_date, 'slot_id', e.slot_id, 'title', e.title,
              'recipe_id', case when private.meal_recipe_visible(e.recipe_id, p_home, p_me)
                                then e.recipe_id end,
              'notes', e.notes, 'servings', e.servings, 'created_at', e.created_at)
              order by e.on_date, e.id), '[]')
            from private.meal_entries e where e.owner_home_id = p_home and e.deleted_at is null));
      end if;

    elsif p_category = 'habits_goals' then
      if private.habit_access(p_home, p_me) is not null then
        v_files := v_files || pg_catalog.jsonb_build_object(
          'habits_goals/habits', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', h.id, 'name', h.name, 'description', h.description, 'time_zone', h.time_zone,
              'archived_at', h.archived_at, 'created_at', h.created_at)
              order by h.created_at, h.id), '[]')
            from private.habits h where h.owner_home_id = p_home and h.deleted_at is null),
          'habits_goals/check_ins', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'habit_id', c.habit_id, 'on_date', c.on_date,
              'completed_by', private.export_member(p_home, c.completed_by, p_me),
              'status', c.status, 'note', c.note, 'recorded_at', c.recorded_at)
              order by c.on_date, c.id), '[]')
            from private.habit_checkins c join private.habits h on h.id = c.habit_id
            where h.owner_home_id = p_home and h.deleted_at is null),
          'habits_goals/amounts', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'habit_id', c.habit_id, 'on_date', c.on_date, 'quantity', c.quantity,
              'contributed_by', private.export_member(p_home, c.contributed_by, p_me),
              'status', c.status, 'recorded_at', c.recorded_at) order by c.on_date, c.id), '[]')
            from private.habit_contributions c join private.habits h on h.id = c.habit_id
            where h.owner_home_id = p_home and h.deleted_at is null));
      end if;
      if private.goal_access(p_home, p_me) is not null then
        v_files := v_files || pg_catalog.jsonb_build_object(
          'habits_goals/goals', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', g.id, 'kind', g.kind, 'title', g.title, 'description', g.description,
              'target', g.target, 'unit', g.unit, 'deadline', g.deadline,
              'achieved_at', g.achieved_at, 'archived_at', g.archived_at,
              'period_start', g.period_start, 'period_end', g.period_end, 'outcome', g.outcome,
              'created_at', g.created_at) order by g.created_at, g.id), '[]')
            from private.goals g where g.owner_home_id = p_home and g.deleted_at is null),
          'habits_goals/goal_entries', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'goal_id', x.goal_id, 'kind', x.kind, 'quantity', x.quantity, 'unit', x.unit,
              'note', x.note, 'contributed_by', private.export_member(p_home, x.contributed_by, p_me),
              'recorded_at', x.recorded_at, 'status', x.status) order by x.recorded_at, x.id), '[]')
            from private.goal_entries x join private.goals g on g.id = x.goal_id
            where g.owner_home_id = p_home and g.deleted_at is null));
      end if;

    elsif p_category = 'pets' then
      if private.pet_access(p_home, p_me) is not null then
        v_files := pg_catalog.jsonb_build_object(
          'pets/pets', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', p.id, 'name', p.name, 'species', p.species, 'species_label', p.species_label,
              'breed', p.breed, 'birth_date', p.birth_date, 'sex', p.sex, 'neutered', p.neutered,
              'weight', p.weight, 'weight_unit', p.weight_unit, 'vet_name', p.vet_name,
              'vet_clinic', p.vet_clinic, 'vet_phone', p.vet_phone, 'vet_email', p.vet_email,
              'vet_address', p.vet_address, 'diet', p.diet,
              'care_instructions', p.care_instructions, 'notes', p.notes,
              'photo_file', p.photo_file_id, 'created_at', p.created_at)
              order by p.name, p.id), '[]')
            from private.pets p where p.home_id = p_home and p.deleted_at is null));
        select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
          select private.export_media(p.photo_file_id, 'pets/photos') m
          from private.pets p
          where p.home_id = p_home and p.deleted_at is null and p.photo_file_id is not null
        ) s where m is not null;
        -- Medical information only for whoever may see it in this Home.
        if private.pet_medical_can_view(p_home, p_me) then
          v_files := v_files || pg_catalog.jsonb_build_object(
            'pets/medical_details', (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'pet_id', d.pet_id, 'allergies', d.allergies, 'medications', d.medications,
                'microchip', d.microchip, 'registration', d.registration,
                'identification_notes', d.identification_notes, 'medical_notes', d.medical_notes,
                'updated_at', d.updated_at) order by d.pet_id), '[]')
              from private.pet_medical_details d join private.pets p on p.id = d.pet_id
              where p.home_id = p_home and p.deleted_at is null),
            'pets/medical_entries', (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', x.id, 'pet_id', x.pet_id, 'event_type', x.event_type,
                'event_date', x.event_date, 'title', x.title, 'veterinarian', x.veterinarian,
                'location', x.location, 'treatment', x.treatment, 'notes', x.notes,
                'follow_up_date', x.follow_up_date) order by x.event_date, x.id), '[]')
              from private.pet_medical_entries x join private.pets p on p.id = x.pet_id
              where p.home_id = p_home and p.deleted_at is null and x.deleted_at is null),
            'pets/medical_attachments', (
              select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'entry_id', a.entry_id, 'file', a.file_id, 'name', a.display_name,
                'added_at', a.added_at) order by a.added_at, a.id), '[]')
              from private.pet_medical_attachments a
              join private.pet_medical_entries x on x.id = a.entry_id
              join private.pets p on p.id = x.pet_id
              where p.home_id = p_home and p.deleted_at is null and x.deleted_at is null
                and a.removed_at is null));
          v_media := v_media || coalesce((
            select pg_catalog.jsonb_agg(m) from (
              select private.export_media(a.file_id, 'pets/medical_files') m
              from private.pet_medical_attachments a
              join private.pet_medical_entries x on x.id = a.entry_id
              join private.pets p on p.id = x.pet_id
              where p.home_id = p_home and p.deleted_at is null and x.deleted_at is null
                and a.removed_at is null
            ) s where m is not null), '[]');
        end if;
      end if;

    elsif p_category = 'photos' then
      if private.photo_access(p_home, p_me) is not null then
        v_files := pg_catalog.jsonb_build_object(
          'photos/photos', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', p.id, 'file', p.file_id, 'width', p.width, 'height', p.height,
              'added_by', private.export_member(p_home, p.created_by, p_me),
              'created_at', p.created_at) order by p.created_at, p.id), '[]')
            from private.photos p where p.owner_home_id = p_home and p.deleted_at is null),
          'photos/albums', (
            select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', a.id, 'name', a.name, 'created_at', a.created_at,
              -- Only the Home's own photos: personal photos added to it stay their owner's.
              'photos', (select coalesce(pg_catalog.jsonb_agg(i.photo_id order by i.added_at), '[]')
                         from private.photo_album_items i join private.photos p on p.id = i.photo_id
                         where i.album_id = a.id and p.owner_home_id = p_home and p.deleted_at is null))
              order by a.created_at, a.id), '[]')
            from private.photo_albums a where a.owner_home_id = p_home and a.deleted_at is null));
        select coalesce(pg_catalog.jsonb_agg(m), '[]') into v_media from (
          select private.export_media(p.file_id, 'photos/photos') m
          from private.photos p where p.owner_home_id = p_home and p.deleted_at is null
        ) s where m is not null;
      end if;

    elsif p_category = 'points' then
      v_files := pg_catalog.jsonb_build_object(
        'points/rewards', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', r.id, 'name', r.name, 'description', r.description, 'cost', r.cost,
            'requires_approval', r.requires_approval, 'enabled', r.enabled,
            'archived_at', r.archived_at) order by r.created_at, r.id), '[]')
          from private.rewards r
          where r.home_id = p_home
            and (private.can_manage_rewards(p_home, p_me) or (r.enabled and r.archived_at is null))),
        'points/accounts', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'member', private.export_member(p_home, a.user_id, p_me), 'balance', a.balance,
            'reserved', a.reserved) order by a.created_at, a.id), '[]')
          from private.point_accounts a
          where a.home_id = p_home and private.can_view_point_account(a, p_me)),
        'points/entries', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'member', private.export_member(p_home, a.user_id, p_me), 'kind', x.kind,
            'amount', x.amount, 'reason', x.reason, 'attributed_at', x.attributed_at)
            order by x.seq), '[]')
          from private.point_entries x join private.point_accounts a on a.id = x.account_id
          where x.home_id = p_home and private.can_view_point_account(a, p_me)),
        'points/redemptions', (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'reward', x.reward_name, 'cost', x.cost,
            'requested_by', private.export_member(p_home, x.requested_by, p_me),
            'status', x.status, 'requested_at', x.requested_at, 'redeemed_at', x.redeemed_at,
            'fulfillment', x.fulfillment, 'resolution', x.resolution) order by x.seq), '[]')
          from private.reward_redemptions x
          where x.home_id = p_home and private.can_see_redemption(x, p_me)));

    else
      raise exception 'unknown category' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('files', v_files, 'media', v_media);
  end
  $$;

revoke all on function private.collect_home_category(uuid, uuid, text) from public;

-- Starts (or, after a crashed run, resumes) preparing an export. 'skip' when it is no longer
-- queued or preparing; 'invalidated' when what it depended on changed before it started.
create function public.begin_data_export(p_export_id uuid)
returns table (
  outcome text, object_key text, categories text[], all_data boolean, locale text, homes jsonb,
  kind text
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_export private.data_exports;
  begin
    select * into v_export from private.data_exports e where e.id = p_export_id for update;
    if not found or v_export.status not in ('queued', 'preparing') then
      return query
        select 'skip'::text, null::text, null::text[], null::boolean, null::text, null::jsonb, null::text;
      return;
    end if;
    if not private.data_export_intact(v_export) then
      perform private.end_data_export(v_export.id, 'invalidated', 'access_changed');
      return query
        select 'invalidated'::text, null::text, null::text[], null::boolean, null::text, null::jsonb,
               null::text;
      return;
    end if;
    update private.data_exports e
      set status = 'preparing', started_at = coalesce(e.started_at, pg_catalog.now()),
          object_key = coalesce(e.object_key, private.new_object_key('u')),
          access_snapshot = case when e.kind = 'home' then coalesce(e.access_snapshot,
            private.home_export_access(e.home_id, e.requester_id, e.categories)) end
      where e.id = v_export.id
      returning * into v_export;
    return query
      select 'ok'::text, v_export.object_key, v_export.categories, v_export.all_data,
             coalesce((select p.locale from public.user_preferences p
                       where p.user_id = v_export.requester_id), 'en'),
             -- The selected Home scope, for the manifest (it filters several categories).
             (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                       'id', h.id, 'name', h.name) order by h.name), '[]')
              from public.homes h where h.id = any (private.data_export_homes(v_export))),
             v_export.kind;
  end
  $$;

revoke all on function public.begin_data_export(uuid) from public, anon, authenticated;
grant execute on function public.begin_data_export(uuid) to service_role;

-- One category of an export that is being prepared, checked again on every call.
create function public.collect_data_export(p_export_id uuid, p_category text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_export private.data_exports;
  begin
    select * into v_export from private.data_exports e where e.id = p_export_id;
    if not found or v_export.status <> 'preparing' or not (p_category = any (v_export.categories)) then
      raise exception 'export not being prepared' using errcode = 'P0002';
    end if;
    if not private.data_export_intact(v_export) then
      raise exception 'export no longer eligible' using errcode = 'P0002', hint = 'access_changed';
    end if;
    if v_export.kind = 'home' then
      return private.collect_home_category(v_export.requester_id, v_export.home_id, p_category);
    end if;
    return private.collect_personal_category(
      v_export.requester_id, private.data_export_homes(v_export), p_category);
  end
  $$;

revoke all on function public.collect_data_export(uuid, text) from public, anon, authenticated;
grant execute on function public.collect_data_export(uuid, text) to service_role;

-- Marks an export ready once its archive is stored, and tells the requester (in-app and email,
-- without a link to the file). 'discarded' when it was canceled or invalidated meanwhile (its file
-- is then queued for removal by end_data_export).
create function public.finish_data_export(
  p_export_id uuid, p_size bigint, p_summary jsonb, p_partial boolean
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_export private.data_exports;
  begin
    if p_size is null or p_size < 0 or p_summary is null or jsonb_typeof(p_summary) <> 'object' then
      raise exception 'invalid result' using errcode = '22023';
    end if;
    select * into v_export from private.data_exports e where e.id = p_export_id for update;
    if not found or v_export.status <> 'preparing' then
      if found and v_export.object_key is not null
         and v_export.status in ('canceled', 'invalidated', 'failed', 'expired') then
        -- The file may have been written after the export ended: remove it (again) to be sure.
        delete from private.storage_object_deletions d
          where d.object_key = v_export.object_key and d.done_at is not null;
        perform private.queue_object_deletion(v_export.object_key, 'export');
      end if;
      return 'discarded';
    end if;
    if not private.data_export_intact(v_export) then
      perform private.end_data_export(v_export.id, 'invalidated', 'access_changed');
      return 'discarded';
    end if;
    update private.data_exports e
      set status = 'ready', size_bytes = p_size, summary = p_summary,
          -- Anything that became visible while collecting may be in the archive: check it too.
          access_snapshot = case when e.kind = 'home'
            then private.home_export_access(e.home_id, e.requester_id, e.categories) end,
          partial = coalesce(p_partial, false), generated_at = pg_catalog.now(),
          expires_at = pg_catalog.now() + private.data_export_lifetime()
      where e.id = v_export.id;
    perform private.notify_user(
      -- A Home export's notice carries its Home, so it leads to that Home's export page.
      v_export.requester_id, v_export.home_id, 'security', 'account.data_export_ready', '{}'::jsonb,
      'account.data_export_ready:' || v_export.id::text, true);
    perform private.record_account_activity(
      v_export.requester_id, 'privacy', 'data_export_ready', 'completed', null, 'automatic');
    return 'ready';
  end
  $$;

revoke all on function public.finish_data_export(uuid, bigint, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.finish_data_export(uuid, bigint, jsonb, boolean) to service_role;

-- Records a failed preparation (a short code only) and tells the requester in-app.
create function public.fail_data_export(p_export_id uuid, p_code text) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user uuid;
    v_home uuid;
  begin
    if p_code is null or p_code !~ '^[a-z][a-z_]{0,47}$' then
      raise exception 'invalid code' using errcode = '22023';
    end if;
    select e.requester_id, e.home_id into v_user, v_home from private.data_exports e
      where e.id = p_export_id and e.status in ('queued', 'preparing');
    if not found or not private.end_data_export(p_export_id, 'failed', p_code) then
      return false;
    end if;
    perform private.notify_user(
      v_user, v_home, 'security', 'account.data_export_failed', '{}'::jsonb,
      'account.data_export_failed:' || p_export_id::text, false);
    perform private.record_account_activity(v_user, 'privacy', 'data_export_failed', 'failed',
                                            null, 'automatic');
    return true;
  end
  $$;

revoke all on function public.fail_data_export(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_data_export(uuid, text) to service_role;

-- Hourly: ends expired exports (their files removed), fails preparations that never finished, and
-- warns once before expiry (in-app only, no link). Returns how many exports it changed.
create function public.sweep_data_exports(p_limit integer) returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_row record;
    v_count integer := 0;
  begin
    if p_limit is null or p_limit < 1 or p_limit > 1000 then
      raise exception 'invalid limit' using errcode = '22023';
    end if;
    for v_row in
      select e.id from private.data_exports e
      where e.status = 'ready' and e.expires_at <= pg_catalog.now()
      order by e.expires_at limit p_limit
    loop
      if private.end_data_export(v_row.id, 'expired') then
        v_count := v_count + 1;
      end if;
    end loop;
    for v_row in
      select e.id, e.requester_id, e.home_id from private.data_exports e
      where e.status in ('queued', 'preparing')
        and e.created_at <= pg_catalog.now() - private.data_export_preparation_limit()
      order by e.created_at limit p_limit
    loop
      if private.end_data_export(v_row.id, 'failed', 'timed_out') then
        perform private.notify_user(
          v_row.requester_id, v_row.home_id, 'security', 'account.data_export_failed', '{}'::jsonb,
          'account.data_export_failed:' || v_row.id::text, false);
        v_count := v_count + 1;
      end if;
    end loop;
    for v_row in
      update private.data_exports e set warned_at = pg_catalog.now()
      where e.id in (
        select x.id from private.data_exports x
        where x.status = 'ready' and x.warned_at is null
          and x.expires_at > pg_catalog.now()
          and x.expires_at <= pg_catalog.now() + private.data_export_warning_lead()
        order by x.expires_at limit p_limit)
      returning e.id, e.requester_id, e.home_id
    loop
      perform private.notify_user(
        v_row.requester_id, v_row.home_id, 'security', 'account.data_export_expiring', '{}'::jsonb,
        'account.data_export_expiring:' || v_row.id::text, false);
      v_count := v_count + 1;
    end loop;
    -- A preparation still running when its export ended (canceled, invalidated, timed out) can
    -- store the archive after the removal ran, or crash before finishing, so nothing would remove
    -- it. Once no preparation can still be running (its lease is 15 minutes), the archive is
    -- removed once more; a missing object counts as removed.
    for v_row in
      update private.data_exports e set cleanup_rechecked_at = pg_catalog.now()
      where e.id in (
        select x.id from private.data_exports x
        where x.object_key is not null and x.cleanup_rechecked_at is null
          and x.status in ('failed', 'canceled', 'expired', 'invalidated')
          and x.ended_at <= pg_catalog.now() - interval '30 minutes'
        order by x.ended_at limit p_limit)
      returning e.object_key
    loop
      delete from private.storage_object_deletions d
        where d.object_key = v_row.object_key and d.done_at is not null;
      perform private.queue_object_deletion(v_row.object_key, 'export');
      v_count := v_count + 1;
    end loop;
    return v_count;
  end
  $$;

revoke all on function public.sweep_data_exports(integer) from public, anon, authenticated;
grant execute on function public.sweep_data_exports(integer) to service_role;

-- Guided privacy review ---------------------------------------------------------------------------

-- Progress only: the step reached, never copies of settings. Completion changes nothing else.
create table private.privacy_reviews (
  user_id uuid primary key references auth.users (id) on delete cascade,
  step text not null constraint privacy_reviews_step_check
    check (step in ('profile', 'homes', 'connections', 'security', 'devices', 'data_rights')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table private.privacy_reviews enable row level security;
revoke all on table private.privacy_reviews from public;

comment on table private.privacy_reviews is
  'S39: where the person is in the optional guided privacy review. Via my_privacy_review only.';

create function public.my_privacy_review()
returns table (step text, started_at timestamptz, completed_at timestamptz)
  language sql stable security definer set search_path = '' as $$
    select r.step, r.started_at, r.completed_at from private.privacy_reviews r
    where r.user_id = auth.uid()
  $$;

revoke all on function public.my_privacy_review() from public, anon;
grant execute on function public.my_privacy_review() to authenticated;

-- 'start' (re)starts at the first step, 'step' saves the step reached, 'finish' records completion,
-- 'dismiss' forgets the progress. Start and finish appear in the activity history.
create function public.save_my_privacy_review(p_action text, p_step text default null)
returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_action = 'start' then
      insert into private.privacy_reviews (user_id, step) values (v_user_id, 'profile')
        on conflict (user_id) do update
          set step = 'profile', started_at = pg_catalog.now(), completed_at = null,
              updated_at = pg_catalog.now();
      perform private.record_account_activity(v_user_id, 'privacy', 'privacy_review_started', 'completed');
    elsif p_action = 'step' then
      if p_step is null or p_step not in ('profile', 'homes', 'connections', 'security', 'devices', 'data_rights') then
        raise exception 'unknown step' using errcode = '22023';
      end if;
      update private.privacy_reviews r set step = p_step, updated_at = pg_catalog.now()
        where r.user_id = v_user_id and r.completed_at is null;
      if not found then
        raise exception 'no review in progress' using errcode = 'P0002';
      end if;
    elsif p_action = 'finish' then
      update private.privacy_reviews r
        set step = 'data_rights', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where r.user_id = v_user_id and r.completed_at is null;
      if not found then
        raise exception 'no review in progress' using errcode = 'P0002';
      end if;
      perform private.record_account_activity(v_user_id, 'privacy', 'privacy_review_completed', 'completed');
    elsif p_action = 'dismiss' then
      delete from private.privacy_reviews r where r.user_id = v_user_id;
    else
      raise exception 'unknown action' using errcode = '22023';
    end if;
  end
  $$;

revoke all on function public.save_my_privacy_review(text, text) from public, anon;
grant execute on function public.save_my_privacy_review(text, text) to authenticated;
