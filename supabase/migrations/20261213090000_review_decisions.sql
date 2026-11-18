-- Review backlog Part 4b: the owner's decisions (2026-11-17) turned into code (plans/steps/
-- fix-review-backlog-brief.md, "Decisions log"):
--   S41-M3  a child whose primary guardian is no longer eligible is on hold (cannot sign in) until the
--           guardian is eligible again or the Owner appoints another; guardians are warned first;
--   S41-M2  offering, handing over and removing a child's guardian role needs a fresh re-authentication;
--   S16-4   a Home's trash is restored and purged by its Owner and managers only, in every module;
--   S22-L3  a claimed chore's auto-release timer restarts when its claimant returns from a vacation;
--   S34-M6  a conflict on a calendar Google stops listing is kept, marked stale, until the owner decides;
--   S38-M7  the activity-history purge keeps the restricted security audit events;
--   S29-L9  a contributor is notified when a habit manager corrects their contribution;
--   S30-L4  only active goals count toward the 100-goal limit;
--   S25-L6  origin recipe managers see only the names of destination Homes they belong to;
--   S12b-L6 members see the ownership-recovery objection deadline;
--   S35-L6  every member with photo access sees the Home pool's figures in the photo upload flow.
-- Review fixes: Home trash managers see everything deleted in their modules and deletes say whether the
-- caller may Undo (public.can_restore_trash_entry); an Owner's appointment ends an ineligible primary's
-- role; a claimant back early (withdrawn, or the vacation cancelled) gets the restarted timer; a child on
-- hold cannot act by PIN on household devices or Displays either.
-- Forward-only. Rollback: re-apply the replaced function bodies from their original migrations,
-- rename the *_before_* functions back into place (dropping the wrappers first), and drop the added
-- helpers; no table or column changes, no data rewritten.

-- Shared helpers (defined first: SQL-language bodies are checked when they are created) ------------------

