-- UX3a: work periods as flagged native recurring calendar events (brief plans/steps/UX3a-brief.md;
-- plans/steps/UX00-redesign-plan-brief.md, Ward's answer of 2026-11-19; Modules.md §4.2).
--
-- A work period is a personal calendar event with `work_period = true`: a shift pattern is a recurring
-- event, a changed or cancelled shift is a native recurrence exception, and the flag lets the interface
-- draw it as a background block. Everything else (recurrence, exceptions, reminders, trash, export,
-- limits, permissions) is the existing event machinery.
--
-- Privacy (§4.2 / §11.2): a work period is visible to its owner only. It cannot belong to a Home and
-- cannot be shared with a Home, so it never reaches another member, not even as a busy block.
--
-- Rollback: drop the two triggers and the `work_period` column, then restore
-- private.calendar_values and private.calendar_occurrence_json from 20261118090000_calendar.sql, and
-- private.copy_item_eligible from 20261128090000_category_deletion_home_copies.sql.
-- Rows flagged as work periods turn into ordinary personal events.

alter table private.calendar_events
  add column work_period boolean not null default false,
  add constraint calendar_events_work_period_personal check (not work_period or (home_id is null and owner_user_id is not null));

-- The flag is fixed when the event is created.
create function private.calendar_work_period_fixed() returns trigger
  language plpgsql set search_path = '' as $$
  begin
    if new.work_period is distinct from old.work_period then
      raise exception 'work period flag cannot change' using errcode = '22023';
    end if;
    return new;
  end
  $$;
create trigger calendar_events_work_period_fixed before update of work_period on private.calendar_events
  for each row execute function private.calendar_work_period_fixed();

-- A work period is never shared with a Home.
create function private.calendar_work_period_unshared() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if exists (select 1 from private.calendar_events e where e.id = new.event_id and e.work_period) then
      raise exception 'work periods cannot be shared' using errcode = '22023';
    end if;
    return new;
  end
  $$;
create trigger calendar_event_shares_no_work_period before insert on private.calendar_event_shares
  for each row execute function private.calendar_work_period_unshared();

-- Reading: every occurrence says whether it is a work period (series and detail reads build on it).
create or replace function private.calendar_occurrence_json(
  p_event private.calendar_events, p_occurrence private.calendar_occurrence, p_viewer uuid, p_home_id uuid,
  p_zone text
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'eventId', p_event.id,
    'on', case when p_event.frequency is not null then p_occurrence.original_date end,
    'kind', private.calendar_kind(p_event, p_viewer),
    'sharedBy', case when private.calendar_kind(p_event, p_viewer) = 'shared'
      then private.member_ref(p_home_id, p_event.owner_user_id) end,
    'title', p_occurrence.title,
    'location', p_occurrence.location,
    'allDay', p_occurrence.all_day,
    'from', case when p_occurrence.all_day then p_occurrence.starts_on
      else (private.calendar_start_at(p_occurrence, p_event.timezone) at time zone p_zone)::date end,
    'to', case when p_occurrence.all_day then p_occurrence.ends_on
      else ((private.calendar_end_at(p_occurrence, p_event.timezone) - interval '1 microsecond')
        at time zone p_zone)::date end,
    'startsAt', private.calendar_start_at(p_occurrence, p_event.timezone),
    'endsAt', private.calendar_end_at(p_occurrence, p_event.timezone),
    'timezone', p_event.timezone,
    'recurring', p_event.frequency is not null,
    'changed', p_occurrence.is_exception,
    'participants', private.calendar_participants_json(p_event.home_id, p_occurrence.participants),
    'workPeriod', p_event.work_period
  );
  $$;

-- Reading request values: `workPeriod` (boolean, default false). The create call and a "this and following" change take it from the body.
create or replace function private.calendar_values(p_body jsonb, p_with_repeat boolean) returns private.calendar_events
  language plpgsql stable set search_path = '' as $$
  declare
    v private.calendar_events;
    v_repeat jsonb;
    v_weekdays smallint[];
    v_reminder numeric;
  begin
    if p_body is null or pg_catalog.jsonb_typeof(p_body) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v.title := private.pet_json_text(p_body, 'title', 200, true);
    if v.title is null then
      raise exception 'invalid title' using errcode = '22023';
    end if;
    v.location := private.pet_json_text(p_body, 'location', 200, true);
    v.description := private.pet_json_text(p_body, 'description', 4000, false);
    v.all_day := private.pet_json_bool(p_body, 'allDay');
    v.starts_on := private.pet_json_date(p_body, 'startsOn');
    v.ends_on := private.pet_json_date(p_body, 'endsOn');
    v.start_time := private.calendar_json_time(p_body, 'startTime');
    v.end_time := private.calendar_json_time(p_body, 'endTime');
    v.timezone := case when pg_catalog.jsonb_typeof(p_body -> 'timezone') = 'string' then p_body ->> 'timezone' end;
    if v.all_day is null or v.starts_on is null or v.ends_on is null
       or not private.calendar_valid_zone(v.timezone)
       or (v.all_day and (v.start_time is not null or v.end_time is not null))
       or (not v.all_day and (v.start_time is null or v.end_time is null)) then
      raise exception 'invalid time' using errcode = '22023';
    end if;
    if p_with_repeat and pg_catalog.jsonb_typeof(p_body -> 'repeat') = 'object' then
      v_repeat := p_body -> 'repeat';
      v.frequency := private.pet_json_choice(v_repeat, 'frequency', array['daily', 'weekly', 'monthly', 'yearly']);
      if pg_catalog.jsonb_typeof(v_repeat -> 'interval') <> 'number' or (v_repeat ->> 'interval') !~ '^[0-9]{1,2}$' then
        raise exception 'invalid interval' using errcode = '22023';
      end if;
      v.interval_count := (v_repeat ->> 'interval')::integer;
      if pg_catalog.jsonb_typeof(v_repeat -> 'weekdays') = 'array' then
        if exists (select 1 from pg_catalog.jsonb_array_elements(v_repeat -> 'weekdays') d
            where pg_catalog.jsonb_typeof(d) <> 'number' or (d #>> '{}') !~ '^[1-7]$') then
          raise exception 'invalid weekdays' using errcode = '22023';
        end if;
        select pg_catalog.array_agg(d::smallint order by d::smallint) into v_weekdays
          from pg_catalog.jsonb_array_elements_text(v_repeat -> 'weekdays') d;
        v.weekdays := v_weekdays;
      elsif v_repeat ? 'weekdays' and pg_catalog.jsonb_typeof(v_repeat -> 'weekdays') <> 'null' then
        raise exception 'invalid weekdays' using errcode = '22023';
      end if;
      v.repeat_ends_on := private.pet_json_date(v_repeat, 'endsOn');
      if v_repeat ? 'count' and pg_catalog.jsonb_typeof(v_repeat -> 'count') <> 'null' then
        if pg_catalog.jsonb_typeof(v_repeat -> 'count') <> 'number'
           or (v_repeat ->> 'count') !~ '^[0-9]{1,4}$' then
          raise exception 'invalid count' using errcode = '22023';
        end if;
        v.max_count := (v_repeat ->> 'count')::integer;
      end if;
      if not private.valid_series_rule(v.frequency, v.interval_count, v.weekdays, v.starts_on, v.repeat_ends_on,
          v.max_count) then
        raise exception 'invalid repeat' using errcode = '22023';
      end if;
      v.until_date := private.series_until(v.frequency, v.interval_count, v.weekdays, v.starts_on,
        v.repeat_ends_on, v.max_count);
    elsif p_with_repeat and p_body ? 'repeat' and pg_catalog.jsonb_typeof(p_body -> 'repeat') <> 'null' then
      raise exception 'invalid repeat' using errcode = '22023';
    end if;
    -- The reminder belongs to the whole event (one occurrence's change keeps it).
    if p_with_repeat then
      v_reminder := private.pet_json_number(p_body, 'reminder');
      if v_reminder is not null and v_reminder not in (0, 15, 60, 1440) then
        raise exception 'invalid reminder' using errcode = '22023';
      end if;
      v.reminder_minutes := v_reminder::integer;
    end if;
    v.work_period := coalesce(private.pet_json_bool(p_body, 'workPeriod'), false);
    return v;
  end
  $$;

-- A work period is never copied into a Home (the copy would be an ordinary event every member sees).
create or replace function private.copy_item_eligible(p_item_type text, p_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and coalesce(case p_item_type
    when 'recipe' then exists (select 1 from private.recipes r
      where r.id = p_id and r.owner_user_id = p_user_id and r.deleted_at is null and r.status = 'published')
    when 'calendar_event' then exists (select 1 from private.calendar_events e
      where e.id = p_id and e.owner_user_id = p_user_id and e.deleted_at is null and not e.work_period)
    when 'photo_album' then exists (select 1 from private.photo_albums a
      where a.id = p_id and a.owner_user_id = p_user_id and a.deleted_at is null)
  end, false);
  $$;
