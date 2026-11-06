-- S37: adult account security (brief S37; spec "Confirmed adult device and session management",
-- "Confirmed optional adult two-factor authentication", "Confirmed routine adult password changes
-- and session revocation", "Confirmed secure self-service primary account email changes";
-- architecture.md §7).
--
-- Supabase Auth runs two-factor sign-in (TOTP), password and email changes and sessions. It lets
-- any signed-in browser call those endpoints with its own session; the spec requires recent
-- reauthentication first. As in S08 (20261015090000_sign_in_methods.sql), the database enforces
-- it on the tables Supabase Auth writes:
--
-- * public.authorize_account_change(action) gives a one-time permission after a password sign-in
--   from the last 5 minutes on a live session, and, when the account has two-factor sign-in, a
--   TOTP verification on that session from the last 5 minutes (aal2). S08's
--   authorize_sign_in_method_change gets the same second-factor requirement.
-- * Triggers need that permission for: a password change of a confirmed account (a password-reset
--   sign-in also counts), starting an email change, adding a TOTP authenticator, removing a
--   verified one.
-- * Per account: at most 10 TOTP challenges in 15 minutes, and no second successful verification of
--   one authenticator within 90 seconds (a code seen once cannot be replayed in its window).
-- * Two-factor recovery codes: 10 single-use codes, stored only as SHA-256 verifiers; redeeming one
--   (lost authenticator) removes the authenticator, signs out the other sessions and sends a notice.
-- * Own sessions: list, sign out one, report one as suspicious, sign out everywhere.
-- * public.check_request(), PostgREST's pre-request function: every signed-in API request needs a
--   session that still exists and, for an account with two-factor sign-in, an aal2 session. The
--   Realtime signal tables get the same check as a restrictive policy.
-- * private.account_security_events records each change (no secrets, codes, addresses or IPs).
--
-- Everything lives in schema private (no API access) except the functions the browser calls.

-- Audit -------------------------------------------------------------------------------------------

create table private.account_security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null constraint account_security_events_kind_check check (kind in (
    'reauthenticated',
    'password_changed',
    'email_change_requested',
    'email_change_cancelled',
    'email_changed',
    'two_factor_enrolled',
    'two_factor_disabled',
    'recovery_codes_created',
    'recovery_code_used',
    'recovery_code_failed',
    'session_revoked',
    'session_reported',
    'signed_out_everywhere',
    'device_trusted',
    'device_trust_revoked',
    'backup_email_requested',
    'backup_email_changed',
    'backup_email_removed',
    'account_recovery_codes_created',
    'account_recovery_requested',
    'account_recovery_code_failed',
    'account_recovery_started',
    'account_recovery_cancelled',
    'account_recovered'
  )),
  -- The session the change came from, or the one it was about; never a token.
  session_id uuid,
  created_at timestamptz not null default now()
);

create index account_security_events_user_idx
  on private.account_security_events (user_id, created_at desc);

comment on table private.account_security_events is
  'S37: privacy-minimised account security history (kind, time, session id). S38 shows it.';

revoke all on table private.account_security_events from public;

create function private.record_security_event(p_user_id uuid, p_kind text, p_session_id uuid)
returns void
  language sql security definer set search_path = '' as $$
    insert into private.account_security_events (user_id, kind, session_id)
      values (p_user_id, p_kind, p_session_id)
  $$;

-- The session id in the caller's access token, or null.
create function private.jwt_session_id() returns uuid
  language plpgsql stable set search_path = '' as $$
  begin
    return (auth.jwt() ->> 'session_id')::uuid;
  exception when invalid_text_representation then
    return null;
  end
  $$;

-- Whether the account has a verified authenticator (two-factor sign-in is on).
create function private.has_two_factor(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1 from auth.mfa_factors f
      where f.user_id = p_user_id and f.status = 'verified'
    )
  $$;

-- True when session p_session_id of p_user_id still exists and has not expired.
create function private.session_is_live(p_user_id uuid, p_session_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1 from auth.sessions s
      where s.id = p_session_id
        and s.user_id = p_user_id
        and (s.not_after is null or s.not_after > pg_catalog.now())
    )
  $$;

-- Permissions -------------------------------------------------------------------------------------

create table private.account_change_grants (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null constraint account_change_grants_action_check check (action in (
    'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
    'backup_email', 'account_recovery_codes'
  )),
  -- The browser session that asked for it (not the short-lived reauthentication session). A
  -- password change must leave exactly this session signed in (checked at commit, below).
  session_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, action)
);

comment on table private.account_change_grants is
  'S37: one-time permissions for sensitive account changes after recent reauthentication.';

revoke all on table private.account_change_grants from public;

-- An account-change permission is meant for the request that follows at once in the same page.
create function private.account_change_grant_lifetime() returns interval
  language sql immutable set search_path = '' as $$ select interval '2 minutes' $$;

-- Uses up the matching permission, if one is still valid; an expired one is removed too. When the
-- change is made through Madeora's own API, the caller's session must be the one it was given to.
-- (Supabase Auth's own writes carry no session, so for those it cannot be checked.)
create function private.consume_account_change_grant(
  p_user_id uuid, p_action text, p_session_id uuid default null
)
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_found boolean;
  begin
    delete from private.account_change_grants g
      where g.user_id = p_user_id and g.action = p_action and g.expires_at > pg_catalog.now()
        and (p_session_id is null or g.session_id = p_session_id)
      returning true into v_found;
    delete from private.account_change_grants g
      where g.user_id = p_user_id and g.action = p_action and g.expires_at <= pg_catalog.now();
    return coalesce(v_found, false);
  end
  $$;

-- Whether p_user_id has just reauthenticated. The first factor is a fresh sign-in in a separate
-- session p_session_id (a password, or Google: amr "oauth") within the S08 window. When the
-- account has two-factor sign-in, a TOTP verification within that window is needed too, on that
-- session or on the browser's own session p_main_session_id (the app verifies the code there, so
-- that Supabase Auth also accepts the change from that aal2 session).
create function private.is_recent_reauthentication(
  p_user_id uuid, p_session_id uuid, p_main_session_id uuid default null
)
returns boolean
  language sql stable security definer set search_path = '' as $$
    select p_session_id is not null
      and exists (
        select 1
        from auth.sessions s
        join auth.mfa_amr_claims c on c.session_id = s.id
        where s.id = p_session_id
          and s.user_id = p_user_id
          and (s.not_after is null or s.not_after > pg_catalog.now())
          and c.authentication_method in ('password', 'oauth')
          and c.updated_at > pg_catalog.now() - private.sign_in_method_reauth_window()
      )
      and (
        not private.has_two_factor(p_user_id)
        or exists (
          select 1
          from auth.sessions s
          join auth.mfa_amr_claims c on c.session_id = s.id
          where s.id in (p_session_id, p_main_session_id)
            and s.user_id = p_user_id
            and s.aal = 'aal2'
            and c.authentication_method = 'totp'
            and c.updated_at > pg_catalog.now() - private.sign_in_method_reauth_window()
        )
      )
  $$;

-- Called by the browser with the session of the password (and TOTP) sign-in it has just made in a
-- memory-only client, naming its own (main) session in p_session_id: the permission is bound to
-- that session. Returns when the permission expires.
create function public.authorize_account_change(p_action text, p_session_id uuid)
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
      'backup_email', 'account_recovery_codes'
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
    -- Turning two-factor sign-in on twice, or off when it is off, is a mistake, not a permission.
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

comment on function public.authorize_account_change(text, uuid) is
  'S37: one-time permission for a sensitive account change after a fresh password (and TOTP) sign-in.';

revoke all on function public.authorize_account_change(text, uuid) from public, anon;
grant execute on function public.authorize_account_change(text, uuid) to authenticated;

