-- S44 follow-up (owner decision, 13 Nov 2026): wrong PIN tries on a Household Display never count
-- toward a member's PIN lock. A display is a shared screen visitors can reach, so a passer-by must
-- not be able to lock a member's (or a child's) PIN from it. The display's own limits still apply
-- to every check that is not completed: at most 20 per display per hour and 30 per client per 15
-- minutes (S42's limits), and a PIN that is already locked elsewhere is still refused here.
-- Only the two attempt functions change: each no longer counts the try as a failure up front.

create or replace function public.display_chore_attempt(
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
    insert into private.display_checks (display_id, home_id, purpose, occurrence_id, member_user_id,
                                        client_key)
      values (v_display.id, v_display.home_id, 'chore', p_occurrence_id, v_member, p_client_key)
      returning id into v_check;
    return query select 'check'::text, null::uuid, v_check, v_pin.pin_hash, null::timestamptz;
  end
  $$;

create or replace function public.display_lock_attempt(
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
    insert into private.display_checks (display_id, home_id, purpose, member_user_id, client_key)
      values (v_display.id, v_display.home_id, 'lock', v_member, p_client_key)
      returning id into v_check;
    return query select 'check'::text, v_check, v_pin.pin_hash, null::timestamptz;
  end
  $$;
