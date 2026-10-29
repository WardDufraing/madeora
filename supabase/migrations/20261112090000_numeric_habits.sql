-- S29: numeric habits (brief plans/steps/S29-brief.md; ADR 0037; spec "Confirmed optional numeric daily
-- habit targets", "Confirmed numeric habit daily excess and no carryover", "Confirmed numeric habit
-- measurement units and limited conversions", "Confirmed numeric habit target effective-date changes",
-- "Confirmed explicit confirmation for same-day numeric target completion changes", "Confirmed
-- daily-only numeric habit quantity targets", "Confirmed weekly and monthly numeric habit quantity
-- summaries", "Confirmed interactive numeric habit dashboard widgets", "Confirmed numeric habit
-- quick-add quantities and manual entry", "Confirmed positive-only numeric habit contributions and
-- corrections", "Confirmed progress-aware numeric habit reminders", "Confirmed numeric habit daily
-- totals without routine contribution timelines", "Confirmed one daily note for numeric habit
-- progress", "Confirmed numeric habit decimal precision and localized entry", "Confirmed numeric
-- habits excluded from calendar").
--
-- A numeric habit is a daily or weekday habit whose day is completed by reaching a daily target.
-- How a habit is tracked is a dated version (private.habit_tracking; no row: complete once). Progress
-- is a list of positive contributions (private.habit_contributions) whose exact decimal sum for the
-- local date is compared with the target of the version in effect on that date. The day's completion
-- is a *derived* check-in the database keeps in step: written when the total reaches the target,
-- marked undone when a correction or a same-day target change takes it back below. So streaks,
-- milestones, insights, reminders and the calendar keep working on check-ins exactly as in S28.
--
-- Nothing here is exposed as a table. Contribution rows (who added what) are readable only by their
-- contributor and by habit managers (get_habit_contributions); everyone who may see the habit reads
-- the daily totals. Contributions write no habit_events (every viewer reads those); a manager's
-- correction and every tracking change do, with ids, dates and codes only.
--
-- S28 functions this step changes are renamed to *_before_numeric (and moved to the private schema
-- where they were public) and wrapped, so the S28 migration stays as it was applied.

-- History kinds ---------------------------------------------------------------------------------------

alter table private.habit_events drop constraint habit_events_kind_check;
alter table private.habit_events add constraint habit_events_kind_check check (kind in (
  'created', 'edited', 'schedule_changed', 'end_changed', 'paused', 'pause_changed', 'resumed',
  'archived', 'unarchived', 'restored', 'reactivated', 'reminders_changed', 'checked_in', 'undone',
  'corrected', 'note_added', 'note_edited', 'note_removed', 'vacation_pause_changed',
  'tracking_changed', 'contribution_corrected'
));

-- Units and quantities --------------------------------------------------------------------------------

-- The unit catalogue. Presets: glasses, pages and repetitions (whole numbers only, no conversion);
-- ml and l (volume), min and h (time), m and km (distance), which convert only inside their own
-- dimension. A custom label is a labelled quantity: up to three decimals, never converted.
-- factor: how many of the dimension's smallest unit one of this unit is.
-- apps/web/src/habits and packages/domain/src/habits/numeric.ts use the same table.
create function private.habit_unit_info(p_unit text, p_kind text)
returns table (dimension text, factor numeric, discrete boolean)
  language sql immutable set search_path = '' as $$
  select u.dimension, u.factor, u.discrete
  from (values
    ('glasses', 'glasses', 1::numeric, true),
    ('pages', 'pages', 1::numeric, true),
    ('repetitions', 'repetitions', 1::numeric, true),
    ('ml', 'volume', 1::numeric, false),
    ('l', 'volume', 1000::numeric, false),
    ('min', 'time', 1::numeric, false),
    ('h', 'time', 60::numeric, false),
    ('m', 'distance', 1::numeric, false),
    ('km', 'distance', 1000::numeric, false)
  ) as u (code, dimension, factor, discrete)
  where p_kind = 'preset' and u.code = p_unit
  union all
  select 'custom:' || p_unit, 1::numeric, false
  where p_kind = 'custom' and p_unit is not null;
  $$;

create function private.valid_habit_unit(p_unit text, p_kind text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(case p_kind
    when 'preset' then exists (select 1 from private.habit_unit_info(p_unit, p_kind))
    when 'custom' then private.is_visible_name(p_unit, 20)
  end, false);
  $$;

-- A quantity or target: strictly positive, at most 1,000,000, at most three decimals, whole for a
-- discrete unit.
create function private.valid_habit_quantity(p_value numeric, p_discrete boolean) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_value > 0 and p_value <= 1000000 and p_value = pg_catalog.round(p_value, 3)
    and (not p_discrete or p_value = pg_catalog.trunc(p_value)), false);
  $$;

-- A tracking version: 'once' carries nothing; 'numeric' a valid unit, a valid target and up to five
-- distinct valid quick-add presets.
create function private.valid_habit_tracking(
  p_mode text, p_target numeric, p_unit text, p_kind text, p_quick_adds numeric[]
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(case p_mode
    when 'once' then p_target is null and p_unit is null and p_kind is null
      and coalesce(cardinality(p_quick_adds), 0) = 0
    when 'numeric' then private.valid_habit_unit(p_unit, p_kind) and coalesce((
      select private.valid_habit_quantity(p_target, i.discrete)
        and coalesce(cardinality(p_quick_adds), 0) <= 5
        and coalesce((select bool_and(private.valid_habit_quantity(q, i.discrete)) and count(distinct q) = count(*)
          from pg_catalog.unnest(p_quick_adds) q), true)
      from private.habit_unit_info(p_unit, p_kind) i), false)
  end, false);
  $$;

-- Tables ----------------------------------------------------------------------------------------------

alter table private.habit_checkins add column derived boolean not null default false;

create table private.habit_tracking (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references private.habits (id) on delete cascade,
  effective_on date not null,
  mode text not null constraint habit_tracking_mode_check check (mode in ('once', 'numeric')),
  target numeric(12, 3),
  unit text,
  unit_kind text constraint habit_tracking_kind_check check (unit_kind in ('preset', 'custom')),
  quick_adds numeric(12, 3)[] not null default '{}',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint habit_tracking_effective_key unique (habit_id, effective_on),
  constraint habit_tracking_shape_check
    check (private.valid_habit_tracking(mode, target, unit, unit_kind, quick_adds))
);

create table private.habit_contributions (
  id uuid primary key,
  habit_id uuid not null references private.habits (id) on delete cascade,
  on_date date not null,
  -- In the unit of the version in effect on on_date; positive; at most three decimals.
  quantity numeric(12, 3) not null constraint habit_contributions_quantity_check
    check (quantity > 0 and quantity <= 1000000),
  -- Set once a manager amends the quantity: what was recorded first.
  original_quantity numeric(12, 3),
  -- What the person typed when they entered another unit (converted exactly into quantity).
  entered_quantity numeric(12, 3),
  entered_unit text,
  contributed_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  source text not null constraint habit_contributions_source_check check (source in ('app', 'widget')),
  status text not null default 'active' constraint habit_contributions_status_check check (status in ('active', 'undone')),
  amended_by uuid references auth.users (id) on delete set null,
  amended_at timestamptz,
  undone_by uuid references auth.users (id) on delete set null,
  undone_at timestamptz,
  undo_kind text constraint habit_contributions_undo_kind_check check (undo_kind in ('undo', 'correction')),
  undo_reason text constraint habit_contributions_reason_check check (undo_reason is null or private.is_plain_text(undo_reason, 200)),
  constraint habit_contributions_undo_check check ((status = 'undone') = (undone_at is not null and undo_kind is not null))
);

create index habit_contributions_day_idx on private.habit_contributions (habit_id, on_date);
create index habit_contributions_active_idx on private.habit_contributions (habit_id, on_date) where status = 'active';

-- One optional note per habit and numeric day, independent of the contributions. Clearing keeps the
-- row (note null) so the revision counts on and a stale editor is still told.
create table private.habit_day_notes (
  habit_id uuid not null references private.habits (id) on delete cascade,
  on_date date not null,
  note text constraint habit_day_notes_note_check check (note is null or private.is_plain_text(note, 280)),
  revision integer not null default 1 constraint habit_day_notes_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (habit_id, on_date)
);

alter table private.habit_tracking enable row level security;
alter table private.habit_contributions enable row level security;
alter table private.habit_day_notes enable row level security;
revoke all on private.habit_tracking, private.habit_contributions, private.habit_day_notes
  from public, anon, authenticated;

-- Reading helpers ---------------------------------------------------------------------------------------

-- The tracking version in effect on a date (a row of nulls: complete once).
create function private.habit_tracking_on(p_habit_id uuid, p_on date) returns private.habit_tracking
  language sql stable security definer set search_path = '' as $$
  select t.* from private.habit_tracking t
  where t.habit_id = p_habit_id and t.effective_on <= p_on
  order by t.effective_on desc limit 1;
  $$;

-- True when the tracking in effect on a date, or any version after it, is numeric.
create function private.habit_numeric_ahead(p_habit_id uuid, p_on date) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.habit_tracking t
    where t.habit_id = p_habit_id and t.mode = 'numeric'
      and (t.effective_on > p_on or t.id = (private.habit_tracking_on(p_habit_id, p_on)).id));
  $$;

create function private.habit_contribution_total(p_habit_id uuid, p_on date) returns numeric
  language sql stable security definer set search_path = '' as $$
  select coalesce(sum(c.quantity), 0) from private.habit_contributions c
  where c.habit_id = p_habit_id and c.on_date = p_on and c.status = 'active';
  $$;

-- A day's progress as an answer, or null when the day is not tracked numerically.
create function private.habit_progress_json(p_habit private.habits, p_on date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_tracking private.habit_tracking := private.habit_tracking_on(p_habit.id, p_on);
    v_total numeric;
  begin
    if v_tracking.id is null or v_tracking.mode <> 'numeric' then
      return null;
    end if;
    v_total := private.habit_contribution_total(p_habit.id, p_on);
    return pg_catalog.jsonb_build_object('onDate', p_on, 'total', v_total, 'target', v_tracking.target,
      'unit', v_tracking.unit, 'unitKind', v_tracking.unit_kind, 'met', v_total >= v_tracking.target,
      'above', v_total > v_tracking.target);
  end
  $$;

create function private.habit_tracking_json(p_tracking private.habit_tracking, p_habit private.habits)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select case when p_tracking.id is not null then pg_catalog.jsonb_build_object(
    'effectiveOn', p_tracking.effective_on, 'mode', p_tracking.mode, 'target', p_tracking.target,
    'unit', p_tracking.unit, 'unitKind', p_tracking.unit_kind,
    'quickAdds', pg_catalog.to_jsonb(p_tracking.quick_adds),
    'by', private.habit_person(p_habit, p_tracking.created_by), 'at', p_tracking.created_at) end;
  $$;

-- Why a new contribution for a date cannot be recorded now, or null: the S28 reasons of a new
-- check-in, 'not_numeric' (the day completes once), but never 'already_completed' (more than the
-- target is allowed), and 'paused' also for a completed day.
create function private.habit_contribution_block(p_habit private.habits, p_on date, p_today date) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_tracking private.habit_tracking;
    v_block text := private.habit_checkin_block(p_habit, p_on, p_today);
  begin
    if v_block is not null and v_block <> 'already_completed' then
      return v_block;
    end if;
    v_tracking := private.habit_tracking_on(p_habit.id, p_on);
    if v_tracking.id is null or v_tracking.mode <> 'numeric' then
      return 'not_numeric';
    end if;
    if private.habit_paused_on(p_habit, p_on) is not null then
      return 'paused';
    end if;
    return null;
  end
  $$;

-- The first scheduled, tracked day after a date, or null (looks a year ahead).
create function private.habit_next_scheduled(p_habit private.habits, p_after date) returns date
  language sql stable security definer set search_path = '' as $$
  select min(x.on_date) from private.habit_days(p_habit.id, p_after + 1, p_after + 400) x
  where x.period_id is not null and x.scheduled;
  $$;

-- The numeric days between two dates as the daily totals show them, newest first: the effective
-- target and unit, the exact total, the day's state, its note and whether progress can still be
-- added. Aggregates only: nobody is named.
create function private.habit_numeric_days_json(p_habit private.habits, p_from date, p_to date, p_today date)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'onDate', s.on_date, 'state', s.state, 'pausedBy', s.paused_by,
      'target', t.target, 'unit', t.unit, 'unitKind', t.unit_kind, 'total', c.total,
      'met', c.total >= t.target, 'above', c.total > t.target,
      'note', n.note, 'noteRevision', coalesce(n.revision, 0),
      'block', private.habit_contribution_block(p_habit, s.on_date, p_today))
    order by s.on_date desc), '[]'::jsonb)
  from private.habit_day_states(p_habit, p_from, p_to, p_today) s
  join lateral (select tr.* from private.habit_tracking tr
    where tr.habit_id = p_habit.id and tr.effective_on <= s.on_date
    order by tr.effective_on desc limit 1) t on t.mode = 'numeric'
  cross join lateral (select private.habit_contribution_total(p_habit.id, s.on_date) as total) c
  left join private.habit_day_notes n on n.habit_id = p_habit.id and n.on_date = s.on_date
  where p_from <= p_to and s.state <> 'untracked';
  $$;

