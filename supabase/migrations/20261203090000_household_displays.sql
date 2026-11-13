-- S43: Household Display pairing and identity (spec "Confirmed dedicated household display identity
-- and privacy lock screen", "Confirmed manager-approved pairing for household displays";
-- architecture.md §7 and §33; brief plans/steps/S43-brief.md).
--
-- An unregistered tablet shows a short-lived, single-use pairing code. A Home manager, in their own
-- session, enters the code, reviews the device, names it and approves it into one Home. The tablet
-- then turns the approval into its own Supabase Auth session, using a secret only it holds:
--   * the tablet keeps a random 32-byte claim secret in an httpOnly cookie; its 8-character code is
--     derived from that secret by the web server. Only SHA-256 hashes of both are stored here;
--   * approval locks the request row and binds it, in one transaction, to the reviewed request, the
--     Home, the manager and a new device record with its own Supabase Auth user. A second approval
--     of the same code (concurrent claim, replay, another Home) finds it already used;
--   * only the browser holding the claim secret can register a session for the approval, once.
--
-- A display's session is locked down at the same choke points as a child's (S42):
--   1. private.confirmed_email() is null for a display, so every function behind
--      require_confirmed_caller() refuses it, and it never receives email or notifications;
--   2. the PostgREST pre-request check accepts a display's token only for a registered session of
--      an unrevoked display in an open Home, and then only for display_session_paths(); every table,
--      view, GraphQL and other function call is refused, and Realtime is refused;
--   3. a display's auth.users row can never get a password, another email address, a phone number
--      or a provider identity.
-- A display is never a Home member, so no membership-based policy ever matches it.

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
    'calendar_event', 'photo', 'photo_album', 'home_copy', 'household_device', 'household_display'
  ));

-- Limits (brief S43 defaults, owner may change) ------------------------------------------------------

create function private.display_limits(
  out code_lifetime interval,
  out claim_window interval,
  out codes_per_client integer,
  out client_window interval,
  out failures_per_manager integer,
  out manager_window interval,
  out displays_per_home integer,
  out seen_interval interval,
  out revoked_listed interval
)
  language sql immutable parallel safe set search_path = '' as $$
    select interval '10 minutes', interval '10 minutes', 30, interval '1 hour', 10,
           interval '15 minutes', 10, interval '1 minute', interval '30 days'
  $$;

revoke all on function private.display_limits() from public;

-- Identity -------------------------------------------------------------------------------------------

-- Whether a user is a Household Display: the kind Madeora's approval wrote into the account's app
-- metadata (users cannot edit app metadata; the guard below keeps it). Read from auth.users, not the
-- device record, so a display account can never be taken for an adult's.
create function private.is_display(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1 from auth.users u
      where u.id = p_user_id and u.raw_app_meta_data ->> 'madeora_kind' = 'display'
    )
  $$;

revoke all on function private.is_display(uuid) from public;
grant execute on function private.is_display(uuid) to service_role;

-- The internal, non-deliverable address Supabase Auth needs to issue a display's session. Never
-- shown, never mailed (.invalid is reserved and cannot resolve).
create function private.display_alias_email(p_display_user uuid) returns text
  language sql immutable parallel safe set search_path = '' as $$
    select 'display-' || p_display_user::text || '@displays.madeora.invalid'
  $$;

revoke all on function private.display_alias_email(uuid) from public;

