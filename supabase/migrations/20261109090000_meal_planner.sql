-- S27: meal planner (brief plans/steps/S27-brief.md; ADR 0034; spec "Confirmed configurable meal-planner
-- dashboard widgets", "Confirmed meal-plan date-range shopping transfer", "Confirmed print-friendly
-- weekly meal-plan overview", "Confirmed whole-week meal-plan copying", "Confirmed optional recurring
-- meal-plan entries", "Confirmed recipe and custom meal-plan entries", "Confirmed configurable
-- meal-planner slots").
--
-- Every slot, meal and repeating series belongs to exactly one context: a person (their Personal space)
-- or a Home. Nothing here is exposed as a table; people use security-definer functions that run with
-- their own session and recheck the confirmed caller, their current membership and their access on
-- every call. A Home the caller is not in answers 42501 "not permitted" exactly like one that does not
-- exist; a meal, slot or series they may not see answers 'not_found' exactly like a missing one.
--
-- Who may do what (default picked in the brief, owner may override; the per-module permission matrix
-- is open in the spec). packages/domain/src/permissions/meals.ts makes the same decisions:
-- - Personal space: its owner, for everything.
-- - Home: every current member views the plan and prints it. Members plan meals (add, edit, move,
--   remove, repeating meals, copy week, ingredient transfers) unless a meal manager set the Home's
--   planner to view only. Meal managers (the Owner and Administrators granted the new delegable
--   capability manageHomeMeals) always plan, configure slots and set that member access.
--
-- One meal per date and slot. Concrete meals are rows (a unique index per slot and date); repeating
-- meals are computed from their series' segments, so an occurrence's identity is (segment, date) and
-- no retry, outage or second device can ever create a duplicate or a backlog. An occurrence that is
-- removed or edited gets an exception row (skipped, or detached into a concrete meal). Every write
-- takes the context lock first (private.lock_meal_context), so occupancy is decided one at a time per
-- context; replacing an occupied slot is always an explicit choice the caller names.
--
-- Dates are local calendar dates without times. "Today" is the Home's timezone for a Home; for the
-- Personal space the app passes its date (the task rule, private.task_today).

-- Audit subjects, the new capability, trash types ------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping',
    'manageHomeMeals'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping', 'meals'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry'
  ));

-- Limits and text rules ----------------------------------------------------------------------------

-- apps/web/src/meals/schema.ts and packages/domain/src/meals use the same numbers.
create function private.meal_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'slots' then 8                -- slots per context (disabled ones count)
    when 'slot_name' then 30
    when 'title' then 120              -- a custom meal's title
    when 'notes' then 1000
    when 'servings' then 99
    when 'series' then 100             -- series per context that have not ended
    when 'plan_days' then 42           -- days in one plan read
    when 'transfer_days' then 31       -- days in one ingredient transfer
    when 'horizon_days' then 366       -- days a series preview checks for collisions
    when 'copy_rows' then 100          -- rows in one week copy (7 days x 8 slots, plus slack)
  end;
  $$;

-- The en and nl names of an unrenamed standard slot (apps/web/src/i18n/messages: meals.slots.*), so a
-- renamed or custom slot can never read like one of them.
create function private.meal_standard_names(p_key text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_key
    when 'breakfast' then array['Breakfast', 'Ontbijt']
    when 'lunch' then array['Lunch']
    when 'dinner' then array['Dinner', 'Avondeten']
    else array[]::text[]
  end;
  $$;

-- A plausible calendar date for a meal (keeps generated ranges bounded).
create function private.is_meal_date(p_on date) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_on between date '2000-01-01' and date '2100-12-31', false);
  $$;

-- Whether a meal's content is acceptable: a recipe (with optional servings) or a custom title, never
-- both; optional notes.
create function private.valid_meal_content(
  p_recipe_id uuid, p_title text, p_notes text, p_servings integer
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    ((p_recipe_id is not null and p_title is null)
      or (p_recipe_id is null and p_title is not null
        and private.is_visible_name(p_title, 120) and pg_catalog.btrim(p_title) <> ''
        and p_servings is null))
    and (p_notes is null or private.is_plain_text(p_notes, 1000))
    and (p_servings is null or p_servings between 1 and 99),
    false);
  $$;

-- Whether a repeat schedule is well formed: daily (no weekdays), chosen weekdays (at least one ISO
-- weekday, 1 Monday … 7 Sunday) or weekly (exactly one weekday).
create function private.valid_meal_cadence(p_cadence text, p_weekdays smallint[]) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    (p_cadence = 'daily' and p_weekdays is null)
    or (p_cadence in ('weekdays', 'weekly') and p_weekdays is not null
      and cardinality(p_weekdays) between 1 and 7
      and p_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
      and array_position(p_weekdays, null) is null
      and cardinality(p_weekdays) = (select count(distinct x) from unnest(p_weekdays) x)
      and (p_cadence = 'weekdays' or cardinality(p_weekdays) = 1)),
    false);
  $$;

-- Tables -------------------------------------------------------------------------------------------

-- A Home's planner settings (a row exists once a manager changed them; none means the defaults).
create table private.meal_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  member_access text not null default 'edit'
    constraint meal_settings_member_access_check check (member_access in ('edit', 'view')),
  revision integer not null default 1 constraint meal_settings_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table private.meal_slots (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  -- One of the standard slots (kept when renamed), or null for a custom one.
  standard_key text constraint meal_slots_standard_check check (standard_key in ('breakfast', 'lunch', 'dinner')),
  -- null: the translated standard name. A custom slot always has a name.
  name text constraint meal_slots_name_check check (name is null or private.is_visible_name(name, 30)),
  position integer not null default 0,
  enabled boolean not null default true,
  revision integer not null default 1 constraint meal_slots_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  constraint meal_slots_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint meal_slots_named check (standard_key is not null or name is not null)
);

create unique index meal_slots_standard_idx
  on private.meal_slots (coalesce(owner_home_id, owner_user_id), standard_key) where standard_key is not null;
create unique index meal_slots_name_idx
  on private.meal_slots (coalesce(owner_home_id, owner_user_id), private.recipe_fold(name)) where name is not null;
create index meal_slots_context_idx on private.meal_slots (coalesce(owner_home_id, owner_user_id), position);

