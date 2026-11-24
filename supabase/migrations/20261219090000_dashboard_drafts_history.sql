-- UX2-data: the data layer for the dashboard redesign (plans/steps/UX2-data-brief.md;
-- docs/design/dashboard-ux-ui-redesign.md Decisions 6, 32, 33, 34; plans/steps/UX00-redesign-plan-brief.md
-- section 7). No UI uses it yet; UX2b-UX2d build on these functions.
--
-- Three dashboard "targets" exist from now on:
-- - personal: the caller's own personal dashboard (unchanged);
-- - default:  a Home's shared default dashboard (the S17 Home dashboard, unchanged rules: every member
--             reads it, the Owner and Administrators granted manageHomeDashboard save it);
-- - mine:     the caller's optional personal view of one Home ("My Home view", Decision 33). Only its
--             owner reads or saves it; it ends when they leave the Home (or the Home or account is
--             deleted). It stores an arrangement only: widget data is still read through each
--             module's own permission checks, so an override never widens access.
--
-- New, all private and reachable only through the security-definer functions below:
-- - dashboard_drafts: one recoverable edit draft per person and target (Decision 6), kept for
--   private.dashboard_limit('draft_days') days after its last autosave, then purged;
-- - dashboard_member_overrides: "My Home view" layouts with their own revision and one-step Undo;
-- - dashboard_layout_versions: the 10 most recent committed layouts per target (Decision 32), written
--   from the stored row inside the commit, never from a client-supplied copy.
--
-- Backward compatible: existing callers of get_dashboard / save_dashboard / undo_dashboard_change pass
-- no target and keep today's behaviour (personal, or the Home's shared default).

-- Limits ------------------------------------------------------------------------------------------

create or replace function private.dashboard_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'layout_bytes' then 65536  -- one stored layout, as JSON text
    when 'templates' then 50         -- active templates per person
    when 'name_chars' then 80        -- a template name
    when 'versions' then 10          -- committed layouts kept per target (Decision 32)
    when 'draft_days' then 30        -- days a draft is kept after its last autosave
    when 'known_widgets' then 400    -- shared-default widget ids remembered per override
  end;
  $$;

