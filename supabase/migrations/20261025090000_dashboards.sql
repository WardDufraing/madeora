-- S17: the dashboard engine (brief S17; architecture.md §15; spec "Confirmed editable starter
-- personal dashboard for new adult accounts", "Confirmed selected Home widgets on the global personal
-- dashboard", "Confirmed dashboard ownership", "Agreed customization behavior").
--
-- A dashboard layout belongs either to one person (their personal dashboard) or to one Home (the
-- Home's shared dashboard). A person or Home without a saved row sees the current starter layout,
-- which lives in application code; the first save stores a concrete copy, so a later starter change
-- never overwrites a customized dashboard.
--
-- Who may change what (owner decisions, 2026-10-16):
-- - a personal dashboard: its owner only;
-- - a Home dashboard: every current member reads it; the Owner, and Administrators the Owner granted
--   the new capability manageHomeDashboard, save it;
-- - templates are private to their owner until shared into a Home. A personal-kind template may be
--   shared into any Home its owner belongs to; a home-kind template only into a Home whose dashboard
--   its owner may edit. Members of that Home see shared templates while the sharer still belongs to
--   it. Applying one is an ordinary save of the target dashboard, so the save rule above decides.
--
-- The layout's inner structure (widget types, positions, configuration) is validated by the
-- application's versioned Zod schema before every save; the database checks its shape and size, and
-- a reader re-validates and drops what it does not recognise. Nothing here is exposed as a table.

-- Audit subjects ----------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template'
  ));

-- The new Administrator capability ----------------------------------------------------------------

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard'
  );
  $$;

-- Limits ------------------------------------------------------------------------------------------

create function private.dashboard_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'layout_bytes' then 65536  -- one stored layout, as JSON text
    when 'templates' then 50         -- active templates per person
    when 'name_chars' then 80        -- a template name
  end;
  $$;

-- A layout's outer shape: an object with schema version 1, a widgets array and a placements object,
-- no larger than the limit. The application validates everything inside it.
create function private.is_dashboard_layout(p_layout jsonb) returns boolean
  language sql immutable set search_path = '' as $$
  -- Never null: a missing key must answer false, not slip past a "not" as null.
  select coalesce(
    pg_catalog.jsonb_typeof(p_layout) = 'object'
      and p_layout -> 'version' = '1'::jsonb
      and pg_catalog.jsonb_typeof(p_layout -> 'widgets') = 'array'
      and pg_catalog.jsonb_typeof(p_layout -> 'placements') = 'object'
      and pg_catalog.octet_length(p_layout::text) <= private.dashboard_limit('layout_bytes'),
    false);
  $$;

