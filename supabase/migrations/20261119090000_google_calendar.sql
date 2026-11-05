-- S33: Google Calendar connect and inbound sync (brief plans/steps/S33-brief.md; ADR 0043; architecture.md
-- §31; Modules.md §4.2 and §4.8; Project-specification §11.2 "Calendar sharing — approved privacy policy").
--
-- One person connects one Google account. Its refresh token is stored encrypted (AES-256-GCM in the app and
-- the jobs, bound to the person's id); this database never sees it in clear and never returns it to anyone
-- but the person's own server-side disconnect and the sync job. The person chooses per calendar whether it
-- syncs, whether it shows on their personal calendar and which of their Homes see it.
--
-- Privacy (§11.2, option A): an unshared calendar reveals nothing to anyone else: no event, time, busy
-- block, count, calendar name or sync state. A calendar shared with a Home shows its events in full,
-- read-only, to that Home's current members, except events Google marks private or confidential, which only
-- the owner ever sees. A share is tied to the owner's membership, so leaving the Home ends it.
--
-- Nothing here is exposed as a table. People use security-definer functions with their own session; the
-- sync job (packages/jobs/src/jobs/google-calendar.ts) uses service-role-only functions that recheck the
-- connection and its lease. Writing to Google, conflicts and exclusions are S34.

-- Limits ---------------------------------------------------------------------------------------------------

-- apps/web/src/google-calendar/schema.ts GOOGLE_CALENDAR_LIMITS and packages/google-calendar use the same.
create function private.google_calendar_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'synced_calendars' then 20      -- calendars that sync, per connection
    when 'listed_calendars' then 250     -- calendars kept from Google's list
    when 'events' then 5000              -- stored events per calendar
    when 'page_events' then 250          -- events in one applied page
    when 'stale_minutes' then 60         -- no successful sync for longer: stale
    when 'auto_minutes' then 15          -- the automatic sync interval
    when 'manual_seconds' then 60        -- Sync now at most this often
    when 'full_hours' then 24            -- a full pass at least this often (moves the window)
    when 'lease_seconds_max' then 900
  end;
  $$;

-- Notification kind for an expired authorization (in-app, essential: the person must reconnect).
-- Audit: none; this is a person's own integration, never a Home action.

-- Tables ---------------------------------------------------------------------------------------------------

create table private.google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The account's primary calendar id (its address), shown to the person only.
  account text not null constraint google_calendar_connections_account_check
    check (private.calendar_single_line(account, 320)),
  -- 'v1.<iv>.<ciphertext>.<tag>' (base64url): AES-256-GCM, associated data bound to user_id.
  refresh_token text not null constraint google_calendar_connections_token_check
    check (char_length(refresh_token) <= 4096
      and refresh_token ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'),
  scopes text[] not null,
  status text not null default 'connected'
    constraint google_calendar_connections_status_check check (status in ('connected', 'authorization_expired')),
  connected_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  -- Set once Google's calendar list has been read (the defaults apply on that first read).
  calendars_listed_at timestamptz,
  -- The last run that started, and the last one that ended without a connection-wide error.
  last_attempt_at timestamptz,
  last_synced_at timestamptz,
  last_error_code text constraint google_calendar_connections_error_check
    check (last_error_code is null or last_error_code ~ '^[a-z_]{1,40}$'),
  -- A queued run that has not started yet (shown as "Syncing…"), and the counter of manual requests.
  sync_requested_at timestamptz,
  sync_seq integer not null default 0,
  -- One run at a time: the run's lease.
  sync_lease uuid,
  sync_lease_until timestamptz,
  constraint google_calendar_connections_user_key unique (user_id)
);

create table private.google_calendars (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references private.google_calendar_connections (id) on delete cascade,
  -- The connection's person, repeated so a Home share can be tied to their membership.
  user_id uuid not null references auth.users (id) on delete cascade,
  google_calendar_id text not null constraint google_calendars_google_id_check
    check (private.calendar_single_line(google_calendar_id, 1024)),
  name text not null constraint google_calendars_name_check check (private.calendar_single_line(name, 200)),
  time_zone text,
  access_role text not null
    constraint google_calendars_access_role_check check (access_role in ('freeBusyReader', 'reader', 'writer', 'owner')),
  is_primary boolean not null default false,
  -- Still in Google's list for this account.
  available boolean not null default true,
  sync_enabled boolean not null default false,
  show_personal boolean not null default false,
  sync_token text constraint google_calendars_sync_token_check check (char_length(sync_token) <= 2048),
  last_synced_at timestamptz,
  full_synced_at timestamptz,
  last_error_code text constraint google_calendars_error_check
    check (last_error_code is null or last_error_code ~ '^[a-z_]{1,40}$'),
  constraint google_calendars_google_key unique (connection_id, google_calendar_id),
  constraint google_calendars_show_check check (sync_enabled or not show_personal)
);
create index google_calendars_user_idx on private.google_calendars (user_id);

-- A calendar shared with one of its owner's Homes. Tied to the owner's membership, so leaving ends it.
create table private.google_calendar_home_shares (
  calendar_id uuid not null references private.google_calendars (id) on delete cascade,
  home_id uuid not null,
  user_id uuid not null,
  shared_at timestamptz not null default now(),
  constraint google_calendar_home_shares_pkey primary key (calendar_id, home_id),
  constraint google_calendar_home_shares_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);
create index google_calendar_home_shares_home_idx on private.google_calendar_home_shares (home_id);
create index google_calendar_home_shares_member_idx on private.google_calendar_home_shares (home_id, user_id);

-- One Google event instance (recurring series are read expanded). Unique per calendar and Google id, so a
-- repeated page, a retried run or a full pass never creates a second copy. These fields are also the last
-- synced snapshot S34 compares Madeora edits with.
create table private.google_calendar_events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references private.google_calendars (id) on delete cascade,
  google_event_id text not null constraint google_calendar_events_google_id_check
    check (private.calendar_single_line(google_event_id, 1024)),
  etag text constraint google_calendar_events_etag_check check (char_length(etag) <= 200),
  google_updated timestamptz,
  status text not null constraint google_calendar_events_status_check check (status in ('confirmed', 'tentative')),
  title text constraint google_calendar_events_title_check check (private.calendar_single_line(title, 200)),
  location text constraint google_calendar_events_location_check check (private.calendar_single_line(location, 200)),
  description text constraint google_calendar_events_description_check check (private.is_plain_text(description, 4000)),
  all_day boolean not null,
  -- All-day: the first and the last day (inclusive). Timed: the instants, and the zone Google gave.
  starts_on date,
  ends_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  time_zone text constraint google_calendar_events_zone_check check (char_length(time_zone) <= 64),
  recurring_event_id text constraint google_calendar_events_recurring_check check (char_length(recurring_event_id) <= 1024),
  original_start text constraint google_calendar_events_original_check check (char_length(original_start) <= 64),
  -- Google visibility private or confidential: never shown in a Home.
  private_in_google boolean not null default false,
  link text constraint google_calendar_events_link_check
    check (char_length(link) <= 2048 and link ~ '^https://(www\.)?google\.com/calendar/'),
  -- The lease of the full pass that last saw it (a full pass removes what it did not see).
  seen_in uuid,
  synced_at timestamptz not null default now(),
  constraint google_calendar_events_google_key unique (calendar_id, google_event_id),
  constraint google_calendar_events_time_shape check (
    (all_day and starts_on is not null and ends_on is not null and ends_on >= starts_on
      and starts_at is null and ends_at is null)
    or (not all_day and starts_at is not null and ends_at is not null and ends_at >= starts_at
      and starts_on is null and ends_on is null))
);
create index google_calendar_events_recurring_idx on private.google_calendar_events (calendar_id, recurring_event_id)
  where recurring_event_id is not null;

