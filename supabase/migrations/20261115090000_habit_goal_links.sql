-- S30c: habit-to-goal links (brief plans/steps/S30c-brief.md; ADR 0040; spec "Confirmed optional
-- numeric habit-to-goal automatic progress synchronization", "Confirmed selectable historical start for
-- habit-to-goal links", "Confirmed continued habit-to-goal synchronization after achievement",
-- "Confirmed multiple independent goal links per numeric habit", and the linked-series lines of the
-- recurring goal and period finalization decisions). Builds on S29 (numeric habits), S30 (goals) and
-- S30b (recurring goals).
--
-- A link makes a numeric habit's recorded daily quantities count toward one measurable goal, or toward
-- every period of one measurable series. Links exist only inside one context: a person's habit toward
-- their own personal goal, a Home's habit toward a goal of the same Home. Everyone who sees such a goal
-- already sees the habit, so a link never shows anything to someone who could not see it before, and
-- no link crosses Homes.
--
-- The linked ledger (goal_link_days) holds one row per link and habit day: the day's active total in
-- the day's habit unit, converted into the goal's unit, and the goal (for a series, the period that
-- contains the day) it counts for. It is derived: nobody writes it directly, and every change to the
-- habit day (add, Undo, a manager's void or amend, backdating) recomputes it in the same transaction,
-- under the habit lock and then the goals' locks. A goal's total is its manual ledger (S30) plus its
-- linked ledger. Reaching the target never marks a goal achieved; an achieved goal keeps counting.
--
-- Lock order: habit, then series (ascending ids), then goals (ascending ids). Goal-side writes never
-- take a habit lock: they rebuild a goal's linked rows from the habit's committed data while holding
-- the goal lock, and every habit-side recompute takes the goal lock before it reads anything, so both
-- sides end equal whichever runs first. A goal that is archived or in the trash (or a period of a series
-- in the trash) is left alone while hidden; unarchive, restore and a new period rebuild its rows.

-- Event kinds, entry source ------------------------------------------------------------------------------

alter table private.goal_events drop constraint goal_events_kind_check;
alter table private.goal_events add constraint goal_events_kind_check check (kind in (
  'created', 'edited', 'target_changed', 'adjusted', 'corrected', 'achieved', 'reopened',
  'archived', 'unarchived', 'restored', 'reminders_changed', 'finalized', 'outcome_changed',
  'link_created', 'link_changed', 'link_removed'
));

alter table private.goal_series_events drop constraint goal_series_events_kind_check;
alter table private.goal_series_events add constraint goal_series_events_kind_check check (kind in (
  'created', 'edited', 'target_scheduled', 'paused', 'resumed', 'stopped', 'restored',
  'link_created', 'link_changed', 'link_removed'
));

-- 'link': the manual adjustment that keeps a removed link's amount in the goal.
alter table private.goal_entries drop constraint goal_entries_source_check;
alter table private.goal_entries add constraint goal_entries_source_check
  check (source in ('app', 'widget', 'link'));

-- Limits -------------------------------------------------------------------------------------------------

-- apps/web/src/goals/schema.ts uses the same numbers.
create function private.goal_link_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'per_goal' then 10           -- active links into one goal or series
    when 'per_habit' then 10          -- active links out of one habit
  end;
  $$;

-- Tables -------------------------------------------------------------------------------------------------

-- A link from a numeric habit to a measurable goal (goal_id) or to a measurable series (series_id).
-- starts_on: the first habit day that counts (inclusive). A removed link is kept for the history; its
-- ledger rows are gone (kept as a manual adjustment or removed, removal). habit_id becomes null when
-- the habit is purged: the link then stays frozen with its amounts until a goal manager removes it.
create table private.goal_habit_links (
  id uuid primary key,
  habit_id uuid references private.habits (id) on delete set null,
  goal_id uuid references private.goals (id) on delete cascade,
  series_id uuid references private.goal_series (id) on delete cascade,
  starts_on date not null,
  state text not null default 'active' constraint goal_habit_links_state_check check (state in ('active', 'removed')),
  removal text constraint goal_habit_links_removal_check check (removal in ('keep', 'remove')),
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint goal_habit_links_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint goal_habit_links_one_target check (num_nonnulls(goal_id, series_id) = 1),
  constraint goal_habit_links_removed_check
    check ((state = 'removed') = (removed_at is not null) and (state = 'removed') = (removal is not null))
);

-- At most one active link between a habit and a goal or series: a second one would count every day twice.
create unique index goal_habit_links_goal_key on private.goal_habit_links (habit_id, goal_id)
  where state = 'active' and goal_id is not null;
create unique index goal_habit_links_series_key on private.goal_habit_links (habit_id, series_id)
  where state = 'active' and series_id is not null;
create index goal_habit_links_habit_idx on private.goal_habit_links (habit_id) where state = 'active';
create index goal_habit_links_goal_idx on private.goal_habit_links (goal_id) where goal_id is not null;
create index goal_habit_links_series_idx on private.goal_habit_links (series_id) where series_id is not null;

-- The linked ledger: what one link counts for one habit day. source_*: the day's active habit total in
-- the unit of the habit's tracking version that day; quantity: that total in the goal's unit (0 when
-- the units are not compatible, counted false). goal_id: the goal or the series' period it counts for.
create table private.goal_link_days (
  link_id uuid not null references private.goal_habit_links (id) on delete cascade,
  on_date date not null,
  goal_id uuid not null references private.goals (id) on delete cascade,
  source_quantity numeric(16, 3) not null constraint goal_link_days_source_check check (source_quantity > 0),
  source_unit text not null,
  source_unit_kind text not null constraint goal_link_days_unit_kind_check check (source_unit_kind in ('preset', 'custom')),
  quantity numeric(16, 3) not null constraint goal_link_days_quantity_check check (quantity >= 0),
  counted boolean not null,
  updated_at timestamptz not null default now(),
  primary key (link_id, on_date),
  constraint goal_link_days_counted_check check (counted or quantity = 0)
);

create index goal_link_days_goal_idx on private.goal_link_days (goal_id);

alter table private.goal_habit_links enable row level security;
alter table private.goal_link_days enable row level security;
revoke all on private.goal_habit_links, private.goal_link_days from public, anon, authenticated;

-- Units --------------------------------------------------------------------------------------------------

-- A habit quantity in a goal's unit: the same unit as is; the same dimension (l and ml, h and min, km
-- and m) by the exact factors, rounded half up to three decimals; an identical custom label as is.
-- Null when the units are not compatible (another dimension, a whole-number unit, another custom
-- label). packages/domain/src/goals/links.ts uses the same rule.
create function private.goal_link_convert(
  p_quantity numeric, p_from text, p_from_kind text, p_to text, p_to_kind text
) returns numeric
  language sql immutable set search_path = '' as $$
  select case
    when p_quantity is null or p_from is null or p_to is null or p_from_kind is null or p_to_kind is null then null
    when p_from_kind = p_to_kind and p_from = p_to then p_quantity
    when p_from_kind = 'preset' and p_to_kind = 'preset' then (
      select pg_catalog.round(p_quantity * a.factor / b.factor, 3)
      from private.habit_unit_info(p_from, 'preset') a, private.habit_unit_info(p_to, 'preset') b
      where a.dimension = b.dimension and not a.discrete and not b.discrete)
  end;
  $$;