-- As 20261130090000_child_sign_in.sql, and never for a display either.
create or replace function private.confirmed_email(p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.lower(u.email) from auth.users u
  where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null
    and not exists (select 1 from public.child_profiles c where c.user_id = u.id)
    and u.raw_app_meta_data ->> 'madeora_kind' is distinct from 'display';
  $$;

-- As 20261130090000_child_sign_in.sql, and never a display either.
create or replace function private.can_receive_notifications(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
      and not exists (select 1 from public.child_profiles c where c.user_id = u.id)
      and u.raw_app_meta_data ->> 'madeora_kind' is distinct from 'display'
  );
  $$;

-- Guards on a display's Supabase Auth rows ---------------------------------------------------------

create function private.guard_display_auth_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_row jsonb := pg_catalog.to_jsonb(new);
    v_was boolean := old.raw_app_meta_data ->> 'madeora_kind' = 'display';
    v_is boolean := new.raw_app_meta_data ->> 'madeora_kind' = 'display';
  begin
    if v_was is distinct from v_is and (v_was or v_is) then
      raise exception 'an account cannot become or stop being a Household Display'
        using errcode = '42501', hint = 'Household Displays are paired by Home managers (S43).';
    end if;
    if not coalesce(v_is, false) then
      return new;
    end if;
    if coalesce(new.encrypted_password, '') <> '' then
      raise exception 'a Household Display has no Supabase Auth password'
        using errcode = '42501', hint = 'Household Displays are paired by Home managers (S43).';
    end if;
    if coalesce(v_row ->> 'email_change', '') <> '' or coalesce(v_row ->> 'phone_change', '') <> ''
       or coalesce(v_row ->> 'phone', '') <> ''
       or new.email is distinct from private.display_alias_email(new.id) then
      raise exception 'a Household Display''s sign-in address cannot change'
        using errcode = '42501', hint = 'Household Displays are paired by Home managers (S43).';
    end if;
    return new;
  end
  $$;

revoke all on function private.guard_display_auth_user() from public;

create trigger madeora_guard_display_auth_user
  before update on auth.users
  for each row execute function private.guard_display_auth_user();

-- A display signs in only through Madeora's pairing: no Google or any other provider identity.
create function private.guard_display_identity() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if private.is_display(new.user_id) and new.provider <> 'email' then
      raise exception 'a Household Display cannot link a sign-in provider'
        using errcode = '42501', hint = 'Household Displays are paired by Home managers (S43).';
    end if;
    return new;
  end
  $$;

revoke all on function private.guard_display_identity() from public;

create trigger madeora_guard_display_identity
  before insert on auth.identities
  for each row execute function private.guard_display_identity();

-- Displays -------------------------------------------------------------------------------------------

-- A Household Display paired into one Home. user_id is its own Supabase Auth user while it is
-- active; revoking it deletes that user (every session and refresh token with it) and keeps this
-- row as the record managers see.
create table private.household_displays (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  user_id uuid constraint household_displays_user_key unique
    references auth.users (id) on delete set null,
  name text not null constraint household_displays_name_check
    check (private.is_visible_name(name, 40)),
  -- Best-effort description of the tablet when it asked for its code (S38 device_labels).
  device_kind text not null,
  browser text not null,
  platform text not null,
  paired_by uuid references auth.users (id) on delete set null,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  constraint household_displays_revoked_no_user check (revoked_at is null or user_id is null)
);

create index household_displays_home_idx on private.household_displays (home_id);

revoke all on table private.household_displays from public;

comment on table private.household_displays is
  'S43: Household Displays paired into a Home, each with its own display-only Supabase Auth user.';

-- Deleting a display record (its Home purged) deletes its Supabase Auth user too, so no display
-- account outlives its Home.
create function private.delete_display_user() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if old.user_id is not null then
      delete from auth.users u where u.id = old.user_id;
    end if;
    return null;
  end
  $$;

revoke all on function private.delete_display_user() from public;

create trigger household_displays_delete_user
  after delete on private.household_displays
  for each row execute function private.delete_display_user();

-- The Supabase Auth sessions Madeora registered for displays. A display's token works only while
-- its session is here and not ended, the display is not revoked and its Home is open.
create table private.display_sessions (
  session_id uuid primary key,
  display_id uuid not null references private.household_displays (id) on delete cascade,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text
);

create index display_sessions_display_idx on private.display_sessions (display_id)
  where ended_at is null;

revoke all on table private.display_sessions from public;

-- Pairing requests -------------------------------------------------------------------------------------

-- A tablet's request to be paired. Pending until a manager approves it into a Home ('approved'),
-- the tablet registers its session ('claimed'), or the tablet asks for a new code ('cancelled').
-- client_key is the web server's HMAC of the client address; the address is never stored. Rows
-- older than a day are removed by the next request.
create table private.display_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null
    constraint display_pairing_requests_secret_hash_check check (secret_hash ~ '^[0-9a-f]{64}$')
    constraint display_pairing_requests_secret_hash_key unique,
  code_hash text not null
    constraint display_pairing_requests_code_hash_check check (code_hash ~ '^[0-9a-f]{64}$'),
  client_key text not null
    constraint display_pairing_requests_client_key_check check (client_key ~ '^[0-9a-f]{64}$'),
  device_kind text not null,
  browser text not null,
  platform text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' constraint display_pairing_requests_status_check
    check (status in ('pending', 'approved', 'claimed', 'cancelled')),
  home_id uuid references public.homes (id) on delete cascade,
  display_id uuid references private.household_displays (id) on delete cascade,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  claimed_at timestamptz,
  constraint display_pairing_requests_approval_check check (
    (status in ('approved', 'claimed'))
      = (home_id is not null and display_id is not null and approved_at is not null)
  ),
  constraint display_pairing_requests_claim_check check ((status = 'claimed') = (claimed_at is not null))
);