alter table private.google_calendar_connections enable row level security;
alter table private.google_calendars enable row level security;
alter table private.google_calendar_home_shares enable row level security;
alter table private.google_calendar_events enable row level security;
revoke all on table private.google_calendar_connections, private.google_calendars,
  private.google_calendar_home_shares, private.google_calendar_events
  from public, anon, authenticated, service_role;

-- Visibility -------------------------------------------------------------------------------------------------

-- The Google events a viewer sees in a context (p_home_id null: Personal). Personal: their own calendars
-- that sync and show there. A Home: the calendars shared with it by current members (the share's foreign
-- key guarantees the membership), without events private in Google. The callers check the viewer's
-- membership of the Home first.
create function private.google_context_events(p_user_id uuid, p_home_id uuid)
returns table (event private.google_calendar_events, calendar private.google_calendars)
  language sql stable security definer set search_path = '' as $$
  select e, c from private.google_calendar_events e
  join private.google_calendars c on c.id = e.calendar_id
  where p_user_id is not null and c.sync_enabled and c.available and case
    when p_home_id is null then c.user_id = p_user_id and c.show_personal
    else not e.private_in_google and exists (
      select 1 from private.google_calendar_home_shares s where s.calendar_id = c.id and s.home_id = p_home_id)
      and private.home_role(p_home_id, p_user_id) is not null
  end;
  $$;

-- Whether a Google event overlaps the local dates [p_from, p_to] in p_zone.
create function private.google_in_window(p_event private.google_calendar_events, p_from date, p_to date, p_zone text)
returns boolean
  language sql stable set search_path = '' as $$
  select case when p_event.all_day then p_event.starts_on <= p_to and p_event.ends_on >= p_from
    else p_event.starts_at < ((p_to + 1)::timestamp at time zone p_zone)
      and (p_event.ends_at > (p_from::timestamp at time zone p_zone)
        or (p_event.ends_at = p_event.starts_at and p_event.starts_at >= (p_from::timestamp at time zone p_zone)))
  end;
  $$;

create function private.google_sort_at(p_event private.google_calendar_events, p_zone text) returns timestamptz
  language sql stable set search_path = '' as $$
  select coalesce(p_event.starts_at, p_event.starts_on::timestamp at time zone p_zone);
  $$;

-- One Google event as an occurrence in a list, in the shape of private.calendar_occurrence_json plus its
-- source and calendar name. `kind`: 'personal' (the viewer's own) or 'shared' (someone's, shared here).
create function private.google_occurrence_json(
  p_event private.google_calendar_events, p_calendar private.google_calendars, p_viewer uuid, p_home_id uuid,
  p_zone text
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'eventId', p_event.id,
    'on', null,
    'kind', case when p_calendar.user_id = p_viewer then 'personal' else 'shared' end,
    'sharedBy', case when p_calendar.user_id <> p_viewer then private.member_ref(p_home_id, p_calendar.user_id) end,
    'title', coalesce(p_event.title, ''),
    'location', p_event.location,
    'allDay', p_event.all_day,
    'from', case when p_event.all_day then p_event.starts_on else (p_event.starts_at at time zone p_zone)::date end,
    'to', case when p_event.all_day then p_event.ends_on
      when p_event.ends_at = p_event.starts_at then (p_event.starts_at at time zone p_zone)::date
      else ((p_event.ends_at - interval '1 microsecond') at time zone p_zone)::date end,
    'startsAt', p_event.starts_at,
    'endsAt', p_event.ends_at,
    'timezone', case when private.calendar_valid_zone(p_event.time_zone) then p_event.time_zone
      when private.calendar_valid_zone(p_calendar.time_zone) then p_calendar.time_zone else p_zone end,
    'recurring', p_event.recurring_event_id is not null,
    'changed', false,
    'participants', '[]'::jsonb,
    'source', 'google',
    'calendar', p_calendar.name
  );
  $$;

