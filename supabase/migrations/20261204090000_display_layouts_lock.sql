-- S44: Household Display layouts, privacy lock and member actions (spec "Confirmed dedicated household
-- display identity and privacy lock screen", "Confirmed independent layouts for each Household
-- Display", "Confirmed Household Display member-only actions"; architecture.md §33, §40; brief
-- plans/steps/S44-brief.md).
--
-- - Each display has its own configuration (layout, orientation, theme, density, clock format) and
--   its own privacy/party lock, kept here so both survive refresh, reconnect and restart. Home
--   managers change them from their own session, with a revision check against concurrent edits.
-- - The display reads everything it shows through one function, public.display_board(), which
--   decides in SQL what is shared-display-safe, whatever the layout asks for. While locked it
--   returns the lock screen's fields only.
-- - Member actions (completing a chore) and locking on the display run through the web
--   server as the service role: PIN hashes never reach a display's token. The web server learns
--   which display is asking from the display's own session (display_me) and passes its id; the
--   functions check again that the display is active and its Home open. Unlocking needs a
--   manager's own session (spec: "privacy-mode unlock ... a Home manager must use an
--   independently authorized session"); tapping the display or picking a member never unlocks.
-- - public.display_signals carries one version per display (no content) for Realtime; only that
--   display's own live session can read its row.

-- 1. Configuration ------------------------------------------------------------------------------------------

-- The outer shape of a display layout (the web server checks every detail with its schema):
-- version 1, at most 8 widgets of the display catalogue, each with a unique id, a size and a
-- settings object, and at most 8 KB.
create function private.valid_display_layout(p_layout jsonb) returns boolean
  language plpgsql immutable set search_path = '' as $$
  declare
    v_widget jsonb;
    v_ids text[] := '{}';
  begin
    if p_layout is null or pg_catalog.jsonb_typeof(p_layout) <> 'object'
       or p_layout -> 'version' is distinct from '1'::jsonb
       or pg_catalog.jsonb_typeof(p_layout -> 'widgets') is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_layout -> 'widgets') > 8
       or pg_catalog.octet_length(p_layout::text) > 8192
       or exists (select 1 from pg_catalog.jsonb_object_keys(p_layout) k
                  where k not in ('version', 'widgets')) then
      return false;
    end if;
    for v_widget in select w from pg_catalog.jsonb_array_elements(p_layout -> 'widgets') w loop
      if pg_catalog.jsonb_typeof(v_widget) <> 'object'
         or coalesce(v_widget ->> 'type', '') not in ('clock', 'chores', 'shopping')
         or coalesce(v_widget ->> 'size', '') not in ('small', 'medium', 'large')
         or coalesce(v_widget ->> 'id', '')
              !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or pg_catalog.jsonb_typeof(v_widget -> 'config') is distinct from 'object'
         or (v_widget ->> 'id') = any (v_ids) then
        return false;
      end if;
      v_ids := v_ids || (v_widget ->> 'id');
    end loop;
    return true;
  end
  $$;

revoke all on function private.valid_display_layout(jsonb) from public;