-- One pending request per code, so a code names exactly one tablet.
create unique index display_pairing_requests_code_idx on private.display_pairing_requests (code_hash)
  where status = 'pending';
create index display_pairing_requests_client_idx
  on private.display_pairing_requests (client_key, created_at);
create index display_pairing_requests_created_idx on private.display_pairing_requests (created_at);

revoke all on table private.display_pairing_requests from public;

comment on table private.display_pairing_requests is
  'S43: Household Display pairing codes (SHA-256 of the code and of the tablet''s secret only).';

-- A manager's wrong, expired or used code, counted before the code is looked at so parallel
-- guesses cannot exceed the limit. Rows older than a day are removed by the next attempt.
create table private.display_pairing_failures (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index display_pairing_failures_user_idx on private.display_pairing_failures (user_id, created_at);

revoke all on table private.display_pairing_failures from public;

-- 2. Request-level enforcement ---------------------------------------------------------------------------

-- Whether a display's token is usable: a registered, not ended session of this display, which is
-- not revoked and whose Home is open.
create function private.display_session_ok(p_user_id uuid, p_session_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1 from private.display_sessions ds
      join private.household_displays d on d.id = ds.display_id
      where ds.session_id = p_session_id and d.user_id = p_user_id
        and ds.ended_at is null and d.revoked_at is null
        and private.home_is_open(d.home_id)
    )
  $$;

revoke all on function private.display_session_ok(uuid, uuid) from public;

-- As 20261130090000_child_sign_in.sql, plus: a display's token is 'display_session' while its
-- session is usable (display_session_ok) and 'session_not_active' otherwise (including a session
-- Supabase Auth issued some other way). Displays have no two-factor sign-in and are never
-- deactivated.
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
    if private.is_display(v_user_id) then
      if private.display_session_ok(v_user_id, v_session_id) then
        return 'display_session';
      end if;
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

-- The only API calls a display session may make.
create function private.display_session_paths() returns text[]
  language sql immutable parallel safe set search_path = '' as $$
    select array['/rpc/display_me']::text[]
  $$;

revoke all on function private.display_session_paths() from public;

-- As 20261130090000_child_sign_in.sql, plus: a display session may only call display_session_paths().
create or replace function private.enforce_request_session() returns void
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_state text := private.request_session_state();
    v_path text := coalesce(pg_catalog.current_setting('request.path', true), '');
  begin
    if v_state = 'session_not_active' then
      raise sqlstate 'PT401' using message = 'session_not_active';
    end if;
    if v_state = 'display_session' and v_path <> all (private.display_session_paths()) then
      raise sqlstate 'PT403' using message = 'display_session_scope';
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

-- Realtime (not PostgREST) uses request_session_ok() in its policies: 'display_session' is not
-- 'ok', so displays receive no Realtime events (S44 opens shared-display-safe ones).

-- 3. The tablet (the web server only, as service_role) ------------------------------------------------

-- Starts a pairing request for a tablet. The web server made the secret, derived the code from it
-- and sends only their SHA-256 hashes, a client key and the user agent (kept as labels only).
-- Returns 'created' and when the code expires, 'rate_limited' or 'collision' (another pending code
-- is the same; the server tries a new secret).
create function public.display_pairing_start(
  p_secret_hash text, p_code_hash text, p_client_key text, p_user_agent text
) returns table (outcome text, expires_at timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_limits record := private.display_limits();
    v_labels record := private.device_labels(p_user_agent);
    v_expires timestamptz := pg_catalog.now() + v_limits.code_lifetime;
  begin
    if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$'
       or p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$'
       or p_client_key is null or p_client_key !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid pairing request' using errcode = '22023';
    end if;
    -- One request at a time per client counts the throttle exactly.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('display_pairing_client:' || p_client_key, 0));
    delete from private.display_pairing_requests r
      where r.created_at < pg_catalog.now() - interval '1 day';
    if (select count(*) from private.display_pairing_requests r
        where r.client_key = p_client_key
          and r.created_at > pg_catalog.now() - v_limits.client_window)
       >= v_limits.codes_per_client then
      return query select 'rate_limited'::text, null::timestamptz;
      return;
    end if;
    -- An expired pending code no longer blocks the same code for a new tablet.
    update private.display_pairing_requests r set status = 'cancelled'
      where r.code_hash = p_code_hash and r.status = 'pending' and r.expires_at <= pg_catalog.now();
    begin
      insert into private.display_pairing_requests
          (secret_hash, code_hash, client_key, device_kind, browser, platform, expires_at)
        values (p_secret_hash, p_code_hash, p_client_key, v_labels.device_kind, v_labels.browser,
                v_labels.platform, v_expires);
    exception when unique_violation then
      return query select 'collision'::text, null::timestamptz;
      return;
    end;
    return query select 'created'::text, v_expires;
  end
  $$;

revoke all on function public.display_pairing_start(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.display_pairing_start(text, text, text, text) to service_role;

-- Where a tablet's request stands: 'pending' (with its expiry), 'approved' (claimable now),
-- 'expired' (code or claim window over, cancelled, or the display already gone) or 'unknown'
-- (no such request, or already claimed).
create function public.display_pairing_status(p_secret_hash text)
returns table (status text, expires_at timestamptz)
  language sql stable security definer set search_path = '' as $$
    select coalesce(
             (select case
                when r.status = 'pending' and r.expires_at > pg_catalog.now() then 'pending'
                when r.status = 'approved'
                     and r.approved_at > pg_catalog.now() - (select l.claim_window
                                                             from private.display_limits() l)
                     and d.revoked_at is null and d.user_id is not null
                     and private.home_is_open(d.home_id) then 'approved'
                when r.status = 'claimed' then 'unknown'
                else 'expired'
              end
              from private.display_pairing_requests r
              left join private.household_displays d on d.id = r.display_id
              where r.secret_hash = coalesce(p_secret_hash, '')),
             'unknown'),
           (select r.expires_at from private.display_pairing_requests r
            where r.secret_hash = coalesce(p_secret_hash, '') and r.status = 'pending')
  $$;

revoke all on function public.display_pairing_status(text) from public, anon, authenticated;
grant execute on function public.display_pairing_status(text) to service_role;

-- The tablet asks for a new code: its pending request is cancelled. Returns whether one was.
create function public.display_pairing_cancel(p_secret_hash text) returns boolean
  language sql security definer set search_path = '' as $$
    with cancelled as (
      update private.display_pairing_requests r set status = 'cancelled'
        where r.secret_hash = coalesce(p_secret_hash, '') and r.status = 'pending'
        returning r.id
    )
    select exists (select 1 from cancelled)
  $$;

revoke all on function public.display_pairing_cancel(text) from public, anon, authenticated;
grant execute on function public.display_pairing_cancel(text) to service_role;

-- The approved request behind a tablet's secret, locked, when it can still be claimed.
create function private.claimable_pairing(p_secret_hash text)
returns private.display_pairing_requests
  language sql security definer set search_path = '' as $$
    select r.* from private.display_pairing_requests r
    join private.household_displays d on d.id = r.display_id
    where r.secret_hash = coalesce(p_secret_hash, '') and r.status = 'approved'
      and r.approved_at > pg_catalog.now() - (select l.claim_window from private.display_limits() l)
      and d.revoked_at is null and d.user_id is not null and private.home_is_open(d.home_id)
    for update of r
  $$;

revoke all on function private.claimable_pairing(text) from public;

-- Step 1 of claiming: when the tablet's request was approved and can still be claimed, the display
-- account's internal alias, for issuing its session. Returns 'ready' or 'invalid'. Does not change
-- anything, so an interrupted claim can be retried within the claim window.
create function public.display_pairing_claim(p_secret_hash text)
returns table (outcome text, alias_email text)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_r private.display_pairing_requests := private.claimable_pairing(p_secret_hash);
    v_user uuid;
  begin
    if v_r.id is null then
      return query select 'invalid'::text, null::text;
      return;
    end if;
    select d.user_id into v_user from private.household_displays d where d.id = v_r.display_id;
    return query select 'ready'::text, private.display_alias_email(v_user);
  end
  $$;

revoke all on function public.display_pairing_claim(text) from public, anon, authenticated;
grant execute on function public.display_pairing_claim(text) to service_role;

-- Step 2: registers the Supabase Auth session just issued for the display, which is what makes its
-- token usable. Once only: the request is then 'claimed' and its secret is worthless. Returns
-- 'registered' or 'invalid'.
create function public.display_pairing_complete(p_secret_hash text, p_session_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_r private.display_pairing_requests := private.claimable_pairing(p_secret_hash);
    v_display private.household_displays;
  begin
    if v_r.id is null then
      return 'invalid';
    end if;
    select * into v_display from private.household_displays d where d.id = v_r.display_id;
    if p_session_id is null
       or not exists (
         select 1 from auth.sessions s
         where s.id = p_session_id and s.user_id = v_display.user_id
           and s.created_at > v_r.approved_at - interval '1 minute'
       )
       or exists (select 1 from private.display_sessions ds where ds.session_id = p_session_id) then
      return 'invalid';
    end if;
    update private.display_pairing_requests r
      set status = 'claimed', claimed_at = pg_catalog.now()
      where r.id = v_r.id;
    insert into private.display_sessions (session_id, display_id) values (p_session_id, v_display.id);
    update private.household_displays d set last_seen_at = pg_catalog.now() where d.id = v_display.id;
    perform private.audit('display.signed_in', v_display.home_id, 'household_display',
      v_display.id, '{}'::jsonb);
    return 'registered';
  end
  $$;

revoke all on function public.display_pairing_complete(text, uuid) from public, anon, authenticated;
grant execute on function public.display_pairing_complete(text, uuid) to service_role;

-- 4. Home managers ---------------------------------------------------------------------------------------

-- The caller's manager standing in a Home: 'ok', 'not_found' (not a member, or closed) or
-- 'not_permitted' (not the Owner or an Administrator granted manageHomeSettings).
create function private.display_manager_check(p_home_id uuid, p_user_id uuid, p_lock boolean)
returns text
  language plpgsql security definer set search_path = '' as $$
  begin
    if p_home_id is null then
      return 'not_found';
    end if;
    if p_lock and not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, p_user_id) is null then
      return 'not_found';
    end if;
    if not private.has_home_capability(p_home_id, p_user_id, 'manageHomeSettings') then
      return 'not_permitted';
    end if;
    return 'ok';
  end
  $$;

revoke all on function private.display_manager_check(uuid, uuid, boolean) from public;

-- Serializes one manager's code attempts and says whether they used up their wrong tries.
create function private.display_manager_throttled(p_user_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_limits record := private.display_limits();
  begin
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('display_pairing_manager:' || p_user_id::text, 0));
    delete from private.display_pairing_failures f
      where f.user_id = p_user_id and f.created_at < pg_catalog.now() - interval '1 day';
    return (select count(*) from private.display_pairing_failures f
            where f.user_id = p_user_id
              and f.created_at > pg_catalog.now() - v_limits.manager_window)
           >= v_limits.failures_per_manager;
  end
  $$;

revoke all on function private.display_manager_throttled(uuid) from public;

-- Records a manager's failed code and audits it in the Home (reason only, never the code).
create function private.display_pairing_failed(p_home_id uuid, p_user_id uuid, p_reason text)
returns void
  language sql security definer set search_path = '' as $$
    insert into private.display_pairing_failures (user_id) values (p_user_id);
    select private.audit('display.pairing_failed', p_home_id, 'home', p_home_id,
      pg_catalog.jsonb_build_object('reason', p_reason));
  $$;

revoke all on function private.display_pairing_failed(uuid, uuid, text) from public;

-- Step 1 for a manager: looks a code up so they can review the tablet before approving. Changes
-- nothing but the wrong-try count. Outcomes: 'found' (with the request and its device labels),
-- 'invalid_code', 'expired', 'already_used', 'rate_limited', 'not_permitted', 'not_found'.
create function public.check_display_pairing_code(p_home_id uuid, p_code_hash text)
returns table (
  outcome text,
  request_id uuid,
  device_kind text,
  browser text,
  platform text,
  requested_at timestamptz,
  expires_at timestamptz
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
    v_r private.display_pairing_requests;
  begin
    if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid code' using errcode = '22023';
    end if;
    v_check := private.display_manager_check(p_home_id, v_user_id, false);
    if v_check <> 'ok' then
      return query select v_check, null::uuid, null::text, null::text, null::text,
                          null::timestamptz, null::timestamptz;
      return;
    end if;
    if private.display_manager_throttled(v_user_id) then
      return query select 'rate_limited'::text, null::uuid, null::text, null::text, null::text,
                          null::timestamptz, null::timestamptz;
      return;
    end if;
    select * into v_r from private.display_pairing_requests r
      where r.code_hash = p_code_hash and r.status <> 'cancelled'
      order by (r.status = 'pending') desc, r.created_at desc
      limit 1;
    if v_r.id is null then
      perform private.display_pairing_failed(p_home_id, v_user_id, 'invalid_code');
      return query select 'invalid_code'::text, null::uuid, null::text, null::text, null::text,
                          null::timestamptz, null::timestamptz;
      return;
    end if;
    if v_r.status <> 'pending' then
      perform private.display_pairing_failed(p_home_id, v_user_id, 'already_used');
      return query select 'already_used'::text, null::uuid, null::text, null::text, null::text,
                          null::timestamptz, null::timestamptz;
      return;
    end if;
    if v_r.expires_at <= pg_catalog.now() then
      perform private.display_pairing_failed(p_home_id, v_user_id, 'expired');
      return query select 'expired'::text, null::uuid, null::text, null::text, null::text,
                          null::timestamptz, null::timestamptz;
      return;
    end if;
    return query select 'found'::text, v_r.id, v_r.device_kind, v_r.browser, v_r.platform,
                        v_r.created_at, v_r.expires_at;
  end
  $$;

revoke all on function public.check_display_pairing_code(uuid, text) from public, anon;
grant execute on function public.check_display_pairing_code(uuid, text) to authenticated;

-- Step 2: approves the reviewed request into this Home under the chosen name. The request row is
-- locked, so of two managers approving the same code only the first succeeds; the code must still
-- match the reviewed request (a tablet that asked for a new code meanwhile is not paired), and the
-- request must still be pending and unexpired. Creates the display's own Supabase Auth user (no
-- password, internal alias) and its device record. The same manager retrying the same approval
-- for the same Home (an interrupted response) gets the same display back.
-- Outcomes: 'approved' (with the display id), 'invalid_code', 'expired', 'already_used',
-- 'limit_reached', 'rate_limited', 'not_permitted', 'not_found'.
create function public.approve_display_pairing(
  p_home_id uuid, p_request_id uuid, p_code_hash text, p_name text
) returns table (outcome text, display_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_limits record := private.display_limits();
    v_check text;
    v_r private.display_pairing_requests;
    v_display uuid;
    v_account uuid := gen_random_uuid();
  begin
    if p_name is null or not private.is_visible_name(p_name, 40) then
      raise exception 'invalid display name' using errcode = '22023';
    end if;
    if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid code' using errcode = '22023';
    end if;
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return query select v_check, null::uuid;
      return;
    end if;
    if private.display_manager_throttled(v_user_id) then
      return query select 'rate_limited'::text, null::uuid;
      return;
    end if;
    select * into v_r from private.display_pairing_requests r
      where r.id = p_request_id for update;
    if v_r.id is null or v_r.code_hash <> p_code_hash then
      perform private.display_pairing_failed(p_home_id, v_user_id, 'invalid_code');
      return query select 'invalid_code'::text, null::uuid;
      return;
    end if;
    if v_r.status in ('approved', 'claimed') then
      if v_r.approved_by = v_user_id and v_r.home_id = p_home_id and v_r.status = 'approved' then
        return query select 'approved'::text, v_r.display_id;
        return;
      end if;
      perform private.display_pairing_failed(p_home_id, v_user_id, 'already_used');
      return query select 'already_used'::text, null::uuid;
      return;
    end if;
    if v_r.status = 'cancelled' or v_r.expires_at <= pg_catalog.now() then
      perform private.display_pairing_failed(p_home_id, v_user_id, 'expired');
      return query select 'expired'::text, null::uuid;
      return;
    end if;
    if (select count(*) from private.household_displays d
        where d.home_id = p_home_id and d.revoked_at is null and d.user_id is not null)
       >= v_limits.displays_per_home then
      return query select 'limit_reached'::text, null::uuid;
      return;
    end if;

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', v_account, 'authenticated', 'authenticated',
      private.display_alias_email(v_account), '', pg_catalog.now(), '', '', '', '',
      '{"provider": "madeora_display", "providers": [], "madeora_kind": "display"}'::jsonb,
      '{}'::jsonb, pg_catalog.now(), pg_catalog.now()
    );
    insert into private.household_displays
        (home_id, user_id, name, device_kind, browser, platform, paired_by)
      values (p_home_id, v_account, p_name, v_r.device_kind, v_r.browser, v_r.platform, v_user_id)
      returning id into v_display;
    update private.display_pairing_requests r
      set status = 'approved', home_id = p_home_id, display_id = v_display,
          approved_by = v_user_id, approved_at = pg_catalog.now()
      where r.id = v_r.id;
    perform private.audit('display.paired', p_home_id, 'household_display', v_display,
      pg_catalog.jsonb_build_object('name', p_name));
    return query select 'approved'::text, v_display;
  end
  $$;

revoke all on function public.approve_display_pairing(uuid, uuid, text, text) from public, anon;
grant execute on function public.approve_display_pairing(uuid, uuid, text, text) to authenticated;

-- Renames an active display (same managers). Returns 'saved', 'unchanged', 'not_permitted' or
-- 'not_found'.
create function public.rename_household_display(p_home_id uuid, p_display_id uuid, p_name text)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
    v_old text;
  begin
    if p_name is null or not private.is_visible_name(p_name, 40) then
      raise exception 'invalid display name' using errcode = '22023';
    end if;
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return v_check;
    end if;
    select d.name into v_old from private.household_displays d
      where d.id = p_display_id and d.home_id = p_home_id and d.revoked_at is null
      for update;
    if not found then
      return 'not_found';
    end if;
    if v_old = p_name then
      return 'unchanged';
    end if;
    update private.household_displays d set name = p_name where d.id = p_display_id;
    perform private.audit('display.renamed', p_home_id, 'household_display', p_display_id,
      pg_catalog.jsonb_build_object('from', v_old, 'to', p_name));
    return 'saved';
  end
  $$;

revoke all on function public.rename_household_display(uuid, uuid, text) from public, anon;
grant execute on function public.rename_household_display(uuid, uuid, text) to authenticated;

-- Revokes a display (same managers), at once: its sessions end and its Supabase Auth user is
-- deleted with every refresh token, so neither a stale session nor an offline device can use it
-- again. Returns 'revoked', 'unchanged', 'not_permitted' or 'not_found'.
create function public.revoke_household_display(p_home_id uuid, p_display_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_check text;
    v_display private.household_displays;
  begin
    v_check := private.display_manager_check(p_home_id, v_user_id, true);
    if v_check <> 'ok' then
      return v_check;
    end if;
    select * into v_display from private.household_displays d
      where d.id = p_display_id and d.home_id = p_home_id for update;
    if not found then
      return 'not_found';
    end if;
    if v_display.revoked_at is not null then
      return 'unchanged';
    end if;
    update private.household_displays d
      set revoked_at = pg_catalog.now(), revoked_by = v_user_id, user_id = null
      where d.id = p_display_id;
    update private.display_sessions ds
      set ended_at = pg_catalog.now(), end_reason = 'revoked'
      where ds.display_id = p_display_id and ds.ended_at is null;
    if v_display.user_id is not null then
      delete from auth.users u where u.id = v_display.user_id;
    end if;
    perform private.audit('display.revoked', p_home_id, 'household_display', p_display_id,
      '{}'::jsonb);
    return 'revoked';
  end
  $$;

revoke all on function public.revoke_household_display(uuid, uuid) from public, anon;
grant execute on function public.revoke_household_display(uuid, uuid) to authenticated;

-- The Home's displays for the same managers: active ones and those revoked in the last 30 days.
create function public.home_household_displays(p_home_id uuid)
returns table (
  display_id uuid,
  name text,
  status text,
  device_kind text,
  browser text,
  platform text,
  paired_by_membership_id uuid,
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if private.display_manager_check(p_home_id, v_user_id, false) <> 'ok' then
      raise exception 'not a manager of this Home' using errcode = '42501';
    end if;
    return query
      select d.id, d.name,
             case when d.revoked_at is null and d.user_id is not null then 'active'
                  else 'revoked' end,
             d.device_kind, d.browser, d.platform,
             (select m.id from public.home_memberships m
                where m.home_id = d.home_id and m.user_id = d.paired_by),
             d.paired_at, d.last_seen_at, d.revoked_at
      from private.household_displays d
      where d.home_id = p_home_id
        and (d.revoked_at is null
             or d.revoked_at > pg_catalog.now() - (select l.revoked_listed
                                                   from private.display_limits() l))
      order by (d.revoked_at is null) desc, d.paired_at, d.id;
  end
  $$;

revoke all on function public.home_household_displays(uuid) from public, anon;
grant execute on function public.home_household_displays(uuid) to authenticated;

-- 5. The display's own session -----------------------------------------------------------------------------

-- The signed-in display: its name and its Home's name and timezone. Notes that the display was
-- seen (at most once a minute). Refused for anyone but a display in a usable display session.
create function public.display_me()
returns table (
  display_id uuid,
  display_name text,
  home_id uuid,
  home_name text,
  home_timezone text
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
  begin
    if v_user_id is null or v_session_id is null or not private.is_display(v_user_id)
       or not private.display_session_ok(v_user_id, v_session_id) then
      raise exception 'not a display session' using errcode = '42501';
    end if;
    update private.household_displays d set last_seen_at = pg_catalog.now()
      where d.user_id = v_user_id
        and (d.last_seen_at is null
             or d.last_seen_at < pg_catalog.now() - (select l.seen_interval
                                                     from private.display_limits() l));
    return query
      select d.id, d.name, h.id, h.name, h.timezone
      from private.household_displays d
      join public.homes h on h.id = d.home_id
      where d.user_id = v_user_id;
  end
  $$;

revoke all on function public.display_me() from public, anon;
grant execute on function public.display_me() to authenticated;