-- Keeps the day's derived check-in in step with its total (under the habit lock): written when the
-- total reaches the target, marked undone when it falls below it or the day stops being numeric.
-- A new completion cancels the day's pending reminder snoozes. Returns {changed: 'completed' |
-- 'reopened' | null, milestone}; the milestone's celebrate is false unless p_celebrate.
create function private.habit_numeric_sync(
  p_habit private.habits, p_on date, p_actor uuid, p_celebrate boolean
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_tracking private.habit_tracking := private.habit_tracking_on(p_habit.id, p_on);
    v_total numeric := private.habit_contribution_total(p_habit.id, p_on);
    v_active private.habit_checkins;
    v_checkin private.habit_checkins;
    v_met boolean := v_tracking.id is not null and v_tracking.mode = 'numeric' and v_total >= v_tracking.target;
    v_today date := private.habit_today(p_habit);
    v_milestone jsonb;
  begin
    select * into v_active from private.habit_checkins c
      where c.habit_id = p_habit.id and c.on_date = p_on and c.status = 'active';
    if v_met and v_active.id is null then
      insert into private.habit_checkins (id, habit_id, on_date, completed_by, source, derived)
        values (gen_random_uuid(), p_habit.id, p_on, null, 'app', true)
        returning * into v_checkin;
      v_milestone := private.habit_record_milestones(p_habit, v_checkin, v_today);
      if v_milestone is not null then
        v_milestone := v_milestone || pg_catalog.jsonb_build_object('celebrate',
          p_celebrate and (v_milestone ->> 'celebrate')::boolean
            and coalesce((select s.celebrations from private.habit_user_settings s where s.user_id = p_actor), true));
      end if;
      update private.habit_reminder_snoozes s set status = 'cancelled'
        where s.habit_id = p_habit.id and s.on_date = p_on and s.status = 'pending';
      return pg_catalog.jsonb_build_object('changed', 'completed', 'milestone', v_milestone);
    elsif not v_met and v_active.id is not null and v_active.derived then
      update private.habit_checkins c set status = 'undone', undone_by = p_actor,
          undone_at = pg_catalog.now(), undo_kind = 'correction'
        where c.id = v_active.id;
      return pg_catalog.jsonb_build_object('changed', 'reopened', 'milestone', null);
    end if;
    return pg_catalog.jsonb_build_object('changed', null, 'milestone', null);
  end
  $$;

-- Wrapped S28 answers ---------------------------------------------------------------------------------

-- A derived check-in names nobody (the day was completed by the total, not by a person), and nobody
-- can undo, correct or note it directly.
create or replace function private.habit_checkin_json(p_checkin private.habit_checkins, p_habit private.habits, p_viewer uuid)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_checkin.id,
    'onDate', p_checkin.on_date,
    'by', case when p_checkin.derived then null else private.habit_person(p_habit, p_checkin.completed_by) end,
    'mine', not p_checkin.derived and coalesce(p_checkin.completed_by = p_viewer, false),
    'recordedAt', p_checkin.recorded_at,
    'backdated', (p_checkin.recorded_at at time zone private.habit_zone(p_habit))::date > p_checkin.on_date,
    'source', p_checkin.source,
    'note', p_checkin.note,
    'noteRevision', p_checkin.note_revision,
    'noteUpdatedAt', p_checkin.note_updated_at,
    'status', p_checkin.status,
    'undoneBy', case when p_checkin.derived then null else private.habit_person(p_habit, p_checkin.undone_by) end,
    'undoneByMe', not p_checkin.derived and coalesce(p_checkin.undone_by = p_viewer, false),
    'undoneAt', p_checkin.undone_at,
    'undoKind', p_checkin.undo_kind,
    'undoReason', p_checkin.undo_reason,
    'derived', p_checkin.derived);
  $$;

