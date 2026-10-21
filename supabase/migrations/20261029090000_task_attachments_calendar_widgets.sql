-- S19c: task attachments, the task calendar view and task widgets (brief plans/steps/S19c-brief.md;
-- ADR 0025; spec "Confirmed task document and image attachments", "Confirmed deletion and recovery
-- of parent items with attachments", "Confirmed optional task calendar views", "Confirmed
-- configurable task dashboard widgets").
--
-- Widgets read through list_tasks, which gains three timing filters (due today, due in the next 7
-- days, no due date). The calendar reads a window of at most 42 days through list_task_calendar:
-- tasks on their due dates (and start dates), plus the planned dates of active recurring series that
-- have no occurrence yet.
--
-- Attachments reuse the S15 upload pipeline with a new purpose, 'task_attachment'. A task's files
-- live in the task's pool (the person's for a Personal task, the Home's for a Home task). An upload
-- is opened for one task (create_task_attachment_intent), the server verifies and stores the bytes
-- and records the facts (finalize_upload, unchanged), then attach_task_file links the file to the
-- task with the person's own session, re-checking their rights at that moment. A ready file nobody
-- attached is retired by the existing expiry job.
--
-- private.task_attachments links a file to a task. Recurring series keep attachments on the chain
-- (private.task_series_attachments, like the S19b reminder template); every new occurrence gets a
-- link to each, marked as from the series. One file can therefore be linked from many occurrences;
-- it is stored and counted once.
--
-- Removing an attachment is a trash entry (item type task_attachment, or task_series_attachment for
-- a series-wide removal). Deleting a task takes the files no other active task uses into the trash
-- with it. Rows are deleted only when an entry is purged (or their task is); a trigger then releases
-- a file that no row references any more. Visibility follows the task: whoever may see the task may
-- see and download its attachments (authorize_file_read), its editors add and remove them.

-- Audit subject, limits ------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment'
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
    when 'attachments' then 10         -- attachments per task, uploads in progress included (S19c)
    when 'attachment_name' then 200    -- an attachment's display name
    when 'calendar_days' then 42       -- days one calendar read covers (six weeks)
    when 'calendar_entries' then 500   -- entries one calendar read returns
  end;
  $$;

-- Widgets: list_tasks timing filters -------------------------------------------------------------------

-- The S19 listing with three more timing filters for widgets and the calendar's "no due date" link:
--   'due_today' (open, due today), 'due_week' (open, due today or in the next 6 days), 'undated'
--   (no due date; the status filter still applies). Everything else as in S19.
create or replace function public.list_tasks(
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
       or p_when is null
       or p_when not in ('any', 'upcoming', 'active', 'overdue', 'due_today', 'due_week', 'undated')
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
          and (p_when = 'any'
            or (p_when = 'undated' and t.due_date is null)
            or (p_when <> 'undated' and t.completed_at is null and case p_when
              when 'upcoming' then t.start_date > v_today
              when 'active' then (t.start_date is null or t.start_date <= v_today)
                and not coalesce(t.due_date < v_today, false)
              when 'overdue' then t.due_date < v_today
              when 'due_today' then t.due_date = v_today
              when 'due_week' then t.due_date between v_today and v_today + 6
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

-- The calendar ----------------------------------------------------------------------------------------

-- The context's tasks between p_from and p_to (at most 42 days), for the week and month views:
--   * kind 'task', role 'due': a task on its due date (open, completed, overdue, recurring);
--   * kind 'task', role 'start': the same task on its start date, when that falls in the window and
--     differs from the due date (a marker, never a duration);
--   * kind 'planned': a date of an active recurring series that has no occurrence yet (not paused,
--     not ended, its list usable). task_id is the chain's latest occurrence, to open, or null.
-- Filters as in list_tasks: list (null: every active list), status, priorities, labels (any of),
-- assignee. Planned dates count as open and use the series template's priority, labels and
-- assignees. At most 500 entries, by date; 'truncated' says more exist. 'undated' counts the tasks
-- the filters match that have no due date (the view links to them). 42501 for a Home the caller is
-- not in; 22023 for invalid input.
create function public.list_task_calendar(
  p_from date, p_to date, p_home_id uuid default null, p_today date default null,
  p_list_id uuid default null, p_status text default 'all', p_priorities text[] default null,
  p_label_ids uuid[] default null, p_assignee text default 'any', p_assignee_member uuid default null
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_member_user uuid;
    v_entries jsonb;
    v_count integer;
    v_undated integer;
    v_limit integer := private.task_limit('calendar_entries');
  begin
    perform private.require_task_context(p_home_id, v_user_id);
    if p_from is null or p_to is null or p_to < p_from
       or p_to - p_from + 1 > private.task_limit('calendar_days')
       or p_status is null or p_status not in ('open', 'completed', 'all')
       or p_assignee is null or p_assignee not in ('any', 'me', 'unassigned', 'needs_reassignment', 'member')
       or (p_assignee = 'member') <> (p_assignee_member is not null)
       or (p_priorities is not null and not (p_priorities <@ array['low', 'normal', 'high', 'urgent', 'unset']))
       or coalesce(cardinality(p_label_ids), 0) > private.task_limit('labels') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, p_today);
    if p_assignee = 'member' then
      select m.user_id into v_member_user from public.home_memberships m
        where m.home_id = p_home_id and m.id = p_assignee_member;
      v_member_user := coalesce(v_member_user, '00000000-0000-0000-0000-000000000000');
    end if;

    with tasks as (
      select t.*, l.name as l_name, t as t_row
      from private.tasks t
      join private.task_lists l on l.id = t.list_id
      where ((p_home_id is null and t.owner_user_id = v_user_id) or t.owner_home_id = p_home_id)
        and t.deleted_at is null and l.deleted_at is null
        and (case when p_list_id is null then l.archived_at is null else l.id = p_list_id end)
        and (p_status = 'all' or (p_status = 'open') = (t.completed_at is null))
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
    ), placed as (
      select t.id as task_id, t.due_date as entry_date, 'due' as role, t.* from tasks t
        where t.due_date between p_from and p_to
      union all
      select t.id, t.start_date, 'start', t.* from tasks t
        where t.start_date between p_from and p_to and t.start_date is distinct from t.due_date
    ), heads as (
      select s.*, l.name as l_name, s as s_row
      from private.task_series s
      join private.task_lists l on l.id = s.list_id
      where ((p_home_id is null and s.owner_user_id = v_user_id) or s.owner_home_id = p_home_id)
        and s.superseded_at is null and s.deleted_at is null and s.paused_at is null
        and s.next_date is not null and s.next_date <= p_to
        and l.deleted_at is null and l.archived_at is null
        and (p_list_id is null or l.id = p_list_id)
        and p_status <> 'completed'
        and (p_priorities is null or coalesce(s.priority, 'unset') = any (p_priorities))
        and (coalesce(cardinality(p_label_ids), 0) = 0 or exists (
          select 1 from private.task_series_labels k where k.series_id = s.id and k.label_id = any (p_label_ids)))
        and (case p_assignee
          when 'any' then true
          when 'me' then exists (select 1 from private.task_series_assignees a
            where a.series_id = s.id and a.user_id = v_user_id)
          when 'unassigned' then not exists (select 1 from private.task_series_assignees a where a.series_id = s.id)
          when 'needs_reassignment' then s.needs_reassignment
          when 'member' then exists (select 1 from private.task_series_assignees a
            where a.series_id = s.id and a.user_id = v_member_user)
        end)
    ), planned as (
      select h.id as series_id, h.root_id, h.list_id, h.l_name, h.title, h.priority, d as entry_date,
        h.needs_reassignment
      from heads h,
        lateral unnest(private.series_dates(h.s_row, greatest(p_from, h.next_date), private.task_limit('calendar_days'))) as d
      where d <= p_to
        -- A date the chain already has an occurrence for (kept from an earlier part) is not planned.
        and not exists (select 1 from private.tasks o
          where o.series_root_id = h.root_id and o.occurrence_date = d)
    ), entries as (
      select p.entry_date, 0 as kind_order, p.role, pg_catalog.jsonb_build_object(
          'kind', 'task',
          'role', p.role,
          'date', p.entry_date,
          'taskId', p.task_id,
          'listId', p.list_id,
          'listName', p.l_name,
          'title', p.title,
          'startDate', p.start_date,
          'dueDate', p.due_date,
          'priority', p.priority,
          'completed', p.completed_at is not null,
          'overdue', p.completed_at is null and coalesce(p.due_date < v_today, false),
          'recurring', p.series_root_id is not null,
          'needsReassignment', p.needs_reassignment,
          'subtasksDone', (select count(*)::integer from private.subtasks s
            where s.task_id = p.task_id and s.completed_at is not null),
          'subtasksTotal', (select count(*)::integer from private.subtasks s where s.task_id = p.task_id),
          'labelIds', coalesce((select pg_catalog.jsonb_agg(k.label_id order by k.label_id)
            from private.task_label_links k where k.task_id = p.task_id), '[]'::jsonb),
          'assigneeIds', coalesce((select pg_catalog.jsonb_agg(m.id order by m.created_at, m.id)
            from private.task_assignees a
            join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
            where a.task_id = p.task_id), '[]'::jsonb),
          'canComplete', private.can_edit_task(p.t_row, v_user_id),
          'revision', p.revision
        ) as entry, p.title as sort_title, p.task_id as sort_id
      from placed p
      union all
      select p.entry_date, 1, 'due', pg_catalog.jsonb_build_object(
          'kind', 'planned',
          'role', 'due',
          'date', p.entry_date,
          'taskId', (select o.id from private.tasks o
            where o.series_root_id = p.root_id and o.deleted_at is null
            order by o.occurrence_date desc limit 1),
          'listId', p.list_id,
          'listName', p.l_name,
          'title', p.title,
          'priority', p.priority,
          'recurring', true,
          'needsReassignment', p.needs_reassignment,
          'labelIds', coalesce((select pg_catalog.jsonb_agg(k.label_id order by k.label_id)
            from private.task_series_labels k where k.series_id = p.series_id), '[]'::jsonb),
          'assigneeIds', coalesce((select pg_catalog.jsonb_agg(m.id order by m.created_at, m.id)
            from private.task_series_assignees a
            join public.home_memberships m on m.home_id = a.home_id and m.user_id = a.user_id
            where a.series_id = p.series_id), '[]'::jsonb)
        ), p.title, p.series_id
      from planned p
    ), ranked as (
      select e.entry, count(*) over () as total,
        row_number() over (order by e.entry_date, e.kind_order, e.role, e.sort_title, e.sort_id) as n
      from entries e
    )
    select coalesce(pg_catalog.jsonb_agg(r.entry order by r.n) filter (where r.n <= v_limit), '[]'::jsonb),
      coalesce(max(r.total), 0)::integer
      into v_entries, v_count
    from ranked r;

    select count(*)::integer into v_undated
    from private.tasks t
    join private.task_lists l on l.id = t.list_id
    where ((p_home_id is null and t.owner_user_id = v_user_id) or t.owner_home_id = p_home_id)
      and t.deleted_at is null and l.deleted_at is null and t.due_date is null
      and (case when p_list_id is null then l.archived_at is null else l.id = p_list_id end)
      and (p_status = 'all' or (p_status = 'open') = (t.completed_at is null))
      and (p_priorities is null or coalesce(t.priority, 'unset') = any (p_priorities))
      and (coalesce(cardinality(p_label_ids), 0) = 0 or exists (
        select 1 from private.task_label_links k where k.task_id = t.id and k.label_id = any (p_label_ids)))
      and (case p_assignee
        when 'any' then true
        when 'me' then private.is_task_assignee(t.id, v_user_id)
        when 'unassigned' then not exists (select 1 from private.task_assignees a where a.task_id = t.id)
        when 'needs_reassignment' then t.needs_reassignment
        when 'member' then private.is_task_assignee(t.id, v_member_user)
      end);

    return pg_catalog.jsonb_build_object(
      'today', v_today,
      'entries', v_entries,
      'truncated', v_count > v_limit,
      'undated', v_undated
    );
  end
  $$;

-- Attachments: storage policy --------------------------------------------------------------------------

alter table private.stored_files drop constraint stored_files_purpose_check;
alter table private.stored_files add constraint stored_files_purpose_check
  check (purpose in ('avatar', 'task_attachment'));

-- The types a task attachment may have (brief S19c, pending the owner's choice of formats): images,
-- PDF, plain text and CSV, and the Office and OpenDocument formats. The server checks every file's
-- signature; images are re-encoded in their own format without metadata, other files are kept as
-- they are. apps/web/src/tasks/attachment-policy.ts has the same list.
create function private.task_attachment_type(p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_type in (
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation'
  ), false);
  $$;

create or replace function private.upload_max_bytes(p_purpose text) returns bigint
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then 5242880::bigint
    when 'task_attachment' then 10485760::bigint  -- 10 MB (brief S19c)
  end;
  $$;

create or replace function private.upload_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'task_attachment' then private.task_attachment_type(p_type)
    else false
  end;
  $$;

-- Attachments are stored in the type they were declared as (images re-encoded in the same format).
create or replace function private.stored_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type = 'image/webp'
    when 'task_attachment' then private.task_attachment_type(p_type)
    else false
  end;
  $$;

-- The server may also give up an upload whose bytes are not the file they claim to be.
create or replace function public.abandon_my_upload(p_file_id uuid, p_reason text) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_file private.stored_files;
  begin
    if p_reason is null or p_reason not in ('mismatch', 'invalid_image', 'invalid_file') then
      raise exception 'invalid reason' using errcode = '22023';
    end if;
    update private.stored_files f set status = 'failed', claimed_until = null
      where f.id = p_file_id and f.created_by = v_user_id and f.status = 'pending'
      returning * into v_file;
    if not found then
      return false;
    end if;
    perform private.queue_object_deletion(v_file.upload_key, 'failed');
    perform private.queue_object_deletion(v_file.object_key, 'failed');
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.abandoned', pg_catalog.jsonb_build_object('reason', p_reason)
    );
    return true;
  end
  $$;

-- Attachments: tables -------------------------------------------------------------------------------

-- An upload in progress for one task: which task and the name it will show. Gone once attached.
create table private.task_attachment_uploads (
  file_id uuid primary key references private.stored_files (id) on delete cascade,
  task_id uuid not null references private.tasks (id) on delete cascade,
  display_name text not null
    constraint task_attachment_uploads_name_check check (private.is_visible_name(display_name, 200)),
  created_at timestamptz not null default now()
);

create index task_attachment_uploads_task_idx on private.task_attachment_uploads (task_id);

-- A recurring chain's attachments: every new occurrence gets a link to each active one.
create table private.task_series_attachments (
  id uuid primary key default gen_random_uuid(),
  root_id uuid not null,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  file_id uuid not null references private.stored_files (id) on delete cascade,
  display_name text not null
    constraint task_series_attachments_name_check check (private.is_visible_name(display_name, 200)),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  -- In the trash (a series-wide removal); the row goes when that entry is purged.
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,
  constraint task_series_attachments_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create index task_series_attachments_root_idx on private.task_series_attachments (root_id);
create index task_series_attachments_file_idx on private.task_series_attachments (file_id);
create unique index task_series_attachments_active_key on private.task_series_attachments (root_id, file_id)
  where removed_at is null;

-- A file attached to a task. from_series: it came from the chain's attachments (and keeps saying so
-- on completed occurrences, even after the series attachment itself is gone).
create table private.task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.tasks (id) on delete cascade,
  file_id uuid not null references private.stored_files (id) on delete cascade,
  series_attachment_id uuid references private.task_series_attachments (id) on delete set null,
  from_series boolean not null default false,
  display_name text not null
    constraint task_attachments_name_check check (private.is_visible_name(display_name, 200)),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  -- In the trash: removed on its own (an entry of type task_attachment) or with a series-wide removal
  -- (removed_with_series, restored with that entry).
  removed_at timestamptz,
  removed_by uuid references auth.users (id) on delete set null,
  removed_with_series boolean not null default false,
  constraint task_attachments_series_check check (series_attachment_id is null or from_series)
);

create index task_attachments_task_idx on private.task_attachments (task_id);
create index task_attachments_file_idx on private.task_attachments (file_id);
create index task_attachments_series_idx on private.task_attachments (series_attachment_id)
  where series_attachment_id is not null;
-- A file is attached to a task at most once at a time.
create unique index task_attachments_active_key on private.task_attachments (task_id, file_id)
  where removed_at is null;

alter table private.task_attachment_uploads enable row level security;
alter table private.task_series_attachments enable row level security;
alter table private.task_attachments enable row level security;
revoke all on table private.task_attachment_uploads, private.task_series_attachments,
  private.task_attachments
  from public, anon, authenticated, service_role;

-- Attachments: helpers ------------------------------------------------------------------------------

-- Whether an active task or an active chain uses the file now (it is not in the trash, nor only
-- referenced from the trash). A task that is being deleted is already marked deleted, so it does not
-- count. Sample rows (S16) count too, so the trash never releases a file either still uses.
create function private.file_in_active_use(p_file_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from private.task_attachments a
      join private.tasks t on t.id = a.task_id
      where a.file_id = p_file_id and a.removed_at is null and t.deleted_at is null
    )
    or exists (
      select 1 from private.task_series_attachments s
      where s.file_id = p_file_id and s.removed_at is null
        and exists (select 1 from private.task_series h
          where h.root_id = s.root_id and h.superseded_at is null and h.deleted_at is null)
    )
    or exists (
      select 1 from private.trash_samples s where s.file_id = p_file_id and s.deleted_at is null
    );
  $$;

-- Whether any row still refers to the file (active, in the trash, or on a task in the trash).
create function private.task_file_referenced(p_file_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.task_attachments a where a.file_id = p_file_id)
    or exists (select 1 from private.task_series_attachments s where s.file_id = p_file_id)
    or exists (select 1 from private.task_attachment_uploads u where u.file_id = p_file_id);
  $$;

-- Releases a task file nothing refers to any more: its space is freed and its object queued for
-- removal at once (a ready file is retired first). Rows are deleted only when their trash entry or
-- their task is purged, so this runs at the end of the recovery window, never before.
create function private.release_task_file(p_file_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_file_id is null or private.task_file_referenced(p_file_id)
       or exists (select 1 from private.trash_samples s where s.file_id = p_file_id) then
      return;
    end if;
    perform private.retire_file(p_file_id);
    perform private.purge_file_now(p_file_id);
  end
  $$;

create function private.release_task_file_on_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.release_task_file(old.file_id);
    return null;
  end
  $$;

create trigger task_attachments_release_file
  after delete on private.task_attachments
  for each row execute function private.release_task_file_on_delete();
create trigger task_series_attachments_release_file
  after delete on private.task_series_attachments
  for each row execute function private.release_task_file_on_delete();

-- A chain's attachments go when the last part of the chain does (purging an entire-series removal).
create function private.drop_series_attachments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if not exists (select 1 from private.task_series s where s.root_id = old.root_id) then
      delete from private.task_series_attachments a where a.root_id = old.root_id;
    end if;
    return null;
  end
  $$;

create trigger task_series_drop_attachments
  after delete on private.task_series
  for each row execute function private.drop_series_attachments();

-- Active attachments of a task.
-- An occurrence with a file of its own (attached on its own, still there or in the trash) counts as
-- changed on its own, like a comment: a schedule change keeps it instead of deleting it (S19 deletes
-- untouched occurrences that no longer fit, which would purge the file without a trash entry).
create or replace function private.occurrence_touched(p_task private.tasks) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_task.detached
    or exists (select 1 from private.task_comments c where c.task_id = p_task.id)
    or exists (select 1 from private.subtasks s where s.task_id = p_task.id and s.completed_at is not null)
    or exists (select 1 from private.task_attachments a where a.task_id = p_task.id and not a.from_series);
  $$;

create function private.task_attachment_count(p_task_id uuid) returns integer
  language sql stable security definer set search_path = '' as $$
  select count(*)::integer from private.task_attachments a
    where a.task_id = p_task_id and a.removed_at is null;
  $$;

-- A new occurrence starts with its chain's attachments (S19 creates occurrences in
-- private.create_occurrence; this trigger keeps that function unchanged).
create function private.copy_series_attachments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    insert into private.task_attachments (
      task_id, file_id, series_attachment_id, from_series, display_name, added_by, added_at
    )
    select new.id, s.file_id, s.id, true, s.display_name, s.added_by, pg_catalog.now()
    from private.task_series_attachments s
    join private.stored_files f on f.id = s.file_id and f.status = 'ready'
    where s.root_id = new.series_root_id and s.removed_at is null
    order by s.added_at, s.id
    limit private.task_limit('attachments')
    on conflict do nothing;
    return null;
  end
  $$;

create trigger tasks_copy_series_attachments
  after insert on private.tasks
  for each row when (new.series_root_id is not null)
  execute function private.copy_series_attachments();

-- Attachments: uploading ----------------------------------------------------------------------------

-- Opens an upload of one file for a task the caller may edit. The file goes to the task's pool: the
-- person's own for a Personal task, the Home's for a Home task. Same rate limits, request-id retries
-- and capacity check under the pool lock as S15's create_upload_intent; the task allows at most 10
-- attachments, uploads in progress included (checked under the task's lock, so two at once cannot
-- both take the last place). Outcomes: 'ok' (with the file id, upload key and expiry), 'not_found',
-- 'not_permitted', 'limit_reached', 'storage_full', 'rate_limited', 'conflict' (the request id was
-- used for a different upload). Invalid type, size or name: 22023.
create function public.create_task_attachment_intent(
  p_task_id uuid, p_content_type text, p_size bigint, p_name text, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text;
  begin
    if p_task_id is null or p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('task_attachment')
       or not private.upload_type_allowed('task_attachment', p_content_type)
       or p_name is null or not private.is_visible_name(p_name, private.task_limit('attachment_name')) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    -- Task first, then the pool: the same order as deleting a task (which then moves files).
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    v_pool := private.lock_storage_pool(v_task.owner_user_id, v_task.owner_home_id);

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'task_attachment' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() and exists (
           select 1 from private.task_attachment_uploads u
           where u.file_id = v_existing.id and u.task_id = v_task.id) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if private.task_attachment_count(v_task.id) + (
         select count(*)::integer from private.task_attachment_uploads u
         join private.stored_files f on f.id = u.file_id
         where u.task_id = v_task.id
           and (f.status = 'ready' or (f.status = 'pending' and f.expires_at > pg_catalog.now()))
       ) >= private.task_limit('attachments') then
      return query select 'limit_reached'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.created_at > pg_catalog.now() - interval '1 hour')
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now())
         >= private.storage_limit('pending_per_account') then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    select * into v_usage from private.storage_usage(v_pool.id);
    if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + p_size
       > private.storage_allowance(v_pool) then
      return query select 'storage_full'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    v_prefix := case when v_task.owner_home_id is not null then 'h' else 'u' end;
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'task_attachment', v_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    insert into private.task_attachment_uploads (file_id, task_id, display_name)
      values (v_file.id, v_task.id, p_name);

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'task_attachment', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

-- What adding to following or all occurrences would change, for the scope dialog and the result.
-- Rows: the open occurrences in scope (from p_from, or all), each with its fate.
create function private.series_attachment_targets(
  p_root_id uuid, p_scope text, p_from date, p_task_id uuid, p_file_id uuid
) returns table (task_id uuid, fate text)
  language sql stable security definer set search_path = '' as $$
  select t.id, case
      when t.completed_at is not null then 'completed'
      when t.id <> p_task_id and t.detached then 'kept'
      when exists (select 1 from private.task_attachments a
        where a.task_id = t.id and a.file_id = p_file_id and a.removed_at is null) then 'unchanged'
      when private.task_attachment_count(t.id) >= private.task_limit('attachments') then 'full'
      else 'added'
    end
  from private.tasks t
  where t.series_root_id = p_root_id and t.deleted_at is null
    and (p_scope = 'series' or t.occurrence_date >= p_from);
  $$;

-- The impact of a scope for the dialog, before anything is uploaded or removed: how many open
-- occurrences change, are kept (changed on their own), are completed (never touched) or are full.
-- p_attachment_id: the attachment to remove (null: adding). Outcomes: 'preview', 'not_found',
-- 'not_permitted', 'not_recurring', 'scope_unavailable'.
create function public.task_attachment_scope_impact(
  p_task_id uuid, p_scope text, p_attachment_id uuid default null
) returns table (outcome text, impact jsonb)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_link private.task_attachments;
    v_impact jsonb;
  begin
    if p_task_id is null or p_scope is null or p_scope not in ('following', 'series') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    if v_task.series_root_id is null then
      return query select 'not_recurring', null::jsonb;
      return;
    end if;
    select * into v_head from private.task_series s
      where s.root_id = v_task.series_root_id and s.superseded_at is null and s.deleted_at is null;
    if not found then
      return query select 'not_recurring', null::jsonb;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id) then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    if p_attachment_id is null then
      select pg_catalog.jsonb_build_object('scope', p_scope,
          'changed', count(*) filter (where x.fate = 'added'),
          'kept', count(*) filter (where x.fate = 'kept'),
          'full', count(*) filter (where x.fate = 'full'),
          'completed', count(*) filter (where x.fate = 'completed'))
        into v_impact
        from private.series_attachment_targets(v_head.root_id, p_scope, v_task.occurrence_date,
          v_task.id, null) x;
    else
      select * into v_link from private.task_attachments a
        where a.id = p_attachment_id and a.task_id = v_task.id and a.removed_at is null;
      if not found then
        return query select 'not_found', null::jsonb;
        return;
      end if;
      if v_link.series_attachment_id is null or not exists (
        select 1 from private.task_series_attachments s
        where s.id = v_link.series_attachment_id and s.removed_at is null
      ) then
        return query select 'scope_unavailable', null::jsonb;
        return;
      end if;
      select pg_catalog.jsonb_build_object('scope', p_scope,
          'changed', count(*) filter (where t.completed_at is null and (t.id = v_task.id or not t.detached)),
          'kept', count(*) filter (where t.completed_at is null and t.id <> v_task.id and t.detached),
          'full', 0,
          'completed', count(*) filter (where t.completed_at is not null))
        into v_impact
        from private.task_attachments a
        join private.tasks t on t.id = a.task_id
        where a.series_attachment_id = v_link.series_attachment_id and a.removed_at is null
          and t.deleted_at is null
          and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date);
    end if;
    return query select 'preview', v_impact;
  end
  $$;

