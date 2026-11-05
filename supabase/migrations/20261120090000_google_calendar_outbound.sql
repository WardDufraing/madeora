-- S34: Google Calendar outbound changes, conflicts and exclusions (brief plans/steps/S34-brief.md; ADR 0044;
-- architecture.md §31; Modules.md §4.2: create in the configured target calendar, edits sync, ask-to-resolve
-- conflicts, the two-choice deletion with an exclusion record, the three recurrence scopes).
--
-- The person's changes to Google events (create, edit, delete) are stored here first and sent to Google by the
-- sync job (packages/google-calendar push.ts), which uses Google's etags so it never overwrites a newer Google
-- version. When Google changed the same event since the version the person edited:
--   - fields changed on only one side merge automatically (fields: title, location, description, time);
--   - a field changed on both sides to different values is a conflict: both versions are kept, the event says
--     so, and only its owner chooses which one wins. Nothing here (no apply, finish, retry or later page)
--     ever ends a conflict on its own.
-- "Remove from Madeora" writes an exclusion: the sync keeps storing the event, every read leaves it out, so a
-- resync never shows it again; the owner can restore it.
--
-- Privacy (§11.2) is unchanged: only the calendar's owner sees or makes changes, conflicts and exclusions;
-- Home members see a shared calendar's events as before, and never through a conflict a version that Google
-- marks private (an event in conflict takes the stricter of the two privacy flags).

-- Limits ---------------------------------------------------------------------------------------------------

create or replace function private.google_calendar_limit(p_name text) returns integer
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
    when 'open_changes' then 200         -- changes waiting for Google, per connection
    when 'push_batch' then 50            -- changes one run sends
    when 'push_attempts' then 20         -- failed tries (Google unavailable) before a change is marked failed
    when 'exclusions' then 1000          -- events removed from Madeora, per calendar
  end;
  $$;

-- Tables ---------------------------------------------------------------------------------------------------

-- The configured target calendar for events created in Madeora (null: Madeora only).
alter table private.google_calendar_connections
  add column write_calendar_id uuid references private.google_calendars (id) on delete set null;
-- Connections from S33: their primary calendar, when it syncs and Google lets them write it.
update private.google_calendar_connections k set write_calendar_id = c.id
  from private.google_calendars c
  where c.connection_id = k.id and c.is_primary and c.sync_enabled and c.available
    and c.access_role in ('owner', 'writer');

-- A Madeora-side revision of each stored Google event: every local change and every new Google version moves
-- it, so an edit made from an older page is refused instead of silently merged.
alter table private.google_calendar_events
  add column revision integer not null default 1;

