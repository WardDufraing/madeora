-- S38: account activity history, security activity, the downloadable security report and security
-- sign-in alerts (brief plans/steps/S38-brief.md; spec "Confirmed categorized private account
-- activity history", "Confirmed downloadable adult security activity report", "Confirmed adult
-- account security activity history", "Confirmed risk-based account security notifications").
--
-- * private.account_activity_events: one private, privacy-minimised timeline per account, in five
--   categories (security, privacy, profile, integrations, home_memberships). Only the account
--   holder reads it, through public.list_my_activity(). Nothing here gives a Home manager, a
--   guardian or a display any path to another person's timeline.
-- * It is filled by triggers, so every path is caught: S37's account_security_events (mirrored),
--   sign-ins (auth.sessions), the Home audit trail (memberships, join requests, ownership
--   transfers and recoveries whose subject is this account), profile presentation edits and the
--   Google Calendar integration. Privacy events arrive with S39, where those settings are built.
-- * Sign-ins are classified by a sweep at least two minutes later: the separate sign-in that
--   S08/S37 re-authentication makes is not a new sign-in for the person and must not alert them.
-- * Routine sign-in alerts (new device: on by default; every sign-in: off by default); mandatory
--   alerts stay S37's notices and cannot be turned off.
-- * Security report: a frozen snapshot, built at download time (no stored file), 24 hours, needs
--   S37 re-authentication for the request and for each download.
-- * Visible history is kept 12 months (owner default, awaiting approval), then purged.
--
-- Device context is coarse (device kind, browser family, platform) and parsed here from the user
-- agent; the raw user agent, IP addresses and locations are never stored in these tables.

-- Settings -----------------------------------------------------------------------------------------

create function private.activity_retention() returns interval
  language sql immutable set search_path = '' as $$ select interval '12 months' $$;

create function private.security_report_lifetime() returns interval
  language sql immutable set search_path = '' as $$ select interval '24 hours' $$;

create function private.security_report_daily_limit() returns integer
  language sql immutable set search_path = '' as $$ select 3 $$;

-- How long a sign-in waits before it is classified (re-authentication marks its session within
-- seconds; this leaves a wide margin).
create function private.sign_in_settle_time() returns interval
  language sql immutable set search_path = '' as $$ select interval '2 minutes' $$;

-- Device labels ------------------------------------------------------------------------------------

-- The same best-effort description as apps/web/src/auth/sessions.ts (describeDevice). A hint for
-- the account holder, never proof of identity.
create function private.device_labels(p_user_agent text,
  out device_kind text, out browser text, out platform text)
  language plpgsql immutable set search_path = '' as $$
  declare
    v_ua text := pg_catalog.left(coalesce(p_user_agent, ''), 512);
  begin
    if v_ua = '' then
      device_kind := 'unknown'; browser := 'other'; platform := 'other';
      return;
    end if;
    browser := case
      when v_ua ~ '\yEdg(e|A|iOS)?/' then 'edge'
      when v_ua ~ '\yOPR/|\yOpera\y' then 'opera'
      when v_ua ~ '\ySamsungBrowser/' then 'samsung'
      when v_ua ~ '\y(Firefox|FxiOS)/' then 'firefox'
      when v_ua ~ '\y(Chrome|CriOS|Chromium)/' then 'chrome'
      when v_ua ~ '\ySafari/' and v_ua ~ '\yVersion/' then 'safari'
      else 'other' end;
    platform := case
      when v_ua ~ '\yiPad\y' then 'ipados'
      when v_ua ~ '\y(iPhone|iPod)\y' then 'ios'
      when v_ua ~ '\yAndroid\y' then 'android'
      when v_ua ~ '\yCrOS\y' then 'chromeos'
      when v_ua ~ '\yWindows\y' then 'windows'
      when v_ua ~ '\yMac OS X\y|\yMacintosh\y' then 'macos'
      when v_ua ~ '\yLinux\y' then 'linux'
      else 'other' end;
    device_kind := case
      when platform = 'ipados' or v_ua ~ '\yTablet\y' then 'tablet'
      when platform = 'android' then case when v_ua ~ '\yMobile\y' then 'phone' else 'tablet' end
      when platform = 'ios' or v_ua ~ '\yMobile\y' then 'phone'
      when platform = 'other' then 'unknown'
      else 'computer' end;
  end
  $$;

-- Security events: sign-ins, reports, alert settings -------------------------------------------------

alter table private.account_security_events
  drop constraint account_security_events_kind_check;
alter table private.account_security_events
  add constraint account_security_events_kind_check check (kind in (
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
    'account_recovered',
    -- S38
    'signed_in',
    'security_report_requested',
    'security_report_downloaded',
    'security_report_discarded',
    'security_alerts_changed',
    'google_sign_in_linked',
    'google_sign_in_unlinked',
    -- S38 account lifecycle (20261125090000_account_lifecycle.sql)
    'account_deactivated',
    'account_reactivated',
    'inactivity_reminder_sent',
    'security_review_completed'
  ));

alter table private.account_security_events
  add column device_kind text,
  add column browser text,
  add column platform text,
  -- Sign-ins only: set by the sweep once the sign-in has been classified.
  add column classified_at timestamptz,
  -- Sign-ins only: the account had two-factor sign-in when the session was created, and when that
  -- session completed the second step (aal2). A sign-in that never completes it is unfinished.
  add column second_step_needed boolean not null default false,
  add column second_step_at timestamptz;

create index account_security_events_unclassified_idx
  on private.account_security_events (created_at)
  where kind = 'signed_in' and classified_at is null;

create index account_security_events_session_idx
  on private.account_security_events (session_id, kind)
  where session_id is not null;

-- Every new Supabase Auth session is a sign-in. Runs as part of Supabase Auth's own insert, so it
-- must never be able to make a sign-in fail.
create function private.record_sign_in() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_labels record;
  begin
    begin
      v_labels := private.device_labels(new.user_agent);
      insert into private.account_security_events
          (user_id, kind, session_id, device_kind, browser, platform, second_step_needed,
           second_step_at, created_at)
        values (new.user_id, 'signed_in', new.id, v_labels.device_kind, v_labels.browser,
                v_labels.platform, private.has_two_factor(new.user_id),
                case when new.aal::text = 'aal2' then pg_catalog.now() end,
                coalesce(new.created_at, pg_catalog.now()));
    exception when others then
      raise warning 'madeora: sign-in not recorded (%)', sqlstate;
    end;
    return null;
  end
  $$;

create trigger madeora_record_sign_in
  after insert on auth.sessions
  for each row execute function private.record_sign_in();

-- A session that completes two-factor verification (aal2) finishes its sign-in. Same rule: it
-- runs inside Supabase Auth's update and must never make it fail.
create function private.record_second_step() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    begin
      update private.account_security_events e
        set second_step_at = pg_catalog.now()
        where e.session_id = new.id and e.kind = 'signed_in' and e.second_step_at is null;
    exception when others then
      raise warning 'madeora: second step not recorded (%)', sqlstate;
    end;
    return null;
  end
  $$;

create trigger madeora_record_second_step
  after update of aal on auth.sessions
  for each row
  when (new.aal::text = 'aal2' and old.aal is distinct from new.aal)
  execute function private.record_second_step();

-- Linking or unlinking Google as a sign-in method (S08) is a security event. Creating an account
-- with Google (its first identity) is not a link, and identities removed with a deleted account
-- are not recorded. Never makes Supabase Auth's own write fail.
create function private.record_identity_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    begin
      if tg_op = 'INSERT' then
        if new.provider = 'google' and exists (
          select 1 from auth.identities i where i.user_id = new.user_id and i.id <> new.id
        ) then
          perform private.record_security_event(new.user_id, 'google_sign_in_linked',
                                                private.jwt_session_id());
        end if;
      elsif old.provider = 'google' and exists (select 1 from auth.users u where u.id = old.user_id) then
        perform private.record_security_event(old.user_id, 'google_sign_in_unlinked',
                                              private.jwt_session_id());
      end if;
    exception when others then
      raise warning 'madeora: sign-in method change not recorded (%)', sqlstate;
    end;
    return null;
  end
  $$;

create trigger madeora_record_identity_change
  after insert or delete on auth.identities
  for each row execute function private.record_identity_change();

-- S08 sign-in-method permissions also come from a re-authentication sign-in: record it the way
-- S37's authorize_account_change does, so the sweep does not take it for a new sign-in.
create or replace function public.authorize_sign_in_method_change(
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
    perform private.record_security_event(v_user_id, 'reauthenticated', v_session_id);
    return v_expires_at;
  end
  $$;

-- Activity table -------------------------------------------------------------------------------------

create table private.account_activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null constraint account_activity_events_category_check
    check (category in ('security', 'privacy', 'profile', 'integrations', 'home_memberships')),
  -- A code the app turns into words in the reader's language.
  kind text not null constraint account_activity_events_kind_check
    check (kind ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$' and char_length(kind) <= 64),
  outcome text not null constraint account_activity_events_outcome_check
    check (outcome in ('completed', 'pending', 'declined', 'blocked', 'failed', 'cancelled', 'expired')),
  -- The Home it concerned and its name at that moment, so the entry stays intelligible after the
  -- person leaves (no foreign key: the record outlives the Home). Never other members' names.
  home_id uuid,
  home_name text constraint account_activity_events_home_name_check
    check (home_name is null or char_length(home_name) <= 200),
  -- Who acted, as a safe role only: never another person's identity.
  actor text not null default 'self' constraint account_activity_events_actor_check
    check (actor in ('self', 'home_member', 'home_manager', 'madeora', 'automatic')),
  -- Role codes for role changes ({from, to}); nothing else.
  details jsonb not null default '{}' constraint account_activity_events_details_check
    check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 256),
  device_kind text constraint account_activity_events_device_kind_check
    check (device_kind is null or device_kind in ('phone', 'tablet', 'computer', 'unknown')),
  browser text constraint account_activity_events_browser_check
    check (browser is null or browser in ('edge', 'chrome', 'firefox', 'safari', 'samsung', 'opera', 'other')),
  platform text constraint account_activity_events_platform_check
    check (platform is null or platform in ('windows', 'macos', 'ios', 'ipados', 'android', 'linux', 'chromeos', 'other')),
  -- The session concerned (never shown; used for "this device" and "Secure my account").
  session_id uuid,
  -- The S37 security event this mirrors: at most one entry each.
  source_event_id uuid constraint account_activity_events_source_key unique,
  -- Sign-ins: whether an alert was sent, and the person's answer to it.
  alerted boolean not null default false,
  response text constraint account_activity_events_response_check
    check (response is null or response in ('confirmed', 'reported')),
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create index account_activity_events_user_idx
  on private.account_activity_events (user_id, created_at desc, id desc);
create index account_activity_events_purge_idx
  on private.account_activity_events (created_at);

comment on table private.account_activity_events is
  'S38: private account activity history (five categories). Read only via list_my_activity.';

revoke all on table private.account_activity_events from public;

-- Records one entry. Called from triggers inside other people's and the person's own changes: it
-- must never undo the change it runs in, so failures are swallowed with a warning.
create function private.record_account_activity(
  p_user_id uuid, p_category text, p_kind text, p_outcome text,
  p_home_id uuid default null, p_actor text default 'self', p_details jsonb default '{}'::jsonb
) returns void
  language plpgsql security definer set search_path = '' as $$
  begin
    if p_user_id is null then
      return;
    end if;
    begin
      insert into private.account_activity_events
          (user_id, category, kind, outcome, home_id, home_name, actor, details)
        select p_user_id, p_category, p_kind, p_outcome, p_home_id,
               (select pg_catalog.left(h.name, 200) from public.homes h where h.id = p_home_id),
               coalesce(p_actor, 'automatic'), coalesce(p_details, '{}'::jsonb)
        where exists (select 1 from auth.users u where u.id = p_user_id);
    exception when others then
      raise warning 'madeora: activity not recorded (%)', sqlstate;
    end;
  end
  $$;

-- The safe actor for an entry about p_subject made by p_actor_id.
create function private.activity_actor(p_subject uuid, p_actor_id uuid, p_other text)
returns text
  language sql stable set search_path = '' as $$
    select case
      when p_actor_id is null then 'automatic'
      when p_actor_id = p_subject then 'self'
      when exists (select 1 from private.madeora_staff s where s.user_id = p_actor_id) then 'madeora'
      else p_other end
  $$;

-- Security: mirror S37 events ------------------------------------------------------------------------

create function private.security_event_outcome(p_kind text) returns text
  language sql immutable set search_path = '' as $$
    select case p_kind
      when 'email_change_requested' then 'pending'
      when 'backup_email_requested' then 'pending'
      when 'account_recovery_requested' then 'pending'
      when 'account_recovery_started' then 'pending'
      when 'email_change_cancelled' then 'cancelled'
      when 'account_recovery_cancelled' then 'cancelled'
      when 'recovery_code_failed' then 'blocked'
      when 'account_recovery_code_failed' then 'blocked'
      else 'completed' end
  $$;

-- Re-authentication itself is not shown (the change it allowed is); sign-ins wait for the sweep.
create function private.mirror_security_event() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.kind in ('reauthenticated', 'signed_in') then
      return null;
    end if;
    begin
      insert into private.account_activity_events
          (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
           source_event_id, created_at)
        values (new.user_id, 'security', new.kind, private.security_event_outcome(new.kind), 'self',
                new.device_kind, new.browser, new.platform, new.session_id, new.id, new.created_at)
        on conflict (source_event_id) do nothing;
    exception when others then
      raise warning 'madeora: security activity not mirrored (%)', sqlstate;
    end;
    return null;
  end
  $$;

create trigger madeora_mirror_security_event
  after insert on private.account_security_events
  for each row execute function private.mirror_security_event();

-- Security alert preferences ---------------------------------------------------------------------------

create table private.security_alert_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  new_device boolean not null default true,
  every_sign_in boolean not null default false,
  updated_at timestamptz not null default now()
);

revoke all on table private.security_alert_preferences from public;

comment on table private.security_alert_preferences is
  'S38: routine sign-in alert choices (absent row = defaults: new device on, every sign-in off).';

create function public.get_security_alert_preferences()
returns table (new_device boolean, every_sign_in boolean)
  language sql stable security definer set search_path = '' as $$
    select coalesce(p.new_device, true), coalesce(p.every_sign_in, false)
    from (select auth.uid() as uid) me
    left join private.security_alert_preferences p on p.user_id = me.uid
    where me.uid is not null
  $$;

revoke all on function public.get_security_alert_preferences() from public, anon;
grant execute on function public.get_security_alert_preferences() to authenticated;

create function public.set_security_alert_preferences(p_new_device boolean, p_every_sign_in boolean)
returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_changed boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, private.jwt_session_id()) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_new_device is null or p_every_sign_in is null then
      raise exception 'invalid preferences' using errcode = '22023';
    end if;
    select (p.new_device, p.every_sign_in) is distinct from (p_new_device, p_every_sign_in)
      into v_changed
      from (select 1) one
      left join private.security_alert_preferences p on p.user_id = v_user_id;
    if not coalesce(v_changed, true) then
      return;
    end if;
    -- An absent row means the defaults; storing the defaults is not a change.
    if not exists (select 1 from private.security_alert_preferences p where p.user_id = v_user_id)
       and p_new_device and not p_every_sign_in then
      return;
    end if;
    insert into private.security_alert_preferences (user_id, new_device, every_sign_in)
      values (v_user_id, p_new_device, p_every_sign_in)
      on conflict (user_id) do update
        set new_device = excluded.new_device, every_sign_in = excluded.every_sign_in,
            updated_at = pg_catalog.now();
    perform private.record_security_event(v_user_id, 'security_alerts_changed', private.jwt_session_id());
  end
  $$;

