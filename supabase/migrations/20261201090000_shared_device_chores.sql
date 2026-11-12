-- S42 part 2: chores completed on an approved household device, attributed to the member who did
-- them, with optional PIN verification (spec "Confirmed shared-device chore attribution and
-- optional PIN verification"; architecture.md §34).
--
-- - The device is one of S42's approved household devices (private.household_devices). It shows
--   the Home's open chores and its members; nobody is signed in on it for this.
-- - A member picks a chore, says who did it, and confirms. The web server (service role) then
--   completes it *as that member*: for the length of one call the member is this transaction's
--   device actor (private.device_actors), which require_confirmed_caller accepts, so every chore,
--   approval and points rule of the ordinary completion applies unchanged.
-- - A Home manager can require a PIN for every such completion; a member may also confirm with
--   their PIN when it is optional. Children use their PIN for this Home (private.child_home_pins);
--   adults may set their own household-device PIN (private.member_device_pins). A PIN check is
--   bound to one action, one member, one device and one Home, and nothing is remembered after it.
-- - The completion is recorded with the device, the member and the verification level
--   ('attributed' or 'pin'), and can be undone from the same device for two minutes.

-- 1. Settings and adult PINs -----------------------------------------------------------------------------

-- Whether chores completed on this Home's household devices always need the member's PIN (Home
-- managers decide; off by default, when a PIN is optional). Absent row: off.
create table private.shared_device_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  require_pin boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

revoke all on table private.shared_device_settings from public;

-- An adult's own optional PIN for confirming actions on household devices (owner decision
-- 2026-11-12). Scrypt hash from the web server only; one lock, as a child's PIN.
create table private.member_device_pins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  pin_hash text not null
    constraint member_device_pins_pin_hash_check check (private.is_child_secret_hash(pin_hash)),
  pin_set_at timestamptz not null default now(),
  pin_failures integer not null default 0,
  pin_locked_until timestamptz,
  pin_locks integer not null default 0,
  pin_locks_since timestamptz
);

revoke all on table private.member_device_pins from public;

comment on table private.member_device_pins is
  'S42: an adult''s optional scrypt-hashed PIN for confirming chores on household devices.';

-- 2. Acting for a member, for one call ----------------------------------------------------------------------

