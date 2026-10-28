-- S28: habits core (brief plans/steps/S28-brief.md; ADR 0035; spec "Confirmed flexible habit tracking
-- schedules", "Confirmed forward-only habit schedule changes", "Confirmed opt-in shared Home habit pause
-- notifications", "Confirmed independent manual shared Home habit pauses", "Confirmed independent manual
-- personal habit pauses", "Confirmed optional personal habit pauses during individual vacations",
-- "Confirmed personal and collaborative Home habits", "Confirmed seven-day habit completion
-- backdating", "Confirmed subtle habit streak milestone celebrations", "Confirmed simple habit
-- insights", "Confirmed optional habit end dates", "Confirmed separate ended habit section",
-- "Confirmed ended habit reactivation tracking periods", "Confirmed reminder review during habit
-- reactivation", "Confirmed optional compact habit insights dashboard widget", "Confirmed immediate
-- habit completion Undo", "Confirmed historical habit corrections and streak recalculation",
-- "Confirmed optional notes on habit completions", "Confirmed direct habit completion from
-- notifications", "Confirmed simple habit reminder snoozing", "Confirmed flexible habit reminders",
-- "Confirmed interactive habit and goal dashboard widgets").
--
-- A habit belongs to exactly one context: a person (their Personal space) or a Home. Nothing here is
-- exposed as a table; people use security-definer functions that run with their own session and
-- recheck the confirmed caller, their current membership and their access on every call. A Home the
-- caller is not in answers 42501 "not permitted" exactly like one that does not exist; a habit they
-- may not see answers 'not_found' exactly like a missing one. A personal habit is its owner's alone:
-- no Home role ever sees it, its pauses, its vacation choices or its notes.
--
-- Who may do what (defaults picked in the brief, owner may override). packages/domain/src/permissions/
-- habits.ts makes the same decisions:
-- - Personal habit: its owner, for everything.
-- - Home habit: every current member sees it, its history and insights. Members check in (today and
--   up to seven days back), undo their own check-ins inside that window and keep their own notes,
--   unless a habit manager set the Home's habits to view only. Habit managers (the Owner and
--   Administrators granted the new delegable capability manageHomeHabits) also create and change
--   habits, correct anyone's check-in at any date and set that member access.
--
-- Time: every date is a local calendar date in the habit's timezone (the Home's for a Home habit, the
-- habit's own for a personal one), so daylight-saving changes never move a check-in; "today" is now
-- in that zone. A habit week starts on the habit's stored week start.
--
-- History is never rewritten: schedules are dated versions, end dates and reactivations are tracking
-- periods, check-ins are undone rather than deleted, and every statistic (states, streaks,
-- milestones, insights) is computed from that history each time it is read, so a correction, a
-- backdated check-in, an Undo or a pause change recalculates deterministically. Every change takes the
-- habit's row lock first, so check-ins and changes of one habit are decided one at a time.

-- Audit subjects, the new capability, trash types ------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping',
    'manageHomeMeals', 'manageHomeHabits'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping', 'meals', 'habits'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit'
  ));

-- Notifications: the optional, opt-in category 'habits' (pause and resume notices of Home habits);
-- habit reminders use 'reminders'. ---------------------------------------------------------------------

create or replace function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category
    when 'security' then true when 'storage' then true
    when 'invitations' then false when 'reminders' then false when 'approvals' then false
    when 'chores' then false when 'points' then false when 'rewards' then false
    when 'habits' then false
  end;
  $$;

alter table public.notifications drop constraint notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('security', 'invitations', 'storage', 'reminders', 'approvals', 'chores',
    'points', 'rewards', 'habits'));

alter table public.notification_preferences drop constraint notification_preferences_category_check;
alter table public.notification_preferences add constraint notification_preferences_category_check
  check (category in ('invitations', 'reminders', 'approvals', 'chores', 'points', 'rewards', 'habits'));

-- packages/domain optionalNotificationCategories lists the same.
create or replace function private.notification_category_optional(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_category in ('invitations', 'reminders', 'approvals', 'chores', 'points', 'rewards',
    'habits'), false);
  $$;

-- The built-in default: in-app on, email off, except the opt-in categories 'points' and 'habits',
-- which are off on every channel until the person turns them on (spec: "Default to no dedicated
-- pause/resume notification until the member opts in").
create or replace function private.effective_notification_channel(
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
    return p_channel = 'in_app' and p_category not in ('points', 'habits');
  end
  $$;

create or replace function public.get_notification_settings()
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
      cross join (values ('invitations'), ('reminders'), ('approvals'), ('chores'), ('points'),
        ('rewards'), ('habits')) c (category)
      cross join (values ('in_app'), ('email')) ch (channel)
      order by s.home_id nulls first, c.category, ch.channel;
  end
  $$;

-- Limits and text rules ----------------------------------------------------------------------------

-- apps/web/src/habits/schema.ts and packages/domain/src/habits use the same numbers.
create function private.habit_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'name' then 80
    when 'description' then 500
    when 'note' then 280
    when 'reason' then 200
    when 'habits' then 100            -- habits per context that are not archived
    when 'times' then 3               -- reminder times per habit
    when 'backdate_days' then 7       -- new check-ins: today and the seven days before
    when 'page' then 50               -- history rows one read returns
    when 'query' then 80              -- search text
    when 'start_past_days' then 7     -- a new habit may start up to seven days ago
    when 'start_future_days' then 366
    when 'late_minutes' then 30       -- a reminder more than this late is skipped
  end;
  $$;

-- The milestones, in streak units (occurrences or weeks).
create function private.habit_milestones_list() returns integer[]
  language sql immutable set search_path = '' as $$ select array[7, 30, 100] $$;

-- A schedule is daily, chosen ISO weekdays (1 Monday ... 7 Sunday, at least one, no repeats) or a
-- weekly target of 1 to 7 completions per habit week.
create function private.valid_habit_schedule(p_kind text, p_weekdays smallint[], p_target smallint)
returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(case p_kind
    when 'daily' then p_weekdays is null and p_target is null
    when 'weekdays' then p_target is null and p_weekdays is not null
      and cardinality(p_weekdays) between 1 and 7
      and (select bool_and(w between 1 and 7) and count(distinct w) = count(*) from unnest(p_weekdays) w)
    when 'weekly' then p_weekdays is null and p_target between 1 and 7
  end, false);
  $$;

-- Reminder times (1-3, distinct, whole minutes) and weekdays (1-7, at least one, no repeats).
create function private.valid_habit_reminder(p_times time[], p_weekdays smallint[]) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_times is not null and p_weekdays is not null
    and cardinality(p_times) between 1 and 3 and cardinality(p_weekdays) between 1 and 7
    and (select bool_and(t is not null and t = date_trunc('minute', t)) and count(distinct t) = count(*)
      from unnest(p_times) t)
    and (select bool_and(w between 1 and 7) and count(distinct w) = count(*) from unnest(p_weekdays) w),
    false);
  $$;

-- ISO weekday of a week start: Monday 1, Saturday 6, Sunday 7.
create function private.habit_week_start_day(p_week_start text) returns smallint
  language sql immutable set search_path = '' as $$
  select case p_week_start when 'monday' then 1 when 'saturday' then 6 when 'sunday' then 7 end::smallint;
  $$;

-- The first day of the habit week containing a date.
create function private.habit_week_of(p_week_start text, p_on date) returns date
  language sql immutable set search_path = '' as $$
  select p_on - ((extract(isodow from p_on)::integer - private.habit_week_start_day(p_week_start) + 7) % 7);
  $$;

-- Tables -------------------------------------------------------------------------------------------

-- A Home's habit settings (a row exists once a manager changed them; none means the defaults).
create table private.habit_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  member_access text not null default 'complete'
    constraint habit_settings_access_check check (member_access in ('complete', 'view')),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- A person's own habit choice: milestone celebrations on or muted.
create table private.habit_user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  celebrations boolean not null default true,
  updated_at timestamptz not null default now()
);

create table private.habits (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  name text not null,
  description text,
  -- A personal habit's own timezone (null for a Home habit, which uses the Home's).
  time_zone text,
  week_start text not null constraint habits_week_start_check check (week_start in ('monday', 'saturday', 'sunday')),
  archived_at timestamptz,
  archived_by uuid references auth.users (id) on delete set null,
  -- Set while the habit is in the trash (S16).
  deleted_at timestamptz,
  revision integer not null default 1 constraint habits_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint habits_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint habits_name_check check (private.is_visible_name(name, 80)),
  constraint habits_description_check check (description is null or private.is_plain_text(description, 500)),
  constraint habits_zone_check check ((owner_home_id is null) = (time_zone is not null)
    and (time_zone is null or char_length(time_zone) <= 64))
);

create index habits_home_idx on private.habits (owner_home_id) where owner_home_id is not null;
create index habits_user_idx on private.habits (owner_user_id) where owner_user_id is not null;

-- A tracking period: from starts_on to ends_on (inclusive; null: open). The first starts at the
-- habit's start date; a reactivation adds a new one after the last has ended. Periods never overlap.
create table private.habit_periods (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references private.habits (id) on delete cascade,
  starts_on date not null,
  ends_on date,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint habit_periods_dates_check check (ends_on is null or ends_on >= starts_on),
  constraint habit_periods_start_key unique (habit_id, starts_on)
);

-- A dated schedule version: applies from effective_on until the next version. Never rewritten once
-- in effect (changes add a version from tomorrow or a later week start).
create table private.habit_schedules (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references private.habits (id) on delete cascade,
  effective_on date not null,
  kind text not null constraint habit_schedules_kind_check check (kind in ('daily', 'weekdays', 'weekly')),
  weekdays smallint[],
  weekly_target smallint,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint habit_schedules_shape_check check (private.valid_habit_schedule(kind, weekdays, weekly_target)),
  constraint habit_schedules_effective_key unique (habit_id, effective_on)
);

-- A manual pause from starts_on until the day before resumes_on (null: until resumed). Resuming sets
-- resumes_on to today or later; a pause resumed the day it started covers nothing.
create table private.habit_pauses (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references private.habits (id) on delete cascade,
  starts_on date not null,
  resumes_on date,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revision integer not null default 1 constraint habit_pauses_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint habit_pauses_dates_check check (resumes_on is null or resumes_on >= starts_on)
);

create index habit_pauses_habit_idx on private.habit_pauses (habit_id, starts_on);

-- A personal habit its owner pauses during their own accepted participation in a Home vacation.
create table private.habit_vacation_choices (
  habit_id uuid not null references private.habits (id) on delete cascade,
  vacation_id uuid not null references private.home_vacations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (habit_id, vacation_id)
);

create index habit_vacation_choices_vacation_idx on private.habit_vacation_choices (vacation_id);

-- The days vacations pause a habit, kept per habit: refreshed for today onward whenever a vacation,
-- a participation, a membership or a choice changes, so a past day never changes afterwards.
create table private.habit_vacation_days (
  habit_id uuid primary key references private.habits (id) on delete cascade,
  days datemultirange not null default '{}',
  updated_at timestamptz not null default now()
);

-- A check-in: the habit was done on on_date (the opportunity it counts for). At most one active
-- check-in per habit and date; Undo and corrections mark it undone, never delete it.
create table private.habit_checkins (
  id uuid primary key,
  habit_id uuid not null references private.habits (id) on delete cascade,
  on_date date not null,
  completed_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  source text not null constraint habit_checkins_source_check check (source in ('app', 'widget', 'notification')),
  note text constraint habit_checkins_note_check check (note is null or private.is_plain_text(note, 280)),
  note_revision integer not null default 0 constraint habit_checkins_note_revision_check check (note_revision >= 0),
  note_updated_at timestamptz,
  status text not null default 'active' constraint habit_checkins_status_check check (status in ('active', 'undone')),
  undone_by uuid references auth.users (id) on delete set null,
  undone_at timestamptz,
  -- 'undo': the person's own reversal; 'correction': someone allowed to correct history.
  undo_kind text constraint habit_checkins_undo_kind_check check (undo_kind in ('undo', 'correction')),
  undo_reason text constraint habit_checkins_reason_check check (undo_reason is null or private.is_plain_text(undo_reason, 200)),
  constraint habit_checkins_undo_check check ((status = 'undone') = (undone_at is not null and undo_kind is not null))
);

create unique index habit_checkins_one_active on private.habit_checkins (habit_id, on_date) where status = 'active';
create index habit_checkins_habit_idx on private.habit_checkins (habit_id, on_date desc);

-- A milestone reached: the streak element (occurrence date or week start) where a streak first
-- reached the threshold. Recorded once per streak; corrections never delete it.
create table private.habit_milestones (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references private.habits (id) on delete cascade,
  unit text not null constraint habit_milestones_unit_check check (unit in ('occurrences', 'weeks')),
  threshold integer not null,
  reached_on date not null,
  checkin_id uuid references private.habit_checkins (id) on delete set null,
  backdated boolean not null,
  recorded_at timestamptz not null default now(),
  constraint habit_milestones_key unique (habit_id, unit, threshold, reached_on)
);

-- The habit's reminder: up to three local times on chosen weekdays (off by default; no row = never set).
create table private.habit_reminders (
  habit_id uuid primary key references private.habits (id) on delete cascade,
  enabled boolean not null,
  times time[] not null,
  weekdays smallint[] not null,
  revision integer not null default 1 constraint habit_reminders_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  -- When the hourly top-up last looked at it; the oldest go first, so every chain gets its turn.
  topped_up_at timestamptz,
  constraint habit_reminders_shape_check check (private.valid_habit_reminder(times, weekdays))
);