-- Who may keep drafts and a personal Home view: adults. Children and Household Display accounts
-- keep today's behaviour and cannot customize (UX00 brief section 7, default "adults only").
create function private.can_customize_dashboard(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and not private.is_child(p_user_id) and not private.is_display(p_user_id);
  $$;

-- Resolves (Home, target) for the caller: 'personal', 'default' or 'mine'. p_target null means the
-- legacy meaning (personal without a Home, the shared default with one); 'effective' (reads only)
-- means the caller's Home view when they have one, otherwise the shared default. 42501 "not
-- permitted" for a Home the caller does not belong to, whether or not it exists; 22023 for an
-- unknown target or a target that needs a Home without one.
create function private.dashboard_target(
  p_home_id uuid, p_target text, p_user_id uuid, p_allow_effective boolean
) returns text
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is null then
      if p_target is not null and p_target <> 'personal' then
        raise exception 'invalid target' using errcode = '22023';
      end if;
      return 'personal';
    end if;
    if not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if p_target is null or p_target = 'default' then
      return 'default';
    elsif p_target = 'mine' then
      return 'mine';
    elsif p_target = 'effective' and p_allow_effective then
      return case when exists (
          select 1 from private.dashboard_member_overrides o
          where o.home_id = p_home_id and o.user_id = p_user_id
        ) then 'mine' else 'default' end;
    end if;
    raise exception 'invalid target' using errcode = '22023';
  end
  $$;

-- Whether p_user_id may save p_target (already resolved, membership already checked).
create function private.can_save_dashboard_target(p_home_id uuid, p_target text, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select case p_target
    when 'personal' then true
    when 'default' then private.can_edit_home_dashboard(p_home_id, p_user_id)
    when 'mine' then private.can_customize_dashboard(p_user_id)
    else false
  end;
  $$;

-- The widget ids of a layout (ids the application did not write as uuids are ignored).
create function private.dashboard_widget_ids(p_layout jsonb) returns uuid[]
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(distinct (w ->> 'id')::uuid), '{}')
  from pg_catalog.jsonb_array_elements(
    case when pg_catalog.jsonb_typeof(p_layout -> 'widgets') = 'array' then p_layout -> 'widgets'
    else '[]'::jsonb end) w
  where w ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  $$;

-- Personal Home views ("My Home view", Decision 33) -----------------------------------------------

create table private.dashboard_member_overrides (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null,
  user_id uuid not null,
  layout jsonb not null
    constraint dashboard_member_overrides_layout_check check (private.is_dashboard_layout(layout)),
  revision integer not null default 1
    constraint dashboard_member_overrides_revision_check check (revision >= 1),
  -- What the last reset, template apply or restore replaced, for one-step Undo (as dashboard_layouts).
  previous_layout jsonb
    constraint dashboard_member_overrides_previous_check
      check (previous_layout is null or private.is_dashboard_layout(previous_layout)),
  -- Shared-default widgets this member has already seen or dismissed: never suggested again
  -- (Decision 34). Set when the view is created; grows by dismissals; pruned to the current default.
  known_default_widget_ids uuid[] not null default '{}'
    constraint dashboard_member_overrides_known_check
      check (pg_catalog.cardinality(known_default_widget_ids) <= private.dashboard_limit('known_widgets')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_member_overrides_home_user_key unique (home_id, user_id),
  -- A view belongs to the membership: leaving, removal, Home deletion and account deletion end it.
  constraint dashboard_member_overrides_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

create index dashboard_member_overrides_user_idx on private.dashboard_member_overrides (user_id);

comment on table private.dashboard_member_overrides is
  'UX2-data: a member''s personal view of a Home dashboard. Owner-only. Not exposed through the API.';

alter table private.dashboard_member_overrides enable row level security;
revoke all on private.dashboard_member_overrides from public, anon, authenticated;

-- Drafts (Decision 6) -----------------------------------------------------------------------------

create table private.dashboard_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  home_id uuid references public.homes (id) on delete cascade,
  target text not null
    constraint dashboard_drafts_target_check check (target in ('personal', 'default', 'mine')),
  layout jsonb not null
    constraint dashboard_drafts_layout_check check (private.is_dashboard_layout(layout)),
  -- The committed revision the draft started from (0: the starter). When the target has moved on,
  -- the UI offers rebase-or-discard; a draft never overwrites a newer commit silently.
  base_revision integer not null constraint dashboard_drafts_base_check check (base_revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dashboard_drafts_target_home_check check ((target = 'personal') = (home_id is null)),
  constraint dashboard_drafts_one_per_target unique nulls not distinct (user_id, target, home_id),
  -- A Home draft belongs to the membership: it ends with it (not enforced for personal drafts,
  -- whose home_id is null; those end with the account).
  constraint dashboard_drafts_membership_fkey foreign key (home_id, user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

create index dashboard_drafts_home_idx on private.dashboard_drafts (home_id) where home_id is not null;
create index dashboard_drafts_updated_idx on private.dashboard_drafts (updated_at);

comment on table private.dashboard_drafts is
  'UX2-data: recoverable dashboard edit drafts, one per person and target, purged after '
  'dashboard_limit(''draft_days'') days. Owner-only. Not exposed through the API.';

alter table private.dashboard_drafts enable row level security;
revoke all on private.dashboard_drafts from public, anon, authenticated;

-- Losing the right to edit a Home's shared default discards one's draft of it (a draft of "My Home
-- view" stays: that needs only membership). Covers a revoked manageHomeDashboard grant, a demotion
-- (which drops every grant) and an Owner handing over ownership.
create function private.discard_unpermitted_default_drafts() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.dashboard_drafts d
      where d.home_id = old.home_id and d.user_id = old.user_id and d.target = 'default'
        and not private.can_edit_home_dashboard(old.home_id, old.user_id);
    return null;
  end
  $$;

create trigger home_admin_capabilities_discard_dashboard_drafts
  after delete on private.home_admin_capabilities
  for each row when (old.capability = 'manageHomeDashboard')
  execute function private.discard_unpermitted_default_drafts();

create trigger home_memberships_discard_dashboard_drafts
  after update of role on private.home_memberships_all
  for each row when (old.role is distinct from new.role)
  execute function private.discard_unpermitted_default_drafts();

-- Version history (Decision 32) -------------------------------------------------------------------

create table private.dashboard_layout_versions (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one: a personal or shared-default layout row, or a personal Home view. Deleting that
  -- row (account, Home, membership or view reset) deletes its history.
  layout_id uuid references private.dashboard_layouts (id) on delete cascade,
  override_id uuid references private.dashboard_member_overrides (id) on delete cascade,
  revision integer not null constraint dashboard_layout_versions_revision_check check (revision >= 1),
  layout jsonb not null
    constraint dashboard_layout_versions_layout_check check (private.is_dashboard_layout(layout)),
  -- What made this commit: an edit or template apply ('save'), Undo ('undo'), a history restore
  -- ('restore').
  reason text not null
    constraint dashboard_layout_versions_reason_check check (reason in ('save', 'undo', 'restore')),
  -- Shared-default versions only (a personal or Home-view version is always its owner's): never
  -- shown, only "saved by me" is. Cleared when that account is deleted. Kept null elsewhere so an
  -- account deletion has one cascade path per row (owner row -> versions), not a competing set-null.
  saved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint dashboard_layout_versions_one_target check (num_nonnulls(layout_id, override_id) = 1)
);

create unique index dashboard_layout_versions_layout_idx
  on private.dashboard_layout_versions (layout_id, revision) where layout_id is not null;
create unique index dashboard_layout_versions_override_idx
  on private.dashboard_layout_versions (override_id, revision) where override_id is not null;
create index dashboard_layout_versions_saved_by_idx
  on private.dashboard_layout_versions (saved_by) where saved_by is not null;

comment on table private.dashboard_layout_versions is
  'UX2-data: the 10 most recent committed layouts per dashboard target. Not exposed through the API.';

alter table private.dashboard_layout_versions enable row level security;
revoke all on private.dashboard_layout_versions from public, anon, authenticated;

-- Records the committed layout as a version and keeps only the newest dashboard_limit('versions').
create function private.record_dashboard_version(
  p_layout_id uuid, p_override_id uuid, p_revision integer, p_layout jsonb, p_reason text,
  p_user_id uuid
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    insert into private.dashboard_layout_versions (layout_id, override_id, revision, layout, reason, saved_by)
      values (p_layout_id, p_override_id, p_revision, p_layout, p_reason, p_user_id);
    delete from private.dashboard_layout_versions v
      where v.id in (
        select x.id from private.dashboard_layout_versions x
        where (p_layout_id is not null and x.layout_id = p_layout_id)
           or (p_override_id is not null and x.override_id = p_override_id)
        order by x.revision desc
        offset private.dashboard_limit('versions'));
  end
  $$;

-- The one commit path ------------------------------------------------------------------------------

-- Commits p_layout to a resolved target if nobody committed since p_expected_revision (0: still the
-- starter or, for 'mine', no view yet). Permission and membership are the caller's job. Writes the
-- version and, for the shared default, the audit event. Returns ('saved', new revision) or
-- ('conflict', current revision).
create function private.commit_dashboard(
  p_user_id uuid, p_home_id uuid, p_target text, p_layout jsonb, p_expected_revision integer,
  p_previous jsonb, p_reason text
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row private.dashboard_layouts;
    v_view private.dashboard_member_overrides;
    v_current integer;
    v_default jsonb;
  begin
    if p_target = 'mine' then
      if p_expected_revision = 0 then
        -- What the member sees when the view starts: never offered again as a suggestion.
        select d.layout into v_default from private.dashboard_layouts d where d.owner_home_id = p_home_id;
        insert into private.dashboard_member_overrides
            (home_id, user_id, layout, previous_layout, known_default_widget_ids)
          values (p_home_id, p_user_id, p_layout, p_previous,
            (select coalesce(pg_catalog.array_agg(distinct i), '{}') from pg_catalog.unnest(
              private.dashboard_widget_ids(v_default) || private.dashboard_widget_ids(p_layout)) i))
          on conflict do nothing
          returning * into v_view;
      else
        update private.dashboard_member_overrides o
          set layout = p_layout, previous_layout = p_previous, revision = o.revision + 1,
            updated_at = pg_catalog.now()
          where o.home_id = p_home_id and o.user_id = p_user_id and o.revision = p_expected_revision
          returning * into v_view;
      end if;
      if v_view.id is null then
        select o.revision into v_current from private.dashboard_member_overrides o
          where o.home_id = p_home_id and o.user_id = p_user_id;
        return query select 'conflict', coalesce(v_current, 0);
        return;
      end if;
      perform private.record_dashboard_version(null, v_view.id, v_view.revision, v_view.layout,
        p_reason, null);
      return query select 'saved', v_view.revision;
      return;
    end if;

    if p_expected_revision = 0 then
      -- The first save. A concurrent first save makes this insert do nothing: a conflict.
      insert into private.dashboard_layouts (owner_user_id, owner_home_id, layout, previous_layout, updated_by)
        values (
          case when p_target = 'personal' then p_user_id end,
          case when p_target = 'default' then p_home_id end,
          p_layout, p_previous, p_user_id
        )
        on conflict do nothing
        returning * into v_row;
    else
      update private.dashboard_layouts d
        set layout = p_layout, previous_layout = p_previous, revision = d.revision + 1,
          updated_by = p_user_id, updated_at = pg_catalog.now()
        where (case when p_target = 'personal' then d.owner_user_id = p_user_id
          else d.owner_home_id = p_home_id end)
          and d.revision = p_expected_revision
        returning * into v_row;
    end if;

    if v_row.id is null then
      select d.revision into v_current from private.dashboard_layouts d
        where case when p_target = 'personal' then d.owner_user_id = p_user_id
          else d.owner_home_id = p_home_id end;
      return query select 'conflict', coalesce(v_current, 0);
      return;
    end if;
    -- From the stored row, never from a client-supplied copy.
    perform private.record_dashboard_version(v_row.id, null, v_row.revision, v_row.layout,
      p_reason, case when p_target = 'default' then p_user_id end);
    if p_target = 'default' then
      -- Ids and counts only: never widget settings.
      perform private.audit(
        case p_reason when 'undo' then 'home_dashboard.undone'
          when 'restore' then 'home_dashboard.restored' else 'home_dashboard.saved' end,
        p_home_id, 'home', p_home_id,
        pg_catalog.jsonb_build_object(
          'revision', v_row.revision,
          'widgets', pg_catalog.jsonb_array_length(v_row.layout -> 'widgets'),
          'undoable', v_row.previous_layout is not null));
    end if;
    return query select 'saved', v_row.revision;
  end
  $$;

-- The caller's live draft of a resolved target, or null. An expired draft, or a shared-default draft
-- its author may no longer commit, is deleted on the way.
create function private.live_dashboard_draft(p_user_id uuid, p_home_id uuid, p_target text)
returns private.dashboard_drafts
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_draft private.dashboard_drafts;
  begin
    select * into v_draft from private.dashboard_drafts d
      where d.user_id = p_user_id and d.target = p_target and d.home_id is not distinct from p_home_id;
    if v_draft.id is null then
      return null;
    end if;
    if v_draft.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => private.dashboard_limit('draft_days'))
       or not private.can_save_dashboard_target(p_home_id, p_target, p_user_id) then
      delete from private.dashboard_drafts d where d.id = v_draft.id;
      return null;
    end if;
    return v_draft;
  end
  $$;

-- Public functions: dashboards (replacing the S17 signatures) ------------------------------------

drop function public.get_dashboard(uuid);
drop function public.save_dashboard(jsonb, integer, uuid, jsonb);
drop function public.undo_dashboard_change(integer, uuid);

-- A dashboard as the caller may see it. p_target (Home only): null or 'default' for the shared
-- default, 'mine' for the caller's Home view, 'effective' for their view when they have one and the
-- shared default otherwise. No row means "the starter" (layout null, revision 0); for 'mine' it means
-- "no view yet". target says which one answered; has_override whether the caller has a view of this
-- Home; has_draft whether they have a recoverable draft of the answered target. 42501 "not
-- permitted" for a Home the caller does not belong to; 22023 for an unknown target.
-- Stable callers (S17) pass no target and get the same answer as before plus the new columns.
create function public.get_dashboard(p_home_id uuid default null, p_target text default null)
returns table (
  layout jsonb, revision integer, can_edit boolean, can_undo boolean, updated_at timestamptz,
  target text, has_override boolean, has_draft boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, true);
    v_layout jsonb;
    v_revision integer;
    v_previous jsonb;
    v_updated timestamptz;
    v_can_edit boolean := private.can_save_dashboard_target(p_home_id, v_target, v_user_id);
  begin
    if v_target = 'mine' then
      select o.layout, o.revision, o.previous_layout, o.updated_at
        into v_layout, v_revision, v_previous, v_updated
        from private.dashboard_member_overrides o
        where o.home_id = p_home_id and o.user_id = v_user_id;
    else
      select d.layout, d.revision, d.previous_layout, d.updated_at
        into v_layout, v_revision, v_previous, v_updated
        from private.dashboard_layouts d
        where case when v_target = 'personal' then d.owner_user_id = v_user_id
          else d.owner_home_id = p_home_id end;
    end if;
    return query select v_layout, coalesce(v_revision, 0), v_can_edit,
      v_can_edit and v_previous is not null, v_updated, v_target,
      p_home_id is not null and exists (
        select 1 from private.dashboard_member_overrides o
        where o.home_id = p_home_id and o.user_id = v_user_id),
      -- Read-only here: expiry and revocation are applied by get_dashboard_draft.
      v_can_edit and exists (
        select 1 from private.dashboard_drafts d
        where d.user_id = v_user_id and d.target = v_target
          and d.home_id is not distinct from p_home_id
          and d.updated_at >= pg_catalog.now()
            - pg_catalog.make_interval(days => private.dashboard_limit('draft_days')));
  end
  $$;

-- Commits a dashboard if nobody saved it since p_expected_revision (0: it was still the starter, or
-- for 'mine' the caller had no view yet). p_target as get_dashboard, without 'effective'.
-- p_previous, when given, is what this save replaces, kept for one-step Undo; a plain edit passes
-- null and clears it. p_commit_draft discards the caller's draft of this target in the same
-- transaction when the save succeeds (Done); on a conflict the draft stays. Outcomes: 'saved' with
-- the new revision, 'conflict' with the current one, 'not_permitted'. 42501 "not permitted" for a
-- Home the caller does not belong to; 22023 for a malformed layout or target.
create function public.save_dashboard(
  p_layout jsonb, p_expected_revision integer, p_home_id uuid default null,
  p_previous jsonb default null, p_target text default null, p_commit_draft boolean default false
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, false);
    v_result record;
  begin
    if not private.is_dashboard_layout(p_layout)
       or (p_previous is not null and not private.is_dashboard_layout(p_previous))
       or p_expected_revision is null or p_expected_revision < 0 or p_commit_draft is null then
      raise exception 'invalid layout' using errcode = '22023';
    end if;
    if not private.can_save_dashboard_target(p_home_id, v_target, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_result from private.commit_dashboard(
      v_user_id, p_home_id, v_target, p_layout, p_expected_revision, p_previous, 'save') c;
    if v_result.outcome = 'saved' and p_commit_draft then
      delete from private.dashboard_drafts d
        where d.user_id = v_user_id and d.target = v_target and d.home_id is not distinct from p_home_id;
    end if;
    return query select v_result.outcome, v_result.revision;
  end
  $$;

-- Puts back what the last reset, template apply or restore replaced. Outcomes: 'saved' with the new
-- revision, 'conflict' (someone saved since p_expected_revision), 'nothing_to_undo', 'not_permitted'.
create function public.undo_dashboard_change(
  p_expected_revision integer, p_home_id uuid default null, p_target text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, false);
    v_revision integer;
    v_previous jsonb;
  begin
    if not private.can_save_dashboard_target(p_home_id, v_target, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_target = 'mine' then
      select o.revision, o.previous_layout into v_revision, v_previous
        from private.dashboard_member_overrides o
        where o.home_id = p_home_id and o.user_id = v_user_id
        for update;
    else
      select d.revision, d.previous_layout into v_revision, v_previous
        from private.dashboard_layouts d
        where case when v_target = 'personal' then d.owner_user_id = v_user_id
          else d.owner_home_id = p_home_id end
        for update;
    end if;
    if v_revision is null then
      return query select 'nothing_to_undo', 0;
      return;
    end if;
    if v_revision <> p_expected_revision then
      return query select 'conflict', v_revision;
      return;
    end if;
    if v_previous is null then
      return query select 'nothing_to_undo', v_revision;
      return;
    end if;
    return query select * from private.commit_dashboard(
      v_user_id, p_home_id, v_target, v_previous, v_revision, null, 'undo');
  end
  $$;

-- Public functions: drafts ------------------------------------------------------------------------

-- The caller's recoverable draft of a dashboard target, or no row. current_revision is the target's
-- committed revision now: when it differs from base_revision, someone committed since the draft
-- started and the UI offers rebase-or-discard. A shared-default draft whose author lost the right to
-- edit, or an expired draft, is discarded and not returned. 42501 / 22023 as get_dashboard.
create function public.get_dashboard_draft(p_home_id uuid default null, p_target text default null)
returns table (
  layout jsonb, base_revision integer, current_revision integer, updated_at timestamptz,
  expires_at timestamptz
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, false);
    v_draft private.dashboard_drafts := private.live_dashboard_draft(v_user_id, p_home_id, v_target);
    v_current integer;
  begin
    if v_draft.id is null then
      return;
    end if;
    if v_target = 'mine' then
      select o.revision into v_current from private.dashboard_member_overrides o
        where o.home_id = p_home_id and o.user_id = v_user_id;
    else
      select d.revision into v_current from private.dashboard_layouts d
        where case when v_target = 'personal' then d.owner_user_id = v_user_id
          else d.owner_home_id = p_home_id end;
    end if;
    return query select v_draft.layout, v_draft.base_revision, coalesce(v_current, 0),
      v_draft.updated_at,
      v_draft.updated_at + pg_catalog.make_interval(days => private.dashboard_limit('draft_days'));
  end
  $$;

-- Autosaves the caller's draft of a dashboard target (one per person and target; a later autosave
-- replaces it). Never touches the committed dashboard. Outcomes: 'saved' with the stored time,
-- 'not_permitted' (may not save that target). 42501 / 22023 as save_dashboard. Also purges a
-- bounded batch of anyone's expired drafts, so abandoned drafts do not outlive the retention period
-- while the feature is in use.
create function public.save_dashboard_draft(
  p_layout jsonb, p_base_revision integer, p_home_id uuid default null, p_target text default null
) returns table (outcome text, updated_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, false);
    v_updated timestamptz;
  begin
    if not private.is_dashboard_layout(p_layout) or p_base_revision is null or p_base_revision < 0 then
      raise exception 'invalid layout' using errcode = '22023';
    end if;
    if not private.can_customize_dashboard(v_user_id)
       or not private.can_save_dashboard_target(p_home_id, v_target, v_user_id) then
      return query select 'not_permitted', null::timestamptz;
      return;
    end if;
    perform private.purge_expired_dashboard_drafts(100);
    insert into private.dashboard_drafts as d (user_id, home_id, target, layout, base_revision)
      values (v_user_id, p_home_id, v_target, p_layout, p_base_revision)
      on conflict on constraint dashboard_drafts_one_per_target do update
        set layout = excluded.layout, base_revision = excluded.base_revision,
          updated_at = pg_catalog.now()
      returning d.updated_at into v_updated;
    return query select 'saved', v_updated;
  end
  $$;

-- Discards the caller's draft of a dashboard target (Cancel / Discard draft). Outcomes: 'discarded',
-- 'nothing_to_discard'. Always allowed for one's own draft, even after losing edit rights.
create function public.discard_dashboard_draft(p_home_id uuid default null, p_target text default null)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, false);
  begin
    delete from private.dashboard_drafts d
      where d.user_id = v_user_id and d.target = v_target and d.home_id is not distinct from p_home_id;
    return case when found then 'discarded' else 'nothing_to_discard' end;
  end
  $$;

-- Deletes up to p_limit drafts older than the retention period; returns how many. Called by
-- save_dashboard_draft; a later scheduled job can call it through a public service-role wrapper.
create function private.purge_expired_dashboard_drafts(p_limit integer default 1000) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    delete from private.dashboard_drafts d
      where d.id in (
        select x.id from private.dashboard_drafts x
        where x.updated_at < pg_catalog.now()
          - pg_catalog.make_interval(days => private.dashboard_limit('draft_days'))
        order by x.updated_at
        limit greatest(coalesce(p_limit, 0), 0));
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;

-- Public functions: history -----------------------------------------------------------------------

-- The committed versions of a dashboard target, newest first (at most dashboard_limit('versions')).
-- Personal and 'mine': the caller's own. 'default': only someone who may edit it (other members see
-- the current shared default, not its history). Never who saved a version, only whether it was the
-- caller. Outcome rows only; 'not_permitted' raises 42501 like a foreign Home.
create function public.list_dashboard_versions(p_home_id uuid default null, p_target text default null)
returns table (
  version_id uuid, revision integer, layout jsonb, reason text, saved_by_me boolean,
  created_at timestamptz, is_current boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target text := private.dashboard_target(p_home_id, p_target, v_user_id, false);
    v_layout_id uuid;
    v_override_id uuid;
    v_current integer;
  begin
    if not private.can_save_dashboard_target(p_home_id, v_target, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if v_target = 'mine' then
      select o.id, o.revision into v_override_id, v_current from private.dashboard_member_overrides o
        where o.home_id = p_home_id and o.user_id = v_user_id;
    else
      select d.id, d.revision into v_layout_id, v_current from private.dashboard_layouts d
        where case when v_target = 'personal' then d.owner_user_id = v_user_id
          else d.owner_home_id = p_home_id end;
    end if;
    return query
      select v.id, v.revision, v.layout, v.reason,
        case when v_target = 'default' then v.saved_by is not distinct from v_user_id else true end,
        v.created_at, v.revision = v_current
      from private.dashboard_layout_versions v
      where (v_layout_id is not null and v.layout_id = v_layout_id)
         or (v_override_id is not null and v.override_id = v_override_id)
      order by v.revision desc;
  end
  $$;

-- Restores a version as a new commit (Decision 32: the replaced layout stays in history and can be
-- undone once). p_expected_revision is the target's revision the caller saw. Outcomes: 'saved' with
-- the new revision, 'conflict' with the current one, 'not_found' (no such version of a target the
-- caller may restore: never reveals another person's or Home's history), 'not_permitted'
-- (a member of the Home who may not edit its shared default).
create function public.restore_dashboard_version(p_version_id uuid, p_expected_revision integer)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_version private.dashboard_layout_versions;
    v_row private.dashboard_layouts;
    v_view private.dashboard_member_overrides;
    v_home_id uuid;
    v_target text;
    v_current jsonb;
    v_revision integer;
  begin
    if p_expected_revision is null or p_expected_revision < 1 then
      raise exception 'invalid revision' using errcode = '22023';
    end if;
    select * into v_version from private.dashboard_layout_versions v where v.id = p_version_id;
    if v_version.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_version.override_id is not null then
      select * into v_view from private.dashboard_member_overrides o
        where o.id = v_version.override_id for update;
      if v_view.user_id is distinct from v_user_id then
        return query select 'not_found', null::integer;
        return;
      end if;
      v_target := 'mine';
      v_home_id := v_view.home_id;
      v_current := v_view.layout;
      v_revision := v_view.revision;
    else
      select * into v_row from private.dashboard_layouts d where d.id = v_version.layout_id for update;
      if v_row.owner_user_id is not null then
        if v_row.owner_user_id <> v_user_id then
          return query select 'not_found', null::integer;
          return;
        end if;
        v_target := 'personal';
      else
        if not private.is_home_member(v_row.owner_home_id, v_user_id) then
          return query select 'not_found', null::integer;
          return;
        end if;
        v_target := 'default';
        v_home_id := v_row.owner_home_id;
      end if;
      v_current := v_row.layout;
      v_revision := v_row.revision;
    end if;
    if not private.can_save_dashboard_target(v_home_id, v_target, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_revision <> p_expected_revision then
      return query select 'conflict', v_revision;
      return;
    end if;
    return query select * from private.commit_dashboard(
      v_user_id, v_home_id, v_target, v_version.layout, v_revision, v_current, 'restore');
  end
  $$;

-- Public functions: personal Home views and suggestions (Decisions 33, 34) ------------------------

-- Ends the caller's personal view of a Home: they see the shared default again. Its history and
-- their draft of it go too. Outcomes: 'reset', 'nothing_to_reset'. 42501 for a foreign Home.
create function public.reset_dashboard_override(p_home_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_home_id is null then
      raise exception 'invalid target' using errcode = '22023';
    end if;
    perform private.dashboard_target(p_home_id, 'mine', v_user_id, false);
    delete from private.dashboard_drafts d
      where d.user_id = v_user_id and d.home_id = p_home_id and d.target = 'mine';
    delete from private.dashboard_member_overrides o
      where o.home_id = p_home_id and o.user_id = v_user_id;
    return case when found then 'reset' else 'nothing_to_reset' end;
  end
  $$;

-- Widgets of the Home's shared default that the caller's personal view lacks and that they have
-- neither seen when the view started nor dismissed (Decision 34). One row per widget, in the shared
-- default's order, with the widget entry as stored there (the shared default is readable by every
-- member). No rows without a personal view. 42501 for a foreign Home.
create function public.list_dashboard_suggestions(p_home_id uuid)
returns table (widget_id uuid, widget jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_view private.dashboard_member_overrides;
    v_default jsonb;
  begin
    if p_home_id is null then
      raise exception 'invalid target' using errcode = '22023';
    end if;
    perform private.dashboard_target(p_home_id, 'mine', v_user_id, false);
    select * into v_view from private.dashboard_member_overrides o
      where o.home_id = p_home_id and o.user_id = v_user_id;
    if v_view.id is null then
      return;
    end if;
    select d.layout into v_default from private.dashboard_layouts d where d.owner_home_id = p_home_id;
    return query
      select (w.value ->> 'id')::uuid, w.value
      from pg_catalog.jsonb_array_elements(coalesce(v_default -> 'widgets', '[]'::jsonb))
        with ordinality as w(value, n)
      where w.value ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and not ((w.value ->> 'id')::uuid = any (private.dashboard_widget_ids(v_view.layout)))
        and not ((w.value ->> 'id')::uuid = any (v_view.known_default_widget_ids))
      order by w.n;
  end
  $$;

-- Dismisses suggested widgets so they are not offered again. Ids not in the current shared default
-- are ignored; the remembered set is pruned to the current default. Outcomes: 'dismissed',
-- 'no_override'. 42501 for a foreign Home; 22023 for a missing list.
create function public.dismiss_dashboard_suggestions(p_home_id uuid, p_widget_ids uuid[]) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_default_ids uuid[];
  begin
    if p_home_id is null or p_widget_ids is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.dashboard_target(p_home_id, 'mine', v_user_id, false);
    select private.dashboard_widget_ids(d.layout) into v_default_ids
      from private.dashboard_layouts d where d.owner_home_id = p_home_id;
    v_default_ids := coalesce(v_default_ids, '{}');
    update private.dashboard_member_overrides o
      set known_default_widget_ids = (
        select coalesce(pg_catalog.array_agg(distinct i), '{}')
        from pg_catalog.unnest(o.known_default_widget_ids || p_widget_ids) i
        where i = any (v_default_ids))
      where o.home_id = p_home_id and o.user_id = v_user_id;
    return case when found then 'dismissed' else 'no_override' end;
  end
  $$;

-- Audit actions -----------------------------------------------------------------------------------
-- 'home_dashboard.restored' joins the existing free-text actions; no constraint lists actions.

-- Privacy export (UX00 brief section 7) -----------------------------------------------------------

-- The caller's own dashboard drafts, personal Home views and personal dashboard history, for the
-- personal export's "account" category. Homes outside the export's scope are left out. Shared-default
-- history is Home data, not the person's, so it is not part of a personal export.
create function private.collect_dashboard_export(p_me uuid, p_homes uuid[]) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'account/dashboard_drafts', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'home', h.name, 'target', d.target, 'layout', d.layout, 'base_revision', d.base_revision,
        'created_at', d.created_at, 'updated_at', d.updated_at) order by d.updated_at, d.id), '[]')
      from private.dashboard_drafts d left join public.homes h on h.id = d.home_id
      where d.user_id = p_me and (d.home_id is null or d.home_id = any (p_homes))),
    'account/dashboard_home_views', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'home', h.name, 'layout', o.layout, 'revision', o.revision,
        'created_at', o.created_at, 'updated_at', o.updated_at) order by h.name, o.id), '[]')
      from private.dashboard_member_overrides o join public.homes h on h.id = o.home_id
      where o.user_id = p_me and o.home_id = any (p_homes)),
    'account/dashboard_history', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'home', h.name, 'revision', v.revision, 'reason', v.reason, 'layout', v.layout,
        'created_at', v.created_at) order by h.name nulls first, v.created_at, v.id), '[]')
      from private.dashboard_layout_versions v
      left join private.dashboard_layouts d on d.id = v.layout_id
      left join private.dashboard_member_overrides o on o.id = v.override_id
      left join public.homes h on h.id = o.home_id
      where (d.owner_user_id = p_me)
         or (o.user_id = p_me and o.home_id = any (p_homes))));
  $$;

