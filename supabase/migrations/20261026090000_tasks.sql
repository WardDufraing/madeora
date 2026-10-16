-- S18: tasks core (brief plans/steps/S18-brief.md; ADR 0022; spec "Confirmed independent tasks
-- without cross-task dependencies", "Confirmed basic task activity information", "Confirmed reusable
-- task labels", "Confirmed multiple named task lists and All Tasks view", "Confirmed optional task
-- start and due dates", "Confirmed multiple Home task assignees with shared completion", "Confirmed
-- chronological task comments", "Confirmed task priority levels", "Confirmed simple task subtasks",
-- "Confirmed member departure and removal: content ownership" (task reassignment rule)).
--
-- Every list, task and label belongs to one context: a person (their Personal space) or a Home.
-- Nothing here is exposed as a table; people use security-definer functions that run with their own
-- session and recheck the confirmed caller and their current membership on every call. A Home the
-- caller does not belong to answers 42501 "not permitted" exactly like one that does not exist; a
-- task, list, label, subtask or comment they may not see answers 'not_found' exactly like a missing one.
--
-- Who may do what (default picked in the brief, owner may override; the per-module permission matrix
-- is open in the spec). packages/domain/src/permissions/tasks.ts makes the same decisions:
-- - Personal context: its owner, for everything. Personal tasks have no assignees.
-- - Home: every current member views lists, tasks, labels, subtasks and comments, creates tasks in
--   an active list and comments; a task's creator, its assignees and task managers edit it (content,
--   labels, subtasks, list) and complete or reopen it; its creator and task managers delete it; only
--   task managers set assignees (spec: "the existing Home task-management permission") and manage
--   lists and labels. Task managers: the Owner, and Administrators granted the new delegable
--   capability manageHomeTasks. A member edits and deletes only their own comments.
--
-- People are never identified by account id outside their own Personal context: Home answers name
-- members by membership id (the stable Home-member identifier of public.home_directory) and say
-- "is me"; a departed member reads as null, so attribution stays without granting anything.
--
-- Concurrency: tasks, lists, labels, subtasks and comments carry a revision; an edit names the
-- revision it started from and a stale one answers 'conflict' instead of overwriting. Completion is
-- set-to-state under the task's row lock, so simultaneous completions record one actor and one
-- event. Creates take a client-generated id, so a retried request returns the same row.

-- Audit subjects and the new Administrator capability ----------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks'
  );
  $$;

-- Limits and text rules ----------------------------------------------------------------------------

-- apps/web/src/tasks/schema.ts uses the same numbers.
create function private.task_limit(p_name text) returns integer
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
  end;
  $$;

-- What two names compare as when looking for confusing duplicates: compatibility-normalized, lower
-- case, runs of whitespace as one space.
create function private.task_name_key(p_name text) returns text
  language sql immutable strict set search_path = '' as $$
  select pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.normalize(p_name, 'NFKC'), '\s+', ' ', 'g'));
  $$;

-- Plain multi-line text (descriptions, comments): within the limit, not only whitespace, and no
-- control characters other than tab, line feed and carriage return.
create function private.is_plain_text(p_text text, p_max integer) returns boolean
  language sql immutable strict set search_path = '' as $$
  select pg_catalog.char_length(p_text) between 1 and p_max
    and pg_catalog.btrim(p_text, E' \t\r\n') <> ''
    and p_text !~ '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]';
  $$;

-- Tables -------------------------------------------------------------------------------------------

