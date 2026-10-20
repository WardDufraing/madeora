-- S19b: task reminders, task templates and bulk task actions (brief plans/steps/S19b-brief.md;
-- ADR 0024; spec "Confirmed individual task reminders", "Confirmed reusable task templates",
-- "Confirmed basic bulk task actions", "Confirmed global adult notification defaults with per-Home
-- overrides").
--
-- Reminders. At most one per task (private.task_reminders): at a wall-clock date and time, or N days
-- before the due date at a chosen time (tasks are date-only, so the time is always the person's
-- choice). A Home task's reminder uses the Home's timezone; a Personal task's the person's effective
-- timezone, which the app passes. Setting one enqueues the task-reminder job in the S13 outbox for
-- that instant; the job calls deliver_task_reminder, which re-checks everything at delivery and
-- notifies through private.notify_user (category 'reminders'), so preferences, Home overrides,
-- quiet hours and dedupe are the S14 ones. Every change bumps the reminder's revision, and a job
-- for an older revision does nothing. A changed or removed due date puts a before-due reminder on
-- hold ('needs_review') until the person moves it with the due date or removes it.
--
-- Recurring series have an optional before-due reminder template per chain
-- (private.task_series_reminders), copied onto every new occurrence. Changing it on an occurrence
-- takes the S19 scopes; occurrences given their own reminder ('this occurrence') keep it. A series
-- with a template creates occurrences early enough for their reminder (today + days before + 1),
-- and an hourly job advances those series (advance_reminder_series).
--
-- Templates (private.task_templates): reusable task content owned by a Personal space or a Home.
-- Creating a task from one is one transaction with its whole checklist.
--
-- Bulk actions (bulk_update_tasks): complete, priority, labels, move, each task in its own
-- sub-transaction under the S18 per-task rules, with per-task results and a dry run.
--
-- DST: a wall-clock time is turned into an instant by PostgreSQL's rule: a time inside a
-- spring-forward gap moves forward by the gap, a repeated time is the later (standard-time) one. The
-- app shows the server's resolved time, and says when either case applied (private.zoned_dst_case).

-- Audit subject, limits ------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template'
  ));

-- apps/web/src/tasks/schema.ts uses the same numbers.
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
    when 'reminder_days' then 30       -- "N days before the due date" (S19b)
    when 'templates' then 100          -- templates per context
    when 'template_name' then 60
    when 'bulk' then 100               -- tasks one bulk action changes
  end;
  $$;

-- Notifications: the optional category 'reminders' ---------------------------------------------------

create or replace function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category
    when 'security' then true when 'storage' then true
    when 'invitations' then false when 'reminders' then false
  end;
  $$;

alter table public.notifications drop constraint notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('security', 'invitations', 'storage', 'reminders'));

alter table public.notification_preferences drop constraint notification_preferences_category_check;
alter table public.notification_preferences add constraint notification_preferences_category_check
  check (category in ('invitations', 'reminders'));

-- The optional categories a person can configure (packages/domain optionalNotificationCategories).
create function private.notification_category_optional(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_category in ('invitations', 'reminders'), false);
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
      cross join (values ('invitations'), ('reminders')) c (category)
      cross join (values ('in_app'), ('email')) ch (channel)
      order by s.home_id nulls first, c.category, ch.channel;
  end
  $$;