-- Attaches one of the caller's finished uploads to the task it was opened for, re-checking that the
-- task still exists and that the caller may still edit it (membership, assignment and roles may
-- have changed since the intent). Scopes on an occurrence: 'this' (only this task), 'following' or
-- 'series' (the chain's attachments, so every new occurrence gets it, plus the open occurrences from
-- this one on, or all, that were not changed on their own; completed ones are never touched; the
-- series right). A retry answers 'attached' again without a second link. Outcomes: 'attached' (with
-- the attachment id and, for the series scopes, the impact), 'not_found' (no such finished upload of
-- the caller, or the task is gone), 'not_permitted', 'limit_reached' (the task, or for the series
-- scopes the chain, has 10), 'not_recurring', 'scope_unavailable' (a series scope from a completed
-- occurrence).
create function public.attach_task_file(p_file_id uuid, p_scope text default 'this')
returns table (outcome text, attachment_id uuid, impact jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_upload private.task_attachment_uploads;
    v_file private.stored_files;
    v_task private.tasks;
    v_head private.task_series;
    v_link private.task_attachments;
    v_series_attachment private.task_series_attachments;
    v_target record;
    v_impact jsonb;
    v_added integer := 0;
    v_kept integer := 0;
    v_full integer := 0;
    v_completed integer := 0;
  begin
    if p_file_id is null or p_scope is null or p_scope not in ('this', 'following', 'series') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = v_user_id and f.purpose = 'task_attachment';
    if not found then
      return query select 'not_found', null::uuid, null::jsonb;
      return;
    end if;
    select * into v_upload from private.task_attachment_uploads u where u.file_id = p_file_id;
    if not found then
      -- Already attached (a retry): the link it made.
      select * into v_link from private.task_attachments a
        where a.file_id = p_file_id and a.added_by = v_user_id and a.removed_at is null
          and not a.from_series
        order by a.added_at limit 1;
      if not found then
        select * into v_link from private.task_attachments a
          where a.file_id = p_file_id and a.added_by = v_user_id and a.removed_at is null
          order by a.added_at limit 1;
      end if;
      if v_link.id is not null and exists (
        select 1 from private.tasks t where t.id = v_link.task_id and t.deleted_at is null
          and private.in_task_context(t.owner_user_id, t.owner_home_id, v_user_id)
      ) then
        return query select 'attached', v_link.id, null::jsonb;
      else
        return query select 'not_found', null::uuid, null::jsonb;
      end if;
      return;
    end if;
    if p_scope <> 'this' then
      -- The series head before the occurrence, like every series-wide change (S19 review M1).
      perform private.lock_series_head(
        (select t.series_root_id from private.tasks t where t.id = v_upload.task_id));
    end if;
    v_task := private.lock_task(v_upload.task_id, v_user_id);
    -- The upload row again, under the task's lock: a concurrent attach of the same file waits here
    -- and then finds it gone.
    select * into v_upload from private.task_attachment_uploads u where u.file_id = p_file_id for update;
    if not found then
      return query select o.outcome, o.attachment_id, o.impact
        from public.attach_task_file(p_file_id, p_scope) o;
      return;
    end if;
    if v_task.id is null then
      return query select 'not_found', null::uuid, null::jsonb;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted', null::uuid, null::jsonb;
      return;
    end if;
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if v_file.status <> 'ready' then
      return query select 'not_found', null::uuid, null::jsonb;
      return;
    end if;
    if private.task_attachment_count(v_task.id) >= private.task_limit('attachments') then
      return query select 'limit_reached', null::uuid, null::jsonb;
      return;
    end if;

    if p_scope = 'this' then
      insert into private.task_attachments (task_id, file_id, display_name, added_by)
        values (v_task.id, p_file_id, v_upload.display_name, v_user_id)
        returning * into v_link;
    else
      if v_task.series_root_id is null then
        return query select 'not_recurring', null::uuid, null::jsonb;
        return;
      end if;
      v_head := private.lock_series_head(v_task.series_root_id);
      if v_head.id is null then
        return query select 'not_recurring', null::uuid, null::jsonb;
        return;
      end if;
      if not private.can_edit_series(v_head, v_user_id) then
        return query select 'not_permitted', null::uuid, null::jsonb;
        return;
      end if;
      -- A completed occurrence is never changed by a series change, so it cannot be the one a
      -- series-wide file is added from (it would not get the file itself).
      if v_task.completed_at is not null then
        return query select 'scope_unavailable', null::uuid, null::jsonb;
        return;
      end if;
      -- The chain holds at most as many attachments as a task (checked under the head lock).
      if (select count(*) from private.task_series_attachments s
          where s.root_id = v_head.root_id and s.removed_at is null)
         >= private.task_limit('attachments') then
        return query select 'limit_reached', null::uuid, null::jsonb;
        return;
      end if;
      insert into private.task_series_attachments (
        root_id, owner_user_id, owner_home_id, file_id, display_name, added_by
      ) values (
        v_head.root_id, v_head.owner_user_id, v_head.owner_home_id, p_file_id,
        v_upload.display_name, v_user_id
      ) returning * into v_series_attachment;
      for v_target in
        select x.task_id, x.fate from private.series_attachment_targets(
          v_head.root_id, p_scope, v_task.occurrence_date, v_task.id, p_file_id) x
        order by x.task_id
      loop
        case v_target.fate
          when 'added' then
            perform 1 from private.tasks t where t.id = v_target.task_id for update;
            -- Again under the target's lock: another upload may have taken its last place, and
            -- uploads still in progress for another occurrence count too (this upload's own task
            -- was checked above, where its place was reserved by the intent).
            if v_target.task_id <> v_task.id
               and private.task_attachment_count(v_target.task_id)
                 + (select count(*) from private.task_attachment_uploads u
                    where u.task_id = v_target.task_id)
               >= private.task_limit('attachments') then
              v_full := v_full + 1;
              continue;
            end if;
            insert into private.task_attachments (
              task_id, file_id, series_attachment_id, from_series, display_name, added_by
            ) values (
              v_target.task_id, p_file_id, v_series_attachment.id, true, v_upload.display_name, v_user_id
            ) returning * into v_link;
            v_added := v_added + 1;
          when 'kept' then v_kept := v_kept + 1;
          when 'full' then v_full := v_full + 1;
          when 'completed' then v_completed := v_completed + 1;
          else null;
        end case;
      end loop;
      select * into v_link from private.task_attachments a
        where a.task_id = v_task.id and a.file_id = p_file_id and a.removed_at is null;
      v_impact := pg_catalog.jsonb_build_object('scope', p_scope, 'changed', v_added, 'kept', v_kept,
        'full', v_full, 'completed', v_completed);
    end if;
    delete from private.task_attachment_uploads u where u.file_id = p_file_id;
    perform private.audit_task('task.attachment_added', v_task.owner_home_id, 'task_attachment',
      v_link.id, pg_catalog.jsonb_build_object('scope', p_scope));
    return query select 'attached', v_link.id, v_impact;
  end
  $$;

-- Attachments: reading ------------------------------------------------------------------------------

-- A task's attachments for someone who may see the task, oldest first: name, verified type and
-- size, whether it came from the series (and is still a series attachment), who added it, and
-- whether the caller may remove it. The task-level answers say whether the caller may add files and
-- change series attachments. Null when the task is missing, deleted or not theirs to see.
create function public.list_task_attachments(p_task_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_can_edit boolean;
  begin
    if p_task_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_task from private.tasks t where t.id = p_task_id;
    if not found or v_task.deleted_at is not null
       or not private.in_task_context(v_task.owner_user_id, v_task.owner_home_id, v_user_id) then
      return null;
    end if;
    v_can_edit := private.can_edit_task(v_task, v_user_id);
    if v_task.series_root_id is not null then
      select * into v_head from private.task_series s
        where s.root_id = v_task.series_root_id and s.superseded_at is null and s.deleted_at is null;
    end if;
    return pg_catalog.jsonb_build_object(
      'canAdd', v_can_edit,
      -- Series-wide changes start from an open occurrence (a completed one is never changed).
      'canChangeSeries', v_head.id is not null and v_task.completed_at is null
        and private.can_edit_series(v_head, v_user_id),
      'limit', private.task_limit('attachments'),
      'attachments', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', a.id,
            'fileId', a.file_id,
            'name', a.display_name,
            'contentType', f.content_type,
            'size', f.size_bytes,
            'fromSeries', a.from_series,
            'seriesActive', a.series_attachment_id is not null and exists (
              select 1 from private.task_series_attachments s
              where s.id = a.series_attachment_id and s.removed_at is null),
            'addedAt', a.added_at,
            'addedBy', pg_catalog.jsonb_build_object(
              'me', coalesce(a.added_by = v_user_id, false),
              'member', case when v_task.owner_home_id is not null
                then private.member_ref(v_task.owner_home_id, a.added_by) end),
            'canRemove', v_can_edit
          ) order by a.added_at, a.id)
        from private.task_attachments a
        join private.stored_files f on f.id = a.file_id and f.status = 'ready'
        where a.task_id = v_task.id and a.removed_at is null
      ), '[]'::jsonb)
    );
  end
  $$;

