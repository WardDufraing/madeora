-- S30: goals core (brief plans/steps/S30-brief.md; ADR 0038; spec "Confirmed measurable and
-- completion-based goals", "Confirmed collaborative Home goal contributions", "Confirmed completed goal
-- lifecycle and guided renewal", "Confirmed configurable goal deadline and overdue reminders",
-- "Confirmed interactive habit and goal dashboard widgets" (goal half)). Recurring goal series (S30b)
-- and habit-to-goal links (S30c) build on these tables.
--
-- A goal belongs to exactly one context: a person (their Personal space) or a Home. Nothing here is
-- exposed as a table; people use security-definer functions that run with their own session and
-- recheck the confirmed caller, their current membership and their access on every call. A Home the
-- caller is not in answers 42501 "not permitted" exactly like one that does not exist; a goal they may
-- not see answers 'not_found' exactly like a missing one. A personal goal is its owner's alone: no
-- Home role ever sees it or its entries.
--
-- Who may do what (defaults picked in the brief, owner may override). packages/domain/src/permissions/
-- goals.ts makes the same decisions:
-- - Personal goal: its owner, for everything.
-- - Home goal: every current member sees it, its contribution history and its achievements. Members
--   add contributions, reverse their own and mark a completion goal achieved, unless a goal manager set
--   the Home's goals to view only. Goal managers (the Owner and Administrators granted the new
--   delegable capability manageHomeGoals) also create and change goals, set the total, correct or
--   reverse anyone's entry, mark a measurable goal achieved, reopen goals and set that member access.
--
-- Progress is a ledger: a measurable goal's progress is the exact decimal sum of its active entries
-- (the initial value, contributions, and "set total" adjustments recorded as the signed difference).
-- Entries are never deleted: a correction amends or reverses one and is recorded with its before and
-- after values, so the total and its history always agree. Reaching the target never changes the
-- goal's state; only an explicit Mark achieved does, and every achievement is kept when a goal is
-- reopened. Every change takes the goal's row lock first, so concurrent contributions are decided one
-- at a time and none is lost or counted twice.

-- Audit subjects, the new capability, trash types, the reminder notification ---------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping',
    'manageHomeMeals', 'manageHomeHabits', 'manageHomeGoals'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping', 'meals', 'habits', 'goals'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit', 'goal'
  ));

-- Limits and value rules ---------------------------------------------------------------------------------

-- apps/web/src/goals/schema.ts and packages/domain/src/goals use the same numbers.
create function private.goal_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'title' then 80
    when 'description' then 500
    when 'note' then 280
    when 'reason' then 200
    when 'goals' then 100             -- goals per context that are not archived
    when 'page' then 50               -- history rows one read returns
    when 'query' then 80              -- search text
    when 'lead_days' then 90          -- an advance reminder at most this many days before the deadline
    when 'overdue_days' then 30       -- an overdue reminder at most this many days after it
    when 'late_minutes' then 30       -- a reminder more than this late is skipped
  end;
  $$;

-- A target, a contribution or an initial value: at most 1,000,000,000, at most three decimals, whole
-- for a discrete unit; strictly positive unless p_zero (an initial value or a total may be 0).
create function private.valid_goal_quantity(p_value numeric, p_discrete boolean, p_zero boolean)
returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_value <= 1000000000 and p_value = pg_catalog.round(p_value, 3)
    and (p_value > 0 or (p_zero and p_value = 0))
    and (not coalesce(p_discrete, false) or p_value = pg_catalog.trunc(p_value)), false);
  $$;

-- Whether a unit takes whole numbers only (the habit unit catalogue, S29).
create function private.goal_unit_discrete(p_unit text, p_kind text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce((select i.discrete from private.habit_unit_info(p_unit, p_kind) i), false);
  $$;

-- A goal's shape: a completion goal has no target or unit; a measurable goal a valid unit (a preset of
-- the habit unit catalogue or a custom label) and a valid target.
create function private.valid_goal_shape(p_kind text, p_target numeric, p_unit text, p_unit_kind text)
returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(case p_kind
    when 'completion' then p_target is null and p_unit is null and p_unit_kind is null
    when 'measurable' then private.valid_habit_unit(p_unit, p_unit_kind)
      and private.valid_goal_quantity(p_target, private.goal_unit_discrete(p_unit, p_unit_kind), false)
  end, false);
  $$;

-- Tables -------------------------------------------------------------------------------------------------

-- A Home's goal settings (a row exists once a manager changed them; none means the defaults).
create table private.goal_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  member_access text not null default 'contribute'
    constraint goal_settings_access_check check (member_access in ('contribute', 'view')),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table private.goals (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  kind text not null constraint goals_kind_check check (kind in ('completion', 'measurable')),
  title text not null,
  description text,
  -- A personal goal's own timezone (null for a Home goal, which uses the Home's).
  time_zone text,
  target numeric(13, 3),
  unit text,
  unit_kind text constraint goals_unit_kind_check check (unit_kind in ('preset', 'custom')),
  deadline date,
  -- The current achievement (its row in goal_achievements holds the history).
  achieved_at timestamptz,
  achieved_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  archived_by uuid references auth.users (id) on delete set null,
  -- Set while the goal is in the trash (S16).
  deleted_at timestamptz,
  -- The completed goal this one renews or follows up (Renew, Create a follow-up goal).
  renewed_from uuid references private.goals (id) on delete set null,
  revision integer not null default 1 constraint goals_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint goals_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint goals_title_check check (private.is_visible_name(title, 80)),
  constraint goals_description_check check (description is null or private.is_plain_text(description, 500)),
  constraint goals_zone_check check ((owner_home_id is null) = (time_zone is not null)
    and (time_zone is null or char_length(time_zone) <= 64)),
  constraint goals_shape_check check (private.valid_goal_shape(kind, target, unit, unit_kind))
);

