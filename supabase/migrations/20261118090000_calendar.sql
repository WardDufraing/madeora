-- S32: native calendar (brief plans/steps/S32-brief.md; ADR 0042; Modules.md §4.2; Project-specification
-- "Confirmed shared Home calendar authorization", §11.2 "Calendar sharing — approved privacy policy",
-- "Confirmed Home vacation banners on the main calendar").
--
-- An event belongs to one person (a personal event) or to one Home (a Home event). Nothing here is
-- exposed as a table: people use security-definer functions that run with their own session and recheck
-- the confirmed caller, their current membership and their access on every call.
--
-- Privacy (§11.2, option A): a personal event is visible to its owner only, unless the owner shares that
-- event with a Home they belong to; then every current member of that Home sees it in full, read-only.
-- Nothing else ever reveals a personal event: no busy block, count, time, existence or error difference.
-- A Home calendar lists only Home events and events shared with that Home. A share is tied to the
-- owner's membership, so it ends (and disappears) when they leave.
--
-- Home calendar permissions (packages/domain/src/permissions/calendar.ts makes the same decisions):
-- every current member sees the Home's events. A per-member level decides the rest: 'view', 'edit'
-- (create and edit Home events; the default) or 'edit_delete' (also delete and restore them). The Owner
-- and Administrators granted the new delegable capability manageHomeCalendar ('manage') do everything
-- and set the other members' levels, never their own. Being an event's creator gives no extra right.
--
-- Recurrence uses the S19 schedule rules (private.series_first_on_or_after) on the event's local dates
-- in its own timezone, so a timed series keeps its wall-clock time across daylight-saving changes.
-- Occurrences are computed when read; exceptions keyed by the original date move, change or cancel one.

-- Audit subjects, the new capability, trash types -----------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series',
    'pet', 'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity', 'pet_care_occurrence',
    'calendar_event'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping',
    'manageHomeMeals', 'manageHomeHabits', 'manageHomeGoals', 'manageHomePets',
    'managePetMedicalAccess', 'manageHomeCalendar'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping', 'meals', 'habits',
    'goals', 'pets', 'calendar'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit', 'goal',
    'goal_series', 'pet', 'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity', 'calendar_event'
  ));

-- Limits and value rules ---------------------------------------------------------------------------------

-- apps/web/src/calendar/schema.ts uses the same numbers.
create function private.calendar_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'events' then 5000             -- events per person and per Home not in the trash (a series is one)
    when 'exceptions' then 500          -- changed or cancelled occurrences per series
    when 'participants' then 20
    when 'shares' then 20               -- Homes one personal event is shared with
    when 'title' then 200
    when 'location' then 200
    when 'description' then 4000
    when 'all_day_days' then 366        -- days an all-day event may span
    when 'timed_days' then 14           -- days a timed event may last
    when 'window_days' then 62          -- days one read may cover
    when 'occurrences' then 1000        -- occurrences one read returns at most
    when 'late_minutes' then 30         -- a reminder later than this is not sent
  end;
  $$;

-- One line of plain text: no line breaks or tabs. Null for null.
create function private.calendar_single_line(p_text text, p_max integer) returns boolean
  language sql immutable set search_path = '' as $$
  select private.is_plain_text(p_text, p_max) and p_text !~ '[\t\r\n]';
  $$;

-- Whether p_zone is an IANA timezone this database knows.
create function private.calendar_valid_zone(p_zone text) returns boolean
  language sql stable set search_path = '' as $$
  select p_zone is not null and pg_catalog.char_length(p_zone) <= 64 and p_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'
    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone);
  $$;

-- Tables -------------------------------------------------------------------------------------------------

create table private.calendar_events (
  id uuid primary key,
  -- Exactly one owner: a person (a personal event) or a Home (a Home event).
  owner_user_id uuid references auth.users (id) on delete cascade,
  home_id uuid references public.homes (id) on delete cascade,
  title text not null constraint calendar_events_title_check check (private.calendar_single_line(title, 200)),
  location text constraint calendar_events_location_check check (private.calendar_single_line(location, 200)),
  description text constraint calendar_events_description_check check (private.is_plain_text(description, 4000)),
  all_day boolean not null,
  -- All-day: the first and the last day (inclusive). Timed: the local start and end dates, with the
  -- local start and end times, in `timezone`. A recurring event's first occurrence starts on starts_on.
  starts_on date not null,
  ends_on date not null,
  start_time time without time zone,
  end_time time without time zone,
  timezone text not null,
  -- Recurrence (null frequency: a single event). until_date is the last possible date of an
  -- occurrence's start: the chosen end date or the date of the max_count-th occurrence.
  frequency text constraint calendar_events_frequency_check check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  interval_count integer,
  weekdays smallint[],
  repeat_ends_on date,
  max_count integer,
  until_date date,
  -- Home events only: the participants' user ids (current members when saved; reads drop departed ones).
  participants uuid[] not null default '{}',
  -- Minutes before each occurrence's start (08:00 on its first day for an all-day one); null: no reminder.
  reminder_minutes integer constraint calendar_events_reminder_check check (reminder_minutes in (0, 15, 60, 1440)),
  revision integer not null default 1 constraint calendar_events_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint calendar_events_one_owner check (num_nonnulls(owner_user_id, home_id) = 1),
  constraint calendar_events_dates_check check (ends_on >= starts_on
    and starts_on between date '2000-01-01' and date '2199-12-31'),
  constraint calendar_events_time_shape check (
    (all_day and start_time is null and end_time is null)
    or (not all_day and start_time is not null and end_time is not null
      and (ends_on + end_time) > (starts_on + start_time)
      and (ends_on + end_time) - (starts_on + start_time) <= interval '14 days')),
  constraint calendar_events_all_day_span check (not all_day or ends_on - starts_on < 366),
  constraint calendar_events_rule_check check (
    (frequency is null and interval_count is null and weekdays is null and repeat_ends_on is null
      and max_count is null and until_date is null)
    or (frequency is not null and private.valid_series_rule(frequency, interval_count, weekdays, starts_on,
      repeat_ends_on, max_count))),
  constraint calendar_events_participants_check check (
    cardinality(participants) <= 20 and (home_id is not null or cardinality(participants) = 0))
);

create index calendar_events_owner_idx on private.calendar_events (owner_user_id) where deleted_at is null;
create index calendar_events_home_idx on private.calendar_events (home_id) where deleted_at is null;

-- A personal event shared with a Home. Tied to the owner's membership of that Home, so leaving ends it.
create table private.calendar_event_shares (
  event_id uuid not null references private.calendar_events (id) on delete cascade,
  home_id uuid not null,
  user_id uuid not null,
  shared_at timestamptz not null default now(),
  constraint calendar_event_shares_pkey primary key (event_id, home_id),
  constraint calendar_event_shares_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);
create index calendar_event_shares_home_idx on private.calendar_event_shares (home_id);
create index calendar_event_shares_member_idx on private.calendar_event_shares (home_id, user_id);

-- One changed or cancelled occurrence of a recurring event, keyed by the date it would have started on.
-- `fields` names what it overrides ('title', 'location', 'description', 'time', 'participants'); every
-- other field follows the series. A field in `fields` with a null value (location, description) is
-- cleared for that occurrence.
create table private.calendar_event_exceptions (
  event_id uuid not null references private.calendar_events (id) on delete cascade,
  original_date date not null,
  cancelled boolean not null default false,
  fields text[] not null default '{}' constraint calendar_event_exceptions_fields_check
    check (fields <@ array['title', 'location', 'description', 'time', 'participants']),
  title text constraint calendar_event_exceptions_title_check check (private.calendar_single_line(title, 200)),
  location text constraint calendar_event_exceptions_location_check check (private.calendar_single_line(location, 200)),
  description text constraint calendar_event_exceptions_description_check
    check (private.is_plain_text(description, 4000)),
  all_day boolean,
  starts_on date,
  ends_on date,
  start_time time without time zone,
  end_time time without time zone,
  participants uuid[] constraint calendar_event_exceptions_participants_check check (cardinality(participants) <= 20),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint calendar_event_exceptions_pkey primary key (event_id, original_date),
  constraint calendar_event_exceptions_cancelled_check check (not cancelled or fields = '{}'),
  constraint calendar_event_exceptions_title_shape check (('title' = any (fields)) = (title is not null)),
  constraint calendar_event_exceptions_time_shape check (
    ('time' = any (fields)) = (all_day is not null)
    and (all_day is null or (starts_on is not null and ends_on is not null and ends_on >= starts_on))
    and (all_day is null or (all_day and start_time is null and end_time is null and ends_on - starts_on < 366)
      or (not all_day and start_time is not null and end_time is not null
        and (ends_on + end_time) > (starts_on + start_time)
        and (ends_on + end_time) - (starts_on + start_time) <= interval '14 days'))),
  constraint calendar_event_exceptions_participants_shape check (('participants' = any (fields)) = (participants is not null))
);

-- A member's Home calendar level. No row: 'edit'. The Owner and Administrators granted
-- manageHomeCalendar are 'manage' whatever is stored. Ends with the membership.
create table private.home_calendar_access (
  home_id uuid not null,
  user_id uuid not null,
  level text not null constraint home_calendar_access_level_check check (level in ('view', 'edit', 'edit_delete')),
  set_by uuid references auth.users (id) on delete set null,
  set_at timestamptz not null default now(),
  constraint home_calendar_access_pkey primary key (home_id, user_id),
  constraint home_calendar_access_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);

-- A person's own view settings for their Personal calendar (home_id null) or one Home's (presentation
-- only): Home vacation banners (Home only, default on) and the task and chore overlays (default off;
-- chores are Home only). Turning an overlay off hides it and never changes a task or chore.
create table private.calendar_view_preferences (
  user_id uuid not null references auth.users (id) on delete cascade,
  home_id uuid,
  show_vacations boolean not null default true,
  show_tasks boolean not null default false,
  show_chores boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint calendar_view_preferences_context_key unique nulls not distinct (user_id, home_id),
  constraint calendar_view_preferences_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);