-- S08's permission for linking and unlinking Google now needs the second factor too (ADR 0010),
-- which the app verifies on the browser's own session p_main_session_id.
drop function public.authorize_sign_in_method_change(text, text);
create function public.authorize_sign_in_method_change(
  p_action text, p_provider text, p_main_session_id uuid default null
)
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
    if p_action is null or p_action not in ('link', 'unlink') then
      raise exception 'unknown action' using errcode = '22023';
    end if;
    if p_provider is null or p_provider not in ('google') then
      raise exception 'unknown provider' using errcode = '22023';
    end if;
    if not private.is_recent_reauthentication(v_user_id, v_session_id, p_main_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    perform private.lock_sign_in_methods(v_user_id);

    v_expires_at := pg_catalog.now() + private.sign_in_method_grant_lifetime();
    insert into private.sign_in_method_grants (user_id, action, provider, expires_at)
      values (v_user_id, p_action, p_provider, v_expires_at)
      on conflict (user_id, action) do update
        set provider = excluded.provider,
            expires_at = excluded.expires_at,
            created_at = pg_catalog.now();
    return v_expires_at;
  end
  $$;

comment on function public.authorize_sign_in_method_change(text, text, uuid) is
  'S08/S37: one-time permission to link or unlink a sign-in method after recent reauthentication.';

revoke all on function public.authorize_sign_in_method_change(text, text, uuid) from public, anon;
grant execute on function public.authorize_sign_in_method_change(text, text, uuid) to authenticated;

-- Password and email guards on auth.users --------------------------------------------------------

-- Supabase Auth rewrites a stored password hash at sign-in (not a password change) when it is not
-- a standard bcrypt hash at its default cost of 10: imported Argon2/scrypt hashes, or bcrypt at
-- another cost. Such a rewrite must not be refused. An attacker cannot choose the stored format.
create function private.is_upgradable_password_hash(p_hash text) returns boolean
  language sql immutable set search_path = '' as $$
    select coalesce(p_hash, '') <> '' and p_hash !~ '^\$2[abxy]?\$10\$'
  $$;

create function private.guard_account_credentials() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_keep uuid;
  begin
    -- Supabase Auth's own sign-up and clean-up of accounts that never confirmed their email.
    if old.email_confirmed_at is null then
      return new;
    end if;

    if new.encrypted_password is distinct from old.encrypted_password
       and coalesce(new.encrypted_password, '') <> '' then
      perform private.lock_sign_in_methods(new.id);
      if private.is_upgradable_password_hash(old.encrypted_password) then
        null;
      else
        delete from private.account_change_grants g
          where g.user_id = new.id and g.action = 'password' and g.expires_at > pg_catalog.now()
          returning g.session_id into v_keep;
        delete from private.account_change_grants g
          where g.user_id = new.id and g.action = 'password' and g.expires_at <= pg_catalog.now();
      end if;
      if private.is_upgradable_password_hash(old.encrypted_password) then
        null;
      elsif v_keep is not null then
        -- Checked at commit: Supabase Auth signs out every session but the one that made the
        -- change, so only the session the permission was given to may be left.
        perform pg_catalog.set_config('madeora.password_change_keeps', v_keep::text, true);
        perform private.record_security_event(new.id, 'password_changed', null);
      -- A password-reset link (S06) opens a session whose sign-in method is the emailed one-time
      -- link ("otp"; Madeora offers no other one-time sign-in); the reset form then sets the new
      -- password and signs out everywhere. Only the mailbox owner can open one. Checked at commit
      -- too: the session left signed in must be such a reset session, never another one.
      elsif exists (
        select 1
        from auth.sessions s
        join auth.mfa_amr_claims c on c.session_id = s.id
        where s.user_id = new.id
          and c.authentication_method = 'otp'
          and c.updated_at > pg_catalog.now() - interval '1 hour'
      ) then
        perform pg_catalog.set_config('madeora.password_change_keeps', 'reset', true);
        perform private.record_security_event(new.id, 'password_changed', null);
      else
        raise exception 'password change not authorized'
          using errcode = '42501',
                hint = 'Madeora changes a password only after the account holder reauthenticates (S37).';
      end if;
    end if;

    -- Starting (or replacing) a pending email change. Completing one (Supabase Auth moves
    -- email_change into email) and clearing one are allowed.
    if coalesce(new.email_change, '') <> ''
       and new.email_change is distinct from old.email_change then
      perform private.lock_sign_in_methods(new.id);
      if not private.consume_account_change_grant(new.id, 'email') then
        raise exception 'email change not authorized'
          using errcode = '42501',
                hint = 'Madeora changes an email address only after the account holder reauthenticates (S37).';
      end if;
      perform private.record_security_event(new.id, 'email_change_requested', null);
    end if;

    if new.email is distinct from old.email and old.email is not null and new.email is not null
       and new.email_confirmed_at is not null then
      perform private.record_security_event(new.id, 'email_changed', null);
    end if;
    return new;
  end
  $$;

create trigger madeora_guard_account_credentials
  before update on auth.users
  for each row execute function private.guard_account_credentials();

-- At commit of a password change: Supabase Auth has by then signed out every session of the
-- account except the one that sent the change. If that was not the session the permission was
-- bound to (say, a stolen session racing the owner's reauthentication), or, for a reset, not the
-- reset session, the whole change is refused.
create function private.check_password_change_sessions() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_keeps text := pg_catalog.current_setting('madeora.password_change_keeps', true);
  begin
    if coalesce(v_keeps, '') = '' then
      return null;
    end if;
    perform pg_catalog.set_config('madeora.password_change_keeps', '', true);
    if v_keeps = 'reset' then
      if exists (
        select 1 from auth.sessions s
        where s.user_id = new.id
          and not exists (
            select 1 from auth.mfa_amr_claims c
            where c.session_id = s.id and c.authentication_method = 'otp'
              and c.updated_at > pg_catalog.now() - interval '1 hour'
          )
      ) then
        raise exception 'password change not authorized'
          using errcode = '42501', hint = 'password_change_from_other_session';
      end if;
    elsif exists (
      select 1 from auth.sessions s where s.user_id = new.id and s.id <> v_keeps::uuid
    ) then
      raise exception 'password change not authorized'
        using errcode = '42501', hint = 'password_change_from_other_session';
    end if;
    return null;
  end
  $$;

create constraint trigger madeora_check_password_change_sessions
  after update of encrypted_password on auth.users
  deferrable initially deferred
  for each row execute function private.check_password_change_sessions();

-- Cancels the signed-in account's pending email change. The old address stays authoritative.
create function public.cancel_my_email_change() returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_found boolean;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update auth.users u
      set email_change = '',
          email_change_token_new = '',
          email_change_token_current = '',
          email_change_sent_at = null,
          email_change_confirm_status = 0
      where u.id = v_user_id and coalesce(u.email_change, '') <> ''
      returning true into v_found;
    if coalesce(v_found, false) then
      perform private.record_security_event(v_user_id, 'email_change_cancelled', private.jwt_session_id());
    end if;
    return coalesce(v_found, false);
  end
  $$;

revoke all on function public.cancel_my_email_change() from public, anon;
grant execute on function public.cancel_my_email_change() to authenticated;

-- Two-factor authenticators ------------------------------------------------------------------------

-- Two-factor recovery codes (separate from S37b's account recovery codes).
create table private.two_factor_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- SHA-256 of the normalised code (12 characters from a 32-letter alphabet, 60 bits).
  code_hash bytea not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  constraint two_factor_recovery_codes_hash_unique unique (user_id, code_hash)
);

comment on table private.two_factor_recovery_codes is
  'S37: single-use two-factor recovery codes; only verifiers are stored.';

revoke all on table private.two_factor_recovery_codes from public;

-- Failed redemptions, for the per-account limit.
create table private.two_factor_recovery_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index two_factor_recovery_attempts_user_idx
  on private.two_factor_recovery_attempts (user_id, attempted_at);

revoke all on table private.two_factor_recovery_attempts from public;

create function private.guard_mfa_factor_insert() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_session_id uuid;
  begin
    if new.factor_type::text <> 'totp' then
      raise exception 'only authenticator apps are offered' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(new.user_id);
    delete from private.account_change_grants g
      where g.user_id = new.user_id and g.action = 'two_factor_enroll'
        and g.expires_at > pg_catalog.now()
      returning g.session_id into v_session_id;
    delete from private.account_change_grants g
      where g.user_id = new.user_id and g.action = 'two_factor_enroll'
        and g.expires_at <= pg_catalog.now();
    if v_session_id is null then
      raise exception 'two-factor enrolment not authorized'
        using errcode = '42501',
              hint = 'Madeora adds an authenticator only after the account holder reauthenticates (S37).';
    end if;
    -- The same browser session may create the first recovery codes once the authenticator is
    -- verified (scanning the code takes a while, so this one lasts the longer S08 lifetime).
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (new.user_id, 'recovery_codes', v_session_id,
              pg_catalog.now() + private.sign_in_method_grant_lifetime())
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at,
            created_at = pg_catalog.now();
    return new;
  end
  $$;

create function private.guard_mfa_factor_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    -- The account itself is being deleted, or an unfinished setup is cleaned up.
    if not exists (select 1 from auth.users u where u.id = old.user_id)
       or old.status::text <> 'verified' then
      return old;
    end if;
    perform private.lock_sign_in_methods(old.user_id);
    if coalesce(pg_catalog.current_setting('madeora.recovery_code_redeemed', true), '')
         = old.user_id::text then
      return old;
    end if;
    if not private.consume_account_change_grant(old.user_id, 'two_factor_disable') then
      raise exception 'two-factor removal not authorized'
        using errcode = '42501',
              hint = 'Madeora removes an authenticator only after the account holder reauthenticates (S37).';
    end if;
    return old;
  end
  $$;

-- After the last verified authenticator is gone, its recovery codes mean nothing any more.
create function private.after_mfa_factor_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if old.status::text = 'verified' and exists (select 1 from auth.users u where u.id = old.user_id)
       and not private.has_two_factor(old.user_id) then
      delete from private.two_factor_recovery_codes c where c.user_id = old.user_id;
      perform private.record_security_event(old.user_id, 'two_factor_disabled', null);
    end if;
    return null;
  end
  $$;

create function private.after_mfa_factor_verified() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.status::text = 'verified' and old.status::text <> 'verified' then
      perform private.record_security_event(new.user_id, 'two_factor_enrolled', null);
    end if;
    return null;
  end
  $$;

create trigger madeora_guard_mfa_factor_insert
  before insert on auth.mfa_factors
  for each row execute function private.guard_mfa_factor_insert();

create trigger madeora_guard_mfa_factor_delete
  before delete on auth.mfa_factors
  for each row execute function private.guard_mfa_factor_delete();

create trigger madeora_after_mfa_factor_delete
  after delete on auth.mfa_factors
  for each row execute function private.after_mfa_factor_delete();

create trigger madeora_after_mfa_factor_verified
  after update of status on auth.mfa_factors
  for each row execute function private.after_mfa_factor_verified();

-- Per-account attempt limit: Supabase Auth limits verification per IP address only. The browser
-- asks for a new challenge for every code it tries (supabase-js challengeAndVerify).
create function private.guard_mfa_challenge_insert() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid;
  begin
    select f.user_id into v_user_id from auth.mfa_factors f where f.id = new.factor_id;
    if v_user_id is null then
      return new;
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if (
      select count(*) from auth.mfa_challenges c
      where c.factor_id = new.factor_id
        and c.created_at > pg_catalog.now() - interval '15 minutes'
    ) >= 10 then
      raise exception 'too many two-factor attempts'
        using errcode = '42501', hint = 'two_factor_rate_limited';
    end if;
    return new;
  end
  $$;

-- A code is valid for up to 90 seconds (30-second steps, one step of clock drift either way). A
-- second successful verification of the same authenticator inside that window could be the same
-- code seen by someone else, so it is refused; the person waits for the next code.
--
-- Supabase Auth lets one challenge be verified again and again until it expires, and records no
-- wrong code, so a challenge only counts towards the limit above when it is created. A challenge
-- may therefore only succeed within 30 seconds of its creation (Madeora's pages create and verify
-- in one step): guessing beyond that needs new challenges, which the limit above counts.
create function private.guard_mfa_challenge_verify() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.verified_at is not null and old.verified_at is null
       and old.created_at < pg_catalog.now() - interval '30 seconds' then
      raise exception 'two-factor challenge too old'
        using errcode = '42501', hint = 'two_factor_challenge_expired';
    end if;
    if new.verified_at is not null and old.verified_at is null and exists (
      select 1 from auth.mfa_challenges c
      where c.factor_id = new.factor_id
        and c.id <> new.id
        and c.verified_at > pg_catalog.now() - interval '90 seconds'
    ) then
      raise exception 'two-factor code already used'
        using errcode = '42501', hint = 'two_factor_code_reused';
    end if;
    return new;
  end
  $$;

create trigger madeora_guard_mfa_challenge_insert
  before insert on auth.mfa_challenges
  for each row execute function private.guard_mfa_challenge_insert();

create trigger madeora_guard_mfa_challenge_verify
  before update of verified_at on auth.mfa_challenges
  for each row execute function private.guard_mfa_challenge_verify();

-- Recovery codes ----------------------------------------------------------------------------------

-- Upper case, no spaces or dashes: what the person types is compared in this form.
create function private.normalise_recovery_code(p_code text) returns text
  language sql immutable set search_path = '' as $$
    select pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'))
  $$;

create function private.recovery_code_hash(p_code text) returns bytea
  language sql immutable set search_path = '' as $$
    select extensions.digest(private.normalise_recovery_code(p_code), 'sha256')
  $$;

-- One code: 12 characters from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ (no 0/O, 1/I), each from the low
-- five bits of a random byte (256 is a multiple of 32, so every letter is equally likely).
create function private.new_recovery_code() returns text
  language plpgsql volatile set search_path = '' as $$
  declare
    v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    v_bytes bytea := extensions.gen_random_bytes(12);
    v_code text := '';
  begin
    for i in 0..11 loop
      v_code := v_code || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) & 31) + 1, 1);
    end loop;
    return v_code;
  end
  $$;