create index goals_home_idx on private.goals (owner_home_id) where owner_home_id is not null;
create index goals_user_idx on private.goals (owner_user_id) where owner_user_id is not null;

-- The ledger of a measurable goal. quantity is signed: 'initial' (the progress the goal started with,
-- 0 or more), 'contribution' (an addition, positive), 'adjustment' (a manager's "set total", the
-- difference, never 0). Never deleted: a correction amends quantity (the first is kept in
-- original_quantity) or reverses the entry, and goal_entry_corrections records each one.
create table private.goal_entries (
  id uuid primary key,
  goal_id uuid not null references private.goals (id) on delete cascade,
  kind text not null constraint goal_entries_kind_check check (kind in ('initial', 'contribution', 'adjustment')),
  quantity numeric(16, 3) not null,
  original_quantity numeric(16, 3),
  -- The goal's unit when the entry was recorded: a later confirmed unit change never rewrites it.
  unit text not null,
  unit_kind text not null constraint goal_entries_unit_kind_check check (unit_kind in ('preset', 'custom')),
  note text constraint goal_entries_note_check check (note is null or private.is_plain_text(note, 280)),
  contributed_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  source text not null constraint goal_entries_source_check check (source in ('app', 'widget')),
  status text not null default 'active' constraint goal_entries_status_check check (status in ('active', 'reversed')),
  amended_by uuid references auth.users (id) on delete set null,
  amended_at timestamptz,
  reversed_by uuid references auth.users (id) on delete set null,
  reversed_at timestamptz,
  constraint goal_entries_quantity_check check (case kind
    when 'initial' then quantity >= 0
    when 'contribution' then quantity > 0
    else quantity <> 0 end),
  constraint goal_entries_reversed_check check ((status = 'reversed') = (reversed_at is not null))
);

create index goal_entries_goal_idx on private.goal_entries (goal_id, recorded_at desc, id desc);

create table private.goal_entry_corrections (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references private.goal_entries (id) on delete cascade,
  action text not null constraint goal_entry_corrections_action_check check (action in ('amend', 'reverse')),
  before_quantity numeric(16, 3) not null,
  after_quantity numeric(16, 3),
  actor uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  reason text constraint goal_entry_corrections_reason_check check (reason is null or private.is_plain_text(reason, 200)),
  constraint goal_entry_corrections_shape_check check ((action = 'amend') = (after_quantity is not null))
);

create index goal_entry_corrections_entry_idx on private.goal_entry_corrections (entry_id, at);

-- Every time a goal was marked achieved, with the total and target at that moment; a reopen marks the
-- row reopened and keeps it.
create table private.goal_achievements (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references private.goals (id) on delete cascade,
  achieved_at timestamptz not null default now(),
  achieved_by uuid references auth.users (id) on delete set null,
  total numeric(16, 3),
  target numeric(13, 3),
  -- The unit of total and target at that moment (null for a completion goal).
  unit text,
  unit_kind text constraint goal_achievements_unit_kind_check check (unit_kind in ('preset', 'custom')),
  reopened_at timestamptz,
  reopened_by uuid references auth.users (id) on delete set null,
  reopen_reason text constraint goal_achievements_reason_check
    check (reopen_reason is null or private.is_plain_text(reopen_reason, 200))
);

create unique index goal_achievements_one_open on private.goal_achievements (goal_id) where reopened_at is null;
create index goal_achievements_goal_idx on private.goal_achievements (goal_id, achieved_at desc);

-- The goal's deadline reminders (off by default; no row = never set): an advance reminder lead_days
-- before the deadline and/or an overdue reminder overdue_days after the day after it, at at_time in
-- the goal's timezone.
create table private.goal_reminders (
  goal_id uuid primary key references private.goals (id) on delete cascade,
  enabled boolean not null,
  lead_days smallint constraint goal_reminders_lead_check check (lead_days between 1 and 90),
  overdue_days smallint constraint goal_reminders_overdue_check check (overdue_days between 0 and 30),
  at_time time not null constraint goal_reminders_time_check check (at_time = date_trunc('minute', at_time)),
  revision integer not null default 1 constraint goal_reminders_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint goal_reminders_some_check check (lead_days is not null or overdue_days is not null)
);

