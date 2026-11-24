-- UX8a: protected-action sessions and ambient timing on Household Displays (redesign decisions 36
-- and 37, Ward's answer of 19 Nov 2026; brief plans/steps/UX8a-brief.md).
--
-- - A member's PIN that matches on a display opens a five-minute protected-actions session for that
--   member on that display. While it lasts, actions that would ask that member for their PIN on that
--   display (completing a chore that needs a PIN, locking the display into privacy mode for a
--   manager) are taken without asking again. Every other check still runs on every action: the
--   display is active and unlocked, the member is still a member, eligible for the chore, a manager
--   for locking. The session never widens what the member may do.
-- - One session per display (the newest PIN replaces it). It lasts five minutes from the PIN and is
--   never extended. It ends early when someone taps Lock now, when the display goes ambient, when
--   the display is privacy-locked or revoked, and it stops counting when the member leaves the
--   Home or their PIN is removed, changed or locked.
-- - The privacy lock is unchanged (S44): only a manager's own signed-in session unlocks it. A
--   session cannot unlock it, and locking a display ends its session.
-- - No-lockout rule (13 Nov 2026) unchanged: wrong tries on a display never count toward a member's
--   PIN lock. Sessions are opened only after the existing PIN check, with its display and client
--   throttles.
-- - Ambient timing: each Home has one setting for how long its displays wait without a touch before
--   showing the ambient view (default five minutes). Its managers change it.
--
-- Rollback: drop the two new tables and the new functions, and restore display_chore_attempt
-- (20261205090000) and display_chore_verified (20261204090000). Rows of
-- private.display_actions with verification 'session' must be updated to 'pin' before restoring the
-- old check constraint.

-- 1. Sessions ------------------------------------------------------------------------------------------------

alter table private.display_actions drop constraint display_actions_verification_check;
alter table private.display_actions add constraint display_actions_verification_check
  check (verification in ('attributed', 'pin', 'session'));

-- The open protected-actions session of a display, if any. Expired rows are harmless (every reader
-- checks expires_at) and are deleted when the display's state is read or a session is opened.
create table private.display_unlock_sessions (
  display_id uuid primary key references private.household_displays (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  opened_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint display_unlock_sessions_expiry_check
    check (expires_at > opened_at and expires_at <= opened_at + interval '5 minutes')
);

create index display_unlock_sessions_member_idx on private.display_unlock_sessions (member_user_id);

revoke all on table private.display_unlock_sessions from public;

comment on table private.display_unlock_sessions is
  'UX8a: a member''s five-minute protected-actions session on one Household Display.';

-- How long a session lasts.
create function private.display_unlock_duration() returns interval
  language sql immutable set search_path = '' as $$ select interval '5 minutes' $$;

revoke all on function private.display_unlock_duration() from public;

-- The member whose session on this display counts now, or null. It counts while it has not expired,
-- the display is active and not privacy-locked, the member is still a member of the display's Home,
-- and their PIN for this Home's shared devices still exists, is not locked and was not changed
-- since the session opened.
create function private.display_unlocked_member(p_display_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
    select s.member_user_id
    from private.display_unlock_sessions s
    join private.household_displays d on d.id = s.display_id and d.home_id = s.home_id
    where s.display_id = p_display_id
      and s.expires_at > pg_catalog.now()
      and d.revoked_at is null and d.user_id is not null and private.home_is_open(d.home_id)
      and not coalesce((select c.locked from private.display_configs c
                        where c.display_id = s.display_id), false)
      and private.is_home_member(s.home_id, s.member_user_id)
      and case when private.is_child(s.member_user_id) then
            exists (select 1 from private.child_home_pins hp
                    where hp.home_id = s.home_id and hp.child_user_id = s.member_user_id
                      and hp.pin_set_at <= s.opened_at
                      and (hp.pin_locked_until is null or hp.pin_locked_until <= pg_catalog.now()))
          else
            exists (select 1 from private.member_device_pins dp
                    where dp.user_id = s.member_user_id
                      and dp.pin_set_at <= s.opened_at
                      and (dp.pin_locked_until is null or dp.pin_locked_until <= pg_catalog.now()))
          end
  $$;

revoke all on function private.display_unlocked_member(uuid) from public;

-- Opens (or replaces) the display's session for a member whose PIN just matched. Callers checked the
-- display and the member.
create function private.open_display_unlock(p_display private.household_displays, p_member uuid)
returns void
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.display_unlock_sessions s
      where s.expires_at < pg_catalog.now() - interval '1 day';
    insert into private.display_unlock_sessions as s (display_id, home_id, member_user_id,
                                                      opened_at, expires_at)
      values (p_display.id, p_display.home_id, p_member, pg_catalog.now(),
              pg_catalog.now() + private.display_unlock_duration())
      on conflict (display_id) do update
        set home_id = excluded.home_id, member_user_id = excluded.member_user_id,
            opened_at = excluded.opened_at, expires_at = excluded.expires_at;
    perform private.audit('display.unlock_opened', p_display.home_id, 'household_display',
      p_display.id, pg_catalog.jsonb_build_object(
        'member', private.member_ref(p_display.home_id, p_member)));
  end
  $$;

revoke all on function private.open_display_unlock(private.household_displays, uuid) from public;

-- Locking a display (privacy mode) or revoking it ends its session at once.
create function private.end_display_unlock_on_lock() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.display_unlock_sessions s where s.display_id = new.display_id;
    return null;
  end
  $$;

revoke all on function private.end_display_unlock_on_lock() from public;

create trigger display_unlock_end_on_lock
  after update on private.display_configs
  for each row when (new.locked and not old.locked)
  execute function private.end_display_unlock_on_lock();

create function private.end_display_unlock_on_revoke() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.display_unlock_sessions s where s.display_id = new.id;
    return null;
  end
  $$;

revoke all on function private.end_display_unlock_on_revoke() from public;

create trigger display_unlock_end_on_revoke
  after update on private.household_displays
  for each row when (new.revoked_at is not null and old.revoked_at is null)
  execute function private.end_display_unlock_on_revoke();

-- 2. Ambient timing (one setting per Home) ---------------------------------------------------------------------

create table private.home_display_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  ambient_after_seconds integer not null default 300
    constraint home_display_settings_ambient_check
      check (ambient_after_seconds in (60, 120, 300, 600, 900, 1800)),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

revoke all on table private.home_display_settings from public;

comment on table private.home_display_settings is
  'UX8a: how long a Home''s displays wait without a touch before showing the ambient view.';

-- A change reaches the Home's displays through their Realtime signal.
create trigger display_signals_from_home_settings
  after insert or update on private.home_display_settings
  for each row execute function private.bump_home_display_signals();

-- The seconds a Home's displays wait before the ambient view (the default when never set).
create function private.home_ambient_after(p_home_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
    select coalesce((select s.ambient_after_seconds from private.home_display_settings s
                     where s.home_id = p_home_id), 300)
  $$;

revoke all on function private.home_ambient_after(uuid) from public;

-- The Home's display settings, for the same managers as S43/S44.
create function public.home_display_settings(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if private.display_manager_check(p_home_id, v_user_id, false) <> 'ok' then
      raise exception 'not a manager of this Home' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object('ambient_after_seconds',
                                         private.home_ambient_after(p_home_id));
  end
  $$;

revoke all on function public.home_display_settings(uuid) from public, anon;
grant execute on function public.home_display_settings(uuid) to authenticated;

-- Saves the Home's ambient timing. Outcomes: 'saved', 'unchanged', 'not_permitted', 'not_found'.
create function public.save_home_display_settings(p_home_id uuid, p_ambient_after_seconds integer)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
  begin
    if p_ambient_after_seconds is null
       or p_ambient_after_seconds not in (60, 120, 300, 600, 900, 1800) then
      raise exception 'invalid display settings' using errcode = '22023';
    end if;
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return v_check;
    end if;
    if private.home_ambient_after(p_home_id) = p_ambient_after_seconds then
      return 'unchanged';
    end if;
    insert into private.home_display_settings as s (home_id, ambient_after_seconds, updated_by)
      values (p_home_id, p_ambient_after_seconds, v_user_id)
      on conflict (home_id) do update
        set ambient_after_seconds = excluded.ambient_after_seconds,
            updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    perform private.audit('display.settings_changed', p_home_id, 'home', p_home_id,
      pg_catalog.jsonb_build_object('ambient_after_seconds', p_ambient_after_seconds));
    return 'saved';
  end
  $$;

revoke all on function public.save_home_display_settings(uuid, integer) from public, anon;
grant execute on function public.save_home_display_settings(uuid, integer) to authenticated;

-- 3. The display's state and Lock now (the web server only, as service_role) ----------------------------------

-- What the display's screen needs beyond its board: the Home's ambient timing, and who has a
-- session on it now with how many seconds are left (seconds, so the tablet's clock does not
-- matter). No row for a display that is not active.
create function public.display_session_state(p_display_id uuid)
returns table (ambient_after_seconds integer, unlocked_membership_id uuid, unlock_seconds_left integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays := private.active_display(p_display_id);
    v_member uuid;
  begin
    if v_display.id is null then
      return;
    end if;
    delete from private.display_unlock_sessions s
      where s.display_id = v_display.id and s.expires_at <= pg_catalog.now();
    v_member := private.display_unlocked_member(v_display.id);
    return query
      select private.home_ambient_after(v_display.home_id),
             case when v_member is null then null
                  else private.member_ref(v_display.home_id, v_member) end,
             case when v_member is null then null
                  else (select greatest(1, ceil(extract(epoch from s.expires_at - pg_catalog.now()))::integer)
                        from private.display_unlock_sessions s where s.display_id = v_display.id) end;
  end
  $$;

revoke all on function public.display_session_state(uuid) from public, anon, authenticated;
grant execute on function public.display_session_state(uuid) to service_role;

-- Lock now: ends the display's session. Returns 'ended' or 'none'.
create function public.display_end_unlock(p_display_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_session private.display_unlock_sessions;
  begin
    delete from private.display_unlock_sessions s where s.display_id = p_display_id
      returning * into v_session;
    if v_session.display_id is null then
      return 'none';
    end if;
    if v_session.expires_at > pg_catalog.now() then
      perform private.audit('display.unlock_ended', v_session.home_id, 'household_display',
        p_display_id, pg_catalog.jsonb_build_object(
          'member', private.member_ref(v_session.home_id, v_session.member_user_id)));
    end if;
    return 'ended';
  end
  $$;

revoke all on function public.display_end_unlock(uuid) from public, anon, authenticated;
grant execute on function public.display_end_unlock(uuid) to service_role;

-- 4. Actions use the session ------------------------------------------------------------------------------------

-- As 20261205090000, plus: when the chore needs a PIN and none is given, the member's open session on
-- this display stands in for it (recorded as 'session').
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
    v_verification text := 'attributed';
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
        if private.display_unlocked_member(v_display.id) is distinct from v_member then
          return query select 'pin_required'::text, null::uuid, null::uuid, null::text,
            null::timestamptz;
          return;
        end if;
        v_verification := 'session';
      end if;
      select * into v_done from private.display_complete(v_display, p_occurrence_id, v_member,
                                                         v_verification);
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

-- As 20261204090000, plus: the matched PIN opens the member's session on this display (once the
-- display is still unlocked and offering actions and the member still eligible).
create or replace function public.display_chore_verified(p_display_id uuid, p_check_id uuid)
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
    perform private.open_display_unlock(v_display, v_check.member_user_id);
    return query select * from private.display_complete(v_display, v_check.occurrence_id,
                                                        v_check.member_user_id, 'pin');
  end
  $$;

-- Locking the display (privacy mode) on the display with a manager's open session instead of their
-- PIN. Outcomes: 'saved', 'unchanged' (already locked), 'not_permitted' (not a manager here),
-- 'pin_required' (no session of theirs on this display), 'display_not_active'.
create function public.display_lock_by_session(p_display_id uuid, p_membership_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_display private.household_displays := private.active_display(p_display_id);
    v_member uuid;
  begin
    if v_display.id is null then
      return 'display_not_active';
    end if;
    if (private.display_config(v_display.id)).locked then
      return 'unchanged';
    end if;
    select m.user_id into v_member from public.home_memberships m
      where m.id = p_membership_id and m.home_id = v_display.home_id;
    if v_member is null or not private.display_lock_manager(v_display.home_id, v_member) then
      return 'not_permitted';
    end if;
    if private.display_unlocked_member(v_display.id) is distinct from v_member then
      return 'pin_required';
    end if;
    return private.apply_display_lock(v_display.id, v_display.home_id, true,
      (private.display_config(v_display.id)).lock_message, v_member, 'display_session');
  end
  $$;

revoke all on function public.display_lock_by_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.display_lock_by_session(uuid, uuid) to service_role;