-- S41-M3: a child is on hold in a Home while it has no eligible primary guardian there (none, or one who
-- is deactivated or pending deletion). The row of an ineligible primary is kept, so their reactivation
-- restores the child's access, unless the Owner appointed someone else meanwhile.
create function private.child_on_hold(p_home_id uuid, p_child uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select not exists (
      select 1 from public.child_guardians g
      join public.home_memberships m on m.home_id = g.home_id and m.user_id = g.guardian_user_id
      where g.home_id = p_home_id and g.child_user_id = p_child and g.role = 'primary'
        and private.is_eligible_guardian(g.guardian_user_id)
    )
  $$;

revoke all on function private.child_on_hold(uuid, uuid) from public, anon, authenticated;

-- S41-M2: whether p_user_id holds an unexpired re-authentication permission for p_action, given to the
-- browser session p_session_id. Unlike consume_account_change_grant it is not used up: one fresh
-- confirmation covers the guardian changes made in the next two minutes. It already exists (S38,
-- 20261124090000_activity_history.sql); replaced in place with the same signature, adding null guards.
create or replace function private.has_account_change_grant(p_user_id uuid, p_action text, p_session_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
    select p_user_id is not null and p_session_id is not null and exists (
      select 1 from private.account_change_grants g
      where g.user_id = p_user_id and g.action = p_action and g.session_id = p_session_id
        and g.expires_at > pg_catalog.now()
    )
  $$;

revoke all on function private.has_account_change_grant(uuid, text, uuid) from public, anon, authenticated;

-- S41-M2: re-authentication, one more action -------------------------------------------------------------

alter table private.account_change_grants drop constraint account_change_grants_action_check;
alter table private.account_change_grants
  add constraint account_change_grants_action_check check (action in (
    'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
    'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account',
    'data_export', 'delete_account', 'close_home', 'delete_personal_data', 'child_guardians'
  ));

-- As S40 part 2, with one more action: 'child_guardians' (offering, handing over or removing a child's
-- guardian role).
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
      'data_export', 'delete_account', 'close_home', 'delete_personal_data', 'child_guardians'
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

-- S41-M3: an ineligible guardian holds no authority --------------------------------------------------------

-- As S41, plus: a guardian who is deactivated or pending deletion holds no role while that lasts (their
-- row stays, so reactivation restores it).
create or replace function private.child_guardian_role(p_home_id uuid, p_child uuid, p_user uuid)
returns text
  language sql stable security definer set search_path = '' as $$
    select g.role from public.child_guardians g
    join public.home_memberships m on m.home_id = g.home_id and m.user_id = g.guardian_user_id
    where g.home_id = p_home_id and g.child_user_id = p_child and g.guardian_user_id = p_user
      and private.is_eligible_guardian(g.guardian_user_id)
  $$;

-- As S42, plus: a Home where the child is on hold is not reached, so a session that reaches no other Home
-- stops working at once (request_session_state answers 'session_not_active').
create or replace function private.child_session_homes(p_child uuid, p_session uuid) returns setof uuid
  language sql stable security definer set search_path = '' as $$
    select m.home_id
    from private.child_sessions cs
    join public.home_memberships m on m.user_id = cs.child_user_id
    join public.child_home_settings s on s.home_id = m.home_id and s.child_user_id = m.user_id
    left join private.household_devices d on d.id = cs.device_id
    where cs.session_id = p_session and cs.child_user_id = p_child
      and cs.ended_at is null and cs.expires_at > pg_catalog.now()
      and not private.child_on_hold(m.home_id, m.user_id)
      and (
        (cs.method = 'password' and s.password_sign_in)
        or (cs.method = 'pin' and m.home_id = cs.home_id and s.pin_sign_in
            and d.home_id = cs.home_id and d.revoked_at is null)
      )
  $$;

-- As S42, plus: a Home where the child is on hold does not count, so a child on hold everywhere cannot
-- sign in ('not_enabled', as for sign-in that is off).
create or replace function public.child_sign_in_verified(p_attempt_id uuid)
returns table (outcome text, child_user_id uuid, alias_email text)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_a private.child_sign_in_attempts;
    v_allowed boolean;
    v_home uuid;
  begin
    if not exists (
      select 1 from pg_catalog.pg_db_role_setting rs
      join pg_catalog.pg_roles r on r.oid = rs.setrole
      where r.rolname = 'authenticator'
        and 'pgrst.db_pre_request=public.check_request' = any (rs.setconfig)
    ) then
      return query select 'not_configured'::text, null::uuid, null::text;
      return;
    end if;
    select * into v_a from private.child_sign_in_attempts a
      where a.id = p_attempt_id for update;
    if not found or v_a.child_user_id is null or v_a.checked_at is null
       or v_a.verified_at is not null then
      return query select 'invalid'::text, null::uuid, null::text;
      return;
    end if;
    if v_a.created_at <= pg_catalog.now() - (select l.attempt_lifetime
                                             from private.child_sign_in_limits() l) then
      return query select 'expired'::text, null::uuid, null::text;
      return;
    end if;
    update private.child_sign_in_attempts a set verified_at = pg_catalog.now()
      where a.id = v_a.id;
    if v_a.method = 'password' then
      -- The right password clears the count and any lock its own wrong-try count just set.
      update private.child_credentials c
        set password_failures = 0, password_locks = 0, password_locks_since = null,
            password_locked_until = null
        where c.child_user_id = v_a.child_user_id
          and c.password_locked_until is distinct from 'infinity'::timestamptz;
      v_allowed := exists (
        select 1 from public.home_memberships m
        join public.child_home_settings s on s.home_id = m.home_id and s.child_user_id = m.user_id
        where m.user_id = v_a.child_user_id and s.password_sign_in
          and not private.child_on_hold(m.home_id, m.user_id)
      );
    else
      select d.home_id into v_home from private.household_devices d where d.id = v_a.device_id;
      update private.child_home_pins hp
        set pin_failures = 0, pin_locks = 0, pin_locks_since = null, pin_locked_until = null
        where hp.home_id = v_home and hp.child_user_id = v_a.child_user_id
          and hp.pin_locked_until is distinct from 'infinity'::timestamptz;
      v_allowed := exists (
        select 1 from private.household_devices d
        join public.home_memberships m on m.home_id = d.home_id and m.user_id = v_a.child_user_id
        join public.child_home_settings s on s.home_id = m.home_id and s.child_user_id = m.user_id
        where d.id = v_a.device_id and d.revoked_at is null and s.pin_sign_in
          and not private.child_on_hold(m.home_id, m.user_id)
      );
    end if;
    if not v_allowed then
      return query select 'not_enabled'::text, null::uuid, null::text;
      return;
    end if;
    perform private.ensure_child_alias(v_a.child_user_id);
    return query select 'verified'::text, v_a.child_user_id,
                        private.child_alias_email(v_a.child_user_id);
  end
  $$;

-- As S41, plus: a primary guardian who is no longer eligible counts as none (the Owner may appoint
-- someone), and every offer needs a fresh re-authentication ('reauthentication_required', S41-M2).
create or replace function public.assign_child_guardian(
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

    -- A primary guardian who is no longer eligible (deactivated or pending deletion) counts as none:
    -- the child is on hold and the Owner may appoint someone.
    select g.guardian_user_id into v_primary from public.child_guardians g
      where g.home_id = p_home_id and g.child_user_id = v_child and g.role = 'primary'
        and private.is_eligible_guardian(g.guardian_user_id);
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
    if not private.has_account_change_grant(v_user_id, 'child_guardians', private.jwt_session_id()) then
      return 'reauthentication_required';
    end if;

    perform private.offer_child_guardian(p_home_id, v_child, v_target, v_kind, v_user_id);
    return 'offered';
  end
  $$;

-- As S41, plus: a primary guardian who is no longer eligible counts as none, so the Owner's appointment
-- can be accepted.
create or replace function public.answer_child_guardian_offer(p_offer_id uuid, p_accept boolean)
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
        and g.role = 'primary' and private.is_eligible_guardian(g.guardian_user_id);
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

-- As S41, except that a previous primary guardian who is no longer eligible (deactivated or pending
-- deletion) is not carried over as secondary when someone else becomes primary: an Owner's appointment
-- for a child on hold ends their role, so their return gives them no guardian access (S41-M3).
create or replace function private.apply_child_guardian(
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
      elsif v_primary is not null and v_primary <> p_target
            and private.is_eligible_guardian(v_primary) then
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

-- As S41, plus: removing (or stepping down from) the secondary role needs a fresh re-authentication
-- ('reauthentication_required', S41-M2).
create or replace function public.remove_child_secondary_guardian(
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
    if not exists (select 1 from public.child_guardians g
        where g.home_id = p_home_id and g.child_user_id = v_child and g.role = 'secondary') then
      return 'removed';
    end if;
    if not private.has_account_change_grant(v_user_id, 'child_guardians', private.jwt_session_id()) then
      return 'reauthentication_required';
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

-- The children who would be put on hold if the caller left p_home_id (or, with no Home, deactivated or
-- deleted their account): those they are the primary guardian of, counted per Home. Shown as a warning
-- before they leave, deactivate or delete, with the advice to hand the role over first.
create function public.my_guardian_hold_warnings(p_home_id uuid default null)
returns table (home_id uuid, home_name text, children integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return query
      select h.id, h.name, pg_catalog.count(*)::integer
      from public.child_guardians g
      join public.home_memberships c on c.home_id = g.home_id and c.user_id = g.child_user_id
      join public.homes h on h.id = g.home_id
      where g.guardian_user_id = v_user_id and g.role = 'primary'
        and (p_home_id is null or g.home_id = p_home_id)
      group by h.id, h.name
      order by h.name, h.id;
  end
  $$;

revoke all on function public.my_guardian_hold_warnings(uuid) from public, anon;
grant execute on function public.my_guardian_hold_warnings(uuid) to authenticated;

-- The Home's children, as S41, except that a guardian who is no longer eligible (deactivated) is not
-- listed as one: the child shows as on hold, and the Owner can appoint a primary guardian.
create or replace function public.home_children(p_home_id uuid)
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
           where g.home_id = m.home_id and g.child_user_id = m.user_id and g.role = 'primary'
             and private.is_eligible_guardian(g.guardian_user_id)),
        (select gm.id from public.child_guardians g
           join public.home_memberships gm
             on gm.home_id = g.home_id and gm.user_id = g.guardian_user_id
           where g.home_id = m.home_id and g.child_user_id = m.user_id and g.role = 'secondary'
             and private.is_eligible_guardian(g.guardian_user_id)),
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


-- S16-4: a Home's trash belongs to its Owner and managers -------------------------------------------------

-- The capability that makes an Administrator a manager of a module's Home items (the sample type and any
-- unknown module: none; manageHomeSettings reaches every module).
create function private.trash_manager_capability(p_module text) returns text
  language sql immutable set search_path = '' as $$
    select case p_module
      when 'dashboard' then 'manageHomeDashboard'
      when 'tasks' then 'manageHomeTasks'
      when 'chores' then 'manageHomeChores'
      when 'recipes' then 'manageHomeRecipes'
      when 'shopping' then 'manageHomeShopping'
      when 'meals' then 'manageHomeMeals'
      when 'habits' then 'manageHomeHabits'
      when 'goals' then 'manageHomeGoals'
      when 'pets' then 'manageHomePets'
      when 'calendar' then 'manageHomeCalendar'
      when 'photos' then 'manageHomePhotos'
    end
  $$;

revoke all on function private.trash_manager_capability(text) from public, anon, authenticated;

-- Whether p_user_id manages p_module's trash in a Home: the Owner, or an Administrator granted
-- manageHomeSettings or the module's own capability. Never null.
create function private.can_manage_home_trash(p_home_id uuid, p_module text, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
    select coalesce(
      private.has_home_capability(p_home_id, p_user_id, 'manageHomeSettings')
      or (private.trash_manager_capability(p_module) is not null
        and private.has_home_capability(p_home_id, p_user_id, private.trash_manager_capability(p_module))),
      false)
  $$;

revoke all on function private.can_manage_home_trash(uuid, text, uuid) from public, anon, authenticated;

-- The owner's decision (2026-11-17): restoring and purging a Home's trash, in every module, is for the
-- Owner and that module's managers only; a member who deleted an item no longer restores or purges it.
-- One rule governs listing, restoring and purging (ADR 0020), so a Home entry is now also listed only to
-- them. In the modules with the generic rule (the deleter or manageHomeSettings), a manager now sees and
-- restores everything deleted in their module, not only what they deleted themselves. The modules with
-- their own rule (pets with its medical managers, calendar levels, photo access) keep it, narrowed to
-- managers. Personal entries are unchanged: their owner's alone.
alter function private.can_see_trash_entry(private.trash_entries, uuid) rename to can_see_trash_entry_before_managers;

create function private.can_see_trash_entry(p_entry private.trash_entries, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
    select coalesce(case
      when p_entry.owner_home_id is null then private.can_see_trash_entry_before_managers(p_entry, p_user_id)
      when p_entry.module in ('pets', 'calendar', 'photos') then
        private.can_see_trash_entry_before_managers(p_entry, p_user_id)
          and private.can_manage_home_trash(p_entry.owner_home_id, p_entry.module, p_user_id)
      -- can_manage_home_trash holds only for a current member (has_home_capability checks it).
      else private.can_manage_home_trash(p_entry.owner_home_id, p_entry.module, p_user_id)
    end, false)
  $$;

revoke all on function private.can_see_trash_entry(private.trash_entries, uuid) from public, anon, authenticated;
revoke all on function private.can_see_trash_entry_before_managers(private.trash_entries, uuid)
  from public, anon, authenticated;

-- Whether the caller may restore a trash entry now (S16-4), so a delete offers Undo only to someone whose
-- Undo would work. False for an entry they may not see, one expired, restored or purged, and an unknown id.
create function public.can_restore_trash_entry(p_entry_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select coalesce((
      select t.status = 'trashed' and t.expires_at > pg_catalog.now()
        and private.can_see_trash_entry(t, auth.uid())
      from private.trash_entries t where t.id = p_entry_id), false)
  $$;

revoke all on function public.can_restore_trash_entry(uuid) from public, anon;
grant execute on function public.can_restore_trash_entry(uuid) to authenticated;

-- S30-L4: only active goals count toward the limit ---------------------------------------------------------

-- As S30, except that an achieved (completed) goal no longer counts toward the 100 goals of a context.
-- Reopening an achieved goal is not refused, so a context may briefly hold more than 100 active goals.
create or replace function public.create_goal(
  p_id uuid, p_home_id uuid default null, p_kind text default null, p_title text default null,
  p_description text default null, p_target numeric default null, p_unit text default null,
  p_unit_kind text default null, p_initial numeric default null, p_deadline date default null,
  p_time_zone text default null, p_renewed_from uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.goals;
    v_goal private.goals;
    v_zone text;
  begin
    perform private.require_goal_context(p_home_id, v_user_id);
    if p_id is null or p_title is null or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description')))
       or not private.valid_goal_shape(p_kind, p_target, p_unit, p_unit_kind)
       or (p_kind = 'completion' and p_initial is not null)
       or (p_kind = 'measurable' and p_initial is not null
         and not private.valid_goal_quantity(p_initial, private.goal_unit_discrete(p_unit, p_unit_kind), true))
       or (p_home_id is null and not private.valid_time_zone(p_time_zone)) then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    if private.goal_access(p_home_id, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_existing from private.goals g where g.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by = v_user_id and v_existing.owner_home_id is not distinct from p_home_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if p_renewed_from is not null and private.goal_for(p_renewed_from, v_user_id) is null then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    v_zone := case when p_home_id is null then p_time_zone
      else (select h.timezone from public.homes h where h.id = p_home_id) end;
    if p_deadline is not null and p_deadline < (pg_catalog.now() at time zone v_zone)::date then
      return query select 'invalid_dates', null::integer;
      return;
    end if;
    -- Counted under the context lock, so two creates cannot both pass the limit.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('goals:' || coalesce(p_home_id, v_user_id)::text, 0));
    if (select count(*) from private.goals g
        where g.deleted_at is null and g.archived_at is null and g.achieved_at is null and g.series_id is null
          and ((p_home_id is null and g.owner_home_id is null and g.owner_user_id = v_user_id)
            or (p_home_id is not null and g.owner_home_id = p_home_id))) >= private.goal_limit('goals') then
      return query select 'too_many', null::integer;
      return;
    end if;
    insert into private.goals (id, owner_user_id, owner_home_id, kind, title, description, time_zone, target,
        unit, unit_kind, deadline, renewed_from, created_by, updated_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_kind, p_title, p_description,
        case when p_home_id is null then p_time_zone end, p_target, p_unit, p_unit_kind, p_deadline,
        p_renewed_from, v_user_id, v_user_id)
      returning * into v_goal;
    if p_kind = 'measurable' then
      insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, contributed_by, source)
        values (gen_random_uuid(), v_goal.id, 'initial', coalesce(p_initial, 0), v_goal.unit, v_goal.unit_kind,
          v_user_id, 'app');
    end if;
    perform private.goal_event(v_goal.id, 'created', v_user_id, null,
      pg_catalog.jsonb_build_object('kind', p_kind, 'target', p_target, 'initial', p_initial,
        'renewed', p_renewed_from is not null));
    perform private.audit_goal('goal.created', v_goal);
    return query select 'created', v_goal.revision;
  end
  $$;

-- The same for unarchiving (public.archive_goal wraps this since S30c): an achieved goal comes back
-- without counting.
create or replace function private.archive_goal_before_links(p_id uuid, p_expected_revision integer, p_archived boolean)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
  begin
    if p_id is null or p_expected_revision is null or p_archived is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.goal_may(v_goal, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_goal.revision <> p_expected_revision then
      return query select 'conflict', v_goal.revision;
      return;
    end if;
    if (v_goal.archived_at is not null) = p_archived then
      return query select 'unchanged', v_goal.revision;
      return;
    end if;
    if not p_archived and v_goal.series_id is null and v_goal.achieved_at is null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'goals:' || coalesce(v_goal.owner_home_id, v_goal.owner_user_id)::text, 0));
      if (select count(*) from private.goals g
          where g.deleted_at is null and g.archived_at is null and g.achieved_at is null and g.series_id is null
            and g.owner_user_id is not distinct from v_goal.owner_user_id
            and g.owner_home_id is not distinct from v_goal.owner_home_id) >= private.goal_limit('goals') then
        return query select 'too_many', v_goal.revision;
        return;
      end if;
    end if;
    update private.goals g
      set archived_at = case when p_archived then pg_catalog.now() end,
        archived_by = case when p_archived then v_user_id end,
        revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where g.id = v_goal.id returning * into v_goal;
    if not p_archived then
      perform private.reschedule_goal_reminders(v_goal.id);
    end if;
    perform private.goal_event(v_goal.id, case when p_archived then 'archived' else 'unarchived' end, v_user_id);
    perform private.audit_goal(case when p_archived then 'goal.archived' else 'goal.unarchived' end, v_goal);
    return query select 'saved', v_goal.revision;
  end
  $$;


-- S25-L6: destination names only for Homes the viewer belongs to --------------------------------------------

-- As S25, except that a destination Home the caller is not a member of has no name (null); the page
-- shows a generic "another Home" instead.
create or replace function public.list_recipe_shares(p_recipe_id uuid)
returns table (home_id uuid, home_name text, state text, can_edit boolean, shared_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_share_recipe(v_recipe, v_user_id) then
      return;
    end if;
    return query
      select s.home_id,
        case when exists (select 1 from public.home_memberships m
          where m.home_id = s.home_id and m.user_id = v_user_id) then h.name end,
        case when s.suspended_at is null then 'active' else 'paused' end, s.can_edit, s.shared_at
      from private.recipe_shares s join public.homes h on h.id = s.home_id
      where s.recipe_id = v_recipe.id
      union all
      select h.id, h.name, 'available', false, null::timestamptz
      from public.home_memberships m join public.homes h on h.id = m.home_id
      where m.user_id = v_user_id and h.id is distinct from v_recipe.owner_home_id
        and not exists (select 1 from private.recipe_shares s where s.recipe_id = v_recipe.id and s.home_id = h.id)
      order by 3, 2, 1;
  end
  $$;

-- As S27, with the same rule for the shares in the impact (unnamed ones last).
create or replace function public.recipe_delete_impact(p_recipe_id uuid)
returns table (outcome text, impact jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_see_recipe(v_recipe, v_user_id) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    if not private.can_delete_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    return query select 'ok', pg_catalog.jsonb_build_object(
      'token', private.recipe_impact_token(v_recipe),
      'status', v_recipe.status,
      'homeId', v_recipe.owner_home_id,
      'shares', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'homeId', s.home_id,
            'homeName', case when exists (select 1 from public.home_memberships m
              where m.home_id = s.home_id and m.user_id = v_user_id) then h.name end,
            'canEdit', s.can_edit)
          order by (not exists (select 1 from public.home_memberships m
              where m.home_id = s.home_id and m.user_id = v_user_id)), h.name, s.home_id)
        from private.recipe_shares s join public.homes h on h.id = s.home_id
        where s.recipe_id = v_recipe.id and s.suspended_at is null), '[]'::jsonb),
      'favoriteCount', (select count(*) from private.recipe_favorites f where f.recipe_id = v_recipe.id),
      'beingEdited', exists (
        select 1 from private.recipe_edit_locks l
        where l.recipe_id = v_recipe.id and l.user_id <> v_user_id and l.expires_at > pg_catalog.now()),
      'plannedMeals', (select count(*) from private.meal_entries e
        where e.recipe_id = v_recipe.id and e.deleted_at is null
          and e.on_date >= (pg_catalog.now() at time zone 'UTC')::date - 1),
      'repeatingMeals', (select count(distinct r.series_id) from private.meal_recurrences r
        join private.meal_series s on s.id = r.series_id
        where r.recipe_id = v_recipe.id and s.status <> 'ended'
          and (r.end_on is null or r.end_on >= (pg_catalog.now() at time zone 'UTC')::date - 1))
    );
  end
  $$;

-- S12b-L6: the objection deadline for every member -------------------------------------------------------

-- As S12b, except that every member sees the end of the objection period (members are the ones expected
-- to object; their notification already carries it). Who asked, the statement and the objections stay
-- as before.
create or replace function public.home_ownership_recovery_status(p_home_id uuid)
returns table (
  id uuid, viewer text, state text, created_at timestamptz, objection_ends_at timestamptz,
  claimant_membership_id uuid, objected boolean
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_role text;
  begin
    v_role := private.home_role(p_home_id, v_user_id);
    if v_role is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if v_role = 'owner' then
      -- The Home lock first, as every function that changes cases takes it (no deadlock with an
      -- acceptance in progress).
      perform private.lock_home(p_home_id);
      update private.home_ownership_recoveries r
        set owner_seen_at = pg_catalog.now()
        where r.home_id = p_home_id and r.owner_id = v_user_id and r.owner_seen_at is null
          and r.status in ('submitted', 'in_review', 'approved', 'paused');
    end if;
    return query
      select r.id,
        case when r.claimant_id = v_user_id then 'claimant'
             when v_role = 'owner' then 'owner' else 'member' end,
        private.recovery_state(r), r.created_at,
        r.objection_ends_at,
        case when v_role = 'owner' then (
          select m.id from public.home_memberships m
          where m.home_id = p_home_id and m.user_id = r.claimant_id
        ) end,
        exists (
          select 1 from private.home_ownership_recovery_objections o
          where o.recovery_id = r.id and o.objector_id = v_user_id
        )
      from private.home_ownership_recoveries r
      where r.home_id = p_home_id
        and (
          (r.claimant_id = v_user_id
            and (r.status in ('submitted', 'in_review', 'approved', 'paused')
                 or r.decided_at > pg_catalog.now() - interval '30 days'))
          or (r.claimant_id <> v_user_id
            and r.status in ('submitted', 'in_review', 'approved', 'paused'))
        )
      order by r.created_at desc;
  end
  $$;

-- S35-L6: storage figures in the photo upload flow for every member ------------------------------------------

-- A Home's storage, as home_storage_usage, for every member who may see its photo library (the people
-- who upload there). Only the figures: managing storage stays with the Home's storage managers.
create function public.home_photo_storage_usage(p_home_id uuid)
returns table (
  allowance_bytes bigint, used_bytes bigint, deleted_bytes bigint, reserved_bytes bigint,
  warning_level smallint
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pool private.storage_pools;
    v_usage record;
  begin
    if p_home_id is null or private.photo_access(p_home_id, v_user_id) is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    select * into v_pool from private.storage_pools p where p.owner_home_id = p_home_id;
    if not found then
      return query select (select d.allowance_bytes from private.storage_defaults d
        where d.pool_kind = 'home'), 0::bigint, 0::bigint, 0::bigint, 0::smallint;
      return;
    end if;
    select * into v_usage from private.storage_usage(v_pool.id);
    return query select private.storage_allowance(v_pool), v_usage.ready_bytes,
      v_usage.deleted_bytes, v_usage.reserved_bytes, v_pool.warning_level;
  end
  $$;

revoke all on function public.home_photo_storage_usage(uuid) from public, anon;
grant execute on function public.home_photo_storage_usage(uuid) to authenticated;

-- S34-M6: conflicts outlive a calendar Google stops listing ------------------------------------------------

-- As S34, except that a conflict is kept when its calendar leaves Google's list (only the owner's choice
-- ends a conflict); its waiting and failed changes still go, since nothing can be sent there any more.
-- While the calendar is unavailable the conflict is stale: it can only be dropped ("Google's version").
-- If the calendar comes back, the conflict is live again.
create or replace function public.google_sync_calendars(p_connection_id uuid, p_lease uuid, p_calendars jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_connection private.google_calendar_connections := private.google_leased(p_connection_id, p_lease);
    v_first boolean;
  begin
    if v_connection.id is null then
      return null;
    end if;
    if p_calendars is null or pg_catalog.jsonb_typeof(p_calendars) <> 'array'
      or pg_catalog.jsonb_array_length(p_calendars) > private.google_calendar_limit('listed_calendars') then
      raise exception 'invalid calendars' using errcode = '22023';
    end if;
    if exists (select 1 from pg_catalog.jsonb_array_elements(p_calendars) x
        where pg_catalog.jsonb_typeof(x) <> 'object' or pg_catalog.jsonb_typeof(x -> 'id') <> 'string'
          or pg_catalog.jsonb_typeof(x -> 'name') <> 'string' or pg_catalog.jsonb_typeof(x -> 'accessRole') <> 'string') then
      raise exception 'invalid calendars' using errcode = '22023';
    end if;
    v_first := v_connection.calendars_listed_at is null;
    insert into private.google_calendars (connection_id, user_id, google_calendar_id, name, time_zone, access_role,
        is_primary, available, sync_enabled, show_personal)
      select v_connection.id, v_connection.user_id, x ->> 'id', x ->> 'name',
        case when private.calendar_valid_zone(x ->> 'timeZone') then x ->> 'timeZone' end,
        x ->> 'accessRole', coalesce((x ->> 'primary')::boolean, false), true,
        v_first and coalesce((x ->> 'primary')::boolean, false), v_first and coalesce((x ->> 'primary')::boolean, false)
      from pg_catalog.jsonb_array_elements(p_calendars) x
      on conflict on constraint google_calendars_google_key do update
        set name = excluded.name, time_zone = excluded.time_zone, access_role = excluded.access_role,
          is_primary = excluded.is_primary, available = true;
    with gone as (
      update private.google_calendars c set available = false, sync_token = null, last_synced_at = null,
          full_synced_at = null, last_error_code = null
        where c.connection_id = v_connection.id and c.available
          and c.google_calendar_id not in (select x ->> 'id' from pg_catalog.jsonb_array_elements(p_calendars) x)
        returning c.id
    ), drop_events as (
      delete from private.google_calendar_events e where e.calendar_id in (select id from gone)
    ), drop_changes as (
      delete from private.google_calendar_changes x where x.calendar_id in (select id from gone)
        and x.state <> 'conflict'
    )
    delete from private.google_calendar_home_shares s where s.calendar_id in (select id from gone);
    update private.google_calendar_connections k set calendars_listed_at = pg_catalog.now(),
        write_calendar_id = case
          when v_first then (select c.id from private.google_calendars c
            where c.connection_id = k.id and c.is_primary and c.sync_enabled and c.access_role in ('owner', 'writer')
            limit 1)
          when exists (select 1 from private.google_calendars c where c.id = k.write_calendar_id
            and c.available and c.sync_enabled and c.access_role in ('owner', 'writer')) then k.write_calendar_id
        end
      where k.id = v_connection.id;
    return coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', c.id, 'googleId', c.google_calendar_id, 'syncToken', c.sync_token,
          'fullDue', c.sync_token is null or c.full_synced_at is null
            or c.full_synced_at < pg_catalog.now() - pg_catalog.make_interval(hours => private.google_calendar_limit('full_hours')))
        order by c.is_primary desc, c.id)
      from (select * from private.google_calendars c
        where c.connection_id = v_connection.id and c.sync_enabled and c.available
        order by c.is_primary desc, c.id limit private.google_calendar_limit('synced_calendars')) c), '[]'::jsonb);
  exception
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception 'invalid calendars' using errcode = '22023';
  end
  $$;

-- Choosing Madeora's version needs a calendar Google still lists ('calendar_unavailable'); choosing
-- Google's version drops a stale conflict as before.
alter function public.resolve_google_calendar_conflict(uuid, text) rename to resolve_google_calendar_conflict_before_stale;
revoke all on function public.resolve_google_calendar_conflict_before_stale(uuid, text) from public, anon, authenticated;
alter function public.resolve_google_calendar_conflict_before_stale(uuid, text) set schema private;

create function public.resolve_google_calendar_conflict(p_change_id uuid, p_choice text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_stale boolean;
  begin
    if p_choice = 'madeora' then
      select not c.available into v_stale
        from private.google_calendar_changes x
        join private.google_calendars c on c.id = x.calendar_id
        where x.id = p_change_id and x.user_id = v_user_id and x.state = 'conflict';
      if coalesce(v_stale, false) then
        return 'calendar_unavailable';
      end if;
    end if;
    return private.resolve_google_calendar_conflict_before_stale(p_change_id, p_choice);
  end
  $$;

revoke all on function public.resolve_google_calendar_conflict(uuid, text) from public, anon;
grant execute on function public.resolve_google_calendar_conflict(uuid, text) to authenticated;

-- The connection, as before, with each listed change marked 'stale' when its calendar is no longer
-- listed by Google.
alter function public.get_google_calendar_connection() rename to get_google_calendar_connection_before_stale;
revoke all on function public.get_google_calendar_connection_before_stale() from public, anon, authenticated;
alter function public.get_google_calendar_connection_before_stale() set schema private;

create function public.get_google_calendar_connection() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_result jsonb := private.get_google_calendar_connection_before_stale();
  begin
    if v_result is null then
      return null;
    end if;
    return v_result || pg_catalog.jsonb_build_object('changes', coalesce((
      select pg_catalog.jsonb_agg(e.value || pg_catalog.jsonb_build_object('stale', coalesce((
          select not c.available from private.google_calendar_changes x
          join private.google_calendars c on c.id = x.calendar_id
          where x.id = (e.value ->> 'id')::uuid), false))
        order by e.n)
      from pg_catalog.jsonb_array_elements(v_result -> 'changes') with ordinality as e (value, n)),
      '[]'::jsonb));
  end
  $$;

revoke all on function public.get_google_calendar_connection() from public, anon;
grant execute on function public.get_google_calendar_connection() to authenticated;

-- S22-L3: the auto-release timer restarts after a vacation ------------------------------------------------

-- As S20, except that a claimant's vacation restarts the timer: when they were away (a participation that
-- had begun) on or after the day they claimed, the hours count from the day after their last day away
-- when that is later than the day after the due date. The last day away is the participation's end, or
-- the day before they came back early: the day before the vacation was cancelled, or before they
-- withdrew or were removed (the date of that event). While they are away nothing is released either
-- (private.auto_release_chore_claim, S22).
create or replace function private.chore_release_at(
  p_occurrence private.chore_occurrences, p_chore private.chores, p_zone text
) returns timestamptz
  language sql stable set search_path = '' as $$
  select case when p_chore.auto_release_hours is not null and p_occurrence.claimed_by is not null
    then (greatest(p_occurrence.due_date + 1, coalesce((
        select pg_catalog.max(x.last_day) + 1
        from (
          select p.starts_on,
            case
              when p.status = 'accepted' and v.cancelled_at is null then p.ends_on
              when p.status = 'accepted' then
                least(p.ends_on, (v.cancelled_at at time zone coalesce(p_zone, 'UTC'))::date - 1)
              else least(p.ends_on, (
                select (pg_catalog.max(ev.created_at) at time zone coalesce(p_zone, 'UTC'))::date - 1
                from private.home_vacation_events ev
                where ev.vacation_id = p.vacation_id and ev.subject_id = p.user_id
                  and ev.kind in ('withdrawn', 'removed')))
            end as last_day
          from private.home_vacation_participants p
          join private.home_vacations v on v.id = p.vacation_id
          where p.home_id = p_occurrence.home_id and p.user_id = p_occurrence.claimed_by
            and (p.status = 'accepted'
              or (p.status = 'withdrawn' and p.ended_reason in ('self', 'manager', 'creator')))
            and p.starts_on <= (pg_catalog.now() at time zone coalesce(p_zone, 'UTC'))::date
        ) x
        where x.last_day >= x.starts_on
          and x.last_day >= (p_occurrence.claimed_at at time zone coalesce(p_zone, 'UTC'))::date
      ), p_occurrence.due_date + 1))::timestamp at time zone coalesce(p_zone, 'UTC'))
      + pg_catalog.make_interval(hours => p_chore.auto_release_hours) end;
  $$;

-- S38-M7: the purge keeps security audit events -----------------------------------------------------------

-- As the review backlog's Part 2, except that the restricted security audit trail
-- (private.account_security_events) is no longer purged with the visible history: the owner decided to
-- keep it (it goes only with the account itself).
create or replace function public.purge_account_activity() returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    delete from private.account_activity_events a
      where a.created_at < pg_catalog.now() - private.activity_retention();
    get diagnostics v_count = row_count;
    update private.security_reports r set rows = null
      where r.rows is not null and (r.expires_at <= pg_catalog.now() or r.discarded_at is not null);
    delete from private.security_reports r
      where r.expires_at < pg_catalog.now() - interval '7 days';
    return v_count;
  end
  $$;

-- S29-L9: the contributor hears about a manager's correction ----------------------------------------------

-- As S29, plus a notification (category 'habits', the contributor's own preferences) when a habit
-- manager voids or amends another member's contribution.
create or replace function public.update_habit_contribution(
  p_id uuid, p_action text, p_quantity numeric default null, p_reason text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_contribution private.habit_contributions;
    v_tracking private.habit_tracking;
    v_today date;
    v_before integer;
    v_sync jsonb;
    v_own boolean;
    v_manage boolean;
  begin
    if p_id is null or p_action is null or p_action not in ('undo', 'void', 'amend')
       or (p_reason is not null and not private.is_plain_text(p_reason, private.habit_limit('reason')))
       or (p_action = 'amend') <> (p_quantity is not null)
       or (p_quantity is not null and (p_quantity <= 0 or p_quantity > 1000000)) then
      raise exception 'invalid contribution' using errcode = '22023';
    end if;
    v_habit := private.habit_lock((select c.habit_id from private.habit_contributions c where c.id = p_id), v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_contribution from private.habit_contributions c where c.id = p_id for update;
    v_today := private.habit_today(v_habit);
    if v_contribution.status = 'undone' then
      return pg_catalog.jsonb_build_object('outcome', 'already_undone',
        'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    if v_habit.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    v_own := v_contribution.contributed_by = v_user_id;
    v_manage := private.habit_may(v_habit, v_user_id, 'manage');
    if p_action = 'undo' and not (v_own and private.habit_may(v_habit, v_user_id, 'complete')
         and v_contribution.on_date >= v_today - private.habit_limit('backdate_days')) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if p_action <> 'undo' and not v_manage then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_tracking := private.habit_tracking_on(v_habit.id, v_contribution.on_date);
    if p_action = 'amend' then
      if p_quantity <> pg_catalog.round(p_quantity, 3) then
        return pg_catalog.jsonb_build_object('outcome', 'precision');
      end if;
      if not private.valid_habit_quantity(p_quantity,
          (select i.discrete from private.habit_unit_info(v_tracking.unit, v_tracking.unit_kind) i)) then
        raise exception 'invalid contribution' using errcode = '22023';
      end if;
    end if;
    select s.current_count into v_before from private.habit_streak(v_habit, v_today) s;
    if p_action = 'amend' then
      update private.habit_contributions c set original_quantity = coalesce(c.original_quantity, c.quantity),
          quantity = p_quantity, amended_by = v_user_id, amended_at = pg_catalog.now(),
          entered_quantity = null, entered_unit = null
        where c.id = v_contribution.id returning * into v_contribution;
    else
      update private.habit_contributions c set status = 'undone', undone_by = v_user_id,
          undone_at = pg_catalog.now(), undo_kind = case when p_action = 'undo' then 'undo' else 'correction' end,
          undo_reason = p_reason
        where c.id = v_contribution.id returning * into v_contribution;
    end if;
    if p_action <> 'undo' then
      perform private.habit_event(v_habit.id, 'contribution_corrected', v_user_id, v_contribution.on_date, null,
        pg_catalog.jsonb_build_object('action', p_action, 'ownContribution', v_own));
      perform private.audit_habit('habit.contribution_corrected', v_habit,
        pg_catalog.jsonb_build_object('onDate', v_contribution.on_date, 'action', p_action));
      -- S29-L9 (owner decision): the contributor hears that a manager corrected their contribution,
      -- through their 'habits' notification preferences (in-app only; never the reason).
      if not v_own then
        perform private.notify_user(v_contribution.contributed_by, v_habit.owner_home_id, 'habits',
          'habit.contribution_corrected',
          pg_catalog.jsonb_build_object('habitId', v_habit.id, 'onDate', v_contribution.on_date,
            'action', p_action),
          -- One notice per correction: the same correction retried in one transaction is not repeated.
          'habit-contribution-corrected:' || v_contribution.id::text || ':' || p_action || ':'
            || pg_catalog.date_part('epoch', pg_catalog.now())::text);
      end if;
    end if;
    v_sync := private.habit_numeric_sync(v_habit, v_contribution.on_date, v_user_id, false);
    return pg_catalog.jsonb_build_object('outcome', case when p_action = 'undo' then 'undone' else 'corrected' end,
      'completedNow', (v_sync ->> 'changed') is not distinct from 'completed',
      'reopened', (v_sync ->> 'changed') is not distinct from 'reopened',
      'progress', private.habit_progress_json(v_habit, v_contribution.on_date),
      'streakBefore', v_before,
      'milestone', null,
      'habit', private.habit_summary_json(v_habit, v_user_id));
  end
  $$;

-- S41-M3 (review M-3): a child on hold cannot act in the Home by PIN either ----------------------------------

-- As S42, except that a child on hold is not offered on an approved device's sign-in picker.
create or replace function public.household_device_sign_in(p_device_hash text)
returns table (
  device_id uuid,
  home_id uuid,
  home_name text,
  device_label text,
  child_membership_id uuid,
  child_name text,
  child_accent_color text
)
  language sql stable security definer set search_path = '' as $$
    select d.id, d.home_id, h.name, d.label, m.id,
           coalesce(p.nickname, p.display_name, up.display_name),
           coalesce(p.accent_color, up.accent_color)
    from private.approved_device(coalesce(p_device_hash, '')) d
    join public.homes h on h.id = d.home_id
    left join public.home_memberships m on m.home_id = d.home_id
      and exists (
        select 1 from public.child_home_settings s
        join private.child_home_pins hp
          on hp.home_id = s.home_id and hp.child_user_id = s.child_user_id
        where s.home_id = m.home_id and s.child_user_id = m.user_id and s.pin_sign_in
          and not private.child_on_hold(m.home_id, m.user_id)
      )
    left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
    left join public.user_preferences up on up.user_id = m.user_id
    where d.id is not null
    order by m.created_at, m.id
  $$;


-- As S42 part 2, except that a child on hold is not listed on the device's board...
create or replace function public.shared_device_board(p_device_hash text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_device private.household_devices := private.approved_device(coalesce(p_device_hash, ''));
    v_today date;
  begin
    if v_device.id is null then
      return null;
    end if;
    v_today := private.task_today(v_device.home_id, null);
    return jsonb_build_object(
      'require_pin', coalesce((select s.require_pin from private.shared_device_settings s
                               where s.home_id = v_device.home_id), false),
      'members', coalesce((
        select jsonb_agg(jsonb_build_object(
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
        where m.home_id = v_device.home_id
          and not (private.is_child(m.user_id) and private.child_on_hold(m.home_id, m.user_id))), '[]'::jsonb),
      'chores', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'occurrence_id', o.id,
                 'title', c.title,
                 'due_date', o.due_date,
                 'overdue', o.due_date < v_today,
                 'assignee_ids', coalesce((
                   select jsonb_agg(private.member_ref(a.home_id, a.user_id))
                   from private.chore_occurrence_assignees a where a.occurrence_id = o.id),
                   '[]'::jsonb),
                 'mandatory_open', (select count(*) from private.chore_occurrence_steps st
                   where st.occurrence_id = o.id and st.mandatory and st.checked_at is null),
                 'requires_approval', c.requires_approval,
                 'requires_pin', exists (select 1 from private.shared_device_chore_rules r
                                         where r.chore_id = c.id))
               order by o.due_date, c.title, o.id)
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = v_device.home_id and o.status = 'open' and o.deleted_at is null
          and c.deleted_at is null and o.due_date <= v_today), '[]'::jsonb)
    );
  end
  $$;


-- ...and cannot be named for a chore on the device (an adult never is "on hold": the check is for children).
create or replace function private.device_member(
  p_device private.household_devices, p_occurrence_id uuid, p_membership_id uuid
) returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    join private.chore_occurrences o on o.id = p_occurrence_id and o.home_id = m.home_id
    where m.home_id = p_device.home_id and m.id = p_membership_id and o.deleted_at is null
      and (not private.is_child(m.user_id)
           or (exists (select 1 from private.chore_occurrence_assignees a
                       where a.occurrence_id = o.id and a.user_id = m.user_id)
               and not private.child_on_hold(m.home_id, m.user_id)))
  $$;


-- As S44: the same on a Household Display.
create or replace function private.display_member(p_home_id uuid, p_occurrence_id uuid, p_membership_id uuid)
returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    join private.chore_occurrences o on o.id = p_occurrence_id and o.home_id = m.home_id
    where m.home_id = p_home_id and m.id = p_membership_id and o.deleted_at is null
      and (not private.is_child(m.user_id)
           or (exists (select 1 from private.chore_occurrence_assignees a
                       where a.occurrence_id = o.id and a.user_id = m.user_id)
               and not private.child_on_hold(m.home_id, m.user_id)))
  $$;

