-- Review backlog Part 9: the open LOW and MEDIUM findings that need SQL and were left by Parts 5 to 8
-- (plans/steps/fix-review-backlog-brief.md, "Still open after Parts 5 to 8", group "Needs SQL").
-- Three functions change their result or arguments and are dropped and created again with the same
-- privileges: list_chore_widget and list_chore_approvals (a new estimated_minutes column, S20-M4) and
-- update_habit_pause (a new first argument, the habit id, S28-L2). Every other function keeps its
-- signature and is replaced in place (privileges are kept); one helper is added
-- (private.absence_undecided_count). No table, column or data changes.
-- Forward-only. Rollback: re-apply the previous bodies from the migrations named at each function, drop
-- and re-create the three changed signatures as they were (with their grants), and drop the helper.

-- Chores ---------------------------------------------------------------------------------------------------

-- S20-M4: the estimate is shown in My Chores, All Home Chores and Pending Approvals (spec L1789), so the
-- widget and approval queue functions return the occurrence's estimated_minutes. A new return column needs
-- drop and create (create or replace cannot change the result type); the bodies are otherwise those of
-- 20261214090000_review_low_db.sql (list_chore_widget) and 20261030090000_chores.sql
-- (list_chore_approvals), and the privileges are granted again as before.
drop function public.list_chore_widget(uuid, text, text, date, date, uuid, boolean, integer);
create function public.list_chore_widget(
  p_home_id uuid, p_view text, p_state text, p_from date default null, p_to date default null,
  p_member uuid default null, p_unassigned boolean default false, p_limit integer default 10
)
returns table (
  id uuid, chore_id uuid, title text, category_name text, category_color text, due_date date, status text,
  overdue boolean, in_rework boolean, requires_approval boolean, assignee_member_ids uuid[],
  assigned_to_me boolean, mandatory_open integer, completed_at timestamptz, contributor_me boolean,
  contributor_member uuid, revision integer, estimated_minutes integer, total_count integer
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
            when 'overdue' then o.status = 'open' and o.due_date < v_today and not o.vacation_review
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
        m.status = 'open' and m.due_date < v_today and not m.vacation_review, m.in_rework, m.chore_approval,
        coalesce((select array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
          from private.chore_occurrence_assignees a where a.occurrence_id = m.id), '{}'::uuid[]),
        exists (select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = m.id and a.user_id = v_user_id),
        (select count(*)::integer from private.chore_occurrence_steps s
          where s.occurrence_id = m.id and s.mandatory and s.checked_at is null),
        m.completed_at, coalesce(m.contributor_id = v_user_id, false),
        private.member_ref(m.home_id, m.contributor_id),
        m.revision, m.estimated_minutes, (count(*) over ())::integer
      from matching m
      left join private.chore_categories g on g.id = m.chore_category
      order by case when p_state = 'completed' then m.completed_at end desc nulls last,
        m.due_date, m.chore_title, m.id
      limit p_limit;
  end
  $$;

drop function public.list_chore_approvals(uuid, integer);
create function public.list_chore_approvals(p_home_id uuid, p_limit integer default 100)
returns table (
  occurrence_id uuid, chore_id uuid, title text, category_name text, category_color text,
  scheduled_date date, due_date date, late boolean, assignee_member_ids uuid[], submission_id uuid,
  attempt integer, submitted_at timestamptz, submitted_by_me boolean, submitted_by_member uuid,
  contributor_me boolean, contributor_member uuid, contributor_current boolean, note text,
  steps_done integer, steps_total integer, revision integer, estimated_minutes integer, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_zone text;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_limit is null or p_limit not between 1 and private.chore_limit('approvals_page') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_review_chores(p_home_id, v_user_id) then
      return;
    end if;
    select h.timezone into v_zone from public.homes h where h.id = p_home_id;
    return query
      select o.id, c.id, c.title, g.name, g.color, o.scheduled_date, o.due_date,
        -- Reported after the due day, in the Home's timezone.
        (b.submitted_at at time zone coalesce(v_zone, 'UTC'))::date > o.due_date,
        coalesce((select array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
          from private.chore_occurrence_assignees a where a.occurrence_id = o.id), '{}'::uuid[]),
        b.id, b.attempt, b.submitted_at, coalesce(b.submitted_by = v_user_id, false),
        private.member_ref(o.home_id, b.submitted_by), coalesce(b.contributor_id = v_user_id, false),
        private.member_ref(o.home_id, b.contributor_id),
        b.contributor_id is not null and private.is_home_member(o.home_id, b.contributor_id),
        b.note,
        (select count(*)::integer from pg_catalog.jsonb_array_elements(b.steps) x
          where (x ->> 'checked')::boolean),
        pg_catalog.jsonb_array_length(b.steps),
        o.revision, o.estimated_minutes, (count(*) over ())::integer
      from private.chore_occurrences o
      join private.chores c on c.id = o.chore_id
      join private.chore_submissions b on b.occurrence_id = o.id and b.status = 'pending'
      left join private.chore_categories g on g.id = c.category_id
      where o.home_id = p_home_id and o.status = 'pending_approval' and o.deleted_at is null
        and c.deleted_at is null
      order by b.seq
      limit p_limit;
  end
  $$;

revoke all on function public.list_chore_widget(uuid, text, text, date, date, uuid, boolean, integer)
  from public, anon;
grant execute on function public.list_chore_widget(uuid, text, text, date, date, uuid, boolean, integer)
  to authenticated, service_role;
revoke all on function public.list_chore_approvals(uuid, integer) from public, anon;
grant execute on function public.list_chore_approvals(uuid, integer) to authenticated, service_role;

-- S22-L4: how many items of an absence's review still wait for a decision. The same rows as
-- private.absence_review_items (the same reasons, order and limit), counted without building their JSON:
-- no decision recorded for this absence, and not protected (pending approval or in rework).
create function private.absence_undecided_count(p_absence private.chore_absences) returns integer
  language sql stable security definer set search_path = '' as $$
  with listed as (
    select o.id, o.due_date, c.title, o.status, o.in_rework,
      case
        when o.due_date between p_absence.starts_on and p_absence.ends_on then 'away'
        when o.status = 'open' and o.due_date < p_absence.starts_on
          and o.due_date < private.task_today(p_absence.home_id, null) then 'overdue_before'
      end as reason
    from private.chore_occurrences o join private.chores c on c.id = o.chore_id
    where o.home_id = p_absence.home_id and o.deleted_at is null and c.deleted_at is null
      and o.status in ('open', 'pending_approval')
      and exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = o.id and a.user_id = p_absence.user_id)
  )
  select count(*)::integer
  from (select * from listed where reason is not null order by due_date, title, id
    limit private.vacation_limit('review')) l
  where l.status <> 'pending_approval' and not l.in_rework
    and not exists (select 1 from private.chore_vacation_decisions d
      where d.occurrence_id = l.id and d.source_kind = 'absence' and d.source_id = p_absence.id);
  $$;

revoke all on function private.absence_undecided_count(private.chore_absences) from public, anon, authenticated;

-- S22-L4 (first part): as 20261104090000_home_vacations.sql, except that the undecided count per absence
-- comes from private.absence_undecided_count (a plain count) instead of building every review entry's JSON.
create or replace function public.list_chore_absences(p_home_id uuid)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_manage boolean;
    v_today date;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_manage := private.can_manage_chores(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    return pg_catalog.jsonb_build_object(
      'today', v_today,
      'canManage', v_manage,
      'absences', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', b.id, 'member', private.chore_person(p_home_id, b.user_id, v_user_id),
          'startsOn', b.starts_on, 'endsOn', b.ends_on, 'reason', b.reason,
          'status', case when v_today < b.starts_on then 'upcoming' when v_today <= b.ends_on then 'active'
            else 'ended' end,
          'revision', b.revision,
          'undecided', private.absence_undecided_count(b))
          order by b.ends_on < v_today, b.starts_on, b.id)
        from (select * from private.chore_absences x
          where x.home_id = p_home_id and (x.user_id = v_user_id or v_manage)
          order by x.ends_on < v_today, x.starts_on desc
          limit private.vacation_limit('absences')) b), '[]'::jsonb));
  end
  $$;