revoke all on function public.set_security_alert_preferences(boolean, boolean) from public, anon;
grant execute on function public.set_security_alert_preferences(boolean, boolean) to authenticated;

-- Sign-in sweep ----------------------------------------------------------------------------------------

-- How long a sign-in may wait for its two-factor step before it counts as unfinished.
create function private.second_step_wait() returns interval
  language sql immutable set search_path = '' as $$ select interval '15 minutes' $$;

-- What a sign-in alert carries: coarse device labels only (no identifier, address or location).
create function private.sign_in_alert_params(p_device_kind text, p_browser text, p_platform text)
returns jsonb
  language sql immutable set search_path = '' as $$
    select pg_catalog.jsonb_build_object('device', p_device_kind, 'browser', p_browser, 'platform', p_platform)
  $$;

-- Classifies settled sign-ins (service role; the 5-minute outbox job calls it). A sign-in whose
-- session was used to re-authenticate is left out of the person's history and never alerts. The
-- others become Security entries; a sign-in from a device (kind, browser, platform) not seen in
-- the last 12 months alerts when "new device" is on, any sign-in when "every sign-in" is on. The
-- account's very first sign-in never alerts. A sign-in that entered the right password (or Google)
-- but never completed two-factor verification is shown as an unfinished, blocked sign-in and
-- always alerts, whatever the routine choices (spec: credible suspicious activity is mandatory);
-- it waits up to 15 minutes for the second step while its session is still live. Returns how many
-- were classified.
create function public.process_sign_in_events(p_limit integer default 200)
returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_event record;
    v_count integer := 0;
    v_seen_any boolean;
    v_new_device boolean;
    v_prefs record;
    v_alert text;
    v_unfinished boolean;
  begin
    for v_event in
      select e.* from private.account_security_events e
      where e.kind = 'signed_in' and e.classified_at is null
        and e.created_at <= pg_catalog.now() - private.sign_in_settle_time()
        and not (
          e.second_step_needed and e.second_step_at is null
          and e.created_at > pg_catalog.now() - private.second_step_wait()
          and private.session_is_live(e.user_id, e.session_id)
        )
      order by e.created_at
      limit greatest(1, least(coalesce(p_limit, 200), 1000))
      for update skip locked
    loop
      update private.account_security_events set classified_at = pg_catalog.now()
        where id = v_event.id;
      v_count := v_count + 1;

      if exists (
        select 1 from private.account_security_events r
        where r.user_id = v_event.user_id and r.kind = 'reauthenticated'
          and r.session_id = v_event.session_id
      ) then
        continue;
      end if;

      v_unfinished := v_event.second_step_needed and v_event.second_step_at is null
        and not exists (
          select 1 from private.account_security_events r
          where r.user_id = v_event.user_id and r.kind = 'recovery_code_used'
            and r.session_id = v_event.session_id
        );
      if v_unfinished then
        insert into private.account_activity_events
            (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
             source_event_id, alerted, created_at)
          values (v_event.user_id, 'security', 'sign_in_unfinished', 'blocked', 'self',
                  v_event.device_kind, v_event.browser, v_event.platform, v_event.session_id,
                  v_event.id, true, v_event.created_at)
          on conflict (source_event_id) do nothing;
        perform private.notify_user(
          v_event.user_id, null, 'security', 'account.unfinished_sign_in',
          private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
          'account.unfinished_sign_in:' || v_event.id::text, true);
        continue;
      end if;

      select exists (
        select 1 from private.account_activity_events a
        where a.user_id = v_event.user_id and a.kind = 'signed_in' and a.category = 'security'
      ) into v_seen_any;
      select not exists (
        select 1 from private.account_activity_events a
        where a.user_id = v_event.user_id and a.kind = 'signed_in' and a.category = 'security'
          and a.created_at > pg_catalog.now() - private.activity_retention()
          and a.device_kind is not distinct from v_event.device_kind
          and a.browser is not distinct from v_event.browser
          and a.platform is not distinct from v_event.platform
      ) into v_new_device;

      select coalesce(p.new_device, true) as new_device, coalesce(p.every_sign_in, false) as every_sign_in
        into v_prefs
        from (select 1) one
        left join private.security_alert_preferences p on p.user_id = v_event.user_id;

      v_alert := null;
      if v_seen_any then
        if v_new_device and v_prefs.new_device then
          v_alert := 'account.new_device_sign_in';
        elsif v_prefs.every_sign_in then
          v_alert := 'account.signed_in';
        end if;
      end if;

      insert into private.account_activity_events
          (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
           source_event_id, alerted, created_at)
        values (v_event.user_id, 'security', 'signed_in', 'completed', 'self', v_event.device_kind,
                v_event.browser, v_event.platform, v_event.session_id, v_event.id,
                v_alert is not null, v_event.created_at)
        on conflict (source_event_id) do nothing;

      if v_alert = 'account.new_device_sign_in' then
        perform private.notify_user(
          v_event.user_id, null, 'security', 'account.new_device_sign_in',
          private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
          'account.new_device_sign_in:' || v_event.id::text, true);
      elsif v_alert = 'account.signed_in' then
        perform private.notify_user(
          v_event.user_id, null, 'security', 'account.signed_in',
          private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
          'account.signed_in:' || v_event.id::text, true);
      end if;
    end loop;
    return v_count;
  end
  $$;