-- A calendar's sync state as its owner sees it: 'authorization_expired', 'failed', 'syncing' (its first
-- sync has not happened yet), 'stale' (no successful sync for over an hour) or 'synced'.
create function private.google_calendar_state(
  p_connection private.google_calendar_connections, p_calendar private.google_calendars
) returns text
  language sql stable set search_path = '' as $$
  select case
    when p_connection.status = 'authorization_expired' then 'authorization_expired'
    when p_calendar.last_error_code is not null then 'failed'
    when p_calendar.last_synced_at is null then 'syncing'
    when p_calendar.last_synced_at < pg_catalog.now()
      - pg_catalog.make_interval(mins => private.google_calendar_limit('stale_minutes')) then 'stale'
    else 'synced'
  end;
  $$;

-- The calendars behind a context that are not up to date, for its warning. The owner sees the exact state;
-- a Home member sees someone's shared calendar only as 'syncing' or 'out_of_date', never the reason.
create function private.google_source_warnings(p_user_id uuid, p_home_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'calendar', x.name,
      'own', x.own,
      'sharedBy', case when not x.own then private.member_ref(p_home_id, x.user_id) end,
      'state', case when x.own or x.state = 'syncing' then x.state else 'out_of_date' end,
      'lastSyncedAt', x.last_synced_at
    ) order by x.own desc, pg_catalog.lower(x.name), x.id), '[]'::jsonb)
  from (
    select c.id, c.name, c.user_id, c.last_synced_at, c.user_id = p_user_id as own,
      private.google_calendar_state(k, c) as state
    from private.google_calendars c
    join private.google_calendar_connections k on k.id = c.connection_id
    where p_user_id is not null and c.sync_enabled and c.available and case
      when p_home_id is null then c.user_id = p_user_id and c.show_personal
      else exists (select 1 from private.google_calendar_home_shares s where s.calendar_id = c.id and s.home_id = p_home_id)
        and private.home_role(p_home_id, p_user_id) is not null
    end
  ) x
  where x.state <> 'synced';
  $$;

-- The calendar reads, now with Google events ---------------------------------------------------------------
-- The S32 functions, unchanged except that the Google events of the context join the native ones (same
-- order, same limit) and the answer names the sources that are not up to date. Native occurrences carry
-- source 'madeora'.

