-- S20: chore templates, the Home-wide chore history, bulk occurrence actions and the chore widgets'
-- reads (brief plans/steps/S20-brief.md; ADR 0026; spec "Confirmed reusable chore templates",
-- "Confirmed searchable Home-wide chore completion history", "Confirmed limited bulk chore
-- occurrence management", "Confirmed configurable chore dashboard widgets"). Builds on
-- 20261030090000_chores.sql; like it, nothing is exposed as a table.
--
-- Templates belong to one Home and are managed and used by its chore managers (default picked: the
-- same people who create chores). They hold a title, instructions, a category, an estimate and a
-- checklist; never assignees, schedules, approval or history. A chore made from one is an
-- independent copy (the interface copies the fields into the new-chore form), so editing or retiring
-- a template never changes a chore. Suggested reward points come with points in S23.
--
-- The Home-wide history reads every occurrence of the Home that its members may see (all of them:
-- every member sees every chore), with search and filters. Bulk actions change selected open
-- occurrences one at a time through the same functions as a single change, each under its chore's
-- lock with its own revision, so a stale or closed one is reported and the rest still apply.

-- Templates --------------------------------------------------------------------------------------------

create table private.chore_templates (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  title text not null constraint chore_templates_title_check check (private.is_visible_name(title, 200)),
  instructions text constraint chore_templates_instructions_check
    check (instructions is null or private.is_plain_text(instructions, 2000)),
  category_id uuid,
  estimated_minutes integer constraint chore_templates_minutes_check
    check (estimated_minutes between 1 and 1440),
  -- [{label, mandatory}], as private.chore_steps reads it.
  steps jsonb not null default '[]'::jsonb,
  retired_at timestamptz,
  revision integer not null default 1 constraint chore_templates_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint chore_templates_category_fkey foreign key (category_id, home_id)
    references private.chore_categories (id, home_id) on delete set null (category_id)
);

create index chore_templates_home_idx on private.chore_templates (home_id);

alter table private.chore_templates enable row level security;
revoke all on table private.chore_templates from public, anon, authenticated;
comment on table private.chore_templates is 'S20: Home chore templates. Not exposed through the API.';

-- 100 templates per Home (apps/web/src/chores/schema.ts uses the same number).
create function private.chore_template_limit() returns integer
  language sql immutable set search_path = '' as $$ select 100; $$;

create function private.chore_template_name_taken(p_home_id uuid, p_title text, p_except uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.chore_templates t
    where t.home_id = p_home_id and t.id is distinct from p_except
      and private.task_name_key(t.title) = private.task_name_key(p_title)
  );
  $$;

-- The checklist as a template stores it (labels and flags only), or 22023 when malformed.
create function private.chore_template_steps(p_steps jsonb) returns jsonb
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'label', s.label, 'mandatory', s.mandatory) order by s.step_position), '[]'::jsonb)
  from private.chore_steps(coalesce(p_steps, '[]'::jsonb)) s;
  $$;