create table private.task_lists (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  name text not null constraint task_lists_name_check check (private.is_visible_name(name, 60)),
  position integer not null default 0,
  archived_at timestamptz,
  -- Set while the list is in the trash (S16).
  deleted_at timestamptz,
  revision integer not null default 1 constraint task_lists_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_lists_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create index task_lists_user_idx on private.task_lists (owner_user_id, position)
  where deleted_at is null and owner_user_id is not null;
create index task_lists_home_idx on private.task_lists (owner_home_id, position)
  where deleted_at is null and owner_home_id is not null;

create table private.tasks (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  -- Exactly one list while the task is active. Purging a list leaves its trashed tasks without one;
  -- restoring them then asks for a destination.
  list_id uuid references private.task_lists (id) on delete set null,
  title text not null constraint tasks_title_check check (private.is_visible_name(title, 200)),
  description text constraint tasks_description_check
    check (description is null or private.is_plain_text(description, 5000)),
  -- Calendar dates in the context's timezone (date-only: never converted to instants).
  start_date date,
  due_date date,
  -- Null is "unspecified", distinct from an explicit 'normal' (it sorts as Normal).
  priority text constraint tasks_priority_check check (priority in ('low', 'normal', 'high', 'urgent')),
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  -- The last reopening, shown next to the completion (spec: who completed or reopened it, and when).
  reopened_at timestamptz,
  reopened_by uuid references auth.users (id) on delete set null,
  -- Set when an assignee left the Home while the task was open (spec reassignment rule); cleared when
  -- a task manager sets the assignees again.
  needs_reassignment boolean not null default false,
  revision integer not null default 1 constraint tasks_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tasks_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint tasks_dates_check check (start_date is null or due_date is null or start_date <= due_date),
  constraint tasks_list_check check (list_id is not null or deleted_at is not null),
  constraint tasks_completed_by_check check (completed_at is not null or completed_by is null),
  -- So assignees can name the task's Home in their own foreign key.
  constraint tasks_id_home_key unique (id, owner_home_id)
);

create index tasks_list_idx on private.tasks (list_id) where deleted_at is null;
create index tasks_home_idx on private.tasks (owner_home_id, due_date)
  where deleted_at is null and owner_home_id is not null;
create index tasks_user_idx on private.tasks (owner_user_id, due_date)
  where deleted_at is null and owner_user_id is not null;

-- A Home task's assignees. Both foreign keys hold the rule "a current member of the task's Home":
-- the assignment names the task's Home, and the membership must exist; when it ends (leaving,
-- removal, account deletion) the assignment ends with it.
create table private.task_assignees (
  task_id uuid not null,
  home_id uuid not null,
  user_id uuid not null,
  assigned_by uuid references auth.users (id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (task_id, user_id),
  foreign key (task_id, home_id) references private.tasks (id, owner_home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index task_assignees_member_idx on private.task_assignees (home_id, user_id);

create table private.task_labels (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  name text not null constraint task_labels_name_check check (private.is_visible_name(name, 40)),
  -- An accent palette id of packages/design-tokens (palette.ts; the app checks the same list); null
  -- is the neutral default. The name is always shown with it, so colour never carries meaning alone.
  color text constraint task_labels_color_check
    check (color in (
      'purple', 'blue', 'sky', 'teal', 'green', 'ochre', 'amber', 'orange', 'red', 'pink', 'magenta',
      'slate'
    )),
  revision integer not null default 1 constraint task_labels_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_labels_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create index task_labels_user_idx on private.task_labels (owner_user_id) where owner_user_id is not null;
create index task_labels_home_idx on private.task_labels (owner_home_id) where owner_home_id is not null;

-- Labels on a task; the functions only link labels of the task's own context.
create table private.task_label_links (
  task_id uuid not null references private.tasks (id) on delete cascade,
  label_id uuid not null references private.task_labels (id) on delete cascade,
  primary key (task_id, label_id)
);

create index task_label_links_label_idx on private.task_label_links (label_id);

create table private.subtasks (
  id uuid primary key,
  task_id uuid not null references private.tasks (id) on delete cascade,
  title text not null constraint subtasks_title_check check (private.is_visible_name(title, 200)),
  position integer not null default 0,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint subtasks_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subtasks_task_idx on private.subtasks (task_id, position);

create table private.task_comments (
  id uuid primary key,
  task_id uuid not null references private.tasks (id) on delete cascade,
  -- Null once the author's account is deleted: the text stays, attributed to nobody.
  author_id uuid references auth.users (id) on delete set null,
  body text not null constraint task_comments_body_check check (private.is_plain_text(body, 2000)),
  revision integer not null default 1 constraint task_comments_revision_check check (revision >= 1),
  -- The clock, not the transaction start, so comments keep the order they were written in.
  created_at timestamptz not null default clock_timestamp(),
  edited_at timestamptz
);

create index task_comments_task_idx on private.task_comments (task_id, created_at, id);

comment on table private.task_lists is 'S18: named task lists, personal or per Home. Not exposed through the API.';
comment on table private.tasks is 'S18: personal and Home tasks. Not exposed through the API.';
comment on table private.task_assignees is 'S18: Home task assignees (current members). Not exposed through the API.';
comment on table private.task_labels is 'S18: reusable task labels per context. Not exposed through the API.';
comment on table private.task_label_links is 'S18: labels on tasks. Not exposed through the API.';
comment on table private.subtasks is 'S18: single-level task checklists. Not exposed through the API.';
comment on table private.task_comments is 'S18: chronological plain-text task comments. Not exposed through the API.';

alter table private.task_lists enable row level security;
alter table private.tasks enable row level security;
alter table private.task_assignees enable row level security;
alter table private.task_labels enable row level security;
alter table private.task_label_links enable row level security;
alter table private.subtasks enable row level security;
alter table private.task_comments enable row level security;
revoke all on private.task_lists, private.tasks, private.task_assignees, private.task_labels,
  private.task_label_links, private.subtasks, private.task_comments
  from public, anon, authenticated;

-- Member departure (spec "Confirmed task reassignment rule") ---------------------------------------

-- Before a membership ends, the open tasks of that Home the person was assigned to are flagged for
-- reassignment; the assignment itself then ends through its foreign key. Content, dates and
-- completion history stay; completed tasks keep their attribution and are not flagged.
create function private.flag_departed_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    update private.tasks t set needs_reassignment = true
      where t.owner_home_id = old.home_id and t.completed_at is null and not t.needs_reassignment
        and exists (
          select 1 from private.task_assignees a where a.task_id = t.id and a.user_id = old.user_id
        );
    return old;
  end
  $$;

create trigger home_memberships_flag_task_assignments
  before delete on public.home_memberships
  for each row execute function private.flag_departed_assignments();

-- Permission helpers (the engine in packages/domain mirrors these) ----------------------------------

-- Whether p_user_id may see the context: its owner, or a current member of the Home.
create function private.in_task_context(p_owner_user_id uuid, p_owner_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  -- Every term is false, never null, when it does not hold.
  select p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (p_owner_home_id is not null and private.is_home_member(p_owner_home_id, p_user_id))
  );
  $$;

-- Task managers: the Personal space's owner; in a Home the Owner and Administrators granted
-- manageHomeTasks (engine action home.tasks.manage).
create function private.can_manage_tasks(p_owner_user_id uuid, p_owner_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (p_owner_home_id is not null
      and private.has_home_capability(p_owner_home_id, p_user_id, 'manageHomeTasks'))
  );
  $$;

create function private.is_task_assignee(p_task_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.task_assignees a where a.task_id = p_task_id and a.user_id = p_user_id
  );
  $$;

-- Edit and complete: a task manager, or a current member who created it or is assigned to it.
create function private.can_edit_task(p_task private.tasks, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.can_manage_tasks(p_task.owner_user_id, p_task.owner_home_id, p_user_id)
    or (
      p_task.owner_home_id is not null
      and private.is_home_member(p_task.owner_home_id, p_user_id)
      and (coalesce(p_task.created_by = p_user_id, false) or private.is_task_assignee(p_task.id, p_user_id))
    );
  $$;

-- Delete to the trash: a task manager, or the current member who created it.
create function private.can_delete_task(p_task private.tasks, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.can_manage_tasks(p_task.owner_user_id, p_task.owner_home_id, p_user_id)
    or (
      p_task.owner_home_id is not null
      and private.is_home_member(p_task.owner_home_id, p_user_id)
      and coalesce(p_task.created_by = p_user_id, false)
    );
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_task_context(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- Whether one already loaded row belongs to the caller's chosen context. Queries over a table write
-- the same condition inline as ((p_home_id is null and x.owner_user_id = user) or x.owner_home_id =
-- p_home_id), so the planner can use the per-context indexes (a function call would hide them).
create function private.is_context(
  p_owner_user_id uuid, p_owner_home_id uuid, p_home_id uuid, p_user_id uuid
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(case when p_home_id is null then p_owner_user_id = p_user_id
    else p_owner_home_id = p_home_id end, false);
  $$;

-- "Today" in the context: the Home's own timezone for a Home (whoever views it); for the Personal
-- space the person's effective timezone is known to the app only (it may be the browser's), so the
-- app passes its date, accepted only within a day of the UTC date (every zone is).
create function private.task_today(p_home_id uuid, p_today date) returns date
  language sql stable security definer set search_path = '' as $$
  select case
    when p_home_id is not null then
      (select (pg_catalog.now() at time zone h.timezone)::date from public.homes h where h.id = p_home_id)
    when p_today is not null
      and p_today between (pg_catalog.now() at time zone 'UTC')::date - 1
        and (pg_catalog.now() at time zone 'UTC')::date + 1 then p_today
    else (pg_catalog.now() at time zone 'UTC')::date
  end;
  $$;

-- A person as a Home answer may name them: their current membership id in that Home, or null (the
-- Personal space, a departed member or a deleted account).
create function private.member_ref(p_home_id uuid, p_user_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
  select m.id from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_user_id;
  $$;

create function private.audit_task(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids and counts only: never titles, names, descriptions or comments. Home actions only.
  select case when p_home_id is not null
    then private.audit(p_action, p_home_id, p_subject_type, p_subject_id, p_details) end;
  $$;

-- The caller's context ------------------------------------------------------------------------------

-- What the caller may do in a context, and its "today". 42501 for a Home they are not in.
create function public.get_task_context(p_home_id uuid default null, p_today date default null)
returns table (can_manage boolean, can_create boolean, today date)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    return query select
      private.can_manage_tasks(case when p_home_id is null then v_user_id end, p_home_id, v_user_id),
      true,
      private.task_today(p_home_id, p_today);
  end
  $$;

-- Lists ---------------------------------------------------------------------------------------------

-- The context's lists in their order, with counts of open and of all active tasks (the impact review
-- before archiving or deleting). Archived lists only when asked.
create function public.list_task_lists(p_home_id uuid default null, p_include_archived boolean default false)
returns table (
  id uuid, name text, "position" integer, archived boolean, revision integer,
  open_tasks integer, active_tasks integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    return query
      select l.id, l.name, l.position, l.archived_at is not null, l.revision,
        (select count(*)::integer from private.tasks t
          where t.list_id = l.id and t.deleted_at is null and t.completed_at is null),
        (select count(*)::integer from private.tasks t where t.list_id = l.id and t.deleted_at is null)
      from private.task_lists l
      where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
        and l.deleted_at is null and (coalesce(p_include_archived, false) or l.archived_at is null)
      order by l.archived_at is not null, l.position, l.created_at, l.id
      limit private.task_limit('lists');
  end
  $$;

-- Serializes name checks and limits within one context, so two creates cannot both pass.
create function private.lock_task_context(p_kind text, p_home_id uuid, p_user_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_kind || ':' || coalesce(p_home_id, p_user_id)::text, 0));
  $$;

create function private.task_list_name_taken(
  p_home_id uuid, p_user_id uuid, p_name text, p_except uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.task_lists l
    where ((p_home_id is null and l.owner_user_id = p_user_id) or l.owner_home_id = p_home_id)
      and l.deleted_at is null and l.id is distinct from p_except
      and private.task_name_key(l.name) = private.task_name_key(p_name)
  );
  $$;

-- Creates a list (task managers). Outcomes: 'created', 'exists' (a retry of the caller's own create),
-- 'id_taken', 'duplicate_name', 'limit_reached', 'not_permitted'. 22023 for an invalid name.
create function public.create_task_list(p_id uuid, p_name text, p_home_id uuid default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.task_lists;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_id is null or p_name is null or not private.is_visible_name(p_name, private.task_limit('list_name')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.task_lists l where l.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.is_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if not private.can_manage_tasks(case when p_home_id is null then v_user_id end, p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    perform private.lock_task_context('task_lists', p_home_id, v_user_id);
    if private.task_list_name_taken(p_home_id, v_user_id, p_name, null) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    if (select count(*) from private.task_lists l
        where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
          and l.deleted_at is null) >= private.task_limit('lists') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.task_lists (id, owner_user_id, owner_home_id, name, position, created_by)
      values (
        p_id, case when p_home_id is null then v_user_id end, p_home_id, p_name,
        coalesce((select max(l.position) + 1 from private.task_lists l
          where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
            and l.deleted_at is null), 0),
        v_user_id
      )
      on conflict (id) do nothing;
    if not found then
      -- The same id arrived twice at once: the other request created it (or someone else holds it).
      return query select case when l.created_by = v_user_id then 'exists' else 'id_taken' end,
        case when l.created_by = v_user_id then l.revision end
        from private.task_lists l where l.id = p_id;
      return;
    end if;
    perform private.audit_task('task_list.created', p_home_id, 'task_list', p_id);
    return query select 'created', 1;
  end
  $$;

-- Loads a list for a change by p_user_id, locked. Null when it is missing, deleted or not theirs to see.
create function private.lock_task_list(p_list_id uuid, p_user_id uuid) returns private.task_lists
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_list private.task_lists;
  begin
    select * into v_list from private.task_lists l where l.id = p_list_id for update;
    if not found or v_list.deleted_at is not null
       or not private.in_task_context(v_list.owner_user_id, v_list.owner_home_id, p_user_id) then
      return null;
    end if;
    return v_list;
  end
  $$;

-- Renames, archives or unarchives a list (task managers). Outcomes: 'saved' (with the new revision),
-- 'conflict' (with the current one), 'duplicate_name', 'has_open_tasks' (archiving a list that still
-- has open tasks: move, complete or delete them first), 'not_found', 'not_permitted'.
create function public.update_task_list(
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

-- Puts the context's lists in the given order (task managers); lists not named keep their place
-- after the named ones. Outcomes: 'saved', 'not_permitted'.
create function public.reorder_task_lists(p_list_ids uuid[], p_home_id uuid default null)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_list_ids is null or cardinality(p_list_ids) not between 1 and private.task_limit('lists') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_tasks(case when p_home_id is null then v_user_id end, p_home_id, v_user_id) then
      return 'not_permitted';
    end if;
    perform private.lock_task_context('task_lists', p_home_id, v_user_id);
    update private.task_lists l
      set position = coalesce(o.ord, cardinality(p_list_ids) + l.position)::integer,
        updated_at = pg_catalog.now()
      from private.task_lists l2
      left join (select x.id, x.ord from unnest(p_list_ids) with ordinality as x (id, ord)) o
        on o.id = l2.id
      where l.id = l2.id and l.deleted_at is null
        and ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id);
    return 'saved';
  end
  $$;

-- Moves a list to the trash (task managers), only when no active task is in it: the impact review
-- asks the person to move or delete its tasks first, so no task is silently hidden. Outcomes:
-- 'deleted' (with the trash entry), 'conflict', 'has_tasks' (with the count), 'not_found',
-- 'not_permitted'.
create function public.delete_task_list(p_list_id uuid, p_expected_revision integer)
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
    update private.task_lists l set deleted_at = pg_catalog.now() where l.id = v_list.id;
    return query select 'deleted',
      private.trash_move(v_user_id, 'tasks', 'task_list', v_list.id, v_list.owner_user_id,
        v_list.owner_home_id, v_list.name),
      null::integer;
  end
  $$;

-- Labels --------------------------------------------------------------------------------------------

-- The context's labels by name, with how many active tasks use each (the impact count before
-- removal: every member sees every task of the context, so the count reveals nothing hidden).
create function public.list_task_labels(p_home_id uuid default null)
returns table (id uuid, name text, color text, revision integer, task_count integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    return query
      select l.id, l.name, l.color, l.revision,
        (select count(*)::integer from private.task_label_links k
          join private.tasks t on t.id = k.task_id
          where k.label_id = l.id and t.deleted_at is null)
      from private.task_labels l
      where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id)
      order by private.task_name_key(l.name), l.id
      limit private.task_limit('labels');
  end
  $$;

create function private.task_label_name_taken(
  p_home_id uuid, p_user_id uuid, p_name text, p_except uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.task_labels l
    where ((p_home_id is null and l.owner_user_id = p_user_id) or l.owner_home_id = p_home_id)
      and l.id is distinct from p_except
      and private.task_name_key(l.name) = private.task_name_key(p_name)
  );
  $$;

create function private.is_task_label_color(p_color text) returns boolean
  language sql immutable set search_path = '' as $$
  select p_color is null or p_color in (
      'purple', 'blue', 'sky', 'teal', 'green', 'ochre', 'amber', 'orange', 'red', 'pink', 'magenta',
      'slate'
    );
  $$;

-- Creates a label (task managers). Outcomes as create_task_list.
create function public.create_task_label(
  p_id uuid, p_name text, p_color text default null, p_home_id uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.task_labels;
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_id is null or p_name is null or not private.is_visible_name(p_name, private.task_limit('label_name'))
       or not private.is_task_label_color(p_color) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.task_labels l where l.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.is_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if not private.can_manage_tasks(case when p_home_id is null then v_user_id end, p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    perform private.lock_task_context('task_labels', p_home_id, v_user_id);
    if private.task_label_name_taken(p_home_id, v_user_id, p_name, null) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    if (select count(*) from private.task_labels l
        where ((p_home_id is null and l.owner_user_id = v_user_id) or l.owner_home_id = p_home_id))
       >= private.task_limit('labels') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.task_labels (id, owner_user_id, owner_home_id, name, color, created_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_name, p_color, v_user_id)
      on conflict (id) do nothing;
    if not found then
      return query select case when l.created_by = v_user_id then 'exists' else 'id_taken' end,
        case when l.created_by = v_user_id then l.revision end
        from private.task_labels l where l.id = p_id;
      return;
    end if;
    perform private.audit_task('task_label.created', p_home_id, 'task_label', p_id);
    return query select 'created', 1;
  end
  $$;

create function private.lock_task_label(p_label_id uuid, p_user_id uuid) returns private.task_labels
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_label private.task_labels;
  begin
    select * into v_label from private.task_labels l where l.id = p_label_id for update;
    if not found or not private.in_task_context(v_label.owner_user_id, v_label.owner_home_id, p_user_id) then
      return null;
    end if;
    return v_label;
  end
  $$;

-- Renames or recolours a label (task managers): every task shows the new name at once; nothing else
-- about the tasks changes. Outcomes: 'saved', 'conflict', 'duplicate_name', 'not_found', 'not_permitted'.
create function public.update_task_label(
  p_label_id uuid, p_expected_revision integer, p_name text, p_color text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_label private.task_labels;
  begin
    if p_label_id is null or p_expected_revision is null or p_name is null
       or not private.is_visible_name(p_name, private.task_limit('label_name'))
       or not private.is_task_label_color(p_color) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_label from private.task_labels l where l.id = p_label_id;
    if found and private.in_task_context(v_label.owner_user_id, v_label.owner_home_id, v_user_id) then
      perform private.lock_task_context('task_labels', v_label.owner_home_id, v_label.owner_user_id);
    end if;
    v_label := private.lock_task_label(p_label_id, v_user_id);
    if v_label.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_tasks(v_label.owner_user_id, v_label.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_label.revision <> p_expected_revision then
      return query select 'conflict', v_label.revision;
      return;
    end if;
    if private.task_label_name_taken(
      v_label.owner_home_id, coalesce(v_label.owner_user_id, v_user_id), p_name, v_label.id
    ) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    update private.task_labels l
      set name = p_name, color = p_color, revision = l.revision + 1, updated_at = pg_catalog.now()
      where l.id = v_label.id
      returning * into v_label;
    perform private.audit_task('task_label.updated', v_label.owner_home_id, 'task_label', v_label.id);
    return query select 'saved', v_label.revision;
  end
  $$;

-- Removes a label (task managers) after the impact review: it is detached from its tasks, which are
-- not otherwise changed. A label renamed or recoloured since the review answers 'conflict'.
-- Outcomes: 'deleted' (with how many tasks it was on), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_task_label(p_label_id uuid, p_expected_revision integer)
returns table (outcome text, detached integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_label private.task_labels;
    v_count integer;
  begin
    if p_label_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_label := private.lock_task_label(p_label_id, v_user_id);
    if v_label.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_tasks(v_label.owner_user_id, v_label.owner_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_label.revision <> p_expected_revision then
      return query select 'conflict', null::integer;
      return;
    end if;
    select count(*)::integer into v_count from private.task_label_links k where k.label_id = v_label.id;
    delete from private.task_labels l where l.id = v_label.id;
    perform private.audit_task('task_label.deleted', v_label.owner_home_id, 'task_label', v_label.id,
      pg_catalog.jsonb_build_object('detached', v_count));
    return query select 'deleted', v_count;
  end
  $$;

-- Tasks: shared checks -----------------------------------------------------------------------------

-- Whether every id names a label of the context, at most the per-task limit.
create function private.valid_task_labels(
  p_label_ids uuid[], p_owner_user_id uuid, p_owner_home_id uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(cardinality(p_label_ids), 0) <= private.task_limit('labels_per_task')
    and (select count(*) from private.task_labels l
      where l.id = any (coalesce(p_label_ids, '{}'))
        and l.owner_user_id is not distinct from p_owner_user_id
        and l.owner_home_id is not distinct from p_owner_home_id)
      = (select count(distinct x) from unnest(coalesce(p_label_ids, '{}')) as x);
  $$;

create function private.replace_task_labels(p_task_id uuid, p_label_ids uuid[]) returns void
  language sql volatile security definer set search_path = '' as $$
  delete from private.task_label_links k
    where k.task_id = p_task_id and not (k.label_id = any (coalesce(p_label_ids, '{}')));
  insert into private.task_label_links (task_id, label_id)
    select p_task_id, x from unnest(coalesce(p_label_ids, '{}')) as x
    on conflict do nothing;
  $$;

-- Membership ids of the Home turned into account ids; null when any is not a current member.
create function private.member_users(p_home_id uuid, p_member_ids uuid[]) returns uuid[]
  language sql stable security definer set search_path = '' as $$
  select case
    when (select count(*) from public.home_memberships m
          where m.home_id = p_home_id and m.id = any (coalesce(p_member_ids, '{}')))
       = (select count(distinct x) from unnest(coalesce(p_member_ids, '{}')) as x)
    then coalesce((select array_agg(m.user_id order by m.user_id) from public.home_memberships m
      where m.home_id = p_home_id and m.id = any (coalesce(p_member_ids, '{}'))), '{}')
  end;
  $$;

create function private.replace_task_assignees(
  p_task_id uuid, p_home_id uuid, p_user_ids uuid[], p_actor uuid
) returns void
  language sql volatile security definer set search_path = '' as $$
  delete from private.task_assignees a
    where a.task_id = p_task_id and not (a.user_id = any (coalesce(p_user_ids, '{}')));
  insert into private.task_assignees (task_id, home_id, user_id, assigned_by)
    select p_task_id, p_home_id, x, p_actor from unnest(coalesce(p_user_ids, '{}')) as x
    on conflict do nothing;
  $$;

-- A task's list for a change: locked for share (an archive or delete of the list waits) and usable
-- when it is active, not archived, and in the given context.
create function private.usable_task_list(
  p_list_id uuid, p_owner_user_id uuid, p_owner_home_id uuid
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_list private.task_lists;
  begin
    select * into v_list from private.task_lists l where l.id = p_list_id for share;
    return found and v_list.deleted_at is null and v_list.archived_at is null
      and v_list.owner_user_id is not distinct from p_owner_user_id
      and v_list.owner_home_id is not distinct from p_owner_home_id;
  end
  $$;

-- Loads a task for a change by p_user_id, locked. Null when missing, deleted or not theirs to see.
create function private.lock_task(p_task_id uuid, p_user_id uuid) returns private.tasks
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_task private.tasks;
  begin
    select * into v_task from private.tasks t where t.id = p_task_id for update;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, p_user_id) then
      return null;
    end if;
    return v_task;
  end
  $$;

create function private.valid_task_fields(
  p_title text, p_description text, p_start date, p_due date, p_priority text
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    p_title is not null and private.is_visible_name(p_title, private.task_limit('title'))
    and (p_description is null or private.is_plain_text(p_description, private.task_limit('description')))
    and (p_start is null or p_due is null or p_start <= p_due)
    and (p_priority is null or p_priority in ('low', 'normal', 'high', 'urgent')),
    false);
  $$;

-- Tasks: create, edit, assign, move, complete, delete -----------------------------------------------

-- Creates a task in an active list of the context. Any current member may create; assignees (Home
-- tasks only) need a task manager. Outcomes: 'created', 'exists' (a retry), 'id_taken',
-- 'list_unavailable', 'invalid_label', 'invalid_assignee', 'not_permitted'. 22023 for invalid fields.
create function public.create_task(
  p_id uuid, p_list_id uuid, p_title text, p_description text default null,
  p_start_date date default null, p_due_date date default null, p_priority text default null,
  p_label_ids uuid[] default '{}', p_assignee_ids uuid[] default '{}', p_home_id uuid default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.tasks;
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_users uuid[] := '{}';
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_id is null or p_list_id is null
       or not private.valid_task_fields(p_title, p_description, p_start_date, p_due_date, p_priority) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.tasks t where t.id = p_id;
    if found then
      if v_existing.created_by = v_user_id
         and private.is_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id) then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if not private.usable_task_list(p_list_id, v_owner_user, p_home_id) then
      return query select 'list_unavailable', null::integer;
      return;
    end if;
    if not private.valid_task_labels(p_label_ids, v_owner_user, p_home_id) then
      return query select 'invalid_label', null::integer;
      return;
    end if;
    if coalesce(cardinality(p_assignee_ids), 0) > 0 then
      if p_home_id is null then
        return query select 'invalid_assignee', null::integer;
        return;
      end if;
      if not private.can_manage_tasks(null, p_home_id, v_user_id) then
        return query select 'not_permitted', null::integer;
        return;
      end if;
      v_users := private.member_users(p_home_id, p_assignee_ids);
      if v_users is null or cardinality(v_users) > private.task_limit('assignees_per_task') then
        return query select 'invalid_assignee', null::integer;
        return;
      end if;
    end if;
    insert into private.tasks (
      id, owner_user_id, owner_home_id, list_id, title, description, start_date, due_date, priority,
      created_by, updated_by
    ) values (
      p_id, v_owner_user, p_home_id, p_list_id, p_title, p_description, p_start_date, p_due_date,
      p_priority, v_user_id, v_user_id
    )
    on conflict (id) do nothing;
    if not found then
      return query select case when t.created_by = v_user_id then 'exists' else 'id_taken' end,
        case when t.created_by = v_user_id then t.revision end
        from private.tasks t where t.id = p_id;
      return;
    end if;
    perform private.replace_task_labels(p_id, p_label_ids);
    if p_home_id is not null then
      perform private.replace_task_assignees(p_id, p_home_id, v_users, v_user_id);
    end if;
    perform private.audit_task('task.created', p_home_id, 'task', p_id,
      pg_catalog.jsonb_build_object('assignees', cardinality(v_users)));
    return query select 'created', 1;
  end
  $$;

-- Saves a task's content (title, description, dates, priority, labels) if nobody changed it since
-- p_expected_revision. Outcomes: 'saved', 'conflict', 'invalid_label', 'not_found', 'not_permitted'.
-- Omitted optional fields are cleared (null), so the caller always sends the whole content.
create function public.update_task(
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
        due_date = p_due_date, priority = p_priority, revision = t.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where t.id = v_task.id
      returning * into v_task;
    perform private.replace_task_labels(v_task.id, p_label_ids);
    return query select 'saved', v_task.revision;
  end
  $$;

-- Sets a Home task's assignees (task managers only), as membership ids of current members; clears
-- the reassignment flag. Outcomes: 'saved', 'conflict', 'invalid_assignee', 'not_found', 'not_permitted'.
create function public.set_task_assignees(
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
      set needs_reassignment = false, revision = t.revision + 1, updated_by = v_user_id,
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
create function public.move_task(p_task_id uuid, p_expected_revision integer, p_list_id uuid)
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
      set list_id = p_list_id, revision = t.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where t.id = v_task.id
      returning * into v_task;
    return query select 'saved', v_task.revision;
  end
  $$;

-- Completes or reopens a task: one shared state for every assignee. Set-to-state under the row
-- lock, so of two simultaneous completions one records the actor and the event and the other
-- answers 'already_completed' with that actor; a retry changes nothing. Reopening keeps the
-- subtasks' states and records who reopened it; it needs the task's list to be active
-- ('list_unavailable' otherwise). Outcomes: 'completed', 'reopened', 'already_completed',
-- 'already_open', 'list_unavailable', 'not_found', 'not_permitted'; completed_by_me /
-- completed_by_member name the actual completer.
create function public.set_task_completion(p_task_id uuid, p_completed boolean)
returns table (
  outcome text, completed_at timestamptz, completed_by_me boolean, completed_by_member uuid
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_outcome text;
  begin
    if p_task_id is null or p_completed is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::timestamptz, false, null::uuid;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted', null::timestamptz, false, null::uuid;
      return;
    end if;
    if p_completed and v_task.completed_at is not null then
      v_outcome := 'already_completed';
    elsif not p_completed and v_task.completed_at is null then
      v_outcome := 'already_open';
    elsif not p_completed
       and not private.usable_task_list(v_task.list_id, v_task.owner_user_id, v_task.owner_home_id) then
      -- Reopening inside an archived (or deleted) list would leave an open task that All Tasks does
      -- not show: the person moves it to an active list, or unarchives the list, first.
      v_outcome := 'list_unavailable';
    else
      update private.tasks t
        set completed_at = case when p_completed then pg_catalog.now() end,
          completed_by = case when p_completed then v_user_id end,
          reopened_at = case when p_completed then t.reopened_at else pg_catalog.now() end,
          reopened_by = case when p_completed then t.reopened_by else v_user_id end
        where t.id = v_task.id
        returning * into v_task;
      v_outcome := case when p_completed then 'completed' else 'reopened' end;
      -- One event per state change, never one per assignee.
      perform private.audit_task('task.' || v_outcome, v_task.owner_home_id, 'task', v_task.id);
    end if;
    return query select v_outcome, v_task.completed_at,
      coalesce(v_task.completed_by = v_user_id, false),
      private.member_ref(v_task.owner_home_id, v_task.completed_by);
  end
  $$;

-- Moves a task to the trash with its subtasks, comments, labels and assignees (they stay attached and
-- come back with it). Its creator or a task manager. Outcomes: 'deleted' (with the entry),
-- 'not_found', 'not_permitted'.
create function public.delete_task(p_task_id uuid)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
  begin
    if p_task_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if not private.can_delete_task(v_task, v_user_id) then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    update private.tasks t set deleted_at = pg_catalog.now() where t.id = v_task.id;
    -- No files yet: attachments arrive in S19 and will pass their exclusive files here.
    return query select 'deleted',
      private.trash_move(v_user_id, 'tasks', 'task', v_task.id, v_task.owner_user_id,
        v_task.owner_home_id, v_task.title);
  end
  $$;

-- Tasks: reading -----------------------------------------------------------------------------------

-- Priority order for sorting: unspecified sorts as Normal (spec), Low < Normal < High < Urgent.
create function private.task_priority_rank(p_priority text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_priority when 'low' then 1 when 'high' then 3 when 'urgent' then 4 else 2 end;
  $$;

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
  revision integer, total_count integer
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
        p.revision, p.total
      from page p
      order by
        case when p_sort = 'priority_desc' then private.task_priority_rank(p.priority) end desc,
        case when p_sort = 'priority_asc' then private.task_priority_rank(p.priority) end asc,
        case when p_sort = 'created' then p.created_at end desc,
        p.due_date asc nulls last, p.created_at asc, p.id asc;
  end
  $$;

-- One task with everything its detail page shows, or null when it is missing, deleted or not the
-- caller's to see. People are membership ids (null: departed, or the Personal space) and "is me".
create function public.get_task(p_task_id uuid, p_today date default null) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_list private.task_lists;
    v_home uuid;
    v_today date;
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
      'can', pg_catalog.jsonb_build_object(
        'edit', private.can_edit_task(v_task, v_user_id),
        'complete', private.can_edit_task(v_task, v_user_id),
        'assign', v_home is not null and private.can_manage_tasks(null, v_home, v_user_id),
        'delete', private.can_delete_task(v_task, v_user_id),
        'comment', true)
    );
  end
  $$;

-- Subtasks (whoever may edit the parent) ------------------------------------------------------------

-- Loads the parent of a subtask change, locked, and says whether p_user_id may change its checklist.
-- 'not_found' / 'not_permitted' / null (allowed).
create function private.subtask_parent_refusal(p_task private.tasks, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_task.id is null then 'not_found'
    when not private.can_edit_task(p_task, p_user_id) then 'not_permitted'
  end;
  $$;

-- Adds a subtask at the end. Outcomes: 'created', 'exists', 'id_taken', 'limit_reached',
-- 'not_found', 'not_permitted'.
create function public.add_subtask(p_id uuid, p_task_id uuid, p_title text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_existing private.subtasks;
    v_refusal text;
  begin
    if p_id is null or p_task_id is null or p_title is null
       or not private.is_visible_name(p_title, private.task_limit('title')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    v_refusal := private.subtask_parent_refusal(v_task, v_user_id);
    if v_refusal is not null then
      return query select v_refusal, null::integer;
      return;
    end if;
    select * into v_existing from private.subtasks s where s.id = p_id;
    if found then
      if v_existing.task_id = v_task.id and v_existing.created_by = v_user_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if (select count(*) from private.subtasks s where s.task_id = v_task.id) >= private.task_limit('subtasks') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.subtasks (id, task_id, title, position, created_by)
      values (p_id, v_task.id, p_title,
        coalesce((select max(s.position) + 1 from private.subtasks s where s.task_id = v_task.id), 0),
        v_user_id)
      on conflict (id) do nothing;
    if not found then
      return query select case when s.task_id = v_task.id and s.created_by = v_user_id then 'exists'
          else 'id_taken' end,
        case when s.task_id = v_task.id and s.created_by = v_user_id then s.revision end
        from private.subtasks s where s.id = p_id;
      return;
    end if;
    return query select 'created', 1;
  end
  $$;

-- The subtask and its parent, locked parent first (the same order as every task change).
create function private.lock_subtask(p_id uuid, p_user_id uuid, out o_task private.tasks, out o_subtask private.subtasks)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_task_id uuid;
  begin
    select s.task_id into v_task_id from private.subtasks s where s.id = p_id;
    if v_task_id is null then
      return;
    end if;
    o_task := private.lock_task(v_task_id, p_user_id);
    if o_task.id is null then
      return;
    end if;
    select * into o_subtask from private.subtasks s where s.id = p_id for update;
  end
  $$;

-- Renames a subtask. Outcomes: 'saved', 'conflict', 'not_found', 'not_permitted'.
create function public.rename_subtask(p_id uuid, p_expected_revision integer, p_title text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_locked record;
    v_refusal text;
    v_subtask private.subtasks;
  begin
    if p_id is null or p_expected_revision is null or p_title is null
       or not private.is_visible_name(p_title, private.task_limit('title')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_locked from private.lock_subtask(p_id, v_user_id);
    v_refusal := private.subtask_parent_refusal(v_locked.o_task, v_user_id);
    if v_refusal is null and (v_locked.o_subtask).id is null then
      v_refusal := 'not_found';
    end if;
    if v_refusal is not null then
      return query select v_refusal, null::integer;
      return;
    end if;
    v_subtask := v_locked.o_subtask;
    if v_subtask.revision <> p_expected_revision then
      return query select 'conflict', v_subtask.revision;
      return;
    end if;
    update private.subtasks s set title = p_title, revision = s.revision + 1, updated_at = pg_catalog.now()
      where s.id = v_subtask.id
      returning * into v_subtask;
    return query select 'saved', v_subtask.revision;
  end
  $$;

-- Ticks or unticks a subtask (set-to-state, so a repeated toggle changes nothing). The parent's own
-- completion is never changed by this. Outcomes: 'saved' (with the subtask's revision), 'not_found',
-- 'not_permitted'.
create function public.set_subtask_completion(p_id uuid, p_completed boolean)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_locked record;
    v_refusal text;
    v_subtask private.subtasks;
  begin
    if p_id is null or p_completed is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_locked from private.lock_subtask(p_id, v_user_id);
    v_refusal := private.subtask_parent_refusal(v_locked.o_task, v_user_id);
    if v_refusal is null and (v_locked.o_subtask).id is null then
      v_refusal := 'not_found';
    end if;
    if v_refusal is not null then
      return query select v_refusal, null::integer;
      return;
    end if;
    v_subtask := v_locked.o_subtask;
    if (v_subtask.completed_at is not null) <> p_completed then
      update private.subtasks s
        set completed_at = case when p_completed then pg_catalog.now() end,
          completed_by = case when p_completed then v_user_id end,
          revision = s.revision + 1, updated_at = pg_catalog.now()
        where s.id = v_subtask.id
        returning * into v_subtask;
    end if;
    return query select 'saved', v_subtask.revision;
  end
  $$;

-- Puts a task's subtasks in the given order; subtasks not named follow. Outcomes: 'saved',
-- 'not_found', 'not_permitted'.
create function public.reorder_subtasks(p_task_id uuid, p_subtask_ids uuid[]) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_refusal text;
  begin
    if p_task_id is null or p_subtask_ids is null
       or cardinality(p_subtask_ids) not between 1 and private.task_limit('subtasks') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    v_refusal := private.subtask_parent_refusal(v_task, v_user_id);
    if v_refusal is not null then
      return v_refusal;
    end if;
    update private.subtasks s
      set position = coalesce(o.ord, cardinality(p_subtask_ids) + s.position)::integer,
        updated_at = pg_catalog.now()
      from private.subtasks s2
      left join (select x.id, x.ord from unnest(p_subtask_ids) with ordinality as x (id, ord)) o
        on o.id = s2.id
      where s.id = s2.id and s.task_id = v_task.id;
    return 'saved';
  end
  $$;

-- Removes a subtask (the page confirms first). Outcomes: 'deleted', 'not_found', 'not_permitted'.
create function public.delete_subtask(p_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_locked record;
    v_refusal text;
  begin
    if p_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_locked from private.lock_subtask(p_id, v_user_id);
    v_refusal := private.subtask_parent_refusal(v_locked.o_task, v_user_id);
    if v_refusal is null and (v_locked.o_subtask).id is null then
      v_refusal := 'not_found';
    end if;
    if v_refusal is not null then
      return v_refusal;
    end if;
    delete from private.subtasks s where s.id = p_id;
    return 'deleted';
  end
  $$;

-- Comments (every member who can view the task; authors edit and delete their own) ------------------

-- A page of a task's comments, oldest first. 'not_found' rows are never returned: a task the caller
-- may not see gives an empty page with task_found false.
create function public.list_task_comments(
  p_task_id uuid, p_offset integer default 0, p_limit integer default 100
) returns table (
  id uuid, body text, created_at timestamptz, edited_at timestamptz, revision integer,
  author_me boolean, author_member uuid, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
  begin
    if p_task_id is null or p_offset is null or p_offset not between 0 and private.task_limit('max_offset')
       or p_limit is null or p_limit not between 1 and private.task_limit('comments_page') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return;
    end if;
    return query
      select c.id, c.body, c.created_at, c.edited_at, c.revision,
        coalesce(c.author_id = v_user_id, false),
        private.member_ref(v_task.owner_home_id, c.author_id),
        (count(*) over ())::integer
      from private.task_comments c
      where c.task_id = v_task.id
      order by c.created_at, c.id
      limit p_limit offset p_offset;
  end
  $$;

-- Adds a comment. The task row is locked for share so a delete to the trash waits. Outcomes:
-- 'created', 'exists' (a retried send), 'id_taken', 'not_found'.
create function public.add_task_comment(p_id uuid, p_task_id uuid, p_body text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_existing private.task_comments;
  begin
    if p_id is null or p_task_id is null or p_body is null
       or not private.is_plain_text(p_body, private.task_limit('comment')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id for share;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return query select 'not_found', null::integer;
      return;
    end if;
    select * into v_existing from private.task_comments c where c.id = p_id;
    if found then
      if v_existing.task_id = v_task.id and v_existing.author_id = v_user_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    insert into private.task_comments (id, task_id, author_id, body) values (p_id, v_task.id, v_user_id, p_body)
      on conflict (id) do nothing;
    if not found then
      -- A retried send that arrived while the first was still saving.
      return query select case when c.task_id = v_task.id and c.author_id = v_user_id then 'exists'
          else 'id_taken' end,
        case when c.task_id = v_task.id and c.author_id = v_user_id then c.revision end
        from private.task_comments c where c.id = p_id;
      return;
    end if;
    return query select 'created', 1;
  end
  $$;

-- The caller's own comment on a task they can still see, locked. Null otherwise.
create function private.lock_own_comment(p_id uuid, p_user_id uuid) returns private.task_comments
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_comment private.task_comments;
    v_task private.tasks;
  begin
    select * into v_comment from private.task_comments c where c.id = p_id for update;
    if not found then
      return null;
    end if;
    select * into v_task from private.tasks t where t.id = v_comment.task_id;
    if v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, p_user_id) then
      return null;
    end if;
    return v_comment;
  end
  $$;

-- Edits the caller's own comment. Outcomes: 'saved', 'conflict', 'not_found', 'not_permitted'
-- (someone else's comment).
create function public.update_task_comment(p_id uuid, p_expected_revision integer, p_body text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_comment private.task_comments;
  begin
    if p_id is null or p_expected_revision is null or p_body is null
       or not private.is_plain_text(p_body, private.task_limit('comment')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_comment := private.lock_own_comment(p_id, v_user_id);
    if v_comment.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_comment.author_id is distinct from v_user_id then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_comment.revision <> p_expected_revision then
      return query select 'conflict', v_comment.revision;
      return;
    end if;
    if v_comment.body = p_body then
      return query select 'saved', v_comment.revision;
      return;
    end if;
    update private.task_comments c
      set body = p_body, revision = c.revision + 1, edited_at = pg_catalog.clock_timestamp()
      where c.id = v_comment.id
      returning * into v_comment;
    return query select 'saved', v_comment.revision;
  end
  $$;

-- Deletes the caller's own comment. Outcomes: 'deleted', 'not_found', 'not_permitted'.
create function public.delete_task_comment(p_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_comment private.task_comments;
  begin
    if p_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_comment := private.lock_own_comment(p_id, v_user_id);
    if v_comment.id is null then
      return 'not_found';
    end if;
    if v_comment.author_id is distinct from v_user_id then
      return 'not_permitted';
    end if;
    delete from private.task_comments c where c.id = v_comment.id;
    return 'deleted';
  end
  $$;

-- Trash hooks (S16) for tasks and task lists --------------------------------------------------------

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks'));
alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in ('sample', 'dashboard_template', 'task', 'task_list'));

-- Resolutions may carry one argument after a colon ('move_to_list:<list id>'): the option is the
-- part before it. Otherwise unchanged from S16.
create or replace function private.trash_restore_one(p_user_id uuid, p_entry_id uuid, p_resolution text)
returns table (outcome text, conflict text, options text[], attachments_lost integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.trash_entries;
    v_kind text;
    v_round integer := 0;
    v_resolution text := p_resolution;
    v_lost integer;
  begin
    select * into v_entry from private.trash_entries t where t.id = p_entry_id for update;
    if not found or v_entry.status <> 'trashed' or not private.can_see_trash_entry(v_entry, p_user_id) then
      return query select 'not_found', null::text, null::text[], 0;
      return;
    end if;
    if v_entry.expires_at <= pg_catalog.now() then
      return query select 'expired', null::text, null::text[], 0;
      return;
    end if;
    loop
      v_kind := private.trash_conflict(v_entry);
      exit when v_kind is null;
      if v_kind = 'item_missing' then
        return query select 'not_found', null::text, null::text[], 0;
        return;
      end if;
      -- A chosen resolution counts only when it answers a conflict that is really there.
      if v_resolution is not null
         and pg_catalog.split_part(v_resolution, ':', 1) = any (private.trash_conflict_options(v_kind))
         and v_round < 3 then
        perform private.trash_resolve(v_entry, v_resolution);
        v_resolution := null;
        v_round := v_round + 1;
        continue;
      end if;
      return query select 'needs_resolution', v_kind, private.trash_conflict_options(v_kind), 0;
      return;
    end loop;
    begin
      v_lost := private.trash_item_restore(v_entry);
    exception when unique_violation then
      -- An active item took the place between the check and the restore: ask again, change nothing.
      v_kind := coalesce(private.trash_conflict(v_entry), 'slot_taken');
      return query select 'needs_resolution', v_kind, private.trash_conflict_options(v_kind), 0;
      return;
    end;
    return query select 'restored', null::text, null::text[], v_lost;
    update private.trash_entries t
      set status = 'restored', settled_at = pg_catalog.now(), label = null
      where t.id = v_entry.id;
    perform private.audit_trash_entry(p_user_id, v_entry, 'trash_entry.restored');
  end
  $$;

create or replace function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_kind
    when 'slot_taken' then array['clear_slot']
    when 'parent_unavailable' then array['detach_parent']
    -- The person picks another active list of the same context (argument: its id).
    when 'list_unavailable' then array['move_to_list']
    else array[]::text[]
  end;
  $$;

-- The four dispatch functions again, with cases for tasks and task lists. A task's real conflict is
-- its list: deleted, archived or purged meanwhile. A list has none (matching names never are one;
-- duplicate names are refused only when a person creates or renames).
create or replace function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_sample private.trash_samples;
    v_task private.tasks;
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
    end case;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.get_task_context(uuid, date)',
    'public.list_task_lists(uuid, boolean)',
    'public.create_task_list(uuid, text, uuid)',
    'public.update_task_list(uuid, integer, text, boolean)',
    'public.reorder_task_lists(uuid[], uuid)',
    'public.delete_task_list(uuid, integer)',
    'public.list_task_labels(uuid)',
    'public.create_task_label(uuid, text, text, uuid)',
    'public.update_task_label(uuid, integer, text, text)',
    'public.delete_task_label(uuid, integer)',
    'public.create_task(uuid, uuid, text, text, date, date, text, uuid[], uuid[], uuid)',
    'public.update_task(uuid, integer, text, uuid[], text, date, date, text)',
    'public.set_task_assignees(uuid, integer, uuid[])',
    'public.move_task(uuid, integer, uuid)',
    'public.set_task_completion(uuid, boolean)',
    'public.delete_task(uuid)',
    'public.list_tasks(uuid, uuid, date, text, text, boolean, text[], uuid[], text, uuid, text, integer, integer)',
    'public.get_task(uuid, date)',
    'public.add_subtask(uuid, uuid, text)',
    'public.rename_subtask(uuid, integer, text)',
    'public.set_subtask_completion(uuid, boolean)',
    'public.reorder_subtasks(uuid, uuid[])',
    'public.delete_subtask(uuid)',
    'public.list_task_comments(uuid, integer, integer)',
    'public.add_task_comment(uuid, uuid, text)',
    'public.update_task_comment(uuid, integer, text)',
    'public.delete_task_comment(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.is_delegable_capability(text)',
    'private.task_limit(text)',
    'private.task_name_key(text)',
    'private.is_plain_text(text, integer)',
    'private.flag_departed_assignments()',
    'private.in_task_context(uuid, uuid, uuid)',
    'private.can_manage_tasks(uuid, uuid, uuid)',
    'private.is_task_assignee(uuid, uuid)',
    'private.can_edit_task(private.tasks, uuid)',
    'private.can_delete_task(private.tasks, uuid)',
    'private.require_task_context(uuid, uuid)',
    'private.is_context(uuid, uuid, uuid, uuid)',
    'private.task_today(uuid, date)',
    'private.member_ref(uuid, uuid)',
    'private.audit_task(text, uuid, text, uuid, jsonb)',
    'private.lock_task_context(text, uuid, uuid)',
    'private.task_list_name_taken(uuid, uuid, text, uuid)',
    'private.lock_task_list(uuid, uuid)',
    'private.task_label_name_taken(uuid, uuid, text, uuid)',
    'private.is_task_label_color(text)',
    'private.lock_task_label(uuid, uuid)',
    'private.valid_task_labels(uuid[], uuid, uuid)',
    'private.replace_task_labels(uuid, uuid[])',
    'private.member_users(uuid, uuid[])',
    'private.replace_task_assignees(uuid, uuid, uuid[], uuid)',
    'private.usable_task_list(uuid, uuid, uuid)',
    'private.lock_task(uuid, uuid)',
    'private.valid_task_fields(text, text, date, date, text)',
    'private.task_priority_rank(text)',
    'private.subtask_parent_refusal(private.tasks, uuid)',
    'private.lock_subtask(uuid, uuid)',
    'private.lock_own_comment(uuid, uuid)',
    'private.trash_restore_one(uuid, uuid, text)',
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
