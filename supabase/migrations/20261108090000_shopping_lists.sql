-- S26: shopping lists (brief plans/steps/S26-brief.md; ADR 0033; spec "Confirmed multiple independent
-- shopping lists", "Confirmed structured shopping quantities and units", "Confirmed manual shopping
-- categories and item ordering", "Confirmed shopping quick-add and reviewed multi-item entry",
-- "Confirmed synchronized shopping item completion lifecycle", "Confirmed shopping item moves and
-- copies within a context", "Confirmed recurring shopping items", "Confirmed shopping dashboard
-- widget list selection and quick actions").
--
-- Every list belongs to exactly one context: a person (their Personal space) or a Home. Categories,
-- items, recurring rules and history belong to one list. Nothing here is exposed as a table; people
-- use security-definer functions that run with their own session and recheck the confirmed caller,
-- their current membership and their access on every call. A Home the caller is not in answers 42501
-- "not permitted" exactly like one that does not exist; a list or item they may not see answers
-- 'not_found' (or null) exactly like a missing one.
--
-- Who may do what (default picked in the brief, owner may override; the per-module permission matrix
-- is open in the spec). packages/domain/src/permissions/shopping.ts makes the same decisions:
-- - Personal space: its owner, for everything.
-- - Home: every current member views every list and creates lists. A list's managers (its creator
--   while a member, and shopping managers: the Owner and Administrators granted the new delegable
--   capability manageHomeShopping) rename it, set its member access, archive, restore and delete it,
--   and edit everything in it. Other members get the list's member access: 'edit' (default: add,
--   edit, delete, reorder, categories, clear completed, move/copy, recurring items, check off),
--   'check' (check and uncheck only) or 'view' (read only). Reordering a context's lists is for
--   shopping managers. An archived list is read only for everyone until it is restored.
--
-- Concurrency: every change to a list's content takes the list row lock first (then, for a
-- transfer, the other list's, in id order), so positions, limits, duplicate checks and recurring
-- rules are decided one at a time per list. Edits name the revision they started from; completion
-- is set-to-state; creates take client ids, so a retry returns the same row. Reordering is by
-- relative moves (up/down one place), so two people reordering at once never overwrite each other
-- with a stale full order.
--
-- Recurring items are applied lazily (public.advance_shopping, called before the context's shopping
-- pages and widgets are read): at most one active item per rule, missed days collapse into one item,
-- and the next due date always moves past today. Nothing is delivered or notified on recurrence.
--
-- Realtime (architecture.md §8, per-feature mechanism picked in the brief): Postgres Changes on one
-- row per context (public.shopping_signals) whose version moves once per transaction, at commit,
-- whenever a list, category, item or rule of the context changes. RLS lets only the Home's current
-- members (or the Personal space's owner) see the row; it carries no shopping content.

-- Audit subjects, the new capability, trash types ------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear'
  ));

-- Limits and text rules ----------------------------------------------------------------------------

-- apps/web/src/shopping/schema.ts and packages/domain/src/shopping use the same numbers.
create function private.shopping_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'lists' then 50               -- non-deleted lists per context (archived ones count)
    when 'items' then 500              -- non-deleted items per list (completed ones count)
    when 'categories' then 30          -- per list
    when 'recurrences' then 50         -- rules per list that have not been stopped
    when 'batch' then 100              -- rows in one multi-item entry
    when 'list_name' then 60
    when 'category_name' then 40
    when 'item_name' then 200
    when 'packaging' then 40
    when 'notes' then 500
    when 'history' then 20
    when 'widget_lists' then 5
    when 'widget_items' then 15
    when 'max_quantity' then 100000
  end;
  $$;

-- What two names compare as for duplicates: compatibility-normalized, accents removed, lower case,
-- runs of whitespace as one space (the recipe rule).
create function private.shopping_name_key(p_text text) returns text
  language sql immutable strict set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.normalize(pg_catalog.normalize(p_text, 'NFKC'), 'NFD'), '[̀-ͯ]', '', 'g')),
    '\s+', ' ', 'g'));
  $$;

-- The supported units (packages/domain shoppingUnits). Packaging ("bottles") is a separate text.
create function private.is_shopping_unit(p_unit text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_unit in ('piece', 'g', 'kg', 'ml', 'cl', 'dl', 'l'), false);
  $$;

-- A quantity: finite, positive, at most three decimals and within the limit. Never rounded here: a
-- value with more decimals is refused, not changed.
create function private.is_shopping_quantity(p_quantity numeric) returns boolean
  language sql immutable set search_path = '' as $$
  select p_quantity is not null and p_quantity > 0
    and p_quantity <= private.shopping_limit('max_quantity')
    and p_quantity = pg_catalog.round(p_quantity, 3);
  $$;

-- Whether an item's fields are acceptable together (names and texts within their limits, a unit only
-- with a quantity).
create function private.valid_shopping_fields(
  p_name text, p_quantity numeric, p_unit text, p_packaging text, p_notes text
) returns boolean
  language sql immutable set search_path = '' as $$
  select p_name is not null and private.is_visible_name(p_name, private.shopping_limit('item_name'))
    and (p_quantity is null or private.is_shopping_quantity(p_quantity))
    and (p_unit is null or (private.is_shopping_unit(p_unit) and p_quantity is not null))
    and (p_packaging is null or private.is_visible_name(p_packaging, private.shopping_limit('packaging')))
    and (p_notes is null or private.is_plain_text(p_notes, private.shopping_limit('notes')));
  $$;

-- Tables -------------------------------------------------------------------------------------------

create table private.shopping_lists (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  name text not null constraint shopping_lists_name_check check (private.is_visible_name(name, 60)),
  -- What members who do not manage the list may do (Home lists only; Personal lists keep 'edit').
  member_access text not null default 'edit'
    constraint shopping_lists_member_access_check check (member_access in ('edit', 'check', 'view')),
  position integer not null default 0,
  archived_at timestamptz,
  -- Set while the list is in the trash.
  deleted_at timestamptz,
  revision integer not null default 1 constraint shopping_lists_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopping_lists_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint shopping_lists_personal_access check (owner_home_id is not null or member_access = 'edit')
);

create index shopping_lists_user_idx on private.shopping_lists (owner_user_id, position)
  where deleted_at is null and owner_user_id is not null;
create index shopping_lists_home_idx on private.shopping_lists (owner_home_id, position)
  where deleted_at is null and owner_home_id is not null;

create table private.shopping_categories (
  id uuid primary key,
  list_id uuid not null references private.shopping_lists (id) on delete cascade,
  name text not null constraint shopping_categories_name_check check (private.is_visible_name(name, 40)),
  position integer not null default 0,
  revision integer not null default 1 constraint shopping_categories_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- For the composite references below: an item's or rule's category belongs to its own list.
  constraint shopping_categories_list_key unique (id, list_id)
);

-- Distinguishable within the list: never two categories that read the same.
create unique index shopping_categories_name_idx
  on private.shopping_categories (list_id, private.shopping_name_key(name));