alter table private.calendar_events enable row level security;
alter table private.calendar_event_shares enable row level security;
alter table private.calendar_event_exceptions enable row level security;
alter table private.home_calendar_access enable row level security;
alter table private.calendar_view_preferences enable row level security;
revoke all on table private.calendar_events, private.calendar_event_shares, private.calendar_event_exceptions,
  private.home_calendar_access, private.calendar_view_preferences
  from public, anon, authenticated, service_role;

-- One occurrence as the readers below compute it.
create type private.calendar_occurrence as (
  event_id uuid,
  original_date date,
  all_day boolean,
  starts_on date,
  ends_on date,
  start_time time without time zone,
  end_time time without time zone,
  title text,
  location text,
  description text,
  participants uuid[],
  is_exception boolean
);

-- Access ------------------------------------------------------------------------------------------------

-- A person's Home calendar level: 'manage', 'edit_delete', 'edit', 'view', or null (not a member).
create function private.calendar_level(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when private.has_home_capability(p_home_id, p_user_id, 'manageHomeCalendar') then 'manage'
    else coalesce(a.level, 'edit')
  end
  from public.home_memberships m
  left join private.home_calendar_access a on a.home_id = m.home_id and a.user_id = m.user_id
  where m.home_id = p_home_id and m.user_id = p_user_id and p_user_id is not null and p_home_id is not null;
  $$;

create function private.calendar_level_allows(p_level text, p_action text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(case p_action
    when 'view' then p_level in ('view', 'edit', 'edit_delete', 'manage')
    when 'edit' then p_level in ('edit', 'edit_delete', 'manage')
    when 'delete' then p_level in ('edit_delete', 'manage')
    when 'manage' then p_level = 'manage'
  end, false);
  $$;

-- 42501 for a Home the caller is not in (the same answer as for one that does not exist).
create function private.require_calendar_home(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is null or private.calendar_level(p_home_id, p_user_id) is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- Whether p_user_id sees p_event in a context: the Personal space (p_home_id null: their own personal
-- events only) or one Home (its Home events and the personal events shared with it, for a current
-- member). Every term is false, never null, when it does not hold.
create function private.calendar_can_see(p_event private.calendar_events, p_user_id uuid, p_home_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_user_id is not null and p_event.id is not null and p_event.deleted_at is null and case
    when p_home_id is null then p_event.owner_user_id = p_user_id
    else exists (select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_user_id)
      and (p_event.home_id = p_home_id
        or (p_event.owner_user_id is not null and exists (
          select 1 from private.calendar_event_shares s
          where s.event_id = p_event.id and s.home_id = p_home_id and s.user_id = p_event.owner_user_id)))
  end, false);
  $$;

-- Change an event (every scope): a personal event's owner; for a Home event, level 'edit' or more.
create function private.calendar_can_edit(p_event private.calendar_events, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(case
    when p_event.owner_user_id is not null then p_event.owner_user_id = p_user_id
    else private.calendar_level_allows(private.calendar_level(p_event.home_id, p_user_id), 'edit')
  end, false);
  $$;

-- Delete an event or occurrences of it (every scope), restore it: a personal event's owner; for a Home
-- event, level 'edit_delete' or 'manage'.
create function private.calendar_can_delete(p_event private.calendar_events, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(case
    when p_event.owner_user_id is not null then p_event.owner_user_id = p_user_id
    else private.calendar_level_allows(private.calendar_level(p_event.home_id, p_user_id), 'delete')
  end, false);
  $$;

-- The event, locked, when the caller may change or delete it in some context: the owner of a personal
-- event, or a current member of a Home event's Home. Anyone else gets an empty row, exactly like a
-- missing id (a member of a Home a personal event is shared with may see it but never change it, so it
-- is not theirs to lock either).
create function private.lock_calendar_event(p_event_id uuid, p_user_id uuid) returns private.calendar_events
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_event private.calendar_events;
  begin
    select * into v_event from private.calendar_events e where e.id = p_event_id for update;
    if not found or v_event.deleted_at is not null
       or not (coalesce(v_event.owner_user_id = p_user_id, false)
         or (v_event.home_id is not null and private.calendar_level(v_event.home_id, p_user_id) is not null)) then
      return null;
    end if;
    return v_event;
  end
  $$;

-- Serializes the per-owner limit check, so two creates or restores cannot both take the last place.
create function private.lock_calendar_owner(p_owner_user_id uuid, p_home_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'calendar:' || coalesce(p_home_id::text, 'u:' || p_owner_user_id::text), 0));
  $$;

create function private.calendar_owner_full(p_owner_user_id uuid, p_home_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.calendar_events e
    where e.deleted_at is null
      and (case when p_home_id is null then e.owner_user_id = p_owner_user_id else e.home_id = p_home_id end))
    >= private.calendar_limit('events');
  $$;

-- Home audit: ids, scopes and levels only, never a title, a time or a place. Personal events are never
-- audited into a Home.
create function private.audit_calendar(p_action text, p_event private.calendar_events, p_details jsonb default '{}')
returns void
  language sql volatile security definer set search_path = '' as $$
  select private.audit(p_action, p_event.home_id, 'calendar_event', p_event.id, p_details)
  where p_event.home_id is not null;
  $$;

-- Occurrences ---------------------------------------------------------------------------------------------

-- The rule's start dates within [p_from, p_to] (a single event: its start date when inside).
create function private.calendar_rule_dates(p_event private.calendar_events, p_from date, p_to date)
returns setof date
  language plpgsql immutable set search_path = '' as $$
  declare
    v_date date;
    v_guard integer := 0;
  begin
    if p_event.frequency is null then
      if p_event.starts_on between p_from and p_to then
        return next p_event.starts_on;
      end if;
      return;
    end if;
    v_date := private.series_first_on_or_after(p_event.frequency, p_event.interval_count, p_event.weekdays,
      p_event.starts_on, p_from);
    while v_date is not null and v_date <= p_to and (p_event.until_date is null or v_date <= p_event.until_date)
      and v_guard < 2000 loop
      return next v_date;
      v_guard := v_guard + 1;
      v_date := private.series_first_on_or_after(p_event.frequency, p_event.interval_count, p_event.weekdays,
        p_event.starts_on, v_date + 1);
    end loop;
  end
  $$;

-- Whether p_date is a start date of the rule (within its start and end).
create function private.calendar_is_rule_date(p_event private.calendar_events, p_date date) returns boolean
  language sql immutable set search_path = '' as $$
  select p_date is not null and exists (select 1 from private.calendar_rule_dates(p_event, p_date, p_date));
  $$;

-- The occurrence that starts on the rule date p_date, with its exception applied; null when the date is
-- not on the rule or the occurrence is cancelled.
create function private.calendar_effective(p_event private.calendar_events, p_date date)
returns private.calendar_occurrence
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_exception private.calendar_event_exceptions;
    v_result private.calendar_occurrence;
  begin
    if not private.calendar_is_rule_date(p_event, p_date) then
      return null;
    end if;
    select * into v_exception from private.calendar_event_exceptions x
      where x.event_id = p_event.id and x.original_date = p_date;
    if found and v_exception.cancelled then
      return null;
    end if;
    v_result.event_id := p_event.id;
    v_result.original_date := p_date;
    v_result.all_day := p_event.all_day;
    v_result.starts_on := p_date;
    v_result.ends_on := p_date + (p_event.ends_on - p_event.starts_on);
    v_result.start_time := p_event.start_time;
    v_result.end_time := p_event.end_time;
    v_result.title := p_event.title;
    v_result.location := p_event.location;
    v_result.description := p_event.description;
    v_result.participants := p_event.participants;
    v_result.is_exception := v_exception.event_id is not null;
    if v_exception.event_id is not null then
      if 'title' = any (v_exception.fields) then v_result.title := v_exception.title; end if;
      if 'location' = any (v_exception.fields) then v_result.location := v_exception.location; end if;
      if 'description' = any (v_exception.fields) then v_result.description := v_exception.description; end if;
      if 'participants' = any (v_exception.fields) then v_result.participants := v_exception.participants; end if;
      if 'time' = any (v_exception.fields) then
        v_result.all_day := v_exception.all_day;
        v_result.starts_on := v_exception.starts_on;
        v_result.ends_on := v_exception.ends_on;
        v_result.start_time := v_exception.start_time;
        v_result.end_time := v_exception.end_time;
      end if;
    end if;
    return v_result;
  end
  $$;

-- The first and last instant of an occurrence (timed), or null (all-day).
create function private.calendar_start_at(p_occurrence private.calendar_occurrence, p_zone text) returns timestamptz
  language sql stable set search_path = '' as $$
  select case when not p_occurrence.all_day
    then (p_occurrence.starts_on + p_occurrence.start_time) at time zone p_zone end;
  $$;

create function private.calendar_end_at(p_occurrence private.calendar_occurrence, p_zone text) returns timestamptz
  language sql stable set search_path = '' as $$
  select case when not p_occurrence.all_day
    then (p_occurrence.ends_on + p_occurrence.end_time) at time zone p_zone end;
  $$;

-- The occurrences of one event that overlap the local dates [p_from, p_to] of timezone p_zone (timed
-- occurrences by their instants, all-day ones by their dates), in start order.
create function private.calendar_window(p_event private.calendar_events, p_from date, p_to date, p_zone text)
returns setof private.calendar_occurrence
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_date date;
    v_occurrence private.calendar_occurrence;
    v_window_start timestamptz := p_from::timestamp at time zone p_zone;
    v_window_end timestamptz := (p_to + 1)::timestamp at time zone p_zone;
  begin
    for v_date in
      select d from (
        -- Rule dates whose occurrence could reach the window (a day of margin for timezone offsets) ...
        select d from private.calendar_rule_dates(p_event,
          p_from - (p_event.ends_on - p_event.starts_on) - 1, p_to + 1) as d
        union
        -- ... and moved occurrences that now fall in or near it.
        select x.original_date from private.calendar_event_exceptions x
        where x.event_id = p_event.id and not x.cancelled and 'time' = any (x.fields)
          and x.starts_on <= p_to + 1 and x.ends_on >= p_from - 1
      ) dates order by d
    loop
      v_occurrence := private.calendar_effective(p_event, v_date);
      continue when v_occurrence.event_id is null;
      if v_occurrence.all_day then
        continue when v_occurrence.starts_on > p_to or v_occurrence.ends_on < p_from;
      else
        continue when private.calendar_start_at(v_occurrence, p_event.timezone) >= v_window_end
          or private.calendar_end_at(v_occurrence, p_event.timezone) <= v_window_start;
      end if;
      return next v_occurrence;
    end loop;
  end
  $$;

-- Output -------------------------------------------------------------------------------------------------

-- Participants as membership ids of the event's Home, in saved order; departed members are left out.
create function private.calendar_participants_json(p_home_id uuid, p_participants uuid[]) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(m.id order by p.ord), '[]'::jsonb)
  from pg_catalog.unnest(p_participants) with ordinality as p(user_id, ord)
  join public.home_memberships m on m.home_id = p_home_id and m.user_id = p.user_id
  where p_home_id is not null;
  $$;

-- What kind the event is to a viewer in a context: 'home', 'personal' (their own, in Personal or in a
-- Home it is shared with) or 'shared' (someone else's, shared with this Home).
create function private.calendar_kind(p_event private.calendar_events, p_viewer uuid) returns text
  language sql immutable set search_path = '' as $$
  select case when p_event.home_id is not null then 'home'
    when p_event.owner_user_id = p_viewer then 'personal' else 'shared' end;
  $$;

-- One occurrence for a list, shown in timezone p_zone. `from` and `to` are the local dates it covers there.
create function private.calendar_occurrence_json(
  p_event private.calendar_events, p_occurrence private.calendar_occurrence, p_viewer uuid, p_home_id uuid,
  p_zone text
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'eventId', p_event.id,
    'on', case when p_event.frequency is not null then p_occurrence.original_date end,
    'kind', private.calendar_kind(p_event, p_viewer),
    'sharedBy', case when private.calendar_kind(p_event, p_viewer) = 'shared'
      then private.member_ref(p_home_id, p_event.owner_user_id) end,
    'title', p_occurrence.title,
    'location', p_occurrence.location,
    'allDay', p_occurrence.all_day,
    'from', case when p_occurrence.all_day then p_occurrence.starts_on
      else (private.calendar_start_at(p_occurrence, p_event.timezone) at time zone p_zone)::date end,
    'to', case when p_occurrence.all_day then p_occurrence.ends_on
      else ((private.calendar_end_at(p_occurrence, p_event.timezone) - interval '1 microsecond')
        at time zone p_zone)::date end,
    'startsAt', private.calendar_start_at(p_occurrence, p_event.timezone),
    'endsAt', private.calendar_end_at(p_occurrence, p_event.timezone),
    'timezone', p_event.timezone,
    'recurring', p_event.frequency is not null,
    'changed', p_occurrence.is_exception,
    'participants', private.calendar_participants_json(p_event.home_id, p_occurrence.participants)
  );
  $$;

create function private.calendar_rule_json(p_event private.calendar_events) returns jsonb
  language sql immutable set search_path = '' as $$
  select case when p_event.frequency is null then null else pg_catalog.jsonb_build_object(
    'frequency', p_event.frequency, 'interval', p_event.interval_count,
    'weekdays', coalesce(pg_catalog.to_jsonb(p_event.weekdays), 'null'::jsonb),
    'endsOn', p_event.repeat_ends_on, 'count', p_event.max_count, 'until', p_event.until_date) end;
  $$;

-- The context's timezone for display: the Home's for a Home, the viewer's own (passed by the app, which
-- knows the effective personal timezone) for Personal, UTC when that is missing or unknown.
create function private.calendar_zone(p_home_id uuid, p_zone text) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_home_id is not null then coalesce((select h.timezone from public.homes h where h.id = p_home_id), 'UTC')
    when private.calendar_valid_zone(p_zone) then p_zone
    else 'UTC'
  end;
  $$;

-- The events a viewer sees in a context (not in the trash).
create function private.calendar_context_events(p_user_id uuid, p_home_id uuid)
returns setof private.calendar_events
  language sql stable security definer set search_path = '' as $$
  select e.* from private.calendar_events e
  where e.deleted_at is null and p_user_id is not null and case
    when p_home_id is null then e.owner_user_id = p_user_id
    else e.home_id = p_home_id or e.id in (
      select s.event_id from private.calendar_event_shares s where s.home_id = p_home_id)
  end
    and private.calendar_can_see(e, p_user_id, p_home_id);
  $$;

-- Reading ------------------------------------------------------------------------------------------------

-- Every occurrence the caller sees in a context (p_home_id null: Personal) that overlaps the local dates
-- [p_from, p_to] (at most 62 days), in start order, with the caller's Home calendar level and, for a
-- Home, its vacations when the caller shows them. p_zone is the caller's own timezone (Personal only).
-- 42501 for a Home the caller is not in; 22023 for a malformed window.
create function public.list_calendar(p_from date, p_to date, p_home_id uuid default null, p_zone text default null)
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
        select private.calendar_occurrence_json(e, o, v_user_id, p_home_id, v_zone) as item,
          coalesce(private.calendar_start_at(o, e.timezone), o.starts_on::timestamp at time zone v_zone) as sort_at,
          pg_catalog.lower(o.title) as sort_title, e.id as sort_id
        from private.calendar_context_events(v_user_id, p_home_id) e
        cross join lateral private.calendar_window(e, p_from, p_to, v_zone) o
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
            where p.vacation_id = v.id and p.status = 'accepted')), '[]'::jsonb) else '[]'::jsonb end
    );
  end
  $$;