-- Creates a new set of 10 codes and returns them, formatted XXXX-XXXX-XXXX, this once. Needs an
-- aal2 session and the `recovery_codes` permission: given automatically when an authenticator is
-- added, otherwise by reauthenticating. The previous set stops working in the same transaction.
create function public.create_two_factor_recovery_codes() returns setof text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_code text;
    v_regenerated boolean;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if not private.has_two_factor(v_user_id) or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
       or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'two-factor sign-in required' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.consume_account_change_grant(v_user_id, 'recovery_codes', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    select exists (select 1 from private.two_factor_recovery_codes c where c.user_id = v_user_id)
      into v_regenerated;
    delete from private.two_factor_recovery_codes c where c.user_id = v_user_id;
    for i in 1..10 loop
      loop
        v_code := private.new_recovery_code();
        begin
          insert into private.two_factor_recovery_codes (user_id, code_hash)
            values (v_user_id, private.recovery_code_hash(v_code));
          exit;
        exception when unique_violation then
          -- Astronomically unlikely; draw again.
        end;
      end loop;
      return next pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4)
        || '-' || pg_catalog.substr(v_code, 9, 4);
    end loop;

    perform private.record_security_event(v_user_id, 'recovery_codes_created', v_session_id);
    if v_regenerated then
      perform private.notify_user(
        v_user_id, null, 'security', 'account.recovery_codes_regenerated', '{}'::jsonb,
        'account.recovery_codes_regenerated:' || gen_random_uuid()::text, true);
    end if;
    return;
  end
  $$;

revoke all on function public.create_two_factor_recovery_codes() from public, anon;
grant execute on function public.create_two_factor_recovery_codes() to authenticated;

