-- S47d: Ora's locking Undo functions and history lines for two more guided changes.
--
-- Undo used to be two calls (read the revision, then delete), so an edit made in between could be
-- trashed with the record. Each function below takes the module's own row lock, checks what Ora left
-- behind and only then calls the module's own function, all in one transaction: whoever edits the
-- record first wins and the other side is told truthfully. They check the caller like the module
-- does (confirmed account, membership, the module's own edit or delete right) and add nothing
-- else; they never write on their own except through the module functions they call.

alter table public.ora_interactions drop constraint ora_interactions_kind_check;
alter table public.ora_interactions add constraint ora_interactions_kind_check check (kind in (
  'task-added', 'task-undone', 'shopping-item-added', 'shopping-item-undone',
  'task-completed', 'task-completion-undone', 'task-due-changed', 'task-due-restored'
));

-- Moves a task Ora just added to the trash, only if it is still at the revision Ora left it at.
-- Outcomes: 'deleted', 'conflict' (someone changed it), 'not_found', 'not_permitted'.
create function public.ora_undo_task_create(p_task_id uuid, p_expected_revision integer)
returns table (outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
  begin
    if p_task_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found'::text;
      return;
    end if;
    if not private.can_delete_task(v_task, v_user_id) then
      return query select 'not_permitted'::text;
      return;
    end if;
    if v_task.revision <> p_expected_revision then
      return query select 'conflict'::text;
      return;
    end if;
    -- The row lock above is held until the end of this transaction: nobody can edit it meanwhile.
    return query select d.outcome from public.delete_task(p_task_id) d;
  end
  $$;

-- The same for a shopping item Ora just added.
create function public.ora_undo_shopping_item(p_item_id uuid, p_expected_revision integer)
returns table (outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_item private.shopping_items;
  begin
    if p_item_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_item := private.lock_shopping_item(p_item_id, v_user_id);
    if v_item.id is null then
      return query select 'not_found'::text;
      return;
    end if;
    select * into v_list from private.shopping_lists l where l.id = v_item.list_id;
    if not private.shopping_may(v_list, v_user_id, 'edit') then
      return query select 'not_permitted'::text;
      return;
    end if;
    if v_item.revision <> p_expected_revision then
      return query select 'conflict'::text;
      return;
    end if;
    return query select d.outcome from public.delete_shopping_item(p_item_id) d;
  end
  $$;

-- Reopens a task Ora just completed, only if it is still completed by that very completion
-- (anyone reopening it, or reopening and completing it again, changes `completed_at`).
-- Outcomes: 'reopened', 'conflict', 'list_unavailable', 'not_found', 'not_permitted'.
create function public.ora_undo_task_completion(p_task_id uuid, p_expected_completed_at timestamptz)
returns table (outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
  begin
    if p_task_id is null or p_expected_completed_at is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found'::text;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted'::text;
      return;
    end if;
    if v_task.completed_at is distinct from p_expected_completed_at then
      return query select 'conflict'::text;
      return;
    end if;
    return query select c.outcome from public.set_task_completion(p_task_id, false) c;
  end
  $$;

-- Puts a task's due date back to what it was before Ora changed it, only if the task is still at the
-- revision that change left it at. Goes through the module's own update (same validation, revision
-- and labels); nothing else about the task changes. Outcomes: 'saved', 'conflict', 'invalid',
-- 'not_found', 'not_permitted'.
create function public.ora_undo_task_due(
  p_task_id uuid, p_expected_revision integer, p_previous_due date default null
) returns table (outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_outcome text;
  begin
    if p_task_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found'::text;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted'::text;
      return;
    end if;
    if v_task.revision <> p_expected_revision then
      return query select 'conflict'::text;
      return;
    end if;
    if p_previous_due is not null and v_task.start_date is not null and v_task.start_date > p_previous_due then
      return query select 'invalid'::text;
      return;
    end if;
    select u.outcome into v_outcome
      from public.update_task(
        p_task_id, p_expected_revision, v_task.title,
        coalesce(array(select k.label_id from private.task_label_links k where k.task_id = v_task.id), '{}'),
        v_task.description, v_task.start_date, p_previous_due, v_task.priority
      ) u;
    return query select v_outcome;
  end
  $$;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.ora_undo_task_create(uuid, integer)',
    'public.ora_undo_shopping_item(uuid, integer)',
    'public.ora_undo_task_completion(uuid, timestamptz)',
    'public.ora_undo_task_due(uuid, integer, date)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
end
$$;