-- The next occurrences for the Upcoming events widget: those not yet over, starting within p_days days
-- of today in the context's timezone, at most p_count of them, and whether there are more. 42501 for a
-- Home the caller is not in.
create function public.get_calendar_upcoming(
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
        select private.calendar_occurrence_json(e, o, v_user_id, p_home_id, v_zone) as item,
          pg_catalog.row_number() over (order by
            coalesce(private.calendar_start_at(o, e.timezone), o.starts_on::timestamp at time zone v_zone),
            pg_catalog.lower(o.title), e.id) as n
        from private.calendar_context_events(v_user_id, p_home_id) e
        cross join lateral private.calendar_window(e, v_today, v_today + p_days - 1, v_zone) o
        where case when o.all_day then o.ends_on >= v_today
          else private.calendar_end_at(o, e.timezone) > v_now end
          and (o.all_day or private.calendar_start_at(o, e.timezone) < (v_today + p_days)::timestamp at time zone v_zone)
      ) x where x.n <= p_count + 1;
    return pg_catalog.jsonb_build_object(
      'timezone', v_zone,
      'today', v_today,
      'canCreate', p_home_id is null or private.calendar_level_allows(v_level, 'edit'),
      'more', coalesce(pg_catalog.jsonb_array_length(v_items), 0) > p_count,
      'occurrences', coalesce((select pg_catalog.jsonb_agg(v order by n) from pg_catalog.jsonb_array_elements(
          coalesce(v_items, '[]'::jsonb)) with ordinality as a(v, n) where n <= p_count), '[]'::jsonb)
    );
  end
  $$;