revoke all on function public.process_sign_in_events(integer) from public, anon, authenticated;
grant execute on function public.process_sign_in_events(integer) to service_role;

-- Home memberships, join requests, transfers, recoveries (from the Home audit trail) -----------------

create function private.activity_from_audit() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_action text := new.action;
    v_suffix text := pg_catalog.split_part(new.action, '.', 2);
    v_row record;
    v_user uuid;
    v_outcome text;
  begin
    begin
      if v_action in ('home_membership.created', 'home_membership.role_changed',
                      'home_membership.ended', 'home_membership.capabilities_changed')
         and new.subject_id is not null then
        perform private.record_account_activity(
          new.subject_id, 'home_memberships',
          case v_action
            when 'home_membership.created' then 'home_membership.joined'
            when 'home_membership.role_changed' then 'home_membership.role_changed'
            when 'home_membership.capabilities_changed' then 'home_membership.permissions_changed'
            else case when new.actor_user_id = new.subject_id
                      then 'home_membership.left' else 'home_membership.removed' end
          end,
          'completed', new.home_id,
          private.activity_actor(new.subject_id, new.actor_user_id, 'home_manager'),
          case when v_action = 'home_membership.role_changed' then
            pg_catalog.jsonb_build_object('from', new.details ->> 'from', 'to', new.details ->> 'to')
          else '{}'::jsonb end);

      elsif v_action like 'join_request.%' and v_suffix in ('created', 'approved', 'declined', 'withdrawn', 'expired') then
        select r.applicant_id into v_user from private.home_join_requests r where r.id = new.subject_id;
        perform private.record_account_activity(
          v_user, 'home_memberships', 'join_request',
          case v_suffix when 'created' then 'pending' when 'approved' then 'completed'
                        when 'declined' then 'declined' when 'withdrawn' then 'cancelled'
                        else 'expired' end,
          new.home_id, private.activity_actor(v_user, new.actor_user_id, 'home_manager'));

      elsif v_action in ('invitation.created', 'invitation.revoked', 'invitation.renewed', 'invitation.resent') then
        -- Recipient-specific email invitations only, to the account that owns that verified address.
        select u.id into v_user
          from private.home_invitations i
          join auth.users u on pg_catalog.lower(u.email) = i.recipient_email
                           and u.email_confirmed_at is not null
          where i.id = new.subject_id and i.kind = 'email'
          limit 1;
        perform private.record_account_activity(
          v_user, 'home_memberships', 'invitation',
          case when v_suffix = 'revoked' then 'cancelled' else 'pending' end,
          new.home_id, private.activity_actor(v_user, new.actor_user_id, 'home_manager'));

      elsif v_action like 'home_ownership.transfer_%' then
        select t.from_user_id, t.to_user_id into v_row
          from private.home_ownership_transfers t where t.id = new.subject_id;
        v_outcome := case v_action
          when 'home_ownership.transfer_started' then 'pending'
          when 'home_ownership.transfer_accepted' then 'completed'
          when 'home_ownership.transfer_declined' then 'declined'
          when 'home_ownership.transfer_cancelled' then 'cancelled'
          when 'home_ownership.transfer_expired' then 'expired'
          else 'failed' end;
        if v_row.from_user_id is not null then
          perform private.record_account_activity(
            v_row.from_user_id, 'home_memberships', 'home_ownership.transfer', v_outcome, new.home_id,
            private.activity_actor(v_row.from_user_id, new.actor_user_id, 'home_member'));
          perform private.record_account_activity(
            v_row.to_user_id, 'home_memberships', 'home_ownership.transfer', v_outcome, new.home_id,
            private.activity_actor(v_row.to_user_id, new.actor_user_id, 'home_manager'));
        end if;

      elsif v_action in ('ownership_recovery.requested', 'ownership_recovery.completed',
                         'ownership_recovery.withdrawn', 'ownership_recovery.cancelled_by_owner',
                         'ownership_recovery.owner_returned', 'ownership_recovery.invalid',
                         'ownership_recovery.staff_reject') then
        -- Exceptional ownership recovery affecting this account (spec: shown with security
        -- activity, without the other party's evidence or identity).
        select c.claimant_id, c.owner_id into v_row
          from private.home_ownership_recoveries c where c.id = new.subject_id;
        v_outcome := case v_suffix
          when 'requested' then 'pending'
          when 'completed' then 'completed'
          when 'staff_reject' then 'declined'
          when 'invalid' then 'failed'
          else 'cancelled' end;
        if v_row.claimant_id is not null then
          perform private.record_account_activity(
            v_row.owner_id, 'security', 'ownership_recovery', v_outcome, new.home_id,
            private.activity_actor(v_row.owner_id, new.actor_user_id, 'home_member'));
          perform private.record_account_activity(
            v_row.claimant_id, 'security', 'ownership_recovery', v_outcome, new.home_id,
            private.activity_actor(v_row.claimant_id, new.actor_user_id, 'home_member'));
        end if;
      end if;
    exception when others then
      raise warning 'madeora: membership activity not recorded (%)', sqlstate;
    end;
    return null;
  end
  $$;

create trigger madeora_activity_from_audit
  after insert on private.audit_events
  for each row execute function private.activity_from_audit();

-- Profile -------------------------------------------------------------------------------------------

create function private.activity_from_account_profile() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_actor text := private.activity_actor(new.user_id, auth.uid(), 'automatic');
  begin
    if new.display_name is distinct from (case when tg_op = 'UPDATE' then old.display_name end) then
      perform private.record_account_activity(new.user_id, 'profile', 'profile.name_changed', 'completed', null, v_actor);
    end if;
    if new.accent_color is distinct from (case when tg_op = 'UPDATE' then old.accent_color end) then
      perform private.record_account_activity(new.user_id, 'profile', 'profile.accent_changed', 'completed', null, v_actor);
    end if;
    if new.avatar_file_id is distinct from (case when tg_op = 'UPDATE' then old.avatar_file_id end) then
      perform private.record_account_activity(new.user_id, 'profile', 'profile.avatar_changed', 'completed', null, v_actor);
    end if;
    return null;
  end
  $$;

create trigger madeora_activity_from_account_profile
  after insert or update of display_name, accent_color, avatar_file_id on public.user_preferences
  for each row execute function private.activity_from_account_profile();

create function private.activity_from_home_profile() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_actor text := private.activity_actor(new.user_id, auth.uid(), 'home_manager');
  begin
    if (new.nickname, new.display_name) is distinct from
       (case when tg_op = 'UPDATE' then (old.nickname, old.display_name) end) then
      perform private.record_account_activity(new.user_id, 'profile', 'profile.home_name_changed', 'completed', new.home_id, v_actor);
    end if;
    if new.accent_color is distinct from (case when tg_op = 'UPDATE' then old.accent_color end) then
      perform private.record_account_activity(new.user_id, 'profile', 'profile.home_accent_changed', 'completed', new.home_id, v_actor);
    end if;
    if new.avatar_file_id is distinct from (case when tg_op = 'UPDATE' then old.avatar_file_id end) then
      perform private.record_account_activity(new.user_id, 'profile', 'profile.home_avatar_changed', 'completed', new.home_id, v_actor);
    end if;
    return null;
  end
  $$;

create trigger madeora_activity_from_home_profile
  after insert or update of nickname, display_name, accent_color, avatar_file_id on public.home_member_profiles
  for each row execute function private.activity_from_home_profile();

-- Integrations (Google Calendar) ----------------------------------------------------------------------

create function private.activity_from_google_connection() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if tg_op = 'INSERT' then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.connected', 'completed');
    elsif tg_op = 'DELETE' then
      perform private.record_account_activity(old.user_id, 'integrations', 'google_calendar.disconnected', 'completed',
        null, private.activity_actor(old.user_id, auth.uid(), 'automatic'));
    elsif new.status = 'authorization_expired' and old.status <> 'authorization_expired' then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.authorization_expired', 'failed',
        null, 'automatic');
    elsif new.connected_at is distinct from old.connected_at then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.reconnected', 'completed');
    end if;
    return null;
  end
  $$;