-- A repeating meal: what it is and its state; its schedule lives in segments (meal_recurrences). The
-- last segment is the current one; earlier ones keep the past exactly as it was.
create table private.meal_series (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  status text not null default 'active' constraint meal_series_status_check check (status in ('active', 'paused', 'ended')),
  -- The end date the person chose (a resume continues to it); null: open ended.
  end_on date,
  revision integer not null default 1 constraint meal_series_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meal_series_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create index meal_series_context_idx on private.meal_series (coalesce(owner_home_id, owner_user_id))
  where status <> 'ended';

-- One stretch of a series with fixed content and schedule, from start_on to end_on (inclusive; an
-- end the day before the start is an empty stretch, e.g. a series paused before it began).
create table private.meal_recurrences (
  id uuid primary key default gen_random_uuid(),
  -- Creation order: the latest segment is the current one.
  seq bigint generated always as identity,
  series_id uuid not null references private.meal_series (id) on delete cascade,
  slot_id uuid not null references private.meal_slots (id) on delete cascade,
  recipe_id uuid references private.recipes (id) on delete set null,
  -- A recipe meal whose recipe was purged keeps this flag (shown as unavailable, never as custom).
  is_recipe boolean not null,
  title text,
  notes text,
  servings smallint,
  cadence text not null constraint meal_recurrences_cadence_check check (cadence in ('daily', 'weekdays', 'weekly')),
  weekdays smallint[],
  start_on date not null,
  end_on date,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint meal_recurrences_content_check check (
    (is_recipe and title is null) or (not is_recipe and recipe_id is null and servings is null
      and title is not null and private.is_visible_name(title, 120))
  ),
  constraint meal_recurrences_notes_check check (notes is null or private.is_plain_text(notes, 1000)),
  constraint meal_recurrences_servings_check check (servings is null or servings between 1 and 99),
  constraint meal_recurrences_cadence_shape check (private.valid_meal_cadence(cadence, weekdays)),
  constraint meal_recurrences_dates_check check (
    private.is_meal_date(start_on) and (end_on is null or (end_on >= start_on - 1 and private.is_meal_date(end_on)))
  )
);

create index meal_recurrences_series_idx on private.meal_recurrences (series_id, start_on);
create index meal_recurrences_slot_idx on private.meal_recurrences (slot_id);
create index meal_recurrences_recipe_idx on private.meal_recurrences (recipe_id) where recipe_id is not null;

create table private.meal_entries (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  on_date date not null constraint meal_entries_date_check check (private.is_meal_date(on_date)),
  slot_id uuid not null references private.meal_slots (id) on delete cascade,
  recipe_id uuid references private.recipes (id) on delete set null,
  is_recipe boolean not null,
  title text,
  notes text,
  servings smallint,
  -- An occurrence of a series that was edited or moved: where it came from (kept when the series
  -- changes later).
  origin_recurrence_id uuid references private.meal_recurrences (id) on delete set null,
  origin_on date,
  deleted_at timestamptz,
  revision integer not null default 1 constraint meal_entries_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint meal_entries_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint meal_entries_content_check check (
    (is_recipe and title is null) or (not is_recipe and recipe_id is null and servings is null
      and title is not null and private.is_visible_name(title, 120))
  ),
  constraint meal_entries_notes_check check (notes is null or private.is_plain_text(notes, 1000)),
  constraint meal_entries_servings_check check (servings is null or servings between 1 and 99)
);

-- One meal per slot and date (slots belong to one context).
create unique index meal_entries_slot_date_idx on private.meal_entries (slot_id, on_date) where deleted_at is null;
create index meal_entries_context_idx on private.meal_entries (coalesce(owner_home_id, owner_user_id), on_date)
  where deleted_at is null;
create index meal_entries_recipe_idx on private.meal_entries (recipe_id) where recipe_id is not null;
create index meal_entries_origin_idx on private.meal_entries (origin_recurrence_id) where origin_recurrence_id is not null;

-- An occurrence that no longer shows as computed: removed ('skipped') or replaced by a concrete meal
-- ('detached', entry_id). One per segment and date: the occurrence's stable identity.
create table private.meal_occurrence_exceptions (
  recurrence_id uuid not null references private.meal_recurrences (id) on delete cascade,
  on_date date not null,
  kind text not null constraint meal_occurrence_exceptions_kind_check check (kind in ('skipped', 'detached')),
  entry_id uuid references private.meal_entries (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (recurrence_id, on_date)
);

-- One confirmed ingredient transfer: who moved how many planned ingredients into which list, for which
-- dates. The items it added point back here (shopping_items.meal_transfer_id).
create table private.meal_shopping_transfers (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  list_id uuid references private.shopping_lists (id) on delete set null,
  from_on date not null,
  to_on date not null,
  item_count integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint meal_shopping_transfers_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint meal_shopping_transfers_range check (to_on >= from_on)
);

alter table private.shopping_items
  add column meal_transfer_id uuid references private.meal_shopping_transfers (id) on delete set null;
create index shopping_items_meal_transfer_idx on private.shopping_items (meal_transfer_id)
  where meal_transfer_id is not null;

comment on table private.meal_settings is 'S27: a Home''s meal-planner settings. Not exposed through the API.';
comment on table private.meal_slots is 'S27: per-context meal slots. Not exposed through the API.';
comment on table private.meal_series is 'S27: repeating meals. Not exposed through the API.';
comment on table private.meal_recurrences is 'S27: repeating-meal schedule segments. Not exposed through the API.';
comment on table private.meal_entries is 'S27: planned meals (concrete). Not exposed through the API.';
comment on table private.meal_occurrence_exceptions is 'S27: skipped or detached repeating occurrences. Not exposed through the API.';
comment on table private.meal_shopping_transfers is 'S27: confirmed ingredient transfers. Not exposed through the API.';

alter table private.meal_settings enable row level security;
alter table private.meal_slots enable row level security;
alter table private.meal_series enable row level security;
alter table private.meal_recurrences enable row level security;
alter table private.meal_entries enable row level security;
alter table private.meal_occurrence_exceptions enable row level security;
alter table private.meal_shopping_transfers enable row level security;
revoke all on private.meal_settings, private.meal_slots, private.meal_series, private.meal_recurrences,
  private.meal_entries, private.meal_occurrence_exceptions, private.meal_shopping_transfers
  from public, anon, authenticated, service_role;

-- Permission helpers (the engine in packages/domain mirrors these) ----------------------------------

-- What p_user_id may do with a context's planner now: 'manage' (the Personal space's owner; a Home's
-- Owner and Administrators granted manageHomeMeals), 'edit' or 'view' (other current members, by the
-- Home's member access), or null (not a member).
create function private.meal_access(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then null
    when p_home_id is null then 'manage'
    when not private.is_home_member(p_home_id, p_user_id) then null
    when private.has_home_capability(p_home_id, p_user_id, 'manageHomeMeals') then 'manage'
    else coalesce((select s.member_access from private.meal_settings s where s.home_id = p_home_id), 'edit')
  end;
  $$;

create function private.meal_may(p_home_id uuid, p_user_id uuid, p_need text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    case private.meal_access(p_home_id, p_user_id) when 'manage' then 3 when 'edit' then 2 when 'view' then 1 else 0 end
    >= case p_need when 'manage' then 3 when 'edit' then 2 else 1 end,
    false);
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_meal_context(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- Serializes every change to one context's plan (occupancy, slots, series, copies).
create function private.lock_meal_context(p_home_id uuid, p_user_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meal_plan:' || coalesce(p_home_id, p_user_id)::text, 0));
  $$;

-- Whether a row's owner columns are the context (p_home_id, or the caller's Personal space). Written
-- without a search_path setting so the planner inlines it and uses the owner indexes; the operators
-- are schema-qualified instead, so no search_path can change what it does.
create function private.in_meal_context(
  p_owner_user_id uuid, p_owner_home_id uuid, p_home_id uuid, p_user_id uuid
) returns boolean
  language sql immutable as $$
  select (p_home_id is null and p_owner_user_id operator(pg_catalog.=) p_user_id)
    or (p_home_id is not null and p_owner_home_id operator(pg_catalog.=) p_home_id);
  $$;

-- Whether a recipe may be shown and planned from a context: a Home's own recipes and those shared with
-- it, for its current members; the Personal space's own published recipes. Never a draft or a deleted
-- one, and never because the recipe is visible somewhere else.
create function private.meal_recipe_visible(p_recipe_id uuid, p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when p_home_id is null
      then r.status = 'published' and r.deleted_at is null and r.owner_user_id = p_user_id
      else private.recipe_visible_in(r, p_home_id, p_user_id) end
    from private.recipes r where r.id = p_recipe_id), false);
  $$;

-- The recipe as a meal may show it to this viewer from this context, or null (unavailable).
create function private.meal_recipe_json(p_recipe_id uuid, p_home_id uuid, p_user_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select case when private.meal_recipe_visible(p_recipe_id, p_home_id, p_user_id) then (
    select pg_catalog.jsonb_build_object('id', r.id, 'name', r.name, 'servings', r.servings)
    from private.recipes r where r.id = p_recipe_id) end;
  $$;

create function private.meal_today(p_home_id uuid, p_today date) returns date
  language sql stable security definer set search_path = '' as $$
  select private.task_today(p_home_id, p_today);
  $$;

create function private.audit_meals(
  p_action text, p_home_id uuid, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids, dates and counts only: never titles, notes or recipe names. Home actions only.
  select case when p_home_id is not null
    then private.audit(p_action, p_home_id, 'meal_plan', p_subject_id, p_details) end;
  $$;

-- Creates the standard Breakfast, Lunch and Dinner slots of a context the first time it is opened.
-- Idempotent: concurrent first opens create them once.
create function private.ensure_meal_slots(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if exists (select 1 from private.meal_slots s
        where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id)) then
      return;
    end if;
    perform private.lock_meal_context(p_home_id, p_user_id);
    insert into private.meal_slots (id, owner_user_id, owner_home_id, standard_key, position)
      select gen_random_uuid(), case when p_home_id is null then p_user_id end, p_home_id, k.key, k.pos
      from (values ('breakfast', 0), ('lunch', 1), ('dinner', 2)) as k (key, pos)
      where not exists (select 1 from private.meal_slots s
        where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id))
      on conflict do nothing;
  end
  $$;

-- Occurrences ---------------------------------------------------------------------------------------

-- Whether a segment has an occurrence on a date (date-only: daylight-saving changes never matter).
create function private.meal_occurs(p_recurrence private.meal_recurrences, p_on date) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_on >= p_recurrence.start_on
    and (p_recurrence.end_on is null or p_on <= p_recurrence.end_on)
    and (p_recurrence.cadence = 'daily'
      or extract(isodow from p_on)::smallint = any (p_recurrence.weekdays)), false);
  $$;

-- The computed occurrences of a context between two dates: segments whose slot is enabled, on their
-- days, without the ones that have an exception.
create function private.meal_occurrences(p_home_id uuid, p_user_id uuid, p_from date, p_to date)
returns table (recurrence_id uuid, series_id uuid, on_date date, slot_id uuid)
  language sql stable security definer set search_path = '' as $$
  select r.id, r.series_id, d::date, r.slot_id
  from private.meal_recurrences r
  join private.meal_series s on s.id = r.series_id
  join private.meal_slots sl on sl.id = r.slot_id and sl.enabled
  cross join lateral pg_catalog.generate_series(
    greatest(r.start_on, p_from)::timestamp, least(coalesce(r.end_on, p_to), p_to)::timestamp,
    interval '1 day') d
  where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id)
    and r.start_on <= p_to and (r.end_on is null or r.end_on >= p_from)
    and private.meal_occurs(r, d::date)
    and not exists (select 1 from private.meal_occurrence_exceptions e
      where e.recurrence_id = r.id and e.on_date = d::date);
  $$;

-- A concrete meal as answers show it.
create function private.meal_entry_json(p_entry private.meal_entries, p_viewer uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'kind', 'entry', 'id', p_entry.id, 'date', p_entry.on_date, 'slotId', p_entry.slot_id,
    'type', case when p_entry.is_recipe then 'recipe' else 'custom' end,
    'recipe', case when p_entry.is_recipe and p_entry.recipe_id is not null
      then private.meal_recipe_json(p_entry.recipe_id, p_entry.owner_home_id, p_viewer) end,
    'title', p_entry.title, 'notes', p_entry.notes, 'servings', p_entry.servings,
    'revision', p_entry.revision,
    'origin', case when p_entry.origin_recurrence_id is not null then pg_catalog.jsonb_build_object(
      'recurrenceId', p_entry.origin_recurrence_id, 'date', p_entry.origin_on,
      'seriesId', (select r.series_id from private.meal_recurrences r where r.id = p_entry.origin_recurrence_id))
    end
  );
  $$;

-- A computed occurrence as answers show it.
create function private.meal_occurrence_json(
  p_recurrence private.meal_recurrences, p_on date, p_home_id uuid, p_viewer uuid
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'kind', 'occurrence', 'recurrenceId', p_recurrence.id, 'seriesId', p_recurrence.series_id,
    'date', p_on, 'slotId', p_recurrence.slot_id,
    'type', case when p_recurrence.is_recipe then 'recipe' else 'custom' end,
    'recipe', case when p_recurrence.is_recipe and p_recurrence.recipe_id is not null
      then private.meal_recipe_json(p_recurrence.recipe_id, p_home_id, p_viewer) end,
    'title', p_recurrence.title, 'notes', p_recurrence.notes, 'servings', p_recurrence.servings,
    'cadence', p_recurrence.cadence,
    'seriesRevision', (select s.revision from private.meal_series s where s.id = p_recurrence.series_id)
  );
  $$;

-- What occupies one date and slot of a context: concrete meals and computed occurrences, except the
-- meal or occurrence being placed (p_except_entry, p_except_recurrence + p_except_on) and, for a series
-- being changed, all of that series' own occurrences (p_except_series).
create function private.meal_occupants(
  p_home_id uuid, p_user_id uuid, p_on date, p_slot_id uuid,
  p_except_entry uuid default null, p_except_recurrence uuid default null, p_except_on date default null,
  p_except_series uuid default null
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(o.item order by o.ord), '[]'::jsonb) from (
    select 0 as ord, private.meal_entry_json(e, p_user_id) as item
      from private.meal_entries e
      where e.slot_id = p_slot_id and e.on_date = p_on and e.deleted_at is null
        and e.id is distinct from p_except_entry
    union all
    select 1, private.meal_occurrence_json(r, o.on_date, p_home_id, p_user_id)
      from private.meal_occurrences(p_home_id, p_user_id, p_on, p_on) o
      join private.meal_recurrences r on r.id = o.recurrence_id
      where o.slot_id = p_slot_id
        and not coalesce(o.recurrence_id = p_except_recurrence and o.on_date = p_except_on, false)
        and o.series_id is distinct from p_except_series
  ) o;
  $$;

-- A fingerprint of occupants (identity and revision), for previews that must not be acted on stale.
create function private.meal_occupants_key(p_occupants jsonb) returns text
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.string_agg(case x ->> 'kind'
      when 'entry' then 'e' || (x ->> 'id') || '.' || (x ->> 'revision')
      else 'o' || (x ->> 'recurrenceId') || '.' || (x ->> 'date') || '.' || (x ->> 'seriesRevision') end,
    ',' order by x ->> 'kind', x ->> 'id', x ->> 'recurrenceId'), '')
  from pg_catalog.jsonb_array_elements(coalesce(p_occupants, '[]'::jsonb)) x;
  $$;

-- Removes what occupies a date and slot, as the caller explicitly chose ("replace"): a concrete meal
-- goes to the trash, an occurrence is skipped. Locked by the caller (context lock).
create function private.meal_clear_occupants(p_home_id uuid, p_user_id uuid, p_occupants jsonb)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_item jsonb;
  begin
    for v_item in select * from pg_catalog.jsonb_array_elements(coalesce(p_occupants, '[]'::jsonb)) loop
      if v_item ->> 'kind' = 'entry' then
        perform private.meal_trash_entry((v_item ->> 'id')::uuid, p_user_id);
      else
        insert into private.meal_occurrence_exceptions (recurrence_id, on_date, kind, created_by)
          values ((v_item ->> 'recurrenceId')::uuid, (v_item ->> 'date')::date, 'skipped', p_user_id)
          on conflict do nothing;
      end if;
    end loop;
  end
  $$;

-- Moves a concrete meal to the trash (the caller already checked the right to edit the plan).
create function private.meal_trash_entry(p_entry_id uuid, p_user_id uuid) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.meal_entries;
    v_label text;
  begin
    update private.meal_entries e set deleted_at = pg_catalog.now(), updated_by = p_user_id,
        updated_at = pg_catalog.now()
      where e.id = p_entry_id and e.deleted_at is null
      returning * into v_entry;
    if v_entry.id is null then
      return null;
    end if;
    -- The label others may see in the trash: the custom title, the recipe's name when it is visible
    -- from this context, otherwise a neutral word.
    v_label := coalesce(v_entry.title,
      (select r.name from private.recipes r
        where r.id = v_entry.recipe_id
          and private.meal_recipe_visible(r.id, v_entry.owner_home_id, p_user_id)),
      'Meal');
    return private.trash_move(p_user_id, 'meals', 'meal_entry', v_entry.id, v_entry.owner_user_id,
      v_entry.owner_home_id, v_label);
  end
  $$;

-- Whether the replace choice the caller sent still names exactly what is there now: the occupants'
-- fingerprint they saw (from an 'occupied' answer). Anything else is answered 'occupied' again.
create function private.meal_place(
  p_home_id uuid, p_user_id uuid, p_on date, p_slot_id uuid, p_replace text,
  p_except_entry uuid default null, p_except_recurrence uuid default null, p_except_on date default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occupants jsonb;
  begin
    v_occupants := private.meal_occupants(p_home_id, p_user_id, p_on, p_slot_id,
      p_except_entry, p_except_recurrence, p_except_on);
    if pg_catalog.jsonb_array_length(v_occupants) = 0 then
      return null;
    end if;
    if p_replace is not null and p_replace = private.meal_occupants_key(v_occupants) then
      perform private.meal_clear_occupants(p_home_id, p_user_id, v_occupants);
      return null;
    end if;
    -- Occupied: what is there and the fingerprint a replace must send back.
    return pg_catalog.jsonb_build_object('occupants', v_occupants,
      'replaceKey', private.meal_occupants_key(v_occupants));
  end
  $$;

-- The slot a meal may be placed in: one of the context's enabled slots.
create function private.meal_slot_open(p_slot_id uuid, p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.meal_slots s
    where s.id = p_slot_id and s.enabled
      and private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id));
  $$;

-- The plan ----------------------------------------------------------------------------------------------

create function private.meal_slots_json(p_home_id uuid, p_user_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id, 'standardKey', s.standard_key, 'name', s.name, 'position', s.position,
      'enabled', s.enabled, 'revision', s.revision) order by s.position, s.created_at, s.id), '[]'::jsonb)
  from private.meal_slots s
  where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id);
  $$;

