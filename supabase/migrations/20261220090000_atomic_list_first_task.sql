-- UX4a: create a task list and its first task in one transaction, for the explicit
-- "no list yet, create one for this task" confirmation. `tasks_list_check` needs a list for every
-- active task and lists are never created silently, so the web app calls this after the person
-- confirmed the list name. It reuses create_task_list and create_task unchanged (same permissions,
-- limits, name rules, labels, assignees and audit entries); a refusal of the task undoes the list.
--
-- Outcomes: 'created', 'exists' (a retry of the caller's own earlier call: list and task both exist),
-- 'list_id_taken' (the list id exists and is not that earlier call), 'task_id_taken',
-- 'duplicate_name', 'limit_reached', 'not_permitted' (lists need a task manager),
-- 'invalid_label', 'invalid_assignee'. 22023 for invalid fields.
--
-- Rollback: drop function public.create_task_list_with_task(uuid, text, uuid, text, text, date, date,
-- text, uuid[], uuid[], uuid). Nothing else changes; lists and tasks it created are ordinary rows.

create function public.create_task_list_with_task(
  p_list_id uuid, p_list_name text, p_task_id uuid, p_title text, p_description text default null,
  p_start_date date default null, p_due_date date default null, p_priority text default null,
  p_label_ids uuid[] default '{}', p_assignee_ids uuid[] default '{}', p_home_id uuid default null
) returns table (outcome text, list_revision integer, task_revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list_outcome text;
    v_list_revision integer;
    v_task_outcome text;
    v_task_revision integer;
    v_task private.tasks;
  begin
    if p_list_id is null or p_task_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    begin
      select l.outcome, l.revision into v_list_outcome, v_list_revision
        from public.create_task_list(p_list_id, p_list_name, p_home_id) l;
      if v_list_outcome = 'exists' then
        -- A retry only when the first call also made this task, in this list.
        select * into v_task from private.tasks t
          where t.id = p_task_id and t.created_by = v_user_id and t.list_id = p_list_id
            and t.deleted_at is null;
        if found then
          return query select 'exists', v_list_revision, v_task.revision;
        else
          return query select 'list_id_taken', null::integer, null::integer;
        end if;
        return;
      elsif v_list_outcome = 'id_taken' then
        return query select 'list_id_taken', null::integer, null::integer;
        return;
      elsif v_list_outcome <> 'created' then
        -- duplicate_name, limit_reached, not_permitted: nothing was written.
        return query select v_list_outcome, null::integer, null::integer;
        return;
      end if;
      select t.outcome, t.revision into v_task_outcome, v_task_revision
        from public.create_task(
          p_task_id, p_list_id, p_title, p_description, p_start_date, p_due_date, p_priority,
          p_label_ids, p_assignee_ids, p_home_id) t;
      if v_task_outcome <> 'created' then
        -- create_task answers 'exists' for the caller's own task id (it ignores the list), which
        -- here means the id is taken by a task that is not in this new list.
        if v_task_outcome not in ('exists', 'id_taken', 'invalid_label', 'invalid_assignee', 'not_permitted') then
          raise exception 'unexpected create_task outcome' using errcode = 'XX000';
        end if;
        -- Undo the list (and its audit entry) created a moment ago in this call.
        raise exception 'first task refused' using errcode = 'MD001';
      end if;
    exception when sqlstate 'MD001' then
      return query select case when v_task_outcome in ('exists', 'id_taken') then 'task_id_taken' else v_task_outcome end,
        null::integer, null::integer;
      return;
    end;
    return query select 'created', v_list_revision, v_task_revision;
  end
  $$;

revoke all on function public.create_task_list_with_task(
  uuid, text, uuid, text, text, date, date, text, uuid[], uuid[], uuid) from public, anon;
grant execute on function public.create_task_list_with_task(
  uuid, text, uuid, text, text, date, date, text, uuid[], uuid[], uuid) to authenticated;