-- Tasks ----------------------------------------------------------------------------------------------------

-- S19b-L6: as 20261028090000_task_reminders_templates_bulk.sql, except that a dry run reads the tasks
-- without FOR UPDATE.
create or replace function public.bulk_update_tasks(
  p_task_ids uuid[], p_action text, p_expected_revisions jsonb, p_dry_run boolean,
  p_home_id uuid default null, p_priority text default null, p_label_mode text default null,
  p_label_ids uuid[] default null, p_list_id uuid default null
)
returns table (
  task_id uuid, outcome text, revision integer, open_subtasks integer, recurring boolean, shared boolean
)
  language plpgsql security definer set search_path = '' as $$
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
        -- A preview changes nothing, so it does not hold row locks (S19b-L6).
        if p_dry_run then
          select * into v_task from private.tasks t where t.id = v_id;
        else
          select * into v_task from private.tasks t where t.id = v_id for update;
        end if;
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

-- Habits ---------------------------------------------------------------------------------------------------

-- S28-L2: the pause route names its habit, and a pause of another habit must not be changed through it.
-- update_habit_pause takes the habit id first (a new signature: drop and create); the body is otherwise
-- that of 20261110090000_habits.sql. Privileges as before.
drop function public.update_habit_pause(uuid, integer, text, date, boolean);
create function public.update_habit_pause(
  p_habit_id uuid, p_pause_id uuid, p_expected_revision integer, p_action text,
  p_resumes_on date default null, p_dry_run boolean default false
)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_pause private.habit_pauses;
    v_today date;
    v_new date;
    v_was text;
    v_now text;
    v_impact jsonb;
  begin
    if p_habit_id is null or p_pause_id is null or p_expected_revision is null or p_dry_run is null
       or p_action is null or p_action not in ('resume', 'change')
       or (p_action = 'resume' and p_resumes_on is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- A pause of another habit is not found, whatever the path named (S28-L2).
    v_habit := private.habit_lock((select hp.habit_id from private.habit_pauses hp
      where hp.id = p_pause_id and hp.habit_id = p_habit_id), v_user_id);
    if v_habit.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.habit_may(v_habit, v_user_id, 'manage') then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    select * into v_pause from private.habit_pauses hp where hp.id = p_pause_id for update;
    v_today := private.habit_today(v_habit);
    if (v_pause.resumes_on is not null and v_pause.resumes_on <= v_today)
       or v_habit.archived_at is not null then
      return query select 'not_current', null::jsonb, v_pause.revision;
      return;
    end if;
    if v_pause.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_pause.revision;
      return;
    end if;
    v_new := case when p_action = 'resume' then greatest(v_today, v_pause.starts_on) else p_resumes_on end;
    if p_action = 'change' and p_resumes_on is not null and p_resumes_on <= v_today then
      return query select 'invalid_dates', null::jsonb, v_pause.revision;
      return;
    end if;
    v_impact := pg_catalog.jsonb_build_object('startsOn', v_pause.starts_on, 'resumesOn', v_new,
      'previousResumesOn', v_pause.resumes_on,
      'vacationToday', coalesce((select v.days @> v_today from private.habit_vacation_days v
        where v.habit_id = v_habit.id), false));
    if v_new is not distinct from v_pause.resumes_on then
      return query select 'unchanged', v_impact, v_pause.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_impact, v_pause.revision;
      return;
    end if;
    v_was := private.habit_paused_on(v_habit, v_today);
    update private.habit_pauses hp set resumes_on = v_new, revision = hp.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where hp.id = v_pause.id returning * into v_pause;
    update private.habits h set revision = h.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where h.id = v_habit.id returning * into v_habit;
    v_now := private.habit_paused_on(v_habit, v_today);
    perform private.habit_event(v_habit.id, case when p_action = 'resume' then 'resumed' else 'pause_changed' end,
      v_user_id, v_today, null, pg_catalog.jsonb_build_object('resumesOn', v_new));
    perform private.audit_habit(case when p_action = 'resume' then 'habit.resumed' else 'habit.pause_changed' end,
      v_habit, pg_catalog.jsonb_build_object('resumesOn', v_new));
    if v_was is not null and v_now is null then
      perform private.habit_notify_pause(v_habit, 'habit.resumed', v_user_id,
        'habit-resumed:' || v_pause.id::text || ':' || v_pause.revision::text, null, false);
    end if;
    perform private.schedule_habit_pause_end(v_habit, v_pause);
    return query select 'saved', v_impact, v_pause.revision;
  end
  $$;

revoke all on function public.update_habit_pause(uuid, uuid, integer, text, date, boolean) from public, anon;
grant execute on function public.update_habit_pause(uuid, uuid, integer, text, date, boolean)
  to authenticated, service_role;

-- Goals ----------------------------------------------------------------------------------------------------

-- S30c-L3: as 20261115090000_habit_goal_links.sql, except that a link to an archived one-off goal answers
-- 'archived', as create_goal_link does, instead of a preview of nothing.
create or replace function public.change_goal_link_start(
  p_id uuid, p_start text, p_start_date date default null, p_dry_run boolean default false,
  p_expected_revision integer default null, p_expected_amount numeric default null
)
returns jsonb
  language plpgsql security definer set search_path = '' as $$
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
    v_token integer;
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
    -- An archived one-off goal is not synced, so a preview would show nothing linked (S30c-L3).
    if v_goal.id is not null and v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
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
    v_token := private.goal_link_token(v_link.revision, v_impact);
    if v_starts = v_link.starts_on then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_token, 'impact', v_impact);
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_token, 'impact', v_impact);
    end if;
    if p_expected_revision <> v_token or p_expected_amount <> (v_impact ->> 'amountAfter')::numeric then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_token, 'impact', v_impact);
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