-- Signs in with a recovery code instead of the lost authenticator. Called by the half-signed-in
-- (aal1) session of the two-factor page. Outcomes: 'ok', 'invalid', 'rate_limited', 'not_needed'.
-- On 'ok': the code is used up, every authenticator and remaining code is removed, the account's
-- other sessions are signed out, a notice goes out, and the person is asked to set 2FA up again.
-- A failure is recorded and returned (not raised), so the attempt counts.
create function public.redeem_two_factor_recovery_code(p_code text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_code_id uuid;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.has_two_factor(v_user_id) then
      return 'not_needed';
    end if;
    if (
      select count(*) from private.two_factor_recovery_attempts a
      where a.user_id = v_user_id and a.attempted_at > pg_catalog.now() - interval '15 minutes'
    ) >= 5 then
      return 'rate_limited';
    end if;

    select c.id into v_code_id
      from private.two_factor_recovery_codes c
      where c.user_id = v_user_id
        and c.used_at is null
        and c.code_hash = private.recovery_code_hash(p_code)
        and pg_catalog.char_length(private.normalise_recovery_code(p_code)) = 12;
    if v_code_id is null then
      insert into private.two_factor_recovery_attempts (user_id) values (v_user_id);
      perform private.record_security_event(v_user_id, 'recovery_code_failed', v_session_id);
      return 'invalid';
    end if;

    update private.two_factor_recovery_codes c set used_at = pg_catalog.now() where c.id = v_code_id;
    perform pg_catalog.set_config('madeora.recovery_code_redeemed', v_user_id::text, true);
    delete from auth.mfa_factors f where f.user_id = v_user_id;
    perform pg_catalog.set_config('madeora.recovery_code_redeemed', '', true);
    delete from private.two_factor_recovery_codes c where c.user_id = v_user_id;
    delete from private.two_factor_recovery_attempts a where a.user_id = v_user_id;
    delete from auth.sessions s where s.user_id = v_user_id and s.id <> v_session_id;
    perform private.record_security_event(v_user_id, 'recovery_code_used', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.recovery_code_used', '{}'::jsonb,
      'account.recovery_code_used:' || v_code_id::text, true);
    return 'ok';
  end
  $$;

revoke all on function public.redeem_two_factor_recovery_code(text) from public, anon;
grant execute on function public.redeem_two_factor_recovery_code(text) to authenticated;

-- Sessions ----------------------------------------------------------------------------------------

-- The signed-in account's own sessions. No IP address; the user agent is shortened to a device
-- description by the app. Last activity is the last token refresh (approximate by nature).
create function public.list_my_sessions()
returns table (
  id uuid,
  created_at timestamptz,
  last_active_at timestamptz,
  user_agent text,
  two_factor boolean,
  is_current boolean
)
  language sql stable security definer set search_path = '' as $$
    select s.id,
           s.created_at,
           coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at),
           pg_catalog.left(s.user_agent, 512),
           s.aal::text = 'aal2',
           s.id = private.jwt_session_id()
    from auth.sessions s
    where s.user_id = auth.uid()
      and (s.not_after is null or s.not_after > pg_catalog.now())
    order by s.id = private.jwt_session_id() desc,
             coalesce(s.refreshed_at::timestamptz, s.updated_at, s.created_at) desc
  $$;

revoke all on function public.list_my_sessions() from public, anon;
grant execute on function public.list_my_sessions() to authenticated;

-- Signs out one of the account's own sessions (not the current one: that is the ordinary sign-out).
-- p_report marks it suspicious: recorded, and a notice goes out. Returns false when the session
-- no longer exists (expired or already signed out between the list and the click).
create function public.revoke_my_session(p_session_id uuid, p_report boolean default false)
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_current uuid := private.jwt_session_id();
    v_found boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_current) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_session_id is null or p_session_id = v_current then
      raise exception 'use sign out for this session' using errcode = '22023';
    end if;
    delete from auth.sessions s
      where s.id = p_session_id and s.user_id = v_user_id
      returning true into v_found;
    if not coalesce(v_found, false) then
      return false;
    end if;
    -- A session ended from elsewhere makes its device untrusted too (spec: trust is reassessed when
    -- a session is revoked); signing out on the device itself keeps its trust.
    update private.trusted_devices d set revoked_at = pg_catalog.now()
      where d.user_id = v_user_id and d.revoked_at is null
        and d.id in (select t.device_id from private.trusted_sessions t where t.session_id = p_session_id);
    if coalesce(p_report, false) then
      perform private.record_security_event(v_user_id, 'session_reported', p_session_id);
      perform private.notify_user(
        v_user_id, null, 'security', 'account.session_reported', '{}'::jsonb,
        'account.session_reported:' || p_session_id::text, true);
    else
      perform private.record_security_event(v_user_id, 'session_revoked', p_session_id);
    end if;
    return true;
  end
  $$;

revoke all on function public.revoke_my_session(uuid, boolean) from public, anon;
grant execute on function public.revoke_my_session(uuid, boolean) to authenticated;

-- Signs out every session of the account, this one included. The browser then clears its own
-- cookies and opens the sign-in page.
create function public.sign_out_everywhere() returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_current uuid := private.jwt_session_id();
    v_count integer;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_current) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    delete from auth.sessions s where s.user_id = v_user_id;
    get diagnostics v_count = row_count;
    perform private.record_security_event(v_user_id, 'signed_out_everywhere', v_current);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.signed_out_everywhere', '{}'::jsonb,
      'account.signed_out_everywhere:' || v_current::text, true);
    return v_count;
  end
  $$;

revoke all on function public.sign_out_everywhere() from public, anon;
grant execute on function public.sign_out_everywhere() to authenticated;

-- Trusted devices ---------------------------------------------------------------------------------

-- A browser the account holder chose to trust after passing two-factor sign-in on it (spec
-- "time-limited, risk-based trusted devices"). The browser keeps a random token in an httpOnly
-- cookie; only its SHA-256 is stored. Trust lasts 30 days, is never renewed, and only lets a new
-- sign-in on that browser skip the routine authenticator prompt: every sensitive change still needs
-- a fresh code. The device description is the app's coarse reading of the user agent (no
-- identifiers, no IP address).
create table private.trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash bytea not null constraint trusted_devices_token_key unique,
  kind text not null constraint trusted_devices_kind_check
    check (kind in ('phone', 'tablet', 'computer', 'unknown')),
  browser text not null constraint trusted_devices_browser_check
    check (browser in ('edge', 'chrome', 'firefox', 'safari', 'samsung', 'opera', 'other')),
  platform text not null constraint trusted_devices_platform_check
    check (platform in ('windows', 'macos', 'ios', 'ipados', 'android', 'linux', 'chromeos', 'other')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index trusted_devices_user_idx on private.trusted_devices (user_id) where revoked_at is null;

comment on table private.trusted_devices is
  'S37: time-limited trusted browsers (token hash only). Never exempts sensitive changes.';

-- Sessions that passed the second factor through a trusted device. No foreign key to
-- auth.sessions (Supabase Auth's table); a session that is gone is not live anyway.
create table private.trusted_sessions (
  session_id uuid primary key,
  device_id uuid not null references private.trusted_devices (id) on delete cascade,
  created_at timestamptz not null default now()
);

revoke all on table private.trusted_devices, private.trusted_sessions from public;

create function private.trusted_device_lifetime() returns interval
  language sql immutable set search_path = '' as $$ select interval '30 days' $$;

create function private.token_hash(p_token text) returns bytea
  language sql immutable set search_path = '' as $$
    select extensions.digest(coalesce(p_token, ''), 'sha256')
  $$;

-- Whether session p_session_id of p_user_id passed the second factor through a device that is
-- still trusted.
create function private.session_trusted(p_user_id uuid, p_session_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1
      from private.trusted_sessions t
      join private.trusted_devices d on d.id = t.device_id
      where t.session_id = p_session_id
        and d.user_id = p_user_id
        and d.revoked_at is null
        and d.expires_at > pg_catalog.now()
    )
  $$;

-- Ends every trust of the account (credential, recovery or 2FA changes; reported sessions).
create function private.revoke_all_trust(p_user_id uuid) returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    update private.trusted_devices d set revoked_at = pg_catalog.now()
      where d.user_id = p_user_id and d.revoked_at is null;
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;

-- Consequential account security events clear trust, wherever they come from.
create function private.clear_trust_on_security_event() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.revoke_all_trust(new.user_id);
    return null;
  end
  $$;

create trigger madeora_clear_trust_on_security_event
  after insert on private.account_security_events
  for each row
  when (new.kind in (
    'password_changed', 'email_changed', 'two_factor_enrolled', 'two_factor_disabled',
    'recovery_code_used', 'recovery_codes_created', 'session_reported', 'signed_out_everywhere',
    'backup_email_changed', 'backup_email_removed', 'account_recovery_codes_created',
    'account_recovery_started', 'account_recovered'
  ))
  execute function private.clear_trust_on_security_event();

-- Trusts this browser, from a session that has just passed the second factor (a TOTP
-- verification within the last 10 minutes). The app generates p_token, sets it in an httpOnly
-- cookie and never shows it. At most 10 trusted devices per account: the oldest give way.
create function public.trust_this_device(
  p_token text, p_kind text, p_browser text, p_platform text
) returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_expires_at timestamptz := pg_catalog.now() + private.trusted_device_lifetime();
    v_device_id uuid;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if not private.has_two_factor(v_user_id) or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
       or not exists (
         select 1 from auth.mfa_amr_claims c
         where c.session_id = v_session_id and c.authentication_method = 'totp'
           and c.updated_at > pg_catalog.now() - interval '10 minutes'
       ) then
      raise exception 'two-factor sign-in just now required' using errcode = '42501';
    end if;
    if p_token is null or pg_catalog.length(p_token) < 43 or pg_catalog.length(p_token) > 128 then
      raise exception 'invalid token' using errcode = '22023';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    insert into private.trusted_devices (user_id, token_hash, kind, browser, platform, expires_at)
      values (v_user_id, private.token_hash(p_token), p_kind, p_browser, p_platform, v_expires_at)
      returning id into v_device_id;
    insert into private.trusted_sessions (session_id, device_id) values (v_session_id, v_device_id)
      on conflict (session_id) do update set device_id = excluded.device_id;
    update private.trusted_devices d set revoked_at = pg_catalog.now()
      where d.user_id = v_user_id and d.revoked_at is null
        and d.id not in (
          select k.id from private.trusted_devices k
          where k.user_id = v_user_id and k.revoked_at is null and k.expires_at > pg_catalog.now()
          order by k.created_at desc, k.id desc limit 10
        );
    perform private.record_security_event(v_user_id, 'device_trusted', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.device_trusted',
      pg_catalog.jsonb_build_object('browser', p_browser, 'platform', p_platform),
      'account.device_trusted:' || v_device_id::text, true);
    return v_expires_at;
  end
  $$;

revoke all on function public.trust_this_device(text, text, text, text) from public, anon;
grant execute on function public.trust_this_device(text, text, text, text) to authenticated;

-- At sign-in on a trusted browser: the session (still aal1) counts as past the second factor when
-- the token matches a trusted device of this account that has not expired, and the browser and
-- platform are the ones recorded (a material change asks for the code again). False otherwise.
-- PostgREST's pre-request check lets an aal1 session make this one call.
create function public.use_trusted_device(p_token text, p_browser text, p_platform text)
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_device private.trusted_devices;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id)
       or not private.has_two_factor(v_user_id) then
      return false;
    end if;
    select * into v_device from private.trusted_devices d
      where d.token_hash = private.token_hash(p_token)
        and d.user_id = v_user_id
        and d.revoked_at is null
        and d.expires_at > pg_catalog.now();
    if v_device.id is null
       or v_device.browser is distinct from p_browser
       or v_device.platform is distinct from p_platform then
      return false;
    end if;
    insert into private.trusted_sessions (session_id, device_id) values (v_session_id, v_device.id)
      on conflict (session_id) do update set device_id = excluded.device_id;
    update private.trusted_devices d set last_used_at = pg_catalog.now() where d.id = v_device.id;
    return true;
  end
  $$;

revoke all on function public.use_trusted_device(text, text, text) from public, anon;
grant execute on function public.use_trusted_device(text, text, text) to authenticated;

-- Whether the caller's session passed the second factor through a trusted device (the server
-- asks this for an aal1 token of an account with two-factor sign-in).
create function public.session_is_trusted() returns boolean
  language sql stable security definer set search_path = '' as $$
    select coalesce(private.session_trusted(auth.uid(), private.jwt_session_id()), false)
  $$;

