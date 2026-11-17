-- Review backlog, part 1: the open MEDIUM review findings in the database, RLS and auth areas.
--
-- Each section names its finding. Functions that had to change inside their bodies are redefined
-- whole (create or replace keeps their grants); the others are wrapped the way earlier steps wrap
-- them (the old function moves to private under a *_before_review_fixes name and the new public one
-- calls it). Nothing here changes a table's existing rows except the S38 backfill, the S38 sign-in
-- markers and the S41 removal of grants that children must not hold.

-- S19 review M2: a series can be ended through the schedule edit -------------------------------------

-- As S19, but a schedule change that leaves no next date ends the series instead of being refused;
-- 'ended' stays the answer when nothing at all would be left of the chain.
create or replace function public.update_task_series(
  p_task_id uuid, p_scope text, p_expected_task_revision integer, p_expected_series_revision integer,
  p_dry_run boolean,
  p_set_content boolean default false, p_title text default null, p_description text default null,
  p_priority text default null, p_label_ids uuid[] default null, p_start_offset integer default null,
  p_copy_subtasks boolean default false,
  p_list_id uuid default null,
  p_assignee_ids uuid[] default null,
  p_set_schedule boolean default false, p_frequency text default null, p_interval integer default null,
  p_weekdays smallint[] default null, p_starts_on date default null, p_ends_on date default null,
  p_max_count integer default null,
  p_today date default null
) returns table (outcome text, impact jsonb, revision integer, task_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_head private.task_series;
    v_target private.task_series;
    v_scope text := p_scope;
    v_today date;
    v_users uuid[];
    v_boundary date;
    v_occurrence private.tasks;
    v_updated integer := 0;
    v_kept integer := 0;
    v_removed integer := 0;
    v_completed integer := 0;
    v_selected_removed boolean := false;
    v_subtasks text[];
    v_impact jsonb;
    v_next_task uuid;
  begin
    if p_task_id is null or p_scope is null or p_scope not in ('following', 'series')
       or p_expected_task_revision is null or p_expected_series_revision is null or p_dry_run is null
       or p_set_content is null or p_set_schedule is null or p_copy_subtasks is null
       or (p_set_content and (
         not private.valid_task_fields(p_title, p_description, null, null, p_priority)
         or p_label_ids is null
         or (p_start_offset is not null and p_start_offset not between 0 and private.task_limit('start_offset'))))
       or (p_set_schedule and not private.valid_series_rule(
         p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count))
       or not (p_set_content or p_set_schedule or p_list_id is not null or p_assignee_ids is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The series head before the occurrence, like every series-wide change: two of them started
    -- from different occurrences of one series then queue instead of deadlocking (S19 review M1).
    perform private.lock_series_head(
      (select t.series_root_id from private.tasks t where t.id = p_task_id));
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if v_task.series_root_id is null then
      return query select 'not_recurring', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    v_head := private.lock_series_head(v_task.series_root_id);
    if v_head.id is null then
      return query select 'not_recurring', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if not private.can_edit_series(v_head, v_user_id)
       or (p_assignee_ids is not null and (v_head.owner_home_id is null
         or not private.can_manage_tasks(null, v_head.owner_home_id, v_user_id))) then
      return query select 'not_permitted', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if v_task.revision <> p_expected_task_revision or v_head.revision <> p_expected_series_revision then
      return query select 'conflict', null::jsonb, v_head.revision, null::uuid;
      return;
    end if;
    if p_scope = 'following' and (v_task.series_id is distinct from v_head.id or v_task.completed_at is not null) then
      return query select 'scope_unavailable', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_set_content and not private.valid_task_labels(p_label_ids, v_head.owner_user_id, v_head.owner_home_id) then
      return query select 'invalid_label', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_list_id is not null
       and not private.usable_task_list(p_list_id, v_head.owner_user_id, v_head.owner_home_id) then
      return query select 'list_unavailable', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_assignee_ids is not null then
      v_users := private.member_users(v_head.owner_home_id, p_assignee_ids);
      if v_users is null or cardinality(v_users) > private.task_limit('assignees_per_task') then
        return query select 'invalid_assignee', null::jsonb, null::integer, null::uuid;
        return;
      end if;
    end if;
    v_today := private.task_today(v_head.owner_home_id, p_today);
    v_boundary := v_task.occurrence_date;
    if v_scope = 'following' and v_head.previous_id is null and not exists (
      select 1 from private.tasks t
      where t.series_root_id = v_head.root_id and t.deleted_at is null and t.occurrence_date < v_boundary
    ) then
      v_scope := 'series';
    end if;
    if p_copy_subtasks then
      select coalesce(array_agg(s.title order by s.position, s.created_at, s.id), '{}') into v_subtasks
        from private.subtasks s where s.task_id = v_task.id;
    end if;

    begin
      if v_scope = 'following' then
        -- A new head from this occurrence on, with the old head's template and schedule; the old
        -- head ends the day before. Same creator, so the creator keeps their rights.
        insert into private.task_series (
          id, root_id, previous_id, owner_user_id, owner_home_id, list_id, title, description,
          priority, start_offset, frequency, interval_count, weekdays, starts_on, active_from,
          ends_on, max_count, until_date, next_date, last_date, paused_at, needs_reassignment,
          revision, created_by, created_at, updated_by
        )
        select gen_random_uuid(), h.root_id, h.id, h.owner_user_id, h.owner_home_id, h.list_id,
          h.title, h.description, h.priority, h.start_offset, h.frequency, h.interval_count,
          h.weekdays, h.starts_on, greatest(v_boundary, coalesce(h.active_from, h.starts_on)),
          h.ends_on, h.max_count, h.until_date, h.next_date, h.last_date, h.paused_at,
          h.needs_reassignment, h.revision + 1, h.created_by, h.created_at, v_user_id
        from private.task_series h where h.id = v_head.id
        returning * into v_target;
        insert into private.task_series_labels (series_id, label_id)
          select v_target.id, l.label_id from private.task_series_labels l where l.series_id = v_head.id;
        insert into private.task_series_assignees (series_id, home_id, user_id)
          select v_target.id, a.home_id, a.user_id from private.task_series_assignees a where a.series_id = v_head.id;
        insert into private.task_series_subtasks (series_id, position, title)
          select v_target.id, s.position, s.title from private.task_series_subtasks s where s.series_id = v_head.id;
        -- Never before the old part's own start (S19 review H2): after a reschedule moved the start
        -- later, an older open occurrence can lie before it; the old part then keeps no dates.
        update private.task_series s
          set superseded_at = pg_catalog.now(), next_date = null,
            until_date = greatest(least(coalesce(s.until_date, v_boundary - 1), v_boundary - 1),
              s.starts_on - 1),
            updated_by = v_user_id, updated_at = pg_catalog.now()
          where s.id = v_head.id;
        update private.tasks t set series_id = v_target.id
          where t.series_id = v_head.id and t.occurrence_date >= v_boundary
            and t.deleted_at is null and t.completed_at is null;
      else
        v_target := v_head;
        v_target.revision := v_head.revision + 1;
      end if;

      -- The template.
      if p_set_content then
        v_target.title := p_title;
        v_target.description := p_description;
        v_target.priority := p_priority;
        v_target.start_offset := p_start_offset;
      end if;
      if p_list_id is not null then
        v_target.list_id := p_list_id;
      end if;
      if p_assignee_ids is not null then
        v_target.needs_reassignment := false;
      end if;
      if p_set_schedule then
        v_target.frequency := p_frequency;
        v_target.interval_count := p_interval;
        v_target.weekdays := p_weekdays;
        v_target.starts_on := p_starts_on;
        -- A new part never creates dates before its first occurrence, whatever its anchor.
        v_target.active_from := case when v_scope = 'following' then v_boundary end;
        v_target.ends_on := p_ends_on;
        v_target.max_count := p_max_count;
        v_target.until_date := private.series_until(
          p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count);
      end if;
      update private.task_series s
        set list_id = v_target.list_id, title = v_target.title, description = v_target.description,
          priority = v_target.priority, start_offset = v_target.start_offset,
          frequency = v_target.frequency, interval_count = v_target.interval_count,
          weekdays = v_target.weekdays, starts_on = v_target.starts_on,
          active_from = v_target.active_from, ends_on = v_target.ends_on,
          max_count = v_target.max_count, until_date = v_target.until_date,
          -- A new schedule's next date is computed below; the old one may lie before a later start
          -- (S19 review H1).
          next_date = case when p_set_schedule then null else s.next_date end,
          needs_reassignment = v_target.needs_reassignment, revision = v_target.revision,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where s.id = v_target.id
        returning * into v_target;
      perform private.set_series_template(v_target.id, v_target.owner_home_id,
        case when p_set_content then p_label_ids end, v_users, v_subtasks);

      -- The open occurrences in scope, locked in id order.
      for v_occurrence in
        select * from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
          and (v_scope = 'series' or t.series_id = v_target.id)
        order by t.id
        for update
      loop
        if v_occurrence.id <> v_task.id and v_occurrence.detached then
          v_kept := v_kept + 1;
          continue;
        end if;
        if p_set_schedule and v_occurrence.occurrence_date > v_today
           and not private.series_has_date(v_target, v_occurrence.occurrence_date) then
          if private.occurrence_touched(v_occurrence) then
            -- Kept as it is, and from now on treated as changed on its own.
            update private.tasks t set detached = true where t.id = v_occurrence.id;
            v_kept := v_kept + 1;
          else
            delete from private.tasks t where t.id = v_occurrence.id;
            v_removed := v_removed + 1;
            v_selected_removed := v_selected_removed or v_occurrence.id = v_task.id;
          end if;
          continue;
        end if;
        if not (p_set_content or p_list_id is not null or p_assignee_ids is not null) then
          continue;
        end if;
        update private.tasks t
          set title = case when p_set_content then p_title else t.title end,
            description = case when p_set_content then p_description else t.description end,
            priority = case when p_set_content then p_priority else t.priority end,
            start_date = case when p_set_content
              then case when p_start_offset is not null then t.due_date - p_start_offset end
              else t.start_date end,
            list_id = coalesce(p_list_id, t.list_id),
            needs_reassignment = case when p_assignee_ids is not null then false else t.needs_reassignment end,
            revision = t.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
          where t.id = v_occurrence.id;
        if p_set_content then
          perform private.replace_task_labels(v_occurrence.id, p_label_ids);
        end if;
        if p_assignee_ids is not null then
          perform private.replace_task_assignees(v_occurrence.id, v_target.owner_home_id, v_users, v_user_id);
        end if;
        v_updated := v_updated + 1;
      end loop;
      select count(*)::integer into v_completed from private.tasks t
        where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is not null
          and (v_scope = 'series' or t.occurrence_date >= v_boundary);

      if p_set_schedule then
        -- Creation restarts from today (no back-fill), after whatever the chain still has.
        v_target.next_date := private.series_next(v_target, v_today);
        -- No next date ends the series (S19 review M2), unless the change would leave the
        -- chain (for 'following': the new part) without any occurrence at all.
        if v_target.next_date is null and not exists (
          select 1 from private.tasks t
          where t.series_root_id = v_head.root_id and t.deleted_at is null
            and (v_scope = 'series' or t.series_id = v_target.id)
        ) then
          raise exception 'schedule ended' using errcode = 'MD002';
        end if;
        select max(t.occurrence_date) into v_target.last_date from private.tasks t
          where t.series_root_id = v_head.root_id;
        update private.task_series s set next_date = v_target.next_date, last_date = v_target.last_date
          where s.id = v_target.id
          returning * into v_target;
      end if;
      perform private.advance_series(v_target, v_today);
      select * into v_target from private.task_series s where s.id = v_target.id;

      v_impact := pg_catalog.jsonb_build_object(
        'scope', v_scope,
        'updated', v_updated,
        'kept', v_kept,
        'removed', v_removed,
        'completed', v_completed,
        'selectedRemoved', v_selected_removed,
        'subtasksCopied', coalesce(cardinality(v_subtasks), 0),
        'nextDates', pg_catalog.to_jsonb(private.series_dates(v_target, v_today, 5)));
      if v_selected_removed then
        select t.id into v_next_task from private.tasks t
          where t.series_root_id = v_head.root_id and t.deleted_at is null and t.completed_at is null
            and t.occurrence_date >= v_today
          order by t.occurrence_date limit 1;
      else
        v_next_task := v_task.id;
      end if;
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        -- Everything above is rolled back; the impact stays.
        return query select 'preview', v_impact, v_head.revision, v_task.id;
        return;
      when sqlstate 'MD002' then
        return query select 'ended', null::jsonb, null::integer, null::uuid;
        return;
    end;
    perform private.audit_task('task_series.updated', v_head.owner_home_id, 'task_series', v_head.root_id,
      pg_catalog.jsonb_build_object('scope', v_scope, 'updated', v_updated, 'kept', v_kept,
        'removed', v_removed, 'schedule', p_set_schedule, 'assignees', p_assignee_ids is not null));
    return query select 'saved', v_impact, v_target.revision, v_next_task;
  end
  $$;

-- Trash: chores (S20 review M1) and series attachments (S19c review M-A) -----------------------------

alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_review_fixes;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_review_fixes;

-- Whether a chore's ending blocks bringing back this chore entry: an ended chore takes no occurrence
-- back, except through the entire-series removal that ended it (which un-ends it).
create function private.chore_entry_blocked_by_end(p_entry private.trash_entries) returns boolean
  language sql stable security definer set search_path = '' as $$
  select case p_entry.item_type
    when 'chore_occurrence' then exists (
      select 1 from private.chore_occurrences o join private.chores c on c.id = o.chore_id
      where o.id = p_entry.subject_id and c.ended_at is not null)
    when 'chore_removal' then exists (
      select 1 from private.chore_removals r join private.chores c on c.id = r.chore_id
      where r.id = p_entry.subject_id and c.ended_at is not null
        and (r.occurrences_only or r.mode <> 'series'))
    else false
  end;
  $$;

-- New conflicts: an occurrence (or a removal's occurrences only) of an ended chore
-- ('chore_unavailable'), and a series attachment for a chain that already holds the most
-- ('attachment_limit': the person removes one first).
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_kind text := private.trash_conflict_before_review_fixes(p_entry);
    v_root uuid;
  begin
    if v_kind is not null then
      return v_kind;
    end if;
    if p_entry.module = 'chores' and private.chore_entry_blocked_by_end(p_entry) then
      return 'chore_unavailable';
    end if;
    if p_entry.module = 'tasks' and p_entry.item_type = 'task_series_attachment' then
      select s.root_id into v_root from private.task_series_attachments s where s.id = p_entry.subject_id;
      if (select count(*) from private.task_series_attachments s
          where s.root_id = v_root and s.removed_at is null) >= private.task_limit('attachments') then
        return 'attachment_limit';
      end if;
    end if;
    return null;
  end
  $$;

-- The same checks again under the locks the restore takes anyway (the chore, the series head, in
-- that module's order); a change in between raises unique_violation, which the caller turns into a
-- fresh conflict.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_root uuid;
  begin
    if p_entry.module = 'chores' and p_entry.item_type in ('chore_occurrence', 'chore_removal') then
      perform 1 from private.chores c
        where c.id = case p_entry.item_type
          when 'chore_occurrence' then (select o.chore_id from private.chore_occurrences o
            where o.id = p_entry.subject_id)
          else (select r.chore_id from private.chore_removals r where r.id = p_entry.subject_id) end
        for update;
      if private.chore_entry_blocked_by_end(p_entry) then
        raise exception 'chore unavailable' using errcode = '23505';
      end if;
    elsif p_entry.module = 'tasks' and p_entry.item_type = 'task_series_attachment' then
      select s.root_id into v_root from private.task_series_attachments s where s.id = p_entry.subject_id;
      perform private.lock_series_head(v_root);
      if (select count(*) from private.task_series_attachments s
          where s.root_id = v_root and s.removed_at is null) >= private.task_limit('attachments') then
        raise exception 'attachment limit' using errcode = '23505';
      end if;
    end if;
    return private.trash_item_restore_before_review_fixes(p_entry);
  end
  $$;

-- Chores: no series change on an ended chore (S20 review M1) ------------------------------------------

alter function public.update_chore_series(uuid, text, integer, integer, boolean, jsonb, jsonb, boolean,
  integer, boolean, text, integer, smallint[], date, date, integer) set schema private;
alter function private.update_chore_series(uuid, text, integer, integer, boolean, jsonb, jsonb, boolean,
  integer, boolean, text, integer, smallint[], date, date, integer)
  rename to update_chore_series_before_review_fixes;

-- As before, plus 'scope_unavailable' for a chore that has ended (its occurrences are history).
create function public.update_chore_series(
  p_occurrence_id uuid, p_scope text, p_expected_revision integer,
  p_expected_schedule_revision integer, p_dry_run boolean,
  p_assignment jsonb default null, p_steps jsonb default null,
  p_set_minutes boolean default false, p_minutes integer default null,
  p_set_schedule boolean default false, p_frequency text default null, p_interval integer default null,
  p_weekdays smallint[] default null, p_starts_on date default null, p_ends_on date default null,
  p_max_count integer default null
) returns table (outcome text, impact jsonb, revision integer, occurrence_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
  begin
    if p_occurrence_id is not null then
      v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
      if v_occurrence.id is not null and private.can_manage_chores(v_occurrence.home_id, v_user_id)
         and exists (select 1 from private.chores c where c.id = v_occurrence.chore_id and c.ended_at is not null) then
        return query select 'scope_unavailable', null::jsonb, null::integer, null::uuid;
        return;
      end if;
    end if;
    return query select * from private.update_chore_series_before_review_fixes(p_occurrence_id, p_scope,
      p_expected_revision, p_expected_schedule_revision, p_dry_run, p_assignment, p_steps,
      p_set_minutes, p_minutes, p_set_schedule, p_frequency, p_interval, p_weekdays, p_starts_on,
      p_ends_on, p_max_count);
  end
  $$;

-- Chores: a one-off chore waiting for approval cannot be deleted (S20 review M2) ----------------------

alter function public.delete_chore_occurrences(uuid, text, integer, boolean) set schema private;
alter function private.delete_chore_occurrences(uuid, text, integer, boolean)
  rename to delete_chore_occurrences_before_review_fixes;

-- As before, plus 'pending_approval' for a one-off chore whose completion waits for a decision (it
-- is decided or withdrawn first, like the other single-occurrence changes).
create function public.delete_chore_occurrences(
  p_occurrence_id uuid, p_scope text, p_expected_revision integer, p_dry_run boolean
) returns table (outcome text, impact jsonb, entry_id uuid, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
  begin
    if p_occurrence_id is not null then
      v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
      if v_occurrence.id is not null and v_occurrence.status = 'pending_approval'
         and private.can_manage_chores(v_occurrence.home_id, v_user_id)
         and v_occurrence.revision = p_expected_revision
         and exists (select 1 from private.chores c where c.id = v_occurrence.chore_id and c.kind = 'one_off') then
        return query select 'pending_approval', null::jsonb, null::uuid, v_occurrence.revision;
        return;
      end if;
    end if;
    return query select * from private.delete_chore_occurrences_before_review_fixes(p_occurrence_id, p_scope,
      p_expected_revision, p_dry_run);
  end
  $$;

-- Vacations: participation changes bump the vacation's revision (S22 review M3) -----------------------

-- As S22, and an envelope change is a change of the vacation: a Home pause previewed before it is
-- answered 'conflict' instead of covering dates nobody reviewed.
create or replace function private.refresh_vacation_envelope(p_vacation_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.home_vacations v set starts_on = x.s, ends_on = x.e, revision = v.revision + 1
      from (select min(p.starts_on) as s, max(p.ends_on) as e from private.home_vacation_participants p
        where p.vacation_id = p_vacation_id and p.status = 'accepted') x
      where v.id = p_vacation_id and x.s is not null
        and (v.starts_on is distinct from x.s or v.ends_on is distinct from x.e);
  end
  $$;

-- Vacations: no participation change on an Ended vacation (S22 review M4) -----------------------------

alter function public.change_vacation_participation(uuid, integer, text, boolean, date, date) set schema private;
alter function private.change_vacation_participation(uuid, integer, text, boolean, date, date)
  rename to change_vacation_participation_before_review_fixes;
alter function public.answer_vacation_date_proposal(uuid, text, boolean) set schema private;
alter function private.answer_vacation_date_proposal(uuid, text, boolean)
  rename to answer_vacation_date_proposal_before_review_fixes;

-- Whether a vacation has ended on its Home's today (cancelled ones keep their own answer).
create function private.vacation_has_ended(p_vacation_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce((select private.vacation_status(v, private.task_today(v.home_id, null)) = 'ended'
    from private.home_vacations v where v.id = p_vacation_id), false);
  $$;

-- As S22, plus 'ended' (with the participation's revision) for any action the caller may take on a
-- vacation that has ended: a separate future vacation is needed (spec). Who may act, and on which
-- revision, is still answered first (a dry run of the same action), so nothing is disclosed to
-- someone who may not act. Saved participation changes also bump the vacation's revision (M3): who
-- is away decides which dates a Home pause covers.
create function public.change_vacation_participation(
  p_participant_id uuid, p_expected_revision integer, p_action text, p_dry_run boolean,
  p_starts_on date default null, p_ends_on date default null
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_home uuid;
    v_vacation uuid;
    v_row record;
  begin
    select p.home_id, p.vacation_id into v_home, v_vacation
      from private.home_vacation_participants p where p.id = p_participant_id;
    if v_home is not null and private.is_home_member(v_home, auth.uid()) then
      perform private.lock_home_vacations(v_home);
      if private.vacation_has_ended(v_vacation) then
        select * into v_row from private.change_vacation_participation_before_review_fixes(
          p_participant_id, p_expected_revision, p_action, true, p_starts_on, p_ends_on) x;
        if v_row.outcome = 'preview' then
          return query select 'ended'::text, null::jsonb, p_expected_revision;
        else
          return query select v_row.outcome, v_row.impact, v_row.revision;
        end if;
        return;
      end if;
    end if;
    select * into v_row from private.change_vacation_participation_before_review_fixes(
      p_participant_id, p_expected_revision, p_action, p_dry_run, p_starts_on, p_ends_on) x;
    if v_row.outcome = 'saved' then
      update private.home_vacations v set revision = v.revision + 1 where v.id = v_vacation;
    end if;
    return query select v_row.outcome, v_row.impact, v_row.revision;
  end
  $$;

create function public.answer_vacation_date_proposal(p_proposal_id uuid, p_action text, p_dry_run boolean)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_home uuid;
    v_vacation uuid;
    v_row record;
  begin
    select d.home_id, d.vacation_id into v_home, v_vacation
      from private.home_vacation_date_proposals d where d.id = p_proposal_id;
    if v_home is not null and private.is_home_member(v_home, auth.uid()) then
      perform private.lock_home_vacations(v_home);
      if private.vacation_has_ended(v_vacation) then
        select * into v_row from private.answer_vacation_date_proposal_before_review_fixes(
          p_proposal_id, p_action, true) x;
        if v_row.outcome = 'preview' then
          return query select 'ended'::text, null::jsonb, null::integer;
        else
          return query select v_row.outcome, v_row.impact, v_row.revision;
        end if;
        return;
      end if;
    end if;
    select * into v_row from private.answer_vacation_date_proposal_before_review_fixes(
      p_proposal_id, p_action, p_dry_run) x;
    if v_row.outcome = 'saved' and p_action = 'accept' then
      update private.home_vacations v set revision = v.revision + 1 where v.id = v_vacation;
    end if;
    return query select v_row.outcome, v_row.impact, v_row.revision;
  end
  $$;

-- Vacations: work waiting for a vacation review is not overdue (S22 review M5) ------------------------

-- The S21 overview and manager summary, as before, except that an occurrence waiting for a vacation
-- review is never counted or shown as overdue (spec: paused or "Needs vacation review" work is not
-- treated as overdue).
create or replace function private.chore_summary_counts(p_home_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  with base as (
    select o.*, c.auto_release_hours, (select count(*) from private.chore_occurrence_assignees a
      where a.occurrence_id = o.id) as assigned
    from private.chore_occurrences o
    join private.chores c on c.id = o.chore_id
    where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
      and o.status in ('open', 'pending_approval')
  ), today as (select private.task_today(p_home_id, null) as d)
  select pg_catalog.jsonb_build_object(
    'overdueAssigned', count(*) filter (where b.status = 'open' and b.due_date < t.d
      and not b.vacation_review and b.assigned > 0),
    'overdueUnassigned', count(*) filter (where b.status = 'open' and b.due_date < t.d
      and not b.vacation_review and b.assigned = 0),
    'pendingReview', count(*) filter (where b.status = 'pending_approval'),
    'rework', count(*) filter (where b.status = 'open' and b.in_rework),
    'inReview', count(*) filter (where b.status = 'open' and b.needs_reassignment and b.assigned = 0),
    'releaseSoon', count(*) filter (where b.status = 'open' and not b.in_rework
      and b.claimed_by is not null and b.auto_release_hours is not null
      and ((b.due_date + 1)::timestamp at time zone private.home_zone(p_home_id))
        + pg_catalog.make_interval(hours => b.auto_release_hours)
        between pg_catalog.now() and pg_catalog.now() + interval '24 hours'))
  from base b cross join today t;
  $$;

create or replace function public.get_chore_summary(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_zone text;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('canManage', false);
    end if;
    v_today := private.task_today(p_home_id, null);
    v_zone := private.home_zone(p_home_id);
    return pg_catalog.jsonb_build_object(
      'canManage', true,
      'today', v_today,
      'counts', private.chore_summary_counts(p_home_id),
      'items', coalesce((select pg_catalog.jsonb_agg(x.item order by x.due_date, x.title, x.id) from (
        select o.due_date, c.title, o.id, pg_catalog.jsonb_build_object(
          'id', o.id, 'title', c.title, 'dueDate', o.due_date, 'group', g.grp,
          'assigneeIds', coalesce((select pg_catalog.jsonb_agg(private.member_ref(a.home_id, a.user_id)
            order by a.user_id) from private.chore_occurrence_assignees a where a.occurrence_id = o.id),
            '[]'::jsonb),
          'releaseAt', case when g.grp = 'releaseSoon' then
            ((o.due_date + 1)::timestamp at time zone v_zone)
              + pg_catalog.make_interval(hours => c.auto_release_hours) end) as item,
          pg_catalog.row_number() over (partition by g.grp order by o.due_date, c.title, o.id) as n
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        cross join lateral (
          select case
            when o.status = 'pending_approval' then 'pendingReview'
            when o.in_rework then 'rework'
            when o.needs_reassignment and not exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id) then 'inReview'
            when o.due_date < v_today and not o.vacation_review and exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id) then 'overdueAssigned'
            when o.due_date < v_today and not o.vacation_review then 'overdueUnassigned'
            when o.claimed_by is not null and c.auto_release_hours is not null
              and ((o.due_date + 1)::timestamp at time zone v_zone)
                + pg_catalog.make_interval(hours => c.auto_release_hours)
                between pg_catalog.now() and pg_catalog.now() + interval '24 hours' then 'releaseSoon'
          end as grp
        ) g
        where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
          and o.status in ('open', 'pending_approval') and g.grp is not null
      ) x where x.n <= private.chore_schedule_limit('summary_items')), '[]'::jsonb));
  end
  $$;

create or replace function public.list_chore_schedule(p_home_id uuid, p_from date, p_to date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_items jsonb := '[]'::jsonb;
    v_part private.chore_schedules;
    v_chore private.chores;
    v_next date;
    v_users uuid[];
    v_flagged boolean;
    v_count integer;
    v_guard integer;
    v_truncated boolean := false;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_from is null or p_to is null or p_to < p_from
       or p_to - p_from >= private.chore_schedule_limit('days') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, null);
    select coalesce(pg_catalog.jsonb_agg(x.item order by x.due_date, x.title, x.id), '[]'::jsonb),
        count(*)::integer
      into v_items, v_count
      from (
        select o.due_date, c.title, o.id, pg_catalog.jsonb_build_object(
          'id', o.id, 'choreId', c.id,
          'title', coalesce(case when o.status <> 'open' then o.closed_title end, c.title),
          'date', o.due_date,
          'category', case when g.id is null then null
            else pg_catalog.jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color) end,
          'status', o.status,
          'overdue', o.status = 'open' and o.due_date < v_today and not o.vacation_review,
          'inRework', o.in_rework,
          'needsReassignment', o.needs_reassignment,
          'awaitingVolunteer', exists (select 1 from private.chore_volunteer_requests q
            where q.occurrence_id = o.id and q.status = 'open'),
          'assigneeIds', coalesce((select pg_catalog.jsonb_agg(private.member_ref(a.home_id, a.user_id)
            order by a.user_id) from private.chore_occurrence_assignees a where a.occurrence_id = o.id),
            '[]'::jsonb),
          'minutes', o.estimated_minutes,
          'revision', o.revision,
          'recurring', c.kind = 'recurring',
          'projected', false) as item
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        left join private.chore_categories g on g.id = c.category_id
        where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
          and o.due_date between p_from and p_to
        order by o.due_date, c.title, o.id
        limit private.chore_schedule_limit('items')
      ) x;
    v_truncated := v_count >= private.chore_schedule_limit('items');
    -- Projected dates: after what each current part has created, within the range.
    for v_part in
      select s.* from private.chore_schedules s
      join private.chores c on c.id = s.chore_id
      where s.home_id = p_home_id and s.superseded_at is null and s.next_date is not null
        and s.next_date <= p_to and c.deleted_at is null and c.ended_at is null
      order by s.chore_id
    loop
      exit when v_count >= private.chore_schedule_limit('items');
      select * into v_chore from private.chores c where c.id = v_part.chore_id;
      v_next := private.chore_part_next(v_part, greatest(p_from, v_part.next_date));
      v_guard := 0;
      while v_next is not null and v_next <= p_to and v_guard < 400 loop
        v_guard := v_guard + 1;
        if private.chore_paused_on(v_part, v_next) then
          exit when v_part.paused_until is null;
          v_next := private.chore_part_next(v_part, v_part.paused_until + 1);
          continue;
        end if;
        if not exists (select 1 from private.chore_occurrences o
            where o.chore_id = v_part.chore_id and o.scheduled_date = v_next) then
          select a.user_ids, a.flagged into v_users, v_flagged from private.chore_part_assignees(v_part, v_next) a;
          v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'id', null, 'choreId', v_chore.id, 'title', v_chore.title, 'date', v_next,
            'category', (select pg_catalog.jsonb_build_object('id', g.id, 'name', g.name, 'color', g.color)
              from private.chore_categories g where g.id = v_chore.category_id),
            'status', 'open', 'overdue', false, 'inRework', false, 'needsReassignment', v_flagged,
            'awaitingVolunteer', false,
            'assigneeIds', coalesce((select pg_catalog.jsonb_agg(private.member_ref(p_home_id, u))
              from unnest(v_users) u), '[]'::jsonb),
            'minutes', v_part.estimated_minutes, 'revision', null, 'recurring', true,
            'projected', true));
          v_count := v_count + 1;
          exit when v_count >= private.chore_schedule_limit('items');
        end if;
        v_next := private.chore_part_next(v_part, v_next + 1);
      end loop;
    end loop;
    if v_count >= private.chore_schedule_limit('items') then
      v_truncated := true;
    end if;
    return pg_catalog.jsonb_build_object(
      'today', v_today,
      'canManage', private.can_manage_chores(p_home_id, v_user_id),
      'items', v_items,
      'truncated', v_truncated);
  end
  $$;

-- Recipes: a cover that is no longer ready is not a full pool (S24 review M8) -------------------------

create or replace function private.adopt_recipe_cover(p_recipe private.recipes, p_file_id uuid, p_user_id uuid)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool private.storage_pools;
  begin
    if p_file_id is not distinct from p_recipe.cover_file_id then
      return null;
    end if;
    if p_file_id is not null then
      if not exists (
        select 1 from private.recipe_cover_uploads u
        join private.stored_files f on f.id = u.file_id
        where u.file_id = p_file_id and u.user_id = p_user_id
          and (u.recipe_id is null or u.recipe_id = p_recipe.id)
          and f.status = 'ready' and f.purpose = 'recipe_cover'
      ) then
        return 'invalid_cover';
      end if;
      v_pool := private.recipe_pool(p_recipe);
      if not private.move_file_to_pool(p_file_id, v_pool.id) then
        -- A file that stopped being ready meanwhile (retired, purged) is not a full pool (S24
        -- review M8).
        if not exists (select 1 from private.stored_files f where f.id = p_file_id and f.status = 'ready') then
          return 'invalid_cover';
        end if;
        return 'storage_full';
      end if;
      delete from private.recipe_cover_uploads u where u.file_id = p_file_id;
    end if;
    update private.recipes r set cover_file_id = p_file_id where r.id = p_recipe.id;
    if p_recipe.cover_file_id is not null then
      perform private.retire_file(p_recipe.cover_file_id);
    end if;
    return null;
  end
  $$;

-- Habits: a tracking change says which later scheduled versions it replaces (S29 review M3) -----------

alter function public.change_habit_tracking(uuid, integer, text, numeric, text, text, numeric[], text, date,
  numeric, boolean, boolean, boolean) set schema private;
alter function private.change_habit_tracking(uuid, integer, text, numeric, text, text, numeric[], text, date,
  numeric, boolean, boolean, boolean) rename to change_habit_tracking_before_review_fixes;

-- As S29, with impact.replacesLater: the tracking versions already scheduled after the new one's
-- start, which saving it removes (each with its start, mode, target and unit). Empty when none.
create function public.change_habit_tracking(
  p_id uuid, p_expected_revision integer, p_mode text, p_target numeric default null,
  p_unit text default null, p_unit_kind text default null, p_quick_adds numeric[] default null,
  p_when text default 'date', p_effective_on date default null, p_expected_total numeric default null,
  p_confirm_status boolean default false, p_confirm_unit boolean default false, p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_later jsonb := '[]'::jsonb;
    v_row record;
  begin
    if p_id is not null then
      -- The same lock the change takes, first, so the versions read here are the ones it replaces.
      v_habit := private.habit_lock(p_id, v_user_id);
      if v_habit.id is not null then
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'effectiveOn', t.effective_on, 'mode', t.mode, 'target', t.target, 'unit', t.unit,
            'unitKind', t.unit_kind) order by t.effective_on), '[]'::jsonb)
          into v_later
          from private.habit_tracking t where t.habit_id = v_habit.id;
      end if;
    end if;
    select * into v_row from private.change_habit_tracking_before_review_fixes(p_id, p_expected_revision,
      p_mode, p_target, p_unit, p_unit_kind, p_quick_adds, p_when, p_effective_on, p_expected_total,
      p_confirm_status, p_confirm_unit, p_dry_run) x;
    if v_row.impact is not null and v_row.impact ? 'effectiveOn' then
      v_row.impact := v_row.impact || pg_catalog.jsonb_build_object('replacesLater', coalesce((
        select pg_catalog.jsonb_agg(e.item order by e.item ->> 'effectiveOn')
        from pg_catalog.jsonb_array_elements(v_later) as e (item)
        where (e.item ->> 'effectiveOn')::date > (v_row.impact ->> 'effectiveOn')::date), '[]'::jsonb));
    end if;
    return query select v_row.outcome, v_row.impact, v_row.revision;
  end
  $$;

revoke all on function public.change_habit_tracking(uuid, integer, text, numeric, text, text, numeric[], text,
  date, numeric, boolean, boolean, boolean) from public, anon;
grant execute on function public.change_habit_tracking(uuid, integer, text, numeric, text, text, numeric[], text,
  date, numeric, boolean, boolean, boolean) to authenticated;

-- Account activity: backfill and first sign-in (S38 review M1, M2) ------------------------------------

-- M1: the S37 security events recorded before S38 mirrored new ones, within the visible retention.
-- Sign-ins are left to the sweep and re-authentications are never shown, as for new events.
insert into private.account_activity_events
    (user_id, category, kind, outcome, actor, device_kind, browser, platform, session_id,
     source_event_id, created_at)
  select e.user_id, 'security', e.kind, private.security_event_outcome(e.kind), 'self',
         e.device_kind, e.browser, e.platform, e.session_id, e.id, e.created_at
  from private.account_security_events e
  where e.kind not in ('reauthenticated', 'signed_in')
    and e.created_at > pg_catalog.now() - private.activity_retention()
  on conflict (source_event_id) do nothing;

-- M2: whether an account has ever signed in, kept apart from the history the purge deletes after 12
-- months, so a sign-in after a long absence (or the first one after this deploy) is not taken for
-- the account's very first one. Only the sweep writes it; nobody reads it but the sweep.
create table private.account_sign_in_markers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  first_signed_in_at timestamptz not null
);

alter table private.account_sign_in_markers enable row level security;
revoke all on table private.account_sign_in_markers from public, anon, authenticated;

comment on table private.account_sign_in_markers is
  'S38 review M2: accounts that have signed in before, for the first-sign-in rule of the alert sweep.';

-- Every account already seen signing in: from its history, or from Supabase Auth when it signed in
-- before S38 recorded anything (unless its only sign-ins still wait for the sweep).
insert into private.account_sign_in_markers (user_id, first_signed_in_at)
  select a.user_id, min(a.created_at) from private.account_activity_events a
  where a.kind = 'signed_in' and a.category = 'security'
  group by a.user_id
  on conflict (user_id) do nothing;
insert into private.account_sign_in_markers (user_id, first_signed_in_at)
  select u.id, u.last_sign_in_at from auth.users u
  where u.last_sign_in_at is not null
    and not exists (select 1 from private.account_security_events e
      where e.user_id = u.id and e.kind = 'signed_in' and e.classified_at is null)
  on conflict (user_id) do nothing;

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
    end loop;
    return v_count;
  end
  $$;

-- Home copies: copied files do not count against the requester's upload limits (S40 part 2 review M2)

-- Set for a file a Home copy created (it stays set after the copy ends, so the hourly count also
-- leaves it out).
alter table private.stored_files add column home_copy boolean not null default false;

create function private.mark_home_copy_file() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    update private.stored_files f set home_copy = true where f.id = new.dest_file_id and not f.home_copy;
    return null;
  end
  $$;

revoke all on function private.mark_home_copy_file() from public, anon, authenticated;

create trigger home_copy_files_mark after insert on private.home_copy_files
  for each row execute function private.mark_home_copy_file();

update private.stored_files f set home_copy = true
  where exists (select 1 from private.home_copy_files c where c.dest_file_id = f.id);

-- The upload intents, as before, with copied files left out of both limits.
create or replace function public.create_upload_intent(
  p_purpose text, p_content_type text, p_size bigint, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
  begin
    if p_request_id is null or p_size is null or p_size <= 0
       or private.upload_max_bytes(p_purpose) is null
       or p_size > private.upload_max_bytes(p_purpose)
       or not private.upload_type_allowed(p_purpose, p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;

    -- The pool lock also serialises one person's concurrent intents, so the checks below hold.
    v_pool := private.lock_storage_pool(v_user_id, null);

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = p_purpose and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.created_at > pg_catalog.now() - interval '1 hour'
          and not f.home_copy)
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now()
          and not f.home_copy)
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

    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, p_purpose, v_user_id, p_request_id, private.new_object_key('u'),
      private.new_object_key('u'), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;

    -- Cleans up after the intent ends, whatever happened to it.
    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', p_purpose, 'size', p_size)
    );

    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

create or replace function public.create_task_attachment_intent(
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
        where f.created_by = v_user_id and f.created_at > pg_catalog.now() - interval '1 hour'
          and not f.home_copy)
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now()
          and not f.home_copy)
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

create or replace function public.create_recipe_cover_intent(
  p_content_type text, p_size bigint, p_request_id uuid, p_recipe_id uuid default null,
  p_lock_token uuid default null
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text;
  begin
    if p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('recipe_cover')
       or not private.upload_type_allowed('recipe_cover', p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    if p_recipe_id is not null then
      -- Recipe first, then the pool: the same order as saving and deleting.
      v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
      if v_recipe.id is null then
        return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      if not private.can_edit_recipe(v_recipe, v_user_id) then
        return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      if v_recipe.status = 'published'
         and (p_lock_token is null or not private.holds_recipe_lock(v_recipe.id, v_user_id, p_lock_token)) then
        return query select 'lock_lost'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      v_pool := private.recipe_pool(v_recipe);
    else
      v_pool := private.lock_storage_pool(v_user_id, null);
    end if;

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'recipe_cover' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() and exists (
           select 1 from private.recipe_cover_uploads u
           where u.file_id = v_existing.id and u.recipe_id is not distinct from v_recipe.id) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.created_at > pg_catalog.now() - interval '1 hour'
          and not f.home_copy)
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now()
          and not f.home_copy)
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

    v_prefix := case when v_pool.owner_home_id is not null then 'h' else 'u' end;
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'recipe_cover', v_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    insert into private.recipe_cover_uploads (file_id, user_id, recipe_id)
      values (v_file.id, v_user_id, v_recipe.id);

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'recipe_cover', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

create or replace function private.open_pet_upload(
  p_user_id uuid, p_home_id uuid, p_purpose text, p_content_type text, p_size bigint, p_request_id uuid,
  p_pet_id uuid, p_entry_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
  begin
    v_pool := private.lock_storage_pool(null, p_home_id);
    select * into v_existing from private.stored_files f
      where f.created_by = p_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = p_purpose and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now()
         and (exists (select 1 from private.pet_photo_uploads u
                where u.file_id = v_existing.id and u.pet_id = p_pet_id and p_entry_id is null)
           or exists (select 1 from private.pet_medical_attachment_uploads u
                where u.file_id = v_existing.id and u.entry_id = p_entry_id)) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.created_at > pg_catalog.now() - interval '1 hour'
          and not f.home_copy)
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now()
          and not f.home_copy)
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

    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, p_purpose, p_user_id, p_request_id, private.new_object_key('h'),
      private.new_object_key('h'), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      p_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', p_purpose, 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

create or replace function private.open_photo_upload(
  p_user_id uuid, p_home_id uuid, p_content_type text, p_size bigint, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text := case when p_home_id is null then 'u' else 'h' end;
    v_kind text;
  begin
    v_pool := case when p_home_id is null then private.lock_storage_pool(p_user_id, null)
      else private.lock_storage_pool(null, p_home_id) end;
    select * into v_existing from private.stored_files f
      where f.created_by = p_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'photo' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.pool_id = v_pool.id and v_existing.expires_at > pg_catalog.now() then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.created_at > pg_catalog.now() - interval '1 hour'
          and not f.home_copy)
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now()
          and not f.home_copy)
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

    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'photo', p_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    foreach v_kind in array array['full', 'display', 'thumb'] loop
      insert into private.photo_variants (file_id, kind, object_key)
        values (v_file.id, v_kind, private.new_object_key(v_prefix));
    end loop;

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      p_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'photo', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