-- S30b-L2: as 20261114090000_recurring_goals.sql, except that each series rolls in its own sub-block.
create or replace function public.roll_goal_periods(p_limit integer default null)
returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_created integer := 0;
  begin
    for v_id in select s.id from private.goal_series s
        where s.next_roll_at <= pg_catalog.now() and s.deleted_at is null
        order by s.next_roll_at, s.id
        limit least(coalesce(p_limit, private.goal_limit('roll_batch')), private.goal_limit('roll_batch'))
        for update skip locked loop
      -- One series that fails is logged and skipped; the others still roll (S30b-L2). It stays due, so
      -- the next run (or a read of the series) tries it again.
      begin
        v_created := v_created + private.roll_goal_series(v_id, pg_catalog.now());
      exception when others then
        raise warning 'roll_goal_periods: series % failed (%)', v_id, sqlstate;
      end;
    end loop;
    return v_created;
  end
  $$;

-- S30b-L4: as 20261114090000_recurring_goals.sql, except that ended series periods are filtered out before
-- goal_status and goal_hidden run, so the list cost no longer grows with each series' history.
create or replace function public.get_goals(
  p_home_id uuid default null, p_view text default 'active'::text, p_query text default null
)
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
      -- Ended periods of a series are in no view (S30b-L4): skip them before the per-row status. A
      -- period that ended before yesterday in UTC has ended in every timezone.
      where (x.series_id is null or x.archived_at is not null
          or (x.achieved_at is null and x.period_end >= (pg_catalog.now() at time zone 'UTC')::date - 1))
        and not private.goal_hidden(x)
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

-- Recipes and shopping -------------------------------------------------------------------------------------

