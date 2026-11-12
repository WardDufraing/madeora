-- S41: child profiles and guardians (spec "Confirmed one child identity across multiple Homes",
-- "Confirmed guardian roles", "Confirmed quick child creation", "Confirmed age-appropriate child
-- permission presets", "Confirmed child-controlled accent colors with guardian reset";
-- architecture.md §4 and §34; brief plans/steps/S41-brief.md).
--
-- A child is one canonical identity: an auth.users row with no email, no password and no identity,
-- so nobody can sign in as it (sign-in arrives with S42). That keeps every module that attributes
-- work to a user id (chores, points, tasks, calendar) working for children unchanged. The row is
-- marked as a child in public.child_profiles.
--
-- Per Home:
--   * the child's membership is always a plain Member (never Administrator or Owner);
--   * public.child_guardians holds exactly one primary and at most one secondary guardian, both adult
--     members of that Home; guardianship in one Home grants nothing in another;
--   * public.child_home_settings holds the guardian-selected preset (Young Child, Child, Teen) and
--     explicit overrides. Presets describe what the child may do once they can sign in (S42);
--     nothing here gives a child a session.
--
-- Ward's decisions (2026-11-11): no date of birth; an optional guardian-set age band that only
-- suggests a preset; every child starts on Young Child; no automatic promotion; no minimum age.
--
-- All writes go through the security definer functions below; the tables grant no writes to the
-- API roles.

-- Child identities ---------------------------------------------------------------------------------

create table public.child_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Only a hint for suggesting a preset; never used for access (Ward, 2026-11-11).
  age_band text
    constraint child_profiles_age_band_check check (age_band in ('under_8', '8_12', '13_17')),
  created_by uuid references auth.users (id) on delete set null,
  creation_request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint child_profiles_request_key unique (created_by, creation_request_id)
);

alter table public.child_profiles enable row level security;
revoke all on table public.child_profiles from public, anon, authenticated;

comment on table public.child_profiles is
  'S41: marks an auth user as a guardian-managed child identity (no email, no credentials yet).';

create function private.is_child(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.child_profiles c where c.user_id = p_user_id)
  $$;

revoke all on function private.is_child(uuid) from public;
grant execute on function private.is_child(uuid) to service_role;