create function private.goal_link_compatible(p_from text, p_from_kind text, p_to text, p_to_kind text)
returns boolean
  language sql immutable set search_path = '' as $$
  select private.goal_link_convert(1, p_from, p_from_kind, p_to, p_to_kind) is not null;
  $$;

-- Helpers ------------------------------------------------------------------------------------------------

-- Whether the linked rows of a goal may change now: a measurable goal that is not archived and not out
-- of sight (in the trash, or a period of a series in the trash).
create function private.goal_link_syncable(p_goal private.goals) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_goal.kind = 'measurable' and p_goal.archived_at is null and not private.goal_hidden(p_goal), false);
  $$;

-- A habit's first start date (its first tracking period).
create function private.habit_first_start(p_habit_id uuid) returns date
  language sql stable security definer set search_path = '' as $$
  select min(p.starts_on) from private.habit_periods p where p.habit_id = p_habit_id;
  $$;

-- The numeric tracking version a new link is checked against: the one in effect on p_on when it is
-- numeric, otherwise the next numeric one (a row of nulls when there is none).
create function private.habit_link_tracking(p_habit_id uuid, p_on date) returns private.habit_tracking
  language sql stable security definer set search_path = '' as $$
  select t.* from private.habit_tracking t
  where t.habit_id = p_habit_id and t.mode = 'numeric'
    and (t.id = (private.habit_tracking_on(p_habit_id, p_on)).id or t.effective_on > p_on)
  order by t.effective_on limit 1;
  $$;

-- The linked ledger rows a link with these settings would have: one per habit day from p_starts_on with
-- active contributions on a numeric day, for the goal (or the series' period containing the day) when
-- its rows may change. p_only_goal and p_only_day narrow it.
create function private.goal_link_rows(
  p_habit_id uuid, p_starts_on date, p_goal_id uuid, p_series_id uuid,
  p_only_goal uuid default null, p_only_day date default null
) returns table (
  on_date date, goal_id uuid, source_quantity numeric, source_unit text, source_unit_kind text,
  quantity numeric, counted boolean
)
  language sql stable security definer set search_path = '' as $$
  select d.on_date, g.id, d.total, t.unit, t.unit_kind,
    coalesce(private.goal_link_convert(d.total, t.unit, t.unit_kind, g.unit, g.unit_kind), 0),
    private.goal_link_convert(d.total, t.unit, t.unit_kind, g.unit, g.unit_kind) is not null
  from (select c.on_date, sum(c.quantity) as total from private.habit_contributions c
      where c.habit_id = p_habit_id and c.status = 'active' and c.on_date >= p_starts_on
        and (p_only_day is null or c.on_date = p_only_day)
      group by c.on_date) d
  cross join lateral private.habit_tracking_on(p_habit_id, d.on_date) t
  join private.goals g on case when p_goal_id is not null then g.id = p_goal_id
    else g.series_id = p_series_id and d.on_date between g.period_start and g.period_end end
  where t.mode = 'numeric' and d.total > 0 and private.goal_link_syncable(g)
    and (p_only_goal is null or g.id = p_only_goal);
  $$;

-- Progress (S30, now with the linked ledger) -------------------------------------------------------------

create function private.goal_manual_total(p_goal private.goals) returns numeric
  language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(e.quantity) from private.goal_entries e
    where e.goal_id = p_goal.id and e.status = 'active'), 0);
  $$;

create function private.goal_linked_total(p_goal private.goals) returns numeric
  language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(d.quantity) from private.goal_link_days d
    where d.goal_id = p_goal.id and d.counted), 0);
  $$;

-- The exact total of a measurable goal: its manual ledger plus what linked habits count for it (null
-- for a completion goal).
create or replace function private.goal_total(p_goal private.goals) returns numeric
  language sql stable security definer set search_path = '' as $$
  select case when p_goal.kind = 'measurable'
    then private.goal_manual_total(p_goal) + private.goal_linked_total(p_goal) end;
  $$;

-- Recompute ----------------------------------------------------------------------------------------------

-- Rebuilds a link's ledger rows (all of them, those of one goal, or one day) from the habit's data,
-- for goals whose rows may change; an ended period whose total changed recomputes its outcome (S30b;
-- the change names nobody, since it came from a habit). The caller holds the goals' locks. A removed
-- link, or one whose habit was purged, is left as it is.
create function private.goal_link_refresh(p_link_id uuid, p_goal_id uuid default null, p_on date default null)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_link private.goal_habit_links;
    v_gone uuid[];
    v_added uuid[];
    v_goal_id uuid;
  begin
    select * into v_link from private.goal_habit_links l where l.id = p_link_id;
    if v_link.id is null or v_link.state <> 'active' or v_link.habit_id is null then
      return;
    end if;
    with gone as (
      delete from private.goal_link_days d using private.goals g
      where d.link_id = v_link.id and g.id = d.goal_id and private.goal_link_syncable(g)
        and (p_goal_id is null or d.goal_id = p_goal_id) and (p_on is null or d.on_date = p_on)
      returning d.goal_id
    ) select pg_catalog.array_agg(distinct gone.goal_id) into v_gone from gone;
    with added as (
      insert into private.goal_link_days as d (link_id, on_date, goal_id, source_quantity, source_unit,
          source_unit_kind, quantity, counted)
        select v_link.id, r.on_date, r.goal_id, r.source_quantity, r.source_unit, r.source_unit_kind,
          r.quantity, r.counted
        from private.goal_link_rows(v_link.habit_id, v_link.starts_on, v_link.goal_id, v_link.series_id,
          p_goal_id, p_on) r
      on conflict (link_id, on_date) do update set goal_id = excluded.goal_id,
        source_quantity = excluded.source_quantity, source_unit = excluded.source_unit,
        source_unit_kind = excluded.source_unit_kind, quantity = excluded.quantity,
        counted = excluded.counted, updated_at = pg_catalog.now()
      returning d.goal_id
    ) select pg_catalog.array_agg(distinct added.goal_id) into v_added from added;
    for v_goal_id in select distinct x from pg_catalog.unnest(coalesce(v_gone, '{}') || coalesce(v_added, '{}')) x loop
      perform private.recheck_goal_outcome(v_goal_id, null);
    end loop;
  end
  $$;

-- After a habit day changed (under the habit lock): locks the series and goals its active links count
-- that day for, in the lock order, and recomputes the day for each link.
create function private.goal_links_after_habit_day(p_habit_id uuid, p_on date) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_link_id uuid;
  begin
    if not exists (select 1 from private.goal_habit_links l
        where l.habit_id = p_habit_id and l.state = 'active' and l.starts_on <= p_on) then
      return;
    end if;
    perform 1 from private.goal_series s
      where s.id in (select l.series_id from private.goal_habit_links l
        where l.habit_id = p_habit_id and l.state = 'active' and l.starts_on <= p_on and l.series_id is not null)
      order by s.id for update of s;
    perform 1 from private.goals g
      where g.id in (
        select l.goal_id from private.goal_habit_links l
          where l.habit_id = p_habit_id and l.state = 'active' and l.starts_on <= p_on and l.goal_id is not null
        union
        select x.id from private.goals x join private.goal_habit_links l on l.series_id = x.series_id
          where l.habit_id = p_habit_id and l.state = 'active' and l.starts_on <= p_on
            and p_on between x.period_start and x.period_end)
      order by g.id for update of g;
    for v_link_id in select l.id from private.goal_habit_links l
        where l.habit_id = p_habit_id and l.state = 'active' and l.starts_on <= p_on order by l.id loop
      perform private.goal_link_refresh(v_link_id, null, p_on);
    end loop;
  end
  $$;