-- A Home member who turned a Home habit's reminders off for themselves.
create table private.habit_reminder_optouts (
  habit_id uuid not null references private.habits (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (habit_id, user_id)
);

-- One deferred delivery of one reminder notice (snooze).
create table private.habit_reminder_snoozes (
  notification_id uuid primary key references public.notifications (id) on delete cascade,
  habit_id uuid not null references private.habits (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  on_date date not null,
  minutes integer not null constraint habit_reminder_snoozes_minutes_check check (minutes in (15, 30, 60)),
  due_at timestamptz not null,
  status text not null default 'pending'
    constraint habit_reminder_snoozes_status_check check (status in ('pending', 'delivered', 'cancelled')),
  created_at timestamptz not null default now()
);

-- The habit's history: ids, dates and codes only (never note text or names).
create table private.habit_events (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references private.habits (id) on delete cascade,
  kind text not null constraint habit_events_kind_check check (kind in (
    'created', 'edited', 'schedule_changed', 'end_changed', 'paused', 'pause_changed', 'resumed',
    'archived', 'unarchived', 'restored', 'reactivated', 'reminders_changed', 'checked_in', 'undone',
    'corrected', 'note_added', 'note_edited', 'note_removed', 'vacation_pause_changed'
  )),
  actor uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  on_date date,
  checkin_id uuid,
  details jsonb not null default '{}'
);

create index habit_events_habit_idx on private.habit_events (habit_id, at desc);

alter table private.habit_settings enable row level security;
alter table private.habit_user_settings enable row level security;
alter table private.habits enable row level security;
alter table private.habit_periods enable row level security;
alter table private.habit_schedules enable row level security;
alter table private.habit_pauses enable row level security;
alter table private.habit_vacation_choices enable row level security;
alter table private.habit_vacation_days enable row level security;
alter table private.habit_checkins enable row level security;
alter table private.habit_milestones enable row level security;
alter table private.habit_reminders enable row level security;
alter table private.habit_reminder_optouts enable row level security;
alter table private.habit_reminder_snoozes enable row level security;
alter table private.habit_events enable row level security;
revoke all on private.habit_settings, private.habit_user_settings, private.habits, private.habit_periods,
  private.habit_schedules, private.habit_pauses, private.habit_vacation_choices, private.habit_vacation_days,
  private.habit_checkins, private.habit_milestones, private.habit_reminders, private.habit_reminder_optouts,
  private.habit_reminder_snoozes, private.habit_events
  from public, anon, authenticated;

-- Permission helpers (the engine in packages/domain mirrors these) ----------------------------------

-- What p_user_id may do with a context's habits now: 'manage' (the Personal space's owner; a Home's
-- Owner and Administrators granted manageHomeHabits), 'complete' or 'view' (other current members, by
-- the Home's member access), or null (not a member).
create function private.habit_access(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then null
    when p_home_id is null then 'manage'
    when not private.is_home_member(p_home_id, p_user_id) then null
    when private.has_home_capability(p_home_id, p_user_id, 'manageHomeHabits') then 'manage'
    else coalesce((select s.member_access from private.habit_settings s where s.home_id = p_home_id), 'complete')
  end;
  $$;

-- The caller's access to one habit: a personal habit is its owner's only.
create function private.habit_role(p_habit private.habits, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_habit.id is null or p_user_id is null then null
    when p_habit.owner_home_id is null then case when p_habit.owner_user_id = p_user_id then 'manage' end
    else private.habit_access(p_habit.owner_home_id, p_user_id)
  end;
  $$;

create function private.habit_may(p_habit private.habits, p_user_id uuid, p_need text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    case private.habit_role(p_habit, p_user_id) when 'manage' then 3 when 'complete' then 2 when 'view' then 1 else 0 end
    >= case p_need when 'manage' then 3 when 'complete' then 2 else 1 end,
    false);
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_habit_context(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- A habit the caller may see (not in the trash), or a null row.
create function private.habit_for(p_habit_id uuid, p_user_id uuid) returns private.habits
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_habit private.habits;
  begin
    select * into v_habit from private.habits h where h.id = p_habit_id and h.deleted_at is null;
    if v_habit.id is null or not private.habit_may(v_habit, p_user_id, 'view') then
      return null;
    end if;
    return v_habit;
  end
  $$;

-- The same, locked for a change (the habit lock: every change and check-in of a habit takes it).
create function private.habit_lock(p_habit_id uuid, p_user_id uuid) returns private.habits
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit private.habits;
  begin
    select * into v_habit from private.habits h where h.id = p_habit_id and h.deleted_at is null for update;
    if v_habit.id is null or not private.habit_may(v_habit, p_user_id, 'view') then
      return null;
    end if;
    return v_habit;
  end
  $$;

create function private.habit_zone(p_habit private.habits) returns text
  language sql stable security definer set search_path = '' as $$
  select case when p_habit.owner_home_id is null then p_habit.time_zone
    else (select h.timezone from public.homes h where h.id = p_habit.owner_home_id) end;
  $$;

create function private.habit_today(p_habit private.habits) returns date
  language sql stable security definer set search_path = '' as $$
  select (pg_catalog.now() at time zone private.habit_zone(p_habit))::date;
  $$;

-- Ids, dates and codes only. Home habits only (a personal habit is nobody else's business).
create function private.audit_habit(
  p_action text, p_habit private.habits, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  select case when p_habit.owner_home_id is not null
    then private.audit(p_action, p_habit.owner_home_id, 'habit', p_habit.id, p_details) end;
  $$;

create function private.habit_event(
  p_habit_id uuid, p_kind text, p_actor uuid, p_on date default null, p_checkin_id uuid default null,
  p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.habit_events (habit_id, kind, actor, on_date, checkin_id, details)
    values (p_habit_id, p_kind, p_actor, p_on, p_checkin_id, coalesce(p_details, '{}'::jsonb));
  $$;

-- A person as a habit answer may name them: their membership id in the Home (null for a departed
-- member or a deleted account); for a personal habit, nothing.
create function private.habit_person(p_habit private.habits, p_user_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
  select case when p_habit.owner_home_id is not null and p_user_id is not null
    then private.member_ref(p_habit.owner_home_id, p_user_id) end;
  $$;

-- The habit's calendar ----------------------------------------------------------------------------------

-- Day by day between two dates: the tracking period and schedule version in effect, whether the day is
-- a scheduled opportunity, whether a manual pause or a vacation pauses it, and its active check-in.
create function private.habit_days(p_habit_id uuid, p_from date, p_to date)
returns table (
  on_date date, period_id uuid, kind text, weekly_target smallint, scheduled boolean,
  manual_paused boolean, vacation_paused boolean, checkin_id uuid, completed_by uuid
)
  language sql stable security definer set search_path = '' as $$
  select g.d::date, p.id, s.kind, s.weekly_target,
    p.id is not null and s.kind is not null
      and (s.kind <> 'weekdays' or extract(isodow from g.d)::smallint = any (s.weekdays)),
    exists (select 1 from private.habit_pauses hp
      where hp.habit_id = p_habit_id and hp.starts_on <= g.d::date
        and (hp.resumes_on is null or hp.resumes_on > g.d::date)),
    coalesce((select v.days @> g.d::date from private.habit_vacation_days v where v.habit_id = p_habit_id), false),
    c.id, c.completed_by
  from pg_catalog.generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g (d)
  left join lateral (
    select pr.id from private.habit_periods pr
    where pr.habit_id = p_habit_id and pr.starts_on <= g.d::date and (pr.ends_on is null or pr.ends_on >= g.d::date)
    limit 1) p on true
  left join lateral (
    select sv.kind, sv.weekdays, sv.weekly_target from private.habit_schedules sv
    where sv.habit_id = p_habit_id and sv.effective_on <= g.d::date
    order by sv.effective_on desc limit 1) s on true
  left join private.habit_checkins c on c.habit_id = p_habit_id and c.on_date = g.d::date and c.status = 'active';
  $$;

-- The weeks of weekly schedules that overlap two dates, one row per habit week and tracking period
-- (a reactivation inside a week makes two). The target counts at most the week's active days (in the
-- period and not paused, or already checked in), so a partial or partly paused week asks no more than
-- it can give; a week with no active day is paused. Outcome: 'done' (target reached), 'missed' (over,
-- not reached), 'pending' (still running, not reached), 'future' (not started) or 'paused'.
create function private.habit_weeks(p_habit private.habits, p_from date, p_to date, p_today date)
returns table (
  week_on date, period_id uuid, first_on date, last_on date, weekly_target smallint,
  active_days integer, completions integer, adjusted integer, outcome text
)
  language sql stable security definer set search_path = '' as $$
  with d as (
    select x.*, private.habit_week_of(p_habit.week_start, x.on_date) as week_on
    from private.habit_days(p_habit.id, private.habit_week_of(p_habit.week_start, p_from),
      private.habit_week_of(p_habit.week_start, p_to) + 6) x
    where x.kind = 'weekly' and x.period_id is not null
  ), w as (
    select d.week_on, d.period_id, min(d.on_date) as first_on, max(d.on_date) as last_on,
      max(d.weekly_target) as weekly_target,
      (count(*) filter (where not (d.manual_paused or d.vacation_paused) or d.checkin_id is not null))::integer as active_days,
      (count(d.checkin_id))::integer as completions
    from d group by d.week_on, d.period_id
  )
  select w.week_on, w.period_id, w.first_on, w.last_on, w.weekly_target, w.active_days, w.completions,
    least(w.weekly_target, w.active_days)::integer,
    case
      when least(w.weekly_target, w.active_days) = 0 then 'paused'
      when w.completions >= least(w.weekly_target, w.active_days) then 'done'
      when w.last_on < p_today then 'missed'
      when w.first_on > p_today then 'future'
      else 'pending'
    end
  from w;
  $$;

-- Every streak opportunity up to today, oldest first: scheduled unpaused days of daily and weekday
-- schedules ('occurrences': done, missed, or pending today) and the weeks of weekly schedules
-- ('weeks': done, missed, or pending while running). Paused and unscheduled days and paused weeks are
-- neutral and not listed. grp numbers the streaks: a missed opportunity, a new tracking period or a
-- change of unit starts a new one.
create function private.habit_streak_elements(p_habit private.habits, p_today date)
returns table (seq bigint, unit text, period_id uuid, key_on date, outcome text, grp bigint)
  language sql stable security definer set search_path = '' as $$
  with bounds as (
    select min(pr.starts_on) as first_on from private.habit_periods pr where pr.habit_id = p_habit.id
  ), o as (
    select 'occurrences'::text as unit, x.period_id, x.on_date as key_on,
      case when x.checkin_id is not null then 'done' when x.on_date = p_today then 'pending' else 'missed' end as outcome
    from bounds b, private.habit_days(p_habit.id, b.first_on, p_today) x
    where b.first_on is not null and b.first_on <= p_today and x.scheduled and x.kind <> 'weekly'
      and (x.checkin_id is not null or not (x.manual_paused or x.vacation_paused))
    union all
    select 'weeks', w.period_id, w.week_on, w.outcome
    from bounds b, private.habit_weeks(p_habit, b.first_on, p_today, p_today) w
    where b.first_on is not null and b.first_on <= p_today and w.outcome in ('done', 'missed', 'pending')
  ), n as (
    -- A week can belong to two periods (one ended, one reactivated within it): the period's start
    -- orders them, so the sequence is total and the same on every read.
    select o.*, row_number() over (order by o.key_on, pr.starts_on, o.unit) as seq
    from o join private.habit_periods pr on pr.id = o.period_id
  ), l as (
    select n.*, lag(n.unit) over (order by n.seq) as prev_unit,
      lag(n.period_id) over (order by n.seq) as prev_period
    from n
  )
  select l.seq, l.unit, l.period_id, l.key_on, l.outcome,
    sum(case when l.outcome = 'missed' or l.prev_unit is distinct from l.unit
      or l.prev_period is distinct from l.period_id then 1 else 0 end) over (order by l.seq)
  from l order by l.seq;
  $$;

-- The streak unit of the schedule in effect on a date ('weeks' or 'occurrences'), or null.
create function private.habit_unit_on(p_habit_id uuid, p_on date) returns text
  language sql stable security definer set search_path = '' as $$
  select case when s.kind = 'weekly' then 'weeks' else 'occurrences' end
  from private.habit_schedules s where s.habit_id = p_habit_id and s.effective_on <= p_on
  order by s.effective_on desc limit 1;
  $$;

-- The tracking period that contains a date, or null.
create function private.habit_period_on(p_habit_id uuid, p_on date) returns private.habit_periods
  language sql stable security definer set search_path = '' as $$
  select pr.* from private.habit_periods pr
  where pr.habit_id = p_habit_id and pr.starts_on <= p_on and (pr.ends_on is null or pr.ends_on >= p_on)
  limit 1;
  $$;

-- Current and longest streaks. The current streak is the streak of the latest decided opportunity
-- when that one was done, in today's tracking period and today's unit (an open opportunity today or
-- this week neither counts nor breaks it); otherwise 0. Longest: per unit, over all history.
create function private.habit_streak(p_habit private.habits, p_today date)
returns table (current_count integer, current_unit text, longest_occurrences integer, longest_weeks integer)
  language sql stable security definer set search_path = '' as $$
  with e as (
    select * from private.habit_streak_elements(p_habit, p_today)
  ), runs as (
    select e.grp, min(e.unit) as unit, count(*)::integer as len from e where e.outcome = 'done' group by e.grp
  ), last_decided as (
    select e.* from e where e.outcome <> 'pending' order by e.seq desc limit 1
  ), cur as (
    select (private.habit_period_on(p_habit.id, p_today)).id as period_id,
      coalesce(private.habit_unit_on(p_habit.id, p_today),
        (select case when s.kind = 'weekly' then 'weeks' else 'occurrences' end from private.habit_schedules s
          where s.habit_id = p_habit.id order by s.effective_on limit 1)) as unit
  )
  select
    coalesce((select r.len from last_decided ld, runs r, cur c
      where ld.outcome = 'done' and r.grp = ld.grp and ld.period_id = c.period_id and ld.unit = c.unit), 0),
    (select c.unit from cur c),
    coalesce((select max(r.len) from runs r where r.unit = 'occurrences'), 0),
    coalesce((select max(r.len) from runs r where r.unit = 'weeks'), 0);
  $$;

-- The state of each day between two dates as people see it: 'untracked' (outside every tracking
-- period), 'not_scheduled', 'completed', 'paused', 'future', and for daily and weekday schedules
-- 'pending' (today, not done) or 'missed' (past, not done); a weekly schedule's open days are 'open'
-- (its week decides). paused_by: 'manual', 'vacation' or 'both'.
create function private.habit_day_states(p_habit private.habits, p_from date, p_to date, p_today date)
returns table (on_date date, state text, kind text, paused_by text, checkin_id uuid)
  language sql stable security definer set search_path = '' as $$
  select x.on_date,
    case
      when x.period_id is null then 'untracked'
      when not x.scheduled then 'not_scheduled'
      when x.checkin_id is not null then 'completed'
      when x.manual_paused or x.vacation_paused then 'paused'
      when x.on_date > p_today then 'future'
      when x.kind = 'weekly' then 'open'
      when x.on_date = p_today then 'pending'
      else 'missed'
    end,
    x.kind,
    case when x.manual_paused and x.vacation_paused then 'both' when x.manual_paused then 'manual'
      when x.vacation_paused then 'vacation' end,
    x.checkin_id
  from private.habit_days(p_habit.id, p_from, p_to) x;
  $$;

-- Why a new check-in for a date cannot be recorded now, or null when it can: 'archived', 'future',
-- 'outside_window' (more than seven days ago), 'untracked' (outside every tracking period: before the
-- start, after an end, in a gap), 'not_scheduled', 'already_completed', 'paused', 'target_reached'
-- (a weekly target already met that week).
create function private.habit_checkin_block(p_habit private.habits, p_on date, p_today date) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_day record;
    v_week record;
  begin
    if p_habit.archived_at is not null then
      return 'archived';
    end if;
    if p_on > p_today then
      return 'future';
    end if;
    if p_on < p_today - private.habit_limit('backdate_days') then
      return 'outside_window';
    end if;
    select * into v_day from private.habit_days(p_habit.id, p_on, p_on);
    if v_day.period_id is null then
      return 'untracked';
    end if;
    if not v_day.scheduled then
      return 'not_scheduled';
    end if;
    if v_day.checkin_id is not null then
      return 'already_completed';
    end if;
    if v_day.manual_paused or v_day.vacation_paused then
      return 'paused';
    end if;
    if v_day.kind = 'weekly' then
      select * into v_week from private.habit_weeks(p_habit, p_on, p_on, p_today) w
        where w.period_id = v_day.period_id and w.week_on = private.habit_week_of(p_habit.week_start, p_on);
      if v_week.completions >= v_week.adjusted then
        return 'target_reached';
      end if;
    end if;
    return null;
  end
  $$;

-- What pauses the habit on a date: 'manual', 'vacation', 'both' or null.
create function private.habit_paused_on(p_habit private.habits, p_on date) returns text
  language sql stable security definer set search_path = '' as $$
  select s.paused_by from private.habit_day_states(p_habit, p_on, p_on, p_on) s;
  $$;

-- Lifecycle status today: 'archived', 'ended' (the last tracking period ended before today),
-- 'upcoming' (the next tracking period has not started), 'paused' (a pause covers today) or 'active'.
create function private.habit_status(p_habit private.habits, p_today date) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_last private.habit_periods;
  begin
    if p_habit.archived_at is not null then
      return 'archived';
    end if;
    select * into v_last from private.habit_periods pr where pr.habit_id = p_habit.id order by pr.starts_on desc limit 1;
    if v_last.ends_on is not null and v_last.ends_on < p_today then
      return 'ended';
    end if;
    if v_last.starts_on > p_today then
      return 'upcoming';
    end if;
    if exists (select 1 from private.habit_pauses hp where hp.habit_id = p_habit.id
          and hp.starts_on <= p_today and (hp.resumes_on is null or hp.resumes_on > p_today))
       or coalesce((select v.days @> p_today from private.habit_vacation_days v where v.habit_id = p_habit.id), false) then
      return 'paused';
    end if;
    return 'active';
  end
  $$;

-- The last tracking period.
create function private.habit_last_period(p_habit_id uuid) returns private.habit_periods
  language sql stable security definer set search_path = '' as $$
  select pr.* from private.habit_periods pr where pr.habit_id = p_habit_id order by pr.starts_on desc limit 1;
  $$;

-- The schedule version in effect on a date (the first one when the date is before every version).
create function private.habit_schedule_on(p_habit_id uuid, p_on date) returns private.habit_schedules
  language sql stable security definer set search_path = '' as $$
  select s.* from private.habit_schedules s where s.habit_id = p_habit_id
  order by (s.effective_on <= p_on) desc, case when s.effective_on <= p_on then s.effective_on end desc nulls last,
    s.effective_on
  limit 1;
  $$;

-- Answers ----------------------------------------------------------------------------------------------

create function private.habit_schedule_json(p_schedule private.habit_schedules) returns jsonb
  language sql immutable set search_path = '' as $$
  select case when p_schedule.id is not null then pg_catalog.jsonb_build_object(
    'effectiveOn', p_schedule.effective_on, 'kind', p_schedule.kind,
    'weekdays', coalesce(pg_catalog.to_jsonb(p_schedule.weekdays), '[]'::jsonb),
    'target', p_schedule.weekly_target) end;
  $$;

create function private.habit_ranges_json(p_days datemultirange) returns jsonb
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'startsOn', pg_catalog.lower(r), 'endsOn', pg_catalog.upper(r) - 1) order by pg_catalog.lower(r)), '[]'::jsonb)
  from pg_catalog.unnest(coalesce(p_days, '{}'::datemultirange)) r
  where not pg_catalog.lower_inf(r) and not pg_catalog.upper_inf(r);
  $$;

-- A check-in as a viewer of its habit may see it: who did it (a membership id; for a personal habit
-- nothing), when it was recorded, its note and author, and an undo or correction.
create function private.habit_checkin_json(p_checkin private.habit_checkins, p_habit private.habits, p_viewer uuid)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_checkin.id,
    'onDate', p_checkin.on_date,
    'by', private.habit_person(p_habit, p_checkin.completed_by),
    'mine', coalesce(p_checkin.completed_by = p_viewer, false),
    'recordedAt', p_checkin.recorded_at,
    'backdated', (p_checkin.recorded_at at time zone private.habit_zone(p_habit))::date > p_checkin.on_date,
    'source', p_checkin.source,
    'note', p_checkin.note,
    'noteRevision', p_checkin.note_revision,
    'noteUpdatedAt', p_checkin.note_updated_at,
    'status', p_checkin.status,
    'undoneBy', private.habit_person(p_habit, p_checkin.undone_by),
    'undoneByMe', coalesce(p_checkin.undone_by = p_viewer, false),
    'undoneAt', p_checkin.undone_at,
    'undoKind', p_checkin.undo_kind,
    'undoReason', p_checkin.undo_reason);
  $$;

-- What the viewer may do with one check-in: 'undo' (their own, inside the backdating window, with
-- the right to check in), 'correct' (a habit manager), or null.
create function private.habit_checkin_action(
  p_checkin private.habit_checkins, p_habit private.habits, p_viewer uuid, p_today date
) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_checkin.status <> 'active' or p_habit.archived_at is not null then null
    when p_checkin.completed_by = p_viewer and private.habit_may(p_habit, p_viewer, 'complete')
      and p_checkin.on_date >= p_today - private.habit_limit('backdate_days') then 'undo'
    when private.habit_may(p_habit, p_viewer, 'manage') then 'correct'
  end;
  $$;

-- The current week of a weekly schedule (null otherwise).
create function private.habit_week_json(p_habit private.habits, p_today date) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('weekOn', w.week_on, 'firstOn', w.first_on, 'lastOn', w.last_on,
    'endsOn', w.week_on + 6, 'completions', w.completions, 'target', w.weekly_target,
    'adjusted', w.adjusted, 'outcome', w.outcome)
  from private.habit_weeks(p_habit, p_today, p_today, p_today) w
  where w.period_id = (private.habit_period_on(p_habit.id, p_today)).id
    and w.week_on = private.habit_week_of(p_habit.week_start, p_today);
  $$;

-- A habit as lists, widgets and its page show it.
create function private.habit_summary_json(p_habit private.habits, p_viewer uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := private.habit_today(p_habit);
    v_first private.habit_periods;
    v_last private.habit_periods;
    v_streak record;
    v_state record;
    v_pause private.habit_pauses;
    v_reminder private.habit_reminders;
    v_checkin private.habit_checkins;
    v_status text := private.habit_status(p_habit, v_today);
  begin
    select * into v_first from private.habit_periods pr where pr.habit_id = p_habit.id order by pr.starts_on limit 1;
    v_last := private.habit_last_period(p_habit.id);
    select * into v_streak from private.habit_streak(p_habit, v_today);
    select * into v_state from private.habit_day_states(p_habit, v_today, v_today, v_today);
    select * into v_pause from private.habit_pauses hp
      where hp.habit_id = p_habit.id and (hp.resumes_on is null or hp.resumes_on > v_today)
        and hp.resumes_on is distinct from hp.starts_on
      order by hp.starts_on limit 1;
    select * into v_reminder from private.habit_reminders r where r.habit_id = p_habit.id;
    select * into v_checkin from private.habit_checkins c
      where c.habit_id = p_habit.id and c.on_date = v_today and c.status = 'active';
    return pg_catalog.jsonb_build_object(
      'id', p_habit.id,
      'homeId', p_habit.owner_home_id,
      'name', p_habit.name,
      'description', p_habit.description,
      'timeZone', private.habit_zone(p_habit),
      'weekStart', p_habit.week_start,
      'revision', p_habit.revision,
      'status', v_status,
      'archivedAt', p_habit.archived_at,
      'today', v_today,
      'startsOn', v_first.starts_on,
      'periodStartsOn', v_last.starts_on,
      'endsOn', v_last.ends_on,
      'periodCount', (select count(*) from private.habit_periods pr where pr.habit_id = p_habit.id),
      'schedule', private.habit_schedule_json(private.habit_schedule_on(p_habit.id, greatest(v_today, v_last.starts_on))),
      'nextSchedule', (select private.habit_schedule_json(s) from private.habit_schedules s
        where s.habit_id = p_habit.id and s.effective_on > greatest(v_today, v_last.starts_on)
        order by s.effective_on limit 1),
      'todayState', v_state.state,
      'pausedBy', v_state.paused_by,
      'todayCheckin', case when v_checkin.id is not null then
        private.habit_checkin_json(v_checkin, p_habit, p_viewer)
          || pg_catalog.jsonb_build_object('action', private.habit_checkin_action(v_checkin, p_habit, p_viewer, v_today)) end,
      'todayBlock', private.habit_checkin_block(p_habit, v_today, v_today),
      'week', private.habit_week_json(p_habit, v_today),
      'streak', pg_catalog.jsonb_build_object('current', v_streak.current_count, 'unit', v_streak.current_unit,
        'longestOccurrences', v_streak.longest_occurrences, 'longestWeeks', v_streak.longest_weeks),
      'pause', case when v_pause.id is not null then pg_catalog.jsonb_build_object('id', v_pause.id,
        'startsOn', v_pause.starts_on, 'resumesOn', v_pause.resumes_on, 'revision', v_pause.revision) end,
      'reminders', coalesce(v_reminder.enabled, false),
      'myReminders', p_habit.owner_home_id is null or not exists (select 1 from private.habit_reminder_optouts o
        where o.habit_id = p_habit.id and o.user_id = p_viewer),
      'access', private.habit_role(p_habit, p_viewer));
  end
  $$;

-- Vacation pauses ----------------------------------------------------------------------------------------

-- The days vacations pause a habit by today's rules: a Home habit on the dates its Home's vacations
-- pause the Home (the confirmed Home-wide pause while everyone is still away, S22); a personal habit
-- during its owner's accepted participation in each vacation they switched it on for.
create function private.habit_vacation_live(p_habit private.habits) returns datemultirange
  language sql stable security definer set search_path = '' as $$
  select case when p_habit.owner_home_id is not null then (
      select coalesce(pg_catalog.range_agg(private.vacation_pause_dates(v)), '{}'::datemultirange)
      from private.home_vacations v
      where v.home_id = p_habit.owner_home_id and v.cancelled_at is null and v.home_pause_dates is not null)
    else (
      select coalesce(pg_catalog.range_agg(pg_catalog.daterange(p.starts_on, p.ends_on + 1)), '{}'::datemultirange)
      from private.habit_vacation_choices c
      join private.home_vacations v on v.id = c.vacation_id
      join private.home_vacation_participants p on p.vacation_id = v.id
      where c.habit_id = p_habit.id and p.user_id = p_habit.owner_user_id and p.status = 'accepted'
        and v.cancelled_at is null)
  end;
  $$;

-- Refreshes a habit's vacation days from today on; days before today stay as they were, so a later
-- vacation change, a departure or a new member never turns a paused past day into a missed one.
create function private.refresh_habit_vacation_days(p_habit_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit private.habits;
    v_today date;
    v_old datemultirange;
    v_new datemultirange;
  begin
    select * into v_habit from private.habits h where h.id = p_habit_id;
    if v_habit.id is null then
      return;
    end if;
    v_today := private.habit_today(v_habit);
    v_old := coalesce((select v.days from private.habit_vacation_days v where v.habit_id = p_habit_id),
      '{}'::datemultirange);
    v_new := (v_old * pg_catalog.datemultirange(pg_catalog.daterange(null, v_today)))
      + (private.habit_vacation_live(v_habit) * pg_catalog.datemultirange(pg_catalog.daterange(v_today, null)));
    if v_new = v_old then
      return;
    end if;
    insert into private.habit_vacation_days as d (habit_id, days, updated_at)
      values (p_habit_id, v_new, pg_catalog.now())
      on conflict (habit_id) do update set days = excluded.days, updated_at = excluded.updated_at;
  end
  $$;

-- Refreshes every habit a vacation change can touch: the Home's habits and the personal habits
-- switched on for that vacation (or for any vacation of the Home).
create function private.refresh_habit_vacations_for(p_home_id uuid, p_vacation_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit_id uuid;
  begin
    for v_habit_id in
      select h.id from private.habits h where h.owner_home_id = p_home_id
      union
      select c.habit_id from private.habit_vacation_choices c
      join private.home_vacations v on v.id = c.vacation_id
      where (p_vacation_id is not null and c.vacation_id = p_vacation_id)
         or (p_vacation_id is null and v.home_id = p_home_id)
    loop
      perform private.refresh_habit_vacation_days(v_habit_id);
    end loop;
  end
  $$;

create function private.habit_vacations_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_row record := case when tg_op = 'DELETE' then old else new end;
  begin
    if tg_table_name = 'home_vacations' then
      perform private.refresh_habit_vacations_for(v_row.home_id, v_row.id);
    elsif tg_table_name = 'home_vacation_participants' then
      perform private.refresh_habit_vacations_for(v_row.home_id, v_row.vacation_id);
    else
      perform private.refresh_habit_vacations_for(v_row.home_id, null);
    end if;
    return null;
  end
  $$;

create trigger home_vacations_habits after insert or update or delete on private.home_vacations
  for each row execute function private.habit_vacations_changed();
create trigger home_vacation_participants_habits after insert or update or delete on private.home_vacation_participants
  for each row execute function private.habit_vacations_changed();
create trigger home_memberships_habits after insert or delete on public.home_memberships
  for each row execute function private.habit_vacations_changed();

-- Reminders: scheduling -----------------------------------------------------------------------------------

-- The next reminder moment strictly after p_after: the habit's reminder times on its chosen weekdays,
-- in the habit's timezone (a time in a spring-forward gap moves forward by the gap; a repeated time
-- is the later one, as for task reminders), or null.
create function private.habit_reminder_next(
  p_habit private.habits, p_reminder private.habit_reminders, p_after timestamptz
) returns timestamptz
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_zone text := private.habit_zone(p_habit);
    v_day date := (p_after at time zone v_zone)::date;
    v_time time;
    v_at timestamptz;
  begin
    for i in 0 .. 8 loop
      if extract(isodow from v_day + i)::smallint = any (p_reminder.weekdays) then
        for v_time in select t from pg_catalog.unnest(p_reminder.times) t order by t loop
          v_at := ((v_day + i) + v_time) at time zone v_zone;
          if v_at > p_after then
            return v_at;
          end if;
        end loop;
      end if;
    end loop;
    return null;
  end
  $$;

create function private.habit_utc_text(p_at timestamptz) returns text
  language sql immutable set search_path = '' as $$
  select pg_catalog.to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  $$;

-- Queues the habit-reminder job for the next reminder moment after p_after, when the reminder is on
-- and the habit can still have opportunities then. Idempotent: the key names the habit, the reminder
-- revision and the moment, so the chain, the hourly top-up and a retry queue it once. A job for an
-- earlier revision finds a newer one and does nothing.
create function private.schedule_habit_reminder(p_habit_id uuid, p_after timestamptz default null) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit private.habits;
    v_reminder private.habit_reminders;
    v_last private.habit_periods;
    v_at timestamptz;
  begin
    select * into v_habit from private.habits h where h.id = p_habit_id;
    select * into v_reminder from private.habit_reminders r where r.habit_id = p_habit_id;
    if v_habit.id is null or v_habit.deleted_at is not null or v_habit.archived_at is not null
       or v_reminder.habit_id is null or not v_reminder.enabled then
      return;
    end if;
    v_last := private.habit_last_period(p_habit_id);
    v_at := private.habit_reminder_next(v_habit, v_reminder, coalesce(p_after, pg_catalog.now()));
    if v_at is null or (v_last.ends_on is not null
        and (v_at at time zone private.habit_zone(v_habit))::date > v_last.ends_on) then
      return;
    end if;
    perform private.enqueue_job('habit-reminder', 1,
      'habit-reminder:' || v_habit.id::text || ':' || v_reminder.revision::text || ':'
        || extract(epoch from v_at)::bigint::text,
      pg_catalog.jsonb_build_object('habitId', v_habit.id, 'revision', v_reminder.revision,
        'at', private.habit_utc_text(v_at)),
      null, v_at);
  end
  $$;

-- Who a habit's reminder goes to now: a personal habit's owner; for a Home habit every member who may
-- check in and has not turned that habit's reminders off for themselves.
create function private.habit_reminder_recipients(p_habit private.habits) returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select p_habit.owner_user_id where p_habit.owner_home_id is null
  union all
  select m.user_id from public.home_memberships m
  where p_habit.owner_home_id is not null and m.home_id = p_habit.owner_home_id
    and private.habit_may(p_habit, m.user_id, 'complete')
    and not exists (select 1 from private.habit_reminder_optouts o where o.habit_id = p_habit.id and o.user_id = m.user_id);
  $$;

-- Pause notices -------------------------------------------------------------------------------------------

-- Tells the members of a Home habit who opted in (category 'habits', off by default) that it was
-- paused or resumed, except whoever did it. Ids and dates only; the name is read at display time and
-- only if the reader may still see the habit.
create function private.habit_notify_pause(
  p_habit private.habits, p_kind text, p_actor uuid, p_key text, p_resumes_on date, p_automatic boolean
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid;
  begin
    if p_habit.owner_home_id is null then
      return;
    end if;
    for v_user_id in
      select m.user_id from public.home_memberships m
      where m.home_id = p_habit.owner_home_id and m.user_id is distinct from p_actor
    loop
      perform private.notify_user(v_user_id, p_habit.owner_home_id, 'habits', p_kind,
        pg_catalog.jsonb_build_object('homeId', p_habit.owner_home_id, 'habitId', p_habit.id,
          'resumesOn', p_resumes_on, 'automatic', p_automatic),
        p_key || ':' || v_user_id::text, true);
    end loop;
  end
  $$;

-- Queues the notice for the automatic end of a dated pause of a Home habit (the start of its resume
-- date in the Home's timezone).
create function private.schedule_habit_pause_end(p_habit private.habits, p_pause private.habit_pauses) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_at timestamptz;
  begin
    if p_habit.owner_home_id is null or p_pause.resumes_on is null
       or p_pause.resumes_on <= private.habit_today(p_habit) then
      return;
    end if;
    v_at := p_pause.resumes_on::timestamp at time zone private.habit_zone(p_habit);
    perform private.enqueue_job('habit-pause-end', 1,
      'habit-pause-end:' || p_pause.id::text || ':' || p_pause.resumes_on::text,
      pg_catalog.jsonb_build_object('pauseId', p_pause.id, 'resumesOn', p_pause.resumes_on),
      null, v_at);
  end
  $$;

-- Milestones ----------------------------------------------------------------------------------------------

-- Records the milestones a check-in newly reaches: in the streak that contains the check-in's
-- opportunity, each threshold not yet recorded for that streak (a milestone recorded earlier anywhere
-- in it counts, so Undo and redo, retries and merging streaks never record a threshold twice).
-- Returns the highest new one, with celebrate = the check-in is for today (not backdated) and its
-- opportunity is the one that reached it; the caller adds the person's celebration choice.
create function private.habit_record_milestones(p_habit private.habits, p_checkin private.habit_checkins, p_today date)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_unit text := coalesce(private.habit_unit_on(p_habit.id, p_checkin.on_date), 'occurrences');
    v_key date := case when v_unit = 'weeks' then private.habit_week_of(p_habit.week_start, p_checkin.on_date)
      else p_checkin.on_date end;
    v_period uuid := (private.habit_period_on(p_habit.id, p_checkin.on_date)).id;
    v_keys date[];
    v_threshold integer;
    v_reached date;
    v_best jsonb;
    v_backdated boolean := p_checkin.on_date < p_today;
  begin
    with e as (select * from private.habit_streak_elements(p_habit, p_today))
    select pg_catalog.array_agg(e.key_on order by e.seq) into v_keys
    from e where e.outcome = 'done'
      and e.grp = (select x.grp from e x where x.unit = v_unit and x.key_on = v_key
        and x.period_id = v_period and x.outcome = 'done');
    if v_keys is null then
      return null;
    end if;
    foreach v_threshold in array private.habit_milestones_list() loop
      exit when cardinality(v_keys) < v_threshold;
      v_reached := v_keys[v_threshold];
      if exists (select 1 from private.habit_milestones m
          where m.habit_id = p_habit.id and m.unit = v_unit and m.threshold = v_threshold
            and m.reached_on between v_keys[1] and v_keys[cardinality(v_keys)]) then
        continue;
      end if;
      insert into private.habit_milestones (habit_id, unit, threshold, reached_on, checkin_id, backdated)
        values (p_habit.id, v_unit, v_threshold, v_reached, p_checkin.id, v_backdated)
        on conflict on constraint habit_milestones_key do nothing;
      v_best := pg_catalog.jsonb_build_object('threshold', v_threshold, 'unit', v_unit, 'reachedOn', v_reached,
        'celebrate', not v_backdated and v_reached = v_key);
    end loop;
    return v_best;
  end
  $$;

-- Reading -------------------------------------------------------------------------------------------------

-- The habits of a context (the caller's Personal space, or a Home they are in): 'active' (active,
-- paused and not yet started), 'ended' or 'archived', optionally matching a search, by name; with the
-- counts of the other sections, the caller's access and settings. 42501 for a Home the caller is not
-- in; 22023 for an unknown view.
create function public.get_habits(p_home_id uuid default null, p_view text default 'active', p_query text default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_rows jsonb;
    v_query text := nullif(pg_catalog.btrim(p_query), '');
  begin
    perform private.require_habit_context(p_home_id, v_user_id);
    if p_view is null or p_view not in ('active', 'ended', 'archived')
       or (v_query is not null and char_length(v_query) > private.habit_limit('query')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    with h as (
      select x.*, private.habit_status(x, private.habit_today(x)) as status
      from private.habits x
      where x.deleted_at is null
        and ((p_home_id is null and x.owner_home_id is null and x.owner_user_id = v_user_id)
          or (p_home_id is not null and x.owner_home_id = p_home_id))
    )
    select pg_catalog.jsonb_build_object(
      'habits', coalesce((
        select pg_catalog.jsonb_agg(private.habit_summary_json(
            (select y from private.habits y where y.id = h.id), v_user_id) order by pg_catalog.lower(h.name), h.id)
        from h
        where case p_view when 'archived' then h.status = 'archived' when 'ended' then h.status = 'ended'
            else h.status not in ('archived', 'ended') end
          and (v_query is null or pg_catalog.strpos(pg_catalog.lower(h.name), pg_catalog.lower(v_query)) > 0)),
        '[]'::jsonb),
      'counts', pg_catalog.jsonb_build_object(
        'active', (select count(*) from h where h.status not in ('archived', 'ended')),
        'ended', (select count(*) from h where h.status = 'ended'),
        'archived', (select count(*) from h where h.status = 'archived')))
    into v_rows;
    return v_rows || pg_catalog.jsonb_build_object(
      'access', private.habit_access(p_home_id, v_user_id),
      'memberAccess', case when p_home_id is not null then coalesce(
        (select s.member_access from private.habit_settings s where s.home_id = p_home_id), 'complete') end,
      'celebrations', coalesce((select s.celebrations from private.habit_user_settings s where s.user_id = v_user_id), true),
      'timeZone', case when p_home_id is not null then (select h.timezone from public.homes h where h.id = p_home_id) end);
  end
  $$;

-- One habit with everything its page shows, or null when the caller may not see it: the summary,
-- tracking periods, schedule versions, manual pauses, vacation-paused days, the last eight days with
-- their check-ins and whether each can take a new one, the weeks those days touch, milestones and the
-- reminder.
create function public.get_habit(p_habit_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_today date;
    v_reminder private.habit_reminders;
  begin
    if v_habit.id is null then
      return null;
    end if;
    v_today := private.habit_today(v_habit);
    select * into v_reminder from private.habit_reminders r where r.habit_id = v_habit.id;
    return private.habit_summary_json(v_habit, v_user_id) || pg_catalog.jsonb_build_object(
      'periods', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', pr.id, 'startsOn', pr.starts_on,
          'endsOn', pr.ends_on) order by pr.starts_on)
        from private.habit_periods pr where pr.habit_id = v_habit.id),
      'schedules', (select pg_catalog.jsonb_agg(private.habit_schedule_json(s) order by s.effective_on)
        from private.habit_schedules s where s.habit_id = v_habit.id),
      'pauses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', hp.id,
          'startsOn', hp.starts_on, 'resumesOn', hp.resumes_on, 'revision', hp.revision,
          'current', hp.resumes_on is null or hp.resumes_on > v_today) order by hp.starts_on desc)
        from private.habit_pauses hp where hp.habit_id = v_habit.id and hp.resumes_on is distinct from hp.starts_on),
        '[]'::jsonb),
      'vacationDays', private.habit_ranges_json(
        (select v.days from private.habit_vacation_days v where v.habit_id = v_habit.id)),
      'recent', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'onDate', s.on_date, 'state', s.state, 'kind', s.kind, 'pausedBy', s.paused_by,
          'block', private.habit_checkin_block(v_habit, s.on_date, v_today),
          'checkin', case when c.id is not null then private.habit_checkin_json(c, v_habit, v_user_id)
            || pg_catalog.jsonb_build_object('action', private.habit_checkin_action(c, v_habit, v_user_id, v_today)) end)
          order by s.on_date desc)
        from private.habit_day_states(v_habit, v_today - private.habit_limit('backdate_days'), v_today, v_today) s
        left join private.habit_checkins c on c.id = s.checkin_id),
      'weeks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('weekOn', w.week_on,
          'firstOn', w.first_on, 'lastOn', w.last_on, 'completions', w.completions, 'target', w.weekly_target,
          'adjusted', w.adjusted, 'outcome', w.outcome) order by w.week_on desc, w.first_on desc)
        from private.habit_weeks(v_habit, v_today - private.habit_limit('backdate_days'), v_today, v_today) w),
        '[]'::jsonb),
      'milestones', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('unit', m.unit,
          'threshold', m.threshold, 'reachedOn', m.reached_on, 'recordedAt', m.recorded_at,
          'backdated', m.backdated) order by m.reached_on desc, m.threshold desc)
        from private.habit_milestones m where m.habit_id = v_habit.id), '[]'::jsonb),
      'reminder', case when v_reminder.habit_id is not null then pg_catalog.jsonb_build_object(
        'enabled', v_reminder.enabled, 'times', (select pg_catalog.jsonb_agg(pg_catalog.to_char(t, 'HH24:MI') order by t)
          from pg_catalog.unnest(v_reminder.times) t),
        'weekdays', pg_catalog.to_jsonb(v_reminder.weekdays), 'revision', v_reminder.revision) end,
      'celebrations', coalesce((select s.celebrations from private.habit_user_settings s where s.user_id = v_user_id), true));
  end
  $$;

