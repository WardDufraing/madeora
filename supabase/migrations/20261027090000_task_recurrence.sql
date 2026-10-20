-- S19: recurring tasks and their occurrence history (brief plans/steps/S19-brief.md; ADR 0023; spec
-- "Confirmed recurring task and chore editing scope", "Confirmed recurring task and chore deletion
-- scope", "Confirmed recurring task occurrence history", the recurrence notes of the label,
-- priority, subtask, assignee and comment decisions, and "Confirmed member departure and removal:
-- content ownership" (future recurring assignments are cleared)).
--
-- A series is a template (title, description, priority, labels, assignees, checklist titles, start
-- offset) and a schedule in one context. Its occurrences are ordinary tasks (S18) that carry the
-- series, the root of its chain and their original scheduled date, so each one has its own shared
-- completion, checklist and comments. Every occurrence up to today exists plus exactly one upcoming;
-- public.advance_task_series creates them when a task page is read (no background job in S19), and
-- one per chain and date at most (a unique index), so retries, races and splits never duplicate.
--
-- "This and following" splits a chain: the current part (the head) ends the day before and a new
-- head starts there. "Entire series" changes the head and every open occurrence of the chain.
-- Completed occurrences are never changed; individually changed ("detached") open ones are kept.
-- Removing following or all occurrences is one trash entry (item type task_series_removal) that
-- restores them together.
--
-- Rights (default picked in the brief, mirrors packages/domain decideSeriesAction): one occurrence
-- follows the S18 task rules; the series' creator and task managers change following or all
-- occurrences, pause, resume and delete; only task managers change series assignees.
--
-- Schedules are dates only (tasks are date-only) in the Home's timezone, or the person's effective
-- timezone passed by the app for their Personal space (private.task_today). A series never creates
-- occurrences before the day it was created, rescheduled, resumed or restored.

-- Audit subject, limits ------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series'
  ));

-- apps/web/src/tasks/schema.ts and packages/domain RECURRENCE_LIMITS use the same numbers.
create or replace function private.task_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'lists' then 100              -- non-deleted lists per context
    when 'labels' then 100             -- labels per context
    when 'labels_per_task' then 20
    when 'assignees_per_task' then 20
    when 'subtasks' then 100           -- subtasks per task
    when 'page' then 50                -- tasks one listing returns
    when 'max_offset' then 10000
    when 'comments_page' then 100
    when 'list_name' then 60
    when 'label_name' then 40
    when 'title' then 200              -- task and subtask titles
    when 'description' then 5000
    when 'comment' then 2000
    when 'series' then 200             -- active series per context (S19)
    when 'series_interval' then 99     -- "every N" days, weeks, months or years
    when 'series_count' then 999       -- "ends after N occurrences"
    when 'start_offset' then 365       -- days a start date may lie before the due date
    when 'series_per_advance' then 50  -- series one advance call looks at
    when 'series_catch_up' then 100    -- occurrences one advance call creates per series
    when 'history_page' then 50
  end;
  $$;

-- Tables -------------------------------------------------------------------------------------------

-- One part of a recurring series. A chain of parts (same root_id) is one series to people: a split
-- ("this and following") ends the current part (superseded_at, until_date) and starts a new head.
-- Only the head creates occurrences. next_date is the next date to create (null: ended);
-- last_date the latest date created so far.
create table private.task_series (
  id uuid primary key,
  root_id uuid not null,
  previous_id uuid,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  list_id uuid references private.task_lists (id) on delete set null,
  title text not null constraint task_series_title_check check (private.is_visible_name(title, 200)),
  description text constraint task_series_description_check
    check (description is null or private.is_plain_text(description, 5000)),
  priority text constraint task_series_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent')),
  start_offset integer constraint task_series_start_offset_check check (start_offset between 0 and 365),
  frequency text not null constraint task_series_frequency_check
    check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  interval_count integer not null constraint task_series_interval_check check (interval_count between 1 and 99),
  weekdays smallint[] constraint task_series_weekdays_check check (
    (frequency = 'weekly') = (weekdays is not null)
    and (weekdays is null or (cardinality(weekdays) between 1 and 7 and weekdays <@ '{1,2,3,4,5,6,7}'))
  ),
  -- The schedule's anchor (its first date, and the day of month or week it counts from).
  starts_on date not null,
  -- After a split that kept the schedule: the first date this part may create (the anchor stays,
  -- so "every 2 weeks" or "on the 31st" keeps its rhythm). Null: from starts_on.
  active_from date,
  ends_on date,
  max_count integer constraint task_series_count_check check (max_count between 1 and 999),
  -- The last date the schedule allows (the end date, the counted occurrences, or a split), or null.
  until_date date,
  next_date date,
  last_date date,
  paused_at timestamptz,
  superseded_at timestamptz,
  needs_reassignment boolean not null default false,
  revision integer not null default 1 constraint task_series_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint task_series_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint task_series_ends_check check (ends_on is null or ends_on >= starts_on),
  constraint task_series_until_check check (until_date is null or until_date >= starts_on - 1),
  constraint task_series_next_check check (next_date is null or next_date >= starts_on),
  constraint task_series_id_home_key unique (id, owner_home_id)
);

create index task_series_root_idx on private.task_series (root_id);
-- The heads an advance looks at: active, not ended, oldest progress first.
create index task_series_home_head_idx on private.task_series (owner_home_id, last_date)
  where owner_home_id is not null and superseded_at is null and deleted_at is null;
create index task_series_user_head_idx on private.task_series (owner_user_id, last_date)
  where owner_user_id is not null and superseded_at is null and deleted_at is null;
create index task_series_list_idx on private.task_series (list_id)
  where superseded_at is null and deleted_at is null;

create table private.task_series_labels (
  series_id uuid not null references private.task_series (id) on delete cascade,
  label_id uuid not null references private.task_labels (id) on delete cascade,
  primary key (series_id, label_id)
);

create index task_series_labels_label_idx on private.task_series_labels (label_id);

