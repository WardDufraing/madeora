-- S21c: the chore schedule (overview widget and Chores calendar), moving one occurrence with its
-- effects, personal chore reminders and the chore manager's daily summary (brief
-- plans/steps/S21-brief.md; ADR 0028; spec "Confirmed Home chore overview layouts", "Confirmed
-- chore calendar and rescheduling", "Confirmed individual chore reminders" and "Confirmed daily
-- manager summary of overdue chores").
--
-- Schedule: one read of a Home's chores between two dates, for the Chore schedule widget and the
-- Chores calendar. Occurrences that exist are listed with their state; later dates of a recurring
-- chore that are not created yet (S20 creates them lazily, up to one ahead) are projected from the
-- chore's current part with the assignees its rule gives, marked as projected and never movable.
--
-- Moving: the calendar moves one open occurrence with update_chore_occurrence (S20), which now also
-- reports what the move ends or shifts: whether it becomes overdue, personal reminders that move or
-- end, and an open handover or volunteer request that ends. Only that occurrence changes.
--
-- Reminders: an assignee keeps one personal reminder per occurrence (private.chore_reminders), at a
-- date and time or N days (0-30) before the due day at a time they choose, in the Home's timezone.
-- Setting one queues the chore-reminder job for that moment with the reminder's revision; delivery
-- re-checks everything (still the current revision, the occurrence open, the person still assigned
-- and a member) and notifies through private.notify_user (category 'reminders'). A reminder ends
-- when its person stops being assigned (a deferred check, so replacing the assignee list with the
-- same people keeps it) and when the occurrence is completed, skipped, expires or goes to the
-- trash. A before-due reminder follows a changed due date; one whose new moment has passed ends.
--
-- Daily summary: a chore manager opts in per Home (off by default) and picks an hour in their own
-- timezone. The hourly chore-digest schedule sends at most one in-app notice per Home, manager and
-- local day, only when something qualifies (overdue assigned or unassigned, waiting for review or in
-- rework, in assignment review, automatic release within 24 hours). The notice carries counts only;
-- its link opens the live Summary page, which checks the reader's rights when it opens. Email follows
-- the person's 'chores' choices and quiet hours. Nothing here changes a chore.

-- Reminders ---------------------------------------------------------------------------------------------