-- A page of a habit's check-ins (active and undone), newest date first, after the check-in p_before
-- of the previous page (null: from the newest; the full sort key, so rows sharing a date are never
-- skipped), with what the caller may do with each. Null when the caller may not see the habit.
create function public.get_habit_checkins(p_habit_id uuid, p_before uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_today date;
  begin
    if v_habit.id is null then
      return null;
    end if;
    v_today := private.habit_today(v_habit);
    return coalesce((
      select pg_catalog.jsonb_agg(private.habit_checkin_json(c, v_habit, v_user_id)
          || pg_catalog.jsonb_build_object('action', private.habit_checkin_action(c, v_habit, v_user_id, v_today))
        order by c.on_date desc, c.recorded_at desc, c.id desc)
      from (
        select x.* from private.habit_checkins x
        where x.habit_id = v_habit.id and (p_before is null or (x.on_date, x.recorded_at, x.id) <
          (select b.on_date, b.recorded_at, b.id from private.habit_checkins b
            where b.id = p_before and b.habit_id = v_habit.id))
        order by x.on_date desc, x.recorded_at desc, x.id desc
        limit private.habit_limit('page')
      ) c), '[]'::jsonb);
  end
  $$;

-- A page of a habit's history, newest first, after the event p_before of the previous page (null:
-- from the newest; events of one change share a moment, so the id breaks ties). Null when the caller
-- may not see the habit.
create function public.get_habit_events(p_habit_id uuid, p_before uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
  begin
    if v_habit.id is null then
      return null;
    end if;
    return coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', e.id, 'kind', e.kind,
          'by', private.habit_person(v_habit, e.actor), 'mine', coalesce(e.actor = v_user_id, false),
          'at', e.at, 'onDate', e.on_date, 'checkinId', e.checkin_id, 'details', e.details)
        order by e.at desc, e.id desc)
      from (
        select x.* from private.habit_events x
        where x.habit_id = v_habit.id and (p_before is null or (x.at, x.id) <
          (select b.at, b.id from private.habit_events b where b.id = p_before and b.habit_id = v_habit.id))
        order by x.at desc, x.id desc
        limit private.habit_limit('page')
      ) e), '[]'::jsonb);
  end
  $$;