-- One change waiting for Google. Event scope ('event': one event, or one occurrence of a series) is keyed by
-- the Google event id; series scopes ('following', 'all') by the series id, so one event or series never has
-- two open changes. Snapshots use the shape of packages/google-calendar normalizeEvent (title, location,
-- description, allDay, startsOn, endsOn, startsAt, endsAt, timeZone, private, etag, status,
-- recurringEventId, originalStart): `base` is the Google version the person changed, `mine` Madeora's,
-- `theirs` Google's newer version in a conflict ({"deleted": true} when Google deleted it).
create table private.google_calendar_changes (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references private.google_calendars (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null constraint google_calendar_changes_action_check check (action in ('create', 'update', 'delete')),
  scope text not null constraint google_calendar_changes_scope_check check (scope in ('event', 'following', 'all')),
  google_event_id text not null constraint google_calendar_changes_event_check
    check (private.calendar_single_line(google_event_id, 1024)),
  series_id text constraint google_calendar_changes_series_check check (char_length(series_id) <= 1024),
  fields text[] not null default '{}'
    constraint google_calendar_changes_fields_check check (fields <@ array['title', 'location', 'description', 'time']),
  base jsonb,
  mine jsonb,
  theirs jsonb,
  -- A new event's repeat rule (packages/google-calendar recurrence.ts turns it into an RRULE).
  repeat jsonb,
  state text not null default 'pending'
    constraint google_calendar_changes_state_check check (state in ('pending', 'conflict', 'failed')),
  conflict_fields text[] not null default '{}',
  error_code text constraint google_calendar_changes_error_check check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  attempts integer not null default 0,
  -- Moves with every change the person makes, so a result for an older version never drops a newer one.
  version integer not null default 1,
  title text constraint google_calendar_changes_title_check check (private.calendar_single_line(title, 200)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_calendar_changes_shape check (
    (scope = 'event') = (series_id is null)
    and (action <> 'create' or (scope = 'event' and base is null and mine is not null))
    and (action = 'create' or base is not null)
    and (action <> 'update' or mine is not null)
    and (state <> 'conflict' or theirs is not null))
);
create unique index google_calendar_changes_event_key on private.google_calendar_changes (calendar_id, google_event_id)
  where scope = 'event';
create unique index google_calendar_changes_series_key on private.google_calendar_changes (calendar_id, series_id)
  where scope <> 'event';
create index google_calendar_changes_user_idx on private.google_calendar_changes (user_id, state);

-- "Remove from Madeora": one event or occurrence ('event', by its Google id), a whole series ('series', by the
-- series id) or a series from one occurrence on ('following', by the series id and that occurrence's start).
create table private.google_calendar_exclusions (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references private.google_calendars (id) on delete cascade,
  kind text not null constraint google_calendar_exclusions_kind_check check (kind in ('event', 'series', 'following')),
  google_id text not null constraint google_calendar_exclusions_id_check check (private.calendar_single_line(google_id, 1024)),
  from_at timestamptz,
  title text constraint google_calendar_exclusions_title_check check (private.calendar_single_line(title, 200)),
  starts_on date not null,
  created_at timestamptz not null default now(),
  constraint google_calendar_exclusions_shape check ((kind = 'following') = (from_at is not null)),
  constraint google_calendar_exclusions_key unique nulls not distinct (calendar_id, kind, google_id, from_at)
);

alter table private.google_calendar_changes enable row level security;
alter table private.google_calendar_exclusions enable row level security;
revoke all on table private.google_calendar_changes, private.google_calendar_exclusions
  from public, anon, authenticated, service_role;

-- Snapshots and fields ---------------------------------------------------------------------------------------

-- An occurrence's original start as an instant: Google gives a date (all-day) or a date-time with offset.
create function private.google_original_at(p_original text, p_fallback timestamptz) returns timestamptz
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_original is null then
      return p_fallback;
    end if;
    if p_original ~ '^\d{4}-\d{2}-\d{2}$' then
      return p_original::date::timestamp at time zone 'UTC';
    end if;
    return p_original::timestamptz;
  exception when others then
    return p_fallback;
  end
  $$;

create function private.google_event_at(p_event private.google_calendar_events) returns timestamptz
  language sql immutable set search_path = '' as $$
  select private.google_original_at(p_event.original_start,
    coalesce(p_event.starts_at, p_event.starts_on::timestamp at time zone 'UTC'));
  $$;

-- A stored event as a snapshot.
create function private.google_snapshot(p_event private.google_calendar_events) returns jsonb
  language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('etag', p_event.etag, 'status', p_event.status, 'title', p_event.title,
    'location', p_event.location, 'description', p_event.description, 'allDay', p_event.all_day,
    'startsOn', p_event.starts_on, 'endsOn', p_event.ends_on, 'startsAt', p_event.starts_at, 'endsAt', p_event.ends_at,
    'timeZone', p_event.time_zone, 'private', p_event.private_in_google,
    'recurringEventId', p_event.recurring_event_id, 'originalStart', p_event.original_start);
  $$;

-- One field's value in a snapshot, comparable across both sides (instants as epoch seconds).
create function private.google_field(p_snapshot jsonb, p_field text) returns jsonb
  language sql immutable set search_path = '' as $$
  select case p_field
    when 'title' then coalesce(p_snapshot -> 'title', 'null'::jsonb)
    when 'location' then coalesce(p_snapshot -> 'location', 'null'::jsonb)
    when 'description' then coalesce(p_snapshot -> 'description', 'null'::jsonb)
    when 'time' then pg_catalog.jsonb_build_object(
      'allDay', coalesce(p_snapshot -> 'allDay', 'null'::jsonb),
      'startsOn', coalesce(p_snapshot -> 'startsOn', 'null'::jsonb),
      'endsOn', coalesce(p_snapshot -> 'endsOn', 'null'::jsonb),
      'startsAt', pg_catalog.to_jsonb(extract(epoch from (p_snapshot ->> 'startsAt')::timestamptz)),
      'endsAt', pg_catalog.to_jsonb(extract(epoch from (p_snapshot ->> 'endsAt')::timestamptz)))
  end;
  $$;

-- The fields whose values differ between two snapshots.
create function private.google_diff(p_a jsonb, p_b jsonb) returns text[]
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(f order by n), '{}')
  from pg_catalog.unnest(array['title', 'location', 'description', 'time']) with ordinality as x(f, n)
  where private.google_field(p_a, f) is distinct from private.google_field(p_b, f);
  $$;

-- p_into with the keys of p_fields taken from p_from.
create function private.google_take(p_into jsonb, p_from jsonb, p_fields text[]) returns jsonb
  language sql immutable set search_path = '' as $$
  select p_into || coalesce((select pg_catalog.jsonb_object_agg(k, coalesce(p_from -> k, 'null'::jsonb))
    from pg_catalog.unnest(p_fields) f
    cross join lateral pg_catalog.unnest(case f when 'time'
      then array['allDay', 'startsOn', 'endsOn', 'startsAt', 'endsAt', 'timeZone'] else array[f] end) k), '{}'::jsonb);
  $$;

-- Writes a snapshot's values into a stored event (its etag and privacy flag too) and moves its revision.
create function private.google_row_set(p_event_id uuid, p_snapshot jsonb) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.google_calendar_events e set
        etag = p_snapshot ->> 'etag',
        status = coalesce(p_snapshot ->> 'status', e.status),
        title = p_snapshot ->> 'title',
        location = p_snapshot ->> 'location',
        description = p_snapshot ->> 'description',
        all_day = (p_snapshot ->> 'allDay')::boolean,
        starts_on = (p_snapshot ->> 'startsOn')::date,
        ends_on = (p_snapshot ->> 'endsOn')::date,
        starts_at = (p_snapshot ->> 'startsAt')::timestamptz,
        ends_at = (p_snapshot ->> 'endsAt')::timestamptz,
        time_zone = p_snapshot ->> 'timeZone',
        private_in_google = coalesce((p_snapshot ->> 'private')::boolean, e.private_in_google),
        link = case when p_snapshot ? 'link' then p_snapshot ->> 'link' else e.link end,
        revision = e.revision + 1,
        synced_at = pg_catalog.now()
      where e.id = p_event_id;
  end
  $$;

-- Madeora's version of an event from validated values (private.calendar_values), as a snapshot.
create function private.google_local_snapshot(p_values private.calendar_events, p_private boolean, p_etag text)
returns jsonb
  language sql stable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('etag', p_etag, 'status', 'confirmed', 'title', p_values.title,
    'location', p_values.location, 'description', p_values.description, 'allDay', p_values.all_day,
    'startsOn', case when p_values.all_day then p_values.starts_on end,
    'endsOn', case when p_values.all_day then p_values.ends_on end,
    'startsAt', case when not p_values.all_day then (p_values.starts_on + p_values.start_time) at time zone p_values.timezone end,
    'endsAt', case when not p_values.all_day then (p_values.ends_on + p_values.end_time) at time zone p_values.timezone end,
    'timeZone', case when not p_values.all_day then p_values.timezone end,
    'private', p_private);
  $$;

-- Whether an event is removed from Madeora by one of its calendar's exclusions.
create function private.google_excluded(p_event private.google_calendar_events) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.google_calendar_exclusions x
    where x.calendar_id = p_event.calendar_id and case x.kind
      when 'event' then x.google_id = p_event.google_event_id
      when 'series' then x.google_id = p_event.recurring_event_id or x.google_id = p_event.google_event_id
      else x.google_id = p_event.recurring_event_id and private.google_event_at(p_event) >= x.from_at
    end);
  $$;

-- The open change that concerns an event, as its owner sees it: its own (event scope) or its series'.
create function private.google_event_change(p_event private.google_calendar_events)
returns private.google_calendar_changes
  language sql stable security definer set search_path = '' as $$
  select c from private.google_calendar_changes c
  where c.calendar_id = p_event.calendar_id and (
    (c.scope = 'event' and c.google_event_id = p_event.google_event_id)
    or (c.scope = 'all' and c.series_id = p_event.recurring_event_id)
    or (c.scope = 'following' and c.series_id = p_event.recurring_event_id
      and private.google_event_at(p_event) >= private.google_original_at(c.base ->> 'originalStart',
        (c.base ->> 'startsAt')::timestamptz)))
  order by (c.scope = 'event') desc
  limit 1;
  $$;

-- An event's state for its owner's views: null (in sync), 'saving', 'deleting', 'conflict' or 'failed'.
create function private.google_change_state(p_change private.google_calendar_changes) returns text
  language sql immutable set search_path = '' as $$
  select case when p_change.id is null then null
    when p_change.state = 'pending' then case when p_change.action = 'delete' then 'deleting' else 'saving' end
    else p_change.state end;
  $$;

-- Weighs Google's newer version (p_theirs, a normalized event or {"deleted": true}) against an open change:
--   'conflict': a field both sides changed to different values, a deletion against an edit, or the change
--               already in conflict (it only takes the newer Google version; it never ends on its own);
--   'merged':   the change stays, rebased on p_theirs (fields only Google changed are taken into Madeora's
--               version);
--   'done':     nothing is left to send (Google already has Madeora's values, or both deleted it).
-- Event-scope changes keep the stored event in step: Madeora's version while open, Google's when done; in a
-- conflict it takes the stricter privacy flag. The caller holds the change's calendar lock.
create function private.google_reconcile(p_change_id uuid, p_theirs jsonb) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    c private.google_calendar_changes;
    v_event private.google_calendar_events;
    v_deleted boolean := coalesce((p_theirs ->> 'deleted')::boolean, false);
    v_google text[];
    v_overlap text[];
    v_mine jsonb;
    v_fields text[];
  begin
    select * into c from private.google_calendar_changes x where x.id = p_change_id for update;
    if c.id is null then
      return 'done';
    end if;
    if c.scope = 'event' then
      select * into v_event from private.google_calendar_events e
        where e.calendar_id = c.calendar_id and e.google_event_id = c.google_event_id;
    end if;
    if not v_deleted then
      v_google := private.google_diff(c.base, p_theirs);
    end if;

    -- Already in conflict: only the newer Google version is kept.
    if c.state = 'conflict' then
      update private.google_calendar_changes x set theirs = p_theirs, updated_at = pg_catalog.now(),
          conflict_fields = case when v_deleted then x.conflict_fields
            else coalesce(nullif((select coalesce(pg_catalog.array_agg(f), '{}') from pg_catalog.unnest(x.fields) f
              where private.google_field(p_theirs, f) is distinct from private.google_field(x.base, f)
                and private.google_field(p_theirs, f) is distinct from private.google_field(x.mine, f)), '{}'),
              x.conflict_fields) end
        where x.id = c.id;
      if v_event.id is not null and not v_deleted and coalesce((p_theirs ->> 'private')::boolean, false) then
        update private.google_calendar_events e set private_in_google = true, revision = e.revision + 1
          where e.id = v_event.id;
      end if;
      return 'conflict';
    end if;

    if c.action = 'create' then
      if v_deleted then
        delete from private.google_calendar_events e where e.id = v_event.id;
        delete from private.google_calendar_changes x where x.id = c.id;
        return 'done';
      end if;
      -- Google already has it: whatever Madeora changed since becomes an edit of Google's version.
      v_fields := private.google_diff(p_theirs, c.mine);
      if pg_catalog.cardinality(v_fields) = 0 then
        if v_event.id is not null then
          perform private.google_row_set(v_event.id, p_theirs);
        end if;
        delete from private.google_calendar_changes x where x.id = c.id;
        return 'done';
      end if;
      update private.google_calendar_changes x set action = 'update', base = p_theirs, fields = v_fields,
          mine = x.mine || pg_catalog.jsonb_build_object('etag', p_theirs -> 'etag', 'private', p_theirs -> 'private'),
          updated_at = pg_catalog.now()
        where x.id = c.id;
      if v_event.id is not null then
        update private.google_calendar_events e set etag = p_theirs ->> 'etag', revision = e.revision + 1
          where e.id = v_event.id;
      end if;
      return 'merged';
    end if;

    if c.action = 'delete' then
      if v_deleted then
        if c.scope = 'event' then
          delete from private.google_calendar_events e where e.id = v_event.id;
        end if;
        delete from private.google_calendar_changes x where x.id = c.id;
        return 'done';
      end if;
      if pg_catalog.cardinality(v_google) = 0 then
        update private.google_calendar_changes x set base = p_theirs, updated_at = pg_catalog.now() where x.id = c.id;
        return 'merged';
      end if;
      update private.google_calendar_changes x set state = 'conflict', theirs = p_theirs, conflict_fields = v_google,
          error_code = null, updated_at = pg_catalog.now()
        where x.id = c.id;
      if v_event.id is not null then
        perform private.google_row_set(v_event.id, p_theirs);
      end if;
      return 'conflict';
    end if;

    -- An edit.
    if v_deleted then
      update private.google_calendar_changes x set state = 'conflict', theirs = p_theirs, conflict_fields = x.fields,
          error_code = null, updated_at = pg_catalog.now()
        where x.id = c.id;
      return 'conflict';
    end if;
    select coalesce(pg_catalog.array_agg(f), '{}') into v_overlap from pg_catalog.unnest(c.fields) f
      where f = any (v_google) and private.google_field(p_theirs, f) is distinct from private.google_field(c.mine, f);
    if pg_catalog.cardinality(v_overlap) > 0 then
      update private.google_calendar_changes x set state = 'conflict', theirs = p_theirs, conflict_fields = v_overlap,
          error_code = null, updated_at = pg_catalog.now()
        where x.id = c.id;
      if v_event.id is not null and coalesce((p_theirs ->> 'private')::boolean, false) then
        update private.google_calendar_events e set private_in_google = true, revision = e.revision + 1
          where e.id = v_event.id;
      end if;
      return 'conflict';
    end if;
    -- No field changed on both sides: take Google's other changes, keep Madeora's.
    v_mine := private.google_take(c.mine, p_theirs, (select coalesce(pg_catalog.array_agg(f), '{}')
      from pg_catalog.unnest(v_google) f where not (f = any (c.fields))))
      || pg_catalog.jsonb_build_object('etag', p_theirs -> 'etag', 'private', p_theirs -> 'private');
    select coalesce(pg_catalog.array_agg(f), '{}') into v_fields from pg_catalog.unnest(c.fields) f
      where private.google_field(p_theirs, f) is distinct from private.google_field(v_mine, f);
    if pg_catalog.cardinality(v_fields) = 0 then
      if v_event.id is not null then
        perform private.google_row_set(v_event.id, p_theirs);
      end if;
      delete from private.google_calendar_changes x where x.id = c.id;
      return 'done';
    end if;
    update private.google_calendar_changes x set base = p_theirs, mine = v_mine, fields = v_fields,
        updated_at = pg_catalog.now()
      where x.id = c.id;
    if v_event.id is not null then
      perform private.google_row_set(v_event.id, v_mine);
    end if;
    return 'merged';
  end
  $$;

-- Queues a run for a connection that has new changes, unless one is already waiting to start.
create function private.google_queue_push(p_connection_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_connection private.google_calendar_connections;
  begin
    select * into v_connection from private.google_calendar_connections k where k.id = p_connection_id for update;
    if v_connection.id is null or v_connection.status <> 'connected' then
      return;
    end if;
    if v_connection.sync_requested_at is not null
        and (v_connection.last_attempt_at is null or v_connection.sync_requested_at > v_connection.last_attempt_at) then
      return;
    end if;
    update private.google_calendar_connections k set sync_seq = k.sync_seq + 1 where k.id = v_connection.id;
    perform private.queue_google_calendar_sync(v_connection.id, 'push:' || (v_connection.sync_seq + 1)::text);
  end
  $$;

-- Visibility, now without excluded events ------------------------------------------------------------------

create or replace function private.google_context_events(p_user_id uuid, p_home_id uuid)
returns table (event private.google_calendar_events, calendar private.google_calendars)
  language sql stable security definer set search_path = '' as $$
  select e, c from private.google_calendar_events e
  join private.google_calendars c on c.id = e.calendar_id
  where p_user_id is not null and c.sync_enabled and c.available and case
    when p_home_id is null then c.user_id = p_user_id and c.show_personal
    else not e.private_in_google and exists (
      select 1 from private.google_calendar_home_shares s where s.calendar_id = c.id and s.home_id = p_home_id)
      and private.home_role(p_home_id, p_user_id) is not null
  end
  and not private.google_excluded(e);
  $$;

-- The occurrence shape gains `googleState`: the event's change state, for its owner only.
create or replace function private.google_occurrence_json(
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
    'calendar', p_calendar.name,
    'googleState', case when p_calendar.user_id = p_viewer
      then private.google_change_state(private.google_event_change(p_event)) end
  );
  $$;

-- One Google event as the caller sees it (S33), with what its owner needs to change it: the revision the edit
-- page sends back, whether the calendar can be written, the series, and the open change (both versions in a
-- conflict). Other people get exactly the S33 answer (`change` null, `editable` false).
create or replace function public.get_google_calendar_event(p_event_id uuid, p_home_id uuid default null, p_zone text default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.google_calendar_events;
    v_calendar private.google_calendars;
    v_connection private.google_calendar_connections;
    v_change private.google_calendar_changes;
    v_zone text;
    v_state text;
    v_own boolean;
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
    v_own := v_calendar.user_id = v_user_id;
    v_state := private.google_calendar_state(v_connection, v_calendar);
    v_zone := private.calendar_zone(p_home_id, p_zone);
    if v_own then
      v_change := private.google_event_change(v_event);
    end if;
    return private.google_occurrence_json(v_event, v_calendar, v_user_id, p_home_id, v_zone)
      || pg_catalog.jsonb_build_object(
        'description', v_event.description,
        'displayTimezone', v_zone,
        'startsOn', v_event.starts_on,
        'endsOn', v_event.ends_on,
        'tentative', v_event.status = 'tentative',
        'privateInGoogle', v_event.private_in_google,
        'link', case when v_own then v_event.link end,
        'state', case when v_own or v_state in ('synced', 'syncing') then v_state else 'out_of_date' end,
        'lastSyncedAt', v_calendar.last_synced_at,
        'revision', case when v_own then v_event.revision end,
        'editable', v_own and v_calendar.access_role in ('owner', 'writer') and v_connection.status = 'connected',
        'pendingCreate', v_own and v_change.action = 'create',
        'change', case when v_change.id is not null then pg_catalog.jsonb_build_object(
          'id', v_change.id,
          'action', v_change.action,
          'scope', v_change.scope,
          'state', v_change.state,
          'errorCode', v_change.error_code,
          'fields', pg_catalog.to_jsonb(v_change.fields),
          'conflictFields', pg_catalog.to_jsonb(v_change.conflict_fields),
          'mine', v_change.mine,
          'theirs', v_change.theirs,
          'own', v_change.scope = 'event') end);
  end
  $$;

-- The person's own connection, with the target calendar, open changes and removed events --------------------

create or replace function public.get_google_calendar_connection() returns jsonb
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
      'writeCalendarId', v_connection.write_calendar_id,
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
            'lastSyncedAt', c.last_synced_at,
            'writable', c.access_role in ('owner', 'writer'),
            'openChanges', (select count(*) from private.google_calendar_changes x where x.calendar_id = c.id)
          ) order by c.is_primary desc, c.available desc, pg_catalog.lower(c.name), c.id)
        from private.google_calendars c where c.connection_id = v_connection.id), '[]'::jsonb),
      'homes', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', h.id, 'name', h.name)
          order by pg_catalog.lower(h.name), h.id)
        from public.home_memberships m join public.homes h on h.id = m.home_id
        where m.user_id = v_user_id), '[]'::jsonb),
      'changes', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', x.id,
            'eventId', (select e.id from private.google_calendar_events e
              where e.calendar_id = x.calendar_id and e.google_event_id = x.google_event_id),
            'title', x.title,
            'calendar', c.name,
            'action', x.action,
            'scope', x.scope,
            'state', x.state,
            'errorCode', x.error_code,
            'updatedAt', x.updated_at
          ) order by x.state = 'pending', x.updated_at desc, x.id)
        from (select * from private.google_calendar_changes x where x.user_id = v_user_id
          order by x.state = 'pending', x.updated_at desc limit 100) x
        join private.google_calendars c on c.id = x.calendar_id), '[]'::jsonb),
      'hidden', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', x.id, 'kind', x.kind, 'title', x.title, 'startsOn', x.starts_on, 'calendar', c.name
          ) order by x.created_at desc, x.id)
        from (select x.* from private.google_calendar_exclusions x
          join private.google_calendars c on c.id = x.calendar_id
          where c.connection_id = v_connection.id order by x.created_at desc limit 100) x
        join private.google_calendars c on c.id = x.calendar_id), '[]'::jsonb),
      'limits', pg_catalog.jsonb_build_object('syncedCalendars', private.google_calendar_limit('synced_calendars'))
    );
  end
  $$;