create or replace function public.list_calendar(p_from date, p_to date, p_home_id uuid default null, p_zone text default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_zone text;
    v_level text;
    v_show_vacations boolean := false;
    v_prefs private.calendar_view_preferences;
    v_occurrences jsonb;
    v_count integer;
  begin
    if p_from is null or p_to is null or p_to < p_from or p_to - p_from >= private.calendar_limit('window_days') then
      raise exception 'invalid window' using errcode = '22023';
    end if;
    if p_home_id is not null then
      perform private.require_calendar_home(p_home_id, v_user_id);
      v_level := private.calendar_level(p_home_id, v_user_id);
    end if;
    select * into v_prefs from private.calendar_view_preferences p
      where p.user_id = v_user_id and p.home_id is not distinct from p_home_id;
    v_show_vacations := p_home_id is not null and coalesce(v_prefs.show_vacations, true);
    v_zone := private.calendar_zone(p_home_id, p_zone);
    select pg_catalog.jsonb_agg(x.item order by x.sort_at, x.sort_title, x.sort_id), count(*)
      into v_occurrences, v_count
      from (
        select * from (
          select private.calendar_occurrence_json(e, o, v_user_id, p_home_id, v_zone)
              || '{"source": "madeora", "calendar": null}'::jsonb as item,
            coalesce(private.calendar_start_at(o, e.timezone), o.starts_on::timestamp at time zone v_zone) as sort_at,
            pg_catalog.lower(o.title) as sort_title, e.id as sort_id
          from private.calendar_context_events(v_user_id, p_home_id) e
          cross join lateral private.calendar_window(e, p_from, p_to, v_zone) o
          union all
          select private.google_occurrence_json(g.event, g.calendar, v_user_id, p_home_id, v_zone),
            private.google_sort_at(g.event, v_zone), pg_catalog.lower(coalesce((g.event).title, '')), (g.event).id
          from private.google_context_events(v_user_id, p_home_id) g
          where private.google_in_window(g.event, p_from, p_to, v_zone)
        ) u
        order by 2, 3, 4
        limit private.calendar_limit('occurrences') + 1
      ) x;
    return pg_catalog.jsonb_build_object(
      'timezone', v_zone,
      'today', (pg_catalog.now() at time zone v_zone)::date,
      'level', v_level,
      'canCreate', p_home_id is null or private.calendar_level_allows(v_level, 'edit'),
      'truncated', coalesce(v_count, 0) > private.calendar_limit('occurrences'),
      'occurrences', coalesce((select pg_catalog.jsonb_agg(v order by n) from pg_catalog.jsonb_array_elements(
          coalesce(v_occurrences, '[]'::jsonb)) with ordinality as a(v, n)
        where n <= private.calendar_limit('occurrences')), '[]'::jsonb),
      'showVacations', v_show_vacations,
      'showTasks', coalesce(v_prefs.show_tasks, false),
      'showChores', p_home_id is not null and coalesce(v_prefs.show_chores, false),
      'vacations', case when v_show_vacations then coalesce((
        select pg_catalog.jsonb_agg(private.vacation_summary(v, v_user_id, (pg_catalog.now() at time zone v_zone)::date)
          order by v.starts_on, v.ends_on, v.id)
        from private.home_vacations v
        where v.home_id = p_home_id and v.cancelled_at is null
          and v.starts_on <= p_to and v.ends_on >= p_from
          and exists (select 1 from private.home_vacation_participants p
            where p.vacation_id = v.id and p.status = 'accepted')), '[]'::jsonb) else '[]'::jsonb end,
      'googleWarnings', private.google_source_warnings(v_user_id, p_home_id)
    );
  end
  $$;

create or replace function public.get_calendar_upcoming(
  p_days integer, p_count integer, p_home_id uuid default null, p_zone text default null
)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_zone text;
    v_today date;
    v_now timestamptz := pg_catalog.now();
    v_items jsonb;
    v_level text;
  begin
    if p_days is null or p_days not in (7, 14, 30) or p_count is null or p_count not in (3, 5, 10) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_home_id is not null then
      perform private.require_calendar_home(p_home_id, v_user_id);
      v_level := private.calendar_level(p_home_id, v_user_id);
    end if;
    v_zone := private.calendar_zone(p_home_id, p_zone);
    v_today := (v_now at time zone v_zone)::date;
    select pg_catalog.jsonb_agg(x.item order by x.n) into v_items
      from (
        select u.item, pg_catalog.row_number() over (order by u.sort_at, u.sort_title, u.sort_id) as n
        from (
          select private.calendar_occurrence_json(e, o, v_user_id, p_home_id, v_zone)
              || '{"source": "madeora", "calendar": null}'::jsonb as item,
            coalesce(private.calendar_start_at(o, e.timezone), o.starts_on::timestamp at time zone v_zone) as sort_at,
            pg_catalog.lower(o.title) as sort_title, e.id as sort_id
          from private.calendar_context_events(v_user_id, p_home_id) e
          cross join lateral private.calendar_window(e, v_today, v_today + p_days - 1, v_zone) o
          where case when o.all_day then o.ends_on >= v_today
            else private.calendar_end_at(o, e.timezone) > v_now end
            and (o.all_day or private.calendar_start_at(o, e.timezone) < (v_today + p_days)::timestamp at time zone v_zone)
          union all
          select private.google_occurrence_json(g.event, g.calendar, v_user_id, p_home_id, v_zone),
            private.google_sort_at(g.event, v_zone), pg_catalog.lower(coalesce((g.event).title, '')), (g.event).id
          from private.google_context_events(v_user_id, p_home_id) g
          where private.google_in_window(g.event, v_today, v_today + p_days - 1, v_zone)
            and case when (g.event).all_day then (g.event).ends_on >= v_today
              else (g.event).ends_at > v_now or ((g.event).ends_at = (g.event).starts_at and (g.event).starts_at >= v_now) end
        ) u
      ) x where x.n <= p_count + 1;
    return pg_catalog.jsonb_build_object(
      'timezone', v_zone,
      'today', v_today,
      'canCreate', p_home_id is null or private.calendar_level_allows(v_level, 'edit'),
      'more', coalesce(pg_catalog.jsonb_array_length(v_items), 0) > p_count,
      'occurrences', coalesce((select pg_catalog.jsonb_agg(v order by n) from pg_catalog.jsonb_array_elements(
          coalesce(v_items, '[]'::jsonb)) with ordinality as a(v, n) where n <= p_count), '[]'::jsonb),
      'googleWarnings', private.google_source_warnings(v_user_id, p_home_id)
    );
  end
  $$;

-- One Google event as the caller sees it in a context (p_home_id null: Personal). Null when the caller may
-- not see it there or it does not exist: nothing tells these apart. Read-only in S33. The Google link and
-- the exact sync state are the owner's only.
create function public.get_google_calendar_event(p_event_id uuid, p_home_id uuid default null, p_zone text default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.google_calendar_events;
    v_calendar private.google_calendars;
    v_connection private.google_calendar_connections;
    v_zone text;
    v_state text;
  begin
    if p_event_id is null or (p_home_id is not null and private.home_role(p_home_id, v_user_id) is null) then
      return null;
    end if;
    select (g.event).* into v_event
      from private.google_context_events(v_user_id, p_home_id) g where (g.event).id = p_event_id;
    if v_event.id is null then
      return null;
    end if;
    select * into v_calendar from private.google_calendars c where c.id = v_event.calendar_id;
    select * into v_connection from private.google_calendar_connections k where k.id = v_calendar.connection_id;
    v_state := private.google_calendar_state(v_connection, v_calendar);
    v_zone := private.calendar_zone(p_home_id, p_zone);
    return private.google_occurrence_json(v_event, v_calendar, v_user_id, p_home_id, v_zone)
      || pg_catalog.jsonb_build_object(
        'description', v_event.description,
        'displayTimezone', v_zone,
        'startsOn', v_event.starts_on,
        'endsOn', v_event.ends_on,
        'tentative', v_event.status = 'tentative',
        'privateInGoogle', v_event.private_in_google,
        'link', case when v_calendar.user_id = v_user_id then v_event.link end,
        'state', case when v_calendar.user_id = v_user_id or v_state in ('synced', 'syncing') then v_state
          else 'out_of_date' end,
        'lastSyncedAt', v_calendar.last_synced_at);
  end
  $$;

-- The person's own connection ------------------------------------------------------------------------------

-- The caller's connection for the settings page: null when there is none. Never the token.
create function public.get_google_calendar_connection() returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_connection private.google_calendar_connections;
  begin
    select * into v_connection from private.google_calendar_connections k where k.user_id = v_user_id;
    if v_connection.id is null then
      return null;
    end if;
    return pg_catalog.jsonb_build_object(
      'account', v_connection.account,
      'status', v_connection.status,
      'connectedAt', v_connection.connected_at,
      'lastSyncedAt', v_connection.last_synced_at,
      'errorCode', v_connection.last_error_code,
      'listed', v_connection.calendars_listed_at is not null,
      'syncQueued', v_connection.sync_requested_at is not null
        and (v_connection.last_attempt_at is null or v_connection.sync_requested_at > v_connection.last_attempt_at),
      'canSyncNow', v_connection.status = 'connected' and (v_connection.sync_requested_at is null
        or v_connection.sync_requested_at < pg_catalog.now()
          - pg_catalog.make_interval(secs => private.google_calendar_limit('manual_seconds'))),
      'calendars', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', c.id,
            'name', c.name,
            'primary', c.is_primary,
            'accessRole', c.access_role,
            'available', c.available,
            'sync', c.sync_enabled,
            'showPersonal', c.show_personal,
            'homes', coalesce((select pg_catalog.jsonb_agg(s.home_id order by s.shared_at, s.home_id)
              from private.google_calendar_home_shares s where s.calendar_id = c.id), '[]'::jsonb),
            'state', case when c.sync_enabled then private.google_calendar_state(v_connection, c) end,
            'errorCode', c.last_error_code,
            'lastSyncedAt', c.last_synced_at
          ) order by c.is_primary desc, c.available desc, pg_catalog.lower(c.name), c.id)
        from private.google_calendars c where c.connection_id = v_connection.id), '[]'::jsonb),
      'homes', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', h.id, 'name', h.name)
          order by pg_catalog.lower(h.name), h.id)
        from public.home_memberships m join public.homes h on h.id = m.home_id
        where m.user_id = v_user_id), '[]'::jsonb),
      'limits', pg_catalog.jsonb_build_object('syncedCalendars', private.google_calendar_limit('synced_calendars'))
    );
  end
  $$;