-- status: 'scheduled' (waiting for its moment), 'sent', 'ended' (its person stopped being assigned,
-- the occurrence closed, a moved due day put it in the past, or it was removed).
create table private.chore_reminders (
  occurrence_id uuid not null references private.chore_occurrences (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null constraint chore_reminders_mode_check check (mode in ('absolute', 'relative')),
  local_at timestamp,
  days_before smallint constraint chore_reminders_days_check check (days_before between 0 and 30),
  time_of_day time,
  fire_at timestamptz,
  status text not null constraint chore_reminders_status_check
    check (status in ('scheduled', 'sent', 'ended')),
  revision integer not null default 1 constraint chore_reminders_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  primary key (occurrence_id, user_id),
  constraint chore_reminders_shape_check check (
    (mode = 'absolute' and local_at is not null and days_before is null and time_of_day is null)
    or (mode = 'relative' and local_at is null and days_before is not null and time_of_day is not null)),
  constraint chore_reminders_fire_check check (status <> 'scheduled' or fire_at is not null)
);

create index chore_reminders_user_idx on private.chore_reminders (user_id);

alter table private.chore_reminders enable row level security;
revoke all on table private.chore_reminders from public, anon, authenticated;

-- The wall-clock moment of a reminder for a due day.
create function private.chore_reminder_local(
  p_mode text, p_local_at timestamp, p_due date, p_days integer, p_time time
) returns timestamp
  language sql immutable set search_path = '' as $$
  select case when p_mode = 'absolute' then p_local_at
    else private.reminder_local(p_due, p_days, p_time) end;
  $$;

-- Writes a reminder (a new revision) and queues its delivery. A moment already past ends it.
create function private.put_chore_reminder(
  p_occurrence private.chore_occurrences, p_user_id uuid, p_mode text, p_local_at timestamp,
  p_days integer, p_time time
) returns private.chore_reminders
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_zone text := private.home_zone(p_occurrence.home_id);
    v_fire timestamptz := private.chore_reminder_local(p_mode, p_local_at, p_occurrence.due_date,
      p_days, p_time) at time zone v_zone;
    v_row private.chore_reminders;
  begin
    insert into private.chore_reminders as r (
      occurrence_id, user_id, mode, local_at, days_before, time_of_day, fire_at, status
    ) values (
      p_occurrence.id, p_user_id, p_mode, case when p_mode = 'absolute' then p_local_at end,
      case when p_mode = 'relative' then p_days end, case when p_mode = 'relative' then p_time end,
      v_fire, case when v_fire > pg_catalog.now() then 'scheduled' else 'ended' end
    )
    on conflict (occurrence_id, user_id) do update
      set mode = excluded.mode, local_at = excluded.local_at, days_before = excluded.days_before,
        time_of_day = excluded.time_of_day, fire_at = excluded.fire_at, status = excluded.status,
        revision = r.revision + 1, updated_at = pg_catalog.now(), delivered_at = null
    returning * into v_row;
    if v_row.status = 'scheduled' then
      perform private.enqueue_job(
        'chore-reminder', 1,
        'chore-reminder:' || p_occurrence.id::text || ':' || p_user_id::text || ':' || v_row.revision::text,
        pg_catalog.jsonb_build_object('occurrenceId', p_occurrence.id, 'userId', p_user_id,
          'revision', v_row.revision),
        private.request_correlation_id(), v_row.fire_at);
    end if;
    return v_row;
  end
  $$;

-- Ends an occurrence's scheduled reminders (one person's, or everyone's for null): a new revision,
-- so a queued job finds it stale. Returns how many ended.
create function private.end_chore_reminders(p_occurrence_id uuid, p_user_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    update private.chore_reminders r
      set status = 'ended', revision = r.revision + 1, updated_at = pg_catalog.now()
      where r.occurrence_id = p_occurrence_id and (p_user_id is null or r.user_id = p_user_id)
        and r.status = 'scheduled';
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;

-- A person who is no longer assigned at the end of the transaction loses their reminder. Deferred:
-- private.set_occurrence_assignees replaces the whole list, and someone kept keeps their reminder.
create function private.chore_reminder_unassigned() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if not exists (
      select 1 from private.chore_occurrence_assignees a
      where a.occurrence_id = old.occurrence_id and a.user_id = old.user_id
    ) then
      perform private.end_chore_reminders(old.occurrence_id, old.user_id);
    end if;
    return null;
  end
  $$;

create constraint trigger chore_occurrence_assignees_reminders
  after delete on private.chore_occurrence_assignees
  deferrable initially deferred for each row execute function private.chore_reminder_unassigned();

-- A closed occurrence ends its reminders; a moved due day moves the before-due ones (a new revision
-- and job), or ends those whose new moment has passed. Waiting for approval keeps them: delivery
-- skips an occurrence that is not open, and a rejection makes it open again. A moved due day of a
-- claimed occurrence also queues its automatic release for the new deadline (a single edit, bulk
-- or series change alike); the old job finds itself not due and does nothing.
create function private.chore_reminder_occurrence_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_reminder private.chore_reminders;
    v_chore private.chores;
  begin
    if new.deleted_at is not null or new.status in ('completed', 'skipped', 'expired') then
      perform private.end_chore_reminders(new.id, null);
      return null;
    end if;
    if new.due_date is distinct from old.due_date then
      for v_reminder in
        select * from private.chore_reminders r
        where r.occurrence_id = new.id and r.status = 'scheduled' and r.mode = 'relative'
      loop
        perform private.put_chore_reminder(new, v_reminder.user_id, 'relative', null,
          v_reminder.days_before, v_reminder.time_of_day);
      end loop;
      if new.status = 'open' and new.claimed_by is not null then
        select * into v_chore from private.chores c where c.id = new.chore_id;
        perform private.schedule_chore_release(new, v_chore);
      end if;
    end if;
    return null;
  end
  $$;

create trigger chore_occurrences_reminders
  after update of status, deleted_at, due_date on private.chore_occurrences
  for each row execute function private.chore_reminder_occurrence_changed();

-- The caller's reminder on an occurrence, with whether they may set one (an assignee of an open
-- occurrence), the Home's timezone and their channels for reminders. Null when not visible.
create function public.get_chore_reminder(p_occurrence_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_reminder private.chore_reminders;
    v_zone text;
  begin
    select * into v_occurrence from private.chore_occurrences o where o.id = p_occurrence_id;
    if not found or v_occurrence.deleted_at is not null
       or not private.is_home_member(v_occurrence.home_id, v_user_id) then
      return null;
    end if;
    select * into v_reminder from private.chore_reminders r
      where r.occurrence_id = v_occurrence.id and r.user_id = v_user_id;
    v_zone := private.home_zone(v_occurrence.home_id);
    return pg_catalog.jsonb_build_object(
      'occurrenceId', v_occurrence.id,
      'dueDate', v_occurrence.due_date,
      'timeZone', v_zone,
      'canSet', v_occurrence.status in ('open', 'pending_approval') and exists (
        select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_user_id),
      'reminder', case when v_reminder.occurrence_id is null or v_reminder.status = 'ended' then null
        else pg_catalog.jsonb_build_object(
          'mode', v_reminder.mode,
          'localAt', v_reminder.local_at,
          'daysBefore', v_reminder.days_before,
          'time', pg_catalog.to_char(v_reminder.time_of_day, 'HH24:MI'),
          'fireAt', v_reminder.fire_at,
          'dst', private.zoned_dst_case(private.chore_reminder_local(v_reminder.mode,
            v_reminder.local_at, v_occurrence.due_date, v_reminder.days_before,
            v_reminder.time_of_day), v_zone),
          'status', v_reminder.status) end,
      'revision', coalesce(v_reminder.revision, 0),
      'channels', pg_catalog.jsonb_build_object(
        'inApp', private.effective_notification_channel(v_user_id, v_occurrence.home_id, 'reminders', 'in_app'),
        'email', private.effective_notification_channel(v_user_id, v_occurrence.home_id, 'reminders', 'email')
          and private.confirmed_email(v_user_id) is not null)
    );
  end
  $$;

-- Sets the caller's reminder on an occurrence they are assigned to, at the revision they saw.
-- p_mode 'absolute' (p_local_at, wall clock in the Home's timezone) or 'relative' (p_days_before
-- 0-30 and p_time). p_dry_run answers the moment and its daylight-saving case without saving.
-- Outcomes: 'preview', 'saved', 'in_past', 'not_assignee', 'occurrence_closed', 'conflict',
-- 'not_found'.
create function public.set_chore_reminder(
  p_occurrence_id uuid, p_mode text, p_expected_revision integer, p_dry_run boolean,
  p_local_at timestamp default null, p_days_before integer default null, p_time time default null
) returns table (outcome text, fire_at timestamptz, dst text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_reminder private.chore_reminders;
    v_zone text;
    v_local timestamp;
    v_fire timestamptz;
  begin
    if p_occurrence_id is null or p_mode is null or p_mode not in ('absolute', 'relative')
       or p_expected_revision is null or p_dry_run is null
       or (p_mode = 'absolute' and (p_local_at is null or p_days_before is not null or p_time is not null))
       or (p_mode = 'relative' and (p_local_at is not null or p_time is null
         or p_days_before is null or p_days_before not between 0 and private.task_limit('reminder_days'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::timestamptz, null::text, null::integer;
      return;
    end if;
    if v_occurrence.status not in ('open', 'pending_approval') then
      return query select 'occurrence_closed', null::timestamptz, null::text, null::integer;
      return;
    end if;
    if not exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_user_id) then
      return query select 'not_assignee', null::timestamptz, null::text, null::integer;
      return;
    end if;
    select * into v_reminder from private.chore_reminders r
      where r.occurrence_id = v_occurrence.id and r.user_id = v_user_id for update;
    if coalesce(v_reminder.revision, 0) <> p_expected_revision then
      return query select 'conflict', null::timestamptz, null::text, coalesce(v_reminder.revision, 0);
      return;
    end if;
    v_zone := private.home_zone(v_occurrence.home_id);
    v_local := private.chore_reminder_local(p_mode, p_local_at, v_occurrence.due_date, p_days_before, p_time);
    v_fire := v_local at time zone v_zone;
    if v_fire <= pg_catalog.now() then
      return query select 'in_past', v_fire, private.zoned_dst_case(v_local, v_zone), null::integer;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_fire, private.zoned_dst_case(v_local, v_zone),
        coalesce(v_reminder.revision, 0);
      return;
    end if;
    v_reminder := private.put_chore_reminder(v_occurrence, v_user_id, p_mode, p_local_at,
      p_days_before, p_time);
    return query select 'saved', v_reminder.fire_at, private.zoned_dst_case(v_local, v_zone),
      v_reminder.revision;
  end
  $$;

-- Removes the caller's reminder on an occurrence. Outcomes: 'removed', 'conflict', 'not_found'.
create function public.remove_chore_reminder(p_occurrence_id uuid, p_expected_revision integer)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_reminder private.chore_reminders;
  begin
    if p_occurrence_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    select * into v_reminder from private.chore_reminders r
      where r.occurrence_id = v_occurrence.id and r.user_id = v_user_id for update;
    if v_reminder.occurrence_id is null or v_reminder.status = 'ended' then
      return query select 'removed', coalesce(v_reminder.revision, 0);
      return;
    end if;
    if v_reminder.revision <> p_expected_revision then
      return query select 'conflict', v_reminder.revision;
      return;
    end if;
    update private.chore_reminders r
      set status = 'ended', revision = r.revision + 1, updated_at = pg_catalog.now()
      where r.occurrence_id = v_occurrence.id and r.user_id = v_user_id
      returning * into v_reminder;
    return query select 'removed', v_reminder.revision;
  end
  $$;

-- Delivers a reminder (the chore-reminder job; service role only). Re-checks everything at delivery
-- and notifies once per person and revision. Outcomes: 'notified', 'not_sent' (no longer
-- applicable), 'stale' (a newer revision or not scheduled), 'not_due' (early: the job retries).
create function public.deliver_chore_reminder(p_occurrence_id uuid, p_user_id uuid, p_revision integer)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_reminder private.chore_reminders;
    v_occurrence private.chore_occurrences;
  begin
    if p_occurrence_id is null or p_user_id is null or p_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform 1 from private.chores c
      where c.id = (select o.chore_id from private.chore_occurrences o where o.id = p_occurrence_id)
      for update;
    select * into v_occurrence from private.chore_occurrences o where o.id = p_occurrence_id for update;
    select * into v_reminder from private.chore_reminders r
      where r.occurrence_id = p_occurrence_id and r.user_id = p_user_id for update;
    if v_reminder.occurrence_id is null or v_reminder.revision <> p_revision
       or v_reminder.status <> 'scheduled' then
      return 'stale';
    end if;
    if v_reminder.fire_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    if v_occurrence.deleted_at is not null or v_occurrence.status <> 'open'
       or not private.is_home_member(v_occurrence.home_id, p_user_id)
       or not exists (select 1 from private.chore_occurrence_assignees a
         where a.occurrence_id = p_occurrence_id and a.user_id = p_user_id) then
      update private.chore_reminders r set status = 'ended', delivered_at = pg_catalog.now()
        where r.occurrence_id = p_occurrence_id and r.user_id = p_user_id;
      return 'not_sent';
    end if;
    perform private.notify_user(
      p_user_id, v_occurrence.home_id, 'reminders', 'chore.reminder',
      pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id,
        'dueDate', v_occurrence.due_date),
      'chore-reminder:' || p_occurrence_id::text || ':' || p_user_id::text || ':' || p_revision::text,
      true);
    update private.chore_reminders r set status = 'sent', delivered_at = pg_catalog.now()
      where r.occurrence_id = p_occurrence_id and r.user_id = p_user_id;
    return 'notified';
  end
  $$;

-- Moving one occurrence reports its effects ---------------------------------------------------------------

alter function public.update_chore_occurrence(uuid, integer, boolean, date, uuid[], boolean, integer, jsonb, boolean)
  set schema private;
alter function private.update_chore_occurrence(uuid, integer, boolean, date, uuid[], boolean, integer, jsonb, boolean)
  rename to update_chore_occurrence_before_reminders;

-- S20's change to one occurrence, whose impact also says what a new due date or assignee does
-- (S21; spec "Confirmed chore calendar and rescheduling"): 'overdue' (due before the Home's today
-- after the change), 'remindersMoved', 'remindersEnded', 'handoverEnded' (an open handover request
-- of a changed assignment) and 'volunteerEnded' (an open volunteer request, resolved by an assignee
-- or expired by a past deadline), and 'releaseNow' (a claim kept by the change whose automatic
-- release moment has passed with the new due date, so it goes back to the pool at once). Counted
-- under the chore lock before the change. A change with releaseNow is made only with
-- p_confirm_release (spec: an immediate release is previewed and confirmed); otherwise the answer is
-- needs_confirmation with the impact.
create function public.update_chore_occurrence(
  p_occurrence_id uuid, p_expected_revision integer, p_dry_run boolean,
  p_due_date date default null, p_assignee_ids uuid[] default null,
  p_set_minutes boolean default false, p_minutes integer default null,
  p_steps jsonb default null, p_confirm_checklist boolean default false,
  p_confirm_release boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_due date;
    v_users uuid[];
    v_current uuid[];
    v_assignment_changed boolean;
    v_zone text;
    v_extra jsonb := '{}'::jsonb;
    v_chore private.chores;
    v_moved private.chore_occurrences;
    v_release_now boolean := false;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is not null and (p_due_date is not null or p_assignee_ids is not null) then
      v_due := coalesce(p_due_date, v_occurrence.due_date);
      v_zone := private.home_zone(v_occurrence.home_id);
      select coalesce(array_agg(a.user_id order by a.user_id), '{}') into v_current
        from private.chore_occurrence_assignees a where a.occurrence_id = v_occurrence.id;
      v_users := case when p_assignee_ids is null then v_current
        else coalesce(private.chore_member_users(v_occurrence.home_id, p_assignee_ids), v_current) end;
      v_assignment_changed := p_assignee_ids is not null and not (v_users @> v_current and v_current @> v_users);
      if v_occurrence.status = 'open' and v_occurrence.claimed_by is not null
         and not v_assignment_changed and v_due <> v_occurrence.due_date then
        select * into v_chore from private.chores c where c.id = v_occurrence.chore_id;
        v_moved := v_occurrence;
        v_moved.due_date := v_due;
        v_release_now := coalesce(private.chore_release_at(v_moved, v_chore, v_zone) <= pg_catalog.now(), false)
          and coalesce(private.chore_release_at(v_occurrence, v_chore, v_zone) > pg_catalog.now(), false);
      end if;
      v_extra := pg_catalog.jsonb_build_object(
        'overdue', v_due < private.task_today(v_occurrence.home_id, null),
        'remindersMoved', (select count(*)::integer from private.chore_reminders r
          where r.occurrence_id = v_occurrence.id and r.status = 'scheduled' and r.mode = 'relative'
            and r.user_id = any (v_users) and v_due <> v_occurrence.due_date
            and private.reminder_local(v_due, r.days_before, r.time_of_day) at time zone v_zone > pg_catalog.now()),
        'remindersEnded', (select count(*)::integer from private.chore_reminders r
          where r.occurrence_id = v_occurrence.id and r.status = 'scheduled'
            and (not (r.user_id = any (v_users))
              or (r.mode = 'relative' and v_due <> v_occurrence.due_date
                and private.reminder_local(v_due, r.days_before, r.time_of_day) at time zone v_zone <= pg_catalog.now()))),
        'handoverEnded', v_assignment_changed and exists (select 1 from private.chore_reassignment_requests q
          where q.occurrence_id = v_occurrence.id and q.status in ('pending', 'awaiting_manager')),
        'volunteerEnded', exists (select 1 from private.chore_volunteer_requests q
          where q.occurrence_id = v_occurrence.id and q.status = 'open')
          and (cardinality(v_users) > 0
            or ((v_due + 1)::timestamp at time zone v_zone) <= pg_catalog.now()),
        'releaseNow', v_release_now);
    end if;
    if v_release_now and not coalesce(p_dry_run, false) and not coalesce(p_confirm_release, false) then
      -- Checked as a preview: anything else that refuses the change still answers first.
      return query
        select case when u.outcome = 'preview' then 'needs_confirmation' else u.outcome end,
          case when u.impact is null then null else u.impact || v_extra end, u.revision
        from private.update_chore_occurrence_before_reminders(p_occurrence_id, p_expected_revision,
          true, p_due_date, p_assignee_ids, p_set_minutes, p_minutes, p_steps,
          p_confirm_checklist) u;
      return;
    end if;
    return query
      select u.outcome, case when u.impact is null then null else u.impact || v_extra end, u.revision
      from private.update_chore_occurrence_before_reminders(p_occurrence_id, p_expected_revision,
        p_dry_run, p_due_date, p_assignee_ids, p_set_minutes, p_minutes, p_steps,
        p_confirm_checklist) u;
  end
  $$;

-- The chore schedule ----------------------------------------------------------------------------------------

create function private.chore_schedule_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'days' then 42        -- the longest range one read covers (a month view of six weeks)
    when 'items' then 600      -- items one read returns
    when 'summary_items' then 50 -- occurrences per group on the Summary page
    when 'digests' then 200    -- summaries one hourly run considers
  end;
  $$;

-- A Home's chores between two dates (inclusive), for the schedule widget and the calendar: every
-- occurrence due then (any state, not in the trash) and the dates of recurring chores not created
-- yet, projected from their current part (assignees by its rule, null for an empty place). Each
-- item's member ids are membership ids. 42501 for a Home the caller is not in.
create function public.list_chore_schedule(p_home_id uuid, p_from date, p_to date) returns jsonb
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
          'overdue', o.status = 'open' and o.due_date < v_today,
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

-- The daily summary ---------------------------------------------------------------------------------------

create table private.chore_summary_settings (
  home_id uuid not null,
  user_id uuid not null,
  enabled boolean not null default false,
  -- The hour (0-23) in time_zone, the person's own timezone when they saved it.
  send_hour smallint not null default 8 constraint chore_summary_settings_hour_check
    check (send_hour between 0 and 23),
  time_zone text not null constraint chore_summary_settings_zone_check
    check (private.valid_time_zone(time_zone)),
  -- The local day of the last run that looked at this setting (sent or nothing to report).
  last_day date,
  revision integer not null default 1 constraint chore_summary_settings_revision_check check (revision >= 1),
  updated_at timestamptz not null default now(),
  primary key (home_id, user_id),
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index chore_summary_settings_due_idx on private.chore_summary_settings (enabled, last_day);

alter table private.chore_summary_settings enable row level security;
revoke all on table private.chore_summary_settings from public, anon, authenticated;

-- What qualifies for a Home's summary now, as counts.
create function private.chore_summary_counts(p_home_id uuid) returns jsonb
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
    'overdueAssigned', count(*) filter (where b.status = 'open' and b.due_date < t.d and b.assigned > 0),
    'overdueUnassigned', count(*) filter (where b.status = 'open' and b.due_date < t.d and b.assigned = 0),
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

-- The caller's summary setting for a Home. 42501 for a Home they are not in.
create function public.get_chore_summary_setting(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_setting private.chore_summary_settings;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    select * into v_setting from private.chore_summary_settings s
      where s.home_id = p_home_id and s.user_id = v_user_id;
    return pg_catalog.jsonb_build_object(
      'canManage', private.can_manage_chores(p_home_id, v_user_id),
      'enabled', coalesce(v_setting.enabled, false),
      'hour', coalesce(v_setting.send_hour, 8),
      'timeZone', v_setting.time_zone,
      'revision', coalesce(v_setting.revision, 0));
  end
  $$;

-- Turns the caller's daily summary for a Home on or off (chore managers), at the hour in their own
-- timezone, at the revision they saw. Outcomes: 'saved', 'conflict', 'not_permitted'.
create function public.set_chore_summary_setting(
  p_home_id uuid, p_enabled boolean, p_hour integer, p_time_zone text, p_expected_revision integer
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_setting private.chore_summary_settings;
  begin
    if p_home_id is null or p_enabled is null or p_hour is null or p_hour not between 0 and 23
       or p_expected_revision is null or not private.valid_time_zone(p_time_zone) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.require_chore_home(p_home_id, v_user_id);
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    select * into v_setting from private.chore_summary_settings s
      where s.home_id = p_home_id and s.user_id = v_user_id for update;
    if coalesce(v_setting.revision, 0) <> p_expected_revision then
      return query select 'conflict', coalesce(v_setting.revision, 0);
      return;
    end if;
    insert into private.chore_summary_settings as s (home_id, user_id, enabled, send_hour, time_zone)
      values (p_home_id, v_user_id, p_enabled, p_hour, p_time_zone)
    on conflict (home_id, user_id) do update
      set enabled = excluded.enabled, send_hour = excluded.send_hour, time_zone = excluded.time_zone,
        revision = s.revision + 1, updated_at = pg_catalog.now()
    returning * into v_setting;
    return query select 'saved', v_setting.revision;
  end
  $$;

-- The live Summary page (chore managers): the counts and up to 50 occurrences per group, earliest
-- due first. Anyone else gets canManage false and nothing else. 42501 for a Home they are not in.
create function public.get_chore_summary(p_home_id uuid) returns jsonb
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
            when o.due_date < v_today and exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id) then 'overdueAssigned'
            when o.due_date < v_today then 'overdueUnassigned'
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

-- The hourly run (chore-digest; service role only): for each enabled setting whose hour has come on
-- a local day not yet handled, a summary notice when something qualifies and the person still
-- manages the Home's chores. At most one per Home, manager and local day (the day is recorded, and
-- the notice's dedupe key carries it). Returns how many notices it sent.
create function public.send_chore_summaries(p_limit integer) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_setting private.chore_summary_settings;
    v_local timestamp;
    v_counts jsonb;
    v_sent integer := 0;
  begin
    if p_limit is null or p_limit not between 1 and private.chore_schedule_limit('digests') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    for v_setting in
      select s.* from private.chore_summary_settings s
      where s.enabled
        and (s.last_day is null or s.last_day < (pg_catalog.now() at time zone s.time_zone)::date)
        and extract(hour from pg_catalog.now() at time zone s.time_zone) >= s.send_hour
      order by s.last_day nulls first, s.home_id, s.user_id
      limit p_limit
      for update skip locked
    loop
      v_local := pg_catalog.now() at time zone v_setting.time_zone;
      update private.chore_summary_settings s set last_day = v_local::date
        where s.home_id = v_setting.home_id and s.user_id = v_setting.user_id;
      if private.can_manage_chores(v_setting.home_id, v_setting.user_id) then
        v_counts := private.chore_summary_counts(v_setting.home_id);
        if (select sum(v.value::integer) from pg_catalog.jsonb_each_text(v_counts) v) > 0 then
          perform private.notify_user(
            v_setting.user_id, v_setting.home_id, 'chores', 'chore.manager_summary',
            v_counts || pg_catalog.jsonb_build_object('homeId', v_setting.home_id),
            'chore-summary:' || v_setting.home_id::text || ':' || v_setting.user_id::text || ':'
              || (v_local::date)::text,
            true);
          v_sent := v_sent + 1;
        end if;
      end if;
    end loop;
    return v_sent;
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
      'update_chore_occurrence', 'get_chore_reminder', 'set_chore_reminder', 'remove_chore_reminder',
      'list_chore_schedule', 'get_chore_summary_setting', 'set_chore_summary_setting',
      'get_chore_summary'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The jobs: the service role only.
  execute 'revoke all on function public.deliver_chore_reminder(uuid, uuid, integer) from public, anon, authenticated';
  execute 'grant execute on function public.deliver_chore_reminder(uuid, uuid, integer) to service_role';
  execute 'revoke all on function public.send_chore_summaries(integer) from public, anon, authenticated';
  execute 'grant execute on function public.send_chore_summaries(integer) to service_role';

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like '%chore%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