-- One event as the caller sees it in a context (p_home_id null: Personal), with the series and, for
-- p_on (a start date of a recurring event's rule), that occurrence. Null when the caller may not see it
-- there, it is in the trash, or it does not exist: nothing tells these apart.
create function public.get_calendar_event(
  p_event_id uuid, p_home_id uuid default null, p_on date default null, p_zone text default null
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.calendar_events;
    v_occurrence private.calendar_occurrence;
    v_zone text;
    v_series private.calendar_occurrence;
  begin
    if p_event_id is null then
      return null;
    end if;
    select * into v_event from private.calendar_events e where e.id = p_event_id;
    if not found or not private.calendar_can_see(v_event, v_user_id, p_home_id) then
      return null;
    end if;
    v_zone := private.calendar_zone(p_home_id, p_zone);
    if v_event.frequency is not null and p_on is not null then
      v_occurrence := private.calendar_effective(v_event, p_on);
    end if;
    v_series.event_id := v_event.id;
    v_series.original_date := v_event.starts_on;
    v_series.all_day := v_event.all_day;
    v_series.starts_on := v_event.starts_on;
    v_series.ends_on := v_event.ends_on;
    v_series.start_time := v_event.start_time;
    v_series.end_time := v_event.end_time;
    v_series.title := v_event.title;
    v_series.location := v_event.location;
    v_series.description := v_event.description;
    v_series.participants := v_event.participants;
    v_series.is_exception := false;
    return pg_catalog.jsonb_build_object(
      'id', v_event.id,
      'homeId', v_event.home_id,
      'kind', private.calendar_kind(v_event, v_user_id),
      'sharedBy', case when private.calendar_kind(v_event, v_user_id) = 'shared'
        then private.member_ref(p_home_id, v_event.owner_user_id) end,
      'revision', v_event.revision,
      -- The owner's or the Home's own setting; never shown with someone's shared event.
      'reminder', case when private.calendar_kind(v_event, v_user_id) <> 'shared' then v_event.reminder_minutes end,
      'displayTimezone', v_zone,
      'series', private.calendar_occurrence_json(v_event, v_series, v_user_id, p_home_id, v_zone)
        || pg_catalog.jsonb_build_object(
          'description', v_event.description,
          'startsOn', v_event.starts_on, 'endsOn', v_event.ends_on,
          'startTime', pg_catalog.to_char(v_event.start_time, 'HH24:MI'),
          'endTime', pg_catalog.to_char(v_event.end_time, 'HH24:MI')),
      'repeat', private.calendar_rule_json(v_event),
      'occurrence', case when v_occurrence.event_id is null then null
        else private.calendar_occurrence_json(v_event, v_occurrence, v_user_id, p_home_id, v_zone)
          || pg_catalog.jsonb_build_object(
            'description', v_occurrence.description,
            'startsOn', v_occurrence.starts_on, 'endsOn', v_occurrence.ends_on,
            'startTime', pg_catalog.to_char(v_occurrence.start_time, 'HH24:MI'),
            'endTime', pg_catalog.to_char(v_occurrence.end_time, 'HH24:MI'),
            'first', v_occurrence.original_date = v_event.starts_on) end,
      -- Only the owner learns which Homes their event is shared with.
      'shares', case when v_event.owner_user_id = v_user_id then coalesce((
        select pg_catalog.jsonb_agg(s.home_id order by s.shared_at, s.home_id)
        from private.calendar_event_shares s where s.event_id = v_event.id), '[]'::jsonb) end,
      'canEdit', private.calendar_can_edit(v_event, v_user_id),
      'canDelete', private.calendar_can_delete(v_event, v_user_id),
      'exceptions', (select count(*) from private.calendar_event_exceptions x where x.event_id = v_event.id)
    );
  end
  $$;

-- Reading request values ---------------------------------------------------------------------------------
-- A missing key or JSON null is "not entered"; anything else must be valid, or the whole request is
-- refused with 22023 and nothing is saved. Plain-text and date readers are the pets module's generic ones.

create function private.calendar_json_time(p_body jsonb, p_key text) returns time without time zone
  language plpgsql immutable set search_path = '' as $$
  declare
    v_value text;
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    v_value := case when pg_catalog.jsonb_typeof(p_body -> p_key) = 'string' then p_body ->> p_key end;
    if v_value is null or v_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return v_value::time;
  end
  $$;

-- A list of uuids, at most p_max, each once.
create function private.calendar_json_ids(p_body jsonb, p_key text, p_max integer) returns uuid[]
  language plpgsql immutable set search_path = '' as $$
  declare
    v_ids uuid[];
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return '{}';
    end if;
    if pg_catalog.jsonb_typeof(p_body -> p_key) <> 'array'
       or pg_catalog.jsonb_array_length(p_body -> p_key) > p_max
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_body -> p_key) e
         where pg_catalog.jsonb_typeof(e) <> 'string'
           or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    select coalesce(pg_catalog.array_agg(e::uuid order by n), '{}') into v_ids
      from pg_catalog.jsonb_array_elements_text(p_body -> p_key) with ordinality as a(e, n);
    if pg_catalog.cardinality(v_ids) <> (select count(distinct x) from pg_catalog.unnest(v_ids) x) then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return v_ids;
  end
  $$;

-- The event's values from a request body (title, location, description, allDay, startsOn, endsOn,
-- startTime, endTime, timezone, repeat). Malformed: 22023. Participants and shares are read separately.
-- p_with_repeat false ignores `repeat` (one occurrence's change).
create function private.calendar_values(p_body jsonb, p_with_repeat boolean) returns private.calendar_events
  language plpgsql stable set search_path = '' as $$
  declare
    v private.calendar_events;
    v_repeat jsonb;
    v_weekdays smallint[];
    v_reminder numeric;
  begin
    if p_body is null or pg_catalog.jsonb_typeof(p_body) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v.title := private.pet_json_text(p_body, 'title', 200, true);
    if v.title is null then
      raise exception 'invalid title' using errcode = '22023';
    end if;
    v.location := private.pet_json_text(p_body, 'location', 200, true);
    v.description := private.pet_json_text(p_body, 'description', 4000, false);
    v.all_day := private.pet_json_bool(p_body, 'allDay');
    v.starts_on := private.pet_json_date(p_body, 'startsOn');
    v.ends_on := private.pet_json_date(p_body, 'endsOn');
    v.start_time := private.calendar_json_time(p_body, 'startTime');
    v.end_time := private.calendar_json_time(p_body, 'endTime');
    v.timezone := case when pg_catalog.jsonb_typeof(p_body -> 'timezone') = 'string' then p_body ->> 'timezone' end;
    if v.all_day is null or v.starts_on is null or v.ends_on is null
       or not private.calendar_valid_zone(v.timezone)
       or (v.all_day and (v.start_time is not null or v.end_time is not null))
       or (not v.all_day and (v.start_time is null or v.end_time is null)) then
      raise exception 'invalid time' using errcode = '22023';
    end if;
    if p_with_repeat and pg_catalog.jsonb_typeof(p_body -> 'repeat') = 'object' then
      v_repeat := p_body -> 'repeat';
      v.frequency := private.pet_json_choice(v_repeat, 'frequency', array['daily', 'weekly', 'monthly', 'yearly']);
      if pg_catalog.jsonb_typeof(v_repeat -> 'interval') <> 'number' or (v_repeat ->> 'interval') !~ '^[0-9]{1,2}$' then
        raise exception 'invalid interval' using errcode = '22023';
      end if;
      v.interval_count := (v_repeat ->> 'interval')::integer;
      if pg_catalog.jsonb_typeof(v_repeat -> 'weekdays') = 'array' then
        if exists (select 1 from pg_catalog.jsonb_array_elements(v_repeat -> 'weekdays') d
            where pg_catalog.jsonb_typeof(d) <> 'number' or (d #>> '{}') !~ '^[1-7]$') then
          raise exception 'invalid weekdays' using errcode = '22023';
        end if;
        select pg_catalog.array_agg(d::smallint order by d::smallint) into v_weekdays
          from pg_catalog.jsonb_array_elements_text(v_repeat -> 'weekdays') d;
        v.weekdays := v_weekdays;
      elsif v_repeat ? 'weekdays' and pg_catalog.jsonb_typeof(v_repeat -> 'weekdays') <> 'null' then
        raise exception 'invalid weekdays' using errcode = '22023';
      end if;
      v.repeat_ends_on := private.pet_json_date(v_repeat, 'endsOn');
      if v_repeat ? 'count' and pg_catalog.jsonb_typeof(v_repeat -> 'count') <> 'null' then
        if pg_catalog.jsonb_typeof(v_repeat -> 'count') <> 'number'
           or (v_repeat ->> 'count') !~ '^[0-9]{1,4}$' then
          raise exception 'invalid count' using errcode = '22023';
        end if;
        v.max_count := (v_repeat ->> 'count')::integer;
      end if;
      if not private.valid_series_rule(v.frequency, v.interval_count, v.weekdays, v.starts_on, v.repeat_ends_on,
          v.max_count) then
        raise exception 'invalid repeat' using errcode = '22023';
      end if;
      v.until_date := private.series_until(v.frequency, v.interval_count, v.weekdays, v.starts_on,
        v.repeat_ends_on, v.max_count);
    elsif p_with_repeat and p_body ? 'repeat' and pg_catalog.jsonb_typeof(p_body -> 'repeat') <> 'null' then
      raise exception 'invalid repeat' using errcode = '22023';
    end if;
    -- The reminder belongs to the whole event (one occurrence's change keeps it).
    if p_with_repeat then
      v_reminder := private.pet_json_number(p_body, 'reminder');
      if v_reminder is not null and v_reminder not in (0, 15, 60, 1440) then
        raise exception 'invalid reminder' using errcode = '22023';
      end if;
      v.reminder_minutes := v_reminder::integer;
    end if;
    return v;
  end
  $$;

-- Why an event's time cannot be saved, or null: 'invalid_dates' (end not after start, too long, out of
-- range, a weekly rule whose start is not one of its weekdays) or 'nonexistent_time' (a local start or
-- end that the clock skips in that timezone, at a daylight-saving change).
create function private.calendar_time_problem(
  p_all_day boolean, p_starts_on date, p_ends_on date, p_start_time time, p_end_time time, p_zone text
) returns text
  language plpgsql stable set search_path = '' as $$
  declare
    v_start timestamp := p_starts_on + coalesce(p_start_time, time '00:00');
    v_end timestamp := p_ends_on + coalesce(p_end_time, time '00:00');
  begin
    if p_ends_on < p_starts_on or p_starts_on < date '2000-01-01' or p_ends_on > date '2199-12-31' then
      return 'invalid_dates';
    end if;
    if p_all_day then
      return case when p_ends_on - p_starts_on >= private.calendar_limit('all_day_days') then 'invalid_dates' end;
    end if;
    if v_end <= v_start or v_end - v_start > pg_catalog.make_interval(days => private.calendar_limit('timed_days')) then
      return 'invalid_dates';
    end if;
    if ((v_start at time zone p_zone) at time zone p_zone) <> v_start
       or ((v_end at time zone p_zone) at time zone p_zone) <> v_end then
      return 'nonexistent_time';
    end if;
    return null;
  end
  $$;

-- Membership ids of p_home_id to user ids, in order; null when one is not a current member there.
create function private.calendar_participant_users(p_home_id uuid, p_memberships uuid[]) returns uuid[]
  language sql stable security definer set search_path = '' as $$
  select case when (select count(*) from pg_catalog.unnest(p_memberships) x) = count(m.user_id)
    then coalesce(pg_catalog.array_agg(m.user_id order by p.ord) filter (where m.user_id is not null), '{}') end
  from pg_catalog.unnest(p_memberships) with ordinality as p(id, ord)
  left join public.home_memberships m on m.id = p.id and m.home_id = p_home_id;
  $$;

-- Whether every Home in p_home_ids is one p_user_id currently belongs to.
create function private.calendar_own_homes(p_user_id uuid, p_home_ids uuid[]) returns boolean
  language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from pg_catalog.unnest(p_home_ids) h
    where not exists (select 1 from public.home_memberships m where m.home_id = h and m.user_id = p_user_id));
  $$;

-- Replaces a personal event's shares (the owner's current Homes only).
create function private.calendar_set_shares(p_event private.calendar_events, p_home_ids uuid[]) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    delete from private.calendar_event_shares s where s.event_id = p_event.id and not (s.home_id = any (p_home_ids));
    insert into private.calendar_event_shares (event_id, home_id, user_id)
      select p_event.id, h, p_event.owner_user_id from pg_catalog.unnest(p_home_ids) h
      on conflict (event_id, home_id) do nothing;
  end
  $$;

-- Creating ------------------------------------------------------------------------------------------------

-- The stored id of an event the client asked for with p_client_id: a version-4-shaped uuid derived from
-- the caller and that id. A retry finds the same event, and an id someone else used never collides with
-- theirs, so creating can never tell whether another person's event exists (S32 review H2).
create function private.calendar_event_id(p_user_id uuid, p_client_id uuid) returns uuid
  language sql immutable set search_path = '' as $$
  select (pg_catalog.substr(h, 1, 8) || '-' || pg_catalog.substr(h, 9, 4) || '-4' || pg_catalog.substr(h, 14, 3)
    || '-' || pg_catalog.substr('89ab', 1 + (pg_catalog.get_byte(pg_catalog.decode(pg_catalog.substr(h, 17, 2), 'hex'), 0) % 4), 1)
    || pg_catalog.substr(h, 18, 3) || '-' || pg_catalog.substr(h, 21, 12))::uuid
  from (select pg_catalog.md5('calendar-event:' || p_user_id::text || ':' || p_client_id::text) as h) x;
  $$;

-- Creates an event: personal (p_home_id null; `shares` lists Homes of the caller to share it with) or in
-- a Home (level 'edit' or more; `participants` lists membership ids there). The client picks a request id
-- and the event's id is derived from it and the caller (private.calendar_event_id; the answer carries
-- it), so a retry answers 'exists' instead of making a second event. Outcomes: 'created', 'exists',
-- 'not_permitted', 'limit_reached', 'invalid_member', 'invalid_home', 'invalid_dates',
-- 'nonexistent_time'. 42501 for a Home the caller is not in.
create function public.create_calendar_event(p_id uuid, p_event jsonb, p_home_id uuid default null) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v private.calendar_events;
    v_existing private.calendar_events;
    v_problem text;
    v_participants uuid[];
    v_shares uuid[];
  begin
    if p_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_home_id is not null then
      perform private.require_calendar_home(p_home_id, v_user_id);
    end if;
    v := private.calendar_values(p_event, true);
    v_participants := private.calendar_json_ids(p_event, 'participants', private.calendar_limit('participants'));
    v_shares := private.calendar_json_ids(p_event, 'shares', private.calendar_limit('shares'));
    -- Derived from the caller, so an event found here is their own earlier request.
    select * into v_existing from private.calendar_events e where e.id = private.calendar_event_id(v_user_id, p_id);
    if found then
      return pg_catalog.jsonb_build_object('outcome', 'exists', 'id', v_existing.id, 'revision', v_existing.revision);
    end if;
    if p_home_id is not null and not private.calendar_level_allows(private.calendar_level(p_home_id, v_user_id), 'edit') then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_problem := private.calendar_time_problem(v.all_day, v.starts_on, v.ends_on, v.start_time, v.end_time, v.timezone);
    if v_problem is null and v.frequency = 'weekly'
       and not (pg_catalog.date_part('isodow', v.starts_on)::smallint = any (v.weekdays)) then
      v_problem := 'invalid_dates';
    end if;
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    if p_home_id is null then
      if pg_catalog.cardinality(v_participants) > 0 then
        raise exception 'invalid participants' using errcode = '22023';
      end if;
      if not private.calendar_own_homes(v_user_id, v_shares) then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_home');
      end if;
    else
      if pg_catalog.cardinality(v_shares) > 0 then
        raise exception 'invalid shares' using errcode = '22023';
      end if;
      v.participants := private.calendar_participant_users(p_home_id, v_participants);
      if v.participants is null then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_member');
      end if;
    end if;
    perform private.lock_calendar_owner(v_user_id, p_home_id);
    if private.calendar_owner_full(v_user_id, p_home_id) then
      return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
    end if;
    v.id := private.calendar_event_id(v_user_id, p_id);
    v.owner_user_id := case when p_home_id is null then v_user_id end;
    v.home_id := p_home_id;
    v.participants := coalesce(v.participants, '{}');
    v.revision := 1;
    v.created_by := v_user_id;
    v.created_at := pg_catalog.now();
    v.updated_by := v_user_id;
    v.updated_at := pg_catalog.now();
    v.deleted_at := null;
    insert into private.calendar_events select v.*;
    if p_home_id is null then
      perform private.calendar_set_shares(v, v_shares);
    end if;
    perform private.audit_calendar('calendar.event.created', v);
    return pg_catalog.jsonb_build_object('outcome', 'created', 'id', v.id, 'revision', 1);
  end
  $$;