-- Rebuilds every active link's rows for one goal (the caller holds its lock): a one-off goal's own
-- links, or its series' links for a period.
create function private.goal_links_refresh_goal(p_goal_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
    v_link_id uuid;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id;
    if v_goal.id is null then
      return;
    end if;
    for v_link_id in select l.id from private.goal_habit_links l
        where l.state = 'active' and (l.goal_id = v_goal.id or (v_goal.series_id is not null and l.series_id = v_goal.series_id))
        order by l.id loop
      perform private.goal_link_refresh(v_link_id, v_goal.id, null);
    end loop;
  end
  $$;

-- Rebuilds every active link of a series for all its periods (the caller holds the series lock; the
-- periods are locked here, after it).
create function private.goal_links_refresh_series(p_series_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_link_id uuid;
  begin
    if not exists (select 1 from private.goal_habit_links l where l.series_id = p_series_id and l.state = 'active') then
      return;
    end if;
    perform 1 from private.goals g where g.series_id = p_series_id order by g.id for update of g;
    for v_link_id in select l.id from private.goal_habit_links l
        where l.series_id = p_series_id and l.state = 'active' order by l.id loop
      perform private.goal_link_refresh(v_link_id, null, null);
    end loop;
  end
  $$;

-- Hooks into S29 and S30b ----------------------------------------------------------------------------------

-- habit_numeric_sync (S29) runs after every change to a habit day's contributions, under the habit
-- lock: the day's linked rows follow in the same transaction.
alter function private.habit_numeric_sync(private.habits, date, uuid, boolean) rename to habit_numeric_sync_before_links;

create function private.habit_numeric_sync(
  p_habit private.habits, p_on date, p_actor uuid, p_celebrate boolean
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_sync jsonb := private.habit_numeric_sync_before_links(p_habit, p_on, p_actor, p_celebrate);
  begin
    perform private.goal_links_after_habit_day(p_habit.id, p_on);
    return v_sync;
  end
  $$;

-- A new period of a series counts its series' links from the start (rollover holds the series lock).
alter function private.create_goal_period(private.goal_series, date, date) rename to create_goal_period_before_links;

create function private.create_goal_period(p_series private.goal_series, p_start date, p_end date)
returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal_id uuid := private.create_goal_period_before_links(p_series, p_start, p_end);
  begin
    if v_goal_id is not null then
      perform private.goal_links_refresh_goal(v_goal_id);
    end if;
    return v_goal_id;
  end
  $$;

-- Answers ------------------------------------------------------------------------------------------------

-- A goal as the viewer sees it (S30, S30b) with its progress breakdown: the manual part, what linked
-- habits count, and how many links count toward it.
alter function private.goal_summary_json(private.goals, uuid) rename to goal_summary_json_before_links;

create function private.goal_summary_json(p_goal private.goals, p_viewer uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select private.goal_summary_json_before_links(p_goal, p_viewer) || pg_catalog.jsonb_build_object(
    'manualTotal', case when p_goal.kind = 'measurable' then private.goal_manual_total(p_goal) end,
    'linkedTotal', case when p_goal.kind = 'measurable' then private.goal_linked_total(p_goal) end,
    'linkCount', (select count(*) from private.goal_habit_links l where l.state = 'active'
      and (l.goal_id = p_goal.id or (p_goal.series_id is not null and l.series_id = p_goal.series_id))));
  $$;

-- What a link's habit is now: 'active', 'archived', 'trash' or 'deleted' (purged).
create function private.goal_link_source_state(p_link private.goal_habit_links) returns text
  language sql stable security definer set search_path = '' as $$
  select case when h.id is null then 'deleted' when h.deleted_at is not null then 'trash'
    when h.archived_at is not null then 'archived' else 'active' end
  from (select 1) x left join private.habits h on h.id = p_link.habit_id;
  $$;

-- Whether p_viewer may change or remove a link: goal manager of its goal or series and, while the habit
-- exists, habit manager.
create function private.goal_link_manager(p_link private.goal_habit_links, p_viewer uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    case when p_link.goal_id is not null
      then private.goal_may((select g from private.goals g where g.id = p_link.goal_id), p_viewer, 'manage')
      else private.goal_series_role((select s from private.goal_series s where s.id = p_link.series_id), p_viewer) = 'manage' end
    and (p_link.habit_id is null
      or private.habit_may((select h from private.habits h where h.id = p_link.habit_id), p_viewer, 'manage')),
    false);
  $$;

-- A link as a viewer of its goal and habit sees it. amount and uncountedDays are for p_goal_id when
-- given (a period of a series link, or the goal), otherwise for the link's goal, or for a series link
-- its current period. Daily totals only: nobody's contribution is named.
create function private.goal_link_json(p_link private.goal_habit_links, p_viewer uuid, p_goal_id uuid default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_habit private.habits;
    v_series private.goal_series;
    v_goal private.goals;
    v_scope uuid := p_goal_id;
    v_today date;
    v_tracking private.habit_tracking;
  begin
    select * into v_habit from private.habits h where h.id = p_link.habit_id;
    if p_link.series_id is not null then
      select * into v_series from private.goal_series s where s.id = p_link.series_id;
      if v_scope is null then
        v_today := (pg_catalog.now() at time zone private.goal_series_zone(v_series))::date;
        select g.id into v_scope from private.goals g
          where g.series_id = v_series.id and v_today between g.period_start and g.period_end and g.deleted_at is null;
      end if;
    else
      select * into v_goal from private.goals g where g.id = p_link.goal_id;
      v_scope := coalesce(v_scope, v_goal.id);
    end if;
    if v_habit.id is not null then
      v_tracking := private.habit_link_tracking(v_habit.id, private.habit_today(v_habit));
    end if;
    return pg_catalog.jsonb_build_object(
      'id', p_link.id,
      'habit', case when v_habit.id is not null then pg_catalog.jsonb_build_object('id', v_habit.id,
        'name', v_habit.name, 'unit', v_tracking.unit, 'unitKind', v_tracking.unit_kind,
        'firstStart', private.habit_first_start(v_habit.id), 'today', private.habit_today(v_habit)) end,
      'source', private.goal_link_source_state(p_link),
      'goalId', p_link.goal_id,
      'seriesId', p_link.series_id,
      'destination', case when v_series.id is not null
        then pg_catalog.jsonb_build_object('kind', 'series', 'id', v_series.id, 'title', v_series.title,
          'frequency', v_series.frequency)
        else pg_catalog.jsonb_build_object('kind', 'goal', 'id', v_goal.id, 'title', v_goal.title) end,
      'homeId', coalesce(v_series.owner_home_id, v_goal.owner_home_id),
      'startsOn', p_link.starts_on,
      'state', p_link.state,
      'revision', p_link.revision,
      'scopeGoalId', v_scope,
      'amount', coalesce((select sum(d.quantity) from private.goal_link_days d
        where d.link_id = p_link.id and d.goal_id = v_scope and d.counted), 0),
      'uncountedDays', (select count(*) from private.goal_link_days d
        where d.link_id = p_link.id and d.goal_id = v_scope and not d.counted),
      'createdAt', p_link.created_at,
      'createdBy', case when coalesce(v_series.owner_home_id, v_goal.owner_home_id) is not null
        and p_link.created_by is not null
        then private.member_ref(coalesce(v_series.owner_home_id, v_goal.owner_home_id), p_link.created_by) end,
      'mine', coalesce(p_link.created_by = p_viewer, false),
      'actions', pg_catalog.jsonb_build_object(
        'manage', p_link.state = 'active' and private.goal_link_manager(p_link, p_viewer),
        'changeStart', p_link.state = 'active' and v_habit.id is not null and v_habit.deleted_at is null
          and v_habit.archived_at is null and private.goal_link_manager(p_link, p_viewer)));
  end
  $$;

-- Reading ------------------------------------------------------------------------------------------------

-- The active links of exactly one of: a goal (a period shows its series' links, with the amounts for
-- that period), a series (amounts for its current period) or a habit. Null when the caller may not see
-- it. 22023 unless exactly one id is given.
create function public.get_goal_links(p_goal_id uuid default null, p_series_id uuid default null, p_habit_id uuid default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_series private.goal_series;
    v_habit private.habits;
  begin
    if num_nonnulls(p_goal_id, p_series_id, p_habit_id) <> 1 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_goal_id is not null then
      v_goal := private.goal_for(p_goal_id, v_user_id);
      if v_goal.id is null then
        return null;
      end if;
      return pg_catalog.jsonb_build_object('links', coalesce((select pg_catalog.jsonb_agg(
          private.goal_link_json(l, v_user_id, v_goal.id) order by l.created_at, l.id)
        from private.goal_habit_links l where l.state = 'active'
          and (l.goal_id = v_goal.id or (v_goal.series_id is not null and l.series_id = v_goal.series_id))), '[]'::jsonb));
    elsif p_series_id is not null then
      v_series := private.goal_series_for(p_series_id, v_user_id);
      if v_series.id is null then
        return null;
      end if;
      return pg_catalog.jsonb_build_object('links', coalesce((select pg_catalog.jsonb_agg(
          private.goal_link_json(l, v_user_id) order by l.created_at, l.id)
        from private.goal_habit_links l where l.state = 'active' and l.series_id = v_series.id), '[]'::jsonb));
    end if;
    v_habit := private.habit_for(p_habit_id, v_user_id);
    if v_habit.id is null then
      return null;
    end if;
    -- Only destinations the caller can see (the same people, since links stay inside one context).
    return pg_catalog.jsonb_build_object('links', coalesce((select pg_catalog.jsonb_agg(
        private.goal_link_json(l, v_user_id) order by l.created_at, l.id)
      from private.goal_habit_links l where l.state = 'active' and l.habit_id = v_habit.id
        and case when l.goal_id is not null then (private.goal_for(l.goal_id, v_user_id)).id is not null
          else (private.goal_series_for(l.series_id, v_user_id)).id is not null end), '[]'::jsonb));
  end
  $$;

-- The habits the caller could link to a goal or series: numeric habits of the same context (not
-- archived, not in the trash) that they manage, with a unit compatible with the goal's (a series: every
-- target from its current period on), not linked to it yet. Null when the caller may not see the goal
-- or series; an empty list when they may not manage it.
create function public.get_goal_link_candidates(p_goal_id uuid default null, p_series_id uuid default null)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_series private.goal_series;
    v_home_id uuid;
    v_owner uuid;
    v_manage boolean;
  begin
    if num_nonnulls(p_goal_id, p_series_id) <> 1 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_goal_id is not null then
      v_goal := private.goal_for(p_goal_id, v_user_id);
      if v_goal.id is null then
        return null;
      end if;
      v_home_id := v_goal.owner_home_id;
      v_owner := v_goal.owner_user_id;
      v_manage := private.goal_may(v_goal, v_user_id, 'manage') and v_goal.kind = 'measurable'
        and v_goal.series_id is null and v_goal.archived_at is null;
    else
      v_series := private.goal_series_for(p_series_id, v_user_id);
      if v_series.id is null then
        return null;
      end if;
      v_home_id := v_series.owner_home_id;
      v_owner := v_series.owner_user_id;
      v_manage := private.goal_series_role(v_series, v_user_id) = 'manage' and v_series.kind = 'measurable'
        and v_series.state <> 'stopped';
    end if;
    if not v_manage then
      return pg_catalog.jsonb_build_object('habits', '[]'::jsonb);
    end if;
    return pg_catalog.jsonb_build_object('habits', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', x.id, 'name', x.name, 'unit', x.unit, 'unitKind', x.unit_kind, 'firstStart', x.first_start,
        'today', x.today) order by pg_catalog.lower(x.name), x.id)
      from (select h.id, h.name, t.unit, t.unit_kind, private.habit_first_start(h.id) as first_start,
          private.habit_today(h) as today
        from private.habits h
        cross join lateral private.habit_link_tracking(h.id, private.habit_today(h)) t
        where h.deleted_at is null and h.archived_at is null
          and ((v_home_id is null and h.owner_home_id is null and h.owner_user_id = v_owner)
            or (v_home_id is not null and h.owner_home_id = v_home_id))
          and private.habit_may(h, v_user_id, 'manage') and t.id is not null
          and private.goal_link_target_compatible(t.unit, t.unit_kind, p_goal_id, p_series_id)
          and not exists (select 1 from private.goal_habit_links l where l.habit_id = h.id and l.state = 'active'
            and (l.goal_id = p_goal_id or l.series_id = p_series_id))) x), '[]'::jsonb));
  end
  $$;

-- Whether a habit unit is compatible with a goal's unit, or with every target of a series from the
-- one in effect for its current period on.
create function private.goal_link_target_compatible(p_unit text, p_unit_kind text, p_goal_id uuid, p_series_id uuid)
returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_goal private.goals;
    v_series private.goal_series;
    v_from date;
  begin
    if p_goal_id is not null then
      select * into v_goal from private.goals g where g.id = p_goal_id;
      return v_goal.kind = 'measurable' and private.goal_link_compatible(p_unit, p_unit_kind, v_goal.unit, v_goal.unit_kind);
    end if;
    select * into v_series from private.goal_series s where s.id = p_series_id;
    select b.period_start into v_from from private.goal_period_bounds(v_series.frequency, v_series.week_start,
      greatest((pg_catalog.now() at time zone private.goal_series_zone(v_series))::date, v_series.first_period_start)) b;
    v_from := (private.goal_series_target_for(v_series.id, v_from)).effective_from;
    return exists (select 1 from private.goal_series_targets t where t.series_id = v_series.id)
      and not exists (select 1 from private.goal_series_targets t
        where t.series_id = v_series.id and t.effective_from >= coalesce(v_from, v_series.first_period_start)
          and not private.goal_link_compatible(p_unit, p_unit_kind, t.unit, t.unit_kind));
  end
  $$;

-- Impact -------------------------------------------------------------------------------------------------

-- What a link change does to each goal it touches. p_mode 'set': the link's rows become those of
-- p_starts_on (no link yet: p_link_id null); 'remove': its rows leave; 'keep': its rows become manual
-- adjustments (totals unchanged). Answers the amounts before and after, the days that would not count
-- (incompatible units), and one entry per goal: a one-off goal always, a series' period running now
-- always, any other period whose amount changes (or, keeping, has one).
create function private.goal_link_impact(
  p_link_id uuid, p_habit_id uuid, p_starts_on date, p_goal_id uuid, p_series_id uuid, p_mode text
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_current uuid;
    v_series private.goal_series;
    v_today date;
    v_goals jsonb;
    v_before numeric;
    v_after numeric;
    v_uncounted integer;
  begin
    if p_series_id is not null then
      select * into v_series from private.goal_series s where s.id = p_series_id;
      v_today := (pg_catalog.now() at time zone private.goal_series_zone(v_series))::date;
      select g.id into v_current from private.goals g
        where g.series_id = p_series_id and v_today between g.period_start and g.period_end
          and not private.goal_hidden(g);
    end if;
    with cur as (
      select d.goal_id, sum(d.quantity) filter (where d.counted) as q from private.goal_link_days d
        join private.goals g on g.id = d.goal_id
      where p_link_id is not null and d.link_id = p_link_id and (p_mode <> 'set' or private.goal_link_syncable(g))
      group by d.goal_id
    ), nxt as (
      select r.goal_id, sum(r.quantity) filter (where r.counted) as q, count(*) filter (where not r.counted) as bad
      from private.goal_link_rows(p_habit_id, p_starts_on, p_goal_id, p_series_id) r
      where p_mode = 'set' and p_habit_id is not null
      group by r.goal_id
    ), ids as (
      select cur.goal_id from cur union select nxt.goal_id from nxt
      union select p_goal_id where p_goal_id is not null
      union select v_current where v_current is not null
    ), per_goal as (
      select g.*, coalesce(cur.q, 0) as before_q,
        case when p_mode = 'set' then coalesce(nxt.q, 0) else 0 end as after_q,
        coalesce(nxt.bad, 0) as bad, private.goal_total(g) as total
      from ids join private.goals g on g.id = ids.goal_id
      left join cur on cur.goal_id = g.id left join nxt on nxt.goal_id = g.id
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'goalId', r.id, 'title', r.title, 'periodStart', r.period_start, 'periodEnd', r.period_end,
        'ended', private.goal_period_ended((select g from private.goals g where g.id = r.id)),
        'target', r.target, 'unit', r.unit, 'unitKind', r.unit_kind,
        'linkedBefore', r.before_q, 'linkedAfter', r.after_q,
        'totalBefore', r.total,
        'totalAfter', case when p_mode = 'keep' then r.total else r.total - r.before_q + r.after_q end,
        'reachedBefore', r.total >= r.target,
        'reachedAfter', case when p_mode = 'keep' then r.total else r.total - r.before_q + r.after_q end >= r.target,
        'achieved', r.achieved_at is not null,
        'outcomeBefore', r.outcome,
        'syncable', private.goal_link_syncable((select g from private.goals g where g.id = r.id)),
        'uncountedDays', r.bad)
        order by r.period_start nulls first, r.id)
      filter (where r.id = p_goal_id or r.id = v_current or r.before_q <> r.after_q or (p_mode = 'keep' and r.before_q <> 0)),
        '[]'::jsonb),
      coalesce(sum(r.before_q), 0), coalesce(sum(r.after_q), 0), coalesce(sum(r.bad), 0)
      into v_goals, v_before, v_after, v_uncounted
      from per_goal r;
    return pg_catalog.jsonb_build_object('amountBefore', v_before, 'amountAfter', v_after,
      'uncountedDays', v_uncounted, 'goals', v_goals);
  end
  $$;