-- The object behind a file the caller may see now, or no row (the same answer for every reason).
-- S15 avatars as before. Task attachments (S19c): while the file is attached to a task (not in the
-- trash) that the caller may see now: its Personal space's owner, or a current member of its Home.
-- display_name is the attachment's name (null for avatars), for the download's file name.
drop function public.authorize_file_read(uuid);
create function public.authorize_file_read(p_file_id uuid)
returns table (object_key text, content_type text, size_bytes bigint, sha256 text, display_name text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select f.object_key, f.content_type, f.size_bytes, f.sha256, null::text
      from private.stored_files f
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'avatar'
        and (
          f.created_by = v_user_id
          or exists (
            select 1
            from public.home_memberships owner_m
            join public.home_memberships viewer_m
              on viewer_m.home_id = owner_m.home_id and viewer_m.user_id = v_user_id
            left join public.home_member_profiles hp
              on hp.home_id = owner_m.home_id and hp.user_id = owner_m.user_id
            left join public.user_preferences up on up.user_id = owner_m.user_id
            where owner_m.user_id = f.created_by
              and coalesce(hp.avatar_file_id, up.avatar_file_id) = f.id
          )
        )
      union all
      select f.object_key, f.content_type, f.size_bytes, f.sha256, x.display_name
      from private.stored_files f,
        lateral (
          select a.display_name from private.task_attachments a
          join private.tasks t on t.id = a.task_id
          where a.file_id = f.id and a.removed_at is null and t.deleted_at is null
            and private.in_task_context(t.owner_user_id, t.owner_home_id, v_user_id)
          order by a.added_at, a.id
          limit 1
        ) x
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'task_attachment';
  end
  $$;

-- Attachments: removing ------------------------------------------------------------------------------

-- Removes an attachment into the trash of the task's context (7 days). 'this': from this task only
-- (an entry of type task_attachment). 'following' / 'series' on an attachment that came from the
-- series: the chain's attachment goes (new occurrences no longer get it), and so do its links on
-- the open occurrences from this one on, or all, that were not changed on their own (this one
-- always); completed occurrences keep theirs. One entry (task_series_attachment) brings it all back.
-- The file goes into the file trash too when no active task uses it any more (still counted until
-- purged). Rights: the task's editors; the series right for the series scopes. p_dry_run: the impact
-- only. Outcomes: 'preview', 'removed' (with the trash entry and, for series scopes, the impact),
-- 'not_found' (also when someone removed it first), 'not_permitted', 'scope_unavailable'.
create function public.remove_task_attachment(
  p_attachment_id uuid, p_scope text default 'this', p_dry_run boolean default false
) returns table (outcome text, entry_id uuid, impact jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_link private.task_attachments;
    v_task private.tasks;
    v_head private.task_series;
    v_series_attachment private.task_series_attachments;
    v_entry uuid;
    v_changed integer := 0;
    v_kept integer := 0;
    v_completed integer := 0;
    v_impact jsonb;
  begin
    if p_attachment_id is null or p_scope is null or p_scope not in ('this', 'following', 'series')
       or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_link from private.task_attachments a where a.id = p_attachment_id;
    if not found then
      return query select 'not_found', null::uuid, null::jsonb;
      return;
    end if;
    if p_scope <> 'this' then
      perform private.lock_series_head(
        (select t.series_root_id from private.tasks t where t.id = v_link.task_id));
    end if;
    v_task := private.lock_task(v_link.task_id, v_user_id);
    select * into v_link from private.task_attachments a where a.id = p_attachment_id for update;
    if v_task.id is null or v_link.removed_at is not null then
      return query select 'not_found', null::uuid, null::jsonb;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted', null::uuid, null::jsonb;
      return;
    end if;

    if p_scope = 'this' then
      if p_dry_run then
        return query select 'preview', null::uuid, null::jsonb;
        return;
      end if;
      update private.tasks t set updated_at = pg_catalog.now() where t.id = v_task.id;
      update private.task_attachments a set removed_at = pg_catalog.now(), removed_by = v_user_id
        where a.id = v_link.id;
      v_entry := private.trash_move(v_user_id, 'tasks', 'task_attachment', v_link.id,
        v_task.owner_user_id, v_task.owner_home_id, v_link.display_name,
        case when private.file_in_active_use(v_link.file_id) then '{}'::uuid[]
          else array[v_link.file_id] end);
      perform private.audit_task('task.attachment_removed', v_task.owner_home_id, 'task_attachment',
        v_link.id, pg_catalog.jsonb_build_object('scope', 'this'));
      return query select 'removed', v_entry, null::jsonb;
      return;
    end if;

    if v_link.series_attachment_id is null then
      return query select 'scope_unavailable', null::uuid, null::jsonb;
      return;
    end if;
    select * into v_series_attachment from private.task_series_attachments s
      where s.id = v_link.series_attachment_id for update;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_series_attachment.removed_at is not null or v_head.id is null then
      return query select 'scope_unavailable', null::uuid, null::jsonb;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id) then
      return query select 'not_permitted', null::uuid, null::jsonb;
      return;
    end if;
    select count(*) filter (where t.completed_at is null and (t.id = v_task.id or not t.detached)),
        count(*) filter (where t.completed_at is null and t.id <> v_task.id and t.detached),
        count(*) filter (where t.completed_at is not null)
      into v_changed, v_kept, v_completed
      from private.task_attachments a
      join private.tasks t on t.id = a.task_id
      where a.series_attachment_id = v_series_attachment.id and a.removed_at is null
        and t.deleted_at is null
        and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date);
    v_impact := pg_catalog.jsonb_build_object('scope', p_scope, 'changed', v_changed, 'kept', v_kept,
      'full', 0, 'completed', v_completed);
    if p_dry_run then
      return query select 'preview', null::uuid, v_impact;
      return;
    end if;
    update private.task_series_attachments s set removed_at = pg_catalog.now(), removed_by = v_user_id
      where s.id = v_series_attachment.id;
    update private.task_attachments a
      set removed_at = pg_catalog.now(), removed_by = v_user_id, removed_with_series = true
      from private.tasks t
      where t.id = a.task_id and a.series_attachment_id = v_series_attachment.id
        and a.removed_at is null and t.deleted_at is null and t.completed_at is null
        and (t.id = v_task.id or not t.detached)
        and (p_scope = 'series' or t.occurrence_date >= v_task.occurrence_date);
    v_entry := private.trash_move(v_user_id, 'tasks', 'task_series_attachment', v_series_attachment.id,
      v_task.owner_user_id, v_task.owner_home_id, v_series_attachment.display_name,
      case when private.file_in_active_use(v_series_attachment.file_id) then '{}'::uuid[]
        else array[v_series_attachment.file_id] end);
    perform private.audit_task('task_series.attachment_removed', v_task.owner_home_id, 'task_series',
      v_head.root_id, pg_catalog.jsonb_build_object('scope', p_scope, 'changed', v_changed));
    return query select 'removed', v_entry, v_impact;
  end
  $$;