-- S24-L4: as 20261107090000_recipe_sharing_import.sql, except that only Top rated (which orders by rating)
-- rates every candidate; the other modes pick their page first and rate only the recipes shown.
create or replace function public.recipe_widget(
  p_home_id uuid default null, p_mode text default null, p_limit integer default null, p_seed text default null
)
returns table (id uuid, name text, cover_file_id uuid, rating_average numeric, rating_count integer, available integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_recipe_context(p_home_id, v_user_id);
    if p_mode is null or p_mode not in ('favorites', 'recent', 'top_rated', 'random')
       or p_limit is null or p_limit not between 1 and private.recipe_limit('widget')
       or pg_catalog.char_length(coalesce(p_seed, '')) > 64 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return query
      with base as (
        select r.id, r.name, r.name_key, r.cover_file_id, r.published_at, r.owner_user_id,
          (select f.created_at from private.recipe_favorites f where f.user_id = v_user_id
            and f.recipe_id = r.id and f.context_home_id is not distinct from p_home_id) as favorited_at
        from private.recipes r
        where ((p_home_id is null and r.owner_user_id = v_user_id) or r.owner_home_id = p_home_id
            or r.id = any (array(select s.recipe_id from private.recipe_shares s
              where s.home_id = p_home_id and s.suspended_at is null)))
          and r.status = 'published' and r.deleted_at is null
      ), candidates as (
        select b.*, g.average, g.rating_count
        from base b
        cross join lateral private.recipe_rating(b.id,
          case when p_home_id is null then b.owner_user_id end, p_home_id) g
        where p_mode = 'top_rated' and g.rating_count > 0
        union all
        select b.*, null::numeric, null::integer
        from base b
        where p_mode <> 'top_rated' and (p_mode <> 'favorites' or b.favorited_at is not null)
      ), page as (
        select c.*, (count(*) over ())::integer as total
        from candidates c
        order by
          case when p_mode = 'favorites' then c.favorited_at end desc,
          case when p_mode = 'recent' then c.published_at end desc,
          case when p_mode = 'top_rated' then c.average end desc,
          case when p_mode = 'top_rated' then c.rating_count end desc,
          case when p_mode = 'random' then pg_catalog.md5(c.id::text || coalesce(p_seed, '')) end,
          c.name_key, c.id
        limit p_limit
      )
      select p.id, p.name, p.cover_file_id, g.average, g.rating_count, p.total
      from page p
      cross join lateral private.recipe_rating(p.id,
        case when p_home_id is null then p.owner_user_id end, p_home_id) g
      order by
        case when p_mode = 'favorites' then p.favorited_at end desc,
        case when p_mode = 'recent' then p.published_at end desc,
        case when p_mode = 'top_rated' then p.average end desc,
        case when p_mode = 'top_rated' then p.rating_count end desc,
        case when p_mode = 'random' then pg_catalog.md5(p.id::text || coalesce(p_seed, '')) end,
        p.name_key, p.id;
  end
  $$;

-- S26-L8 (first part): as 20261108090000_shopping_lists.sql, except that a Personal rule's zone is no longer
-- looked up in pg_timezone_names (which reads the whole timezone database on every call). The zones
-- passed in were checked against that list when they were stored or sent; a zone PostgreSQL no longer
-- knows still falls back to UTC.
create or replace function private.shopping_today(p_home_id uuid, p_time_zone text) returns date
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_zone text;
  begin
    select h.timezone into v_zone from public.homes h where h.id = p_home_id;
    if v_zone is null and p_time_zone is not null and pg_catalog.char_length(p_time_zone) <= 64 then
      begin
        return (pg_catalog.now() at time zone p_time_zone)::date;
      exception when invalid_parameter_value then
        v_zone := null;
      end;
    end if;
    return (pg_catalog.now() at time zone coalesce(v_zone, 'UTC'))::date;
  end
  $$;

-- Points -----------------------------------------------------------------------------------------------------

-- S23-L8: as 20261105090000_points_rewards.sql, except that only a member's call locks the Home and the
-- reward (the membership check after the lock stays).
create or replace function public.redeem_reward(
  p_id uuid, p_reward_id uuid, p_expected_cost integer, p_dry_run boolean default false
)
returns table (outcome text, detail jsonb)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reward private.rewards;
    v_existing private.reward_redemptions;
    v_account private.point_accounts;
    v_today date;
    v_block text;
    v_detail jsonb;
    v_redemption private.reward_redemptions;
    v_reviewer uuid;
  begin
    if p_id is null or p_reward_id is null or p_expected_cost is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_points_home((select r.home_id from private.rewards r
      where r.id = p_reward_id and private.is_home_member(r.home_id, v_user_id)));
    select * into v_reward from private.rewards r
      where r.id = p_reward_id and private.is_home_member(r.home_id, v_user_id) for update;
    if not found or not private.is_home_member(v_reward.home_id, v_user_id) then
      return query select 'not_found', null::jsonb;
      return;
    end if;
    select * into v_existing from private.reward_redemptions r where r.id = p_id;
    if found then
      if v_existing.requested_by is distinct from v_user_id or v_existing.reward_id <> p_reward_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', pg_catalog.jsonb_build_object('id', v_existing.id, 'status', v_existing.status);
      return;
    end if;
    v_account := private.lock_point_account(v_reward.home_id, v_user_id);
    v_today := private.task_today(v_reward.home_id, null);
    v_block := private.reward_block(v_reward, v_account.id, v_today);
    if v_block is not null then
      return query select v_block, case when v_block = 'member_limit' then pg_catalog.jsonb_build_object(
        'nextEligibleOn', private.reward_period_next(v_reward.home_id, v_reward.member_period, v_today)) end;
      return;
    end if;
    v_detail := pg_catalog.jsonb_build_object('cost', v_reward.cost, 'requiresApproval', v_reward.requires_approval,
      'available', v_account.balance - v_account.reserved,
      'availableAfter', v_account.balance - v_account.reserved - v_reward.cost,
      'reviewerAvailable', not v_reward.requires_approval
        or private.reward_reviewer_available(v_reward.home_id, v_user_id));
    if v_reward.cost <> p_expected_cost then
      return query select 'cost_changed', v_detail;
      return;
    end if;
    if v_account.balance - v_account.reserved < v_reward.cost then
      return query select 'insufficient_points', v_detail;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_detail;
      return;
    end if;
    insert into private.reward_redemptions (
      id, home_id, reward_id, account_id, requested_by, cost, reward_name, status, redeemed_at,
      fulfillment, decided_at
    ) values (
      p_id, v_reward.home_id, v_reward.id, v_account.id, v_user_id, v_reward.cost, v_reward.name,
      case when v_reward.requires_approval then 'pending' else 'redeemed' end,
      case when v_reward.requires_approval then null else pg_catalog.now() end,
      case when v_reward.requires_approval then null else 'pending' end,
      case when v_reward.requires_approval then null else pg_catalog.now() end
    ) returning * into v_redemption;
    perform private.redemption_event(v_redemption.id, 'requested', v_user_id, null);
    if v_reward.requires_approval then
      perform private.change_reserved(v_account.id, v_reward.cost);
      for v_reviewer in
        select m.user_id from public.home_memberships m
        where m.home_id = v_reward.home_id and m.user_id <> v_user_id
          and private.can_approve_rewards(v_reward.home_id, m.user_id)
        order by m.user_id
      loop
        perform private.notify_user(v_reviewer, v_reward.home_id, 'rewards', 'reward.requested',
          pg_catalog.jsonb_build_object('homeId', v_reward.home_id, 'redemptionId', v_redemption.id),
          'reward.requested:' || v_redemption.id::text, true);
      end loop;
    else
      perform private.post_point_entry(v_account.id, 'redemption', -v_reward.cost, null, null,
        v_redemption.id, null, null, v_user_id, null);
      perform private.redemption_event(v_redemption.id, 'redeemed', v_user_id, null);
    end if;
    perform private.audit(case when v_reward.requires_approval then 'rewards.requested' else 'rewards.redeemed' end,
      v_reward.home_id, 'reward_redemption', v_redemption.id,
      pg_catalog.jsonb_build_object('reward', v_reward.id, 'cost', v_reward.cost));
    return query select case when v_reward.requires_approval then 'requested' else 'redeemed' end,
      v_detail || pg_catalog.jsonb_build_object('id', v_redemption.id);
  end
  $$;

-- S23-L8: as 20261105090000_points_rewards.sql, except that only a member's call locks the Home and the
-- reward (the membership check after the lock stays).
create or replace function public.update_reward(
  p_reward_id uuid, p_expected_revision integer, p_name text, p_cost integer,
  p_description text default null, p_requires_approval boolean default false,
  p_enabled boolean default true, p_available_from date default null, p_available_until date default null,
  p_total_limit integer default null, p_member_limit integer default null,
  p_member_period text default null, p_dry_run boolean default false
)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_description text := nullif(pg_catalog.btrim(p_description, E' \t\r\n'), '');
    v_reward private.rewards;
    v_impact jsonb;
    v_used integer;
  begin
    if p_reward_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.check_reward_fields(p_name, v_description, p_cost, p_requires_approval, p_enabled,
      p_available_from, p_available_until, p_total_limit, p_member_limit, p_member_period);
    perform private.lock_points_home((select r.home_id from private.rewards r
      where r.id = p_reward_id and private.is_home_member(r.home_id, v_user_id)));
    select * into v_reward from private.rewards r
      where r.id = p_reward_id and private.is_home_member(r.home_id, v_user_id) for update;
    if not found or not private.is_home_member(v_reward.home_id, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_reward.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_reward.archived_at is not null then
      return query select 'archived', null::jsonb, v_reward.revision;
      return;
    end if;
    if v_reward.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_reward.revision;
      return;
    end if;
    v_used := private.reward_total_used(v_reward.id);
    v_impact := pg_catalog.jsonb_build_object(
      'pending', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'pending'),
      'redeemed', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'redeemed'),
      'costChanged', p_cost <> v_reward.cost,
      'totalReached', p_total_limit is not null and v_used >= p_total_limit,
      'approvalChanged', p_requires_approval <> v_reward.requires_approval);
    if p_dry_run then
      return query select 'preview', v_impact, v_reward.revision;
      return;
    end if;
    update private.rewards r
      set name = p_name, description = v_description, cost = p_cost,
        requires_approval = p_requires_approval, enabled = p_enabled, available_from = p_available_from,
        available_until = p_available_until, total_limit = p_total_limit, member_limit = p_member_limit,
        member_period = p_member_period, revision = r.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where r.id = v_reward.id
      returning * into v_reward;
    perform private.audit('rewards.updated', v_reward.home_id, 'reward', v_reward.id,
      pg_catalog.jsonb_build_object('cost', v_reward.cost, 'enabled', v_reward.enabled,
        'approval', v_reward.requires_approval));
    return query select 'saved', v_impact, v_reward.revision;
  end
  $$;

-- S23-L8: as 20261105090000_points_rewards.sql, except that only a member's call locks the Home and the
-- reward (the membership check after the lock stays).
create or replace function public.archive_reward(
  p_reward_id uuid, p_expected_revision integer, p_archived boolean
)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reward private.rewards;
    v_impact jsonb;
  begin
    if p_reward_id is null or p_expected_revision is null or p_archived is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_points_home((select r.home_id from private.rewards r
      where r.id = p_reward_id and private.is_home_member(r.home_id, v_user_id)));
    select * into v_reward from private.rewards r
      where r.id = p_reward_id and private.is_home_member(r.home_id, v_user_id) for update;
    if not found or not private.is_home_member(v_reward.home_id, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_rewards(v_reward.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_reward.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_reward.revision;
      return;
    end if;
    if (v_reward.archived_at is not null) = p_archived then
      return query select 'unchanged', null::jsonb, v_reward.revision;
      return;
    end if;
    if not p_archived then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('rewards:' || v_reward.home_id::text, 0));
      if (select count(*) from private.rewards r where r.home_id = v_reward.home_id and r.archived_at is null)
         >= private.points_limit('rewards') then
        return query select 'limit_reached', null::jsonb, v_reward.revision;
        return;
      end if;
    end if;
    v_impact := pg_catalog.jsonb_build_object(
      'pending', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'pending'),
      'outstanding', (select count(*)::integer from private.reward_redemptions r
        where r.reward_id = v_reward.id and r.status = 'redeemed' and r.fulfillment <> 'fulfilled'
          and (r.resolution is null or r.replacement_status in ('pending', 'unable'))));
    update private.rewards r
      set archived_at = case when p_archived then pg_catalog.now() end,
        archived_by = case when p_archived then v_user_id end,
        revision = r.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where r.id = v_reward.id
      returning * into v_reward;
    perform private.audit(case when p_archived then 'rewards.archived' else 'rewards.restored' end,
      v_reward.home_id, 'reward', v_reward.id, v_impact);
    return query select 'saved', v_impact, v_reward.revision;
  end
  $$;

