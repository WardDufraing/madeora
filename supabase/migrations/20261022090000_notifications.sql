-- S14: notifications core (brief S14; spec "Confirmed global adult notification defaults with
-- per-Home overrides", "Confirmed verified Home ownership recovery"; architecture.md §39, §11).
--
-- * public.notifications: the in-app store, one row per account and event. A person reads their own
--   rows (RLS, and only while they still belong to the notification's Home); nobody writes them
--   through the API. In-app delivery is a row written in the business transaction, so it never
--   depends on email.
-- * public.notification_preferences / public.notification_quiet_hours: global defaults (home_id
--   null) and per-Home overrides. A missing Home row means "inherited"; reset deletes it.
-- * private.notify_user(): the one delivery function. It re-checks the recipient and membership,
--   resolves the effective choice now, stores the notification (deduplicated) and, in the same
--   transaction, enqueues the email job in the S13 outbox. Essential security notices cannot be
--   switched off or deferred.
-- * Triggers on ownership-recovery cases and join requests call it; a trigger and
--   private.prepare_invitation_email enqueue invitation emails.
-- * service_role-only functions give the Trigger.dev jobs exactly what they need (an address, a
--   template's inputs) and record outcomes. The jobs hold the service key, so they never touch a
--   table directly (ADR 0017).
--
-- Quiet hours defer optional email to the end of the window. Nothing else is silenced: there is no
-- push channel yet, and in-app notifications always appear (marked as arrived during quiet hours).

-- Categories ------------------------------------------------------------------------------------------

-- Whether a category is essential (true), optional (false), or unknown (null). Essential messages
-- (account recovery and ownership recovery, spec) ignore muting, opt-outs and quiet hours.
create function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category when 'security' then true when 'invitations' then false end;
  $$;

-- The store -----------------------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The source Home; null for notices about the account or about a Home the person is not (yet) in.
  home_id uuid references public.homes (id) on delete cascade,
  category text not null constraint notifications_category_check
    check (category in ('security', 'invitations')),
  -- What happened, as a code the app turns into words in the reader's language.
  kind text not null constraint notifications_kind_check
    check (kind ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and char_length(kind) <= 64),
  -- Ids, dates and codes only: never names, free text or evidence.
  params jsonb not null default '{}' constraint notifications_params_check
    check (jsonb_typeof(params) = 'object' and pg_column_size(params) <= 2048),
  -- Names the event; one notification per account and key, however often delivery is attempted.
  dedupe_key text not null constraint notifications_dedupe_key_check
    check (dedupe_key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  -- False when the person turned the in-app channel off for this category: the row then only
  -- carries the email's state.
  show_in_app boolean not null,
  during_quiet_hours boolean not null default false,
  email_status text not null default 'none' constraint notifications_email_status_check
    check (email_status in ('none', 'queued', 'sent', 'failed', 'skipped', 'not_configured')),
  email_error_code text constraint notifications_email_error_code_check
    check (email_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  -- A random UUID v4 (S13): the same id appears in the job's logs.
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_dedupe unique (user_id, dedupe_key)
);

comment on table public.notifications is
  'In-app notifications, one row per account and event (S14). Written only by private.notify_user.';

create index notifications_inbox_idx on public.notifications (user_id, created_at desc)
  where show_in_app;
create index notifications_unread_idx on public.notifications (user_id) where show_in_app and read_at is null;
create index notifications_home_idx on public.notifications (home_id) where home_id is not null;

alter table public.notifications enable row level security;
revoke all on table public.notifications from anon, authenticated;
-- No email state, error code or correlation id for the API: the person sees the notice itself.
grant select (id, home_id, category, kind, params, during_quiet_hours, created_at, read_at)
  on table public.notifications to authenticated;

-- Own rows, and Home notices only while still a member (spec: revoked membership).
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and show_in_app
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = notifications.home_id and m.user_id = (select auth.uid())
      )
    )
  );

-- Preferences ---------------------------------------------------------------------------------------

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Null: the account-wide default. Set: an override for this Home only.
  home_id uuid references public.homes (id) on delete cascade,
  -- Optional categories only; essential ones cannot be configured.
  category text not null constraint notification_preferences_category_check
    check (category in ('invitations')),
  channel text not null constraint notification_preferences_channel_check
    check (channel in ('in_app', 'email')),
  enabled boolean not null,
  updated_at timestamptz not null default now()
);

create unique index notification_preferences_global_key
  on public.notification_preferences (user_id, category, channel) where home_id is null;
create unique index notification_preferences_home_key
  on public.notification_preferences (user_id, home_id, category, channel) where home_id is not null;

alter table public.notification_preferences enable row level security;
revoke all on table public.notification_preferences from anon, authenticated;
grant select on table public.notification_preferences to authenticated;
create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated using (user_id = (select auth.uid()));