-- Insights for the last p_days days (7, 30, 90 or 365) up to today: completion rate (done eligible
-- opportunities over eligible ones: missed and done occurrences, and decided weeks; paused,
-- unscheduled, untracked and not-yet-decided ones are left out), current and longest streaks, a
-- 12-week trend, each tracking period's own totals, and the schedule versions and paused days inside
-- the range. Null when the caller may not see the habit; 22023 for another range.
create function public.get_habit_insights(p_habit_id uuid, p_days integer) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_today date;
    v_from date;
    v_week date;
    v_streak record;
    v_result jsonb;
  begin
    if p_days is null or p_days not in (7, 30, 90, 365) then
      raise exception 'invalid range' using errcode = '22023';
    end if;
    if v_habit.id is null then
      return null;
    end if;
    v_today := private.habit_today(v_habit);
    v_from := v_today - p_days + 1;
    v_week := private.habit_week_of(v_habit.week_start, v_today);
    select * into v_streak from private.habit_streak(v_habit, v_today);
    with e as (
      select x.*, case when x.unit = 'weeks' then x.key_on + 6 else x.key_on end as last_on
      from private.habit_streak_elements(v_habit, v_today) x
      where x.outcome in ('done', 'missed')
    )
    select pg_catalog.jsonb_build_object(
      'days', p_days, 'from', v_from, 'to', v_today,
      'completed', (select count(*) from e where e.outcome = 'done' and e.last_on >= v_from and e.key_on <= v_today),
      'eligible', (select count(*) from e where e.last_on >= v_from and e.key_on <= v_today),
      'trend', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('weekOn', w,
            'completed', (select count(*) from e where e.outcome = 'done' and e.key_on between w and w + 6),
            'eligible', (select count(*) from e where e.key_on between w and w + 6))
          order by w)
        from pg_catalog.generate_series((v_week - 77)::timestamp, v_week::timestamp, interval '7 days') g (d),
          lateral (select g.d::date as w) x),
      'periods', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('startsOn', pr.starts_on,
            'endsOn', pr.ends_on,
            'completed', (select count(*) from e where e.period_id = pr.id and e.outcome = 'done'),
            'eligible', (select count(*) from e where e.period_id = pr.id))
          order by pr.starts_on)
        from private.habit_periods pr where pr.habit_id = v_habit.id))
    into v_result;
    return v_result || pg_catalog.jsonb_build_object(
      'habit', private.habit_summary_json(v_habit, v_user_id),
      'streak', pg_catalog.jsonb_build_object('current', v_streak.current_count, 'unit', v_streak.current_unit,
        'longestOccurrences', v_streak.longest_occurrences, 'longestWeeks', v_streak.longest_weeks),
      'scheduleChanges', coalesce((select pg_catalog.jsonb_agg(private.habit_schedule_json(s) order by s.effective_on)
        from private.habit_schedules s where s.habit_id = v_habit.id and s.effective_on between v_from + 1 and v_today),
        '[]'::jsonb),
      'pausedDays', (select count(*) from private.habit_day_states(v_habit, v_from, v_today, v_today) s
        where s.state = 'paused'));
  end
  $$;