-- One row per display, created with the defaults the first time it is read. layout null: the
-- default layout (apps/web/src/displays/layout.ts). revision moves with every layout or preference
-- change (managers' edits are checked against it); lock_version with every lock change. The
-- synced_* columns are what the display last read, so managers see whether a change has reached it.
create table private.display_configs (
  display_id uuid primary key references private.household_displays (id) on delete cascade,
  layout jsonb constraint display_configs_layout_check
    check (layout is null or private.valid_display_layout(layout)),
  orientation text not null default 'auto'
    constraint display_configs_orientation_check check (orientation in ('auto', 'landscape', 'portrait')),
  theme text not null default 'auto'
    constraint display_configs_theme_check check (theme in ('auto', 'light', 'dark')),
  density text not null default 'comfortable'
    constraint display_configs_density_check check (density in ('comfortable', 'compact')),
  clock_format text not null default 'auto'
    constraint display_configs_clock_check check (clock_format in ('auto', '12h', '24h')),
  revision integer not null default 1 constraint display_configs_revision_check check (revision >= 1),
  locked boolean not null default false,
  -- The optional, non-sensitive welcome message of the lock screen (kept while unlocked).
  lock_message text constraint display_configs_lock_message_check
    check (lock_message is null or private.is_visible_name(lock_message, 80)),
  lock_version integer not null default 1
    constraint display_configs_lock_version_check check (lock_version >= 1),
  locked_at timestamptz,
  locked_by uuid references auth.users (id) on delete set null,
  synced_revision integer,
  synced_lock_version integer,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

revoke all on table private.display_configs from public;

comment on table private.display_configs is
  'S44: each Household Display''s own layout, presentation and privacy lock.';

-- A display's configuration row, created with the defaults when missing.
create function private.display_config(p_display_id uuid) returns private.display_configs
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_config private.display_configs;
  begin
    insert into private.display_configs (display_id) values (p_display_id) on conflict do nothing;
    select * into v_config from private.display_configs c where c.display_id = p_display_id;
    return v_config;
  end
  $$;

revoke all on function private.display_config(uuid) from public;

-- Whether the display's layout offers member actions: the default layout does; a saved one does
-- when it has a chores widget whose settings do not turn actions off.
create function private.display_actions_enabled(p_layout jsonb) returns boolean
  language sql immutable set search_path = '' as $$
    select p_layout is null
      or exists (select 1 from pg_catalog.jsonb_array_elements(p_layout -> 'widgets') w
                 where w ->> 'type' = 'chores'
                   and (w -> 'config' -> 'actions') is distinct from 'false'::jsonb)
  $$;

revoke all on function private.display_actions_enabled(jsonb) from public;

-- An active display: not revoked, still with its account, its Home open.
create function private.active_display(p_display_id uuid) returns private.household_displays
  language sql stable security definer set search_path = '' as $$
    select d.* from private.household_displays d
    where d.id = p_display_id and d.revoked_at is null and d.user_id is not null
      and private.home_is_open(d.home_id)
  $$;

revoke all on function private.active_display(uuid) from public;

-- Whether a member may lock the display on the display itself: an adult manager of its Home.
create function private.display_lock_manager(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select p_user_id is not null and private.is_home_member(p_home_id, p_user_id)
      and not private.is_child(p_user_id)
      and private.has_home_capability(p_home_id, p_user_id, 'manageHomeSettings')
  $$;

revoke all on function private.display_lock_manager(uuid, uuid) from public;

-- 2. Realtime signals ----------------------------------------------------------------------------------------

-- One row per display whose version moves when what it shows may have changed: its Home's chores or
-- shopping lists (through the S21/S26 signal rows), or its own configuration or lock. No content.
create table public.display_signals (
  display_id uuid primary key references private.household_displays (id) on delete cascade,
  version bigint not null default 1,
  changed_at timestamptz not null default now()
);

alter table public.display_signals enable row level security;
revoke all on table public.display_signals from public, anon, authenticated;
grant select on table public.display_signals to authenticated;

-- Only the display itself, in its own usable display session (S43's request state), sees its row.
create function private.display_signal_visible(p_display_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select private.request_session_state() = 'display_session'
      and exists (select 1 from private.household_displays d
                  where d.id = p_display_id and d.user_id = auth.uid() and d.revoked_at is null)
  $$;

revoke all on function private.display_signal_visible(uuid) from public;
grant execute on function private.display_signal_visible(uuid) to authenticated;

create policy display_signals_select_own on public.display_signals
  for select
  to authenticated
  using ((select private.display_signal_visible(display_id)));

comment on table public.display_signals is
  'S44: a per-display version that moves when what the display shows may have changed (Realtime). No content.';

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.display_signals;
  end if;
end
$$;

create function private.bump_display_signal(p_display_id uuid) returns void
  language sql security definer set search_path = '' as $$
    insert into public.display_signals as s (display_id) values (p_display_id)
      on conflict (display_id) do update set version = s.version + 1, changed_at = pg_catalog.now();
  $$;

revoke all on function private.bump_display_signal(uuid) from public;

-- Moves the signal of every active display of a Home.
create function private.bump_home_display_signals() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.home_id is null then
      return null;
    end if;
    insert into public.display_signals as s (display_id)
      select d.id from private.household_displays d
      where d.home_id = new.home_id and d.revoked_at is null and d.user_id is not null
      on conflict (display_id) do update set version = s.version + 1, changed_at = pg_catalog.now();
    return null;
  end
  $$;

revoke all on function private.bump_home_display_signals() from public;

create trigger display_signals_from_chores
  after insert or update on public.chore_pool_signals
  for each row execute function private.bump_home_display_signals();

create trigger display_signals_from_shopping
  after insert or update on public.shopping_signals
  for each row execute function private.bump_home_display_signals();

create function private.bump_config_display_signal() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.bump_display_signal(new.display_id);
    return null;
  end
  $$;

revoke all on function private.bump_config_display_signal() from public;

create trigger display_signals_from_config
  after update on private.display_configs
  for each row
  when (old.revision is distinct from new.revision or old.lock_version is distinct from new.lock_version)
  execute function private.bump_config_display_signal();

-- 3. The display's own session --------------------------------------------------------------------------------

-- The only API calls a display session may make (S43 plus the board).
create or replace function private.display_session_paths() returns text[]
  language sql immutable parallel safe set search_path = '' as $$
    select array['/rpc/display_me', '/rpc/display_board']::text[]
  $$;

-- Everything a display shows, decided here. Notes that the display was seen and which configuration
-- it now shows. While locked: the lock screen's fields only (its own id for Realtime, but no Home or
-- display name, members,
-- chores, lists or actions). Otherwise: the display's layout and presentation, and the Home's
-- shared-display-safe data for the display catalogue:
--   * members (name, colour, whether a child, PIN rules) only when the layout offers actions, and
--     the Home's adult managers (name, colour) who may lock the display with their PIN;
--   * open chores up to today (title, due date, assignees, open mandatory steps, approval);
--   * active Home shopping lists (name) with their active items (name, quantity, unit; never notes
--     or who added or completed them).
-- Refused for anyone but a display in a usable display session.
create function public.display_board() returns jsonb
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_display private.household_displays;
    v_config private.display_configs;
    v_home public.homes;
    v_today date;
    v_actions boolean;
    v_base jsonb;
  begin
    if v_user_id is null or v_session_id is null or not private.is_display(v_user_id)
       or not private.display_session_ok(v_user_id, v_session_id) then
      raise exception 'not a display session' using errcode = '42501';
    end if;
    select * into v_display from private.household_displays d where d.user_id = v_user_id;
    select * into v_home from public.homes h where h.id = v_display.home_id;
    v_config := private.display_config(v_display.id);
    update private.display_configs c
      set synced_revision = c.revision, synced_lock_version = c.lock_version
      where c.display_id = v_display.id
        and (c.synced_revision is distinct from c.revision
             or c.synced_lock_version is distinct from c.lock_version);
    update private.household_displays d set last_seen_at = pg_catalog.now()
      where d.id = v_display.id
        and (d.last_seen_at is null
             or d.last_seen_at < pg_catalog.now() - (select l.seen_interval
                                                     from private.display_limits() l));
    v_base := pg_catalog.jsonb_build_object(
      'display_id', v_display.id,
      'locked', v_config.locked,
      'timezone', v_home.timezone,
      'theme', v_config.theme,
      'clock_format', v_config.clock_format,
      'density', v_config.density,
      'orientation', v_config.orientation,
      'signal_version', coalesce((select s.version from public.display_signals s
                                  where s.display_id = v_display.id), 0)
    );
    if v_config.locked then
      return v_base || pg_catalog.jsonb_build_object('lock_message', v_config.lock_message);
    end if;

    v_today := private.task_today(v_display.home_id, null);
    v_actions := private.display_actions_enabled(v_config.layout);
    return v_base || pg_catalog.jsonb_build_object(
      'display_name', v_display.name,
      'home_name', v_home.name,
      'layout', v_config.layout,
      'actions', v_actions,
      'require_pin', coalesce((select s.require_pin from private.shared_device_settings s
                               where s.home_id = v_display.home_id), false),
      'members', case when not v_actions then '[]'::jsonb else coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'membership_id', m.id,
                 'name', coalesce(p.nickname, p.display_name, up.display_name),
                 'accent_color', coalesce(p.accent_color, up.accent_color),
                 'is_child', private.is_child(m.user_id),
                 'requires_pin', exists (select 1 from private.shared_device_member_rules r
                                         where r.home_id = m.home_id and r.user_id = m.user_id),
                 'has_pin', case when private.is_child(m.user_id)
                   then exists (select 1 from private.child_home_pins hp
                                where hp.home_id = m.home_id and hp.child_user_id = m.user_id)
                   else exists (select 1 from private.member_device_pins dp
                                where dp.user_id = m.user_id) end)
               order by m.created_at, m.id)
        from public.home_memberships m
        left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
        left join public.user_preferences up on up.user_id = m.user_id
        where m.home_id = v_display.home_id), '[]'::jsonb) end,
      'chores', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'occurrence_id', o.id,
                 'title', o.title,
                 'due_date', o.due_date,
                 'overdue', o.due_date < v_today,
                 'assignee_ids', coalesce((
                   select pg_catalog.jsonb_agg(private.member_ref(a.home_id, a.user_id))
                   from private.chore_occurrence_assignees a where a.occurrence_id = o.id),
                   '[]'::jsonb),
                 'mandatory_open', (select count(*) from private.chore_occurrence_steps st
                   where st.occurrence_id = o.id and st.mandatory and st.checked_at is null),
                 'requires_approval', o.requires_approval,
                 'requires_pin', exists (select 1 from private.shared_device_chore_rules r
                                         where r.chore_id = o.chore_id))
               order by o.due_date, o.title, o.id)
        from (select oc.id, oc.chore_id, oc.due_date, c.title, c.requires_approval
              from private.chore_occurrences oc
              join private.chores c on c.id = oc.chore_id
              where oc.home_id = v_display.home_id and oc.status = 'open' and oc.deleted_at is null
                and c.deleted_at is null and oc.due_date <= v_today
              order by oc.due_date, c.title, oc.id
              limit 50) o), '[]'::jsonb),
      -- Who may lock this display here with their PIN (name and colour only).
      'lock_managers', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'membership_id', m.id,
                 'name', coalesce(p.nickname, p.display_name, up.display_name),
                 'accent_color', coalesce(p.accent_color, up.accent_color))
               order by m.created_at, m.id)
        from public.home_memberships m
        left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
        left join public.user_preferences up on up.user_id = m.user_id
        where m.home_id = v_display.home_id
          and private.display_lock_manager(m.home_id, m.user_id)), '[]'::jsonb),
      'shopping', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'list_id', l.id,
                 'name', l.name,
                 'remaining', (select count(*) from private.shopping_items i
                               where i.list_id = l.id and i.deleted_at is null
                                 and i.completed_at is null),
                 'items', coalesce((
                   select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                            'item_id', i.id, 'name', i.name,
                            'quantity', pg_catalog.trim_scale(i.quantity)::text,
                            'unit', i.unit)
                          order by i.position, i.id)
                   from (select si.id, si.name, si.quantity, si.unit, si.position
                         from private.shopping_items si
                         where si.list_id = l.id and si.deleted_at is null
                           and si.completed_at is null
                         order by si.position, si.id
                         limit 15) i), '[]'::jsonb))
               order by l.position, l.id)
        from (select sl.id, sl.name, sl.position from private.shopping_lists sl
              where sl.owner_home_id = v_display.home_id and sl.deleted_at is null
                and sl.archived_at is null
              order by sl.position, sl.id
              limit 20) l), '[]'::jsonb)
    );
  end
  $$;