-- Changing ------------------------------------------------------------------------------------------------

-- Up to p_limit occurrence start dates of a rule from p_from on, and whether there are more.
create function private.calendar_preview_dates(p_event private.calendar_events, p_from date, p_limit integer)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_dates date[] := '{}';
    v_date date;
    v_guard integer := 0;
  begin
    if p_event.frequency is null then
      return pg_catalog.jsonb_build_object('dates', pg_catalog.jsonb_build_array(p_event.starts_on), 'more', false);
    end if;
    v_date := private.series_first_on_or_after(p_event.frequency, p_event.interval_count, p_event.weekdays,
      p_event.starts_on, greatest(p_from, p_event.starts_on));
    while v_date is not null and (p_event.until_date is null or v_date <= p_event.until_date)
      and pg_catalog.cardinality(v_dates) <= p_limit and v_guard < 5000 loop
      v_guard := v_guard + 1;
      if not exists (select 1 from private.calendar_event_exceptions x
          where x.event_id = p_event.id and x.original_date = v_date and x.cancelled) then
        v_dates := v_dates || v_date;
      end if;
      v_date := private.series_first_on_or_after(p_event.frequency, p_event.interval_count, p_event.weekdays,
        p_event.starts_on, v_date + 1);
    end loop;
    return pg_catalog.jsonb_build_object(
      'dates', coalesce((select pg_catalog.jsonb_agg(d order by d) from pg_catalog.unnest(v_dates[1:p_limit]) d), '[]'::jsonb),
      'more', pg_catalog.cardinality(v_dates) > p_limit,
      'endless', p_event.until_date is null);
  end
  $$;

-- Removes exceptions whose original date is no longer a start date of the event's rule; answers how many.
create function private.calendar_drop_orphan_exceptions(p_event private.calendar_events) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    delete from private.calendar_event_exceptions x
      where x.event_id = p_event.id and not private.calendar_is_rule_date(p_event, x.original_date);
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;

-- How many exceptions of p_event would not survive under the rule of p_rule.
create function private.calendar_orphan_count(p_event_id uuid, p_rule private.calendar_events, p_from date)
returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.calendar_event_exceptions x
  where x.event_id = p_event_id and x.original_date >= p_from
    and not private.calendar_is_rule_date(p_rule, x.original_date);
  $$;

-- The last start date of p_event's rule before p_date, or null. A rule's consecutive dates are never
-- further apart than one full period (interval days, weeks, months of 31 days or years of 366 days), so
-- looking back that far finds it.
create function private.calendar_last_before(p_event private.calendar_events, p_date date) returns date
  language sql stable security definer set search_path = '' as $$
  select max(d) from private.calendar_rule_dates(p_event,
    greatest(p_event.starts_on, p_date - coalesce(p_event.interval_count, 1) * case p_event.frequency
      when 'daily' then 1 when 'weekly' then 7 when 'monthly' then 31 else 366 end - 1),
    p_date - 1) d;
  $$;