-- A month of a habit: every day's state, and for weekly schedules each week's outcome. Null when the
-- caller may not see the habit; 22023 for a date outside 2000-2100.
create function public.get_habit_calendar(p_habit_id uuid, p_month date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_first date := pg_catalog.date_trunc('month', p_month)::date;
    v_last date := (pg_catalog.date_trunc('month', p_month) + interval '1 month - 1 day')::date;
    v_today date;
  begin
    if p_month is null or p_month not between '2000-01-01' and '2100-12-31' then
      raise exception 'invalid month' using errcode = '22023';
    end if;
    if v_habit.id is null then
      return null;
    end if;
    v_today := private.habit_today(v_habit);
    return pg_catalog.jsonb_build_object(
      'month', v_first, 'today', v_today, 'weekStart', v_habit.week_start,
      'days', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('onDate', s.on_date, 'state', s.state,
          'kind', s.kind, 'pausedBy', s.paused_by) order by s.on_date)
        from private.habit_day_states(v_habit, v_first, v_last, v_today) s),
      'weeks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('weekOn', w.week_on,
          'firstOn', w.first_on, 'lastOn', w.last_on, 'completions', w.completions, 'target', w.weekly_target,
          'adjusted', w.adjusted, 'outcome', w.outcome) order by w.week_on, w.first_on)
        from private.habit_weeks(v_habit, v_first, v_last, v_today) w), '[]'::jsonb));
  end
  $$;

-- The names of habits a notification names, for the caller, only where they may still see the habit.
create function public.habit_notice_names(p_habit_ids uuid[])
returns table (habit_id uuid, name text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_habit_ids is null or cardinality(p_habit_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    return query
      select h.id, h.name from private.habits h
      where h.id = any (p_habit_ids) and h.deleted_at is null and private.habit_may(h, v_user_id, 'view');
  end
  $$;

-- Habits: creating and changing ------------------------------------------------------------------------

-- Creates a habit (a personal habit; a Home habit: habit managers) with its first tracking period and
-- schedule. p_time_zone: a personal habit's timezone (the app passes the person's effective one);
-- ignored for a Home habit. p_week_start: monday, saturday or sunday. Outcomes: 'created', 'exists'
-- (a retry of the caller's own create), 'id_taken', 'invalid_dates' (start more than seven days ago
-- or more than a year ahead; end before start), 'too_many', 'not_permitted'. 42501 for a Home the
-- caller is not in; 22023 for invalid fields.
create function public.create_habit(
  p_id uuid, p_home_id uuid default null, p_name text default null, p_description text default null,
  p_kind text default null, p_weekdays smallint[] default null, p_target smallint default null,
  p_starts_on date default null, p_ends_on date default null, p_time_zone text default null,
  p_week_start text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.habits;
    v_habit private.habits;
    v_zone text;
    v_today date;
  begin
    perform private.require_habit_context(p_home_id, v_user_id);
    if p_id is null or p_name is null or not private.is_visible_name(p_name, private.habit_limit('name'))
       or (p_description is not null and not private.is_plain_text(p_description, private.habit_limit('description')))
       or not private.valid_habit_schedule(p_kind, p_weekdays, p_target)
       or p_starts_on is null or p_week_start is null or p_week_start not in ('monday', 'saturday', 'sunday')
       or (p_home_id is null and not private.valid_time_zone(p_time_zone)) then
      raise exception 'invalid habit' using errcode = '22023';
    end if;
    if private.habit_access(p_home_id, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_existing from private.habits h where h.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by = v_user_id and v_existing.owner_home_id is not distinct from p_home_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    v_zone := case when p_home_id is null then p_time_zone
      else (select h.timezone from public.homes h where h.id = p_home_id) end;
    v_today := (pg_catalog.now() at time zone v_zone)::date;
    if p_starts_on < v_today - private.habit_limit('start_past_days')
       or p_starts_on > v_today + private.habit_limit('start_future_days')
       or (p_ends_on is not null and p_ends_on < p_starts_on) then
      return query select 'invalid_dates', null::integer;
      return;
    end if;
    -- Counted under the context lock, so two creates cannot both pass the limit.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('habits:' || coalesce(p_home_id, v_user_id)::text, 0));
    if (select count(*) from private.habits h
        where h.deleted_at is null and h.archived_at is null
          and ((p_home_id is null and h.owner_home_id is null and h.owner_user_id = v_user_id)
            or (p_home_id is not null and h.owner_home_id = p_home_id))) >= private.habit_limit('habits') then
      return query select 'too_many', null::integer;
      return;
    end if;
    insert into private.habits (id, owner_user_id, owner_home_id, name, description, time_zone, week_start,
        created_by, updated_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_name, p_description,
        case when p_home_id is null then p_time_zone end, p_week_start, v_user_id, v_user_id)
      returning * into v_habit;
    insert into private.habit_periods (habit_id, starts_on, ends_on, created_by)
      values (v_habit.id, p_starts_on, p_ends_on, v_user_id);
    insert into private.habit_schedules (habit_id, effective_on, kind, weekdays, weekly_target, created_by)
      values (v_habit.id, p_starts_on, p_kind, p_weekdays, p_target, v_user_id);
    perform private.refresh_habit_vacation_days(v_habit.id);
    perform private.habit_event(v_habit.id, 'created', v_user_id, p_starts_on);
    perform private.audit_habit('habit.created', v_habit);
    return query select 'created', v_habit.revision;
  end
  $$;

-- Edits a habit's name, description and (personal habits) timezone, from the revision the caller saw
-- (habit managers). A new timezone applies from now on: dates already recorded never move.
-- Outcomes: 'saved', 'unchanged', 'conflict', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.update_habit(
  p_id uuid, p_expected_revision integer, p_name text, p_description text default null,
  p_time_zone text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_zone_changed boolean;
  begin
    if p_id is null or p_expected_revision is null or p_name is null
       or not private.is_visible_name(p_name, private.habit_limit('name'))
       or (p_description is not null and not private.is_plain_text(p_description, private.habit_limit('description'))) then
      raise exception 'invalid habit' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_habit.owner_home_id is null and not private.valid_time_zone(p_time_zone) then
      raise exception 'invalid habit' using errcode = '22023';
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', v_habit.revision;
      return;
    end if;
    v_zone_changed := v_habit.owner_home_id is null and p_time_zone <> v_habit.time_zone;
    if p_name = v_habit.name and p_description is not distinct from v_habit.description and not v_zone_changed then
      return query select 'unchanged', v_habit.revision;
      return;
    end if;
    update private.habits h set name = p_name, description = p_description,
        time_zone = case when h.owner_home_id is null then p_time_zone end,
        revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    if v_zone_changed then
      -- Reminder moments move with the zone: a new reminder revision retires the queued ones.
      update private.habit_reminders r set revision = r.revision + 1 where r.habit_id = v_habit.id;
      perform private.schedule_habit_reminder(v_habit.id);
      perform private.refresh_habit_vacation_days(v_habit.id);
    end if;
    perform private.habit_event(v_habit.id, 'edited', v_user_id, null, null,
      pg_catalog.jsonb_build_object('timeZone', v_zone_changed));
    perform private.audit_habit('habit.updated', v_habit);
    return query select 'saved', v_habit.revision;
  end
  $$;

-- The earliest date a schedule change can take effect: tomorrow; when the schedule in effect then or
-- the new one is weekly, the start of the next habit week (a running week keeps one target).
create function private.habit_earliest_change(p_habit private.habits, p_today date, p_new_kind text)
returns date
  language sql stable security definer set search_path = '' as $$
  select case
    when p_new_kind = 'weekly' or (private.habit_schedule_on(p_habit.id, p_today + 1)).kind = 'weekly'
      then private.habit_week_of(p_habit.week_start, p_today) + 7
    else p_today + 1
  end;
  $$;

-- The next scheduled dates of a schedule from a date (at most five), with whether each is paused.
create function private.habit_preview_dates(
  p_habit private.habits, p_kind text, p_weekdays smallint[], p_from date, p_until date
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('onDate', x.d,
      'paused', y.manual_paused or y.vacation_paused) order by x.d), '[]'::jsonb)
  from (
    select g.d::date as d from pg_catalog.generate_series(p_from::timestamp,
      least(coalesce(p_until, p_from + 60), p_from + 60)::timestamp, interval '1 day') g (d)
    where p_kind = 'daily' or (p_kind = 'weekdays' and extract(isodow from g.d)::smallint = any (p_weekdays))
    order by g.d limit 5
  ) x
  cross join lateral private.habit_days(p_habit.id, x.d, x.d) y;
  $$;

-- Changes the schedule from a date on (habit managers), never before: the earliest is tomorrow, or
-- the next habit week's start when a weekly schedule is involved. Versions that had not taken effect
-- yet from that date on are replaced; history keeps the schedule that applied to it. p_dry_run
-- returns the preview: old and new schedule, the earliest date, the next opportunities, the current
-- streak, pauses ahead and whether the reminder's days still meet scheduled days. Outcomes:
-- 'preview', 'saved', 'unchanged', 'invalid_date', 'ended', 'archived', 'conflict', 'not_found',
-- 'not_permitted'. 22023 for an invalid schedule.
create function public.change_habit_schedule(
  p_id uuid, p_expected_revision integer, p_kind text, p_weekdays smallint[] default null,
  p_target smallint default null, p_effective_on date default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_today date;
    v_earliest date;
    v_old private.habit_schedules;
    v_last private.habit_periods;
    v_status text;
    v_reminder private.habit_reminders;
    v_impact jsonb;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null
       or not private.valid_habit_schedule(p_kind, p_weekdays, p_target) then
      raise exception 'invalid schedule' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    v_today := private.habit_today(v_habit);
    v_status := private.habit_status(v_habit, v_today);
    if v_status in ('archived', 'ended') then
      return query select v_status, null::jsonb, v_habit.revision;
      return;
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_habit.revision;
      return;
    end if;
    v_last := private.habit_last_period(v_habit.id);
    v_earliest := greatest(private.habit_earliest_change(v_habit, v_today, p_kind), v_last.starts_on);
    v_old := private.habit_schedule_on(v_habit.id, coalesce(p_effective_on, v_earliest));
    select * into v_reminder from private.habit_reminders r where r.habit_id = v_habit.id;
    v_impact := pg_catalog.jsonb_build_object(
      'old', private.habit_schedule_json(v_old),
      'new', pg_catalog.jsonb_build_object('kind', p_kind, 'weekdays', coalesce(pg_catalog.to_jsonb(p_weekdays), '[]'::jsonb),
        'target', p_target, 'effectiveOn', p_effective_on),
      'earliest', v_earliest,
      'weekBoundary', p_kind = 'weekly' or v_old.kind = 'weekly',
      'nextDates', case when p_effective_on is not null and p_kind <> 'weekly'
        then private.habit_preview_dates(v_habit, p_kind, p_weekdays, p_effective_on, v_last.ends_on) end,
      'currentStreak', (select pg_catalog.jsonb_build_object('current', s.current_count, 'unit', s.current_unit)
        from private.habit_streak(v_habit, v_today) s),
      'unitChanges', (v_old.kind = 'weekly') <> (p_kind = 'weekly'),
      'pauses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('startsOn', hp.starts_on,
          'resumesOn', hp.resumes_on) order by hp.starts_on)
        from private.habit_pauses hp where hp.habit_id = v_habit.id
          and (hp.resumes_on is null or hp.resumes_on > coalesce(p_effective_on, v_earliest))
          and hp.resumes_on is distinct from hp.starts_on), '[]'::jsonb),
      'vacationDays', private.habit_ranges_json((select v.days from private.habit_vacation_days v
        where v.habit_id = v_habit.id) * pg_catalog.datemultirange(
          pg_catalog.daterange(coalesce(p_effective_on, v_earliest), null))),
      'reminder', case when v_reminder.enabled then pg_catalog.jsonb_build_object('enabled', true,
        'meetsSchedule', p_kind <> 'weekdays' or v_reminder.weekdays && p_weekdays) end);
    if p_effective_on is null or p_effective_on < v_earliest
       or (v_impact ->> 'weekBoundary')::boolean
         and p_effective_on <> private.habit_week_of(v_habit.week_start, p_effective_on)
       or (v_last.ends_on is not null and p_effective_on > v_last.ends_on) then
      return query select 'invalid_date', v_impact, v_habit.revision;
      return;
    end if;
    if v_old.kind = p_kind and v_old.weekdays is not distinct from p_weekdays
       and v_old.weekly_target is not distinct from p_target
       and not exists (select 1 from private.habit_schedules s
         where s.habit_id = v_habit.id and s.effective_on > p_effective_on) then
      return query select 'unchanged', v_impact, v_habit.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_impact, v_habit.revision;
      return;
    end if;
    delete from private.habit_schedules s where s.habit_id = v_habit.id and s.effective_on >= p_effective_on;
    insert into private.habit_schedules (habit_id, effective_on, kind, weekdays, weekly_target, created_by)
      values (v_habit.id, p_effective_on, p_kind, p_weekdays, p_target, v_user_id);
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    perform private.habit_event(v_habit.id, 'schedule_changed', v_user_id, p_effective_on, null,
      pg_catalog.jsonb_build_object('from', v_old.kind, 'to', p_kind));
    perform private.audit_habit('habit.schedule_changed', v_habit,
      pg_catalog.jsonb_build_object('effectiveOn', p_effective_on));
    return query select 'saved', v_impact, v_habit.revision;
  end
  $$;

-- Sets, changes or clears the end date of the current tracking period (habit managers). Not before
-- the period's start; an end before today needs the preview (it ends the habit at once) and is
-- refused while check-ins lie after it ('checkins_after_end', with their count). An ended habit
-- continues only through reactivation ('ended'). p_dry_run returns the preview: the end, the last
-- scheduled day on or before it and whether it is in the past. Outcomes: 'preview', 'saved',
-- 'unchanged', 'invalid_dates', 'checkins_after_end', 'ended', 'archived', 'conflict', 'not_found',
-- 'not_permitted'.
create function public.set_habit_end(
  p_id uuid, p_expected_revision integer, p_ends_on date default null, p_dry_run boolean default false
)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_today date;
    v_status text;
    v_last private.habit_periods;
    v_after integer;
    v_impact jsonb;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    v_today := private.habit_today(v_habit);
    v_status := private.habit_status(v_habit, v_today);
    if v_status in ('archived', 'ended') then
      return query select v_status, null::jsonb, v_habit.revision;
      return;
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_habit.revision;
      return;
    end if;
    v_last := private.habit_last_period(v_habit.id);
    if p_ends_on is not null and p_ends_on < v_last.starts_on then
      return query select 'invalid_dates', null::jsonb, v_habit.revision;
      return;
    end if;
    select count(*) into v_after from private.habit_checkins c
      where c.habit_id = v_habit.id and c.status = 'active' and c.on_date >= v_last.starts_on
        and p_ends_on is not null and c.on_date > p_ends_on;
    v_impact := pg_catalog.jsonb_build_object(
      'endsOn', p_ends_on, 'previousEndsOn', v_last.ends_on, 'startsOn', v_last.starts_on,
      'inPast', p_ends_on is not null and p_ends_on < v_today,
      'checkinsAfter', v_after,
      'lastScheduled', case when p_ends_on is not null then (select max(x.on_date)
        from private.habit_days(v_habit.id, greatest(v_last.starts_on, p_ends_on - 31), p_ends_on) x
        where x.scheduled) end);
    if v_after > 0 then
      return query select 'checkins_after_end', v_impact, v_habit.revision;
      return;
    end if;
    if p_ends_on is not distinct from v_last.ends_on then
      return query select 'unchanged', v_impact, v_habit.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_impact, v_habit.revision;
      return;
    end if;
    update private.habit_periods pr set ends_on = p_ends_on where pr.id = v_last.id;
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    perform private.schedule_habit_reminder(v_habit.id);
    perform private.habit_event(v_habit.id, 'end_changed', v_user_id, p_ends_on, null,
      pg_catalog.jsonb_build_object('from', v_last.ends_on, 'to', p_ends_on));
    perform private.audit_habit('habit.end_changed', v_habit, pg_catalog.jsonb_build_object('endsOn', p_ends_on));
    return query select 'saved', v_impact, v_habit.revision;
  end
  $$;