-- Queues a sync run of a connection, keyed so the same request never queues twice.
create function private.queue_google_calendar_sync(p_connection_id uuid, p_key text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    perform private.enqueue_job('google-calendar-sync', 1, 'google-calendar-sync:' || p_connection_id::text || ':' || p_key,
      pg_catalog.jsonb_build_object('connectionId', p_connection_id), private.request_correlation_id());
    update private.google_calendar_connections k set sync_requested_at = pg_catalog.now()
      where k.id = p_connection_id;
  end
  $$;

-- Stores the caller's connection after the app's OAuth callback checked Google's answer: p_token is the
-- refresh token encrypted by the app. The same account again keeps the calendar choices (a reconnect,
-- authorization back to 'connected'); another account replaces the old connection and everything in it.
-- Queues the first sync. Outcomes: 'connected', 'reconnected', 'replaced'; 22023 for a malformed value.
create function public.save_google_calendar_connection(p_account text, p_token text, p_scopes text[]) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.google_calendar_connections;
    v_id uuid;
    v_outcome text;
    v_recent boolean;
  begin
    if p_account is null or not private.calendar_single_line(p_account, 320)
      or p_token is null or pg_catalog.char_length(p_token) > 4096 or p_token !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
      or p_scopes is null or pg_catalog.cardinality(p_scopes) not between 1 and 10
      or exists (select 1 from pg_catalog.unnest(p_scopes) s where s is null or s !~ '^[a-z0-9:/._-]{1,200}$') then
      raise exception 'invalid connection' using errcode = '22023';
    end if;
    select * into v_existing from private.google_calendar_connections k where k.user_id = v_user_id for update;
    -- At most one queued run a minute per person, however often this is called; otherwise the
    -- 15-minute poll (queue_google_calendar_syncs) picks the connection up on its next pass.
    v_recent := v_existing.sync_requested_at >= pg_catalog.now()
      - pg_catalog.make_interval(secs => private.google_calendar_limit('manual_seconds'));
    if v_existing.id is not null and v_existing.account = p_account then
      update private.google_calendar_connections k set refresh_token = p_token, scopes = p_scopes,
          status = 'connected', status_changed_at = pg_catalog.now(), connected_at = pg_catalog.now(),
          last_error_code = null, sync_seq = k.sync_seq + 1
        where k.id = v_existing.id;
      v_id := v_existing.id;
      v_outcome := 'reconnected';
    else
      if v_existing.id is not null then
        delete from private.google_calendar_connections k where k.id = v_existing.id;
        v_outcome := 'replaced';
      else
        v_outcome := 'connected';
      end if;
      insert into private.google_calendar_connections (user_id, account, refresh_token, scopes)
        values (v_user_id, p_account, p_token, p_scopes) returning id into v_id;
    end if;
    if v_recent is not true then
      perform private.queue_google_calendar_sync(v_id,
        'connect:' || (select k.sync_seq from private.google_calendar_connections k where k.id = v_id)::text);
    end if;
    return v_outcome;
  end
  $$;

-- Sync now: queues a run unless one was requested within the last minute. Outcomes: 'queued', 'too_soon',
-- 'not_connected', 'authorization_expired'.
create function public.request_google_calendar_sync() returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_connection private.google_calendar_connections;
  begin
    select * into v_connection from private.google_calendar_connections k where k.user_id = v_user_id for update;
    if v_connection.id is null then
      return 'not_connected';
    end if;
    if v_connection.status <> 'connected' then
      return 'authorization_expired';
    end if;
    if v_connection.sync_requested_at >= pg_catalog.now()
        - pg_catalog.make_interval(secs => private.google_calendar_limit('manual_seconds')) then
      return 'too_soon';
    end if;
    update private.google_calendar_connections k set sync_seq = k.sync_seq + 1 where k.id = v_connection.id;
    perform private.queue_google_calendar_sync(v_connection.id, 'manual:' || (v_connection.sync_seq + 1)::text);
    return 'queued';
  end
  $$;

-- One calendar's choices: whether it syncs, shows on the personal calendar and which of the caller's Homes
-- see it (replacing the list). Turning sync off removes its events, its sync token and its Home shares;
-- turning it on queues a sync. Outcomes: 'saved', 'not_found' (not the caller's), 'unavailable' (no longer
-- in Google), 'invalid_home', 'too_many'; 22023 for a malformed request.
create function public.set_google_calendar_settings(
  p_calendar_id uuid, p_sync boolean, p_show_personal boolean, p_home_ids uuid[]
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_calendar private.google_calendars;
    v_connection private.google_calendar_connections;
    v_homes uuid[] := coalesce(p_home_ids, '{}');
  begin
    if p_calendar_id is null or p_sync is null or p_show_personal is null
      or pg_catalog.cardinality(v_homes) > 20 or array_position(v_homes, null) is not null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_connection from private.google_calendar_connections k where k.user_id = v_user_id for update;
    select * into v_calendar from private.google_calendars c
      where c.id = p_calendar_id and c.connection_id = v_connection.id for update;
    if v_calendar.id is null then
      return 'not_found';
    end if;
    -- A busy-only calendar (Google's freeBusyReader) has no event details to show.
    if p_sync and (not v_calendar.available or v_calendar.access_role = 'freeBusyReader') then
      return 'unavailable';
    end if;
    if not p_sync and (p_show_personal or pg_catalog.cardinality(v_homes) > 0) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if exists (select 1 from pg_catalog.unnest(v_homes) h(id)
        where private.home_role(h.id, v_user_id) is null) then
      return 'invalid_home';
    end if;
    if p_sync and not v_calendar.sync_enabled and (select count(*) from private.google_calendars c
        where c.connection_id = v_connection.id and c.sync_enabled) >= private.google_calendar_limit('synced_calendars') then
      return 'too_many';
    end if;
    if not p_sync then
      delete from private.google_calendar_events e where e.calendar_id = v_calendar.id;
      delete from private.google_calendar_home_shares s where s.calendar_id = v_calendar.id;
      update private.google_calendars c set sync_enabled = false, show_personal = false, sync_token = null,
          last_synced_at = null, full_synced_at = null, last_error_code = null
        where c.id = v_calendar.id;
      return 'saved';
    end if;
    update private.google_calendars c set sync_enabled = true, show_personal = p_show_personal
      where c.id = v_calendar.id;
    delete from private.google_calendar_home_shares s
      where s.calendar_id = v_calendar.id and s.home_id <> all (v_homes);
    insert into private.google_calendar_home_shares (calendar_id, home_id, user_id)
      select v_calendar.id, h.id, v_user_id from (select distinct pg_catalog.unnest(v_homes) as id) h
      on conflict on constraint google_calendar_home_shares_pkey do nothing;
    -- Turning a calendar on queues a run, at most once a minute (the poll covers the rest).
    if not v_calendar.sync_enabled and v_connection.status = 'connected'
        and (v_connection.sync_requested_at is null or v_connection.sync_requested_at < pg_catalog.now()
          - pg_catalog.make_interval(secs => private.google_calendar_limit('manual_seconds'))) then
      update private.google_calendar_connections k set sync_seq = k.sync_seq + 1 where k.id = v_connection.id;
      perform private.queue_google_calendar_sync(v_connection.id, 'calendar:' || (v_connection.sync_seq + 1)::text);
    end if;
    return 'saved';
  end
  $$;

-- Disconnect: removes the connection, its calendars, shares and events, and returns the encrypted token so
-- the app can revoke it at Google (null when there was no connection). Only the caller's own.
create function public.disconnect_google_calendar() returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_token text;
  begin
    delete from private.google_calendar_connections k where k.user_id = v_user_id returning k.refresh_token into v_token;
    return v_token;
  end
  $$;

-- The sync job (service role) ------------------------------------------------------------------------------

-- The connection's row when p_lease holds it now; null otherwise.
create function private.google_leased(p_connection_id uuid, p_lease uuid) returns private.google_calendar_connections
  language sql stable security definer set search_path = '' as $$
  select k from private.google_calendar_connections k
  where k.id = p_connection_id and p_lease is not null and k.sync_lease = p_lease
    and k.sync_lease_until > pg_catalog.now();
  $$;

-- The calendar's row when it belongs to the connection p_lease holds; null otherwise.
-- Locks the calendar row, so a person turning sync off (set_google_calendar_settings, which locks it too)
-- either waits for this write or is seen by it: a turned-off calendar never gets events or a token back.
create function private.google_leased_calendar(p_calendar_id uuid, p_lease uuid) returns private.google_calendars
  language sql volatile security definer set search_path = '' as $$
  select c from private.google_calendars c
  join private.google_calendar_connections k on k.id = c.connection_id
  where c.id = p_calendar_id and p_lease is not null and k.sync_lease = p_lease and k.sync_lease_until > pg_catalog.now()
  for update of c;
  $$;

-- Starts a run: takes the connection's lease for p_lease_seconds. Outcomes: 'ok' with the person's id and
-- the encrypted token; 'missing' (disconnected), 'expired' (authorization expired: nothing to do until the
-- person reconnects), 'inactive' (the account cannot be used), 'busy' (another run holds the lease).
create function public.google_sync_begin(p_connection_id uuid, p_lease uuid, p_lease_seconds integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_connection private.google_calendar_connections;
  begin
    if p_connection_id is null or p_lease is null or p_lease_seconds is null
      or p_lease_seconds not between 30 and private.google_calendar_limit('lease_seconds_max') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_connection from private.google_calendar_connections k where k.id = p_connection_id for update;
    if v_connection.id is null then
      return '{"outcome": "missing"}'::jsonb;
    end if;
    if v_connection.status <> 'connected' then
      return '{"outcome": "expired"}'::jsonb;
    end if;
    if not private.can_receive_notifications(v_connection.user_id) then
      -- Recorded as an attempt, so the automatic sync does not queue it again every 15 minutes.
      update private.google_calendar_connections k set last_attempt_at = pg_catalog.now() where k.id = v_connection.id;
      return '{"outcome": "inactive"}'::jsonb;
    end if;
    if v_connection.sync_lease is not null and v_connection.sync_lease <> p_lease
        and v_connection.sync_lease_until > pg_catalog.now() then
      return '{"outcome": "busy"}'::jsonb;
    end if;
    update private.google_calendar_connections k set sync_lease = p_lease,
        sync_lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
        last_attempt_at = pg_catalog.now()
      where k.id = v_connection.id;
    return pg_catalog.jsonb_build_object('outcome', 'ok', 'userId', v_connection.user_id,
      'token', v_connection.refresh_token);
  end
  $$;

-- Applies Google's calendar list (all of it, [{id, name, timeZone, accessRole, primary}]) and returns the
-- calendars to sync now: [{id, googleId, syncToken, fullDue}]. Calendars Google no longer lists become
-- unavailable and lose their events and shares. On the first list, the primary calendar syncs and shows on
-- the personal calendar (nothing is shared with a Home). Null when the lease is not held.
create function public.google_sync_calendars(p_connection_id uuid, p_lease uuid, p_calendars jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_connection private.google_calendar_connections := private.google_leased(p_connection_id, p_lease);
    v_first boolean;
  begin
    if v_connection.id is null then
      return null;
    end if;
    if p_calendars is null or pg_catalog.jsonb_typeof(p_calendars) <> 'array'
      or pg_catalog.jsonb_array_length(p_calendars) > private.google_calendar_limit('listed_calendars') then
      raise exception 'invalid calendars' using errcode = '22023';
    end if;
    if exists (select 1 from pg_catalog.jsonb_array_elements(p_calendars) x
        where pg_catalog.jsonb_typeof(x) <> 'object' or pg_catalog.jsonb_typeof(x -> 'id') <> 'string'
          or pg_catalog.jsonb_typeof(x -> 'name') <> 'string' or pg_catalog.jsonb_typeof(x -> 'accessRole') <> 'string') then
      raise exception 'invalid calendars' using errcode = '22023';
    end if;
    v_first := v_connection.calendars_listed_at is null;
    insert into private.google_calendars (connection_id, user_id, google_calendar_id, name, time_zone, access_role,
        is_primary, available, sync_enabled, show_personal)
      select v_connection.id, v_connection.user_id, x ->> 'id', x ->> 'name',
        case when private.calendar_valid_zone(x ->> 'timeZone') then x ->> 'timeZone' end,
        x ->> 'accessRole', coalesce((x ->> 'primary')::boolean, false), true,
        v_first and coalesce((x ->> 'primary')::boolean, false), v_first and coalesce((x ->> 'primary')::boolean, false)
      from pg_catalog.jsonb_array_elements(p_calendars) x
      on conflict on constraint google_calendars_google_key do update
        set name = excluded.name, time_zone = excluded.time_zone, access_role = excluded.access_role,
          is_primary = excluded.is_primary, available = true;
    with gone as (
      update private.google_calendars c set available = false, sync_token = null, last_synced_at = null,
          full_synced_at = null, last_error_code = null
        where c.connection_id = v_connection.id and c.available
          and c.google_calendar_id not in (select x ->> 'id' from pg_catalog.jsonb_array_elements(p_calendars) x)
        returning c.id
    ), drop_events as (
      delete from private.google_calendar_events e where e.calendar_id in (select id from gone)
    )
    delete from private.google_calendar_home_shares s where s.calendar_id in (select id from gone);
    update private.google_calendar_connections k set calendars_listed_at = pg_catalog.now() where k.id = v_connection.id;
    return coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', c.id, 'googleId', c.google_calendar_id, 'syncToken', c.sync_token,
          'fullDue', c.sync_token is null or c.full_synced_at is null
            or c.full_synced_at < pg_catalog.now() - pg_catalog.make_interval(hours => private.google_calendar_limit('full_hours')))
        order by c.is_primary desc, c.id)
      from (select * from private.google_calendars c
        where c.connection_id = v_connection.id and c.sync_enabled and c.available
        order by c.is_primary desc, c.id limit private.google_calendar_limit('synced_calendars')) c), '[]'::jsonb);
  exception
    when check_violation or not_null_violation or invalid_text_representation then
      raise exception 'invalid calendars' using errcode = '22023';
  end
  $$;

-- Applies one page of Google events to a calendar. Each item is either {id, cancelled: true} (the instance
-- or the whole series is gone) or a normalized event (packages/google-calendar normalizeEvent). Upserts on
-- the calendar and Google id, so a repeated page changes nothing; an unchanged etag is not rewritten. In a
-- full pass (p_full) every row seen is marked with the lease. Answers the calendar's stored event count,
-- or null when the lease is not held. 22023 for a malformed page (nothing applied).
create function public.google_sync_apply_events(p_calendar_id uuid, p_lease uuid, p_full boolean, p_events jsonb)
returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_calendar private.google_calendars := private.google_leased_calendar(p_calendar_id, p_lease);
    v_count integer;
  begin
    if v_calendar.id is null or not v_calendar.sync_enabled or not v_calendar.available then
      return null;
    end if;
    if p_full is null or p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array'
      or pg_catalog.jsonb_array_length(p_events) > private.google_calendar_limit('page_events')
      or exists (select 1 from pg_catalog.jsonb_array_elements(p_events) x
        where pg_catalog.jsonb_typeof(x) <> 'object' or pg_catalog.jsonb_typeof(x -> 'id') <> 'string') then
      raise exception 'invalid page' using errcode = '22023';
    end if;
    -- Only the last item per Google id in the page counts.
    delete from private.google_calendar_events e
      where e.calendar_id = v_calendar.id and exists (
        select 1 from (select distinct on (x ->> 'id') x from pg_catalog.jsonb_array_elements(p_events)
            with ordinality as a(x, n) order by x ->> 'id', n desc) l
        where coalesce((l.x ->> 'cancelled')::boolean, false)
          and (e.google_event_id = l.x ->> 'id' or e.recurring_event_id = l.x ->> 'id'));
    insert into private.google_calendar_events as t (calendar_id, google_event_id, etag, google_updated, status, title,
        location, description, all_day, starts_on, ends_on, starts_at, ends_at, time_zone, recurring_event_id,
        original_start, private_in_google, link, seen_in, synced_at)
      select v_calendar.id, x ->> 'id', x ->> 'etag', (x ->> 'updated')::timestamptz,
        x ->> 'status', x ->> 'title', x ->> 'location', x ->> 'description', (x ->> 'allDay')::boolean,
        (x ->> 'startsOn')::date, (x ->> 'endsOn')::date, (x ->> 'startsAt')::timestamptz, (x ->> 'endsAt')::timestamptz,
        x ->> 'timeZone', x ->> 'recurringEventId', x ->> 'originalStart', coalesce((x ->> 'private')::boolean, false),
        x ->> 'link', case when p_full then p_lease end, pg_catalog.now()
      from (select distinct on (x ->> 'id') x from pg_catalog.jsonb_array_elements(p_events)
          with ordinality as a(x, n) order by x ->> 'id', n desc) l
      where not coalesce((x ->> 'cancelled')::boolean, false)
      on conflict on constraint google_calendar_events_google_key do update
        set etag = excluded.etag, google_updated = excluded.google_updated, status = excluded.status,
          title = excluded.title, location = excluded.location, description = excluded.description,
          all_day = excluded.all_day, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
          starts_at = excluded.starts_at, ends_at = excluded.ends_at, time_zone = excluded.time_zone,
          recurring_event_id = excluded.recurring_event_id, original_start = excluded.original_start,
          private_in_google = excluded.private_in_google, link = excluded.link,
          seen_in = coalesce(excluded.seen_in, t.seen_in),
          synced_at = case when t.etag is not distinct from excluded.etag then t.synced_at else excluded.synced_at end;
    select count(*) into v_count from private.google_calendar_events e where e.calendar_id = v_calendar.id;
    return v_count;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation
      or not_null_violation or string_data_right_truncation then
      raise exception 'invalid page' using errcode = '22023';
  end
  $$;

-- Ends one calendar's pass. Success (p_error null): stores the new sync token and the sync time; a full pass
-- also removes every row it did not see. Failure: records the code (the token stays, so the next run resumes;
-- 'sync_token_invalid' clears it). True when applied, false when the lease is not held.
create function public.google_sync_finish_calendar(
  p_calendar_id uuid, p_lease uuid, p_full boolean, p_sync_token text default null, p_error text default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_calendar private.google_calendars := private.google_leased_calendar(p_calendar_id, p_lease);
  begin
    if v_calendar.id is null then
      return false;
    end if;
    if p_full is null or (p_error is not null and p_error !~ '^[a-z_]{1,40}$')
      or (p_error is null and (p_sync_token is null or char_length(p_sync_token) > 2048)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_error is not null then
      update private.google_calendars c set last_error_code = p_error,
          sync_token = case when p_error = 'sync_token_invalid' then null else c.sync_token end
        where c.id = v_calendar.id;
      return true;
    end if;
    -- Turned off (or gone from Google) during the run: its events were removed; keep no token.
    if not v_calendar.sync_enabled or not v_calendar.available then
      return true;
    end if;
    if p_full then
      delete from private.google_calendar_events e
        where e.calendar_id = v_calendar.id and e.seen_in is distinct from p_lease;
    end if;
    update private.google_calendars c set sync_token = p_sync_token, last_synced_at = pg_catalog.now(),
        full_synced_at = case when p_full then pg_catalog.now() else c.full_synced_at end, last_error_code = null
      where c.id = v_calendar.id;
    return true;
  end
  $$;

-- Ends a run and releases the lease. p_outcome: 'ok', 'authorization_expired' (Google refused the refresh
-- token: syncing stops, the events stay with a warning, and the person is told once per connection) or a
-- failure code for the whole connection (the next run retries). True when applied.
create function public.google_sync_finish(p_connection_id uuid, p_lease uuid, p_outcome text) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_connection private.google_calendar_connections := private.google_leased(p_connection_id, p_lease);
  begin
    if p_outcome is null or p_outcome !~ '^[a-z_]{1,40}$' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_connection.id is null then
      return false;
    end if;
    if p_outcome = 'ok' then
      update private.google_calendar_connections k set last_synced_at = pg_catalog.now(), last_error_code = null,
          sync_lease = null, sync_lease_until = null
        where k.id = v_connection.id;
    elsif p_outcome = 'authorization_expired' then
      update private.google_calendar_connections k set status = 'authorization_expired',
          status_changed_at = pg_catalog.now(), last_error_code = null, sync_lease = null, sync_lease_until = null
        where k.id = v_connection.id;
      perform private.notify_user(v_connection.user_id, null, 'security', 'google_calendar.authorization_expired',
        '{}'::jsonb,
        'google-calendar-expired:' || v_connection.id::text || ':' || extract(epoch from v_connection.connected_at)::bigint::text,
        false);
    else
      update private.google_calendar_connections k set last_error_code = p_outcome,
          sync_lease = null, sync_lease_until = null
        where k.id = v_connection.id;
    end if;
    return true;
  end
  $$;

-- The automatic sync (called by the outbox dispatcher every few minutes): queues a run for up to p_limit
-- connected accounts with a calendar to sync (or not listed yet) whose last run started over 15 minutes ago
-- and that have none waiting, keyed by the
-- 15-minute slot so a repeated call queues nothing twice. Answers how many it queued.
create function public.queue_google_calendar_syncs(p_limit integer) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_interval interval := pg_catalog.make_interval(mins => private.google_calendar_limit('auto_minutes'));
    v_slot bigint := pg_catalog.floor(extract(epoch from pg_catalog.now())
      / (private.google_calendar_limit('auto_minutes') * 60))::bigint;
    v_id uuid;
    v_count integer := 0;
  begin
    if p_limit is null or p_limit not between 1 and 500 then
      raise exception 'invalid limit' using errcode = '22023';
    end if;
    for v_id in
      select k.id from private.google_calendar_connections k
      where k.status = 'connected'
        and (k.last_attempt_at is null or k.last_attempt_at < pg_catalog.now() - v_interval)
        and (k.sync_requested_at is null or k.sync_requested_at < pg_catalog.now() - v_interval
          or (k.last_attempt_at is not null and k.sync_requested_at <= k.last_attempt_at))
        and (k.sync_lease_until is null or k.sync_lease_until < pg_catalog.now())
        -- Only accounts with a calendar to sync, or not listed yet (keeps the free job budget, M3).
        and (exists (select 1 from private.google_calendars c where c.connection_id = k.id and c.sync_enabled)
          or not exists (select 1 from private.google_calendars c where c.connection_id = k.id))
      order by k.last_attempt_at nulls first, k.id
      limit p_limit
      for update skip locked
    loop
      perform private.queue_google_calendar_sync(v_id, 'auto:' || v_slot::text);
      v_count := v_count + 1;
    end loop;
    return v_count;
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The person's own functions: signed-in people only (each rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_google_calendar_event', 'get_google_calendar_connection', 'save_google_calendar_connection',
      'request_google_calendar_sync', 'set_google_calendar_settings', 'disconnect_google_calendar'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The sync job: the service role only.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'google_sync_begin', 'google_sync_calendars', 'google_sync_apply_events', 'google_sync_finish_calendar',
      'google_sync_finish', 'queue_google_calendar_syncs'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'google%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'queue_google_calendar_sync'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