create trigger madeora_activity_from_google_connection
  after insert or update of status, connected_at or delete on private.google_calendar_connections
  for each row execute function private.activity_from_google_connection();

create function private.activity_from_google_share() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if tg_op = 'INSERT' then
      perform private.record_account_activity(new.user_id, 'integrations', 'google_calendar.shared', 'completed', new.home_id);
    elsif exists (
      -- Not when the share ends because the membership did: that has its own entry.
      select 1 from public.home_memberships m where m.home_id = old.home_id and m.user_id = old.user_id
    ) then
      perform private.record_account_activity(old.user_id, 'integrations', 'google_calendar.unshared', 'completed',
        old.home_id, private.activity_actor(old.user_id, auth.uid(), 'automatic'));
    end if;
    return null;
  end
  $$;

create trigger madeora_activity_from_google_share
  after insert or delete on private.google_calendar_home_shares
  for each row execute function private.activity_from_google_share();

-- A connection attempt that failed before anything was saved (Google refused, or the person
-- cancelled): recorded by the OAuth callback with the person's own session. At most one a minute.
create function public.record_integration_failure(p_provider text) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_provider is null or p_provider not in ('google_calendar') then
      raise exception 'unknown provider' using errcode = '22023';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if exists (
      select 1 from private.account_activity_events a
      where a.user_id = v_user_id and a.kind = p_provider || '.connect_failed'
        and a.created_at > pg_catalog.now() - interval '1 minute'
    ) then
      return;
    end if;
    perform private.record_account_activity(v_user_id, 'integrations', p_provider || '.connect_failed', 'failed');
  end
  $$;

