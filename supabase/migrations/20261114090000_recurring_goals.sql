-- S30b: recurring goals (brief plans/steps/S30b-brief.md; ADR 0039; spec "Confirmed completed goal
-- lifecycle and guided renewal" (recurring goals), "Confirmed weekly, monthly and yearly recurring
-- measurable goals", "Confirmed recurring measurable goal period finalization and historical
-- corrections", "Confirmed recurring measurable goal target effective periods", and the recurring line
-- of "Confirmed configurable goal deadline and overdue reminders"). Builds on S30 (*_goals.sql).
--
-- A series is a recurring goal in a Personal space or a Home: measurable goals repeat weekly, monthly
-- or yearly, completion goals monthly or yearly. Each period is an ordinary goal (series_id,
-- period_start, period_end) with its own ledger, target, achievement history, deadline (its last day)
-- and reminders, so every S30 rule applies to it unchanged. A period exists at most once: the unique
-- (series_id, period_start) index holds even for periods in the trash, so a retried, duplicated or
-- concurrent rollover can never make a second one, and a removed period is never made again.
--
-- Rollover (private.roll_goal_series, under the series row lock) finalizes every period whose last
-- day has passed and creates the current period when the series is active. It never backfills: a
-- period that passed while the series was paused, stopped or not started yet is never created. It runs
-- from the hourly background schedule (public.roll_goal_periods, service role) and lazily before the
-- goals list and series reads (public.sync_goal_periods), so a new period exists as soon as anyone
-- looks. Dates are local calendar dates in the series' timezone, so daylight-saving changes cannot
-- move a boundary.
--
-- Finalization records a measurable period's calculated outcome (target reached or not) and its total
-- at that moment. It never marks anything achieved or reopens anything; the next period starts at 0.
-- After a period ends nobody adds progress to it; goal managers may still correct it (audited
-- corrections, set total, Mark achieved, reopen), which recomputes that period's outcome alone under
-- its own target and marks the result corrected. An explicit achievement is never revoked by a
-- correction: the period shows that it needs review (the manager's Reopen).
--
-- Target changes take effect from the current or a chosen future period (goal_series_targets); past
-- periods keep their own targets. Lock order: a series before any of its goals, never the other way.

-- Audit subject, trash type, event kinds -----------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series'
  ));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit', 'goal',
    'goal_series'
  ));

alter table private.goal_events drop constraint goal_events_kind_check;
alter table private.goal_events add constraint goal_events_kind_check check (kind in (
  'created', 'edited', 'target_changed', 'adjusted', 'corrected', 'achieved', 'reopened',
  'archived', 'unarchived', 'restored', 'reminders_changed', 'finalized', 'outcome_changed'
));

-- Limits -------------------------------------------------------------------------------------------------

-- apps/web/src/goals/schema.ts and packages/domain/src/goals use the same numbers.
create or replace function private.goal_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'title' then 80
    when 'description' then 500
    when 'note' then 280
    when 'reason' then 200
    when 'goals' then 100             -- goals per context that are not archived (periods not counted)
    when 'series' then 50             -- series per context that are not stopped
    when 'page' then 50               -- history rows one read returns
    when 'query' then 80              -- search text
    when 'lead_days' then 90          -- an advance reminder at most this many days before the deadline
    when 'overdue_days' then 30       -- an overdue reminder at most this many days after it
    when 'late_minutes' then 30       -- a reminder more than this late is skipped
    when 'roll_batch' then 200        -- series one background run rolls at most
  end;
  $$;

-- Periods ------------------------------------------------------------------------------------------------

-- The period of a frequency that contains p_on: the week by the week start (the habit rule, so a week
-- crossing New Year is one period), the calendar month (February has 28 or 29 days) or the calendar
-- year. Inclusive local dates.
create function private.goal_period_bounds(p_frequency text, p_week_start text, p_on date)
returns table (period_start date, period_end date)
  language sql immutable set search_path = '' as $$
  select x.s, case p_frequency
      when 'weekly' then x.s + 6
      when 'monthly' then (x.s + interval '1 month')::date - 1
      else (x.s + interval '1 year')::date - 1 end
  from (select case p_frequency
      when 'weekly' then private.habit_week_of(p_week_start, p_on)
      when 'monthly' then pg_catalog.date_trunc('month', p_on::timestamp)::date
      else pg_catalog.date_trunc('year', p_on::timestamp)::date end as s) x
  where p_on is not null and p_frequency in ('weekly', 'monthly', 'yearly')
    and (p_frequency <> 'weekly' or p_week_start in ('monday', 'saturday', 'sunday'));
  $$;

-- Tables -------------------------------------------------------------------------------------------------

create table private.goal_series (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  kind text not null constraint goal_series_kind_check check (kind in ('completion', 'measurable')),
  frequency text not null constraint goal_series_frequency_check check (frequency in ('weekly', 'monthly', 'yearly')),
  week_start text not null default 'monday'
    constraint goal_series_week_start_check check (week_start in ('monday', 'saturday', 'sunday')),
  title text not null,
  description text,
  -- A personal series' own timezone (null for a Home series, which uses the Home's).
  time_zone text,
  first_period_start date not null,
  -- No period starts after this date (null: no end).
  ends_on date,
  state text not null default 'active' constraint goal_series_state_check check (state in ('active', 'paused', 'stopped')),
  stopped_at timestamptz,
  stopped_by uuid references auth.users (id) on delete set null,
  -- The advance reminder each new period gets (null: none).
  reminder_lead_days smallint constraint goal_series_lead_check check (reminder_lead_days between 1 and 90),
  reminder_at_time time constraint goal_series_time_check check (reminder_at_time = date_trunc('minute', reminder_at_time)),
  -- When the next rollover has work (a period ends or begins); null: nothing ahead.
  next_roll_at timestamptz,
  deleted_at timestamptz,
  revision integer not null default 1 constraint goal_series_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint goal_series_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint goal_series_title_check check (private.is_visible_name(title, 80)),
  constraint goal_series_description_check check (description is null or private.is_plain_text(description, 500)),
  constraint goal_series_zone_check check ((owner_home_id is null) = (time_zone is not null)
    and (time_zone is null or char_length(time_zone) <= 64)),
  -- Completion goals repeat monthly or yearly only (the spec approves weekly for measurable goals).
  constraint goal_series_completion_check check (kind = 'measurable' or frequency <> 'weekly'),
  constraint goal_series_ends_check check (ends_on is null or ends_on >= first_period_start),
  constraint goal_series_stopped_check check ((state = 'stopped') = (stopped_at is not null)),
  constraint goal_series_reminder_check check ((reminder_lead_days is null) = (reminder_at_time is null))
);

create index goal_series_home_idx on private.goal_series (owner_home_id) where owner_home_id is not null;
create index goal_series_user_idx on private.goal_series (owner_user_id) where owner_user_id is not null;
create index goal_series_roll_idx on private.goal_series (next_roll_at) where next_roll_at is not null and deleted_at is null;

-- A measurable series' target and unit from a period on: the row with the latest effective_from on or
-- before a period's start applies to it. Past periods keep the target they were created with.
create table private.goal_series_targets (
  series_id uuid not null references private.goal_series (id) on delete cascade,
  effective_from date not null,
  target numeric(13, 3) not null,
  unit text not null,
  unit_kind text not null constraint goal_series_targets_unit_kind_check check (unit_kind in ('preset', 'custom')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (series_id, effective_from),
  constraint goal_series_targets_shape_check check (private.valid_goal_shape('measurable', target, unit, unit_kind))
);

-- The series' history: ids, codes, dates and numbers only.
create table private.goal_series_events (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references private.goal_series (id) on delete cascade,
  kind text not null constraint goal_series_events_kind_check check (kind in (
    'created', 'edited', 'target_scheduled', 'paused', 'resumed', 'stopped', 'restored'
  )),
  actor uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  details jsonb not null default '{}'
);

create index goal_series_events_idx on private.goal_series_events (series_id, at desc, id desc);

alter table private.goals
  add column series_id uuid references private.goal_series (id) on delete cascade,
  add column period_start date,
  add column period_end date,
  -- The calculated outcome once the period ended (measurable: total against target; completion:
  -- marked achieved), its total then, and when a later correction changed it.
  add column outcome text constraint goals_outcome_check check (outcome in ('reached', 'not_reached')),
  add column outcome_total numeric(16, 3),
  add column finalized_at timestamptz,
  add column outcome_corrected_at timestamptz,
  add constraint goals_period_check check (
    num_nonnulls(series_id, period_start, period_end) in (0, 3)
    and (period_end is null or period_end >= period_start)
    and (series_id is not null or (finalized_at is null and outcome is null))
    and ((finalized_at is null) = (outcome is null)));

create unique index goals_series_period_key on private.goals (series_id, period_start) where series_id is not null;

alter table private.goal_series enable row level security;
alter table private.goal_series_targets enable row level security;
alter table private.goal_series_events enable row level security;
revoke all on private.goal_series, private.goal_series_targets, private.goal_series_events
  from public, anon, authenticated;

-- Helpers ------------------------------------------------------------------------------------------------

create function private.goal_series_zone(p_series private.goal_series) returns text
  language sql stable security definer set search_path = '' as $$
  select case when p_series.owner_home_id is null then p_series.time_zone
    else (select h.timezone from public.homes h where h.id = p_series.owner_home_id) end;
  $$;

-- The instant a local date begins in a timezone.
create function private.goal_local_midnight(p_on date, p_zone text) returns timestamptz
  language sql stable set search_path = '' as $$
  select p_on::timestamp at time zone p_zone;
  $$;

-- Whether a goal is out of sight: in the trash itself, or a period of a series in the trash.
create function private.goal_hidden(p_goal private.goals) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_goal.deleted_at is not null or (p_goal.series_id is not null and exists (
    select 1 from private.goal_series s where s.id = p_goal.series_id and s.deleted_at is not null));
  $$;

-- Whether a period's last day has passed (in its timezone). Never true for a goal outside a series.
create function private.goal_period_ended(p_goal private.goals) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_goal.series_id is not null and private.goal_today(p_goal) > p_goal.period_end, false);
  $$;