create or replace function private.habit_checkin_action(
  p_checkin private.habit_checkins, p_habit private.habits, p_viewer uuid, p_today date
) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_checkin.derived or p_checkin.status <> 'active' or p_habit.archived_at is not null then null
    when p_checkin.completed_by = p_viewer and private.habit_may(p_habit, p_viewer, 'complete')
      and p_checkin.on_date >= p_today - private.habit_limit('backdate_days') then 'undo'
    when private.habit_may(p_habit, p_viewer, 'manage') then 'correct'
  end;
  $$;

alter function private.habit_summary_json(private.habits, uuid) rename to habit_summary_json_before_numeric;

-- The S28 summary plus how the habit is tracked: the version in effect today, the next one, today's
-- progress and whether progress can be added today.
create function private.habit_summary_json(p_habit private.habits, p_viewer uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := private.habit_today(p_habit);
    v_tracking private.habit_tracking := private.habit_tracking_on(p_habit.id, v_today);
  begin
    return private.habit_summary_json_before_numeric(p_habit, p_viewer) || pg_catalog.jsonb_build_object(
      'tracking', coalesce(private.habit_tracking_json(v_tracking, p_habit),
        pg_catalog.jsonb_build_object('effectiveOn', null, 'mode', 'once', 'target', null, 'unit', null,
          'unitKind', null, 'quickAdds', '[]'::jsonb, 'by', null, 'at', null)),
      'nextTracking', (select private.habit_tracking_json(t, p_habit) from private.habit_tracking t
        where t.habit_id = p_habit.id and t.effective_on > v_today order by t.effective_on limit 1),
      'progress', private.habit_progress_json(p_habit, v_today),
      'contributionBlock', case when v_tracking.mode = 'numeric'
        then private.habit_contribution_block(p_habit, v_today, v_today) end);
  end
  $$;

alter function public.get_habit(uuid) set schema private;
alter function private.get_habit(uuid) rename to get_habit_before_numeric;

create function public.get_habit(p_habit_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_base jsonb;
    v_today date;
  begin
    if v_habit.id is null then
      return null;
    end if;
    v_base := private.get_habit_before_numeric(p_habit_id);
    v_today := private.habit_today(v_habit);
    return v_base || pg_catalog.jsonb_build_object(
      'trackings', coalesce((select pg_catalog.jsonb_agg(private.habit_tracking_json(t, v_habit) order by t.effective_on)
        from private.habit_tracking t where t.habit_id = v_habit.id), '[]'::jsonb),
      'numericRecent', private.habit_numeric_days_json(v_habit, v_today - private.habit_limit('backdate_days'),
        v_today, v_today));
  end
  $$;

alter function public.get_habit_calendar(uuid, date) set schema private;
alter function private.get_habit_calendar(uuid, date) rename to get_habit_calendar_before_numeric;

create function public.get_habit_calendar(p_habit_id uuid, p_month date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_base jsonb;
    v_first date;
    v_last date;
    v_today date;
  begin
    v_base := private.get_habit_calendar_before_numeric(p_habit_id, p_month);
    if v_base is null then
      return null;
    end if;
    v_first := pg_catalog.date_trunc('month', p_month)::date;
    v_last := (pg_catalog.date_trunc('month', p_month) + interval '1 month - 1 day')::date;
    v_today := private.habit_today(v_habit);
    return v_base || pg_catalog.jsonb_build_object('numericDays',
      private.habit_numeric_days_json(v_habit, v_first, least(v_last, v_today), v_today));
  end
  $$;

-- Weekly and monthly quantity summaries (insights): the last eight habit weeks and six calendar
-- months. Per period and per unit family: the exact total of actual quantities, the eligible days
-- (scheduled, tracked, not paused, already begun; days without progress count), their average and
-- the days that met their own day's target. Compatible units of one family are added in the most
-- recent unit; incompatible units and custom labels stay separate segments, never mixed. The running
-- period is 'so far'. Null for a habit that was never numeric.
create function private.habit_numeric_summary_json(p_habit private.habits, p_today date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_week date := private.habit_week_of(p_habit.week_start, p_today);
    v_month date := pg_catalog.date_trunc('month', p_today::timestamp)::date;
    v_from date := least(v_week - 49, (v_month - interval '5 months')::date);
  begin
    if not exists (select 1 from private.habit_tracking t where t.habit_id = p_habit.id and t.mode = 'numeric') then
      return null;
    end if;
    return (
      with d as (
        select x.on_date, t.target, t.unit, t.unit_kind, i.dimension, i.factor,
          private.habit_contribution_total(p_habit.id, x.on_date) as total
        from private.habit_days(p_habit.id, v_from, p_today) x
        join lateral (select tr.* from private.habit_tracking tr
          where tr.habit_id = p_habit.id and tr.effective_on <= x.on_date
          order by tr.effective_on desc limit 1) t on t.mode = 'numeric'
        cross join lateral private.habit_unit_info(t.unit, t.unit_kind) i
        where x.period_id is not null and x.scheduled
          and (x.checkin_id is not null or not (x.manual_paused or x.vacation_paused))
      ), periods as (
        select 'week'::text as kind, g::date as starts_on, (g::date + 6) as ends_on
        from pg_catalog.generate_series((v_week - 49)::timestamp, v_week::timestamp, interval '7 days') g
        union all
        select 'month', m::date, (m + interval '1 month - 1 day')::date
        from pg_catalog.generate_series((v_month - interval '5 months')::timestamp, v_month::timestamp,
          interval '1 month') m
      ), seg as (
        select p.kind, p.starts_on, d.dimension,
          (pg_catalog.array_agg(d.unit order by d.on_date desc))[1] as unit,
          (pg_catalog.array_agg(d.unit_kind order by d.on_date desc))[1] as unit_kind,
          (pg_catalog.array_agg(d.factor order by d.on_date desc))[1] as unit_factor,
          sum(d.total * d.factor) as base_total,
          count(*) as eligible,
          count(*) filter (where d.total >= d.target) as met
        from periods p join d on d.on_date between p.starts_on and p.ends_on
        group by p.kind, p.starts_on, d.dimension
      )
      select pg_catalog.jsonb_build_object('periods', coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('kind', p.kind, 'startsOn', p.starts_on, 'endsOn', p.ends_on,
          'soFar', p.ends_on >= p_today,
          'segments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'unit', s.unit, 'unitKind', s.unit_kind,
              'total', pg_catalog.round(s.base_total / s.unit_factor, 3),
              'eligibleDays', s.eligible, 'metDays', s.met,
              'average', pg_catalog.round(s.base_total / s.unit_factor / s.eligible, 3)) order by s.dimension)
            from seg s where s.kind = p.kind and s.starts_on = p.starts_on), '[]'::jsonb))
        order by p.kind desc, p.starts_on desc), '[]'::jsonb))
      from periods p);
  end
  $$;

