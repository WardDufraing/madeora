-- S10: Home invitations, join requests and manager approval (brief S10; spec "Confirmed Home
-- invitations", "Confirmed manager invitations and approved adult join requests", "Confirmed
-- active invitation management", "Confirmed email invitation resend and renewal", "Confirmed
-- email invitation account matching", "Confirmed private accounts and invitation-only discovery").
--
-- Three ways in, one boundary:
-- - an email invitation (only the account with that verified email may use it),
-- - an invitation link (any signed-in adult; single use, or 2 to 10 admissions),
-- - a join code (Member only, no use cap; shared as a code or a link).
-- Using any of them only creates a pending join request. A current manager's approval is the
-- membership boundary: it re-checks everything, creates the membership and counts the use, under
-- row locks, so simultaneous approvals cannot exceed a cap or create two memberships.
--
-- The tables live in schema private, which the Data API cannot reach at all. Everything the app
-- does goes through the security definer functions at the end of this file, each of which checks
-- the caller (auth.uid()), their current membership and authority, and the invitation's state.

-- Audit subjects ------------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in ('home', 'user', 'invitation', 'join_request'));

create function private.audit(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid,
  p_details jsonb default '{}'::jsonb
) returns void
  language sql security definer set search_path = '' as $$
  insert into private.audit_events (actor_user_id, home_id, action, subject_type, subject_id, details)
    values (auth.uid(), p_home_id, p_action, p_subject_type, p_subject_id, p_details);
  $$;

-- Invitations ---------------------------------------------------------------------------------------

create table private.home_invitations (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  kind text not null constraint home_invitations_kind_check
    check (kind in ('email', 'link', 'join_code')),
  -- Never 'owner': ownership changes only through the explicit transfer (S12). Join codes always
  -- propose Member (spec: an applicant cannot request elevated roles).
  role text not null constraint home_invitations_role_check
    check (role in ('member', 'administrator') and (kind <> 'join_code' or role = 'member')),
  -- Email invitations only: the intended recipient (lower case) and the email's language.
  recipient_email text constraint home_invitations_recipient_check
    check (
      (kind = 'email') = (recipient_email is not null)
      and (recipient_email is null or (
        char_length(recipient_email) <= 254 and recipient_email = lower(recipient_email)
        and recipient_email ~ '^[^@\s]+@[^@\s]+$'
      ))
    ),
  email_locale text constraint home_invitations_email_locale_check
    check ((kind = 'email') = (email_locale is not null) and email_locale in ('en', 'nl')),
  -- The secret part of the link (or the join code). Kept in the clear because Resend must send
  -- the same link again (spec) and managers copy links later; the whole table is unreachable
  -- through the API, and renewal replaces it.
  token text not null constraint home_invitations_token_key unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- How many approved admissions it allows (null: no cap, join codes only) and how many it had.
  max_admissions integer constraint home_invitations_max_admissions_check
    check (
      case kind
        when 'email' then max_admissions = 1
        when 'link' then max_admissions = 1 or max_admissions between 2 and 10
        else max_admissions is null
      end
    ),
  admissions integer not null default 0
    constraint home_invitations_admissions_check
    check (admissions >= 0 and (max_admissions is null or admissions <= max_admissions)),
  -- The inviter. If they no longer have the authority to issue this role (or their account is
  -- gone), the invitation stops being usable (spec: acceptance must fail safely).
  created_by uuid references auth.users (id) on delete set null,
  creation_request_id uuid not null,
  -- Ended early: revoked by a manager, or (email invitations) its recipient was declined.
  ended_at timestamptz,
  ended_by uuid,
  end_reason text constraint home_invitations_end_check
    check ((end_reason is null) = (ended_at is null) and end_reason in ('revoked', 'declined')),
  -- Email delivery bookkeeping (email invitations only): when it was last sent, how many sends
  -- (first send, resends, renewals) fell in the current 24-hour window, and the last outcome.
  last_sent_at timestamptz,
  send_window_started_at timestamptz,
  sends_in_window integer not null default 0,
  delivery_status text constraint home_invitations_delivery_check
    check (delivery_status in ('pending', 'sent', 'failed', 'not_configured'))
);

create unique index home_invitations_request_key
  on private.home_invitations (created_by, creation_request_id);
create index home_invitations_home_idx on private.home_invitations (home_id, created_at desc);

comment on table private.home_invitations is
  'Email invitations, invitation links and join codes for a Home (S10). Not exposed through the API.';

-- Join requests -------------------------------------------------------------------------------------

create table private.home_join_requests (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  invitation_id uuid not null references private.home_invitations (id) on delete cascade,
  applicant_id uuid not null references auth.users (id) on delete cascade,
  -- Copied from the invitation; the applicant never chooses it, and approval cannot change it.
  role text not null constraint home_join_requests_role_check
    check (role in ('member', 'administrator')),
  status text not null default 'pending' constraint home_join_requests_status_check
    check (status in ('pending', 'approved', 'declined', 'withdrawn', 'expired')),
  -- What managers see to recognise the applicant (spec: minimally necessary verified identity):
  -- the verified email and the display name at the time of the request.
  applicant_email text not null,
  applicant_name text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  constraint home_join_requests_decided_check check ((status = 'pending') = (decided_at is null))
);

