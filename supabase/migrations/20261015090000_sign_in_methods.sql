-- S08: rules for linking and unlinking sign-in methods (brief S08; spec "Confirmed self-service
-- Google and Apple sign-in method management"; architecture.md §7).
--
-- Supabase Auth attaches a Google sign-in to an existing account whose email matches (automatic
-- linking), and lets any signed-in browser link or unlink a provider with its own session. The
-- spec allows neither: linking needs explicit consent after recent reauthentication, never a
-- matching email, and the last usable sign-in method can never be removed. Supabase has no setting
-- for this on hosted projects, so the database enforces it on the table Supabase Auth writes:
--
-- * Adding a provider identity (Google; Apple later) to an account that already has a confirmed
--   sign-in method needs a one-time link permission. Without one the insert fails and Supabase
--   Auth reports an error. With one, the transaction must also be Supabase Auth's manual-link flow
--   for that account (checked when it commits), so a plain sign-in with a matching email is
--   refused even while a permission is open: automatic email-based linking cannot happen.
-- * Removing a provider identity needs a one-time unlink permission and a remaining usable
--   method: a confirmed email address with a password. The email/password identity itself cannot
--   be removed (no Madeora flow offers it yet).
-- * Permissions come only from public.authorize_sign_in_method_change(), which requires a
--   password sign-in from the last 5 minutes on a session that still exists.
--
-- Supabase Auth's own clean-up keeps working: a new account (no other identity), an account that
-- never confirmed its email (Auth then removes the unconfirmed password, its protection against
-- pre-account takeover), and deleting an account (identities go with it).
--
-- Supabase allows triggers on its auth tables, but no new functions or tables in schema auth, so
-- everything here lives in schema private and the API cannot reach it.

create table private.sign_in_method_grants (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null
    constraint sign_in_method_grants_action_check check (action in ('link', 'unlink')),
  provider text not null
    constraint sign_in_method_grants_provider_check check (provider in ('google')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- One open permission per account and action: asking again replaces it.
  primary key (user_id, action)
);

comment on table private.sign_in_method_grants is
  'One-time permissions to link or unlink a sign-in method after recent reauthentication (S08).';

revoke all on table private.sign_in_method_grants from public;

-- How long a password sign-in counts as "recent", and how long a permission stays usable. The app
-- mirrors both in apps/web/src/auth/sign-in-methods.ts.
create function private.sign_in_method_reauth_window() returns interval
  language sql immutable set search_path = '' as $$ select interval '5 minutes' $$;

create function private.sign_in_method_grant_lifetime() returns interval
  language sql immutable set search_path = '' as $$ select interval '10 minutes' $$;

-- Serializes every link, unlink and permission change of one account, so two concurrent requests
-- cannot both pass the checks below. Released at the end of the transaction.
create function private.lock_sign_in_methods(p_user_id uuid) returns void
  language sql set search_path = '' as $$
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('madeora.sign_in_methods:' || p_user_id::text, 0)
    )
  $$;

-- True when the account can still sign in without any provider identity: a confirmed email with
-- a password. Typing that password is also how the unlink permission was obtained.
create function private.has_usable_password(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1
      from auth.users u
      where u.id = p_user_id
        and u.email is not null
        and u.email_confirmed_at is not null
        and coalesce(u.encrypted_password, '') <> ''
    )
  $$;

-- Uses up the matching permission, if one is still valid.
create function private.consume_sign_in_method_grant(
  p_user_id uuid, p_action text, p_provider text
) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_found boolean;
  begin
    delete from private.sign_in_method_grants g
      where g.user_id = p_user_id
        and g.action = p_action
        and g.provider = p_provider
        and g.expires_at > pg_catalog.now()
      returning true into v_found;
    -- An expired permission is removed too, so it can never be used later.
    delete from private.sign_in_method_grants g
      where g.user_id = p_user_id and g.action = p_action and g.expires_at <= pg_catalog.now();
    return coalesce(v_found, false);
  end
  $$;

create function private.guard_identity_insert() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_confirmed timestamptz;
  begin
    -- Email/password identities are created by Supabase Auth's own sign-up and confirmation flows,
    -- which already require control of the address.
    if new.provider = 'email' then
      return new;
    end if;

    perform private.lock_sign_in_methods(new.user_id);

    -- A brand-new account: this identity is its first.
    if not exists (
      select 1 from auth.identities i where i.user_id = new.user_id and i.id <> new.id
    ) then
      return new;
    end if;

    -- An account that never confirmed its email holds nothing and cannot sign in. Supabase Auth
    -- hands it to the verified provider identity and removes the unconfirmed password.
    select u.email_confirmed_at into v_confirmed from auth.users u where u.id = new.user_id;
    if v_confirmed is null then
      return new;
    end if;

    if private.consume_sign_in_method_grant(new.user_id, 'link', new.provider) then
      -- Checked again at commit: it must be a manual link to this account (see below).
      perform pg_catalog.set_config(
        'madeora.linked_by_permission',
        coalesce(pg_catalog.current_setting('madeora.linked_by_permission', true), '')
          || new.id::text || ',',
        true
      );
      return new;
    end if;

    raise exception 'sign-in method link not authorized'
      using errcode = '42501',
            hint = 'Madeora links a provider only after the account holder confirms it (S08).';
  end
  $$;

create function private.guard_identity_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_confirmed timestamptz;
    v_exists boolean;
  begin
    select true, u.email_confirmed_at into v_exists, v_confirmed
      from auth.users u where u.id = old.user_id;

    -- The account itself is being deleted (the identities go with it).
    if v_exists is null then
      return old;
    end if;

    perform private.lock_sign_in_methods(old.user_id);

    -- Supabase Auth's clean-up of an account that never confirmed its email.
    if v_confirmed is null then
      return old;
    end if;

    if old.provider = 'email' then
      raise exception 'the email and password sign-in method cannot be removed'
        using errcode = '42501';
    end if;

    if not private.has_usable_password(old.user_id) then
      raise exception 'the last usable sign-in method cannot be removed'
        using errcode = '42501';
    end if;

    if not private.consume_sign_in_method_grant(old.user_id, 'unlink', old.provider) then
      raise exception 'sign-in method unlink not authorized'
        using errcode = '42501',
              hint = 'Madeora unlinks a provider only after the account holder confirms it (S08).';
    end if;

    return old;
  end
  $$;

-- Runs when the transaction commits, after Supabase Auth has finished the callback. An identity
-- let in by a permission must come from Supabase Auth's manual-link flow for this account: the
-- PKCE flow state that targets the account (linking_target_id), for this provider, completed by
-- a callback within the last minute (user_id and auth_code_issued_at set; Supabase Auth sets them
-- in the same transaction as the insert). Links through the implicit flow, which deletes its flow
-- state, are refused: Madeora's clients use PKCE. A Google sign-in that Supabase
-- would link by matching email has no such flow state, so a permission left open (for example by
-- cancelling at Google) cannot be used by it.
create function private.check_identity_link_flow() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if pg_catalog.strpos(
         coalesce(pg_catalog.current_setting('madeora.linked_by_permission', true), ''),
         new.id::text || ','
       ) = 0 then
      return null;
    end if;

    if not exists (
      select 1
      from auth.flow_state f
      where f.linking_target_id = new.user_id
        and f.user_id = new.user_id
        and f.provider_type = new.provider
        and f.auth_code_issued_at >= pg_catalog.now() - interval '1 minute'
    ) then
      raise exception 'sign-in method link not authorized'
        using errcode = '42501',
              hint = 'Only a manual link started by the account holder may add a sign-in method (S08).';
    end if;
    return null;
  end
  $$;

create trigger madeora_guard_identity_insert
  before insert on auth.identities
  for each row execute function private.guard_identity_insert();

create trigger madeora_guard_identity_delete
  before delete on auth.identities
  for each row execute function private.guard_identity_delete();

create constraint trigger madeora_check_identity_link_flow
  after insert on auth.identities
  deferrable initially deferred
  for each row execute function private.check_identity_link_flow();

-- Called by the browser with the session of a password sign-in it has just made (the settings page
-- asks for the password again). Checks in the database, not just in the token, that this session
-- still exists and recorded a password sign-in within the reauthentication window, then stores a
-- one-time permission. Returns when it expires.
create function public.authorize_sign_in_method_change(p_action text, p_provider text)
returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid;
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

    begin
      v_session_id := (auth.jwt() ->> 'session_id')::uuid;
    exception when invalid_text_representation then
      v_session_id := null;
    end;

    if v_session_id is null or not exists (
      select 1
      from auth.sessions s
      join auth.mfa_amr_claims c on c.session_id = s.id
      where s.id = v_session_id
        and s.user_id = v_user_id
        and (s.not_after is null or s.not_after > pg_catalog.now())
        and c.authentication_method = 'password'
        and c.updated_at > pg_catalog.now() - private.sign_in_method_reauth_window()
    ) then
      raise exception 'recent password sign-in required'
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

comment on function public.authorize_sign_in_method_change(text, text) is
  'S08: one-time permission to link or unlink a sign-in method after a fresh password sign-in.';

-- Only signed-in people may ask; the function checks the rest itself.
revoke all on function public.authorize_sign_in_method_change(text, text) from public, anon;
grant execute on function public.authorize_sign_in_method_change(text, text) to authenticated;