alter function public.get_habit_insights(uuid, integer) set schema private;
alter function private.get_habit_insights(uuid, integer) rename to get_habit_insights_before_numeric;

create function public.get_habit_insights(p_habit_id uuid, p_days integer) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_base jsonb := private.get_habit_insights_before_numeric(p_habit_id, p_days);
  begin
    if v_base is null then
      return null;
    end if;
    return v_base || pg_catalog.jsonb_build_object('numeric',
      private.habit_numeric_summary_json(v_habit, private.habit_today(v_habit)));
  end
  $$;

-- Creating --------------------------------------------------------------------------------------------

drop function public.create_habit(uuid, uuid, text, text, text, smallint[], smallint, date, date, text, text);

-- create_habit of S28 plus the tracking: p_tracking_target (null: complete once), its unit and the
-- quick-add presets. A numeric habit needs a daily or weekdays schedule. Extra outcome: none; invalid
-- tracking is 22023.
create function public.create_habit(
  p_id uuid, p_home_id uuid default null, p_name text default null, p_description text default null,
  p_kind text default null, p_weekdays smallint[] default null, p_target smallint default null,
  p_starts_on date default null, p_ends_on date default null, p_time_zone text default null,
  p_week_start text default null, p_tracking_target numeric default null, p_tracking_unit text default null,
  p_tracking_unit_kind text default null, p_tracking_quick_adds numeric[] default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.habits;
    v_habit private.habits;
    v_zone text;
    v_today date;
    v_numeric boolean := p_tracking_target is not null;
  begin
    perform private.require_habit_context(p_home_id, v_user_id);
    if p_id is null or p_name is null or not private.is_visible_name(p_name, private.habit_limit('name'))
       or (p_description is not null and not private.is_plain_text(p_description, private.habit_limit('description')))
       or not private.valid_habit_schedule(p_kind, p_weekdays, p_target)
       or p_starts_on is null or p_week_start is null or p_week_start not in ('monday', 'saturday', 'sunday')
       or (p_home_id is null and not private.valid_time_zone(p_time_zone))
       or (v_numeric and (p_kind = 'weekly' or not private.valid_habit_tracking('numeric', p_tracking_target,
         p_tracking_unit, p_tracking_unit_kind, coalesce(p_tracking_quick_adds, '{}'))))
       or (not v_numeric and (p_tracking_unit is not null or p_tracking_unit_kind is not null
         or coalesce(cardinality(p_tracking_quick_adds), 0) > 0)) then
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
    if v_numeric then
      insert into private.habit_tracking (habit_id, effective_on, mode, target, unit, unit_kind, quick_adds, created_by)
        values (v_habit.id, p_starts_on, 'numeric', p_tracking_target, p_tracking_unit, p_tracking_unit_kind,
          coalesce(p_tracking_quick_adds, '{}'), v_user_id);
    end if;
    perform private.refresh_habit_vacation_days(v_habit.id);
    perform private.habit_event(v_habit.id, 'created', v_user_id, p_starts_on,
      null, pg_catalog.jsonb_build_object('numeric', v_numeric));
    perform private.audit_habit('habit.created', v_habit);
    return query select 'created', v_habit.revision;
  end
  $$;

-- Check-ins of numeric days ---------------------------------------------------------------------------

alter function public.complete_habit(uuid, uuid, date, text, text) set schema private;
alter function private.complete_habit(uuid, uuid, date, text, text) rename to complete_habit_before_numeric;

-- A numeric day is completed by its total, never by a single tap: 'numeric_required'.
create function public.complete_habit(
  p_checkin_id uuid, p_habit_id uuid, p_on date default null, p_note text default null,
  p_source text default 'app'
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
  begin
    if v_habit.id is not null
       and coalesce((private.habit_tracking_on(v_habit.id, coalesce(p_on, private.habit_today(v_habit)))).mode, 'once') = 'numeric'
       and private.habit_may(v_habit, v_user_id, 'complete') then
      return pg_catalog.jsonb_build_object('outcome', 'numeric_required',
        'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    return private.complete_habit_before_numeric(p_checkin_id, p_habit_id, p_on, p_note, p_source);
  end
  $$;

alter function public.undo_habit_checkin(uuid, text) set schema private;
alter function private.undo_habit_checkin(uuid, text) rename to undo_habit_checkin_before_numeric;

create function public.undo_habit_checkin(p_checkin_id uuid, p_reason text default null) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if exists (select 1 from private.habit_checkins c where c.id = p_checkin_id and c.derived
        and (private.habit_for(c.habit_id, v_user_id)).id is not null) then
      return pg_catalog.jsonb_build_object('outcome', 'numeric_derived');
    end if;
    return private.undo_habit_checkin_before_numeric(p_checkin_id, p_reason);
  end
  $$;

alter function public.set_habit_checkin_note(uuid, integer, text) set schema private;
alter function private.set_habit_checkin_note(uuid, integer, text) rename to set_habit_checkin_note_before_numeric;

create function public.set_habit_checkin_note(
  p_checkin_id uuid, p_expected_revision integer, p_note text default null
)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if exists (select 1 from private.habit_checkins c where c.id = p_checkin_id and c.derived
        and (private.habit_for(c.habit_id, v_user_id)).id is not null) then
      return query select 'numeric_derived', null::integer;
      return;
    end if;
    return query select * from private.set_habit_checkin_note_before_numeric(p_checkin_id, p_expected_revision, p_note);
  end
  $$;

-- A weekly schedule never meets a numeric day: 'numeric_requires_daily'.
alter function public.change_habit_schedule(uuid, integer, text, smallint[], smallint, date, boolean) set schema private;
alter function private.change_habit_schedule(uuid, integer, text, smallint[], smallint, date, boolean)
  rename to change_habit_schedule_before_numeric;

create function public.change_habit_schedule(
  p_id uuid, p_expected_revision integer, p_kind text, p_weekdays smallint[] default null,
  p_target smallint default null, p_effective_on date default null, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
  begin
    if p_kind = 'weekly' and p_id is not null then
      v_habit := private.habit_lock(p_id, v_user_id);
      if v_habit.id is not null
         and private.habit_numeric_ahead(v_habit.id, coalesce(p_effective_on, private.habit_today(v_habit))) then
        return query select 'numeric_requires_daily', null::jsonb, v_habit.revision;
        return;
      end if;
    end if;
    return query select * from private.change_habit_schedule_before_numeric(
      p_id, p_expected_revision, p_kind, p_weekdays, p_target, p_effective_on, p_dry_run);
  end
  $$;

alter function public.reactivate_habit(uuid, integer, date, date, text, smallint[], smallint, text, time[], smallint[], boolean)
  set schema private;
alter function private.reactivate_habit(uuid, integer, date, date, text, smallint[], smallint, text, time[], smallint[], boolean)
  rename to reactivate_habit_before_numeric;

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
  begin
    if p_kind = 'weekly' and p_id is not null then
      v_habit := private.habit_lock(p_id, v_user_id);
      if v_habit.id is not null
         and private.habit_numeric_ahead(v_habit.id, coalesce(p_starts_on, private.habit_today(v_habit))) then
        return query select 'numeric_requires_daily', null::jsonb, v_habit.revision;
        return;
      end if;
    end if;
    return query select * from private.reactivate_habit_before_numeric(
      p_id, p_expected_revision, p_starts_on, p_ends_on, p_kind, p_weekdays, p_target, p_reminder,
      p_reminder_times, p_reminder_weekdays, p_dry_run);
  end
  $$;

-- Contributions ---------------------------------------------------------------------------------------

-- Adds progress to a numeric day (people who may check in): today or up to seven days back, a
-- scheduled, tracked, unpaused day; more than the target is fine and counts on that day only.
-- p_quantity is positive; p_entered_unit another unit of the same family (then p_quantity is in that
-- unit and converted exactly; a result with more than three decimals answers 'precision' with the
-- rounded value, a unit of another family 'unit_mismatch'). p_id is the caller's client id: a retry
-- answers 'exists'. p_expected_revision (when given) refuses a stale form or widget ('stale'). The
-- answer carries the habit, the day's progress, the streak before and after and a newly reached
-- milestone. Outcomes: 'added', 'exists', 'id_taken', 'stale', 'not_numeric', 'precision',
-- 'unit_mismatch', the S28 refusals ('archived', 'future', 'outside_window', 'untracked',
-- 'not_scheduled', 'paused'), 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.add_habit_contribution(
  p_id uuid, p_habit_id uuid, p_quantity numeric, p_on date default null,
  p_entered_unit text default null, p_source text default 'app', p_expected_revision integer default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_existing private.habit_contributions;
    v_contribution private.habit_contributions;
    v_tracking private.habit_tracking;
    v_entered_dimension text;
    v_entered_factor numeric;
    v_unit_dimension text;
    v_unit_factor numeric;
    v_today date;
    v_block text;
    v_quantity numeric := p_quantity;
    v_converted numeric;
    v_before integer;
    v_sync jsonb;
  begin
    if p_id is null or p_habit_id is null or p_quantity is null or p_quantity <= 0 or p_quantity > 1000000
       or p_source is null or p_source not in ('app', 'widget')
       or (p_entered_unit is not null and not private.valid_habit_unit(p_entered_unit, 'preset')) then
      raise exception 'invalid contribution' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_habit_id, v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_today := private.habit_today(v_habit);
    p_on := coalesce(p_on, v_today);
    select * into v_existing from private.habit_contributions c where c.id = p_id;
    if v_existing.id is not null then
      if v_existing.habit_id = v_habit.id and v_existing.contributed_by = v_user_id and v_existing.on_date = p_on then
        return pg_catalog.jsonb_build_object('outcome', 'exists',
          'progress', private.habit_progress_json(v_habit, p_on),
          'habit', private.habit_summary_json(v_habit, v_user_id));
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    if not private.habit_may(v_habit, v_user_id, 'complete') then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if p_expected_revision is not null and p_expected_revision <> v_habit.revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    v_block := private.habit_contribution_block(v_habit, p_on, v_today);
    if v_block is not null then
      return pg_catalog.jsonb_build_object('outcome', v_block, 'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    v_tracking := private.habit_tracking_on(v_habit.id, p_on);
    if p_entered_unit is not null and not (v_tracking.unit_kind = 'preset' and p_entered_unit = v_tracking.unit) then
      select i.dimension, i.factor into v_entered_dimension, v_entered_factor
        from private.habit_unit_info(p_entered_unit, 'preset') i;
      select i.dimension, i.factor into v_unit_dimension, v_unit_factor
        from private.habit_unit_info(v_tracking.unit, v_tracking.unit_kind) i;
      if v_entered_dimension is distinct from v_unit_dimension or v_tracking.unit_kind <> 'preset' then
        return pg_catalog.jsonb_build_object('outcome', 'unit_mismatch');
      end if;
      if p_quantity <> pg_catalog.round(p_quantity, 3) then
        raise exception 'invalid contribution' using errcode = '22023';
      end if;
      v_converted := p_quantity * v_entered_factor / v_unit_factor;
      if v_converted <> pg_catalog.round(v_converted, 3) or v_converted <= 0 then
        return pg_catalog.jsonb_build_object('outcome', 'precision', 'converted', pg_catalog.round(v_converted, 3));
      end if;
      v_quantity := pg_catalog.round(v_converted, 3);
    elsif p_entered_unit is not null then
      p_entered_unit := null;
    end if;
    if not private.valid_habit_quantity(v_quantity,
        (select i.discrete from private.habit_unit_info(v_tracking.unit, v_tracking.unit_kind) i)) then
      raise exception 'invalid contribution' using errcode = '22023';
    end if;
    select s.current_count into v_before from private.habit_streak(v_habit, v_today) s;
    insert into private.habit_contributions (id, habit_id, on_date, quantity, entered_quantity, entered_unit,
        contributed_by, source)
      values (p_id, v_habit.id, p_on, v_quantity, case when p_entered_unit is not null then p_quantity end,
        p_entered_unit, v_user_id, p_source)
      returning * into v_contribution;
    v_sync := private.habit_numeric_sync(v_habit, p_on, v_user_id, p_on = v_today);
    return pg_catalog.jsonb_build_object('outcome', 'added',
      'contributionId', v_contribution.id,
      'completedNow', (v_sync ->> 'changed') is not distinct from 'completed',
      'progress', private.habit_progress_json(v_habit, p_on),
      'streakBefore', v_before,
      'milestone', v_sync -> 'milestone',
      'habit', private.habit_summary_json(v_habit, v_user_id));
  end
  $$;

-- A contribution as the person who may see it sees it.
create function private.habit_contribution_json(
  p_contribution private.habit_contributions, p_habit private.habits, p_viewer uuid, p_today date
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_contribution.id, 'onDate', p_contribution.on_date, 'quantity', p_contribution.quantity,
    'originalQuantity', p_contribution.original_quantity,
    'enteredQuantity', p_contribution.entered_quantity, 'enteredUnit', p_contribution.entered_unit,
    'by', private.habit_person(p_habit, p_contribution.contributed_by),
    'mine', coalesce(p_contribution.contributed_by = p_viewer, false),
    'recordedAt', p_contribution.recorded_at, 'source', p_contribution.source,
    'status', p_contribution.status, 'amendedAt', p_contribution.amended_at,
    'undoneAt', p_contribution.undone_at, 'undoKind', p_contribution.undo_kind,
    'undoReason', p_contribution.undo_reason,
    'action', case
      when p_contribution.status <> 'active' or p_habit.archived_at is not null then null
      when p_contribution.contributed_by = p_viewer and private.habit_may(p_habit, p_viewer, 'complete')
        and p_contribution.on_date >= p_today - private.habit_limit('backdate_days') then 'undo'
      when private.habit_may(p_habit, p_viewer, 'manage') then 'correct'
    end);
  $$;

-- The contributions of one numeric day: habit managers and the owner see all of them with who added
-- them (Review contributions); anyone else only their own, so they can undo them. Null when the
-- caller may not see the habit; 22023 for a date that is not a numeric day.
create function public.get_habit_contributions(p_habit_id uuid, p_on date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_today date;
    v_manager boolean;
    v_tracking private.habit_tracking;
  begin
    if p_on is null then
      raise exception 'invalid date' using errcode = '22023';
    end if;
    if v_habit.id is null then
      return null;
    end if;
    v_today := private.habit_today(v_habit);
    v_manager := private.habit_may(v_habit, v_user_id, 'manage');
    v_tracking := private.habit_tracking_on(v_habit.id, p_on);
    return pg_catalog.jsonb_build_object(
      'onDate', p_on, 'all', v_manager,
      'target', v_tracking.target, 'unit', v_tracking.unit, 'unitKind', v_tracking.unit_kind,
      'total', private.habit_contribution_total(v_habit.id, p_on),
      'contributions', coalesce((select pg_catalog.jsonb_agg(private.habit_contribution_json(c, v_habit, v_user_id, v_today)
          order by c.recorded_at desc, c.id desc)
        from private.habit_contributions c
        where c.habit_id = v_habit.id and c.on_date = p_on and (v_manager or c.contributed_by = v_user_id)),
        '[]'::jsonb));
  end
  $$;

-- Undoes or corrects a contribution. 'undo': the contributor's own, inside the seven-day window, while
-- they may check in (and never another member's). 'void' and 'amend' (a new quantity; the first is
-- kept): habit managers, any date, optional reason; the contribution is kept either way. The day's
-- completion is recomputed. Outcomes: 'undone', 'corrected', 'already_undone', 'precision' (amend),
-- 'archived', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.update_habit_contribution(
  p_id uuid, p_action text, p_quantity numeric default null, p_reason text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_contribution private.habit_contributions;
    v_tracking private.habit_tracking;
    v_today date;
    v_before integer;
    v_sync jsonb;
    v_own boolean;
    v_manage boolean;
  begin
    if p_id is null or p_action is null or p_action not in ('undo', 'void', 'amend')
       or (p_reason is not null and not private.is_plain_text(p_reason, private.habit_limit('reason')))
       or (p_action = 'amend') <> (p_quantity is not null)
       or (p_quantity is not null and (p_quantity <= 0 or p_quantity > 1000000)) then
      raise exception 'invalid contribution' using errcode = '22023';
    end if;
    v_habit := private.habit_lock((select c.habit_id from private.habit_contributions c where c.id = p_id), v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_contribution from private.habit_contributions c where c.id = p_id for update;
    v_today := private.habit_today(v_habit);
    if v_contribution.status = 'undone' then
      return pg_catalog.jsonb_build_object('outcome', 'already_undone',
        'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    if v_habit.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    v_own := v_contribution.contributed_by = v_user_id;
    v_manage := private.habit_may(v_habit, v_user_id, 'manage');
    if p_action = 'undo' and not (v_own and private.habit_may(v_habit, v_user_id, 'complete')
         and v_contribution.on_date >= v_today - private.habit_limit('backdate_days')) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if p_action <> 'undo' and not v_manage then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_tracking := private.habit_tracking_on(v_habit.id, v_contribution.on_date);
    if p_action = 'amend' then
      if p_quantity <> pg_catalog.round(p_quantity, 3) then
        return pg_catalog.jsonb_build_object('outcome', 'precision');
      end if;
      if not private.valid_habit_quantity(p_quantity,
          (select i.discrete from private.habit_unit_info(v_tracking.unit, v_tracking.unit_kind) i)) then
        raise exception 'invalid contribution' using errcode = '22023';
      end if;
    end if;
    select s.current_count into v_before from private.habit_streak(v_habit, v_today) s;
    if p_action = 'amend' then
      update private.habit_contributions c set original_quantity = coalesce(c.original_quantity, c.quantity),
          quantity = p_quantity, amended_by = v_user_id, amended_at = pg_catalog.now(),
          entered_quantity = null, entered_unit = null
        where c.id = v_contribution.id returning * into v_contribution;
    else
      update private.habit_contributions c set status = 'undone', undone_by = v_user_id,
          undone_at = pg_catalog.now(), undo_kind = case when p_action = 'undo' then 'undo' else 'correction' end,
          undo_reason = p_reason
        where c.id = v_contribution.id returning * into v_contribution;
    end if;
    if p_action <> 'undo' then
      perform private.habit_event(v_habit.id, 'contribution_corrected', v_user_id, v_contribution.on_date, null,
        pg_catalog.jsonb_build_object('action', p_action, 'ownContribution', v_own));
      perform private.audit_habit('habit.contribution_corrected', v_habit,
        pg_catalog.jsonb_build_object('onDate', v_contribution.on_date, 'action', p_action));
    end if;
    v_sync := private.habit_numeric_sync(v_habit, v_contribution.on_date, v_user_id, false);
    return pg_catalog.jsonb_build_object('outcome', case when p_action = 'undo' then 'undone' else 'corrected' end,
      'completedNow', (v_sync ->> 'changed') is not distinct from 'completed',
      'reopened', (v_sync ->> 'changed') is not distinct from 'reopened',
      'progress', private.habit_progress_json(v_habit, v_contribution.on_date),
      'streakBefore', v_before,
      'milestone', null,
      'habit', private.habit_summary_json(v_habit, v_user_id));
  end
  $$;

-- Daily totals ----------------------------------------------------------------------------------------

-- Up to p_days (1-62) numeric days ending the day before p_before (none: ending today), newest
-- first: one total per day with its effective target and unit, state, note and whether progress can
-- be added. hasMore: older tracked days exist. Null when the caller may not see the habit.
create function public.get_habit_daily_totals(p_habit_id uuid, p_before date default null, p_days integer default 31)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
    v_today date;
    v_to date;
    v_first date;
  begin
    if p_days is null or p_days not between 1 and 62 then
      raise exception 'invalid range' using errcode = '22023';
    end if;
    if v_habit.id is null then
      return null;
    end if;
    v_today := private.habit_today(v_habit);
    v_to := least(coalesce(p_before - 1, v_today), v_today);
    select min(greatest(t.effective_on, (select min(pr.starts_on) from private.habit_periods pr where pr.habit_id = v_habit.id)))
      into v_first from private.habit_tracking t where t.habit_id = v_habit.id and t.mode = 'numeric';
    if v_first is null or v_to < v_first then
      return pg_catalog.jsonb_build_object('days', '[]'::jsonb, 'hasMore', false);
    end if;
    return pg_catalog.jsonb_build_object(
      'days', private.habit_numeric_days_json(v_habit, greatest(v_to - p_days + 1, v_first), v_to, v_today),
      'hasMore', v_to - p_days + 1 > v_first);
  end
  $$;

-- The day's note: habit managers (the owner of a personal habit) add, change or clear it (empty),
-- from the revision they saw (0: none yet), on a numeric day that has begun, is scheduled and
-- inside a tracking period and not paused. The note never changes a total, a streak or a reminder.
-- Outcomes: 'saved', 'unchanged', 'conflict', 'not_numeric', 'untracked', 'not_scheduled', 'paused',
-- 'future', 'archived', 'not_found', 'not_permitted'. 22023 for an invalid note.
create function public.set_habit_day_note(
  p_habit_id uuid, p_on date, p_expected_revision integer, p_note text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_note text := nullif(p_note, '');
    v_row private.habit_day_notes;
    v_today date;
    v_state record;
    v_tracking private.habit_tracking;
  begin
    if p_habit_id is null or p_on is null or p_expected_revision is null or p_expected_revision < 0
       or (v_note is not null and not private.is_plain_text(v_note, private.habit_limit('note'))) then
      raise exception 'invalid note' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_habit_id, v_user_id);
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
    v_today := private.habit_today(v_habit);
    if p_on > v_today then
      return query select 'future', null::integer;
      return;
    end if;
    v_tracking := private.habit_tracking_on(v_habit.id, p_on);
    select * into v_state from private.habit_day_states(v_habit, p_on, p_on, v_today);
    if v_state.state = 'untracked' then
      return query select 'untracked', null::integer;
      return;
    end if;
    if v_tracking.id is null or v_tracking.mode <> 'numeric' then
      return query select 'not_numeric', null::integer;
      return;
    end if;
    if v_state.state = 'not_scheduled' then
      return query select 'not_scheduled', null::integer;
      return;
    end if;
    if v_state.state = 'paused' then
      return query select 'paused', null::integer;
      return;
    end if;
    select * into v_row from private.habit_day_notes n where n.habit_id = v_habit.id and n.on_date = p_on for update;
    if coalesce(v_row.revision, 0) <> p_expected_revision then
      return query select 'conflict', coalesce(v_row.revision, 0);
      return;
    end if;
    if v_note is not distinct from v_row.note then
      return query select 'unchanged', coalesce(v_row.revision, 0);
      return;
    end if;
    insert into private.habit_day_notes (habit_id, on_date, note, revision, created_by, updated_by)
      values (v_habit.id, p_on, v_note, 1, v_user_id, v_user_id)
      on conflict (habit_id, on_date) do update
        set note = excluded.note, revision = private.habit_day_notes.revision + 1,
          updated_by = v_user_id, updated_at = pg_catalog.now()
      returning * into v_row;
    perform private.habit_event(v_habit.id,
      case when v_note is null then 'note_removed' when v_row.revision = 1 then 'note_added' else 'note_edited' end,
      v_user_id, p_on, null, pg_catalog.jsonb_build_object('day', true));
    return query select 'saved', v_row.revision;
  end
  $$;

-- Changing how a habit is tracked ---------------------------------------------------------------------

-- Changes a habit's tracking from a date (habit managers; the owner of a personal habit): complete
-- once or a numeric daily target with unit and quick-add presets. p_when: 'today', 'next' (the next
-- scheduled day) or 'date' (p_effective_on). Only a target change (numeric before and after, same
-- unit) may apply today; a mode or unit change applies from tomorrow, and between incompatible units
-- (or custom labels) needs p_confirm_unit and a target the caller chose (compatible units are
-- converted exactly in the preview). Today's total is compared with the new target only after
-- p_confirm_status when that flips today between partial and completed; p_expected_total (today's total as
-- read) catches a contribution that arrived since the preview ('stale'). p_dry_run answers the
-- preview. Earlier days keep their own version. Outcomes: 'preview', 'saved', 'unchanged',
-- 'invalid_date' (past, after the habit's end, or no scheduled day ahead; impact says why),
-- 'today_ineligible' (today cannot take it: paused, unscheduled, ...; impact.nextDate), 'confirm_unit',
-- 'confirm_status', 'stale', 'numeric_requires_daily', 'ended', 'archived', 'conflict', 'not_found',
-- 'not_permitted'. 22023 for an invalid tracking.
create function public.change_habit_tracking(
  p_id uuid, p_expected_revision integer, p_mode text, p_target numeric default null,
  p_unit text default null, p_unit_kind text default null, p_quick_adds numeric[] default null,
  p_when text default 'date', p_effective_on date default null, p_expected_total numeric default null,
  p_confirm_status boolean default false, p_confirm_unit boolean default false, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_today date;
    v_status text;
    v_last private.habit_periods;
    v_eff date;
    v_old private.habit_tracking;
    v_cur private.habit_tracking;
    v_same_unit boolean;
    v_old_dimension text;
    v_new_dimension text;
    v_old_factor numeric := 1;
    v_new_factor numeric := 1;
    v_relation text := 'same';
    v_converted numeric;
    v_total numeric;
    v_today_block text;
    v_before boolean;
    v_after boolean;
    v_applies_today boolean;
    v_impact jsonb;
    v_quick numeric[] := coalesce(p_quick_adds, '{}');
    v_reminder private.habit_reminders;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null or p_confirm_status is null
       or p_confirm_unit is null or p_mode is null or p_mode not in ('once', 'numeric')
       or p_when is null or p_when not in ('today', 'next', 'date')
       or (p_when = 'date' and p_effective_on is null)
       or not private.valid_habit_tracking(p_mode, p_target, p_unit, p_unit_kind, v_quick) then
      raise exception 'invalid tracking' using errcode = '22023';
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
    v_cur := private.habit_tracking_on(v_habit.id, v_today);
    v_eff := case p_when when 'today' then v_today when 'next' then private.habit_next_scheduled(v_habit, v_today)
      else p_effective_on end;
    if v_eff is null or v_eff < v_today then
      return query select 'invalid_date', pg_catalog.jsonb_build_object('earliest', v_today,
        'reason', case when v_eff is null then 'no_scheduled_day' else 'past' end), v_habit.revision;
      return;
    end if;
    v_old := private.habit_tracking_on(v_habit.id, v_eff);
    v_same_unit := v_old.mode = 'numeric' and p_mode = 'numeric' and v_old.unit = p_unit
      and v_old.unit_kind = p_unit_kind;
    -- No presets given: the same unit keeps its presets, another unit starts without.
    if p_quick_adds is null and v_same_unit then
      v_quick := v_old.quick_adds;
    end if;
    if v_eff = v_today and not v_same_unit then
      return query select 'invalid_date', pg_catalog.jsonb_build_object('earliest', v_today + 1,
        'reason', 'mode_or_unit_needs_future'), v_habit.revision;
      return;
    end if;
    if v_last.ends_on is not null and v_eff > v_last.ends_on then
      return query select 'invalid_date', pg_catalog.jsonb_build_object('earliest', v_today,
        'reason', 'after_end', 'afterEnd', true, 'endsOn', v_last.ends_on), v_habit.revision;
      return;
    end if;
    if p_mode = 'numeric' and ((private.habit_schedule_on(v_habit.id, v_eff)).kind = 'weekly'
       or exists (select 1 from private.habit_schedules s
         where s.habit_id = v_habit.id and s.kind = 'weekly' and s.effective_on > v_eff)) then
      return query select 'numeric_requires_daily', null::jsonb, v_habit.revision;
      return;
    end if;
    v_applies_today := v_eff = v_today;
    if v_applies_today then
      v_today_block := private.habit_contribution_block(v_habit, v_today, v_today);
      if v_today_block is not null then
        return query select 'today_ineligible', pg_catalog.jsonb_build_object('reason', v_today_block,
          'nextDate', private.habit_next_scheduled(v_habit, v_today)), v_habit.revision;
        return;
      end if;
      v_total := private.habit_contribution_total(v_habit.id, v_today);
      v_before := v_total >= v_old.target;
      v_after := v_total >= p_target;
    end if;
    if v_old.mode = 'numeric' and p_mode = 'numeric' and not v_same_unit then
      select i.dimension, i.factor into v_old_dimension, v_old_factor
        from private.habit_unit_info(v_old.unit, v_old.unit_kind) i;
      select i.dimension, i.factor into v_new_dimension, v_new_factor
        from private.habit_unit_info(p_unit, p_unit_kind) i;
      if v_old_dimension = v_new_dimension and v_old.unit_kind = 'preset' and p_unit_kind = 'preset' then
        v_relation := 'compatible';
        v_converted := v_old.target * v_old_factor / v_new_factor;
      else
        v_relation := 'incompatible';
      end if;
    elsif v_old.mode is distinct from p_mode then
      v_relation := 'mode';
    end if;
    select * into v_reminder from private.habit_reminders r where r.habit_id = v_habit.id;
    v_impact := pg_catalog.jsonb_build_object(
      'old', private.habit_tracking_json(v_old, v_habit),
      'new', pg_catalog.jsonb_build_object('mode', p_mode, 'target', p_target, 'unit', p_unit,
        'unitKind', p_unit_kind, 'quickAdds', pg_catalog.to_jsonb(v_quick)),
      'effectiveOn', v_eff, 'when', p_when, 'relation', v_relation,
      'converted', case when v_relation = 'compatible' then pg_catalog.jsonb_build_object(
        'target', pg_catalog.round(v_converted, 3), 'exact', v_converted = pg_catalog.round(v_converted, 3),
        'quickAdds', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.round(q * v_old_factor / v_new_factor, 3)), '[]'::jsonb)
          from pg_catalog.unnest(v_old.quick_adds) q)) end,
      'today', case when v_applies_today then pg_catalog.jsonb_build_object('total', v_total,
        'completedBefore', v_before, 'completedAfter', v_after, 'statusChange', v_before <> v_after) end,
      'nextDates', coalesce((select pg_catalog.jsonb_agg(x.on_date order by x.on_date)
        from (select y.on_date from private.habit_days(v_habit.id, v_eff, v_eff + 60) y
          where y.period_id is not null and y.scheduled order by y.on_date limit 5) x), '[]'::jsonb),
      'currentStreak', (select pg_catalog.jsonb_build_object('current', s.current_count, 'unit', s.current_unit)
        from private.habit_streak(v_habit, v_today) s),
      'pauses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('startsOn', hp.starts_on,
          'resumesOn', hp.resumes_on) order by hp.starts_on)
        from private.habit_pauses hp where hp.habit_id = v_habit.id
          and (hp.resumes_on is null or hp.resumes_on > v_eff) and hp.resumes_on is distinct from hp.starts_on),
        '[]'::jsonb),
      'vacationDays', private.habit_ranges_json((select v.days from private.habit_vacation_days v
        where v.habit_id = v_habit.id) * pg_catalog.datemultirange(pg_catalog.daterange(v_eff, null))),
      'reminders', coalesce(v_reminder.enabled, false));
    if v_relation = 'incompatible' and not p_confirm_unit then
      return query select 'confirm_unit', v_impact, v_habit.revision;
      return;
    end if;
    if ((p_mode = 'once' and coalesce(v_old.mode, 'once') = 'once')
        or (p_mode = 'numeric' and v_old.mode = 'numeric' and v_old.target = p_target
          and v_old.unit = p_unit and v_old.unit_kind = p_unit_kind
          and v_old.quick_adds = v_quick::numeric(12, 3)[]))
       and not exists (select 1 from private.habit_tracking t where t.habit_id = v_habit.id and t.effective_on > v_eff) then
      return query select 'unchanged', v_impact, v_habit.revision;
      return;
    end if;
    if v_applies_today and p_expected_total is distinct from v_total then
      return query select 'stale', v_impact, v_habit.revision;
      return;
    end if;
    if v_applies_today and v_before <> v_after and not p_confirm_status and not p_dry_run then
      return query select 'confirm_status', v_impact, v_habit.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_impact, v_habit.revision;
      return;
    end if;
    delete from private.habit_tracking t where t.habit_id = v_habit.id and t.effective_on >= v_eff;
    insert into private.habit_tracking (habit_id, effective_on, mode, target, unit, unit_kind, quick_adds, created_by)
      values (v_habit.id, v_eff, p_mode, p_target, p_unit, p_unit_kind, v_quick, v_user_id);
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    perform private.habit_event(v_habit.id, 'tracking_changed', v_user_id, v_eff, null,
      pg_catalog.jsonb_build_object('from', coalesce(v_old.mode, 'once'), 'to', p_mode, 'relation', v_relation,
        'statusChange', coalesce(v_before <> v_after, false)));
    perform private.audit_habit('habit.tracking_changed', v_habit,
      pg_catalog.jsonb_build_object('effectiveOn', v_eff, 'mode', p_mode));
    if v_applies_today then
      perform private.habit_numeric_sync(v_habit, v_today, v_user_id, false);
    end if;
    return query select 'saved', v_impact, v_habit.revision;
  end
  $$;

-- Replaces the quick-add presets (habit managers) of the tracking in effect today (or, before a
-- numeric version starts, the next one) and of every later version with the same unit. Up to five
-- distinct positive amounts the unit allows, in the order given. Outcomes: 'saved', 'unchanged',
-- 'not_numeric', 'conflict', 'archived', 'not_found', 'not_permitted'. 22023 for invalid presets.
create function public.set_habit_quick_adds(p_id uuid, p_expected_revision integer, p_quick_adds numeric[])
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_today date;
    v_row private.habit_tracking;
    v_quick numeric[] := coalesce(p_quick_adds, '{}');
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid presets' using errcode = '22023';
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
    if v_habit.revision <> p_expected_revision then
      return query select 'conflict', v_habit.revision;
      return;
    end if;
    v_today := private.habit_today(v_habit);
    v_row := private.habit_tracking_on(v_habit.id, v_today);
    if v_row.id is null or v_row.mode <> 'numeric' then
      select * into v_row from private.habit_tracking t
        where t.habit_id = v_habit.id and t.mode = 'numeric' and t.effective_on > v_today
        order by t.effective_on limit 1;
    end if;
    if v_row.id is null then
      return query select 'not_numeric', null::integer;
      return;
    end if;
    if not private.valid_habit_tracking('numeric', v_row.target, v_row.unit, v_row.unit_kind, v_quick) then
      raise exception 'invalid presets' using errcode = '22023';
    end if;
    if v_row.quick_adds is not distinct from v_quick::numeric(12, 3)[] then
      return query select 'unchanged', v_habit.revision;
      return;
    end if;
    update private.habit_tracking t set quick_adds = v_quick
      where t.habit_id = v_habit.id and t.mode = 'numeric' and t.effective_on >= v_row.effective_on
        and t.unit = v_row.unit and t.unit_kind = v_row.unit_kind;
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    perform private.habit_event(v_habit.id, 'tracking_changed', v_user_id, v_today, null,
      pg_catalog.jsonb_build_object('presets', true));
    return query select 'saved', v_habit.revision;
  end
  $$;

-- Reminders carry a point-in-time progress snapshot ---------------------------------------------------

-- deliver_habit_reminder of S28 with 'progress' in the notice (null for a day that completes once).
-- An unmet numeric day still sends; a met one is 'not_needed' as before (its derived check-in
-- blocks the day), so reaching the target stops the day's reminders.
create or replace function public.deliver_habit_reminder(p_habit_id uuid, p_revision integer, p_at timestamptz)
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
          'weekly', (private.habit_schedule_on(v_habit.id, v_on)).kind = 'weekly',
          'progress', private.habit_progress_json(v_habit, v_on)),
        'habit-reminder:' || v_habit.id::text || ':' || v_user_id::text || ':' || extract(epoch from p_at)::bigint::text,
        true);
    end loop;
    return 'notified';
  end
  $$;

create or replace function public.deliver_habit_snooze(p_notification_id uuid) returns text
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
        'snoozed', true, 'progress', private.habit_progress_json(v_habit, v_snooze.on_date)),
      'habit-snooze:' || p_notification_id::text, true);
    update private.habit_reminder_snoozes s set status = 'delivered' where s.notification_id = p_notification_id;
    return 'notified';
  end
  $$;

-- Grants ----------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The numeric habits API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_habit', 'get_habit_calendar', 'get_habit_insights', 'create_habit', 'complete_habit',
      'undo_habit_checkin', 'set_habit_checkin_note', 'change_habit_schedule', 'reactivate_habit',
      'add_habit_contribution', 'get_habit_contributions', 'update_habit_contribution',
      'get_habit_daily_totals', 'set_habit_day_note', 'change_habit_tracking', 'set_habit_quick_adds'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Background delivery stays with the service role.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('deliver_habit_reminder', 'deliver_habit_snooze')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers (including the renamed S28 originals) stay closed to the API roles.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like '%habit%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