-- The member a device action runs as, in this transaction only. Written and removed by the
-- security-definer device functions below; nothing else can write it (no grants).
create table private.device_actors (
  txid bigint not null,
  user_id uuid not null,
  home_id uuid not null,
  -- The one occurrence this actor may reopen (the device's Undo), or null.
  may_reopen uuid,
  primary key (txid, user_id)
);

revoke all on table private.device_actors from public;

create function private.device_actor(p_user_id uuid) returns private.device_actors
  language sql stable security definer set search_path = '' as $$
    select a.* from private.device_actors a
    where a.txid = pg_catalog.txid_current() and a.user_id = p_user_id
  $$;

revoke all on function private.device_actor(uuid) from public;

-- As 20261017090000_home_invitations.sql, plus: the member a household device acts for in this
-- transaction (children included: they have no confirmed email).
create or replace function private.require_confirmed_caller() returns uuid
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is not null and (private.device_actor(v_user_id)).user_id is not null then
      return v_user_id;
    end if;
    if v_user_id is null or private.confirmed_email(v_user_id) is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return v_user_id;
  end
  $$;

-- As 20261030090000_chores.sql / 20261105090000_points_rewards.sql, plus: a device Undo may reopen
-- the one occurrence it completed moments ago (and reverse its points), and nothing else.
create or replace function private.can_manage_chores(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and (private.has_home_capability(p_home_id, p_user_id, 'manageHomeChores')
         or exists (select 1 from private.device_actors a
                    where a.txid = pg_catalog.txid_current() and a.user_id = p_user_id
                      and a.home_id = p_home_id and a.may_reopen is not null));
  $$;

create or replace function private.can_manage_points(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and (private.has_home_capability(p_home_id, p_user_id, 'manageHomePoints')
         or exists (select 1 from private.device_actors a
                    where a.txid = pg_catalog.txid_current() and a.user_id = p_user_id
                      and a.home_id = p_home_id and a.may_reopen is not null));
  $$;

-- Runs p_sql's chore call as p_user_id: sets the request's subject to the member, records the
-- device actor, and puts both back afterwards. Only the functions below call it.
create function private.begin_device_actor(p_user_id uuid, p_home_id uuid, p_may_reopen uuid)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  begin
    insert into private.device_actors (txid, user_id, home_id, may_reopen)
      values (pg_catalog.txid_current(), p_user_id, p_home_id, p_may_reopen);
    perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
    perform pg_catalog.set_config('request.jwt.claims',
      pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
    return coalesce(v_claims, '');
  end
  $$;

create function private.end_device_actor(p_user_id uuid, p_claims text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    delete from private.device_actors a
      where a.txid = pg_catalog.txid_current() and a.user_id = p_user_id;
    perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
    perform pg_catalog.set_config('request.jwt.claims', p_claims, true);
  end
  $$;

revoke all on function private.begin_device_actor(uuid, uuid, uuid) from public;
revoke all on function private.end_device_actor(uuid, text) from public;

-- 3. Records ----------------------------------------------------------------------------------------------

-- Each chore completed on a household device: who it is attributed to, how they were verified,
-- and whether it was undone. Kept with the Home (ids only).
create table private.shared_device_actions (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  device_id uuid not null references private.household_devices (id) on delete cascade,
  occurrence_id uuid not null,
  member_user_id uuid references auth.users (id) on delete set null,
  verification text not null
    constraint shared_device_actions_verification_check check (verification in ('attributed', 'pin')),
  outcome text not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);

create index shared_device_actions_device_idx on private.shared_device_actions (device_id, created_at);

revoke all on table private.shared_device_actions from public;

-- A PIN check waiting for the web server's comparison: one action, one member, one device.
create table private.shared_device_checks (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references private.household_devices (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  occurrence_id uuid not null,
  member_user_id uuid not null references auth.users (id) on delete cascade,
  client_key text not null
    constraint shared_device_checks_client_key_check check (client_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index shared_device_checks_device_idx on private.shared_device_checks (device_id, created_at)
  where used_at is null;
create index shared_device_checks_client_idx on private.shared_device_checks (client_key, created_at)
  where used_at is null;

revoke all on table private.shared_device_checks from public;

-- 4. Managers and adults --------------------------------------------------------------------------------------

-- The Home's rule, for its managers (Owner, or Administrator with manageHomeSettings).
create function public.shared_device_pin_rule(p_home_id uuid) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if private.home_role(p_home_id, v_user_id) is null
       or not private.has_home_capability(p_home_id, v_user_id, 'manageHomeSettings') then
      raise exception 'not a manager of this Home' using errcode = '42501';
    end if;
    return coalesce((select s.require_pin from private.shared_device_settings s
                     where s.home_id = p_home_id), false);
  end
  $$;

revoke all on function public.shared_device_pin_rule(uuid) from public, anon;
grant execute on function public.shared_device_pin_rule(uuid) to authenticated;

-- Sets it. Returns 'saved', 'unchanged', 'not_permitted' or 'not_found'.
create function public.set_shared_device_pin_rule(p_home_id uuid, p_require_pin boolean)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_before boolean;
  begin
    if p_require_pin is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) or private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    if not private.has_home_capability(p_home_id, v_user_id, 'manageHomeSettings') then
      return 'not_permitted';
    end if;
    select s.require_pin into v_before from private.shared_device_settings s
      where s.home_id = p_home_id for update;
    if coalesce(v_before, false) = p_require_pin then
      return 'unchanged';
    end if;
    insert into private.shared_device_settings (home_id, require_pin, updated_by)
      values (p_home_id, p_require_pin, v_user_id)
      on conflict (home_id) do update
        set require_pin = excluded.require_pin, updated_by = excluded.updated_by,
            updated_at = pg_catalog.now();
    perform private.audit('home.shared_device_pin_rule_changed', p_home_id, 'home', p_home_id,
      jsonb_build_object('require_pin', p_require_pin));
    return 'saved';
  end
  $$;

revoke all on function public.set_shared_device_pin_rule(uuid, boolean) from public, anon;
grant execute on function public.set_shared_device_pin_rule(uuid, boolean) to authenticated;

-- An adult's own household-device PIN: whether it is set, and its lock. Never the hash.
create function public.my_device_pin()
returns table (has_pin boolean, locked_until timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select p.user_id is not null,
             case when p.pin_locked_until > pg_catalog.now() then p.pin_locked_until end
      from (select 1) one
      left join private.member_device_pins p on p.user_id = v_user_id;
  end
  $$;

revoke all on function public.my_device_pin() from public, anon;
grant execute on function public.my_device_pin() to authenticated;

-- Sets (p_hash, made by the web server) or removes (null) the caller's own PIN. Adults only.
-- Returns 'saved', 'cleared' or 'unchanged'.
create function public.set_my_device_pin(p_hash text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_found boolean;
  begin
    if private.is_child(v_user_id) then
      raise exception 'children''s PINs are set by their guardians' using errcode = '42501';
    end if;
    if p_hash is null then
      delete from private.member_device_pins p where p.user_id = v_user_id returning true into v_found;
      if v_found is null then
        return 'unchanged';
      end if;
      perform private.audit('user.device_pin_cleared', null, 'user', v_user_id, '{}'::jsonb);
      return 'cleared';
    end if;
    if not private.is_child_secret_hash(p_hash) then
      raise exception 'invalid PIN' using errcode = '22023';
    end if;
    insert into private.member_device_pins (user_id, pin_hash) values (v_user_id, p_hash)
      on conflict (user_id) do update
        set pin_hash = excluded.pin_hash, pin_set_at = pg_catalog.now(), pin_failures = 0,
            pin_locked_until = null, pin_locks = 0, pin_locks_since = null;
    perform private.audit('user.device_pin_set', null, 'user', v_user_id, '{}'::jsonb);
    return 'saved';
  end
  $$;

revoke all on function public.set_my_device_pin(text) from public, anon;
grant execute on function public.set_my_device_pin(text) to authenticated;

-- 5. The device (the web server only, as service_role) ------------------------------------------------------

-- What an approved device's chore screen shows: the Home's rule, its members (name, colour,
-- whether they are a child, whether they have a PIN usable here) and its open chores up to today
-- (title, due date, assignees, open mandatory steps, approval). Empty for an unknown device.
create function public.shared_device_board(p_device_hash text) returns jsonb
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
                 'has_pin', case when private.is_child(m.user_id)
                   then exists (select 1 from private.child_home_pins hp
                                where hp.home_id = m.home_id and hp.child_user_id = m.user_id)
                   else exists (select 1 from private.member_device_pins dp
                                where dp.user_id = m.user_id) end)
               order by m.created_at, m.id)
        from public.home_memberships m
        left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
        left join public.user_preferences up on up.user_id = m.user_id
        where m.home_id = v_device.home_id), '[]'::jsonb),
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
                 'requires_approval', c.requires_approval)
               order by o.due_date, c.title, o.id)
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = v_device.home_id and o.status = 'open' and o.deleted_at is null
          and c.deleted_at is null and o.due_date <= v_today), '[]'::jsonb)
    );
  end
  $$;