revoke all on function public.display_board() from public, anon;
grant execute on function public.display_board() to authenticated;

-- 4. Home managers ---------------------------------------------------------------------------------------------

-- A display's configuration for the same managers as S43 (Owner, or Administrator with
-- manageHomeSettings), with whether the display has picked up the latest change ('applied') and
-- the Home's active shopping lists for the widget settings. Null for an unknown or revoked display.
create function public.household_display_config(p_home_id uuid, p_display_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_config private.display_configs;
  begin
    if private.display_manager_check(p_home_id, v_user_id, false) <> 'ok' then
      raise exception 'not a manager of this Home' using errcode = '42501';
    end if;
    if not exists (select 1 from private.household_displays d
                   where d.id = p_display_id and d.home_id = p_home_id and d.revoked_at is null
                     and d.user_id is not null) then
      return null;
    end if;
    v_config := private.display_config(p_display_id);
    return pg_catalog.jsonb_build_object(
      'layout', v_config.layout,
      'orientation', v_config.orientation,
      'theme', v_config.theme,
      'density', v_config.density,
      'clock_format', v_config.clock_format,
      'revision', v_config.revision,
      'locked', v_config.locked,
      'lock_message', v_config.lock_message,
      'locked_at', v_config.locked_at,
      'applied', v_config.synced_revision is not distinct from v_config.revision
                 and v_config.synced_lock_version is not distinct from v_config.lock_version,
      'shopping_lists', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('list_id', l.id, 'name', l.name)
                                    order by l.position, l.id)
        from private.shopping_lists l
        where l.owner_home_id = p_home_id and l.deleted_at is null and l.archived_at is null),
        '[]'::jsonb)
    );
  end
  $$;