revoke all on function public.session_is_trusted() from public, anon;
grant execute on function public.session_is_trusted() to authenticated;

create function public.list_my_trusted_devices()
returns table (
  id uuid, kind text, browser text, platform text,
  created_at timestamptz, last_used_at timestamptz, expires_at timestamptz, is_current boolean
)
  language sql stable security definer set search_path = '' as $$
    select d.id, d.kind, d.browser, d.platform, d.created_at, d.last_used_at, d.expires_at,
           exists (select 1 from private.trusted_sessions t
                   where t.device_id = d.id and t.session_id = private.jwt_session_id())
    from private.trusted_devices d
    where d.user_id = auth.uid() and d.revoked_at is null and d.expires_at > pg_catalog.now()
    order by d.created_at desc, d.id
  $$;

revoke all on function public.list_my_trusted_devices() from public, anon;
grant execute on function public.list_my_trusted_devices() to authenticated;

-- Ending trust needs no reauthentication (it only takes something away). False when the device
-- was not (or no longer) trusted.
create function public.revoke_trusted_device(p_device_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_found boolean;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update private.trusted_devices d set revoked_at = pg_catalog.now()
      where d.id = p_device_id and d.user_id = v_user_id and d.revoked_at is null
      returning true into v_found;
    if coalesce(v_found, false) then
      perform private.record_security_event(v_user_id, 'device_trust_revoked', null);
    end if;
    return coalesce(v_found, false);
  end
  $$;

create function public.revoke_all_trusted_devices() returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_count integer;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    v_count := private.revoke_all_trust(v_user_id);
    if v_count > 0 then
      perform private.record_security_event(v_user_id, 'device_trust_revoked', null);
    end if;
    return v_count;
  end
  $$;

revoke all on function public.revoke_trusted_device(uuid) from public, anon;
grant execute on function public.revoke_trusted_device(uuid) to authenticated;
revoke all on function public.revoke_all_trusted_devices() from public, anon;
grant execute on function public.revoke_all_trusted_devices() to authenticated;

-- Security emails to addresses other than the primary one ----------------------------------------

-- Notices to the primary address go through private.notify_user. These go elsewhere: the link
-- that verifies a new backup address, and the recovery messages sent to the backup address. The
-- `security-email` job reads the row at send time, so the link's secret is never in a job payload;
-- once the email is sent (or given up) the secret is erased and only its hash, kept by the flow
-- that issued it, remains.
create table private.security_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null constraint security_emails_kind_check check (kind in (
    'backup_verify', 'recovery_link', 'recovery_started', 'recovery_ready'
  )),
  to_email text not null,
  token text,
  expires_at timestamptz,
  status text not null default 'queued'
    constraint security_emails_status_check check (status in ('queued', 'sent', 'failed', 'not_configured')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

revoke all on table private.security_emails from public;

create function private.queue_security_email(
  p_user_id uuid, p_kind text, p_to text, p_token text, p_expires_at timestamptz
) returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    insert into private.security_emails (user_id, kind, to_email, token, expires_at)
      values (p_user_id, p_kind, p_to, p_token, p_expires_at)
      returning id into v_id;
    perform private.enqueue_job(
      'security-email', 1, 'security-email:' || v_id::text,
      pg_catalog.jsonb_build_object('emailId', v_id));
    return v_id;
  end
  $$;

-- For the security-email job (service role): 'ok' with what to send, or 'skipped' when it was
-- already sent, its link expired or its flow moved on.
create function public.get_security_email(p_email_id uuid)
returns table (
  outcome text, kind text, recipient_email text, email_locale text, token text,
  expires_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_e private.security_emails;
    v_locale text;
  begin
    select * into v_e from private.security_emails e where e.id = p_email_id;
    if v_e.id is null or v_e.status <> 'queued'
       or (v_e.expires_at is not null and v_e.expires_at <= pg_catalog.now())
       or (v_e.kind in ('backup_verify', 'recovery_link', 'recovery_ready') and v_e.token is null) then
      return query select 'skipped'::text, null::text, null::text, null::text, null::text, null::timestamptz;
      return;
    end if;
    select p.locale into v_locale from public.user_preferences p where p.user_id = v_e.user_id;
    return query select 'ok'::text, v_e.kind, v_e.to_email, coalesce(v_locale, 'en'), v_e.token,
                        v_e.expires_at;
  end
  $$;

create function public.record_security_email(p_email_id uuid, p_status text) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_found boolean;
  begin
    if p_status not in ('sent', 'failed', 'not_configured') then
      raise exception 'unknown status' using errcode = '22023';
    end if;
    update private.security_emails e
      set status = p_status, token = null,
          sent_at = case when p_status = 'sent' then pg_catalog.now() end
      where e.id = p_email_id and e.status = 'queued'
      returning true into v_found;
    return coalesce(v_found, false);
  end
  $$;

revoke all on function public.get_security_email(uuid) from public, anon, authenticated;
revoke all on function public.record_security_email(uuid, text) from public, anon, authenticated;
grant execute on function public.get_security_email(uuid) to service_role;
grant execute on function public.record_security_email(uuid, text) to service_role;

-- Backup email ------------------------------------------------------------------------------------

-- One optional verified backup address per account (spec "optional backup account recovery
-- methods"), only ever used for account recovery. It must differ from the primary address, and an
-- address can be the verified backup of one account only. A change keeps the verified address
-- until the new one is confirmed through a single-use link (1 hour).
create table private.backup_emails (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  verified_at timestamptz,
  pending_email text,
  pending_token_hash bytea,
  pending_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint backup_emails_verified check ((email is null) = (verified_at is null)),
  constraint backup_emails_pending check (
    (pending_email is null) = (pending_token_hash is null)
    and (pending_email is null) = (pending_expires_at is null)
  )
);

create unique index backup_emails_email_key on private.backup_emails (email) where email is not null;

create table private.backup_email_sends (
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now()
);

create index backup_email_sends_idx on private.backup_email_sends (user_id, sent_at);

revoke all on table private.backup_emails, private.backup_email_sends from public;

create function private.normalise_email(p_email text) returns text
  language sql immutable set search_path = '' as $$
    select pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')))
  $$;

-- A masked address for display: the first character of the local part, then the domain.
create function private.mask_email(p_email text) returns text
  language sql immutable set search_path = '' as $$
    select case when p_email is null or pg_catalog.strpos(p_email, '@') < 2 then null
      else pg_catalog.left(p_email, 1) || '•••' || pg_catalog.substr(p_email, pg_catalog.strpos(p_email, '@'))
    end
  $$;

-- Sends a verification link to p_email, after reauthentication (the `backup_email` permission of
-- this session). Outcomes: 'sent', 'invalid', 'same_as_primary', 'rate_limited' (5 links a day).
create function public.request_backup_email(p_email text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_email text := private.normalise_email(p_email);
    v_token text;
    v_expires_at timestamptz := pg_catalog.now() + interval '1 hour';
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if pg_catalog.length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      return 'invalid';
    end if;
    if exists (select 1 from auth.users u
               where u.id = v_user_id and private.normalise_email(u.email) = v_email) then
      return 'same_as_primary';
    end if;
    if (select count(*) from private.backup_email_sends s
        where s.user_id = v_user_id and s.sent_at > pg_catalog.now() - interval '1 day') >= 5 then
      return 'rate_limited';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.consume_account_change_grant(v_user_id, 'backup_email', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    v_token := private.new_invitation_token('link');
    insert into private.backup_emails (user_id, pending_email, pending_token_hash, pending_expires_at)
      values (v_user_id, v_email, private.token_hash(v_token), v_expires_at)
      on conflict (user_id) do update
        set pending_email = excluded.pending_email,
            pending_token_hash = excluded.pending_token_hash,
            pending_expires_at = excluded.pending_expires_at,
            updated_at = pg_catalog.now();
    insert into private.backup_email_sends (user_id) values (v_user_id);
    perform private.queue_security_email(v_user_id, 'backup_verify', v_email, v_token, v_expires_at);
    perform private.record_security_event(v_user_id, 'backup_email_requested', v_session_id);
    return 'sent';
  end
  $$;

-- Opened from the link, signed in as the account. Outcomes: 'confirmed', 'invalid' (wrong,
-- used or expired link), 'unavailable' (the address is another account's backup or sign-in
-- address).
create function public.confirm_backup_email(p_token text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_row private.backup_emails;
    v_replaced boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, private.jwt_session_id()) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    select * into v_row from private.backup_emails b where b.user_id = v_user_id for update;
    if v_row.pending_token_hash is null or v_row.pending_token_hash <> private.token_hash(p_token)
       or v_row.pending_expires_at <= pg_catalog.now() then
      return 'invalid';
    end if;
    if exists (select 1 from private.backup_emails b
               where b.email = v_row.pending_email and b.user_id <> v_user_id)
       or exists (select 1 from auth.users u
                  where private.normalise_email(u.email) = v_row.pending_email) then
      update private.backup_emails b
        set pending_email = null, pending_token_hash = null, pending_expires_at = null,
            updated_at = pg_catalog.now()
        where b.user_id = v_user_id;
      return 'unavailable';
    end if;
    v_replaced := v_row.email is not null;
    update private.backup_emails b
      set email = v_row.pending_email, verified_at = pg_catalog.now(),
          pending_email = null, pending_token_hash = null, pending_expires_at = null,
          updated_at = pg_catalog.now()
      where b.user_id = v_user_id;
    perform private.record_security_event(v_user_id, 'backup_email_changed', private.jwt_session_id());
    perform private.notify_user(
      v_user_id, null, 'security', 'account.backup_email_changed',
      pg_catalog.jsonb_build_object('replaced', v_replaced),
      'account.backup_email_changed:' || pg_catalog.gen_random_uuid()::text, true);
    return 'confirmed';
  end
  $$;

-- Drops a pending change; the verified address (if any) stays.
create function public.cancel_backup_email_change() returns void
  language plpgsql security definer set search_path = '' as $$
  begin
    if auth.uid() is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update private.backup_emails b
      set pending_email = null, pending_token_hash = null, pending_expires_at = null,
          updated_at = pg_catalog.now()
      where b.user_id = auth.uid();
    delete from private.backup_emails b where b.user_id = auth.uid() and b.email is null;
  end
  $$;

-- Removes the backup address, after reauthentication. A recovery in progress ends with it.
create function public.remove_backup_email() returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_found boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.consume_account_change_grant(v_user_id, 'backup_email', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    delete from private.backup_emails b where b.user_id = v_user_id and b.email is not null
      returning true into v_found;
    delete from private.backup_emails b where b.user_id = v_user_id;
    if not coalesce(v_found, false) then
      return false;
    end if;
    update private.account_recoveries r set status = 'cancelled', updated_at = pg_catalog.now()
      where r.user_id = v_user_id and r.status in ('link_sent', 'waiting', 'ready');
    perform private.record_security_event(v_user_id, 'backup_email_removed', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.backup_email_removed', '{}'::jsonb,
      'account.backup_email_removed:' || pg_catalog.gen_random_uuid()::text, true);
    return true;
  end
  $$;

revoke all on function public.request_backup_email(text) from public, anon;
grant execute on function public.request_backup_email(text) to authenticated;
revoke all on function public.confirm_backup_email(text) from public, anon;
grant execute on function public.confirm_backup_email(text) to authenticated;
revoke all on function public.cancel_backup_email_change() from public, anon;
grant execute on function public.cancel_backup_email_change() to authenticated;
revoke all on function public.remove_backup_email() from public, anon;
grant execute on function public.remove_backup_email() to authenticated;

-- Account recovery codes --------------------------------------------------------------------------

-- Separate from the two-factor recovery codes: 16 characters (80 bits), shown XXXX-XXXX-XXXX-XXXX.
-- One of them, with the backup address, starts the waiting-period recovery below; they authorize
-- nothing else.
create table private.account_recovery_codes (
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash bytea not null,
  created_at timestamptz not null default now(),
  primary key (user_id, code_hash)
);

revoke all on table private.account_recovery_codes from public;

create function private.new_account_recovery_code() returns text
  language plpgsql volatile set search_path = '' as $$
  declare
    v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    v_bytes bytea := extensions.gen_random_bytes(16);
    v_code text := '';
  begin
    for i in 0..15 loop
      v_code := v_code || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) & 31) + 1, 1);
    end loop;
    return v_code;
  end
  $$;

-- Creates a new set of 10 and returns them once; the old set stops working in the same
-- transaction. Needs the `account_recovery_codes` permission of this session.
create function public.create_account_recovery_codes() returns setof text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_code text;
    v_regenerated boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.consume_account_change_grant(v_user_id, 'account_recovery_codes', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    select exists (select 1 from private.account_recovery_codes c where c.user_id = v_user_id)
      into v_regenerated;
    delete from private.account_recovery_codes c where c.user_id = v_user_id;
    for i in 1..10 loop
      v_code := private.new_account_recovery_code();
      insert into private.account_recovery_codes (user_id, code_hash)
        values (v_user_id, private.recovery_code_hash(v_code));
      return next pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4) || '-'
        || pg_catalog.substr(v_code, 9, 4) || '-' || pg_catalog.substr(v_code, 13, 4);
    end loop;
    perform private.record_security_event(v_user_id, 'account_recovery_codes_created', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.account_recovery_codes_created',
      pg_catalog.jsonb_build_object('replaced', v_regenerated),
      'account.account_recovery_codes_created:' || pg_catalog.gen_random_uuid()::text, true);
  end
  $$;

revoke all on function public.create_account_recovery_codes() from public, anon;
grant execute on function public.create_account_recovery_codes() to authenticated;

-- Account recovery (lost password and mailbox) ----------------------------------------------------

-- Owner's decision (2026-11-06): the link sent to the verified backup address plus one account
-- recovery code start a 72-hour wait, with notices to both addresses and in the app; the account
-- holder can cancel it from Settings › Security. After the wait, a link to the backup address
-- makes it the primary address, ends every session and resets trust and recovery codes; the
-- password is then reset through the normal reset email. Two-factor sign-in stays on unless the
-- person said they lost the authenticator too.
create table private.account_recoveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null constraint account_recoveries_status_check
    check (status in ('link_sent', 'waiting', 'ready', 'completed', 'cancelled')),
  backup_email text not null,
  link_token_hash bytea,
  link_expires_at timestamptz,
  lost_authenticator boolean not null default false,
  ready_at timestamptz,
  finish_token_hash bytea,
  finish_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index account_recoveries_user_idx on private.account_recoveries (user_id, created_at desc);
create unique index account_recoveries_link_key on private.account_recoveries (link_token_hash)
  where link_token_hash is not null;
create unique index account_recoveries_finish_key on private.account_recoveries (finish_token_hash)
  where finish_token_hash is not null;

create table private.account_recovery_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null constraint account_recovery_attempts_kind_check
    check (kind in ('started', 'code_failed')),
  attempted_at timestamptz not null default now()
);

create index account_recovery_attempts_idx
  on private.account_recovery_attempts (user_id, kind, attempted_at);

revoke all on table private.account_recoveries, private.account_recovery_attempts from public;

create function private.account_recovery_wait() returns interval
  language sql immutable set search_path = '' as $$ select interval '72 hours' $$;

-- Step 1, signed out: the account's sign-in address. The answer is always the same; when the
-- account has a verified backup address (and asked fewer than 3 times today, with no recovery
-- already waiting), a link valid for 1 hour goes to that address.
create function private.start_account_recovery(p_email text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid;
    v_backup text;
    v_token text;
    v_expires_at timestamptz := pg_catalog.now() + interval '1 hour';
  begin
    select u.id, b.email into v_user_id, v_backup
      from auth.users u join private.backup_emails b on b.user_id = u.id
      where private.normalise_email(u.email) = private.normalise_email(p_email)
        and u.email_confirmed_at is not null and b.email is not null;
    if v_user_id is null then
      return;
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if exists (select 1 from private.account_recoveries r
               where r.user_id = v_user_id and r.status in ('waiting', 'ready'))
       or (select count(*) from private.account_recovery_attempts a
           where a.user_id = v_user_id and a.kind = 'started'
             and a.attempted_at > pg_catalog.now() - interval '1 day') >= 3 then
      return;
    end if;
    insert into private.account_recovery_attempts (user_id, kind) values (v_user_id, 'started');
    update private.account_recoveries r set status = 'cancelled', link_token_hash = null,
           updated_at = pg_catalog.now()
      where r.user_id = v_user_id and r.status = 'link_sent';
    v_token := private.new_invitation_token('link');
    insert into private.account_recoveries (user_id, status, backup_email, link_token_hash, link_expires_at)
      values (v_user_id, 'link_sent', v_backup, private.token_hash(v_token), v_expires_at);
    perform private.queue_security_email(v_user_id, 'recovery_link', v_backup, v_token, v_expires_at);
    perform private.record_security_event(v_user_id, 'account_recovery_requested', null);
  end
  $$;

-- Step 2, signed out, from the link: one account recovery code. Outcomes: 'waiting' (the wait has
-- started; ready_at says until when), 'invalid' (wrong code, or a wrong, used or expired link),
-- 'rate_limited' (5 wrong codes in 15 minutes).
create function private.continue_account_recovery(
  p_token text, p_code text, p_lost_authenticator boolean
) returns table (outcome text, ready_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_r private.account_recoveries;
    -- Milliseconds, so the time survives the round trip through the job payload exactly.
    v_ready_at timestamptz := pg_catalog.date_trunc('milliseconds', pg_catalog.now() + private.account_recovery_wait());
    v_found boolean;
  begin
    select * into v_r from private.account_recoveries r
      where r.link_token_hash = private.token_hash(p_token)
        and r.status = 'link_sent' and r.link_expires_at > pg_catalog.now()
      for update;
    if v_r.id is null then
      return query select 'invalid'::text, null::timestamptz;
      return;
    end if;
    perform private.lock_sign_in_methods(v_r.user_id);
    if (select count(*) from private.account_recovery_attempts a
        where a.user_id = v_r.user_id and a.kind = 'code_failed'
          and a.attempted_at > pg_catalog.now() - interval '15 minutes') >= 5 then
      return query select 'rate_limited'::text, null::timestamptz;
      return;
    end if;
    delete from private.account_recovery_codes c
      where c.user_id = v_r.user_id and c.code_hash = private.recovery_code_hash(p_code)
      returning true into v_found;
    if not coalesce(v_found, false) then
      insert into private.account_recovery_attempts (user_id, kind) values (v_r.user_id, 'code_failed');
      perform private.record_security_event(v_r.user_id, 'account_recovery_code_failed', null);
      return query select 'invalid'::text, null::timestamptz;
      return;
    end if;
    update private.account_recoveries r
      set status = 'waiting', link_token_hash = null, link_expires_at = null,
          lost_authenticator = coalesce(p_lost_authenticator, false),
          ready_at = v_ready_at, updated_at = pg_catalog.now()
      where r.id = v_r.id;
    perform private.record_security_event(v_r.user_id, 'account_recovery_started', null);
    perform private.notify_user(
      v_r.user_id, null, 'security', 'account.recovery_started',
      pg_catalog.jsonb_build_object('readyAt', v_ready_at),
      'account.recovery_started:' || v_r.id::text, true);
    perform private.queue_security_email(v_r.user_id, 'recovery_started', v_r.backup_email, null, null);
    perform private.enqueue_job(
      'account-recovery-ready', 1, 'account-recovery-ready:' || v_r.id::text,
      pg_catalog.jsonb_build_object('recoveryId', v_r.id, 'readyAt', v_ready_at),
      null, v_ready_at);
    return query select 'waiting'::text, v_ready_at;
  end
  $$;

-- For the account-recovery-ready job (service role), at the end of the wait: a link to finish
-- (valid 7 days) goes to the backup address, if the recovery is still waiting for that time.
create function public.deliver_account_recovery_ready(p_recovery_id uuid, p_ready_at timestamptz)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_r private.account_recoveries;
    v_token text;
    v_expires_at timestamptz := pg_catalog.now() + interval '7 days';
  begin
    select * into v_r from private.account_recoveries r where r.id = p_recovery_id for update;
    if v_r.id is null or v_r.status <> 'waiting' or v_r.ready_at is distinct from p_ready_at
       or v_r.ready_at > pg_catalog.now() then
      return 'not_ready';
    end if;
    v_token := private.new_invitation_token('link');
    update private.account_recoveries r
      set status = 'ready', finish_token_hash = private.token_hash(v_token),
          finish_expires_at = v_expires_at, updated_at = pg_catalog.now()
      where r.id = v_r.id;
    perform private.queue_security_email(v_r.user_id, 'recovery_ready', v_r.backup_email, v_token, v_expires_at);
    return 'notified';
  end
  $$;

revoke all on function public.deliver_account_recovery_ready(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.deliver_account_recovery_ready(uuid, timestamptz) to service_role;

-- Step 3, signed out, from the second link. Outcomes: 'completed' (the backup address is now the
-- sign-in address: reset the password there), 'invalid', 'unavailable' (the backup address
-- changed, or another account now uses it).
create function private.finish_account_recovery(p_token text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_r private.account_recoveries;
  begin
    select * into v_r from private.account_recoveries r
      where r.finish_token_hash = private.token_hash(p_token)
        and r.status = 'ready' and r.finish_expires_at > pg_catalog.now()
      for update;
    if v_r.id is null then
      return 'invalid';
    end if;
    perform private.lock_sign_in_methods(v_r.user_id);
    if not exists (select 1 from private.backup_emails b
                   where b.user_id = v_r.user_id and b.email = v_r.backup_email)
       or exists (select 1 from auth.users u
                  where u.id <> v_r.user_id and private.normalise_email(u.email) = v_r.backup_email) then
      update private.account_recoveries r set status = 'cancelled', finish_token_hash = null,
             updated_at = pg_catalog.now()
        where r.id = v_r.id;
      return 'unavailable';
    end if;

    -- The backup address becomes the sign-in address (as Supabase Auth's own email change would
    -- leave it), and every session of the account ends, here and in every Home. The old password
    -- and every outstanding reset or one-time link stop working (they may be in the hands of
    -- whoever took the lost password or mailbox); a new password follows by the reset email to the
    -- new address. Clearing the password needs no permission (only setting one does).
    update auth.users u
      set email = v_r.backup_email,
          email_confirmed_at = coalesce(u.email_confirmed_at, pg_catalog.now()),
          email_change = '', email_change_token_new = '', email_change_token_current = '',
          email_change_sent_at = null, email_change_confirm_status = 0,
          encrypted_password = '', recovery_token = '', recovery_sent_at = null,
          reauthentication_token = '', reauthentication_sent_at = null,
          updated_at = pg_catalog.now()
      where u.id = v_r.user_id;
    delete from auth.one_time_tokens t where t.user_id = v_r.user_id;
    update auth.identities i
      set identity_data = i.identity_data || pg_catalog.jsonb_build_object('email', v_r.backup_email),
          updated_at = pg_catalog.now()
      where i.user_id = v_r.user_id and i.provider = 'email';
    delete from auth.sessions s where s.user_id = v_r.user_id;
    if v_r.lost_authenticator then
      perform pg_catalog.set_config('madeora.recovery_code_redeemed', v_r.user_id::text, true);
      delete from auth.mfa_factors f where f.user_id = v_r.user_id;
      delete from private.two_factor_recovery_codes c where c.user_id = v_r.user_id;
      perform pg_catalog.set_config('madeora.recovery_code_redeemed', '', true);
    end if;
    delete from private.account_recovery_codes c where c.user_id = v_r.user_id;
    delete from private.backup_emails b where b.user_id = v_r.user_id;
    update private.account_recoveries r
      set status = 'completed', finish_token_hash = null, updated_at = pg_catalog.now()
      where r.id = v_r.id;
    perform private.record_security_event(v_r.user_id, 'account_recovered', null);
    perform private.notify_user(
      v_r.user_id, null, 'security', 'account.recovered',
      pg_catalog.jsonb_build_object('authenticatorRemoved', v_r.lost_authenticator),
      'account.recovered:' || v_r.id::text, true);
    return 'completed';
  end
  $$;

-- The signed-out steps, callable by visitors. As with check_request, the public functions run
-- with the caller's rights and are bound at creation; only the private helpers above, granted
-- narrowly, read the account.
revoke all on function private.start_account_recovery(text) from public;
grant execute on function private.start_account_recovery(text) to anon, authenticated;
revoke all on function private.continue_account_recovery(text, text, boolean) from public;
grant execute on function private.continue_account_recovery(text, text, boolean) to anon, authenticated;
revoke all on function private.finish_account_recovery(text) from public;
grant execute on function private.finish_account_recovery(text) to anon, authenticated;

create function public.start_account_recovery(p_email text) returns void
  language sql volatile
  begin atomic
    select private.start_account_recovery(p_email);
  end;

create function public.continue_account_recovery(
  p_token text, p_code text, p_lost_authenticator boolean default false
) returns table (outcome text, ready_at timestamptz)
  language sql volatile
  begin atomic
    select * from private.continue_account_recovery(p_token, p_code, p_lost_authenticator);
  end;

create function public.finish_account_recovery(p_token text) returns text
  language sql volatile
  begin atomic
    select private.finish_account_recovery(p_token);
  end;

revoke all on function public.start_account_recovery(text) from public;
grant execute on function public.start_account_recovery(text) to anon, authenticated;
revoke all on function public.continue_account_recovery(text, text, boolean) from public;
grant execute on function public.continue_account_recovery(text, text, boolean) to anon, authenticated;
revoke all on function public.finish_account_recovery(text) from public;
grant execute on function public.finish_account_recovery(text) to anon, authenticated;

-- The account holder stops a recovery they did not ask for (no reauthentication: it only takes
-- something away). Returns whether one was stopped.
create function public.cancel_account_recovery() returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_count integer;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update private.account_recoveries r
      set status = 'cancelled', link_token_hash = null, finish_token_hash = null,
          updated_at = pg_catalog.now()
      where r.user_id = v_user_id and r.status in ('link_sent', 'waiting', 'ready');
    get diagnostics v_count = row_count;
    if v_count > 0 then
      perform private.record_security_event(v_user_id, 'account_recovery_cancelled', private.jwt_session_id());
    end if;
    return v_count > 0;
  end
  $$;

revoke all on function public.cancel_account_recovery() from public, anon;
grant execute on function public.cancel_account_recovery() to authenticated;

-- What Settings › Security shows about the account ------------------------------------------------

create function public.my_account_security()
returns table (
  has_password boolean,
  two_factor boolean,
  recovery_codes_left integer,
  backup_email text,
  backup_email_pending text,
  account_recovery_codes_left integer,
  recovery_waiting_until timestamptz,
  recovery_ready boolean
)
  language sql stable security definer set search_path = '' as $$
    select private.has_usable_password(u.id),
           private.has_two_factor(u.id),
           (select count(*)::integer from private.two_factor_recovery_codes c
              where c.user_id = u.id and c.used_at is null),
           private.mask_email(b.email),
           private.mask_email(case when b.pending_expires_at > pg_catalog.now() then b.pending_email end),
           (select count(*)::integer from private.account_recovery_codes c where c.user_id = u.id),
           (select r.ready_at from private.account_recoveries r
              where r.user_id = u.id and r.status in ('waiting', 'ready')
              order by r.created_at desc limit 1),
           exists (select 1 from private.account_recoveries r
                   where r.user_id = u.id and r.status = 'ready')
    from auth.users u
    left join private.backup_emails b on b.user_id = u.id
    where u.id = auth.uid()
  $$;

revoke all on function public.my_account_security() from public, anon;
grant execute on function public.my_account_security() to authenticated;

-- Request-level enforcement -----------------------------------------------------------------------

-- The state of the caller's token: 'ok' when not signed in, for the service role (jobs), or for a
-- signed-in token whose session exists and, for an account with two-factor sign-in, has passed
-- the second factor (aal2); otherwise 'session_not_active' or 'second_factor_required'.
create function private.request_session_state() returns text
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
    return 'ok';
  end
  $$;

-- For the row level security policies of tables Realtime streams (it does not go through PostgREST).
create function private.request_session_ok() returns boolean
  language sql stable security definer set search_path = '' as $$
    select private.request_session_state() = 'ok'
  $$;

revoke all on function private.request_session_ok() from public;
grant execute on function private.request_session_ok() to authenticated;

-- 401 for a revoked or expired session; 401 for an account with two-factor sign-in whose session
-- has not passed it, except the calls that check the second factor themselves: a recovery code
-- instead of the authenticator and a trusted browser (the two-factor page), and the two
-- reauthentication permissions, which the short-lived password or Google session asks for while
-- the code is verified on the browser's own session (is_recent_reauthentication requires it).
create function private.enforce_request_session() returns void
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_state text := private.request_session_state();
  begin
    if v_state = 'session_not_active' then
      raise sqlstate 'PT401' using message = 'session_not_active';
    end if;
    if v_state = 'second_factor_required'
       and coalesce(pg_catalog.current_setting('request.path', true), '') not in (
         '/rpc/redeem_two_factor_recovery_code', '/rpc/use_trusted_device',
         '/rpc/authorize_account_change', '/rpc/authorize_sign_in_method_change'
       ) then
      raise sqlstate 'PT401' using message = 'second_factor_required';
    end if;
  end
  $$;

revoke all on function private.enforce_request_session() from public;
grant execute on function private.enforce_request_session() to anon, authenticated, service_role;

-- PostgREST runs this before every API request (pgrst.db_pre_request below), as the request's
-- role. It runs with that role's rights (no SECURITY DEFINER in schema public); its body is bound
-- at creation, so the API roles need no access to schema private, only to the one helper above.
create function public.check_request() returns void
  language sql stable
  begin atomic
    select private.enforce_request_session();
  end;

revoke all on function public.check_request() from public;
grant execute on function public.check_request() to anon, authenticated, service_role;

-- PostgREST is told to run it in the next migration (20261123090100_adult_security_request_check.sql),
-- so a hosted project that refuses that setting still gets everything above.

-- Realtime does not go through PostgREST: the signal tables it streams get the same check.
create policy chore_pool_signals_session_ok on public.chore_pool_signals
  as restrictive for select to authenticated
  using ((select private.request_session_ok()));

create policy shopping_signals_session_ok on public.shopping_signals
  as restrictive for select to authenticated
  using ((select private.request_session_ok()));