-- Series assignees are current members by construction: the assignment ends with the membership
-- (spec: future recurring assignments to a departed member are cleared).
create table private.task_series_assignees (
  series_id uuid not null,
  home_id uuid not null,
  user_id uuid not null,
  primary key (series_id, user_id),
  foreign key (series_id, home_id) references private.task_series (id, owner_home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index task_series_assignees_member_idx on private.task_series_assignees (home_id, user_id);

-- The checklist every new occurrence starts with (titles only; each occurrence ticks its own).
create table private.task_series_subtasks (
  series_id uuid not null references private.task_series (id) on delete cascade,
  position integer not null,
  title text not null constraint task_series_subtasks_title_check check (private.is_visible_name(title, 200)),
  primary key (series_id, position)
);

-- Occurrences: tasks that know their series part, their chain and their original scheduled date.
alter table private.tasks
  add column series_id uuid references private.task_series (id) on delete set null,
  add column series_root_id uuid,
  add column occurrence_date date,
  -- Changed on its own ("this occurrence"): later series changes leave it as it is.
  add column detached boolean not null default false,
  add constraint tasks_series_check check (series_id is null or series_root_id is not null),
  add constraint tasks_occurrence_check check (series_root_id is null or occurrence_date is not null);

-- At most one occurrence per chain and date, whatever retries, races or splits do.
create unique index tasks_occurrence_key on private.tasks (series_root_id, occurrence_date)
  where series_root_id is not null;
create index tasks_series_idx on private.tasks (series_id) where series_id is not null;

-- What removing following or all occurrences took away, so the trash can bring it back.
create table private.task_series_removals (
  id uuid primary key default gen_random_uuid(),
  root_id uuid not null,
  head_id uuid not null,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  mode text not null constraint task_series_removals_mode_check check (mode in ('following', 'series')),
  from_date date,
  task_ids uuid[] not null,
  -- The head's revision right after the removal: a different one later means the series changed.
  head_revision integer not null,
  previous_ends_on date,
  previous_max_count integer,
  previous_until_date date,
  -- Set by the restore resolution 'restore_tasks_only': the occurrences come back, the series as it is.
  tasks_only boolean not null default false,
  created_at timestamptz not null default now(),
  constraint task_series_removals_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

alter table private.task_series enable row level security;
alter table private.task_series_labels enable row level security;
alter table private.task_series_assignees enable row level security;
alter table private.task_series_subtasks enable row level security;
alter table private.task_series_removals enable row level security;
revoke all on table private.task_series, private.task_series_labels, private.task_series_assignees,
  private.task_series_subtasks, private.task_series_removals
  from public, anon, authenticated;

comment on table private.task_series is
  'S19: recurring task series parts (template and schedule). Not exposed through the API.';

-- Member departure ----------------------------------------------------------------------------------

-- Before a membership ends, the series the person was assigned to are flagged for reassignment (new
-- occurrences then carry the flag too); the assignment ends through its foreign key. S18's trigger
-- flags their open occurrences.
create function private.flag_departed_series_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    update private.task_series s set needs_reassignment = true
      where s.owner_home_id = old.home_id and s.deleted_at is null and s.superseded_at is null
        and not s.needs_reassignment
        and exists (
          select 1 from private.task_series_assignees a where a.series_id = s.id and a.user_id = old.user_id
        );
    return old;
  end
  $$;

create trigger home_memberships_flag_series_assignments
  before delete on public.home_memberships
  for each row execute function private.flag_departed_series_assignments();

-- Schedule arithmetic (packages/domain/src/tasks/recurrence.ts mirrors it; shared vectors test both) --

-- The date of a month offset from p_start, on p_start's day or the month's last day.
create function private.series_month_date(p_start date, p_months integer) returns date
  language sql immutable strict set search_path = '' as $$
  select pg_catalog.make_date(
    (pg_catalog.date_part('year', m)::integer),
    (pg_catalog.date_part('month', m)::integer),
    least(pg_catalog.date_part('day', p_start)::integer,
      pg_catalog.date_part('day', m + interval '1 month' - interval '1 day')::integer))
  from (select pg_catalog.date_trunc('month', p_start::timestamp) + pg_catalog.make_interval(months => p_months) as m) x;
  $$;

-- The first date of the pattern on or after p_from, never before p_starts_on, ignoring any end.
--   daily: every p_interval days from the start; weekly: the ISO weekdays (1 Monday … 7 Sunday) of
--   every p_interval-th Monday–Sunday week from the start's week; monthly: the start's day every
--   p_interval months (29–31: the month's last day); yearly: the start's day every p_interval years
--   (29 February: 28 February in other years).
create function private.series_first_on_or_after(
  p_frequency text, p_interval integer, p_weekdays smallint[], p_starts_on date, p_from date
) returns date
  language plpgsql immutable set search_path = '' as $$
  declare
    v_target date := greatest(p_from, p_starts_on);
    v_first_week date;
    v_week integer;
    v_from date;
    v_week_start date;
    v_day integer;
    v_index integer;
    v_candidate date;
  begin
    if p_frequency is null or p_interval is null or p_interval < 1 or p_starts_on is null then
      return null;
    end if;
    case p_frequency
      when 'daily' then
        return p_starts_on + ((v_target - p_starts_on + p_interval - 1) / p_interval) * p_interval;
      when 'weekly' then
        if coalesce(cardinality(p_weekdays), 0) = 0 then
          return null;
        end if;
        v_first_week := p_starts_on - (pg_catalog.date_part('isodow', p_starts_on)::integer - 1);
        v_week := (v_target - v_first_week) / 7;
        v_from := v_target;
        loop
          if v_week % p_interval <> 0 then
            v_week := ((v_week + p_interval - 1) / p_interval) * p_interval;
            v_from := v_first_week + v_week * 7;
          end if;
          v_week_start := v_first_week + v_week * 7;
          select min(d) into v_day from unnest(p_weekdays) as d where v_week_start + d - 1 >= v_from;
          if v_day is not null then
            return v_week_start + v_day - 1;
          end if;
          v_week := v_week + p_interval;
          v_from := v_first_week + v_week * 7;
        end loop;
      when 'monthly', 'yearly' then
        v_index := (pg_catalog.date_part('year', v_target)::integer * 12
            + pg_catalog.date_part('month', v_target)::integer)
          - (pg_catalog.date_part('year', p_starts_on)::integer * 12
            + pg_catalog.date_part('month', p_starts_on)::integer);
        if p_frequency = 'yearly' then
          -- Whole years from the start, every p_interval of them.
          v_index := pg_catalog.date_part('year', v_target)::integer - pg_catalog.date_part('year', p_starts_on)::integer;
          v_index := greatest(0, ((v_index + p_interval - 1) / p_interval) * p_interval);
          loop
            v_candidate := private.series_month_date(p_starts_on, v_index * 12);
            if v_candidate >= v_target then
              return v_candidate;
            end if;
            v_index := v_index + p_interval;
          end loop;
        end if;
        v_index := greatest(0, ((v_index + p_interval - 1) / p_interval) * p_interval);
        loop
          v_candidate := private.series_month_date(p_starts_on, v_index);
          if v_candidate >= v_target then
            return v_candidate;
          end if;
          v_index := v_index + p_interval;
        end loop;
      else
        return null;
    end case;
  end
  $$;

-- Whether a schedule is well formed (the API checks the same with packages/domain isValidPattern).
create function private.valid_series_rule(
  p_frequency text, p_interval integer, p_weekdays smallint[], p_starts_on date, p_ends_on date,
  p_max_count integer
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    p_frequency in ('daily', 'weekly', 'monthly', 'yearly')
    and p_interval between 1 and private.task_limit('series_interval')
    and p_starts_on is not null
    and p_starts_on between date '2000-01-01' and date '2199-12-31'
    and (p_ends_on is null or p_ends_on between p_starts_on and date '2199-12-31')
    and (p_max_count is null or p_max_count between 1 and private.task_limit('series_count'))
    and case when p_frequency = 'weekly'
      then cardinality(p_weekdays) between 1 and 7 and p_weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]
        and (select count(distinct d) from unnest(p_weekdays) as d) = cardinality(p_weekdays)
      else p_weekdays is null end,
    false);
  $$;

-- The last date a schedule allows: its end date, or the date of its p_max_count-th occurrence,
-- whichever comes first; null when it never ends.
create function private.series_until(
  p_frequency text, p_interval integer, p_weekdays smallint[], p_starts_on date, p_ends_on date,
  p_max_count integer
) returns date
  language plpgsql immutable set search_path = '' as $$
  declare
    v_date date;
  begin
    if p_max_count is null then
      return p_ends_on;
    end if;
    v_date := private.series_first_on_or_after(p_frequency, p_interval, p_weekdays, p_starts_on, p_starts_on);
    for i in 2 .. p_max_count loop
      exit when p_ends_on is not null and v_date >= p_ends_on;
      v_date := private.series_first_on_or_after(p_frequency, p_interval, p_weekdays, p_starts_on, v_date + 1);
    end loop;
    return case when p_ends_on is not null and p_ends_on < v_date then p_ends_on else v_date end;
  end
  $$;

-- The next date of a part on or after p_from within its end, or null.
create function private.series_next(p_series private.task_series, p_from date) returns date
  language sql immutable set search_path = '' as $$
  select case when p_series.until_date is null or d <= p_series.until_date then d end
  from (select private.series_first_on_or_after(p_series.frequency, p_series.interval_count,
    p_series.weekdays, p_series.starts_on,
    greatest(p_from, coalesce(p_series.active_from, p_series.starts_on))) as d) x;
  $$;

-- Whether a date is on a part's schedule (within its start and end).
create function private.series_has_date(p_series private.task_series, p_date date) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(private.series_next(p_series, p_date) = p_date, false);
  $$;

-- Up to p_limit dates of a part on or after p_from (for impact previews).
create function private.series_dates(p_series private.task_series, p_from date, p_limit integer)
returns date[]
  language plpgsql immutable set search_path = '' as $$
  declare
    v_dates date[] := '{}';
    v_next date := private.series_next(p_series, p_from);
  begin
    while v_next is not null and cardinality(v_dates) < p_limit loop
      v_dates := v_dates || v_next;
      v_next := private.series_next(p_series, v_next + 1);
    end loop;
    return v_dates;
  end
  $$;

-- Permission helpers (packages/domain decideSeriesAction mirrors these) ----------------------------

-- Change following or all occurrences, pause, resume, delete: a task manager, or the current member
-- who created the series (its first part: a split keeps the creator).
create function private.can_edit_series(p_series private.task_series, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.can_manage_tasks(p_series.owner_user_id, p_series.owner_home_id, p_user_id)
    or (
      p_series.owner_home_id is not null
      and private.is_home_member(p_series.owner_home_id, p_user_id)
      and coalesce(p_series.created_by = p_user_id, false)
    );
  $$;

-- The head of an occurrence's chain, locked: the one part that creates occurrences, and the row
-- every change to following or all occurrences of the chain locks first. Null when the series was
-- removed entirely.
create function private.lock_series_head(p_root_id uuid) returns private.task_series
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_head private.task_series;
  begin
    select * into v_head from private.task_series s
      where s.root_id = p_root_id and s.superseded_at is null and s.deleted_at is null
      for update;
    return v_head;
  end
  $$;

-- Whether an occurrence was changed in a way a series change must not undo: changed on its own,
-- commented on, or with a ticked checklist item.
create function private.occurrence_touched(p_task private.tasks) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_task.detached
    or exists (select 1 from private.task_comments c where c.task_id = p_task.id)
    or exists (select 1 from private.subtasks s where s.task_id = p_task.id and s.completed_at is not null);
  $$;

-- Occurrences -----------------------------------------------------------------------------------------

-- Creates the head's occurrence for one date from its template, unless the chain already has one
-- for that date (a retry, a race, or an occurrence kept from an earlier part). Its creator is the
-- series' creator, so the S18 task rules give them the same rights on every occurrence.
create function private.create_occurrence(p_series private.task_series, p_date date) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid := gen_random_uuid();
  begin
    insert into private.tasks (
      id, owner_user_id, owner_home_id, list_id, title, description, start_date, due_date, priority,
      needs_reassignment, created_by, created_at, updated_by, series_id, series_root_id, occurrence_date
    ) values (
      v_id, p_series.owner_user_id, p_series.owner_home_id, p_series.list_id, p_series.title,
      p_series.description, case when p_series.start_offset is not null then p_date - p_series.start_offset end,
      p_date, p_series.priority, p_series.needs_reassignment, p_series.created_by, pg_catalog.now(),
      p_series.created_by, p_series.id, p_series.root_id, p_date
    )
    on conflict (series_root_id, occurrence_date) where series_root_id is not null do nothing;
    if not found then
      return null;
    end if;
    insert into private.task_label_links (task_id, label_id)
      select v_id, l.label_id from private.task_series_labels l where l.series_id = p_series.id;
    insert into private.task_assignees (task_id, home_id, user_id, assigned_by)
      select v_id, a.home_id, a.user_id, p_series.created_by
      from private.task_series_assignees a where a.series_id = p_series.id;
    insert into private.subtasks (id, task_id, title, position, created_by)
      select gen_random_uuid(), v_id, s.title, s.position, p_series.created_by
      from private.task_series_subtasks s where s.series_id = p_series.id;
    return v_id;
  end
  $$;

-- Brings a locked head up to date: every occurrence up to p_today, plus one upcoming, at most
-- series_catch_up per call (the rest next time). A missed date stays an open, overdue occurrence;
-- nothing is skipped or completed. Nothing happens while it is paused, ended or its list unusable
-- (lists refuse archiving and deletion while a series uses them). Returns how many it created.
create function private.advance_series(p_series private.task_series, p_today date) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_next date := p_series.next_date;
    v_last date := p_series.last_date;
    v_created integer := 0;
  begin
    if p_series.id is null or p_series.paused_at is not null or p_series.deleted_at is not null
       or p_series.superseded_at is not null or v_next is null then
      return 0;
    end if;
    if not private.usable_task_list(p_series.list_id, p_series.owner_user_id, p_series.owner_home_id) then
      return 0;
    end if;
    while v_next is not null and v_created < private.task_limit('series_catch_up')
      and (v_next <= p_today or v_last is null or v_last <= p_today) loop
      perform private.create_occurrence(p_series, v_next);
      v_created := v_created + 1;
      v_last := greatest(v_last, v_next);
      v_next := private.series_next(p_series, v_next + 1);
    end loop;
    if v_next is distinct from p_series.next_date or v_last is distinct from p_series.last_date then
      update private.task_series s set next_date = v_next, last_date = v_last where s.id = p_series.id;
    end if;
    return v_created;
  end
  $$;

-- Creates the occurrences due in the caller's context (up to today plus one upcoming per series).
-- Task pages call it before they read, so occurrences appear without a background job. Looks at
-- most series_per_advance series per call, those furthest behind first. Returns how many it created.
create function public.advance_task_series(p_home_id uuid default null, p_today date default null)
returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_series private.task_series;
    v_created integer := 0;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, p_today);
    -- Locked one by one in id order (never two at once), so two page loads queue instead of
    -- creating anything twice; the second sees the first's progress and has nothing left to do.
    for v_series in
      select * from private.task_series s
      where ((p_home_id is null and s.owner_user_id = v_user_id) or s.owner_home_id = p_home_id)
        and s.superseded_at is null and s.deleted_at is null and s.paused_at is null
        and s.next_date is not null and (s.last_date is null or s.last_date <= v_today)
      order by s.last_date nulls first, s.id
      limit private.task_limit('series_per_advance')
    loop
      select * into v_series from private.task_series s where s.id = v_series.id for update;
      if v_series.superseded_at is null and v_series.deleted_at is null then
        v_created := v_created + private.advance_series(v_series, v_today);
      end if;
    end loop;
    return v_created;
  end
  $$;

-- Writes a template's labels, assignees and checklist (replacing what was there).
create function private.set_series_template(
  p_series_id uuid, p_home_id uuid, p_label_ids uuid[], p_user_ids uuid[], p_subtasks text[]
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_label_ids is not null then
      delete from private.task_series_labels l where l.series_id = p_series_id;
      insert into private.task_series_labels (series_id, label_id)
        select p_series_id, x from unnest(p_label_ids) as x on conflict do nothing;
    end if;
    if p_user_ids is not null and p_home_id is not null then
      delete from private.task_series_assignees a where a.series_id = p_series_id;
      insert into private.task_series_assignees (series_id, home_id, user_id)
        select p_series_id, p_home_id, x from unnest(p_user_ids) as x on conflict do nothing;
    end if;
    if p_subtasks is not null then
      delete from private.task_series_subtasks s where s.series_id = p_series_id;
      insert into private.task_series_subtasks (series_id, position, title)
        select p_series_id, o::integer, x from unnest(p_subtasks) with ordinality as u (x, o);
    end if;
  end
  $$;

-- Creating a series ---------------------------------------------------------------------------------

-- Creates a recurring task: the series and its first occurrences (from p_starts_on, never before
-- today: no back-fill). The same rules as create_task: any current member, in an active list;
-- assignees need a task manager. p_id is the series id from the client, so a retry returns the same
-- series. Outcomes: 'created', 'exists', 'id_taken', 'list_unavailable', 'invalid_label',
-- 'invalid_assignee', 'not_permitted', 'limit_reached', 'ended' (the schedule allows no date from
-- today). first_task_id is the first occurrence (to open it). 22023 for invalid fields.
create function public.create_task_series(
  p_id uuid, p_list_id uuid, p_title text, p_frequency text, p_interval integer,
  p_starts_on date, p_weekdays smallint[] default null, p_ends_on date default null,
  p_max_count integer default null, p_description text default null, p_start_offset integer default null,
  p_priority text default null, p_label_ids uuid[] default '{}', p_assignee_ids uuid[] default '{}',
  p_home_id uuid default null, p_today date default null
) returns table (outcome text, first_task_id uuid, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_existing private.task_series;
    v_series private.task_series;
    v_users uuid[] := '{}';
    v_today date;
    v_first uuid;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_id is null or p_list_id is null
       or not private.valid_task_fields(p_title, p_description, null, null, p_priority)
       or not private.valid_series_rule(p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count)
       or (p_start_offset is not null and p_start_offset not between 0 and private.task_limit('start_offset')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, p_today);
    select * into v_existing from private.task_series s where s.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.is_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists',
          (select t.id from private.tasks t where t.series_root_id = v_existing.root_id
            and t.deleted_at is null order by t.occurrence_date limit 1),
          v_existing.revision;
      else
        return query select 'id_taken', null::uuid, null::integer;
      end if;
      return;
    end if;
    if not private.usable_task_list(p_list_id, v_owner_user, p_home_id) then
      return query select 'list_unavailable', null::uuid, null::integer;
      return;
    end if;
    if not private.valid_task_labels(p_label_ids, v_owner_user, p_home_id) then
      return query select 'invalid_label', null::uuid, null::integer;
      return;
    end if;
    if coalesce(cardinality(p_assignee_ids), 0) > 0 then
      if p_home_id is null then
        return query select 'invalid_assignee', null::uuid, null::integer;
        return;
      end if;
      if not private.can_manage_tasks(null, p_home_id, v_user_id) then
        return query select 'not_permitted', null::uuid, null::integer;
        return;
      end if;
      v_users := private.member_users(p_home_id, p_assignee_ids);
      if v_users is null or cardinality(v_users) > private.task_limit('assignees_per_task') then
        return query select 'invalid_assignee', null::uuid, null::integer;
        return;
      end if;
    end if;
    -- The per-context limit, counted under the context lock so two creates cannot both pass.
    perform private.lock_task_context('task_series', p_home_id, v_user_id);
    if (select count(*) from private.task_series s
        where ((p_home_id is null and s.owner_user_id = v_user_id) or s.owner_home_id = p_home_id)
          and s.superseded_at is null and s.deleted_at is null) >= private.task_limit('series') then
      return query select 'limit_reached', null::uuid, null::integer;
      return;
    end if;
    insert into private.task_series (
      id, root_id, owner_user_id, owner_home_id, list_id, title, description, priority, start_offset,
      frequency, interval_count, weekdays, starts_on, ends_on, max_count, until_date, created_by,
      updated_by
    ) values (
      p_id, p_id, v_owner_user, p_home_id, p_list_id, p_title, p_description, p_priority, p_start_offset,
      p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count,
      private.series_until(p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count),
      v_user_id, v_user_id
    )
    on conflict (id) do nothing
    returning * into v_series;
    if v_series.id is null then
      return query select 'id_taken', null::uuid, null::integer;
      return;
    end if;
    v_series.next_date := private.series_next(v_series, greatest(v_today, p_starts_on));
    if v_series.next_date is null then
      -- Every date of the schedule is in the past: nothing would ever be created.
      delete from private.task_series s where s.id = v_series.id;
      return query select 'ended', null::uuid, null::integer;
      return;
    end if;
    update private.task_series s set next_date = v_series.next_date where s.id = v_series.id;
    perform private.set_series_template(v_series.id, p_home_id, p_label_ids, v_users, null);
    perform private.advance_series(v_series, v_today);
    select t.id into v_first from private.tasks t
      where t.series_root_id = v_series.id order by t.occurrence_date limit 1;
    perform private.audit_task('task_series.created', p_home_id, 'task_series', v_series.id,
      pg_catalog.jsonb_build_object('assignees', cardinality(v_users), 'frequency', p_frequency));
    return query select 'created', v_first, 1;
  end
  $$;

-- Changing following or all occurrences ------------------------------------------------------------

-- What a change to following or all occurrences does, and its impact (spec "Confirmed recurring task
-- and chore editing scope"). One occurrence is changed with the S18 functions (update_task,
-- set_task_assignees, move_task), which mark it individually changed.
--
--   p_scope 'following': this occurrence and later ones (only from an open occurrence of the head
--     part; 'scope_unavailable' otherwise). The head ends the day before and a new head starts here
--     with the change; open later occurrences move to it. With no earlier occurrence in the chain
--     it is the same as 'series'.
--   p_scope 'series': the head and every open occurrence of the chain.
--   Parts, each optional: content (p_set_content: title, description, priority, labels, start
--   offset in days before the due date, and with p_copy_subtasks this occurrence's checklist as the
--   checklist of occurrences created from now on); the list (p_list_id); assignees (p_assignee_ids,
--   task managers only); the schedule (p_set_schedule: frequency, interval, weekdays, anchor date,
--   end date, count).
--
-- Never changed: completed occurrences, and open ones changed individually (kept; this occurrence
-- itself is always changed). A schedule change removes upcoming open occurrences that are no longer
-- on it unless touched (changed individually, commented, or with a ticked item: kept), and creates
-- from today on (no back-fill); overdue open ones stay, as missed history.
--
-- p_dry_run: the same work, rolled back, so the preview cannot disagree with the change. Outcomes:
-- 'preview' and 'saved' (with impact: updated, kept, removed, completed, selectedRemoved, nextDates),
-- 'conflict' (either revision is stale; revision: the series' current one), 'not_found',
-- 'not_recurring', 'not_permitted', 'scope_unavailable', 'list_unavailable', 'invalid_label',
-- 'invalid_assignee', 'ended' (the new schedule allows no date from today). task_id: this
-- occurrence, or when the schedule change removed it the chain's next open occurrence.
create function public.update_task_series(
  p_task_id uuid, p_scope text, p_expected_task_revision integer, p_expected_series_revision integer,
  p_dry_run boolean,
  p_set_content boolean default false, p_title text default null, p_description text default null,
  p_priority text default null, p_label_ids uuid[] default null, p_start_offset integer default null,
  p_copy_subtasks boolean default false,
  p_list_id uuid default null,
  p_assignee_ids uuid[] default null,
  p_set_schedule boolean default false, p_frequency text default null, p_interval integer default null,
  p_weekdays smallint[] default null, p_starts_on date default null, p_ends_on date default null,
  p_max_count integer default null,
  p_today date default null
) returns table (outcome text, impact jsonb, revision integer, task_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_target private.task_series;
    v_scope text := p_scope;
    v_today date;
    v_users uuid[];
    v_boundary date;
    v_occurrence private.tasks;
    v_updated integer := 0;
    v_kept integer := 0;
    v_removed integer := 0;
    v_completed integer := 0;
    v_selected_removed boolean := false;
    v_subtasks text[];
    v_impact jsonb;
    v_next_task uuid;
  begin
    if p_task_id is null or p_scope is null or p_scope not in ('following', 'series')
       or p_expected_task_revision is null or p_expected_series_revision is null or p_dry_run is null
       or p_set_content is null or p_set_schedule is null or p_copy_subtasks is null
       or (p_set_content and (
         not private.valid_task_fields(p_title, p_description, null, null, p_priority)
         or p_label_ids is null
         or (p_start_offset is not null and p_start_offset not between 0 and private.task_limit('start_offset'))))
       or (p_set_schedule and not private.valid_series_rule(
         p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count))
       or not (p_set_content or p_set_schedule or p_list_id is not null or p_assignee_ids is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The series head before the occurrence, like every series-wide change: two of them started
    -- from different occurrences of one series then queue instead of deadlocking (S19 review M1).
    perform private.lock_series_head(
      (select t.series_root_id from private.tasks t where t.id = p_task_id));
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if v_task.series_root_id is null then
      return query select 'not_recurring', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_head.id is null then
      return query select 'not_recurring', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id)
       or (p_assignee_ids is not null and (v_head.owner_home_id is null
         or not private.can_manage_tasks(null, v_head.owner_home_id, v_user_id))) then
      return query select 'not_permitted', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if v_task.revision <> p_expected_task_revision or v_head.revision <> p_expected_series_revision then
      return query select 'conflict', null::jsonb, v_head.revision, null::uuid;
      return;
    end if;
    if p_scope = 'following' and (v_task.series_id is distinct from v_head.id or v_task.completed_at is not null) then
      return query select 'scope_unavailable', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_set_content and not private.valid_task_labels(p_label_ids, v_head.owner_user_id, v_head.owner_home_id) then
      return query select 'invalid_label', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_list_id is not null
       and not private.usable_task_list(p_list_id, v_head.owner_user_id, v_head.owner_home_id) then
      return query select 'list_unavailable', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_assignee_ids is not null then
      v_users := private.member_users(v_head.owner_home_id, p_assignee_ids);
      if v_users is null or cardinality(v_users) > private.task_limit('assignees_per_task') then
        return query select 'invalid_assignee', null::jsonb, null::integer, null::uuid;
        return;
      end if;
    end if;
    v_today := private.task_today(v_head.owner_home_id, p_today);
    v_boundary := v_task.occurrence_date;
    if v_scope = 'following' and v_head.previous_id is null and not exists (
      select 1 from private.tasks t
      where t.series_root_id = v_head.root_id and t.deleted_at is null and t.occurrence_date < v_boundary
    ) then
      v_scope := 'series';
    end if;
    if p_copy_subtasks then
      select coalesce(array_agg(s.title order by s.position, s.created_at, s.id), '{}') into v_subtasks
        from private.subtasks s where s.task_id = v_task.id;
    end if;

    begin
      if v_scope = 'following' then
        -- A new head from this occurrence on, with the old head's template and schedule; the old
        -- head ends the day before. Same creator, so the creator keeps their rights.
        insert into private.task_series (
          id, root_id, previous_id, owner_user_id, owner_home_id, list_id, title, description,
          priority, start_offset, frequency, interval_count, weekdays, starts_on, active_from,
          ends_on, max_count, until_date, next_date, last_date, paused_at, needs_reassignment,
          revision, created_by, created_at, updated_by
        )
        select gen_random_uuid(), h.root_id, h.id, h.owner_user_id, h.owner_home_id, h.list_id,
          h.title, h.description, h.priority, h.start_offset, h.frequency, h.interval_count,
          h.weekdays, h.starts_on, greatest(v_boundary, coalesce(h.active_from, h.starts_on)),
          h.ends_on, h.max_count, h.until_date, h.next_date, h.last_date, h.paused_at,
          h.needs_reassignment, h.revision + 1, h.created_by, h.created_at, v_user_id
        from private.task_series h where h.id = v_head.id
        returning * into v_target;
        insert into private.task_series_labels (series_id, label_id)
          select v_target.id, l.label_id from private.task_series_labels l where l.series_id = v_head.id;
        insert into private.task_series_assignees (series_id, home_id, user_id)
          select v_target.id, a.home_id, a.user_id from private.task_series_assignees a where a.series_id = v_head.id;
        insert into private.task_series_subtasks (series_id, position, title)
          select v_target.id, s.position, s.title from private.task_series_subtasks s where s.series_id = v_head.id;
        -- Never before the old part's own start (S19 review H2): after a reschedule moved the start
        -- later, an older open occurrence can lie before it; the old part then keeps no dates.
        update private.task_series s
          set superseded_at = pg_catalog.now(), next_date = null,
            until_date = greatest(least(coalesce(s.until_date, v_boundary - 1), v_boundary - 1),
              s.starts_on - 1),
            updated_by = v_user_id, updated_at = pg_catalog.now()
          where s.id = v_head.id;
        update private.tasks t set series_id = v_target.id
          where t.series_id = v_head.id and t.occurrence_date >= v_boundary
            and t.deleted_at is null and t.completed_at is null;
      else
        v_target := v_head;
        v_target.revision := v_head.revision + 1;
      end if;

      -- The template.
      if p_set_content then
        v_target.title := p_title;
        v_target.description := p_description;
        v_target.priority := p_priority;
        v_target.start_offset := p_start_offset;
      end if;
      if p_list_id is not null then
        v_target.list_id := p_list_id;
      end if;
      if p_assignee_ids is not null then
        v_target.needs_reassignment := false;
      end if;
      if p_set_schedule then
        v_target.frequency := p_frequency;
        v_target.interval_count := p_interval;
        v_target.weekdays := p_weekdays;
        v_target.starts_on := p_starts_on;
        -- A new part never creates dates before its first occurrence, whatever its anchor.
        v_target.active_from := case when v_scope = 'following' then v_boundary end;
        v_target.ends_on := p_ends_on;
        v_target.max_count := p_max_count;
        v_target.until_date := private.series_until(
          p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count);
      end if;
      update private.task_series s
        set list_id = v_target.list_id, title = v_target.title, description = v_target.description,
          priority = v_target.priority, start_offset = v_target.start_offset,
          frequency = v_target.frequency, interval_count = v_target.interval_count,
          weekdays = v_target.weekdays, starts_on = v_target.starts_on,
          active_from = v_target.active_from, ends_on = v_target.ends_on,
          max_count = v_target.max_count, until_date = v_target.until_date,
          -- A new schedule's next date is computed below; the old one may lie before a later start
          -- (S19 review H1).
          next_date = case when p_set_schedule then null else s.next_date end,
          needs_reassignment = v_target.needs_reassignment, revision = v_target.revision,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where s.id = v_target.id
        returning * into v_target;
      perform private.set_series_template(v_target.id, v_target.owner_home_id,
        case when p_set_content then p_label_ids end, v_users, v_subtasks);

      -- The open occurrences in scope, locked in id order.
      for v_occurrence in
        select * from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
          and (v_scope = 'series' or t.series_id = v_target.id)
        order by t.id
        for update
      loop
        if v_occurrence.id <> v_task.id and v_occurrence.detached then
          v_kept := v_kept + 1;
          continue;
        end if;
        if p_set_schedule and v_occurrence.occurrence_date > v_today
           and not private.series_has_date(v_target, v_occurrence.occurrence_date) then
          if private.occurrence_touched(v_occurrence) then
            -- Kept as it is, and from now on treated as changed on its own.
            update private.tasks t set detached = true where t.id = v_occurrence.id;
            v_kept := v_kept + 1;
          else
            delete from private.tasks t where t.id = v_occurrence.id;
            v_removed := v_removed + 1;
            v_selected_removed := v_selected_removed or v_occurrence.id = v_task.id;
          end if;
          continue;
        end if;
        if not (p_set_content or p_list_id is not null or p_assignee_ids is not null) then
          continue;
        end if;
        update private.tasks t
          set title = case when p_set_content then p_title else t.title end,
            description = case when p_set_content then p_description else t.description end,
            priority = case when p_set_content then p_priority else t.priority end,
            start_date = case when p_set_content
              then case when p_start_offset is not null then t.due_date - p_start_offset end
              else t.start_date end,
            list_id = coalesce(p_list_id, t.list_id),
            needs_reassignment = case when p_assignee_ids is not null then false else t.needs_reassignment end,
            revision = t.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
          where t.id = v_occurrence.id;
        if p_set_content then
          perform private.replace_task_labels(v_occurrence.id, p_label_ids);
        end if;
        if p_assignee_ids is not null then
          perform private.replace_task_assignees(v_occurrence.id, v_target.owner_home_id, v_users, v_user_id);
        end if;
        v_updated := v_updated + 1;
      end loop;
      select count(*)::integer into v_completed from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is not null
          and (v_scope = 'series' or t.occurrence_date >= v_boundary);

      if p_set_schedule then
        -- Creation restarts from today (no back-fill), after whatever the chain still has.
        v_target.next_date := private.series_next(v_target, v_today);
        if v_target.next_date is null then
          raise exception 'schedule ended' using errcode = 'MD002';
        end if;
        select max(t.occurrence_date) into v_target.last_date from private.tasks t
          where t.series_root_id = v_head.root_id;
        update private.task_series s set next_date = v_target.next_date, last_date = v_target.last_date
          where s.id = v_target.id
          returning * into v_target;
      end if;
      perform private.advance_series(v_target, v_today);
      select * into v_target from private.task_series s where s.id = v_target.id;

      v_impact := pg_catalog.jsonb_build_object(
        'scope', v_scope,
        'updated', v_updated,
        'kept', v_kept,
        'removed', v_removed,
        'completed', v_completed,
        'selectedRemoved', v_selected_removed,
        'subtasksCopied', coalesce(cardinality(v_subtasks), 0),
        'nextDates', pg_catalog.to_jsonb(private.series_dates(v_target, v_today, 5)));
      if v_selected_removed then
        select t.id into v_next_task from private.tasks t
          where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
            and t.occurrence_date >= v_today
          order by t.occurrence_date limit 1;
      else
        v_next_task := v_task.id;
      end if;
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        -- Everything above is rolled back; the impact stays.
        return query select 'preview', v_impact, v_head.revision, v_task.id;
        return;
      when sqlstate 'MD002' then
        return query select 'ended', null::jsonb, null::integer, null::uuid;
        return;
    end;
    perform private.audit_task('task_series.updated', v_head.owner_home_id, 'task_series', v_head.root_id,
      pg_catalog.jsonb_build_object('scope', v_scope, 'updated', v_updated, 'kept', v_kept,
        'removed', v_removed, 'schedule', p_set_schedule, 'assignees', p_assignee_ids is not null));
    return query select 'saved', v_impact, v_target.revision, v_next_task;
  end
  $$;

-- Removing following or all occurrences ------------------------------------------------------------

-- Removes this and later occurrences, or the whole series (spec "Confirmed recurring task and chore
-- deletion scope"); one occurrence is deleted with delete_task. Completed occurrences always stay
-- (history). 'following': only from an open occurrence of the head part; the series ends the day
-- before, and this and later open occurrences go to the trash. 'series': the series stops and every
-- open occurrence of it goes to the trash. Either is one trash entry (item type
-- task_series_removal) that brings them back together. With no earlier occurrence, 'following'
-- is 'series'. The series' creator or a task manager. p_dry_run returns the impact only.
-- Outcomes: 'preview', 'deleted' (with the entry), 'conflict', 'not_found', 'not_recurring',
-- 'not_permitted', 'scope_unavailable'. impact: scope, removed, completed.
create function public.delete_task_series(
  p_task_id uuid, p_scope text, p_expected_series_revision integer, p_dry_run boolean
) returns table (outcome text, impact jsonb, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_scope text := p_scope;
    v_ids uuid[];
    v_completed integer;
    v_impact jsonb;
    v_removal private.task_series_removals;
  begin
    if p_task_id is null or p_scope is null or p_scope not in ('following', 'series')
       or p_expected_series_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The series head before the occurrence, like every series-wide change: two of them started
    -- from different occurrences of one series then queue instead of deadlocking (S19 review M1).
    perform private.lock_series_head(
      (select t.series_root_id from private.tasks t where t.id = p_task_id));
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::jsonb, null::uuid;
      return;
    end if;
    if v_task.series_root_id is null then
      return query select 'not_recurring', null::jsonb, null::uuid;
      return;
    end if;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_head.id is null then
      return query select 'not_recurring', null::jsonb, null::uuid;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::uuid;
      return;
    end if;
    if v_head.revision <> p_expected_series_revision then
      return query select 'conflict', null::jsonb, null::uuid;
      return;
    end if;
    if p_scope = 'following' and (v_task.series_id is distinct from v_head.id or v_task.completed_at is not null) then
      return query select 'scope_unavailable', null::jsonb, null::uuid;
      return;
    end if;
    if v_scope = 'following' and v_head.previous_id is null and not exists (
      select 1 from private.tasks t
      where t.series_root_id = v_head.root_id and t.deleted_at is null
        and t.occurrence_date < v_task.occurrence_date
    ) then
      v_scope := 'series';
    end if;
    -- The open occurrences that go, locked in id order (a completion waits, or has won).
    select coalesce(array_agg(x.id order by x.id), '{}') into v_ids from (
      select t.id from private.tasks t
      where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
        and (v_scope = 'series' or (t.series_id = v_head.id and t.occurrence_date >= v_task.occurrence_date))
      order by t.id
      for update
    ) x;
    select count(*)::integer into v_completed from private.tasks t
      where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is not null
        and (v_scope = 'series' or t.occurrence_date >= v_task.occurrence_date);
    v_impact := pg_catalog.jsonb_build_object(
      'scope', v_scope, 'removed', cardinality(v_ids), 'completed', v_completed);
    if p_dry_run then
      return query select 'preview', v_impact, null::uuid;
      return;
    end if;
    insert into private.task_series_removals (
      root_id, head_id, owner_user_id, owner_home_id, mode, from_date, task_ids, head_revision,
      previous_ends_on, previous_max_count, previous_until_date
    ) values (
      v_head.root_id, v_head.id, v_head.owner_user_id, v_head.owner_home_id, v_scope,
      case when v_scope = 'following' then v_task.occurrence_date end, v_ids, v_head.revision + 1,
      v_head.ends_on, v_head.max_count, v_head.until_date
    ) returning * into v_removal;
    update private.tasks t set deleted_at = pg_catalog.now() where t.id = any (v_ids);
    if v_scope = 'following' then
      update private.task_series s
        -- Never before the part's own start (S19 review H2), as in update_task_series.
        set until_date = greatest(
            least(coalesce(s.until_date, v_task.occurrence_date - 1), v_task.occurrence_date - 1),
            s.starts_on - 1),
          next_date = null, revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where s.id = v_head.id;
    else
      update private.task_series s
        set revision = case when s.id = v_head.id then s.revision + 1 else s.revision end,
          deleted_at = pg_catalog.now(), updated_by = v_user_id, updated_at = pg_catalog.now()
        where s.root_id = v_head.root_id and s.deleted_at is null;
    end if;
    perform private.audit_task('task_series.removed', v_head.owner_home_id, 'task_series', v_head.root_id,
      pg_catalog.jsonb_build_object('scope', v_scope, 'removed', cardinality(v_ids)));
    return query select 'deleted', v_impact,
      private.trash_move(v_user_id, 'tasks', 'task_series_removal', v_removal.id, v_head.owner_user_id,
        v_head.owner_home_id, v_head.title);
  end
  $$;

-- Pausing and resuming --------------------------------------------------------------------------------

-- Pauses a series (no new occurrences; open ones stay) or resumes it from today (no back-fill). The
-- series' creator or a task manager. Outcomes: 'saved', 'conflict', 'not_found', 'not_recurring',
-- 'not_permitted'.
create function public.set_task_series_paused(
  p_task_id uuid, p_paused boolean, p_expected_series_revision integer, p_today date default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
  begin
    if p_task_id is null or p_paused is null or p_expected_series_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The series head before the occurrence, like every series-wide change: two of them started
    -- from different occurrences of one series then queue instead of deadlocking (S19 review M1).
    perform private.lock_series_head(
      (select t.series_root_id from private.tasks t where t.id = p_task_id));
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_task.series_root_id is null or v_head.id is null then
      return query select 'not_recurring', null::integer;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_head.revision <> p_expected_series_revision then
      return query select 'conflict', v_head.revision;
      return;
    end if;
    if p_paused = (v_head.paused_at is not null) then
      return query select 'saved', v_head.revision;
      return;
    end if;
    update private.task_series s
      set paused_at = case when p_paused then pg_catalog.now() end,
        -- Resuming continues from today: dates missed while paused are not created.
        next_date = case when p_paused or s.next_date is null then s.next_date
          else private.series_next(s, private.task_today(s.owner_home_id, p_today)) end,
        revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_head.id
      returning * into v_head;
    if not p_paused then
      perform private.advance_series(v_head, private.task_today(v_head.owner_home_id, p_today));
    end if;
    perform private.audit_task(case when p_paused then 'task_series.paused' else 'task_series.resumed' end,
      v_head.owner_home_id, 'task_series', v_head.root_id);
    return query select 'saved', v_head.revision;
  end
  $$;

-- Occurrence history --------------------------------------------------------------------------------

-- A page of a series' history, newest first (spec "Confirmed recurring task occurrence history"):
-- every occurrence of the chain scheduled up to today, and any completed early; never a future one
-- merely forecast. Each row: scheduled date, due date, status ('completed', 'completed_late' after
-- its due date in the context's timezone, 'missed' for an overdue open one, 'open' for one due
-- today), when it was completed and by whom (the actual completer, once). Occurrences in the trash
-- are left out. p_filter: 'all', 'completed' or 'missed'. p_time_zone is the person's effective
-- timezone for their Personal space (a Home uses its own). A task the caller may not see, or one that
-- is not recurring, gives no rows.
create function public.list_task_occurrences(
  p_task_id uuid, p_filter text default 'all', p_offset integer default 0, p_limit integer default 50,
  p_today date default null, p_time_zone text default null
) returns table (
  id uuid, occurrence_date date, due_date date, status text, completed_at timestamptz,
  completed_by_me boolean, completed_by_member uuid, is_current boolean, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_today date;
    v_zone text;
  begin
    if p_task_id is null or p_filter is null or p_filter not in ('all', 'completed', 'missed')
       or p_offset is null or p_offset not between 0 and private.task_limit('max_offset')
       or p_limit is null or p_limit not between 1 and private.task_limit('history_page') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id;
    if not found or v_task.deleted_at is not null or v_task.series_root_id is null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return;
    end if;
    v_today := private.task_today(v_task.owner_home_id, p_today);
    if v_task.owner_home_id is not null then
      select h.timezone into v_zone from public.homes h where h.id = v_task.owner_home_id;
    elsif p_time_zone is not null and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_time_zone) then
      v_zone := p_time_zone;
    end if;
    v_zone := coalesce(v_zone, 'UTC');
    return query
      with rows as (
        select t.id, t.occurrence_date, t.due_date, t.completed_at, t.completed_by,
          case
            when t.completed_at is not null then
              case when t.due_date is not null and (t.completed_at at time zone v_zone)::date > t.due_date
                then 'completed_late' else 'completed' end
            when t.due_date < v_today then 'missed'
            else 'open'
          end as status
        from private.tasks t
        where t.series_root_id = v_task.series_root_id and t.deleted_at is null
          and (t.occurrence_date <= v_today or t.completed_at is not null)
      )
      select r.id, r.occurrence_date, r.due_date, r.status, r.completed_at,
        coalesce(r.completed_by = v_user_id, false),
        private.member_ref(v_task.owner_home_id, r.completed_by),
        r.id = v_task.id,
        (count(*) over ())::integer
      from rows r
      where p_filter = 'all'
        or (p_filter = 'completed' and r.status in ('completed', 'completed_late'))
        or (p_filter = 'missed' and r.status = 'missed')
      order by r.occurrence_date desc, r.id
      limit p_limit offset p_offset;
  end
  $$;

-- S18 functions again ---------------------------------------------------------------------------------

-- A change to one occurrence of a series ("this occurrence") marks it individually changed, so later
-- changes to following or all occurrences leave it as it is. Otherwise unchanged from S18.

-- Saves a task's content (title, description, dates, priority, labels) if nobody changed it since
-- p_expected_revision. Outcomes: 'saved', 'conflict', 'invalid_label', 'not_found', 'not_permitted'.
-- Omitted optional fields are cleared (null), so the caller always sends the whole content.
create or replace function public.update_task(
  p_task_id uuid, p_expected_revision integer, p_title text, p_label_ids uuid[],
  p_description text default null, p_start_date date default null, p_due_date date default null,
  p_priority text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
  begin
    if p_task_id is null or p_expected_revision is null or p_label_ids is null
       or not private.valid_task_fields(p_title, p_description, p_start_date, p_due_date, p_priority) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_task.revision <> p_expected_revision then
      return query select 'conflict', v_task.revision;
      return;
    end if;
    if not private.valid_task_labels(p_label_ids, v_task.owner_user_id, v_task.owner_home_id) then
      return query select 'invalid_label', null::integer;
      return;
    end if;
    update private.tasks t
      set title = p_title, description = p_description, start_date = p_start_date,
        due_date = p_due_date, priority = p_priority, detached = t.series_root_id is not null,
        revision = t.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where t.id = v_task.id
      returning * into v_task;
    perform private.replace_task_labels(v_task.id, p_label_ids);
    return query select 'saved', v_task.revision;
  end
  $$;

-- Sets a Home task's assignees (task managers only), as membership ids of current members; clears
-- the reassignment flag. Outcomes: 'saved', 'conflict', 'invalid_assignee', 'not_found', 'not_permitted'.
create or replace function public.set_task_assignees(
  p_task_id uuid, p_expected_revision integer, p_member_ids uuid[]
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_users uuid[];
  begin
    if p_task_id is null or p_expected_revision is null or p_member_ids is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_task.owner_home_id is null or not private.can_manage_tasks(null, v_task.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_task.revision <> p_expected_revision then
      return query select 'conflict', v_task.revision;
      return;
    end if;
    v_users := private.member_users(v_task.owner_home_id, p_member_ids);
    if v_users is null or cardinality(v_users) > private.task_limit('assignees_per_task') then
      return query select 'invalid_assignee', null::integer;
      return;
    end if;
    perform private.replace_task_assignees(v_task.id, v_task.owner_home_id, v_users, v_user_id);
    update private.tasks t
      set needs_reassignment = false, detached = t.series_root_id is not null,
        revision = t.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where t.id = v_task.id
      returning * into v_task;
    perform private.audit_task('task.assignees_set', v_task.owner_home_id, 'task', v_task.id,
      pg_catalog.jsonb_build_object('assignees', cardinality(v_users)));
    return query select 'saved', v_task.revision;
  end
  $$;

-- Moves a task to another active list of the same context, keeping everything else. Outcomes:
-- 'saved', 'conflict', 'list_unavailable' (deleted, archived, missing or in another context),
-- 'not_found', 'not_permitted'.
create or replace function public.move_task(p_task_id uuid, p_expected_revision integer, p_list_id uuid)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
  begin
    if p_task_id is null or p_expected_revision is null or p_list_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_task.revision <> p_expected_revision then
      return query select 'conflict', v_task.revision;
      return;
    end if;
    if not private.usable_task_list(p_list_id, v_task.owner_user_id, v_task.owner_home_id) then
      return query select 'list_unavailable', null::integer;
      return;
    end if;
    if v_task.list_id = p_list_id then
      return query select 'saved', v_task.revision;
      return;
    end if;
    update private.tasks t
      set list_id = p_list_id, detached = t.series_root_id is not null,
        revision = t.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where t.id = v_task.id
      returning * into v_task;
    return query select 'saved', v_task.revision;
  end
  $$;

-- Archiving or deleting a list that an active series creates occurrences into answers 'has_series'
-- with how many (the person moves or ends those series first), like open tasks. Otherwise as S18.

-- Renames, archives or unarchives a list (task managers). Outcomes: 'saved' (with the new revision),
-- 'conflict' (with the current one), 'duplicate_name', 'has_open_tasks' (archiving a list that still
-- has open tasks: move, complete or delete them first), 'not_found', 'not_permitted'.
create or replace function public.update_task_list(
  p_list_id uuid, p_expected_revision integer, p_name text, p_archived boolean
) returns table (outcome text, revision integer, open_tasks integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.task_lists;
    v_open integer;
  begin
    if p_list_id is null or p_expected_revision is null or p_archived is null or p_name is null
       or not private.is_visible_name(p_name, private.task_limit('list_name')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The context lock first, then the row: the same order as reorder_task_lists and create, so
    -- a rename and a reorder of the same context queue instead of deadlocking.
    select * into v_list from private.task_lists l where l.id = p_list_id;
    if found and private.in_task_context(v_list.owner_user_id, v_list.owner_home_id, v_user_id) then
      perform private.lock_task_context('task_lists', v_list.owner_home_id, v_list.owner_user_id);
    end if;
    v_list := private.lock_task_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::integer, null::integer;
      return;
    end if;
    if not private.can_manage_tasks(v_list.owner_user_id, v_list.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::integer, null::integer;
      return;
    end if;
    if v_list.revision <> p_expected_revision then
      return query select 'conflict', v_list.revision, null::integer;
      return;
    end if;
    if p_name <> v_list.name then
      if private.task_list_name_taken(
        v_list.owner_home_id, coalesce(v_list.owner_user_id, v_user_id), p_name, v_list.id
      ) then
        return query select 'duplicate_name', null::integer, null::integer;
        return;
      end if;
    end if;
    if p_archived and v_list.archived_at is null then
      -- The list row is locked, so a task created or moved into it meanwhile has committed or waits.
      select count(*)::integer into v_open from private.tasks t
        where t.list_id = v_list.id and t.deleted_at is null and t.completed_at is null;
      if v_open > 0 then
        return query select 'has_open_tasks', null::integer, v_open;
        return;
      end if;
      -- A series creating occurrences into it would have nowhere to put them (S19).
      select count(*)::integer into v_open from private.task_series s
        where s.list_id = v_list.id and s.superseded_at is null and s.deleted_at is null
          and s.next_date is not null;
      if v_open > 0 then
        return query select 'has_series', null::integer, v_open;
        return;
      end if;
    end if;
    update private.task_lists l
      set name = p_name,
        archived_at = case when p_archived then coalesce(l.archived_at, pg_catalog.now()) end,
        revision = l.revision + 1, updated_at = pg_catalog.now()
      where l.id = v_list.id
      returning * into v_list;
    perform private.audit_task('task_list.updated', v_list.owner_home_id, 'task_list', v_list.id,
      pg_catalog.jsonb_build_object('archived', p_archived));
    return query select 'saved', v_list.revision, null::integer;
  end
  $$;

-- Moves a list to the trash (task managers), only when no active task is in it: the impact review
-- asks the person to move or delete its tasks first, so no task is silently hidden. Outcomes:
-- 'deleted' (with the trash entry), 'conflict', 'has_tasks' (with the count), 'not_found',
-- 'not_permitted'.
create or replace function public.delete_task_list(p_list_id uuid, p_expected_revision integer)
returns table (outcome text, entry_id uuid, active_tasks integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.task_lists;
    v_active integer;
  begin
    if p_list_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_task_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::uuid, null::integer;
      return;
    end if;
    if not private.can_manage_tasks(v_list.owner_user_id, v_list.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::uuid, null::integer;
      return;
    end if;
    if v_list.revision <> p_expected_revision then
      return query select 'conflict', null::uuid, null::integer;
      return;
    end if;
    select count(*)::integer into v_active from private.tasks t
      where t.list_id = v_list.id and t.deleted_at is null;
    if v_active > 0 then
      return query select 'has_tasks', null::uuid, v_active;
      return;
    end if;
    select count(*)::integer into v_active from private.task_series s
      where s.list_id = v_list.id and s.superseded_at is null and s.deleted_at is null
        and s.next_date is not null;
    if v_active > 0 then
      return query select 'has_series', null::uuid, v_active;
      return;
    end if;
    update private.task_lists l set deleted_at = pg_catalog.now() where l.id = v_list.id;
    return query select 'deleted',
      private.trash_move(v_user_id, 'tasks', 'task_list', v_list.id, v_list.owner_user_id,
        v_list.owner_home_id, v_list.name),
      null::integer;
  end
  $$;

-- Reading: a task's series, and whether a row repeats -----------------------------------------------

-- One task with everything its detail page shows, or null when it is missing, deleted or not the
-- caller's to see. People are membership ids (null: departed, or the Personal space) and "is me".
create or replace function public.get_task(p_task_id uuid, p_today date default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_list private.task_lists;
    v_home uuid;
    v_today date;
    v_head private.task_series;
  begin
    if p_task_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return null;
    end if;
    select * into v_list from private.task_lists l where l.id = v_task.list_id;
    v_home := v_task.owner_home_id;
    v_today := private.task_today(v_home, p_today);
    if v_task.series_root_id is not null then
      select * into v_head from private.task_series s
        where s.root_id = v_task.series_root_id and s.superseded_at is null and s.deleted_at is null;
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_task.id,
      'homeId', v_home,
      'list', pg_catalog.jsonb_build_object('id', v_list.id, 'name', v_list.name,
        'archived', v_list.archived_at is not null),
      'title', v_task.title,
      'description', v_task.description,
      'startDate', v_task.start_date,
      'dueDate', v_task.due_date,
      'priority', v_task.priority,
      'revision', v_task.revision,
      'needsReassignment', v_task.needs_reassignment,
      'overdue', v_task.completed_at is null and coalesce(v_task.due_date < v_today, false),
      'upcoming', v_task.completed_at is null and coalesce(v_task.start_date > v_today, false),
      'createdAt', v_task.created_at,
      'createdBy', pg_catalog.jsonb_build_object('me', coalesce(v_task.created_by = v_user_id, false),
        'member', private.member_ref(v_home, v_task.created_by)),
      'updatedAt', v_task.updated_at,
      'updatedBy', pg_catalog.jsonb_build_object('me', coalesce(v_task.updated_by = v_user_id, false),
        'member', private.member_ref(v_home, v_task.updated_by)),
      'completedAt', v_task.completed_at,
      'completedBy', case when v_task.completed_at is not null then pg_catalog.jsonb_build_object(
        'me', coalesce(v_task.completed_by = v_user_id, false),
        'member', private.member_ref(v_home, v_task.completed_by)) end,
      'reopenedAt', v_task.reopened_at,
      'reopenedBy', case when v_task.reopened_at is not null then pg_catalog.jsonb_build_object(
        'me', coalesce(v_task.reopened_by = v_user_id, false),
        'member', private.member_ref(v_home, v_task.reopened_by)) end,
      'assignees', coalesce((select pg_catalog.jsonb_agg(m.id order by m.created_at, m.id)
        from private.task_assignees a
        join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
        where a.task_id = v_task.id), '[]'::jsonb),
      'labels', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', l.id, 'name', l.name, 'color', l.color) order by private.task_name_key(l.name), l.id)
        from private.task_label_links k join private.task_labels l on l.id = k.label_id
        where k.task_id = v_task.id), '[]'::jsonb),
      'subtasks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', s.id, 'title', s.title, 'completed', s.completed_at is not null,
          'revision', s.revision) order by s.position, s.created_at, s.id)
        from private.subtasks s where s.task_id = v_task.id), '[]'::jsonb),
      'commentCount', (select count(*) from private.task_comments c where c.task_id = v_task.id),
      -- S19: the series this occurrence belongs to (its head), or null for a one-off task or when
      -- the series was removed. The occurrence's own scheduled date stays even if its due date moved.
      'occurrenceDate', v_task.occurrence_date,
      'series', case when v_head.id is not null then pg_catalog.jsonb_build_object(
        'revision', v_head.revision,
        'frequency', v_head.frequency,
        'interval', v_head.interval_count,
        'weekdays', pg_catalog.to_jsonb(v_head.weekdays),
        'startsOn', v_head.starts_on,
        'endsOn', v_head.ends_on,
        'count', v_head.max_count,
        'startOffset', v_head.start_offset,
        'listId', v_head.list_id,
        'paused', v_head.paused_at is not null,
        'ended', v_head.next_date is null and v_head.paused_at is null,
        -- The next open occurrence after today, or the next date still to be created.
        'nextDate', coalesce((select min(t.occurrence_date) from private.tasks t
          where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
            and t.occurrence_date > v_today), v_head.next_date),
        'inHead', v_task.series_id is not distinct from v_head.id,
        'detached', v_task.detached,
        'needsReassignment', v_head.needs_reassignment,
        'assignees', coalesce((select pg_catalog.jsonb_agg(m.id order by m.created_at, m.id)
          from private.task_series_assignees a
          join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
          where a.series_id = v_head.id), '[]'::jsonb),
        'checklistSize', (select count(*) from private.task_series_subtasks s where s.series_id = v_head.id),
        'can', pg_catalog.jsonb_build_object(
          'edit', private.can_edit_series(v_head, v_user_id),
          'assign', v_home is not null and private.can_manage_tasks(null, v_home, v_user_id),
          'delete', private.can_edit_series(v_head, v_user_id))) end,
      'can', pg_catalog.jsonb_build_object(
        'edit', private.can_edit_task(v_task, v_user_id),
        'complete', private.can_edit_task(v_task, v_user_id),
        'assign', v_home is not null and private.can_manage_tasks(null, v_home, v_user_id),
        'delete', private.can_delete_task(v_task, v_user_id),
        'comment', true)
    );
  end
  $$;

-- Rows say whether they are an occurrence of a series ("Repeats"). The result type changes, so the
-- S18 function is dropped and created again; otherwise unchanged.
drop function public.list_tasks(uuid, uuid, date, text, text, boolean, text[], uuid[], text, uuid, text, integer, integer);

-- One page of the context's tasks (p_list_id null: All Tasks, every active list), filtered and
-- sorted, with the filtered total. Only small fields: the details come from get_task.
--   p_status: 'open', 'completed' or 'all'. p_when: 'any', 'upcoming' (open, start after today),
--   'active' (open, started or no start, not overdue), 'overdue' (open, due before today).
--   p_hide_future: leaves out open tasks that start after today (not with 'upcoming').
--   p_priorities: any of 'low', 'normal', 'high', 'urgent', 'unset'. p_label_ids: any of them.
--   p_assignee: 'any', 'me', 'unassigned', 'needs_reassignment' or 'member' (p_assignee_member).
--   p_sort: 'due', 'priority_desc', 'priority_asc' or 'created'; ties by due date, creation, id.
create function public.list_tasks(
  p_home_id uuid default null, p_list_id uuid default null, p_today date default null,
  p_status text default 'open', p_when text default 'any', p_hide_future boolean default false,
  p_priorities text[] default null, p_label_ids uuid[] default null,
  p_assignee text default 'any', p_assignee_member uuid default null,
  p_sort text default 'due', p_limit integer default 50, p_offset integer default 0
) returns table (
  id uuid, list_id uuid, list_name text, title text, start_date date, due_date date,
  priority text, completed_at timestamptz, needs_reassignment boolean, overdue boolean,
  upcoming boolean, subtasks_done integer, subtasks_total integer, comment_count integer,
  label_ids uuid[], assignee_member_ids uuid[], assigned_to_me boolean, can_complete boolean,
  revision integer, total_count integer, recurring boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_member_user uuid;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_status is null or p_status not in ('open', 'completed', 'all')
       or p_when is null or p_when not in ('any', 'upcoming', 'active', 'overdue')
       or p_assignee is null or p_assignee not in ('any', 'me', 'unassigned', 'needs_reassignment', 'member')
       or (p_assignee = 'member') <> (p_assignee_member is not null)
       or p_sort is null or p_sort not in ('due', 'priority_desc', 'priority_asc', 'created')
       or p_limit is null or p_limit not between 1 and private.task_limit('page')
       or p_offset is null or p_offset not between 0 and private.task_limit('max_offset')
       or (p_priorities is not null and not (p_priorities <@ array['low', 'normal', 'high', 'urgent', 'unset']))
       or coalesce(cardinality(p_label_ids), 0) > private.task_limit('labels') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, p_today);
    if p_assignee = 'member' then
      select m.user_id into v_member_user from public.home_memberships m
        where m.home_id = p_home_id and m.id = p_assignee_member;
      -- A member who is not (or no longer) in this Home is assigned to nothing.
      v_member_user := coalesce(v_member_user, '00000000-0000-0000-0000-000000000000');
    end if;
    return query
      with base as (
        select t.*, l.name as l_name, t as t_row
        from private.tasks t
        join private.task_lists l on l.id = t.list_id
        where ((p_home_id is null and t.owner_user_id = v_user_id) or t.owner_home_id = p_home_id)
          and t.deleted_at is null and l.deleted_at is null
          and (case when p_list_id is null then l.archived_at is null else l.id = p_list_id end)
          and (p_status = 'all' or (p_status = 'open') = (t.completed_at is null))
          and (p_when = 'any' or (t.completed_at is null and case p_when
            when 'upcoming' then t.start_date > v_today
            when 'active' then (t.start_date is null or t.start_date <= v_today)
              and not coalesce(t.due_date < v_today, false)
            when 'overdue' then t.due_date < v_today
          end))
          and (not coalesce(p_hide_future, false) or p_when = 'upcoming' or t.completed_at is not null
            or not coalesce(t.start_date > v_today, false))
          and (p_priorities is null or coalesce(t.priority, 'unset') = any (p_priorities))
          and (coalesce(cardinality(p_label_ids), 0) = 0 or exists (
            select 1 from private.task_label_links k where k.task_id = t.id and k.label_id = any (p_label_ids)))
          and (case p_assignee
            when 'any' then true
            when 'me' then private.is_task_assignee(t.id, v_user_id)
            when 'unassigned' then not exists (select 1 from private.task_assignees a where a.task_id = t.id)
            when 'needs_reassignment' then t.needs_reassignment
            when 'member' then private.is_task_assignee(t.id, v_member_user)
          end)
      ), page as (
        select b.*, count(*) over ()::integer as total
        from base b
        order by
          case when p_sort = 'priority_desc' then private.task_priority_rank(b.priority) end desc,
          case when p_sort = 'priority_asc' then private.task_priority_rank(b.priority) end asc,
          case when p_sort = 'created' then b.created_at end desc,
          b.due_date asc nulls last, b.created_at asc, b.id asc
        limit p_limit offset p_offset
      )
      select p.id, p.list_id, p.l_name, p.title, p.start_date, p.due_date, p.priority, p.completed_at,
        p.needs_reassignment,
        p.completed_at is null and coalesce(p.due_date < v_today, false),
        p.completed_at is null and coalesce(p.start_date > v_today, false),
        (select count(*)::integer from private.subtasks s where s.task_id = p.id and s.completed_at is not null),
        (select count(*)::integer from private.subtasks s where s.task_id = p.id),
        (select count(*)::integer from private.task_comments c where c.task_id = p.id),
        coalesce((select array_agg(k.label_id order by k.label_id) from private.task_label_links k
          where k.task_id = p.id), '{}'),
        -- Oldest membership first, as in get_task, so every view lists assignees alike.
        coalesce((select array_agg(m.id order by m.created_at, m.id) from private.task_assignees a
          join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
          where a.task_id = p.id), '{}'),
        private.is_task_assignee(p.id, v_user_id),
        private.can_edit_task(p.t_row, v_user_id),
        p.revision, p.total, p.series_root_id is not null
      from page p
      order by
        case when p_sort = 'priority_desc' then private.task_priority_rank(p.priority) end desc,
        case when p_sort = 'priority_asc' then private.task_priority_rank(p.priority) end asc,
        case when p_sort = 'created' then p.created_at end desc,
        p.due_date asc nulls last, p.created_at asc, p.id asc;
  end
  $$;

-- Trash: series removals ------------------------------------------------------------------------------

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in ('sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal'));

create or replace function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_kind
    when 'slot_taken' then array['clear_slot']
    when 'parent_unavailable' then array['detach_parent']
    -- The person picks another active list of the same context (argument: its id).
    when 'list_unavailable' then array['move_to_list']
    -- A removed series changed since (edited, split, paused, removed again): bring back only the
    -- removed occurrences and leave the series as it is now.
    when 'series_changed' then array['restore_tasks_only']
    else array[]::text[]
  end;
  $$;

-- The four dispatch functions again, with the case for a series removal. Its conflicts: a removed
-- occurrence's list (or the series' list) is gone or archived (move_to_list:<id>), or the series
-- changed since (restore_tasks_only). Task and list cases unchanged from S18.
create or replace function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_sample private.trash_samples;
    v_task private.tasks;
    v_removal private.task_series_removals;
    v_head private.task_series;
  begin
    case p_entry.item_type
      when 'sample' then
        select * into v_sample from private.trash_samples s where s.id = p_entry.subject_id;
        if not found then
          return 'item_missing';
        end if;
        if v_sample.parent_id is not null and exists (
          select 1 from private.trash_samples p
          where p.id = v_sample.parent_id and p.deleted_at is not null
        ) then
          return 'parent_unavailable';
        end if;
        if v_sample.slot is not null and exists (
          select 1 from private.trash_samples o
          where o.id <> v_sample.id and o.deleted_at is null and o.slot = v_sample.slot
            and o.owner_user_id is not distinct from v_sample.owner_user_id
            and o.owner_home_id is not distinct from v_sample.owner_home_id
        ) then
          return 'slot_taken';
        end if;
        return null;
      when 'dashboard_template' then
        if not exists (
          select 1 from private.dashboard_templates t
          where t.id = p_entry.subject_id and t.deleted_at is not null
        ) then
          return 'item_missing';
        end if;
        return null;
      when 'task' then
        select * into v_task from private.tasks t where t.id = p_entry.subject_id;
        if not found or v_task.deleted_at is null then
          return 'item_missing';
        end if;
        if v_task.list_id is null or not exists (
          select 1 from private.task_lists l
          where l.id = v_task.list_id and l.deleted_at is null and l.archived_at is null
        ) then
          return 'list_unavailable';
        end if;
        return null;
      when 'task_list' then
        if not exists (
          select 1 from private.task_lists l where l.id = p_entry.subject_id and l.deleted_at is not null
        ) then
          return 'item_missing';
        end if;
        return null;
      when 'task_series_removal' then
        -- Removed occurrences need an active list, like a task; then the series must be as the
        -- removal left it (unless the person chose to bring back only the occurrences).
        select * into v_removal from private.task_series_removals r where r.id = p_entry.subject_id;
        if not found then
          return 'item_missing';
        end if;
        if not v_removal.tasks_only then
          select * into v_head from private.task_series s where s.id = v_removal.head_id;
        end if;
        if exists (
          select 1 from private.tasks t
          where t.id = any (v_removal.task_ids) and t.deleted_at is not null
            and (t.list_id is null or not exists (
              select 1 from private.task_lists l
              where l.id = t.list_id and l.deleted_at is null and l.archived_at is null))
        ) or (v_head.id is not null and (v_head.list_id is null or not exists (
          select 1 from private.task_lists l
          where l.id = v_head.list_id and l.deleted_at is null and l.archived_at is null))) then
          return 'list_unavailable';
        end if;
        if not v_removal.tasks_only
           and (v_head.id is null or v_head.revision <> v_removal.head_revision
             or v_head.superseded_at is not null) then
          return 'series_changed';
        end if;
        return null;
    end case;
    return null;
  end
  $$;

create or replace function private.trash_resolve(p_entry private.trash_entries, p_resolution text)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_arg text := pg_catalog.split_part(p_resolution, ':', 2);
    v_task private.tasks;
  begin
    case p_entry.item_type
      when 'sample' then
        if p_resolution = 'clear_slot' then
          update private.trash_samples s set slot = null where s.id = p_entry.subject_id;
        elsif p_resolution = 'detach_parent' then
          update private.trash_samples s set parent_id = null where s.id = p_entry.subject_id;
        end if;
      when 'dashboard_template' then
        -- No conflicts, so nothing to resolve.
        null;
      when 'task' then
        -- Only an active, unarchived list of the task's own context; anything else leaves the task
        -- as it is, so the conflict is reported again.
        if pg_catalog.split_part(p_resolution, ':', 1) = 'move_to_list'
           and v_arg ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          select * into v_task from private.tasks t where t.id = p_entry.subject_id for update;
          if found and exists (
            select 1 from private.task_lists l
            where l.id = v_arg::uuid and l.deleted_at is null and l.archived_at is null
              and l.owner_user_id is not distinct from v_task.owner_user_id
              and l.owner_home_id is not distinct from v_task.owner_home_id
          ) then
            update private.tasks t set list_id = v_arg::uuid where t.id = v_task.id;
          end if;
        end if;
      when 'task_list' then
        null;
      when 'task_series_removal' then
        if p_resolution = 'restore_tasks_only' then
          update private.task_series_removals r set tasks_only = true where r.id = p_entry.subject_id;
        elsif pg_catalog.split_part(p_resolution, ':', 1) = 'move_to_list'
           and v_arg ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          -- The removed occurrences whose list is gone move to the chosen active list of their
          -- context; so does the series, when its own list is gone.
          update private.tasks t set list_id = v_arg::uuid
            from private.task_series_removals r
            where r.id = p_entry.subject_id and t.id = any (r.task_ids) and t.deleted_at is not null
              and exists (
                select 1 from private.task_lists l
                where l.id = v_arg::uuid and l.deleted_at is null and l.archived_at is null
                  and l.owner_user_id is not distinct from t.owner_user_id
                  and l.owner_home_id is not distinct from t.owner_home_id)
              and (t.list_id is null or not exists (
                select 1 from private.task_lists u
                where u.id = t.list_id and u.deleted_at is null and u.archived_at is null));
          update private.task_series s set list_id = v_arg::uuid
            from private.task_series_removals r
            where r.id = p_entry.subject_id and s.root_id = r.root_id
              and exists (
                select 1 from private.task_lists l
                where l.id = v_arg::uuid and l.deleted_at is null and l.archived_at is null
                  and l.owner_user_id is not distinct from s.owner_user_id
                  and l.owner_home_id is not distinct from s.owner_home_id)
              and (s.list_id is null or not exists (
                select 1 from private.task_lists u
                where u.id = s.list_id and u.deleted_at is null and u.archived_at is null));
        end if;
    end case;
  end
  $$;

create or replace function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
    v_lost integer := 0;
    v_lost_ids uuid[] := '{}';
    v_ref uuid;
    v_task private.tasks;
    v_removal private.task_series_removals;
    v_head private.task_series;
  begin
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id
      order by ef.file_id
    loop
      if not private.restore_file(v_file_id) then
        v_lost := v_lost + 1;
        v_lost_ids := v_lost_ids || v_file_id;
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        -- The file the item uses must be usable too: it may have gone to the trash with another
        -- item that shared it (the last one deleted takes it along).
        select s.file_id into v_ref from private.trash_samples s where s.id = p_entry.subject_id;
        if v_ref is not null and not (v_ref = any (v_lost_ids)) and not private.restore_file(v_ref) then
          v_lost := v_lost + 1;
          v_lost_ids := v_lost_ids || v_ref;
        end if;
        update private.trash_samples s
          set deleted_at = null,
            -- A reference to a file that is gone would be broken: drop it, the caller reports it.
            file_id = case when s.file_id = any (v_lost_ids) then null else s.file_id end
          where s.id = p_entry.subject_id;
      when 'dashboard_template' then
        -- Its shares come back with it; a share into a Home the owner has since left was already
        -- ended by home_memberships_end_template_shares.
        update private.dashboard_templates t set deleted_at = null, updated_at = pg_catalog.now()
          where t.id = p_entry.subject_id;
      when 'task' then
        -- Its subtasks, comments, labels and assignees never left it. Its list is locked for share
        -- and checked again: a list deleted or archived since the conflict check makes this a
        -- conflict (reported as one by the caller, which turns a unique violation into
        -- needs_resolution), so no active task can end up in an unusable list.
        select * into v_task from private.tasks t where t.id = p_entry.subject_id for update;
        if v_task.list_id is null
           or not private.usable_task_list(v_task.list_id, v_task.owner_user_id, v_task.owner_home_id) then
          raise exception 'task list unavailable' using errcode = '23505';
        end if;
        update private.tasks t set deleted_at = null where t.id = v_task.id;
      when 'task_list' then
        update private.task_lists l set deleted_at = null, updated_at = pg_catalog.now()
          where l.id = p_entry.subject_id;
      when 'task_series_removal' then
        -- The removed occurrences come back (each one's list locked for share and checked, as for a
        -- task); then, unless only the occurrences were asked for, the series as before the removal,
        -- creating again from today (dates that passed meanwhile are not created).
        select * into v_removal from private.task_series_removals r where r.id = p_entry.subject_id;
        for v_task in
          select * from private.tasks t
          where t.id = any (v_removal.task_ids) and t.deleted_at is not null
          order by t.id for update
        loop
          if v_task.list_id is null
             or not private.usable_task_list(v_task.list_id, v_task.owner_user_id, v_task.owner_home_id) then
            raise exception 'task list unavailable' using errcode = '23505';
          end if;
          update private.tasks t set deleted_at = null where t.id = v_task.id;
        end loop;
        if not v_removal.tasks_only then
          select * into v_head from private.task_series s where s.id = v_removal.head_id for update;
          if v_head.id is null or v_head.revision <> v_removal.head_revision
             or not private.usable_task_list(v_head.list_id, v_head.owner_user_id, v_head.owner_home_id) then
            raise exception 'series changed' using errcode = '23505';
          end if;
          if v_removal.mode = 'series' then
            update private.task_series s set deleted_at = null
              where s.root_id = v_removal.root_id and s.deleted_at is not null;
          end if;
          update private.task_series s
            set until_date = v_removal.previous_until_date, revision = s.revision + 1,
              updated_at = pg_catalog.now()
            where s.id = v_head.id
            returning * into v_head;
          update private.task_series s
            set next_date = private.series_next(v_head, private.task_today(v_head.owner_home_id, null))
            where s.id = v_head.id
            returning * into v_head;
        end if;
    end case;
    return v_lost;
  end
  $$;

create or replace function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
  begin
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id
      order by ef.file_id
    loop
      -- Never release a file another active item still uses.
      if not exists (
        select 1 from private.trash_samples s where s.file_id = v_file_id and s.deleted_at is null
      ) then
        perform private.purge_file_now(v_file_id);
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        delete from private.trash_samples s where s.id = p_entry.subject_id and s.deleted_at is not null;
      when 'dashboard_template' then
        -- Its shares go with it (on delete cascade).
        delete from private.dashboard_templates t
          where t.id = p_entry.subject_id and t.deleted_at is not null;
      when 'task' then
        -- Subtasks, comments, label links and assignees go with it (on delete cascade).
        delete from private.tasks t where t.id = p_entry.subject_id and t.deleted_at is not null;
      when 'task_list' then
        -- Tasks of this list still in the trash lose their list (on delete set null); restoring one
        -- then asks for another list.
        delete from private.task_lists l where l.id = p_entry.subject_id and l.deleted_at is not null;
      when 'task_series_removal' then
        -- The removed occurrences still in the trash go (with their checklists and comments). A
        -- removed series whose definition is still deleted goes too; its completed occurrences stay
        -- as completed tasks without a series.
        delete from private.tasks t
          using private.task_series_removals r
          where r.id = p_entry.subject_id and t.id = any (r.task_ids) and t.deleted_at is not null;
        if exists (
          select 1 from private.task_series_removals r
          join private.task_series s on s.root_id = r.root_id
          where r.id = p_entry.subject_id and r.mode = 'series' and s.deleted_at is not null
        ) then
          update private.tasks t
            set series_id = null, series_root_id = null, occurrence_date = null
            from private.task_series_removals r
            where r.id = p_entry.subject_id and t.series_root_id = r.root_id;
          delete from private.task_series s
            using private.task_series_removals r
            where r.id = p_entry.subject_id and s.root_id = r.root_id;
        end if;
        delete from private.task_series_removals r where r.id = p_entry.subject_id;
    end case;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.advance_task_series(uuid, date)',
    'public.create_task_series(uuid, uuid, text, text, integer, date, smallint[], date, integer, text, integer, text, uuid[], uuid[], uuid, date)',
    'public.update_task_series(uuid, text, integer, integer, boolean, boolean, text, text, text, uuid[], integer, boolean, uuid, uuid[], boolean, text, integer, smallint[], date, date, integer, date)',
    'public.delete_task_series(uuid, text, integer, boolean)',
    'public.set_task_series_paused(uuid, boolean, integer, date)',
    'public.list_task_occurrences(uuid, text, integer, integer, date, text)',
    'public.list_tasks(uuid, uuid, date, text, text, boolean, text[], uuid[], text, uuid, text, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.task_limit(text)',
    'private.flag_departed_series_assignments()',
    'private.series_month_date(date, integer)',
    'private.series_first_on_or_after(text, integer, smallint[], date, date)',
    'private.valid_series_rule(text, integer, smallint[], date, date, integer)',
    'private.series_until(text, integer, smallint[], date, date, integer)',
    'private.series_next(private.task_series, date)',
    'private.series_has_date(private.task_series, date)',
    'private.series_dates(private.task_series, date, integer)',
    'private.can_edit_series(private.task_series, uuid)',
    'private.lock_series_head(uuid)',
    'private.occurrence_touched(private.tasks)',
    'private.create_occurrence(private.task_series, date)',
    'private.advance_series(private.task_series, date)',
    'private.set_series_template(uuid, uuid, uuid[], uuid[], text[])',
    'private.trash_conflict_options(text)',
    'private.trash_conflict(private.trash_entries)',
    'private.trash_resolve(private.trash_entries, text)',
    'private.trash_item_restore(private.trash_entries)',
    'private.trash_item_purge(private.trash_entries)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
