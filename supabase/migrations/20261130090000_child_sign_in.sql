-- S42: child sign-in (spec "Confirmed guardian-managed child sign-in", "Confirmed primary and
-- secondary child guardian authority"; architecture.md §7 and §34; brief plans/steps/S42-brief.md).
--
-- A child signs in to their own restricted identity, never a parent's account:
--   * with a guardian-managed username and password, only where a primary guardian turned on
--     independent (password) sign-in;
--   * with a PIN, only on a household device a Home manager approved, only for that Home.
-- Madeora's web server checks the password or PIN against a scrypt hash (the database never sees
-- either), then issues an ordinary Supabase Auth session and registers it here. Nothing in this
-- file ever stores, logs or audits a PIN, a password or a hash of one outside its credential row.
--
-- A child's session is locked down in three places, so no module's own checks have to know about
-- children:
--   1. private.confirmed_email() is null for a child, so every function behind
--      require_confirmed_caller() refuses a child, and children receive no email or notification;
--   2. the PostgREST pre-request check accepts a child's token only for a registered, live, still
--      allowed child session, and then only for the child_* functions listed below; every table,
--      view, GraphQL and other function call is refused;
--   3. a child's auth.users row can never get a Supabase Auth password, another email address, a
--      phone number or a provider identity, so no second way to sign in can be added.

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series', 'pet',
    'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity', 'pet_care_occurrence',
    'calendar_event', 'photo', 'photo_album', 'home_copy', 'household_device'
  ));

-- 1. Children are never confirmed adults -------------------------------------------------------------

-- As 20261017090000_home_invitations.sql, but never for a child: a child's internal alias is
-- confirmed for Supabase Auth's sake only (S42), it is not an email address anyone reads.
create or replace function private.confirmed_email(p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.lower(u.email) from auth.users u
  where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null
    and not exists (select 1 from public.child_profiles c where c.user_id = u.id);
  $$;

-- As 20261022090000_notifications.sql, but never a child (no notifications or email yet).
create or replace function private.can_receive_notifications(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
      and not exists (select 1 from public.child_profiles c where c.user_id = u.id)
  );
  $$;

-- The internal, non-deliverable address Supabase Auth needs to issue a child's session. Never
-- shown, never mailed (.invalid is reserved and cannot resolve).
create function private.child_alias_email(p_child uuid) returns text
  language sql immutable parallel safe set search_path = '' as $$
    select 'child-' || p_child::text || '@children.madeora.invalid'
  $$;

revoke all on function private.child_alias_email(uuid) from public;

-- Gives the child its alias, confirmed, so Supabase Auth can issue a session for it.
create function private.ensure_child_alias(p_child uuid) returns void
  language sql security definer set search_path = '' as $$
    update auth.users u
      set email = private.child_alias_email(u.id),
          email_confirmed_at = coalesce(u.email_confirmed_at, pg_catalog.now()),
          updated_at = pg_catalog.now()
      where u.id = p_child and u.email is distinct from private.child_alias_email(u.id)
  $$;

revoke all on function private.ensure_child_alias(uuid) from public;

-- 3. Guards on a child's Supabase Auth rows -------------------------------------------------------

create function private.guard_child_auth_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    -- Read through jsonb so the guard does not depend on every Supabase Auth column existing.
    v_row jsonb := pg_catalog.to_jsonb(new);
  begin
    if not private.is_child(new.id) then
      return new;
    end if;
    if coalesce(new.encrypted_password, '') <> '' then
      raise exception 'a child has no Supabase Auth password'
        using errcode = '42501', hint = 'Child credentials are managed by guardians in Madeora (S42).';
    end if;
    if coalesce(v_row ->> 'email_change', '') <> '' or coalesce(v_row ->> 'phone_change', '') <> ''
       or coalesce(v_row ->> 'phone', '') <> '' then
      raise exception 'a child''s sign-in address cannot change'
        using errcode = '42501', hint = 'Child credentials are managed by guardians in Madeora (S42).';
    end if;
    if new.email is not null and new.email <> private.child_alias_email(new.id) then
      raise exception 'a child''s sign-in address cannot change'
        using errcode = '42501', hint = 'Child credentials are managed by guardians in Madeora (S42).';
    end if;
    return new;
  end
  $$;

revoke all on function private.guard_child_auth_user() from public;

create trigger madeora_guard_child_auth_user
  before update on auth.users
  for each row execute function private.guard_child_auth_user();

-- A child signs in only through Madeora: no Google or any other provider identity.
create function private.guard_child_identity() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if private.is_child(new.user_id) and new.provider <> 'email' then
      raise exception 'a child cannot link a sign-in provider'
        using errcode = '42501', hint = 'Child credentials are managed by guardians in Madeora (S42).';
    end if;
    return new;
  end
  $$;

revoke all on function private.guard_child_identity() from public;

create trigger madeora_guard_child_identity
  before insert on auth.identities
  for each row execute function private.guard_child_identity();

-- Limits (brief S42 defaults, owner may change) ------------------------------------------------------

create function private.child_sign_in_limits(
  out failures_before_lock integer,
  out lock_duration interval,
  out locks_before_guardian_unlock integer,
  out lock_count_window interval,
  out device_failures_per_hour integer,
  out client_failures_per_window integer,
  out client_window interval,
  out pin_session interval,
  out password_session interval,
  out attempt_lifetime interval,
  out devices_per_home integer
)
  language sql immutable set search_path = '' as $$
    select 5, interval '15 minutes', 3, interval '24 hours', 20, 30, interval '15 minutes',
           interval '4 hours', interval '30 days', interval '2 minutes', 20
  $$;

revoke all on function private.child_sign_in_limits() from public;

-- Credentials ---------------------------------------------------------------------------------------

-- The web server's scrypt format: scrypt$<log2 N>$<r>$<p>$<salt, base64url>$<key, base64url>.
create function private.is_child_secret_hash(p_hash text) returns boolean
  language sql immutable parallel safe set search_path = '' as $$
    select coalesce(p_hash ~ '^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$', false)
  $$;

revoke all on function private.is_child_secret_hash(text) from public;

create table private.child_credentials (
  child_user_id uuid primary key references public.child_profiles (user_id) on delete cascade,
  -- 3 to 24 characters: a-z, 0-9, '.', '_' and '-', starting and ending with a letter or digit.
  username text
    constraint child_credentials_username_check
      check (username ~ '^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$'),
  password_hash text
    constraint child_credentials_password_hash_check
      check (password_hash is null or private.is_child_secret_hash(password_hash)),
  password_set_at timestamptz,
  -- Wrong tries since the last success or lock, the current lock, and the locks in the window.
  password_failures integer not null default 0,
  password_locked_until timestamptz,
  password_locks integer not null default 0,
  password_locks_since timestamptz,
  updated_at timestamptz not null default now(),
  constraint child_credentials_username_key unique (username)
);

revoke all on table private.child_credentials from public;

comment on table private.child_credentials is
  'S42: a child''s identity-wide username and scrypt hash of their independent password.';

-- Per-Home switches: both off until the child's primary guardian turns them on.
alter table public.child_home_settings
  add column password_sign_in boolean not null default false,
  add column pin_sign_in boolean not null default false,
  add column sign_in_updated_at timestamptz;

grant select (password_sign_in, pin_sign_in) on table public.child_home_settings to authenticated;

-- A child's PIN is Home-scoped (spec: Home guardians keep the Home's approved-device PIN rules):
-- one scrypt hash and one lock per child per Home, gone with the child's membership there.
create table private.child_home_pins (
  home_id uuid not null,
  child_user_id uuid not null,
  pin_hash text not null
    constraint child_home_pins_pin_hash_check check (private.is_child_secret_hash(pin_hash)),
  pin_set_at timestamptz not null default now(),
  pin_failures integer not null default 0,
  pin_locked_until timestamptz,
  pin_locks integer not null default 0,
  pin_locks_since timestamptz,
  updated_at timestamptz not null default now(),
  constraint child_home_pins_pkey primary key (home_id, child_user_id),
  constraint child_home_pins_settings_fkey foreign key (home_id, child_user_id)
    references public.child_home_settings (home_id, child_user_id) on delete cascade
);

