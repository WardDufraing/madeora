-- S42 part 3: the age-aware move from a guardian-managed child profile to the same person's
-- independent account (spec "Confirmed age-aware child-to-independent-account transition";
-- brief plans/steps/S42-brief.md).
--
-- Ward's decision (2026-11-12): the child's primary guardian starts the move and enters the birth
-- date then; the minimum age comes from the Home's country (the GDPR digital-consent age; 16 when
-- the country is not known). A Home has no country field, so its country is read from its
-- scheduling time zone; a child in several Homes needs the highest age of them all. The birth
-- date is used for that check only and is never stored.
--
-- Steps:
--   1. A guardian with identity authority (the primary guardian in every Home of the child) starts
--      the move: eligible → a single-use claim link (7 days) for the young person; not yet →
--      the date they will be, nothing kept.
--   2. The young person opens the link (no sign-in), reviews what changes and gives an email
--      address they control. A verification link (1 hour) is emailed to it.
--   3. From that link they confirm. In one transaction: their child sessions end, child sign-in
--      credentials and PINs are deleted, guardian assignments and child settings end in every
--      Home, they stop being a child, and the verified address becomes their sign-in address.
--      They then choose a password through the ordinary password-reset email (S06), so no
--      password ever passes through Madeora's database functions.
--   Their identity (user id) never changes, so every chore, point, habit, goal and setting stays
--   theirs; their Home memberships and Member role are unchanged. Either guardian in any Home may
--   cancel before completion (guardian disagreement). Nothing changes because of a birthday.

-- 1. Ages and countries -------------------------------------------------------------------------------

-- GDPR article 8 digital-consent ages by country (EU/EEA and the UK). Anything else: 16.
create table private.digital_consent_ages (
  country text primary key constraint digital_consent_ages_country_check check (country ~ '^[A-Z]{2}$'),
  min_age integer not null constraint digital_consent_ages_age_check check (min_age between 13 and 18)
);

revoke all on table private.digital_consent_ages from public;

insert into private.digital_consent_ages (country, min_age) values
  ('AT', 14), ('BE', 13), ('BG', 14), ('HR', 16), ('CY', 14), ('CZ', 15), ('DK', 13), ('EE', 13),
  ('FI', 13), ('FR', 15), ('DE', 16), ('GR', 15), ('HU', 16), ('IE', 16), ('IT', 14), ('LV', 13),
  ('LT', 14), ('LU', 16), ('MT', 13), ('NL', 16), ('PL', 16), ('PT', 13), ('RO', 16), ('SK', 16),
  ('SI', 15), ('ES', 14), ('SE', 13), ('IS', 13), ('LI', 16), ('NO', 13), ('GB', 13);

-- The country of an IANA time zone, for the zones of the countries above.
create table private.time_zone_countries (
  time_zone text primary key,
  country text not null references private.digital_consent_ages (country)
);

revoke all on table private.time_zone_countries from public;

insert into private.time_zone_countries (time_zone, country) values
  ('Europe/Vienna', 'AT'), ('Europe/Brussels', 'BE'), ('Europe/Sofia', 'BG'),
  ('Europe/Zagreb', 'HR'), ('Asia/Nicosia', 'CY'), ('Asia/Famagusta', 'CY'),
  ('Europe/Nicosia', 'CY'), ('Europe/Prague', 'CZ'), ('Europe/Copenhagen', 'DK'),
  ('Europe/Tallinn', 'EE'), ('Europe/Helsinki', 'FI'), ('Europe/Mariehamn', 'FI'),
  ('Europe/Paris', 'FR'), ('Europe/Berlin', 'DE'), ('Europe/Busingen', 'DE'),
  ('Europe/Athens', 'GR'), ('Europe/Budapest', 'HU'), ('Europe/Dublin', 'IE'),
  ('Europe/Rome', 'IT'), ('Europe/Riga', 'LV'), ('Europe/Vilnius', 'LT'),
  ('Europe/Luxembourg', 'LU'), ('Europe/Malta', 'MT'), ('Europe/Amsterdam', 'NL'),
  ('Europe/Warsaw', 'PL'), ('Europe/Lisbon', 'PT'), ('Atlantic/Madeira', 'PT'),
  ('Atlantic/Azores', 'PT'), ('Europe/Bucharest', 'RO'), ('Europe/Bratislava', 'SK'),
  ('Europe/Ljubljana', 'SI'), ('Europe/Madrid', 'ES'), ('Africa/Ceuta', 'ES'),
  ('Atlantic/Canary', 'ES'), ('Europe/Stockholm', 'SE'), ('Atlantic/Reykjavik', 'IS'),
  ('Europe/Vaduz', 'LI'), ('Europe/Oslo', 'NO'), ('Europe/London', 'GB');