revoke all on function public.shared_device_board(text) from public, anon, authenticated;
grant execute on function public.shared_device_board(text) to service_role;

-- Who may be named for an occurrence on the device: any current member of the device's Home; a
-- child only for a chore assigned to them (no adult or unassigned work in a child's name).
create function private.device_member(
  p_device private.household_devices, p_occurrence_id uuid, p_membership_id uuid
) returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    join private.chore_occurrences o on o.id = p_occurrence_id and o.home_id = m.home_id
    where m.home_id = p_device.home_id and m.id = p_membership_id and o.deleted_at is null
      and (not private.is_child(m.user_id)
           or exists (select 1 from private.chore_occurrence_assignees a
                      where a.occurrence_id = o.id and a.user_id = m.user_id))
  $$;

revoke all on function private.device_member(private.household_devices, uuid, uuid) from public;

-- Completes the occurrence as the member and records it. Returns the completion's outcome and
-- the action id (for Undo; null when nothing was completed or submitted).
create function private.device_complete(
  p_device private.household_devices, p_occurrence_id uuid, p_member uuid, p_verification text
) returns table (outcome text, action_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_claims text;
    v_outcome text;
    v_action uuid;
  begin
    v_claims := private.begin_device_actor(p_member, p_device.home_id, null);
    select c.outcome into v_outcome
      from public.complete_chore_occurrence(p_occurrence_id,
        private.member_ref(p_device.home_id, p_member), null) c;
    perform private.end_device_actor(p_member, v_claims);
    if v_outcome in ('completed', 'submitted') then
      insert into private.shared_device_actions (home_id, device_id, occurrence_id, member_user_id,
                                                 verification, outcome)
        values (p_device.home_id, p_device.id, p_occurrence_id, p_member, p_verification, v_outcome)
        returning id into v_action;
      update private.household_devices d set last_used_at = pg_catalog.now() where d.id = p_device.id;
      perform private.audit('chore_occurrence.device_completed', p_device.home_id,
        'chore_occurrence', p_occurrence_id,
        jsonb_build_object('device_id', p_device.id, 'verification', p_verification,
                           'member', private.member_ref(p_device.home_id, p_member),
                           'outcome', v_outcome));
    end if;
    return query select v_outcome, v_action;
  end
  $$;

revoke all on function private.device_complete(private.household_devices, uuid, uuid, text)
  from public;

-- Step 1 of a device completion. p_pin: the member typed a PIN. Without one the chore is completed
-- at once as 'attributed', unless the Home requires a PIN ('pin_required', nothing counted). With
-- one, the member's PIN hash is returned with a check id for the web server to compare (the try is
-- counted as wrong until shared_device_verified confirms it).
-- Outcomes: the completion's own ('completed', 'submitted', 'already_completed', ...), 'check',
-- 'pin_required',
-- 'pin_not_set' (a PIN is needed and the member has none here), 'locked' (locked_until),
-- 'rate_limited', 'not_eligible' (not a member here, or a child and not their chore),
-- 'device_not_approved'.
create function public.shared_device_attempt(
  p_device_hash text, p_occurrence_id uuid, p_membership_id uuid, p_pin boolean, p_client_key text
) returns table (outcome text, action_id uuid, check_id uuid, pin_hash text, locked_until timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_device private.household_devices;
    v_member uuid;
    v_child boolean;
    v_require boolean;
    v_hash text;
    v_locked timestamptz;
    v_check uuid;
    v_done record;
  begin
    perform private.check_child_client_key(p_client_key);
    v_device := private.approved_device(coalesce(p_device_hash, ''));
    if v_device.id is null then
      return query select 'device_not_approved'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    v_member := private.device_member(v_device, p_occurrence_id, p_membership_id);
    if v_member is null then
      return query select 'not_eligible'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    v_require := coalesce((select s.require_pin from private.shared_device_settings s
                           where s.home_id = v_device.home_id), false);
    if not coalesce(p_pin, false) then
      if v_require then
        return query select 'pin_required'::text, null::uuid, null::uuid, null::text,
          null::timestamptz;
        return;
      end if;
      select * into v_done from private.device_complete(v_device, p_occurrence_id, v_member,
                                                        'attributed');
      return query select v_done.outcome, v_done.action_id, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;

    -- A PIN is needed: throttle failed checks per device and per client, as sign-in does.
    delete from private.shared_device_checks c where c.created_at < pg_catalog.now() - interval '1 day';
    if (select count(*) from private.shared_device_checks c
        where c.device_id = v_device.id and c.used_at is null
          and c.created_at > pg_catalog.now() - interval '1 hour')
         >= (select l.device_failures_per_hour from private.child_sign_in_limits() l)
       or (select count(*) from private.shared_device_checks c
           where c.client_key = p_client_key and c.used_at is null
             and c.created_at > pg_catalog.now() - (select l.client_window
                                                    from private.child_sign_in_limits() l))
         >= (select l.client_failures_per_window from private.child_sign_in_limits() l) then
      return query select 'rate_limited'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    v_child := private.is_child(v_member);
    if v_child then
      select hp.pin_hash, hp.pin_locked_until into v_hash, v_locked
        from private.child_home_pins hp
        where hp.home_id = v_device.home_id and hp.child_user_id = v_member for update;
    else
      select dp.pin_hash, dp.pin_locked_until into v_hash, v_locked
        from private.member_device_pins dp where dp.user_id = v_member for update;
    end if;
    if v_hash is null then
      return query select 'pin_not_set'::text, null::uuid, null::uuid, null::text,
        null::timestamptz;
      return;
    end if;
    if v_locked > pg_catalog.now() then
      return query select 'locked'::text, null::uuid, null::uuid, null::text, v_locked;
      return;
    end if;
    perform private.count_device_pin_failure(v_member, v_device.home_id);
    insert into private.shared_device_checks (device_id, home_id, occurrence_id, member_user_id,
                                              client_key)
      values (v_device.id, v_device.home_id, p_occurrence_id, v_member, p_client_key)
      returning id into v_check;
    return query select 'check'::text, null::uuid, v_check, v_hash, null::timestamptz;
  end
  $$;

-- Counts a wrong try against the PIN a device check uses (counted before the comparison).
create function private.count_device_pin_failure(p_member uuid, p_home_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_p private.member_device_pins;
    v_n record;
  begin
    if private.is_child(p_member) then
      perform private.count_child_failure(p_member, 'pin', p_home_id);
      return;
    end if;
    select * into v_p from private.member_device_pins dp where dp.user_id = p_member for update;
    if not found then
      return;
    end if;
    v_n := private.next_child_lock(v_p.pin_failures, v_p.pin_locks, v_p.pin_locks_since);
    update private.member_device_pins dp
      set pin_failures = v_n.o_failures, pin_locks = v_n.o_locks, pin_locks_since = v_n.o_since,
          pin_locked_until = coalesce(v_n.o_until, dp.pin_locked_until)
      where dp.user_id = p_member;
  end
  $$;

revoke all on function private.count_device_pin_failure(uuid, uuid) from public;

revoke all on function public.shared_device_attempt(text, uuid, uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.shared_device_attempt(text, uuid, uuid, boolean, text)
  to service_role;

-- Step 2, after the web server matched the PIN: clears the wrong-try count and completes the chore
-- as 'pin'. The check must be fresh (two minutes), unused, and from the same device.
create function public.shared_device_verified(p_device_hash text, p_check_id uuid)
returns table (outcome text, action_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_device private.household_devices := private.approved_device(coalesce(p_device_hash, ''));
    v_check private.shared_device_checks;
  begin
    select * into v_check from private.shared_device_checks c where c.id = p_check_id for update;
    if v_device.id is null or v_check.id is null or v_check.device_id <> v_device.id
       or v_check.used_at is not null
       or v_check.created_at <= pg_catalog.now() - interval '2 minutes' then
      return query select 'invalid'::text, null::uuid;
      return;
    end if;
    update private.shared_device_checks c set used_at = pg_catalog.now() where c.id = v_check.id;
    if private.is_child(v_check.member_user_id) then
      update private.child_home_pins hp
        set pin_failures = 0, pin_locks = 0, pin_locks_since = null, pin_locked_until = null
        where hp.home_id = v_check.home_id and hp.child_user_id = v_check.member_user_id
          and hp.pin_locked_until is distinct from 'infinity'::timestamptz;
    else
      update private.member_device_pins dp
        set pin_failures = 0, pin_locks = 0, pin_locks_since = null, pin_locked_until = null
        where dp.user_id = v_check.member_user_id
          and dp.pin_locked_until is distinct from 'infinity'::timestamptz;
    end if;
    -- Still a member, and still allowed for this chore.
    if private.device_member(v_device, v_check.occurrence_id,
                             private.member_ref(v_device.home_id, v_check.member_user_id)) is null then
      return query select 'not_eligible'::text, null::uuid;
      return;
    end if;
    return query select * from private.device_complete(v_device, v_check.occurrence_id,
                                                       v_check.member_user_id, 'pin');
  end
  $$;

revoke all on function public.shared_device_verified(text, uuid) from public, anon, authenticated;
grant execute on function public.shared_device_verified(text, uuid) to service_role;

-- Undo, from the same device within two minutes: reopens the occurrence (and reverses its points)
-- as the member it was attributed to. Returns 'undone', 'expired' or 'invalid'.
create function public.shared_device_undo(p_device_hash text, p_action_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_device private.household_devices := private.approved_device(coalesce(p_device_hash, ''));
    v_action private.shared_device_actions;
    v_claims text;
    v_outcome text;
  begin
    select * into v_action from private.shared_device_actions a where a.id = p_action_id for update;
    if v_device.id is null or v_action.id is null or v_action.device_id <> v_device.id
       or v_action.undone_at is not null or v_action.member_user_id is null
       or not private.is_home_member(v_device.home_id, v_action.member_user_id) then
      return 'invalid';
    end if;
    if v_action.created_at <= pg_catalog.now() - interval '2 minutes' then
      return 'expired';
    end if;
    v_claims := private.begin_device_actor(v_action.member_user_id, v_device.home_id,
                                           v_action.occurrence_id);
    select r.outcome into v_outcome from public.reopen_chore_occurrence(v_action.occurrence_id) r;
    perform private.end_device_actor(v_action.member_user_id, v_claims);
    if v_outcome not in ('reopened', 'already_open') then
      return 'invalid';
    end if;
    update private.shared_device_actions a set undone_at = pg_catalog.now() where a.id = v_action.id;
    perform private.audit('chore_occurrence.device_undone', v_device.home_id, 'chore_occurrence',
      v_action.occurrence_id, jsonb_build_object('device_id', v_device.id));
    return 'undone';
  end
  $$;

revoke all on function public.shared_device_undo(text, uuid) from public, anon, authenticated;
grant execute on function public.shared_device_undo(text, uuid) to service_role;