-- Changes an event. A single event changes as a whole (p_scope null or 'all'). A recurring event takes a
-- scope and, for 'only' and 'following', p_on (a start date of an occurrence that is not cancelled):
-- - 'only': that occurrence only (the series is untouched; `repeat` is ignored);
-- - 'following': the series ends before p_on and a new event, p_new_id, starts with the changes (its
--   start on or after p_on's previous occurrence + 1); exceptions from p_on on go with it when its rule
--   still has their date. From the first occurrence it is the same as 'all';
-- - 'all': the series changes; exceptions keep their own changes, and those whose date is no longer on
--   the rule are removed.
-- Shares (personal; a body without `shares` keeps the current ones) and participants (Home) come from
-- the body and apply to the series (or the new one); the new one's id derives from p_new_id and the
-- caller, like a created event's; for 'only', participants apply to that occurrence. With p_dry_run nothing changes and the answer
-- is a preview of the occurrences affected. Outcomes: 'saved', 'preview', 'not_found', 'not_permitted',
-- 'stale', 'invalid_scope', 'invalid_member', 'invalid_home', 'invalid_dates', 'nonexistent_time',
-- 'limit_reached'.
create function public.update_calendar_event(
  p_event_id uuid, p_expected_revision integer, p_event jsonb, p_scope text default null, p_on date default null,
  p_dry_run boolean default false, p_new_id uuid default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.calendar_events;
    v private.calendar_events;
    v_scope text := p_scope;
    v_problem text;
    v_participants uuid[];
    v_shares uuid[];
    v_occurrence private.calendar_occurrence;
    v_fields text[] := '{}';
    v_last date;
    v_new private.calendar_events;
    v_removed integer;
    v_moved integer;
  begin
    if p_event_id is null or p_expected_revision is null
       or (p_scope is not null and p_scope not in ('only', 'following', 'all')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_event := private.lock_calendar_event(p_event_id, v_user_id);
    if v_event.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.calendar_can_edit(v_event, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_event.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_event.revision);
    end if;
    if v_event.frequency is null then
      if coalesce(v_scope, 'all') <> 'all' then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_scope');
      end if;
      v_scope := 'all';
    elsif v_scope is null then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_scope');
    elsif v_scope in ('only', 'following') then
      v_occurrence := private.calendar_effective(v_event, p_on);
      if v_occurrence.event_id is null then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_scope');
      end if;
      if v_scope = 'following' and p_on = v_event.starts_on then
        v_scope := 'all';
      end if;
    end if;

    v := private.calendar_values(p_event, v_scope <> 'only');
    v_participants := private.calendar_json_ids(p_event, 'participants', private.calendar_limit('participants'));
    v_shares := private.calendar_json_ids(p_event, 'shares', private.calendar_limit('shares'));
    -- A body without `shares` keeps the event's current ones (an edit from a Home's calendar never
    -- unshares it; S32 review H1).
    if v_event.home_id is null and not (p_event ? 'shares') then
      select coalesce(pg_catalog.array_agg(sh.home_id order by sh.home_id), '{}') into v_shares
        from private.calendar_event_shares sh where sh.event_id = v_event.id;
    end if;
    v_problem := private.calendar_time_problem(v.all_day, v.starts_on, v.ends_on, v.start_time, v.end_time, v.timezone);
    if v_problem is null and v.frequency = 'weekly'
       and not (pg_catalog.date_part('isodow', v.starts_on)::smallint = any (v.weekdays)) then
      v_problem := 'invalid_dates';
    end if;
    if v_problem is not null then
      return pg_catalog.jsonb_build_object('outcome', v_problem);
    end if;
    if v_event.home_id is null then
      if pg_catalog.cardinality(v_participants) > 0 then
        raise exception 'invalid participants' using errcode = '22023';
      end if;
      if v_scope <> 'only' and not private.calendar_own_homes(v_user_id, v_shares) then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_home');
      end if;
      v.participants := '{}';
    else
      if pg_catalog.cardinality(v_shares) > 0 then
        raise exception 'invalid shares' using errcode = '22023';
      end if;
      v.participants := private.calendar_participant_users(v_event.home_id, v_participants);
      if v.participants is null then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_member');
      end if;
    end if;

    if v_scope = 'only' then
      -- An occurrence keeps the series' timezone; its date and time may move.
      if v.timezone <> v_event.timezone then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
      end if;
      if v.title <> v_event.title then v_fields := v_fields || 'title'::text; end if;
      if v.location is distinct from v_event.location then v_fields := v_fields || 'location'::text; end if;
      if v.description is distinct from v_event.description then v_fields := v_fields || 'description'::text; end if;
      if v.participants <> v_event.participants then v_fields := v_fields || 'participants'::text; end if;
      if v.all_day <> v_event.all_day or v.starts_on <> p_on
         or v.ends_on - v.starts_on <> v_event.ends_on - v_event.starts_on
         or v.start_time is distinct from v_event.start_time or v.end_time is distinct from v_event.end_time then
        v_fields := v_fields || 'time'::text;
      end if;
      if p_dry_run then
        return pg_catalog.jsonb_build_object('outcome', 'preview', 'scope', 'only',
          'dates', pg_catalog.jsonb_build_array(p_on), 'more', false, 'endless', false, 'removedChanges', 0);
      end if;
      if pg_catalog.cardinality(v_fields) > 0 and not exists (select 1 from private.calendar_event_exceptions x
          where x.event_id = v_event.id and x.original_date = p_on)
         and (select count(*) from private.calendar_event_exceptions x where x.event_id = v_event.id)
           >= private.calendar_limit('exceptions') then
        return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
      end if;
      if pg_catalog.cardinality(v_fields) = 0 then
        delete from private.calendar_event_exceptions x where x.event_id = v_event.id and x.original_date = p_on;
      else
        insert into private.calendar_event_exceptions as x (event_id, original_date, cancelled, fields, title,
            location, description, all_day, starts_on, ends_on, start_time, end_time, participants, updated_by)
          values (v_event.id, p_on, false, v_fields,
            case when 'title' = any (v_fields) then v.title end,
            case when 'location' = any (v_fields) then v.location end,
            case when 'description' = any (v_fields) then v.description end,
            case when 'time' = any (v_fields) then v.all_day end,
            case when 'time' = any (v_fields) then v.starts_on end,
            case when 'time' = any (v_fields) then v.ends_on end,
            case when 'time' = any (v_fields) then v.start_time end,
            case when 'time' = any (v_fields) then v.end_time end,
            case when 'participants' = any (v_fields) then v.participants end,
            v_user_id)
          on conflict (event_id, original_date) do update set cancelled = false, fields = excluded.fields,
            title = excluded.title, location = excluded.location, description = excluded.description,
            all_day = excluded.all_day, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
            start_time = excluded.start_time, end_time = excluded.end_time, participants = excluded.participants,
            updated_by = excluded.updated_by, updated_at = pg_catalog.now();
      end if;
      update private.calendar_events e set revision = e.revision + 1, updated_by = v_user_id,
          updated_at = pg_catalog.now()
        where e.id = v_event.id returning * into v_event;
      perform private.audit_calendar('calendar.event.updated', v_event, pg_catalog.jsonb_build_object('scope', 'only'));
      return pg_catalog.jsonb_build_object('outcome', 'saved', 'id', v_event.id, 'revision', v_event.revision);
    end if;

    if v_scope = 'following' then
      if p_new_id is null then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      v_last := private.calendar_last_before(v_event, p_on);
      if v.starts_on <= coalesce(v_last, v_event.starts_on) then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
      end if;
      v_new := v;
      v_new.id := private.calendar_event_id(v_user_id, p_new_id);
      v_new.owner_user_id := v_event.owner_user_id;
      v_new.home_id := v_event.home_id;
      if p_dry_run then
        return private.calendar_preview_dates(v_event, p_on, 10)
          || pg_catalog.jsonb_build_object('outcome', 'preview', 'scope', 'following',
            'removedChanges', private.calendar_orphan_count(v_event.id, v_new, p_on));
      end if;
      if exists (select 1 from private.calendar_events e where e.id = v_new.id) then
        return pg_catalog.jsonb_build_object('outcome', 'id_taken');
      end if;
      perform private.lock_calendar_owner(v_event.owner_user_id, v_event.home_id);
      if private.calendar_owner_full(v_event.owner_user_id, v_event.home_id) then
        return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
      end if;
      -- The old series ends with its last occurrence before p_on.
      update private.calendar_events e set repeat_ends_on = v_last, max_count = null, until_date = v_last,
          revision = e.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where e.id = v_event.id;
      v_new.revision := 1;
      v_new.created_by := v_user_id;
      v_new.created_at := pg_catalog.now();
      v_new.updated_by := v_user_id;
      v_new.updated_at := pg_catalog.now();
      v_new.deleted_at := null;
      insert into private.calendar_events select v_new.*;
      -- The occurrence being edited takes the new values as they are; later changes go with the new series.
      delete from private.calendar_event_exceptions x where x.event_id = v_event.id and x.original_date = p_on;
      update private.calendar_event_exceptions x set event_id = v_new.id
        where x.event_id = v_event.id and x.original_date > p_on;
      get diagnostics v_moved = row_count;
      v_removed := private.calendar_drop_orphan_exceptions(v_new);
      if v_event.home_id is null then
        perform private.calendar_set_shares(v_new, v_shares);
      end if;
      select * into v_event from private.calendar_events e where e.id = v_event.id;
      perform private.audit_calendar('calendar.event.updated', v_event,
        pg_catalog.jsonb_build_object('scope', 'following', 'newEventId', v_new.id));
      perform private.audit_calendar('calendar.event.created', v_new,
        pg_catalog.jsonb_build_object('from', v_event.id));
      return pg_catalog.jsonb_build_object('outcome', 'saved', 'id', v_new.id, 'revision', 1,
        'previousRevision', v_event.revision, 'removedChanges', v_removed);
    end if;

    -- 'all'
    v.id := v_event.id;
    v.owner_user_id := v_event.owner_user_id;
    v.home_id := v_event.home_id;
    if p_dry_run then
      return private.calendar_preview_dates(v, v.starts_on, 10)
        || pg_catalog.jsonb_build_object('outcome', 'preview', 'scope', 'all',
          'removedChanges', private.calendar_orphan_count(v_event.id, v, v_event.starts_on));
    end if;
    update private.calendar_events e set title = v.title, location = v.location, description = v.description,
        all_day = v.all_day, starts_on = v.starts_on, ends_on = v.ends_on, start_time = v.start_time,
        end_time = v.end_time, timezone = v.timezone, frequency = v.frequency, interval_count = v.interval_count,
        weekdays = v.weekdays, repeat_ends_on = v.repeat_ends_on, max_count = v.max_count, until_date = v.until_date,
        participants = v.participants, reminder_minutes = v.reminder_minutes, revision = e.revision + 1,
        updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where e.id = v_event.id returning * into v_event;
    v_removed := private.calendar_drop_orphan_exceptions(v_event);
    if v_event.home_id is null then
      perform private.calendar_set_shares(v_event, v_shares);
    end if;
    perform private.audit_calendar('calendar.event.updated', v_event, pg_catalog.jsonb_build_object('scope', 'all'));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'id', v_event.id, 'revision', v_event.revision,
      'removedChanges', v_removed);
  end
  $$;

-- Replaces the Homes a personal event is shared with (its owner only; their current Homes). Outcomes:
-- 'saved', 'not_found', 'stale', 'invalid_home'.
create function public.set_calendar_event_shares(p_event_id uuid, p_expected_revision integer, p_home_ids uuid[])
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.calendar_events;
  begin
    if p_event_id is null or p_expected_revision is null or p_home_ids is null
       or pg_catalog.cardinality(p_home_ids) > private.calendar_limit('shares')
       or pg_catalog.array_position(p_home_ids, null) is not null
       or pg_catalog.cardinality(p_home_ids) <> (select count(distinct h) from pg_catalog.unnest(p_home_ids) h) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_event := private.lock_calendar_event(p_event_id, v_user_id);
    -- A Home event, or someone else's: the same answer as a missing one.
    if v_event.id is null or v_event.owner_user_id is distinct from v_user_id then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if v_event.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_event.revision);
    end if;
    if not private.calendar_own_homes(v_user_id, p_home_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_home');
    end if;
    perform private.calendar_set_shares(v_event, p_home_ids);
    update private.calendar_events e set revision = e.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where e.id = v_event.id returning * into v_event;
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'id', v_event.id, 'revision', v_event.revision);
  end
  $$;