create or replace function public.set_notification_preference(
  p_category text, p_channel text, p_enabled boolean, p_home_id uuid default null
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.notification_category_optional(p_category) or p_channel not in ('in_app', 'email')
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

create or replace function public.reset_notification_preference(
  p_category text, p_channel text, p_home_id uuid default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.notification_category_optional(p_category) or p_channel not in ('in_app', 'email') then
      raise exception 'invalid notification preference' using errcode = '22023';
    end if;
    delete from public.notification_preferences p
      where p.user_id = v_user_id and p.home_id is not distinct from p_home_id
        and p.category = p_category and p.channel = p_channel;
    return found;
  end
  $$;

-- Tables -----------------------------------------------------------------------------------------------

-- A task's reminder. status: 'scheduled' (waiting for its time), 'needs_review' (a before-due
-- reminder whose due date changed or went: not delivered until the person decides), 'sent',
-- 'not_sent' (its time came while the task was completed, deleted or had nobody to remind, or an
-- occurrence was created after its time), 'off' (an occurrence whose own choice is "no reminder",
-- so a later series change leaves it alone). own: chosen on this task ('this occurrence', or any
-- task that is not an occurrence); false: copied from its series' template.
create table private.task_reminders (
  task_id uuid primary key references private.tasks (id) on delete cascade,
  mode text constraint task_reminders_mode_check check (mode in ('absolute', 'relative')),
  -- absolute: the wall-clock date and time as entered, in time_zone.
  local_at timestamp,
  -- relative: days before the due date, at this wall-clock time in time_zone.
  days_before smallint constraint task_reminders_days_check check (days_before between 0 and 30),
  time_of_day time,
  time_zone text constraint task_reminders_zone_check
    check (char_length(time_zone) <= 64
      and time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  fire_at timestamptz,
  status text not null constraint task_reminders_status_check
    check (status in ('scheduled', 'needs_review', 'sent', 'not_sent', 'off')),
  own boolean not null default true,
  revision integer not null default 1 constraint task_reminders_revision_check check (revision >= 1),
  set_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  constraint task_reminders_shape_check check (
    (status = 'off' and mode is null and local_at is null and days_before is null
      and time_of_day is null and fire_at is null)
    or (mode = 'absolute' and local_at is not null and days_before is null and time_of_day is null
      and time_zone is not null)
    or (mode = 'relative' and local_at is null and days_before is not null and time_of_day is not null
      and time_zone is not null)
  ),
  constraint task_reminders_fire_check check (status <> 'scheduled' or fire_at is not null)
);

-- A chain's before-due reminder template (one per series root, so S19 splits keep it). Never
-- deleted while the chain exists: "off" is days_before null, so its revision only grows.
create table private.task_series_reminders (
  root_id uuid primary key,
  days_before smallint constraint task_series_reminders_days_check check (days_before between 0 and 30),
  time_of_day time,
  time_zone text constraint task_series_reminders_zone_check
    check (char_length(time_zone) <= 64
      and time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'),
  revision integer not null default 1 constraint task_series_reminders_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint task_series_reminders_shape_check check (
    (days_before is null and time_of_day is null)
    or (days_before is not null and time_of_day is not null and time_zone is not null)
  )
);

-- Whether every checklist title is a visible name within the limit.
create function private.valid_subtask_titles(p_titles text[]) returns boolean
  language sql immutable set search_path = '' as $$
  select p_titles is not null
    and coalesce(cardinality(p_titles), 0) <= private.task_limit('subtasks')
    and not exists (
      select 1 from unnest(p_titles) as x
      where x is null or not private.is_visible_name(x, private.task_limit('title'))
    );
  $$;

-- Reusable task content, owned by one Personal space or Home (spec "Confirmed reusable task
-- templates"). Label ids have no foreign key on purpose: a label deleted later is left out (and
-- disclosed) when the template is used, never silently recreated.
create table private.task_templates (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  name text not null constraint task_templates_name_check check (private.is_visible_name(name, 60)),
  title text not null constraint task_templates_title_check check (private.is_visible_name(title, 200)),
  description text constraint task_templates_description_check
    check (description is null or private.is_plain_text(description, 5000)),
  priority text constraint task_templates_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent')),
  label_ids uuid[] not null default '{}' constraint task_templates_labels_check
    check (cardinality(label_ids) <= 20),
  subtasks text[] not null default '{}' constraint task_templates_subtasks_check
    check (private.valid_subtask_titles(subtasks)),
  revision integer not null default 1 constraint task_templates_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint task_templates_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create index task_templates_home_idx on private.task_templates (owner_home_id) where owner_home_id is not null;
create index task_templates_user_idx on private.task_templates (owner_user_id) where owner_user_id is not null;

alter table private.task_reminders enable row level security;
alter table private.task_series_reminders enable row level security;
alter table private.task_templates enable row level security;
revoke all on table private.task_reminders, private.task_series_reminders, private.task_templates
  from public, anon, authenticated;

-- Time zones and wall-clock times --------------------------------------------------------------------

create function private.valid_time_zone(p_zone text) returns boolean
  language sql stable set search_path = '' as $$
  select p_zone is not null and char_length(p_zone) <= 64
    and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone);
  $$;

-- Whether a wall-clock time in a zone falls in a spring-forward gap ('gap': it does not exist that
-- day, and PostgreSQL moves it forward by the gap) or happens twice ('overlap': the later, standard
-- time is used); null otherwise. The app says so next to the resolved time.
create function private.zoned_dst_case(p_local timestamp, p_zone text) returns text
  language plpgsql stable set search_path = '' as $$
  declare
    v_at timestamptz;
    v_before interval;
    v_alt timestamptz;
  begin
    if p_local is null or p_zone is null then
      return null;
    end if;
    v_at := p_local at time zone p_zone;
    if (v_at at time zone p_zone) <> p_local then
      return 'gap';
    end if;
    -- The UTC offset three hours earlier; when the same wall-clock time also maps from that offset
    -- to an earlier instant, the time happens twice.
    v_before := ((v_at - interval '3 hours') at time zone p_zone)
      - ((v_at - interval '3 hours') at time zone 'UTC');
    v_alt := (p_local - v_before) at time zone 'UTC';
    if v_alt <> v_at and (v_alt at time zone p_zone) = p_local then
      return 'overlap';
    end if;
    return null;
  end
  $$;

-- The wall-clock time of a before-due reminder.
create function private.reminder_local(p_due date, p_days integer, p_time time) returns timestamp
  language sql immutable set search_path = '' as $$
  select case when p_due is not null and p_days is not null and p_time is not null
    then (p_due - p_days) + p_time end;
  $$;

-- The zone a context's reminders use: the Home's own; for the Personal space the person's effective
-- timezone, which only the app knows (it may be the browser's), passed and checked here.
create function private.reminder_zone(p_home_id uuid, p_zone text) returns text
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null then
      return (select h.timezone from public.homes h where h.id = p_home_id);
    end if;
    if not private.valid_time_zone(p_zone) then
      raise exception 'invalid time zone' using errcode = '22023';
    end if;
    return p_zone;
  end
  $$;

-- Reminders: writing and scheduling -----------------------------------------------------------------

-- Writes a task's reminder (a new revision) and, when its time is still to come, enqueues the
-- task-reminder job for that time. A job for an earlier revision then finds a newer one and does
-- nothing. A time already past is stored as 'not_sent' (an occurrence created late; people cannot
-- choose a past time). Returns the row.
create function private.put_task_reminder(
  p_task_id uuid, p_mode text, p_local_at timestamp, p_days integer, p_time time, p_zone text,
  p_due date, p_own boolean, p_user_id uuid
) returns private.task_reminders
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_local timestamp := case when p_mode = 'absolute' then p_local_at
      else private.reminder_local(p_due, p_days, p_time) end;
    v_fire timestamptz := v_local at time zone p_zone;
    v_status text;
    v_row private.task_reminders;
  begin
    v_status := case
      when v_local is null then 'needs_review'
      when v_fire > pg_catalog.now() then 'scheduled'
      else 'not_sent' end;
    insert into private.task_reminders as r (
      task_id, mode, local_at, days_before, time_of_day, time_zone, fire_at, status, own, set_by
    ) values (
      p_task_id, p_mode, case when p_mode = 'absolute' then p_local_at end,
      case when p_mode = 'relative' then p_days end, case when p_mode = 'relative' then p_time end,
      p_zone, case when v_local is not null then v_fire end, v_status, p_own, p_user_id
    )
    on conflict (task_id) do update
      set mode = excluded.mode, local_at = excluded.local_at, days_before = excluded.days_before,
        time_of_day = excluded.time_of_day, time_zone = excluded.time_zone, fire_at = excluded.fire_at,
        status = excluded.status, own = excluded.own, set_by = excluded.set_by,
        revision = r.revision + 1, updated_at = pg_catalog.now(), delivered_at = null
    returning * into v_row;
    if v_row.status = 'scheduled' then
      perform private.enqueue_job(
        'task-reminder', 1, 'task-reminder:' || p_task_id::text || ':' || v_row.revision::text,
        pg_catalog.jsonb_build_object('taskId', p_task_id, 'revision', v_row.revision),
        private.request_correlation_id(), v_row.fire_at);
    end if;
    return v_row;
  end
  $$;

-- Removes a task's own reminder. An occurrence of a series with a reminder template keeps an 'off'
-- row instead, so a later series change does not give it one again.
create function private.clear_task_reminder(p_task private.tasks, p_user_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_task.series_root_id is not null and exists (
      select 1 from private.task_series_reminders s
      where s.root_id = p_task.series_root_id and s.days_before is not null
    ) then
      insert into private.task_reminders as r (task_id, status, own, set_by)
        values (p_task.id, 'off', true, p_user_id)
        on conflict (task_id) do update
          set mode = null, local_at = null, days_before = null, time_of_day = null, time_zone = null,
            fire_at = null, status = 'off', own = true, set_by = excluded.set_by,
            revision = r.revision + 1, updated_at = pg_catalog.now(), delivered_at = null;
    else
      delete from private.task_reminders r where r.task_id = p_task.id;
    end if;
  end
  $$;

-- A new occurrence starts with its series' reminder (S19 creates occurrences in
-- private.create_occurrence; this trigger keeps that function unchanged).
create function private.copy_series_reminder() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_template private.task_series_reminders;
  begin
    select * into v_template from private.task_series_reminders s
      where s.root_id = new.series_root_id and s.days_before is not null;
    if found then
      perform private.put_task_reminder(new.id, 'relative', null, v_template.days_before,
        v_template.time_of_day, v_template.time_zone, new.due_date, false, v_template.updated_by);
    end if;
    return null;
  end
  $$;

create trigger tasks_copy_series_reminder
  after insert on private.tasks
  for each row when (new.series_root_id is not null)
  execute function private.copy_series_reminder();

-- A changed or removed due date puts a before-due reminder on hold (spec: show the effect and
-- require review rather than silently delivering at an unintended time). The new revision makes
-- any queued job a no-op.
create function private.hold_reminder_on_due_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    update private.task_reminders r
      set status = 'needs_review', fire_at = null, revision = r.revision + 1,
        updated_at = pg_catalog.now()
      where r.task_id = new.id and r.mode = 'relative' and r.status in ('scheduled', 'not_sent');
    return null;
  end
  $$;

create trigger tasks_hold_reminder_on_due_change
  after update of due_date on private.tasks
  for each row when (old.due_date is distinct from new.due_date)
  execute function private.hold_reminder_on_due_change();

-- A chain's template goes when the last part of the chain does (purging an entire-series removal).
create function private.drop_series_reminder() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if not exists (select 1 from private.task_series s where s.root_id = old.root_id) then
      delete from private.task_series_reminders r where r.root_id = old.root_id;
    end if;
    return null;
  end
  $$;

create trigger task_series_drop_reminder
  after delete on private.task_series
  for each row execute function private.drop_series_reminder();

-- Series generation with reminders ------------------------------------------------------------------

-- How many days ahead a chain must create occurrences so that each exists before its reminder:
-- days before + 1 (the extra day covers the hourly advance and zones); 0 without a template.
create function private.series_reminder_lead(p_root_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
  select coalesce((select r.days_before + 1 from private.task_series_reminders r
    where r.root_id = p_root_id and r.days_before is not null), 0);
  $$;

-- S19's advance, now also creating every occurrence up to today + the reminder lead (each then gets
-- its reminder in time). Without a template it behaves exactly as before: up to today plus one.
create or replace function private.advance_series(p_series private.task_series, p_today date) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_next date := p_series.next_date;
    v_last date := p_series.last_date;
    v_created integer := 0;
    v_horizon date;
  begin
    if p_series.id is null or p_series.paused_at is not null or p_series.deleted_at is not null
       or p_series.superseded_at is not null or v_next is null then
      return 0;
    end if;
    if not private.usable_task_list(p_series.list_id, p_series.owner_user_id, p_series.owner_home_id) then
      return 0;
    end if;
    v_horizon := p_today + private.series_reminder_lead(p_series.root_id);
    while v_next is not null and v_created < private.task_limit('series_catch_up')
      and (v_next <= v_horizon or v_last is null or v_last <= p_today) loop
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

create or replace function public.advance_task_series(p_home_id uuid default null, p_today date default null)
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
        and s.next_date is not null
        and (s.last_date is null or s.last_date <= v_today
          or s.next_date <= v_today + private.series_reminder_lead(s.root_id))
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

-- Called hourly by the task-reminder-advance job (service role): advances series with a reminder
-- template whose next occurrence is within reach of its reminder, so reminders arrive even when
-- nobody opens a task page. "Today" is the Home's, or for a Personal series its reminder's zone.
-- At most p_limit series per call, those closest first. Returns how many occurrences it created.
create function public.advance_reminder_series(p_limit integer) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row record;
    v_series private.task_series;
    v_today date;
    v_created integer := 0;
  begin
    if p_limit is null or p_limit not between 1 and 500 then
      raise exception 'invalid limit' using errcode = '22023';
    end if;
    for v_row in
      select s.id, r.time_zone as zone from private.task_series s
      join private.task_series_reminders r on r.root_id = s.root_id and r.days_before is not null
      left join public.homes h on h.id = s.owner_home_id
      where s.superseded_at is null and s.deleted_at is null and s.paused_at is null
        and s.next_date is not null
        and s.next_date <= (pg_catalog.now() at time zone coalesce(h.timezone, r.time_zone))::date
          + r.days_before + 1
      order by s.next_date, s.id
      limit p_limit
    loop
      select * into v_series from private.task_series s where s.id = v_row.id for update;
      if v_series.superseded_at is null and v_series.deleted_at is null then
        v_today := case when v_series.owner_home_id is not null
          then private.task_today(v_series.owner_home_id, null)
          else (pg_catalog.now() at time zone v_row.zone)::date end;
        v_created := v_created + private.advance_series(v_series, v_today);
      end if;
    end loop;
    return v_created;
  end
  $$;

-- Reminders: reading ---------------------------------------------------------------------------------

-- A task's reminder and everything its editor shows, or null when the task is missing, deleted or not
-- the caller's to see: the reminder (with the resolved time and any DST case), the series' template
-- for an occurrence, who will be reminded (membership ids; the Personal space reminds its owner),
-- what the caller may change, and how the caller would receive it here (in-app, email).
create function public.get_task_reminder(p_task_id uuid, p_time_zone text default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_reminder private.task_reminders;
    v_template private.task_series_reminders;
    v_head private.task_series;
    v_recipients uuid[];
    v_assigned boolean;
    v_zone text;
    v_review_local timestamp;
  begin
    select * into v_task from private.tasks t where t.id = p_task_id;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return null;
    end if;
    select * into v_reminder from private.task_reminders r where r.task_id = v_task.id;
    if v_task.series_root_id is not null then
      select * into v_template from private.task_series_reminders s where s.root_id = v_task.series_root_id;
      select * into v_head from private.task_series s
        where s.root_id = v_task.series_root_id and s.superseded_at is null and s.deleted_at is null;
    end if;
    if v_task.owner_home_id is not null then
      select coalesce(array_agg(m.id order by m.created_at, m.id), '{}') into v_recipients
        from private.task_assignees a
        join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
        where a.task_id = v_task.id;
      v_assigned := cardinality(v_recipients) > 0;
      if not v_assigned then
        v_recipients := array_remove(array[private.member_ref(v_task.owner_home_id,
          coalesce(v_reminder.set_by, v_user_id))], null);
      end if;
      v_zone := (select h.timezone from public.homes h where h.id = v_task.owner_home_id);
    else
      v_zone := case when private.valid_time_zone(p_time_zone) then p_time_zone end;
    end if;
    if v_reminder.status = 'needs_review' then
      v_review_local := private.reminder_local(v_task.due_date, v_reminder.days_before, v_reminder.time_of_day);
    end if;
    return pg_catalog.jsonb_build_object(
      'taskId', v_task.id,
      'dueDate', v_task.due_date,
      'completed', v_task.completed_at is not null,
      'recurring', v_task.series_root_id is not null,
      'canEdit', private.can_edit_task(v_task, v_user_id),
      'canEditSeries', case when v_head.id is null then false else private.can_edit_series(v_head, v_user_id) end,
      'timeZone', v_zone,
      'reminder', case when v_reminder.task_id is null then null else pg_catalog.jsonb_build_object(
        'mode', v_reminder.mode,
        'localAt', v_reminder.local_at,
        'daysBefore', v_reminder.days_before,
        'time', pg_catalog.to_char(v_reminder.time_of_day, 'HH24:MI'),
        'timeZone', v_reminder.time_zone,
        'fireAt', v_reminder.fire_at,
        'dst', private.zoned_dst_case(coalesce(v_reminder.local_at,
          private.reminder_local(v_task.due_date, v_reminder.days_before, v_reminder.time_of_day)),
          v_reminder.time_zone),
        'status', v_reminder.status,
        'own', v_reminder.own,
        'revision', v_reminder.revision,
        'reviewFireAt', case when v_review_local is not null then v_review_local at time zone v_reminder.time_zone end,
        'reviewDst', private.zoned_dst_case(v_review_local, v_reminder.time_zone)
      ) end,
      'seriesReminder', case when v_template.root_id is null then null else pg_catalog.jsonb_build_object(
        'active', v_template.days_before is not null,
        'daysBefore', v_template.days_before,
        'time', pg_catalog.to_char(v_template.time_of_day, 'HH24:MI'),
        'revision', v_template.revision
      ) end,
      'recipients', case when v_task.owner_home_id is null then null else pg_catalog.to_jsonb(v_recipients) end,
      'recipientsAreAssignees', coalesce(v_assigned, false),
      'channels', pg_catalog.jsonb_build_object(
        'inApp', private.effective_notification_channel(v_user_id, v_task.owner_home_id, 'reminders', 'in_app'),
        'email', private.effective_notification_channel(v_user_id, v_task.owner_home_id, 'reminders', 'email')
          and private.confirmed_email(v_user_id) is not null)
    );
  end
  $$;

-- Titles of reminded tasks for the notification centre, only for tasks the caller can see now (a
-- reminder never shows a title the reader lost access to). At most 100 ids.
create function public.task_reminder_titles(p_task_ids uuid[])
returns table (task_id uuid, title text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_task_ids is null or cardinality(p_task_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    return query
      select t.id, t.title from private.tasks t
      where t.id = any (p_task_ids) and t.deleted_at is null
        and private.in_task_context(t.owner_user_id, t.owner_home_id, v_user_id);
  end
  $$;

-- Reminders: changing --------------------------------------------------------------------------------

-- Sets a task's reminder (spec "Confirmed individual task reminders").
--   p_scope 'this': this task only (any task; on an occurrence it becomes its own and later series
--     changes keep it). Either mode. The S18 edit rule; not on a completed task.
--   p_scope 'following' / 'series' (occurrences only; the series' creator or a task manager;
--     before-due only): the chain's template, and the open occurrences from this one on
--     ('following') or all of them ('series') that have no reminder of their own. Completed
--     occurrences never change; an occurrence whose new time has passed keeps what it had.
-- p_mode 'absolute': p_local_at, a wall-clock date and time; 'relative': p_days_before (0-30) days
-- before the due date at p_time. The zone is the Home's, or p_time_zone for the Personal space.
-- p_expected_revision: the task's reminder revision (0 when it has none); p_expected_series_revision:
-- the template's (0 when none), for the series scopes.
-- p_dry_run: the same work, rolled back. Outcomes: 'preview', 'saved' (fire_at, dst; for the series
-- scopes impact: updated, kept, past, completed), 'conflict' (revision: the current one),
-- 'not_found', 'not_permitted', 'not_recurring', 'scope_unavailable', 'task_completed',
-- 'needs_due_date', 'in_past'. 22023 for invalid input.
create function public.set_task_reminder(
  p_task_id uuid, p_scope text, p_mode text, p_expected_revision integer,
  p_local_at timestamp default null, p_days_before integer default null, p_time time default null,
  p_time_zone text default null, p_expected_series_revision integer default null,
  p_dry_run boolean default false
) returns table (outcome text, fire_at timestamptz, dst text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_reminder private.task_reminders;
    v_template private.task_series_reminders;
    v_zone text;
    v_local timestamp;
    v_fire timestamptz;
    v_occurrence private.tasks;
    v_existing private.task_reminders;
    v_updated integer := 0;
    v_kept integer := 0;
    v_past integer := 0;
    v_completed integer := 0;
    v_impact jsonb;
    v_revision integer;
  begin
    if p_task_id is null or p_scope is null or p_scope not in ('this', 'following', 'series')
       or p_mode is null or p_mode not in ('absolute', 'relative')
       or p_expected_revision is null or p_dry_run is null
       or (p_mode = 'absolute' and (p_local_at is null or p_days_before is not null or p_time is not null))
       or (p_mode = 'relative' and (p_local_at is not null or p_time is null
         or p_days_before is null or p_days_before not between 0 and private.task_limit('reminder_days')))
       or (p_scope <> 'this' and (p_mode <> 'relative' or p_expected_series_revision is null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_scope <> 'this' then
      -- The series head before the occurrence, like every series-wide change (S19 review M1).
      perform private.lock_series_head(
        (select t.series_root_id from private.tasks t where t.id = p_task_id));
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::timestamptz, null::text, null::jsonb, null::integer;
      return;
    end if;
    v_zone := private.reminder_zone(v_task.owner_home_id, p_time_zone);

    if p_scope = 'this' then
      if not private.can_edit_task(v_task, v_user_id) then
        return query select 'not_permitted', null::timestamptz, null::text, null::jsonb, null::integer;
        return;
      end if;
      select * into v_reminder from private.task_reminders r where r.task_id = v_task.id for update;
      if coalesce(v_reminder.revision, 0) <> p_expected_revision then
        return query select 'conflict', null::timestamptz, null::text, null::jsonb, coalesce(v_reminder.revision, 0);
        return;
      end if;
      if v_task.completed_at is not null then
        return query select 'task_completed', null::timestamptz, null::text, null::jsonb, null::integer;
        return;
      end if;
      if p_mode = 'relative' and v_task.due_date is null then
        return query select 'needs_due_date', null::timestamptz, null::text, null::jsonb, null::integer;
        return;
      end if;
      v_local := case when p_mode = 'absolute' then p_local_at
        else private.reminder_local(v_task.due_date, p_days_before, p_time) end;
      v_fire := v_local at time zone v_zone;
      if v_fire <= pg_catalog.now() then
        return query select 'in_past', v_fire, private.zoned_dst_case(v_local, v_zone), null::jsonb, null::integer;
        return;
      end if;
      if p_dry_run then
        return query select 'preview', v_fire, private.zoned_dst_case(v_local, v_zone), null::jsonb,
          coalesce(v_reminder.revision, 0);
        return;
      end if;
      v_reminder := private.put_task_reminder(v_task.id, p_mode, p_local_at, p_days_before, p_time,
        v_zone, v_task.due_date, true, v_user_id);
      perform private.audit_task('task.reminder_set', v_task.owner_home_id, 'task', v_task.id,
        pg_catalog.jsonb_build_object('mode', p_mode));
      return query select 'saved', v_reminder.fire_at, private.zoned_dst_case(v_local, v_zone),
        null::jsonb, v_reminder.revision;
      return;
    end if;

    -- Following or entire series.
    if v_task.series_root_id is null then
      return query select 'not_recurring', null::timestamptz, null::text, null::jsonb, null::integer;
      return;
    end if;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_head.id is null then
      return query select 'not_recurring', null::timestamptz, null::text, null::jsonb, null::integer;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id) then
      return query select 'not_permitted', null::timestamptz, null::text, null::jsonb, null::integer;
      return;
    end if;
    select * into v_template from private.task_series_reminders s where s.root_id = v_head.root_id for update;
    if coalesce(v_template.revision, 0) <> p_expected_series_revision then
      return query select 'conflict', null::timestamptz, null::text, null::jsonb, coalesce(v_template.revision, 0);
      return;
    end if;
    if p_scope = 'following' and v_task.completed_at is not null then
      return query select 'scope_unavailable', null::timestamptz, null::text, null::jsonb, null::integer;
      return;
    end if;

    begin
      insert into private.task_series_reminders as s (root_id, days_before, time_of_day, time_zone, updated_by)
        values (v_head.root_id, p_days_before, p_time, v_zone, v_user_id)
        on conflict (root_id) do update
          set days_before = excluded.days_before, time_of_day = excluded.time_of_day,
            time_zone = excluded.time_zone, updated_by = excluded.updated_by,
            revision = s.revision + 1, updated_at = pg_catalog.now()
        returning s.revision into v_revision;
      for v_occurrence in
        select * from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
          and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date)
        order by t.id
        for update
      loop
        select * into v_existing from private.task_reminders r where r.task_id = v_occurrence.id for update;
        if v_occurrence.id <> v_task.id and coalesce(v_existing.own, false) then
          v_kept := v_kept + 1;
          continue;
        end if;
        v_local := private.reminder_local(v_occurrence.due_date, p_days_before, p_time);
        if v_local is null or (v_local at time zone v_zone) <= pg_catalog.now() then
          v_past := v_past + 1;
          continue;
        end if;
        perform private.put_task_reminder(v_occurrence.id, 'relative', null, p_days_before, p_time,
          v_zone, v_occurrence.due_date, false, v_user_id);
        v_updated := v_updated + 1;
      end loop;
      select count(*)::integer into v_completed from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is not null
          and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date);
      -- Occurrences now due for creation (the reminder lead) are created with their reminder.
      perform private.advance_series(v_head,
        case when v_head.owner_home_id is not null then private.task_today(v_head.owner_home_id, null)
          else (pg_catalog.now() at time zone v_zone)::date end);
      v_local := private.reminder_local(v_task.due_date, p_days_before, p_time);
      v_impact := pg_catalog.jsonb_build_object(
        'scope', p_scope, 'updated', v_updated, 'kept', v_kept, 'past', v_past,
        'completed', v_completed);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_local at time zone v_zone, private.zoned_dst_case(v_local, v_zone),
          v_impact, coalesce(v_template.revision, 0);
        return;
    end;
    perform private.audit_task('task_series.reminder_set', v_head.owner_home_id, 'task_series', v_head.root_id,
      pg_catalog.jsonb_build_object('scope', p_scope, 'updated', v_updated, 'kept', v_kept));
    return query select 'saved', v_local at time zone v_zone, private.zoned_dst_case(v_local, v_zone),
      v_impact, v_revision;
  end
  $$;

-- Removes a task's reminder. 'this': this task only (an occurrence of a series with a reminder then
-- has "no reminder" as its own choice). 'following' / 'series': the chain's template is switched off,
-- and the open occurrences in scope without their own reminder lose theirs (this occurrence always
-- does). Same rights, revisions and dry run as set_task_reminder. Outcomes: 'preview', 'deleted'
-- (impact for the series scopes), 'conflict', 'not_found', 'not_permitted', 'not_recurring'.
create function public.remove_task_reminder(
  p_task_id uuid, p_scope text, p_expected_revision integer,
  p_expected_series_revision integer default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_reminder private.task_reminders;
    v_template private.task_series_reminders;
    v_occurrence private.tasks;
    v_existing private.task_reminders;
    v_removed integer := 0;
    v_kept integer := 0;
    v_completed integer := 0;
    v_impact jsonb;
    v_revision integer;
  begin
    if p_task_id is null or p_scope is null or p_scope not in ('this', 'following', 'series')
       or p_expected_revision is null or p_dry_run is null
       or (p_scope <> 'this' and p_expected_series_revision is null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_scope <> 'this' then
      perform private.lock_series_head(
        (select t.series_root_id from private.tasks t where t.id = p_task_id));
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;

    if p_scope = 'this' then
      if not private.can_edit_task(v_task, v_user_id) then
        return query select 'not_permitted', null::jsonb, null::integer;
        return;
      end if;
      select * into v_reminder from private.task_reminders r where r.task_id = v_task.id for update;
      if coalesce(v_reminder.revision, 0) <> p_expected_revision then
        return query select 'conflict', null::jsonb, coalesce(v_reminder.revision, 0);
        return;
      end if;
      if p_dry_run then
        return query select 'preview', null::jsonb, coalesce(v_reminder.revision, 0);
        return;
      end if;
      perform private.clear_task_reminder(v_task, v_user_id);
      perform private.audit_task('task.reminder_removed', v_task.owner_home_id, 'task', v_task.id);
      return query select 'deleted', null::jsonb,
        (select r.revision from private.task_reminders r where r.task_id = v_task.id);
      return;
    end if;

    if v_task.series_root_id is null then
      return query select 'not_recurring', null::jsonb, null::integer;
      return;
    end if;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_head.id is null then
      return query select 'not_recurring', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    select * into v_template from private.task_series_reminders s where s.root_id = v_head.root_id for update;
    if coalesce(v_template.revision, 0) <> p_expected_series_revision then
      return query select 'conflict', null::jsonb, coalesce(v_template.revision, 0);
      return;
    end if;

    begin
      if v_template.root_id is not null then
        update private.task_series_reminders s
          set days_before = null, time_of_day = null, revision = s.revision + 1,
            updated_by = v_user_id, updated_at = pg_catalog.now()
          where s.root_id = v_head.root_id
          returning s.revision into v_revision;
      end if;
      for v_occurrence in
        select * from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
          and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date)
        order by t.id
        for update
      loop
        select * into v_existing from private.task_reminders r where r.task_id = v_occurrence.id for update;
        if v_existing.task_id is null then
          continue;
        end if;
        if v_occurrence.id <> v_task.id and v_existing.own then
          v_kept := v_kept + 1;
          continue;
        end if;
        delete from private.task_reminders r where r.task_id = v_occurrence.id;
        v_removed := v_removed + 1;
      end loop;
      select count(*)::integer into v_completed from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is not null
          and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date);
      v_impact := pg_catalog.jsonb_build_object(
        'scope', p_scope, 'updated', v_removed, 'kept', v_kept, 'past', 0, 'completed', v_completed);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, coalesce(v_template.revision, 0);
        return;
    end;
    perform private.audit_task('task_series.reminder_removed', v_head.owner_home_id, 'task_series',
      v_head.root_id, pg_catalog.jsonb_build_object('scope', p_scope, 'removed', v_removed));
    return query select 'deleted', v_impact, coalesce(v_revision, 0);
  end
  $$;

-- Settles a reminder put on hold by a changed or removed due date: 'follow' moves it with the new due
-- date (needs one, and a time still to come), 'remove' removes it. Outcomes: 'saved' (fire_at),
-- 'deleted', 'not_needed' (it is not on hold), 'conflict', 'needs_due_date', 'in_past', 'not_found',
-- 'not_permitted'.
create function public.review_task_reminder(p_task_id uuid, p_choice text, p_expected_revision integer)
returns table (outcome text, fire_at timestamptz, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_reminder private.task_reminders;
    v_local timestamp;
  begin
    if p_task_id is null or p_choice is null or p_choice not in ('follow', 'remove')
       or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::timestamptz, null::integer;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted', null::timestamptz, null::integer;
      return;
    end if;
    select * into v_reminder from private.task_reminders r where r.task_id = v_task.id for update;
    if v_reminder.task_id is null or v_reminder.revision <> p_expected_revision then
      return query select 'conflict', null::timestamptz, coalesce(v_reminder.revision, 0);
      return;
    end if;
    if v_reminder.status <> 'needs_review' then
      return query select 'not_needed', null::timestamptz, v_reminder.revision;
      return;
    end if;
    if p_choice = 'remove' then
      perform private.clear_task_reminder(v_task, v_user_id);
      return query select 'deleted', null::timestamptz,
        (select r.revision from private.task_reminders r where r.task_id = v_task.id);
      return;
    end if;
    if v_task.due_date is null then
      return query select 'needs_due_date', null::timestamptz, null::integer;
      return;
    end if;
    v_local := private.reminder_local(v_task.due_date, v_reminder.days_before, v_reminder.time_of_day);
    if (v_local at time zone v_reminder.time_zone) <= pg_catalog.now() then
      return query select 'in_past', v_local at time zone v_reminder.time_zone, null::integer;
      return;
    end if;
    v_reminder := private.put_task_reminder(v_task.id, 'relative', null, v_reminder.days_before,
      v_reminder.time_of_day, v_reminder.time_zone, v_task.due_date, v_reminder.own, v_user_id);
    return query select 'saved', v_reminder.fire_at, v_reminder.revision;
  end
  $$;

-- Reminders: delivery (service role, the task-reminder job) ------------------------------------------

-- Delivers a reminder at its time, re-checking everything now (spec: revalidate recipient
-- eligibility, task version, schedule and settings at delivery). Nothing happens for an older
-- revision, a reminder no longer scheduled (sent, on hold, removed) or one whose time has not come.
-- A completed or deleted task, or one with nobody to remind, records 'not_sent'. Recipients: the
-- Personal space's owner; a Home task's current assignees, or with none the member who set it.
-- Each gets one notification per revision (the S14 dedupe key), so a repeated or concurrent
-- delivery notifies once; the row lock makes the second delivery wait and find it sent.
-- Outcomes: 'notified', 'not_sent', 'stale', 'not_due'.
create function public.deliver_task_reminder(p_task_id uuid, p_revision integer) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_reminder private.task_reminders;
    v_task private.tasks;
    v_recipients uuid[];
    v_user uuid;
  begin
    if p_task_id is null or p_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id for update;
    select * into v_reminder from private.task_reminders r where r.task_id = p_task_id for update;
    if v_reminder.task_id is null or v_reminder.revision <> p_revision or v_reminder.status <> 'scheduled' then
      return 'stale';
    end if;
    if v_reminder.fire_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    if v_task.deleted_at is not null or v_task.completed_at is not null then
      update private.task_reminders r set status = 'not_sent', delivered_at = pg_catalog.now()
        where r.task_id = p_task_id;
      return 'not_sent';
    end if;
    if v_task.owner_home_id is null then
      v_recipients := array[v_task.owner_user_id];
    else
      select coalesce(array_agg(a.user_id order by a.user_id), '{}') into v_recipients
        from private.task_assignees a where a.task_id = p_task_id;
      if cardinality(v_recipients) = 0 and v_reminder.set_by is not null
         and private.is_home_member(v_task.owner_home_id, v_reminder.set_by) then
        v_recipients := array[v_reminder.set_by];
      end if;
    end if;
    if cardinality(v_recipients) = 0 then
      update private.task_reminders r set status = 'not_sent', delivered_at = pg_catalog.now()
        where r.task_id = p_task_id;
      return 'not_sent';
    end if;
    foreach v_user in array v_recipients loop
      perform private.notify_user(
        v_user, v_task.owner_home_id, 'reminders', 'task.reminder',
        pg_catalog.jsonb_build_object('taskId', v_task.id, 'dueDate', v_task.due_date),
        'task-reminder:' || v_task.id::text || ':' || v_reminder.revision::text,
        true);
    end loop;
    update private.task_reminders r set status = 'sent', delivered_at = pg_catalog.now()
      where r.task_id = p_task_id;
    return 'notified';
  end
  $$;

-- Templates ---------------------------------------------------------------------------------------------

create function private.task_template_name_taken(
  p_home_id uuid, p_user_id uuid, p_name text, p_except uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.task_templates t
    where ((p_home_id is null and t.owner_user_id = p_user_id) or t.owner_home_id = p_home_id)
      and t.id is distinct from p_except
      and private.task_name_key(t.name) = private.task_name_key(p_name)
  );
  $$;

create function private.valid_template_fields(
  p_name text, p_title text, p_description text, p_priority text, p_subtasks text[]
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    p_name is not null and private.is_visible_name(p_name, private.task_limit('template_name'))
    and private.valid_task_fields(p_title, p_description, null, null, p_priority)
    and private.valid_subtask_titles(p_subtasks),
    false);
  $$;

-- Loads a template for a change, locked. Null when missing or not in a context the caller can see.
create function private.lock_task_template(p_id uuid, p_user_id uuid) returns private.task_templates
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_template private.task_templates;
  begin
    select * into v_template from private.task_templates t where t.id = p_id for update;
    if not found or not private.in_task_context(v_template.owner_user_id, v_template.owner_home_id, p_user_id) then
      return null;
    end if;
    return v_template;
  end
  $$;

-- The labels of a template still valid in its context, in its order.
create function private.template_valid_labels(p_template private.task_templates) returns uuid[]
  language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(x order by o), '{}') from unnest(p_template.label_ids) with ordinality as u (x, o)
  where exists (
    select 1 from private.task_labels l
    where l.id = x and l.owner_user_id is not distinct from p_template.owner_user_id
      and l.owner_home_id is not distinct from p_template.owner_home_id
  );
  $$;

-- The context's templates by name: every current member sees a Home's; the Personal space's owner
-- theirs. 42501 for a Home the caller is not in.
create function public.list_task_templates(p_home_id uuid default null)
returns table (
  id uuid, name text, title text, priority text, label_count integer, subtask_count integer, revision integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    return query
      select t.id, t.name, t.title, t.priority,
        cardinality(private.template_valid_labels(t))::integer, cardinality(t.subtasks)::integer, t.revision
      from private.task_templates t
      where (p_home_id is null and t.owner_user_id = v_user_id) or t.owner_home_id = p_home_id
      order by private.task_name_key(t.name), t.id;
  end
  $$;

-- One template with its still-valid labels and how many it lost (deleted labels are left out and
-- disclosed), or null when missing or not the caller's to see.
create function public.get_task_template(p_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_template private.task_templates;
    v_labels uuid[];
  begin
    select * into v_template from private.task_templates t where t.id = p_id;
    if not found or not private.in_task_context(v_template.owner_user_id, v_template.owner_home_id, v_user_id) then
      return null;
    end if;
    v_labels := private.template_valid_labels(v_template);
    return pg_catalog.jsonb_build_object(
      'id', v_template.id, 'homeId', v_template.owner_home_id, 'name', v_template.name,
      'title', v_template.title, 'description', v_template.description, 'priority', v_template.priority,
      'labelIds', pg_catalog.to_jsonb(v_labels),
      'omittedLabels', cardinality(v_template.label_ids) - cardinality(v_labels),
      'subtasks', pg_catalog.to_jsonb(v_template.subtasks), 'revision', v_template.revision,
      'canManage', private.can_manage_tasks(v_template.owner_user_id, v_template.owner_home_id, v_user_id));
  end
  $$;

-- Creates a template (task managers: the Personal space's owner; in a Home the Owner and
-- manageHomeTasks). p_id comes from the client, so a retry answers 'exists'. Outcomes: 'created',
-- 'exists', 'id_taken', 'duplicate_name', 'limit_reached', 'invalid_label', 'not_permitted'. 22023
-- for invalid fields.
create function public.create_task_template(
  p_id uuid, p_name text, p_title text, p_description text default null, p_priority text default null,
  p_label_ids uuid[] default '{}', p_subtasks text[] default '{}', p_home_id uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_existing private.task_templates;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_id is null or p_label_ids is null
       or not private.valid_template_fields(p_name, p_title, p_description, p_priority, p_subtasks) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.task_templates t where t.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.is_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if not private.can_manage_tasks(v_owner_user, p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if not private.valid_task_labels(p_label_ids, v_owner_user, p_home_id) then
      return query select 'invalid_label', null::integer;
      return;
    end if;
    perform private.lock_task_context('task_template', p_home_id, v_user_id);
    if private.task_template_name_taken(p_home_id, v_user_id, p_name, null) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    if (select count(*) from private.task_templates t
        where (p_home_id is null and t.owner_user_id = v_user_id) or t.owner_home_id = p_home_id)
       >= private.task_limit('templates') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.task_templates (
      id, owner_user_id, owner_home_id, name, title, description, priority, label_ids, subtasks,
      created_by, updated_by
    ) values (
      p_id, v_owner_user, p_home_id, p_name, p_title, p_description, p_priority,
      (select coalesce(array_agg(distinct x), '{}') from unnest(p_label_ids) as x), p_subtasks,
      v_user_id, v_user_id
    )
    on conflict (id) do nothing;
    if not found then
      return query select 'id_taken', null::integer;
      return;
    end if;
    perform private.audit_task('task_template.created', p_home_id, 'task_template', p_id);
    return query select 'created', 1;
  end
  $$;

-- Saves a template's content if nobody changed it since p_expected_revision. Tasks made from it are
-- never touched. Outcomes: 'saved', 'conflict', 'duplicate_name', 'invalid_label', 'not_found',
-- 'not_permitted'. 22023 for invalid fields.
create function public.update_task_template(
  p_id uuid, p_expected_revision integer, p_name text, p_title text, p_description text default null,
  p_priority text default null, p_label_ids uuid[] default '{}', p_subtasks text[] default '{}'
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_template private.task_templates;
  begin
    if p_id is null or p_expected_revision is null or p_label_ids is null
       or not private.valid_template_fields(p_name, p_title, p_description, p_priority, p_subtasks) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The context lock before the row lock, as every name check (S18).
    select * into v_template from private.task_templates t where t.id = p_id;
    if not found or not private.in_task_context(v_template.owner_user_id, v_template.owner_home_id, v_user_id) then
      return query select 'not_found', null::integer;
      return;
    end if;
    perform private.lock_task_context('task_template', v_template.owner_home_id, v_template.owner_user_id);
    v_template := private.lock_task_template(p_id, v_user_id);
    if v_template.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_tasks(v_template.owner_user_id, v_template.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_template.revision <> p_expected_revision then
      return query select 'conflict', v_template.revision;
      return;
    end if;
    if not private.valid_task_labels(p_label_ids, v_template.owner_user_id, v_template.owner_home_id) then
      return query select 'invalid_label', null::integer;
      return;
    end if;
    if private.task_template_name_taken(v_template.owner_home_id, v_template.owner_user_id, p_name, p_id) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    update private.task_templates t
      set name = p_name, title = p_title, description = p_description, priority = p_priority,
        label_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(p_label_ids) as x),
        subtasks = p_subtasks, revision = t.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where t.id = p_id
      returning * into v_template;
    perform private.audit_task('task_template.updated', v_template.owner_home_id, 'task_template', p_id);
    return query select 'saved', v_template.revision;
  end
  $$;

-- Deletes a template (after the person confirmed). Tasks made from it stay. Outcomes: 'deleted',
-- 'conflict', 'not_found', 'not_permitted'.
create function public.delete_task_template(p_id uuid, p_expected_revision integer)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_template private.task_templates;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_template := private.lock_task_template(p_id, v_user_id);
    if v_template.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_tasks(v_template.owner_user_id, v_template.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_template.revision <> p_expected_revision then
      return query select 'conflict', v_template.revision;
      return;
    end if;
    delete from private.task_templates t where t.id = p_id;
    perform private.audit_task('task_template.deleted', v_template.owner_home_id, 'task_template', p_id);
    return query select 'deleted', null::integer;
  end
  $$;

-- Creates a task from the reviewed preview of a template: the task and its whole checklist (every
-- item open) in one transaction, so a retry or a double submit returns 'exists' and never a second
-- task or half a checklist. The preview's fields are what the person confirmed; the template's
-- revision must still be p_expected_template_revision ('template_changed' otherwise, with the
-- current one), and the list, labels and rights are checked again (create_task). Nothing else of
-- the template's source is copied. Outcomes: 'created', 'exists', 'id_taken', 'template_changed',
-- 'not_found' (the template), 'list_unavailable', 'invalid_label', 'not_permitted'.
create function public.create_task_from_template(
  p_task_id uuid, p_template_id uuid, p_expected_template_revision integer, p_list_id uuid,
  p_title text, p_description text default null, p_priority text default null,
  p_label_ids uuid[] default '{}', p_subtasks text[] default '{}',
  p_start_date date default null, p_due_date date default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_template private.task_templates;
    v_existing private.tasks;
    v_result record;
  begin
    if p_task_id is null or p_template_id is null or p_expected_template_revision is null
       or p_list_id is null or p_label_ids is null or not private.valid_subtask_titles(p_subtasks) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_template from private.task_templates t where t.id = p_template_id for share;
    if not found or not private.in_task_context(v_template.owner_user_id, v_template.owner_home_id, v_user_id) then
      return query select 'not_found', null::integer;
      return;
    end if;
    -- A retry of a create that went through answers 'exists', even if the template changed since.
    select * into v_existing from private.tasks t where t.id = p_task_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.is_context(v_existing.owner_user_id, v_existing.owner_home_id,
           v_template.owner_home_id, v_user_id) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if v_template.revision <> p_expected_template_revision then
      return query select 'template_changed', v_template.revision;
      return;
    end if;
    select * into v_result from public.create_task(
      p_task_id, p_list_id, p_title, p_description, p_start_date, p_due_date, p_priority,
      p_label_ids, '{}', v_template.owner_home_id) as c;
    if v_result.outcome <> 'created' then
      return query select v_result.outcome, v_result.revision;
      return;
    end if;
    insert into private.subtasks (id, task_id, title, position, created_by)
      select gen_random_uuid(), p_task_id, x, o::integer, v_user_id
      from unnest(p_subtasks) with ordinality as u (x, o);
    perform private.audit_task('task.created_from_template', v_template.owner_home_id, 'task', p_task_id,
      pg_catalog.jsonb_build_object('subtasks', cardinality(p_subtasks)));
    return query select 'created', v_result.revision;
  end
  $$;

-- Bulk actions --------------------------------------------------------------------------------------------

-- Applies one basic action to the selected tasks of one context (spec "Confirmed basic bulk task
-- actions"): 'complete', 'priority' (p_priority; null is Unspecified), 'labels' (p_label_mode 'add',
-- 'remove' or 'replace' with p_label_ids) or 'move' (to p_list_id, an active list of the same
-- context). Each task is handled in its own sub-transaction with the per-task rules of the single
-- action (S18 edit rule, list usable, labels of the context), in id order. Its result:
--   'changed' ('will_change' in a dry run), 'unchanged' (already in that state: no second
--   completion, no new revision; this makes a retry safe), 'conflict' (its revision is not the one in
--   p_expected_revisions: changed since the preview, nothing overwritten), 'not_found' (missing,
--   deleted, another context or not visible), 'not_permitted', 'list_unavailable', 'invalid_label',
--   'too_many_labels', 'failed'.
-- An occurrence of a recurring series changes alone (and is marked changed on its own, S19); the
-- series is never changed. p_expected_revisions maps task ids to revisions; required unless
-- p_dry_run. Also answers each task's unfinished subtasks, whether it repeats and whether it has
-- several assignees (the preview's warnings). At most 100 tasks; 22023 for invalid input.
create function public.bulk_update_tasks(
  p_task_ids uuid[], p_action text, p_expected_revisions jsonb, p_dry_run boolean,
  p_home_id uuid default null, p_priority text default null, p_label_mode text default null,
  p_label_ids uuid[] default null, p_list_id uuid default null
) returns table (
  task_id uuid, outcome text, revision integer, open_subtasks integer, recurring boolean, shared boolean
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_ids uuid[];
    v_id uuid;
    v_task private.tasks;
    v_outcome text;
    v_expected integer;
    v_current uuid[];
    v_target uuid[];
    v_labels_ok boolean := true;
    v_list_ok boolean := true;
    v_results jsonb := '[]'::jsonb;
    v_changed integer := 0;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    select coalesce(array_agg(distinct x order by x), '{}') into v_ids from unnest(p_task_ids) as x where x is not null;
    if p_task_ids is null or cardinality(v_ids) = 0 or cardinality(v_ids) > private.task_limit('bulk')
       or p_action is null or p_action not in ('complete', 'priority', 'labels', 'move')
       or p_dry_run is null
       or (not p_dry_run and (p_expected_revisions is null or jsonb_typeof(p_expected_revisions) <> 'object'))
       or (p_expected_revisions is not null and jsonb_typeof(p_expected_revisions) <> 'object')
       or (p_action = 'priority' and p_priority is not null and p_priority not in ('low', 'normal', 'high', 'urgent'))
       or (p_action = 'labels' and (p_label_mode is null or p_label_mode not in ('add', 'remove', 'replace')
         or p_label_ids is null or cardinality(p_label_ids) > private.task_limit('labels_per_task')))
       or (p_action = 'move' and p_list_id is null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_action = 'labels' then
      v_labels_ok := private.valid_task_labels(p_label_ids, v_owner_user, p_home_id);
    end if;
    if p_action = 'move' then
      v_list_ok := private.usable_task_list(p_list_id, v_owner_user, p_home_id);
    end if;

    foreach v_id in array v_ids loop
      v_outcome := null;
      begin
        select * into v_task from private.tasks t where t.id = v_id for update;
        if not found or v_task.deleted_at is not null
           or not private.is_context(v_task.owner_user_id, v_task.owner_home_id, p_home_id, v_user_id) then
          v_outcome := 'not_found';
          v_task := null;
        elsif not private.can_edit_task(v_task, v_user_id) then
          v_outcome := 'not_permitted';
        elsif not v_labels_ok then
          v_outcome := 'invalid_label';
        elsif not v_list_ok then
          v_outcome := 'list_unavailable';
        end if;
        if v_outcome is null then
          if p_action = 'labels' then
            select coalesce(array_agg(k.label_id order by k.label_id), '{}') into v_current
              from private.task_label_links k where k.task_id = v_id;
            select coalesce(array_agg(distinct x order by x), '{}') into v_target from unnest(
              case p_label_mode
                when 'add' then v_current || p_label_ids
                when 'remove' then (select coalesce(array_agg(c), '{}') from unnest(v_current) as c
                  where not (c = any (p_label_ids)))
                else p_label_ids
              end) as x;
          end if;
          if (p_action = 'complete' and v_task.completed_at is not null)
             or (p_action = 'priority' and v_task.priority is not distinct from p_priority)
             or (p_action = 'labels' and v_target = v_current)
             or (p_action = 'move' and v_task.list_id = p_list_id) then
            v_outcome := 'unchanged';
          elsif p_action = 'labels' and cardinality(v_target) > private.task_limit('labels_per_task') then
            v_outcome := 'too_many_labels';
          else
            v_expected := case when p_expected_revisions ? v_id::text
              then (p_expected_revisions ->> v_id::text)::integer end;
            if (not p_dry_run and v_expected is null)
               or (v_expected is not null and v_expected <> v_task.revision) then
              v_outcome := 'conflict';
            elsif p_dry_run then
              v_outcome := 'will_change';
            else
              case p_action
                when 'complete' then
                  update private.tasks t
                    set completed_at = pg_catalog.now(), completed_by = v_user_id
                    where t.id = v_id
                    returning * into v_task;
                  perform private.audit_task('task.completed', v_task.owner_home_id, 'task', v_id);
                when 'priority' then
                  update private.tasks t
                    set priority = p_priority, detached = t.series_root_id is not null,
                      revision = t.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
                    where t.id = v_id
                    returning * into v_task;
                when 'labels' then
                  perform private.replace_task_labels(v_id, v_target);
                  update private.tasks t
                    set detached = t.series_root_id is not null,
                      revision = t.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
                    where t.id = v_id
                    returning * into v_task;
                when 'move' then
                  update private.tasks t
                    set list_id = p_list_id, detached = t.series_root_id is not null,
                      revision = t.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
                    where t.id = v_id
                    returning * into v_task;
              end case;
              v_outcome := 'changed';
              v_changed := v_changed + 1;
            end if;
          end if;
        end if;
      exception when others then
        -- One task's unexpected failure never undoes the others (spec: partial success is reported).
        raise warning 'bulk_update_tasks: task failed (sqlstate %)', sqlstate;
        v_outcome := 'failed';
      end;
      v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'task_id', v_id, 'outcome', v_outcome,
        'revision', case when v_outcome in ('not_found', 'failed') then null else v_task.revision end,
        'open_subtasks', case when v_outcome in ('not_found', 'failed') then null else
          (select count(*)::integer from private.subtasks s where s.task_id = v_id and s.completed_at is null) end,
        'recurring', case when v_outcome in ('not_found', 'failed') then null else v_task.series_root_id is not null end,
        'shared', case when v_outcome in ('not_found', 'failed') then null else
          (select count(*) > 1 from private.task_assignees a where a.task_id = v_id) end));
    end loop;
    if not p_dry_run and v_changed > 0 then
      perform private.audit_task('task.bulk_' || p_action, p_home_id, 'home', p_home_id,
        pg_catalog.jsonb_build_object('changed', v_changed, 'selected', cardinality(v_ids)));
    end if;
    return query
      select r.task_id, r.outcome, r.revision, r.open_subtasks, r.recurring, r.shared
      from pg_catalog.jsonb_to_recordset(v_results) as r (
        task_id uuid, outcome text, revision integer, open_subtasks integer, recurring boolean, shared boolean);
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.get_notification_settings()',
    'public.set_notification_preference(text, text, boolean, uuid)',
    'public.reset_notification_preference(text, text, uuid)',
    'public.advance_task_series(uuid, date)',
    'public.get_task_reminder(uuid, text)',
    'public.task_reminder_titles(uuid[])',
    'public.set_task_reminder(uuid, text, text, integer, timestamp, integer, time, text, integer, boolean)',
    'public.remove_task_reminder(uuid, text, integer, integer, boolean)',
    'public.review_task_reminder(uuid, text, integer)',
    'public.list_task_templates(uuid)',
    'public.get_task_template(uuid)',
    'public.create_task_template(uuid, text, text, text, text, uuid[], text[], uuid)',
    'public.update_task_template(uuid, integer, text, text, text, text, uuid[], text[])',
    'public.delete_task_template(uuid, integer)',
    'public.create_task_from_template(uuid, uuid, integer, uuid, text, text, text, uuid[], text[], date, date)',
    'public.bulk_update_tasks(uuid[], text, jsonb, boolean, uuid, text, text, uuid[], uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The jobs' functions: the service role only.
  foreach v_function in array array[
    'public.deliver_task_reminder(uuid, integer)',
    'public.advance_reminder_series(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.task_limit(text)',
    'private.notification_category_essential(text)',
    'private.notification_category_optional(text)',
    'private.valid_subtask_titles(text[])',
    'private.valid_time_zone(text)',
    'private.zoned_dst_case(timestamp, text)',
    'private.reminder_local(date, integer, time)',
    'private.reminder_zone(uuid, text)',
    'private.put_task_reminder(uuid, text, timestamp, integer, time, text, date, boolean, uuid)',
    'private.clear_task_reminder(private.tasks, uuid)',
    'private.copy_series_reminder()',
    'private.hold_reminder_on_due_change()',
    'private.drop_series_reminder()',
    'private.series_reminder_lead(uuid)',
    'private.advance_series(private.task_series, date)',
    'private.task_template_name_taken(uuid, uuid, text, uuid)',
    'private.valid_template_fields(text, text, text, text, text[])',
    'private.lock_task_template(uuid, uuid)',
    'private.template_valid_labels(private.task_templates)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