-- Home-level grants refuse children (S41 review M5) ----------------------------------------------------

alter function public.set_home_export_access(uuid, uuid, boolean) set schema private;
alter function private.set_home_export_access(uuid, uuid, boolean) rename to set_home_export_access_before_review_fixes;
alter function public.set_pet_medical_access(uuid, uuid, text) set schema private;
alter function private.set_pet_medical_access(uuid, uuid, text) rename to set_pet_medical_access_before_review_fixes;
alter function public.set_home_calendar_access(uuid, uuid, text) set schema private;
alter function private.set_home_calendar_access(uuid, uuid, text) rename to set_home_calendar_access_before_review_fixes;

-- Whether a membership of a Home the caller is in belongs to a child. A child's access comes from
-- the guardian preset model only, so these per-member grants answer 'not_permitted' for a child,
-- as they do for the Owner. Callers outside the Home get the original answers.
create function private.grant_target_is_child(p_home_id uuid, p_membership_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.is_home_member(p_home_id, auth.uid()) and exists (
    select 1 from public.home_memberships m
    where m.id = p_membership_id and m.home_id = p_home_id and private.is_child(m.user_id));
  $$;

create function public.set_home_export_access(p_home_id uuid, p_membership_id uuid, p_granted boolean)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_membership_id is not null and p_granted is not null
       and private.grant_target_is_child(p_home_id, p_membership_id) then
      return 'not_permitted';
    end if;
    return private.set_home_export_access_before_review_fixes(p_home_id, p_membership_id, p_granted);
  end
  $$;

create function public.set_pet_medical_access(p_home_id uuid, p_membership_id uuid, p_level text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_membership_id is not null and p_level in ('none', 'view', 'manage')
       and private.grant_target_is_child(p_home_id, p_membership_id) then
      return 'not_permitted';
    end if;
    return private.set_pet_medical_access_before_review_fixes(p_home_id, p_membership_id, p_level);
  end
  $$;

create function public.set_home_calendar_access(p_home_id uuid, p_membership_id uuid, p_level text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_membership_id is not null and p_level in ('view', 'edit', 'edit_delete')
       and private.grant_target_is_child(p_home_id, p_membership_id) then
      return 'not_permitted';
    end if;
    return private.set_home_calendar_access_before_review_fixes(p_home_id, p_membership_id, p_level);
  end
  $$;

-- Grants children already hold that widen their access: the Home export, pet medical access and
-- calendar deletion (a narrower calendar level stays: it only restricts).
delete from private.home_export_grants g where private.is_child(g.user_id);
delete from private.pet_medical_access a where private.is_child(a.user_id);
delete from private.home_calendar_access a where a.level = 'edit_delete' and private.is_child(a.user_id);

-- Displays: a claim does not count as the display being seen (S43 review M3) --------------------------

-- As S43, but last_seen_at is set only by display_me, the display's first request with its new
-- session. A claim whose answer never reached the tablet then shows as "not seen yet" instead of
-- "last seen just now", so the manager can tell it apart and revoke it.
create or replace function public.display_pairing_complete(p_secret_hash text, p_session_id uuid)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_r private.display_pairing_requests := private.claimable_pairing(p_secret_hash);
    v_display private.household_displays;
  begin
    if v_r.id is null then
      return 'invalid';
    end if;
    select * into v_display from private.household_displays d where d.id = v_r.display_id;
    if p_session_id is null
       or not exists (
         select 1 from auth.sessions s
         where s.id = p_session_id and s.user_id = v_display.user_id
           and s.created_at > v_r.approved_at - interval '1 minute'
       )
       or exists (select 1 from private.display_sessions ds where ds.session_id = p_session_id) then
      return 'invalid';
    end if;
    update private.display_pairing_requests r
      set status = 'claimed', claimed_at = pg_catalog.now()
      where r.id = v_r.id;
    insert into private.display_sessions (session_id, display_id) values (p_session_id, v_display.id);
    perform private.audit('display.signed_in', v_display.home_id, 'household_display',
      v_display.id, '{}'::jsonb);
    return 'registered';
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'update_chore_series', 'delete_chore_occurrences', 'change_vacation_participation',
      'answer_vacation_date_proposal', 'set_home_export_access', 'set_pet_medical_access',
      'set_home_calendar_access'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like '%before_review_fixes'
      or p.proname in ('chore_entry_blocked_by_end', 'trash_conflict', 'trash_item_restore',
        'vacation_has_ended', 'grant_target_is_child'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