-- S23-L8: as 20261105090000_points_rewards.sql, except that only a member's call takes the locks.
create or replace function private.lock_redemption(p_redemption_id uuid, p_user_id uuid)
returns private.reward_redemptions
  language plpgsql security definer set search_path = '' as $$
  declare
    v_redemption private.reward_redemptions;
  begin
    perform private.lock_points_home((select r.home_id from private.reward_redemptions r
      where r.id = p_redemption_id and private.is_home_member(r.home_id, p_user_id)));
    perform 1 from private.rewards w
      where w.id = (select r.reward_id from private.reward_redemptions r
        where r.id = p_redemption_id and private.is_home_member(r.home_id, p_user_id))
      for update;
    select * into v_redemption from private.reward_redemptions r
      where r.id = p_redemption_id and private.is_home_member(r.home_id, p_user_id) for update;
    if not found or not private.is_home_member(v_redemption.home_id, p_user_id) then
      return null;
    end if;
    return v_redemption;
  end
  $$;

-- S28b-L6 (first part): as 20261111090000_personal_points_rewards.sql, except that reusing an id for a
-- different kind or amount answers 'id_taken' instead of 'exists'.
create or replace function public.adjust_personal_points(
  p_id uuid, p_kind text, p_amount integer, p_reason text, p_dry_run boolean default false
)
returns table (outcome text, preview jsonb, entry_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.personal_reason(p_reason);
    v_account private.personal_point_accounts;
    v_preview jsonb;
    v_entry private.personal_point_entries;
  begin
    if p_id is null or p_kind is null or p_kind not in ('credit', 'correction')
       or p_amount is null or p_amount = 0 or abs(p_amount) > private.personal_points_limit('adjustment')
       or (p_kind = 'credit' and p_amount < 0) or p_dry_run is null or v_reason is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_account := private.lock_personal_account(v_user_id);
    if exists (select 1 from private.personal_point_entries e where e.user_id = v_user_id and e.id = p_id) then
      -- A retry answers 'exists' only when it asks for the same change (S28b-L6).
      if exists (select 1 from private.personal_point_entries e where e.user_id = v_user_id and e.id = p_id
                   and e.kind = p_kind and e.amount = p_amount) then
        return query select 'exists', null::jsonb, p_id;
      else
        return query select 'id_taken', null::jsonb, null::uuid;
      end if;
      return;
    end if;
    v_preview := pg_catalog.jsonb_build_object('kind', p_kind, 'amount', p_amount,
      'available', v_account.balance, 'availableAfter', v_account.balance + p_amount);
    if v_account.balance + p_amount < 0 then
      return query select 'insufficient_points', v_preview, null::uuid;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_preview, null::uuid;
      return;
    end if;
    v_entry := private.post_personal_entry(v_user_id, p_id, p_kind, p_amount, null, null, null, v_reason);
    return query select 'posted', v_preview, v_entry.id;
  end
  $$;

-- Dashboards -------------------------------------------------------------------------------------------------

-- S17-L2: as 20261025090000_dashboards.sql, except that a share is listed only while its sharer may still
-- share that kind of template in that Home (for a Home template: still edits the Home dashboard).
create or replace function public.list_dashboard_templates(p_home_id uuid default null)
returns table (
  template_id uuid, name text, kind text, layout jsonb, is_mine boolean, shared_home_ids uuid[],
  updated_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_home_id is not null and not private.is_home_member(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select t.id, t.name, t.kind, t.layout, t.owner_user_id = v_user_id,
        coalesce((
          select pg_catalog.array_agg(s.home_id order by s.home_id)
          from private.dashboard_template_shares s
          where s.template_id = t.id and private.is_home_member(s.home_id, v_user_id)
        ), '{}'),
        t.updated_at
      from private.dashboard_templates t
      where t.deleted_at is null
        and (
          (p_home_id is null and t.owner_user_id = v_user_id)
          or exists (
            select 1 from private.dashboard_template_shares s
            where s.template_id = t.id
              and (p_home_id is null or s.home_id = p_home_id)
              and private.is_home_member(s.home_id, v_user_id)
              and private.can_share_template(t.kind, s.home_id, s.shared_by)
          )
        )
      order by t.owner_user_id = v_user_id desc, t.name, t.id;
  end
  $$;

-- Homes, members and children -------------------------------------------------------------------------------

-- S12-L3 (first part): as 20261019090000_roles_and_ownership.sql, except that a transfer already marked
-- invalid answers 'no_longer_valid', not 'already_decided'.
create or replace function public.respond_to_ownership_transfer(
  p_home_id uuid, p_transfer_id uuid, p_decision text
)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_transfer private.home_ownership_transfers;
  begin
    if p_decision is null or p_decision not in ('accept', 'decline') then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    perform private.expire_ownership_transfers(p_home_id);
    select * into v_transfer from private.home_ownership_transfers t
      where t.id = p_transfer_id and t.home_id = p_home_id for update;
    if not found or v_transfer.to_user_id <> v_user_id then
      return 'not_found';
    end if;
    if v_transfer.status = 'expired' then
      return 'expired';
    end if;
    if v_transfer.status = 'invalid' then
      return 'no_longer_valid';
    end if;
    if v_transfer.status <> 'pending' then
      return 'already_decided';
    end if;

    if p_decision = 'decline' then
      update private.home_ownership_transfers
        set status = 'declined', decided_at = pg_catalog.now()
        where id = v_transfer.id;
      perform private.audit('home_ownership.transfer_declined', p_home_id, 'ownership_transfer',
        v_transfer.id);
      return 'declined';
    end if;

    if private.home_role(p_home_id, v_transfer.from_user_id) is distinct from 'owner'
       or private.confirmed_email(v_user_id) is null then
      update private.home_ownership_transfers
        set status = 'invalid', decided_at = pg_catalog.now()
        where id = v_transfer.id;
      perform private.audit('home_ownership.transfer_invalid', p_home_id, 'ownership_transfer',
        v_transfer.id);
      return 'no_longer_valid';
    end if;

    -- Marked accepted first, so the triggers that invalidate pending transfers on role changes
    -- leave this one alone. Then the swap: the former Owner steps down first (the one-Owner index
    -- is checked per statement), and the recipient becomes the Owner before the transaction ends.
    update private.home_ownership_transfers
      set status = 'accepted', decided_at = pg_catalog.now()
      where id = v_transfer.id;
    update public.home_memberships set role = 'member'
      where home_id = p_home_id and user_id = v_transfer.from_user_id;
    update public.home_memberships set role = 'owner'
      where home_id = p_home_id and user_id = v_user_id;
    perform private.audit('home_ownership.transfer_accepted', p_home_id, 'ownership_transfer',
      v_transfer.id, pg_catalog.jsonb_build_object('from', v_transfer.from_user_id));
    return 'accepted';
  end
  $$;

-- S12-L3 (second part): as 20261125090000_account_lifecycle.sql, except that replaying a request id whose
-- transfer has since ended answers how it ended instead of 'started'.
create or replace function public.start_ownership_transfer(
  p_home_id uuid, p_membership_id uuid, p_request_id uuid
)
returns table (outcome text, transfer_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_existing private.home_ownership_transfers;
    v_id uuid;
  begin
    if p_request_id is null then
      raise exception 'a request id is required' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) <> 'owner' then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;

    select * into v_existing from private.home_ownership_transfers t
      where t.from_user_id = v_user_id and t.creation_request_id = p_request_id;
    if found then
      -- A replay answers 'started' only while that transfer is still pending (S12-L3).
      if v_existing.home_id <> p_home_id then
        return query select 'not_found'::text, null::uuid;
      elsif v_existing.status = 'pending' then
        return query select 'started'::text, v_existing.id;
      elsif v_existing.status = 'expired' then
        return query select 'expired'::text, null::uuid;
      elsif v_existing.status = 'invalid' then
        return query select 'no_longer_valid'::text, null::uuid;
      else
        return query select 'already_decided'::text, null::uuid;
      end if;
      return;
    end if;

    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if v_target.user_id = v_user_id or v_target.role = 'owner'
       or private.confirmed_email(v_target.user_id) is null
       or private.is_deactivated(v_target.user_id) then
      return query select 'invalid_target'::text, null::uuid;
      return;
    end if;

    perform private.expire_ownership_transfers(p_home_id);
    if exists (
      select 1 from private.home_ownership_transfers t
      where t.home_id = p_home_id and t.status = 'pending'
    ) then
      return query select 'pending_exists'::text, null::uuid;
      return;
    end if;

    insert into private.home_ownership_transfers (
      home_id, from_user_id, to_user_id, expires_at, creation_request_id
    )
      values (
        p_home_id, v_user_id, v_target.user_id, pg_catalog.now() + interval '7 days', p_request_id
      )
      returning id into v_id;
    perform private.audit('home_ownership.transfer_started', p_home_id, 'ownership_transfer', v_id,
      pg_catalog.jsonb_build_object('to', v_target.user_id));
    return query select 'started'::text, v_id;
  end
  $$;

-- S41-L1: as 20261129090000_child_profiles.sql, except that a secondary guardian cannot add an "on"
-- override.
create or replace function public.set_child_access(
  p_home_id uuid, p_child_membership_id uuid, p_preset text, p_overrides jsonb,
  p_confirm_expansion boolean, p_expected_updated_at timestamp with time zone
)
returns table (outcome text, before_capabilities text[], after_capabilities text[])
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_caller_role text;
    v_settings public.child_home_settings;
    v_before text[];
    v_after text[];
  begin
    if p_preset is null or p_preset not in ('young_child', 'child', 'teen') then
      raise exception 'invalid preset' using errcode = '22023';
    end if;
    if p_overrides is null or not private.valid_child_overrides(p_overrides) then
      raise exception 'invalid overrides' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null then
      return query select 'not_found'::text, null::text[], null::text[];
      return;
    end if;
    v_caller_role := private.child_guardian_role(p_home_id, v_child, v_user_id);
    if v_caller_role is null then
      return query select 'not_permitted'::text, null::text[], null::text[];
      return;
    end if;

    select * into v_settings from public.child_home_settings s
      where s.home_id = p_home_id and s.child_user_id = v_child for update;
    v_before := private.child_effective_capabilities(v_settings.preset, v_settings.overrides);
    v_after := private.child_effective_capabilities(p_preset, p_overrides);

    if p_expected_updated_at is null or v_settings.updated_at <> p_expected_updated_at then
      return query select 'stale'::text, v_before, v_after;
      return;
    end if;
    -- A secondary guardian only switches things off: no new "on" override either, even one that
    -- changes nothing today but would keep a capability on after a later preset change (S41-L1).
    if v_caller_role = 'secondary'
       and (p_preset <> v_settings.preset or not (v_before @> v_after)
         or exists (select 1 from pg_catalog.jsonb_each(p_overrides) o
           where o.value = 'true'::jsonb and v_settings.overrides -> o.key is distinct from 'true'::jsonb)) then
      return query select 'not_permitted'::text, v_before, v_after;
      return;
    end if;
    if p_preset = v_settings.preset and p_overrides = v_settings.overrides then
      return query select 'unchanged'::text, v_before, v_after;
      return;
    end if;
    if not (v_before @> v_after) and not coalesce(p_confirm_expansion, false) then
      return query select 'confirmation_required'::text, v_before, v_after;
      return;
    end if;

    update public.child_home_settings s
      set preset = p_preset, overrides = p_overrides, updated_by = v_user_id,
          updated_at = pg_catalog.clock_timestamp()
      where s.home_id = p_home_id and s.child_user_id = v_child;
    perform private.audit('child.access_changed', p_home_id, 'user', v_child,
      jsonb_build_object(
        'preset_before', v_settings.preset, 'preset_after', p_preset,
        'before', to_jsonb(v_before), 'after', to_jsonb(v_after)
      ));
    return query select 'saved'::text, v_before, v_after;
  end
  $$;

-- S42P-L2: as 20261202090000_child_independent_account.sql, except that the 5-attempt limit is checked
-- first and an address already in use counts as an attempt.
create or replace function public.claim_child_transition(p_token text, p_email text)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_t private.child_transitions;
    v_email text := private.normalise_email(p_email);
    v_link text;
    v_expires timestamptz := pg_catalog.now() + interval '1 hour';
  begin
    select * into v_t from private.child_transitions t
      where t.claim_token_hash = private.token_hash(p_token) and t.status = 'started'
        and t.claim_expires_at > pg_catalog.now()
      for update;
    if v_t.id is null or not private.child_transition_holds(v_t) then
      return 'invalid';
    end if;
    if pg_catalog.length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       or v_email like '%.invalid' then
      return 'invalid_email';
    end if;
    -- The limit comes first, and an address already in use counts against it too, so a claim link
    -- cannot be used to test addresses without limit (S42P-L2).
    if v_t.email_sends >= 5 then
      return 'rate_limited';
    end if;
    if exists (select 1 from auth.users u where private.normalise_email(u.email) = v_email)
       or exists (select 1 from private.backup_emails b where b.email = v_email) then
      update private.child_transitions t set email_sends = t.email_sends + 1 where t.id = v_t.id;
      return 'email_taken';
    end if;
    v_link := private.new_invitation_token('link');
    update private.child_transitions t
      set pending_email = v_email, email_token_hash = private.token_hash(v_link),
          email_expires_at = v_expires, email_sends = t.email_sends + 1
      where t.id = v_t.id;
    perform private.queue_security_email(v_t.child_user_id, 'transition_verify', v_email, v_link,
                                         v_expires);
    perform private.audit('child.transition_email_sent', null, 'user', v_t.child_user_id, '{}'::jsonb);
    return 'sent';
  end
  $$;

-- Copies to a Home -------------------------------------------------------------------------------------------

-- S40P2-L4: as 20261128090000_category_deletion_home_copies.sql, except that the copy date is answered only
-- to someone who may see the item through its own module (the check the item pages use: a recipe draft
-- stays hidden from other members, for example), not to every member of its Home.
create or replace function public.get_copy_origin(p_item_type text, p_item_id uuid)
returns timestamptz
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_home uuid;
    v_at timestamptz;
    v_visible boolean := false;
  begin
    if p_item_type = 'recipe' then
      select r.owner_home_id, r.copied_from_personal_at, private.can_see_recipe(r, v_user_id)
        into v_home, v_at, v_visible
        from private.recipes r where r.id = p_item_id and r.deleted_at is null;
    elsif p_item_type = 'calendar_event' then
      select e.home_id, e.copied_from_personal_at, private.calendar_can_see(e, v_user_id, e.home_id)
        into v_home, v_at, v_visible
        from private.calendar_events e where e.id = p_item_id and e.deleted_at is null;
    elsif p_item_type = 'photo_album' then
      select a.owner_home_id, a.copied_from_personal_at,
          private.can_see_photo_library(a.owner_user_id, a.owner_home_id, v_user_id)
        into v_home, v_at, v_visible
        from private.photo_albums a where a.id = p_item_id and a.deleted_at is null;
    elsif p_item_type = 'photo' then
      select p.owner_home_id, p.copied_from_personal_at,
          private.can_see_photo_library(p.owner_user_id, p.owner_home_id, v_user_id)
        into v_home, v_at, v_visible
        from private.photos p where p.id = p_item_id and p.deleted_at is null;
    else
      raise exception 'invalid item type' using errcode = '22023';
    end if;
    if v_home is null or private.home_role(v_home, v_user_id) is null or not coalesce(v_visible, false) then
      return null;
    end if;
    return v_at;
  end
  $$;

-- Photos -----------------------------------------------------------------------------------------------------

-- S35-L3: as 20261121090000_photos.sql, except that an uploader who can no longer add to the Home library
-- gets 'not_permitted' (the upload is still marked failed and its objects queued).
create or replace function public.finalize_photo(p_user_id uuid, p_file_id uuid, p_variants jsonb)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
    v_pool private.storage_pools;
    v_variant jsonb;
    v_kinds text[] := '{}';
    v_total bigint := 0;
    v_master jsonb;
    v_ok boolean := true;
    v_outcome text;
    v_photo private.photos;
  begin
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = p_user_id and f.purpose = 'photo';
    if not found then
      return 'not_found';
    end if;
    select * into v_pool from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'ready' then
      return case when exists (select 1 from private.photos x where x.file_id = v_file.id)
        then 'ready' else 'not_found' end;
    end if;
    if v_file.status <> 'pending' then
      return 'not_found';
    end if;

    if p_variants is null or pg_catalog.jsonb_typeof(p_variants) <> 'array'
       or pg_catalog.jsonb_array_length(p_variants) <> 4 then
      v_ok := false;
    else
      for v_variant in select * from pg_catalog.jsonb_array_elements(p_variants) loop
        if pg_catalog.jsonb_typeof(v_variant) <> 'object'
           or coalesce(v_variant ->> 'kind', '') not in ('master', 'full', 'display', 'thumb')
           or (v_variant ->> 'kind') = any (v_kinds)
           or coalesce(v_variant ->> 'size', '') !~ '^[0-9]{1,10}$'
           or coalesce(v_variant ->> 'width', '') !~ '^[0-9]{1,5}$'
           or coalesce(v_variant ->> 'height', '') !~ '^[0-9]{1,5}$'
           or coalesce(v_variant ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
          v_ok := false;
          exit;
        end if;
        if (v_variant ->> 'size')::bigint < 1 or (v_variant ->> 'width')::integer < 1
           or (v_variant ->> 'height')::integer < 1 then
          v_ok := false;
          exit;
        end if;
        v_kinds := v_kinds || (v_variant ->> 'kind');
        v_total := v_total + (v_variant ->> 'size')::bigint;
        if (v_variant ->> 'kind') = 'master' then
          v_master := v_variant;
        end if;
      end loop;
    end if;
    -- The uploader must still be allowed to add to a Home library; losing that answers
    -- 'not_permitted', not 'invalid' (S35-L3).
    if v_ok and v_pool.owner_home_id is not null
       and private.photo_access(v_pool.owner_home_id, p_user_id) is null then
      perform public.finalize_upload(p_user_id, p_file_id, 'image/webp', 0, null);
      return 'not_permitted';
    end if;
    if not v_ok then
      -- Marks the file failed and queues its objects (the facts below are never valid).
      perform public.finalize_upload(p_user_id, p_file_id, 'image/webp', 0, null);
      return 'invalid';
    end if;

    v_outcome := public.finalize_upload(
      p_user_id, p_file_id, 'image/webp', v_total, v_master ->> 'sha256');
    if v_outcome <> 'ready' then
      return v_outcome;
    end if;

    for v_variant in select * from pg_catalog.jsonb_array_elements(p_variants) loop
      if (v_variant ->> 'kind') <> 'master' then
        update private.photo_variants v
          set size_bytes = (v_variant ->> 'size')::bigint, width = (v_variant ->> 'width')::integer,
            height = (v_variant ->> 'height')::integer, sha256 = v_variant ->> 'sha256'
          where v.file_id = p_file_id and v.kind = v_variant ->> 'kind';
      end if;
    end loop;
    insert into private.photos (file_id, owner_user_id, owner_home_id, created_by, width, height)
      values (p_file_id, v_pool.owner_user_id, v_pool.owner_home_id, p_user_id,
        (v_master ->> 'width')::integer, (v_master ->> 'height')::integer)
      on conflict (file_id) do nothing
      returning * into v_photo;
    return 'ready';
  end
  $$;

-- Accounts and sign-in ---------------------------------------------------------------------------------------

-- S08-L3: as 20261015090000_sign_in_methods.sql, plus: an account never gets a second identity from a
-- provider it already has.
create or replace function private.guard_identity_insert()
returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_confirmed timestamptz;
  begin
    -- Email/password identities are created by Supabase Auth's own sign-up and confirmation flows,
    -- which already require control of the address.
    if new.provider = 'email' then
      return new;
    end if;

    perform private.lock_sign_in_methods(new.user_id);

    -- One identity per provider and account (S08-L3): a second Google identity is never attached,
    -- whatever was authorized.
    if exists (
      select 1 from auth.identities i
      where i.user_id = new.user_id and i.provider = new.provider and i.id <> new.id
    ) then
      raise exception 'sign-in method already linked' using errcode = '42501';
    end if;

    -- A brand-new account: this identity is its first.
    if not exists (
      select 1 from auth.identities i where i.user_id = new.user_id and i.id <> new.id
    ) then
      return new;
    end if;

    -- An account that never confirmed its email holds nothing and cannot sign in. Supabase Auth
    -- hands it to the verified provider identity and removes the unconfirmed password.
    select u.email_confirmed_at into v_confirmed from auth.users u where u.id = new.user_id;
    if v_confirmed is null then
      return new;
    end if;

    if private.consume_sign_in_method_grant(new.user_id, 'link', new.provider) then
      -- Checked again at commit: it must be a manual link to this account (see below).
      perform pg_catalog.set_config(
        'madeora.linked_by_permission',
        coalesce(pg_catalog.current_setting('madeora.linked_by_permission', true), '')
          || new.id::text || ',',
        true
      );
      return new;
    end if;

    raise exception 'sign-in method link not authorized'
      using errcode = '42501',
            hint = 'Madeora links a provider only after the account holder confirms it (S08).';
  end
  $$;

-- S38P2-L2: as 20261125090000_account_lifecycle.sql, except that a call within the touch interval reads
-- without FOR UPDATE.
create or replace function public.touch_my_activity()
returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_row private.account_inactivity;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    -- Most calls fall within the touch interval: answer them from a plain read, without a row lock or a
    -- write (S38P2-L2). Only a due update locks the row and reads it again.
    select * into v_row from private.account_inactivity i where i.user_id = v_user_id;
    if v_row.user_id is not null
       and v_row.last_active_at > pg_catalog.now() - private.activity_touch_interval() then
      return v_row.review_due;
    end if;
    select * into v_row from private.account_inactivity i where i.user_id = v_user_id for update;
    if v_row.user_id is null then
      insert into private.account_inactivity (user_id, last_active_at)
        values (v_user_id, pg_catalog.now())
        on conflict (user_id) do nothing;
      return false;
    end if;
    if v_row.last_active_at > pg_catalog.now() - private.activity_touch_interval() then
      return v_row.review_due;
    end if;
    update private.account_inactivity i
      set last_active_at = pg_catalog.now(),
          reminders_sent = 0,
          last_reminder_at = null,
          review_due = i.review_due
            or v_row.last_active_at <= pg_catalog.now() - private.inactivity_threshold()
      where i.user_id = v_user_id
      returning i.review_due into v_row.review_due;
    return v_row.review_due;
  end
  $$;

-- S38-L11 (database part): as 20261211090000_review_medium_db_rls.sql, except that each event is
-- classified in its own sub-block: a failing row rolls back alone (it stays unclassified and is tried
-- again next run) and is logged as a warning, instead of aborting the whole batch every run.
create or replace function public.process_sign_in_events(p_limit integer default 200)
returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_event record;
    v_count integer := 0;
    v_seen_any boolean;
    v_new_device boolean;
    v_prefs record;
    v_alert text;
    v_unfinished boolean;
  begin
    for v_event in
      select e.* from private.account_security_events e
      where e.kind = 'signed_in' and e.classified_at is null
        and e.created_at <= pg_catalog.now() - private.sign_in_settle_time()
        and not (
          e.second_step_needed and e.second_step_at is null
          and e.created_at > pg_catalog.now() - private.second_step_wait()
          and private.session_is_live(e.user_id, e.session_id)
        )
      order by e.created_at
      limit greatest(1, least(coalesce(p_limit, 200), 1000))
      for update skip locked
    loop
      -- One row that fails is logged and left for the next run; the rest of the batch goes on (S38-L11).
      begin
        update private.account_security_events set classified_at = pg_catalog.now()
          where id = v_event.id;
        v_count := v_count + 1;

        if exists (
          select 1 from private.account_security_events r
          where r.user_id = v_event.user_id and r.kind = 'reauthenticated'
            and r.session_id = v_event.session_id
        ) then
          continue;
        end if;

        v_unfinished := v_event.second_step_needed and v_event.second_step_at is null
          and not exists (
            select 1 from private.account_security_events r
            where r.user_id = v_event.user_id and r.kind = 'recovery_code_used'
              and r.session_id = v_event.session_id
          );
        if v_unfinished then
          insert into private.account_activity_events
              (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
               source_event_id, alerted, created_at)
            values (v_event.user_id, 'security', 'sign_in_unfinished', 'blocked', 'self',
                    v_event.device_kind, v_event.browser, v_event.platform, v_event.session_id,
                    v_event.id, true, v_event.created_at)
            on conflict (source_event_id) do nothing;
          perform private.notify_user(
            v_event.user_id, null, 'security', 'account.unfinished_sign_in',
            private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
            'account.unfinished_sign_in:' || v_event.id::text, true);
          continue;
        end if;

        -- From the marker the purge never deletes, not from the visible history (S38 review M2).
        select exists (
          select 1 from private.account_sign_in_markers s where s.user_id = v_event.user_id
        ) into v_seen_any;
        select not exists (
          select 1 from private.account_activity_events a
          where a.user_id = v_event.user_id and a.kind = 'signed_in' and a.category = 'security'
            and a.created_at > pg_catalog.now() - private.activity_retention()
            and a.device_kind is not distinct from v_event.device_kind
            and a.browser is not distinct from v_event.browser
            and a.platform is not distinct from v_event.platform
        ) into v_new_device;

        select coalesce(p.new_device, true) as new_device, coalesce(p.every_sign_in, false) as every_sign_in
          into v_prefs
          from (select 1) one
          left join private.security_alert_preferences p on p.user_id = v_event.user_id;

        v_alert := null;
        if v_seen_any then
          if v_new_device and v_prefs.new_device then
            v_alert := 'account.new_device_sign_in';
          elsif v_prefs.every_sign_in then
            v_alert := 'account.signed_in';
          end if;
        end if;

        insert into private.account_activity_events
            (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
             source_event_id, alerted, created_at)
          values (v_event.user_id, 'security', 'signed_in', 'completed', 'self', v_event.device_kind,
                  v_event.browser, v_event.platform, v_event.session_id, v_event.id,
                  v_alert is not null, v_event.created_at)
          on conflict (source_event_id) do nothing;
        insert into private.account_sign_in_markers (user_id, first_signed_in_at)
          values (v_event.user_id, v_event.created_at)
          on conflict (user_id) do nothing;

        if v_alert = 'account.new_device_sign_in' then
          perform private.notify_user(
            v_event.user_id, null, 'security', 'account.new_device_sign_in',
            private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
            'account.new_device_sign_in:' || v_event.id::text, true);
        elsif v_alert = 'account.signed_in' then
          perform private.notify_user(
            v_event.user_id, null, 'security', 'account.signed_in',
            private.sign_in_alert_params(v_event.device_kind, v_event.browser, v_event.platform),
            'account.signed_in:' || v_event.id::text, true);
        end if;
      exception when others then
        raise warning 'process_sign_in_events: event % failed (%)', v_event.id, sqlstate;
      end;
    end loop;
    return v_count;
  end
  $$;