-- A Home member who turned a Home goal's reminders off for themselves.
create table private.goal_reminder_optouts (
  goal_id uuid not null references private.goals (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (goal_id, user_id)
);

-- The goal's history: ids, codes and numbers only (never note text or titles).
create table private.goal_events (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references private.goals (id) on delete cascade,
  kind text not null constraint goal_events_kind_check check (kind in (
    'created', 'edited', 'target_changed', 'adjusted', 'corrected', 'achieved', 'reopened',
    'archived', 'unarchived', 'restored', 'reminders_changed'
  )),
  actor uuid references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  entry_id uuid,
  details jsonb not null default '{}'
);

create index goal_events_goal_idx on private.goal_events (goal_id, at desc, id desc);

alter table private.goal_settings enable row level security;
alter table private.goals enable row level security;
alter table private.goal_entries enable row level security;
alter table private.goal_entry_corrections enable row level security;
alter table private.goal_achievements enable row level security;
alter table private.goal_reminders enable row level security;
alter table private.goal_reminder_optouts enable row level security;
alter table private.goal_events enable row level security;
revoke all on private.goal_settings, private.goals, private.goal_entries, private.goal_entry_corrections,
  private.goal_achievements, private.goal_reminders, private.goal_reminder_optouts, private.goal_events
  from public, anon, authenticated;

-- Permission helpers (the engine in packages/domain mirrors these) --------------------------------------

-- What p_user_id may do with a context's goals now: 'manage' (the Personal space's owner; a Home's
-- Owner and Administrators granted manageHomeGoals), 'contribute' or 'view' (other current members, by
-- the Home's member access), or null (not a member).
create function private.goal_access(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then null
    when p_home_id is null then 'manage'
    when not private.is_home_member(p_home_id, p_user_id) then null
    when private.has_home_capability(p_home_id, p_user_id, 'manageHomeGoals') then 'manage'
    else coalesce((select s.member_access from private.goal_settings s where s.home_id = p_home_id), 'contribute')
  end;
  $$;

-- The caller's access to one goal: a personal goal is its owner's only.
create function private.goal_role(p_goal private.goals, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_goal.id is null or p_user_id is null then null
    when p_goal.owner_home_id is null then case when p_goal.owner_user_id = p_user_id then 'manage' end
    else private.goal_access(p_goal.owner_home_id, p_user_id)
  end;
  $$;

create function private.goal_may(p_goal private.goals, p_user_id uuid, p_need text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    case private.goal_role(p_goal, p_user_id) when 'manage' then 3 when 'contribute' then 2 when 'view' then 1 else 0 end
    >= case p_need when 'manage' then 3 when 'contribute' then 2 else 1 end,
    false);
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_goal_context(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- A goal the caller may see (not in the trash), or a null row.
create function private.goal_for(p_goal_id uuid, p_user_id uuid) returns private.goals
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_goal private.goals;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id and g.deleted_at is null;
    if v_goal.id is null or not private.goal_may(v_goal, p_user_id, 'view') then
      return null;
    end if;
    return v_goal;
  end
  $$;

-- The same, locked for a change (the goal lock: every change and entry of a goal takes it).
create function private.goal_lock(p_goal_id uuid, p_user_id uuid) returns private.goals
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id and g.deleted_at is null for update;
    if v_goal.id is null or not private.goal_may(v_goal, p_user_id, 'view') then
      return null;
    end if;
    return v_goal;
  end
  $$;

create function private.goal_zone(p_goal private.goals) returns text
  language sql stable security definer set search_path = '' as $$
  select case when p_goal.owner_home_id is null then p_goal.time_zone
    else (select h.timezone from public.homes h where h.id = p_goal.owner_home_id) end;
  $$;

create function private.goal_today(p_goal private.goals) returns date
  language sql stable security definer set search_path = '' as $$
  select (pg_catalog.now() at time zone private.goal_zone(p_goal))::date;
  $$;

-- Ids, codes and numbers only. Home goals only (a personal goal is nobody else's business).
create function private.audit_goal(
  p_action text, p_goal private.goals, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  select case when p_goal.owner_home_id is not null
    then private.audit(p_action, p_goal.owner_home_id, 'goal', p_goal.id, p_details) end;
  $$;

create function private.goal_event(
  p_goal_id uuid, p_kind text, p_actor uuid, p_entry_id uuid default null, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.goal_events (goal_id, kind, actor, entry_id, details)
    values (p_goal_id, p_kind, p_actor, p_entry_id, coalesce(p_details, '{}'::jsonb));
  $$;

-- A person as a goal answer may name them: their membership id in the Home (null for a departed member
-- or a deleted account); for a personal goal, nothing.
create function private.goal_person(p_goal private.goals, p_user_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
  select case when p_goal.owner_home_id is not null and p_user_id is not null
    then private.member_ref(p_goal.owner_home_id, p_user_id) end;
  $$;

-- Progress and state ------------------------------------------------------------------------------------

-- The exact sum of a measurable goal's active entries (null for a completion goal).
create function private.goal_total(p_goal private.goals) returns numeric
  language sql stable security definer set search_path = '' as $$
  select case when p_goal.kind = 'measurable' then coalesce(
    (select sum(e.quantity) from private.goal_entries e where e.goal_id = p_goal.id and e.status = 'active'), 0) end;
  $$;

-- 'archived', 'achieved' (the Completed section), 'overdue' (deadline before today, not achieved; a
-- label, never a failure) or 'active'.
create function private.goal_status(p_goal private.goals, p_today date) returns text
  language sql stable set search_path = '' as $$
  select case
    when p_goal.archived_at is not null then 'archived'
    when p_goal.achieved_at is not null then 'achieved'
    when p_goal.deadline is not null and p_goal.deadline < p_today then 'overdue'
    else 'active'
  end;
  $$;

-- Reminder moments --------------------------------------------------------------------------------------

-- The reminder moments of a deadline: 'lead' p_lead days before it, 'overdue' p_overdue days after the
-- day after it, each at p_time in the goal's timezone (PostgreSQL resolves a time a daylight-saving
-- change skips or repeats; the preview shows the instant it chose).
create function private.goal_reminder_moments(
  p_goal private.goals, p_deadline date, p_lead smallint, p_overdue smallint, p_time time
) returns table (kind text, at timestamptz)
  language sql stable security definer set search_path = '' as $$
  select x.kind, x.at from (
    select 'lead' as kind, ((p_deadline - p_lead) + p_time) at time zone private.goal_zone(p_goal) as at
      where p_deadline is not null and p_lead is not null and p_time is not null
    union all
    select 'overdue', ((p_deadline + 1 + p_overdue) + p_time) at time zone private.goal_zone(p_goal)
      where p_deadline is not null and p_overdue is not null and p_time is not null
  ) x order by x.at;
  $$;

create function private.goal_moments_json(
  p_goal private.goals, p_deadline date, p_lead smallint, p_overdue smallint, p_time time
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', m.kind,
      'at', private.habit_utc_text(m.at), 'passed', m.at <= pg_catalog.now()) order by m.at), '[]'::jsonb)
  from private.goal_reminder_moments(p_goal, p_deadline, p_lead, p_overdue, p_time) m;
  $$;

-- Queues the goal-reminder job for each moment still ahead, when the reminder is on and the goal can
-- still need it (a deadline, not achieved, archived or in the trash). A moment already passed is never
-- queued (no retroactive reminder). Idempotent: the key names the goal, the reminder revision and the
-- moment kind, so a retry queues it once; a job of an earlier revision finds a newer one and does
-- nothing.
create function private.schedule_goal_reminders(p_goal_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
    v_reminder private.goal_reminders;
    v_moment record;
  begin
    select * into v_goal from private.goals g where g.id = p_goal_id;
    select * into v_reminder from private.goal_reminders r where r.goal_id = p_goal_id;
    if v_goal.id is null or v_goal.deleted_at is not null or v_goal.archived_at is not null
       or v_goal.achieved_at is not null or v_goal.deadline is null
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

-- After a change that moves or revives the moments (deadline, timezone, reopen, unarchive, restore): a
-- new reminder revision retires every queued job, then the moments still ahead are queued again. A
-- reminder that is off stays off.
create function private.reschedule_goal_reminders(p_goal_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.goal_reminders r set revision = r.revision + 1 where r.goal_id = p_goal_id and r.enabled;
    perform private.schedule_goal_reminders(p_goal_id);
  end
  $$;

-- Who a goal's reminder goes to now: a personal goal's owner; for a Home goal every current member (all
-- of them may see it) who has not turned that goal's reminders off for themselves.
create function private.goal_reminder_recipients(p_goal private.goals) returns setof uuid
  language sql stable security definer set search_path = '' as $$
  select p_goal.owner_user_id where p_goal.owner_home_id is null
  union all
  select m.user_id from public.home_memberships m
  where p_goal.owner_home_id is not null and m.home_id = p_goal.owner_home_id
    and private.goal_may(p_goal, m.user_id, 'view')
    and not exists (select 1 from private.goal_reminder_optouts o where o.goal_id = p_goal.id and o.user_id = m.user_id);
  $$;

-- Answers ------------------------------------------------------------------------------------------------

-- A goal as the viewer sees it: its definition, progress, state and what the viewer may do now.
create function private.goal_summary_json(p_goal private.goals, p_viewer uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_today date := private.goal_today(p_goal);
    v_total numeric := private.goal_total(p_goal);
    v_role text := private.goal_role(p_goal, p_viewer);
    v_reached boolean := p_goal.kind = 'measurable' and v_total >= p_goal.target;
    v_open boolean := p_goal.archived_at is null and p_goal.achieved_at is null;
    v_renewed private.goals;
  begin
    if p_goal.renewed_from is not null then
      v_renewed := private.goal_for(p_goal.renewed_from, p_viewer);
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
      'actions', pg_catalog.jsonb_build_object(
        'contribute', v_open and p_goal.kind = 'measurable' and private.goal_may(p_goal, p_viewer, 'contribute'),
        'setTotal', v_open and p_goal.kind = 'measurable' and v_role = 'manage',
        'achieve', v_open and case when p_goal.kind = 'completion' then private.goal_may(p_goal, p_viewer, 'contribute')
          else v_role = 'manage' and v_reached end,
        'reopen', p_goal.archived_at is null and p_goal.achieved_at is not null and v_role = 'manage',
        'manage', v_role = 'manage'));
  end
  $$;

-- An entry as the viewer sees it, with its corrections and what the viewer may do with it: 'correct'
-- (goal managers: amend or reverse), 'reverse' (the contributor's own contribution) or null.
create function private.goal_entry_json(p_entry private.goal_entries, p_goal private.goals, p_viewer uuid)
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
      when p_entry.kind = 'contribution' and p_entry.contributed_by = p_viewer
        and private.goal_may(p_goal, p_viewer, 'contribute') then 'reverse'
    end);
  $$;

-- Reading -----------------------------------------------------------------------------------------------

-- The goals of a context (the caller's Personal space, or a Home they are in): 'active' (active and
-- overdue), 'completed' (achieved) or 'archived', optionally matching a search by title; with the counts
-- of every section, the caller's access and the Home's member access. 42501 for a Home the caller is not
-- in; 22023 for an unknown view.
create function public.get_goals(p_home_id uuid default null, p_view text default 'active', p_query text default null)
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
      select x.id, x.title, x.achieved_at, x.deadline,
        private.goal_status(x, private.goal_today(x)) as status
      from private.goals x
      where x.deleted_at is null
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
        where case p_view when 'archived' then g.status = 'archived' when 'completed' then g.status = 'achieved'
            else g.status in ('active', 'overdue') end
          and (v_query is null or pg_catalog.strpos(pg_catalog.lower(g.title), pg_catalog.lower(v_query)) > 0)),
        '[]'::jsonb),
      'counts', pg_catalog.jsonb_build_object(
        'active', (select count(*) from g where g.status in ('active', 'overdue')),
        'completed', (select count(*) from g where g.status = 'achieved'),
        'archived', (select count(*) from g where g.status = 'archived')))
    into v_rows;
    return v_rows || pg_catalog.jsonb_build_object(
      'access', private.goal_access(p_home_id, v_user_id),
      'memberAccess', case when p_home_id is not null then coalesce(
        (select s.member_access from private.goal_settings s where s.home_id = p_home_id), 'contribute') end,
      'timeZone', case when p_home_id is not null then (select h.timezone from public.homes h where h.id = p_home_id) end);
  end
  $$;

-- One goal with everything its page shows, or null when the caller may not see it: the summary, the
-- achievements (newest first), the reminder with its moments and the number of entries.
create function public.get_goal(p_goal_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals := private.goal_for(p_goal_id, v_user_id);
    v_reminder private.goal_reminders;
  begin
    if v_goal.id is null then
      return null;
    end if;
    select * into v_reminder from private.goal_reminders r where r.goal_id = v_goal.id;
    return private.goal_summary_json(v_goal, v_user_id) || pg_catalog.jsonb_build_object(
      'achievements', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', a.id, 'achievedAt', a.achieved_at, 'by', private.goal_person(v_goal, a.achieved_by),
          'mine', coalesce(a.achieved_by = v_user_id, false),
          'total', a.total, 'target', a.target, 'unit', a.unit, 'unitKind', a.unit_kind,
          'reopenedAt', a.reopened_at,
          'reopenedBy', private.goal_person(v_goal, a.reopened_by),
          'reopenedByMe', coalesce(a.reopened_by = v_user_id, false), 'reason', a.reopen_reason)
          order by a.achieved_at desc, a.id)
        from private.goal_achievements a where a.goal_id = v_goal.id), '[]'::jsonb),
      'reminder', case when v_reminder.goal_id is not null then pg_catalog.jsonb_build_object(
        'enabled', v_reminder.enabled, 'leadDays', v_reminder.lead_days, 'overdueDays', v_reminder.overdue_days,
        'atTime', pg_catalog.to_char(v_reminder.at_time, 'HH24:MI'), 'revision', v_reminder.revision,
        'moments', case when v_reminder.enabled then private.goal_moments_json(v_goal, v_goal.deadline,
          v_reminder.lead_days, v_reminder.overdue_days, v_reminder.at_time) else '[]'::jsonb end) end,
      'entryCount', (select count(*) from private.goal_entries e where e.goal_id = v_goal.id));
  end
  $$;

-- A page of a goal's entries (newest first) after the entry p_before (none: the newest). Every viewer
-- of the goal sees who added what and when (brief default 8); hasMore: older entries exist. Null when
-- the caller may not see the goal; 22023 for a cursor that is not one of its entries.
create function public.get_goal_entries(p_goal_id uuid, p_before uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals := private.goal_for(p_goal_id, v_user_id);
    v_cursor private.goal_entries;
    v_rows jsonb;
  begin
    if v_goal.id is null then
      return null;
    end if;
    if p_before is not null then
      select * into v_cursor from private.goal_entries e where e.id = p_before and e.goal_id = v_goal.id;
      if v_cursor.id is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;
    select coalesce(pg_catalog.jsonb_agg(private.goal_entry_json(x, v_goal, v_user_id) order by x.recorded_at desc, x.id desc),
        '[]'::jsonb)
      into v_rows
      from (select * from private.goal_entries e
        where e.goal_id = v_goal.id
          and (v_cursor.id is null or (e.recorded_at, e.id) < (v_cursor.recorded_at, v_cursor.id))
        order by e.recorded_at desc, e.id desc limit private.goal_limit('page') + 1) x;
    return pg_catalog.jsonb_build_object(
      'entries', (select coalesce(pg_catalog.jsonb_agg(v order by o), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(v_rows) with ordinality as t (v, o) where o <= private.goal_limit('page')),
      'hasMore', pg_catalog.jsonb_array_length(v_rows) > private.goal_limit('page'));
  end
  $$;

-- A page of a goal's history (newest first) after the event p_before. Null when the caller may not see
-- the goal; 22023 for a cursor that is not one of its events.
create function public.get_goal_events(p_goal_id uuid, p_before uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals := private.goal_for(p_goal_id, v_user_id);
    v_cursor private.goal_events;
    v_rows jsonb;
  begin
    if v_goal.id is null then
      return null;
    end if;
    if p_before is not null then
      select * into v_cursor from private.goal_events e where e.id = p_before and e.goal_id = v_goal.id;
      if v_cursor.id is null then
        raise exception 'invalid cursor' using errcode = '22023';
      end if;
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', x.id, 'kind', x.kind,
        'by', private.goal_person(v_goal, x.actor), 'mine', coalesce(x.actor = v_user_id, false),
        'at', x.at, 'entryId', x.entry_id, 'details', x.details) order by x.at desc, x.id desc), '[]'::jsonb)
      into v_rows
      from (select * from private.goal_events e
        where e.goal_id = v_goal.id
          and (v_cursor.id is null or (e.at, e.id) < (v_cursor.at, v_cursor.id))
        order by e.at desc, e.id desc limit private.goal_limit('page') + 1) x;
    return pg_catalog.jsonb_build_object(
      'events', (select coalesce(pg_catalog.jsonb_agg(v order by o), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(v_rows) with ordinality as t (v, o) where o <= private.goal_limit('page')),
      'hasMore', pg_catalog.jsonb_array_length(v_rows) > private.goal_limit('page'));
  end
  $$;

-- The titles of goals named in the caller's notifications, for those the caller may still see.
create function public.goal_notice_names(p_goal_ids uuid[])
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
      where g.id = any (p_goal_ids) and g.deleted_at is null and private.goal_may(g, v_user_id, 'view');
  end
  $$;

-- Creating and changing goals ------------------------------------------------------------------------------

-- Creates a goal (a personal goal; a Home goal: goal managers). A measurable goal needs a target and a
-- unit and starts with p_initial (default 0) as its first ledger entry. p_deadline: today or later (in
-- the goal's timezone). p_time_zone: a personal goal's timezone (the app passes the person's effective
-- one); ignored for a Home goal. p_renewed_from: a goal the caller may see that this one renews.
-- Outcomes: 'created', 'exists' (a retry of the caller's own create), 'id_taken', 'invalid_dates',
-- 'too_many', 'not_permitted'. 42501 for a Home the caller is not in; 22023 for invalid fields.
create function public.create_goal(
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
        where g.deleted_at is null and g.archived_at is null
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

-- Edits a goal's title, description, deadline (null: none) and (personal goals) timezone, from the
-- revision the caller saw (goal managers). A changed deadline must be today or later; it retires the
-- queued reminders and queues the new moments. Removing the deadline turns its reminders off. Outcomes:
-- 'saved', 'unchanged', 'conflict', 'invalid_dates', 'not_found', 'not_permitted'. 22023 for invalid
-- fields.
create function public.update_goal(
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

-- Changes a measurable goal's target and unit (goal managers), from the revision the caller saw. The
-- existing entries are never converted: a unit change on a goal with progress needs p_confirm_unit. On
-- an achieved goal whose total is below the new target the achievement is reopened (kept in its
-- history) only with p_confirm_status. p_dry_run answers the impact without saving. Outcomes:
-- 'preview', 'saved', 'unchanged', 'confirm_unit', 'confirm_status', 'conflict', 'not_measurable',
-- 'archived', 'not_found', 'not_permitted', each with the impact where it explains it. 22023 for an
-- invalid target or unit.
create function public.change_goal_target(
  p_id uuid, p_expected_revision integer, p_target numeric, p_unit text, p_unit_kind text,
  p_dry_run boolean default false, p_confirm_unit boolean default false, p_confirm_status boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_total numeric;
    v_unit_changed boolean;
    v_reopens boolean;
    v_impact jsonb;
    v_before numeric;
    v_unit_before text;
    v_unit_kind_before text;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null or p_confirm_unit is null
       or p_confirm_status is null or not private.valid_goal_shape('measurable', p_target, p_unit, p_unit_kind) then
      raise exception 'invalid target' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_may(v_goal, v_user_id, 'manage') then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_goal.kind <> 'measurable' then
      return pg_catalog.jsonb_build_object('outcome', 'not_measurable');
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    if v_goal.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', v_goal.revision);
    end if;
    v_total := private.goal_total(v_goal);
    v_unit_changed := p_unit <> v_goal.unit or p_unit_kind <> v_goal.unit_kind;
    v_reopens := v_goal.achieved_at is not null and v_total < p_target;
    v_impact := pg_catalog.jsonb_build_object(
      'targetBefore', v_goal.target, 'targetAfter', p_target,
      'unitBefore', v_goal.unit, 'unitKindBefore', v_goal.unit_kind,
      'unitAfter', p_unit, 'unitKindAfter', p_unit_kind, 'unitChanged', v_unit_changed,
      'total', v_total, 'reachedBefore', v_total >= v_goal.target, 'reachedAfter', v_total >= p_target,
      'achieved', v_goal.achieved_at is not null, 'reopens', v_reopens);
    if p_target = v_goal.target and not v_unit_changed then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_goal.revision, 'impact', v_impact);
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_goal.revision, 'impact', v_impact);
    end if;
    if v_unit_changed and not p_confirm_unit
       and exists (select 1 from private.goal_entries e where e.goal_id = v_goal.id and e.status = 'active' and e.quantity <> 0) then
      return pg_catalog.jsonb_build_object('outcome', 'confirm_unit', 'revision', v_goal.revision, 'impact', v_impact);
    end if;
    if v_reopens and not p_confirm_status then
      return pg_catalog.jsonb_build_object('outcome', 'confirm_status', 'revision', v_goal.revision, 'impact', v_impact);
    end if;
    v_before := v_goal.target;
    v_unit_before := v_goal.unit;
    v_unit_kind_before := v_goal.unit_kind;
    update private.goals g set target = p_target, unit = p_unit, unit_kind = p_unit_kind,
        achieved_at = case when v_reopens then null else g.achieved_at end,
        achieved_by = case when v_reopens then null else g.achieved_by end,
        revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where g.id = v_goal.id returning * into v_goal;
    if v_reopens then
      update private.goal_achievements a set reopened_at = pg_catalog.now(), reopened_by = v_user_id
        where a.goal_id = v_goal.id and a.reopened_at is null;
    end if;
    perform private.goal_event(v_goal.id, 'target_changed', v_user_id, null,
      pg_catalog.jsonb_build_object('targetBefore', v_before, 'targetAfter', p_target,
        'unitBefore', v_unit_before, 'unitKindBefore', v_unit_kind_before, 'unitAfter', p_unit,
        'unitKindAfter', p_unit_kind, 'unitChanged', v_unit_changed, 'reopened', v_reopens));
    perform private.audit_goal('goal.target_changed', v_goal,
      pg_catalog.jsonb_build_object('unitChanged', v_unit_changed, 'reopened', v_reopens));
    if v_reopens then
      perform private.reschedule_goal_reminders(v_goal.id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_goal.revision, 'impact', v_impact,
      'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- Progress ----------------------------------------------------------------------------------------------

-- Records progress on a measurable goal. p_mode 'add' (members who may contribute): adds p_quantity
-- (positive). 'total' (goal managers): sets the total to p_quantity (0 or more), recorded as the signed
-- difference; p_expected_total is the total the caller saw, so a total that moved meanwhile answers
-- 'stale' instead of overwriting someone's contribution. p_id is the caller's client id: a retry answers
-- 'exists'. Outcomes: 'added', 'adjusted', 'exists', 'unchanged', 'stale', 'id_taken', 'achieved',
-- 'archived', 'not_measurable', 'not_found', 'not_permitted', each with the goal as it is now where the
-- caller may see it. 22023 for invalid fields.
create function public.add_goal_entry(
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
    end if;
    return pg_catalog.jsonb_build_object('outcome', case when p_mode = 'add' then 'added' else 'adjusted' end,
      'entryId', p_id, 'totalBefore', v_total,
      'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- Corrects an entry. 'reverse': the contributor's own contribution while they may contribute, or any
-- entry by goal managers. 'amend' (goal managers): a new quantity (a contribution stays positive, an
-- adjustment non-zero, an initial value 0 or more); the first quantity is kept. Either way the entry
-- stays, the correction is recorded with before, after, who, when and the optional reason, and a
-- change that would take the total below 0 answers 'negative_total'. Corrections are allowed on an
-- achieved goal (the achievement stays). Outcomes: 'reversed', 'corrected', 'unchanged',
-- 'already_reversed', 'negative_total', 'archived', 'not_found', 'not_permitted'. 22023 for invalid
-- fields.
create function public.update_goal_entry(
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
    return pg_catalog.jsonb_build_object('outcome', case when p_action = 'amend' then 'corrected' else 'reversed' end,
      'totalBefore', v_total, 'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- Achievement -------------------------------------------------------------------------------------------

-- Marks a goal achieved or reopens it, from the revision the caller saw. Achieving: a completion goal by
-- anyone who may contribute; a measurable goal by goal managers once its total has reached the target
-- (reaching it never achieves by itself). Reopening: goal managers, with an optional reason; the
-- achievement stays in the history and the deadline reminders still ahead are queued again. A second
-- tap answers 'unchanged'. Outcomes: 'achieved', 'reopened', 'unchanged', 'target_not_reached',
-- 'conflict', 'archived', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.set_goal_achievement(
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
        case when p_achieved and v_goal.kind = 'completion' then 'contribute' else 'manage' end) then
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
    return pg_catalog.jsonb_build_object('outcome', case when p_achieved then 'achieved' else 'reopened' end,
      'revision', v_goal.revision, 'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;

-- Archive and trash -------------------------------------------------------------------------------------

-- Archives or unarchives a goal (goal managers), from the revision the caller saw. An archived goal is
-- kept with everything but leaves lists, widgets and reminders. Outcomes: 'saved', 'unchanged',
-- 'conflict', 'too_many' (unarchiving past the limit), 'not_found', 'not_permitted'.
create function public.archive_goal(p_id uuid, p_expected_revision integer, p_archived boolean)
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
    if not p_archived then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'goals:' || coalesce(v_goal.owner_home_id, v_goal.owner_user_id)::text, 0));
      if (select count(*) from private.goals g
          where g.deleted_at is null and g.archived_at is null
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

-- Moves a goal to the trash (goal managers), from the revision the caller saw. Outcomes: 'deleted'
-- (with the trash entry), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_goal(p_id uuid, p_expected_revision integer)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.goal_may(v_goal, v_user_id, 'manage') then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    if v_goal.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    update private.goals g set deleted_at = pg_catalog.now(), updated_by = v_user_id, updated_at = pg_catalog.now()
      where g.id = v_goal.id;
    perform private.audit_goal('goal.deleted', v_goal);
    return query select 'deleted', private.trash_move(v_user_id, 'goals', 'goal', v_goal.id,
      v_goal.owner_user_id, v_goal.owner_home_id, v_goal.title);
  end
  $$;

-- Reminders ---------------------------------------------------------------------------------------------

-- Sets a goal's deadline reminders (goal managers), from the reminder revision the caller saw (0: never
-- set). Turning them on needs a deadline ('no_deadline') and at least one of an advance reminder
-- (p_lead_days 1-90 before it) and an overdue reminder (p_overdue_days 0-30 after the day after it), at
-- p_at_time. p_dry_run answers the moments the settings would give, each with whether it has already
-- passed (a passed moment is skipped, never sent late). Outcomes: 'preview', 'saved', 'unchanged',
-- 'conflict', 'no_deadline', 'archived', 'not_found', 'not_permitted'. 22023 for invalid settings.
create function public.set_goal_reminders(
  p_id uuid, p_expected_revision integer, p_enabled boolean, p_lead_days smallint default null,
  p_overdue_days smallint default null, p_at_time time default null, p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_reminder private.goal_reminders;
    v_moments jsonb;
  begin
    if p_id is null or p_expected_revision is null or p_enabled is null or p_dry_run is null
       or (p_lead_days is not null and p_lead_days not between 1 and private.goal_limit('lead_days'))
       or (p_overdue_days is not null and p_overdue_days not between 0 and private.goal_limit('overdue_days'))
       or (p_at_time is not null and p_at_time <> date_trunc('minute', p_at_time))
       or (p_enabled and (p_at_time is null or (p_lead_days is null and p_overdue_days is null))) then
      raise exception 'invalid reminder' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_may(v_goal, v_user_id, 'manage') then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    if p_enabled and v_goal.deadline is null then
      return pg_catalog.jsonb_build_object('outcome', 'no_deadline');
    end if;
    select * into v_reminder from private.goal_reminders r where r.goal_id = v_goal.id for update;
    if coalesce(v_reminder.revision, 0) <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', coalesce(v_reminder.revision, 0));
    end if;
    v_moments := case when p_enabled then private.goal_moments_json(v_goal, v_goal.deadline, p_lead_days,
      p_overdue_days, p_at_time) else '[]'::jsonb end;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', coalesce(v_reminder.revision, 0),
        'moments', v_moments);
    end if;
    if v_reminder.goal_id is null and not p_enabled then
      -- Off, and never set: nothing to keep.
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', 0, 'moments', v_moments);
    end if;
    if v_reminder.goal_id is not null and v_reminder.enabled = p_enabled
       and (not p_enabled or (v_reminder.lead_days is not distinct from p_lead_days
         and v_reminder.overdue_days is not distinct from p_overdue_days and v_reminder.at_time = p_at_time)) then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_reminder.revision, 'moments', v_moments);
    end if;
    insert into private.goal_reminders as r (goal_id, enabled, lead_days, overdue_days, at_time, updated_by)
      values (v_goal.id, p_enabled,
        case when p_enabled then p_lead_days else v_reminder.lead_days end,
        case when p_enabled then p_overdue_days else v_reminder.overdue_days end,
        case when p_enabled then p_at_time else v_reminder.at_time end, v_user_id)
      on conflict (goal_id) do update set enabled = excluded.enabled, lead_days = excluded.lead_days,
        overdue_days = excluded.overdue_days, at_time = excluded.at_time, revision = r.revision + 1,
        updated_by = excluded.updated_by, updated_at = pg_catalog.now()
      returning * into v_reminder;
    perform private.schedule_goal_reminders(v_goal.id);
    perform private.goal_event(v_goal.id, 'reminders_changed', v_user_id, null,
      pg_catalog.jsonb_build_object('enabled', p_enabled));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_reminder.revision, 'moments', v_moments);
  end
  $$;

-- Turns a Home goal's reminders off or back on for the caller only (anyone who may see it). Outcomes:
-- 'saved', 'not_found'. 22023 for a personal goal.
create function public.set_my_goal_reminders(p_id uuid, p_enabled boolean) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
  begin
    if p_id is null or p_enabled is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_goal := private.goal_for(p_id, v_user_id);
    if v_goal.id is null then
      return 'not_found';
    end if;
    if v_goal.owner_home_id is null then
      raise exception 'not a Home goal' using errcode = '22023';
    end if;
    if p_enabled then
      delete from private.goal_reminder_optouts o where o.goal_id = v_goal.id and o.user_id = v_user_id;
    else
      insert into private.goal_reminder_optouts (goal_id, user_id) values (v_goal.id, v_user_id)
        on conflict do nothing;
    end if;
    return 'saved';
  end
  $$;

-- Settings ----------------------------------------------------------------------------------------------

-- A Home's member access to its goals ('contribute' or 'view'; goal managers only). Outcomes: 'saved',
-- 'not_permitted'. 42501 for a Home the caller is not in; 22023 for another value.
create function public.update_goal_settings(p_home_id uuid, p_member_access text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_home_id is null or p_member_access is null or p_member_access not in ('contribute', 'view') then
      raise exception 'invalid settings' using errcode = '22023';
    end if;
    perform private.require_goal_context(p_home_id, v_user_id);
    if private.goal_access(p_home_id, v_user_id) is distinct from 'manage' then
      return 'not_permitted';
    end if;
    insert into private.goal_settings as s (home_id, member_access, updated_by)
      values (p_home_id, p_member_access, v_user_id)
      on conflict (home_id) do update set member_access = excluded.member_access,
        updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    perform private.audit('goals.member_access', p_home_id, 'goal', null,
      pg_catalog.jsonb_build_object('memberAccess', p_member_access));
    return 'saved';
  end
  $$;

-- Background delivery (service role only) ---------------------------------------------------------------

-- Delivers one deadline reminder moment of a goal (the goal-reminder job). Rechecked now: the reminder
-- revision is current and on, the goal still has its deadline and is not achieved, archived or in the
-- trash. A moment more than 30 minutes late is skipped, never sent afterwards. Each recipient (rechecked
-- now) is told once per moment (dedupe key). Outcomes: 'notified', 'late', 'inactive', 'stale', 'not_due'.
create function public.deliver_goal_reminder(p_goal_id uuid, p_revision integer, p_kind text, p_at timestamptz)
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
    if v_goal.id is null or v_goal.deleted_at is not null or v_reminder.goal_id is null
       or v_reminder.revision <> p_revision or not v_reminder.enabled then
      return 'stale';
    end if;
    if p_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    if pg_catalog.now() > p_at + pg_catalog.make_interval(mins => private.goal_limit('late_minutes')) then
      return 'late';
    end if;
    if v_goal.archived_at is not null or v_goal.achieved_at is not null or v_goal.deadline is null then
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

-- Trash -------------------------------------------------------------------------------------------------

-- The dispatch functions as they stood before goals keep handling every other module; these handle the
-- goals module and hand the rest on (the habits pattern).
alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_goals;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_goals;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_goals;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_goals;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_goals;

-- A goal has nothing that can be in the way of its return.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'goals' then
      return private.trash_conflict_before_goals(p_entry);
    end if;
    if not exists (select 1 from private.goals g where g.id = p_entry.subject_id and g.deleted_at is not null) then
      return 'item_missing';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select private.trash_conflict_options_before_goals(p_kind);
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'goals' then
      perform private.trash_resolve_before_goals(p_entry, p_resolution);
    end if;
  end
  $$;

-- A goal comes back exactly as it was, with its reminder moments still ahead queued again.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_goal private.goals;
  begin
    if p_entry.module <> 'goals' then
      return private.trash_item_restore_before_goals(p_entry);
    end if;
    select * into v_goal from private.goals g where g.id = p_entry.subject_id and g.deleted_at is not null for update;
    if v_goal.id is null then
      raise exception 'goal restore unavailable' using errcode = '23505';
    end if;
    update private.goals g
      set deleted_at = null, revision = g.revision + 1, updated_by = auth.uid(), updated_at = pg_catalog.now()
      where g.id = v_goal.id;
    perform private.reschedule_goal_reminders(v_goal.id);
    perform private.goal_event(v_goal.id, 'restored', auth.uid());
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'goals' then
      perform private.trash_item_purge_before_goals(p_entry);
      return;
    end if;
    delete from private.goals g where g.id = p_entry.subject_id and g.deleted_at is not null;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The goals API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_goals', 'get_goal', 'get_goal_entries', 'get_goal_events', 'goal_notice_names', 'create_goal',
      'update_goal', 'change_goal_target', 'add_goal_entry', 'update_goal_entry', 'set_goal_achievement',
      'archive_goal', 'delete_goal', 'set_goal_reminders', 'set_my_goal_reminders', 'update_goal_settings'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Background delivery: the service role only (Trigger.dev jobs).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('deliver_goal_reminder')
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
      or p.proname in ('is_delegable_capability', 'trash_conflict', 'trash_conflict_options',
        'trash_resolve', 'trash_item_restore', 'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