-- A period's calculated outcome now: a measurable period's total against its target, a completion
-- period whether it is marked achieved.
create function private.goal_period_outcome(p_goal private.goals) returns text
  language sql stable security definer set search_path = '' as $$
  select case when p_goal.series_id is null then null
    when case when p_goal.kind = 'measurable' then private.goal_total(p_goal) >= p_goal.target
      else p_goal.achieved_at is not null end then 'reached' else 'not_reached' end;
  $$;

-- A series the caller may see (not in the trash), or a null row.
create function private.goal_series_for(p_series_id uuid, p_user_id uuid) returns private.goal_series
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_series private.goal_series;
  begin
    select * into v_series from private.goal_series s where s.id = p_series_id and s.deleted_at is null;
    if v_series.id is null or p_user_id is null
       or (v_series.owner_home_id is null and v_series.owner_user_id <> p_user_id)
       or (v_series.owner_home_id is not null and private.goal_access(v_series.owner_home_id, p_user_id) is null) then
      return null;
    end if;
    return v_series;
  end
  $$;

-- The caller's access to a series ('manage', 'contribute', 'view' or null), like private.goal_role.
create function private.goal_series_role(p_series private.goal_series, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_series.id is null or p_user_id is null then null
    when p_series.owner_home_id is null then case when p_series.owner_user_id = p_user_id then 'manage' end
    else private.goal_access(p_series.owner_home_id, p_user_id)
  end;
  $$;

-- The same, locked for a change (series before goals).
create function private.goal_series_lock(p_series_id uuid, p_user_id uuid) returns private.goal_series
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_series private.goal_series;
  begin
    select * into v_series from private.goal_series s where s.id = p_series_id and s.deleted_at is null for update;
    if v_series.id is null or private.goal_series_role(v_series, p_user_id) is null then
      return null;
    end if;
    return v_series;
  end
  $$;

-- The target and unit of a measurable series for the period starting on p_start.
create function private.goal_series_target_for(p_series_id uuid, p_start date) returns private.goal_series_targets
  language sql stable security definer set search_path = '' as $$
  select t.* from private.goal_series_targets t
  where t.series_id = p_series_id and t.effective_from <= p_start
  order by t.effective_from desc limit 1;
  $$;

create function private.goal_series_event(
  p_series_id uuid, p_kind text, p_actor uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.goal_series_events (series_id, kind, actor, details)
    values (p_series_id, p_kind, p_actor, coalesce(p_details, '{}'::jsonb));
  $$;

-- Ids, codes and numbers only. Home series only.
create function private.audit_goal_series(
  p_action text, p_series private.goal_series, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  select case when p_series.owner_home_id is not null
    then private.audit(p_action, p_series.owner_home_id, 'goal_series', p_series.id, p_details) end;
  $$;

-- Status: a period whose last day passed is 'ended' (unless achieved or archived); it never shows as
-- overdue, since its deadline is that last day.
create or replace function private.goal_status(p_goal private.goals, p_today date) returns text
  language sql stable set search_path = '' as $$
  select case
    when p_goal.archived_at is not null then 'archived'
    when p_goal.achieved_at is not null then 'achieved'
    when p_goal.series_id is not null and p_goal.period_end < p_today then 'ended'
    when p_goal.deadline is not null and p_goal.deadline < p_today then 'overdue'
    else 'active'
  end;
  $$;

-- S30's lookups, now also hiding the periods of a series in the trash.
create or replace function private.goal_for(p_goal_id uuid, p_user_id uuid) returns private.goals
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_goal private.goals;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id;
    if v_goal.id is null or private.goal_hidden(v_goal) or not private.goal_may(v_goal, p_user_id, 'view') then
      return null;
    end if;
    return v_goal;
  end
  $$;

create or replace function private.goal_lock(p_goal_id uuid, p_user_id uuid) returns private.goals
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id and g.deleted_at is null for update;
    if v_goal.id is null or private.goal_hidden(v_goal) or not private.goal_may(v_goal, p_user_id, 'view') then
      return null;
    end if;
    return v_goal;
  end
  $$;

-- Outcome ------------------------------------------------------------------------------------------------

-- Records an ended period's calculated outcome (the goal is locked by the caller). Never achieves or
-- reopens anything. Idempotent: a finalized period is left alone.
create function private.finalize_goal_period(p_goal private.goals) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_outcome text := private.goal_period_outcome(p_goal);
    v_total numeric := private.goal_total(p_goal);
  begin
    if p_goal.series_id is null or p_goal.finalized_at is not null then
      return;
    end if;
    update private.goals g set outcome = v_outcome, outcome_total = v_total, finalized_at = pg_catalog.now()
      where g.id = p_goal.id and g.finalized_at is null;
    if found then
      perform private.goal_event(p_goal.id, 'finalized', null, null,
        pg_catalog.jsonb_build_object('outcome', v_outcome, 'total', v_total, 'target', p_goal.target));
    end if;
  end
  $$;

-- After a change to a finalized period (a correction, set total, achievement): recomputes its outcome
-- under its own target and unit. A changed total or outcome marks the result corrected; a flipped
-- outcome is recorded with its before and after. The goal is locked by the caller.
create function private.recheck_goal_outcome(p_goal_id uuid, p_actor uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
    v_outcome text;
    v_total numeric;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id;
    if v_goal.series_id is null or v_goal.finalized_at is null then
      return;
    end if;
    v_outcome := private.goal_period_outcome(v_goal);
    v_total := private.goal_total(v_goal);
    if v_outcome = v_goal.outcome and v_total is not distinct from v_goal.outcome_total then
      return;
    end if;
    update private.goals g set outcome = v_outcome, outcome_total = v_total,
        outcome_corrected_at = pg_catalog.now()
      where g.id = v_goal.id;
    if v_outcome <> v_goal.outcome then
      perform private.goal_event(v_goal.id, 'outcome_changed', p_actor, null,
        pg_catalog.jsonb_build_object('before', v_goal.outcome, 'after', v_outcome,
          'totalBefore', v_goal.outcome_total, 'total', v_total, 'target', v_goal.target));
    end if;
  end
  $$;

-- Rollover -----------------------------------------------------------------------------------------------

-- Creates one period of a series (the series is locked by the caller and the period does not exist):
-- a goal with the series' title, kind and the target that applies to that period, no progress, the
-- period's last day as deadline and the series' advance reminder.
create function private.create_goal_period(p_series private.goal_series, p_start date, p_end date)
returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_target private.goal_series_targets;
    v_goal private.goals;
  begin
    if p_series.kind = 'measurable' then
      v_target := private.goal_series_target_for(p_series.id, p_start);
    end if;
    insert into private.goals (id, owner_user_id, owner_home_id, kind, title, description, time_zone, target,
        unit, unit_kind, deadline, series_id, period_start, period_end)
      values (gen_random_uuid(), p_series.owner_user_id, p_series.owner_home_id, p_series.kind, p_series.title,
        p_series.description, p_series.time_zone, v_target.target, v_target.unit, v_target.unit_kind, p_end,
        p_series.id, p_start, p_end)
      on conflict (series_id, period_start) where series_id is not null do nothing
      returning * into v_goal;
    if v_goal.id is null then
      return null;
    end if;
    -- No initial entry: a period starts at 0, and nothing is carried over from the one before.
    perform private.goal_event(v_goal.id, 'created', null, null,
      pg_catalog.jsonb_build_object('kind', v_goal.kind, 'target', v_goal.target, 'series', true,
        'periodStart', p_start, 'periodEnd', p_end));
    if p_series.reminder_lead_days is not null then
      insert into private.goal_reminders (goal_id, enabled, lead_days, overdue_days, at_time, updated_by)
        values (v_goal.id, true, p_series.reminder_lead_days, null, p_series.reminder_at_time, null);
      perform private.schedule_goal_reminders(v_goal.id);
    end if;
    return v_goal.id;
  end
  $$;

-- Rolls one series at p_now: finalizes every period whose last day has passed and, when the series is
-- active, creates the current period if it starts on or after the first period, on or before the end
-- date, and does not exist yet. A series whose next period would start after its end date stops.
-- Never backfills. Records when the next rollover has work. Idempotent; answers the periods created.
create function private.roll_goal_series(p_series_id uuid, p_now timestamptz) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_series private.goal_series;
    v_zone text;
    v_today date;
    v_goal private.goals;
    v_start date;
    v_end date;
    v_created integer := 0;
    v_next timestamptz;
  begin
    select * into v_series from private.goal_series s where s.id = p_series_id for update;
    if v_series.id is null or v_series.deleted_at is not null then
      return 0;
    end if;
    v_zone := private.goal_series_zone(v_series);
    v_today := (p_now at time zone v_zone)::date;
    for v_goal in select * from private.goals g
        where g.series_id = v_series.id and g.finalized_at is null and g.period_end < v_today
        order by g.period_start for update loop
      perform private.finalize_goal_period(v_goal);
    end loop;
    select b.period_start, b.period_end into v_start, v_end
      from private.goal_period_bounds(v_series.frequency, v_series.week_start, v_today) b;
    if v_series.state <> 'stopped' and v_series.ends_on is not null and v_start > v_series.ends_on then
      update private.goal_series s set state = 'stopped', stopped_at = p_now, stopped_by = null,
          revision = s.revision + 1, updated_at = pg_catalog.now()
        where s.id = v_series.id returning * into v_series;
      perform private.goal_series_event(v_series.id, 'stopped', null,
        pg_catalog.jsonb_build_object('endsOn', v_series.ends_on, 'automatic', true));
    end if;
    if v_series.state = 'active' and v_start >= v_series.first_period_start
       and not exists (select 1 from private.goals g where g.series_id = v_series.id and g.period_start = v_start) then
      if private.create_goal_period(v_series, v_start, v_end) is not null then
        v_created := 1;
      end if;
    end if;
    -- The next moment with work: the end of a period still to finalize, the start of the next period
    -- of an active series, or the first period of one that has not started.
    select min(x.at) into v_next from (
      select private.goal_local_midnight(g.period_end + 1, v_zone) as at
        from private.goals g where g.series_id = v_series.id and g.finalized_at is null
      union all
      select private.goal_local_midnight(case when v_today < v_series.first_period_start
          then v_series.first_period_start else v_end + 1 end, v_zone)
        where v_series.state = 'active'
    ) x;
    update private.goal_series s set next_roll_at = v_next where s.id = v_series.id
      and s.next_roll_at is distinct from v_next;
    return v_created;
  end
  $$;

-- The background rollover (service role, the hourly schedule): rolls the series whose next work has
-- come, oldest first, at most p_limit (default 200); one locked by a person's change waits for the next
-- run. Answers the periods created.
create function public.roll_goal_periods(p_limit integer default null) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_created integer := 0;
  begin
    for v_id in select s.id from private.goal_series s
        where s.next_roll_at <= pg_catalog.now() and s.deleted_at is null
        order by s.next_roll_at, s.id
        limit least(coalesce(p_limit, private.goal_limit('roll_batch')), private.goal_limit('roll_batch'))
        for update skip locked loop
      v_created := v_created + private.roll_goal_series(v_id, pg_catalog.now());
    end loop;
    return v_created;
  end
  $$;

-- Rolls the caller's context before a read: the series of a Home they are in (or their Personal space)
-- whose next work has come, or one series they may see. Answers the periods created. 42501 for a Home
-- the caller is not in.
create function public.sync_goal_periods(p_home_id uuid default null, p_series_id uuid default null)
returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
    v_created integer := 0;
  begin
    if p_series_id is not null then
      if private.goal_series_for(p_series_id, v_user_id) is null then
        return 0;
      end if;
      return private.roll_goal_series(p_series_id, pg_catalog.now());
    end if;
    perform private.require_goal_context(p_home_id, v_user_id);
    for v_id in select s.id from private.goal_series s
        where s.next_roll_at <= pg_catalog.now() and s.deleted_at is null
          and ((p_home_id is null and s.owner_home_id is null and s.owner_user_id = v_user_id)
            or (p_home_id is not null and s.owner_home_id = p_home_id))
        order by s.next_roll_at, s.id
        limit private.goal_limit('series') loop
      v_created := v_created + private.roll_goal_series(v_id, pg_catalog.now());
    end loop;
    return v_created;
  end
  $$;

-- Reminders (S30, now also silent for an ended period or a series in the trash) ---------------------------

create or replace function private.schedule_goal_reminders(p_goal_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
    v_reminder private.goal_reminders;
    v_moment record;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id;
    select * into v_reminder from private.goal_reminders r where r.goal_id = p_goal_id;
    if v_goal.id is null or private.goal_hidden(v_goal) or v_goal.archived_at is not null
       or v_goal.achieved_at is not null or v_goal.deadline is null or private.goal_period_ended(v_goal)
       or v_reminder.goal_id is null or not v_reminder.enabled then
      return;
    end if;
    for v_moment in select * from private.goal_reminder_moments(v_goal, v_goal.deadline, v_reminder.lead_days,
        v_reminder.overdue_days, v_reminder.at_time) m where m.at > pg_catalog.now() loop
      perform private.enqueue_job('goal-reminder', 1,
        'goal-reminder:' || v_goal.id::text || ':' || v_reminder.revision::text || ':' || v_moment.kind,
        pg_catalog.jsonb_build_object('goalId', v_goal.id, 'revision', v_reminder.revision,
          'kind', v_moment.kind, 'at', private.habit_utc_text(v_moment.at)),
        null, v_moment.at);
    end loop;
  end
  $$;

create or replace function public.deliver_goal_reminder(p_goal_id uuid, p_revision integer, p_kind text, p_at timestamptz)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
    v_reminder private.goal_reminders;
    v_user_id uuid;
  begin
    if p_goal_id is null or p_revision is null or p_at is null or p_kind is null
       or p_kind not in ('lead', 'overdue') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_goal from private.goals g where g.id = p_goal_id for update;
    select * into v_reminder from private.goal_reminders r where r.goal_id = p_goal_id;
    if v_goal.id is null or private.goal_hidden(v_goal) or v_reminder.goal_id is null
       or v_reminder.revision <> p_revision or not v_reminder.enabled then
      return 'stale';
    end if;
    if p_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    if pg_catalog.now() > p_at + pg_catalog.make_interval(mins => private.goal_limit('late_minutes')) then
      return 'late';
    end if;
    if v_goal.archived_at is not null or v_goal.achieved_at is not null or v_goal.deadline is null
       or private.goal_period_ended(v_goal) then
      return 'inactive';
    end if;
    for v_user_id in select * from private.goal_reminder_recipients(v_goal) loop
      perform private.notify_user(v_user_id, v_goal.owner_home_id, 'reminders', 'goal.reminder',
        pg_catalog.jsonb_build_object('homeId', v_goal.owner_home_id, 'goalId', v_goal.id, 'reminder', p_kind,
          'deadline', v_goal.deadline),
        'goal-reminder:' || v_goal.id::text || ':' || v_user_id::text || ':' || p_revision::text || ':' || p_kind,
        true);
    end loop;
    return 'notified';
  end
  $$;

-- Answers ------------------------------------------------------------------------------------------------

-- A goal as the viewer sees it (S30), with its period when it belongs to a series: the period, the
-- series' frequency, the calculated outcome once the period ended, whether a correction changed the
-- finalized result, and whether an explicit achievement now needs review. After a period ends only
-- goal managers change it, and nobody adds progress.
create or replace function private.goal_summary_json(p_goal private.goals, p_viewer uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := private.goal_today(p_goal);
    v_total numeric := private.goal_total(p_goal);
    v_role text := private.goal_role(p_goal, p_viewer);
    v_reached boolean := p_goal.kind = 'measurable' and v_total >= p_goal.target;
    v_open boolean := p_goal.archived_at is null and p_goal.achieved_at is null;
    v_ended boolean := p_goal.series_id is not null and v_today > p_goal.period_end;
    v_renewed private.goals;
    v_series private.goal_series;
  begin
    if p_goal.renewed_from is not null then
      v_renewed := private.goal_for(p_goal.renewed_from, p_viewer);
    end if;
    if p_goal.series_id is not null then
      select * into v_series from private.goal_series s where s.id = p_goal.series_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'id', p_goal.id,
      'homeId', p_goal.owner_home_id,
      'kind', p_goal.kind,
      'title', p_goal.title,
      'description', p_goal.description,
      'timeZone', private.goal_zone(p_goal),
      'today', v_today,
      'revision', p_goal.revision,
      'status', private.goal_status(p_goal, v_today),
      'deadline', p_goal.deadline,
      'target', p_goal.target,
      'unit', p_goal.unit,
      'unitKind', p_goal.unit_kind,
      'total', coalesce(v_total, 0),
      'reached', v_reached,
      'achievedAt', p_goal.achieved_at,
      'achievedBy', private.goal_person(p_goal, p_goal.achieved_by),
      'achievedByMe', coalesce(p_goal.achieved_by = p_viewer, false),
      'archivedAt', p_goal.archived_at,
      'createdAt', p_goal.created_at,
      'renewedFrom', case when v_renewed.id is not null then
        pg_catalog.jsonb_build_object('id', v_renewed.id, 'title', v_renewed.title) end,
      'reminders', coalesce((select r.enabled from private.goal_reminders r where r.goal_id = p_goal.id), false),
      'myReminders', p_goal.owner_home_id is null or not exists (select 1 from private.goal_reminder_optouts o
        where o.goal_id = p_goal.id and o.user_id = p_viewer),
      'access', v_role,
      'period', case when v_series.id is not null then pg_catalog.jsonb_build_object(
        'seriesId', v_series.id, 'seriesTitle', v_series.title, 'frequency', v_series.frequency,
        'start', p_goal.period_start, 'end', p_goal.period_end, 'ended', v_ended,
        'outcome', case when v_ended then private.goal_period_outcome(p_goal) end,
        'finalizedAt', p_goal.finalized_at, 'correctedAt', p_goal.outcome_corrected_at,
        'needsReview', p_goal.kind = 'measurable' and p_goal.achieved_at is not null and v_total < p_goal.target) end,
      'actions', pg_catalog.jsonb_build_object(
        'contribute', v_open and not v_ended and p_goal.kind = 'measurable'
          and private.goal_may(p_goal, p_viewer, 'contribute'),
        'setTotal', v_open and p_goal.kind = 'measurable' and v_role = 'manage',
        'achieve', v_open and case
          when v_ended then v_role = 'manage' and (p_goal.kind = 'completion' or v_reached)
          when p_goal.kind = 'completion' then private.goal_may(p_goal, p_viewer, 'contribute')
          else v_role = 'manage' and v_reached end,
        'reopen', p_goal.archived_at is null and p_goal.achieved_at is not null and v_role = 'manage',
        'manage', v_role = 'manage'));
  end
  $$;

-- An entry as the viewer sees it (S30); in an ended period only goal managers may correct it.
create or replace function private.goal_entry_json(p_entry private.goal_entries, p_goal private.goals, p_viewer uuid)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_entry.id, 'kind', p_entry.kind, 'quantity', p_entry.quantity,
    'originalQuantity', p_entry.original_quantity, 'unit', p_entry.unit, 'unitKind', p_entry.unit_kind,
    'note', p_entry.note,
    'by', private.goal_person(p_goal, p_entry.contributed_by),
    'mine', coalesce(p_entry.contributed_by = p_viewer, false),
    'recordedAt', p_entry.recorded_at, 'source', p_entry.source, 'status', p_entry.status,
    'amendedAt', p_entry.amended_at, 'reversedAt', p_entry.reversed_at,
    'corrections', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'action', c.action, 'before', c.before_quantity, 'after', c.after_quantity,
        'by', private.goal_person(p_goal, c.actor), 'mine', coalesce(c.actor = p_viewer, false),
        'at', c.at, 'reason', c.reason) order by c.at, c.id)
      from private.goal_entry_corrections c where c.entry_id = p_entry.id), '[]'::jsonb),
    'action', case
      when p_entry.status <> 'active' or p_goal.archived_at is not null then null
      when private.goal_may(p_goal, p_viewer, 'manage') then 'correct'
      when private.goal_period_ended(p_goal) then null
      when p_entry.kind = 'contribution' and p_entry.contributed_by = p_viewer
        and private.goal_may(p_goal, p_viewer, 'contribute') then 'reverse'
    end);
  $$;