-- The common header of a link preview: the habit, the destination, the start and the units.
create function private.goal_link_preview_json(
  p_habit private.habits, p_goal private.goals, p_series private.goal_series, p_starts_on date
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := private.habit_today(p_habit);
    v_tracking private.habit_tracking := private.habit_link_tracking(p_habit.id, v_today);
    v_target private.goal_series_targets;
  begin
    if p_series.id is not null then
      v_target := private.goal_series_target_for(p_series.id, (select b.period_start from private.goal_period_bounds(
        p_series.frequency, p_series.week_start, greatest((pg_catalog.now() at time zone
          private.goal_series_zone(p_series))::date, p_series.first_period_start)) b));
    end if;
    return pg_catalog.jsonb_build_object(
      'habit', pg_catalog.jsonb_build_object('id', p_habit.id, 'name', p_habit.name, 'unit', v_tracking.unit,
        'unitKind', v_tracking.unit_kind, 'firstStart', private.habit_first_start(p_habit.id), 'today', v_today),
      'destination', case when p_series.id is not null
        then pg_catalog.jsonb_build_object('kind', 'series', 'id', p_series.id, 'title', p_series.title,
          'frequency', p_series.frequency, 'unit', v_target.unit, 'unitKind', v_target.unit_kind,
          'target', v_target.target)
        else pg_catalog.jsonb_build_object('kind', 'goal', 'id', p_goal.id, 'title', p_goal.title,
          'unit', p_goal.unit, 'unitKind', p_goal.unit_kind, 'target', p_goal.target) end,
      'startsOn', p_starts_on,
      'until', v_today);
  end
  $$;

-- Writing helpers ----------------------------------------------------------------------------------------

-- Locks a link's destination (the series and then its periods, or the goal). The habit is locked first
-- by the caller.
create function private.goal_link_lock_destination(p_goal_id uuid, p_series_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_series_id is not null then
      perform 1 from private.goal_series s where s.id = p_series_id for update;
      perform 1 from private.goals g where g.series_id = p_series_id order by g.id for update of g;
    else
      perform 1 from private.goals g where g.id = p_goal_id for update;
    end if;
  end
  $$;

-- Records a link change on every goal it touched (a one-off goal always; periods whose amount changed)
-- and on the series. Ids, dates and numbers only.
create function private.goal_link_record(
  p_link private.goal_habit_links, p_kind text, p_actor uuid, p_impact jsonb, p_details jsonb,
  p_entries jsonb default '{}'::jsonb
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal jsonb;
    v_series private.goal_series;
    v_goal_row private.goals;
  begin
    for v_goal in select * from pg_catalog.jsonb_array_elements(p_impact -> 'goals') loop
      if p_link.goal_id is not null or (v_goal ->> 'linkedBefore')::numeric <> (v_goal ->> 'linkedAfter')::numeric
         or p_entries ? (v_goal ->> 'goalId') then
        perform private.goal_event((v_goal ->> 'goalId')::uuid, p_kind, p_actor,
          (p_entries ->> (v_goal ->> 'goalId'))::uuid,
          p_details || pg_catalog.jsonb_build_object('linkedBefore', v_goal -> 'linkedBefore',
            'linkedAfter', v_goal -> 'linkedAfter', 'totalBefore', v_goal -> 'totalBefore',
            'totalAfter', v_goal -> 'totalAfter'));
      end if;
    end loop;
    if p_link.series_id is not null then
      select * into v_series from private.goal_series s where s.id = p_link.series_id;
      perform private.goal_series_event(v_series.id, p_kind, p_actor, p_details);
      perform private.audit_goal_series('goal_series.' || p_kind, v_series, pg_catalog.jsonb_build_object('linkId', p_link.id));
    else
      select * into v_goal_row from private.goals g where g.id = p_link.goal_id;
      perform private.audit_goal('goal.' || p_kind, v_goal_row, pg_catalog.jsonb_build_object('linkId', p_link.id));
    end if;
  end
  $$;

-- Writing ------------------------------------------------------------------------------------------------

-- Links a numeric habit to a measurable goal or series (exactly one), counting from p_start: 'today'
-- (the habit's today, including what was entered earlier today), 'date' (p_start_date, from the habit's
-- first start date up to today) or 'beginning' (the habit's first start date). Needs manage permission
-- on both. p_dry_run answers the preview; confirming needs the revision of the goal or series and the
-- amount the preview showed, and answers 'stale' with a new preview when either changed. A retry with
-- the same id answers 'exists'. Outcomes: 'preview', 'created', 'exists', 'id_taken', 'stale',
-- 'already_linked', 'incompatible_unit', 'not_numeric', 'other_context', 'invalid_start',
-- 'series_period', 'not_measurable', 'archived', 'habit_archived', 'stopped', 'too_many', 'not_found',
-- 'not_permitted'. 22023 for invalid fields.
create function public.create_goal_link(
  p_id uuid, p_habit_id uuid, p_goal_id uuid default null, p_series_id uuid default null,
  p_start text default 'today', p_start_date date default null, p_dry_run boolean default false,
  p_expected_revision integer default null, p_expected_amount numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.goal_habit_links;
    v_habit private.habits;
    v_goal private.goals;
    v_series private.goal_series;
    v_link private.goal_habit_links;
    v_tracking private.habit_tracking;
    v_today date;
    v_first date;
    v_starts date;
    v_revision integer;
    v_impact jsonb;
    v_home_id uuid;
    v_owner uuid;
  begin
    if p_id is null or p_habit_id is null or num_nonnulls(p_goal_id, p_series_id) <> 1 or p_dry_run is null
       or p_start is null or p_start not in ('today', 'date', 'beginning')
       or (p_start = 'date') <> (p_start_date is not null)
       or (not p_dry_run and (p_expected_revision is null or p_expected_amount is null)) then
      raise exception 'invalid link' using errcode = '22023';
    end if;
    select * into v_existing from private.goal_habit_links l where l.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by = v_user_id and v_existing.habit_id is not distinct from p_habit_id
         and v_existing.goal_id is not distinct from p_goal_id and v_existing.series_id is not distinct from p_series_id then
        return pg_catalog.jsonb_build_object('outcome', 'exists', 'link', private.goal_link_json(v_existing, v_user_id));
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    -- Lock order: the habit, then the series and its periods, or the goal.
    v_habit := private.habit_lock(p_habit_id, v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if p_series_id is not null then
      v_series := private.goal_series_lock(p_series_id, v_user_id);
      if v_series.id is null then
        return pg_catalog.jsonb_build_object('outcome', 'not_found');
      end if;
      perform private.goal_link_lock_destination(null, v_series.id);
      v_home_id := v_series.owner_home_id;
      v_owner := v_series.owner_user_id;
    else
      v_goal := private.goal_lock(p_goal_id, v_user_id);
      if v_goal.id is null then
        return pg_catalog.jsonb_build_object('outcome', 'not_found');
      end if;
      v_home_id := v_goal.owner_home_id;
      v_owner := v_goal.owner_user_id;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage')
       or (v_series.id is not null and private.goal_series_role(v_series, v_user_id) is distinct from 'manage')
       or (v_goal.id is not null and not private.goal_may(v_goal, v_user_id, 'manage')) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_habit.owner_home_id is distinct from v_home_id
       or (v_home_id is null and v_habit.owner_user_id is distinct from v_owner) then
      return pg_catalog.jsonb_build_object('outcome', 'other_context');
    end if;
    if v_goal.id is not null and v_goal.series_id is not null then
      return pg_catalog.jsonb_build_object('outcome', 'series_period');
    end if;
    if coalesce(v_series.kind, v_goal.kind) <> 'measurable' then
      return pg_catalog.jsonb_build_object('outcome', 'not_measurable');
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    if v_series.state = 'stopped' then
      return pg_catalog.jsonb_build_object('outcome', 'stopped');
    end if;
    if v_habit.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'habit_archived');
    end if;
    v_today := private.habit_today(v_habit);
    v_tracking := private.habit_link_tracking(v_habit.id, v_today);
    if v_tracking.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_numeric');
    end if;
    if not private.goal_link_target_compatible(v_tracking.unit, v_tracking.unit_kind, p_goal_id, p_series_id) then
      return pg_catalog.jsonb_build_object('outcome', 'incompatible_unit');
    end if;
    if exists (select 1 from private.goal_habit_links l where l.habit_id = v_habit.id and l.state = 'active'
        and (l.goal_id = p_goal_id or l.series_id = p_series_id)) then
      return pg_catalog.jsonb_build_object('outcome', 'already_linked');
    end if;
    if (select count(*) from private.goal_habit_links l where l.habit_id = v_habit.id and l.state = 'active')
         >= private.goal_link_limit('per_habit')
       or (select count(*) from private.goal_habit_links l where l.state = 'active'
         and (l.goal_id = p_goal_id or l.series_id = p_series_id)) >= private.goal_link_limit('per_goal') then
      return pg_catalog.jsonb_build_object('outcome', 'too_many');
    end if;
    v_first := private.habit_first_start(v_habit.id);
    v_starts := case p_start when 'today' then v_today when 'beginning' then v_first else p_start_date end;
    if v_starts is null or (p_start = 'date' and (p_start_date < v_first or p_start_date > v_today)) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_start');
    end if;
    v_revision := coalesce(v_series.revision, v_goal.revision);
    v_impact := private.goal_link_preview_json(v_habit, v_goal, v_series, v_starts)
      || private.goal_link_impact(null, v_habit.id, v_starts, p_goal_id, p_series_id, 'set');
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_revision, 'impact', v_impact);
    end if;
    if p_expected_revision <> v_revision or p_expected_amount <> (v_impact ->> 'amountAfter')::numeric then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_revision, 'impact', v_impact);
    end if;
    insert into private.goal_habit_links (id, habit_id, goal_id, series_id, starts_on, created_by, updated_by)
      values (p_id, v_habit.id, p_goal_id, p_series_id, v_starts, v_user_id, v_user_id)
      on conflict (id) do nothing
      returning * into v_link;
    if v_link.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    perform private.goal_link_refresh(v_link.id);
    perform private.goal_link_record(v_link, 'link_created', v_user_id, v_impact,
      pg_catalog.jsonb_build_object('linkId', v_link.id, 'habitId', v_habit.id, 'startsOn', v_starts,
        'start', p_start));
    return pg_catalog.jsonb_build_object('outcome', 'created', 'link', private.goal_link_json(v_link, v_user_id),
      'impact', v_impact);
  end
  $$;

-- Changes the first counted day of an active link (same choices as creating it). Days before the new
-- start leave the goal, days from it count; ended periods recompute their outcome. Preview and
-- confirmation as for creating, with the link's revision. Outcomes: 'preview', 'saved', 'unchanged',
-- 'stale', 'invalid_start', 'source_unavailable' (the habit is archived, in the trash or gone),
-- 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.change_goal_link_start(
  p_id uuid, p_start text, p_start_date date default null, p_dry_run boolean default false,
  p_expected_revision integer default null, p_expected_amount numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_link private.goal_habit_links;
    v_habit private.habits;
    v_goal private.goals;
    v_series private.goal_series;
    v_today date;
    v_first date;
    v_starts date;
    v_impact jsonb;
  begin
    if p_id is null or p_dry_run is null or p_start is null or p_start not in ('today', 'date', 'beginning')
       or (p_start = 'date') <> (p_start_date is not null)
       or (not p_dry_run and (p_expected_revision is null or p_expected_amount is null)) then
      raise exception 'invalid link' using errcode = '22023';
    end if;
    select * into v_link from private.goal_habit_links l where l.id = p_id;
    if v_link.id is null or v_link.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if v_link.habit_id is null then
      return pg_catalog.jsonb_build_object('outcome', 'source_unavailable');
    end if;
    -- A habit in the trash cannot be locked through habit_lock; it cannot change either.
    v_habit := private.habit_lock(v_link.habit_id, v_user_id);
    if v_habit.id is null then
      if exists (select 1 from private.habits h where h.id = v_link.habit_id and private.habit_may(h, v_user_id, 'view')) then
        return pg_catalog.jsonb_build_object('outcome', 'source_unavailable');
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if v_link.series_id is not null then
      v_series := private.goal_series_lock(v_link.series_id, v_user_id);
    else
      v_goal := private.goal_lock(v_link.goal_id, v_user_id);
    end if;
    if v_series.id is null and v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    perform private.goal_link_lock_destination(v_link.goal_id, v_link.series_id);
    select * into v_link from private.goal_habit_links l where l.id = p_id;
    if v_link.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_link_manager(v_link, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_habit.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'source_unavailable');
    end if;
    v_today := private.habit_today(v_habit);
    v_first := private.habit_first_start(v_habit.id);
    v_starts := case p_start when 'today' then v_today when 'beginning' then v_first else p_start_date end;
    if v_starts is null or (p_start = 'date' and (p_start_date < v_first or p_start_date > v_today)) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_start');
    end if;
    v_impact := private.goal_link_preview_json(v_habit, v_goal, v_series, v_starts)
      || private.goal_link_impact(v_link.id, v_habit.id, v_starts, v_link.goal_id, v_link.series_id, 'set')
      || pg_catalog.jsonb_build_object('startsOnBefore', v_link.starts_on);
    if v_starts = v_link.starts_on then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_link.revision, 'impact', v_impact);
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_link.revision, 'impact', v_impact);
    end if;
    if p_expected_revision <> v_link.revision or p_expected_amount <> (v_impact ->> 'amountAfter')::numeric then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_link.revision, 'impact', v_impact);
    end if;
    update private.goal_habit_links l set starts_on = v_starts, revision = l.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where l.id = v_link.id returning * into v_link;
    perform private.goal_link_refresh(v_link.id);
    perform private.goal_link_record(v_link, 'link_changed', v_user_id, v_impact,
      pg_catalog.jsonb_build_object('linkId', v_link.id, 'habitId', v_link.habit_id,
        'startsOnBefore', v_impact -> 'startsOnBefore', 'startsOn', v_starts));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'link', private.goal_link_json(v_link, v_user_id),
      'impact', v_impact);
  end
  $$;