-- The series that have not ended, with their current segment (for the repeating-meals list and the
-- "this and future" editor).
create function private.meal_series_json(p_home_id uuid, p_user_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id, 'status', s.status, 'revision', s.revision, 'endOn', s.end_on,
      'recurrenceId', r.id, 'slotId', r.slot_id, 'slotEnabled', sl.enabled,
      'type', case when r.is_recipe then 'recipe' else 'custom' end,
      'recipe', case when r.is_recipe and r.recipe_id is not null
        then private.meal_recipe_json(r.recipe_id, p_home_id, p_user_id) end,
      'title', r.title, 'notes', r.notes, 'servings', r.servings,
      'cadence', r.cadence, 'weekdays', pg_catalog.to_jsonb(r.weekdays),
      'startOn', r.start_on, 'segmentEndOn', r.end_on
    ) order by s.created_at, s.id), '[]'::jsonb)
  from private.meal_series s
  join lateral (select * from private.meal_recurrences x where x.series_id = s.id
    order by x.seq desc limit 1) r on true
  join private.meal_slots sl on sl.id = r.slot_id
  where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id)
    and s.status <> 'ended';
  $$;

-- The plan of a context between two dates (at most 42 days; both null: today), after creating the
-- standard slots on first open: the caller's access, the context's today, slots, concrete meals,
-- computed occurrences and the open series, plus a fingerprint of the meals for a print preview.
-- Several meals in one slot and date are an unresolved conflict the interface shows. 42501 for a Home
-- the caller is not in; 22023 for a malformed range.
create function public.get_meal_plan(
  p_home_id uuid default null, p_from date default null, p_to date default null, p_today date default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_from date;
    v_to date;
    v_entries jsonb;
    v_occurrences jsonb;
    v_slots jsonb;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    v_today := private.meal_today(p_home_id, p_today);
    v_from := coalesce(p_from, v_today);
    v_to := coalesce(p_to, v_from);
    if not private.is_meal_date(v_from) or not private.is_meal_date(v_to) or v_to < v_from
       or v_to - v_from >= private.meal_limit('plan_days') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.ensure_meal_slots(p_home_id, v_user_id);
    v_slots := private.meal_slots_json(p_home_id, v_user_id);
    select coalesce(pg_catalog.jsonb_agg(private.meal_entry_json(e, v_user_id)
        order by e.on_date, e.slot_id, e.id), '[]'::jsonb)
      into v_entries
      from private.meal_entries e
      where private.in_meal_context(e.owner_user_id, e.owner_home_id, p_home_id, v_user_id)
        and e.deleted_at is null and e.on_date between v_from and v_to;
    select coalesce(pg_catalog.jsonb_agg(private.meal_occurrence_json(r, o.on_date, p_home_id, v_user_id)
        order by o.on_date, o.slot_id, r.id), '[]'::jsonb)
      into v_occurrences
      from private.meal_occurrences(p_home_id, v_user_id, v_from, v_to) o
      join private.meal_recurrences r on r.id = o.recurrence_id;
    return pg_catalog.jsonb_build_object(
      'access', private.meal_access(p_home_id, v_user_id),
      'memberAccess', coalesce((select s.member_access from private.meal_settings s where s.home_id = p_home_id), 'edit'),
      'settingsRevision', coalesce((select s.revision from private.meal_settings s where s.home_id = p_home_id), 0),
      'today', v_today, 'from', v_from, 'to', v_to,
      'slots', v_slots, 'entries', v_entries, 'occurrences', v_occurrences,
      'series', private.meal_series_json(p_home_id, v_user_id),
      'token', pg_catalog.md5(v_slots::text || v_entries::text || v_occurrences::text)
    );
  end
  $$;

-- The recipes that may be planned from a context (published, visible from it), by name, matching an
-- optional search. 42501 for a Home the caller is not in.
create function public.list_meal_recipes(p_home_id uuid default null, p_query text default null)
returns table (id uuid, name text, servings integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_query is not null and pg_catalog.char_length(p_query) > 100 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return query
      select r.id, r.name, r.servings from private.recipes r
      where r.status = 'published' and r.deleted_at is null
        and (case when p_home_id is null then r.owner_user_id = v_user_id
          else r.owner_home_id = p_home_id or private.recipe_shared_with(r.id, p_home_id) end)
        and private.meal_recipe_visible(r.id, p_home_id, v_user_id)
        and (p_query is null or pg_catalog.strpos(r.name_key, private.recipe_fold(p_query)) > 0)
      order by r.name_key, r.id
      limit 50;
  end
  $$;

-- Meals ------------------------------------------------------------------------------------------------

-- Plans a meal (people who may edit the plan): a recipe visible from the context, or a custom title.
-- Occupied slot and date: 'occupied' with what is there and a replace key; sending that key back
-- replaces it (a concrete meal goes to the trash, an occurrence is skipped). Outcomes: 'created',
-- 'exists' (a retry of the caller's own create), 'id_taken', 'occupied', 'slot_unavailable',
-- 'recipe_unavailable', 'not_permitted'. 22023 for invalid fields.
create function public.create_meal_entry(
  p_id uuid, p_on date, p_slot_id uuid, p_home_id uuid default null, p_recipe_id uuid default null,
  p_title text default null, p_notes text default null, p_servings integer default null,
  p_replace text default null
) returns table (outcome text, revision integer, occupied jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.meal_entries;
    v_occupied jsonb;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_id is null or p_slot_id is null or not private.is_meal_date(p_on)
       or not private.valid_meal_content(p_recipe_id, p_title, p_notes, p_servings) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(p_home_id, v_user_id);
    select * into v_existing from private.meal_entries e where e.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.in_meal_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists', v_existing.revision, null::jsonb;
      else
        return query select 'id_taken', null::integer, null::jsonb;
      end if;
      return;
    end if;
    if not private.meal_slot_open(p_slot_id, p_home_id, v_user_id) then
      return query select 'slot_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if p_recipe_id is not null and not private.meal_recipe_visible(p_recipe_id, p_home_id, v_user_id) then
      return query select 'recipe_unavailable', null::integer, null::jsonb;
      return;
    end if;
    v_occupied := private.meal_place(p_home_id, v_user_id, p_on, p_slot_id, p_replace);
    if v_occupied is not null then
      return query select 'occupied', null::integer, v_occupied;
      return;
    end if;
    insert into private.meal_entries (
      id, owner_user_id, owner_home_id, on_date, slot_id, recipe_id, is_recipe, title, notes, servings,
      created_by, updated_by
    ) values (
      p_id, case when p_home_id is null then v_user_id end, p_home_id, p_on, p_slot_id, p_recipe_id,
      p_recipe_id is not null, case when p_recipe_id is null then pg_catalog.btrim(p_title) end,
      p_notes, p_servings, v_user_id, v_user_id
    );
    return query select 'created', 1, null::jsonb;
  end
  $$;

-- Loads a concrete meal of a context the caller is a member of (null otherwise).
create function private.meal_entry_for(p_entry_id uuid, p_user_id uuid) returns private.meal_entries
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_entry private.meal_entries;
  begin
    select * into v_entry from private.meal_entries e where e.id = p_entry_id and e.deleted_at is null;
    if v_entry.id is null or private.meal_access(v_entry.owner_home_id, p_user_id) is null
       or (v_entry.owner_user_id is not null and v_entry.owner_user_id <> p_user_id) then
      return null;
    end if;
    return v_entry;
  end
  $$;

-- Edits or moves a concrete meal (people who may edit the plan), from the revision the caller saw. A
-- meal whose recipe became unavailable keeps it unless another is chosen. Moving into an occupied slot
-- and date answers 'occupied' as create does. Outcomes: 'saved' (with the new revision), 'conflict'
-- (with the current one), 'occupied', 'slot_unavailable', 'recipe_unavailable', 'not_found',
-- 'not_permitted'. 22023 for invalid fields.
create function public.update_meal_entry(
  p_id uuid, p_expected_revision integer, p_on date, p_slot_id uuid, p_recipe_id uuid default null,
  p_title text default null, p_notes text default null, p_servings integer default null,
  p_replace text default null
) returns table (outcome text, revision integer, occupied jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_entry private.meal_entries;
    v_occupied jsonb;
    v_keep_recipe boolean;
  begin
    if p_id is null or p_expected_revision is null or p_slot_id is null or not private.is_meal_date(p_on) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_entry := private.meal_entry_for(p_id, v_user_id);
    -- A recipe meal saved without choosing another recipe or a title keeps its recipe (also one the
    -- caller can no longer see, whose id they were never told, or one that was purged).
    v_keep_recipe := v_entry.id is not null and v_entry.is_recipe and p_title is null
      and (p_recipe_id is null or p_recipe_id = v_entry.recipe_id);
    if not v_keep_recipe and not private.valid_meal_content(p_recipe_id, p_title, p_notes, p_servings) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_keep_recipe and ((p_notes is not null and not private.is_plain_text(p_notes, 1000))
        or (p_servings is not null and p_servings not between 1 and 99)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_entry.id is null then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    if not private.meal_may(v_entry.owner_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(v_entry.owner_home_id, v_user_id);
    select * into v_entry from private.meal_entries e where e.id = p_id and e.deleted_at is null for update;
    if v_entry.id is null then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    if v_entry.revision <> p_expected_revision then
      return query select 'conflict', v_entry.revision, null::jsonb;
      return;
    end if;
    -- Staying in its own slot is allowed even when that slot was disabled meanwhile.
    if p_slot_id <> v_entry.slot_id
       and not private.meal_slot_open(p_slot_id, v_entry.owner_home_id, v_user_id) then
      return query select 'slot_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if not v_keep_recipe and p_recipe_id is not null
       and p_recipe_id is distinct from v_entry.recipe_id
       and not private.meal_recipe_visible(p_recipe_id, v_entry.owner_home_id, v_user_id) then
      return query select 'recipe_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if p_on <> v_entry.on_date or p_slot_id <> v_entry.slot_id then
      v_occupied := private.meal_place(v_entry.owner_home_id, v_user_id, p_on, p_slot_id, p_replace, v_entry.id);
      if v_occupied is not null then
        return query select 'occupied', null::integer, v_occupied;
        return;
      end if;
    end if;
    update private.meal_entries e set
        on_date = p_on, slot_id = p_slot_id,
        recipe_id = case when v_keep_recipe then e.recipe_id else p_recipe_id end,
        is_recipe = v_keep_recipe or p_recipe_id is not null,
        title = case when v_keep_recipe or p_recipe_id is not null then null else pg_catalog.btrim(p_title) end,
        notes = p_notes,
        servings = case when v_keep_recipe or p_recipe_id is not null then p_servings end,
        revision = e.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where e.id = v_entry.id
      returning e.revision into v_entry.revision;
    return query select 'saved', v_entry.revision, null::jsonb;
  end
  $$;

-- Moves a concrete meal to the trash (people who may edit the plan), from the revision the caller
-- saw. Outcomes: 'deleted' (with the entry), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_meal_entry(p_id uuid, p_expected_revision integer)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_entry private.meal_entries;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_entry := private.meal_entry_for(p_id, v_user_id);
    if v_entry.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.meal_may(v_entry.owner_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    perform private.lock_meal_context(v_entry.owner_home_id, v_user_id);
    select * into v_entry from private.meal_entries e where e.id = p_id and e.deleted_at is null for update;
    if v_entry.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if v_entry.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    return query select 'deleted', private.meal_trash_entry(v_entry.id, v_user_id);
  end
  $$;

-- Occurrences of a series -----------------------------------------------------------------------------

-- Loads a segment of a context the caller is a member of (null otherwise), with its context.
create function private.meal_recurrence_for(p_recurrence_id uuid, p_user_id uuid)
returns private.meal_recurrences
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_recurrence private.meal_recurrences;
    v_series private.meal_series;
  begin
    select * into v_recurrence from private.meal_recurrences r where r.id = p_recurrence_id;
    select * into v_series from private.meal_series s where s.id = v_recurrence.series_id;
    if v_recurrence.id is null or private.meal_access(v_series.owner_home_id, p_user_id) is null
       or (v_series.owner_user_id is not null and v_series.owner_user_id <> p_user_id) then
      return null;
    end if;
    return v_recurrence;
  end
  $$;

-- Whether the occurrence (segment, date) shows now: on its days, its slot enabled, no exception.
create function private.meal_occurrence_live(p_recurrence private.meal_recurrences, p_on date) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.meal_occurs(p_recurrence, p_on)
    and exists (select 1 from private.meal_slots s where s.id = p_recurrence.slot_id and s.enabled)
    and not exists (select 1 from private.meal_occurrence_exceptions e
      where e.recurrence_id = p_recurrence.id and e.on_date = p_on);
  $$;

-- Edits or moves one occurrence (people who may edit the plan): it becomes a concrete meal p_entry_id
-- (detached, remembering its origin) and the series continues. Placing it elsewhere checks occupancy as
-- create does. Outcomes: 'saved' (with the meal's revision), 'exists' (a retry: this occurrence is
-- already the caller's meal p_entry_id), 'occupied', 'slot_unavailable', 'recipe_unavailable',
-- 'not_found' (no such occurrence now), 'not_permitted'. 22023 for invalid fields.
create function public.edit_meal_occurrence(
  p_recurrence_id uuid, p_on date, p_entry_id uuid, p_new_on date, p_slot_id uuid,
  p_recipe_id uuid default null, p_title text default null, p_notes text default null,
  p_servings integer default null, p_replace text default null
) returns table (outcome text, revision integer, occupied jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recurrence private.meal_recurrences;
    v_series private.meal_series;
    v_exception private.meal_occurrence_exceptions;
    v_occupied jsonb;
    v_keep_recipe boolean;
  begin
    if p_recurrence_id is null or p_entry_id is null or p_slot_id is null
       or not private.is_meal_date(p_on) or not private.is_meal_date(p_new_on) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recurrence := private.meal_recurrence_for(p_recurrence_id, v_user_id);
    v_keep_recipe := v_recurrence.id is not null and v_recurrence.is_recipe and p_title is null
      and (p_recipe_id is null or p_recipe_id = v_recurrence.recipe_id);
    if not v_keep_recipe and not private.valid_meal_content(p_recipe_id, p_title, p_notes, p_servings) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_keep_recipe and ((p_notes is not null and not private.is_plain_text(p_notes, 1000))
        or (p_servings is not null and p_servings not between 1 and 99)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_recurrence.id is null then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    select * into v_series from private.meal_series s where s.id = v_recurrence.series_id;
    if not private.meal_may(v_series.owner_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(v_series.owner_home_id, v_user_id);
    select * into v_exception from private.meal_occurrence_exceptions e
      where e.recurrence_id = p_recurrence_id and e.on_date = p_on;
    if v_exception.recurrence_id is not null then
      if v_exception.kind = 'detached' and v_exception.entry_id = p_entry_id then
        return query select 'exists', (select e.revision from private.meal_entries e where e.id = p_entry_id),
          null::jsonb;
      else
        return query select 'not_found', null::integer, null::jsonb;
      end if;
      return;
    end if;
    if not private.meal_occurrence_live(v_recurrence, p_on) then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    if exists (select 1 from private.meal_entries e where e.id = p_entry_id) then
      return query select 'id_taken', null::integer, null::jsonb;
      return;
    end if;
    if p_slot_id <> v_recurrence.slot_id
       and not private.meal_slot_open(p_slot_id, v_series.owner_home_id, v_user_id) then
      return query select 'slot_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if not v_keep_recipe and p_recipe_id is not null
       and p_recipe_id is distinct from v_recurrence.recipe_id
       and not private.meal_recipe_visible(p_recipe_id, v_series.owner_home_id, v_user_id) then
      return query select 'recipe_unavailable', null::integer, null::jsonb;
      return;
    end if;
    v_occupied := private.meal_place(v_series.owner_home_id, v_user_id, p_new_on, p_slot_id, p_replace,
      null, p_recurrence_id, p_on);
    if v_occupied is not null then
      return query select 'occupied', null::integer, v_occupied;
      return;
    end if;
    insert into private.meal_entries (
      id, owner_user_id, owner_home_id, on_date, slot_id, recipe_id, is_recipe, title, notes, servings,
      origin_recurrence_id, origin_on, created_by, updated_by
    ) values (
      p_entry_id, v_series.owner_user_id, v_series.owner_home_id, p_new_on, p_slot_id,
      case when v_keep_recipe then v_recurrence.recipe_id else p_recipe_id end,
      v_keep_recipe or p_recipe_id is not null,
      case when v_keep_recipe or p_recipe_id is not null then null else pg_catalog.btrim(p_title) end,
      p_notes, case when v_keep_recipe or p_recipe_id is not null then p_servings end,
      p_recurrence_id, p_on, v_user_id, v_user_id
    );
    insert into private.meal_occurrence_exceptions (recurrence_id, on_date, kind, entry_id, created_by)
      values (p_recurrence_id, p_on, 'detached', p_entry_id, v_user_id);
    return query select 'saved', 1, null::jsonb;
  end
  $$;

-- Removes one occurrence (people who may edit the plan); the series continues. Idempotent. Outcomes:
-- 'skipped', 'not_found', 'not_permitted'.
create function public.skip_meal_occurrence(p_recurrence_id uuid, p_on date) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recurrence private.meal_recurrences;
    v_series private.meal_series;
  begin
    if p_recurrence_id is null or not private.is_meal_date(p_on) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recurrence := private.meal_recurrence_for(p_recurrence_id, v_user_id);
    if v_recurrence.id is null then
      return 'not_found';
    end if;
    select * into v_series from private.meal_series s where s.id = v_recurrence.series_id;
    if not private.meal_may(v_series.owner_home_id, v_user_id, 'edit') then
      return 'not_permitted';
    end if;
    perform private.lock_meal_context(v_series.owner_home_id, v_user_id);
    if exists (select 1 from private.meal_occurrence_exceptions e
        where e.recurrence_id = p_recurrence_id and e.on_date = p_on and e.kind = 'skipped') then
      return 'skipped';
    end if;
    if not private.meal_occurrence_live(v_recurrence, p_on) then
      return 'not_found';
    end if;
    insert into private.meal_occurrence_exceptions (recurrence_id, on_date, kind, created_by)
      values (p_recurrence_id, p_on, 'skipped', v_user_id);
    return 'skipped';
  end
  $$;

-- Undoes a skip (people who may edit the plan), if nothing was placed there meanwhile. Outcomes:
-- 'restored', 'occupied' (with what is there now), 'not_found', 'not_permitted'.
create function public.restore_meal_occurrence(p_recurrence_id uuid, p_on date)
returns table (outcome text, occupied jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recurrence private.meal_recurrences;
    v_series private.meal_series;
    v_occupants jsonb;
  begin
    if p_recurrence_id is null or not private.is_meal_date(p_on) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_recurrence := private.meal_recurrence_for(p_recurrence_id, v_user_id);
    if v_recurrence.id is null then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    select * into v_series from private.meal_series s where s.id = v_recurrence.series_id;
    if not private.meal_may(v_series.owner_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(v_series.owner_home_id, v_user_id);
    if not exists (select 1 from private.meal_occurrence_exceptions e
        where e.recurrence_id = p_recurrence_id and e.on_date = p_on and e.kind = 'skipped') then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    v_occupants := private.meal_occupants(v_series.owner_home_id, v_user_id, p_on, v_recurrence.slot_id);
    if pg_catalog.jsonb_array_length(v_occupants) > 0 then
      return query select 'occupied', pg_catalog.jsonb_build_object('occupants', v_occupants,
        'replaceKey', private.meal_occupants_key(v_occupants));
      return;
    end if;
    delete from private.meal_occurrence_exceptions e
      where e.recurrence_id = p_recurrence_id and e.on_date = p_on and e.kind = 'skipped';
    return query select 'restored', null::jsonb;
  end
  $$;

-- Series ---------------------------------------------------------------------------------------------

-- The collisions a schedule would have in a context from p_start (until its end or 366 days on): the
-- dates where it has an occurrence and something else is planned in the slot, with what is there. A
-- series being changed (p_series) never collides with its own occurrences, and dates where it already
-- has an exception (kept by the change) are left out.
create function private.meal_collisions(
  p_home_id uuid, p_user_id uuid, p_slot_id uuid, p_cadence text, p_weekdays smallint[],
  p_start date, p_end date, p_series uuid default null
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  with candidate as (
    select d::date as on_date
    from pg_catalog.generate_series(p_start::timestamp,
      least(coalesce(p_end, p_start + private.meal_limit('horizon_days') - 1),
        p_start + private.meal_limit('horizon_days') - 1)::timestamp, interval '1 day') d
    where (p_cadence = 'daily' or extract(isodow from d)::smallint = any (p_weekdays))
      and not exists (select 1 from private.meal_occurrence_exceptions e
        join private.meal_recurrences r on r.id = e.recurrence_id
        where r.series_id = p_series and e.on_date = d::date)
  ), hits as (
    select c.on_date, private.meal_occupants(p_home_id, p_user_id, c.on_date, p_slot_id,
      null, null, null, p_series) as occupants
    from candidate c
    -- Only dates where something is planned in the slot at all (cheap test first).
    where exists (select 1 from private.meal_entries e
        where e.slot_id = p_slot_id and e.on_date = c.on_date and e.deleted_at is null)
      or exists (select 1 from private.meal_recurrences r
        where r.slot_id = p_slot_id and r.series_id is distinct from p_series
          and private.meal_occurs(r, c.on_date))
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'date', h.on_date, 'occupants', h.occupants, 'replaceKey', private.meal_occupants_key(h.occupants))
    order by h.on_date), '[]'::jsonb)
  from hits h where pg_catalog.jsonb_array_length(h.occupants) > 0;
  $$;

-- A fingerprint of collisions, for a series change that must not act on a stale preview.
create function private.meal_collisions_key(p_collisions jsonb) returns text
  language sql immutable set search_path = '' as $$
  select pg_catalog.md5(coalesce(pg_catalog.string_agg((x ->> 'date') || ':' || (x ->> 'replaceKey'), ';'
    order by x ->> 'date'), ''))
  from pg_catalog.jsonb_array_elements(coalesce(p_collisions, '[]'::jsonb)) x;
  $$;

-- The next occurrence dates of a schedule from a date (at most three), for previews.
create function private.meal_next_dates(
  p_cadence text, p_weekdays smallint[], p_start date, p_end date, p_count integer
) returns jsonb
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(x.d order by x.d), '[]'::jsonb) from (
    select d::date as d
    from pg_catalog.generate_series(p_start::timestamp,
      least(coalesce(p_end, p_start + 13), p_start + 13)::timestamp, interval '1 day') d
    where p_cadence = 'daily' or extract(isodow from d)::smallint = any (p_weekdays)
    order by d limit p_count
  ) x;
  $$;

-- Applies the caller's choice for each collision of a series change: 'skip' (the new occurrence on
-- that date is skipped) or 'replace' (what is there is removed). Every collision needs a choice.
-- Returns false when one is missing or unknown.
create function private.meal_apply_decisions(
  p_home_id uuid, p_user_id uuid, p_recurrence_id uuid, p_collisions jsonb, p_decisions jsonb
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_collision jsonb;
    v_choice text;
  begin
    for v_collision in select * from pg_catalog.jsonb_array_elements(coalesce(p_collisions, '[]'::jsonb)) loop
      v_choice := coalesce(p_decisions, '{}'::jsonb) ->> (v_collision ->> 'date');
      if v_choice = 'skip' then
        insert into private.meal_occurrence_exceptions (recurrence_id, on_date, kind, created_by)
          values (p_recurrence_id, (v_collision ->> 'date')::date, 'skipped', p_user_id)
          on conflict do nothing;
      elsif v_choice = 'replace' then
        perform private.meal_clear_occupants(p_home_id, p_user_id, v_collision -> 'occupants');
      else
        return false;
      end if;
    end loop;
    return true;
  end
  $$;

-- What a new schedule would do, before it is saved (people who may edit the plan): the next three
-- dates and the collisions to decide, with the token the save sends back. p_series names a series
-- being changed from p_start on (edit "this and future", resume). Outcomes: 'ok' (with the preview),
-- 'slot_unavailable', 'invalid_date' (a start before today, or an end before the start),
-- 'not_found' (p_series), 'not_permitted'. 22023 for a malformed schedule.
create function public.preview_meal_series(
  p_slot_id uuid, p_cadence text, p_weekdays smallint[], p_start_on date,
  p_home_id uuid default null, p_end_on date default null, p_series_id uuid default null,
  p_today date default null
) returns table (outcome text, preview jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_collisions jsonb;
  begin
    -- An empty weekday list is how a daily schedule arrives from the generated bindings.
    if p_weekdays = '{}'::smallint[] then
      p_weekdays := null;
    end if;
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_slot_id is null or not private.valid_meal_cadence(p_cadence, p_weekdays)
       or not private.is_meal_date(p_start_on) or (p_end_on is not null and not private.is_meal_date(p_end_on)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    if p_series_id is not null and not exists (select 1 from private.meal_series s
        where s.id = p_series_id and s.status <> 'ended'
          and private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, v_user_id)) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    if p_start_on < private.meal_today(p_home_id, p_today) or (p_end_on is not null and p_end_on < p_start_on) then
      return query select 'invalid_date', null::jsonb;
      return;
    end if;
    if not private.meal_slot_open(p_slot_id, p_home_id, v_user_id) then
      return query select 'slot_unavailable', null::jsonb;
      return;
    end if;
    v_collisions := private.meal_collisions(p_home_id, v_user_id, p_slot_id, p_cadence, p_weekdays,
      p_start_on, p_end_on, p_series_id);
    return query select 'ok', pg_catalog.jsonb_build_object(
      'nextDates', private.meal_next_dates(p_cadence, p_weekdays, p_start_on, p_end_on, 3),
      'collisions', v_collisions, 'token', private.meal_collisions_key(v_collisions));
  end
  $$;

-- Starts a repeating meal (people who may edit the plan), from today or later. The collisions are
-- recomputed: a token that no longer matches answers 'conflicts' with the current ones (nothing
-- saved); otherwise each collision needs a choice in p_decisions ({"YYYY-MM-DD": "skip"|"replace"}).
-- Outcomes: 'created', 'exists' (a retry of the caller's own create), 'id_taken', 'conflicts',
-- 'limit_reached', 'slot_unavailable', 'recipe_unavailable', 'invalid_date', 'not_permitted'. 22023
-- for invalid fields.
create function public.create_meal_series(
  p_id uuid, p_slot_id uuid, p_cadence text, p_weekdays smallint[], p_start_on date, p_token text,
  p_home_id uuid default null, p_end_on date default null, p_recipe_id uuid default null,
  p_title text default null, p_notes text default null, p_servings integer default null,
  p_decisions jsonb default null, p_today date default null
) returns table (outcome text, revision integer, collisions jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.meal_series;
    v_collisions jsonb;
    v_recurrence_id uuid := gen_random_uuid();
  begin
    -- An empty weekday list is how a daily schedule arrives from the generated bindings.
    if p_weekdays = '{}'::smallint[] then
      p_weekdays := null;
    end if;
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_id is null or p_slot_id is null or not private.valid_meal_cadence(p_cadence, p_weekdays)
       or not private.is_meal_date(p_start_on) or (p_end_on is not null and not private.is_meal_date(p_end_on))
       or not private.valid_meal_content(p_recipe_id, p_title, p_notes, p_servings)
       or (p_decisions is not null and pg_catalog.jsonb_typeof(p_decisions) <> 'object') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(p_home_id, v_user_id);
    select * into v_existing from private.meal_series s where s.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.in_meal_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists', v_existing.revision, null::jsonb;
      else
        return query select 'id_taken', null::integer, null::jsonb;
      end if;
      return;
    end if;
    if p_start_on < private.meal_today(p_home_id, p_today) or (p_end_on is not null and p_end_on < p_start_on) then
      return query select 'invalid_date', null::integer, null::jsonb;
      return;
    end if;
    if not private.meal_slot_open(p_slot_id, p_home_id, v_user_id) then
      return query select 'slot_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if p_recipe_id is not null and not private.meal_recipe_visible(p_recipe_id, p_home_id, v_user_id) then
      return query select 'recipe_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if (select count(*) from private.meal_series s
        where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, v_user_id)
          and s.status <> 'ended') >= private.meal_limit('series') then
      return query select 'limit_reached', null::integer, null::jsonb;
      return;
    end if;
    v_collisions := private.meal_collisions(p_home_id, v_user_id, p_slot_id, p_cadence, p_weekdays,
      p_start_on, p_end_on, null);
    if p_token is distinct from private.meal_collisions_key(v_collisions) then
      return query select 'conflicts', null::integer, v_collisions;
      return;
    end if;
    insert into private.meal_series (id, owner_user_id, owner_home_id, end_on, created_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_end_on, v_user_id);
    insert into private.meal_recurrences (
      id, series_id, slot_id, recipe_id, is_recipe, title, notes, servings, cadence, weekdays,
      start_on, end_on, created_by
    ) values (
      v_recurrence_id, p_id, p_slot_id, p_recipe_id, p_recipe_id is not null,
      case when p_recipe_id is null then pg_catalog.btrim(p_title) end, p_notes, p_servings,
      p_cadence, p_weekdays, p_start_on, p_end_on, v_user_id
    );
    if not private.meal_apply_decisions(p_home_id, v_user_id, v_recurrence_id, v_collisions, p_decisions) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.audit_meals('meal_series.created', p_home_id, p_id);
    return query select 'created', 1, null::jsonb;
  end
  $$;

-- Ends every segment of a series by p_cut (inclusive), never before its own start (an empty stretch).
create function private.meal_cut_series(p_series_id uuid, p_cut date) returns void
  language sql volatile security definer set search_path = '' as $$
  update private.meal_recurrences r
    set end_on = greatest(least(coalesce(r.end_on, p_cut), p_cut), r.start_on - 1)
    where r.series_id = p_series_id;
  $$;

-- The last day a series still has occurrences on, before a resume (null: none at all).
create function private.meal_series_last_day(p_series_id uuid) returns date
  language sql stable security definer set search_path = '' as $$
  select max(r.end_on) from private.meal_recurrences r
  where r.series_id = p_series_id and r.end_on >= r.start_on;
  $$;

-- Moves a series' exceptions from p_from on to its new segment p_new, where that segment has the day
-- (an edited or moved occurrence stays where it is and is never planned twice; a skipped one stays
-- skipped), with the meals that came from them. Used by edit_future and resume, so a pause never
-- brings back what was skipped or edited.
create function private.meal_adopt_exceptions(p_series_id uuid, p_new uuid, p_from date) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_new private.meal_recurrences;
  begin
    select * into v_new from private.meal_recurrences r where r.id = p_new;
    update private.meal_entries e set origin_recurrence_id = p_new
      from private.meal_occurrence_exceptions x
      join private.meal_recurrences r on r.id = x.recurrence_id
      where r.series_id = p_series_id and r.id <> p_new and x.on_date >= p_from and x.kind = 'detached'
        and e.id = x.entry_id and private.meal_occurs(v_new, x.on_date);
    update private.meal_occurrence_exceptions x set recurrence_id = p_new
      from private.meal_recurrences r
      where r.id = x.recurrence_id and r.series_id = p_series_id and r.id <> p_new and x.on_date >= p_from
        and private.meal_occurs(v_new, x.on_date);
  end
  $$;

-- Changes a series (people who may edit the plan), from the revision the caller saw:
-- - 'edit_future' from p_from (today or later, an active series): new content and schedule from that
--   date in a new segment; every earlier stretch ends the day before, so the past is never rewritten.
--   Exceptions on later dates move to the new segment where it still has that day; stretches that had
--   not started are dropped.
-- - 'pause': no occurrences after today (today's stays).
-- - 'resume' from p_from (after the last remaining occurrence and not before today): the latest
--   details continue to the chosen end date; later exceptions move to the new segment as for edit_future.
-- - 'end' from p_from (today or later): no occurrences from that date on.
-- edit_future and resume recompute collisions as create does (p_token, p_decisions). Outcomes: 'saved'
-- (with the new revision), 'conflict' (with the current one), 'conflicts', 'slot_unavailable',
-- 'recipe_unavailable', 'invalid_date', 'not_found', 'not_permitted'. 22023 for invalid fields.
create function public.update_meal_series(
  p_id uuid, p_expected_revision integer, p_action text, p_from date default null,
  p_token text default null, p_decisions jsonb default null, p_slot_id uuid default null,
  p_cadence text default null, p_weekdays smallint[] default null, p_end_on date default null,
  p_recipe_id uuid default null, p_title text default null, p_notes text default null,
  p_servings integer default null, p_today date default null
) returns table (outcome text, revision integer, collisions jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.meal_series;
    v_current private.meal_recurrences;
    v_today date;
    v_collisions jsonb;
    v_new_id uuid := gen_random_uuid();
    v_keep_recipe boolean := false;
    v_recipe_id uuid;
    v_is_recipe boolean;
    v_last date;
  begin
    -- An empty weekday list is how a daily schedule arrives from the generated bindings.
    if p_weekdays = '{}'::smallint[] then
      p_weekdays := null;
    end if;
    if p_id is null or p_expected_revision is null
       or p_action is null or p_action not in ('edit_future', 'pause', 'resume', 'end')
       or (p_action <> 'pause' and not private.is_meal_date(p_from))
       or (p_decisions is not null and pg_catalog.jsonb_typeof(p_decisions) <> 'object') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_series from private.meal_series s where s.id = p_id;
    if v_series.id is null or private.meal_access(v_series.owner_home_id, v_user_id) is null
       or (v_series.owner_user_id is not null and v_series.owner_user_id <> v_user_id) then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    if not private.meal_may(v_series.owner_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(v_series.owner_home_id, v_user_id);
    select * into v_series from private.meal_series s where s.id = p_id for update;
    -- The current segment: the one made last.
    select * into v_current from private.meal_recurrences r where r.series_id = p_id
      order by r.seq desc limit 1;
    if p_action = 'edit_future' then
      v_keep_recipe := v_current.is_recipe and p_title is null
        and (p_recipe_id is null or p_recipe_id = v_current.recipe_id);
      if p_slot_id is null or not private.valid_meal_cadence(p_cadence, p_weekdays)
         or (p_end_on is not null and not private.is_meal_date(p_end_on))
         or (not v_keep_recipe and not private.valid_meal_content(p_recipe_id, p_title, p_notes, p_servings))
         or (v_keep_recipe and ((p_notes is not null and not private.is_plain_text(p_notes, 1000))
           or (p_servings is not null and p_servings not between 1 and 99))) then
        raise exception 'invalid request' using errcode = '22023';
      end if;
    end if;
    if v_series.revision <> p_expected_revision then
      return query select 'conflict', v_series.revision, null::jsonb;
      return;
    end if;
    v_today := private.meal_today(v_series.owner_home_id, p_today);

    if p_action = 'pause' then
      if v_series.status <> 'active' then
        return query select 'invalid_date', null::integer, null::jsonb;
        return;
      end if;
      perform private.meal_cut_series(p_id, v_today);
      update private.meal_series s set status = 'paused', revision = s.revision + 1, updated_at = pg_catalog.now()
        where s.id = p_id returning s.revision into v_series.revision;
      perform private.audit_meals('meal_series.paused', v_series.owner_home_id, p_id);
      return query select 'saved', v_series.revision, null::jsonb;
      return;
    end if;

    if p_action = 'end' then
      if v_series.status = 'ended' or p_from < v_today then
        return query select 'invalid_date', null::integer, null::jsonb;
        return;
      end if;
      perform private.meal_cut_series(p_id, p_from - 1);
      update private.meal_series s
        set status = 'ended', end_on = least(coalesce(s.end_on, p_from - 1), p_from - 1),
          revision = s.revision + 1, updated_at = pg_catalog.now()
        where s.id = p_id returning s.revision into v_series.revision;
      perform private.audit_meals('meal_series.ended', v_series.owner_home_id, p_id);
      return query select 'saved', v_series.revision, null::jsonb;
      return;
    end if;

    if p_action = 'resume' then
      v_last := private.meal_series_last_day(p_id);
      if v_series.status <> 'paused' or p_from < v_today or (v_last is not null and p_from <= v_last)
         or (v_series.end_on is not null and p_from > v_series.end_on) then
        return query select 'invalid_date', null::integer, null::jsonb;
        return;
      end if;
      if not private.meal_slot_open(v_current.slot_id, v_series.owner_home_id, v_user_id) then
        return query select 'slot_unavailable', null::integer, null::jsonb;
        return;
      end if;
      v_collisions := private.meal_collisions(v_series.owner_home_id, v_user_id, v_current.slot_id,
        v_current.cadence, v_current.weekdays, p_from, v_series.end_on, p_id);
      if p_token is distinct from private.meal_collisions_key(v_collisions) then
        return query select 'conflicts', null::integer, v_collisions;
        return;
      end if;
      insert into private.meal_recurrences (
        id, series_id, slot_id, recipe_id, is_recipe, title, notes, servings, cadence, weekdays,
        start_on, end_on, created_by
      ) values (
        v_new_id, p_id, v_current.slot_id, v_current.recipe_id, v_current.is_recipe, v_current.title,
        v_current.notes, v_current.servings, v_current.cadence, v_current.weekdays, p_from,
        v_series.end_on, v_user_id
      );
      -- Occurrences skipped or edited while it was paused stay that way (they are not collisions).
      perform private.meal_adopt_exceptions(p_id, v_new_id, p_from);
      if not private.meal_apply_decisions(v_series.owner_home_id, v_user_id, v_new_id, v_collisions, p_decisions) then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      update private.meal_series s set status = 'active', revision = s.revision + 1, updated_at = pg_catalog.now()
        where s.id = p_id returning s.revision into v_series.revision;
      perform private.audit_meals('meal_series.resumed', v_series.owner_home_id, p_id);
      return query select 'saved', v_series.revision, null::jsonb;
      return;
    end if;

    -- edit_future
    if v_series.status <> 'active' or p_from < v_today
       or (v_series.end_on is not null and p_from > v_series.end_on)
       or (p_end_on is not null and p_end_on < p_from) then
      return query select 'invalid_date', null::integer, null::jsonb;
      return;
    end if;
    if not private.meal_slot_open(p_slot_id, v_series.owner_home_id, v_user_id) then
      return query select 'slot_unavailable', null::integer, null::jsonb;
      return;
    end if;
    if not v_keep_recipe and p_recipe_id is not null and p_recipe_id is distinct from v_current.recipe_id
       and not private.meal_recipe_visible(p_recipe_id, v_series.owner_home_id, v_user_id) then
      return query select 'recipe_unavailable', null::integer, null::jsonb;
      return;
    end if;
    v_collisions := private.meal_collisions(v_series.owner_home_id, v_user_id, p_slot_id, p_cadence,
      p_weekdays, p_from, p_end_on, p_id);
    if p_token is distinct from private.meal_collisions_key(v_collisions) then
      return query select 'conflicts', null::integer, v_collisions;
      return;
    end if;
    v_recipe_id := case when v_keep_recipe then v_current.recipe_id else p_recipe_id end;
    v_is_recipe := v_keep_recipe or p_recipe_id is not null;
    insert into private.meal_recurrences (
      id, series_id, slot_id, recipe_id, is_recipe, title, notes, servings, cadence, weekdays,
      start_on, end_on, created_by
    ) values (
      v_new_id, p_id, p_slot_id, v_recipe_id, v_is_recipe,
      case when v_is_recipe then null else pg_catalog.btrim(p_title) end, p_notes,
      case when v_is_recipe then p_servings end, p_cadence, p_weekdays, p_from, p_end_on, v_user_id
    );
    perform private.meal_adopt_exceptions(p_id, v_new_id, p_from);
    update private.meal_recurrences r
      set end_on = greatest(least(coalesce(r.end_on, p_from - 1), p_from - 1), r.start_on - 1)
      where r.series_id = p_id and r.id <> v_new_id;
    -- Stretches that had not started yet are replaced entirely.
    delete from private.meal_recurrences r where r.series_id = p_id and r.id <> v_new_id and r.start_on >= p_from;
    if not private.meal_apply_decisions(v_series.owner_home_id, v_user_id, v_new_id, v_collisions, p_decisions) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    update private.meal_series s set end_on = p_end_on, revision = s.revision + 1, updated_at = pg_catalog.now()
      where s.id = p_id returning s.revision into v_series.revision;
    perform private.audit_meals('meal_series.changed', v_series.owner_home_id, p_id);
    return query select 'saved', v_series.revision, null::jsonb;
  end
  $$;

-- Slots and settings ----------------------------------------------------------------------------------

-- Whether a slot name is free in a context: no other slot's stored name, and no unrenamed standard
-- slot's en or nl name, reads the same.
create function private.meal_slot_name_free(
  p_home_id uuid, p_user_id uuid, p_name text, p_except uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from private.meal_slots s
    where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, p_user_id)
      and s.id is distinct from p_except
      and (
        (s.name is not null and private.recipe_fold(s.name) = private.recipe_fold(p_name))
        or (s.name is null and exists (select 1 from unnest(private.meal_standard_names(s.standard_key)) n
          where private.recipe_fold(n) = private.recipe_fold(p_name)))
      )
  );
  $$;

-- Adds a custom slot at the end (meal managers). Outcomes: 'created', 'exists' (a retry), 'id_taken',
-- 'name_taken', 'limit_reached', 'not_permitted'. 22023 for an invalid name.
create function public.create_meal_slot(p_id uuid, p_name text, p_home_id uuid default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.meal_slots;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_id is null or p_name is null or not private.is_visible_name(p_name, private.meal_limit('slot_name'))
       or pg_catalog.btrim(p_name) = '' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    perform private.ensure_meal_slots(p_home_id, v_user_id);
    perform private.lock_meal_context(p_home_id, v_user_id);
    select * into v_existing from private.meal_slots s where s.id = p_id;
    if found then
      if private.in_meal_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id)
         and v_existing.name = pg_catalog.btrim(p_name) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if (select count(*) from private.meal_slots s
        where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, v_user_id))
        >= private.meal_limit('slots') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    if not private.meal_slot_name_free(p_home_id, v_user_id, pg_catalog.btrim(p_name), null) then
      return query select 'name_taken', null::integer;
      return;
    end if;
    insert into private.meal_slots (id, owner_user_id, owner_home_id, name, position)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, pg_catalog.btrim(p_name),
        coalesce((select max(s.position) + 1 from private.meal_slots s
          where private.in_meal_context(s.owner_user_id, s.owner_home_id, p_home_id, v_user_id)), 0));
    perform private.audit_meals('meal_slot.created', p_home_id, p_id);
    return query select 'created', 1;
  end
  $$;

-- Loads a slot of a context the caller is a member of (null otherwise).
create function private.meal_slot_for(p_slot_id uuid, p_user_id uuid) returns private.meal_slots
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_slot private.meal_slots;
  begin
    select * into v_slot from private.meal_slots s where s.id = p_slot_id;
    if v_slot.id is null or private.meal_access(v_slot.owner_home_id, p_user_id) is null
       or (v_slot.owner_user_id is not null and v_slot.owner_user_id <> p_user_id) then
      return null;
    end if;
    return v_slot;
  end
  $$;

-- What disabling a slot affects: planned meals from today on and earlier ones (concrete), and series
-- that have not ended in it, with a token the disable sends back.
create function private.meal_slot_impact_json(p_slot private.meal_slots, p_today date) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'futureMeals', future_meals, 'pastMeals', past_meals, 'series', series,
    'token', pg_catalog.md5(p_slot.id::text || ':' || p_slot.revision::text || ':' || future_meals || ':'
      || past_meals || ':' || series)
  ) from (select
    (select count(*) from private.meal_entries e
      where e.slot_id = p_slot.id and e.deleted_at is null and e.on_date >= p_today) as future_meals,
    (select count(*) from private.meal_entries e
      where e.slot_id = p_slot.id and e.deleted_at is null and e.on_date < p_today) as past_meals,
    (select count(distinct s.id) from private.meal_series s
      join private.meal_recurrences r on r.series_id = s.id
      where r.slot_id = p_slot.id and s.status <> 'ended'
        and (r.end_on is null or r.end_on >= p_today)) as series
  ) counts;
  $$;

-- What disabling a slot would affect (anyone who may see the plan). Outcomes: 'ok' (with the impact),
-- 'not_found'.
create function public.meal_slot_impact(p_slot_id uuid, p_today date default null)
returns table (outcome text, impact jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_slot private.meal_slots;
  begin
    if p_slot_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_slot := private.meal_slot_for(p_slot_id, v_user_id);
    if v_slot.id is null then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    return query select 'ok', private.meal_slot_impact_json(v_slot, private.meal_today(v_slot.owner_home_id, p_today));
  end
  $$;

-- Renames a slot (null name: back to the standard name, standard slots only), disables or enables it
-- (meal managers), from the revision the caller saw. Disabling a slot that holds meals or series needs
-- the impact token: without a matching one 'impact_required' with the impact (nothing changed). Nothing
-- is deleted or moved. Outcomes: 'saved' (with the new revision), 'conflict', 'name_taken',
-- 'impact_required', 'not_found', 'not_permitted'. 22023 for an invalid name.
create function public.update_meal_slot(
  -- p_name and p_enabled default to null only so a null name (the standard one) can be omitted; a
  -- missing p_enabled is refused below.
  p_slot_id uuid, p_expected_revision integer, p_name text default null, p_enabled boolean default null,
  p_impact_token text default null, p_today date default null
) returns table (outcome text, revision integer, impact jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_slot private.meal_slots;
    v_name text := pg_catalog.btrim(p_name);
    v_impact jsonb;
  begin
    if p_slot_id is null or p_expected_revision is null or p_enabled is null
       or (p_name is not null and (not private.is_visible_name(p_name, private.meal_limit('slot_name')) or v_name = '')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_slot := private.meal_slot_for(p_slot_id, v_user_id);
    if v_slot.id is null then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    if p_name is null and v_slot.standard_key is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(v_slot.owner_home_id, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(v_slot.owner_home_id, v_user_id);
    select * into v_slot from private.meal_slots s where s.id = p_slot_id for update;
    if v_slot.revision <> p_expected_revision then
      return query select 'conflict', v_slot.revision, null::jsonb;
      return;
    end if;
    if v_name is not null and v_name is distinct from v_slot.name
       and not private.meal_slot_name_free(v_slot.owner_home_id, v_user_id, v_name, v_slot.id) then
      return query select 'name_taken', null::integer, null::jsonb;
      return;
    end if;
    if v_slot.enabled and not p_enabled then
      v_impact := private.meal_slot_impact_json(v_slot, private.meal_today(v_slot.owner_home_id, p_today));
      if ((v_impact ->> 'futureMeals')::integer > 0 or (v_impact ->> 'pastMeals')::integer > 0
          or (v_impact ->> 'series')::integer > 0)
         and p_impact_token is distinct from v_impact ->> 'token' then
        return query select 'impact_required', null::integer, v_impact;
        return;
      end if;
    end if;
    update private.meal_slots s set name = v_name, enabled = p_enabled, revision = s.revision + 1
      where s.id = v_slot.id returning s.revision into v_slot.revision;
    perform private.audit_meals('meal_slot.updated', v_slot.owner_home_id, v_slot.id,
      pg_catalog.jsonb_build_object('enabled', p_enabled));
    return query select 'saved', v_slot.revision, null::jsonb;
  end
  $$;

-- Moves a slot one place up or down (meal managers), under the context lock. Outcomes: 'saved',
-- 'unchanged' (already first or last), 'not_found', 'not_permitted'.
create function public.move_meal_slot(p_slot_id uuid, p_direction text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_slot private.meal_slots;
    v_ids uuid[];
    v_index integer;
    v_other integer;
  begin
    if p_slot_id is null or p_direction is null or p_direction not in ('up', 'down') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_slot := private.meal_slot_for(p_slot_id, v_user_id);
    if v_slot.id is null then
      return 'not_found';
    end if;
    if not private.meal_may(v_slot.owner_home_id, v_user_id, 'manage') then
      return 'not_permitted';
    end if;
    perform private.lock_meal_context(v_slot.owner_home_id, v_user_id);
    select array_agg(s.id order by s.position, s.created_at, s.id) into v_ids from private.meal_slots s
      where private.in_meal_context(s.owner_user_id, s.owner_home_id, v_slot.owner_home_id, v_user_id);
    v_index := array_position(v_ids, v_slot.id);
    v_other := case p_direction when 'up' then v_index - 1 else v_index + 1 end;
    if v_other < 1 or v_other > cardinality(v_ids) then
      return 'unchanged';
    end if;
    -- Renumber the whole order with the two swapped, so equal or sparse positions never matter.
    update private.meal_slots s
      set position = case when x.ord = v_index then v_other when x.ord = v_other then v_index else x.ord end - 1,
        revision = s.revision + 1
      from unnest(v_ids) with ordinality as x (id, ord)
      where s.id = x.id;
    return 'saved';
  end
  $$;

-- Sets a Home planner's member access (meal managers): 'edit' (members plan meals) or 'view'.
-- Outcomes: 'saved' (with the new revision), 'conflict' (with the current one), 'not_permitted'.
create function public.update_meal_settings(p_home_id uuid, p_expected_revision integer, p_member_access text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_current integer;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_home_id is null or p_expected_revision is null or p_member_access is null
       or p_member_access not in ('edit', 'view') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    perform private.lock_meal_context(p_home_id, v_user_id);
    v_current := coalesce((select s.revision from private.meal_settings s where s.home_id = p_home_id), 0);
    if v_current <> p_expected_revision then
      return query select 'conflict', v_current;
      return;
    end if;
    insert into private.meal_settings as s (home_id, member_access, updated_by)
      values (p_home_id, p_member_access, v_user_id)
      on conflict (home_id) do update
        set member_access = excluded.member_access, revision = s.revision + 1,
          updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    perform private.audit_meals('meal_settings.updated', p_home_id, p_home_id,
      pg_catalog.jsonb_build_object('memberAccess', p_member_access));
    return query select 'saved', v_current + 1;
  end
  $$;

-- Copy week -----------------------------------------------------------------------------------------

-- The rows a week copy would make: every concrete meal and computed occurrence of the 7 source days,
-- mapped to the same weekday and slot of the destination week, with its status ('ok', 'unavailable':
-- a recipe not visible from the context now, 'slot_disabled') and what occupies the destination
-- (except meals with the ids in p_own, a retry's own copies). Row keys: 'e:<meal id>' or
-- 'o:<segment id>:<date>'.
create function private.meal_copy_rows(
  p_home_id uuid, p_user_id uuid, p_source date, p_destination date, p_own uuid[]
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  with source as (
    select 'e:' || e.id::text as key, e.on_date, e.slot_id, e.recipe_id, e.is_recipe, e.title, e.notes,
      e.servings, e.revision::text as version
    from private.meal_entries e
    where private.in_meal_context(e.owner_user_id, e.owner_home_id, p_home_id, p_user_id)
      and e.deleted_at is null and e.on_date between p_source and p_source + 6
    union all
    select 'o:' || r.id::text || ':' || o.on_date::text, o.on_date, r.slot_id, r.recipe_id, r.is_recipe,
      r.title, r.notes, r.servings, s.revision::text
    from private.meal_occurrences(p_home_id, p_user_id, p_source, p_source + 6) o
    join private.meal_recurrences r on r.id = o.recurrence_id
    join private.meal_series s on s.id = r.series_id
  ), mapped as (
    select x.*, x.on_date + (p_destination - p_source) as dest_on, sl.enabled as slot_enabled,
      case when x.is_recipe then x.recipe_id is not null
        and private.meal_recipe_visible(x.recipe_id, p_home_id, p_user_id) else true end as visible
    from source x join private.meal_slots sl on sl.id = x.slot_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', m.key, 'version', m.version, 'sourceDate', m.on_date, 'date', m.dest_on, 'slotId', m.slot_id,
      'type', case when m.is_recipe then 'recipe' else 'custom' end,
      'recipe', case when m.is_recipe and m.visible
        then private.meal_recipe_json(m.recipe_id, p_home_id, p_user_id) end,
      'title', m.title, 'notes', m.notes, 'servings', m.servings,
      'repeating', m.key like 'o:%',
      'status', case when not m.visible then 'unavailable' when not m.slot_enabled then 'slot_disabled' else 'ok' end,
      'occupants', occ.list, 'replaceKey', private.meal_occupants_key(occ.list)
    ) order by m.on_date, m.slot_id, m.key), '[]'::jsonb)
  from mapped m
  cross join lateral (
    select coalesce(pg_catalog.jsonb_agg(item), '[]'::jsonb) as list
    from pg_catalog.jsonb_array_elements(
      private.meal_occupants(p_home_id, p_user_id, m.dest_on, m.slot_id)) item
    where not (item ->> 'kind' = 'entry' and (item ->> 'id')::uuid = any (coalesce(p_own, '{}')))
  ) occ;
  $$;

create function private.meal_copy_token(p_rows jsonb) returns text
  language sql immutable set search_path = '' as $$
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
    (x ->> 'key') || '.' || (x ->> 'version') || '.' || (x ->> 'status') || '.' || (x ->> 'replaceKey'), ';'
    order by x ->> 'key'), ''))
  from pg_catalog.jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x;
  $$;

-- Previews copying one week to another of the same context (people who may edit the plan): the source
-- and destination start dates are 7 days apart or more, a whole number of weeks. Outcomes: 'ok' (with
-- rows and token), 'not_permitted'. 22023 for malformed weeks.
create function public.preview_meal_copy(p_source date, p_destination date, p_home_id uuid default null)
returns table (outcome text, preview jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_rows jsonb;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if not private.is_meal_date(p_source) or not private.is_meal_date(p_destination)
       or p_source = p_destination or (p_destination - p_source) % 7 <> 0 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    perform private.ensure_meal_slots(p_home_id, v_user_id);
    v_rows := private.meal_copy_rows(p_home_id, v_user_id, p_source, p_destination, null);
    return query select 'ok', pg_catalog.jsonb_build_object('rows', v_rows, 'token', private.meal_copy_token(v_rows));
  end
  $$;

-- Copies the chosen rows of a week preview (people who may edit the plan). p_rows: [{ "key": row key,
-- "id": client uuid of the copy, "replace": boolean }]; rows not sent are excluded. A preview token that
-- no longer matches answers 'stale' (nothing copied); a retry's own copies never count as a change.
-- Copies are standalone meals (never series). Per row: 'created', 'exists', 'id_taken', 'occupied'
-- (not replaced), 'unavailable', 'slot_unavailable', 'missing' (no such source row now). Outcomes:
-- 'done' (with the rows), 'stale', 'not_permitted'. 22023 for malformed input.
create function public.copy_meal_week(
  p_source date, p_destination date, p_token text, p_rows jsonb, p_home_id uuid default null
) returns table (outcome text, results jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_ids uuid[];
    v_rows jsonb;
    v_choice jsonb;
    v_row jsonb;
    v_id uuid;
    v_existing private.meal_entries;
    v_results jsonb := '[]'::jsonb;
    v_result text;
    v_occupants jsonb;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if not private.is_meal_date(p_source) or not private.is_meal_date(p_destination)
       or p_source = p_destination or (p_destination - p_source) % 7 <> 0
       or p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array'
       or pg_catalog.jsonb_array_length(p_rows) not between 1 and private.meal_limit('copy_rows')
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_rows) x
         where pg_catalog.jsonb_typeof(x) <> 'object'
           or coalesce(x ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or pg_catalog.jsonb_typeof(x -> 'key') is distinct from 'string'
           or coalesce(pg_catalog.jsonb_typeof(x -> 'replace'), 'boolean') <> 'boolean') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(p_home_id, v_user_id);
    select array_agg((x ->> 'id')::uuid) into v_ids from pg_catalog.jsonb_array_elements(p_rows) x;
    v_rows := private.meal_copy_rows(p_home_id, v_user_id, p_source, p_destination, v_ids);
    if p_token is distinct from private.meal_copy_token(v_rows) then
      return query select 'stale', null::jsonb;
      return;
    end if;
    for v_choice in select * from pg_catalog.jsonb_array_elements(p_rows) loop
      v_id := (v_choice ->> 'id')::uuid;
      select x into v_row from pg_catalog.jsonb_array_elements(v_rows) x where x ->> 'key' = v_choice ->> 'key';
      select * into v_existing from private.meal_entries e where e.id = v_id;
      v_result := case
        when v_existing.id is not null then
          case when v_existing.created_by = v_user_id and v_existing.deleted_at is null
            and private.in_meal_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id)
            then 'exists' else 'id_taken' end
        when v_row is null then 'missing'
        when v_row ->> 'status' = 'unavailable' then 'unavailable'
        when v_row ->> 'status' = 'slot_disabled' then 'slot_unavailable'
      end;
      if v_result is null then
        -- What is there now (unchanged since the preview, by the token, except this copy's own rows):
        -- a meal this copy just made is never replaced; anything else only when the row says so.
        v_occupants := private.meal_occupants(p_home_id, v_user_id, (v_row ->> 'date')::date,
          (v_row ->> 'slotId')::uuid);
        if pg_catalog.jsonb_array_length(v_occupants) > 0 then
          if not coalesce((v_choice ->> 'replace')::boolean, false) or exists (
              select 1 from pg_catalog.jsonb_array_elements(v_occupants) o
              where o ->> 'kind' = 'entry' and (o ->> 'id')::uuid = any (v_ids)) then
            v_result := 'occupied';
          else
            perform private.meal_clear_occupants(p_home_id, v_user_id, v_occupants);
          end if;
        end if;
      end if;
      if v_result is null then
        insert into private.meal_entries (
          id, owner_user_id, owner_home_id, on_date, slot_id, recipe_id, is_recipe, title, notes, servings,
          created_by, updated_by
        ) values (
          v_id, case when p_home_id is null then v_user_id end, p_home_id, (v_row ->> 'date')::date,
          (v_row ->> 'slotId')::uuid, (v_row -> 'recipe' ->> 'id')::uuid, v_row ->> 'type' = 'recipe',
          v_row ->> 'title', v_row ->> 'notes', (v_row ->> 'servings')::smallint, v_user_id, v_user_id
        );
        v_result := 'created';
      end if;
      v_results := v_results || pg_catalog.jsonb_build_object('key', v_choice ->> 'key', 'id', v_id, 'outcome', v_result);
      v_row := null;
      v_existing := null;
    end loop;
    perform private.audit_meals('meal_plan.week_copied', p_home_id, p_home_id, pg_catalog.jsonb_build_object(
      'source', p_source, 'destination', p_destination,
      'created', (select count(*) from pg_catalog.jsonb_array_elements(v_results) x where x ->> 'outcome' = 'created')));
    return query select 'done', v_results;
  end
  $$;

-- Ingredient transfer ---------------------------------------------------------------------------------

-- The meals of a date range as an ingredient transfer sees them: each concrete meal and computed
-- occurrence once (never skipped ones), with 'included' (a recipe visible from the context now, with its
-- ingredients and yield), 'custom' (no ingredients) or 'unavailable' (no details at all).
create function private.meal_transfer_meals(p_home_id uuid, p_user_id uuid, p_from date, p_to date)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  with meals as (
    select 'e:' || e.id::text as key, e.on_date, e.slot_id, e.recipe_id, e.is_recipe, e.title, e.servings,
      e.revision::text as version
    from private.meal_entries e
    where private.in_meal_context(e.owner_user_id, e.owner_home_id, p_home_id, p_user_id)
      and e.deleted_at is null and e.on_date between p_from and p_to
    union all
    select 'o:' || r.id::text || ':' || o.on_date::text, o.on_date, r.slot_id, r.recipe_id, r.is_recipe,
      r.title, r.servings, s.revision::text
    from private.meal_occurrences(p_home_id, p_user_id, p_from, p_to) o
    join private.meal_recurrences r on r.id = o.recurrence_id
    join private.meal_series s on s.id = r.series_id
  ), judged as (
    select m.*, case
        when not m.is_recipe then 'custom'
        when m.recipe_id is not null and private.meal_recipe_visible(m.recipe_id, p_home_id, p_user_id) then 'included'
        else 'unavailable' end as status
    from meals m
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', j.key, 'version', j.version, 'date', j.on_date, 'slotId', j.slot_id, 'status', j.status,
      'title', case when j.status = 'custom' then j.title end,
      'servings', case when j.status = 'included' then j.servings end,
      'recipe', case when j.status = 'included' then (
        select pg_catalog.jsonb_build_object('id', r.id, 'name', r.name, 'servings', r.servings,
          'revision', r.revision,
          'ingredients', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'position', i.position, 'name', i.name, 'quantityNum', i.quantity_num,
              'quantityDen', i.quantity_den, 'unit', i.unit, 'note', i.note) order by i.position)
            from private.recipe_ingredients i where i.recipe_id = r.id), '[]'::jsonb))
        from private.recipes r where r.id = j.recipe_id) end
    ) order by j.on_date, j.slot_id, j.key), '[]'::jsonb)
  from judged j;
  $$;

create function private.meal_transfer_token(p_meals jsonb) returns text
  language sql immutable set search_path = '' as $$
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
    (x ->> 'key') || '.' || (x ->> 'version') || '.' || (x ->> 'status') || '.'
      || coalesce(x -> 'recipe' ->> 'revision', ''), ';' order by x ->> 'key'), ''))
  from pg_catalog.jsonb_array_elements(coalesce(p_meals, '[]'::jsonb)) x;
  $$;

-- Previews collecting the ingredients of a date range (people who may edit the plan; at most 31 days).
-- The app builds the editable rows (scaling, units) from the meals. Outcomes: 'ok' (with meals and
-- token), 'not_permitted'. 22023 for a malformed range.
create function public.preview_meal_ingredients(p_from date, p_to date, p_home_id uuid default null)
returns table (outcome text, preview jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_meals jsonb;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if not private.is_meal_date(p_from) or not private.is_meal_date(p_to) or p_to < p_from
       or p_to - p_from >= private.meal_limit('transfer_days') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    v_meals := private.meal_transfer_meals(p_home_id, v_user_id, p_from, p_to);
    return query select 'ok', pg_catalog.jsonb_build_object('meals', v_meals, 'token', private.meal_transfer_token(v_meals));
  end
  $$;

-- Adds the reviewed ingredient rows to one shopping list of the same context (people who may edit the
-- plan and the list). The meals are rechecked: a token that no longer matches answers 'stale' (nothing
-- added). Rows are ordinary shopping items (add_shopping_items: client ids, duplicate answers, limits)
-- linked to this transfer's record; a retry with the same p_id answers each row again ('exists').
-- Outcomes: 'done' (with per-row results), 'stale', 'list_unavailable' (missing, archived, another
-- context or not editable), 'not_permitted'. 22023 for malformed input.
create function public.transfer_meal_ingredients(
  p_id uuid, p_from date, p_to date, p_list_id uuid, p_token text, p_items jsonb, p_home_id uuid default null
) returns table (outcome text, results jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.meal_shopping_transfers;
    v_list private.shopping_lists;
    v_results jsonb;
    v_created uuid[];
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if p_id is null or p_list_id is null or not private.is_meal_date(p_from) or not private.is_meal_date(p_to)
       or p_to < p_from or p_to - p_from >= private.meal_limit('transfer_days')
       or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(p_home_id, v_user_id);
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    if v_list.id is null
       or not private.in_meal_context(v_list.owner_user_id, v_list.owner_home_id, p_home_id, v_user_id)
       or not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'list_unavailable', null::jsonb;
      return;
    end if;
    select * into v_existing from private.meal_shopping_transfers t where t.id = p_id;
    if v_existing.id is not null and (v_existing.created_by is distinct from v_user_id
        or v_existing.list_id is distinct from p_list_id) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_existing.id is null
       and p_token is distinct from private.meal_transfer_token(private.meal_transfer_meals(p_home_id, v_user_id, p_from, p_to)) then
      return query select 'stale', null::jsonb;
      return;
    end if;
    insert into private.meal_shopping_transfers (id, owner_user_id, owner_home_id, list_id, from_on, to_on, created_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_list_id, p_from, p_to, v_user_id)
      on conflict (id) do nothing;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', a.id, 'outcome', a.outcome)), '[]'::jsonb),
        array_agg(a.id) filter (where a.outcome = 'created')
      into v_results, v_created
      from public.add_shopping_items(p_list_id, p_items) a;
    if v_created is not null then
      update private.shopping_items i set meal_transfer_id = p_id where i.id = any (v_created);
      update private.meal_shopping_transfers t set item_count = t.item_count + cardinality(v_created)
        where t.id = p_id;
    end if;
    perform private.audit_meals('meal_plan.ingredients_transferred', p_home_id, p_id, pg_catalog.jsonb_build_object(
      'listId', p_list_id, 'created', coalesce(cardinality(v_created), 0)));
    return query select 'done', v_results;
  end
  $$;

-- Recipe deletion impact --------------------------------------------------------------------------------

-- S25's recipe_delete_impact, now with the meal-plan impact promised there: how many planned meals
-- from today on (concrete, in any context, a count only) and series that have not ended refer to the
-- recipe. They are kept and show "Recipe unavailable" after the delete.
create or replace function public.recipe_delete_impact(p_recipe_id uuid)
returns table (outcome text, impact jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
  begin
    if p_recipe_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_recipe from private.recipes r where r.id = p_recipe_id;
    if not private.can_see_recipe(v_recipe, v_user_id) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    if not private.can_delete_recipe(v_recipe, v_user_id) then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    return query select 'ok', pg_catalog.jsonb_build_object(
      'token', private.recipe_impact_token(v_recipe),
      'status', v_recipe.status,
      'homeId', v_recipe.owner_home_id,
      'shares', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'homeId', s.home_id, 'homeName', h.name, 'canEdit', s.can_edit)
          order by h.name, s.home_id)
        from private.recipe_shares s join public.homes h on h.id = s.home_id
        where s.recipe_id = v_recipe.id and s.suspended_at is null), '[]'::jsonb),
      'favoriteCount', (select count(*) from private.recipe_favorites f where f.recipe_id = v_recipe.id),
      'beingEdited', exists (
        select 1 from private.recipe_edit_locks l
        where l.recipe_id = v_recipe.id and l.user_id <> v_user_id and l.expires_at > pg_catalog.now()),
      'plannedMeals', (select count(*) from private.meal_entries e
        where e.recipe_id = v_recipe.id and e.deleted_at is null
          and e.on_date >= (pg_catalog.now() at time zone 'UTC')::date - 1),
      'repeatingMeals', (select count(distinct r.series_id) from private.meal_recurrences r
        join private.meal_series s on s.id = r.series_id
        where r.recipe_id = v_recipe.id and s.status <> 'ended'
          and (r.end_on is null or r.end_on >= (pg_catalog.now() at time zone 'UTC')::date - 1))
    );
  end
  $$;

-- Trash ------------------------------------------------------------------------------------------------

-- The dispatch functions as they stood before meals keep handling every other module; these handle the
-- meals module and hand the rest on (the chores pattern).
alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_meals;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_meals;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_meals;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_meals;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_meals;

-- What may be in the way of restoring a meal: its slot and date taken meanwhile ('meal_slot_occupied').
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_entry private.meal_entries;
  begin
    if p_entry.module <> 'meals' then
      return private.trash_conflict_before_meals(p_entry);
    end if;
    select * into v_entry from private.meal_entries e where e.id = p_entry.subject_id and e.deleted_at is not null;
    if not found then
      return 'item_missing';
    end if;
    if exists (select 1 from private.meal_entries e
        where e.slot_id = v_entry.slot_id and e.on_date = v_entry.on_date and e.deleted_at is null)
       or exists (select 1 from private.meal_occurrences(v_entry.owner_home_id, v_entry.owner_user_id,
           v_entry.on_date, v_entry.on_date) o where o.slot_id = v_entry.slot_id) then
      return 'meal_slot_occupied';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'meal_slot_occupied' then array[]::text[]
    else private.trash_conflict_options_before_meals(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'meals' then
      perform private.trash_resolve_before_meals(p_entry, p_resolution);
    end if;
    -- A taken slot has no resolution: the person frees it first.
  end
  $$;

-- A meal comes back to its date and slot (even a slot disabled meanwhile, as history).
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.meal_entries;
  begin
    if p_entry.module <> 'meals' then
      return private.trash_item_restore_before_meals(p_entry);
    end if;
    select * into v_entry from private.meal_entries e where e.id = p_entry.subject_id;
    if v_entry.id is not null then
      perform private.lock_meal_context(v_entry.owner_home_id, v_entry.owner_user_id);
    end if;
    if v_entry.id is null or private.trash_conflict(p_entry) is not null then
      raise exception 'meal restore unavailable' using errcode = '23505';
    end if;
    update private.meal_entries e
      set deleted_at = null, revision = e.revision + 1, updated_by = auth.uid(), updated_at = pg_catalog.now()
      where e.id = v_entry.id;
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'meals' then
      perform private.trash_item_purge_before_meals(p_entry);
      return;
    end if;
    delete from private.meal_entries e where e.id = p_entry.subject_id and e.deleted_at is not null;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The meal-planner API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_meal_plan', 'list_meal_recipes', 'create_meal_entry', 'update_meal_entry', 'delete_meal_entry',
      'edit_meal_occurrence', 'skip_meal_occurrence', 'restore_meal_occurrence', 'preview_meal_series',
      'create_meal_series', 'update_meal_series', 'create_meal_slot', 'meal_slot_impact',
      'update_meal_slot', 'move_meal_slot', 'update_meal_settings', 'preview_meal_copy',
      'copy_meal_week', 'preview_meal_ingredients', 'transfer_meal_ingredients', 'recipe_delete_impact'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql), except the pure
  -- checks the tables' check constraints run with the writer's privileges (below).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%meal%'
      or p.proname in ('is_delegable_capability', 'trash_conflict', 'trash_conflict_options',
        'trash_resolve', 'trash_item_restore', 'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