-- An adult who can hold guardian authority: a signed-up account with a confirmed email, not a
-- child, not deactivated or pending deletion.
create function private.is_eligible_guardian(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select private.confirmed_email(p_user_id) is not null
      and not private.is_child(p_user_id)
      and not private.is_deactivated(p_user_id)
  $$;

revoke all on function private.is_eligible_guardian(uuid) from public;

-- Children are always plain Members --------------------------------------------------------------

create function private.child_membership_role() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.role <> 'member' and private.is_child(new.user_id) then
      raise exception 'a child is always a Member' using errcode = '23514';
    end if;
    return new;
  end
  $$;

revoke all on function private.child_membership_role() from public;

create trigger home_memberships_child_role
  before insert or update of role, user_id on private.home_memberships_all
  for each row execute function private.child_membership_role();

-- Guardians -----------------------------------------------------------------------------------------

create table public.child_guardians (
  home_id uuid not null,
  child_user_id uuid not null,
  guardian_user_id uuid not null,
  role text not null constraint child_guardians_role_check check (role in ('primary', 'secondary')),
  assigned_by uuid references auth.users (id) on delete set null,
  assigned_at timestamptz not null default now(),
  constraint child_guardians_pkey primary key (home_id, child_user_id, role),
  constraint child_guardians_one_role_key unique (home_id, child_user_id, guardian_user_id),
  constraint child_guardians_not_self check (guardian_user_id <> child_user_id),
  -- Ending either membership ends the assignment. A child without a primary guardian is on hold
  -- until the Owner appoints one.
  constraint child_guardians_child_membership_fkey foreign key (home_id, child_user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade,
  constraint child_guardians_guardian_membership_fkey foreign key (home_id, guardian_user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

create index child_guardians_guardian_idx on public.child_guardians (guardian_user_id);

alter table public.child_guardians enable row level security;
revoke all on table public.child_guardians from public, anon, authenticated;

comment on table public.child_guardians is
  'S41: the primary and optional secondary guardian of a child in one Home.';

create function private.child_guardian_role(p_home_id uuid, p_child uuid, p_user uuid)
returns text
  language sql stable security definer set search_path = '' as $$
    select g.role from public.child_guardians g
    join public.home_memberships m on m.home_id = g.home_id and m.user_id = g.guardian_user_id
    where g.home_id = p_home_id and g.child_user_id = p_child and g.guardian_user_id = p_user
  $$;

revoke all on function private.child_guardian_role(uuid, uuid, uuid) from public;

-- The same for the signed-in caller only, for RLS policies: it can only answer about the caller.
create function private.caller_child_guardian_role(p_home_id uuid, p_child uuid) returns text
  language sql stable security definer set search_path = '' as $$
    select private.child_guardian_role(p_home_id, p_child, auth.uid())
  $$;

revoke all on function private.caller_child_guardian_role(uuid, uuid) from public;
grant execute on function private.caller_child_guardian_role(uuid, uuid) to authenticated;

-- Every member of the Home may see who a child's guardians are (spec: show guardian roles to
-- authorized adults); nothing else about the child is in this table.
create policy child_guardians_select_home_members on public.child_guardians
  for select to authenticated
  using (exists (
    select 1 from public.home_memberships m
    where m.home_id = child_guardians.home_id and m.user_id = (select auth.uid())
  ));

grant select on table public.child_guardians to authenticated;

-- Only a guardian of the child in a Home both share sees the identity-level row (the age band).
create policy child_profiles_select_guardians on public.child_profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.child_guardians g
      join public.home_memberships m on m.home_id = g.home_id and m.user_id = g.guardian_user_id
      where g.child_user_id = child_profiles.user_id and g.guardian_user_id = (select auth.uid())
    )
  );

grant select (user_id, age_band, created_at) on table public.child_profiles to authenticated;

-- Presets and access ----------------------------------------------------------------------------------

-- The capabilities a child can be given in one Home and what each preset includes (S41 brief,
-- defaults awaiting Ward's review). packages/domain/src/permissions/children.ts lists the same.
create function private.child_capabilities() returns text[]
  language sql immutable parallel safe set search_path = '' as $$
    select array[
      'viewHomeChores', 'viewHomeCalendar', 'viewLeaderboard', 'claimPoolChores',
      'redeemRewards', 'viewShopping', 'editShopping', 'viewMeals', 'viewRecipes', 'viewPets',
      'editOwnAvatar', 'editOwnDisplayName'
    ]::text[]
  $$;

create function private.child_preset_capabilities(p_preset text) returns text[]
  language sql immutable parallel safe set search_path = '' as $$
    select case p_preset
      when 'young_child' then array['viewHomeChores', 'viewHomeCalendar', 'viewLeaderboard']
      when 'child' then array[
        'viewHomeChores', 'viewHomeCalendar', 'viewLeaderboard', 'claimPoolChores',
        'redeemRewards', 'viewShopping', 'viewMeals', 'viewRecipes', 'viewPets', 'editOwnAvatar'
      ]
      when 'teen' then array[
        'viewHomeChores', 'viewHomeCalendar', 'viewLeaderboard', 'claimPoolChores',
        'redeemRewards', 'viewShopping', 'editShopping', 'viewMeals', 'viewRecipes', 'viewPets',
        'editOwnAvatar', 'editOwnDisplayName'
      ]
    end::text[]
  $$;

-- Overrides: a JSON object whose keys are known capabilities and whose values are booleans.
create function private.valid_child_overrides(p_overrides jsonb) returns boolean
  language sql immutable parallel safe set search_path = '' as $$
    select pg_catalog.jsonb_typeof(p_overrides) = 'object'
      and not exists (
        select 1 from pg_catalog.jsonb_each(p_overrides) e
        where e.key <> all (private.child_capabilities())
          or pg_catalog.jsonb_typeof(e.value) <> 'boolean'
      )
  $$;

-- The effective capabilities: the preset's, with each override switching one on or off. Sorted, so
-- two sets compare with = and @>.
create function private.child_effective_capabilities(p_preset text, p_overrides jsonb)
returns text[]
  language sql immutable parallel safe set search_path = '' as $$
    select coalesce(pg_catalog.array_agg(c order by c), '{}'::text[])
    from pg_catalog.unnest(private.child_capabilities()) c
    where coalesce(
      (p_overrides ->> c)::boolean,
      c = any (private.child_preset_capabilities(p_preset))
    )
  $$;

revoke all on function private.child_capabilities() from public;
revoke all on function private.child_preset_capabilities(text) from public;
revoke all on function private.valid_child_overrides(jsonb) from public;
revoke all on function private.child_effective_capabilities(text, jsonb) from public;

create table public.child_home_settings (
  home_id uuid not null,
  child_user_id uuid not null,
  -- Quick creation always starts on the most restrictive preset (spec; Ward, 2026-11-11).
  preset text not null default 'young_child'
    constraint child_home_settings_preset_check check (preset in ('young_child', 'child', 'teen')),
  overrides jsonb not null default '{}'::jsonb
    constraint child_home_settings_overrides_check check (private.valid_child_overrides(overrides)),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint child_home_settings_pkey primary key (home_id, child_user_id),
  constraint child_home_settings_membership_fkey foreign key (home_id, child_user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

alter table public.child_home_settings enable row level security;
revoke all on table public.child_home_settings from public, anon, authenticated;

comment on table public.child_home_settings is
  'S41: a child''s guardian-selected preset and explicit overrides in one Home.';

-- Guardians of the child in that Home (and, from S42, the child) read the settings.
create policy child_home_settings_select_guardians on public.child_home_settings
  for select to authenticated
  using (
    (child_user_id = (select auth.uid()) and exists (
      select 1 from public.home_memberships m
      where m.home_id = child_home_settings.home_id and m.user_id = (select auth.uid())
    ))
    or private.caller_child_guardian_role(home_id, child_user_id) is not null
  );

grant select (home_id, child_user_id, preset, overrides, updated_at)
  on table public.child_home_settings to authenticated;

-- Whether a child holds a capability in a Home now. S42 uses it when children can sign in.
create function private.child_has_capability(p_home_id uuid, p_child uuid, p_capability text)
returns boolean
  language sql stable security definer set search_path = '' as $$
    select coalesce((
      select p_capability = any (private.child_effective_capabilities(s.preset, s.overrides))
      from public.child_home_settings s
      join public.home_memberships m on m.home_id = s.home_id and m.user_id = s.child_user_id
      where s.home_id = p_home_id and s.child_user_id = p_child
    ), false)
  $$;

revoke all on function private.child_has_capability(uuid, uuid, text) from public;

-- Shared lookups for the functions below -----------------------------------------------------------

-- The child behind a membership id in a Home, or null when it is not a child's membership.
create function private.child_of_membership(p_home_id uuid, p_membership_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    where m.id = p_membership_id and m.home_id = p_home_id and private.is_child(m.user_id)
  $$;

revoke all on function private.child_of_membership(uuid, uuid) from public;

-- An adult member who may be a guardian in this Home, by membership id; null otherwise.
create function private.guardian_candidate(p_home_id uuid, p_membership_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    where m.id = p_membership_id and m.home_id = p_home_id
      and private.is_eligible_guardian(m.user_id)
  $$;

revoke all on function private.guardian_candidate(uuid, uuid) from public;

-- Guardian offers ----------------------------------------------------------------------------------

-- Nobody becomes a guardian without accepting (spec "Confirmed quick child profile creation":
-- validate the guardian's acceptance before activating; "Confirmed primary and secondary child
-- guardian authority": controlled transfer, guardian invitation/acceptance, never silently transfer
-- guardian authority). Every assignment of someone other than the caller is an offer the named adult
-- accepts or declines. Kinds:
--   'initial'   the creator named another adult as primary guardian; the child is on hold until
--               they accept;
--   'appoint'   the Owner names a primary guardian for a child on hold (never themselves);
--   'handover'  the primary guardian offers the primary role;
--   'secondary' the primary guardian offers the secondary role.
-- One open offer per child, Home and role; a new one replaces it. Offers expire after 14 days.
create table public.child_guardian_offers (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null,
  child_user_id uuid not null,
  guardian_user_id uuid not null,
  role text not null
    constraint child_guardian_offers_role_check check (role in ('primary', 'secondary')),
  kind text not null
    constraint child_guardian_offers_kind_check
      check (kind in ('initial', 'appoint', 'handover', 'secondary')),
  constraint child_guardian_offers_kind_role_check
    check ((kind = 'secondary') = (role = 'secondary')),
  offered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  constraint child_guardian_offers_one_per_role_key unique (home_id, child_user_id, role),
  constraint child_guardian_offers_child_membership_fkey foreign key (home_id, child_user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade,
  constraint child_guardian_offers_guardian_membership_fkey foreign key (home_id, guardian_user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

alter table public.child_guardian_offers enable row level security;
revoke all on table public.child_guardian_offers from public, anon, authenticated;

comment on table public.child_guardian_offers is
  'S41: a guardian role offered to an adult member, active only once they accept.';

-- The offered adult, whoever made the offer, and the child's guardians in that Home see it.
create policy child_guardian_offers_select_involved on public.child_guardian_offers
  for select to authenticated
  using (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = child_guardian_offers.home_id and m.user_id = (select auth.uid())
    )
    and (
      guardian_user_id = (select auth.uid())
      or offered_by = (select auth.uid())
      or private.caller_child_guardian_role(home_id, child_user_id) is not null
    )
  );

grant select (id, home_id, child_user_id, guardian_user_id, role, kind, created_at, expires_at)
  on table public.child_guardian_offers to authenticated;

-- Make or replace an offer (the caller's authority is checked by the caller of this function).
create function private.offer_child_guardian(
  p_home_id uuid, p_child uuid, p_target uuid, p_kind text, p_actor uuid
) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_role text := case when p_kind = 'secondary' then 'secondary' else 'primary' end;
  begin
    delete from public.child_guardian_offers o
      where o.home_id = p_home_id and o.child_user_id = p_child and o.role = v_role;
    insert into public.child_guardian_offers
      (home_id, child_user_id, guardian_user_id, role, kind, offered_by)
      values (p_home_id, p_child, p_target, v_role, p_kind, p_actor);
    perform private.audit('child.guardian_offered', p_home_id, 'user', p_child,
      jsonb_build_object('kind', p_kind, 'guardian', p_target));
  end
  $$;

revoke all on function private.offer_child_guardian(uuid, uuid, uuid, text, uuid) from public;

-- Apply an accepted assignment.
--   * secondary: replaces any current secondary;
--   * primary: the target becomes primary; the other adult stays as secondary (the previous
--     secondary unless they became primary, otherwise the previous primary).
create function private.apply_child_guardian(
  p_home_id uuid, p_child uuid, p_target uuid, p_role text, p_actor uuid
) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_primary uuid;
    v_secondary uuid;
  begin
    select g.guardian_user_id into v_primary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'primary';
    select g.guardian_user_id into v_secondary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'secondary';

    if p_role = 'secondary' then
      delete from public.child_guardians g
        where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'secondary';
      insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
        values (p_home_id, p_child, p_target, 'secondary', p_actor);
    else
      delete from public.child_guardians g
        where g.home_id = p_home_id and g.child_user_id = p_child;
      insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
        values (p_home_id, p_child, p_target, 'primary', p_actor);
      if v_secondary is not null and v_secondary <> p_target then
        insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
          values (p_home_id, p_child, v_secondary, 'secondary', p_actor);
      elsif v_primary is not null and v_primary <> p_target then
        insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
          values (p_home_id, p_child, v_primary, 'secondary', p_actor);
      end if;
    end if;
    -- An open offer to the new guardian for the other role no longer makes sense.
    delete from public.child_guardian_offers o
      where o.home_id = p_home_id and o.child_user_id = p_child and o.guardian_user_id = p_target;
    perform private.audit('child.guardian_assigned', p_home_id, 'user', p_child,
      jsonb_build_object('role', p_role, 'guardian', p_target));
  end
  $$;

revoke all on function private.apply_child_guardian(uuid, uuid, uuid, text, uuid) from public;

-- Every guardian role that ends (step-down, hand-over, the guardian or the child leaving the Home)
-- is audited, including the ones that end through a membership cascade.
create function private.audit_child_guardian_end() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    insert into private.audit_events (actor_user_id, home_id, action, subject_type, subject_id, details)
      values (auth.uid(), old.home_id, 'child.guardian_ended', 'user', old.child_user_id,
              jsonb_build_object('role', old.role, 'guardian', old.guardian_user_id));
    return null;
  end
  $$;

revoke all on function private.audit_child_guardian_end() from public;

create trigger child_guardians_audit_end
  after delete on public.child_guardians
  for each row execute function private.audit_child_guardian_end();

-- Creation limits (S41 brief defaults, Ward may change): at most 10 children created per account per
-- 24 hours, and at most 30 children in one Home.
create function private.child_creation_limits() returns table (per_account_day integer, per_home integer)
  language sql immutable parallel safe set search_path = '' as $$
    select 10, 30
  $$;

revoke all on function private.child_creation_limits() from public;

-- How long after creation a child created by mistake can be deleted outright (S41 brief default).
create function private.child_correction_window() returns interval
  language sql immutable parallel safe set search_path = '' as $$
    select interval '24 hours'
  $$;

revoke all on function private.child_correction_window() from public;

-- Create a child ---------------------------------------------------------------------------------------

-- Home → Members → Add child (spec "Confirmed quick child creation"): a name, an eligible primary
-- guardian and nothing else is required. Who may add a child: any adult member, who becomes primary
-- guardian at once; the Owner or an Administrator holding manageInvitations may instead name another
-- adult member, who receives an offer and becomes primary guardian only on accepting (until then the
-- child is on hold). A repeated request id from the same caller returns the same child.
-- Outcomes: 'created', 'not_found', 'not_permitted', 'invalid_guardian', 'limit_reached'.
create function public.create_child(
  p_home_id uuid,
  p_name text,
  p_primary_guardian_membership_id uuid,
  p_age_band text,
  p_accent_color text,
  p_request_id uuid
) returns table (outcome text, membership_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_role text;
    v_guardian uuid;
    v_child uuid;
    v_membership uuid;
    -- The API sends '' for "no age band" (generated RPC types have no nullable arguments).
    v_age_band text := nullif(p_age_band, '');
  begin
    if p_request_id is null then
      raise exception 'a request id is required' using errcode = '22023';
    end if;
    if p_name is null or not private.is_visible_name(p_name, 50) then
      raise exception 'invalid name' using errcode = '22023';
    end if;
    if v_age_band is not null and v_age_band not in ('under_8', '8_12', '13_17') then
      raise exception 'invalid age band' using errcode = '22023';
    end if;
    if p_accent_color is null or p_accent_color !~ '^#[0-9a-f]{6}$' then
      raise exception 'invalid accent colour' using errcode = '22023';
    end if;

    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    v_role := private.home_role(p_home_id, v_user_id);
    if v_role is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;

    -- Retry of a request that already created a child.
    select m.id into v_membership
      from public.child_profiles c
      join public.home_memberships m on m.user_id = c.user_id and m.home_id = p_home_id
      where c.created_by = v_user_id and c.creation_request_id = p_request_id;
    if found then
      return query select 'created'::text, v_membership;
      return;
    end if;
    if exists (
      select 1 from public.child_profiles c
      where c.created_by = v_user_id and c.creation_request_id = p_request_id
    ) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;

    if private.is_child(v_user_id) or private.is_deactivated(v_user_id) then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;

    v_guardian := private.guardian_candidate(p_home_id, p_primary_guardian_membership_id);
    if v_guardian is null then
      return query select 'invalid_guardian'::text, null::uuid;
      return;
    end if;
    if not (
      v_guardian = v_user_id
      or v_role = 'owner'
      or private.has_home_capability(p_home_id, v_user_id, 'manageInvitations')
    ) then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;

    if (select count(*) from public.child_profiles c
        where c.created_by = v_user_id and c.created_at > now() - interval '24 hours')
         >= (select l.per_account_day from private.child_creation_limits() l)
       or (select count(*) from public.home_memberships m
           join public.child_profiles c on c.user_id = m.user_id
           where m.home_id = p_home_id)
         >= (select l.per_home from private.child_creation_limits() l) then
      return query select 'limit_reached'::text, null::uuid;
      return;
    end if;

    -- The identity: no email, no password, no identity row. Token columns are empty strings, as
    -- Supabase Auth expects.
    v_child := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', v_child, 'authenticated', 'authenticated', null, '',
      null, '', '', '', '',
      '{"provider": "madeora_child", "providers": [], "madeora_kind": "child"}'::jsonb, '{}'::jsonb,
      now(), now()
    );
    insert into public.child_profiles (user_id, age_band, created_by, creation_request_id)
      values (v_child, v_age_band, v_user_id, p_request_id);
    insert into public.user_preferences (user_id, display_name) values (v_child, p_name);

    insert into public.home_memberships (home_id, user_id, role)
      values (p_home_id, v_child, 'member')
      returning id into v_membership;
    insert into public.home_member_profiles (home_id, user_id, accent_color)
      values (p_home_id, v_child, p_accent_color);
    insert into public.child_home_settings (home_id, child_user_id, updated_by)
      values (p_home_id, v_child, v_user_id);
    perform private.audit('child.created', p_home_id, 'user', v_child,
      jsonb_build_object('preset', 'young_child', 'primary_guardian', v_guardian));
    if v_guardian = v_user_id then
      insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
        values (p_home_id, v_child, v_guardian, 'primary', v_user_id);
    else
      perform private.offer_child_guardian(p_home_id, v_child, v_guardian, 'initial', v_user_id);
    end if;
    return query select 'created'::text, v_membership;
  end
  $$;

revoke all on function public.create_child(uuid, text, uuid, text, text, uuid) from public, anon;
grant execute on function public.create_child(uuid, text, uuid, text, text, uuid) to authenticated;

-- Guardian assignments -------------------------------------------------------------------------------

-- Offer a guardian role (spec "Confirmed guardian roles"); it applies when the named adult accepts:
--   * 'secondary': only the primary guardian;
--   * 'primary' while the child has a primary: only that primary guardian (hand-over);
--   * 'primary' while the child has none (on hold): only the Owner, and never to themselves (being a
--     Home manager never grants parental access; spec).
-- Outcomes: 'offered', 'not_found', 'not_permitted', 'invalid_guardian'.
create function public.assign_child_guardian(
  p_home_id uuid, p_child_membership_id uuid, p_guardian_membership_id uuid, p_role text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_target uuid;
    v_caller_role text;
    v_primary uuid;
    v_secondary uuid;
    v_kind text;
  begin
    if p_role is null or p_role not in ('primary', 'secondary') then
      raise exception 'invalid guardian role' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return 'not_found';
    end if;

    select g.guardian_user_id into v_primary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = v_child and g.role = 'primary';
    select g.guardian_user_id into v_secondary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = v_child and g.role = 'secondary';
    v_caller_role := private.child_guardian_role(p_home_id, v_child, v_user_id);

    if p_role = 'secondary' then
      if v_caller_role is distinct from 'primary' then
        return 'not_permitted';
      end if;
      v_kind := 'secondary';
    elsif v_primary is not null then
      if v_caller_role is distinct from 'primary' then
        return 'not_permitted';
      end if;
      v_kind := 'handover';
    else
      if private.home_role(p_home_id, v_user_id) is distinct from 'owner' then
        return 'not_permitted';
      end if;
      v_kind := 'appoint';
    end if;

    v_target := private.guardian_candidate(p_home_id, p_guardian_membership_id);
    if v_target is null or v_target = v_user_id
       or v_target = v_primary
       or (p_role = 'secondary' and v_target = v_secondary) then
      return 'invalid_guardian';
    end if;

    perform private.offer_child_guardian(p_home_id, v_child, v_target, v_kind, v_user_id);
    return 'offered';
  end
  $$;

revoke all on function public.assign_child_guardian(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.assign_child_guardian(uuid, uuid, uuid, text) to authenticated;

-- The offered adult accepts or declines. Accepting re-checks that the offer still stands: not
-- expired, the adult still eligible, and the authority behind it unchanged (the offering primary is
-- still primary for 'secondary' and 'handover'; the child is still on hold for 'initial' and
-- 'appoint', and the appointing Owner is still the Owner). Outcomes: 'accepted', 'declined',
-- 'not_found', 'expired', 'no_longer_valid'.
create function public.answer_child_guardian_offer(p_offer_id uuid, p_accept boolean)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_offer public.child_guardian_offers;
    v_primary uuid;
    v_valid boolean;
  begin
    if p_accept is null then
      raise exception 'an answer is required' using errcode = '22023';
    end if;
    select * into v_offer from public.child_guardian_offers o
      where o.id = p_offer_id and o.guardian_user_id = v_user_id;
    if not found then
      return 'not_found';
    end if;
    if not private.lock_home(v_offer.home_id) then
      return 'not_found';
    end if;
    -- Read again under the lock.
    select * into v_offer from public.child_guardian_offers o
      where o.id = p_offer_id and o.guardian_user_id = v_user_id;
    if not found or private.home_role(v_offer.home_id, v_user_id) is null then
      return 'not_found';
    end if;

    if not p_accept then
      delete from public.child_guardian_offers o where o.id = v_offer.id;
      perform private.audit('child.guardian_offer_declined', v_offer.home_id, 'user',
        v_offer.child_user_id, jsonb_build_object('kind', v_offer.kind));
      return 'declined';
    end if;
    if v_offer.expires_at <= now() then
      delete from public.child_guardian_offers o where o.id = v_offer.id;
      return 'expired';
    end if;

    select g.guardian_user_id into v_primary from public.child_guardians g
      where g.home_id = v_offer.home_id and g.child_user_id = v_offer.child_user_id
        and g.role = 'primary';
    v_valid := private.is_eligible_guardian(v_user_id)
      and v_primary is distinct from v_user_id
      and case v_offer.kind
        when 'secondary' then v_primary is not null and v_primary = v_offer.offered_by
        when 'handover' then v_primary is not null and v_primary = v_offer.offered_by
        when 'appoint' then v_primary is null
          and private.home_role(v_offer.home_id, v_offer.offered_by) = 'owner'
        else v_primary is null
      end;
    if not coalesce(v_valid, false) then
      delete from public.child_guardian_offers o where o.id = v_offer.id;
      return 'no_longer_valid';
    end if;

    perform private.apply_child_guardian(v_offer.home_id, v_offer.child_user_id, v_user_id,
      v_offer.role, v_offer.offered_by);
    return 'accepted';
  end
  $$;

revoke all on function public.answer_child_guardian_offer(uuid, boolean) from public, anon;
grant execute on function public.answer_child_guardian_offer(uuid, boolean) to authenticated;

-- Withdraw an open offer: whoever made it, or the child's primary guardian. Outcomes: 'cancelled',
-- 'not_found', 'not_permitted'.
create function public.cancel_child_guardian_offer(p_offer_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_offer public.child_guardian_offers;
  begin
    select * into v_offer from public.child_guardian_offers o where o.id = p_offer_id;
    if not found or private.home_role(v_offer.home_id, v_user_id) is null then
      return 'not_found';
    end if;
    if not private.lock_home(v_offer.home_id) then
      return 'not_found';
    end if;
    if not (
      v_offer.offered_by = v_user_id
      or private.child_guardian_role(v_offer.home_id, v_offer.child_user_id, v_user_id)
        is not distinct from 'primary'
    ) then
      return 'not_permitted';
    end if;
    delete from public.child_guardian_offers o where o.id = v_offer.id;
    perform private.audit('child.guardian_offer_cancelled', v_offer.home_id, 'user',
      v_offer.child_user_id, jsonb_build_object('kind', v_offer.kind));
    return 'cancelled';
  end
  $$;

revoke all on function public.cancel_child_guardian_offer(uuid) from public, anon;
grant execute on function public.cancel_child_guardian_offer(uuid) to authenticated;

-- The open offers made to the caller in a Home, for the Members page.
create function public.my_child_guardian_offers(p_home_id uuid)
returns table (
  offer_id uuid,
  child_membership_id uuid,
  child_name text,
  role text,
  kind text,
  expires_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or p_home_id is null or private.home_role(p_home_id, v_user_id) is null then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;
    return query
      select o.id, m.id, coalesce(p.nickname, p.display_name, up.display_name), o.role, o.kind,
             o.expires_at
      from public.child_guardian_offers o
      join public.home_memberships m on m.home_id = o.home_id and m.user_id = o.child_user_id
      left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      where o.home_id = p_home_id and o.guardian_user_id = v_user_id and o.expires_at > now()
      order by o.created_at, o.id;
  end
  $$;

revoke all on function public.my_child_guardian_offers(uuid) from public, anon;
grant execute on function public.my_child_guardian_offers(uuid) to authenticated;

-- Remove the secondary guardian: the primary guardian, or the secondary stepping down. The primary
-- can only hand the role over (assign_child_guardian). Outcomes: 'removed', 'not_found',
-- 'not_permitted'.
create function public.remove_child_secondary_guardian(
  p_home_id uuid, p_child_membership_id uuid
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_caller_role text;
    v_secondary uuid;
  begin
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return 'not_found';
    end if;
    v_caller_role := private.child_guardian_role(p_home_id, v_child, v_user_id);
    if v_caller_role is null then
      return 'not_permitted';
    end if;
    delete from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = v_child and g.role = 'secondary'
      returning g.guardian_user_id into v_secondary;
    if v_secondary is null then
      return 'removed';
    end if;
    perform private.audit('child.guardian_removed', p_home_id, 'user', v_child,
      jsonb_build_object('role', 'secondary', 'guardian', v_secondary));
    return 'removed';
  end
  $$;

revoke all on function public.remove_child_secondary_guardian(uuid, uuid) from public, anon;
grant execute on function public.remove_child_secondary_guardian(uuid, uuid) to authenticated;

-- Correct a mistaken or duplicate creation (spec "Confirmed quick child profile creation": support
-- an authorized retry/recovery and avoid orphan profiles): within the correction window after
-- creation, the child's primary guardian or the adult who created the child may delete the child
-- outright, as long as this is the child's only Home. History rows keep their place with the id set
-- to null ("Former member"). Deleting an established child identity, with the 30-day recovery the
-- spec gives accounts, is a later step. Outcomes: 'deleted', 'not_found', 'not_permitted',
-- 'too_late', 'child_other_homes'.
create function public.delete_mistaken_child(p_home_id uuid, p_child_membership_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_profile public.child_profiles;
  begin
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return 'not_found';
    end if;
    select * into v_profile from public.child_profiles c where c.user_id = v_child;
    if not (
      v_profile.created_by is not distinct from v_user_id
      or private.child_guardian_role(p_home_id, v_child, v_user_id) is not distinct from 'primary'
    ) then
      return 'not_permitted';
    end if;
    if v_profile.created_at <= now() - private.child_correction_window() then
      return 'too_late';
    end if;
    if exists (
      select 1 from private.home_memberships_all m
      where m.user_id = v_child and m.home_id <> p_home_id
    ) then
      return 'child_other_homes';
    end if;
    perform private.audit('child.deleted', p_home_id, 'user', v_child,
      jsonb_build_object('reason', 'mistaken_creation'));
    delete from auth.users u where u.id = v_child;
    return 'deleted';
  end
  $$;

revoke all on function public.delete_mistaken_child(uuid, uuid) from public, anon;
grant execute on function public.delete_mistaken_child(uuid, uuid) to authenticated;

-- Preset and overrides ---------------------------------------------------------------------------------

-- Change a child's preset and overrides in one Home (spec "Confirmed age-appropriate child permission
-- presets"). The primary guardian may change anything; the secondary guardian may only switch
-- capabilities off within the current preset (routine, safe changes). A change that adds any
-- capability needs p_confirm_expansion, so the interface has shown the before/after preview first.
-- p_expected_updated_at refuses a write based on a stale read (two guardians editing at once).
-- Outcomes: 'saved', 'unchanged', 'confirmation_required', 'stale', 'not_found', 'not_permitted'.
create function public.set_child_access(
  p_home_id uuid,
  p_child_membership_id uuid,
  p_preset text,
  p_overrides jsonb,
  p_confirm_expansion boolean,
  p_expected_updated_at timestamptz
) returns table (outcome text, before_capabilities text[], after_capabilities text[])
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_caller_role text;
    v_settings public.child_home_settings;
    v_before text[];
    v_after text[];
  begin
    if p_preset is null or p_preset not in ('young_child', 'child', 'teen') then
      raise exception 'invalid preset' using errcode = '22023';
    end if;
    if p_overrides is null or not private.valid_child_overrides(p_overrides) then
      raise exception 'invalid overrides' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    v_caller_role := private.child_guardian_role(p_home_id, v_child, v_user_id);
    if v_caller_role is null then
      return query select 'not_permitted'::text, null::text[], null::text[];
      return;
    end if;

    select * into v_settings from public.child_home_settings s
      where s.home_id = p_home_id and s.child_user_id = v_child for update;
    v_before := private.child_effective_capabilities(v_settings.preset, v_settings.overrides);
    v_after := private.child_effective_capabilities(p_preset, p_overrides);

    if p_expected_updated_at is null or v_settings.updated_at <> p_expected_updated_at then
      return query select 'stale'::text, v_before, v_after;
      return;
    end if;
    if v_caller_role = 'secondary'
       and (p_preset <> v_settings.preset or not (v_before @> v_after)) then
      return query select 'not_permitted'::text, v_before, v_after;
      return;
    end if;
    if p_preset = v_settings.preset and p_overrides = v_settings.overrides then
      return query select 'unchanged'::text, v_before, v_after;
      return;
    end if;
    if not (v_before @> v_after) and not coalesce(p_confirm_expansion, false) then
      return query select 'confirmation_required'::text, v_before, v_after;
      return;
    end if;

    update public.child_home_settings s
      set preset = p_preset, overrides = p_overrides, updated_by = v_user_id,
          updated_at = pg_catalog.clock_timestamp()
      where s.home_id = p_home_id and s.child_user_id = v_child;
    perform private.audit('child.access_changed', p_home_id, 'user', v_child,
      jsonb_build_object(
        'preset_before', v_settings.preset, 'preset_after', p_preset,
        'before', to_jsonb(v_before), 'after', to_jsonb(v_after)
      ));
    return query select 'saved'::text, v_before, v_after;
  end
  $$;

revoke all on function public.set_child_access(uuid, uuid, text, jsonb, boolean, timestamptz)
  from public, anon;
grant execute on function public.set_child_access(uuid, uuid, text, jsonb, boolean, timestamptz)
  to authenticated;

-- Presentation in one Home ----------------------------------------------------------------------------

-- A guardian (primary or secondary) sets the child's display name and identifying accent in this
-- Home, or resets the accent to a suggested default (spec: routine settings; guardian reset of a
-- child's colour). An empty display name falls back to the name given at creation. The child's own
-- colour changes arrive with child sign-in (S42). Outcomes: 'saved', 'not_found', 'not_permitted'.
create function public.set_child_presentation(
  p_home_id uuid, p_child_membership_id uuid, p_display_name text, p_accent_color text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    -- '' (or null) clears the Home name, so the name given at creation shows.
    v_name text := nullif(p_display_name, '');
  begin
    if v_name is not null and not private.is_visible_name(v_name, 50) then
      raise exception 'invalid name' using errcode = '22023';
    end if;
    if p_accent_color is null or p_accent_color !~ '^#[0-9a-f]{6}$' then
      raise exception 'invalid accent colour' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return 'not_found';
    end if;
    if private.child_guardian_role(p_home_id, v_child, v_user_id) is null then
      return 'not_permitted';
    end if;

    insert into public.home_member_profiles (home_id, user_id, display_name, accent_color)
      values (p_home_id, v_child, v_name, p_accent_color)
      on conflict (home_id, user_id) do update
        set display_name = excluded.display_name, accent_color = excluded.accent_color;
    perform private.audit('child.presentation_changed', p_home_id, 'user', v_child,
      jsonb_build_object('fields', jsonb_build_array('display_name', 'accent_color')));
    return 'saved';
  end
  $$;

revoke all on function public.set_child_presentation(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_child_presentation(uuid, uuid, text, text) to authenticated;

-- Linking a child to another Home ---------------------------------------------------------------------

-- One child identity across Homes (spec "Confirmed one child identity across multiple Homes"):
-- linking needs a deliberate request from each side and is never automatic. The child's primary
-- guardian in a Home where the child already is issues a one-time link code (approval on that side);
-- an adult member of the other Home redeems it there and becomes the child's primary guardian in
-- that Home (approval on the other side). Knowing the child's name, being a Home manager or a shared
-- display never claims a child. The code is shown once, stored only as a SHA-256 hash, valid for
-- 7 days, single use; issuing a new one for the same child and Home replaces the open one. Each
-- Home keeps its own membership, guardians, settings and history.
create table private.child_link_codes (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null,
  child_user_id uuid not null,
  code_hash bytea not null constraint child_link_codes_hash_key unique,
  created_by uuid references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  constraint child_link_codes_one_open_key unique (home_id, child_user_id),
  constraint child_link_codes_child_membership_fkey foreign key (home_id, child_user_id)
    references private.home_memberships_all (home_id, user_id) on delete cascade
);

revoke all on table private.child_link_codes from public;

comment on table private.child_link_codes is
  'S41: one-time codes a primary guardian issues to link a child to another Home (hash only).';

-- A typed code in its stored form: upper case, spaces and dashes removed, look-alikes I/L/O read as
-- 1/1/0. Null when it cannot be a code.
create function private.normalize_child_link_code(p_value text) returns text
  language sql immutable parallel safe set search_path = '' as $$
    select case
      when p_value is null or pg_catalog.char_length(p_value) > 64 then null
      else nullif(
        pg_catalog.translate(
          pg_catalog.upper(pg_catalog.regexp_replace(p_value, '[\s-]', '', 'g')), 'ILO', '110'),
        '')
    end
  $$;

revoke all on function private.normalize_child_link_code(text) from public;

-- Issue a link code for the child in this Home: only the child's primary guardian here.
-- Outcomes: 'issued' (with the code, shown once, as XXXX-XXXX-XXXX-XXXX), 'not_found',
-- 'not_permitted'.
create function public.create_child_link_code(p_home_id uuid, p_child_membership_id uuid)
returns table (outcome text, code text, expires_at timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    v_child uuid;
    v_bytes bytea;
    v_code text := '';
    v_expires timestamptz;
  begin
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::text, null::timestamptz;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::text, null::timestamptz;
      return;
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return query select 'not_found'::text, null::text, null::timestamptz;
      return;
    end if;
    if private.child_guardian_role(p_home_id, v_child, v_user_id) is distinct from 'primary' then
      return query select 'not_permitted'::text, null::text, null::timestamptz;
      return;
    end if;

    -- 16 characters from 32 symbols: 80 random bits.
    v_bytes := extensions.gen_random_bytes(16);
    for i in 0..15 loop
      v_code := v_code
        || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) % 32) + 1, 1);
    end loop;
    delete from private.child_link_codes c where c.home_id = p_home_id and c.child_user_id = v_child;
    insert into private.child_link_codes (home_id, child_user_id, code_hash, created_by)
      values (p_home_id, v_child, extensions.digest(v_code, 'sha256'), v_user_id)
      returning child_link_codes.expires_at into v_expires;
    perform private.audit('child.link_code_issued', p_home_id, 'user', v_child, '{}'::jsonb);
    return query select 'issued'::text,
      pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4) || '-'
        || pg_catalog.substr(v_code, 9, 4) || '-' || pg_catalog.substr(v_code, 13, 4),
      v_expires;
  end
  $$;

revoke all on function public.create_child_link_code(uuid, uuid) from public, anon;
grant execute on function public.create_child_link_code(uuid, uuid) to authenticated;

-- Withdraw the open link code for the child in this Home: the child's primary guardian here.
-- Outcomes: 'cancelled', 'not_found', 'not_permitted'.
create function public.cancel_child_link_code(p_home_id uuid, p_child_membership_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
  begin
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return 'not_found';
    end if;
    if private.child_guardian_role(p_home_id, v_child, v_user_id) is distinct from 'primary' then
      return 'not_permitted';
    end if;
    delete from private.child_link_codes c where c.home_id = p_home_id and c.child_user_id = v_child;
    return 'cancelled';
  end
  $$;

revoke all on function public.cancel_child_link_code(uuid, uuid) from public, anon;
grant execute on function public.cancel_child_link_code(uuid, uuid) to authenticated;

-- Redeem a link code in the caller's Home: the caller (an adult member eligible to be a guardian)
-- becomes the child's primary guardian in this Home; the child starts on Young Child here, with the
-- colour the caller picked. Re-checked under both Homes' locks: the code is unused and unexpired,
-- whoever issued it is still the child's primary guardian in the issuing Home, the child is not
-- already in this Home, and this Home's child limit. A wrong code and a used one look the same.
-- At most 10 failed attempts per account per hour.
-- Outcomes: 'linked', 'not_found', 'not_permitted', 'invalid_code', 'expired', 'no_longer_valid',
-- 'already_linked', 'limit_reached', 'rate_limited'.
create table private.child_link_failures (
  user_id uuid not null references auth.users (id) on delete cascade,
  failed_at timestamptz not null default now()
);

create index child_link_failures_user_idx on private.child_link_failures (user_id, failed_at);
revoke all on table private.child_link_failures from public;

create function public.redeem_child_link_code(p_home_id uuid, p_code text, p_accent_color text)
returns table (outcome text, membership_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_code text := private.normalize_child_link_code(p_code);
    v_link private.child_link_codes;
    v_membership uuid;
  begin
    if p_accent_color is null or p_accent_color !~ '^#[0-9a-f]{6}$' then
      raise exception 'invalid accent colour' using errcode = '22023';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if not private.is_eligible_guardian(v_user_id) then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;
    if (select count(*) from private.child_link_failures f
        where f.user_id = v_user_id and f.failed_at > now() - interval '1 hour') >= 10 then
      return query select 'rate_limited'::text, null::uuid;
      return;
    end if;

    select * into v_link from private.child_link_codes c
      where v_code is not null and c.code_hash = extensions.digest(v_code, 'sha256');
    if not found then
      insert into private.child_link_failures (user_id) values (v_user_id);
      return query select 'invalid_code'::text, null::uuid;
      return;
    end if;

    -- Both Homes, always in the same order, so two links in opposite directions cannot deadlock.
    if v_link.home_id = p_home_id then
      return query select 'already_linked'::text, null::uuid;
      return;
    end if;
    if not private.lock_home(least(v_link.home_id, p_home_id))
       or not private.lock_home(greatest(v_link.home_id, p_home_id)) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    -- Read again under the locks: it may have been used or withdrawn meanwhile.
    select * into v_link from private.child_link_codes c where c.id = v_link.id;
    if not found then
      return query select 'invalid_code'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if v_link.expires_at <= now() then
      delete from private.child_link_codes c where c.id = v_link.id;
      return query select 'expired'::text, null::uuid;
      return;
    end if;
    if private.child_guardian_role(v_link.home_id, v_link.child_user_id, v_link.created_by)
       is distinct from 'primary' then
      delete from private.child_link_codes c where c.id = v_link.id;
      return query select 'no_longer_valid'::text, null::uuid;
      return;
    end if;
    if exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_link.child_user_id
    ) then
      return query select 'already_linked'::text, null::uuid;
      return;
    end if;
    if (select count(*) from public.home_memberships m
        join public.child_profiles c on c.user_id = m.user_id
        where m.home_id = p_home_id)
       >= (select l.per_home from private.child_creation_limits() l) then
      return query select 'limit_reached'::text, null::uuid;
      return;
    end if;

    delete from private.child_link_codes c where c.id = v_link.id;
    insert into public.home_memberships (home_id, user_id, role)
      values (p_home_id, v_link.child_user_id, 'member')
      returning id into v_membership;
    insert into public.home_member_profiles (home_id, user_id, accent_color)
      values (p_home_id, v_link.child_user_id, p_accent_color);
    insert into public.child_home_settings (home_id, child_user_id, updated_by)
      values (p_home_id, v_link.child_user_id, v_user_id);
    insert into public.child_guardians (home_id, child_user_id, guardian_user_id, role, assigned_by)
      values (p_home_id, v_link.child_user_id, v_user_id, 'primary', v_user_id);
    -- Each Home's record names only its own side.
    perform private.audit('child.linked_out', v_link.home_id, 'user', v_link.child_user_id,
      '{}'::jsonb);
    perform private.audit('child.linked_in', p_home_id, 'user', v_link.child_user_id,
      jsonb_build_object('primary_guardian', v_user_id));
    return query select 'linked'::text, v_membership;
  end
  $$;

revoke all on function public.redeem_child_link_code(uuid, text, text) from public, anon;
grant execute on function public.redeem_child_link_code(uuid, text, text) to authenticated;

-- Whether the child has an open link code in this Home (for the guardians' page); never the code.
create function public.child_link_code_state(p_home_id uuid, p_child_membership_id uuid)
returns timestamptz
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_child uuid;
  begin
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_user_id is null or v_child is null
       or private.child_guardian_role(p_home_id, v_child, v_user_id) is distinct from 'primary' then
      return null;
    end if;
    return (select c.expires_at from private.child_link_codes c
            where c.home_id = p_home_id and c.child_user_id = v_child and c.expires_at > now());
  end
  $$;

revoke all on function public.child_link_code_state(uuid, uuid) from public, anon;
grant execute on function public.child_link_code_state(uuid, uuid) to authenticated;

-- Reading the children of a Home -------------------------------------------------------------------------

-- Every member sees each child's name, colour and guardians (the directory shows them anyway).
-- Only that child's guardians in this Home see the preset, overrides, effective capabilities and age
-- band; for everyone else those columns are null. Pending guardian offers show who was asked; the
-- offer ids only to whoever may withdraw them. can_delete: the caller may delete a mistaken creation.
create function public.home_children(p_home_id uuid)
returns table (
  membership_id uuid,
  name text,
  accent_color text,
  primary_guardian_membership_id uuid,
  secondary_guardian_membership_id uuid,
  my_guardian_role text,
  preset text,
  overrides jsonb,
  capabilities text[],
  age_band text,
  settings_updated_at timestamptz,
  pending_primary_membership_id uuid,
  pending_secondary_membership_id uuid,
  pending_primary_offer_id uuid,
  pending_secondary_offer_id uuid,
  can_delete boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or p_home_id is null or private.home_role(p_home_id, v_user_id) is null then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;

    return query
      select
        m.id,
        coalesce(p.nickname, p.display_name, up.display_name),
        coalesce(p.accent_color, up.accent_color),
        (select gm.id from public.child_guardians g
           join public.home_memberships gm
             on gm.home_id = g.home_id and gm.user_id = g.guardian_user_id
           where g.home_id = m.home_id and g.child_user_id = m.user_id and g.role = 'primary'),
        (select gm.id from public.child_guardians g
           join public.home_memberships gm
             on gm.home_id = g.home_id and gm.user_id = g.guardian_user_id
           where g.home_id = m.home_id and g.child_user_id = m.user_id and g.role = 'secondary'),
        r.role,
        case when r.role is not null then s.preset end,
        case when r.role is not null then s.overrides end,
        case when r.role is not null
          then private.child_effective_capabilities(s.preset, s.overrides) end,
        case when r.role is not null then c.age_band end,
        case when r.role is not null then s.updated_at end,
        (select om.id from public.child_guardian_offers o
           join public.home_memberships om
             on om.home_id = o.home_id and om.user_id = o.guardian_user_id
           where o.home_id = m.home_id and o.child_user_id = m.user_id and o.role = 'primary'
             and o.expires_at > now()),
        (select om.id from public.child_guardian_offers o
           join public.home_memberships om
             on om.home_id = o.home_id and om.user_id = o.guardian_user_id
           where o.home_id = m.home_id and o.child_user_id = m.user_id and o.role = 'secondary'
             and o.expires_at > now()),
        -- Offer ids only for whoever may withdraw them.
        (select o.id from public.child_guardian_offers o
           where o.home_id = m.home_id and o.child_user_id = m.user_id and o.role = 'primary'
             and o.expires_at > now()
             and (o.offered_by = v_user_id or r.role = 'primary')),
        (select o.id from public.child_guardian_offers o
           where o.home_id = m.home_id and o.child_user_id = m.user_id and o.role = 'secondary'
             and o.expires_at > now()
             and (o.offered_by = v_user_id or r.role = 'primary')),
        (c.created_by = v_user_id or r.role = 'primary')
          and c.created_at > now() - private.child_correction_window()
          and not exists (
            select 1 from public.home_memberships om
            where om.user_id = m.user_id and om.home_id <> m.home_id
          )
      from public.home_memberships m
      join public.child_profiles c on c.user_id = m.user_id
      join public.child_home_settings s on s.home_id = m.home_id and s.child_user_id = m.user_id
      left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      cross join lateral (
        select private.child_guardian_role(m.home_id, m.user_id, v_user_id) as role
      ) r
      where m.home_id = p_home_id
      order by m.created_at, m.id;
  end
  $$;

revoke all on function public.home_children(uuid) from public, anon;
grant execute on function public.home_children(uuid) to authenticated;

-- The directory says which members are children -------------------------------------------------------

drop function public.home_directory(uuid);
create function public.home_directory(p_home_id uuid)
returns table (
  membership_id uuid,
  role text,
  joined_at timestamptz,
  is_self boolean,
  name text,
  accent_color text,
  avatar_file_id uuid,
  is_inactive boolean,
  is_child boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or p_home_id is null or not exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;

    return query
      select
        m.id,
        m.role,
        m.created_at,
        m.user_id = v_user_id,
        coalesce(p.nickname, p.display_name, up.display_name),
        coalesce(p.accent_color, up.accent_color),
        coalesce(p.avatar_file_id, up.avatar_file_id),
        private.is_deactivated(m.user_id),
        private.is_child(m.user_id)
      from public.home_memberships m
      left join public.home_member_profiles p
        on p.home_id = m.home_id and p.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      where m.home_id = p_home_id
      order by m.created_at, m.id;
  end
  $$;

comment on function public.home_directory(uuid) is
  'S11/S15/S38/S41: the members of a Home the caller belongs to, with effective name, colour, avatar file id, whether the account is deactivated and whether the member is a child.';

revoke all on function public.home_directory(uuid) from public, anon;
grant execute on function public.home_directory(uuid) to authenticated;

-- Removing a child from a Home ------------------------------------------------------------------------

-- As S12, plus: a child's membership may be removed only by the Owner or the child's primary guardian
-- in this Home, and never from the child's last Home (removing a child from one Home keeps the
-- identity and its other Homes; deleting a child identity is a later step). New outcome
-- 'child_last_home'.
create or replace function public.remove_home_member(
  p_home_id uuid, p_membership_id uuid, p_expected_role text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_actor_role text;
    v_target public.home_memberships;
  begin
    if p_expected_role is null or p_expected_role not in ('member', 'administrator', 'owner') then
      raise exception 'invalid role' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    v_actor_role := private.home_role(p_home_id, v_user_id);
    if v_actor_role is null then
      return 'not_found';
    end if;
    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    if v_target.role <> p_expected_role then
      return 'stale';
    end if;
    if v_target.user_id = v_user_id or v_target.role = 'owner' then
      return 'not_permitted';
    end if;

    if private.is_child(v_target.user_id) then
      if not (
        v_actor_role = 'owner'
        or private.child_guardian_role(p_home_id, v_target.user_id, v_user_id)
          is not distinct from 'primary'
      ) then
        return 'not_permitted';
      end if;
      if not exists (
        select 1 from public.home_memberships m
        where m.user_id = v_target.user_id and m.home_id <> p_home_id
      ) then
        return 'child_last_home';
      end if;
    elsif not (
      v_actor_role = 'owner'
      or (v_target.role = 'member'
          and private.has_home_capability(p_home_id, v_user_id, 'removeMembers'))
    ) then
      return 'not_permitted';
    end if;

    perform pg_catalog.set_config('madeora.membership_end', 'removed', true);
    delete from public.home_memberships where id = v_target.id;
    perform pg_catalog.set_config('madeora.membership_end', '', true);
    return 'removed';
  end
  $$;

-- A child's identity ends with its last Home ----------------------------------------------------------

-- A child's last membership can only end when its Home is purged (S40) or deleted outright; the
-- identity then has no Home and no guardian, so it is deleted with it (history keeps its rows with
-- the id set to null: "Former member").
create function private.end_orphaned_child() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if private.is_child(old.user_id) and not exists (
      select 1 from private.home_memberships_all m where m.user_id = old.user_id
    ) then
      delete from auth.users u where u.id = old.user_id;
    end if;
    return null;
  end
  $$;

revoke all on function private.end_orphaned_child() from public;

create trigger home_memberships_end_orphaned_child
  after delete on private.home_memberships_all
  for each row execute function private.end_orphaned_child();