-- One pending request per person per Home.
create unique index home_join_requests_one_pending
  on private.home_join_requests (home_id, applicant_id) where status = 'pending';
create index home_join_requests_home_idx on private.home_join_requests (home_id, created_at desc);
create index home_join_requests_applicant_idx
  on private.home_join_requests (applicant_id, created_at desc);
create index home_join_requests_invitation_idx on private.home_join_requests (invitation_id);

comment on table private.home_join_requests is
  'Requests to join a Home made with an invitation or join code, and their outcome (S10).';

-- Failed lookups, for rate limiting link and code guessing per account.
create table private.join_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index join_attempts_user_idx on private.join_attempts (user_id, attempted_at);

-- Helpers -------------------------------------------------------------------------------------------

-- Whether p_user may issue (and approve) invitations for p_role in p_home right now. The Owner
-- may do both. An Administrator will manage Member invitations through the capability the Owner
-- grants in S12 (TypeScript: manageInvitations); Administrator invitations stay Owner-only, as
-- assigning Administrators is a non-delegable Owner power. Mirrors packages/domain's engine.
create function private.can_manage_invitations(p_home_id uuid, p_user_id uuid, p_role text)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_role in ('member', 'administrator') and exists (
    select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id = p_user_id and m.role = 'owner'
  );
  $$;