revoke all on table private.child_home_pins from public;

comment on table private.child_home_pins is
  'S42: a child''s scrypt-hashed PIN and its lock, for one Home''s approved household devices.';

-- Approved household devices ----------------------------------------------------------------------------

-- A browser a Home manager approved for child PIN sign-in in one Home. The device keeps a random
-- 32-byte secret in an httpOnly cookie; only its SHA-256 is stored here.
create table private.household_devices (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  label text not null constraint household_devices_label_check
    check (private.is_visible_name(label, 60)),
  secret_hash text not null
    constraint household_devices_secret_hash_check check (secret_hash ~ '^[0-9a-f]{64}$')
    constraint household_devices_secret_hash_key unique,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  last_used_at timestamptz
);

create index household_devices_home_idx on private.household_devices (home_id)
  where revoked_at is null;

revoke all on table private.household_devices from public;

comment on table private.household_devices is
  'S42: browsers a Home manager approved for child PIN sign-in (secret stored as SHA-256 only).';

-- Sign-in attempts and sessions --------------------------------------------------------------------------

-- Every attempt, counted before the hash is checked, so parallel guesses cannot exceed the limits.
-- client_key is the SHA-256 of the client's address made by the web server; the address itself is
-- never stored. Rows older than a day are removed by the next attempt.
create table private.child_sign_in_attempts (
  id uuid primary key default gen_random_uuid(),
  method text not null constraint child_sign_in_attempts_method_check
    check (method in ('password', 'pin')),
  child_user_id uuid references public.child_profiles (user_id) on delete cascade,
  device_id uuid references private.household_devices (id) on delete cascade,
  client_key text not null
    constraint child_sign_in_attempts_client_key_check check (client_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  -- Set when step 1 answered 'check' (handed out a hash); only such an attempt can be verified.
  checked_at timestamptz,
  verified_at timestamptz,
  completed_at timestamptz
);

create index child_sign_in_attempts_client_idx
  on private.child_sign_in_attempts (client_key, created_at) where verified_at is null;
create index child_sign_in_attempts_device_idx
  on private.child_sign_in_attempts (device_id, created_at) where verified_at is null;
create index child_sign_in_attempts_created_idx on private.child_sign_in_attempts (created_at);

revoke all on table private.child_sign_in_attempts from public;

-- The Supabase Auth sessions Madeora issued to children. A child's token works only while its
-- session is here, not ended and not expired (checked on every request, below).
create table private.child_sessions (
  session_id uuid primary key,
  child_user_id uuid not null references public.child_profiles (user_id) on delete cascade,
  method text not null constraint child_sessions_method_check check (method in ('password', 'pin')),
  -- PIN sessions only: the device and its Home, the only Home the session reaches.
  home_id uuid references public.homes (id) on delete cascade,
  device_id uuid references private.household_devices (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  constraint child_sessions_pin_device check (
    (method = 'pin') = (home_id is not null and device_id is not null)
  )
);

create index child_sessions_child_idx on private.child_sessions (child_user_id)
  where ended_at is null;
create index child_sessions_device_idx on private.child_sessions (device_id)
  where ended_at is null;

revoke all on table private.child_sessions from public;

-- The Homes a child session reaches now; none when it is not usable. A password session reaches
-- the Homes where password sign-in is on; a PIN session only its device's Home, while the device
-- is approved and PIN sign-in is on there.
create function private.child_session_homes(p_child uuid, p_session uuid) returns setof uuid
  language sql stable security definer set search_path = '' as $$
    select m.home_id
    from private.child_sessions cs
    join public.home_memberships m on m.user_id = cs.child_user_id
    join public.child_home_settings s on s.home_id = m.home_id and s.child_user_id = m.user_id
    left join private.household_devices d on d.id = cs.device_id
    where cs.session_id = p_session and cs.child_user_id = p_child
      and cs.ended_at is null and cs.expires_at > pg_catalog.now()
      and (
        (cs.method = 'password' and s.password_sign_in)
        or (cs.method = 'pin' and m.home_id = cs.home_id and s.pin_sign_in
            and d.home_id = cs.home_id and d.revoked_at is null)
      )
  $$;

revoke all on function private.child_session_homes(uuid, uuid) from public;

create function private.child_session_ok(p_child uuid, p_session uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (select 1 from private.child_session_homes(p_child, p_session))
  $$;

revoke all on function private.child_session_ok(uuid, uuid) from public;

-- Ends a child's sessions (all, or one method's) and signs them out of Supabase Auth.
create function private.end_child_sessions(
  p_child uuid, p_method text, p_reason text, p_device_id uuid default null,
  p_home_id uuid default null
) returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_ids uuid[];
  begin
    with ended as (
      update private.child_sessions cs
        set ended_at = pg_catalog.now(), end_reason = p_reason
        where cs.ended_at is null
          and (p_child is null or cs.child_user_id = p_child)
          and (p_method is null or cs.method = p_method)
          and (p_device_id is null or cs.device_id = p_device_id)
          and (p_home_id is null or cs.home_id = p_home_id)
        returning cs.session_id
    )
    select coalesce(pg_catalog.array_agg(e.session_id), '{}') into v_ids from ended e;
    delete from auth.sessions s where s.id = any (v_ids);
    return pg_catalog.cardinality(v_ids);
  end
  $$;

revoke all on function private.end_child_sessions(uuid, text, text, uuid, uuid) from public;

-- 2. Request-level enforcement ---------------------------------------------------------------------------

-- As 20261125090000_account_lifecycle.sql, plus: a child's token is 'child_session' while its
-- session is a registered, live, allowed child session, and 'session_not_active' otherwise
-- (including a session Supabase Auth issued some other way). Children have no two-factor sign-in
-- and are never deactivated, so those checks do not apply to them.
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
    if private.is_child(v_user_id) then
      if private.child_session_ok(v_user_id, v_session_id) then
        return 'child_session';
      end if;
      return 'session_not_active';
    end if;
    if coalesce(v_claims ->> 'aal', '') <> 'aal2' and private.has_two_factor(v_user_id)
       and (private.is_deactivated(v_user_id)
            or not private.session_trusted(v_user_id, v_session_id)) then
      return 'second_factor_required';
    end if;
    if private.is_deactivated(v_user_id) then
      return 'account_deactivated';
    end if;
    return 'ok';
  end
  $$;

-- The only API calls a child session may make. Each checks child_has_capability itself.
create function private.child_session_paths() returns text[]
  language sql immutable parallel safe set search_path = '' as $$
    select array['/rpc/child_me', '/rpc/child_end_session']::text[]
  $$;

revoke all on function private.child_session_paths() from public;

-- As 20261125090000_account_lifecycle.sql, plus: a child session may only call child_session_paths().
create or replace function private.enforce_request_session() returns void
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_state text := private.request_session_state();
    v_path text := coalesce(pg_catalog.current_setting('request.path', true), '');
  begin
    if v_state = 'session_not_active' then
      raise sqlstate 'PT401' using message = 'session_not_active';
    end if;
    if v_state = 'child_session' and v_path <> all (private.child_session_paths()) then
      raise sqlstate 'PT403' using message = 'child_session_scope';
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

-- Realtime (not PostgREST) uses request_session_ok() in its policies: 'child_session' is not 'ok',
-- so children receive no Realtime events.

-- Guardian management -------------------------------------------------------------------------------------

-- The child behind a membership and the caller's guardian role for them, under the Home lock.
-- Outcome 'not_found' for a Home the caller is not in or a membership that is not a child there;
-- 'not_permitted' for a caller who is not one of the child's guardians in that Home.
create function private.lock_guarded_child(
  p_home_id uuid, p_child_membership_id uuid, p_user_id uuid,
  out o_outcome text, out o_child uuid, out o_role text
)
  language plpgsql security definer set search_path = '' as $$
  begin
    if not private.lock_home(p_home_id) or private.home_role(p_home_id, p_user_id) is null then
      o_outcome := 'not_found';
      return;
    end if;
    o_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if o_child is null then
      o_outcome := 'not_found';
      return;
    end if;
    o_role := private.child_guardian_role(p_home_id, o_child, p_user_id);
    o_outcome := case when o_role is null then 'not_permitted' else 'ok' end;
  end
  $$;

revoke all on function private.lock_guarded_child(uuid, uuid, uuid) from public;

-- Interim identity-level authority (spec "identity-level guardians", owner decision 2026-11-12):
-- the child's identity-wide credentials (username, independent password, its lock and password
-- sessions) may be changed only by a guardian who is the child's primary guardian in every Home the
-- child belongs to. A Home-only guardian of a child in several Homes cannot reach them; dedicated
-- identity guardians replace this rule in a later step.
create function private.child_identity_authority(p_child uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.home_memberships m where m.user_id = p_child)
       and not exists (
         select 1 from public.home_memberships m
         where m.user_id = p_child
           and private.child_guardian_role(m.home_id, p_child, p_user_id) is distinct from 'primary'
       )
  $$;

revoke all on function private.child_identity_authority(uuid, uuid) from public;

-- What a guardian sees about a child's sign-in in this Home. Never a hash, PIN or password.
create function public.child_sign_in_settings(p_home_id uuid, p_child_membership_id uuid)
returns table (
  username text,
  has_password boolean,
  has_pin boolean,
  password_sign_in boolean,
  pin_sign_in boolean,
  password_locked_until timestamptz,
  pin_locked_until timestamptz,
  active_sessions integer,
  can_manage_identity boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid := private.child_of_membership(p_home_id, p_child_membership_id);
  begin
    if v_child is null or private.home_role(p_home_id, v_user_id) is null
       or private.child_guardian_role(p_home_id, v_child, v_user_id) is null then
      raise exception 'not a guardian of this child here' using errcode = '42501';
    end if;
    return query
      -- Sessions count only where they reach this Home: its PIN sessions, and password sessions
      -- while password sign-in is on here. Nothing about the child's other Homes.
      select c.username,
             c.password_hash is not null,
             hp.pin_hash is not null,
             s.password_sign_in,
             s.pin_sign_in,
             case when c.password_locked_until > pg_catalog.now() then c.password_locked_until end,
             case when hp.pin_locked_until > pg_catalog.now() then hp.pin_locked_until end,
             (select count(*)::integer from private.child_sessions cs
                where cs.child_user_id = v_child and cs.ended_at is null
                  and cs.expires_at > pg_catalog.now()
                  and ((cs.method = 'pin' and cs.home_id = p_home_id)
                       or (cs.method = 'password' and s.password_sign_in))),
             private.child_identity_authority(v_child, v_user_id)
      from public.child_home_settings s
      left join private.child_credentials c on c.child_user_id = s.child_user_id
      left join private.child_home_pins hp
        on hp.home_id = s.home_id and hp.child_user_id = s.child_user_id
      where s.home_id = p_home_id and s.child_user_id = v_child;
  end
  $$;

revoke all on function public.child_sign_in_settings(uuid, uuid) from public, anon;
grant execute on function public.child_sign_in_settings(uuid, uuid) to authenticated;

-- The child's username (identity-wide: primary guardian in every Home of the child, see
-- child_identity_authority). 'taken' when another child has it. Returns 'saved', 'unchanged', 'taken', 'not_permitted' or 'not_found'.
create function public.set_child_username(
  p_home_id uuid, p_child_membership_id uuid, p_username text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_guard record;
    v_username text := pg_catalog.lower(p_username);
  begin
    if v_username is null or v_username !~ '^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$' then
      raise exception 'invalid username' using errcode = '22023';
    end if;
    v_guard := private.lock_guarded_child(p_home_id, p_child_membership_id, v_user_id);
    if v_guard.o_outcome <> 'ok' then
      return v_guard.o_outcome;
    end if;
    if not private.child_identity_authority(v_guard.o_child, v_user_id) then
      return 'not_permitted';
    end if;
    perform 1 from private.child_credentials c where c.child_user_id = v_guard.o_child for update;
    if exists (select 1 from private.child_credentials c
               where c.child_user_id = v_guard.o_child and c.username = v_username) then
      return 'unchanged';
    end if;
    if exists (select 1 from private.child_credentials c
               where c.username = v_username and c.child_user_id <> v_guard.o_child) then
      return 'taken';
    end if;
    begin
      insert into private.child_credentials (child_user_id, username)
        values (v_guard.o_child, v_username)
        on conflict (child_user_id) do update
          set username = excluded.username, updated_at = pg_catalog.now();
    exception when unique_violation then
      return 'taken';
    end;
    perform private.ensure_child_alias(v_guard.o_child);
    perform private.audit('child.username_set', p_home_id, 'user', v_guard.o_child, '{}'::jsonb);
    return 'saved';
  end
  $$;

revoke all on function public.set_child_username(uuid, uuid, text) from public, anon;
grant execute on function public.set_child_username(uuid, uuid, text) to authenticated;

-- Sets (or replaces) the child's password or PIN hash, made by the web server. The password is
-- the identity-wide independent credential (child_identity_authority, and only once a username
-- exists); the PIN belongs to this Home and either of its guardians may set it (spec: routine help
-- with approved-device PINs). A new credential clears its lock and ends the sessions it opened
-- (a PIN: only this Home's PIN sessions). Returns 'saved', 'username_required',
-- 'not_permitted' or 'not_found'.
create function public.set_child_credential(
  p_home_id uuid, p_child_membership_id uuid, p_kind text, p_hash text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_guard record;
  begin
    if p_kind is null or p_kind not in ('password', 'pin') then
      raise exception 'invalid credential kind' using errcode = '22023';
    end if;
    if not private.is_child_secret_hash(p_hash) then
      raise exception 'invalid credential' using errcode = '22023';
    end if;
    v_guard := private.lock_guarded_child(p_home_id, p_child_membership_id, v_user_id);
    if v_guard.o_outcome <> 'ok' then
      return v_guard.o_outcome;
    end if;
    if p_kind = 'password' then
      if not private.child_identity_authority(v_guard.o_child, v_user_id) then
        return 'not_permitted';
      end if;
      perform 1 from private.child_credentials c where c.child_user_id = v_guard.o_child for update;
      if not exists (
        select 1 from private.child_credentials c
        where c.child_user_id = v_guard.o_child and c.username is not null
      ) then
        return 'username_required';
      end if;
      update private.child_credentials c
        set password_hash = p_hash, password_set_at = pg_catalog.now(), password_failures = 0,
            password_locked_until = null, password_locks = 0, password_locks_since = null,
            updated_at = pg_catalog.now()
        where c.child_user_id = v_guard.o_child;
      perform private.end_child_sessions(v_guard.o_child, 'password', 'credential_changed');
    else
      insert into private.child_home_pins (home_id, child_user_id, pin_hash)
        values (p_home_id, v_guard.o_child, p_hash)
        on conflict (home_id, child_user_id) do update
          set pin_hash = excluded.pin_hash, pin_set_at = pg_catalog.now(), pin_failures = 0,
              pin_locked_until = null, pin_locks = 0, pin_locks_since = null,
              updated_at = pg_catalog.now();
      perform private.end_child_sessions(v_guard.o_child, 'pin', 'credential_changed', null,
                                         p_home_id);
    end if;
    perform private.ensure_child_alias(v_guard.o_child);
    perform private.audit('child.' || p_kind || '_set', p_home_id, 'user', v_guard.o_child,
      jsonb_build_object('by_role', v_guard.o_role));
    return 'saved';
  end
  $$;

revoke all on function public.set_child_credential(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_child_credential(uuid, uuid, text, text) to authenticated;

-- Removes the child's password (child_identity_authority) or this Home's PIN (either guardian
-- here) and ends the sessions it opened. Returns 'cleared', 'unchanged', 'not_permitted' or 'not_found'.
create function public.clear_child_credential(
  p_home_id uuid, p_child_membership_id uuid, p_kind text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_guard record;
    v_found boolean;
  begin
    if p_kind is null or p_kind not in ('password', 'pin') then
      raise exception 'invalid credential kind' using errcode = '22023';
    end if;
    v_guard := private.lock_guarded_child(p_home_id, p_child_membership_id, v_user_id);
    if v_guard.o_outcome <> 'ok' then
      return v_guard.o_outcome;
    end if;
    if p_kind = 'password'
       and not private.child_identity_authority(v_guard.o_child, v_user_id) then
      return 'not_permitted';
    end if;
    if p_kind = 'password' then
      update private.child_credentials c
        set password_hash = null, password_set_at = null, password_failures = 0,
            password_locked_until = null, password_locks = 0, password_locks_since = null,
            updated_at = pg_catalog.now()
        where c.child_user_id = v_guard.o_child and c.password_hash is not null
        returning true into v_found;
    else
      delete from private.child_home_pins hp
        where hp.home_id = p_home_id and hp.child_user_id = v_guard.o_child
        returning true into v_found;
    end if;
    if v_found is null then
      return 'unchanged';
    end if;
    perform private.end_child_sessions(v_guard.o_child, p_kind, 'credential_removed', null,
      case when p_kind = 'pin' then p_home_id end);
    perform private.audit('child.' || p_kind || '_cleared', p_home_id, 'user', v_guard.o_child,
      jsonb_build_object('by_role', v_guard.o_role));
    return 'cleared';
  end
  $$;

revoke all on function public.clear_child_credential(uuid, uuid, text) from public, anon;
grant execute on function public.clear_child_credential(uuid, uuid, text) to authenticated;

-- Turns password (independent) and PIN sign-in on or off for this child in this Home. Turning
-- either on is the primary guardian's decision (spec: primary-only sensitive authority); either
-- guardian may turn one off. A change takes effect on the child's next request (the request check
-- reads these switches). Returns 'saved', 'unchanged', 'not_permitted' or 'not_found'.
create function public.set_child_sign_in_access(
  p_home_id uuid, p_child_membership_id uuid, p_password_sign_in boolean, p_pin_sign_in boolean
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_guard record;
    v_before public.child_home_settings;
  begin
    if p_password_sign_in is null or p_pin_sign_in is null then
      raise exception 'both switches are required' using errcode = '22023';
    end if;
    v_guard := private.lock_guarded_child(p_home_id, p_child_membership_id, v_user_id);
    if v_guard.o_outcome <> 'ok' then
      return v_guard.o_outcome;
    end if;
    select * into v_before from public.child_home_settings s
      where s.home_id = p_home_id and s.child_user_id = v_guard.o_child for update;
    if v_before.password_sign_in = p_password_sign_in and v_before.pin_sign_in = p_pin_sign_in then
      return 'unchanged';
    end if;
    if v_guard.o_role <> 'primary'
       and ((p_password_sign_in and not v_before.password_sign_in)
            or (p_pin_sign_in and not v_before.pin_sign_in)) then
      return 'not_permitted';
    end if;
    update public.child_home_settings s
      set password_sign_in = p_password_sign_in, pin_sign_in = p_pin_sign_in,
          sign_in_updated_at = pg_catalog.now()
      where s.home_id = p_home_id and s.child_user_id = v_guard.o_child;
    -- PIN sessions on this Home's devices end with the switch.
    if v_before.pin_sign_in and not p_pin_sign_in then
      perform private.end_child_sessions(v_guard.o_child, 'pin', 'sign_in_turned_off', null,
                                         p_home_id);
    end if;
    perform private.audit('child.sign_in_access_changed', p_home_id, 'user', v_guard.o_child,
      jsonb_build_object(
        'by_role', v_guard.o_role,
        'before', jsonb_build_object('password', v_before.password_sign_in,
                                     'pin', v_before.pin_sign_in),
        'after', jsonb_build_object('password', p_password_sign_in, 'pin', p_pin_sign_in)));
    return 'saved';
  end
  $$;

revoke all on function public.set_child_sign_in_access(uuid, uuid, boolean, boolean)
  from public, anon;
grant execute on function public.set_child_sign_in_access(uuid, uuid, boolean, boolean)
  to authenticated;

-- Lifts this Home's PIN lock (either guardian here) and, for a caller with
-- child_identity_authority, the password lock. Returns 'unlocked', 'unchanged', 'not_permitted' or
-- 'not_found'.
create function public.unlock_child_sign_in(p_home_id uuid, p_child_membership_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_guard record;
    v_found boolean;
    v_pin_found boolean;
  begin
    v_guard := private.lock_guarded_child(p_home_id, p_child_membership_id, v_user_id);
    if v_guard.o_outcome <> 'ok' then
      return v_guard.o_outcome;
    end if;
    update private.child_home_pins hp
      set pin_failures = 0, pin_locked_until = null, pin_locks = 0, pin_locks_since = null,
          updated_at = pg_catalog.now()
      where hp.home_id = p_home_id and hp.child_user_id = v_guard.o_child
        and (hp.pin_locked_until > pg_catalog.now() or hp.pin_failures > 0 or hp.pin_locks > 0)
      returning true into v_pin_found;
    if private.child_identity_authority(v_guard.o_child, v_user_id) then
      update private.child_credentials c
        set password_failures = 0, password_locked_until = null, password_locks = 0,
            password_locks_since = null, updated_at = pg_catalog.now()
        where c.child_user_id = v_guard.o_child
          and (c.password_locked_until > pg_catalog.now() or c.password_failures > 0
               or c.password_locks > 0)
        returning true into v_found;
    end if;
    if v_found is null and v_pin_found is null then
      return 'unchanged';
    end if;
    perform private.audit('child.sign_in_unlocked', p_home_id, 'user', v_guard.o_child,
      jsonb_build_object('by_role', v_guard.o_role));
    return 'unlocked';
  end
  $$;

revoke all on function public.unlock_child_sign_in(uuid, uuid) from public, anon;
grant execute on function public.unlock_child_sign_in(uuid, uuid) to authenticated;

-- Signs the child out, for a lost device: this Home's PIN sessions (either guardian here) and, for
-- a caller with child_identity_authority, every password session too. A Home-only guardian cuts
-- password access to their Home by turning password sign-in off here. Returns the outcome and how
-- many sessions ended.
create function public.end_child_sign_ins(p_home_id uuid, p_child_membership_id uuid)
returns table (outcome text, ended integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_guard record;
    v_count integer;
  begin
    v_guard := private.lock_guarded_child(p_home_id, p_child_membership_id, v_user_id);
    if v_guard.o_outcome <> 'ok' then
      return query select v_guard.o_outcome, 0;
      return;
    end if;
    v_count := private.end_child_sessions(v_guard.o_child, 'pin', 'ended_by_guardian', null,
                                          p_home_id);
    if private.child_identity_authority(v_guard.o_child, v_user_id) then
      v_count := v_count
        + private.end_child_sessions(v_guard.o_child, 'password', 'ended_by_guardian');
    end if;
    perform private.audit('child.sessions_ended', p_home_id, 'user', v_guard.o_child,
      jsonb_build_object('by_role', v_guard.o_role, 'count', v_count));
    return query select 'ended'::text, v_count;
  end
  $$;

revoke all on function public.end_child_sign_ins(uuid, uuid) from public, anon;
grant execute on function public.end_child_sign_ins(uuid, uuid) to authenticated;

-- Household devices (Home managers) ------------------------------------------------------------------------

-- Approves the caller's own browser for child PIN sign-in in this Home: the Owner, or an
-- Administrator granted manageHomeSettings. The web server made the secret and sends only its
-- SHA-256. Returns the outcome and the device id.
create function public.approve_household_device(
  p_home_id uuid, p_label text, p_secret_hash text
) returns table (outcome text, device_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
  begin
    if p_label is null or not private.is_visible_name(p_label, 60) then
      raise exception 'invalid device name' using errcode = '22023';
    end if;
    if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid device secret' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) or private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if not private.has_home_capability(p_home_id, v_user_id, 'manageHomeSettings') then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;
    if (select count(*) from private.household_devices d
        where d.home_id = p_home_id and d.revoked_at is null)
       >= (select l.devices_per_home from private.child_sign_in_limits() l) then
      return query select 'limit_reached'::text, null::uuid;
      return;
    end if;
    insert into private.household_devices (home_id, label, secret_hash, approved_by)
      values (p_home_id, p_label, p_secret_hash, v_user_id)
      returning id into v_id;
    perform private.audit('household_device.approved', p_home_id, 'household_device', v_id,
      '{}'::jsonb);
    return query select 'approved'::text, v_id;
  end
  $$;

revoke all on function public.approve_household_device(uuid, text, text) from public, anon;
grant execute on function public.approve_household_device(uuid, text, text) to authenticated;

-- Revokes a device (same managers); its PIN sessions end at once. Returns 'revoked', 'unchanged',
-- 'not_permitted' or 'not_found'.
create function public.revoke_household_device(p_home_id uuid, p_device_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_device private.household_devices;
  begin
    if not private.lock_home(p_home_id) or private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    if not private.has_home_capability(p_home_id, v_user_id, 'manageHomeSettings') then
      return 'not_permitted';
    end if;
    select * into v_device from private.household_devices d
      where d.id = p_device_id and d.home_id = p_home_id for update;
    if not found then
      return 'not_found';
    end if;
    if v_device.revoked_at is not null then
      return 'unchanged';
    end if;
    update private.household_devices d
      set revoked_at = pg_catalog.now(), revoked_by = v_user_id
      where d.id = p_device_id;
    perform private.end_child_sessions(null, 'pin', 'device_revoked', p_device_id);
    perform private.audit('household_device.revoked', p_home_id, 'household_device', p_device_id,
      '{}'::jsonb);
    return 'revoked';
  end
  $$;

revoke all on function public.revoke_household_device(uuid, uuid) from public, anon;
grant execute on function public.revoke_household_device(uuid, uuid) to authenticated;

-- The Home's approved devices, for the same managers. p_current_hash (the caller's own device
-- cookie, hashed by the web server, or '') only marks which row is the caller's browser.
create function public.home_household_devices(p_home_id uuid, p_current_hash text)
returns table (
  device_id uuid,
  label text,
  approved_by_membership_id uuid,
  approved_at timestamptz,
  last_used_at timestamptz,
  is_this_device boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if private.home_role(p_home_id, v_user_id) is null
       or not private.has_home_capability(p_home_id, v_user_id, 'manageHomeSettings') then
      raise exception 'not a manager of this Home' using errcode = '42501';
    end if;
    return query
      select d.id, d.label,
             (select m.id from public.home_memberships m
                where m.home_id = d.home_id and m.user_id = d.approved_by),
             d.approved_at, d.last_used_at,
             d.secret_hash = nullif(p_current_hash, '')
      from private.household_devices d
      where d.home_id = p_home_id and d.revoked_at is null
      order by d.approved_at, d.id;
  end
  $$;

revoke all on function public.home_household_devices(uuid, text) from public, anon;
grant execute on function public.home_household_devices(uuid, text) to authenticated;

-- Signing in (the web server only, as service_role) ------------------------------------------------------------

-- Counts a wrong try against one credential (the password, or the PIN in p_home_id): the fifth
-- since the last success or lock locks it for 15 minutes, and the third lock within 24 hours locks
-- it until a guardian unlocks it.
create function private.next_child_lock(
  p_failures integer, p_locks integer, p_since timestamptz,
  out o_failures integer, out o_locks integer, out o_since timestamptz, out o_until timestamptz
)
  language plpgsql stable set search_path = '' as $$
  declare
    v_limits record := private.child_sign_in_limits();
  begin
    o_failures := p_failures + 1;
    o_locks := p_locks;
    o_since := p_since;
    if o_since is null or o_since <= pg_catalog.now() - v_limits.lock_count_window then
      o_locks := 0;
      o_since := null;
    end if;
    if o_failures >= v_limits.failures_before_lock then
      o_failures := 0;
      o_locks := o_locks + 1;
      o_since := coalesce(o_since, pg_catalog.now());
      o_until := case when o_locks >= v_limits.locks_before_guardian_unlock
        then 'infinity'::timestamptz else pg_catalog.now() + v_limits.lock_duration end;
    end if;
  end
  $$;

revoke all on function private.next_child_lock(integer, integer, timestamptz) from public;

create function private.count_child_failure(p_child uuid, p_kind text, p_home_id uuid default null)
returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_c private.child_credentials;
    v_p private.child_home_pins;
    v_n record;
  begin
    if p_kind = 'password' then
      select * into v_c from private.child_credentials c where c.child_user_id = p_child for update;
      if not found then
        return;
      end if;
      v_n := private.next_child_lock(v_c.password_failures, v_c.password_locks,
                                     v_c.password_locks_since);
      update private.child_credentials c
        set password_failures = v_n.o_failures, password_locks = v_n.o_locks,
            password_locks_since = v_n.o_since,
            password_locked_until = coalesce(v_n.o_until, c.password_locked_until)
        where c.child_user_id = p_child;
    else
      select * into v_p from private.child_home_pins hp
        where hp.home_id = p_home_id and hp.child_user_id = p_child for update;
      if not found then
        return;
      end if;
      v_n := private.next_child_lock(v_p.pin_failures, v_p.pin_locks, v_p.pin_locks_since);
      update private.child_home_pins hp
        set pin_failures = v_n.o_failures, pin_locks = v_n.o_locks, pin_locks_since = v_n.o_since,
            pin_locked_until = coalesce(v_n.o_until, hp.pin_locked_until)
        where hp.home_id = p_home_id and hp.child_user_id = p_child;
    end if;
  end
  $$;

revoke all on function private.count_child_failure(uuid, text, uuid) from public;

create function private.check_child_client_key(p_client_key text) returns void
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_client_key is null or p_client_key !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid client key' using errcode = '22023';
    end if;
  end
  $$;

revoke all on function private.check_child_client_key(text) from public;

-- Whether this client has used up its failed tries (both methods together).
create function private.child_client_throttled(p_client_key text) returns boolean
  language sql stable security definer set search_path = '' as $$
    select (select count(*) from private.child_sign_in_attempts a
            where a.client_key = p_client_key and a.verified_at is null
              and a.created_at > pg_catalog.now() - (select l.client_window
                                                      from private.child_sign_in_limits() l))
           >= (select l.client_failures_per_window from private.child_sign_in_limits() l)
  $$;

revoke all on function private.child_client_throttled(text) from public;

-- Step 1 of password sign-in. Records the attempt (and counts it as a wrong try until step 2
-- confirms it), then returns the hash for the web server to check:
--   'check'        compare the password with password_hash, then call child_sign_in_verified;
--   'unknown'      no such username or no password (the server still runs a dummy comparison,
--                  then answers exactly as for a wrong password);
--   'locked'       too many wrong tries (locked_until; 'infinity' until a guardian unlocks);
--   'rate_limited' too many failed tries from this client.
create function public.child_password_attempt(p_username text, p_client_key text)
returns table (outcome text, attempt_id uuid, password_hash text, locked_until timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_c private.child_credentials;
    v_attempt uuid;
  begin
    perform private.check_child_client_key(p_client_key);
    delete from private.child_sign_in_attempts a
      where a.created_at < pg_catalog.now() - interval '1 day';
    if private.child_client_throttled(p_client_key) then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    select * into v_c from private.child_credentials c
      where c.username = pg_catalog.lower(coalesce(p_username, ''))
      for update;
    insert into private.child_sign_in_attempts (method, child_user_id, client_key)
      values ('password', v_c.child_user_id, p_client_key)
      returning id into v_attempt;
    if v_c.child_user_id is null or v_c.password_hash is null then
      return query select 'unknown'::text, v_attempt, null::text, null::timestamptz;
      return;
    end if;
    if v_c.password_locked_until > pg_catalog.now() then
      return query select 'locked'::text, null::uuid, null::text, v_c.password_locked_until;
      return;
    end if;
    perform private.count_child_failure(v_c.child_user_id, 'password');
    update private.child_sign_in_attempts a set checked_at = pg_catalog.now()
      where a.id = v_attempt;
    return query select 'check'::text, v_attempt, v_c.password_hash, null::timestamptz;
  end
  $$;

revoke all on function public.child_password_attempt(text, text) from public, anon, authenticated;
grant execute on function public.child_password_attempt(text, text) to service_role;

-- The approved device behind a cookie's hash, or nothing (unknown, revoked, or its Home closed).
create function private.approved_device(p_secret_hash text) returns private.household_devices
  language sql stable security definer set search_path = '' as $$
    select d.* from private.household_devices d
    join public.homes h on h.id = d.home_id
    where d.secret_hash = p_secret_hash and d.revoked_at is null
      and private.home_is_open(d.home_id)
  $$;

revoke all on function private.approved_device(text) from public;

-- Step 1 of PIN sign-in, on an approved device only. Same outcomes as child_password_attempt, plus
-- 'device_not_approved'. The child is named by their membership in the device's Home.
create function public.child_pin_attempt(
  p_device_hash text, p_child_membership_id uuid, p_client_key text
) returns table (outcome text, attempt_id uuid, pin_hash text, locked_until timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_device private.household_devices;
    v_child uuid;
    v_p private.child_home_pins;
    v_attempt uuid;
  begin
    perform private.check_child_client_key(p_client_key);
    delete from private.child_sign_in_attempts a
      where a.created_at < pg_catalog.now() - interval '1 day';
    if private.child_client_throttled(p_client_key) then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    v_device := private.approved_device(coalesce(p_device_hash, ''));
    if v_device.id is null then
      insert into private.child_sign_in_attempts (method, client_key) values ('pin', p_client_key);
      return query select 'device_not_approved'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if (select count(*) from private.child_sign_in_attempts a
        where a.device_id = v_device.id and a.verified_at is null
          and a.created_at > pg_catalog.now() - interval '1 hour')
       >= (select l.device_failures_per_hour from private.child_sign_in_limits() l) then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    v_child := private.child_of_membership(v_device.home_id, p_child_membership_id);
    if v_child is not null then
      select * into v_p from private.child_home_pins hp
        where hp.home_id = v_device.home_id and hp.child_user_id = v_child for update;
    end if;
    insert into private.child_sign_in_attempts (method, child_user_id, device_id, client_key)
      values ('pin', v_p.child_user_id, v_device.id, p_client_key)
      returning id into v_attempt;
    if v_p.child_user_id is null then
      return query select 'unknown'::text, v_attempt, null::text, null::timestamptz;
      return;
    end if;
    if v_p.pin_locked_until > pg_catalog.now() then
      return query select 'locked'::text, null::uuid, null::text, v_p.pin_locked_until;
      return;
    end if;
    perform private.count_child_failure(v_p.child_user_id, 'pin', v_device.home_id);
    update private.child_sign_in_attempts a set checked_at = pg_catalog.now()
      where a.id = v_attempt;
    return query select 'check'::text, v_attempt, v_p.pin_hash, null::timestamptz;
  end
  $$;

revoke all on function public.child_pin_attempt(text, uuid, text) from public, anon, authenticated;
grant execute on function public.child_pin_attempt(text, uuid, text) to service_role;

-- Step 2, after the web server matched the hash: clears the wrong-try count and, when sign-in is
-- allowed for this method, returns the child's id and internal alias for issuing the session.
-- 'not_enabled' when the credential was right but sign-in is off ('expired' / 'invalid' for an
-- attempt that is too old or not in step 1's 'check' state). 'not_configured' when PostgREST's
-- pre-request check (pgrst.db_pre_request, which confines child tokens) is not set up: no child
-- session is issued without it.
create function public.child_sign_in_verified(p_attempt_id uuid)
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

revoke all on function public.child_sign_in_verified(uuid) from public, anon, authenticated;
grant execute on function public.child_sign_in_verified(uuid) to service_role;

-- Step 3: registers the Supabase Auth session just issued for this attempt, which is what makes the
-- child's token usable. Returns 'registered' and when the session ends, or 'invalid'.
create function public.child_sign_in_complete(p_attempt_id uuid, p_session_id uuid)
returns table (outcome text, expires_at timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_limits record := private.child_sign_in_limits();
    v_a private.child_sign_in_attempts;
    v_device private.household_devices;
    v_expires timestamptz;
    v_home uuid;
  begin
    select * into v_a from private.child_sign_in_attempts a
      where a.id = p_attempt_id for update;
    if not found or v_a.verified_at is null or v_a.completed_at is not null
       or v_a.verified_at <= pg_catalog.now() - v_limits.attempt_lifetime
       or not exists (
         select 1 from auth.sessions s
         where s.id = p_session_id and s.user_id = v_a.child_user_id
           and s.created_at > pg_catalog.now() - v_limits.attempt_lifetime
       )
       or exists (select 1 from private.child_sessions cs where cs.session_id = p_session_id) then
      return query select 'invalid'::text, null::timestamptz;
      return;
    end if;
    update private.child_sign_in_attempts a set completed_at = pg_catalog.now()
      where a.id = v_a.id;
    if v_a.method = 'pin' then
      select * into v_device from private.household_devices d where d.id = v_a.device_id;
      v_expires := pg_catalog.now() + v_limits.pin_session;
      insert into private.child_sessions (session_id, child_user_id, method, home_id, device_id,
                                          expires_at)
        values (p_session_id, v_a.child_user_id, 'pin', v_device.home_id, v_device.id, v_expires);
      update private.household_devices d set last_used_at = pg_catalog.now()
        where d.id = v_device.id;
      perform private.audit('child.signed_in', v_device.home_id, 'user', v_a.child_user_id,
        jsonb_build_object('method', 'pin', 'device_id', v_device.id));
    else
      v_expires := pg_catalog.now() + v_limits.password_session;
      insert into private.child_sessions (session_id, child_user_id, method, expires_at)
        values (p_session_id, v_a.child_user_id, 'password', v_expires);
      for v_home in
        select s.home_id from public.child_home_settings s
        join public.home_memberships m on m.home_id = s.home_id and m.user_id = s.child_user_id
        where s.child_user_id = v_a.child_user_id and s.password_sign_in
      loop
        perform private.audit('child.signed_in', v_home, 'user', v_a.child_user_id,
          jsonb_build_object('method', 'password'));
      end loop;
    end if;
    return query select 'registered'::text, v_expires;
  end
  $$;

revoke all on function public.child_sign_in_complete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.child_sign_in_complete(uuid, uuid) to service_role;

-- The PIN sign-in screen of an approved device: its Home and the children who can use a PIN there
-- (name and colour only). Nothing for an unknown or revoked device.
create function public.household_device_sign_in(p_device_hash text)
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
      )
    left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
    left join public.user_preferences up on up.user_id = m.user_id
    where d.id is not null
    order by m.created_at, m.id
  $$;

revoke all on function public.household_device_sign_in(text) from public, anon, authenticated;
grant execute on function public.household_device_sign_in(text) to service_role;

-- The child's own session --------------------------------------------------------------------------------

-- The signed-in child: each Home this session reaches, their name and colour there and what they
-- may do there. Refused for anyone but a child in a live child session.
create function public.child_me()
returns table (
  home_id uuid,
  home_name text,
  display_name text,
  accent_color text,
  capabilities text[],
  method text,
  session_expires_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
  begin
    if v_user_id is null or v_session_id is null or not private.is_child(v_user_id)
       or not private.child_session_ok(v_user_id, v_session_id) then
      raise exception 'not a child session' using errcode = '42501';
    end if;
    return query
      select h.id, h.name,
             coalesce(p.nickname, p.display_name, up.display_name),
             coalesce(p.accent_color, up.accent_color),
             private.child_effective_capabilities(s.preset, s.overrides),
             cs.method, cs.expires_at
      from private.child_session_homes(v_user_id, v_session_id) sh(home_id)
      join public.homes h on h.id = sh.home_id
      join public.child_home_settings s on s.home_id = sh.home_id and s.child_user_id = v_user_id
      join private.child_sessions cs on cs.session_id = v_session_id
      left join public.home_member_profiles p on p.home_id = sh.home_id and p.user_id = v_user_id
      left join public.user_preferences up on up.user_id = v_user_id
      order by h.name, h.id;
  end
  $$;

revoke all on function public.child_me() from public, anon;
grant execute on function public.child_me() to authenticated;

-- Ends the caller's own child session (the app then signs out of Supabase Auth too).
create function public.child_end_session() returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
  begin
    if v_user_id is null or v_session_id is null or not private.is_child(v_user_id) then
      raise exception 'not a child session' using errcode = '42501';
    end if;
    update private.child_sessions cs
      set ended_at = pg_catalog.now(), end_reason = 'signed_out'
      where cs.session_id = v_session_id and cs.child_user_id = v_user_id and cs.ended_at is null;
    delete from auth.sessions s where s.id = v_session_id and s.user_id = v_user_id;
  end
  $$;

revoke all on function public.child_end_session() from public, anon;
grant execute on function public.child_end_session() to authenticated;