-- Who may save a Home's dashboard: the Owner, or an Administrator granted manageHomeDashboard
-- (packages/domain decideHomeAction "home.dashboard.edit" makes the same decision).
create function private.can_edit_home_dashboard(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.has_home_capability(p_home_id, p_user_id, 'manageHomeDashboard');
  $$;

create function private.is_home_member(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null and exists (
    select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_user_id
  );
  $$;

-- Layouts -----------------------------------------------------------------------------------------

create table private.dashboard_layouts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  layout jsonb not null
    constraint dashboard_layouts_layout_check check (private.is_dashboard_layout(layout)),
  -- Increases by one on every save; a save names the revision it started from (optimistic
  -- concurrency), so two editors never silently overwrite each other.
  revision integer not null default 1 constraint dashboard_layouts_revision_check check (revision >= 1),
  -- What the last reset or template apply replaced, for one-step Undo. Cleared by any other save.
  previous_layout jsonb
    constraint dashboard_layouts_previous_check
      check (previous_layout is null or private.is_dashboard_layout(previous_layout)),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint dashboard_layouts_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create unique index dashboard_layouts_user_idx on private.dashboard_layouts (owner_user_id)
  where owner_user_id is not null;
create unique index dashboard_layouts_home_idx on private.dashboard_layouts (owner_home_id)
  where owner_home_id is not null;

comment on table private.dashboard_layouts is
  'S17: saved personal and Home dashboard layouts. Not exposed through the API.';

alter table private.dashboard_layouts enable row level security;
revoke all on private.dashboard_layouts from public, anon, authenticated;

-- The caller's personal dashboard (p_home_id null) or a Home's dashboard. No row means "the starter
-- layout" (layout null, revision 0). can_edit says whether the caller may save it; can_undo whether a
-- reset or template apply can be undone. 42501 "not permitted" for a Home the caller does not belong
-- to, whether or not it exists.
create function public.get_dashboard(p_home_id uuid default null)
returns table (layout jsonb, revision integer, can_edit boolean, can_undo boolean, updated_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_row private.dashboard_layouts;
    v_can_edit boolean;
  begin
    if p_home_id is null then
      select * into v_row from private.dashboard_layouts d where d.owner_user_id = v_user_id;
      v_can_edit := true;
    else
      if not private.is_home_member(p_home_id, v_user_id) then
        raise exception 'not permitted' using errcode = '42501';
      end if;
      select * into v_row from private.dashboard_layouts d where d.owner_home_id = p_home_id;
      v_can_edit := private.can_edit_home_dashboard(p_home_id, v_user_id);
    end if;
    return query select v_row.layout, coalesce(v_row.revision, 0), v_can_edit,
      v_can_edit and v_row.previous_layout is not null, v_row.updated_at;
  end
  $$;

-- Saves a dashboard if nobody saved it since p_expected_revision (0: it was still the starter).
-- p_previous, when given, is what this save replaces (the layout the caller read at that revision,
-- or the starter it showed), kept for one-step Undo; a plain edit passes null and clears it.
-- Outcomes: 'saved' with the new revision, 'conflict' with the current one, 'not_permitted' (a Home
-- member who may not edit it). 42501 "not permitted" for a Home the caller does not belong to; 22023
-- for a malformed layout.
create function public.save_dashboard(
  p_layout jsonb, p_expected_revision integer, p_home_id uuid default null,
  p_previous jsonb default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_row private.dashboard_layouts;
    v_current integer;
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if not private.is_dashboard_layout(p_layout)
       or (p_previous is not null and not private.is_dashboard_layout(p_previous))
       or p_expected_revision is null or p_expected_revision < 0 then
      raise exception 'invalid layout' using errcode = '22023';
    end if;
    if p_home_id is not null and not private.can_edit_home_dashboard(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;

    if p_expected_revision = 0 then
      -- The first save. A concurrent first save makes this insert do nothing: a conflict.
      insert into private.dashboard_layouts (owner_user_id, owner_home_id, layout, previous_layout, updated_by)
        values (
          case when p_home_id is null then v_user_id end, p_home_id, p_layout, p_previous, v_user_id
        )
        on conflict do nothing
        returning * into v_row;
    else
      update private.dashboard_layouts d
        set layout = p_layout, previous_layout = p_previous, revision = d.revision + 1,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where (case when p_home_id is null then d.owner_user_id = v_user_id
          else d.owner_home_id = p_home_id end)
          and d.revision = p_expected_revision
        returning * into v_row;
    end if;

    if v_row.id is null then
      select d.revision into v_current from private.dashboard_layouts d
        where case when p_home_id is null then d.owner_user_id = v_user_id
          else d.owner_home_id = p_home_id end;
      return query select 'conflict', coalesce(v_current, 0);
      return;
    end if;
    if p_home_id is not null then
      -- Ids and counts only: never widget settings.
      perform private.audit('home_dashboard.saved', p_home_id, 'home', p_home_id,
        pg_catalog.jsonb_build_object(
          'revision', v_row.revision,
          'widgets', pg_catalog.jsonb_array_length(p_layout -> 'widgets'),
          'undoable', p_previous is not null));
    end if;
    return query select 'saved', v_row.revision;
  end
  $$;

-- Puts back what the last reset or template apply replaced. Outcomes: 'saved' with the new revision,
-- 'conflict' (someone saved since p_expected_revision), 'nothing_to_undo', 'not_permitted'.
create function public.undo_dashboard_change(p_expected_revision integer, p_home_id uuid default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_row private.dashboard_layouts;
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if p_home_id is not null and not private.can_edit_home_dashboard(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_row from private.dashboard_layouts d
      where case when p_home_id is null then d.owner_user_id = v_user_id
        else d.owner_home_id = p_home_id end
      for update;
    if v_row.id is null then
      return query select 'nothing_to_undo', 0;
      return;
    end if;
    if v_row.revision <> p_expected_revision then
      return query select 'conflict', v_row.revision;
      return;
    end if;
    if v_row.previous_layout is null then
      return query select 'nothing_to_undo', v_row.revision;
      return;
    end if;
    update private.dashboard_layouts d
      set layout = d.previous_layout, previous_layout = null, revision = d.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where d.id = v_row.id
      returning * into v_row;
    if p_home_id is not null then
      perform private.audit('home_dashboard.undone', p_home_id, 'home', p_home_id,
        pg_catalog.jsonb_build_object('revision', v_row.revision));
    end if;
    return query select 'saved', v_row.revision;
  end
  $$;

-- Templates ---------------------------------------------------------------------------------------

create table private.dashboard_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  -- Which dashboard it fits: a personal dashboard or a Home dashboard.
  kind text not null constraint dashboard_templates_kind_check check (kind in ('personal', 'home')),
  name text not null constraint dashboard_templates_name_check
    check (
      char_length(name) between 1 and private.dashboard_limit('name_chars')
      and name = pg_catalog.btrim(name)
      and name !~ '[[:cntrl:]]'
    ),
  layout jsonb not null
    constraint dashboard_templates_layout_check check (private.is_dashboard_layout(layout)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set while the template is in the owner's trash (S16).
  deleted_at timestamptz
);

create index dashboard_templates_owner_idx on private.dashboard_templates (owner_user_id)
  where deleted_at is null;

create table private.dashboard_template_shares (
  template_id uuid not null references private.dashboard_templates (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  shared_by uuid not null references auth.users (id) on delete cascade,
  shared_at timestamptz not null default now(),
  primary key (template_id, home_id)
);

create index dashboard_template_shares_home_idx on private.dashboard_template_shares (home_id);

comment on table private.dashboard_templates is
  'S17: dashboard templates, private to their owner until shared. Not exposed through the API.';
comment on table private.dashboard_template_shares is
  'S17: templates shared into a Home. Not exposed through the API.';

alter table private.dashboard_templates enable row level security;
alter table private.dashboard_template_shares enable row level security;
revoke all on private.dashboard_templates, private.dashboard_template_shares
  from public, anon, authenticated;

-- A share ends when the person who shared it leaves the Home (or is removed), so nothing of theirs
-- stays behind in a Home they no longer belong to.
create function private.end_departed_template_shares() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.dashboard_template_shares s
      where s.home_id = old.home_id and s.shared_by = old.user_id;
    return null;
  end
  $$;

create trigger home_memberships_end_template_shares
  after delete on public.home_memberships
  for each row execute function private.end_departed_template_shares();

-- Whether p_user_id may share a template of p_kind into p_home_id (owner decision "split by target").
create function private.can_share_template(p_kind text, p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'personal' then private.is_home_member(p_home_id, p_user_id)
    when 'home' then private.can_edit_home_dashboard(p_home_id, p_user_id)
    else false
  end;
  $$;

create function private.audit_template(
  p_action text, p_home_id uuid, p_template_id uuid
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids only: never the name or the layout.
  select private.audit(p_action, p_home_id, 'dashboard_template', p_template_id);
  $$;

-- The templates the caller may see: their own (with every Home they shared it into), and those
-- shared into a Home they belong to by someone who still belongs to it. p_home_id narrows the list
-- to templates shared into that Home (42501 "not permitted" when the caller is not a member).
-- shared_home_ids only ever lists Homes the caller belongs to. Never the sharer's identity.
create function public.list_dashboard_templates(p_home_id uuid default null)
returns table (
  template_id uuid, name text, kind text, layout jsonb, is_mine boolean, shared_home_ids uuid[],
  updated_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select t.id, t.name, t.kind, t.layout, t.owner_user_id = v_user_id,
        coalesce((
          select pg_catalog.array_agg(s.home_id order by s.home_id)
          from private.dashboard_template_shares s
          where s.template_id = t.id and private.is_home_member(s.home_id, v_user_id)
        ), '{}'),
        t.updated_at
      from private.dashboard_templates t
      where t.deleted_at is null
        and (
          (p_home_id is null and t.owner_user_id = v_user_id)
          or exists (
            select 1 from private.dashboard_template_shares s
            where s.template_id = t.id
              and (p_home_id is null or s.home_id = p_home_id)
              and private.is_home_member(s.home_id, v_user_id)
              and private.is_home_member(s.home_id, s.shared_by)
          )
        )
      order by t.owner_user_id = v_user_id desc, t.name, t.id;
  end
  $$;

-- Saves a new private template. Outcomes: 'created' with its id, 'limit_reached'. 22023 for an
-- invalid kind, name or layout.
create function public.create_dashboard_template(p_name text, p_kind text, p_layout jsonb)
returns table (outcome text, template_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
  begin
    if p_kind is null or p_kind not in ('personal', 'home') or not private.is_dashboard_layout(p_layout)
       or p_name is null or char_length(p_name) not between 1 and private.dashboard_limit('name_chars')
       or p_name <> pg_catalog.btrim(p_name) or p_name ~ '[[:cntrl:]]' then
      raise exception 'invalid template' using errcode = '22023';
    end if;
    -- One person's creates run one at a time, so two at once cannot pass the limit together.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dashboard_templates:' || v_user_id::text, 0));
    if (select pg_catalog.count(*) from private.dashboard_templates t
        where t.owner_user_id = v_user_id and t.deleted_at is null)
       >= private.dashboard_limit('templates') then
      return query select 'limit_reached', null::uuid;
      return;
    end if;
    insert into private.dashboard_templates (owner_user_id, kind, name, layout)
      values (v_user_id, p_kind, p_name, p_layout)
      returning id into v_id;
    return query select 'created', v_id;
  end
  $$;

-- Renames one of the caller's own templates. Outcomes: 'ok', 'not_found'.
create function public.rename_dashboard_template(p_template_id uuid, p_name text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_name is null or char_length(p_name) not between 1 and private.dashboard_limit('name_chars')
       or p_name <> pg_catalog.btrim(p_name) or p_name ~ '[[:cntrl:]]' then
      raise exception 'invalid name' using errcode = '22023';
    end if;
    update private.dashboard_templates t set name = p_name, updated_at = pg_catalog.now()
      where t.id = p_template_id and t.owner_user_id = v_user_id and t.deleted_at is null;
    return case when found then 'ok' else 'not_found' end;
  end
  $$;

-- Shares one of the caller's own templates into a Home. Outcomes: 'shared', 'unchanged',
-- 'not_permitted' (a member who may not share a template of this kind there), 'not_found' (not
-- their template, or not a Home they belong to).
create function public.share_dashboard_template(p_template_id uuid, p_home_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_template private.dashboard_templates;
  begin
    select * into v_template from private.dashboard_templates t
      where t.id = p_template_id and t.owner_user_id = v_user_id and t.deleted_at is null;
    if not found or not private.is_home_member(p_home_id, v_user_id) then
      return 'not_found';
    end if;
    if not private.can_share_template(v_template.kind, p_home_id, v_user_id) then
      return 'not_permitted';
    end if;
    insert into private.dashboard_template_shares (template_id, home_id, shared_by)
      values (v_template.id, p_home_id, v_user_id)
      on conflict do nothing;
    if not found then
      return 'unchanged';
    end if;
    perform private.audit_template('dashboard_template.shared', p_home_id, v_template.id);
    return 'shared';
  end
  $$;

-- Ends a template's share in a Home: its owner, or someone who may edit that Home's dashboard.
-- Outcomes: 'removed', 'not_found'.
create function public.unshare_dashboard_template(p_template_id uuid, p_home_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.is_home_member(p_home_id, v_user_id) then
      return 'not_found';
    end if;
    delete from private.dashboard_template_shares s
      using private.dashboard_templates t
      where s.template_id = p_template_id and s.home_id = p_home_id and t.id = s.template_id
        and (t.owner_user_id = v_user_id or private.can_edit_home_dashboard(p_home_id, v_user_id))
        -- Someone else's template in the trash is not visible, so it is not theirs to touch.
        and (t.deleted_at is null or t.owner_user_id = v_user_id);
    if not found then
      return 'not_found';
    end if;
    perform private.audit_template('dashboard_template.unshared', p_home_id, p_template_id);
    return 'removed';
  end
  $$;

-- Moves one of the caller's templates to their personal trash (S16): restorable for 7 days with its
-- shares, then purged. Returns the trash entry id, or null when it is not theirs or not found.
create function public.delete_dashboard_template(p_template_id uuid) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_template private.dashboard_templates;
  begin
    select * into v_template from private.dashboard_templates t
      where t.id = p_template_id and t.owner_user_id = v_user_id and t.deleted_at is null
      for update;
    if not found then
      return null;
    end if;
    update private.dashboard_templates t set deleted_at = pg_catalog.now() where t.id = v_template.id;
    return private.trash_move(
      v_user_id, 'dashboard', 'dashboard_template', v_template.id, v_user_id, null, v_template.name
    );
  end
  $$;

-- Trash hooks (S16) for the template type ---------------------------------------------------------

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard'));
alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in ('sample', 'dashboard_template'));

-- The four dispatch functions again, with a case for templates. A template has no restore conflict:
-- matching names never are one, and the per-person limit applies to creating, not to restoring.
create or replace function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_sample private.trash_samples;
  begin
    case p_entry.item_type
      when 'sample' then
        select * into v_sample from private.trash_samples s where s.id = p_entry.subject_id;
        if not found then
          return 'item_missing';
        end if;
        if v_sample.parent_id is not null and exists (
          select 1 from private.trash_samples p
          where p.id = v_sample.parent_id and p.deleted_at is not null
        ) then
          return 'parent_unavailable';
        end if;
        if v_sample.slot is not null and exists (
          select 1 from private.trash_samples o
          where o.id <> v_sample.id and o.deleted_at is null and o.slot = v_sample.slot
            and o.owner_user_id is not distinct from v_sample.owner_user_id
            and o.owner_home_id is not distinct from v_sample.owner_home_id
        ) then
          return 'slot_taken';
        end if;
        return null;
      when 'dashboard_template' then
        if not exists (
          select 1 from private.dashboard_templates t
          where t.id = p_entry.subject_id and t.deleted_at is not null
        ) then
          return 'item_missing';
        end if;
        return null;
    end case;
    return null;
  end
  $$;

create or replace function private.trash_resolve(p_entry private.trash_entries, p_resolution text)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    case p_entry.item_type
      when 'sample' then
        if p_resolution = 'clear_slot' then
          update private.trash_samples s set slot = null where s.id = p_entry.subject_id;
        elsif p_resolution = 'detach_parent' then
          update private.trash_samples s set parent_id = null where s.id = p_entry.subject_id;
        end if;
      when 'dashboard_template' then
        -- No conflicts, so nothing to resolve.
        null;
    end case;
  end
  $$;

create or replace function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
    v_lost integer := 0;
    v_lost_ids uuid[] := '{}';
    v_ref uuid;
  begin
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id
      order by ef.file_id
    loop
      if not private.restore_file(v_file_id) then
        v_lost := v_lost + 1;
        v_lost_ids := v_lost_ids || v_file_id;
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        -- The file the item uses must be usable too: it may have gone to the trash with another
        -- item that shared it (the last one deleted takes it along).
        select s.file_id into v_ref from private.trash_samples s where s.id = p_entry.subject_id;
        if v_ref is not null and not (v_ref = any (v_lost_ids)) and not private.restore_file(v_ref) then
          v_lost := v_lost + 1;
          v_lost_ids := v_lost_ids || v_ref;
        end if;
        update private.trash_samples s
          set deleted_at = null,
            -- A reference to a file that is gone would be broken: drop it, the caller reports it.
            file_id = case when s.file_id = any (v_lost_ids) then null else s.file_id end
          where s.id = p_entry.subject_id;
      when 'dashboard_template' then
        -- Its shares come back with it; a share into a Home the owner has since left was already
        -- ended by home_memberships_end_template_shares.
        update private.dashboard_templates t set deleted_at = null, updated_at = pg_catalog.now()
          where t.id = p_entry.subject_id;
    end case;
    return v_lost;
  end
  $$;

create or replace function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
  begin
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id
      order by ef.file_id
    loop
      -- Never release a file another active item still uses.
      if not exists (
        select 1 from private.trash_samples s where s.file_id = v_file_id and s.deleted_at is null
      ) then
        perform private.purge_file_now(v_file_id);
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        delete from private.trash_samples s where s.id = p_entry.subject_id and s.deleted_at is not null;
      when 'dashboard_template' then
        -- Its shares go with it (on delete cascade).
        delete from private.dashboard_templates t
          where t.id = p_entry.subject_id and t.deleted_at is not null;
    end case;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.get_dashboard(uuid)',
    'public.save_dashboard(jsonb, integer, uuid, jsonb)',
    'public.undo_dashboard_change(integer, uuid)',
    'public.list_dashboard_templates(uuid)',
    'public.create_dashboard_template(text, text, jsonb)',
    'public.rename_dashboard_template(uuid, text)',
    'public.share_dashboard_template(uuid, uuid)',
    'public.unshare_dashboard_template(uuid, uuid)',
    'public.delete_dashboard_template(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.is_delegable_capability(text)',
    'private.dashboard_limit(text)',
    'private.is_dashboard_layout(jsonb)',
    'private.can_edit_home_dashboard(uuid, uuid)',
    'private.is_home_member(uuid, uuid)',
    'private.end_departed_template_shares()',
    'private.can_share_template(text, uuid, uuid)',
    'private.audit_template(text, uuid, uuid)',
    'private.trash_conflict(private.trash_entries)',
    'private.trash_resolve(private.trash_entries, text)',
    'private.trash_item_restore(private.trash_entries)',
    'private.trash_item_purge(private.trash_entries)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