create table private.shopping_recurrences (
  id uuid primary key,
  list_id uuid not null references private.shopping_lists (id) on delete cascade,
  -- The item it makes (copied when the rule is started or its schedule saved from an item).
  name text not null constraint shopping_recurrences_name_check check (private.is_visible_name(name, 200)),
  quantity numeric(9, 3),
  unit text,
  packaging text,
  notes text,
  category_id uuid,
  -- Its category was removed: it continues Uncategorized until a member chooses again.
  category_lost boolean not null default false,
  frequency text not null constraint shopping_recurrences_frequency_check
    check (frequency in ('daily', 'weekly', 'monthly')),
  -- Weekly: ISO weekdays (1 Monday … 7 Sunday), at least one. Monthly: the day of the month
  -- (months without it use their last day).
  weekdays smallint[],
  month_day smallint,
  start_on date,
  -- Personal lists: the owner's effective timezone when it was saved. Home lists use the Home's.
  time_zone text,
  next_on date not null,
  paused_at timestamptz,
  ended_at timestamptz,
  -- Why the last due day made no item ('list_full'), shown with the rule until the next one does.
  stalled text constraint shopping_recurrences_stalled_check check (stalled in ('list_full')),
  revision integer not null default 1 constraint shopping_recurrences_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopping_recurrences_fields_check
    check (private.valid_shopping_fields(name, quantity, unit, packaging, notes)),
  constraint shopping_recurrences_schedule_check check (
    (frequency = 'daily' and weekdays is null and month_day is null)
    or (frequency = 'weekly' and month_day is null and weekdays is not null
      and cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
    or (frequency = 'monthly' and weekdays is null and month_day between 1 and 31)
  ),
  constraint shopping_recurrences_category_fkey foreign key (category_id, list_id)
    references private.shopping_categories (id, list_id) on delete set null (category_id)
);

create index shopping_recurrences_list_idx on private.shopping_recurrences (list_id, next_on)
  where ended_at is null;

-- One "Clear completed": the items it cleared go to the trash together, as one entry.
create table private.shopping_clears (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references private.shopping_lists (id) on delete cascade,
  item_count integer not null constraint shopping_clears_count_check check (item_count >= 1),
  cleared_by uuid references auth.users (id) on delete set null,
  cleared_at timestamptz not null default now()
);

create index shopping_clears_list_idx on private.shopping_clears (list_id);

create table private.shopping_items (
  id uuid primary key,
  list_id uuid not null references private.shopping_lists (id) on delete cascade,
  category_id uuid,
  name text not null constraint shopping_items_name_check check (private.is_visible_name(name, 200)),
  quantity numeric(9, 3),
  unit text,
  packaging text,
  notes text,
  -- One increasing order per list; a group (a category, or Uncategorized) shows its items by it.
  position integer not null default 0,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  -- Made by a recurring rule, for the due day occurrence_on (kept after the rule ends).
  recurrence_id uuid references private.shopping_recurrences (id) on delete set null,
  occurrence_on date,
  -- Set while the item is in the trash: deleted alone, with its list, or cleared (clear_id).
  deleted_at timestamptz,
  clear_id uuid references private.shopping_clears (id) on delete set null,
  revision integer not null default 1 constraint shopping_items_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopping_items_fields_check
    check (private.valid_shopping_fields(name, quantity, unit, packaging, notes)),
  constraint shopping_items_completion_check check (completed_by is null or completed_at is not null),
  constraint shopping_items_category_fkey foreign key (category_id, list_id)
    references private.shopping_categories (id, list_id) on delete set null (category_id)
);

create index shopping_items_list_idx on private.shopping_items (list_id, position) where deleted_at is null;
create index shopping_items_recurrence_idx on private.shopping_items (recurrence_id)
  where recurrence_id is not null and deleted_at is null and completed_at is null;
create index shopping_items_clear_idx on private.shopping_items (clear_id) where clear_id is not null;
create index shopping_items_category_idx on private.shopping_items (category_id) where category_id is not null;

-- What happened to an item: ids, kinds, actor and time only (never its name or notes again).
create table private.shopping_item_events (
  id bigint generated always as identity primary key,
  item_id uuid not null references private.shopping_items (id) on delete cascade,
  kind text not null constraint shopping_item_events_kind_check check (kind in (
    'added', 'edited', 'completed', 'reopened', 'moved_in', 'moved_out', 'copied', 'recurred',
    'deleted', 'cleared', 'restored'
  )),
  -- null for an automatic change (a recurring rule) or a deleted account.
  actor uuid references auth.users (id) on delete set null,
  -- The other list of a move or copy (same context), when there is one.
  other_list_id uuid,
  at timestamptz not null default now()
);

create index shopping_item_events_item_idx on private.shopping_item_events (item_id, at desc, id desc);

comment on table private.shopping_lists is 'S26: personal and Home shopping lists. Not exposed through the API.';
comment on table private.shopping_categories is 'S26: manual per-list shopping categories. Not exposed through the API.';
comment on table private.shopping_recurrences is 'S26: recurring shopping item rules. Not exposed through the API.';
comment on table private.shopping_clears is 'S26: one Clear completed, for the trash. Not exposed through the API.';
comment on table private.shopping_items is 'S26: shopping list items. Not exposed through the API.';
comment on table private.shopping_item_events is 'S26: shopping item history (ids and kinds only). Not exposed through the API.';

alter table private.shopping_lists enable row level security;
alter table private.shopping_categories enable row level security;
alter table private.shopping_recurrences enable row level security;
alter table private.shopping_clears enable row level security;
alter table private.shopping_items enable row level security;
alter table private.shopping_item_events enable row level security;
revoke all on private.shopping_lists, private.shopping_categories, private.shopping_recurrences,
  private.shopping_clears, private.shopping_items, private.shopping_item_events
  from public, anon, authenticated, service_role;

-- The Realtime signal: one row per context (a Home's id, or a person's id for their Personal
-- space), readable by that Home's current members or that person only. No shopping content.
create table public.shopping_signals (
  context_id uuid primary key,
  home_id uuid references public.homes (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  version bigint not null default 1,
  changed_at timestamptz not null default now(),
  constraint shopping_signals_one_owner check (num_nonnulls(home_id, user_id) = 1),
  constraint shopping_signals_context check (context_id = coalesce(home_id, user_id))
);

alter table public.shopping_signals enable row level security;
revoke all on table public.shopping_signals from public, anon, authenticated;
grant select on table public.shopping_signals to authenticated;

create policy shopping_signals_select_own on public.shopping_signals
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.home_memberships m
      where m.home_id = shopping_signals.home_id and m.user_id = (select auth.uid())
    )
  );

comment on table public.shopping_signals is
  'S26: a per-context version that moves when its shopping lists change (Realtime). No shopping content.';

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.shopping_signals;
  end if;
end
$$;

-- Moves the context's signal once per transaction, at commit (a deferred constraint trigger), so it
-- is taken after every list lock and never inside them. A context deleted in the same transaction
-- (its list gone) gets none.
create function private.bump_shopping_signal() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_list_id uuid;
    v_home uuid;
    v_user uuid;
    v_key text;
  begin
    if tg_table_name = 'shopping_lists' then
      v_list_id := case when tg_op = 'DELETE' then old.id else new.id end;
    else
      v_list_id := case when tg_op = 'DELETE' then old.list_id else new.list_id end;
    end if;
    select l.owner_home_id, l.owner_user_id into v_home, v_user
      from private.shopping_lists l where l.id = v_list_id;
    if not found then
      if tg_table_name = 'shopping_lists' and tg_op = 'DELETE' then
        v_home := old.owner_home_id;
        v_user := old.owner_user_id;
      else
        return null;
      end if;
    end if;
    v_key := 'madeora.shopping_signal_' || pg_catalog.replace(coalesce(v_home, v_user)::text, '-', '');
    if pg_catalog.current_setting(v_key, true) = pg_catalog.txid_current()::text then
      return null;
    end if;
    perform pg_catalog.set_config(v_key, pg_catalog.txid_current()::text, true);
    if v_home is not null then
      insert into public.shopping_signals as s (context_id, home_id)
        select v_home, v_home where exists (select 1 from public.homes h where h.id = v_home)
        on conflict (context_id) do update set version = s.version + 1, changed_at = pg_catalog.now();
    else
      insert into public.shopping_signals as s (context_id, user_id)
        select v_user, v_user where exists (select 1 from auth.users u where u.id = v_user)
        on conflict (context_id) do update set version = s.version + 1, changed_at = pg_catalog.now();
    end if;
    return null;
  end
  $$;

create constraint trigger shopping_lists_signal after insert or update or delete on private.shopping_lists
  deferrable initially deferred for each row execute function private.bump_shopping_signal();
create constraint trigger shopping_categories_signal after insert or update or delete on private.shopping_categories
  deferrable initially deferred for each row execute function private.bump_shopping_signal();
create constraint trigger shopping_items_signal after insert or update or delete on private.shopping_items
  deferrable initially deferred for each row execute function private.bump_shopping_signal();
create constraint trigger shopping_recurrences_signal after insert or update or delete on private.shopping_recurrences
  deferrable initially deferred for each row execute function private.bump_shopping_signal();

-- Permission helpers (the engine in packages/domain mirrors these) ----------------------------------

-- Shopping managers of a context: the Personal space's owner; in a Home the Owner and Administrators
-- granted manageHomeShopping (engine action home.shopping.manage).
create function private.can_manage_shopping(p_owner_user_id uuid, p_owner_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (p_owner_home_id is not null
      and private.has_home_capability(p_owner_home_id, p_user_id, 'manageHomeShopping'))
  );
  $$;