-- Removes an active link. 'keep': what it counts for each goal becomes one manual adjustment there
-- (source 'link'), so no total changes; 'remove': its amounts leave the goals, and ended periods
-- recompute their outcome. Either way later habit changes no longer reach the goal. Preview and
-- confirmation with the link's revision and the amount the preview showed. Outcomes: 'preview',
-- 'removed', 'stale', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.remove_goal_link(
  p_id uuid, p_mode text, p_dry_run boolean default false, p_expected_revision integer default null,
  p_expected_amount numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_link private.goal_habit_links;
    v_series private.goal_series;
    v_goal private.goals;
    v_impact jsonb;
    v_row record;
    v_entries jsonb := '{}'::jsonb;
    v_entry_id uuid;
    v_target private.goals;
  begin
    if p_id is null or p_dry_run is null or p_mode is null or p_mode not in ('keep', 'remove')
       or (not p_dry_run and (p_expected_revision is null or p_expected_amount is null)) then
      raise exception 'invalid link' using errcode = '22023';
    end if;
    select * into v_link from private.goal_habit_links l where l.id = p_id;
    if v_link.id is null or v_link.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    -- Lock order: the habit (when it still exists, even in the trash), then the destination.
    perform 1 from private.habits h where h.id = v_link.habit_id for update;
    if v_link.series_id is not null then
      v_series := private.goal_series_lock(v_link.series_id, v_user_id);
    else
      -- A goal in the trash keeps its links: it is restored or purged with them.
      v_goal := private.goal_lock(v_link.goal_id, v_user_id);
    end if;
    if v_series.id is null and v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    perform private.goal_link_lock_destination(v_link.goal_id, v_link.series_id);
    select * into v_link from private.goal_habit_links l where l.id = p_id;
    if v_link.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_link_manager(v_link, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_impact := private.goal_link_impact(v_link.id, null, null, v_link.goal_id, v_link.series_id, p_mode)
      || pg_catalog.jsonb_build_object('mode', p_mode, 'startsOn', v_link.starts_on,
        'habit', case when v_link.habit_id is not null then (select pg_catalog.jsonb_build_object('id', h.id, 'name', h.name)
          from private.habits h where h.id = v_link.habit_id) end,
        'source', private.goal_link_source_state(v_link));
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_link.revision, 'impact', v_impact);
    end if;
    if p_expected_revision <> v_link.revision or p_expected_amount <> (v_impact ->> 'amountBefore')::numeric then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_link.revision, 'impact', v_impact);
    end if;
    if p_mode = 'keep' then
      for v_row in select d.goal_id, sum(d.quantity) as q from private.goal_link_days d
          where d.link_id = v_link.id and d.counted group by d.goal_id having sum(d.quantity) <> 0 loop
        select * into v_target from private.goals g where g.id = v_row.goal_id;
        v_entry_id := gen_random_uuid();
        insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, contributed_by, source)
          values (v_entry_id, v_target.id, 'adjustment', v_row.q, v_target.unit, v_target.unit_kind, v_user_id, 'link');
        v_entries := v_entries || pg_catalog.jsonb_build_object(v_target.id::text, v_entry_id);
      end loop;
    end if;
    delete from private.goal_link_days d where d.link_id = v_link.id;
    update private.goal_habit_links l set state = 'removed', removal = p_mode, removed_at = pg_catalog.now(),
        removed_by = v_user_id, revision = l.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where l.id = v_link.id returning * into v_link;
    for v_row in select (x ->> 'goalId')::uuid as goal_id from pg_catalog.jsonb_array_elements(v_impact -> 'goals') x loop
      perform private.recheck_goal_outcome(v_row.goal_id, v_user_id);
    end loop;
    perform private.goal_link_record(v_link, 'link_removed', v_user_id, v_impact,
      pg_catalog.jsonb_build_object('linkId', v_link.id, 'habitId', v_link.habit_id, 'mode', p_mode,
        'amount', v_impact -> 'amountBefore'), v_entries);
    return pg_catalog.jsonb_build_object('outcome', 'removed', 'impact', v_impact);
  end
  $$;