-- Deleting ------------------------------------------------------------------------------------------------

-- Deletes an event or occurrences of it. A single event, a recurring one with 'all', or 'following' from
-- the first occurrence go to the trash (7 days; restorable). 'only' cancels that occurrence; 'following'
-- ends the series before p_on and drops the exceptions from there. With p_dry_run nothing changes and the
-- answer previews what goes. Outcomes: 'deleted' (with the trash entry id when it went to the trash),
-- 'preview', 'not_found', 'not_permitted', 'stale', 'invalid_scope'.
create function public.delete_calendar_event(
  p_event_id uuid, p_expected_revision integer, p_scope text default null, p_on date default null,
  p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_event private.calendar_events;
    v_scope text := p_scope;
    v_occurrence private.calendar_occurrence;
    v_last date;
    v_entry uuid;
  begin
    if p_event_id is null or p_expected_revision is null
       or (p_scope is not null and p_scope not in ('only', 'following', 'all')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_event := private.lock_calendar_event(p_event_id, v_user_id);
    if v_event.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.calendar_can_delete(v_event, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_event.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_event.revision);
    end if;
    if v_event.frequency is null then
      if coalesce(v_scope, 'all') <> 'all' then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_scope');
      end if;
      v_scope := 'all';
    elsif v_scope is null then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_scope');
    elsif v_scope in ('only', 'following') then
      v_occurrence := private.calendar_effective(v_event, p_on);
      if v_occurrence.event_id is null then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_scope');
      end if;
      if v_scope = 'following' and p_on = v_event.starts_on then
        v_scope := 'all';
      end if;
    end if;

    if p_dry_run then
      return case v_scope
        when 'only' then pg_catalog.jsonb_build_object('dates', pg_catalog.jsonb_build_array(p_on), 'more', false,
          'endless', false)
        when 'following' then private.calendar_preview_dates(v_event, p_on, 10)
        else private.calendar_preview_dates(v_event, v_event.starts_on, 10)
      end || pg_catalog.jsonb_build_object('outcome', 'preview', 'scope', v_scope, 'trash', v_scope = 'all');
    end if;

    if v_scope = 'only' then
      insert into private.calendar_event_exceptions as x (event_id, original_date, cancelled, fields, updated_by)
        values (v_event.id, p_on, true, '{}', v_user_id)
        on conflict (event_id, original_date) do update set cancelled = true, fields = '{}', title = null,
          location = null, description = null, all_day = null, starts_on = null, ends_on = null,
          start_time = null, end_time = null, participants = null, updated_by = excluded.updated_by,
          updated_at = pg_catalog.now();
      update private.calendar_events e set revision = e.revision + 1, updated_by = v_user_id,
          updated_at = pg_catalog.now()
        where e.id = v_event.id returning * into v_event;
      perform private.audit_calendar('calendar.event.deleted', v_event, pg_catalog.jsonb_build_object('scope', 'only'));
      return pg_catalog.jsonb_build_object('outcome', 'deleted', 'revision', v_event.revision);
    end if;

    if v_scope = 'following' then
      v_last := private.calendar_last_before(v_event, p_on);
      update private.calendar_events e set repeat_ends_on = v_last, max_count = null, until_date = v_last,
          revision = e.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where e.id = v_event.id returning * into v_event;
      delete from private.calendar_event_exceptions x where x.event_id = v_event.id and x.original_date >= p_on;
      perform private.audit_calendar('calendar.event.deleted', v_event,
        pg_catalog.jsonb_build_object('scope', 'following'));
      return pg_catalog.jsonb_build_object('outcome', 'deleted', 'revision', v_event.revision);
    end if;

    update private.calendar_events e set deleted_at = pg_catalog.now(), revision = e.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where e.id = v_event.id returning * into v_event;
    v_entry := private.trash_move(v_user_id, 'calendar', 'calendar_event', v_event.id, v_event.owner_user_id,
      v_event.home_id, v_event.title, '{}'::uuid[]);
    perform private.audit_calendar('calendar.event.deleted', v_event, pg_catalog.jsonb_build_object('scope', 'all'));
    return pg_catalog.jsonb_build_object('outcome', 'deleted', 'entryId', v_entry);
  end
  $$;

-- Home calendar access ------------------------------------------------------------------------------------

-- The members' calendar levels. Someone who may set them (the Owner, Administrators granted
-- manageHomeCalendar) sees every member; everyone else only their own. 42501 for a Home the caller is
-- not in.
create function public.list_home_calendar_access(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_manager boolean;
  begin
    perform private.require_calendar_home(p_home_id, v_user_id);
    v_manager := private.calendar_level(p_home_id, v_user_id) = 'manage';
    return pg_catalog.jsonb_build_object(
      'canManage', v_manager,
      'members', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'membershipId', m.id,
            'isSelf', m.user_id = v_user_id,
            'role', m.role,
            'level', private.calendar_level(p_home_id, m.user_id),
            'canChange', v_manager and m.user_id <> v_user_id
              and private.calendar_level(p_home_id, m.user_id) <> 'manage')
          order by m.created_at, m.id)
        from public.home_memberships m
        where m.home_id = p_home_id and (v_manager or m.user_id = v_user_id)), '[]'::jsonb)
    );
  end
  $$;