create table public.notification_quiet_hours (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  home_id uuid references public.homes (id) on delete cascade,
  -- A Home row with enabled = false turns quiet hours off for that Home although the account has some.
  enabled boolean not null,
  start_time time not null,
  end_time time not null,
  -- Wall-clock times in this IANA zone, so the database never has to guess a device zone.
  time_zone text not null constraint notification_quiet_hours_zone_check
    check (char_length(time_zone) <= 64
      and time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  updated_at timestamptz not null default now(),
  constraint notification_quiet_hours_window_check check (start_time <> end_time)
);

create unique index notification_quiet_hours_global_key
  on public.notification_quiet_hours (user_id) where home_id is null;
create unique index notification_quiet_hours_home_key
  on public.notification_quiet_hours (user_id, home_id) where home_id is not null;

alter table public.notification_quiet_hours enable row level security;
revoke all on table public.notification_quiet_hours from anon, authenticated;
grant select on table public.notification_quiet_hours to authenticated;
create policy notification_quiet_hours_select_own on public.notification_quiet_hours
  for select to authenticated using (user_id = (select auth.uid()));

-- Leaving or being removed from a Home ends the person's overrides there, so a later rejoin
-- starts from the account defaults (spec: no stale Home settings).
create function private.drop_home_notification_settings() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from public.notification_preferences p
      where p.user_id = old.user_id and p.home_id = old.home_id;
    delete from public.notification_quiet_hours q
      where q.user_id = old.user_id and q.home_id = old.home_id;
    return null;
  end
  $$;

create trigger home_memberships_drop_notification_settings
  after delete on public.home_memberships
  for each row execute function private.drop_home_notification_settings();

-- Resolution (the single source of truth for what is effective) -----------------------------------

-- The effective choice for one category and channel in one Home (null: no Home context, so only
-- the account defaults apply): essential first, then the Home override, then the account default,
-- then the built-in default (in-app on, email off: email is opt-in).
create function private.effective_notification_channel(
  p_user_id uuid, p_home_id uuid, p_category text, p_channel text
) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_value boolean;
  begin
    if private.notification_category_essential(p_category) then
      return true;
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
    return p_channel = 'in_app';
  end
  $$;

-- Whether p_at falls in the person's quiet hours for this Home, and when that window ends. The
-- Home's own row wins (also when it turns quiet hours off); otherwise the account row.
create function private.notification_quiet_state(p_user_id uuid, p_home_id uuid, p_at timestamptz)
returns table (quiet boolean, ends_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_row public.notification_quiet_hours;
    v_local timestamp;
    v_time time;
    v_end_local timestamp;
  begin
    if p_home_id is not null then
      select * into v_row from public.notification_quiet_hours q
        where q.user_id = p_user_id and q.home_id = p_home_id;
    end if;
    if v_row.id is null then
      select * into v_row from public.notification_quiet_hours q
        where q.user_id = p_user_id and q.home_id is null;
    end if;
    if v_row.id is null or not v_row.enabled then
      return query select false, null::timestamptz;
      return;
    end if;
    v_local := p_at at time zone v_row.time_zone;
    v_time := v_local::time;
    if v_row.start_time < v_row.end_time then
      if v_time >= v_row.start_time and v_time < v_row.end_time then
        v_end_local := v_local::date + v_row.end_time;
      end if;
    elsif v_time >= v_row.start_time then
      v_end_local := (v_local::date + 1) + v_row.end_time;
    elsif v_time < v_row.end_time then
      v_end_local := v_local::date + v_row.end_time;
    end if;
    if v_end_local is null then
      return query select false, null::timestamptz;
    else
      return query select true, v_end_local at time zone v_row.time_zone;
    end if;
  end
  $$;

-- Whether an account can receive anything now. Account deactivation (not built yet) will extend
-- this one function.
create function private.can_receive_notifications(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
  );
  $$;

-- The correlation id of the request that is running, when the app forwarded one as the
-- x-correlation-id header (PostgREST exposes request headers); a fresh one otherwise. Only a
-- random UUID v4 is accepted, as the job tables require.
create function private.request_correlation_id() returns uuid
  language plpgsql volatile set search_path = '' as $$
  declare
    v_value text;
  begin
    begin
      v_value := (current_setting('request.headers', true)::jsonb) ->> 'x-correlation-id';
    exception when others then
      v_value := null;
    end;
    if v_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return v_value::uuid;
    end if;
    return gen_random_uuid();
  end
  $$;

-- Delivery ----------------------------------------------------------------------------------------

-- Delivers one notification to one account, inside the caller's transaction. Returns the new
-- notification's id, or null when nothing was delivered (the account cannot receive, it is not in
-- the Home, nothing is enabled, or this event was already delivered). Rules, evaluated now:
--   * a Home notice goes only to a current member of that Home;
--   * in-app and email follow the effective choice for the category and Home; essential
--     categories ignore it;
--   * email also needs p_email (the event may email at all) and a confirmed address;
--   * optional email is deferred to the end of quiet hours; essential email never is;
--   * the email job is enqueued in this transaction, with the notification id as its only payload.
create function private.notify_user(
  p_user_id uuid,
  p_home_id uuid,
  p_category text,
  p_kind text,
  p_params jsonb,
  p_dedupe_key text,
  p_email boolean default false
) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_essential boolean := private.notification_category_essential(p_category);
    v_in_app boolean;
    v_email boolean;
    v_address text;
    v_quiet record;
    v_correlation uuid := private.request_correlation_id();
    v_id uuid;
    v_status text := 'none';
  begin
    -- A programming error (an unknown category) is loud; everything below must never be able to
    -- undo the business change this runs inside, so it is isolated in a sub-transaction.
    if v_essential is null then
      raise exception 'unknown notification category' using errcode = '22023';
    end if;
    begin
      if p_user_id is null or not private.can_receive_notifications(p_user_id) then
        return null;
      end if;
      if p_home_id is not null and private.home_role(p_home_id, p_user_id) is null then
        return null;
      end if;

      v_in_app := private.effective_notification_channel(p_user_id, p_home_id, p_category, 'in_app');
      v_email := p_email
        and private.effective_notification_channel(p_user_id, p_home_id, p_category, 'email');
      v_address := private.confirmed_email(p_user_id);
      if v_email and v_address is null then
        v_email := false;
        v_status := 'skipped';
      end if;
      if not v_in_app and not v_email then
        return null;
      end if;
      if v_email then
        v_status := 'queued';
      end if;

      select * into v_quiet from private.notification_quiet_state(p_user_id, p_home_id, now());

      insert into public.notifications (
        user_id, home_id, category, kind, params, dedupe_key, show_in_app, during_quiet_hours,
        email_status, correlation_id
      ) values (
        p_user_id, p_home_id, p_category, p_kind, coalesce(p_params, '{}'::jsonb), p_dedupe_key,
        v_in_app, v_quiet.quiet, v_status, v_correlation
      )
      on conflict on constraint notifications_dedupe do nothing
      returning id into v_id;
      if v_id is null then
        return null;
      end if;

      if v_email then
        -- In its own sub-transaction: if the outbox cannot take the job, the in-app notice stays
        -- and only the email is marked failed (in-app delivery never depends on email).
        begin
          perform private.enqueue_job(
            'notification-email', 1, 'notification-email:' || v_id::text,
            pg_catalog.jsonb_build_object('notificationId', v_id),
            v_correlation,
            case when not v_essential and v_quiet.quiet then v_quiet.ends_at else now() end
          );
        exception when others then
          update public.notifications n
            set email_status = 'failed', email_error_code = 'enqueue_failed'
            where n.id = v_id;
          raise warning 'notify_user: email job not queued (sqlstate %)', sqlstate;
        end;
      end if;
      return v_id;
    exception when others then
      -- Nothing here may block a security-critical change; the sqlstate is all that is logged.
      raise warning 'notify_user: not delivered (sqlstate %)', sqlstate;
      return null;
    end;
  end
  $$;

-- Tells the person who asked how their case ended. If they are no longer a member of the Home (the
-- reason it ended may be that they left or were removed), a Home notice would be invisible to them,
-- so the notice goes without the Home.
create function private.notify_claimant_ended(
  p_case private.home_ownership_recoveries, p_kind text, p_key text
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    perform private.notify_user(
      p_case.claimant_id,
      case when private.home_role(p_case.home_id, p_case.claimant_id) is null then null
           else p_case.home_id end,
      'security', p_kind, pg_catalog.jsonb_build_object('recoveryId', p_case.id), p_key, true);
  end
  $$;

-- Ownership recovery events (S12b carry-over) ------------------------------------------------------

-- One trigger turns every state change of a recovery case into notifications, in the same
-- transaction as the change, so no path (staff, Owner, claimant, objection, membership change,
-- timeout settling) can change a case unnoticed. What each person learns:
--   the person who asked: where their request stands (in-app and email);
--   the Owner: that a request exists (in-app), and review start and approval (in-app and email);
--   other members: that a review is open, that the objection period began, and that it ended
--     (in-app only); never who asked, nor evidence, objections or staff notes.
-- Keys that can repeat (pause, resume) carry a microsecond timestamp, so each event is its own
-- notification; keys of one-time events do not.
create function private.notify_recovery_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_params jsonb := pg_catalog.jsonb_build_object('recoveryId', new.id);
    v_ends jsonb;
    v_ends_epoch text;
    v_stamp text := pg_catalog.floor(
      pg_catalog.date_part('epoch', pg_catalog.clock_timestamp()) * 1000000)::bigint::text;
    v_prefix text := 'recovery:' || new.id::text || ':';
    v_member uuid;
    v_everyone boolean := false;
  begin
    if tg_op = 'INSERT' then
      perform private.notify_user(new.owner_id, new.home_id, 'security', 'recovery.owner_requested',
        v_params, v_prefix || 'requested:owner');
      for v_member in
        select m.user_id from public.home_memberships m
        where m.home_id = new.home_id and m.user_id not in (new.claimant_id, new.owner_id)
      loop
        perform private.notify_user(v_member, new.home_id, 'security', 'recovery.member_requested',
          v_params, v_prefix || 'requested:' || v_member::text);
      end loop;
      return null;
    end if;

    if new.status is not distinct from old.status
       and new.objection_ends_at is not distinct from old.objection_ends_at then
      return null;
    end if;

    if new.status = 'in_review' and old.status = 'submitted' then
      perform private.notify_user(new.owner_id, new.home_id, 'security', 'recovery.owner_review_started',
        v_params, v_prefix || 'review:owner', true);
      perform private.notify_user(new.claimant_id, new.home_id, 'security',
        'recovery.claimant_review_started', v_params, v_prefix || 'review:claimant', true);

    elsif new.status = 'in_review' and old.status = 'paused' then
      perform private.notify_user(new.claimant_id, new.home_id, 'security',
        'recovery.claimant_resumed', v_params, v_prefix || 'resumed:' || v_stamp, true);

    elsif new.status = 'submitted' and old.status = 'paused' then
      perform private.notify_user(new.claimant_id, new.home_id, 'security',
        'recovery.claimant_resumed', v_params, v_prefix || 'resumed:' || v_stamp, true);

    elsif new.status = 'approved' and new.objection_ends_at is not null then
      v_ends_epoch := pg_catalog.floor(pg_catalog.date_part('epoch', new.objection_ends_at))::bigint::text;
      v_params := v_params || pg_catalog.jsonb_build_object(
        'objectionEndsAt', pg_catalog.to_char(new.objection_ends_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
      perform private.notify_user(new.owner_id, new.home_id, 'security', 'recovery.owner_approved',
        v_params, v_prefix || 'approved:owner:' || v_ends_epoch, true);
      perform private.notify_user(new.claimant_id, new.home_id, 'security',
        'recovery.claimant_approved', v_params, v_prefix || 'approved:claimant:' || v_ends_epoch, true);
      for v_member in
        select m.user_id from public.home_memberships m
        where m.home_id = new.home_id and m.user_id not in (new.claimant_id, new.owner_id)
      loop
        perform private.notify_user(v_member, new.home_id, 'security',
          'recovery.member_objection_open', v_params,
          v_prefix || 'objection:' || v_member::text || ':' || v_ends_epoch);
      end loop;
      -- The person who asked hears when the period is over and they can accept: a job that runs
      -- then and re-checks the case (public.deliver_recovery_ready).
      begin
        perform private.enqueue_job(
          'recovery-ready', 1, 'recovery-ready:' || new.id::text || ':' || v_ends_epoch,
          pg_catalog.jsonb_build_object(
            'recoveryId', new.id,
            'objectionEndsAt', pg_catalog.to_char(new.objection_ends_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
          private.request_correlation_id(), new.objection_ends_at);
      exception when others then
        raise warning 'recovery-ready job not queued (sqlstate %)', sqlstate;
      end;

    elsif new.status = 'paused' and old.status <> 'paused' then
      perform private.notify_user(new.claimant_id, new.home_id, 'security',
        'recovery.claimant_paused', v_params, v_prefix || 'paused:' || v_stamp, true);

    elsif new.status = 'rejected' and old.status <> 'rejected' then
      perform private.notify_claimant_ended(new, 'recovery.claimant_rejected', v_prefix || 'rejected');
      v_everyone := true;

    elsif new.status in ('cancelled', 'owner_returned') and old.status <> new.status then
      perform private.notify_claimant_ended(new, 'recovery.claimant_ended_owner_access',
        v_prefix || 'ended:claimant');
      v_everyone := true;

    elsif new.status = 'invalid' and old.status <> 'invalid' then
      perform private.notify_claimant_ended(new, 'recovery.claimant_invalid', v_prefix || 'invalid');
      v_everyone := true;

    elsif new.status = 'withdrawn' and old.status <> 'withdrawn' then
      v_everyone := true;

    elsif new.status = 'completed' and old.status <> 'completed' then
      perform private.notify_user(new.claimant_id, new.home_id, 'security',
        'recovery.claimant_completed', v_params, v_prefix || 'completed:claimant', true);
      -- A former Owner who is removed from the Home gets a notice without the Home (they will
      -- not belong to it when they read it); one who stays gets the Home's.
      if new.former_owner_outcome = 'removed' then
        perform private.notify_user(new.owner_id, null, 'security',
          'recovery.former_owner_completed_removed', v_params, v_prefix || 'completed:owner', true);
      else
        perform private.notify_user(new.owner_id, new.home_id, 'security',
          'recovery.former_owner_completed', v_params, v_prefix || 'completed:owner', true);
      end if;
      for v_member in
        select m.user_id from public.home_memberships m
        where m.home_id = new.home_id and m.user_id not in (new.claimant_id, new.owner_id)
      loop
        perform private.notify_user(v_member, new.home_id, 'security', 'recovery.member_completed',
          v_params, v_prefix || 'completed:' || v_member::text);
      end loop;
    end if;

    -- Everyone who was told a review was open hears that it ended (not who asked or why).
    if v_everyone then
      for v_member in
        select m.user_id from public.home_memberships m
        where m.home_id = new.home_id and m.user_id not in (new.claimant_id)
      loop
        perform private.notify_user(v_member, new.home_id, 'security', 'recovery.member_ended',
          v_params, v_prefix || 'ended:' || v_member::text);
      end loop;
    end if;
    return null;
  end
  $$;

create trigger home_ownership_recoveries_notify
  after insert or update of status, objection_ends_at on private.home_ownership_recoveries
  for each row execute function private.notify_recovery_change();

-- When the objection period is over, tells the person who asked that they can accept. Called by
-- the recovery-ready job at objection_ends_at, with the end it was queued for: a case that was
-- paused, resumed with a new period, rejected, ended or whose Owner returned in the meantime no
-- longer matches, and nothing is sent. Outcomes: 'notified', 'not_ready' (also when it already was).
create function public.deliver_recovery_ready(p_recovery_id uuid, p_objection_ends_at timestamptz)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_case private.home_ownership_recoveries;
  begin
    select * into v_case from private.home_ownership_recoveries r where r.id = p_recovery_id;
    if not found
       or v_case.status <> 'approved'
       or pg_catalog.date_trunc('second', v_case.objection_ends_at)
         is distinct from pg_catalog.date_trunc('second', p_objection_ends_at)
       or private.recovery_state(v_case) <> 'ready' then
      return 'not_ready';
    end if;
    if private.notify_user(
      v_case.claimant_id, v_case.home_id, 'security', 'recovery.claimant_ready',
      pg_catalog.jsonb_build_object('recoveryId', v_case.id),
      'recovery:' || v_case.id::text || ':ready:' ||
        pg_catalog.floor(pg_catalog.date_part('epoch', p_objection_ends_at))::bigint::text,
      true
    ) is null then
      return 'not_ready';
    end if;
    return 'notified';
  end
  $$;

-- Join request events (optional category "invitations") ---------------------------------------------

-- Managers who can decide a new request are told (in-app by default); the applicant is told the
-- decision. The applicant's notice has no Home: they are not a member when it is declined.
create function private.notify_join_request_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_member uuid;
    v_params jsonb := pg_catalog.jsonb_build_object('requestId', new.id);
  begin
    if tg_op = 'INSERT' then
      if new.status = 'pending' then
        for v_member in
          select m.user_id from public.home_memberships m
          where m.home_id = new.home_id and m.user_id <> new.applicant_id
            and private.can_manage_invitations(new.home_id, m.user_id, new.role)
        loop
          perform private.notify_user(v_member, new.home_id, 'invitations', 'join_request.received',
            v_params, 'join-request:' || new.id::text || ':received:' || v_member::text, true);
        end loop;
      end if;
    elsif old.status = 'pending' and new.status in ('approved', 'declined') then
      perform private.notify_user(new.applicant_id, null, 'invitations', 'join_request.decided',
        v_params || pg_catalog.jsonb_build_object('decision', new.status),
        'join-request:' || new.id::text || ':decided', true);
    end if;
    return null;
  end
  $$;

create trigger home_join_requests_notify
  after insert or update of status on private.home_join_requests
  for each row execute function private.notify_join_request_change();

-- Invitation emails through the outbox (S10 carry-over) -----------------------------------------------

-- Counts the sends of an email invitation: the first send, then every resend and renewal. The job's
-- idempotency key is (invitation, send number), so a retried job never sends a send twice and a
-- superseded send (a newer one exists) is skipped.
alter table private.home_invitations
  add column email_sends integer not null default 0
  constraint home_invitations_email_sends_check check (email_sends >= 0);

-- The first email, enqueued in the transaction that creates the invitation: the send number is set
-- before the row is written, the job is queued once the row exists.
create function private.number_first_invitation_email() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.kind = 'email' then
      new.email_sends := 1;
    end if;
    return new;
  end
  $$;

create function private.enqueue_first_invitation_email() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.kind = 'email' then
      perform private.enqueue_job(
        'invitation-email', 1, 'invitation-email:' || new.id::text || ':1',
        pg_catalog.jsonb_build_object('invitationId', new.id, 'send', 1),
        private.request_correlation_id());
    end if;
    return null;
  end
  $$;

create trigger home_invitations_number_first_email
  before insert on private.home_invitations
  for each row execute function private.number_first_invitation_email();
create trigger home_invitations_enqueue_first_email
  after insert on private.home_invitations
  for each row execute function private.enqueue_first_invitation_email();

-- Resend and renew: as before (S10), and the email is queued in the same transaction instead of
-- being sent by the web request. Same return values as S10.
create function private.prepare_invitation_email_v2(
  p_home_id uuid, p_invitation_id uuid, p_renew boolean
) returns table (outcome text, expires_at timestamptz)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_found record;
    v_inv private.home_invitations;
    v_send integer;
  begin
    select * into v_found from private.invitation_for_manager(p_home_id, p_invitation_id, v_user_id);
    if v_found.o_outcome <> 'ok' then
      return query select v_found.o_outcome, null::timestamptz;
      return;
    end if;
    v_inv := v_found.o_invitation;
    if v_inv.kind <> 'email' then
      return query select 'not_email'::text, null::timestamptz;
      return;
    end if;
    if private.invitation_state(v_inv) <> 'active' then
      return query select 'not_active'::text, null::timestamptz;
      return;
    end if;
    -- The recipient already used it: a manager decides their request instead.
    if exists (
      select 1 from private.home_join_requests r
      where r.invitation_id = v_inv.id and r.status = 'pending'
    ) then
      return query select 'has_request'::text, null::timestamptz;
      return;
    end if;
    if not private.count_invitation_send(v_inv.id, v_user_id) then
      return query select 'rate_limited'::text, null::timestamptz;
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

    update private.home_invitations i set email_sends = i.email_sends + 1
      where i.id = v_inv.id returning i.email_sends into v_send;
    perform private.enqueue_job(
      'invitation-email', 1, 'invitation-email:' || v_inv.id::text || ':' || v_send::text,
      pg_catalog.jsonb_build_object('invitationId', v_inv.id, 'send', v_send),
      private.request_correlation_id());

    return query select 'ok'::text, i.expires_at from private.home_invitations i where i.id = v_inv.id;
  end
  $$;

drop function public.resend_home_invitation(uuid, uuid);
drop function public.renew_home_invitation(uuid, uuid);
drop function private.prepare_invitation_email(uuid, uuid, boolean);
alter function private.prepare_invitation_email_v2(uuid, uuid, boolean)
  rename to prepare_invitation_email;

create function public.resend_home_invitation(p_home_id uuid, p_invitation_id uuid)
returns table (outcome text, expires_at timestamptz)
  language sql security definer set search_path = '' as $$
  select * from private.prepare_invitation_email(p_home_id, p_invitation_id, false);
  $$;

create function public.renew_home_invitation(p_home_id uuid, p_invitation_id uuid)
returns table (outcome text, expires_at timestamptz)
  language sql security definer set search_path = '' as $$
  select * from private.prepare_invitation_email(p_home_id, p_invitation_id, true);
  $$;

-- Only the email job records delivery now; a manager cannot write the status through the API.
drop function public.record_home_invitation_delivery(uuid, uuid, text);

-- Job access (service role only) -------------------------------------------------------------------------

-- What the invitation-email job needs to send send number p_send. Outcomes: 'ok' (the row has the
-- data), 'superseded' (a newer send exists), 'not_active' (revoked, used, expired, or its inviter
-- lost the authority), 'not_found'. The link is read here, at send time, so a payload never holds it.
create function public.get_invitation_email(p_invitation_id uuid, p_send integer)
returns table (
  outcome text, recipient_email text, email_locale text, role text, token text,
  expires_at timestamptz, home_name text, home_time_zone text
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_inv private.home_invitations;
  begin
    select * into v_inv from private.home_invitations i
      where i.id = p_invitation_id and i.kind = 'email';
    if not found then
      return query select 'not_found'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text, null::text;
      return;
    end if;
    if p_send is null or p_send < v_inv.email_sends then
      return query select 'superseded'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text, null::text;
      return;
    end if;
    if private.invitation_state(v_inv) <> 'active' then
      return query select 'not_active'::text, null::text, null::text, null::text, null::text,
        null::timestamptz, null::text, null::text;
      return;
    end if;
    return query
      select 'ok'::text, v_inv.recipient_email, v_inv.email_locale, v_inv.role, v_inv.token,
        v_inv.expires_at, h.name, h.timezone
      from public.homes h where h.id = v_inv.home_id;
  end
  $$;

-- Records what happened to send number p_send; a stale send cannot overwrite a newer one's status.
create function public.record_invitation_email(p_invitation_id uuid, p_send integer, p_status text)
returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_status is null or p_status not in ('sent', 'failed', 'not_configured') then
      raise exception 'invalid delivery status' using errcode = '22023';
    end if;
    update private.home_invitations i set delivery_status = p_status
      where i.id = p_invitation_id and i.kind = 'email' and i.email_sends = p_send;
    return found;
  end
  $$;

-- What the notification-email job needs, re-checked now (the choice, the membership and the
-- address may have changed since the notification was made). Outcomes: 'ok', 'not_found',
-- 'already_done' (not queued any more), 'not_member', 'disabled', 'no_address', 'cannot_receive'.
create function public.get_notification_email(p_notification_id uuid)
returns table (
  outcome text, recipient_email text, locale text, kind text, category text, home_id uuid,
  home_name text, home_time_zone text, params jsonb
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_n public.notifications;
    v_address text;
    v_home public.homes;
    v_locale text;
  begin
    select * into v_n from public.notifications n where n.id = p_notification_id;
    if not found then
      return query select 'not_found'::text, null::text, null::text, null::text, null::text,
        null::uuid, null::text, null::text, null::jsonb;
      return;
    end if;
    if v_n.email_status not in ('queued', 'failed') then
      return query select 'already_done'::text, null::text, null::text, null::text, null::text,
        null::uuid, null::text, null::text, null::jsonb;
      return;
    end if;
    if not private.can_receive_notifications(v_n.user_id) then
      return query select 'cannot_receive'::text, null::text, null::text, null::text, null::text,
        null::uuid, null::text, null::text, null::jsonb;
      return;
    end if;
    if v_n.home_id is not null then
      select * into v_home from public.homes h where h.id = v_n.home_id;
      if private.home_role(v_n.home_id, v_n.user_id) is null then
        return query select 'not_member'::text, null::text, null::text, null::text, null::text,
          null::uuid, null::text, null::text, null::jsonb;
        return;
      end if;
    end if;
    if not private.effective_notification_channel(v_n.user_id, v_n.home_id, v_n.category, 'email') then
      return query select 'disabled'::text, null::text, null::text, null::text, null::text,
        null::uuid, null::text, null::text, null::jsonb;
      return;
    end if;
    v_address := private.confirmed_email(v_n.user_id);
    if v_address is null then
      return query select 'no_address'::text, null::text, null::text, null::text, null::text,
        null::uuid, null::text, null::text, null::jsonb;
      return;
    end if;
    select p.locale into v_locale from public.user_preferences p where p.user_id = v_n.user_id;
    return query
      select 'ok'::text, v_address, coalesce(v_locale, 'en'), v_n.kind, v_n.category, v_n.home_id,
        v_home.name, v_home.timezone, v_n.params;
  end
  $$;

-- Records the email's outcome. Only a queued or failed email changes (a sent one stays sent).
create function public.record_notification_email(
  p_notification_id uuid, p_status text, p_error_code text default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_status is null or p_status not in ('sent', 'failed', 'skipped', 'not_configured') then
      raise exception 'invalid email status' using errcode = '22023';
    end if;
    if p_error_code is not null then
      perform private.check_job_error_code(p_error_code);
    end if;
    update public.notifications n set email_status = p_status, email_error_code = p_error_code
      where n.id = p_notification_id and n.email_status in ('queued', 'failed');
    return found;
  end
  $$;

-- Whether the caller belongs to the Home, holding a share lock on the membership row until the end
-- of the transaction, so a concurrent removal waits for the write that follows and its cleanup
-- trigger then deletes it (no override survives the membership).
create function private.lock_membership(p_home_id uuid, p_user_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    perform 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = p_user_id for share;
    return found;
  end
  $$;

-- Reading and changing your own settings ----------------------------------------------------------------

-- Your settings as they take effect: the account defaults (home_id null) and every Home you belong
-- to, for each optional category and channel, with whether you set it explicitly (overridden) or it
-- is inherited (a Home) or the built-in default (the account row).
create function public.get_notification_settings()
returns table (home_id uuid, category text, channel text, enabled boolean, overridden boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select s.home_id, c.category, ch.channel,
        private.effective_notification_channel(v_user_id, s.home_id, c.category, ch.channel),
        exists (
          select 1 from public.notification_preferences p
          where p.user_id = v_user_id and p.home_id is not distinct from s.home_id
            and p.category = c.category and p.channel = ch.channel
        )
      from (
        select null::uuid as home_id
        union all
        select m.home_id from public.home_memberships m where m.user_id = v_user_id
      ) s
      cross join (values ('invitations')) c (category)
      cross join (values ('in_app'), ('email')) ch (channel)
      order by s.home_id nulls first, c.category, ch.channel;
  end
  $$;

-- Whether email can be a channel for you: you have a confirmed address.
create function public.my_notification_channels() returns table (email_verified boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query select private.confirmed_email(v_user_id) is not null;
  end
  $$;

-- Sets one choice for the account (p_home_id null) or for one Home you belong to. Outcomes: 'ok',
-- 'not_found' (not a member of that Home). Essential categories cannot be configured (22023).
create function public.set_notification_preference(
  p_category text, p_channel text, p_enabled boolean, p_home_id uuid default null
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_category is distinct from 'invitations' or p_channel not in ('in_app', 'email')
       or p_enabled is null then
      raise exception 'invalid notification preference' using errcode = '22023';
    end if;
    if p_home_id is not null and not private.lock_membership(p_home_id, v_user_id) then
      return 'not_found';
    end if;
    if p_home_id is null then
      insert into public.notification_preferences (user_id, category, channel, enabled)
        values (v_user_id, p_category, p_channel, p_enabled)
        on conflict (user_id, category, channel) where home_id is null
        do update set enabled = excluded.enabled, updated_at = now();
    else
      insert into public.notification_preferences (user_id, home_id, category, channel, enabled)
        values (v_user_id, p_home_id, p_category, p_channel, p_enabled)
        on conflict (user_id, home_id, category, channel) where home_id is not null
        do update set enabled = excluded.enabled, updated_at = now();
    end if;
    return 'ok';
  end
  $$;

-- Goes back to inheriting (a Home) or to the built-in default (the account).
create function public.reset_notification_preference(
  p_category text, p_channel text, p_home_id uuid default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_category is distinct from 'invitations' or p_channel not in ('in_app', 'email') then
      raise exception 'invalid notification preference' using errcode = '22023';
    end if;
    delete from public.notification_preferences p
      where p.user_id = v_user_id and p.home_id is not distinct from p_home_id
        and p.category = p_category and p.channel = p_channel;
    return found;
  end
  $$;

-- Sets quiet hours for the account or one Home (a Home row overrides the account's, also with
-- enabled = false). Times are wall-clock in p_time_zone, which must be a real IANA zone. Outcomes:
-- 'ok', 'not_found' (not a member of that Home). start = end is invalid (22023).
create function public.set_notification_quiet_hours(
  p_enabled boolean, p_start time, p_end time, p_time_zone text, p_home_id uuid default null
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_enabled is null or p_start is null or p_end is null or p_start = p_end
       or p_time_zone is null
       or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_time_zone) then
      raise exception 'invalid quiet hours' using errcode = '22023';
    end if;
    if p_home_id is not null and not private.lock_membership(p_home_id, v_user_id) then
      return 'not_found';
    end if;
    if p_home_id is null then
      insert into public.notification_quiet_hours (user_id, enabled, start_time, end_time, time_zone)
        values (v_user_id, p_enabled, p_start, p_end, p_time_zone)
        on conflict (user_id) where home_id is null
        do update set enabled = excluded.enabled, start_time = excluded.start_time,
          end_time = excluded.end_time, time_zone = excluded.time_zone, updated_at = now();
    else
      insert into public.notification_quiet_hours (user_id, home_id, enabled, start_time, end_time, time_zone)
        values (v_user_id, p_home_id, p_enabled, p_start, p_end, p_time_zone)
        on conflict (user_id, home_id) where home_id is not null
        do update set enabled = excluded.enabled, start_time = excluded.start_time,
          end_time = excluded.end_time, time_zone = excluded.time_zone, updated_at = now();
    end if;
    return 'ok';
  end
  $$;

create function public.reset_notification_quiet_hours(p_home_id uuid default null) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    delete from public.notification_quiet_hours q
      where q.user_id = v_user_id and q.home_id is not distinct from p_home_id;
    return found;
  end
  $$;

-- Marks your own notifications read: the listed ids, or all of them (p_ids null). Returns how many
-- changed. Notices of a Home you left are not yours to touch any more and are left alone.
create function public.mark_notifications_read(p_ids uuid[] default null) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_count integer;
  begin
    if p_ids is not null and pg_catalog.cardinality(p_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    update public.notifications n set read_at = now()
      where n.user_id = v_user_id and n.show_in_app and n.read_at is null
        and (p_ids is null or n.id = any (p_ids))
        and (n.home_id is null or private.home_role(n.home_id, v_user_id) is not null);
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------------

-- Supabase's default privileges give every new function in schema public to anon and authenticated.
do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.get_notification_settings()',
    'public.my_notification_channels()',
    'public.set_notification_preference(text, text, boolean, uuid)',
    'public.reset_notification_preference(text, text, uuid)',
    'public.set_notification_quiet_hours(boolean, time, time, text, uuid)',
    'public.reset_notification_quiet_hours(uuid)',
    'public.mark_notifications_read(uuid[])',
    'public.resend_home_invitation(uuid, uuid)',
    'public.renew_home_invitation(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The jobs' functions: the service role only.
  foreach v_function in array array[
    'public.deliver_recovery_ready(uuid, timestamptz)',
    'public.get_invitation_email(uuid, integer)',
    'public.record_invitation_email(uuid, integer, text)',
    'public.get_notification_email(uuid)',
    'public.record_notification_email(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end
$$;