-- The Home's templates for chore managers, by title (retired ones only when asked); nothing for
-- anyone else, so their titles stay hidden. 42501 for a Home the caller is not in.
create function public.list_chore_templates(p_home_id uuid, p_include_retired boolean default false)
returns table (
  id uuid, title text, instructions text, category_id uuid, category_name text, category_color text,
  category_archived boolean, minutes integer, steps jsonb, retired boolean, revision integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return;
    end if;
    return query
      select t.id, t.title, t.instructions, g.id, g.name, g.color, g.archived_at is not null,
        t.estimated_minutes, t.steps, t.retired_at is not null, t.revision
      from private.chore_templates t
      left join private.chore_categories g on g.id = t.category_id
      where t.home_id = p_home_id and (coalesce(p_include_retired, false) or t.retired_at is null)
      order by private.task_name_key(t.title), t.id;
  end
  $$;

-- Creates a template (chore managers). p_id comes from the client, so a retry returns 'exists'.
-- Outcomes: 'created', 'exists', 'id_taken', 'not_permitted', 'duplicate_name', 'limit_reached',
-- 'invalid_category'. 22023 for invalid fields.
create function public.create_chore_template(
  p_id uuid, p_home_id uuid, p_title text, p_instructions text default null,
  p_category_id uuid default null, p_minutes integer default null, p_steps jsonb default '[]'::jsonb
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_steps jsonb;
    v_existing private.chore_templates;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or not private.valid_chore_fields(p_title, p_instructions, p_minutes) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform 1 from private.chore_steps(coalesce(p_steps, '[]'::jsonb)) s where s.step_id is not null;
    if found then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_steps := private.chore_template_steps(p_steps);
    select * into v_existing from private.chore_templates t where t.id = p_id;
    if found then
      return query select case when v_existing.created_by = v_user_id and v_existing.home_id = p_home_id
        then 'exists' else 'id_taken' end,
        case when v_existing.created_by = v_user_id then v_existing.revision end;
      return;
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if not private.usable_chore_category(p_home_id, p_category_id) then
      return query select 'invalid_category', null::integer;
      return;
    end if;
    perform private.lock_chore_home('templates', p_home_id);
    if private.chore_template_name_taken(p_home_id, p_title, null) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    if (select count(*) from private.chore_templates t where t.home_id = p_home_id)
       >= private.chore_template_limit() then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.chore_templates (
      id, home_id, title, instructions, category_id, estimated_minutes, steps, created_by, updated_by
    ) values (
      p_id, p_home_id, p_title, p_instructions, p_category_id, p_minutes, v_steps, v_user_id, v_user_id
    ) on conflict (id) do nothing;
    if not found then
      return query select 'id_taken', null::integer;
      return;
    end if;
    perform private.audit_chore('chore_template.created', p_home_id, 'chore_template', p_id);
    return query select 'created', 1;
  end
  $$;

-- Changes a template's fields, or retires or reinstates it (chore managers). Chores made from it
-- never change. An archived category may stay, not be newly chosen. p_retired null keeps it.
-- Outcomes: 'saved', 'conflict' (with the current revision), 'not_found', 'not_permitted',
-- 'duplicate_name', 'invalid_category'.
create function public.update_chore_template(
  p_id uuid, p_expected_revision integer, p_title text, p_instructions text default null,
  p_category_id uuid default null, p_minutes integer default null, p_steps jsonb default '[]'::jsonb,
  p_retired boolean default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_steps jsonb;
    v_template private.chore_templates;
  begin
    if p_id is null or p_expected_revision is null
       or not private.valid_chore_fields(p_title, p_instructions, p_minutes) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform 1 from private.chore_steps(coalesce(p_steps, '[]'::jsonb)) s where s.step_id is not null;
    if found then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_steps := private.chore_template_steps(p_steps);
    select * into v_template from private.chore_templates t where t.id = p_id for update;
    if not found or not private.is_home_member(v_template.home_id, v_user_id) then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_template.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_template.revision <> p_expected_revision then
      return query select 'conflict', v_template.revision;
      return;
    end if;
    if p_category_id is distinct from v_template.category_id
       and not private.usable_chore_category(v_template.home_id, p_category_id) then
      return query select 'invalid_category', null::integer;
      return;
    end if;
    perform private.lock_chore_home('templates', v_template.home_id);
    if private.chore_template_name_taken(v_template.home_id, p_title, v_template.id) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    update private.chore_templates t
      set title = p_title, instructions = p_instructions, category_id = p_category_id,
        estimated_minutes = p_minutes, steps = v_steps,
        retired_at = case when p_retired is null then t.retired_at
          when p_retired then coalesce(t.retired_at, pg_catalog.now()) end,
        revision = t.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where t.id = v_template.id
      returning * into v_template;
    perform private.audit_chore('chore_template.updated', v_template.home_id, 'chore_template',
      v_template.id, pg_catalog.jsonb_build_object('retired', v_template.retired_at is not null));
    return query select 'saved', v_template.revision;
  end
  $$;

-- The Home-wide history --------------------------------------------------------------------------------

-- One page of the Home's chore history (spec "Confirmed searchable Home-wide chore completion
-- history"), strictly this Home, every member of it. Each row is one occurrence with its chore,
-- dates, assignees, outcome (open, due today, missed, needs rework, pending approval, completed,
-- skipped) and record. Filters combine:
--   p_search      the chore's title (as the occurrence was closed under, or now), the completion
--                 note or the skip reason, case-insensitive (at most 100 characters);
--   p_member      a membership id: assigned to them, or done by them;
--   p_chore_id    one chore;
--   p_from, p_to  a date range, on the scheduled date (p_basis 'scheduled', the default) or the
--                 completion date in the Home's timezone ('completed': completed ones only);
--   p_state       'all', 'open' (not yet due), 'due_today', 'missed', 'rework', 'pending_approval',
--                 'completed', 'skipped';
--   p_approval    'any', 'pending', 'approved', 'rejected' (had a rejected attempt), 'none'
--                 (never submitted for approval).
-- Newest first: by scheduled date, or by completion time on the completed basis. 42501 for a Home
-- the caller is not in.
create function public.list_home_chore_history(
  p_home_id uuid, p_search text default null, p_member uuid default null, p_chore_id uuid default null,
  p_from date default null, p_to date default null, p_basis text default 'scheduled',
  p_state text default 'all', p_approval text default 'any',
  p_offset integer default 0, p_limit integer default 50
) returns table (
  id uuid, chore_id uuid, scheduled_date date, due_date date, status text, title text,
  category text, category_color text, assignee_member_ids uuid[],
  completed_at timestamptz, completed_by_me boolean, completed_by_member uuid,
  contributor_me boolean, contributor_member uuid, note text,
  skipped_at timestamptz, skipped_by_me boolean, skipped_by_member uuid, skip_reason text,
  approved_at timestamptz, approved_by_me boolean, approved_by_member uuid,
  attempts integer, rejected integer, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_zone text;
    v_member_user uuid;
    v_pattern text;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if (p_search is not null and pg_catalog.char_length(p_search) > 100)
       or p_basis is null or p_basis not in ('scheduled', 'completed')
       or p_state is null or p_state not in ('all', 'open', 'due_today', 'missed', 'rework',
         'pending_approval', 'completed', 'skipped')
       or p_approval is null or p_approval not in ('any', 'pending', 'approved', 'rejected', 'none')
       or (p_from is not null and p_to is not null and p_to < p_from)
       or p_offset is null or p_offset not between 0 and private.chore_limit('max_offset')
       or p_limit is null or p_limit not between 1 and private.chore_limit('history_page') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, null);
    select h.timezone into v_zone from public.homes h where h.id = p_home_id;
    if p_member is not null then
      select m.user_id into v_member_user from public.home_memberships m
        where m.home_id = p_home_id and m.id = p_member;
    end if;
    -- The search as a literal substring: LIKE's own characters escaped.
    v_pattern := case when private.chore_short_text(p_search) is not null then
      '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
        private.chore_short_text(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
    return query
      with rows as (
        select o.*, c.title as chore_title, c.category_id as chore_category,
          case
            when o.status <> 'open' then o.status
            when o.in_rework then 'rework'
            when o.due_date < v_today then 'missed'
            when o.due_date = v_today then 'due_today'
            else 'open'
          end as shown,
          (select count(*)::integer from private.chore_submissions b where b.occurrence_id = o.id)
            as attempt_count,
          (select count(*)::integer from private.chore_submissions b
            where b.occurrence_id = o.id and b.status = 'rejected') as rejected_count
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
          and (p_chore_id is null or o.chore_id = p_chore_id)
          and (p_member is null or (v_member_user is not null and (
            o.contributor_id = v_member_user
            or exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id and a.user_id = v_member_user))))
          and (v_pattern is null
            or coalesce(o.closed_title, c.title) ilike v_pattern
            or o.note ilike v_pattern or o.skip_reason ilike v_pattern)
          and case p_basis
            when 'completed' then o.status = 'completed'
              and (p_from is null or (o.completed_at at time zone v_zone)::date >= p_from)
              and (p_to is null or (o.completed_at at time zone v_zone)::date <= p_to)
            else (p_from is null or o.scheduled_date >= p_from)
              and (p_to is null or o.scheduled_date <= p_to)
            end
      )
      select r.id, r.chore_id, r.scheduled_date, r.due_date, r.shown,
        coalesce(r.closed_title, r.chore_title),
        case when r.status in ('open', 'pending_approval') then g.name else r.closed_category end,
        case when r.status in ('open', 'pending_approval') then g.color end,
        coalesce((select array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
          from private.chore_occurrence_assignees a where a.occurrence_id = r.id), '{}'::uuid[]),
        r.completed_at, coalesce(r.completed_by = v_user_id, false),
        private.member_ref(r.home_id, r.completed_by),
        coalesce(r.contributor_id = v_user_id, false), private.member_ref(r.home_id, r.contributor_id),
        r.note, r.skipped_at, coalesce(r.skipped_by = v_user_id, false),
        private.member_ref(r.home_id, r.skipped_by), r.skip_reason,
        r.approved_at, coalesce(r.approved_by = v_user_id, false),
        private.member_ref(r.home_id, r.approved_by),
        r.attempt_count, r.rejected_count,
        (count(*) over ())::integer
      from rows r
      left join private.chore_categories g on g.id = r.chore_category
      where (p_state = 'all' or r.shown = p_state)
        and case p_approval
          when 'pending' then r.status = 'pending_approval'
          when 'approved' then r.approved_at is not null
          when 'rejected' then r.rejected_count > 0
          when 'none' then r.attempt_count = 0
          else true end
      order by case when p_basis = 'completed' then r.completed_at end desc nulls last,
        r.scheduled_date desc, r.id
      limit p_limit offset p_offset;
  end
  $$;

-- Bulk occurrence actions --------------------------------------------------------------------------------

-- Applies one action to selected occurrences of one Home (chore managers; spec "Confirmed limited
-- bulk chore occurrence management"): 'reassign' to one current member (p_member, a membership id),
-- 'skip' with an optional reason, or 'due_date' (p_due_date). p_items: [{id, revision}], 1-100
-- distinct occurrences, each with the revision the manager saw. Every occurrence goes through the
-- same function as a single change (update_chore_occurrence: it becomes individually changed, so
-- the series and the rotation never change; skip_chore_occurrence), under its own chore's lock, so
-- one that is missing, of another Home, stale, completed, skipped or pending approval is reported
-- with its reason and the others still apply. p_dry_run: the per-occurrence preview, changing
-- nothing. Audited once with the number applied (each change is also audited as a single one). A retry is harmless: an applied change has a new revision and reports 'conflict' (or the
-- state it reached). Returns one row per item, in the order given: outcome ('preview', 'saved',
-- 'skipped', or 'not_found', 'conflict', 'occurrence_closed', 'pending_approval', 'invalid_assignee',
-- 'failed'), title, due date and assignees before and after, and the revision now.
create function public.bulk_chore_occurrences(
  p_home_id uuid, p_action text, p_items jsonb, p_dry_run boolean,
  p_member uuid default null, p_due_date date default null, p_reason text default null
) returns table (
  occurrence_id uuid, outcome text, title text, due_before date, due_after date,
  assignees_before uuid[], assignees_after uuid[], revision integer
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_item record;
    v_occurrence private.chore_occurrences;
    v_title text;
    v_before uuid[];
    v_after uuid[];
    v_outcome text;
    v_revision integer;
    v_due date;
    v_applied integer := 0;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_action is null or p_action not in ('reassign', 'skip', 'due_date') or p_dry_run is null
       or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
       or pg_catalog.jsonb_array_length(p_items) not between 1 and 100
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_items) e (i)
         where pg_catalog.jsonb_typeof(e.i -> 'id') <> 'string'
           or (e.i ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or pg_catalog.jsonb_typeof(e.i -> 'revision') <> 'number'
           or (e.i ->> 'revision') !~ '^[1-9][0-9]{0,8}$')
       or (select count(distinct e.i ->> 'id') from pg_catalog.jsonb_array_elements(p_items) e (i))
         <> pg_catalog.jsonb_array_length(p_items)
       or (p_action = 'reassign') <> (p_member is not null)
       or (p_action = 'due_date') <> (p_due_date is not null)
       or (p_action <> 'skip' and p_reason is not null)
       or (p_due_date is not null and p_due_date not between date '2000-01-01' and date '2199-12-31')
       or (private.chore_short_text(p_reason) is not null
         and not private.is_plain_text(private.chore_short_text(p_reason), private.chore_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select (e.i ->> 'id')::uuid, 'not_permitted', null::text, null::date, null::date,
          null::uuid[], null::uuid[], null::integer
        from pg_catalog.jsonb_array_elements(p_items) with ordinality e (i, o) order by e.o;
      return;
    end if;

    for v_item in
      select (e.i ->> 'id')::uuid as id, (e.i ->> 'revision')::integer as expected
      from pg_catalog.jsonb_array_elements(p_items) with ordinality e (i, o) order by e.o
    loop
      v_title := null; v_before := null; v_after := null; v_due := null; v_revision := null;
      begin
        v_occurrence := private.lock_chore_occurrence(v_item.id, v_user_id);
        if v_occurrence.id is null or v_occurrence.home_id <> p_home_id then
          v_outcome := 'not_found';
        else
          select c.title into v_title from private.chores c where c.id = v_occurrence.chore_id;
          select coalesce(array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id),
              '{}'::uuid[]) into v_before
            from private.chore_occurrence_assignees a where a.occurrence_id = v_occurrence.id;
          v_due := v_occurrence.due_date;
          if p_action = 'skip' then
            if v_occurrence.revision <> v_item.expected then
              v_outcome := 'conflict';
            elsif v_occurrence.status = 'pending_approval' then
              v_outcome := 'pending_approval';
            elsif v_occurrence.status <> 'open' then
              v_outcome := 'occurrence_closed';
            elsif p_dry_run then
              v_outcome := 'preview';
            else
              select s.outcome into v_outcome
                from public.skip_chore_occurrence(v_occurrence.id, p_reason) s;
            end if;
          elsif v_occurrence.status = 'pending_approval' and v_occurrence.revision = v_item.expected then
            v_outcome := 'pending_approval';
          else
            select u.outcome into v_outcome
              from public.update_chore_occurrence(v_occurrence.id, v_item.expected, p_dry_run,
                p_due_date => case when p_action = 'due_date' then p_due_date end,
                p_assignee_ids => case when p_action = 'reassign' then array[p_member] end) u;
          end if;
        end if;
      exception when others then
        -- One occurrence's failure never undoes the others (it is reported).
        v_outcome := 'failed';
      end;
      if v_outcome in ('preview', 'saved', 'skipped') then
        v_after := case when p_action = 'reassign' then array[p_member] else v_before end;
      end if;
      if v_outcome in ('saved', 'skipped') then
        v_applied := v_applied + 1;
      end if;
      select o.revision into v_revision from private.chore_occurrences o where o.id = v_item.id
        and o.home_id = p_home_id;
      return query select v_item.id, v_outcome, v_title, v_due,
        case when v_outcome in ('preview', 'saved') and p_action = 'due_date' then p_due_date
          when v_outcome in ('preview', 'saved', 'skipped') then v_due end,
        v_before, v_after, v_revision;
    end loop;
    if v_applied > 0 then
      perform private.audit_chore('chore_occurrence.bulk', p_home_id, 'home', p_home_id,
        pg_catalog.jsonb_build_object('action', p_action, 'count', v_applied,
          'requested', pg_catalog.jsonb_array_length(p_items)));
    end if;
  end
  $$;

-- The chore widgets ----------------------------------------------------------------------------------------

-- What a My Chores or All Home Chores widget shows (spec "Confirmed configurable chore dashboard
-- widgets"), for one Home: p_view 'mine' (assigned to the viewer) or 'all' (p_member narrows it to
-- one member, a membership id; 'unassigned' with p_unassigned). p_state: 'outstanding' (open,
-- overdue, needs rework and pending approval), 'overdue', 'pending_approval', 'rework', 'completed'
-- (completed in the date range, newest first). p_from/p_to: due dates (completion dates in the
-- Home's timezone for 'completed'); null is open-ended. Outstanding rows come earliest due first.
-- 42501 for a Home the caller is not in.
create function public.list_chore_widget(
  p_home_id uuid, p_view text, p_state text, p_from date default null, p_to date default null,
  p_member uuid default null, p_unassigned boolean default false, p_limit integer default 10
) returns table (
  id uuid, chore_id uuid, title text, category_name text, category_color text, due_date date,
  status text, overdue boolean, in_rework boolean, requires_approval boolean,
  assignee_member_ids uuid[], assigned_to_me boolean, mandatory_open integer,
  completed_at timestamptz, contributor_me boolean, contributor_member uuid,
  revision integer, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_zone text;
    v_member_user uuid;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_view is null or p_view not in ('mine', 'all')
       or p_state is null or p_state not in ('outstanding', 'overdue', 'pending_approval', 'rework', 'completed')
       or (p_from is not null and p_to is not null and p_to < p_from)
       or p_unassigned is null or (p_unassigned and (p_member is not null or p_view = 'mine'))
       or (p_member is not null and p_view = 'mine')
       or p_limit is null or p_limit not between 1 and 20 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, null);
    select h.timezone into v_zone from public.homes h where h.id = p_home_id;
    v_member_user := case when p_view = 'mine' then v_user_id end;
    if p_member is not null then
      select m.user_id into v_member_user from public.home_memberships m
        where m.home_id = p_home_id and m.id = p_member;
    end if;
    return query
      with matching as (
        select o.*, c.title as chore_title, c.category_id as chore_category,
          c.requires_approval as chore_approval
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
          and case p_state
            when 'outstanding' then o.status in ('open', 'pending_approval')
              and (o.due_date <= v_today + private.chore_limit('horizon') or o.status = 'pending_approval')
            when 'overdue' then o.status = 'open' and o.due_date < v_today
            when 'pending_approval' then o.status = 'pending_approval'
            when 'rework' then o.status = 'open' and o.in_rework
            else o.status = 'completed' end
          and case when p_state = 'completed' then
              (p_from is null or (o.completed_at at time zone v_zone)::date >= p_from)
              and (p_to is null or (o.completed_at at time zone v_zone)::date <= p_to)
            else (p_from is null or o.due_date >= p_from) and (p_to is null or o.due_date <= p_to) end
          and case
            when p_unassigned then not exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id)
            when p_view = 'mine' or p_member is not null then v_member_user is not null and exists (
              select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id and a.user_id = v_member_user)
            else true end
      )
      select m.id, m.chore_id, m.chore_title, g.name, g.color, m.due_date, m.status,
        m.status = 'open' and m.due_date < v_today, m.in_rework, m.chore_approval,
        coalesce((select array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
          from private.chore_occurrence_assignees a where a.occurrence_id = m.id), '{}'::uuid[]),
        exists (select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = m.id and a.user_id = v_user_id),
        (select count(*)::integer from private.chore_occurrence_steps s
          where s.occurrence_id = m.id and s.mandatory and s.checked_at is null),
        m.completed_at, coalesce(m.contributor_id = v_user_id, false),
        private.member_ref(m.home_id, m.contributor_id),
        m.revision, (count(*) over ())::integer
      from matching m
      left join private.chore_categories g on g.id = m.chore_category
      order by case when p_state = 'completed' then m.completed_at end desc nulls last,
        m.due_date, m.chore_title, m.id
      limit p_limit;
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'list_chore_templates', 'create_chore_template', 'update_chore_template',
      'list_home_chore_history', 'bulk_chore_occurrences', 'list_chore_widget'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'chore_template%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