-- As 20261126090000_privacy_exports.sql, plus the dashboard files above in the "account" category.
create or replace function public.collect_data_export(p_export_id uuid, p_category text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_export private.data_exports;
    v_result jsonb;
    v_homes uuid[];
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
    v_homes := private.data_export_homes(v_export);
    v_result := private.collect_personal_category(v_export.requester_id, v_homes, p_category);
    if p_category = 'account' then
      v_result := pg_catalog.jsonb_set(v_result, '{files}',
        coalesce(v_result -> 'files', '{}'::jsonb)
          || private.collect_dashboard_export(v_export.requester_id, v_homes));
    end if;
    return v_result;
  end
  $$;

-- Backfill ----------------------------------------------------------------------------------------
-- Every existing saved layout gets its current layout as its first history entry, so history is
-- never empty for a dashboard that was saved before this migration.
insert into private.dashboard_layout_versions (layout_id, revision, layout, reason, saved_by, created_at)
  select d.id, d.revision, d.layout, 'save', case when d.owner_home_id is not null then d.updated_by end,
    d.updated_at
  from private.dashboard_layouts d;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.get_dashboard(uuid, text)',
    'public.save_dashboard(jsonb, integer, uuid, jsonb, text, boolean)',
    'public.undo_dashboard_change(integer, uuid, text)',
    'public.get_dashboard_draft(uuid, text)',
    'public.save_dashboard_draft(jsonb, integer, uuid, text)',
    'public.discard_dashboard_draft(uuid, text)',
    'public.list_dashboard_versions(uuid, text)',
    'public.restore_dashboard_version(uuid, integer)',
    'public.reset_dashboard_override(uuid)',
    'public.list_dashboard_suggestions(uuid)',
    'public.dismiss_dashboard_suggestions(uuid, uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.dashboard_limit(text)',
    'private.can_customize_dashboard(uuid)',
    'private.dashboard_target(uuid, text, uuid, boolean)',
    'private.can_save_dashboard_target(uuid, text, uuid)',
    'private.dashboard_widget_ids(jsonb)',
    'private.discard_unpermitted_default_drafts()',
    'private.record_dashboard_version(uuid, uuid, integer, jsonb, text, uuid)',
    'private.commit_dashboard(uuid, uuid, text, jsonb, integer, jsonb, text)',
    'private.live_dashboard_draft(uuid, uuid, text)',
    'private.purge_expired_dashboard_drafts(integer)',
    'private.collect_dashboard_export(uuid, uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;

-- collect_data_export keeps its original grants (create or replace keeps them); restate them.
revoke all on function public.collect_data_export(uuid, text) from public, anon, authenticated;
grant execute on function public.collect_data_export(uuid, text) to service_role;