-- A series as a list shows it: its definition, state and current period.
create function private.goal_series_summary_json(p_series private.goal_series, p_viewer uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := (pg_catalog.now() at time zone private.goal_series_zone(p_series))::date;
    v_current private.goals;
    v_target private.goal_series_targets;
    v_start date;
    v_end date;
  begin
    select b.period_start, b.period_end into v_start, v_end
      from private.goal_period_bounds(p_series.frequency, p_series.week_start, v_today) b;
    select * into v_current from private.goals g
      where g.series_id = p_series.id and g.period_start = v_start and g.deleted_at is null;
    if p_series.kind = 'measurable' then
      v_target := private.goal_series_target_for(p_series.id, greatest(v_start, p_series.first_period_start));
    end if;
    return pg_catalog.jsonb_build_object(
      'id', p_series.id,
      'homeId', p_series.owner_home_id,
      'kind', p_series.kind,
      'frequency', p_series.frequency,
      'weekStart', p_series.week_start,
      'title', p_series.title,
      'state', p_series.state,
      'firstPeriodStart', p_series.first_period_start,
      'endsOn', p_series.ends_on,
      'revision', p_series.revision,
      'target', v_target.target,
      'unit', v_target.unit,
      'unitKind', v_target.unit_kind,
      'current', case when v_current.id is not null then pg_catalog.jsonb_build_object(
        'id', v_current.id, 'start', v_current.period_start, 'end', v_current.period_end,
        'total', coalesce(private.goal_total(v_current), 0), 'target', v_current.target,
        'unit', v_current.unit, 'unitKind', v_current.unit_kind,
        'status', private.goal_status(v_current, v_today)) end,
      'access', private.goal_series_role(p_series, p_viewer));
  end
  $$;

-- Reading -----------------------------------------------------------------------------------------------

-- The goals of a context (S30). Periods appear in Active while they run; once they end or are achieved
-- they live in their series' history, not in Completed. 'series': the context's series.
create or replace function public.get_goals(p_home_id uuid default null, p_view text default 'active', p_query text default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_rows jsonb;
    v_query text := nullif(pg_catalog.btrim(p_query), '');
  begin
    perform private.require_goal_context(p_home_id, v_user_id);
    if p_view is null or p_view not in ('active', 'completed', 'archived')
       or (v_query is not null and char_length(v_query) > private.goal_limit('query')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    with g as (
      select x.id, x.title, x.achieved_at, x.deadline, x.series_id,
        private.goal_status(x, private.goal_today(x)) as status
      from private.goals x
      where not private.goal_hidden(x)
        and ((p_home_id is null and x.owner_home_id is null and x.owner_user_id = v_user_id)
          or (p_home_id is not null and x.owner_home_id = p_home_id))
    )
    select pg_catalog.jsonb_build_object(
      'goals', coalesce((
        select pg_catalog.jsonb_agg(private.goal_summary_json(
            (select y from private.goals y where y.id = g.id), v_user_id)
          order by case when p_view = 'completed' then g.achieved_at end desc nulls last,
            g.deadline nulls last, pg_catalog.lower(g.title), g.id)
        from g
        where case p_view when 'archived' then g.status = 'archived'
            when 'completed' then g.status = 'achieved' and g.series_id is null
            else g.status in ('active', 'overdue') end
          and (v_query is null or pg_catalog.strpos(pg_catalog.lower(g.title), pg_catalog.lower(v_query)) > 0)),
        '[]'::jsonb),
      'counts', pg_catalog.jsonb_build_object(
        'active', (select count(*) from g where g.status in ('active', 'overdue')),
        'completed', (select count(*) from g where g.status = 'achieved' and g.series_id is null),
        'archived', (select count(*) from g where g.status = 'archived')),
      'series', coalesce((
        select pg_catalog.jsonb_agg(private.goal_series_summary_json(s, v_user_id)
          order by case s.state when 'active' then 0 when 'paused' then 1 else 2 end,
            pg_catalog.lower(s.title), s.id)
        from private.goal_series s
        where s.deleted_at is null
          and ((p_home_id is null and s.owner_home_id is null and s.owner_user_id = v_user_id)
            or (p_home_id is not null and s.owner_home_id = p_home_id))
          and (v_query is null or pg_catalog.strpos(pg_catalog.lower(s.title), pg_catalog.lower(v_query)) > 0)),
        '[]'::jsonb))
    into v_rows;
    return v_rows || pg_catalog.jsonb_build_object(
      'access', private.goal_access(p_home_id, v_user_id),
      'memberAccess', case when p_home_id is not null then coalesce(
        (select s.member_access from private.goal_settings s where s.home_id = p_home_id), 'contribute') end,
      'timeZone', case when p_home_id is not null then (select h.timezone from public.homes h where h.id = p_home_id) end);
  end
  $$;

create or replace function public.goal_notice_names(p_goal_ids uuid[])
returns table (goal_id uuid, title text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_goal_ids is null or cardinality(p_goal_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    return query
      select g.id, g.title from private.goals g
      where g.id = any (p_goal_ids) and not private.goal_hidden(g) and private.goal_may(g, v_user_id, 'view');
  end
  $$;

-- One series with everything its page shows, or null when the caller may not see it: the summary, the
-- timezone and today, the current and next periods, the target schedule, the reminder template, the
-- newest history (50) and what the caller may do.
create function public.get_goal_series(p_series_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series := private.goal_series_for(p_series_id, v_user_id);
    v_zone text;
    v_today date;
    v_start date;
    v_end date;
    v_next_start date;
    v_next_end date;
    v_role text;
  begin
    if v_series.id is null then
      return null;
    end if;
    v_zone := private.goal_series_zone(v_series);
    v_today := (pg_catalog.now() at time zone v_zone)::date;
    v_role := private.goal_series_role(v_series, v_user_id);
    select b.period_start, b.period_end into v_start, v_end
      from private.goal_period_bounds(v_series.frequency, v_series.week_start,
        greatest(v_today, v_series.first_period_start)) b;
    select b.period_start, b.period_end into v_next_start, v_next_end
      from private.goal_period_bounds(v_series.frequency, v_series.week_start, v_end + 1) b;
    return private.goal_series_summary_json(v_series, v_user_id) || pg_catalog.jsonb_build_object(
      'description', v_series.description,
      'timeZone', v_zone,
      'today', v_today,
      'createdAt', v_series.created_at,
      'stoppedAt', v_series.stopped_at,
      'reminder', case when v_series.reminder_lead_days is not null then pg_catalog.jsonb_build_object(
        'leadDays', v_series.reminder_lead_days, 'atTime', pg_catalog.to_char(v_series.reminder_at_time, 'HH24:MI')) end,
      -- The period running now (or the first one, before the series starts) and the one after it.
      'currentPeriod', pg_catalog.jsonb_build_object('start', v_start, 'end', v_end),
      'nextPeriod', case when v_series.state <> 'stopped' and (v_series.ends_on is null or v_next_start <= v_series.ends_on)
        then pg_catalog.jsonb_build_object('start', v_next_start, 'end', v_next_end) end,
      'targets', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'effectiveFrom', t.effective_from, 'target', t.target, 'unit', t.unit, 'unitKind', t.unit_kind,
          'past', t.effective_from < v_start) order by t.effective_from)
        from private.goal_series_targets t where t.series_id = v_series.id), '[]'::jsonb),
      'events', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', x.id, 'kind', x.kind,
          'by', case when v_series.owner_home_id is not null and x.actor is not null
            then private.member_ref(v_series.owner_home_id, x.actor) end,
          'mine', coalesce(x.actor = v_user_id, false), 'at', x.at, 'details', x.details)
          order by x.at desc, x.id desc)
        from (select * from private.goal_series_events e where e.series_id = v_series.id
          order by e.at desc, e.id desc limit private.goal_limit('page')) x), '[]'::jsonb),
      'periodCount', (select count(*) from private.goals g where g.series_id = v_series.id and g.deleted_at is null),
      'actions', pg_catalog.jsonb_build_object(
        'manage', v_role = 'manage',
        'changeTarget', v_role = 'manage' and v_series.kind = 'measurable' and v_series.state <> 'stopped',
        'pause', v_role = 'manage' and v_series.state = 'active',
        'resume', v_role = 'manage' and v_series.state = 'paused',
        'stop', v_role = 'manage' and v_series.state <> 'stopped'));
  end
  $$;