revoke all on function public.record_integration_failure(text) from public, anon;
grant execute on function public.record_integration_failure(text) to authenticated;

-- Reading ---------------------------------------------------------------------------------------------

-- The signed-in account's own history, newest first, in pages (keyset: pass the last row's
-- created_at and id). Filters: categories, outcomes, a time range [p_from, p_to), one Home. Search:
-- p_kinds are the kinds whose label (in the reader's language) matches the query, p_text matches the
-- Home-name snapshot; either matching is enough. Nothing older than the retention period.
create function public.list_my_activity(
  p_categories text[] default null,
  p_outcomes text[] default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_home_id uuid default null,
  p_kinds text[] default null,
  p_text text default null,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  category text,
  kind text,
  outcome text,
  home_id uuid,
  home_name text,
  is_current_member boolean,
  actor text,
  details jsonb,
  device_kind text,
  browser text,
  platform text,
  is_current_session boolean,
  session_live boolean,
  alerted boolean,
  response text,
  created_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_text text := nullif(pg_catalog.btrim(p_text), '');
    v_search boolean := p_kinds is not null or nullif(pg_catalog.btrim(p_text), '') is not null;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, private.jwt_session_id()) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if v_text is not null and pg_catalog.char_length(v_text) > 100 then
      raise exception 'query too long' using errcode = '22023';
    end if;
    if (p_before_created_at is null) <> (p_before_id is null) then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    return query
      select a.id, a.category, a.kind, a.outcome, a.home_id, a.home_name,
             a.home_id is not null and exists (
               select 1 from public.home_memberships m where m.home_id = a.home_id and m.user_id = v_user_id
             ),
             a.actor, a.details, a.device_kind, a.browser, a.platform,
             a.session_id is not null and a.session_id = private.jwt_session_id(),
             a.session_id is not null and private.session_is_live(v_user_id, a.session_id),
             a.alerted, a.response, a.created_at
      from private.account_activity_events a
      where a.user_id = v_user_id
        and a.created_at > pg_catalog.now() - private.activity_retention()
        and (p_categories is null or a.category = any (p_categories))
        and (p_outcomes is null or a.outcome = any (p_outcomes))
        and (p_from is null or a.created_at >= p_from)
        and (p_to is null or a.created_at < p_to)
        and (p_home_id is null or a.home_id = p_home_id)
        and (not v_search
             or a.kind = any (coalesce(p_kinds, array[]::text[]))
             or (v_text is not null and a.home_name ilike
                 '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
        and (p_before_created_at is null
             or (a.created_at, a.id) < (p_before_created_at, p_before_id))
      order by a.created_at desc, a.id desc
      limit greatest(1, least(coalesce(p_limit, 50), 100));
  end
  $$;

revoke all on function public.list_my_activity(text[], text[], timestamptz, timestamptz, uuid, text[], text, timestamptz, uuid, integer) from public, anon;
grant execute on function public.list_my_activity(text[], text[], timestamptz, timestamptz, uuid, text[], text, timestamptz, uuid, integer) to authenticated;

-- The Homes that appear in the person's own history (for the Home filter), with the latest name
-- recorded there.
create function public.list_my_activity_homes()
returns table (home_id uuid, home_name text)
  language sql stable security definer set search_path = '' as $$
    select distinct on (a.home_id) a.home_id, a.home_name
    from private.account_activity_events a
    where a.user_id = auth.uid() and a.home_id is not null
      and a.created_at > pg_catalog.now() - private.activity_retention()
      and private.session_is_live(auth.uid(), private.jwt_session_id())
    order by a.home_id, a.created_at desc
  $$;

revoke all on function public.list_my_activity_homes() from public, anon;
grant execute on function public.list_my_activity_homes() to authenticated;

-- "This was me" / "Secure my account" on one of the person's own sign-ins. Securing signs that
-- session out (when it is another, still-live session) and records a suspicious-session report.
-- Returns 'confirmed', 'signed_out' (reported and signed out) or 'reported'.
create function public.respond_to_sign_in(p_event_id uuid, p_response text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_current uuid := private.jwt_session_id();
    v_event private.account_activity_events;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_current) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_response is null or p_response not in ('confirmed', 'reported') then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    select * into v_event from private.account_activity_events a
      where a.id = p_event_id and a.user_id = v_user_id
        and a.kind in ('signed_in', 'sign_in_unfinished')
        and a.created_at > pg_catalog.now() - private.activity_retention()
      for update;
    if v_event.id is null then
      raise exception 'unknown sign-in' using errcode = 'P0002';
    end if;
    update private.account_activity_events a
      set response = p_response, responded_at = pg_catalog.now()
      where a.id = v_event.id;
    if p_response = 'confirmed' then
      return 'confirmed';
    end if;
    if v_event.session_id is not null and v_event.session_id <> v_current
       and private.session_is_live(v_user_id, v_event.session_id)
       and public.revoke_my_session(v_event.session_id, true) then
      return 'signed_out';
    end if;
    perform private.record_security_event(v_user_id, 'session_reported', v_event.session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.session_reported', '{}'::jsonb,
      'account.session_reported:' || coalesce(v_event.session_id, v_event.id)::text, true);
    return 'reported';
  end
  $$;

revoke all on function public.respond_to_sign_in(uuid, text) from public, anon;
grant execute on function public.respond_to_sign_in(uuid, text) to authenticated;

-- The person's recent security notices with their delivery state (queued or sent is not proof of
-- receipt; the page says so).
create function public.list_my_security_notices(p_limit integer default 10)
returns table (id uuid, kind text, email_status text, created_at timestamptz)
  language sql stable security definer set search_path = '' as $$
    select n.id, n.kind, n.email_status, n.created_at
    from public.notifications n
    where n.user_id = auth.uid() and n.category = 'security'
      and private.session_is_live(auth.uid(), private.jwt_session_id())
    order by n.created_at desc, n.id desc
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  $$;

revoke all on function public.list_my_security_notices(integer) from public, anon;
grant execute on function public.list_my_security_notices(integer) to authenticated;

-- Security report ---------------------------------------------------------------------------------------

alter table private.account_change_grants drop constraint account_change_grants_action_check;
alter table private.account_change_grants
  add constraint account_change_grants_action_check check (action in (
    'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
    'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account'
  ));

-- As S37, with two more actions: 'security_report' (request and download a security report) and
-- 'deactivate_account' (temporary deactivation).
create or replace function public.authorize_account_change(p_action text, p_session_id uuid)
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
      'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account'
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

-- Whether p_user_id holds a still-valid permission for p_action bound to p_session_id, without
-- using it up: a report permission covers the request and the downloads in the minutes after it.
create function private.has_account_change_grant(p_user_id uuid, p_action text, p_session_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1 from private.account_change_grants g
      where g.user_id = p_user_id and g.action = p_action and g.session_id = p_session_id
        and g.expires_at > pg_catalog.now()
    )
  $$;

create table private.security_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Local calendar dates in p_timezone, inclusive.
  range_from date not null,
  range_to date not null,
  timezone text not null constraint security_reports_timezone_check check (char_length(timezone) <= 64),
  -- Nothing at or after this instant is included (the request itself included).
  snapshot_at timestamptz not null,
  expires_at timestamptz not null,
  discarded_at timestamptz,
  downloaded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint security_reports_range_check check (range_from <= range_to)
);

create index security_reports_user_idx on private.security_reports (user_id, created_at desc);

revoke all on table private.security_reports from public;

comment on table private.security_reports is
  'S38: requested security reports (a frozen snapshot; the file is built at download, never stored).';

create function private.report_status(p_report private.security_reports) returns text
  language sql stable set search_path = '' as $$
    select case
      when p_report.discarded_at is not null then 'discarded'
      when p_report.expires_at <= pg_catalog.now() then 'expired'
      else 'ready' end
  $$;

-- Requests a report of the account's security events between two local dates (inclusive) in
-- p_timezone, within the retention period. Needs the 'security_report' permission (S37
-- re-authentication) of this session. At most 3 a day. Returns the report id.
create function public.request_security_report(p_from date, p_to date, p_timezone text)
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_today date;
    v_earliest date;
    v_id uuid;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_timezone is null or pg_catalog.char_length(p_timezone) > 64
       or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
      raise exception 'invalid timezone' using errcode = '22023';
    end if;
    v_today := (pg_catalog.now() at time zone p_timezone)::date;
    v_earliest := ((pg_catalog.now() - private.activity_retention()) at time zone p_timezone)::date;
    if p_from is null or p_to is null or p_from > p_to or p_from < v_earliest or p_to > v_today then
      raise exception 'invalid range' using errcode = '22023';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.has_account_change_grant(v_user_id, 'security_report', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if (select pg_catalog.count(*) from private.security_reports r
        where r.user_id = v_user_id and r.created_at > pg_catalog.now() - interval '24 hours')
       >= private.security_report_daily_limit() then
      raise exception 'too many reports' using errcode = '54000', hint = 'rate_limited';
    end if;
    -- clock_timestamp: the snapshot is fixed before the request is recorded, so the report never
    -- contains its own request.
    insert into private.security_reports (user_id, range_from, range_to, timezone, snapshot_at, expires_at)
      values (v_user_id, p_from, p_to, p_timezone, pg_catalog.clock_timestamp(),
              pg_catalog.now() + private.security_report_lifetime())
      returning id into v_id;
    insert into private.account_security_events (user_id, kind, session_id, created_at)
      values (v_user_id, 'security_report_requested', v_session_id, pg_catalog.clock_timestamp());
    perform private.notify_user(
      v_user_id, null, 'security', 'account.security_report_ready', '{}'::jsonb,
      'account.security_report_ready:' || v_id::text, true);
    return v_id;
  end
  $$;

revoke all on function public.request_security_report(date, date, text) from public, anon;
grant execute on function public.request_security_report(date, date, text) to authenticated;

create function public.list_my_security_reports()
returns table (
  id uuid, range_from date, range_to date, timezone text, snapshot_at timestamptz,
  expires_at timestamptz, status text, downloaded_at timestamptz, created_at timestamptz
)
  language sql stable security definer set search_path = '' as $$
    select r.id, r.range_from, r.range_to, r.timezone, r.snapshot_at, r.expires_at,
           private.report_status(r), r.downloaded_at, r.created_at
    from private.security_reports r
    where r.user_id = auth.uid()
      and private.session_is_live(auth.uid(), private.jwt_session_id())
      and r.created_at > pg_catalog.now() - interval '7 days'
    order by r.created_at desc
    limit 10
  $$;

revoke all on function public.list_my_security_reports() from public, anon;
grant execute on function public.list_my_security_reports() to authenticated;

create function public.discard_security_report(p_report_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_found boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, private.jwt_session_id()) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update private.security_reports r set discarded_at = pg_catalog.now()
      where r.id = p_report_id and r.user_id = v_user_id and r.discarded_at is null
        and r.expires_at > pg_catalog.now()
      returning true into v_found;
    if coalesce(v_found, false) then
      perform private.record_security_event(v_user_id, 'security_report_discarded', private.jwt_session_id());
    end if;
    return coalesce(v_found, false);
  end
  $$;

revoke all on function public.discard_security_report(uuid) from public, anon;
grant execute on function public.discard_security_report(uuid) to authenticated;

-- The rows of one ready report, for the download (the app builds CSV or JSON from them). Checks
-- again: the caller's own, ready report; a live session; this session's fresh 'security_report'
-- permission. Security events only, between the range's local dates, before the snapshot, within
-- retention. Records the download (after the snapshot, so later reports include it).
create function public.security_report_rows(p_report_id uuid)
returns table (
  kind text, outcome text, home_name text, actor text, device_kind text, browser text,
  platform text, created_at timestamptz
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_report private.security_reports;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    select * into v_report from private.security_reports r
      where r.id = p_report_id and r.user_id = v_user_id;
    if v_report.id is null or private.report_status(v_report) <> 'ready' then
      raise exception 'report not available' using errcode = 'P0002';
    end if;
    if not private.has_account_change_grant(v_user_id, 'security_report', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    update private.security_reports r set downloaded_at = pg_catalog.now() where r.id = v_report.id;
    -- clock_timestamp: always after the snapshot, even inside the request's own transaction.
    insert into private.account_security_events (user_id, kind, session_id, created_at)
      values (v_user_id, 'security_report_downloaded', v_session_id, pg_catalog.clock_timestamp());
    return query
      select a.kind, a.outcome, a.home_name, a.actor, a.device_kind, a.browser, a.platform, a.created_at
      from private.account_activity_events a
      where a.user_id = v_user_id and a.category = 'security'
        and a.created_at >= (v_report.range_from::timestamp at time zone v_report.timezone)
        and a.created_at < ((v_report.range_to + 1)::timestamp at time zone v_report.timezone)
        and a.created_at < v_report.snapshot_at
        and a.created_at > pg_catalog.now() - private.activity_retention()
      order by a.created_at, a.id;
  end
  $$;

revoke all on function public.security_report_rows(uuid) from public, anon;
grant execute on function public.security_report_rows(uuid) to authenticated;

-- Retention -------------------------------------------------------------------------------------------

-- Removes history and security events past the retention period, and report records a week after
-- they expired (service role; the hourly job calls it). Returns how many history rows went.
create function public.purge_account_activity() returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    delete from private.account_activity_events a
      where a.created_at < pg_catalog.now() - private.activity_retention();
    get diagnostics v_count = row_count;
    delete from private.account_security_events e
      where e.created_at < pg_catalog.now() - private.activity_retention();
    delete from private.security_reports r
      where r.expires_at < pg_catalog.now() - interval '7 days';
    return v_count;
  end
  $$;

revoke all on function public.purge_account_activity() from public, anon, authenticated;
grant execute on function public.purge_account_activity() to service_role;