-- Turning a calendar's sync off is refused while it has changes waiting for Google ('pending_changes'), and
-- clears it as the target calendar. Otherwise as in S33.
create or replace function public.set_google_calendar_settings(
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
      if exists (select 1 from private.google_calendar_changes x where x.calendar_id = v_calendar.id) then
        return 'pending_changes';
      end if;
      delete from private.google_calendar_events e where e.calendar_id = v_calendar.id;
      delete from private.google_calendar_home_shares s where s.calendar_id = v_calendar.id;
      update private.google_calendars c set sync_enabled = false, show_personal = false, sync_token = null,
          last_synced_at = null, full_synced_at = null, last_error_code = null
        where c.id = v_calendar.id;
      update private.google_calendar_connections k set write_calendar_id = null
        where k.id = v_connection.id and k.write_calendar_id = v_calendar.id;
      return 'saved';
    end if;
    update private.google_calendars c set sync_enabled = true, show_personal = p_show_personal
      where c.id = v_calendar.id;
    delete from private.google_calendar_home_shares s
      where s.calendar_id = v_calendar.id and s.home_id <> all (v_homes);
    insert into private.google_calendar_home_shares (calendar_id, home_id, user_id)
      select v_calendar.id, h.id, v_user_id from (select distinct pg_catalog.unnest(v_homes) as id) h
      on conflict on constraint google_calendar_home_shares_pkey do nothing;
    if not v_calendar.sync_enabled and v_connection.status = 'connected'
        and (v_connection.sync_requested_at is null or v_connection.sync_requested_at < pg_catalog.now()
          - pg_catalog.make_interval(secs => private.google_calendar_limit('manual_seconds'))) then
      update private.google_calendar_connections k set sync_seq = k.sync_seq + 1 where k.id = v_connection.id;
      perform private.queue_google_calendar_sync(v_connection.id, 'calendar:' || (v_connection.sync_seq + 1)::text);
    end if;
    return 'saved';
  end
  $$;

-- The target calendar for new events: one of the caller's calendars that syncs and that Google lets them
-- write, or null (Madeora only). Outcomes: 'saved', 'not_found', 'read_only' (not writable or not syncing).
create function public.set_google_calendar_write_target(p_calendar_id uuid default null) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_connection private.google_calendar_connections;
    v_calendar private.google_calendars;
  begin
    select * into v_connection from private.google_calendar_connections k where k.user_id = v_user_id for update;
    if v_connection.id is null then
      return 'not_found';
    end if;
    if p_calendar_id is not null then
      select * into v_calendar from private.google_calendars c
        where c.id = p_calendar_id and c.connection_id = v_connection.id;
      if v_calendar.id is null then
        return 'not_found';
      end if;
      if not (v_calendar.sync_enabled and v_calendar.available and v_calendar.access_role in ('owner', 'writer')) then
        return 'read_only';
      end if;
    end if;
    update private.google_calendar_connections k set write_calendar_id = p_calendar_id where k.id = v_connection.id;
    return 'saved';
  end
  $$;

-- Changing Google events from Madeora ----------------------------------------------------------------------

-- The caller's own Google calendar that syncs, locked; null when it is not theirs, not syncing or gone.
create function private.google_own_calendar(p_user_id uuid, p_calendar_id uuid) returns private.google_calendars
  language sql volatile security definer set search_path = '' as $$
  select c from private.google_calendars c
  where c.id = p_calendar_id and c.user_id = p_user_id and c.sync_enabled and c.available
  for update;
  $$;

-- Why Madeora cannot write to a calendar now: 'read_only' (Google's access role), 'authorization_expired', or
-- null.
create function private.google_write_problem(p_calendar private.google_calendars) returns text
  language sql stable security definer set search_path = '' as $$
  select case when p_calendar.access_role not in ('owner', 'writer') then 'read_only'
    when (select k.status from private.google_calendar_connections k where k.id = p_calendar.connection_id) <> 'connected'
      then 'authorization_expired' end;
  $$;

-- The Google event id Madeora gives a new event: derived from the caller and the client's request id, so a
-- retry finds the same event and Google's own duplicate check catches a repeated insert. Google ids use the
-- characters a–v and 0–9.
create function private.google_new_event_id(p_user_id uuid, p_request_id uuid) returns text
  language sql immutable set search_path = '' as $$
  select 'madeora' || pg_catalog.md5('google-calendar-event:' || p_user_id::text || ':' || p_request_id::text);
  $$;

-- Creates an event in one of the caller's writable Google calendars (p_event as for native events:
-- title, location, description, allDay, startsOn, endsOn, startTime, endTime, timezone, repeat; no
-- reminder, participants or shares). It shows in Madeora at once, marked as saving, and the sync job inserts
-- it in Google. Answers {outcome, eventId}; outcomes: 'created', 'exists' (the same request again), 'not_found',
-- 'read_only', 'authorization_expired', 'limit_reached', 'invalid_dates', 'nonexistent_time'. 22023 for a
-- malformed request.
create function public.create_google_calendar_event(p_request_id uuid, p_calendar_id uuid, p_event jsonb)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_calendar private.google_calendars;
    v_problem text;
    v_values private.calendar_events;
    v_google_id text;
    v_existing uuid;
    v_id uuid;
    v_mine jsonb;
  begin
    if p_request_id is null or p_calendar_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_event ? 'participants' or p_event ? 'shares'
        or (p_event ? 'reminder' and pg_catalog.jsonb_typeof(p_event -> 'reminder') <> 'null') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_values := private.calendar_values(p_event, true);
    v_calendar := private.google_own_calendar(v_user_id, p_calendar_id);
    if v_calendar.id is null then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_problem := private.google_write_problem(v_calendar);
    v_google_id := private.google_new_event_id(v_user_id, p_request_id);
    select e.id into v_existing from private.google_calendar_events e
      where e.calendar_id = v_calendar.id and (e.google_event_id = v_google_id or e.recurring_event_id = v_google_id)
      limit 1;
    if v_existing is not null or exists (select 1 from private.google_calendar_changes x
        where x.calendar_id = v_calendar.id and x.google_event_id = v_google_id) then
      return pg_catalog.jsonb_build_object('outcome', 'exists', 'eventId', v_existing);
    end if;
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    v_problem := private.calendar_time_problem(v_values.all_day, v_values.starts_on, v_values.ends_on,
      v_values.start_time, v_values.end_time, v_values.timezone);
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    if (select count(*) from private.google_calendar_events e where e.calendar_id = v_calendar.id)
        >= private.google_calendar_limit('events')
      or (select count(*) from private.google_calendar_changes x where x.user_id = v_user_id)
        >= private.google_calendar_limit('open_changes') then
      return '{"outcome": "limit_reached"}'::jsonb;
    end if;
    v_mine := private.google_local_snapshot(v_values, false, null);
    insert into private.google_calendar_events (calendar_id, google_event_id, etag, status, title, location, description,
        all_day, starts_on, ends_on, starts_at, ends_at, time_zone, private_in_google)
      values (v_calendar.id, v_google_id, null, 'confirmed', v_values.title, v_values.location, v_values.description,
        v_values.all_day, (v_mine ->> 'startsOn')::date, (v_mine ->> 'endsOn')::date,
        (v_mine ->> 'startsAt')::timestamptz, (v_mine ->> 'endsAt')::timestamptz, v_mine ->> 'timeZone', false)
      returning id into v_id;
    insert into private.google_calendar_changes (calendar_id, user_id, action, scope, google_event_id, fields, mine,
        repeat, title)
      values (v_calendar.id, v_user_id, 'create', 'event', v_google_id, array['title', 'location', 'description', 'time'],
        v_mine, case when v_values.frequency is not null then pg_catalog.jsonb_build_object(
          'frequency', v_values.frequency, 'interval', v_values.interval_count,
          'weekdays', pg_catalog.to_jsonb(v_values.weekdays), 'endsOn', v_values.repeat_ends_on,
          'count', v_values.max_count) end,
        v_values.title);
    perform private.google_queue_push(v_calendar.connection_id);
    return pg_catalog.jsonb_build_object('outcome', 'created', 'eventId', v_id);
  end
  $$;

-- The caller's own stored event they may change: visible to them (not removed from Madeora), in a calendar
-- that syncs. Null otherwise; callers answer 'not_found' for it, as for a forged id.
create function private.google_own_event(p_user_id uuid, p_event_id uuid) returns private.google_calendar_events
  language sql stable security definer set search_path = '' as $$
  select e from private.google_calendar_events e
  join private.google_calendars c on c.id = e.calendar_id
  where e.id = p_event_id and c.user_id = p_user_id and c.sync_enabled and c.available
    and not private.google_excluded(e);
  $$;

-- The occurrences a series scope affects, for the dry run: the stored ones (the sync window), first 50.
create function private.google_scope_preview(p_event private.google_calendar_events, p_scope text) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('outcome', 'preview',
    'count', count(*),
    'dates', coalesce((pg_catalog.array_agg(d order by a) filter (where n <= 50))::text[], '{}'),
    -- Google's series may go on past the synced window; those occurrences change too.
    'beyondWindow', p_scope = 'all' or (p_scope = 'following'))
  from (
    select coalesce(e.starts_on, (e.starts_at at time zone coalesce(e.time_zone, 'UTC'))::date) as d,
      private.google_event_at(e) as a,
      pg_catalog.row_number() over (order by private.google_event_at(e)) as n
    from private.google_calendar_events e
    where e.calendar_id = p_event.calendar_id and not private.google_excluded(e) and case p_scope
      when 'event' then e.id = p_event.id
      when 'all' then e.recurring_event_id = p_event.recurring_event_id
      else e.recurring_event_id = p_event.recurring_event_id and private.google_event_at(e) >= private.google_event_at(p_event)
    end
  ) x;
  $$;

-- Why the caller cannot start a change on this event now: 'conflict_open' (a conflict on it or its series
-- waits for their choice), 'busy' (another change on it or its series is still being sent), or null.
create function private.google_change_blocker(p_event private.google_calendar_events, p_scope text) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when bool_or(c.state = 'conflict') then 'conflict_open'
    when count(*) > 0 then 'busy'
  end
  from private.google_calendar_changes c
  where c.calendar_id = p_event.calendar_id and (
    (c.scope = 'event' and c.google_event_id = p_event.google_event_id
      and not (p_scope = 'event' and c.action <> 'delete' and c.state <> 'conflict'))
    or (c.scope <> 'event' and c.series_id = p_event.recurring_event_id)
    or (p_scope <> 'event' and c.scope = 'event' and p_event.recurring_event_id is not null and exists (
      select 1 from private.google_calendar_events e
      where e.calendar_id = c.calendar_id and e.google_event_id = c.google_event_id
        and e.recurring_event_id = p_event.recurring_event_id)));
  $$;

-- Edits a Google event from Madeora (owner only, writable calendar). p_scope: 'event' (this event, or this
-- occurrence), 'following' or 'all' (a recurring event's series). p_revision is the event's revision the page
-- showed. p_event: title, location, description, allDay, startsOn, endsOn, startTime, endTime, timezone (no
-- repeat). Series scopes change the text and the time of day or length, never the date or the kind of event
-- ('series_limit'). p_dry_run answers {outcome: 'preview', count, dates, beyondWindow} and changes nothing.
-- Outcomes: 'saved', 'unchanged', 'preview', 'not_found', 'read_only', 'authorization_expired', 'stale',
-- 'invalid_scope', 'series_limit', 'busy', 'conflict_open', 'limit_reached', 'invalid_dates',
-- 'nonexistent_time'. 22023 for a malformed request.
create function public.update_google_calendar_event(
  p_event_id uuid, p_scope text, p_revision integer, p_event jsonb, p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.google_calendar_events;
    v_calendar private.google_calendars;
    v_problem text;
    v_values private.calendar_events;
    v_current jsonb;
    v_mine jsonb;
    v_fields text[];
    v_change private.google_calendar_changes;
    v_zone text;
  begin
    if p_event_id is null or p_scope is null or p_scope not in ('event', 'following', 'all') or p_revision is null
        or p_dry_run is null or (p_event ? 'repeat' and pg_catalog.jsonb_typeof(p_event -> 'repeat') <> 'null') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_values := private.calendar_values(p_event, false);
    v_event := private.google_own_event(v_user_id, p_event_id);
    if v_event.id is null then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_calendar := private.google_own_calendar(v_user_id, v_event.calendar_id);
    if v_calendar.id is null then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_problem := private.google_write_problem(v_calendar);
    -- Locked through its calendar: the sync job's writes take the same lock.
    select * into v_event from private.google_calendar_events e where e.id = v_event.id;
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    if p_scope <> 'event' and v_event.recurring_event_id is null then
      return '{"outcome": "invalid_scope"}'::jsonb;
    end if;
    if v_event.revision <> p_revision then
      return '{"outcome": "stale"}'::jsonb;
    end if;
    v_problem := private.calendar_time_problem(v_values.all_day, v_values.starts_on, v_values.ends_on,
      v_values.start_time, v_values.end_time, v_values.timezone);
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    v_current := private.google_snapshot(v_event);
    v_mine := private.google_local_snapshot(v_values, v_event.private_in_google, v_event.etag)
      || pg_catalog.jsonb_build_object('status', v_event.status, 'recurringEventId', v_event.recurring_event_id,
        'originalStart', v_event.original_start);
    v_fields := private.google_diff(v_current, v_mine);
    if p_scope <> 'event' then
      v_zone := coalesce(v_event.time_zone, v_calendar.time_zone, 'UTC');
      if v_values.all_day <> v_event.all_day
        or (v_event.all_day and v_values.starts_on <> v_event.starts_on)
        or (not v_event.all_day and (v_values.timezone <> v_zone
          or v_values.starts_on <> (v_event.starts_at at time zone v_zone)::date)) then
        return '{"outcome": "series_limit"}'::jsonb;
      end if;
    end if;
    if p_dry_run then
      return private.google_scope_preview(v_event, p_scope);
    end if;
    v_problem := private.google_change_blocker(v_event, p_scope);
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;

    if p_scope = 'event' then
      select * into v_change from private.google_calendar_changes x
        where x.calendar_id = v_event.calendar_id and x.scope = 'event' and x.google_event_id = v_event.google_event_id
        for update;
      if pg_catalog.cardinality(v_fields) = 0 then
        return '{"outcome": "unchanged"}'::jsonb;
      end if;
      if v_change.action = 'create' and v_change.repeat is not null then
        -- A new series waiting for Google is changed in Google once it is there.
        return '{"outcome": "busy"}'::jsonb;
      end if;
      if v_change.id is not null then
        -- Merged into the change still waiting: its base stays the Google version first edited.
        update private.google_calendar_changes x set
            mine = case when x.action = 'create' then v_mine - 'recurringEventId' - 'originalStart'
              || pg_catalog.jsonb_build_object('etag', null) else v_mine end,
            fields = case when x.action = 'create' then x.fields else private.google_diff(x.base, v_mine) end,
            state = 'pending', error_code = null, attempts = 0, version = x.version + 1, title = v_values.title,
            updated_at = pg_catalog.now()
          where x.id = v_change.id;
        if v_change.action = 'update' and pg_catalog.cardinality(private.google_diff(v_change.base, v_mine)) = 0 then
          -- Back to Google's version: nothing left to send.
          delete from private.google_calendar_changes x where x.id = v_change.id;
        end if;
      else
        if (select count(*) from private.google_calendar_changes x where x.user_id = v_user_id)
            >= private.google_calendar_limit('open_changes') then
          return '{"outcome": "limit_reached"}'::jsonb;
        end if;
        insert into private.google_calendar_changes (calendar_id, user_id, action, scope, google_event_id, fields,
            base, mine, title)
          values (v_event.calendar_id, v_user_id, 'update', 'event', v_event.google_event_id, v_fields, v_current,
            v_mine, v_values.title);
      end if;
      perform private.google_row_set(v_event.id, v_mine);
    else
      if pg_catalog.cardinality(v_fields) = 0 then
        return '{"outcome": "unchanged"}'::jsonb;
      end if;
      if (select count(*) from private.google_calendar_changes x where x.user_id = v_user_id)
          >= private.google_calendar_limit('open_changes') then
        return '{"outcome": "limit_reached"}'::jsonb;
      end if;
      insert into private.google_calendar_changes (calendar_id, user_id, action, scope, google_event_id, series_id,
          fields, base, mine, title)
        values (v_event.calendar_id, v_user_id, 'update', p_scope, v_event.google_event_id, v_event.recurring_event_id,
          v_fields, v_current, v_mine, v_values.title);
      update private.google_calendar_events e set revision = e.revision + 1 where e.id = v_event.id;
    end if;
    perform private.google_queue_push(v_calendar.connection_id);
    return pg_catalog.jsonb_build_object('outcome', 'saved',
      'revision', (select e.revision from private.google_calendar_events e where e.id = v_event.id));
  end
  $$;

-- Deletes a Google event from Madeora, after the person chose where (Modules.md §4.2, option B):
--   p_destination 'madeora': "Remove from Madeora": an exclusion hides it (and, for a series scope, the series
--     or the series from this occurrence on) from every Madeora view; Google is not touched; Settings can
--     restore it. Any calendar the person syncs, even read-only.
--   p_destination 'everywhere': "Delete everywhere": queued for Google (writable calendar only); the event
--     stays visible as deleting until Google confirms.
-- p_dry_run answers the preview. Outcomes: 'removed', 'deleting', 'preview', 'not_found', 'read_only',
-- 'authorization_expired', 'stale', 'invalid_scope', 'busy', 'conflict_open', 'limit_reached'.
create function public.delete_google_calendar_event(
  p_event_id uuid, p_scope text, p_destination text, p_revision integer, p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.google_calendar_events;
    v_calendar private.google_calendars;
    v_problem text;
  begin
    if p_event_id is null or p_scope is null or p_scope not in ('event', 'following', 'all') or p_revision is null
        or p_destination is null or p_destination not in ('madeora', 'everywhere') or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_event := private.google_own_event(v_user_id, p_event_id);
    if v_event.id is null then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_calendar := private.google_own_calendar(v_user_id, v_event.calendar_id);
    if v_calendar.id is null then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_problem := private.google_write_problem(v_calendar);
    select * into v_event from private.google_calendar_events e where e.id = v_event.id;
    if p_scope <> 'event' and v_event.recurring_event_id is null then
      return '{"outcome": "invalid_scope"}'::jsonb;
    end if;
    if v_event.revision <> p_revision then
      return '{"outcome": "stale"}'::jsonb;
    end if;
    if p_destination = 'everywhere' and v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    if p_dry_run then
      return private.google_scope_preview(v_event, p_scope);
    end if;
    v_problem := private.google_change_blocker(v_event, p_scope);
    if v_problem is null and exists (select 1 from private.google_calendar_changes x
        where x.calendar_id = v_event.calendar_id and x.scope = 'event' and x.google_event_id = v_event.google_event_id) then
      v_problem := case when exists (select 1 from private.google_calendar_changes x
          where x.calendar_id = v_event.calendar_id and x.scope = 'event'
            and x.google_event_id = v_event.google_event_id and x.state = 'conflict') then 'conflict_open' else 'busy' end;
    end if;
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;

    if p_destination = 'madeora' then
      if (select count(*) from private.google_calendar_exclusions x where x.calendar_id = v_event.calendar_id)
          >= private.google_calendar_limit('exclusions') then
        return '{"outcome": "limit_reached"}'::jsonb;
      end if;
      insert into private.google_calendar_exclusions (calendar_id, kind, google_id, from_at, title, starts_on)
        values (v_event.calendar_id,
          case p_scope when 'event' then 'event' when 'all' then 'series' else 'following' end,
          case when p_scope = 'event' then v_event.google_event_id else v_event.recurring_event_id end,
          case when p_scope = 'following' then private.google_event_at(v_event) end,
          v_event.title,
          coalesce(v_event.starts_on, (v_event.starts_at at time zone coalesce(v_event.time_zone, 'UTC'))::date))
        on conflict on constraint google_calendar_exclusions_key do nothing;
      return '{"outcome": "removed"}'::jsonb;
    end if;

    if (select count(*) from private.google_calendar_changes x where x.user_id = v_user_id)
        >= private.google_calendar_limit('open_changes') then
      return '{"outcome": "limit_reached"}'::jsonb;
    end if;
    insert into private.google_calendar_changes (calendar_id, user_id, action, scope, google_event_id, series_id, base,
        title)
      values (v_event.calendar_id, v_user_id, 'delete', p_scope, v_event.google_event_id,
        case when p_scope <> 'event' then v_event.recurring_event_id end, private.google_snapshot(v_event), v_event.title);
    update private.google_calendar_events e set revision = e.revision + 1 where e.id = v_event.id;
    perform private.google_queue_push(v_calendar.connection_id);
    return '{"outcome": "deleting"}'::jsonb;
  end
  $$;

-- The caller's own change, locked with its calendar; null when it is not theirs.
create function private.google_own_change(p_user_id uuid, p_change_id uuid) returns private.google_calendar_changes
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_change private.google_calendar_changes;
  begin
    perform 1 from private.google_calendars c
      join private.google_calendar_changes x on x.calendar_id = c.id
      where x.id = p_change_id and x.user_id = p_user_id
      for update of c;
    select * into v_change from private.google_calendar_changes x
      where x.id = p_change_id and x.user_id = p_user_id for update;
    return v_change;
  end
  $$;

-- The person's choice in a conflict (only theirs; nothing else ends one):
--   'google':  Google's version stays; Madeora's change is dropped (a deletion Google made removes the event).
--   'madeora': Madeora's version is sent again, based on Google's current version (its etag), so a newer Google
--              change in between makes a new conflict instead of an overwrite. Against a deletion in Google it
--              restores the event; for "Delete everywhere" against an edit in Google it deletes anyway.
-- Outcomes: 'resolved', 'not_found', 'not_in_conflict'.
create function public.resolve_google_calendar_conflict(p_change_id uuid, p_choice text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_change private.google_calendar_changes;
    v_event private.google_calendar_events;
    v_deleted boolean;
    v_connection uuid;
  begin
    if p_change_id is null or p_choice is null or p_choice not in ('madeora', 'google') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_change := private.google_own_change(v_user_id, p_change_id);
    if v_change.id is null then
      return 'not_found';
    end if;
    if v_change.state <> 'conflict' then
      return 'not_in_conflict';
    end if;
    v_deleted := coalesce((v_change.theirs ->> 'deleted')::boolean, false);
    if v_change.scope = 'event' then
      select * into v_event from private.google_calendar_events e
        where e.calendar_id = v_change.calendar_id and e.google_event_id = v_change.google_event_id;
    end if;
    select c.connection_id into v_connection from private.google_calendars c where c.id = v_change.calendar_id;

    if p_choice = 'google' then
      if v_event.id is not null then
        if v_deleted then
          delete from private.google_calendar_events e where e.id = v_event.id;
        else
          perform private.google_row_set(v_event.id, v_change.theirs);
        end if;
      end if;
      delete from private.google_calendar_changes x where x.id = v_change.id;
      return 'resolved';
    end if;

    if v_change.scope <> 'event' and v_deleted then
      -- Google deleted the series: Madeora cannot recreate a series safely. The change stays as failed with
      -- the reason, so the person discards it (or recreates the event); nothing is sent.
      update private.google_calendar_changes x set state = 'failed', error_code = 'series_limit', theirs = null,
          conflict_fields = '{}', version = x.version + 1, updated_at = pg_catalog.now()
        where x.id = v_change.id;
      return 'resolved';
    end if;
    if v_change.action = 'delete' and v_deleted then
      -- Both sides now want it gone: nothing to send.
      if v_event.id is not null then
        delete from private.google_calendar_events e where e.id = v_event.id;
      end if;
      delete from private.google_calendar_changes x where x.id = v_change.id;
      return 'resolved';
    end if;
    update private.google_calendar_changes x set state = 'pending', base = x.theirs, theirs = null,
        conflict_fields = '{}', error_code = null, attempts = 0, version = x.version + 1,
        fields = case when x.action = 'update' then
          case when v_deleted then array['title', 'location', 'description', 'time']
          else (select coalesce(pg_catalog.array_agg(f), '{}') from pg_catalog.unnest(array['title', 'location',
            'description', 'time']) f where private.google_field(x.theirs, f) is distinct from private.google_field(x.mine, f)
              and (f = any (x.fields) or x.scope = 'event')) end
          else x.fields end,
        updated_at = pg_catalog.now()
      where x.id = v_change.id;
    if v_change.action = 'update' and pg_catalog.cardinality(
        (select x.fields from private.google_calendar_changes x where x.id = v_change.id)) = 0 then
      -- Google already has Madeora's values.
      delete from private.google_calendar_changes x where x.id = v_change.id;
      if v_event.id is not null then
        perform private.google_row_set(v_event.id, v_change.theirs);
      end if;
      return 'resolved';
    end if;
    if v_event.id is not null and v_change.action = 'update' then
      -- The stricter privacy flag stays until Google confirms, so a Home never sees a version made private.
      perform private.google_row_set(v_event.id, v_change.mine
        || pg_catalog.jsonb_build_object('etag', v_change.theirs -> 'etag',
          'private', coalesce((v_change.mine ->> 'private')::boolean, false)
            or coalesce((v_change.theirs ->> 'private')::boolean, false)));
    end if;
    perform private.google_queue_push(v_connection);
    return 'resolved';
  end
  $$;

-- Try again after a failure. Outcomes: 'queued', 'not_found', 'not_failed'.
create function public.retry_google_calendar_change(p_change_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_change private.google_calendar_changes;
  begin
    v_change := private.google_own_change(v_user_id, p_change_id);
    if v_change.id is null then
      return 'not_found';
    end if;
    if v_change.state <> 'failed' then
      return 'not_failed';
    end if;
    update private.google_calendar_changes x set state = 'pending', error_code = null, attempts = 0,
        updated_at = pg_catalog.now()
      where x.id = v_change.id;
    perform private.google_queue_push((select c.connection_id from private.google_calendars c where c.id = v_change.calendar_id));
    return 'queued';
  end
  $$;

-- Discard a change that has not reached Google (waiting or failed; a conflict needs a choice): the event goes
-- back to Google's version (a new event that Google never got disappears). If a run already sent it, the next
-- sync shows what Google has. Outcomes: 'discarded', 'not_found', 'in_conflict'.
create function public.discard_google_calendar_change(p_change_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_change private.google_calendar_changes;
    v_event private.google_calendar_events;
  begin
    v_change := private.google_own_change(v_user_id, p_change_id);
    if v_change.id is null then
      return 'not_found';
    end if;
    if v_change.state = 'conflict' then
      return 'in_conflict';
    end if;
    select * into v_event from private.google_calendar_events e
      where e.calendar_id = v_change.calendar_id and e.google_event_id = v_change.google_event_id;
    if v_change.scope = 'event' and v_event.id is not null then
      if v_change.action = 'create' then
        delete from private.google_calendar_events e where e.id = v_event.id;
      elsif v_change.action = 'update' then
        perform private.google_row_set(v_event.id, v_change.base);
      else
        update private.google_calendar_events e set revision = e.revision + 1 where e.id = v_event.id;
      end if;
    elsif v_event.id is not null then
      update private.google_calendar_events e set revision = e.revision + 1 where e.id = v_event.id;
    end if;
    delete from private.google_calendar_changes x where x.id = v_change.id;
    return 'discarded';
  end
  $$;

-- Restores an event removed from Madeora (only the calendar's owner). Outcomes: 'restored', 'not_found'.
create function public.restore_google_calendar_event(p_exclusion_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
  begin
    delete from private.google_calendar_exclusions x
      using private.google_calendars c
      where x.id = p_exclusion_id and c.id = x.calendar_id and c.user_id = v_user_id
      returning x.id into v_id;
    return case when v_id is null then 'not_found' else 'restored' end;
  end
  $$;

-- The sync job: calendar list and events, now aware of changes ----------------------------------------------

-- As in S33, plus: the first list makes the primary calendar the target for new events; a calendar Google no
-- longer lists also loses its open changes and stops being the target.
create or replace function public.google_sync_calendars(p_connection_id uuid, p_lease uuid, p_calendars jsonb) returns jsonb
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
    ), drop_changes as (
      delete from private.google_calendar_changes x where x.calendar_id in (select id from gone)
    )
    delete from private.google_calendar_home_shares s where s.calendar_id in (select id from gone);
    update private.google_calendar_connections k set calendars_listed_at = pg_catalog.now(),
        write_calendar_id = case
          when v_first then (select c.id from private.google_calendars c
            where c.connection_id = k.id and c.is_primary and c.sync_enabled and c.access_role in ('owner', 'writer')
            limit 1)
          when exists (select 1 from private.google_calendars c where c.id = k.write_calendar_id
            and c.available and c.sync_enabled and c.access_role in ('owner', 'writer')) then k.write_calendar_id
        end
      where k.id = v_connection.id;
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

-- As in S33, except that an event with an open change of its own is weighed against it
-- (private.google_reconcile) instead of being overwritten: Google's unchanged version is skipped, other changes
-- merge or make a conflict. Every event seen in a full pass is still marked, also the skipped ones.
create or replace function public.google_sync_apply_events(p_calendar_id uuid, p_lease uuid, p_full boolean, p_events jsonb)
returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_calendar private.google_calendars := private.google_leased_calendar(p_calendar_id, p_lease);
    v_count integer;
    v_item record;
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
    create temporary table if not exists pg_temp.google_page (id text primary key, x jsonb not null, cancelled boolean not null,
      change_id uuid) on commit drop;
    truncate pg_temp.google_page;
    -- Only the last item per Google id in the page counts.
    insert into pg_temp.google_page (id, x, cancelled, change_id)
      select l.x ->> 'id', l.x, coalesce((l.x ->> 'cancelled')::boolean, false),
        (select c.id from private.google_calendar_changes c
          where c.calendar_id = v_calendar.id and c.scope = 'event' and c.google_event_id = l.x ->> 'id')
      from (select distinct on (x ->> 'id') x from pg_catalog.jsonb_array_elements(p_events)
          with ordinality as a(x, n) order by x ->> 'id', n desc) l;

    -- Events with an open change of their own.
    for v_item in select * from pg_temp.google_page p where p.change_id is not null loop
      if p_full then
        update private.google_calendar_events e set seen_in = p_lease
          where e.calendar_id = v_calendar.id and e.google_event_id = v_item.id;
      end if;
      if v_item.cancelled then
        perform private.google_reconcile(v_item.change_id, '{"deleted": true}'::jsonb);
      elsif (v_item.x ->> 'etag') is not distinct from (select coalesce(c.base, c.theirs) ->> 'etag'
          from private.google_calendar_changes c where c.id = v_item.change_id)
          and exists (select 1 from private.google_calendar_changes c where c.id = v_item.change_id and c.action <> 'create') then
        -- Google's version is the one Madeora's change is based on: nothing new.
        null;
      elsif exists (select 1 from private.google_calendar_changes c where c.id = v_item.change_id
          and c.state = 'conflict' and (c.theirs ->> 'etag') is not distinct from (v_item.x ->> 'etag')) then
        null;
      else
        perform private.google_reconcile(v_item.change_id, v_item.x - 'id' - 'updated' - 'cancelled');
        update private.google_calendar_events e set
            link = case when v_item.x ->> 'link' is not null then v_item.x ->> 'link' else e.link end,
            recurring_event_id = v_item.x ->> 'recurringEventId', original_start = v_item.x ->> 'originalStart',
            google_updated = (v_item.x ->> 'updated')::timestamptz,
            seen_in = case when p_full then p_lease else e.seen_in end
          where e.calendar_id = v_calendar.id and e.google_event_id = v_item.id;
      end if;
    end loop;

    -- A cancelled series: occurrences with an open change of their own are weighed as deleted, the rest go.
    for v_item in
      select c.id as change_id from private.google_calendar_changes c
      join private.google_calendar_events e on e.calendar_id = c.calendar_id and e.google_event_id = c.google_event_id
      join pg_temp.google_page p on p.cancelled and p.id = e.recurring_event_id
      where c.calendar_id = v_calendar.id and c.scope = 'event'
    loop
      perform private.google_reconcile(v_item.change_id, '{"deleted": true}'::jsonb);
    end loop;
    delete from private.google_calendar_events e
      where e.calendar_id = v_calendar.id
        and exists (select 1 from pg_temp.google_page p where p.cancelled and p.change_id is null
          and (e.google_event_id = p.id or e.recurring_event_id = p.id))
        and not exists (select 1 from private.google_calendar_changes c
          where c.calendar_id = e.calendar_id and c.scope = 'event' and c.google_event_id = e.google_event_id);

    insert into private.google_calendar_events as t (calendar_id, google_event_id, etag, google_updated, status, title,
        location, description, all_day, starts_on, ends_on, starts_at, ends_at, time_zone, recurring_event_id,
        original_start, private_in_google, link, seen_in, synced_at)
      select v_calendar.id, x ->> 'id', x ->> 'etag', (x ->> 'updated')::timestamptz,
        x ->> 'status', x ->> 'title', x ->> 'location', x ->> 'description', (x ->> 'allDay')::boolean,
        (x ->> 'startsOn')::date, (x ->> 'endsOn')::date, (x ->> 'startsAt')::timestamptz, (x ->> 'endsAt')::timestamptz,
        x ->> 'timeZone', x ->> 'recurringEventId', x ->> 'originalStart', coalesce((x ->> 'private')::boolean, false),
        x ->> 'link', case when p_full then p_lease end, pg_catalog.now()
      from pg_temp.google_page p
      where not p.cancelled and p.change_id is null
      on conflict on constraint google_calendar_events_google_key do update
        set etag = excluded.etag, google_updated = excluded.google_updated, status = excluded.status,
          title = excluded.title, location = excluded.location, description = excluded.description,
          all_day = excluded.all_day, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
          starts_at = excluded.starts_at, ends_at = excluded.ends_at, time_zone = excluded.time_zone,
          recurring_event_id = excluded.recurring_event_id, original_start = excluded.original_start,
          private_in_google = excluded.private_in_google, link = excluded.link,
          seen_in = coalesce(excluded.seen_in, t.seen_in),
          revision = case when t.etag is not distinct from excluded.etag then t.revision else t.revision + 1 end,
          synced_at = case when t.etag is not distinct from excluded.etag then t.synced_at else excluded.synced_at end;
    select count(*) into v_count from private.google_calendar_events e where e.calendar_id = v_calendar.id;
    return v_count;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation
      or not_null_violation or string_data_right_truncation then
      raise exception 'invalid page' using errcode = '22023';
  end
  $$;

-- As in S33; a full pass that did not see an event with an open change of its own weighs it as deleted in
-- Google, except a new event Google has not received yet.
create or replace function public.google_sync_finish_calendar(
  p_calendar_id uuid, p_lease uuid, p_full boolean, p_sync_token text default null, p_error text default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_calendar private.google_calendars := private.google_leased_calendar(p_calendar_id, p_lease);
    v_change uuid;
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
    if not v_calendar.sync_enabled or not v_calendar.available then
      return true;
    end if;
    if p_full then
      for v_change in
        select c.id from private.google_calendar_changes c
        join private.google_calendar_events e on e.calendar_id = c.calendar_id and e.google_event_id = c.google_event_id
        where c.calendar_id = v_calendar.id and c.scope = 'event' and c.action <> 'create'
          and c.state <> 'conflict' and e.seen_in is distinct from p_lease
          -- Only inside the window the full pass listed (30 days back, 365 ahead; a day's margin): an event
          -- outside it was simply not asked for, not deleted.
          and coalesce(e.ends_at, (e.ends_on + 1)::timestamp at time zone 'UTC') > pg_catalog.now() - interval '29 days'
          and coalesce(e.starts_at, e.starts_on::timestamp at time zone 'UTC') < pg_catalog.now() + interval '364 days'
      loop
        perform private.google_reconcile(v_change, '{"deleted": true}'::jsonb);
      end loop;
      delete from private.google_calendar_events e
        where e.calendar_id = v_calendar.id and e.seen_in is distinct from p_lease
          and not exists (select 1 from private.google_calendar_changes c
            where c.calendar_id = e.calendar_id and c.scope = 'event' and c.google_event_id = e.google_event_id);
    end if;
    update private.google_calendars c set sync_token = p_sync_token, last_synced_at = pg_catalog.now(),
        full_synced_at = case when p_full then pg_catalog.now() else c.full_synced_at end, last_error_code = null
      where c.id = v_calendar.id;
    return true;
  end
  $$;

-- As in S33, plus: when the person made a change while this run held the lease, a follow-up run is queued.
create or replace function public.google_sync_finish(p_connection_id uuid, p_lease uuid, p_outcome text) returns boolean
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
      return true;
    else
      update private.google_calendar_connections k set last_error_code = p_outcome,
          sync_lease = null, sync_lease_until = null
        where k.id = v_connection.id;
    end if;
    if exists (select 1 from private.google_calendar_changes x
        join private.google_calendars c on c.id = x.calendar_id
        where c.connection_id = v_connection.id and x.state = 'pending'
          and x.updated_at >= v_connection.last_attempt_at) then
      -- A run asked for during this one found the lease taken and ended: ask again.
      update private.google_calendar_connections k set sync_requested_at = null where k.id = v_connection.id;
      perform private.google_queue_push(v_connection.id);
    end if;
    return true;
  end
  $$;

-- The changes a run sends, oldest first (pending ones of calendars that sync), with what the push needs. Null
-- when the lease is not held.
create function public.google_push_changes(p_connection_id uuid, p_lease uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_connection private.google_calendar_connections := private.google_leased(p_connection_id, p_lease);
  begin
    if v_connection.id is null then
      return null;
    end if;
    return coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', x.id, 'version', x.version, 'calendarId', c.id, 'googleCalendarId', c.google_calendar_id,
          'calendarTimeZone', c.time_zone, 'action', x.action, 'scope', x.scope, 'googleEventId', x.google_event_id,
          'seriesId', x.series_id, 'fields', pg_catalog.to_jsonb(x.fields), 'base', x.base, 'mine', x.mine,
          'repeat', x.repeat
        ) order by x.created_at, x.id)
      from (select x.* from private.google_calendar_changes x
        join private.google_calendars c on c.id = x.calendar_id
        where c.connection_id = v_connection.id and c.sync_enabled and c.available and x.state = 'pending'
        order by x.created_at, x.id limit private.google_calendar_limit('push_batch')) x
      join private.google_calendars c on c.id = x.calendar_id), '[]'::jsonb);
  end
  $$;

-- Records what Google answered for a change (p_version: the change's version that was sent):
--   {"outcome": "done", "event": <normalized event or null>}: Google confirmed. The change ends, unless the
--     person changed it again meanwhile (it is then rebased on Google's answer and stays). A new repeating
--     event's placeholder goes (its occurrences come with the next pull); a deletion removes what it covered.
--   {"outcome": "changed", "theirs": <normalized event or {"deleted": true}>}: Google has a newer version
--     (etag mismatch, or gone): weighed by private.google_reconcile (merge or conflict).
--   {"outcome": "failed", "code": ...}: Google refused for good; the person sees why and chooses.
--   {"outcome": "retry", "code": ...}: Google unavailable; the change waits for the next run (failed after
--     too many tries).
-- Answers the change as it now stands for another try in the same run ({"state": ...}), or null when the lease
-- is not held. 22023 for a malformed result.
create function public.google_push_result(p_change_id uuid, p_lease uuid, p_version integer, p_result jsonb)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_change private.google_calendar_changes;
    v_calendar private.google_calendars;
    v_outcome text := p_result ->> 'outcome';
    v_event private.google_calendar_events;
    v_answer jsonb;
    v_code text := p_result ->> 'code';
    v_reconciled text;
    v_calendar_id uuid;
  begin
    if p_change_id is null or p_version is null or p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object'
      or v_outcome is null or v_outcome not in ('done', 'changed', 'failed', 'retry')
      or (v_outcome in ('failed', 'retry') and (v_code is null or v_code !~ '^[a-z_]{1,40}$'))
      or (v_outcome = 'changed' and pg_catalog.jsonb_typeof(p_result -> 'theirs') <> 'object') then
      raise exception 'invalid result' using errcode = '22023';
    end if;
    select x.calendar_id into v_calendar_id from private.google_calendar_changes x where x.id = p_change_id;
    v_calendar := private.google_leased_calendar(v_calendar_id, p_lease);
    if v_calendar.id is null then
      return case when exists (select 1 from private.google_calendar_changes x where x.id = p_change_id)
        then null else '{"state": "gone"}'::jsonb end;
    end if;
    select * into v_change from private.google_calendar_changes x where x.id = p_change_id for update;
    if v_change.scope = 'event' then
      select * into v_event from private.google_calendar_events e
        where e.calendar_id = v_change.calendar_id and e.google_event_id = v_change.google_event_id;
    end if;

    if v_outcome in ('retry', 'failed') and v_change.state <> 'pending' then
      -- A conflict (or an earlier failure) stays as it is.
      return pg_catalog.jsonb_build_object('state', v_change.state);
    end if;
    if v_outcome = 'retry' then
      update private.google_calendar_changes x set attempts = x.attempts + 1, error_code = v_code,
          state = case when x.attempts + 1 >= private.google_calendar_limit('push_attempts') then 'failed' else x.state end,
          updated_at = case when x.attempts + 1 >= private.google_calendar_limit('push_attempts') then pg_catalog.now()
            else x.updated_at end
        where x.id = v_change.id;
      return '{"state": "waiting"}'::jsonb;
    end if;
    if v_outcome = 'failed' then
      if v_change.version = p_version then
        update private.google_calendar_changes x set state = 'failed', error_code = v_code, updated_at = pg_catalog.now()
          where x.id = v_change.id;
        return '{"state": "failed"}'::jsonb;
      end if;
      return '{"state": "waiting"}'::jsonb;
    end if;
    if v_outcome = 'changed' then
      v_reconciled := private.google_reconcile(v_change.id, (p_result -> 'theirs') - 'id' - 'updated' - 'cancelled'
        || case when coalesce((p_result -> 'theirs' ->> 'cancelled')::boolean, false) then '{"deleted": true}'::jsonb
          else '{}'::jsonb end);
      if v_reconciled = 'merged' then
        select * into v_change from private.google_calendar_changes x where x.id = p_change_id;
        return pg_catalog.jsonb_build_object('state', 'pending', 'version', v_change.version, 'base', v_change.base,
          'mine', v_change.mine, 'fields', pg_catalog.to_jsonb(v_change.fields), 'action', v_change.action);
      end if;
      return pg_catalog.jsonb_build_object('state', v_reconciled);
    end if;

    -- Done.
    if p_result ? 'event' and pg_catalog.jsonb_typeof(p_result -> 'event') = 'object'
        and pg_catalog.jsonb_typeof(p_result -> 'event' -> 'id') <> 'string' then
      raise exception 'invalid result' using errcode = '22023';
    end if;
    v_answer := case when pg_catalog.jsonb_typeof(p_result -> 'event') = 'object' then (p_result -> 'event') - 'id'
      - 'updated' - 'cancelled' end;
    if v_change.action = 'delete' then
      delete from private.google_calendar_events e
        where e.calendar_id = v_change.calendar_id and case v_change.scope
          when 'event' then e.google_event_id = v_change.google_event_id
          when 'all' then e.recurring_event_id = v_change.series_id
          else e.recurring_event_id = v_change.series_id and private.google_event_at(e)
            >= private.google_original_at(v_change.base ->> 'originalStart', (v_change.base ->> 'startsAt')::timestamptz)
        end;
      delete from private.google_calendar_changes x where x.id = v_change.id;
      return '{"state": "done"}'::jsonb;
    end if;
    if v_change.scope <> 'event' then
      delete from private.google_calendar_changes x where x.id = v_change.id;
      return '{"state": "done"}'::jsonb;
    end if;
    if v_change.action = 'create' and v_change.repeat is not null then
      -- The placeholder of a new series; its occurrences arrive with the pull that follows (it cannot be edited
      -- while it waits, so there is no newer version to keep).
      delete from private.google_calendar_events e where e.id = v_event.id;
      delete from private.google_calendar_changes x where x.id = v_change.id;
      return '{"state": "done"}'::jsonb;
    end if;
    if v_answer is null then
      raise exception 'invalid result' using errcode = '22023';
    end if;
    if v_change.version = p_version then
      if v_event.id is not null then
        perform private.google_row_set(v_event.id, v_answer);
      end if;
      delete from private.google_calendar_changes x where x.id = v_change.id;
      return '{"state": "done"}'::jsonb;
    end if;
    -- The person changed it again while it was being sent: Google now has the version sent; send the rest.
    update private.google_calendar_changes x set action = 'update', base = v_answer, repeat = null,
        fields = private.google_diff(v_answer, x.mine),
        mine = x.mine || pg_catalog.jsonb_build_object('etag', v_answer -> 'etag'), updated_at = pg_catalog.now()
      where x.id = v_change.id;
    if pg_catalog.cardinality((select x.fields from private.google_calendar_changes x where x.id = v_change.id)) = 0 then
      delete from private.google_calendar_changes x where x.id = v_change.id;
      if v_event.id is not null then
        perform private.google_row_set(v_event.id, v_answer);
      end if;
      return '{"state": "done"}'::jsonb;
    end if;
    if v_event.id is not null then
      update private.google_calendar_events e set etag = v_answer ->> 'etag' where e.id = v_event.id;
    end if;
    return '{"state": "waiting"}'::jsonb;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation
      or not_null_violation or string_data_right_truncation then
      raise exception 'invalid result' using errcode = '22023';
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_google_calendar_event', 'get_google_calendar_connection', 'set_google_calendar_settings',
      'set_google_calendar_write_target', 'create_google_calendar_event', 'update_google_calendar_event',
      'delete_google_calendar_event', 'resolve_google_calendar_conflict', 'retry_google_calendar_change',
      'discard_google_calendar_change', 'restore_google_calendar_event'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'google_sync_calendars', 'google_sync_apply_events', 'google_sync_finish_calendar', 'google_sync_finish',
      'google_push_changes', 'google_push_result'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'google%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