-- Reactivates an Ended habit (habit managers): a new tracking period from p_starts_on (today or later)
-- with an optional end (not before its start), a schedule from that day, and the reviewed reminder:
-- 'keep' (the previous one as it was: on stays on only if its days still meet the schedule, off stays
-- off), 'change' (new times and days, on) or 'off'. The gap is never filled and the new period's
-- streak starts at zero. p_dry_run returns the preview (dates, schedule, the previous reminder and
-- whether it still fits, pauses that will still apply). Outcomes: 'preview', 'reactivated',
-- 'not_ended', 'invalid_dates', 'invalid_reminder' (keep chosen for a reminder whose days miss the
-- new schedule), 'archived', 'conflict', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.reactivate_habit(
  p_id uuid, p_expected_revision integer, p_starts_on date default null, p_ends_on date default null,
  p_kind text default null, p_weekdays smallint[] default null, p_target smallint default null,
  p_reminder text default null, p_reminder_times time[] default null,
  p_reminder_weekdays smallint[] default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_today date;
    v_status text;
    v_last private.habit_periods;
    v_reminder private.habit_reminders;
    v_fits boolean;
    v_impact jsonb;
    v_current private.habit_schedules;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null or p_starts_on is null
       or not private.valid_habit_schedule(p_kind, p_weekdays, p_target)
       or p_reminder is null or p_reminder not in ('keep', 'change', 'off')
       or (p_reminder = 'change' and not private.valid_habit_reminder(p_reminder_times, p_reminder_weekdays)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    v_today := private.habit_today(v_habit);
    v_status := private.habit_status(v_habit, v_today);
    if v_status = 'archived' then
      return query select 'archived', null::jsonb, v_habit.revision;
      return;
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_habit.revision;
      return;
    end if;
    if v_status <> 'ended' then
      return query select 'not_ended', null::jsonb, v_habit.revision;
      return;
    end if;
    v_last := private.habit_last_period(v_habit.id);
    select * into v_reminder from private.habit_reminders r where r.habit_id = v_habit.id;
    v_fits := v_reminder.habit_id is null or p_kind <> 'weekdays' or v_reminder.weekdays && p_weekdays;
    v_impact := pg_catalog.jsonb_build_object(
      'startsOn', p_starts_on, 'endsOn', p_ends_on, 'previousEndsOn', v_last.ends_on, 'today', v_today,
      'schedule', pg_catalog.jsonb_build_object('kind', p_kind, 'weekdays', coalesce(pg_catalog.to_jsonb(p_weekdays), '[]'::jsonb),
        'target', p_target),
      'previousReminder', case when v_reminder.habit_id is not null then pg_catalog.jsonb_build_object(
        'enabled', v_reminder.enabled, 'times', (select pg_catalog.jsonb_agg(pg_catalog.to_char(t, 'HH24:MI') order by t)
          from pg_catalog.unnest(v_reminder.times) t),
        'weekdays', pg_catalog.to_jsonb(v_reminder.weekdays), 'fitsSchedule', v_fits) end,
      'pauses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('startsOn', hp.starts_on,
          'resumesOn', hp.resumes_on) order by hp.starts_on)
        from private.habit_pauses hp where hp.habit_id = v_habit.id
          and (hp.resumes_on is null or hp.resumes_on > p_starts_on) and hp.resumes_on is distinct from hp.starts_on),
        '[]'::jsonb),
      'nextDates', case when p_kind <> 'weekly'
        then private.habit_preview_dates(v_habit, p_kind, p_weekdays, p_starts_on, p_ends_on) end,
      'longest', (select pg_catalog.jsonb_build_object('occurrences', s.longest_occurrences, 'weeks', s.longest_weeks)
        from private.habit_streak(v_habit, v_today) s));
    if p_starts_on < v_today or p_starts_on > v_today + private.habit_limit('start_future_days')
       or p_starts_on <= v_last.ends_on or (p_ends_on is not null and p_ends_on < p_starts_on) then
      return query select 'invalid_dates', v_impact, v_habit.revision;
      return;
    end if;
    if p_reminder = 'keep' and v_reminder.enabled and not v_fits
       or p_reminder = 'change' and p_kind = 'weekdays' and not (p_reminder_weekdays && p_weekdays) then
      return query select 'invalid_reminder', v_impact, v_habit.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_impact, v_habit.revision;
      return;
    end if;
    insert into private.habit_periods (habit_id, starts_on, ends_on, created_by)
      values (v_habit.id, p_starts_on, p_ends_on, v_user_id);
    v_current := private.habit_schedule_on(v_habit.id, p_starts_on);
    if v_current.kind is distinct from p_kind or v_current.weekdays is distinct from p_weekdays
       or v_current.weekly_target is distinct from p_target or exists (select 1 from private.habit_schedules s
         where s.habit_id = v_habit.id and s.effective_on > p_starts_on) then
      delete from private.habit_schedules s where s.habit_id = v_habit.id and s.effective_on >= p_starts_on;
      insert into private.habit_schedules (habit_id, effective_on, kind, weekdays, weekly_target, created_by)
        values (v_habit.id, p_starts_on, p_kind, p_weekdays, p_target, v_user_id);
    end if;
    if p_reminder = 'change' then
      insert into private.habit_reminders as r (habit_id, enabled, times, weekdays, updated_by)
        values (v_habit.id, true, p_reminder_times, p_reminder_weekdays, v_user_id)
        on conflict (habit_id) do update set enabled = true, times = excluded.times, weekdays = excluded.weekdays,
          revision = r.revision + 1, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    elsif v_reminder.habit_id is not null then
      update private.habit_reminders r
        set enabled = (p_reminder = 'keep' and r.enabled), revision = r.revision + 1,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where r.habit_id = v_habit.id;
    end if;
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    perform private.refresh_habit_vacation_days(v_habit.id);
    perform private.schedule_habit_reminder(v_habit.id);
    perform private.habit_event(v_habit.id, 'reactivated', v_user_id, p_starts_on, null,
      pg_catalog.jsonb_build_object('endsOn', p_ends_on, 'reminder', p_reminder));
    perform private.audit_habit('habit.reactivated', v_habit, pg_catalog.jsonb_build_object('startsOn', p_starts_on));
    return query select 'reactivated', v_impact, v_habit.revision;
  end
  $$;

-- Archives or unarchives a habit (habit managers): hidden from lists, widgets and reminders, nothing
-- erased. Outcomes: 'saved', 'unchanged', 'conflict', 'too_many' (unarchiving past the limit),
-- 'not_found', 'not_permitted'.
create function public.archive_habit(p_id uuid, p_expected_revision integer, p_archived boolean)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
  begin
    if p_id is null or p_expected_revision is null or p_archived is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', v_habit.revision;
      return;
    end if;
    if (v_habit.archived_at is not null) = p_archived then
      return query select 'unchanged', v_habit.revision;
      return;
    end if;
    if not p_archived then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'habits:' || coalesce(v_habit.owner_home_id, v_habit.owner_user_id)::text, 0));
      if (select count(*) from private.habits h
          where h.deleted_at is null and h.archived_at is null
            and h.owner_user_id is not distinct from v_habit.owner_user_id
            and h.owner_home_id is not distinct from v_habit.owner_home_id) >= private.habit_limit('habits') then
        return query select 'too_many', v_habit.revision;
        return;
      end if;
    end if;
    update private.habits h
      set archived_at = case when p_archived then pg_catalog.now() end,
        archived_by = case when p_archived then v_user_id end,
        revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    if not p_archived then
      perform private.schedule_habit_reminder(v_habit.id);
    end if;
    perform private.habit_event(v_habit.id, case when p_archived then 'archived' else 'unarchived' end, v_user_id);
    perform private.audit_habit(case when p_archived then 'habit.archived' else 'habit.unarchived' end, v_habit);
    return query select 'saved', v_habit.revision;
  end
  $$;

-- Moves a habit to the trash (habit managers), from the revision the caller saw. Outcomes: 'deleted'
-- (with the trash entry), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_habit(p_id uuid, p_expected_revision integer)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    update private.habits h set deleted_at = pg_catalog.now(), updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id;
    update private.habit_reminder_snoozes s set status = 'cancelled' where s.habit_id = v_habit.id and s.status = 'pending';
    perform private.audit_habit('habit.deleted', v_habit);
    return query select 'deleted', private.trash_move(v_user_id, 'habits', 'habit', v_habit.id,
      v_habit.owner_user_id, v_habit.owner_home_id, v_habit.name);
  end
  $$;

-- Check-ins ---------------------------------------------------------------------------------------------