-- The age a person must have reached to manage their own account, for a child in all their Homes.
create function private.child_independence_age(p_child uuid) returns integer
  language sql stable security definer set search_path = '' as $$
    select coalesce(pg_catalog.max(coalesce(a.min_age, 16)), 16)
    from public.home_memberships m
    join public.homes h on h.id = m.home_id
    left join private.time_zone_countries z on z.time_zone = h.timezone
    left join private.digital_consent_ages a on a.country = z.country
    where m.user_id = p_child
  $$;

revoke all on function private.child_independence_age(uuid) from public;

-- 2. Transitions ------------------------------------------------------------------------------------

create table private.child_transitions (
  id uuid primary key default gen_random_uuid(),
  child_user_id uuid not null references auth.users (id) on delete cascade,
  started_by uuid references auth.users (id) on delete set null,
  required_age integer not null,
  status text not null default 'started'
    constraint child_transitions_status_check check (status in ('started', 'completed', 'cancelled')),
  claim_token_hash bytea not null constraint child_transitions_claim_key unique,
  claim_expires_at timestamptz not null,
  -- Set when the young person gives an address; cleared on completion (it is then auth.users').
  pending_email text,
  email_token_hash bytea constraint child_transitions_email_key unique,
  email_expires_at timestamptz,
  email_sends integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- One open move per child.
create unique index child_transitions_open_key on private.child_transitions (child_user_id)
  where status = 'started';

revoke all on table private.child_transitions from public;

comment on table private.child_transitions is
  'S42: a child''s move to an independent account. Token hashes only; no birth date.';

-- The verification email goes through the S37 security-email job.
alter table private.security_emails drop constraint security_emails_kind_check;
alter table private.security_emails add constraint security_emails_kind_check check (kind in (
  'backup_verify', 'recovery_link', 'recovery_started', 'recovery_ready', 'transition_verify'
));

create or replace function public.get_security_email(p_email_id uuid)
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
       or (v_e.kind in ('backup_verify', 'recovery_link', 'recovery_ready', 'transition_verify')
           and v_e.token is null) then
      return query select 'skipped'::text, null::text, null::text, null::text, null::text, null::timestamptz;
      return;
    end if;
    select p.locale into v_locale from public.user_preferences p where p.user_id = v_e.user_id;
    return query select 'ok'::text, v_e.kind, v_e.to_email, coalesce(v_locale, 'en'), v_e.token,
                        v_e.expires_at;
  end
  $$;

-- The child's open move, if its claim link still works.
create function private.open_child_transition(p_child uuid) returns private.child_transitions
  language sql stable security definer set search_path = '' as $$
    select t.* from private.child_transitions t
    where t.child_user_id = p_child and t.status = 'started' and t.claim_expires_at > pg_catalog.now()
  $$;

revoke all on function private.open_child_transition(uuid) from public;

-- Whether a move still holds: the child's Homes may have changed since it started (a new Home
-- with a higher age, or one where its starter is not the primary guardian). Then it must be
-- started again, by someone with authority in every Home, against the age they all require.
create function private.child_transition_holds(p_t private.child_transitions) returns boolean
  language sql stable security definer set search_path = '' as $$
    select p_t.started_by is not null
      and private.is_child(p_t.child_user_id)
      and private.child_independence_age(p_t.child_user_id) <= p_t.required_age
      and private.child_identity_authority(p_t.child_user_id, p_t.started_by)
  $$;

revoke all on function private.child_transition_holds(private.child_transitions) from public;

-- 3. Guardians ------------------------------------------------------------------------------------------

-- What a guardian of the child in this Home sees: whether a move is open and until when, the age
-- needed, and whether they may start one. Anyone else: an error.
create function public.child_transition_state(p_home_id uuid, p_child_membership_id uuid)
returns table (open boolean, claim_expires_at timestamptz, email_given boolean, required_age integer,
               can_start boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid := private.child_of_membership(p_home_id, p_child_membership_id);
    v_open private.child_transitions;
  begin
    if v_child is null or private.child_guardian_role(p_home_id, v_child, v_user_id) is null then
      raise exception 'not a guardian of this child' using errcode = '42501';
    end if;
    v_open := private.open_child_transition(v_child);
    return query select v_open.id is not null, v_open.claim_expires_at,
                        v_open.pending_email is not null,
                        private.child_independence_age(v_child),
                        private.child_identity_authority(v_child, v_user_id);
  end
  $$;

revoke all on function public.child_transition_state(uuid, uuid) from public, anon;
grant execute on function public.child_transition_state(uuid, uuid) to authenticated;

-- Starts (or restarts, replacing the old link) the move. Outcomes: 'started' with the claim token
-- (shown once to the guardian, stored only as its hash), 'not_eligible' with the date the child
-- will be, 'not_permitted', 'not_found'.
create function public.start_child_transition(
  p_home_id uuid, p_child_membership_id uuid, p_birth_date date
) returns table (outcome text, token text, expires_at timestamptz, eligible_on date)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_age integer;
    v_token text;
    v_id uuid;
    v_expires timestamptz := pg_catalog.now() + interval '7 days';
  begin
    if p_birth_date is null or p_birth_date > current_date
       or p_birth_date < current_date - interval '120 years' then
      raise exception 'invalid birth date' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::text, null::timestamptz, null::date;
      return;
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null or private.child_guardian_role(p_home_id, v_child, v_user_id) is null then
      return query select 'not_found'::text, null::text, null::timestamptz, null::date;
      return;
    end if;
    if not private.child_identity_authority(v_child, v_user_id) then
      return query select 'not_permitted'::text, null::text, null::timestamptz, null::date;
      return;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('child_transition:' || v_child::text, 0));
    v_age := private.child_independence_age(v_child);
    if (p_birth_date + pg_catalog.make_interval(years => v_age))::date > current_date then
      perform private.audit('child.transition_not_eligible', p_home_id, 'user', v_child,
        pg_catalog.jsonb_build_object('required_age', v_age));
      return query select 'not_eligible'::text, null::text, null::timestamptz,
                          (p_birth_date + pg_catalog.make_interval(years => v_age))::date;
      return;
    end if;

    update private.child_transitions t set status = 'cancelled'
      where t.child_user_id = v_child and t.status = 'started';
    v_token := private.new_invitation_token('link');
    insert into private.child_transitions (child_user_id, started_by, required_age, claim_token_hash,
                                           claim_expires_at)
      values (v_child, v_user_id, v_age, private.token_hash(v_token), v_expires)
      returning id into v_id;
    -- Every other guardian, in any of the child's Homes, is told so they can cancel in time.
    perform private.notify_user(g.guardian_user_id, g.home_id, 'security', 'child.transition_started',
      '{}'::jsonb, 'child.transition_started:' || v_id::text || ':' || g.guardian_user_id::text)
    from (select distinct on (x.guardian_user_id) x.guardian_user_id, x.home_id
          from public.child_guardians x
          where x.child_user_id = v_child and x.guardian_user_id <> v_user_id
          order by x.guardian_user_id, x.assigned_at) g;
    perform private.audit('child.transition_started', p_home_id, 'user', v_child,
      pg_catalog.jsonb_build_object('required_age', v_age));
    return query select 'started'::text, v_token, v_expires, null::date;
  end
  $$;

revoke all on function public.start_child_transition(uuid, uuid, date) from public, anon;
grant execute on function public.start_child_transition(uuid, uuid, date) to authenticated;

-- Either guardian of the child in this Home stops an open move. 'cancelled', 'unchanged' or
-- 'not_found'.
create function public.cancel_child_transition(p_home_id uuid, p_child_membership_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid := private.child_of_membership(p_home_id, p_child_membership_id);
    v_found boolean;
  begin
    if v_child is null or private.child_guardian_role(p_home_id, v_child, v_user_id) is null then
      return 'not_found';
    end if;
    update private.child_transitions t
      set status = 'cancelled', pending_email = null, email_token_hash = null
      where t.child_user_id = v_child and t.status = 'started'
      returning true into v_found;
    if v_found is null then
      return 'unchanged';
    end if;
    perform private.audit('child.transition_cancelled', p_home_id, 'user', v_child, '{}'::jsonb);
    return 'cancelled';
  end
  $$;

revoke all on function public.cancel_child_transition(uuid, uuid) from public, anon;
grant execute on function public.cancel_child_transition(uuid, uuid) to authenticated;

-- 4. The young person (the web server only, as service_role; no session) ----------------------------

-- What the move changes, for the review screens: their name, their Homes, and what ends.
create function private.child_transition_summary(p_t private.child_transitions) returns jsonb
  language sql stable security definer set search_path = '' as $$
    select pg_catalog.jsonb_build_object(
      'name', (select coalesce(p.nickname, p.display_name, up.display_name)
               from public.home_memberships m
               left join public.home_member_profiles p
                 on p.home_id = m.home_id and p.user_id = m.user_id
               left join public.user_preferences up on up.user_id = m.user_id
               where m.user_id = p_t.child_user_id order by m.created_at limit 1),
      'homes', coalesce((select pg_catalog.jsonb_agg(h.name order by m.created_at)
                         from public.home_memberships m join public.homes h on h.id = m.home_id
                         where m.user_id = p_t.child_user_id), '[]'::jsonb),
      'guardians', (select pg_catalog.count(*) from public.child_guardians g
                    where g.child_user_id = p_t.child_user_id),
      'has_username', exists (select 1 from private.child_credentials c
                              where c.child_user_id = p_t.child_user_id and c.username is not null),
      'pin_homes', (select pg_catalog.count(*) from private.child_home_pins p
                    where p.child_user_id = p_t.child_user_id),
      'email', p_t.pending_email,
      'claim_expires_at', p_t.claim_expires_at
    )
  $$;

revoke all on function private.child_transition_summary(private.child_transitions) from public;

-- The claim screen; null for a wrong, used or expired link.
create function public.child_transition_preview(p_token text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_t private.child_transitions;
  begin
    select * into v_t from private.child_transitions t
      where t.claim_token_hash = private.token_hash(p_token) and t.status = 'started'
        and t.claim_expires_at > pg_catalog.now();
    if v_t.id is null or not private.child_transition_holds(v_t) then
      return null;
    end if;
    return private.child_transition_summary(v_t);
  end
  $$;

-- Takes the address the young person controls and emails it a verification link. Outcomes:
-- 'sent', 'invalid' (link), 'invalid_email', 'email_taken', 'rate_limited'.
create function public.claim_child_transition(p_token text, p_email text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_t private.child_transitions;
    v_email text := private.normalise_email(p_email);
    v_link text;
    v_expires timestamptz := pg_catalog.now() + interval '1 hour';
  begin
    select * into v_t from private.child_transitions t
      where t.claim_token_hash = private.token_hash(p_token) and t.status = 'started'
        and t.claim_expires_at > pg_catalog.now()
      for update;
    if v_t.id is null or not private.child_transition_holds(v_t) then
      return 'invalid';
    end if;
    if pg_catalog.length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       or v_email like '%.invalid' then
      return 'invalid_email';
    end if;
    if exists (select 1 from auth.users u where private.normalise_email(u.email) = v_email)
       or exists (select 1 from private.backup_emails b where b.email = v_email) then
      return 'email_taken';
    end if;
    if v_t.email_sends >= 5 then
      return 'rate_limited';
    end if;
    v_link := private.new_invitation_token('link');
    update private.child_transitions t
      set pending_email = v_email, email_token_hash = private.token_hash(v_link),
          email_expires_at = v_expires, email_sends = t.email_sends + 1
      where t.id = v_t.id;
    perform private.queue_security_email(v_t.child_user_id, 'transition_verify', v_email, v_link,
                                         v_expires);
    perform private.audit('child.transition_email_sent', null, 'user', v_t.child_user_id, '{}'::jsonb);
    return 'sent';
  end
  $$;

-- The confirmation screen, opened from the emailed link; null for a wrong or expired link.
-- `completed` is true when this link already finished the move (a retry).
create function public.child_transition_review(p_email_token text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_t private.child_transitions;
  begin
    select * into v_t from private.child_transitions t
      where t.email_token_hash = private.token_hash(p_email_token);
    if v_t.id is null then
      return null;
    end if;
    if v_t.status = 'completed' then
      return pg_catalog.jsonb_build_object('completed', true);
    end if;
    if v_t.status <> 'started' or v_t.email_expires_at <= pg_catalog.now()
       or v_t.claim_expires_at <= pg_catalog.now() or not private.child_transition_holds(v_t) then
      return null;
    end if;
    return private.child_transition_summary(v_t) || pg_catalog.jsonb_build_object('completed', false);
  end
  $$;

-- Completes the move (see the top of this file). Outcomes: 'completed' (also for a retry of this
-- link), 'invalid', 'email_taken'.
create function public.complete_child_transition(p_email_token text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_t private.child_transitions;
    v_child uuid;
    v_homes uuid[];
    v_home uuid;
  begin
    select * into v_t from private.child_transitions t
      where t.email_token_hash = private.token_hash(p_email_token)
      for update;
    if v_t.id is null then
      return 'invalid';
    end if;
    if v_t.status = 'completed' then
      return 'completed';
    end if;
    if v_t.status <> 'started' or v_t.email_expires_at <= pg_catalog.now()
       or v_t.claim_expires_at <= pg_catalog.now() or v_t.pending_email is null then
      return 'invalid';
    end if;
    v_child := v_t.child_user_id;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('child_transition:' || v_child::text, 0));
    if not private.child_transition_holds(v_t) then
      update private.child_transitions t
        set status = 'cancelled', pending_email = null
        where t.id = v_t.id;
      perform private.audit('child.transition_cancelled', null, 'user', v_child,
        pg_catalog.jsonb_build_object('reason', 'homes_changed'));
      return 'invalid';
    end if;
    perform private.lock_sign_in_methods(v_child);
    if exists (select 1 from auth.users u
               where private.normalise_email(u.email) = v_t.pending_email and u.id <> v_child)
       or exists (select 1 from private.backup_emails b where b.email = v_t.pending_email) then
      return 'email_taken';
    end if;

    select coalesce(pg_catalog.array_agg(m.home_id), '{}') into v_homes
      from public.home_memberships m where m.user_id = v_child;

    -- Every guardian is told that their authority ended (before it is removed).
    perform private.notify_user(g.guardian_user_id, g.home_id, 'security', 'child.transition_completed',
      '{}'::jsonb, 'child.transition_completed:' || v_t.id::text || ':' || g.guardian_user_id::text)
    from (select distinct on (x.guardian_user_id) x.guardian_user_id, x.home_id
          from public.child_guardians x where x.child_user_id = v_child
          order by x.guardian_user_id, x.assigned_at) g;

    -- Child sessions end everywhere; child credentials, PINs and guardian authority end.
    perform private.end_child_sessions(v_child, null, 'independent');
    delete from public.child_guardian_offers o where o.child_user_id = v_child;
    delete from private.child_link_codes c where c.child_user_id = v_child;
    delete from public.child_guardians g where g.child_user_id = v_child;
    delete from public.child_home_settings s where s.child_user_id = v_child;
    delete from public.child_profiles c where c.user_id = v_child;
    delete from auth.sessions s where s.user_id = v_child;

    -- The verified address becomes the sign-in address. No password yet: they choose one through
    -- the password-reset email, so a password never reaches the database in the clear.
    update auth.users u
      set email = v_t.pending_email, email_confirmed_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      where u.id = v_child;
    update auth.identities i
      set identity_data = i.identity_data || pg_catalog.jsonb_build_object('email', v_t.pending_email),
          updated_at = pg_catalog.now()
      where i.user_id = v_child and i.provider = 'email';

    update private.child_transitions t
      set status = 'completed', completed_at = pg_catalog.now(), pending_email = null
      where t.id = v_t.id;
    foreach v_home in array v_homes loop
      perform private.audit('child.transition_completed', v_home, 'user', v_child,
        pg_catalog.jsonb_build_object('required_age', v_t.required_age));
    end loop;
    return 'completed';
  end
  $$;

revoke all on function public.child_transition_preview(text) from public, anon, authenticated;
revoke all on function public.claim_child_transition(text, text) from public, anon, authenticated;
revoke all on function public.child_transition_review(text) from public, anon, authenticated;
revoke all on function public.complete_child_transition(text) from public, anon, authenticated;
grant execute on function public.child_transition_preview(text) to service_role;
grant execute on function public.claim_child_transition(text, text) to service_role;
grant execute on function public.child_transition_review(text) to service_role;
grant execute on function public.complete_child_transition(text) to service_role;