revoke all on function public.household_display_config(uuid, uuid) from public, anon;
grant execute on function public.household_display_config(uuid, uuid) to authenticated;

-- Saves a display's layout and presentation when nobody changed them since p_expected_revision
-- (else 'conflict', nothing saved). p_layout null restores the default layout. Outcomes: 'saved'
-- (with the new revision), 'unchanged', 'conflict', 'not_permitted', 'not_found'.
create function public.save_household_display_config(
  p_home_id uuid,
  p_display_id uuid,
  p_expected_revision integer,
  p_layout jsonb,
  p_orientation text,
  p_theme text,
  p_density text,
  p_clock_format text
) returns table (outcome text, revision integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
    v_config private.display_configs;
  begin
    if p_expected_revision is null
       or (p_layout is not null and not private.valid_display_layout(p_layout))
       or p_orientation is null or p_orientation not in ('auto', 'landscape', 'portrait')
       or p_theme is null or p_theme not in ('auto', 'light', 'dark')
       or p_density is null or p_density not in ('comfortable', 'compact')
       or p_clock_format is null or p_clock_format not in ('auto', '12h', '24h') then
      raise exception 'invalid display configuration' using errcode = '22023';
    end if;
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return query select v_check, null::integer;
      return;
    end if;
    if private.active_display(p_display_id) is null
       or (private.active_display(p_display_id)).home_id is distinct from p_home_id then
      return query select 'not_found'::text, null::integer;
      return;
    end if;
    perform private.display_config(p_display_id);
    select * into v_config from private.display_configs c where c.display_id = p_display_id
      for update;
    if v_config.revision <> p_expected_revision then
      return query select 'conflict'::text, v_config.revision;
      return;
    end if;
    if v_config.layout is not distinct from p_layout and v_config.orientation = p_orientation
       and v_config.theme = p_theme and v_config.density = p_density
       and v_config.clock_format = p_clock_format then
      return query select 'unchanged'::text, v_config.revision;
      return;
    end if;
    update private.display_configs c
      set layout = p_layout, orientation = p_orientation, theme = p_theme, density = p_density,
          clock_format = p_clock_format, revision = c.revision + 1, updated_by = v_user_id,
          updated_at = pg_catalog.now()
      where c.display_id = p_display_id;
    perform private.audit(case when p_layout is null then 'display.config_reset'
                               else 'display.configured' end,
      p_home_id, 'household_display', p_display_id,
      pg_catalog.jsonb_build_object(
        'widgets', coalesce((select pg_catalog.jsonb_agg(w ->> 'type')
                             from pg_catalog.jsonb_array_elements(p_layout -> 'widgets') w),
                            '[]'::jsonb),
        'orientation', p_orientation));
    return query select 'saved'::text, v_config.revision + 1;
  end
  $$;

revoke all on function public.save_household_display_config(uuid, uuid, integer, jsonb, text, text, text, text)
  from public, anon;
grant execute on function public.save_household_display_config(uuid, uuid, integer, jsonb, text, text, text, text)
  to authenticated;

-- Applies a lock change to a display (callers checked who may). Returns 'saved' or 'unchanged'.
create function private.apply_display_lock(
  p_display_id uuid, p_home_id uuid, p_locked boolean, p_message text, p_by uuid, p_via text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_config private.display_configs;
  begin
    perform private.display_config(p_display_id);
    select * into v_config from private.display_configs c where c.display_id = p_display_id
      for update;
    if v_config.locked = p_locked and v_config.lock_message is not distinct from p_message then
      return 'unchanged';
    end if;
    update private.display_configs c
      set locked = p_locked, lock_message = p_message, lock_version = c.lock_version + 1,
          locked_at = case when p_locked and not c.locked then pg_catalog.now()
                           when not p_locked then null else c.locked_at end,
          locked_by = case when p_locked then coalesce(p_by, c.locked_by) end
      where c.display_id = p_display_id;
    if v_config.locked <> p_locked then
      perform private.audit(case when p_locked then 'display.locked' else 'display.unlocked' end,
        p_home_id, 'household_display', p_display_id,
        pg_catalog.jsonb_build_object('via', p_via, 'member', private.member_ref(p_home_id, p_by)));
    end if;
    return 'saved';
  end
  $$;

revoke all on function private.apply_display_lock(uuid, uuid, boolean, text, uuid, text) from public;

-- Locks or unlocks a display, and sets its lock screen's welcome message (null: none), from a
-- manager's own session. Outcomes: 'saved', 'unchanged', 'not_permitted', 'not_found'.
create function public.set_household_display_lock(
  p_home_id uuid, p_display_id uuid, p_locked boolean, p_message text default null
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
  begin
    if p_locked is null or (p_message is not null and not private.is_visible_name(p_message, 80)) then
      raise exception 'invalid lock' using errcode = '22023';
    end if;
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return v_check;
    end if;
    if private.active_display(p_display_id) is null
       or (private.active_display(p_display_id)).home_id is distinct from p_home_id then
      return 'not_found';
    end if;
    return private.apply_display_lock(p_display_id, p_home_id, p_locked, p_message, v_user_id,
                                      'manager_session');
  end
  $$;

revoke all on function public.set_household_display_lock(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.set_household_display_lock(uuid, uuid, boolean, text) to authenticated;

-- 5. Actions on the display (the web server only, as service_role) -------------------------------------------

-- Each chore completed on a display: who it is attributed to, how they were verified, and whether
-- it was undone (as S42's shared_device_actions, with the display as the device origin).
create table private.display_actions (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  display_id uuid not null references private.household_displays (id) on delete cascade,
  occurrence_id uuid not null,
  member_user_id uuid references auth.users (id) on delete set null,
  verification text not null
    constraint display_actions_verification_check check (verification in ('attributed', 'pin')),
  outcome text not null,
  occurrence_revision integer not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

create index display_actions_display_idx on private.display_actions (display_id, created_at);

revoke all on table private.display_actions from public;

-- A PIN check on a display waiting for the web server's comparison: one purpose (a chore, or
-- locking the display), one member, one display.
create table private.display_checks (
  id uuid primary key default gen_random_uuid(),
  display_id uuid not null references private.household_displays (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  purpose text not null constraint display_checks_purpose_check
    check (purpose in ('chore', 'lock')),
  occurrence_id uuid,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  client_key text not null
    constraint display_checks_client_key_check check (client_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  constraint display_checks_occurrence_check check ((purpose = 'chore') = (occurrence_id is not null))
);

create index display_checks_display_idx on private.display_checks (display_id, created_at)
  where used_at is null;
create index display_checks_client_idx on private.display_checks (client_key, created_at)
  where used_at is null;

revoke all on table private.display_checks from public;

-- Who may be named for an occurrence on a display: any current member of the display's Home; a
-- child only for a chore assigned to them (as S42's device_member).
create function private.display_member(p_home_id uuid, p_occurrence_id uuid, p_membership_id uuid)
returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    join private.chore_occurrences o on o.id = p_occurrence_id and o.home_id = m.home_id
    where m.home_id = p_home_id and m.id = p_membership_id and o.deleted_at is null
      and (not private.is_child(m.user_id)
           or exists (select 1 from private.chore_occurrence_assignees a
                      where a.occurrence_id = o.id and a.user_id = m.user_id))
  $$;

revoke all on function private.display_member(uuid, uuid, uuid) from public;

-- Completes the occurrence as the member (S42's device actor) and records it with the display as
-- the device origin. Returns the completion's outcome and the action id (for Undo).
create function private.display_complete(
  p_display private.household_displays, p_occurrence_id uuid, p_member uuid, p_verification text
) returns table (outcome text, action_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_claims text;
    v_outcome text;
    v_action uuid;
  begin
    v_claims := private.begin_device_actor(p_member, p_display.home_id, null);
    select c.outcome into v_outcome
      from public.complete_chore_occurrence(p_occurrence_id,
        private.member_ref(p_display.home_id, p_member), null) c;
    perform private.end_device_actor(p_member, v_claims);
    if v_outcome in ('completed', 'submitted') then
      insert into private.display_actions (home_id, display_id, occurrence_id, member_user_id,
                                           verification, outcome, occurrence_revision)
        values (p_display.home_id, p_display.id, p_occurrence_id, p_member, p_verification,
                v_outcome,
                (select o.revision from private.chore_occurrences o where o.id = p_occurrence_id))
        returning id into v_action;
      perform private.audit('chore_occurrence.display_completed', p_display.home_id,
        'chore_occurrence', p_occurrence_id,
        pg_catalog.jsonb_build_object('display_id', p_display.id, 'verification', p_verification,
                                      'member', private.member_ref(p_display.home_id, p_member),
                                      'outcome', v_outcome));
    end if;
    return query select v_outcome, v_action;
  end
  $$;

revoke all on function private.display_complete(private.household_displays, uuid, uuid, text)
  from public;

-- Whether a new PIN check on this display or from this client would go over S42's limits.
create function private.display_checks_throttled(p_display_id uuid, p_client_key text)
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_limits record := private.child_sign_in_limits();
  begin
    delete from private.display_checks c where c.created_at < pg_catalog.now() - interval '1 day';
    return (select count(*) from private.display_checks c
            where c.display_id = p_display_id and c.used_at is null
              and c.created_at > pg_catalog.now() - interval '1 hour')
             >= v_limits.device_failures_per_hour
       or (select count(*) from private.display_checks c
           where c.client_key = p_client_key and c.used_at is null
             and c.created_at > pg_catalog.now() - v_limits.client_window)
             >= v_limits.client_failures_per_window;
  end
  $$;

revoke all on function private.display_checks_throttled(uuid, text) from public;

-- The member's PIN for this Home's shared devices (a child's Home PIN, an adult's own device PIN),
-- locked for the check. Returns the hash and lock (both null: no PIN).
create function private.display_member_pin(p_home_id uuid, p_member uuid,
  out pin_hash text, out locked_until timestamptz)
  language plpgsql security definer set search_path = '' as $$
  begin
    if private.is_child(p_member) then
      select hp.pin_hash, hp.pin_locked_until into pin_hash, locked_until
        from private.child_home_pins hp
        where hp.home_id = p_home_id and hp.child_user_id = p_member for update;
    else
      select dp.pin_hash, dp.pin_locked_until into pin_hash, locked_until
        from private.member_device_pins dp where dp.user_id = p_member for update;
    end if;
  end
  $$;

revoke all on function private.display_member_pin(uuid, uuid) from public;

-- Clears a member's wrong-try count after a matched PIN (a guardian's lock stays).
create function private.display_pin_matched(p_home_id uuid, p_member uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  begin
    if private.is_child(p_member) then
      update private.child_home_pins hp
        set pin_failures = 0, pin_locks = 0, pin_locks_since = null, pin_locked_until = null
        where hp.home_id = p_home_id and hp.child_user_id = p_member
          and hp.pin_locked_until is distinct from 'infinity'::timestamptz;
    else
      update private.member_device_pins dp
        set pin_failures = 0, pin_locks = 0, pin_locks_since = null, pin_locked_until = null
        where dp.user_id = p_member
          and dp.pin_locked_until is distinct from 'infinity'::timestamptz;
    end if;
  end
  $$;

revoke all on function private.display_pin_matched(uuid, uuid) from public;

-- Step 1 of completing a chore on a display, as S42's shared_device_attempt. Also refused while the
-- display is locked ('display_locked') or its layout offers no actions ('actions_off').
-- Outcomes: the completion's own ('completed', 'submitted', 'already_completed', ...), 'check',
-- 'pin_required', 'pin_not_set', 'locked' (locked_until), 'rate_limited', 'not_eligible',
-- 'display_locked', 'actions_off', 'display_not_active'.
create function public.display_chore_attempt(
  p_display_id uuid, p_occurrence_id uuid, p_membership_id uuid, p_pin boolean, p_client_key text
) returns table (outcome text, action_id uuid, check_id uuid, pin_hash text, locked_until timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays;
    v_config private.display_configs;
    v_member uuid;
    v_pin record;
    v_check uuid;
    v_done record;
  begin
    perform private.check_child_client_key(p_client_key);
    v_display := private.active_display(p_display_id);
    if v_display.id is null then
      return query select 'display_not_active'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    v_config := private.display_config(v_display.id);
    if v_config.locked then
      return query select 'display_locked'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    if not private.display_actions_enabled(v_config.layout) then
      return query select 'actions_off'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    v_member := private.display_member(v_display.home_id, p_occurrence_id, p_membership_id);
    if v_member is null then
      return query select 'not_eligible'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    if not coalesce(p_pin, false) then
      if private.shared_device_pin_needed(v_display.home_id, v_member, p_occurrence_id) then
        return query select 'pin_required'::text, null::uuid, null::uuid, null::text,
          null::timestamptz;
        return;
      end if;
      select * into v_done from private.display_complete(v_display, p_occurrence_id, v_member,
                                                         'attributed');
      return query select v_done.outcome, v_done.action_id, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    if private.display_checks_throttled(v_display.id, p_client_key) then
      return query select 'rate_limited'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    v_pin := private.display_member_pin(v_display.home_id, v_member);
    if v_pin.pin_hash is null then
      return query select 'pin_not_set'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    if v_pin.locked_until > pg_catalog.now() then
      return query select 'locked'::text, null::uuid, null::uuid, null::text, v_pin.locked_until;
      return;
    end if;
    perform private.count_device_pin_failure(v_member, v_display.home_id);
    insert into private.display_checks (display_id, home_id, purpose, occurrence_id, member_user_id,
                                        client_key)
      values (v_display.id, v_display.home_id, 'chore', p_occurrence_id, v_member, p_client_key)
      returning id into v_check;
    return query select 'check'::text, null::uuid, v_check, v_pin.pin_hash, null::timestamptz;
  end
  $$;

revoke all on function public.display_chore_attempt(uuid, uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.display_chore_attempt(uuid, uuid, uuid, boolean, text)
  to service_role;

-- The fresh (two minutes), unused check of this display for this purpose, locked and marked used.
create function private.use_display_check(p_display_id uuid, p_check_id uuid, p_purpose text)
returns private.display_checks
  language plpgsql security definer set search_path = '' as $$
  declare
    v_check private.display_checks;
  begin
    select * into v_check from private.display_checks c where c.id = p_check_id for update;
    if v_check.id is null or v_check.display_id <> p_display_id or v_check.purpose <> p_purpose
       or v_check.used_at is not null
       or v_check.created_at <= pg_catalog.now() - interval '2 minutes' then
      return null;
    end if;
    update private.display_checks c set used_at = pg_catalog.now() where c.id = v_check.id;
    perform private.display_pin_matched(v_check.home_id, v_check.member_user_id);
    return v_check;
  end
  $$;

revoke all on function private.use_display_check(uuid, uuid, text) from public;

-- Step 2, after the web server matched the PIN: completes the chore as 'pin'. The display must
-- still be active, unlocked and offering actions, and the member still eligible.
create function public.display_chore_verified(p_display_id uuid, p_check_id uuid)
returns table (outcome text, action_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays := private.active_display(p_display_id);
    v_config private.display_configs;
    v_check private.display_checks;
  begin
    if v_display.id is null then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    v_check := private.use_display_check(v_display.id, p_check_id, 'chore');
    if v_check.id is null then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    v_config := private.display_config(v_display.id);
    if v_config.locked then
      return query select 'display_locked'::text, null::uuid;
      return;
    end if;
    if not private.display_actions_enabled(v_config.layout) then
      return query select 'actions_off'::text, null::uuid;
      return;
    end if;
    if private.display_member(v_display.home_id, v_check.occurrence_id,
                              private.member_ref(v_display.home_id, v_check.member_user_id)) is null then
      return query select 'not_eligible'::text, null::uuid;
      return;
    end if;
    return query select * from private.display_complete(v_display, v_check.occurrence_id,
                                                        v_check.member_user_id, 'pin');
  end
  $$;

revoke all on function public.display_chore_verified(uuid, uuid) from public, anon, authenticated;
grant execute on function public.display_chore_verified(uuid, uuid) to service_role;

-- Undo, from the same display within two minutes, as S42's shared_device_undo. Returns 'undone',
-- 'expired' or 'invalid'.
create function public.display_chore_undo(p_display_id uuid, p_action_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays := private.active_display(p_display_id);
    v_action private.display_actions;
    v_claims text;
    v_outcome text;
  begin
    select * into v_action from private.display_actions a where a.id = p_action_id for update;
    if v_display.id is null or v_action.id is null or v_action.display_id <> v_display.id
       or v_action.undone_at is not null or v_action.member_user_id is null
       or not private.is_home_member(v_display.home_id, v_action.member_user_id)
       or (private.display_config(v_display.id)).locked then
      return 'invalid';
    end if;
    if v_action.created_at <= pg_catalog.now() - interval '2 minutes' then
      return 'expired';
    end if;
    if (select o.revision from private.chore_occurrences o where o.id = v_action.occurrence_id
        for update) is distinct from v_action.occurrence_revision then
      return 'invalid';
    end if;
    v_claims := private.begin_device_actor(v_action.member_user_id, v_display.home_id,
                                           v_action.occurrence_id);
    select r.outcome into v_outcome from public.reopen_chore_occurrence(v_action.occurrence_id) r;
    perform private.end_device_actor(v_action.member_user_id, v_claims);
    if v_outcome not in ('reopened', 'already_open') then
      return 'invalid';
    end if;
    update private.display_actions a set undone_at = pg_catalog.now() where a.id = v_action.id;
    perform private.audit('chore_occurrence.display_undone', v_display.home_id, 'chore_occurrence',
      v_action.occurrence_id, pg_catalog.jsonb_build_object('display_id', v_display.id));
    return 'undone';
  end
  $$;

revoke all on function public.display_chore_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.display_chore_undo(uuid, uuid) to service_role;

-- Step 1 of locking the display on the display itself: a manager of the display's Home (Owner, or
-- Administrator with manageHomeSettings) confirms with their own household-device PIN, always.
-- Unlocking is never possible on the display (spec: privacy-mode unlock needs a manager's
-- independently authorized session): only set_household_display_lock unlocks.
-- Outcomes: 'check' (with the PIN hash for the web server), 'unchanged' (already locked),
-- 'not_permitted' (not a manager here), 'pin_not_set', 'locked' (the PIN is locked, locked_until),
-- 'rate_limited', 'display_not_active'.
create function public.display_lock_attempt(
  p_display_id uuid, p_membership_id uuid, p_client_key text
) returns table (outcome text, check_id uuid, pin_hash text, locked_until timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays;
    v_member uuid;
    v_pin record;
    v_check uuid;
  begin
    perform private.check_child_client_key(p_client_key);
    v_display := private.active_display(p_display_id);
    if v_display.id is null then
      return query select 'display_not_active'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if (private.display_config(v_display.id)).locked then
      return query select 'unchanged'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    select m.user_id into v_member from public.home_memberships m
      where m.id = p_membership_id and m.home_id = v_display.home_id;
    if v_member is null or not private.display_lock_manager(v_display.home_id, v_member) then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if private.display_checks_throttled(v_display.id, p_client_key) then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    v_pin := private.display_member_pin(v_display.home_id, v_member);
    if v_pin.pin_hash is null then
      return query select 'pin_not_set'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if v_pin.locked_until > pg_catalog.now() then
      return query select 'locked'::text, null::uuid, null::text, v_pin.locked_until;
      return;
    end if;
    perform private.count_device_pin_failure(v_member, v_display.home_id);
    insert into private.display_checks (display_id, home_id, purpose, member_user_id, client_key)
      values (v_display.id, v_display.home_id, 'lock', v_member, p_client_key)
      returning id into v_check;
    return query select 'check'::text, v_check, v_pin.pin_hash, null::timestamptz;
  end
  $$;

revoke all on function public.display_lock_attempt(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.display_lock_attempt(uuid, uuid, text) to service_role;

-- Step 2, after the web server matched the PIN: locks the display (keeping its welcome message), if
-- the member is still a manager there. Returns 'saved', 'unchanged', 'not_permitted' or 'invalid'.
create function public.display_lock_verified(p_display_id uuid, p_check_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays := private.active_display(p_display_id);
    v_check private.display_checks;
  begin
    if v_display.id is null then
      return 'invalid';
    end if;
    v_check := private.use_display_check(v_display.id, p_check_id, 'lock');
    if v_check.id is null then
      return 'invalid';
    end if;
    if not private.display_lock_manager(v_display.home_id, v_check.member_user_id) then
      return 'not_permitted';
    end if;
    return private.apply_display_lock(v_display.id, v_display.home_id, true,
      (private.display_config(v_display.id)).lock_message, v_check.member_user_id, 'display_pin');
  end
  $$;

revoke all on function public.display_lock_verified(uuid, uuid) from public, anon, authenticated;
grant execute on function public.display_lock_verified(uuid, uuid) to service_role;