-- What p_user_id may do with the list now: 'manage', 'edit', 'check', 'view', or null (not theirs to
-- see, deleted, or missing). Archived lists are read only: see private.shopping_may.
create function private.shopping_access(p_list private.shopping_lists, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null or p_list.id is null or p_list.deleted_at is not null then null
    when p_list.owner_user_id is not null then
      case when p_list.owner_user_id = p_user_id then 'manage' end
    when not private.is_home_member(p_list.owner_home_id, p_user_id) then null
    -- The creator manages it only within the membership it was created in: leaving ends that, and
    -- rejoining (a new membership row, created later) does not bring it back.
    when coalesce(p_list.created_by = p_user_id, false) and exists (
        select 1 from public.home_memberships m
        where m.home_id = p_list.owner_home_id and m.user_id = p_user_id
          and m.created_at <= p_list.created_at)
      or private.has_home_capability(p_list.owner_home_id, p_user_id, 'manageHomeShopping') then 'manage'
    else p_list.member_access
  end;
  $$;

-- Whether p_user_id may do p_need ('view', 'check', 'edit', 'manage') with the list now. Checking off
-- and editing need an active list; managing (rename, access, archive, restore, delete) does not.
create function private.shopping_may(p_list private.shopping_lists, p_user_id uuid, p_need text)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    case private.shopping_access(p_list, p_user_id)
      when 'manage' then 4 when 'edit' then 3 when 'check' then 2 when 'view' then 1 else 0
    end
    >= case p_need when 'manage' then 4 when 'edit' then 3 when 'check' then 2 else 1 end
    and (p_need in ('view', 'manage') or p_list.archived_at is null),
    false);
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_shopping_context(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- Serializes list creation, limits and list order within one context.
create function private.lock_shopping_context(p_home_id uuid, p_user_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('shopping_lists:' || coalesce(p_home_id, p_user_id)::text, 0));
  $$;

-- Loads a list for a change, locked. Null when it is missing, deleted or not theirs to see.
create function private.lock_shopping_list(p_list_id uuid, p_user_id uuid) returns private.shopping_lists
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_list private.shopping_lists;
  begin
    select * into v_list from private.shopping_lists l where l.id = p_list_id for update;
    if not found or private.shopping_access(v_list, p_user_id) is null then
      return null;
    end if;
    return v_list;
  end
  $$;

-- An item for a change, locked after its list (the lock order: the list row first). Null when the
-- item or its list is missing, deleted or not theirs to see. The caller then reads the list row,
-- which this transaction already holds.
create function private.lock_shopping_item(p_item_id uuid, p_user_id uuid) returns private.shopping_items
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_list_id uuid;
    v_list private.shopping_lists;
    v_item private.shopping_items;
  begin
    select i.list_id into v_list_id from private.shopping_items i where i.id = p_item_id;
    if v_list_id is null then
      return null;
    end if;
    v_list := private.lock_shopping_list(v_list_id, p_user_id);
    select * into v_item from private.shopping_items i where i.id = p_item_id for update;
    -- A move to another list between reading and locking is caught by comparing the list again.
    if v_list.id is null or v_item.id is null or v_item.list_id <> v_list.id or v_item.deleted_at is not null then
      return null;
    end if;
    return v_item;
  end
  $$;

-- A person as a Home answer may name them: their current membership id in that Home and whether it
-- is the caller; Personal answers only ever say "me".
create function private.shopping_person(p_home_id uuid, p_user_id uuid, p_viewer uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select case when p_user_id is null then null else pg_catalog.jsonb_build_object(
    'me', p_user_id = p_viewer,
    'member', case when p_home_id is not null then private.member_ref(p_home_id, p_user_id) end
  ) end;
  $$;

create function private.audit_shopping(
  p_action text, p_home_id uuid, p_list_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids and counts only: never list, category or item names. Home actions only.
  select case when p_home_id is not null
    then private.audit(p_action, p_home_id, 'shopping_list', p_list_id, p_details) end;
  $$;

create function private.shopping_event(
  p_item_id uuid, p_kind text, p_actor uuid, p_other_list_id uuid default null
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.shopping_item_events (item_id, kind, actor, other_list_id)
    values (p_item_id, p_kind, p_actor, p_other_list_id);
  $$;

-- The next position at the end of a list.
create function private.shopping_next_position(p_list_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
  select coalesce(max(i.position) + 1, 0) from private.shopping_items i where i.list_id = p_list_id;
  $$;

-- Whether an active item of the list (other than p_except) reads the same as p_name.
create function private.shopping_duplicate(p_list_id uuid, p_name text, p_except uuid default null)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.shopping_items i
    where i.list_id = p_list_id and i.deleted_at is null and i.completed_at is null
      and i.id is distinct from p_except
      and private.shopping_name_key(i.name) = private.shopping_name_key(p_name)
  );
  $$;

create function private.shopping_item_count(p_list_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.shopping_items i where i.list_id = p_list_id and i.deleted_at is null;
  $$;

-- Schedules --------------------------------------------------------------------------------------------

-- The first due day on or after p_from of a schedule (never before its start date). Date-only, so a
-- daylight-saving change never adds or skips an occurrence. Monthly on a day the month lacks: its
-- last day.
create function private.shopping_due_on_or_after(
  p_frequency text, p_weekdays smallint[], p_month_day smallint, p_start_on date, p_from date
) returns date
  language plpgsql immutable set search_path = '' as $$
  declare
    v_from date := greatest(p_from, coalesce(p_start_on, p_from));
    v_day date;
    v_month date;
    v_last integer;
  begin
    if p_frequency = 'daily' then
      return v_from;
    elsif p_frequency = 'weekly' then
      for v_offset in 0..6 loop
        v_day := v_from + v_offset;
        if extract(isodow from v_day)::smallint = any (p_weekdays) then
          return v_day;
        end if;
      end loop;
      return null;
    else
      v_month := pg_catalog.make_date(extract(year from v_from)::integer, extract(month from v_from)::integer, 1);
      for v_step in 0..1 loop
        -- The month's last day: the first of the next month, minus one day.
        v_last := extract(day from ((v_month + pg_catalog.make_interval(months => 1))::date - 1))::integer;
        v_day := v_month + (least(p_month_day, v_last) - 1);
        if v_day >= v_from then
          return v_day;
        end if;
        v_month := (v_month + pg_catalog.make_interval(months => 1))::date;
      end loop;
      return null;
    end if;
  end
  $$;

-- The most recent due day on or before p_today, starting from p_from (the rule's next due day): the
-- day a late item stands for. Missed days before it are not made up.
create function private.shopping_latest_due(
  p_rule private.shopping_recurrences, p_today date
) returns date
  language plpgsql immutable set search_path = '' as $$
  declare
    v_day date := p_rule.next_on;
    v_next date;
  begin
    -- Bounded: a year of daily occurrences at most, then today itself.
    for v_round in 1..400 loop
      v_next := private.shopping_due_on_or_after(
        p_rule.frequency, p_rule.weekdays, p_rule.month_day, p_rule.start_on, v_day + 1);
      if v_next is null or v_next > p_today then
        return v_day;
      end if;
      v_day := v_next;
    end loop;
    return p_today;
  end
  $$;

-- "Today" for a rule: the Home's own timezone for a Home list; the zone saved with the rule for a
-- Personal list (UTC when it is unknown).
create function private.shopping_today(p_home_id uuid, p_time_zone text) returns date
  language sql stable security definer set search_path = '' as $$
  select (pg_catalog.now() at time zone coalesce(
    (select h.timezone from public.homes h where h.id = p_home_id),
    (select z.name from pg_catalog.pg_timezone_names z where z.name = p_time_zone),
    'UTC'))::date;
  $$;

-- Whether a schedule is well formed (the table's check, as a question).
create function private.valid_shopping_schedule(
  p_frequency text, p_weekdays smallint[], p_month_day smallint
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    (p_frequency = 'daily' and p_weekdays is null and p_month_day is null)
    or (p_frequency = 'weekly' and p_month_day is null and p_weekdays is not null
      and cardinality(p_weekdays) between 1 and 7 and p_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
      and array_position(p_weekdays, null) is null)
    or (p_frequency = 'monthly' and p_weekdays is null and p_month_day between 1 and 31),
    false);
  $$;

-- Applies the due rules of one list (locked by the caller): at most one active item per rule, made
-- from the rule's current details; missed days give one item; the next due day moves past today.
-- Returns how many items it made.
create function private.advance_shopping_list(p_list private.shopping_lists) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_rule private.shopping_recurrences;
    v_today date;
    v_made integer := 0;
    v_item_id uuid;
  begin
    if p_list.deleted_at is not null or p_list.archived_at is not null then
      return 0;
    end if;
    for v_rule in
      select * from private.shopping_recurrences r
      where r.list_id = p_list.id and r.ended_at is null and r.paused_at is null
      order by r.id for update
    loop
      v_today := private.shopping_today(p_list.owner_home_id, v_rule.time_zone);
      continue when v_rule.next_on > v_today;
      if exists (
        select 1 from private.shopping_items i
        where i.recurrence_id = v_rule.id and i.deleted_at is null and i.completed_at is null
      ) then
        -- Still on the list: nothing new, nothing changed.
        update private.shopping_recurrences r
          set next_on = private.shopping_due_on_or_after(
              r.frequency, r.weekdays, r.month_day, r.start_on, v_today + 1),
            stalled = null
          where r.id = v_rule.id;
        continue;
      end if;
      if private.shopping_item_count(p_list.id) >= private.shopping_limit('items') then
        update private.shopping_recurrences r
          set next_on = private.shopping_due_on_or_after(
              r.frequency, r.weekdays, r.month_day, r.start_on, v_today + 1),
            stalled = 'list_full'
          where r.id = v_rule.id;
        continue;
      end if;
      v_item_id := gen_random_uuid();
      insert into private.shopping_items (
        id, list_id, category_id, name, quantity, unit, packaging, notes, position,
        recurrence_id, occurrence_on, created_by
      ) values (
        v_item_id, p_list.id, v_rule.category_id, v_rule.name, v_rule.quantity, v_rule.unit,
        v_rule.packaging, v_rule.notes, private.shopping_next_position(p_list.id),
        v_rule.id, private.shopping_latest_due(v_rule, v_today), null
      );
      perform private.shopping_event(v_item_id, 'recurred', null);
      update private.shopping_recurrences r
        set next_on = private.shopping_due_on_or_after(
            r.frequency, r.weekdays, r.month_day, r.start_on, v_today + 1),
          stalled = null
        where r.id = v_rule.id;
      v_made := v_made + 1;
    end loop;
    return v_made;
  end
  $$;

-- Restarts a list's rules from today, without catching up (a restored or unarchived list).
create function private.restart_shopping_rules(p_list private.shopping_lists) returns void
  language sql volatile security definer set search_path = '' as $$
  update private.shopping_recurrences r
    set next_on = private.shopping_due_on_or_after(r.frequency, r.weekdays, r.month_day, r.start_on,
      private.shopping_today(p_list.owner_home_id, r.time_zone))
    where r.list_id = p_list.id and r.ended_at is null
      and r.next_on < private.shopping_today(p_list.owner_home_id, r.time_zone);
  $$;

-- The caller's context --------------------------------------------------------------------------------

-- What the caller may do in a context, and its signal version. 42501 for a Home they are not in.
create function public.get_shopping_context(p_home_id uuid default null)
returns table (can_create boolean, can_reorder boolean, signal_version bigint)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_shopping_context(p_home_id, v_user_id);
    return query select
      true,
      private.can_manage_shopping(case when p_home_id is null then v_user_id end, p_home_id, v_user_id),
      coalesce((select s.version from public.shopping_signals s
        where s.context_id = coalesce(p_home_id, v_user_id)), 0);
  end
  $$;

-- Applies the context's due recurring items. Called before its shopping pages and widgets are read;
-- idempotent, so two readers at once make one item. Returns how many items it made.
create function public.advance_shopping(p_home_id uuid default null) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list_id uuid;
    v_list private.shopping_lists;
    v_made integer := 0;
  begin
    perform private.require_shopping_context(p_home_id, v_user_id);
    for v_list_id in
      select distinct l.id from private.shopping_lists l
      join private.shopping_recurrences r on r.list_id = l.id
      where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
        and l.deleted_at is null and l.archived_at is null
        and r.ended_at is null and r.paused_at is null
        and r.next_on <= private.shopping_today(l.owner_home_id, r.time_zone)
      order by l.id
    loop
      v_list := private.lock_shopping_list(v_list_id, v_user_id);
      continue when v_list.id is null;
      v_made := v_made + private.advance_shopping_list(v_list);
    end loop;
    return v_made;
  end
  $$;

-- Lists ---------------------------------------------------------------------------------------------

-- The context's lists in their order (archived ones apart, when asked), with the caller's access and
-- the counts the overview and the archive/delete impact show.
create function public.list_shopping_lists(p_home_id uuid default null, p_archived boolean default false)
returns table (
  id uuid, name text, "position" integer, archived boolean, member_access text, access text,
  revision integer, active_items integer, completed_items integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_shopping_context(p_home_id, v_user_id);
    return query
      select l.id, l.name, l.position, l.archived_at is not null, l.member_access,
        private.shopping_access(l, v_user_id), l.revision,
        (select count(*)::integer from private.shopping_items i
          where i.list_id = l.id and i.deleted_at is null and i.completed_at is null),
        (select count(*)::integer from private.shopping_items i
          where i.list_id = l.id and i.deleted_at is null and i.completed_at is not null)
      from private.shopping_lists l
      where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
        and l.deleted_at is null
        and (l.archived_at is not null) = coalesce(p_archived, false)
      order by l.position, l.created_at, l.id
      limit private.shopping_limit('lists');
  end
  $$;

-- Creates a list (every current member; the Personal space's owner). It goes to the end of the
-- context's order. Outcomes: 'created', 'exists' (a retry of the caller's own create), 'id_taken',
-- 'limit_reached'. 22023 for an invalid name.
create function public.create_shopping_list(p_id uuid, p_name text, p_home_id uuid default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.shopping_lists;
  begin
    perform private.require_shopping_context(p_home_id, v_user_id);
    if p_id is null or p_name is null
       or not private.is_visible_name(p_name, private.shopping_limit('list_name')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_shopping_context(p_home_id, v_user_id);
    select * into v_existing from private.shopping_lists l where l.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and ((p_home_id is null and v_existing.owner_user_id = v_user_id)
           or v_existing.owner_home_id = p_home_id) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if (select count(*) from private.shopping_lists l
        where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
          and l.deleted_at is null) >= private.shopping_limit('lists') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.shopping_lists (id, owner_user_id, owner_home_id, name, position, created_by)
      values (
        p_id, case when p_home_id is null then v_user_id end, p_home_id, p_name,
        coalesce((select max(l.position) + 1 from private.shopping_lists l
          where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
            and l.deleted_at is null), 0),
        v_user_id
      );
    perform private.audit_shopping('shopping_list.created', p_home_id, p_id);
    return query select 'created', 1;
  end
  $$;

-- Renames a list, sets its member access, archives or restores it (the list's managers). Archiving
-- keeps every item and its history. Outcomes: 'saved' (with the new revision), 'conflict' (with the
-- current one), 'not_found', 'not_permitted'.
create function public.update_shopping_list(
  p_list_id uuid, p_expected_revision integer, p_name text, p_member_access text, p_archived boolean
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
  begin
    if p_list_id is null or p_expected_revision is null or p_archived is null or p_name is null
       or not private.is_visible_name(p_name, private.shopping_limit('list_name'))
       or coalesce(p_member_access, '') not in ('edit', 'check', 'view') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_list.revision <> p_expected_revision then
      return query select 'conflict', v_list.revision;
      return;
    end if;
    update private.shopping_lists l
      set name = p_name,
        member_access = case when l.owner_home_id is null then 'edit' else p_member_access end,
        archived_at = case when p_archived then coalesce(l.archived_at, pg_catalog.now()) end,
        revision = l.revision + 1, updated_at = pg_catalog.now()
      where l.id = v_list.id
      returning * into v_list;
    if not p_archived then
      perform private.restart_shopping_rules(v_list);
    end if;
    perform private.audit_shopping('shopping_list.updated', v_list.owner_home_id, v_list.id,
      pg_catalog.jsonb_build_object('archived', p_archived, 'memberAccess', v_list.member_access));
    return query select 'saved', v_list.revision;
  end
  $$;

-- Moves an active list one place up or down in its context's order (shopping managers). Outcomes:
-- 'saved', 'unchanged' (already first or last), 'not_found', 'not_permitted'.
create function public.move_shopping_list(p_list_id uuid, p_direction text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_other private.shopping_lists;
  begin
    if p_list_id is null or coalesce(p_direction, '') not in ('up', 'down') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    if not found or private.shopping_access(v_list, v_user_id) is null then
      return 'not_found';
    end if;
    perform private.lock_shopping_context(v_list.owner_home_id, v_list.owner_user_id);
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    if private.shopping_access(v_list, v_user_id) is null or v_list.archived_at is not null then
      return 'not_found';
    end if;
    if not private.can_manage_shopping(v_list.owner_user_id, v_list.owner_home_id, v_user_id) then
      return 'not_permitted';
    end if;
    -- Normalize the order first (0, 1, 2, ... by the order shown), so ties never stall a move.
    update private.shopping_lists l set position = o.ord::integer
      from (
        select x.id, row_number() over (order by x.position, x.created_at, x.id) - 1 as ord
        from private.shopping_lists x
        where ((v_list.owner_home_id is null and x.owner_user_id = v_list.owner_user_id)
            or x.owner_home_id = v_list.owner_home_id)
          and x.deleted_at is null and x.archived_at is null
      ) o
      where l.id = o.id and l.position <> o.ord;
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    select * into v_other from private.shopping_lists l
      where ((v_list.owner_home_id is null and l.owner_user_id = v_list.owner_user_id)
          or l.owner_home_id = v_list.owner_home_id)
        and l.deleted_at is null and l.archived_at is null
        and l.position = v_list.position + case when p_direction = 'up' then -1 else 1 end;
    if not found then
      return 'unchanged';
    end if;
    update private.shopping_lists l set position = v_other.position, updated_at = pg_catalog.now()
      where l.id = v_list.id;
    update private.shopping_lists l set position = v_list.position, updated_at = pg_catalog.now()
      where l.id = v_other.id;
    return 'saved';
  end
  $$;

-- Moves a list, with its items, categories and rules, to the trash (the list's managers). Restoring
-- brings them back. Outcomes: 'deleted' (with the trash entry), 'conflict', 'not_found',
-- 'not_permitted'.
create function public.delete_shopping_list(p_list_id uuid, p_expected_revision integer)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
  begin
    if p_list_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'manage') then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    if v_list.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    update private.shopping_lists l
      set deleted_at = pg_catalog.now(), revision = l.revision + 1, updated_at = pg_catalog.now()
      where l.id = v_list.id;
    perform private.audit_shopping('shopping_list.deleted', v_list.owner_home_id, v_list.id);
    return query select 'deleted',
      private.trash_move(v_user_id, 'shopping', 'shopping_list', v_list.id, v_list.owner_user_id,
        v_list.owner_home_id, v_list.name);
  end
  $$;

-- One list with everything its page shows, or null when it is not the caller's to see. Items in the
-- trash never appear. People are named by membership id in Homes ("me" for the caller).
create function public.get_shopping_list(p_list_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_access text;
  begin
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    v_access := private.shopping_access(v_list, v_user_id);
    if v_access is null then
      return null;
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_list.id,
      'homeId', v_list.owner_home_id,
      'name', v_list.name,
      'archived', v_list.archived_at is not null,
      'memberAccess', v_list.member_access,
      'access', v_access,
      'revision', v_list.revision,
      'createdByMe', coalesce(v_list.created_by = v_user_id, false),
      'categories', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', c.id, 'name', c.name, 'revision', c.revision) order by c.position, c.created_at, c.id)
        from private.shopping_categories c where c.list_id = v_list.id), '[]'::jsonb),
      'items', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', i.id, 'name', i.name,
          'quantity', pg_catalog.trim_scale(i.quantity)::text,
          'unit', i.unit, 'packaging', i.packaging, 'notes', i.notes,
          'categoryId', i.category_id, 'position', i.position,
          'completedAt', i.completed_at,
          'completedBy', private.shopping_person(v_list.owner_home_id, i.completed_by, v_user_id),
          'recurrenceId', case when r.ended_at is null then i.recurrence_id end,
          'occurrenceOn', i.occurrence_on,
          'revision', i.revision, 'createdAt', i.created_at
        ) order by i.position, i.created_at, i.id)
        from private.shopping_items i
        left join private.shopping_recurrences r on r.id = i.recurrence_id
        where i.list_id = v_list.id and i.deleted_at is null), '[]'::jsonb),
      'recurrences', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', r.id, 'name', r.name,
          'quantity', pg_catalog.trim_scale(r.quantity)::text,
          'unit', r.unit, 'packaging', r.packaging, 'notes', r.notes,
          'categoryId', r.category_id, 'categoryLost', r.category_lost,
          'frequency', r.frequency, 'weekdays', pg_catalog.to_jsonb(r.weekdays),
          'monthDay', r.month_day, 'startOn', r.start_on, 'nextOn', r.next_on,
          'paused', r.paused_at is not null, 'stalled', r.stalled, 'revision', r.revision,
          'activeItemId', (select i.id from private.shopping_items i
            where i.recurrence_id = r.id and i.deleted_at is null and i.completed_at is null
            order by i.created_at desc limit 1)
        ) order by r.created_at, r.id)
        from private.shopping_recurrences r where r.list_id = v_list.id and r.ended_at is null), '[]'::jsonb),
      -- The other active lists of this context the caller may add to (move and copy destinations).
      'destinations', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', d.id, 'name', d.name, 'position', d.position) order by d.position, d.created_at, d.id)
        from private.shopping_lists d
        where d.id <> v_list.id and d.deleted_at is null and d.archived_at is null
          and ((v_list.owner_home_id is null and d.owner_user_id = v_list.owner_user_id)
            or d.owner_home_id = v_list.owner_home_id)
          and private.shopping_may(d, v_user_id, 'edit')), '[]'::jsonb)
    );
  end
  $$;

-- Categories ----------------------------------------------------------------------------------------------

-- Creates a category at the end of the list's category order (editors). Outcomes: 'created',
-- 'exists' (a retry), 'id_taken', 'duplicate_name', 'limit_reached', 'not_found', 'not_permitted'.
create function public.create_shopping_category(p_id uuid, p_list_id uuid, p_name text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_existing private.shopping_categories;
  begin
    if p_id is null or p_list_id is null or p_name is null
       or not private.is_visible_name(p_name, private.shopping_limit('category_name')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    select * into v_existing from private.shopping_categories c where c.id = p_id;
    if found then
      if v_existing.list_id = v_list.id and v_existing.created_by = v_user_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if exists (select 1 from private.shopping_categories c
        where c.list_id = v_list.id and private.shopping_name_key(c.name) = private.shopping_name_key(p_name)) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    if (select count(*) from private.shopping_categories c where c.list_id = v_list.id)
       >= private.shopping_limit('categories') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.shopping_categories (id, list_id, name, position, created_by)
      values (p_id, v_list.id, p_name,
        coalesce((select max(c.position) + 1 from private.shopping_categories c where c.list_id = v_list.id), 0),
        v_user_id);
    return query select 'created', 1;
  end
  $$;

-- Renames a category (editors): its items keep it. Outcomes: 'saved', 'conflict', 'duplicate_name',
-- 'not_found', 'not_permitted'.
create function public.rename_shopping_category(p_id uuid, p_expected_revision integer, p_name text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_category private.shopping_categories;
  begin
    if p_id is null or p_expected_revision is null or p_name is null
       or not private.is_visible_name(p_name, private.shopping_limit('category_name')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list((select c.list_id from private.shopping_categories c where c.id = p_id), v_user_id);
    select * into v_category from private.shopping_categories c where c.id = p_id for update;
    if v_list.id is null or v_category.id is null or v_category.list_id <> v_list.id then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_category.revision <> p_expected_revision then
      return query select 'conflict', v_category.revision;
      return;
    end if;
    if exists (select 1 from private.shopping_categories c
        where c.list_id = v_list.id and c.id <> v_category.id
          and private.shopping_name_key(c.name) = private.shopping_name_key(p_name)) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    update private.shopping_categories c set name = p_name, revision = c.revision + 1
      where c.id = v_category.id returning c.revision into v_category.revision;
    return query select 'saved', v_category.revision;
  end
  $$;

-- Moves a category one place up or down (editors). Outcomes: 'saved', 'unchanged', 'not_found',
-- 'not_permitted'.
create function public.move_shopping_category(p_id uuid, p_direction text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_category private.shopping_categories;
    v_other private.shopping_categories;
  begin
    if p_id is null or coalesce(p_direction, '') not in ('up', 'down') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list((select c.list_id from private.shopping_categories c where c.id = p_id), v_user_id);
    if v_list.id is null or not exists (select 1 from private.shopping_categories c where c.id = p_id and c.list_id = v_list.id) then
      return 'not_found';
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return 'not_permitted';
    end if;
    update private.shopping_categories c set position = o.ord::integer
      from (select x.id, row_number() over (order by x.position, x.created_at, x.id) - 1 as ord
        from private.shopping_categories x where x.list_id = v_list.id) o
      where c.id = o.id and c.position <> o.ord;
    select * into v_category from private.shopping_categories c where c.id = p_id;
    select * into v_other from private.shopping_categories c
      where c.list_id = v_list.id
        and c.position = v_category.position + case when p_direction = 'up' then -1 else 1 end;
    if not found then
      return 'unchanged';
    end if;
    update private.shopping_categories c set position = v_other.position where c.id = v_category.id;
    update private.shopping_categories c set position = v_category.position where c.id = v_other.id;
    return 'saved';
  end
  $$;

-- Removes a category (editors). Its items are not deleted: they move to Uncategorized (the impact
-- the dialog showed). Rules that used it continue Uncategorized, flagged. Outcomes: 'deleted' (with
-- how many items moved), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_shopping_category(p_id uuid, p_expected_revision integer)
returns table (outcome text, moved_items integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_category private.shopping_categories;
    v_moved integer;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list((select c.list_id from private.shopping_categories c where c.id = p_id), v_user_id);
    select * into v_category from private.shopping_categories c where c.id = p_id for update;
    if v_list.id is null or v_category.id is null or v_category.list_id <> v_list.id then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_category.revision <> p_expected_revision then
      return query select 'conflict', null::integer;
      return;
    end if;
    -- The impact the dialog showed: the items the person can see (not those in the trash).
    select count(*)::integer into v_moved from private.shopping_items i
      where i.category_id = v_category.id and i.deleted_at is null;
    -- Items (also those in the trash) keep their place in the list's order, now Uncategorized.
    update private.shopping_items i
      set category_id = null, revision = i.revision + 1, updated_at = pg_catalog.now()
      where i.category_id = v_category.id;
    update private.shopping_recurrences r set category_id = null, category_lost = true, revision = r.revision + 1
      where r.category_id = v_category.id;
    delete from private.shopping_categories c where c.id = v_category.id;
    return query select 'deleted', v_moved;
  end
  $$;

-- Items ---------------------------------------------------------------------------------------------------

-- Adds one or more items (editors of an active list), each with its own client id, in the order
-- given, at the end of the list (and of their category, when one is chosen). Each row answers on its
-- own, so one invalid row never stops the others, and a retry never adds a row twice:
-- 'created', 'exists' (this id is already the caller's item in this list), 'id_taken', 'invalid'
-- (fields, or a category not of this list), 'duplicate' (an active item, possibly an earlier row,
-- reads the same; send allowDuplicate to keep it as a separate item), 'limit_reached',
-- 'not_found' / 'not_permitted' (every row, for the list).
-- A row: { "id": uuid, "name": text, "quantity": "1.25"|null, "unit": text|null,
--          "packaging": text|null, "notes": text|null, "categoryId": uuid|null,
--          "allowDuplicate": boolean }
create function public.add_shopping_items(p_list_id uuid, p_items jsonb)
returns table (id uuid, outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_row jsonb;
    v_id uuid;
    v_existing private.shopping_items;
    v_name text;
    v_quantity numeric;
    v_unit text;
    v_packaging text;
    v_notes text;
    v_category uuid;
    v_count integer;
  begin
    if p_list_id is null or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
       or pg_catalog.jsonb_array_length(p_items) not between 1 and private.shopping_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- Every row needs a well-formed id (the client's retry key); anything else is malformed.
    if exists (select 1 from pg_catalog.jsonb_array_elements(p_items) x
        where pg_catalog.jsonb_typeof(x) <> 'object' or coalesce(x ->> 'id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list(p_list_id, v_user_id);
    if v_list.id is null or not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select (x ->> 'id')::uuid,
          case when v_list.id is null then 'not_found' else 'not_permitted' end
        from pg_catalog.jsonb_array_elements(p_items) x;
      return;
    end if;
    v_count := private.shopping_item_count(v_list.id);
    for v_row in select * from pg_catalog.jsonb_array_elements(p_items) loop
      v_id := (v_row ->> 'id')::uuid;
      select * into v_existing from private.shopping_items i where i.id = v_id;
      if found then
        id := v_id;
        outcome := case when v_existing.list_id = v_list.id and v_existing.created_by = v_user_id
          then 'exists' else 'id_taken' end;
        return next;
        continue;
      end if;
      -- Text fields must be strings or null; a quantity a decimal string (never a float).
      if pg_catalog.jsonb_typeof(v_row -> 'name') is distinct from 'string'
         or coalesce(pg_catalog.jsonb_typeof(v_row -> 'quantity'), 'null') not in ('null', 'string')
         or coalesce(pg_catalog.jsonb_typeof(v_row -> 'unit'), 'null') not in ('null', 'string')
         or coalesce(pg_catalog.jsonb_typeof(v_row -> 'packaging'), 'null') not in ('null', 'string')
         or coalesce(pg_catalog.jsonb_typeof(v_row -> 'notes'), 'null') not in ('null', 'string')
         or coalesce(pg_catalog.jsonb_typeof(v_row -> 'categoryId'), 'null') not in ('null', 'string')
         or coalesce(v_row ->> 'quantity', '0') !~ '^[0-9]{1,6}(\.[0-9]{1,3})?$'
         or coalesce(v_row ->> 'categoryId', '00000000-0000-0000-0000-000000000000')
           !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        id := v_id;
        outcome := 'invalid';
        return next;
        continue;
      end if;
      v_name := v_row ->> 'name';
      v_quantity := (v_row ->> 'quantity')::numeric;
      v_unit := v_row ->> 'unit';
      v_packaging := v_row ->> 'packaging';
      v_notes := v_row ->> 'notes';
      v_category := (v_row ->> 'categoryId')::uuid;
      if not private.valid_shopping_fields(v_name, v_quantity, v_unit, v_packaging, v_notes)
         or (v_category is not null and not exists (
           select 1 from private.shopping_categories c where c.id = v_category and c.list_id = v_list.id)) then
        id := v_id;
        outcome := 'invalid';
        return next;
        continue;
      end if;
      if not coalesce((v_row ->> 'allowDuplicate')::boolean, false)
         and private.shopping_duplicate(v_list.id, v_name) then
        id := v_id;
        outcome := 'duplicate';
        return next;
        continue;
      end if;
      if v_count >= private.shopping_limit('items') then
        id := v_id;
        outcome := 'limit_reached';
        return next;
        continue;
      end if;
      insert into private.shopping_items (
        id, list_id, category_id, name, quantity, unit, packaging, notes, position, created_by
      ) values (
        v_id, v_list.id, v_category, v_name, v_quantity, v_unit, v_packaging, v_notes,
        private.shopping_next_position(v_list.id), v_user_id
      );
      perform private.shopping_event(v_id, 'added', v_user_id);
      v_count := v_count + 1;
      id := v_id;
      outcome := 'created';
      return next;
    end loop;
  end
  $$;

-- Edits an item's details or category (editors of an active list). A new category puts it at the end
-- of that group. Never changes its completion. Outcomes: 'saved' (with the new revision), 'conflict'
-- (with the current one), 'invalid_category', 'not_found', 'not_permitted'. 22023 for invalid fields.
-- Every optional field defaults to null (cleared), so the generated types let the app omit it.
create function public.update_shopping_item(
  p_item_id uuid, p_expected_revision integer, p_name text, p_quantity numeric default null,
  p_unit text default null, p_packaging text default null, p_notes text default null,
  p_category_id uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
  begin
    if p_item_id is null or p_expected_revision is null
       or not private.valid_shopping_fields(p_name, p_quantity, p_unit, p_packaging, p_notes) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_item := private.lock_shopping_item(p_item_id, v_user_id);
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if v_item.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_item.revision <> p_expected_revision then
      return query select 'conflict', v_item.revision;
      return;
    end if;
    if p_category_id is not null and not exists (
        select 1 from private.shopping_categories c where c.id = p_category_id and c.list_id = v_list.id) then
      return query select 'invalid_category', null::integer;
      return;
    end if;
    update private.shopping_items i
      set name = p_name, quantity = p_quantity, unit = p_unit, packaging = p_packaging, notes = p_notes,
        position = case when i.category_id is distinct from p_category_id
          then private.shopping_next_position(v_list.id) else i.position end,
        category_id = p_category_id,
        revision = i.revision + 1, updated_at = pg_catalog.now()
      where i.id = v_item.id
      returning * into v_item;
    perform private.shopping_event(v_item.id, 'edited', v_user_id);
    return query select 'saved', v_item.revision;
  end
  $$;

-- Checks an item off or back on (set-to-state; checkers of an active list). Checking a completed
-- item answers 'unchanged' with who completed it. Unchecking names the completion the caller saw
-- (p_seen_completed_at): a newer completion answers 'conflict' instead of being undone unseen.
-- Outcomes: 'completed', 'reopened', 'unchanged', 'conflict', 'not_found', 'not_permitted'.
create function public.set_shopping_item_completed(
  p_item_id uuid, p_completed boolean, p_seen_completed_at timestamptz default null
) returns table (outcome text, completed_at timestamptz, completed_by jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
  begin
    if p_item_id is null or p_completed is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_item := private.lock_shopping_item(p_item_id, v_user_id);
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if v_item.id is null then
      return query select 'not_found', null::timestamptz, null::jsonb;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'check') then
      return query select 'not_permitted', null::timestamptz, null::jsonb;
      return;
    end if;
    if p_completed = (v_item.completed_at is not null) then
      return query select 'unchanged', v_item.completed_at,
        private.shopping_person(v_list.owner_home_id, v_item.completed_by, v_user_id);
      return;
    end if;
    if not p_completed and p_seen_completed_at is not null
       and date_trunc('milliseconds', v_item.completed_at) <> date_trunc('milliseconds', p_seen_completed_at) then
      return query select 'conflict', v_item.completed_at,
        private.shopping_person(v_list.owner_home_id, v_item.completed_by, v_user_id);
      return;
    end if;
    update private.shopping_items i
      set completed_at = case when p_completed then pg_catalog.now() end,
        completed_by = case when p_completed then v_user_id end,
        revision = i.revision + 1, updated_at = pg_catalog.now()
      where i.id = v_item.id
      returning * into v_item;
    perform private.shopping_event(v_item.id, case when p_completed then 'completed' else 'reopened' end, v_user_id);
    return query select case when p_completed then 'completed' else 'reopened' end, v_item.completed_at,
      private.shopping_person(v_list.owner_home_id, v_item.completed_by, v_user_id);
  end
  $$;

-- Moves an active item one place up or down within its group (editors). Outcomes: 'saved',
-- 'unchanged', 'not_found', 'not_permitted'.
create function public.move_shopping_item(p_item_id uuid, p_direction text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
    v_other private.shopping_items;
  begin
    if p_item_id is null or coalesce(p_direction, '') not in ('up', 'down') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_item := private.lock_shopping_item(p_item_id, v_user_id);
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if v_item.id is null then
      return 'not_found';
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return 'not_permitted';
    end if;
    if v_item.completed_at is not null then
      return 'unchanged';
    end if;
    -- The neighbour in the same group (category, active), as the page shows the group.
    select * into v_other from private.shopping_items i
      where i.list_id = v_list.id and i.deleted_at is null and i.completed_at is null
        and i.category_id is not distinct from v_item.category_id and i.id <> v_item.id
        and case when p_direction = 'up'
          then (i.position, i.created_at, i.id) < (v_item.position, v_item.created_at, v_item.id)
          else (i.position, i.created_at, i.id) > (v_item.position, v_item.created_at, v_item.id) end
      order by
        case when p_direction = 'up' then i.position end desc,
        case when p_direction = 'up' then i.created_at end desc,
        case when p_direction = 'up' then i.id end desc,
        case when p_direction = 'down' then i.position end,
        case when p_direction = 'down' then i.created_at end,
        case when p_direction = 'down' then i.id end
      limit 1
      for update;
    if not found then
      return 'unchanged';
    end if;
    if v_other.position = v_item.position then
      -- Equal positions (never written by these functions, but possible after restores): make room.
      update private.shopping_items i set position = i.position + 1
        where i.list_id = v_list.id and i.position >= v_item.position and i.id <> v_item.id
          and (i.position, i.created_at, i.id) >= (v_item.position, v_item.created_at, v_item.id);
      select * into v_other from private.shopping_items i where i.id = v_other.id;
    end if;
    update private.shopping_items i set position = v_other.position, updated_at = pg_catalog.now()
      where i.id = v_item.id;
    update private.shopping_items i set position = v_item.position, updated_at = pg_catalog.now()
      where i.id = v_other.id;
    return 'saved';
  end
  $$;

-- Moves an item to the trash (editors of an active list). Outcomes: 'deleted' (with the entry),
-- 'not_found', 'not_permitted'.
create function public.delete_shopping_item(p_item_id uuid) returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
  begin
    if p_item_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_item := private.lock_shopping_item(p_item_id, v_user_id);
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if v_item.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    update private.shopping_items i set deleted_at = pg_catalog.now(), updated_at = pg_catalog.now()
      where i.id = v_item.id;
    perform private.shopping_event(v_item.id, 'deleted', v_user_id);
    return query select 'deleted',
      private.trash_move(v_user_id, 'shopping', 'shopping_item', v_item.id, v_list.owner_user_id,
        v_list.owner_home_id, v_item.name);
  end
  $$;

-- Clears the completed items the caller saw (editors of an active list): those still completed go to
-- the trash together as one entry; ones reopened or gone meanwhile are left alone and counted.
-- Outcomes: 'cleared' (with counts and the entry), 'unchanged' (nothing left to clear), 'not_found',
-- 'not_permitted'.
create function public.clear_completed_shopping_items(p_list_id uuid, p_item_ids uuid[])
returns table (outcome text, cleared integer, skipped integer, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_clear_id uuid := gen_random_uuid();
    v_ids uuid[];
    v_requested integer;
  begin
    if p_list_id is null or p_item_ids is null
       or cardinality(p_item_ids) not between 1 and private.shopping_limit('items')
       or array_position(p_item_ids, null) is not null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_requested := (select count(distinct x) from unnest(p_item_ids) x)::integer;
    v_list := private.lock_shopping_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::integer, null::integer, null::uuid;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::integer, null::uuid;
      return;
    end if;
    select array_agg(i.id order by i.id) into v_ids from private.shopping_items i
      where i.list_id = v_list.id and i.id = any (p_item_ids)
        and i.deleted_at is null and i.completed_at is not null;
    if v_ids is null then
      return query select 'unchanged', 0, v_requested, null::uuid;
      return;
    end if;
    insert into private.shopping_clears (id, list_id, item_count, cleared_by)
      values (v_clear_id, v_list.id, cardinality(v_ids), v_user_id);
    update private.shopping_items i
      set deleted_at = pg_catalog.now(), clear_id = v_clear_id, updated_at = pg_catalog.now()
      where i.id = any (v_ids);
    insert into private.shopping_item_events (item_id, kind, actor)
      select x, 'cleared', v_user_id from unnest(v_ids) x;
    return query select 'cleared', cardinality(v_ids), v_requested - cardinality(v_ids),
      private.trash_move(v_user_id, 'shopping', 'shopping_clear', v_clear_id, v_list.owner_user_id,
        v_list.owner_home_id, v_list.name);
  end
  $$;

-- Moves or copies an item to another active list of the same context (editors of both). Move keeps
-- the item (and its history); Copy makes a new one with the client id p_copy_id (a retry answers
-- 'exists'). The destination category is only ever the one chosen (null: Uncategorized). A completed
-- item keeps its completion (p_keep_completed) or is reopened; a kept completion keeps its actor and
-- time and is recorded as 'copied', never as a new completion. A copy never takes a recurring rule;
-- a moved item leaves its rule (which stays on its list).
-- Outcomes: 'moved', 'copied', 'exists', 'duplicate' (an active item there reads the same; send
-- p_allow_duplicate), 'conflict' (the item changed since it was read), 'same_list',
-- 'destination_unavailable' (archived, deleted, another context, or not the caller's to add to),
-- 'invalid_category', 'id_taken', 'not_found', 'not_permitted'.
create function public.transfer_shopping_item(
  p_item_id uuid, p_mode text, p_destination_list_id uuid, p_expected_revision integer,
  p_category_id uuid default null, p_keep_completed boolean default true,
  p_allow_duplicate boolean default false, p_copy_id uuid default null
) returns table (outcome text, item_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_source_list_id uuid;
    v_first private.shopping_lists;
    v_second private.shopping_lists;
    v_source private.shopping_lists;
    v_destination private.shopping_lists;
    v_item private.shopping_items;
    v_existing private.shopping_items;
    v_keep boolean := coalesce(p_keep_completed, true);
  begin
    if p_item_id is null or coalesce(p_mode, '') not in ('move', 'copy') or p_destination_list_id is null
       or p_expected_revision is null or (p_mode = 'copy' and p_copy_id is null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_mode = 'copy' then
      select * into v_existing from private.shopping_items i where i.id = p_copy_id;
      if found then
        return query select case when v_existing.created_by = v_user_id
          and v_existing.list_id = p_destination_list_id then 'exists' else 'id_taken' end, p_copy_id;
        return;
      end if;
    end if;
    select i.list_id into v_source_list_id from private.shopping_items i where i.id = p_item_id;
    if v_source_list_id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if v_source_list_id = p_destination_list_id then
      return query select 'same_list', null::uuid;
      return;
    end if;
    -- Both lists in id order, so two transfers between the same lists cannot wait on each other.
    v_first := private.lock_shopping_list(least(v_source_list_id, p_destination_list_id), v_user_id);
    v_second := private.lock_shopping_list(greatest(v_source_list_id, p_destination_list_id), v_user_id);
    if v_first.id = v_source_list_id then
      v_source := v_first;
      v_destination := v_second;
    else
      v_source := v_second;
      v_destination := v_first;
    end if;
    select * into v_item from private.shopping_items i where i.id = p_item_id for update;
    if v_source.id is null or v_item.id is null or v_item.deleted_at is not null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if v_item.list_id <> v_source.id then
      -- Moved elsewhere while this request waited for the lists: it is no longer where it was read.
      return query select 'conflict', null::uuid;
      return;
    end if;
    if not private.shopping_may(v_source, v_user_id, case when p_mode = 'move' then 'edit' else 'view' end) then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    -- Never across contexts: Personal to Home, Home to Personal, or another Home.
    if v_destination.id is null
       or v_destination.owner_home_id is distinct from v_source.owner_home_id
       or v_destination.owner_user_id is distinct from v_source.owner_user_id then
      return query select case when v_destination.id is null then 'destination_unavailable' else 'not_permitted' end, null::uuid;
      return;
    end if;
    if v_destination.archived_at is not null or not private.shopping_may(v_destination, v_user_id, 'edit') then
      return query select 'destination_unavailable', null::uuid;
      return;
    end if;
    if v_item.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    if p_category_id is not null and not exists (
        select 1 from private.shopping_categories c where c.id = p_category_id and c.list_id = v_destination.id) then
      return query select 'invalid_category', null::uuid;
      return;
    end if;
    if not coalesce(p_allow_duplicate, false) and private.shopping_duplicate(v_destination.id, v_item.name) then
      return query select 'duplicate', null::uuid;
      return;
    end if;
    if private.shopping_item_count(v_destination.id) >= private.shopping_limit('items') then
      return query select 'limit_reached', null::uuid;
      return;
    end if;
    if p_mode = 'move' then
      update private.shopping_items i
        set list_id = v_destination.id, category_id = p_category_id,
          position = private.shopping_next_position(v_destination.id),
          completed_at = case when v_keep then i.completed_at end,
          completed_by = case when v_keep then i.completed_by end,
          recurrence_id = null, occurrence_on = null,
          revision = i.revision + 1, updated_at = pg_catalog.now()
        where i.id = v_item.id;
      perform private.shopping_event(v_item.id, 'moved_out', v_user_id, v_destination.id);
      perform private.shopping_event(v_item.id, 'moved_in', v_user_id, v_source.id);
      if v_item.completed_at is not null and not v_keep then
        perform private.shopping_event(v_item.id, 'reopened', v_user_id);
      end if;
      return query select 'moved', v_item.id;
      return;
    end if;
    insert into private.shopping_items (
      id, list_id, category_id, name, quantity, unit, packaging, notes, position,
      completed_at, completed_by, created_by
    ) values (
      p_copy_id, v_destination.id, p_category_id, v_item.name, v_item.quantity, v_item.unit,
      v_item.packaging, v_item.notes, private.shopping_next_position(v_destination.id),
      case when v_keep then v_item.completed_at end, case when v_keep then v_item.completed_by end,
      v_user_id
    );
    perform private.shopping_event(p_copy_id, 'copied', v_user_id, v_source.id);
    return query select 'copied', p_copy_id;
  end
  $$;

-- An item's history, newest first (viewers of the list): kinds, who (membership id or "me") and when.
create function public.shopping_item_history(p_item_id uuid)
returns table (kind text, at timestamptz, actor jsonb, other_list_name text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
  begin
    select * into v_item from private.shopping_items i where i.id = p_item_id;
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if v_item.id is null or v_item.deleted_at is not null or private.shopping_access(v_list, v_user_id) is null then
      return;
    end if;
    return query
      select e.kind, e.at, private.shopping_person(v_list.owner_home_id, e.actor, v_user_id),
        -- The other list of a move or copy: always of the same context, so its name reveals nothing.
        (select o.name from private.shopping_lists o where o.id = e.other_list_id and o.deleted_at is null
          and o.owner_home_id is not distinct from v_list.owner_home_id
          and o.owner_user_id is not distinct from v_list.owner_user_id)
      from private.shopping_item_events e
      where e.item_id = v_item.id
      order by e.at desc, e.id desc
      limit private.shopping_limit('history');
  end
  $$;

-- Recurring items ---------------------------------------------------------------------------------------

-- Starts repeating an active item (editors of an active list): the rule takes the item's details and
-- this item stands for today's occurrence. p_time_zone is the person's effective timezone (Personal
-- lists only; a Home uses its own). Outcomes: 'created' (with the next due day), 'exists' (a retry),
-- 'id_taken', 'already_repeating', 'completed' (check it back first), 'limit_reached', 'not_found',
-- 'not_permitted'. 22023 for an invalid schedule.
create function public.start_shopping_recurrence(
  p_item_id uuid, p_id uuid, p_frequency text, p_weekdays smallint[] default null,
  p_month_day smallint default null, p_start_on date default null, p_time_zone text default null
) returns table (outcome text, revision integer, next_on date)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
    v_existing private.shopping_recurrences;
    v_zone text;
    v_today date;
    v_next date;
  begin
    if p_item_id is null or p_id is null
       or not private.valid_shopping_schedule(p_frequency, p_weekdays, p_month_day) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_item := private.lock_shopping_item(p_item_id, v_user_id);
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if v_item.id is null then
      return query select 'not_found', null::integer, null::date;
      return;
    end if;
    select * into v_existing from private.shopping_recurrences r where r.id = p_id;
    if found then
      if v_existing.list_id = v_list.id and v_existing.created_by = v_user_id then
        return query select 'exists', v_existing.revision, v_existing.next_on;
      else
        return query select 'id_taken', null::integer, null::date;
      end if;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::date;
      return;
    end if;
    if v_item.recurrence_id is not null and exists (
        select 1 from private.shopping_recurrences r where r.id = v_item.recurrence_id and r.ended_at is null) then
      return query select 'already_repeating', null::integer, null::date;
      return;
    end if;
    if v_item.completed_at is not null then
      return query select 'completed', null::integer, null::date;
      return;
    end if;
    if (select count(*) from private.shopping_recurrences r where r.list_id = v_list.id and r.ended_at is null)
       >= private.shopping_limit('recurrences') then
      return query select 'limit_reached', null::integer, null::date;
      return;
    end if;
    if v_list.owner_home_id is null then
      select z.name into v_zone from pg_catalog.pg_timezone_names z where z.name = p_time_zone;
    end if;
    v_today := private.shopping_today(v_list.owner_home_id, v_zone);
    v_next := private.shopping_due_on_or_after(p_frequency, p_weekdays, p_month_day, p_start_on, v_today + 1);
    insert into private.shopping_recurrences (
      id, list_id, name, quantity, unit, packaging, notes, category_id, frequency, weekdays,
      month_day, start_on, time_zone, next_on, created_by
    ) values (
      p_id, v_list.id, v_item.name, v_item.quantity, v_item.unit, v_item.packaging, v_item.notes,
      v_item.category_id, p_frequency, p_weekdays, p_month_day, p_start_on, v_zone, v_next, v_user_id
    );
    update private.shopping_items i
      set recurrence_id = p_id, occurrence_on = v_today, revision = i.revision + 1, updated_at = pg_catalog.now()
      where i.id = v_item.id;
    return query select 'created', 1, v_next;
  end
  $$;

-- Changes a rule (editors of an active list): 'schedule' saves a new schedule (and, with
-- p_template_item_id, the details of that item, which must be the rule's active item) for the next
-- and later occurrences only; 'pause' and 'resume' (restarts from today, never catches up); 'stop'
-- ends it, keeping its items and their history. Outcomes: 'saved' (with the revision and next due
-- day), 'conflict', 'invalid_item', 'not_found', 'not_permitted'.
create function public.update_shopping_recurrence(
  p_id uuid, p_expected_revision integer, p_action text, p_frequency text default null,
  p_weekdays smallint[] default null, p_month_day smallint default null, p_start_on date default null,
  p_template_item_id uuid default null, p_time_zone text default null
) returns table (outcome text, revision integer, next_on date)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_rule private.shopping_recurrences;
    v_item private.shopping_items;
    v_today date;
    v_zone text;
  begin
    if p_id is null or p_expected_revision is null
       or coalesce(p_action, '') not in ('schedule', 'pause', 'resume', 'stop')
       or (p_action = 'schedule' and not private.valid_shopping_schedule(p_frequency, p_weekdays, p_month_day)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list(
      (select r.list_id from private.shopping_recurrences r where r.id = p_id), v_user_id);
    select * into v_rule from private.shopping_recurrences r where r.id = p_id for update;
    if v_list.id is null or v_rule.id is null or v_rule.list_id <> v_list.id or v_rule.ended_at is not null then
      return query select 'not_found', null::integer, null::date;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted', null::integer, null::date;
      return;
    end if;
    if v_rule.revision <> p_expected_revision then
      return query select 'conflict', v_rule.revision, null::date;
      return;
    end if;
    v_zone := v_rule.time_zone;
    if p_action = 'schedule' and v_list.owner_home_id is null and p_time_zone is not null then
      select z.name into v_zone from pg_catalog.pg_timezone_names z where z.name = p_time_zone;
      v_zone := coalesce(v_zone, v_rule.time_zone);
    end if;
    v_today := private.shopping_today(v_list.owner_home_id, v_zone);
    if p_action = 'schedule' then
      if p_template_item_id is not null then
        select * into v_item from private.shopping_items i
          where i.id = p_template_item_id and i.list_id = v_list.id and i.recurrence_id = v_rule.id
            and i.deleted_at is null;
        if not found then
          return query select 'invalid_item', null::integer, null::date;
          return;
        end if;
      end if;
      update private.shopping_recurrences r
        set frequency = p_frequency, weekdays = p_weekdays, month_day = p_month_day,
          start_on = p_start_on, time_zone = v_zone,
          next_on = private.shopping_due_on_or_after(p_frequency, p_weekdays, p_month_day, p_start_on, v_today + 1),
          name = coalesce(v_item.name, r.name),
          quantity = case when v_item.id is not null then v_item.quantity else r.quantity end,
          unit = case when v_item.id is not null then v_item.unit else r.unit end,
          packaging = case when v_item.id is not null then v_item.packaging else r.packaging end,
          notes = case when v_item.id is not null then v_item.notes else r.notes end,
          category_id = case when v_item.id is not null then v_item.category_id else r.category_id end,
          category_lost = case when v_item.id is not null then false else r.category_lost end,
          revision = r.revision + 1, updated_at = pg_catalog.now()
        where r.id = v_rule.id
        returning * into v_rule;
    elsif p_action = 'pause' then
      update private.shopping_recurrences r
        set paused_at = coalesce(r.paused_at, pg_catalog.now()), revision = r.revision + 1,
          updated_at = pg_catalog.now()
        where r.id = v_rule.id
        returning * into v_rule;
    elsif p_action = 'resume' then
      update private.shopping_recurrences r
        set paused_at = null,
          next_on = case when r.paused_at is null then r.next_on else
            private.shopping_due_on_or_after(r.frequency, r.weekdays, r.month_day, r.start_on, v_today) end,
          revision = r.revision + 1, updated_at = pg_catalog.now()
        where r.id = v_rule.id
        returning * into v_rule;
    else
      update private.shopping_recurrences r
        set ended_at = pg_catalog.now(), revision = r.revision + 1, updated_at = pg_catalog.now()
        where r.id = v_rule.id
        returning * into v_rule;
    end if;
    return query select 'saved', v_rule.revision, v_rule.next_on;
  end
  $$;

-- Widget ------------------------------------------------------------------------------------------------

-- A Shopping widget's rows: the active items of the selected lists of one context, in the order the
-- lists were chosen, then category and item order, at most p_limit. Lists that are archived, deleted,
-- of another context or not the caller's to see are left out and counted as unavailable, never
-- replaced. 42501 for a Home the caller is not in.
create function public.shopping_widget(
  p_list_ids uuid[], p_home_id uuid default null, p_limit integer default 5
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_lists jsonb;
  begin
    perform private.require_shopping_context(p_home_id, v_user_id);
    if p_list_ids is null or cardinality(p_list_ids) > private.shopping_limit('widget_lists')
       or array_position(p_list_ids, null) is not null
       or cardinality(p_list_ids) <> (select count(distinct x) from unnest(p_list_ids) x)
       or p_limit is null or p_limit not between 1 and private.shopping_limit('widget_items') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    with chosen as (
      select x.id, x.ord from unnest(p_list_ids) with ordinality as x (id, ord)
    ), visible as (
      select c.ord, l.*, private.shopping_access(l, v_user_id) as access
      from chosen c join private.shopping_lists l on l.id = c.id
      where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
        and l.deleted_at is null and l.archived_at is null
        and private.shopping_access(l, v_user_id) is not null
    )
    select pg_catalog.jsonb_build_object(
      'lists', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', v.id, 'name', v.name, 'position', v.position, 'access', v.access) order by v.ord)
        from visible v), '[]'::jsonb),
      'unavailable', (select count(distinct c.id) from chosen c) - (select count(*) from visible),
      'total', (select count(*) from private.shopping_items i join visible v on v.id = i.list_id
        where i.deleted_at is null and i.completed_at is null),
      'items', coalesce((select pg_catalog.jsonb_agg(row_data order by ord, cpos, ipos, created, iid) from (
          select pg_catalog.jsonb_build_object(
            'id', i.id, 'listId', i.list_id, 'name', i.name,
            'quantity', pg_catalog.trim_scale(i.quantity)::text, 'unit', i.unit,
            'packaging', i.packaging, 'revision', i.revision) as row_data,
            v.ord, coalesce(c.position, 2147483647) as cpos, i.position as ipos, i.created_at as created,
            i.id as iid
          from private.shopping_items i
          join visible v on v.id = i.list_id
          left join private.shopping_categories c on c.id = i.category_id
          where i.deleted_at is null and i.completed_at is null
          order by v.ord, coalesce(c.position, 2147483647), i.position, i.created_at, i.id
          limit p_limit) widget_rows), '[]'::jsonb)
    ) into v_lists;
    return v_lists;
  end
  $$;

-- Trash ------------------------------------------------------------------------------------------------

-- The dispatch functions as they stood before shopping keep handling every other module; these
-- handle the shopping module and hand the rest on (the chores pattern).
alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_shopping;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_shopping;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_shopping;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_shopping;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_shopping;

-- What may be in the way of a shopping restore: a context already at its list limit
-- ('shopping_list_limit'), an item's list that is gone ('shopping_list_unavailable': restore the list
-- first) or full ('shopping_item_limit').
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_list private.shopping_lists;
    v_count integer;
  begin
    if p_entry.module <> 'shopping' then
      return private.trash_conflict_before_shopping(p_entry);
    end if;
    if p_entry.item_type = 'shopping_list' then
      select * into v_list from private.shopping_lists l where l.id = p_entry.subject_id;
      if not found or v_list.deleted_at is null then
        return 'item_missing';
      end if;
      if (select count(*) from private.shopping_lists l
          where ((v_list.owner_home_id is null and l.owner_user_id = v_list.owner_user_id)
              or l.owner_home_id = v_list.owner_home_id)
            and l.deleted_at is null) >= private.shopping_limit('lists') then
        return 'shopping_list_limit';
      end if;
      return null;
    end if;
    if p_entry.item_type = 'shopping_item' then
      select l.* into v_list from private.shopping_items i join private.shopping_lists l on l.id = i.list_id
        where i.id = p_entry.subject_id and i.deleted_at is not null and i.clear_id is null;
      if not found then
        return 'item_missing';
      end if;
      v_count := 1;
    else
      select l.* into v_list from private.shopping_clears c join private.shopping_lists l on l.id = c.list_id
        where c.id = p_entry.subject_id;
      if not found then
        return 'item_missing';
      end if;
      select count(*)::integer into v_count from private.shopping_items i
        where i.clear_id = p_entry.subject_id and i.deleted_at is not null;
      if v_count = 0 then
        return 'item_missing';
      end if;
    end if;
    if v_list.deleted_at is not null then
      return 'shopping_list_unavailable';
    end if;
    if private.shopping_item_count(v_list.id) + v_count > private.shopping_limit('items') then
      return 'shopping_item_limit';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case
    when p_kind in ('shopping_list_limit', 'shopping_list_unavailable', 'shopping_item_limit')
      then array[]::text[]
    else private.trash_conflict_options_before_shopping(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'shopping' then
      perform private.trash_resolve_before_shopping(p_entry, p_resolution);
    end if;
    -- Shopping conflicts have no resolution: they ask the person to restore or free space first.
  end
  $$;

-- A list comes back with its items, categories and rules (rules restart from today: no backlog). An
-- item comes back at the end of its list (Uncategorized when its category was removed meanwhile);
-- cleared items come back to their list as Completed. Access is as it is now, never as it was.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_list private.shopping_lists;
    v_list_id uuid;
  begin
    if p_entry.module <> 'shopping' then
      return private.trash_item_restore_before_shopping(p_entry);
    end if;
    v_list_id := case p_entry.item_type
      when 'shopping_list' then p_entry.subject_id
      when 'shopping_item' then (select i.list_id from private.shopping_items i where i.id = p_entry.subject_id)
      else (select c.list_id from private.shopping_clears c where c.id = p_entry.subject_id)
    end;
    if p_entry.item_type = 'shopping_list' then
      perform private.lock_shopping_context(
        (select l.owner_home_id from private.shopping_lists l where l.id = v_list_id),
        (select l.owner_user_id from private.shopping_lists l where l.id = v_list_id));
    end if;
    select * into v_list from private.shopping_lists l where l.id = v_list_id for update;
    if v_list.id is null or private.trash_conflict(p_entry) is not null then
      raise exception 'shopping restore unavailable' using errcode = '23505';
    end if;
    if p_entry.item_type = 'shopping_list' then
      update private.shopping_lists l
        set deleted_at = null, revision = l.revision + 1, updated_at = pg_catalog.now(),
          position = coalesce((select max(x.position) + 1 from private.shopping_lists x
            where ((v_list.owner_home_id is null and x.owner_user_id = v_list.owner_user_id)
                or x.owner_home_id = v_list.owner_home_id)
              and x.deleted_at is null), 0)
        where l.id = v_list.id
        returning * into v_list;
      perform private.restart_shopping_rules(v_list);
    elsif p_entry.item_type = 'shopping_item' then
      update private.shopping_items i
        set deleted_at = null, position = private.shopping_next_position(v_list.id),
          revision = i.revision + 1, updated_at = pg_catalog.now()
        where i.id = p_entry.subject_id;
      perform private.shopping_event(p_entry.subject_id, 'restored', auth.uid());
    else
      insert into private.shopping_item_events (item_id, kind, actor)
        select i.id, 'restored', auth.uid() from private.shopping_items i
        where i.clear_id = p_entry.subject_id and i.deleted_at is not null;
      update private.shopping_items i
        set deleted_at = null, clear_id = null, revision = i.revision + 1, updated_at = pg_catalog.now()
        where i.clear_id = p_entry.subject_id and i.deleted_at is not null;
      delete from private.shopping_clears c where c.id = p_entry.subject_id;
    end if;
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'shopping' then
      perform private.trash_item_purge_before_shopping(p_entry);
      return;
    end if;
    if p_entry.item_type = 'shopping_list' then
      -- Items, categories, rules, clears and history go with it (on delete cascade).
      delete from private.shopping_lists l where l.id = p_entry.subject_id and l.deleted_at is not null;
    elsif p_entry.item_type = 'shopping_item' then
      delete from private.shopping_items i
        where i.id = p_entry.subject_id and i.deleted_at is not null and i.clear_id is null;
    else
      delete from private.shopping_items i where i.clear_id = p_entry.subject_id and i.deleted_at is not null;
      delete from private.shopping_clears c where c.id = p_entry.subject_id;
    end if;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The shopping API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_shopping_context', 'advance_shopping', 'list_shopping_lists', 'create_shopping_list',
      'update_shopping_list', 'move_shopping_list', 'delete_shopping_list', 'get_shopping_list',
      'create_shopping_category', 'rename_shopping_category', 'move_shopping_category',
      'delete_shopping_category', 'add_shopping_items', 'update_shopping_item',
      'set_shopping_item_completed', 'move_shopping_item', 'delete_shopping_item',
      'clear_completed_shopping_items', 'transfer_shopping_item', 'shopping_item_history',
      'start_shopping_recurrence', 'update_shopping_recurrence', 'shopping_widget'
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
      p.proname like '%shopping%'
      or p.proname in ('is_delegable_capability', 'trash_conflict', 'trash_conflict_options',
        'trash_resolve', 'trash_item_restore', 'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
