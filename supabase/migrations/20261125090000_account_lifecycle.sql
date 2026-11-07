-- S38 (part 2): temporary adult account deactivation and reactivation, long-term inactivity
-- reminders with a security review on return, and the inactive marker Home members see.
--
-- Spec: Project-specification.md "Confirmed temporary adult account deactivation", "Confirmed
-- long-term adult account inactivity reminders and security review" (13 October 2026).
--
-- Deactivation keeps the account, its memberships, roles and data. It ends every session, pauses
-- Google Calendar until the person reconnects it, and stops every notification except security
-- notices. A deactivated account can still sign in (password or Google, with its 2FA), but that
-- session can do nothing except reactivate: PostgREST's pre-request check and the Realtime
-- policies refuse everything else. Inactivity alone never changes anything about the account.

-- Settings ---------------------------------------------------------------------------------------

-- Values awaiting Ward's approval (plans/steps/S38-brief.md).
create function private.inactivity_threshold() returns interval
  language sql immutable set search_path = '' as $$ select interval '12 months' $$;

create function private.inactivity_reminder_interval() returns interval
  language sql immutable set search_path = '' as $$ select interval '3 months' $$;

create function private.inactivity_reminder_limit() returns integer
  language sql immutable set search_path = '' as $$ select 3 $$;

-- A visit counts again as activity at most this often (one write per account per hour).
create function private.activity_touch_interval() returns interval
  language sql immutable set search_path = '' as $$ select interval '1 hour' $$;

-- Deactivation state -----------------------------------------------------------------------------

create table private.account_deactivations (
  user_id uuid primary key references auth.users (id) on delete cascade,
  deactivated_at timestamptz not null default now()
);

revoke all on table private.account_deactivations from public;