-- S30 and S30b goal functions that now know about links ---------------------------------------------------

-- add_goal_entry (S30, S30b): a manager's "set total" never goes below what linked habits count
-- ('below_linked'), so the manual part stays 0 or more.
alter function public.add_goal_entry(uuid, uuid, text, numeric, text, text, numeric) rename to add_goal_entry_before_links;
revoke all on function public.add_goal_entry_before_links(uuid, uuid, text, numeric, text, text, numeric)
  from public, anon, authenticated;
alter function public.add_goal_entry_before_links(uuid, uuid, text, numeric, text, text, numeric) set schema private;

create function public.add_goal_entry(
  p_id uuid, p_goal_id uuid, p_mode text, p_quantity numeric, p_note text default null,
  p_source text default 'app', p_expected_total numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
  begin
    if p_mode = 'total' and p_goal_id is not null and p_quantity is not null and p_id is not null
       and not exists (select 1 from private.goal_entries e where e.id = p_id) then
      v_goal := private.goal_lock(p_goal_id, v_user_id);
      if v_goal.id is not null and v_goal.kind = 'measurable' and private.goal_may(v_goal, v_user_id, 'manage')
         and v_goal.archived_at is null and v_goal.achieved_at is null
         and p_expected_total is not distinct from private.goal_total(v_goal)
         and p_quantity < private.goal_linked_total(v_goal) then
        return pg_catalog.jsonb_build_object('outcome', 'below_linked', 'goal', private.goal_summary_json(v_goal, v_user_id));
      end if;
    end if;
    return private.add_goal_entry_before_links(p_id, p_goal_id, p_mode, p_quantity, p_note, p_source, p_expected_total);
  end
  $$;

-- update_goal_entry (S30, S30b): a correction that would take the manual part below 0 answers
-- 'negative_total', even when linked habits would keep the total above it.
alter function public.update_goal_entry(uuid, text, numeric, text) rename to update_goal_entry_before_links;
revoke all on function public.update_goal_entry_before_links(uuid, text, numeric, text) from public, anon, authenticated;
alter function public.update_goal_entry_before_links(uuid, text, numeric, text) set schema private;

create function public.update_goal_entry(
  p_id uuid, p_action text, p_quantity numeric default null, p_reason text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_entry private.goal_entries;
  begin
    if p_id is not null and p_action in ('reverse', 'amend') then
      v_goal := private.goal_lock((select e.goal_id from private.goal_entries e where e.id = p_id), v_user_id);
      if v_goal.id is not null and v_goal.archived_at is null then
        select * into v_entry from private.goal_entries e where e.id = p_id for update;
        if v_entry.status = 'active'
           and (private.goal_may(v_goal, v_user_id, 'manage')
             or (p_action = 'reverse' and v_entry.kind = 'contribution' and v_entry.contributed_by = v_user_id
               and private.goal_may(v_goal, v_user_id, 'contribute') and not private.goal_period_ended(v_goal)))
           and private.goal_linked_total(v_goal) > 0
           and private.goal_manual_total(v_goal) - v_entry.quantity + coalesce(p_quantity, 0) < 0 then
          return pg_catalog.jsonb_build_object('outcome', 'negative_total', 'goal', private.goal_summary_json(v_goal, v_user_id));
        end if;
      end if;
    end if;
    return private.update_goal_entry_before_links(p_id, p_action, p_quantity, p_reason);
  end
  $$;

-- change_goal_target (S30, S30b): a goal with active links keeps its unit ('linked_unit'); its target
-- may change, which leaves linked quantities as they are.
alter function public.change_goal_target(uuid, integer, numeric, text, text, boolean, boolean, boolean)
  rename to change_goal_target_before_links;
revoke all on function public.change_goal_target_before_links(uuid, integer, numeric, text, text, boolean, boolean, boolean)
  from public, anon, authenticated;
alter function public.change_goal_target_before_links(uuid, integer, numeric, text, text, boolean, boolean, boolean)
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
    if p_id is not null then
      v_goal := private.goal_lock(p_id, v_user_id);
      if v_goal.id is not null and v_goal.series_id is null and private.goal_may(v_goal, v_user_id, 'manage')
         and (p_unit is distinct from v_goal.unit or p_unit_kind is distinct from v_goal.unit_kind)
         and exists (select 1 from private.goal_habit_links l where l.goal_id = v_goal.id and l.state = 'active') then
        return pg_catalog.jsonb_build_object('outcome', 'linked_unit');
      end if;
    end if;
    return private.change_goal_target_before_links(p_id, p_expected_revision, p_target, p_unit, p_unit_kind,
      p_dry_run, p_confirm_unit, p_confirm_status);
  end
  $$;

-- change_goal_series_target (S30b): a series with active links keeps its unit ('linked_unit').
alter function public.change_goal_series_target(uuid, integer, date, numeric, text, text, boolean, boolean, boolean)
  rename to change_goal_series_target_before_links;
revoke all on function public.change_goal_series_target_before_links(uuid, integer, date, numeric, text, text, boolean, boolean, boolean)
  from public, anon, authenticated;
alter function public.change_goal_series_target_before_links(uuid, integer, date, numeric, text, text, boolean, boolean, boolean)
  set schema private;

create function public.change_goal_series_target(
  p_id uuid, p_expected_revision integer, p_effective_from date, p_target numeric, p_unit text,
  p_unit_kind text, p_dry_run boolean default false, p_confirm_unit boolean default false,
  p_confirm_status boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
    v_before private.goal_series_targets;
  begin
    if p_id is not null and p_effective_from is not null then
      v_series := private.goal_series_lock(p_id, v_user_id);
      if v_series.id is not null and private.goal_series_role(v_series, v_user_id) = 'manage'
         and exists (select 1 from private.goal_habit_links l where l.series_id = v_series.id and l.state = 'active') then
        v_before := private.goal_series_target_for(v_series.id, p_effective_from);
        if v_before.series_id is not null
           and (p_unit is distinct from v_before.unit or p_unit_kind is distinct from v_before.unit_kind) then
          return pg_catalog.jsonb_build_object('outcome', 'linked_unit');
        end if;
      end if;
    end if;
    return private.change_goal_series_target_before_links(p_id, p_expected_revision, p_effective_from, p_target,
      p_unit, p_unit_kind, p_dry_run, p_confirm_unit, p_confirm_status);
  end
  $$;

-- archive_goal (S30, S30b): an unarchived goal rebuilds its linked rows (nothing reached it while it was
-- archived).
alter function public.archive_goal(uuid, integer, boolean) rename to archive_goal_before_links;
revoke all on function public.archive_goal_before_links(uuid, integer, boolean) from public, anon, authenticated;
alter function public.archive_goal_before_links(uuid, integer, boolean) set schema private;

create function public.archive_goal(p_id uuid, p_expected_revision integer, p_archived boolean)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_outcome text;
    v_revision integer;
  begin
    select a.outcome, a.revision into v_outcome, v_revision
      from private.archive_goal_before_links(p_id, p_expected_revision, p_archived) a;
    if v_outcome = 'saved' and not p_archived then
      perform private.goal_links_refresh_goal(p_id);
    end if;
    return query select v_outcome, v_revision;
  end
  $$;

-- Trash: a restored goal or series rebuilds its linked rows.
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_goal_links;

create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_result integer := private.trash_item_restore_before_goal_links(p_entry);
  begin
    if p_entry.item_type = 'goal' then
      perform private.goal_links_refresh_goal(p_entry.subject_id);
    elsif p_entry.item_type = 'goal_series' then
      perform private.goal_links_refresh_series(p_entry.subject_id);
    end if;
    return v_result;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The goal link API and the wrapped goal functions: signed-in people only (every function rechecks
  -- the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_goal_links', 'get_goal_link_candidates', 'create_goal_link', 'change_goal_link_start',
      'remove_goal_link', 'add_goal_entry', 'update_goal_entry', 'change_goal_target',
      'change_goal_series_target', 'archive_goal'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%goal%' or p.proname like '%habit%' or p.proname = 'trash_item_restore'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