-- A page of a series' periods (newest first) after the period p_before (none: the newest), each as a
-- goal summary. Periods in the trash are left out. Null when the caller may not see the series; 22023
-- for a cursor that is not one of its periods.
create function public.get_goal_series_periods(p_series_id uuid, p_before uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series := private.goal_series_for(p_series_id, v_user_id);
    v_cursor private.goals;
    v_rows jsonb;
  begin
    if v_series.id is null then
      return null;
    end if;
    if p_before is not null then
      select * into v_cursor from private.goals g where g.id = p_before and g.series_id = v_series.id;
      if v_cursor.id is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;
    select coalesce(pg_catalog.jsonb_agg(private.goal_summary_json(x, v_user_id) order by x.period_start desc), '[]'::jsonb)
      into v_rows
      from (select * from private.goals g
        where g.series_id = v_series.id and g.deleted_at is null
          and (v_cursor.id is null or g.period_start < v_cursor.period_start)
        order by g.period_start desc limit private.goal_limit('page') + 1) x;
    return pg_catalog.jsonb_build_object(
      'periods', (select coalesce(pg_catalog.jsonb_agg(v order by o), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(v_rows) with ordinality as t (v, o) where o <= private.goal_limit('page')),
      'hasMore', pg_catalog.jsonb_array_length(v_rows) > private.goal_limit('page'));
  end
  $$;

-- Series -------------------------------------------------------------------------------------------------

-- The first and next periods a new series would have (for the preview).
create function private.goal_series_preview(
  p_frequency text, p_week_start text, p_first date, p_ends_on date
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'first', pg_catalog.jsonb_build_object('start', a.period_start, 'end', a.period_end),
    'next', case when p_ends_on is null or b.period_start <= p_ends_on
      then pg_catalog.jsonb_build_object('start', b.period_start, 'end', b.period_end) end)
  from private.goal_period_bounds(p_frequency, p_week_start, p_first) a
  cross join lateral private.goal_period_bounds(p_frequency, p_week_start, a.period_end + 1) b;
  $$;

-- Creates a recurring goal series (a personal series; a Home series: goal managers). Measurable series
-- repeat weekly, monthly or yearly with a target and unit; completion series monthly or yearly.
-- p_first_period: a date in the first period, which is the current period or a later one (never an
-- earlier one: nothing is backfilled); p_ends_on: no period starts after it. p_week_start applies to
-- weekly series. An advance reminder (p_reminder_lead_days, p_reminder_at_time) is copied into every
-- new period. p_dry_run answers the first and next periods without saving. The current period is
-- created at once when the series starts now. Outcomes: 'preview', 'created' (with the current period's
-- goal id, if any), 'exists' (a retry of the caller's own create), 'id_taken', 'invalid_dates',
-- 'too_many', 'not_permitted'. 42501 for a Home the caller is not in; 22023 for invalid fields.
create function public.create_goal_series(
  p_id uuid, p_home_id uuid default null, p_kind text default null, p_frequency text default null,
  p_title text default null, p_description text default null, p_target numeric default null,
  p_unit text default null, p_unit_kind text default null, p_week_start text default 'monday',
  p_first_period date default null, p_ends_on date default null, p_time_zone text default null,
  p_reminder_lead_days smallint default null, p_reminder_at_time time default null,
  p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.goal_series;
    v_series private.goal_series;
    v_zone text;
    v_today date;
    v_current date;
    v_first date;
    v_goal_id uuid;
  begin
    perform private.require_goal_context(p_home_id, v_user_id);
    if p_id is null or p_dry_run is null or p_title is null
       or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description')))
       or p_kind is null or p_kind not in ('completion', 'measurable')
       or p_frequency is null or p_frequency not in ('weekly', 'monthly', 'yearly')
       or (p_kind = 'completion' and p_frequency = 'weekly')
       or p_week_start is null or p_week_start not in ('monday', 'saturday', 'sunday')
       or not private.valid_goal_shape(p_kind, p_target, p_unit, p_unit_kind)
       or p_first_period is null
       or (p_home_id is null and not private.valid_time_zone(p_time_zone))
       or (p_reminder_lead_days is null) <> (p_reminder_at_time is null)
       or (p_reminder_lead_days is not null and p_reminder_lead_days not between 1 and private.goal_limit('lead_days'))
       or (p_reminder_at_time is not null and p_reminder_at_time <> date_trunc('minute', p_reminder_at_time)) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    if private.goal_access(p_home_id, v_user_id) is distinct from 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_zone := case when p_home_id is null then p_time_zone
      else (select h.timezone from public.homes h where h.id = p_home_id) end;
    v_today := (pg_catalog.now() at time zone v_zone)::date;
    select b.period_start into v_current from private.goal_period_bounds(p_frequency, p_week_start, v_today) b;
    select b.period_start into v_first from private.goal_period_bounds(p_frequency, p_week_start, p_first_period) b;
    if v_first < v_current or (p_ends_on is not null and p_ends_on < v_first) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'startsNow', v_first = v_current,
        'periods', private.goal_series_preview(p_frequency, p_week_start, v_first, p_ends_on));
    end if;
    select * into v_existing from private.goal_series s where s.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by = v_user_id and v_existing.owner_home_id is not distinct from p_home_id then
        return pg_catalog.jsonb_build_object('outcome', 'exists', 'revision', v_existing.revision);
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    -- Counted under the context lock, so two creates cannot both pass the limit.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('goals:' || coalesce(p_home_id, v_user_id)::text, 0));
    if (select count(*) from private.goal_series s
        where s.deleted_at is null and s.state <> 'stopped'
          and ((p_home_id is null and s.owner_home_id is null and s.owner_user_id = v_user_id)
            or (p_home_id is not null and s.owner_home_id = p_home_id))) >= private.goal_limit('series') then
      return pg_catalog.jsonb_build_object('outcome', 'too_many');
    end if;
    insert into private.goal_series (id, owner_user_id, owner_home_id, kind, frequency, week_start, title,
        description, time_zone, first_period_start, ends_on, reminder_lead_days, reminder_at_time,
        created_by, updated_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_kind, p_frequency, p_week_start,
        p_title, p_description, case when p_home_id is null then p_time_zone end, v_first, p_ends_on,
        p_reminder_lead_days, p_reminder_at_time, v_user_id, v_user_id)
      returning * into v_series;
    if p_kind = 'measurable' then
      insert into private.goal_series_targets (series_id, effective_from, target, unit, unit_kind, created_by)
        values (v_series.id, v_first, p_target, p_unit, p_unit_kind, v_user_id);
    end if;
    perform private.goal_series_event(v_series.id, 'created', v_user_id,
      pg_catalog.jsonb_build_object('kind', p_kind, 'frequency', p_frequency, 'firstPeriodStart', v_first,
        'endsOn', p_ends_on, 'target', p_target));
    perform private.audit_goal_series('goal_series.created', v_series);
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    select g.id into v_goal_id from private.goals g where g.series_id = v_series.id and g.period_start = v_first;
    return pg_catalog.jsonb_build_object('outcome', 'created', 'revision', v_series.revision,
      'currentGoalId', v_goal_id);
  end
  $$;

-- Edits a series (goal managers), from the revision the caller saw: title, description, end date,
-- (personal) timezone and the advance reminder. They apply to the periods created afterwards; a
-- period's own title stays its own. A changed timezone also moves the periods still to finalize. The
-- end date cannot be before the period running now. Outcomes: 'saved', 'unchanged', 'conflict',
-- 'invalid_dates', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.update_goal_series(
  p_id uuid, p_expected_revision integer, p_title text, p_description text default null,
  p_ends_on date default null, p_time_zone text default null,
  p_reminder_lead_days smallint default null, p_reminder_at_time time default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
    v_zone_changed boolean;
    v_current date;
    v_goal_id uuid;
  begin
    if p_id is null or p_expected_revision is null or p_title is null
       or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description')))
       or (p_reminder_lead_days is null) <> (p_reminder_at_time is null)
       or (p_reminder_lead_days is not null and p_reminder_lead_days not between 1 and private.goal_limit('lead_days'))
       or (p_reminder_at_time is not null and p_reminder_at_time <> date_trunc('minute', p_reminder_at_time)) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    v_series := private.goal_series_lock(p_id, v_user_id);
    if v_series.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if private.goal_series_role(v_series, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_series.owner_home_id is null and not private.valid_time_zone(p_time_zone) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    if v_series.revision <> p_expected_revision then
      return query select 'conflict', v_series.revision;
      return;
    end if;
    v_zone_changed := v_series.owner_home_id is null and p_time_zone <> v_series.time_zone;
    if p_title = v_series.title and p_description is not distinct from v_series.description
       and p_ends_on is not distinct from v_series.ends_on and not v_zone_changed
       and p_reminder_lead_days is not distinct from v_series.reminder_lead_days
       and p_reminder_at_time is not distinct from v_series.reminder_at_time then
      return query select 'unchanged', v_series.revision;
      return;
    end if;
    select b.period_start into v_current from private.goal_period_bounds(v_series.frequency, v_series.week_start,
      (pg_catalog.now() at time zone case when v_zone_changed then p_time_zone
        else private.goal_series_zone(v_series) end)::date) b;
    if p_ends_on is distinct from v_series.ends_on and p_ends_on is not null
       and p_ends_on < greatest(v_current, v_series.first_period_start) then
      return query select 'invalid_dates', v_series.revision;
      return;
    end if;
    update private.goal_series s set title = p_title, description = p_description, ends_on = p_ends_on,
        time_zone = case when s.owner_home_id is null then p_time_zone end,
        reminder_lead_days = p_reminder_lead_days, reminder_at_time = p_reminder_at_time,
        revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_series.id returning * into v_series;
    if v_zone_changed then
      for v_goal_id in select g.id from private.goals g where g.series_id = v_series.id and g.finalized_at is null
          order by g.period_start for update loop
        update private.goals g set time_zone = p_time_zone, revision = g.revision + 1 where g.id = v_goal_id;
        perform private.reschedule_goal_reminders(v_goal_id);
      end loop;
    end if;
    perform private.goal_series_event(v_series.id, 'edited', v_user_id,
      pg_catalog.jsonb_build_object('endsOn', v_series.ends_on, 'timeZone', v_zone_changed,
        'reminder', v_series.reminder_lead_days is not null));
    perform private.audit_goal_series('goal_series.updated', v_series);
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    return query select 'saved', (select s.revision from private.goal_series s where s.id = v_series.id);
  end
  $$;

-- Pauses, resumes or stops a series (goal managers), from the revision the caller saw. Paused: no new
-- periods (the current one runs to its end). Resumed: the current period is created if missing, never
-- the ones that passed. Stopped: final. Outcomes: 'saved', 'unchanged', 'stopped' (a stopped series
-- cannot resume or pause), 'conflict', 'not_found', 'not_permitted'. 22023 for another action.
create function public.set_goal_series_state(p_id uuid, p_expected_revision integer, p_action text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
    v_state text;
  begin
    if p_id is null or p_expected_revision is null or p_action is null
       or p_action not in ('pause', 'resume', 'stop') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_series := private.goal_series_lock(p_id, v_user_id);
    if v_series.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if private.goal_series_role(v_series, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_series.revision <> p_expected_revision then
      return query select 'conflict', v_series.revision;
      return;
    end if;
    v_state := case p_action when 'pause' then 'paused' when 'resume' then 'active' else 'stopped' end;
    if v_series.state = v_state then
      return query select 'unchanged', v_series.revision;
      return;
    end if;
    if v_series.state = 'stopped' then
      return query select 'stopped', v_series.revision;
      return;
    end if;
    update private.goal_series s set state = v_state,
        stopped_at = case when v_state = 'stopped' then pg_catalog.now() end,
        stopped_by = case when v_state = 'stopped' then v_user_id end,
        revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_series.id returning * into v_series;
    perform private.goal_series_event(v_series.id,
      case p_action when 'pause' then 'paused' when 'resume' then 'resumed' else 'stopped' end, v_user_id);
    perform private.audit_goal_series('goal_series.' || v_state, v_series);
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    return query select 'saved', (select s.revision from private.goal_series s where s.id = v_series.id);
  end
  $$;

-- Changes a measurable series' target and unit from a period on (goal managers), from the revision the
-- caller saw. p_effective_from: the start of the period running now or of a later one (the form
-- defaults to the next); never an earlier one, and not after the end date. Past periods keep their own
-- targets. When it is the period running now, that period's goal changes too, under the S30 rules: a
-- unit change on a period with progress needs p_confirm_unit, and a change that flips "target reached"
-- needs p_confirm_status (on an achieved period below the new target, confirming reopens the
-- achievement, kept in its history). p_dry_run answers the impact without saving. Outcomes: 'preview',
-- 'saved', 'unchanged', 'confirm_unit', 'confirm_status', 'conflict', 'invalid_period', 'stopped',
-- 'not_measurable', 'not_found', 'not_permitted', each with the impact where it explains it. 22023 for
-- an invalid target or unit.
create function public.change_goal_series_target(
  p_id uuid, p_expected_revision integer, p_effective_from date, p_target numeric, p_unit text,
  p_unit_kind text, p_dry_run boolean default false, p_confirm_unit boolean default false,
  p_confirm_status boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
    v_today date;
    v_current date;
    v_before private.goal_series_targets;
    v_until date;
    v_goal private.goals;
    v_total numeric;
    v_unit_changed boolean;
    v_reached_before boolean;
    v_reached_after boolean;
    v_reopens boolean := false;
    v_impact jsonb;
  begin
    if p_id is null or p_expected_revision is null or p_effective_from is null or p_dry_run is null
       or p_confirm_unit is null or p_confirm_status is null
       or not private.valid_goal_shape('measurable', p_target, p_unit, p_unit_kind) then
      raise exception 'invalid target' using errcode = '22023';
    end if;
    v_series := private.goal_series_lock(p_id, v_user_id);
    if v_series.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if private.goal_series_role(v_series, v_user_id) is distinct from 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_series.kind <> 'measurable' then
      return pg_catalog.jsonb_build_object('outcome', 'not_measurable');
    end if;
    if v_series.state = 'stopped' then
      return pg_catalog.jsonb_build_object('outcome', 'stopped');
    end if;
    if v_series.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', v_series.revision);
    end if;
    -- The period running now exists (or does not) before anything is decided about it.
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    select * into v_series from private.goal_series s where s.id = v_series.id;
    v_today := (pg_catalog.now() at time zone private.goal_series_zone(v_series))::date;
    select b.period_start into v_current from private.goal_period_bounds(v_series.frequency, v_series.week_start, v_today) b;
    if (select b.period_start from private.goal_period_bounds(v_series.frequency, v_series.week_start, p_effective_from) b)
         <> p_effective_from
       or p_effective_from < greatest(v_current, v_series.first_period_start)
       or (v_series.ends_on is not null and p_effective_from > v_series.ends_on) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_period');
    end if;
    v_before := private.goal_series_target_for(v_series.id, p_effective_from);
    select min(t.effective_from) into v_until from private.goal_series_targets t
      where t.series_id = v_series.id and t.effective_from > p_effective_from;
    if p_effective_from = v_current then
      select * into v_goal from private.goals g
        where g.series_id = v_series.id and g.period_start = v_current and g.deleted_at is null for update;
    end if;
    v_unit_changed := p_unit <> v_before.unit or p_unit_kind <> v_before.unit_kind;
    if v_goal.id is not null then
      v_total := private.goal_total(v_goal);
      v_reached_before := v_total >= v_goal.target;
      v_reached_after := v_total >= p_target;
      v_reopens := v_goal.achieved_at is not null and v_total < p_target;
    end if;
    v_impact := pg_catalog.jsonb_build_object(
      'effectiveFrom', p_effective_from, 'until', v_until, 'current', p_effective_from = v_current,
      'targetBefore', v_before.target, 'targetAfter', p_target,
      'unitBefore', v_before.unit, 'unitKindBefore', v_before.unit_kind,
      'unitAfter', p_unit, 'unitKindAfter', p_unit_kind, 'unitChanged', v_unit_changed,
      'goalId', v_goal.id, 'total', v_total, 'reachedBefore', v_reached_before, 'reachedAfter', v_reached_after,
      'achieved', v_goal.achieved_at is not null, 'reopens', v_reopens,
      'reminders', coalesce((select r.enabled from private.goal_reminders r where r.goal_id = v_goal.id), false));
    if p_target = v_before.target and not v_unit_changed then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    if v_goal.id is not null and v_unit_changed and not p_confirm_unit
       and exists (select 1 from private.goal_entries e where e.goal_id = v_goal.id and e.status = 'active' and e.quantity <> 0) then
      return pg_catalog.jsonb_build_object('outcome', 'confirm_unit', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    if v_goal.id is not null and (v_reached_before <> v_reached_after or v_reopens) and not p_confirm_status then
      return pg_catalog.jsonb_build_object('outcome', 'confirm_status', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    insert into private.goal_series_targets as t (series_id, effective_from, target, unit, unit_kind, created_by)
      values (v_series.id, p_effective_from, p_target, p_unit, p_unit_kind, v_user_id)
      on conflict (series_id, effective_from) do update set target = excluded.target, unit = excluded.unit,
        unit_kind = excluded.unit_kind, created_by = excluded.created_by, created_at = pg_catalog.now();
    if v_goal.id is not null then
      update private.goals g set target = p_target, unit = p_unit, unit_kind = p_unit_kind,
          achieved_at = case when v_reopens then null else g.achieved_at end,
          achieved_by = case when v_reopens then null else g.achieved_by end,
          revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where g.id = v_goal.id;
      if v_reopens then
        update private.goal_achievements a set reopened_at = pg_catalog.now(), reopened_by = v_user_id
          where a.goal_id = v_goal.id and a.reopened_at is null;
      end if;
      perform private.goal_event(v_goal.id, 'target_changed', v_user_id, null,
        pg_catalog.jsonb_build_object('targetBefore', v_goal.target, 'targetAfter', p_target,
          'unitBefore', v_goal.unit, 'unitKindBefore', v_goal.unit_kind, 'unitAfter', p_unit,
          'unitKindAfter', p_unit_kind, 'unitChanged', v_unit_changed, 'reopened', v_reopens, 'series', true));
      if v_reopens then
        perform private.reschedule_goal_reminders(v_goal.id);
      end if;
    end if;
    update private.goal_series s set revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_series.id returning * into v_series;
    perform private.goal_series_event(v_series.id, 'target_scheduled', v_user_id,
      pg_catalog.jsonb_build_object('effectiveFrom', p_effective_from, 'targetBefore', v_before.target,
        'targetAfter', p_target, 'unitBefore', v_before.unit, 'unitAfter', p_unit, 'unitChanged', v_unit_changed,
        'current', v_goal.id is not null, 'reopened', v_reopens));
    perform private.audit_goal_series('goal_series.target_changed', v_series,
      pg_catalog.jsonb_build_object('unitChanged', v_unit_changed, 'reopened', v_reopens));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_series.revision, 'impact', v_impact);
  end
  $$;

-- Moves a series with all its periods to the trash (goal managers), from the revision the caller saw.
-- Outcomes: 'deleted' (with the trash entry), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_goal_series(p_id uuid, p_expected_revision integer)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_series := private.goal_series_lock(p_id, v_user_id);
    if v_series.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if private.goal_series_role(v_series, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    if v_series.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    update private.goal_series s set deleted_at = pg_catalog.now(), updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where s.id = v_series.id;
    perform private.audit_goal_series('goal_series.deleted', v_series);
    return query select 'deleted', private.trash_move(v_user_id, 'goals', 'goal_series', v_series.id,
      v_series.owner_user_id, v_series.owner_home_id, v_series.title);
  end
  $$;

-- S30 goal functions that now know about periods -----------------------------------------------------------

-- create_goal (S30): periods do not count toward the goal limit.
create or replace function public.create_goal(
  p_id uuid, p_home_id uuid default null, p_kind text default null, p_title text default null,
  p_description text default null, p_target numeric default null, p_unit text default null,
  p_unit_kind text default null, p_initial numeric default null, p_deadline date default null,
  p_time_zone text default null, p_renewed_from uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.goals;
    v_goal private.goals;
    v_zone text;
  begin
    perform private.require_goal_context(p_home_id, v_user_id);
    if p_id is null or p_title is null or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description')))
       or not private.valid_goal_shape(p_kind, p_target, p_unit, p_unit_kind)
       or (p_kind = 'completion' and p_initial is not null)
       or (p_kind = 'measurable' and p_initial is not null
         and not private.valid_goal_quantity(p_initial, private.goal_unit_discrete(p_unit, p_unit_kind), true))
       or (p_home_id is null and not private.valid_time_zone(p_time_zone)) then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    if private.goal_access(p_home_id, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_existing from private.goals g where g.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by = v_user_id and v_existing.owner_home_id is not distinct from p_home_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if p_renewed_from is not null and private.goal_for(p_renewed_from, v_user_id) is null then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    v_zone := case when p_home_id is null then p_time_zone
      else (select h.timezone from public.homes h where h.id = p_home_id) end;
    if p_deadline is not null and p_deadline < (pg_catalog.now() at time zone v_zone)::date then
      return query select 'invalid_dates', null::integer;
      return;
    end if;
    -- Counted under the context lock, so two creates cannot both pass the limit.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('goals:' || coalesce(p_home_id, v_user_id)::text, 0));
    if (select count(*) from private.goals g
        where g.deleted_at is null and g.archived_at is null and g.series_id is null
          and ((p_home_id is null and g.owner_home_id is null and g.owner_user_id = v_user_id)
            or (p_home_id is not null and g.owner_home_id = p_home_id))) >= private.goal_limit('goals') then
      return query select 'too_many', null::integer;
      return;
    end if;
    insert into private.goals (id, owner_user_id, owner_home_id, kind, title, description, time_zone, target,
        unit, unit_kind, deadline, renewed_from, created_by, updated_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_kind, p_title, p_description,
        case when p_home_id is null then p_time_zone end, p_target, p_unit, p_unit_kind, p_deadline,
        p_renewed_from, v_user_id, v_user_id)
      returning * into v_goal;
    if p_kind = 'measurable' then
      insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, contributed_by, source)
        values (gen_random_uuid(), v_goal.id, 'initial', coalesce(p_initial, 0), v_goal.unit, v_goal.unit_kind,
          v_user_id, 'app');
    end if;
    perform private.goal_event(v_goal.id, 'created', v_user_id, null,
      pg_catalog.jsonb_build_object('kind', p_kind, 'target', p_target, 'initial', p_initial,
        'renewed', p_renewed_from is not null));
    perform private.audit_goal('goal.created', v_goal);
    return query select 'created', v_goal.revision;
  end
  $$;

-- update_goal (S30): a period's deadline (its last day) and timezone come from its series and cannot be
-- changed here; its title and description can.
create or replace function public.update_goal(
  p_id uuid, p_expected_revision integer, p_title text, p_description text default null,
  p_deadline date default null, p_time_zone text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_zone_changed boolean;
    v_deadline_changed boolean;
    v_deadline_before date;
    v_reminders_off boolean := false;
  begin
    if p_id is null or p_expected_revision is null or p_title is null
       or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description'))) then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.goal_may(v_goal, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_goal.owner_home_id is null and not private.valid_time_zone(p_time_zone) then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    if v_goal.series_id is not null and (p_deadline is distinct from v_goal.deadline
        or (v_goal.owner_home_id is null and p_time_zone <> v_goal.time_zone)) then
      raise exception 'invalid goal' using errcode = '22023';
    end if;
    if v_goal.revision <> p_expected_revision then
      return query select 'conflict', v_goal.revision;
      return;
    end if;
    v_zone_changed := v_goal.owner_home_id is null and p_time_zone <> v_goal.time_zone;
    v_deadline_before := v_goal.deadline;
    v_deadline_changed := p_deadline is distinct from v_goal.deadline;
    if p_title = v_goal.title and p_description is not distinct from v_goal.description
       and not v_zone_changed and not v_deadline_changed then
      return query select 'unchanged', v_goal.revision;
      return;
    end if;
    if v_deadline_changed and p_deadline is not null and p_deadline < (pg_catalog.now() at time zone
        case when v_zone_changed then p_time_zone else private.goal_zone(v_goal) end)::date then
      return query select 'invalid_dates', v_goal.revision;
      return;
    end if;
    update private.goals g set title = p_title, description = p_description,
        time_zone = case when g.owner_home_id is null then p_time_zone end, deadline = p_deadline,
        revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where g.id = v_goal.id returning * into v_goal;
    if p_deadline is null and v_deadline_changed then
      update private.goal_reminders r set enabled = false, revision = r.revision + 1, updated_by = v_user_id,
          updated_at = pg_catalog.now()
        where r.goal_id = v_goal.id and r.enabled;
      v_reminders_off := found;
    end if;
    if v_zone_changed or v_deadline_changed then
      perform private.reschedule_goal_reminders(v_goal.id);
    end if;
    perform private.goal_event(v_goal.id, 'edited', v_user_id, null,
      pg_catalog.jsonb_build_object('deadline', v_deadline_changed, 'timeZone', v_zone_changed)
        || case when v_deadline_changed then pg_catalog.jsonb_build_object('deadlineBefore', v_deadline_before,
          'deadlineAfter', p_deadline) else '{}'::jsonb end);
    if v_reminders_off then
      perform private.goal_event(v_goal.id, 'reminders_changed', v_user_id, null,
        pg_catalog.jsonb_build_object('enabled', false, 'deadlineRemoved', true));
    end if;
    perform private.audit_goal('goal.updated', v_goal, pg_catalog.jsonb_build_object('deadline', v_deadline_changed));
    return query select 'saved', v_goal.revision;
  end
  $$;

-- change_goal_target (S30): a period's target belongs to its series ('series_period': change it from
-- the series, effective from a period). The rest is unchanged.
alter function public.change_goal_target(uuid, integer, numeric, text, text, boolean, boolean, boolean)
  rename to change_goal_target_before_series;
revoke all on function public.change_goal_target_before_series(uuid, integer, numeric, text, text, boolean, boolean, boolean)
  from public, anon, authenticated;
alter function public.change_goal_target_before_series(uuid, integer, numeric, text, text, boolean, boolean, boolean)
  set schema private;

create function public.change_goal_target(
  p_id uuid, p_expected_revision integer, p_target numeric, p_unit text, p_unit_kind text,
  p_dry_run boolean default false, p_confirm_unit boolean default false, p_confirm_status boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
  begin
    v_goal := private.goal_for(p_id, v_user_id);
    if v_goal.series_id is not null then
      return pg_catalog.jsonb_build_object('outcome', 'series_period');
    end if;
    return private.change_goal_target_before_series(p_id, p_expected_revision, p_target, p_unit, p_unit_kind,
      p_dry_run, p_confirm_unit, p_confirm_status);
  end
  $$;

-- add_goal_entry (S30): nobody adds progress to a period that has ended ('period_ended'); goal managers
-- may still set its total (an audited historical correction), which recomputes its outcome.
create or replace function public.add_goal_entry(
  p_id uuid, p_goal_id uuid, p_mode text, p_quantity numeric, p_note text default null,
  p_source text default 'app', p_expected_total numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_existing private.goal_entries;
    v_total numeric;
    v_delta numeric;
  begin
    if p_id is null or p_goal_id is null or p_quantity is null or p_mode is null or p_mode not in ('add', 'total')
       or p_source is null or p_source not in ('app', 'widget')
       or (p_note is not null and not private.is_plain_text(p_note, private.goal_limit('note')))
       or (p_mode = 'total' and p_expected_total is null)
       or not private.valid_goal_quantity(p_quantity, false, p_mode = 'total') then
      raise exception 'invalid entry' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_goal_id, v_user_id);
    if v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_existing from private.goal_entries e where e.id = p_id;
    if v_existing.id is not null then
      if v_existing.goal_id = v_goal.id and v_existing.contributed_by = v_user_id then
        return pg_catalog.jsonb_build_object('outcome', 'exists', 'entryId', v_existing.id,
          'goal', private.goal_summary_json(v_goal, v_user_id));
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    if not private.goal_may(v_goal, v_user_id, case when p_mode = 'add' then 'contribute' else 'manage' end) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_goal.kind <> 'measurable' then
      return pg_catalog.jsonb_build_object('outcome', 'not_measurable');
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived', 'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if v_goal.achieved_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'achieved', 'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if p_mode = 'add' and private.goal_period_ended(v_goal) then
      return pg_catalog.jsonb_build_object('outcome', 'period_ended', 'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if not private.valid_goal_quantity(p_quantity, private.goal_unit_discrete(v_goal.unit, v_goal.unit_kind),
        p_mode = 'total') then
      raise exception 'invalid entry' using errcode = '22023';
    end if;
    v_total := private.goal_total(v_goal);
    if p_mode = 'total' then
      if v_total <> p_expected_total then
        return pg_catalog.jsonb_build_object('outcome', 'stale', 'goal', private.goal_summary_json(v_goal, v_user_id));
      end if;
      v_delta := p_quantity - v_total;
      if v_delta = 0 then
        return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'goal', private.goal_summary_json(v_goal, v_user_id));
      end if;
    else
      v_delta := p_quantity;
    end if;
    -- The same id racing into another goal (whose lock this call does not hold) is refused, not a 500.
    insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, note, contributed_by, source)
      values (p_id, v_goal.id, case when p_mode = 'add' then 'contribution' else 'adjustment' end, v_delta,
        v_goal.unit, v_goal.unit_kind, p_note, v_user_id, p_source)
      on conflict (id) do nothing;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    if p_mode = 'total' then
      perform private.goal_event(v_goal.id, 'adjusted', v_user_id, p_id,
        pg_catalog.jsonb_build_object('before', v_total, 'after', p_quantity));
      perform private.audit_goal('goal.adjusted', v_goal);
      perform private.recheck_goal_outcome(v_goal.id, v_user_id);
    end if;
    select * into v_goal from private.goals g where g.id = v_goal.id;
    return pg_catalog.jsonb_build_object('outcome', case when p_mode = 'add' then 'added' else 'adjusted' end,
      'entryId', p_id, 'totalBefore', v_total,
      'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- update_goal_entry (S30): in a period that has ended only goal managers correct entries
-- ('period_ended' for anyone else); each correction there recomputes the period's outcome.
create or replace function public.update_goal_entry(
  p_id uuid, p_action text, p_quantity numeric default null, p_reason text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_entry private.goal_entries;
    v_total numeric;
    v_after numeric;
    v_manage boolean;
    v_own boolean;
    v_discrete boolean;
    v_valid boolean;
  begin
    if p_id is null or p_action is null or p_action not in ('reverse', 'amend')
       or (p_action = 'amend') <> (p_quantity is not null)
       or (p_reason is not null and not private.is_plain_text(p_reason, private.goal_limit('reason')))
       or (p_quantity is not null and (pg_catalog.abs(p_quantity) > 1000000000
         or p_quantity <> pg_catalog.round(p_quantity, 3))) then
      raise exception 'invalid correction' using errcode = '22023';
    end if;
    v_goal := private.goal_lock((select e.goal_id from private.goal_entries e where e.id = p_id), v_user_id);
    if v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_entry from private.goal_entries e where e.id = p_id for update;
    if v_entry.status = 'reversed' then
      return pg_catalog.jsonb_build_object('outcome', 'already_reversed', 'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    v_manage := private.goal_may(v_goal, v_user_id, 'manage');
    v_own := v_entry.kind = 'contribution' and v_entry.contributed_by = v_user_id
      and private.goal_may(v_goal, v_user_id, 'contribute');
    if not (v_manage or (p_action = 'reverse' and v_own)) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if not v_manage and private.goal_period_ended(v_goal) then
      return pg_catalog.jsonb_build_object('outcome', 'period_ended', 'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if p_action = 'amend' then
      v_discrete := private.goal_unit_discrete(v_goal.unit, v_goal.unit_kind);
      v_valid := case v_entry.kind
        when 'initial' then private.valid_goal_quantity(p_quantity, v_discrete, true)
        when 'contribution' then private.valid_goal_quantity(p_quantity, v_discrete, false)
        else p_quantity <> 0 and (not v_discrete or p_quantity = pg_catalog.trunc(p_quantity)) end;
      if not v_valid then
        raise exception 'invalid correction' using errcode = '22023';
      end if;
      if p_quantity = v_entry.quantity then
        return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'goal', private.goal_summary_json(v_goal, v_user_id));
      end if;
    end if;
    v_total := private.goal_total(v_goal);
    v_after := v_total - v_entry.quantity + coalesce(p_quantity, 0);
    if v_after < 0 then
      return pg_catalog.jsonb_build_object('outcome', 'negative_total', 'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    insert into private.goal_entry_corrections (entry_id, action, before_quantity, after_quantity, actor, reason)
      values (v_entry.id, p_action, v_entry.quantity, p_quantity, v_user_id, p_reason);
    if p_action = 'amend' then
      update private.goal_entries e set original_quantity = coalesce(e.original_quantity, e.quantity),
          quantity = p_quantity, amended_by = v_user_id, amended_at = pg_catalog.now()
        where e.id = v_entry.id;
    else
      update private.goal_entries e set status = 'reversed', reversed_by = v_user_id, reversed_at = pg_catalog.now()
        where e.id = v_entry.id;
    end if;
    perform private.goal_event(v_goal.id, 'corrected', v_user_id, v_entry.id,
      pg_catalog.jsonb_build_object('action', p_action, 'entryKind', v_entry.kind,
        'own', v_entry.contributed_by = v_user_id, 'before', v_total, 'after', v_after));
    perform private.audit_goal('goal.entry_corrected', v_goal, pg_catalog.jsonb_build_object('action', p_action));
    perform private.recheck_goal_outcome(v_goal.id, v_user_id);
    select * into v_goal from private.goals g where g.id = v_goal.id;
    return pg_catalog.jsonb_build_object('outcome', case when p_action = 'amend' then 'corrected' else 'reversed' end,
      'totalBefore', v_total, 'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- set_goal_achievement (S30): in a period that has ended only goal managers mark achieved or reopen; a
-- completion period's outcome follows.
create or replace function public.set_goal_achievement(
  p_id uuid, p_expected_revision integer, p_achieved boolean, p_reason text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_total numeric;
  begin
    if p_id is null or p_expected_revision is null or p_achieved is null
       or (p_reason is not null and (p_achieved or not private.is_plain_text(p_reason, private.goal_limit('reason')))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_may(v_goal, v_user_id,
        case when p_achieved and v_goal.kind = 'completion' and not private.goal_period_ended(v_goal)
          then 'contribute' else 'manage' end) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    if (v_goal.achieved_at is not null) = p_achieved then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_goal.revision,
        'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if v_goal.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', v_goal.revision);
    end if;
    v_total := private.goal_total(v_goal);
    if p_achieved and v_goal.kind = 'measurable' and v_total < v_goal.target then
      return pg_catalog.jsonb_build_object('outcome', 'target_not_reached',
        'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if p_achieved then
      insert into private.goal_achievements (goal_id, achieved_by, total, target, unit, unit_kind)
        values (v_goal.id, v_user_id, v_total, v_goal.target, v_goal.unit, v_goal.unit_kind);
      update private.goals g set achieved_at = pg_catalog.now(), achieved_by = v_user_id,
          revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where g.id = v_goal.id returning * into v_goal;
    else
      update private.goal_achievements a set reopened_at = pg_catalog.now(), reopened_by = v_user_id,
          reopen_reason = p_reason
        where a.goal_id = v_goal.id and a.reopened_at is null;
      update private.goals g set achieved_at = null, achieved_by = null,
          revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where g.id = v_goal.id returning * into v_goal;
      perform private.reschedule_goal_reminders(v_goal.id);
    end if;
    perform private.goal_event(v_goal.id, case when p_achieved then 'achieved' else 'reopened' end, v_user_id, null,
      pg_catalog.jsonb_build_object('total', v_total, 'target', v_goal.target));
    perform private.audit_goal(case when p_achieved then 'goal.achieved' else 'goal.reopened' end, v_goal);
    perform private.recheck_goal_outcome(v_goal.id, v_user_id);
    select * into v_goal from private.goals g where g.id = v_goal.id;
    return pg_catalog.jsonb_build_object('outcome', case when p_achieved then 'achieved' else 'reopened' end,
      'revision', v_goal.revision, 'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- archive_goal (S30): periods do not count toward the goal limit when unarchived.
create or replace function public.archive_goal(p_id uuid, p_expected_revision integer, p_archived boolean)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
  begin
    if p_id is null or p_expected_revision is null or p_archived is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.goal_may(v_goal, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_goal.revision <> p_expected_revision then
      return query select 'conflict', v_goal.revision;
      return;
    end if;
    if (v_goal.archived_at is not null) = p_archived then
      return query select 'unchanged', v_goal.revision;
      return;
    end if;
    if not p_archived and v_goal.series_id is null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'goals:' || coalesce(v_goal.owner_home_id, v_goal.owner_user_id)::text, 0));
      if (select count(*) from private.goals g
          where g.deleted_at is null and g.archived_at is null and g.series_id is null
            and g.owner_user_id is not distinct from v_goal.owner_user_id
            and g.owner_home_id is not distinct from v_goal.owner_home_id) >= private.goal_limit('goals') then
        return query select 'too_many', v_goal.revision;
        return;
      end if;
    end if;
    update private.goals g
      set archived_at = case when p_archived then pg_catalog.now() end,
        archived_by = case when p_archived then v_user_id end,
        revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where g.id = v_goal.id returning * into v_goal;
    if not p_archived then
      perform private.reschedule_goal_reminders(v_goal.id);
    end if;
    perform private.goal_event(v_goal.id, case when p_archived then 'archived' else 'unarchived' end, v_user_id);
    perform private.audit_goal(case when p_archived then 'goal.archived' else 'goal.unarchived' end, v_goal);
    return query select 'saved', v_goal.revision;
  end
  $$;

-- set_goal_reminders (S30): a period has advance reminders only (it ends at its deadline), and none once
-- it has ended ('period_ended').
alter function public.set_goal_reminders(uuid, integer, boolean, smallint, smallint, time, boolean)
  rename to set_goal_reminders_before_series;
revoke all on function public.set_goal_reminders_before_series(uuid, integer, boolean, smallint, smallint, time, boolean)
  from public, anon, authenticated;
alter function public.set_goal_reminders_before_series(uuid, integer, boolean, smallint, smallint, time, boolean)
  set schema private;

create function public.set_goal_reminders(
  p_id uuid, p_expected_revision integer, p_enabled boolean, p_lead_days smallint default null,
  p_overdue_days smallint default null, p_at_time time default null, p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals := private.goal_for(p_id, v_user_id);
  begin
    if v_goal.series_id is not null then
      if p_enabled and p_overdue_days is not null then
        raise exception 'invalid reminder' using errcode = '22023';
      end if;
      if p_enabled and private.goal_period_ended(v_goal) then
        return pg_catalog.jsonb_build_object('outcome', 'period_ended');
      end if;
    end if;
    return private.set_goal_reminders_before_series(p_id, p_expected_revision, p_enabled, p_lead_days,
      p_overdue_days, p_at_time, p_dry_run);
  end
  $$;

-- Trash -------------------------------------------------------------------------------------------------

alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_goal_series;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_goal_series;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_goal_series;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_goal_series;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_goal_series;

create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_entry.item_type <> 'goal_series' then
      return private.trash_conflict_before_goal_series(p_entry);
    end if;
    if not exists (select 1 from private.goal_series s where s.id = p_entry.subject_id and s.deleted_at is not null) then
      return 'item_missing';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select private.trash_conflict_options_before_goal_series(p_kind);
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.item_type <> 'goal_series' then
      perform private.trash_resolve_before_goal_series(p_entry, p_resolution);
    end if;
  end
  $$;

-- A series comes back with its periods as they were; the period running now is created if the series is
-- active and it is missing (the ones that passed meanwhile are not), and the reminders still ahead of
-- its periods are queued again.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_series private.goal_series;
    v_goal_id uuid;
  begin
    if p_entry.item_type <> 'goal_series' then
      return private.trash_item_restore_before_goal_series(p_entry);
    end if;
    select * into v_series from private.goal_series s
      where s.id = p_entry.subject_id and s.deleted_at is not null for update;
    if v_series.id is null then
      raise exception 'goal series restore unavailable' using errcode = '23505';
    end if;
    update private.goal_series s
      set deleted_at = null, revision = s.revision + 1, updated_by = auth.uid(), updated_at = pg_catalog.now()
      where s.id = v_series.id;
    perform private.goal_series_event(v_series.id, 'restored', auth.uid());
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    for v_goal_id in select g.id from private.goals g
        where g.series_id = v_series.id and g.finalized_at is null and g.deleted_at is null loop
      perform private.reschedule_goal_reminders(v_goal_id);
    end loop;
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.item_type <> 'goal_series' then
      perform private.trash_item_purge_before_goal_series(p_entry);
      return;
    end if;
    delete from private.goal_series s where s.id = p_entry.subject_id and s.deleted_at is not null;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The goals API: signed-in people only (every function rechecks the confirmed caller). The S30
  -- functions replaced with create or replace keep their grants.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'sync_goal_periods', 'get_goal_series', 'get_goal_series_periods', 'create_goal_series',
      'update_goal_series', 'set_goal_series_state', 'change_goal_series_target', 'delete_goal_series',
      'change_goal_target', 'set_goal_reminders'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Background rollover: the service role only (Trigger.dev jobs).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('roll_goal_periods')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%goal%'
      or p.proname in ('trash_conflict', 'trash_conflict_options', 'trash_resolve', 'trash_item_restore',
        'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