create function private.is_deactivated(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (select 1 from private.account_deactivations d where d.user_id = p_user_id)
  $$;

revoke all on function private.is_deactivated(uuid) from public;

-- As S37, with one more state: 'account_deactivated' for a live, fully signed-in session of a
-- deactivated account (two-factor comes first, so reactivation needs the second factor too).
create or replace function private.request_session_state() returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_claims jsonb := auth.jwt();
    v_user_id uuid;
    v_session_id uuid;
  begin
    if v_claims is null or v_claims ->> 'role' is distinct from 'authenticated' then
      return 'ok';
    end if;
    begin
      v_user_id := (v_claims ->> 'sub')::uuid;
      v_session_id := (v_claims ->> 'session_id')::uuid;
    exception when invalid_text_representation then
      return 'session_not_active';
    end;
    if v_user_id is null or v_session_id is null
       or not private.session_is_live(v_user_id, v_session_id) then
      return 'session_not_active';
    end if;
    if coalesce(v_claims ->> 'aal', '') <> 'aal2' and private.has_two_factor(v_user_id)
       and not private.session_trusted(v_user_id, v_session_id) then
      return 'second_factor_required';
    end if;
    if private.is_deactivated(v_user_id) then
      return 'account_deactivated';
    end if;
    return 'ok';
  end
  $$;

-- As S37, plus: a deactivated account's session may only read its state and reactivate.
create or replace function private.enforce_request_session() returns void
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_state text := private.request_session_state();
    v_path text := coalesce(pg_catalog.current_setting('request.path', true), '');
  begin
    if v_state = 'session_not_active' then
      raise sqlstate 'PT401' using message = 'session_not_active';
    end if;
    if v_state = 'second_factor_required' and v_path not in (
         '/rpc/redeem_two_factor_recovery_code', '/rpc/use_trusted_device',
         '/rpc/authorize_account_change', '/rpc/authorize_sign_in_method_change'
       ) then
      raise sqlstate 'PT401' using message = 'second_factor_required';
    end if;
    if v_state = 'account_deactivated' and v_path not in (
         '/rpc/my_account_state', '/rpc/reactivate_my_account'
       ) then
      raise sqlstate 'PT401' using message = 'account_deactivated';
    end if;
  end
  $$;

-- Notifications: a deactivated account gets security notices only (spec: "maintain only strictly
-- necessary security and recovery notifications"). As 20261110090000_habits.sql otherwise.
create or replace function private.effective_notification_channel(
  p_user_id uuid, p_home_id uuid, p_category text, p_channel text
) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_value boolean;
  begin
    if private.notification_category_essential(p_category) then
      return true;
    end if;
    if private.is_deactivated(p_user_id) then
      return false;
    end if;
    if p_home_id is not null then
      select p.enabled into v_value from public.notification_preferences p
        where p.user_id = p_user_id and p.home_id = p_home_id
          and p.category = p_category and p.channel = p_channel;
      if found then
        return v_value;
      end if;
    end if;
    select p.enabled into v_value from public.notification_preferences p
      where p.user_id = p_user_id and p.home_id is null
        and p.category = p_category and p.channel = p_channel;
    if found then
      return v_value;
    end if;
    return p_channel = 'in_app' and p_category not in ('points', 'habits');
  end
  $$;

-- The caller's own account state: allowed for a deactivated account's session.
create function public.my_account_state()
returns table (deactivated_at timestamptz, review_due boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return query
      select d.deactivated_at,
             coalesce((select i.review_due from private.account_inactivity i where i.user_id = v_user_id), false)
      from (select 1) one
      left join private.account_deactivations d on d.user_id = v_user_id;
  end
  $$;

-- Deactivation -----------------------------------------------------------------------------------

-- The Homes that would be left without an operationally available Owner: every Home the caller
-- owns (each Home has exactly one Owner). An accepted ownership transfer comes first.
create function public.my_deactivation_blockers()
returns table (home_id uuid, home_name text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return query
      select h.id, h.name
      from public.home_memberships m
      join public.homes h on h.id = m.home_id
      where m.user_id = v_user_id and m.role = 'owner'
        and not exists (
          select 1 from public.home_memberships o
          where o.home_id = m.home_id and o.role = 'owner' and o.user_id <> v_user_id
            and not private.is_deactivated(o.user_id)
        )
      order by h.name, h.id;
  end
  $$;

-- Deactivates the caller's account. Needs the 'deactivate_account' permission (S37
-- reauthentication from this session) and no Home that it alone owns. Records the event and the
-- notice first (security notices still reach a deactivated account), pauses Google Calendar
-- (stays paused until the person reconnects it after reactivation), then ends every session of
-- the account, including this one.
create function public.deactivate_my_account() returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if private.is_deactivated(v_user_id) then
      return;
    end if;
    if exists (select 1 from public.my_deactivation_blockers()) then
      raise exception 'sole owner' using errcode = 'P0001', hint = 'sole_owner';
    end if;
    if not private.consume_account_change_grant(v_user_id, 'deactivate_account', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    perform private.record_security_event(v_user_id, 'account_deactivated', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.deactivated', '{}'::jsonb,
      'account.deactivated:' || pg_catalog.gen_random_uuid()::text, true);
    insert into private.account_deactivations (user_id) values (v_user_id);

    perform pg_catalog.set_config('madeora.deactivating', v_user_id::text, true);
    update private.google_calendar_connections c
      set status = 'authorization_expired', status_changed_at = pg_catalog.now()
      where c.user_id = v_user_id and c.status = 'connected';
    perform pg_catalog.set_config('madeora.deactivating', '', true);

    delete from auth.sessions s where s.user_id = v_user_id;
  end
  $$;

-- Google Calendar paused by a deactivation is the person's own action, not an expired authorization.
create or replace function private.activity_from_google_connection() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if tg_op = 'INSERT' then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.connected', 'completed');
    elsif tg_op = 'DELETE' then
      perform private.record_account_activity(old.user_id, 'integrations', 'google_calendar.disconnected', 'completed',
        null, private.activity_actor(old.user_id, auth.uid(), 'automatic'));
    elsif new.status = 'authorization_expired' and old.status <> 'authorization_expired'
          and coalesce(pg_catalog.current_setting('madeora.deactivating', true), '') = new.user_id::text then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.paused', 'completed');
    elsif new.status = 'authorization_expired' and old.status <> 'authorization_expired' then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.authorization_expired', 'failed',
        null, 'automatic');
    elsif new.connected_at is distinct from old.connected_at then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.reconnected', 'completed');
    end if;
    return null;
  end
  $$;

-- Reactivation: the deactivated account's own fully signed-in session (password or Google, and
-- its two-factor sign-in when enabled; the request check guarantees both). Revoked Home access and
-- expired invitations stay as they are; Google Calendar stays paused until reconnected.
create function public.reactivate_my_account() returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_since timestamptz;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id)
       or private.request_session_state() not in ('ok', 'account_deactivated') then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    delete from private.account_deactivations d where d.user_id = v_user_id
      returning d.deactivated_at into v_since;
    if v_since is null then
      raise exception 'not deactivated' using errcode = 'P0002';
    end if;
    -- Coming back is activity: no inactivity reminder or review is pending afterwards.
    insert into private.account_inactivity (user_id, last_active_at)
      values (v_user_id, pg_catalog.now())
      on conflict (user_id) do update
        set last_active_at = excluded.last_active_at, reminders_sent = 0, last_reminder_at = null;
    perform private.record_security_event(v_user_id, 'account_reactivated', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.reactivated', '{}'::jsonb,
      'account.reactivated:' || pg_catalog.gen_random_uuid()::text, true);
    return v_since;
  end
  $$;

-- Inactivity -------------------------------------------------------------------------------------

-- The last qualifying activity: the person using Madeora signed in (the app reports a visit at
-- most hourly). Background jobs, integrations, notification delivery and token refreshes never
-- count. `review_due` is set when someone returns after the threshold.
create table private.account_inactivity (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_active_at timestamptz not null,
  reminders_sent integer not null default 0
    constraint account_inactivity_reminders_check check (reminders_sent >= 0),
  last_reminder_at timestamptz,
  review_due boolean not null default false
);

create index account_inactivity_due_idx on private.account_inactivity (last_active_at)
  where reminders_sent < 3;

revoke all on table private.account_inactivity from public;

-- Existing accounts start from their last sign-in.
insert into private.account_inactivity (user_id, last_active_at)
  select u.id, coalesce(u.last_sign_in_at, u.created_at, pg_catalog.now())
  from auth.users u
  where u.email_confirmed_at is not null
on conflict (user_id) do nothing;

-- A visit by the signed-in person. Returns whether a security review is due (they came back
-- after the inactivity threshold and have not reviewed yet).
create function public.touch_my_activity() returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_row private.account_inactivity;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    select * into v_row from private.account_inactivity i where i.user_id = v_user_id for update;
    if v_row.user_id is null then
      insert into private.account_inactivity (user_id, last_active_at)
        values (v_user_id, pg_catalog.now())
        on conflict (user_id) do nothing;
      return false;
    end if;
    if v_row.last_active_at > pg_catalog.now() - private.activity_touch_interval() then
      return v_row.review_due;
    end if;
    update private.account_inactivity i
      set last_active_at = pg_catalog.now(),
          reminders_sent = 0,
          last_reminder_at = null,
          review_due = i.review_due
            or v_row.last_active_at <= pg_catalog.now() - private.inactivity_threshold()
      where i.user_id = v_user_id
      returning i.review_due into v_row.review_due;
    return v_row.review_due;
  end
  $$;

-- The returning person has looked at their sign-in methods, sessions and security activity.
create function public.complete_security_review() returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update private.account_inactivity i set review_due = false
      where i.user_id = v_user_id and i.review_due;
    if found then
      perform private.record_security_event(v_user_id, 'security_review_completed', private.jwt_session_id());
    end if;
  end
  $$;

-- Sends due inactivity reminders (service role; the hourly job). An account is due when it has
-- been inactive past the threshold, is not deactivated, has had fewer than the limit, and its last
-- reminder is at least one interval old. The notice names no Home, person or date. Returns how
-- many were sent.
create function public.send_inactivity_reminders(p_limit integer default 200)
returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_row record;
    v_count integer := 0;
  begin
    for v_row in
      select i.* from private.account_inactivity i
      join auth.users u on u.id = i.user_id
      where i.last_active_at <= pg_catalog.now() - private.inactivity_threshold()
        and i.reminders_sent < private.inactivity_reminder_limit()
        and (i.last_reminder_at is null
             or i.last_reminder_at <= pg_catalog.now() - private.inactivity_reminder_interval())
        and u.email_confirmed_at is not null and u.deleted_at is null
        and not private.is_deactivated(i.user_id)
      order by i.last_active_at
      limit greatest(1, least(coalesce(p_limit, 200), 1000))
      for update of i skip locked
    loop
      update private.account_inactivity i
        set reminders_sent = i.reminders_sent + 1, last_reminder_at = pg_catalog.now()
        where i.user_id = v_row.user_id;
      perform private.record_security_event(v_row.user_id, 'inactivity_reminder_sent', null);
      perform private.notify_user(
        v_row.user_id, null, 'security', 'account.inactivity_reminder', '{}'::jsonb,
        'account.inactivity_reminder:' || v_row.user_id::text || ':'
          || (v_row.reminders_sent + 1)::text || ':' || pg_catalog.to_char(v_row.last_active_at, 'YYYYMMDDHH24MISS'),
        true);
      v_count := v_count + 1;
    end loop;
    return v_count;
  end
  $$;

-- Home members see that an account is inactive (deactivated), never why. As
-- 20261023090000_file_storage.sql, plus `is_inactive`.
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
  is_inactive boolean
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
        private.is_deactivated(m.user_id)
      from public.home_memberships m
      left join public.home_member_profiles p
        on p.home_id = m.home_id and p.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      where m.home_id = p_home_id
      order by m.created_at, m.id;
  end
  $$;

comment on function public.home_directory(uuid) is
  'S11/S15/S38: the members of a Home the caller belongs to, with effective name, colour, avatar file id and whether the account is deactivated.';

-- Grants -----------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.home_directory(uuid)',
    'public.my_account_state()',
    'public.my_deactivation_blockers()',
    'public.deactivate_my_account()',
    'public.reactivate_my_account()',
    'public.touch_my_activity()',
    'public.complete_security_review()'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
end
$$;

revoke all on function public.send_inactivity_reminders(integer) from public, anon, authenticated;
grant execute on function public.send_inactivity_reminders(integer) to service_role;