-- Records that the habit was done on p_on (people who may check in): today or up to seven days back,
-- a scheduled, unpaused day of a tracking period, not yet completed, and for a weekly schedule only
-- while that week's target is not reached. Under the habit lock, so two members completing the same
-- day get one 'completed' and one 'already_completed' naming who did it. p_checkin_id is the caller's
-- client id: a retry answers 'exists'. The answer carries the habit as it is now, the streak before and
-- after (a backdated check-in can restore one), and a newly reached milestone (celebrate: not
-- backdated, the person has celebrations on). Outcomes: 'completed', 'exists', 'id_taken',
-- 'already_completed', 'target_reached', 'not_scheduled', 'paused', 'untracked', 'outside_window',
-- 'future', 'archived', 'not_found', 'not_permitted'. 22023 for invalid fields. No date: the habit's today.
create function public.complete_habit(
  p_checkin_id uuid, p_habit_id uuid, p_on date default null, p_note text default null,
  p_source text default 'app'
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_existing private.habit_checkins;
    v_checkin private.habit_checkins;
    v_today date;
    v_block text;
    v_before integer;
    v_milestone jsonb;
  begin
    if p_checkin_id is null or p_habit_id is null or p_source is null
       or p_source not in ('app', 'widget', 'notification')
       or (p_note is not null and not private.is_plain_text(p_note, private.habit_limit('note'))) then
      raise exception 'invalid check-in' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_habit_id, v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    -- No date: the habit's today (a weekly reminder's Complete).
    p_on := coalesce(p_on, private.habit_today(v_habit));
    select * into v_existing from private.habit_checkins c where c.id = p_checkin_id;
    if v_existing.id is not null then
      if v_existing.habit_id = v_habit.id and v_existing.completed_by = v_user_id and v_existing.on_date = p_on then
        return pg_catalog.jsonb_build_object('outcome', 'exists',
          'checkin', private.habit_checkin_json(v_existing, v_habit, v_user_id),
          'habit', private.habit_summary_json(v_habit, v_user_id));
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    if not private.habit_may(v_habit, v_user_id, 'complete') then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_today := private.habit_today(v_habit);
    v_block := private.habit_checkin_block(v_habit, p_on, v_today);
    if v_block = 'already_completed' then
      select * into v_existing from private.habit_checkins c
        where c.habit_id = v_habit.id and c.on_date = p_on and c.status = 'active';
      return pg_catalog.jsonb_build_object('outcome', v_block,
        'checkin', private.habit_checkin_json(v_existing, v_habit, v_user_id),
        'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    if v_block is not null then
      return pg_catalog.jsonb_build_object('outcome', v_block, 'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    select s.current_count into v_before from private.habit_streak(v_habit, v_today) s;
    insert into private.habit_checkins (id, habit_id, on_date, completed_by, source, note, note_revision, note_updated_at)
      values (p_checkin_id, v_habit.id, p_on, v_user_id, p_source, p_note,
        case when p_note is null then 0 else 1 end, case when p_note is not null then pg_catalog.now() end)
      returning * into v_checkin;
    perform private.habit_event(v_habit.id, 'checked_in', v_user_id, p_on, v_checkin.id,
      pg_catalog.jsonb_build_object('backdated', p_on < v_today, 'source', p_source));
    v_milestone := private.habit_record_milestones(v_habit, v_checkin, v_today);
    if v_milestone is not null then
      v_milestone := v_milestone || pg_catalog.jsonb_build_object('celebrate',
        (v_milestone ->> 'celebrate')::boolean
          and coalesce((select s.celebrations from private.habit_user_settings s where s.user_id = v_user_id), true));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'completed',
      'checkin', private.habit_checkin_json(v_checkin, v_habit, v_user_id)
        || pg_catalog.jsonb_build_object('action', private.habit_checkin_action(v_checkin, v_habit, v_user_id, v_today)),
      'streakBefore', v_before,
      'milestone', v_milestone,
      'habit', private.habit_summary_json(v_habit, v_user_id));
  end
  $$;

-- Undoes a check-in. The person who recorded it may undo it while its date is inside the seven-day
-- window and they may still check in ('undo'); habit managers may correct any check-in at any date
-- ('correction', optional reason). The check-in is kept, marked undone with who, when and why; the
-- answer carries the streak before and after. A second undo answers 'already_undone' and changes
-- nothing. Outcomes: 'undone', 'already_undone', 'archived', 'not_found', 'not_permitted'. 22023 for
-- an invalid reason.
create function public.undo_habit_checkin(p_checkin_id uuid, p_reason text default null) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_checkin private.habit_checkins;
    v_today date;
    v_action text;
    v_before integer;
  begin
    if p_checkin_id is null
       or (p_reason is not null and not private.is_plain_text(p_reason, private.habit_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock((select c.habit_id from private.habit_checkins c where c.id = p_checkin_id), v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_checkin from private.habit_checkins c where c.id = p_checkin_id for update;
    v_today := private.habit_today(v_habit);
    if v_checkin.status = 'undone' then
      return pg_catalog.jsonb_build_object('outcome', 'already_undone',
        'checkin', private.habit_checkin_json(v_checkin, v_habit, v_user_id),
        'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    if v_habit.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    v_action := private.habit_checkin_action(v_checkin, v_habit, v_user_id, v_today);
    if v_action is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    select s.current_count into v_before from private.habit_streak(v_habit, v_today) s;
    update private.habit_checkins c
      set status = 'undone', undone_by = v_user_id, undone_at = pg_catalog.now(),
        undo_kind = case when v_action = 'undo' then 'undo' else 'correction' end, undo_reason = p_reason
      where c.id = v_checkin.id returning * into v_checkin;
    perform private.habit_event(v_habit.id, case when v_action = 'undo' then 'undone' else 'corrected' end,
      v_user_id, v_checkin.on_date, v_checkin.id,
      pg_catalog.jsonb_build_object('ownCheckin', v_checkin.completed_by = v_user_id));
    if v_action = 'correct' then
      perform private.audit_habit('habit.checkin_corrected', v_habit,
        pg_catalog.jsonb_build_object('checkinId', v_checkin.id, 'onDate', v_checkin.on_date));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'undone',
      'checkin', private.habit_checkin_json(v_checkin, v_habit, v_user_id),
      'streakBefore', v_before,
      'habit', private.habit_summary_json(v_habit, v_user_id));
  end
  $$;

-- Adds, edits or removes (empty) the note of a check-in: only the person who recorded it, while they
-- may still check in and the check-in is active, from the note revision they saw. The note never
-- changes completion, streaks or milestones. Outcomes: 'saved', 'unchanged', 'conflict', 'undone',
-- 'not_found', 'not_permitted'. 22023 for an invalid note.
create function public.set_habit_checkin_note(
  p_checkin_id uuid, p_expected_revision integer, p_note text default null
)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_checkin private.habit_checkins;
    v_note text := nullif(p_note, '');
    v_old_note text;
  begin
    if p_checkin_id is null or p_expected_revision is null
       or (v_note is not null and not private.is_plain_text(v_note, private.habit_limit('note'))) then
      raise exception 'invalid note' using errcode = '22023';
    end if;
    v_habit := private.habit_lock((select c.habit_id from private.habit_checkins c where c.id = p_checkin_id), v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    select * into v_checkin from private.habit_checkins c where c.id = p_checkin_id for update;
    if v_checkin.completed_by is distinct from v_user_id or not private.habit_may(v_habit, v_user_id, 'complete') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_checkin.status <> 'active' then
      return query select 'undone', v_checkin.note_revision;
      return;
    end if;
    if v_checkin.note_revision <> p_expected_revision then
      return query select 'conflict', v_checkin.note_revision;
      return;
    end if;
    if v_note is not distinct from v_checkin.note then
      return query select 'unchanged', v_checkin.note_revision;
      return;
    end if;
    v_old_note := v_checkin.note;
    update private.habit_checkins c set note = v_note, note_revision = c.note_revision + 1,
        note_updated_at = pg_catalog.now()
      where c.id = v_checkin.id returning * into v_checkin;
    perform private.habit_event(v_habit.id,
      case when v_note is null then 'note_removed' when v_old_note is null then 'note_added' else 'note_edited' end,
      v_user_id, v_checkin.on_date, v_checkin.id);
    return query select 'saved', v_checkin.note_revision;
  end
  $$;

-- Pauses ------------------------------------------------------------------------------------------------

-- Pauses a habit from today (habit managers; a personal habit: its owner), until p_resumes_on (later
-- than today; the habit is active again that day) or until resumed. One current manual pause at a
-- time: change it instead ('already_paused'). Paused days are neither done nor missed and keep the
-- streak; reminders skip them. A Home habit's opted-in members are told when its paused state
-- actually changes. p_dry_run returns the preview: the dates, scheduled days it covers (counted for
-- 28 days when open-ended), whether today is already done, the vacation days it overlaps.
-- Outcomes: 'preview', 'paused', 'already_paused', 'invalid_dates', 'ended', 'archived', 'conflict',
-- 'not_found', 'not_permitted'.
create function public.pause_habit(
  p_id uuid, p_expected_revision integer, p_resumes_on date default null, p_dry_run boolean default false
)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_today date;
    v_status text;
    v_until date;
    v_was text;
    v_pause private.habit_pauses;
    v_impact jsonb;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    v_today := private.habit_today(v_habit);
    v_status := private.habit_status(v_habit, v_today);
    if v_status in ('archived', 'ended') then
      return query select v_status, null::jsonb, v_habit.revision;
      return;
    end if;
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_habit.revision;
      return;
    end if;
    if exists (select 1 from private.habit_pauses hp where hp.habit_id = v_habit.id
        and (hp.resumes_on is null or hp.resumes_on > v_today) and hp.resumes_on is distinct from hp.starts_on) then
      return query select 'already_paused', null::jsonb, v_habit.revision;
      return;
    end if;
    if p_resumes_on is not null and p_resumes_on <= v_today then
      return query select 'invalid_dates', null::jsonb, v_habit.revision;
      return;
    end if;
    v_until := coalesce(p_resumes_on - 1, v_today + 27);
    v_impact := pg_catalog.jsonb_build_object('startsOn', v_today, 'resumesOn', p_resumes_on,
      'counted', p_resumes_on is null,
      'scheduledDays', (select count(*) from private.habit_days(v_habit.id, v_today, v_until) x where x.scheduled),
      'todayDone', exists (select 1 from private.habit_checkins c where c.habit_id = v_habit.id
        and c.on_date = v_today and c.status = 'active'),
      'vacationDays', private.habit_ranges_json((select v.days from private.habit_vacation_days v
        where v.habit_id = v_habit.id) * pg_catalog.datemultirange(pg_catalog.daterange(v_today, p_resumes_on))),
      'reminders', coalesce((select r.enabled from private.habit_reminders r where r.habit_id = v_habit.id), false));
    if p_dry_run then
      return query select 'preview', v_impact, v_habit.revision;
      return;
    end if;
    v_was := private.habit_paused_on(v_habit, v_today);
    insert into private.habit_pauses (habit_id, starts_on, resumes_on, created_by, updated_by)
      values (v_habit.id, v_today, p_resumes_on, v_user_id, v_user_id) returning * into v_pause;
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    perform private.habit_event(v_habit.id, 'paused', v_user_id, v_today, null,
      pg_catalog.jsonb_build_object('resumesOn', p_resumes_on));
    perform private.audit_habit('habit.paused', v_habit, pg_catalog.jsonb_build_object('resumesOn', p_resumes_on));
    if v_was is null then
      perform private.habit_notify_pause(v_habit, 'habit.paused', v_user_id,
        'habit-paused:' || v_pause.id::text, p_resumes_on, false);
    end if;
    perform private.schedule_habit_pause_end(v_habit, v_pause);
    return query select 'paused', v_impact, v_habit.revision;
  end
  $$;

-- Changes the current manual pause (habit managers), from the pause revision the caller saw:
-- 'resume' ends it today; 'change' sets a new resume date (later than today) or none (until
-- resumed). Days already paused stay paused. When resuming, a vacation may still pause the habit
-- (the preview says so, and nobody is told it resumed). Outcomes: 'preview', 'saved', 'not_current'
-- (the pause is over), 'invalid_dates', 'unchanged', 'conflict', 'not_found', 'not_permitted'.
create function public.update_habit_pause(
  p_pause_id uuid, p_expected_revision integer, p_action text, p_resumes_on date default null,
  p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_pause private.habit_pauses;
    v_today date;
    v_new date;
    v_was text;
    v_now text;
    v_impact jsonb;
  begin
    if p_pause_id is null or p_expected_revision is null or p_dry_run is null
       or p_action is null or p_action not in ('resume', 'change')
       or (p_action = 'resume' and p_resumes_on is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock((select hp.habit_id from private.habit_pauses hp where hp.id = p_pause_id), v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    select * into v_pause from private.habit_pauses hp where hp.id = p_pause_id for update;
    v_today := private.habit_today(v_habit);
    if (v_pause.resumes_on is not null and v_pause.resumes_on <= v_today)
       or v_habit.archived_at is not null then
      return query select 'not_current', null::jsonb, v_pause.revision;
      return;
    end if;
    if v_pause.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_pause.revision;
      return;
    end if;
    v_new := case when p_action = 'resume' then greatest(v_today, v_pause.starts_on) else p_resumes_on end;
    if p_action = 'change' and p_resumes_on is not null and p_resumes_on <= v_today then
      return query select 'invalid_dates', null::jsonb, v_pause.revision;
      return;
    end if;
    v_impact := pg_catalog.jsonb_build_object('startsOn', v_pause.starts_on, 'resumesOn', v_new,
      'previousResumesOn', v_pause.resumes_on,
      'vacationToday', coalesce((select v.days @> v_today from private.habit_vacation_days v
        where v.habit_id = v_habit.id), false));
    if v_new is not distinct from v_pause.resumes_on then
      return query select 'unchanged', v_impact, v_pause.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_impact, v_pause.revision;
      return;
    end if;
    v_was := private.habit_paused_on(v_habit, v_today);
    update private.habit_pauses hp set resumes_on = v_new, revision = hp.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where hp.id = v_pause.id returning * into v_pause;
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    v_now := private.habit_paused_on(v_habit, v_today);
    perform private.habit_event(v_habit.id, case when p_action = 'resume' then 'resumed' else 'pause_changed' end,
      v_user_id, v_today, null, pg_catalog.jsonb_build_object('resumesOn', v_new));
    perform private.audit_habit(case when p_action = 'resume' then 'habit.resumed' else 'habit.pause_changed' end,
      v_habit, pg_catalog.jsonb_build_object('resumesOn', v_new));
    if v_was is not null and v_now is null then
      perform private.habit_notify_pause(v_habit, 'habit.resumed', v_user_id,
        'habit-resumed:' || v_pause.id::text || ':' || v_pause.revision::text, null, false);
    end if;
    perform private.schedule_habit_pause_end(v_habit, v_pause);
    return query select 'saved', v_impact, v_pause.revision;
  end
  $$;

-- Reminders -----------------------------------------------------------------------------------------------

-- Sets the habit's reminder (habit managers; a personal habit: its owner), from the reminder revision
-- the caller saw (0 when it was never set): on or off, 1-3 local times on chosen weekdays. A new
-- revision retires the reminder moments already queued. Turning it off may leave the times and days
-- out: the saved ones are kept for turning it on again. Outcomes: 'saved', 'unchanged', 'conflict',
-- 'archived', 'not_found', 'not_permitted'. 22023 for invalid times or days.
create function public.set_habit_reminders(
  p_id uuid, p_expected_revision integer, p_enabled boolean, p_times time[] default null,
  p_weekdays smallint[] default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_reminder private.habit_reminders;
    v_times time[];
    v_weekdays smallint[];
  begin
    if p_id is null or p_expected_revision is null or p_enabled is null
       or ((p_enabled or p_times is not null or p_weekdays is not null)
         and not private.valid_habit_reminder(p_times, p_weekdays)) then
      raise exception 'invalid reminder' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_id, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_habit.archived_at is not null then
      return query select 'archived', null::integer;
      return;
    end if;
    select * into v_reminder from private.habit_reminders r where r.habit_id = v_habit.id for update;
    if coalesce(v_reminder.revision, 0) <> p_expected_revision then
      return query select 'conflict', coalesce(v_reminder.revision, 0);
      return;
    end if;
    v_times := coalesce(p_times, v_reminder.times);
    v_weekdays := coalesce(p_weekdays, v_reminder.weekdays);
    if v_times is null then
      -- Off, and never set: nothing to keep.
      return query select 'unchanged', 0;
      return;
    end if;
    if v_reminder.habit_id is not null and v_reminder.enabled = p_enabled
       and (select array_agg(t order by t) from pg_catalog.unnest(v_reminder.times) t)
         = (select array_agg(t order by t) from pg_catalog.unnest(v_times) t)
       and (select array_agg(w order by w) from pg_catalog.unnest(v_reminder.weekdays) w)
         = (select array_agg(w order by w) from pg_catalog.unnest(v_weekdays) w) then
      return query select 'unchanged', v_reminder.revision;
      return;
    end if;
    insert into private.habit_reminders as r (habit_id, enabled, times, weekdays, updated_by)
      values (v_habit.id, p_enabled, v_times, v_weekdays, v_user_id)
      on conflict (habit_id) do update set enabled = excluded.enabled, times = excluded.times,
        weekdays = excluded.weekdays, revision = r.revision + 1, updated_by = excluded.updated_by,
        updated_at = pg_catalog.now()
      returning * into v_reminder;
    if not p_enabled then
      update private.habit_reminder_snoozes s set status = 'cancelled' where s.habit_id = v_habit.id and s.status = 'pending';
    end if;
    perform private.schedule_habit_reminder(v_habit.id);
    perform private.habit_event(v_habit.id, 'reminders_changed', v_user_id, null, null,
      pg_catalog.jsonb_build_object('enabled', p_enabled));
    return query select 'saved', v_reminder.revision;
  end
  $$;

-- Turns a Home habit's reminders off or back on for the caller only (members who may check in).
-- Outcomes: 'saved', 'not_found', 'not_permitted'. 22023 for a personal habit.
create function public.set_my_habit_reminders(p_id uuid, p_enabled boolean) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
  begin
    if p_id is null or p_enabled is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_for(p_id, v_user_id);
    if v_habit.id is null then
      return 'not_found';
    end if;
    if v_habit.owner_home_id is null then
      raise exception 'not a Home habit' using errcode = '22023';
    end if;
    if not private.habit_may(v_habit, v_user_id, 'complete') then
      return 'not_permitted';
    end if;
    if p_enabled then
      delete from private.habit_reminder_optouts o where o.habit_id = v_habit.id and o.user_id = v_user_id;
    else
      insert into private.habit_reminder_optouts (habit_id, user_id) values (v_habit.id, v_user_id)
        on conflict do nothing;
      update private.habit_reminder_snoozes s set status = 'cancelled'
        where s.habit_id = v_habit.id and s.user_id = v_user_id and s.status = 'pending';
    end if;
    return 'saved';
  end
  $$;

-- Snoozes one habit reminder notice of the caller's for 15, 30 or 60 minutes: one deferred delivery,
-- nothing else changes. Refused when the reminder is no longer needed (done, paused, ended, archived,
-- target reached), when the new time is no longer the same local day ('window_closed') or falls in
-- the caller's quiet hours ('quiet_hours'). Outcomes: 'snoozed' (with the moment), 'already_snoozed'
-- (with it), 'not_needed', 'window_closed', 'quiet_hours', 'not_found', 'not_permitted'.
create function public.snooze_habit_reminder(p_notification_id uuid, p_minutes integer)
returns table (outcome text, due_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_notice public.notifications;
    v_snooze private.habit_reminder_snoozes;
    v_habit private.habits;
    v_on date;
    v_due timestamptz;
    v_today date;
  begin
    if p_notification_id is null or p_minutes is null or p_minutes not in (15, 30, 60) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_notice from public.notifications n
      where n.id = p_notification_id and n.user_id = v_user_id and n.kind = 'habit.reminder';
    if v_notice.id is null then
      return query select 'not_found', null::timestamptz;
      return;
    end if;
    v_habit := private.habit_lock((v_notice.params ->> 'habitId')::uuid, v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::timestamptz;
      return;
    end if;
    select * into v_snooze from private.habit_reminder_snoozes s where s.notification_id = v_notice.id;
    if v_snooze.notification_id is not null then
      return query select 'already_snoozed', v_snooze.due_at;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'complete') then
      return query select 'not_permitted', null::timestamptz;
      return;
    end if;
    v_on := (v_notice.params ->> 'onDate')::date;
    v_today := private.habit_today(v_habit);
    if v_on <> v_today or private.habit_checkin_block(v_habit, v_on, v_today) is not null then
      return query select 'not_needed', null::timestamptz;
      return;
    end if;
    v_due := pg_catalog.date_trunc('minute', pg_catalog.now()) + pg_catalog.make_interval(mins => p_minutes);
    if (v_due at time zone private.habit_zone(v_habit))::date <> v_on then
      return query select 'window_closed', v_due;
      return;
    end if;
    if (select q.quiet from private.notification_quiet_state(v_user_id, v_habit.owner_home_id, v_due) q) then
      return query select 'quiet_hours', v_due;
      return;
    end if;
    insert into private.habit_reminder_snoozes (notification_id, habit_id, user_id, on_date, minutes, due_at)
      values (v_notice.id, v_habit.id, v_user_id, v_on, p_minutes, v_due);
    perform private.enqueue_job('habit-reminder-snooze', 1, 'habit-snooze:' || v_notice.id::text,
      pg_catalog.jsonb_build_object('notificationId', v_notice.id), null, v_due);
    return query select 'snoozed', v_due;
  end
  $$;

-- Settings ------------------------------------------------------------------------------------------------

-- A Home's member access to its habits ('complete' or 'view'; habit managers only). Outcomes:
-- 'saved', 'not_permitted'. 42501 for a Home the caller is not in; 22023 for another value.
create function public.update_habit_settings(p_home_id uuid, p_member_access text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_home_id is null or p_member_access is null or p_member_access not in ('complete', 'view') then
      raise exception 'invalid settings' using errcode = '22023';
    end if;
    perform private.require_habit_context(p_home_id, v_user_id);
    if private.habit_access(p_home_id, v_user_id) is distinct from 'manage' then
      return 'not_permitted';
    end if;
    insert into private.habit_settings as s (home_id, member_access, updated_by)
      values (p_home_id, p_member_access, v_user_id)
      on conflict (home_id) do update set member_access = excluded.member_access,
        updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    perform private.audit('habits.member_access', p_home_id, 'habit', null,
      pg_catalog.jsonb_build_object('memberAccess', p_member_access));
    return 'saved';
  end
  $$;

-- The caller's own choice: milestone celebrations on or muted.
create function public.set_habit_celebrations(p_enabled boolean) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_enabled is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    insert into private.habit_user_settings as s (user_id, celebrations) values (v_user_id, p_enabled)
      on conflict (user_id) do update set celebrations = excluded.celebrations, updated_at = pg_catalog.now();
    return 'saved';
  end
  $$;

-- Vacation pauses of personal habits ----------------------------------------------------------------------

-- The caller's own accepted participation in a vacation (null when there is none) and their active
-- personal habits, each with whether it pauses during it and how many scheduled days from today on
-- that would pause. Null when the vacation is not in a Home the caller belongs to.
create function public.get_vacation_habits(p_vacation_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_vacation private.home_vacations;
    v_part private.home_vacation_participants;
  begin
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id;
    if v_vacation.id is null or not private.is_home_member(v_vacation.home_id, v_user_id) then
      return null;
    end if;
    select * into v_part from private.home_vacation_participants p
      where p.vacation_id = v_vacation.id and p.user_id = v_user_id and p.status = 'accepted';
    return pg_catalog.jsonb_build_object(
      'participation', case when v_part.id is not null and v_vacation.cancelled_at is null then
        pg_catalog.jsonb_build_object('startsOn', v_part.starts_on, 'endsOn', v_part.ends_on) end,
      'habits', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', h.id, 'name', h.name,
          'paused', exists (select 1 from private.habit_vacation_choices c where c.habit_id = h.id
            and c.vacation_id = v_vacation.id),
          'scheduledDays', case when v_part.id is not null then (select count(*) from private.habit_days(h.id,
              greatest(v_part.starts_on, private.habit_today(h)), v_part.ends_on) x where x.scheduled) end)
          order by pg_catalog.lower(h.name), h.id)
        from private.habits h
        where h.owner_home_id is null and h.owner_user_id = v_user_id and h.deleted_at is null
          and private.habit_status(h, private.habit_today(h)) not in ('archived', 'ended')), '[]'::jsonb));
  end
  $$;

-- Switches one of the caller's personal habits on or off for their accepted participation in a
-- vacation: paused during it from today on (days already passed never change). Outcomes: 'saved',
-- 'unchanged', 'not_participant', 'not_found'.
create function public.set_vacation_habit(p_vacation_id uuid, p_habit_id uuid, p_paused boolean) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_vacation private.home_vacations;
  begin
    if p_vacation_id is null or p_habit_id is null or p_paused is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_habit_id, v_user_id);
    if v_habit.id is null or v_habit.owner_home_id is not null then
      return 'not_found';
    end if;
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id;
    if v_vacation.id is null or not private.is_home_member(v_vacation.home_id, v_user_id) then
      return 'not_found';
    end if;
    if p_paused and (v_vacation.cancelled_at is not null or not exists (
        select 1 from private.home_vacation_participants p
        where p.vacation_id = v_vacation.id and p.user_id = v_user_id and p.status = 'accepted')) then
      return 'not_participant';
    end if;
    if p_paused = exists (select 1 from private.habit_vacation_choices c
        where c.habit_id = v_habit.id and c.vacation_id = v_vacation.id) then
      return 'unchanged';
    end if;
    if p_paused then
      insert into private.habit_vacation_choices (habit_id, vacation_id) values (v_habit.id, v_vacation.id);
    else
      delete from private.habit_vacation_choices c where c.habit_id = v_habit.id and c.vacation_id = v_vacation.id;
    end if;
    perform private.refresh_habit_vacation_days(v_habit.id);
    perform private.habit_event(v_habit.id, 'vacation_pause_changed', v_user_id, null, null,
      pg_catalog.jsonb_build_object('paused', p_paused));
    return 'saved';
  end
  $$;

-- Background delivery (service role only) -----------------------------------------------------------------

-- Delivers one reminder moment of a habit (the habit-reminder job) and queues the next one. Rechecked
-- now: the reminder revision is current and on, the habit is not archived or in the trash, and the
-- day still needs it (scheduled, in a tracking period, not paused, not done; a weekly schedule: target
-- not reached). A moment more than 30 minutes late is skipped, never sent afterwards. Each recipient
-- is told once per moment (dedupe key). Outcomes: 'notified', 'not_needed', 'late', 'inactive',
-- 'stale', 'not_due'.
create function public.deliver_habit_reminder(p_habit_id uuid, p_revision integer, p_at timestamptz)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit private.habits;
    v_reminder private.habit_reminders;
    v_on date;
    v_today date;
    v_user_id uuid;
  begin
    if p_habit_id is null or p_revision is null or p_at is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_habit from private.habits h where h.id = p_habit_id for update;
    select * into v_reminder from private.habit_reminders r where r.habit_id = p_habit_id;
    if v_habit.id is null or v_habit.deleted_at is not null or v_reminder.habit_id is null
       or v_reminder.revision <> p_revision or not v_reminder.enabled then
      return 'stale';
    end if;
    if p_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    perform private.schedule_habit_reminder(v_habit.id, p_at);
    if pg_catalog.now() > p_at + pg_catalog.make_interval(mins => private.habit_limit('late_minutes')) then
      return 'late';
    end if;
    if v_habit.archived_at is not null then
      return 'inactive';
    end if;
    v_today := private.habit_today(v_habit);
    v_on := (p_at at time zone private.habit_zone(v_habit))::date;
    if v_on <> v_today or private.habit_checkin_block(v_habit, v_on, v_today) is not null then
      return 'not_needed';
    end if;
    for v_user_id in select * from private.habit_reminder_recipients(v_habit) loop
      perform private.notify_user(v_user_id, v_habit.owner_home_id, 'reminders', 'habit.reminder',
        pg_catalog.jsonb_build_object('homeId', v_habit.owner_home_id, 'habitId', v_habit.id, 'onDate', v_on,
          'weekly', (private.habit_schedule_on(v_habit.id, v_on)).kind = 'weekly'),
        'habit-reminder:' || v_habit.id::text || ':' || v_user_id::text || ':' || extract(epoch from p_at)::bigint::text,
        true);
    end loop;
    return 'notified';
  end
  $$;

-- Tops up the reminder chain of every habit whose reminder is on (the hourly task-reminder-advance
-- schedule): queues the next moment where it is missing (a job that failed for good). Returns how many
-- habits were looked at, least recently looked at first.
create function public.advance_habit_reminders(p_limit integer) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit_id uuid;
    v_count integer := 0;
  begin
    if p_limit is null or p_limit not between 1 and 5000 then
      raise exception 'invalid limit' using errcode = '22023';
    end if;
    for v_habit_id in
      select r.habit_id from private.habit_reminders r
      join private.habits h on h.id = r.habit_id
      where r.enabled and h.deleted_at is null and h.archived_at is null
      order by r.topped_up_at nulls first, r.habit_id limit p_limit
    loop
      perform private.schedule_habit_reminder(v_habit_id);
      update private.habit_reminders r set topped_up_at = pg_catalog.now() where r.habit_id = v_habit_id;
      v_count := v_count + 1;
    end loop;
    return v_count;
  end
  $$;

-- Delivers a snoozed reminder (the habit-reminder-snooze job), after rechecking: the person may still
-- check in and still wants this habit's reminders, the reminder is still on, it is still that day,
-- the day still needs it, and it is not quiet hours for them now (then it is dropped, not delayed).
-- Outcomes: 'notified', 'cancelled', 'stale', 'not_due'.
create function public.deliver_habit_snooze(p_notification_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_snooze private.habit_reminder_snoozes;
    v_habit private.habits;
    v_today date;
  begin
    if p_notification_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_snooze from private.habit_reminder_snoozes s where s.notification_id = p_notification_id;
    if v_snooze.notification_id is null or v_snooze.status <> 'pending' then
      return 'stale';
    end if;
    if v_snooze.due_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    select * into v_habit from private.habits h where h.id = v_snooze.habit_id for update;
    select * into v_snooze from private.habit_reminder_snoozes s where s.notification_id = p_notification_id for update;
    if v_snooze.status <> 'pending' then
      return 'stale';
    end if;
    v_today := private.habit_today(v_habit);
    if v_habit.deleted_at is not null or v_habit.archived_at is not null
       or not private.habit_may(v_habit, v_snooze.user_id, 'complete')
       or exists (select 1 from private.habit_reminder_optouts o
         where o.habit_id = v_habit.id and o.user_id = v_snooze.user_id)
       or not coalesce((select r.enabled from private.habit_reminders r where r.habit_id = v_habit.id), false)
       or v_today <> v_snooze.on_date
       or private.habit_checkin_block(v_habit, v_snooze.on_date, v_today) is not null
       or (select q.quiet from private.notification_quiet_state(v_snooze.user_id, v_habit.owner_home_id,
         pg_catalog.now()) q) then
      update private.habit_reminder_snoozes s set status = 'cancelled' where s.notification_id = p_notification_id;
      return 'cancelled';
    end if;
    perform private.notify_user(v_snooze.user_id, v_habit.owner_home_id, 'reminders', 'habit.reminder',
      pg_catalog.jsonb_build_object('homeId', v_habit.owner_home_id, 'habitId', v_habit.id,
        'onDate', v_snooze.on_date, 'weekly', (private.habit_schedule_on(v_habit.id, v_snooze.on_date)).kind = 'weekly',
        'snoozed', true),
      'habit-snooze:' || p_notification_id::text, true);
    update private.habit_reminder_snoozes s set status = 'delivered' where s.notification_id = p_notification_id;
    return 'notified';
  end
  $$;

-- The automatic end of a dated manual pause of a Home habit (the habit-pause-end job): tells the
-- opted-in members it resumed, once, only when this pause still ends that day and nothing else (another
-- pause, a vacation) still pauses the habit. Outcomes: 'notified', 'still_paused', 'stale', 'not_due'.
create function public.deliver_habit_pause_end(p_pause_id uuid, p_resumes_on date) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pause private.habit_pauses;
    v_habit private.habits;
  begin
    if p_pause_id is null or p_resumes_on is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_habit from private.habits h
      where h.id = (select hp.habit_id from private.habit_pauses hp where hp.id = p_pause_id) for update;
    select * into v_pause from private.habit_pauses hp where hp.id = p_pause_id;
    if v_pause.id is null or v_pause.resumes_on is distinct from p_resumes_on or v_pause.resumes_on = v_pause.starts_on
       or v_habit.deleted_at is not null or v_habit.archived_at is not null then
      return 'stale';
    end if;
    if private.habit_today(v_habit) < p_resumes_on then
      return 'not_due';
    end if;
    if private.habit_paused_on(v_habit, p_resumes_on) is not null then
      return 'still_paused';
    end if;
    perform private.habit_notify_pause(v_habit, 'habit.resumed', null,
      'habit-pause-end:' || v_pause.id::text || ':' || p_resumes_on::text, null, true);
    return 'notified';
  end
  $$;

-- Trash ------------------------------------------------------------------------------------------------

-- The dispatch functions as they stood before habits keep handling every other module; these handle the
-- habits module and hand the rest on (the chores pattern).
alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_habits;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_habits;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_habits;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_habits;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_habits;

-- A habit has nothing that can be in the way of its return.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'habits' then
      return private.trash_conflict_before_habits(p_entry);
    end if;
    if not exists (select 1 from private.habits h where h.id = p_entry.subject_id and h.deleted_at is not null) then
      return 'item_missing';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select private.trash_conflict_options_before_habits(p_kind);
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'habits' then
      perform private.trash_resolve_before_habits(p_entry, p_resolution);
    end if;
  end
  $$;

-- A habit comes back exactly as it was, with its reminder chain queued again.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_habit private.habits;
  begin
    if p_entry.module <> 'habits' then
      return private.trash_item_restore_before_habits(p_entry);
    end if;
    select * into v_habit from private.habits h where h.id = p_entry.subject_id and h.deleted_at is not null for update;
    if v_habit.id is null then
      raise exception 'habit restore unavailable' using errcode = '23505';
    end if;
    update private.habits h
      set deleted_at = null, revision = h.revision + 1, updated_by = auth.uid(), updated_at = pg_catalog.now()
      where h.id = v_habit.id;
    perform private.refresh_habit_vacation_days(v_habit.id);
    perform private.schedule_habit_reminder(v_habit.id);
    perform private.habit_event(v_habit.id, 'restored', auth.uid());
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'habits' then
      perform private.trash_item_purge_before_habits(p_entry);
      return;
    end if;
    delete from private.habits h where h.id = p_entry.subject_id and h.deleted_at is not null;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The habits API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_habits', 'get_habit', 'get_habit_checkins', 'get_habit_events', 'get_habit_insights',
      'get_habit_calendar', 'habit_notice_names', 'create_habit', 'update_habit', 'change_habit_schedule',
      'set_habit_end', 'reactivate_habit', 'archive_habit', 'delete_habit', 'complete_habit',
      'undo_habit_checkin', 'set_habit_checkin_note', 'pause_habit', 'update_habit_pause',
      'set_habit_reminders', 'set_my_habit_reminders', 'snooze_habit_reminder', 'update_habit_settings',
      'set_habit_celebrations', 'get_vacation_habits', 'set_vacation_habit'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Background delivery: the service role only (Trigger.dev jobs).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'deliver_habit_reminder', 'advance_habit_reminders', 'deliver_habit_snooze', 'deliver_habit_pause_end'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%habit%'
      or p.proname in ('is_delegable_capability', 'trash_conflict', 'trash_conflict_options',
        'trash_resolve', 'trash_item_restore', 'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