-- The signed-in account's verified email (lower case), or null when it is not confirmed.
create function private.confirmed_email(p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.lower(u.email) from auth.users u
  where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null;
  $$;

-- What an invitation can do now: 'active', or why not ('revoked', 'declined', 'accepted' for a
-- used email invitation, 'used_up', 'expired', 'invalid' when its inviter lost the authority).
create function private.invitation_state(p_invitation private.home_invitations) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_invitation.end_reason is not null then p_invitation.end_reason
    when p_invitation.max_admissions is not null
      and p_invitation.admissions >= p_invitation.max_admissions
      then case when p_invitation.kind = 'email' then 'accepted' else 'used_up' end
    when p_invitation.expires_at <= pg_catalog.now() then 'expired'
    when not private.can_manage_invitations(
      p_invitation.home_id, p_invitation.created_by, p_invitation.role
    ) then 'invalid'
    else 'active'
  end;
  $$;

-- A new secret: 32 random bytes as base64url (43 characters) for links and emails, or 10 Crockford
-- base32 characters (50 bits; no I, L, O or U) for join codes.
create function private.new_invitation_token(p_kind text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    v_bytes bytea;
    v_code text := '';
  begin
    if p_kind = 'join_code' then
      v_bytes := extensions.gen_random_bytes(10);
      for i in 0..9 loop
        -- 256 is a multiple of 32, so every character is equally likely.
        v_code := v_code || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) % 32) + 1, 1);
      end loop;
      return v_code;
    end if;
    return pg_catalog.rtrim(
      pg_catalog.translate(pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'),
      '='
    );
  end
  $$;

-- The stored form of what someone typed or opened: a 43-character link token as is, or a join code
-- with spaces and dashes removed, upper case, and the look-alikes I, L and O read as 1, 1 and 0.
-- Null when it can be neither.
create function private.normalize_invitation_token(p_value text) returns text
  language plpgsql immutable security definer set search_path = '' as $$
  declare
    v_code text;
  begin
    if p_value is null or pg_catalog.char_length(p_value) > 100 then
      return null;
    end if;
    if p_value ~ '^[A-Za-z0-9_-]{43}$' then
      return p_value;
    end if;
    v_code := pg_catalog.translate(
      pg_catalog.upper(pg_catalog.regexp_replace(p_value, '[\s-]', '', 'g')), 'ILO', '110'
    );
    if v_code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$' then
      return v_code;
    end if;
    return null;
  end
  $$;

-- Raises "not signed in" unless the caller is a signed-in account with a confirmed email; returns
-- the account id. Every account is an adult until children (S41) and displays (S43) arrive, which
-- must be refused here then.
create function private.require_confirmed_caller() returns uuid
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or private.confirmed_email(v_user_id) is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return v_user_id;
  end
  $$;

-- Rate limits (brief S10, owner may change): failed lookups per account per 15 minutes, new join
-- requests per account per 24 hours, email sends per invitation per 24 hours and the pause between
-- two sends, invitation emails per sending account and per Home per 24 hours (well under Resend's
-- free 100 a day, which Supabase Auth's account emails share), and active invitations per Home
-- (spec: 25).
create function private.invitation_limit(p_name text) returns integer
  language sql immutable security definer set search_path = '' as $$
  select case p_name
    when 'failed_lookups' then 10
    when 'requests_per_day' then 20
    when 'sends_per_day' then 5
    when 'seconds_between_sends' then 60
    when 'active_per_home' then 25
    when 'emails_per_account_per_day' then 20
    when 'emails_per_home_per_day' then 20
  end;
  $$;

-- Whether the account has used up its failed lookups for now.
create function private.lookups_blocked(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select (
    select pg_catalog.count(*) from private.join_attempts a
    where a.user_id = p_user_id and a.attempted_at > pg_catalog.now() - interval '15 minutes'
  ) >= private.invitation_limit('failed_lookups');
  $$;

create function private.record_failed_lookup(p_user_id uuid) returns void
  language sql security definer set search_path = '' as $$
  delete from private.join_attempts
    where user_id = p_user_id and attempted_at < pg_catalog.now() - interval '1 day';
  insert into private.join_attempts (user_id) values (p_user_id);
  $$;

-- Every invitation email sent (first sends, resends and renewals), kept for a day, so the daily
-- limits per sending account and per Home hold even when invitations are revoked and created again.
create table private.invitation_email_sends (
  id bigint generated always as identity primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now()
);
create index invitation_email_sends_home_idx on private.invitation_email_sends (home_id, sent_at);
create index invitation_email_sends_sender_idx on private.invitation_email_sends (sender_id, sent_at);
revoke all on table private.invitation_email_sends from public;
revoke all on table private.home_invitations, private.home_join_requests, private.join_attempts
  from public;

comment on table private.invitation_email_sends is
  'Invitation emails sent in the last day, for the per-account and per-Home limits (S10).';

-- Whether the sender or the Home has used up today's invitation emails.
create function private.email_sends_blocked(p_home_id uuid, p_sender_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select (
    select pg_catalog.count(*) from private.invitation_email_sends e
    where e.sender_id = p_sender_id and e.sent_at > pg_catalog.now() - interval '24 hours'
  ) >= private.invitation_limit('emails_per_account_per_day')
  or (
    select pg_catalog.count(*) from private.invitation_email_sends e
    where e.home_id = p_home_id and e.sent_at > pg_catalog.now() - interval '24 hours'
  ) >= private.invitation_limit('emails_per_home_per_day');
  $$;

create function private.record_email_send(p_home_id uuid, p_sender_id uuid) returns void
  language sql security definer set search_path = '' as $$
  delete from private.invitation_email_sends
    where sender_id = p_sender_id and sent_at < pg_catalog.now() - interval '2 days';
  insert into private.invitation_email_sends (home_id, sender_id) values (p_home_id, p_sender_id);
  $$;

-- Counts one email send for an invitation by p_sender_id, or returns false when a limit refuses
-- it: the pause between sends and the daily count of this invitation, and the daily limits of the
-- sender and of the Home.
create function private.count_invitation_send(p_invitation_id uuid, p_sender_id uuid)
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_inv private.home_invitations;
  begin
    select * into v_inv from private.home_invitations where id = p_invitation_id for update;
    if private.email_sends_blocked(v_inv.home_id, p_sender_id) then
      return false;
    end if;
    if v_inv.last_sent_at is not null and v_inv.last_sent_at
         > pg_catalog.now() - pg_catalog.make_interval(secs => private.invitation_limit('seconds_between_sends')) then
      return false;
    end if;
    if v_inv.send_window_started_at is null
       or v_inv.send_window_started_at <= pg_catalog.now() - interval '24 hours' then
      update private.home_invitations
        set send_window_started_at = pg_catalog.now(), sends_in_window = 1,
            last_sent_at = pg_catalog.now(), delivery_status = 'pending'
        where id = p_invitation_id;
      perform private.record_email_send(v_inv.home_id, p_sender_id);
      return true;
    end if;
    if v_inv.sends_in_window >= private.invitation_limit('sends_per_day') then
      return false;
    end if;
    update private.home_invitations
      set sends_in_window = sends_in_window + 1, last_sent_at = pg_catalog.now(),
          delivery_status = 'pending'
      where id = p_invitation_id;
    perform private.record_email_send(v_inv.home_id, p_sender_id);
    return true;
  end
  $$;

-- Managing invitations ------------------------------------------------------------------------------

-- Creates an invitation and returns its secret, which only the server uses (to send the email or
-- to show the link to the manager). A repeated p_request_id from the same account returns the
-- invitation that request created; reused with other content it raises 22023. Outcomes:
-- 'created', 'existing', 'limit_reached', 'duplicate_email', 'rate_limited' (email limits),
-- 'not_permitted', 'not_found'. Malformed input raises 22023.
create function public.create_home_invitation(
  p_home_id uuid,
  p_kind text,
  p_role text,
  p_request_id uuid,
  p_recipient_email text default null,
  p_email_locale text default null,
  p_expires_in text default null,
  p_max_admissions integer default null
) returns table (
  outcome text, invitation_id uuid, token text, expires_at timestamptz, delivery_status text
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_interval interval;
    v_email text;
    v_existing private.home_invitations;
    v_created private.home_invitations;
    v_active integer;
  begin
    if p_home_id is null or p_request_id is null
       or p_kind is null or p_kind not in ('email', 'link', 'join_code')
       or p_role is null or p_role not in ('member', 'administrator') then
      raise exception 'invalid invitation' using errcode = '22023';
    end if;

    if not exists (
      select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      return query select 'not_found'::text, null::uuid, null::text, null::timestamptz, null::text;
      return;
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, p_role) then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz, null::text;
      return;
    end if;

    -- Expiry: links and codes choose 24 hours, 7 days (default) or 30 days; email invitations
    -- always last 7 days (spec leaves other durations open).
    v_interval := case coalesce(p_expires_in, '7d')
      when '24h' then interval '24 hours'
      when '7d' then interval '7 days'
      when '30d' then interval '30 days'
    end;
    if v_interval is null or (p_kind = 'email' and v_interval <> interval '7 days') then
      raise exception 'invalid expiry' using errcode = '22023';
    end if;

    if p_kind = 'email' then
      v_email := pg_catalog.lower(pg_catalog.btrim(p_recipient_email));
      if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+$' or pg_catalog.char_length(v_email) > 254
         or p_email_locale is null or p_email_locale not in ('en', 'nl')
         or p_max_admissions is distinct from 1 then
        raise exception 'invalid email invitation' using errcode = '22023';
      end if;
    elsif p_recipient_email is not null or p_email_locale is not null then
      raise exception 'only email invitations have a recipient' using errcode = '22023';
    elsif p_kind = 'link' and (p_max_admissions is null
          or not (p_max_admissions = 1 or p_max_admissions between 2 and 10)) then
      raise exception 'invalid admission cap' using errcode = '22023';
    elsif p_kind = 'join_code' and (p_max_admissions is not null or p_role <> 'member') then
      raise exception 'join codes are Member only without a cap' using errcode = '22023';
    end if;

    -- One creation at a time per Home: the active count below cannot be raced past the limit, and
    -- a retried request cannot miss its earlier result.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('madeora.home_invitations:' || p_home_id::text, 0)
    );

    -- A retry returns what the first attempt created, but only for the very same request: a
    -- request id reused with other content (another address, kind, role or expiry) is refused,
    -- so an existing secret is never sent to, or shown for, something it was not made for.
    select * into v_existing from private.home_invitations i
      where i.created_by = v_user_id and i.creation_request_id = p_request_id;
    if found then
      if v_existing.home_id <> p_home_id
         or v_existing.kind <> p_kind
         or v_existing.role <> p_role
         or v_existing.recipient_email is distinct from v_email
         or v_existing.email_locale is distinct from p_email_locale
         or v_existing.max_admissions is distinct from p_max_admissions
         or v_existing.expires_at - v_existing.created_at <> v_interval then
        raise exception 'request id already used' using errcode = '22023';
      end if;
      return query select 'existing'::text, v_existing.id, v_existing.token,
        v_existing.expires_at, v_existing.delivery_status;
      return;
    end if;

    if p_kind = 'email' then
      -- One outstanding invitation per address per Home. This says nothing about accounts: it
      -- only looks at this Home's own invitations, which the manager can see anyway.
      if exists (
        select 1 from private.home_invitations i
        where i.home_id = p_home_id and i.kind = 'email' and i.recipient_email = v_email
          and private.invitation_state(i) = 'active'
      ) then
        return query select 'duplicate_email'::text, null::uuid, null::text, null::timestamptz,
          null::text;
        return;
      end if;
      -- The first email counts toward the sender's and the Home's daily email limits.
      if private.email_sends_blocked(p_home_id, v_user_id) then
        return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz,
          null::text;
        return;
      end if;
    end if;

    select pg_catalog.count(*) into v_active from private.home_invitations i
      where i.home_id = p_home_id and private.invitation_state(i) = 'active';
    if v_active >= private.invitation_limit('active_per_home') then
      return query select 'limit_reached'::text, null::uuid, null::text, null::timestamptz,
        null::text;
      return;
    end if;

    -- A new join code could, very rarely, repeat an existing one: try again.
    for attempt in 1..5 loop
      begin
        insert into private.home_invitations (
          home_id, kind, role, recipient_email, email_locale, token, expires_at, max_admissions,
          created_by, creation_request_id, delivery_status, last_sent_at, send_window_started_at,
          sends_in_window
        ) values (
          p_home_id, p_kind, p_role, v_email, p_email_locale,
          private.new_invitation_token(p_kind), pg_catalog.now() + v_interval, p_max_admissions,
          v_user_id, p_request_id,
          case when p_kind = 'email' then 'pending' end,
          case when p_kind = 'email' then pg_catalog.now() end,
          case when p_kind = 'email' then pg_catalog.now() end,
          case when p_kind = 'email' then 1 else 0 end
        ) returning * into v_created;
        exit;
      exception when unique_violation then
        if attempt = 5 then
          raise;
        end if;
      end;
    end loop;

    if p_kind = 'email' then
      perform private.record_email_send(p_home_id, v_user_id);
    end if;

    perform private.audit('invitation.created', p_home_id, 'invitation', v_created.id,
      pg_catalog.jsonb_build_object(
        'kind', p_kind, 'role', p_role, 'expires_in', coalesce(p_expires_in, '7d'),
        'max_admissions', p_max_admissions
      ));
    return query select 'created'::text, v_created.id, v_created.token, v_created.expires_at,
      v_created.delivery_status;
  end
  $$;

-- The invitations of a Home, newest first: every active one and those that ended in the last 30
-- days. The secret is returned only for active links and codes (the manager copies those); email
-- links go only to their recipient. Managers only (42501 otherwise).
create function public.list_home_invitations(p_home_id uuid)
returns table (
  id uuid, kind text, role text, recipient_email text, email_locale text, state text,
  created_at timestamptz, expires_at timestamptz, ended_at timestamptz,
  max_admissions integer, admissions integer, pending_requests integer,
  delivery_status text, last_sent_at timestamptz, token text
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select i.id, i.kind, i.role, i.recipient_email, i.email_locale, s.state,
        i.created_at, i.expires_at, i.ended_at, i.max_admissions, i.admissions,
        (select pg_catalog.count(*)::integer from private.home_join_requests r
          where r.invitation_id = i.id and r.status = 'pending'),
        i.delivery_status, i.last_sent_at,
        case when s.state = 'active' and i.kind <> 'email' then i.token end
      from private.home_invitations i
      cross join lateral (select private.invitation_state(i) as state) s
      where i.home_id = p_home_id
        and (s.state = 'active' or coalesce(i.ended_at, i.expires_at) > pg_catalog.now() - interval '30 days'
             or i.created_at > pg_catalog.now() - interval '30 days')
      order by (s.state = 'active') desc, i.created_at desc
      limit 200;
  end
  $$;

-- Looks up an invitation of p_home_id for a manager action and locks it. Raises nothing; the
-- caller turns a null into 'not_found' or 'not_permitted'.
create function private.invitation_for_manager(
  p_home_id uuid, p_invitation_id uuid, p_user_id uuid, out o_outcome text,
  out o_invitation private.home_invitations
)
  language plpgsql security definer set search_path = '' as $$
  begin
    if not exists (
      select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_user_id
    ) then
      o_outcome := 'not_found';
      return;
    end if;
    select * into o_invitation from private.home_invitations i
      where i.id = p_invitation_id and i.home_id = p_home_id for update;
    if not found then
      -- Managers learn that it does not exist; others only that they may not.
      o_outcome := case when private.can_manage_invitations(p_home_id, p_user_id, 'member')
        then 'not_found' else 'not_permitted' end;
      o_invitation := null;
      return;
    end if;
    if not private.can_manage_invitations(p_home_id, p_user_id, o_invitation.role) then
      o_outcome := 'not_permitted';
      o_invitation := null;
      return;
    end if;
    o_outcome := 'ok';
  end
  $$;

-- Revokes an invitation at once: its link or code stops working, pending requests made with it
-- can no longer be approved. Outcomes: 'revoked', 'not_active', 'not_permitted', 'not_found'.
create function public.revoke_home_invitation(p_home_id uuid, p_invitation_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_found record;
  begin
    select * into v_found from private.invitation_for_manager(p_home_id, p_invitation_id, v_user_id);
    if v_found.o_outcome <> 'ok' then
      return v_found.o_outcome;
    end if;
    if private.invitation_state(v_found.o_invitation) <> 'active' then
      return 'not_active';
    end if;
    update private.home_invitations
      set ended_at = pg_catalog.now(), ended_by = v_user_id, end_reason = 'revoked'
      where id = p_invitation_id;
    perform private.audit('invitation.revoked', p_home_id, 'invitation', p_invitation_id,
      pg_catalog.jsonb_build_object('kind', (v_found.o_invitation).kind));
    return 'revoked';
  end
  $$;

-- Resend (same link, recipient, role and expiry) or renew (a new link and a fresh 7 days; the old
-- link dies in the same transaction) an outstanding email invitation, and return what the server
-- needs to send it. Neither works once the recipient has used it, after it ended or expired, or
-- beyond the send limits. Outcomes: 'ok', 'not_email', 'not_active', 'has_request',
-- 'rate_limited', 'not_permitted', 'not_found'.
create function private.prepare_invitation_email(
  p_home_id uuid, p_invitation_id uuid, p_renew boolean
) returns table (
  outcome text, token text, recipient_email text, email_locale text, role text,
  expires_at timestamptz, home_name text
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_found record;
    v_inv private.home_invitations;
  begin
    select * into v_found from private.invitation_for_manager(p_home_id, p_invitation_id, v_user_id);
    if v_found.o_outcome <> 'ok' then
      return query select v_found.o_outcome, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text;
      return;
    end if;
    v_inv := v_found.o_invitation;
    if v_inv.kind <> 'email' then
      return query select 'not_email'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text;
      return;
    end if;
    if private.invitation_state(v_inv) <> 'active' then
      return query select 'not_active'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text;
      return;
    end if;
    -- The recipient already used it: a manager decides their request instead.
    if exists (
      select 1 from private.home_join_requests r
      where r.invitation_id = v_inv.id and r.status = 'pending'
    ) then
      return query select 'has_request'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text;
      return;
    end if;
    if not private.count_invitation_send(v_inv.id, v_user_id) then
      return query select 'rate_limited'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text;
      return;
    end if;

    if p_renew then
      update private.home_invitations i
        set token = private.new_invitation_token('email'),
            expires_at = pg_catalog.now() + interval '7 days'
        where i.id = v_inv.id;
      perform private.audit('invitation.renewed', p_home_id, 'invitation', v_inv.id);
    else
      perform private.audit('invitation.resent', p_home_id, 'invitation', v_inv.id);
    end if;

    return query
      select 'ok'::text, i.token, i.recipient_email, i.email_locale, i.role, i.expires_at, h.name
      from private.home_invitations i join public.homes h on h.id = i.home_id
      where i.id = v_inv.id;
  end
  $$;

create function public.resend_home_invitation(p_home_id uuid, p_invitation_id uuid)
returns table (
  outcome text, token text, recipient_email text, email_locale text, role text,
  expires_at timestamptz, home_name text
)
  language sql security definer set search_path = '' as $$
  select * from private.prepare_invitation_email(p_home_id, p_invitation_id, false);
  $$;

create function public.renew_home_invitation(p_home_id uuid, p_invitation_id uuid)
returns table (
  outcome text, token text, recipient_email text, email_locale text, role text,
  expires_at timestamptz, home_name text
)
  language sql security definer set search_path = '' as $$
  select * from private.prepare_invitation_email(p_home_id, p_invitation_id, true);
  $$;

-- Records whether the email just sent (or tried) was accepted by the email provider.
create function public.record_home_invitation_delivery(
  p_home_id uuid, p_invitation_id uuid, p_status text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_found record;
  begin
    if p_status is null or p_status not in ('sent', 'failed', 'not_configured') then
      raise exception 'invalid delivery status' using errcode = '22023';
    end if;
    select * into v_found from private.invitation_for_manager(p_home_id, p_invitation_id, v_user_id);
    if v_found.o_outcome <> 'ok' then
      return v_found.o_outcome;
    end if;
    if (v_found.o_invitation).kind <> 'email' then
      return 'not_email';
    end if;
    update private.home_invitations set delivery_status = p_status where id = p_invitation_id;
    return 'ok';
  end
  $$;

-- Using an invitation ------------------------------------------------------------------------------

-- The invitation behind a link or code, as the signed-in person may see it, and whether they could
-- ask to join with it. Nothing about the Home is returned unless they may use it (or already
-- belong to it, or already asked). Outcomes: 'ok', 'invalid', 'expired', 'revoked', 'used_up',
-- 'email_mismatch', 'already_member', 'pending', 'declined', 'rate_limited'.
create function private.resolve_invitation(p_token text, p_user_id uuid)
returns table (
  outcome text, invitation_id uuid, home_id uuid, home_name text, role text, kind text,
  expires_at timestamptz, request_id uuid
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_token text := private.normalize_invitation_token(p_token);
    v_inv private.home_invitations;
    v_state text;
    v_request private.home_join_requests;
    v_home_name text;
  begin
    -- Checked before the lookup, so a blocked account learns nothing, even about a valid code.
    if private.lookups_blocked(p_user_id) then
      return query select 'rate_limited'::text, null::uuid, null::uuid, null::text, null::text,
        null::text, null::timestamptz, null::uuid;
      return;
    end if;
    if v_token is not null then
      select * into v_inv from private.home_invitations i where i.token = v_token;
    end if;
    if v_token is null or v_inv.id is null then
      perform private.record_failed_lookup(p_user_id);
      return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::text,
        null::text, null::timestamptz, null::uuid;
      return;
    end if;

    -- A recipient-bound invitation says nothing more to anyone else, not even whether it expired.
    if v_inv.kind = 'email' and v_inv.recipient_email is distinct from private.confirmed_email(p_user_id) then
      return query select 'email_mismatch'::text, null::uuid, null::uuid, null::text, null::text,
        null::text, null::timestamptz, null::uuid;
      return;
    end if;

    select h.name into v_home_name from public.homes h where h.id = v_inv.home_id;

    if exists (
      select 1 from public.home_memberships m
      where m.home_id = v_inv.home_id and m.user_id = p_user_id
    ) then
      return query select 'already_member'::text, v_inv.id, v_inv.home_id, v_home_name, null::text,
        null::text, null::timestamptz, null::uuid;
      return;
    end if;

    select * into v_request from private.home_join_requests r
      where r.home_id = v_inv.home_id and r.applicant_id = p_user_id and r.status = 'pending'
      for update;
    if found then
      if private.request_state(v_request) = 'pending' then
        return query select 'pending'::text, v_inv.id, v_inv.home_id, v_home_name, null::text,
          null::text, null::timestamptz, v_request.id;
        return;
      end if;
      -- Its invitation ended before anyone decided: close it, so a new invitation for the same
      -- Home can be used (one pending request per Home).
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now()
        where id = v_request.id;
      perform private.audit('join_request.expired', v_request.home_id, 'join_request', v_request.id);
    end if;

    -- Declined with this invitation: it cannot be used to ask again.
    if exists (
      select 1 from private.home_join_requests r
      where r.invitation_id = v_inv.id and r.applicant_id = p_user_id and r.status = 'declined'
    ) then
      return query select 'declined'::text, null::uuid, null::uuid, null::text, null::text,
        null::text, null::timestamptz, null::uuid;
      return;
    end if;

    v_state := private.invitation_state(v_inv);
    if v_state <> 'active' then
      return query select
        case v_state
          when 'expired' then 'expired'
          when 'revoked' then 'revoked'
          when 'used_up' then 'used_up'
          -- An accepted or declined email invitation, or one whose inviter lost the authority.
          else 'invalid'
        end,
        null::uuid, null::uuid, null::text, null::text, null::text, null::timestamptz, null::uuid;
      return;
    end if;

    return query select 'ok'::text, v_inv.id, v_inv.home_id, v_home_name, v_inv.role, v_inv.kind,
      v_inv.expires_at, null::uuid;
  end
  $$;

create function public.preview_home_invitation(p_token text)
returns table (
  outcome text, home_id uuid, home_name text, role text, kind text, expires_at timestamptz,
  request_id uuid
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select r.outcome, r.home_id, r.home_name, r.role, r.kind, r.expires_at, r.request_id
      from private.resolve_invitation(p_token, v_user_id) r;
  end
  $$;

-- Asks to join with a link or code: creates a pending request for a manager to decide, with the
-- invitation's role. Asking again while one is pending returns that one. Nothing is consumed.
-- Outcomes: 'requested', and those of resolve_invitation ('pending' with the existing request).
create function public.request_to_join_home(p_token text)
returns table (outcome text, request_id uuid, home_name text)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_found record;
    v_request_id uuid;
  begin
    select * into v_found from private.resolve_invitation(p_token, v_user_id);
    if v_found.outcome = 'pending' then
      return query select 'pending'::text, v_found.request_id, v_found.home_name;
      return;
    end if;
    if v_found.outcome <> 'ok' then
      return query select v_found.outcome,
        null::uuid,
        case when v_found.outcome = 'already_member' then v_found.home_name end;
      return;
    end if;

    if (
      select pg_catalog.count(*) from private.home_join_requests r
      where r.applicant_id = v_user_id and r.created_at > pg_catalog.now() - interval '24 hours'
    ) >= private.invitation_limit('requests_per_day') then
      return query select 'rate_limited'::text, null::uuid, null::text;
      return;
    end if;

    begin
      insert into private.home_join_requests (
        home_id, invitation_id, applicant_id, role, applicant_email, applicant_name
      ) values (
        v_found.home_id, v_found.invitation_id, v_user_id, v_found.role,
        private.confirmed_email(v_user_id),
        (select p.display_name from public.user_preferences p where p.user_id = v_user_id)
      ) returning id into v_request_id;
    exception when unique_violation then
      -- A simultaneous request from the same person got there first.
      select r.id into v_request_id from private.home_join_requests r
        where r.home_id = v_found.home_id and r.applicant_id = v_user_id and r.status = 'pending';
      return query select 'pending'::text, v_request_id, v_found.home_name;
      return;
    end;

    perform private.audit('join_request.created', v_found.home_id, 'join_request', v_request_id,
      pg_catalog.jsonb_build_object('kind', v_found.kind, 'role', v_found.role));
    return query select 'requested'::text, v_request_id, v_found.home_name;
  end
  $$;

-- A request's state as people see it: a pending request whose invitation can no longer admit
-- anyone (expired, revoked, used up, inviter without authority) shows as expired.
create function private.request_state(p_request private.home_join_requests) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_request.status <> 'pending' then p_request.status
    when (
      select private.invitation_state(i) from private.home_invitations i
      where i.id = p_request.invitation_id
    ) = 'active' then 'pending'
    else 'expired'
  end;
  $$;

-- The signed-in person's own join requests of the last 90 days, newest first.
create function public.list_my_join_requests()
returns table (
  id uuid, home_id uuid, home_name text, role text, kind text, state text,
  created_at timestamptz, decided_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select r.id,
        -- The Home's id only while they belong to it, so the page can link there.
        case when exists (
          select 1 from public.home_memberships m
          where m.home_id = r.home_id and m.user_id = v_user_id
        ) then r.home_id end,
        h.name, r.role,
        case when i.kind = 'join_code' then 'join_code' else 'invitation' end,
        private.request_state(r), r.created_at, r.decided_at
      from private.home_join_requests r
      join public.homes h on h.id = r.home_id
      join private.home_invitations i on i.id = r.invitation_id
      where r.applicant_id = v_user_id and r.created_at > pg_catalog.now() - interval '90 days'
      order by r.created_at desc
      limit 50;
  end
  $$;

-- Withdraws the signed-in person's own pending request. Outcomes: 'withdrawn', 'not_pending',
-- 'not_found'.
create function public.withdraw_join_request(p_request_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.home_join_requests;
  begin
    select * into v_request from private.home_join_requests r
      where r.id = p_request_id and r.applicant_id = v_user_id for update;
    if not found then
      return 'not_found';
    end if;
    if v_request.status <> 'pending' then
      return 'not_pending';
    end if;
    update private.home_join_requests
      set status = 'withdrawn', decided_at = pg_catalog.now(), decided_by = v_user_id
      where id = p_request_id;
    perform private.audit('join_request.withdrawn', v_request.home_id, 'join_request', p_request_id);
    return 'withdrawn';
  end
  $$;

-- Deciding requests ---------------------------------------------------------------------------------

-- A Home's join requests for its managers: every pending one and those decided in the last 30
-- days. can_decide is false where the caller lacks the authority for the requested role.
create function public.list_home_join_requests(p_home_id uuid)
returns table (
  id uuid, applicant_name text, applicant_email text, role text, kind text, state text,
  created_at timestamptz, decided_at timestamptz, can_decide boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select r.id, r.applicant_name, r.applicant_email, r.role, i.kind, s.state,
        r.created_at, r.decided_at,
        s.state = 'pending' and private.can_manage_invitations(p_home_id, v_user_id, r.role)
      from private.home_join_requests r
      join private.home_invitations i on i.id = r.invitation_id
      cross join lateral (select private.request_state(r) as state) s
      where r.home_id = p_home_id
        and (r.status = 'pending' or r.decided_at > pg_catalog.now() - interval '30 days')
      order by (s.state = 'pending') desc, r.created_at desc
      limit 200;
  end
  $$;

-- Approves or declines a pending request. Approval is the membership boundary: under locks on the
-- request and its invitation, it re-checks the approver's current authority for the role, the
-- invitation (not ended, not expired, uses left, inviter still authorised), the applicant's
-- confirmed email (and exact match for an email invitation) and existing membership, then creates
-- exactly one membership and counts one use. Outcomes: 'approved', 'declined', 'already_decided',
-- 'no_longer_valid', 'already_member', 'not_permitted', 'not_found'.
create function public.decide_join_request(p_home_id uuid, p_request_id uuid, p_decision text)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.home_join_requests;
    v_inv private.home_invitations;
  begin
    if p_decision is null or p_decision not in ('approve', 'decline') then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      return 'not_found';
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      return 'not_permitted';
    end if;

    -- Lock order everywhere: request, then invitation.
    select * into v_request from private.home_join_requests r
      where r.id = p_request_id and r.home_id = p_home_id for update;
    if not found then
      return 'not_found';
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, v_request.role) then
      return 'not_permitted';
    end if;
    if v_request.status <> 'pending' then
      return 'already_decided';
    end if;
    select * into v_inv from private.home_invitations i where i.id = v_request.invitation_id
      for update;

    if p_decision = 'decline' then
      update private.home_join_requests
        set status = 'declined', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      -- An email invitation has one possible recipient: once they are declined it is finished.
      if v_inv.kind = 'email' and v_inv.end_reason is null then
        update private.home_invitations
          set ended_at = pg_catalog.now(), ended_by = v_user_id, end_reason = 'declined'
          where id = v_inv.id;
      end if;
      perform private.audit('join_request.declined', p_home_id, 'join_request', p_request_id,
        pg_catalog.jsonb_build_object('role', v_request.role));
      return 'declined';
    end if;

    if exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_request.applicant_id
    ) then
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      perform private.audit('join_request.expired', p_home_id, 'join_request', p_request_id,
        pg_catalog.jsonb_build_object('reason', 'already_member'));
      return 'already_member';
    end if;

    if private.invitation_state(v_inv) <> 'active'
       or v_request.role <> v_inv.role
       or private.confirmed_email(v_request.applicant_id) is null
       or (v_inv.kind = 'email'
           and v_inv.recipient_email is distinct from private.confirmed_email(v_request.applicant_id))
    then
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      perform private.audit('join_request.expired', p_home_id, 'join_request', p_request_id);
      return 'no_longer_valid';
    end if;

    -- The S09 trigger audits the new membership with the approver as the actor.
    insert into public.home_memberships (home_id, user_id, role)
      values (p_home_id, v_request.applicant_id, v_request.role);
    update private.home_invitations set admissions = admissions + 1 where id = v_inv.id;
    update private.home_join_requests
      set status = 'approved', decided_at = pg_catalog.now(), decided_by = v_user_id
      where id = p_request_id;
    perform private.audit('join_request.approved', p_home_id, 'join_request', p_request_id,
      pg_catalog.jsonb_build_object('role', v_request.role, 'kind', v_inv.kind));
    return 'approved';
  end
  $$;

-- The number of pending requests a manager can act on, for the Home dashboard. 0 for everyone else.
create function public.count_pending_join_requests(p_home_id uuid) returns integer
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      return 0;
    end if;
    return (
      select pg_catalog.count(*) from private.home_join_requests r
      where r.home_id = p_home_id and private.request_state(r) = 'pending'
        and private.can_manage_invitations(p_home_id, v_user_id, r.role)
    );
  end
  $$;

-- API access ----------------------------------------------------------------------------------------

-- The private helpers keep the default set in the baseline migration: nobody but their owner may
-- run them. The public functions are for signed-in accounts only.
do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.create_home_invitation(uuid, text, text, uuid, text, text, text, integer)',
    'public.list_home_invitations(uuid)',
    'public.revoke_home_invitation(uuid, uuid)',
    'public.resend_home_invitation(uuid, uuid)',
    'public.renew_home_invitation(uuid, uuid)',
    'public.record_home_invitation_delivery(uuid, uuid, text)',
    'public.preview_home_invitation(text)',
    'public.request_to_join_home(text)',
    'public.list_my_join_requests()',
    'public.withdraw_join_request(uuid)',
    'public.list_home_join_requests(uuid)',
    'public.decide_join_request(uuid, uuid, text)',
    'public.count_pending_join_requests(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
end
$$;