-- Deleting a task (S18) now takes along the files no other active task uses. The rest unchanged.
create or replace function public.delete_task(p_task_id uuid)
returns table (outcome text, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_files uuid[];
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
    -- Marked deleted first, so this task no longer counts as using its files.
    select coalesce(array_agg(distinct a.file_id), '{}') into v_files
      from private.task_attachments a
      where a.task_id = v_task.id and a.removed_at is null
        and not private.file_in_active_use(a.file_id);
    return query select 'deleted',
      private.trash_move(v_user_id, 'tasks', 'task', v_task.id, v_task.owner_user_id,
        v_task.owner_home_id, v_task.title, v_files);
  end
  $$;

-- Retires a finished attachment upload nobody attached (the browser stopped after finalize, or the
-- attach was refused): otherwise it would count forever without being visible anywhere.
create function private.retire_unattached_upload(p_file_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    delete from private.task_attachment_uploads u where u.file_id = p_file_id;
    if not exists (select 1 from private.task_attachments a where a.file_id = p_file_id)
       and not exists (select 1 from private.task_series_attachments s where s.file_id = p_file_id) then
      perform private.retire_file(p_file_id);
    end if;
  end
  $$;

-- storage-upload-expire (S15) also retires a finished task attachment that was never attached, and
-- forgets the upload of one that failed or expired.
create or replace function public.expire_upload(p_file_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found then
      return 'missing';
    end if;
    -- Pool first, then the file: the same lock order as every other writer.
    perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'pending' and v_file.expires_at <= pg_catalog.now() then
      update private.stored_files f set status = 'failed' where f.id = v_file.id
        returning * into v_file;
    end if;
    if v_file.status = 'failed' then
      perform private.queue_object_deletion(v_file.upload_key, 'expired');
      perform private.queue_object_deletion(v_file.object_key, 'expired');
      delete from private.task_attachment_uploads u where u.file_id = v_file.id;
    elsif v_file.status <> 'pending' then
      perform private.queue_object_deletion(v_file.upload_key, 'processed');
    end if;
    -- A finished avatar that was never chosen (the browser stopped after finalize) would count
    -- forever without being visible anywhere: it is retired like a replaced one (M2).
    if v_file.status = 'ready' and v_file.purpose = 'avatar' then
      perform private.retire_avatar_if_unused(v_file.created_by, v_file.id);
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    -- The same for a task attachment that was finalized but never attached.
    if v_file.status = 'ready' and v_file.purpose = 'task_attachment'
       and exists (select 1 from private.task_attachment_uploads u where u.file_id = v_file.id) then
      perform private.retire_unattached_upload(v_file.id);
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    return v_file.status;
  end
  $$;

-- Trash: attachments --------------------------------------------------------------------------------

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment'
  ));

-- The four dispatch functions again, with the cases for attachments (S19 cases unchanged). Their
-- conflicts: the task (or for a series attachment, the series) is gone or in the trash
-- ('task_unavailable', 'series_unavailable': restore that first), or the task already has the
-- maximum number of attachments ('attachment_limit'). Neither has a resolution: the person frees a
-- place or restores the task, then tries again.
create or replace function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_sample private.trash_samples;
    v_task private.tasks;
    v_removal private.task_series_removals;
    v_head private.task_series;
    v_link private.task_attachments;
    v_series_attachment private.task_series_attachments;
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
      when 'task_attachment' then
        select * into v_link from private.task_attachments a where a.id = p_entry.subject_id;
        if not found or v_link.removed_at is null or v_link.removed_with_series then
          return 'item_missing';
        end if;
        select * into v_task from private.tasks t where t.id = v_link.task_id;
        if not found or v_task.deleted_at is not null then
          return 'task_unavailable';
        end if;
        if not exists (
          select 1 from private.task_attachments a
          where a.task_id = v_link.task_id and a.file_id = v_link.file_id and a.removed_at is null
        ) and private.task_attachment_count(v_link.task_id) >= private.task_limit('attachments') then
          return 'attachment_limit';
        end if;
        return null;
      when 'task_series_attachment' then
        select * into v_series_attachment from private.task_series_attachments s
          where s.id = p_entry.subject_id;
        if not found or v_series_attachment.removed_at is null then
          return 'item_missing';
        end if;
        if not exists (
          select 1 from private.task_series s
          where s.root_id = v_series_attachment.root_id and s.superseded_at is null
            and s.deleted_at is null
        ) then
          return 'series_unavailable';
        end if;
        return null;
    end case;
    return null;
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
    v_link private.task_attachments;
    v_series_attachment private.task_series_attachments;
  begin
    -- The series head and the task before any storage pool (restore_file locks pools): the order of
    -- the upload, delete and remove paths, so a restore never deadlocks with them.
    case p_entry.item_type
      when 'task' then
        perform 1 from private.tasks t where t.id = p_entry.subject_id for update;
      when 'task_attachment' then
        perform 1 from private.tasks t
          where t.id = (select a.task_id from private.task_attachments a where a.id = p_entry.subject_id)
          for update;
      when 'task_series_attachment' then
        perform private.lock_series_head(
          (select s.root_id from private.task_series_attachments s where s.id = p_entry.subject_id));
      else
        null;
    end case;
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
        select s.file_id into v_ref from private.trash_samples s where s.id = p_entry.subject_id;
        if v_ref is not null and not (v_ref = any (v_lost_ids)) and not private.restore_file(v_ref) then
          v_lost := v_lost + 1;
          v_lost_ids := v_lost_ids || v_ref;
        end if;
        update private.trash_samples s
          set deleted_at = null,
            file_id = case when s.file_id = any (v_lost_ids) then null else s.file_id end
          where s.id = p_entry.subject_id;
      when 'dashboard_template' then
        update private.dashboard_templates t set deleted_at = null, updated_at = pg_catalog.now()
          where t.id = p_entry.subject_id;
      when 'task' then
        select * into v_task from private.tasks t where t.id = p_entry.subject_id for update;
        if v_task.list_id is null
           or not private.usable_task_list(v_task.list_id, v_task.owner_user_id, v_task.owner_home_id) then
          raise exception 'task list unavailable' using errcode = '23505';
        end if;
        update private.tasks t set deleted_at = null where t.id = v_task.id;
        -- Its attachments come back with it. A file that went to the trash with another task (the
        -- last one deleted takes it along) is brought back too; one that is gone is dropped from
        -- the task, and reported, so no attachment points at nothing.
        for v_link in
          select * from private.task_attachments a
          where a.task_id = v_task.id and a.removed_at is null order by a.id
        loop
          if not (v_link.file_id = any (v_lost_ids)) and private.restore_file(v_link.file_id) then
            continue;
          end if;
          if not (v_link.file_id = any (v_lost_ids)) then
            v_lost := v_lost + 1;
            v_lost_ids := v_lost_ids || v_link.file_id;
          end if;
          delete from private.task_attachments a where a.id = v_link.id;
        end loop;
      when 'task_list' then
        update private.task_lists l set deleted_at = null, updated_at = pg_catalog.now()
          where l.id = p_entry.subject_id;
      when 'task_series_removal' then
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
      when 'task_attachment' then
        -- The task is locked and checked again (deleted since the conflict check: a conflict).
        select * into v_link from private.task_attachments a where a.id = p_entry.subject_id for update;
        select * into v_task from private.tasks t where t.id = v_link.task_id for update;
        if v_task.id is null or v_task.deleted_at is not null then
          raise exception 'task unavailable' using errcode = '23505';
        end if;
        if not (v_link.file_id = any (v_lost_ids)) and not private.restore_file(v_link.file_id) then
          v_lost := v_lost + 1;
          v_lost_ids := v_lost_ids || v_link.file_id;
        end if;
        if v_link.file_id = any (v_lost_ids) or exists (
          select 1 from private.task_attachments a
          where a.task_id = v_link.task_id and a.file_id = v_link.file_id and a.removed_at is null
        ) then
          -- Gone, or the same file is attached again meanwhile: nothing to bring back.
          delete from private.task_attachments a where a.id = v_link.id;
        else
          if private.task_attachment_count(v_link.task_id) >= private.task_limit('attachments') then
            raise exception 'attachment limit' using errcode = '23505';
          end if;
          update private.task_attachments a set removed_at = null, removed_by = null
            where a.id = v_link.id;
        end if;
      when 'task_series_attachment' then
        -- The chain's attachment comes back, and so do its links removed with it on occurrences that
        -- are still open and active and have room (completed ones stay as they were).
        select * into v_series_attachment from private.task_series_attachments s
          where s.id = p_entry.subject_id for update;
        if not exists (
          select 1 from private.task_series s
          where s.root_id = v_series_attachment.root_id and s.superseded_at is null
            and s.deleted_at is null
        ) then
          raise exception 'series unavailable' using errcode = '23505';
        end if;
        if not (v_series_attachment.file_id = any (v_lost_ids))
           and not private.restore_file(v_series_attachment.file_id) then
          v_lost := v_lost + 1;
          v_lost_ids := v_lost_ids || v_series_attachment.file_id;
        end if;
        if v_series_attachment.file_id = any (v_lost_ids) then
          delete from private.task_attachments a
            where a.series_attachment_id = v_series_attachment.id and a.removed_with_series;
          delete from private.task_series_attachments s where s.id = v_series_attachment.id;
        else
          if exists (
            select 1 from private.task_series_attachments s
            where s.root_id = v_series_attachment.root_id and s.file_id = v_series_attachment.file_id
              and s.removed_at is null
          ) then
            raise exception 'already a series attachment' using errcode = '23505';
          end if;
          update private.task_series_attachments s set removed_at = null, removed_by = null
            where s.id = v_series_attachment.id;
          for v_link in
            select a.* from private.task_attachments a
            join private.tasks t on t.id = a.task_id
            where a.series_attachment_id = v_series_attachment.id and a.removed_with_series
              and t.deleted_at is null and t.completed_at is null
            order by a.task_id for update of a
          loop
            if exists (
              select 1 from private.task_attachments o
              where o.task_id = v_link.task_id and o.file_id = v_link.file_id and o.removed_at is null
            ) or private.task_attachment_count(v_link.task_id) >= private.task_limit('attachments') then
              continue;
            end if;
            update private.task_attachments a
              set removed_at = null, removed_by = null, removed_with_series = false
              where a.id = v_link.id;
          end loop;
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
      -- Never release a file another active item still uses. Task files are released when their
      -- last row goes (private.release_task_file, below), so a file another entry can still bring
      -- back is kept until then.
      if not private.file_in_active_use(v_file_id) and not private.task_file_referenced(v_file_id) then
        perform private.purge_file_now(v_file_id);
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        delete from private.trash_samples s where s.id = p_entry.subject_id and s.deleted_at is not null;
      when 'dashboard_template' then
        delete from private.dashboard_templates t
          where t.id = p_entry.subject_id and t.deleted_at is not null;
      when 'task' then
        -- Subtasks, comments, label links, assignees and attachment links go with it (on delete
        -- cascade); a file no row refers to any more is then released.
        delete from private.tasks t where t.id = p_entry.subject_id and t.deleted_at is not null;
      when 'task_list' then
        delete from private.task_lists l where l.id = p_entry.subject_id and l.deleted_at is not null;
      when 'task_series_removal' then
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
      when 'task_attachment' then
        delete from private.task_attachments a
          where a.id = p_entry.subject_id and a.removed_at is not null;
      when 'task_series_attachment' then
        -- Its links removed with it go too; links on completed occurrences stay (as from the series).
        delete from private.task_attachments a
          where a.series_attachment_id = p_entry.subject_id and a.removed_with_series
            and a.removed_at is not null;
        delete from private.task_series_attachments s
          where s.id = p_entry.subject_id and s.removed_at is not null;
    end case;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.list_tasks(uuid, uuid, date, text, text, boolean, text[], uuid[], text, uuid, text, integer, integer)',
    'public.list_task_calendar(date, date, uuid, date, uuid, text, text[], uuid[], text, uuid)',
    'public.abandon_my_upload(uuid, text)',
    'public.create_task_attachment_intent(uuid, text, bigint, text, uuid)',
    'public.task_attachment_scope_impact(uuid, text, uuid)',
    'public.attach_task_file(uuid, text)',
    'public.list_task_attachments(uuid)',
    'public.authorize_file_read(uuid)',
    'public.remove_task_attachment(uuid, text, boolean)',
    'public.delete_task(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  foreach v_function in array array['public.expire_upload(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.task_limit(text)',
    'private.task_attachment_type(text)',
    'private.upload_max_bytes(text)',
    'private.upload_type_allowed(text, text)',
    'private.stored_type_allowed(text, text)',
    'private.file_in_active_use(uuid)',
    'private.task_file_referenced(uuid)',
    'private.release_task_file(uuid)',
    'private.release_task_file_on_delete()',
    'private.drop_series_attachments()',
    'private.task_attachment_count(uuid)',
    'private.copy_series_attachments()',
    'private.series_attachment_targets(uuid, text, date, uuid, uuid)',
    'private.retire_unattached_upload(uuid)',
    'private.trash_conflict(private.trash_entries)',
    'private.trash_item_restore(private.trash_entries)',
    'private.trash_item_purge(private.trash_entries)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