-- Sets a member's level: 'view', 'edit' or 'edit_delete'. Only the Owner and Administrators granted
-- manageHomeCalendar, never for themselves or for someone who manages the calendar. Works at once.
-- Outcomes: 'ok', 'unchanged', 'not_found', 'not_permitted'. 42501 for a Home the caller is not in.
create function public.set_home_calendar_access(p_home_id uuid, p_membership_id uuid, p_level text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_before text;
  begin
    if p_membership_id is null or p_level is null or p_level not in ('view', 'edit', 'edit_delete') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.require_calendar_home(p_home_id, v_user_id);
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.calendar_level(p_home_id, v_user_id) <> 'manage' then
      return 'not_permitted';
    end if;
    select * into v_target from public.home_memberships m where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    v_before := private.calendar_level(p_home_id, v_target.user_id);
    if v_target.user_id = v_user_id or v_before = 'manage' then
      return 'not_permitted';
    end if;
    if v_before = p_level then
      return 'unchanged';
    end if;
    insert into private.home_calendar_access (home_id, user_id, level, set_by)
      values (p_home_id, v_target.user_id, p_level, v_user_id)
      on conflict (home_id, user_id) do update
        set level = excluded.level, set_by = excluded.set_by, set_at = pg_catalog.now();
    perform private.audit('calendar.access.changed', p_home_id, 'user', v_target.user_id,
      pg_catalog.jsonb_build_object('from', v_before, 'to', p_level));
    return 'ok';
  end
  $$;

-- The caller's own view settings for their Personal calendar (p_home_id null) or a Home's: each value given
-- is saved, the others stay. Vacations and chores are Home settings. 42501 for a Home they are not in.
create function public.set_calendar_preferences(
  p_home_id uuid default null, p_show_vacations boolean default null, p_show_tasks boolean default null,
  p_show_chores boolean default null
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if (p_show_vacations is null and p_show_tasks is null and p_show_chores is null)
       or (p_home_id is null and (p_show_vacations is not null or p_show_chores is not null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_home_id is not null then
      perform private.require_calendar_home(p_home_id, v_user_id);
    end if;
    insert into private.calendar_view_preferences as p (user_id, home_id, show_vacations, show_tasks, show_chores)
      values (v_user_id, p_home_id, coalesce(p_show_vacations, true), coalesce(p_show_tasks, false),
        coalesce(p_show_chores, false))
      on conflict (user_id, home_id) do update
        set show_vacations = coalesce(p_show_vacations, p.show_vacations),
            show_tasks = coalesce(p_show_tasks, p.show_tasks),
            show_chores = coalesce(p_show_chores, p.show_chores),
            updated_at = pg_catalog.now();
    return 'ok';
  end
  $$;

-- Reminders ----------------------------------------------------------------------------------------------

-- The moment of an occurrence's reminder: its start (08:00 on its first day for an all-day one) in the
-- event's timezone, minus the offset (PostgreSQL resolves a time a daylight-saving change skips or
-- repeats). "1 day before" is the same wall-clock time the day before. Null without a reminder.
create function private.calendar_reminder_at(p_event private.calendar_events, p_occurrence private.calendar_occurrence)
returns timestamptz
  language sql stable set search_path = '' as $$
  select case when p_event.reminder_minutes is null or p_occurrence.event_id is null then null
    when p_event.reminder_minutes = 1440 then
      ((p_occurrence.starts_on - 1)
        + case when p_occurrence.all_day then time '08:00' else p_occurrence.start_time end)
        at time zone p_event.timezone
    else
      ((p_occurrence.starts_on + case when p_occurrence.all_day then time '08:00' else p_occurrence.start_time end)
        at time zone p_event.timezone)
      - pg_catalog.make_interval(mins => p_event.reminder_minutes)
  end;
  $$;

-- The first occurrence, in the rule's order, whose reminder moment is still ahead: its rule date and the
-- moment, or nulls. Starts 15 days back (an occurrence moved later keeps its original date) and looks at
-- no more than 1000 dates.
create function private.calendar_next_reminder(
  p_event private.calendar_events, out original_date date, out remind_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_date date;
    v_at timestamptz;
    v_guard integer := 0;
  begin
    if p_event.id is null or p_event.reminder_minutes is null or p_event.deleted_at is not null then
      return;
    end if;
    if p_event.frequency is null then
      v_at := private.calendar_reminder_at(p_event, private.calendar_effective(p_event, p_event.starts_on));
      if v_at > pg_catalog.now() then
        original_date := p_event.starts_on;
        remind_at := v_at;
      end if;
      return;
    end if;
    v_date := private.series_first_on_or_after(p_event.frequency, p_event.interval_count, p_event.weekdays,
      p_event.starts_on, greatest(p_event.starts_on, (pg_catalog.now() at time zone p_event.timezone)::date - 15));
    while v_date is not null and (p_event.until_date is null or v_date <= p_event.until_date)
      and v_guard < 1000 loop
      v_at := private.calendar_reminder_at(p_event, private.calendar_effective(p_event, v_date));
      if v_at > pg_catalog.now() then
        original_date := v_date;
        remind_at := v_at;
        return;
      end if;
      v_guard := v_guard + 1;
      v_date := private.series_first_on_or_after(p_event.frequency, p_event.interval_count, p_event.weekdays,
        p_event.starts_on, v_date + 1);
    end loop;
  end
  $$;

-- Queues the event's next reminder. The key names the event, the occurrence and the moment, so a retry or
-- a change that keeps the moment queues it once; a job whose moment no longer matches finds that out at
-- delivery and does nothing. Runs after every change of an event or of its occurrences (triggers below).
create function private.schedule_calendar_reminder(p_event_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_event private.calendar_events;
    v_next record;
  begin
    select * into v_event from private.calendar_events e where e.id = p_event_id;
    if v_event.id is null then
      return;
    end if;
    select * into v_next from private.calendar_next_reminder(v_event);
    if v_next.remind_at is null then
      return;
    end if;
    perform private.enqueue_job('calendar-event-reminder', 1,
      'calendar-reminder:' || v_event.id::text || ':' || v_next.original_date::text || ':'
        || extract(epoch from v_next.remind_at)::bigint::text,
      pg_catalog.jsonb_build_object('eventId', v_event.id, 'on', v_next.original_date,
        'at', private.habit_utc_text(v_next.remind_at)),
      null, v_next.remind_at);
  end
  $$;

create function private.calendar_event_reminder_trigger() returns trigger
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if new.reminder_minutes is not null and new.deleted_at is null then
      perform private.schedule_calendar_reminder(new.id);
    end if;
    return null;
  end
  $$;

create trigger calendar_events_reminder after insert or update on private.calendar_events
  for each row execute function private.calendar_event_reminder_trigger();

create function private.calendar_exception_reminder_trigger() returns trigger
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if tg_op in ('INSERT', 'UPDATE') then
      perform private.schedule_calendar_reminder(new.event_id);
    end if;
    if tg_op in ('DELETE', 'UPDATE') and old.event_id is distinct from new.event_id then
      perform private.schedule_calendar_reminder(old.event_id);
    end if;
    return null;
  end
  $$;

create trigger calendar_event_exceptions_reminder after insert or update or delete
  on private.calendar_event_exceptions
  for each row execute function private.calendar_exception_reminder_trigger();

-- Delivers one occurrence's reminder (the calendar-event-reminder job; service role only). Rechecks
-- everything: the event still exists outside the trash with a reminder, the occurrence is not cancelled
-- and its moment is still p_at. A personal event reminds its owner only (sharing never reminds anyone
-- else); a Home event reminds its participants who are still members, or its creator when it has none.
-- Once per person and moment; their choices and quiet hours apply in notify_user. The notice carries
-- ids only (the title is read with the reader's own access). Then queues the next occurrence's.
-- Outcomes: 'notified', 'stale', 'late', 'not_due'.
create function public.deliver_calendar_reminder(p_event_id uuid, p_on date, p_at timestamptz) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_event private.calendar_events;
    v_occurrence private.calendar_occurrence;
    v_users uuid[];
    v_user_id uuid;
  begin
    if p_event_id is null or p_on is null or p_at is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_event from private.calendar_events e where e.id = p_event_id for update;
    if v_event.id is null or v_event.deleted_at is not null or v_event.reminder_minutes is null then
      return 'stale';
    end if;
    v_occurrence := private.calendar_effective(v_event, p_on);
    if private.calendar_reminder_at(v_event, v_occurrence) is distinct from p_at then
      -- The moment moved without a change that queued it: queue the current one (once, by its key).
      perform private.schedule_calendar_reminder(v_event.id);
      return 'stale';
    end if;
    if p_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    if pg_catalog.now() > p_at + pg_catalog.make_interval(mins => private.calendar_limit('late_minutes')) then
      perform private.schedule_calendar_reminder(v_event.id);
      return 'late';
    end if;
    if v_event.home_id is null then
      v_users := array[v_event.owner_user_id];
    else
      select pg_catalog.array_agg(m.user_id order by m.user_id) into v_users
        from public.home_memberships m
        where m.home_id = v_event.home_id and m.user_id = any (coalesce(v_occurrence.participants, '{}'));
      if v_users is null and v_event.created_by is not null then
        v_users := array[v_event.created_by];
      end if;
    end if;
    foreach v_user_id in array coalesce(v_users, '{}') loop
      perform private.notify_user(v_user_id, v_event.home_id, 'reminders', 'calendar.reminder',
        pg_catalog.jsonb_build_object('homeId', v_event.home_id, 'eventId', v_event.id, 'on', p_on,
          'onDate', v_occurrence.starts_on),
        'calendar-reminder:' || v_event.id::text || ':' || p_on::text || ':' || v_user_id::text || ':'
          || extract(epoch from p_at)::bigint::text,
        true);
    end loop;
    perform private.schedule_calendar_reminder(v_event.id);
    return 'notified';
  end
  $$;

-- The titles of events named in the caller's notifications, for those they may see now: their own
-- personal events and the events of Homes they belong to. Nothing for anything else.
create function public.calendar_notice_titles(p_event_ids uuid[])
returns table (event_id uuid, title text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_event_ids is null or pg_catalog.cardinality(p_event_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    return query
      select e.id, e.title from private.calendar_events e
      where e.id = any (p_event_ids) and e.deleted_at is null
        and (e.owner_user_id = v_user_id
          or (e.home_id is not null and private.home_role(e.home_id, v_user_id) is not null));
  end
  $$;

-- Trash --------------------------------------------------------------------------------------------------

-- The calendar's own rule (S16 lets a module set it for its item types): a personal event's entry is its
-- owner's alone (the default rule already says so: it is a personal entry). A Home event's entry is for
-- the members who may delete Home events now (level 'edit_delete' or 'manage'), whoever deleted it, so a
-- lowered level hides it at once and a raised one reaches it.
alter function private.can_see_trash_entry(private.trash_entries, uuid) rename to can_see_trash_entry_before_calendar;

create function private.can_see_trash_entry(p_entry private.trash_entries, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select case
    when p_entry.module <> 'calendar' then private.can_see_trash_entry_before_calendar(p_entry, p_user_id)
    when p_user_id is null then false
    when p_entry.owner_user_id is not null then p_entry.owner_user_id = p_user_id
    else private.calendar_level_allows(private.calendar_level(p_entry.owner_home_id, p_user_id), 'delete')
  end;
  $$;

alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_calendar;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_calendar;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_calendar;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_calendar;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_calendar;

-- An event's only conflict: its owner already has 5000 events ('calendar_limit'); the person makes room.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_event private.calendar_events;
  begin
    if p_entry.module <> 'calendar' then
      return private.trash_conflict_before_calendar(p_entry);
    end if;
    select * into v_event from private.calendar_events e where e.id = p_entry.subject_id;
    if not found or v_event.deleted_at is null then
      return 'item_missing';
    end if;
    if private.calendar_owner_full(v_event.owner_user_id, v_event.home_id) then
      return 'calendar_limit';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'calendar_limit' then array[]::text[]
    else private.trash_conflict_options_before_calendar(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'calendar' then
      perform private.trash_resolve_before_calendar(p_entry, p_resolution);
    end if;
    -- Calendar events have no resolvable conflict.
  end
  $$;

-- The event comes back as it was deleted, with its exceptions; a personal event's shares come back for
-- the Homes its owner still belongs to (the others ended with the membership).
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_event private.calendar_events;
  begin
    if p_entry.module <> 'calendar' then
      return private.trash_item_restore_before_calendar(p_entry);
    end if;
    select * into v_event from private.calendar_events e
      where e.id = p_entry.subject_id and e.deleted_at is not null for update;
    if not found then
      raise exception 'event unavailable' using errcode = '23505';
    end if;
    perform private.lock_calendar_owner(v_event.owner_user_id, v_event.home_id);
    if private.trash_conflict(p_entry) is not null then
      raise exception 'calendar restore conflict' using errcode = '23505';
    end if;
    update private.calendar_events e set deleted_at = null, revision = e.revision + 1, updated_at = pg_catalog.now(),
        participants = coalesce((select pg_catalog.array_agg(p order by n)
          from pg_catalog.unnest(e.participants) with ordinality as a(p, n)
          where exists (select 1 from public.home_memberships m where m.home_id = e.home_id and m.user_id = p)), '{}')
      where e.id = v_event.id returning * into v_event;
    perform private.audit_calendar('calendar.event.restored', v_event);
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'calendar' then
      perform private.trash_item_purge_before_calendar(p_entry);
      return;
    end if;
    delete from private.calendar_events e where e.id = p_entry.subject_id and e.deleted_at is not null;
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The calendar API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'list_calendar', 'get_calendar_upcoming', 'get_calendar_event', 'create_calendar_event',
      'update_calendar_event', 'set_calendar_event_shares', 'delete_calendar_event',
      'list_home_calendar_access', 'set_home_calendar_access', 'set_calendar_preferences',
      'calendar_notice_titles'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The reminder job: the service role only.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'deliver_calendar_reminder'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%calendar%'
      or p.proname in ('can_see_trash_entry', 'trash_conflict', 'trash_conflict_options', 'trash_resolve',
        'trash_item_restore', 'trash_item_purge', 'is_delegable_capability')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
