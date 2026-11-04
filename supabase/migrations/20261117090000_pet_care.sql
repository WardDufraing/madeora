-- S31 (care part): pet-care schedules (brief plans/steps/S31-brief.md "Care schedules"; ADR 0041;
-- Modules.md §4.6 "Confirmed dedicated pet care schedules" and the concealment rule of "Confirmed pet
-- medical-information access permissions"; PS L1885, L1925).
--
-- A care activity belongs to one pet (and so to its Home): a title, a category, optional instructions,
-- an optional reminder and a schedule (once, or the S19 recurrence) with an optional time of day and
-- responsible members. Its occurrences are created up to seven days ahead, by the pages that read them
-- and by the hourly job, one per activity and date whatever retries or races do.
--
-- Pet-care schedules are ordinary pet-module records: every current member sees them and may complete
-- an occurrence; pet managers create, change, pause, resume, end and delete them. An activity "with
-- medical details" (always for medication) is medical information: creating, editing or deleting it
-- needs medical manage too, and for anyone without medical view at that moment its title,
-- instructions and completion notes never leave the database (only the category, the pet, timing,
-- status and responsible members do), in pages, the widget, notifications and the trash.
--
-- As in pets.sql, nothing here is exposed as a table; every function rechecks the confirmed caller,
-- their membership and their access on every call. A Home the caller is not in answers 42501; an
-- activity or occurrence they may not see answers 'not_found' / null exactly like a missing one.

-- Audit subjects, the trash type ----------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series',
    'pet', 'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity', 'pet_care_occurrence'
  ));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit', 'goal',
    'goal_series', 'pet', 'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity'
  ));

-- Limits -------------------------------------------------------------------------------------------------

-- apps/web/src/pets/care-schema.ts PET_CARE_LIMITS has the same values.
create function private.pet_care_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'activities' then 100     -- per pet, not in the trash
    when 'title' then 120
    when 'instructions' then 2000
    when 'note' then 500
    when 'members' then 10         -- responsible members of an activity or occurrence
    when 'horizon' then 7          -- occurrences are created this many days ahead
    when 'window' then 7           -- overdue care older than this is not created late, nor in the widget
    when 'catch_up' then 60        -- occurrences one activity creates per call
    when 'per_advance' then 200    -- activities one call brings up to date
    when 'open' then 60            -- open occurrences an activity page lists
    when 'recent' then 30          -- closed occurrences an activity page lists
    when 'widget' then 15
    when 'late_minutes' then 30    -- a reminder later than this is not sent
    else null
  end;
  $$;

create function private.pet_care_categories() returns text[]
  language sql immutable set search_path = '' as $$
  select array['feeding', 'medication', 'grooming', 'vet_appointment', 'other'];
  $$;

create function private.pet_care_frequencies() returns text[]
  language sql immutable set search_path = '' as $$
  select array['once', 'daily', 'weekly', 'monthly', 'yearly'];
  $$;

-- The Home's wall-clock time now, in its timezone.
create function private.pet_care_now(p_home_id uuid) returns time
  language sql stable security definer set search_path = '' as $$
  select (pg_catalog.now() at time zone coalesce(private.home_zone(p_home_id), 'UTC'))::time;
  $$;

-- Tables -------------------------------------------------------------------------------------------------

create table private.pet_care_activities (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  pet_id uuid not null references private.pets (id) on delete cascade,
  title text not null constraint pet_care_activities_title_check check (private.is_visible_name(title, 120)),
  category text not null constraint pet_care_activities_category_check
    check (category in ('feeding', 'medication', 'grooming', 'vet_appointment', 'other')),
  instructions text constraint pet_care_activities_instructions_check
    check (instructions is null or private.is_plain_text(instructions, 2000)),
  -- Medical information: its texts are shown only to people with medical view.
  medical boolean not null default false,
  -- Minutes before the occurrence's time (08:00 Home time without one); null: no reminder.
  reminder_minutes integer constraint pet_care_activities_reminder_check
    check (reminder_minutes in (0, 15, 60, 1440)),
  state text not null default 'active' constraint pet_care_activities_state_check
    check (state in ('active', 'paused', 'ended')),
  state_changed_at timestamptz,
  state_changed_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint pet_care_activities_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pet_care_activities_id_home_key unique (id, home_id),
  constraint pet_care_activities_medication_check check (category <> 'medication' or medical)
);

create index pet_care_activities_pet_idx on private.pet_care_activities (pet_id) where deleted_at is null;
create index pet_care_activities_home_idx on private.pet_care_activities (home_id) where deleted_at is null;

-- The schedule of an activity, in parts: editing it "from this occurrence on" ends the current part the
-- day before (until_date) and starts a new head part, so history keeps the rule it was made with.
create table private.pet_care_parts (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null,
  home_id uuid not null,
  frequency text not null constraint pet_care_parts_frequency_check
    check (frequency in ('once', 'daily', 'weekly', 'monthly', 'yearly')),
  interval_count integer not null default 1 constraint pet_care_parts_interval_check
    check (interval_count between 1 and 99),
  weekdays smallint[] constraint pet_care_parts_weekdays_check check (
    (frequency = 'weekly') = (weekdays is not null)
    and (weekdays is null or (cardinality(weekdays) between 1 and 7 and weekdays <@ '{1,2,3,4,5,6,7}'))
  ),
  starts_on date not null,
  -- The person's end date (recurring only).
  ends_on date,
  -- The last date this part may create after a split.
  until_date date,
  at_time time constraint pet_care_parts_time_check check (at_time = pg_catalog.date_trunc('minute', at_time)),
  -- The next date not created yet; null when there is none.
  next_date date,
  superseded_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint pet_care_parts_id_home_key unique (id, home_id),
  constraint pet_care_parts_activity_fkey foreign key (activity_id, home_id)
    references private.pet_care_activities (id, home_id) on delete cascade,
  constraint pet_care_parts_once_check check (frequency <> 'once' or (interval_count = 1 and ends_on is null)),
  constraint pet_care_parts_ends_check check (ends_on is null or ends_on >= starts_on)
);

create index pet_care_parts_activity_idx on private.pet_care_parts (activity_id);
create unique index pet_care_parts_one_head on private.pet_care_parts (activity_id) where superseded_at is null;
create index pet_care_parts_due_idx on private.pet_care_parts (home_id, next_date)
  where superseded_at is null and next_date is not null;

-- A part's responsible members; current members by construction (the row ends with the membership).
create table private.pet_care_part_members (
  part_id uuid not null,
  home_id uuid not null,
  user_id uuid not null,
  primary key (part_id, user_id),
  foreign key (part_id, home_id) references private.pet_care_parts (id, home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index pet_care_part_members_member_idx on private.pet_care_part_members (home_id, user_id);

create table private.pet_care_occurrences (
  id uuid primary key,
  activity_id uuid not null,
  home_id uuid not null,
  part_id uuid references private.pet_care_parts (id) on delete set null,
  -- The date the schedule made it for (its identity); due_on and at_time may move on their own.
  scheduled_on date not null,
  due_on date not null,
  at_time time constraint pet_care_occurrences_time_check
    check (at_time = pg_catalog.date_trunc('minute', at_time)),
  status text not null default 'open' constraint pet_care_occurrences_status_check
    check (status in ('open', 'completed', 'skipped')),
  -- Changed on its own ("only this occurrence"): later schedule changes leave it as it is.
  detached boolean not null default false,
  -- When the care was given (correctable) and who recorded it.
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  note text constraint pet_care_occurrences_note_check check (note is null or private.is_plain_text(note, 500)),
  skipped_at timestamptz,
  skipped_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint pet_care_occurrences_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint pet_care_occurrences_id_home_key unique (id, home_id),
  constraint pet_care_occurrences_activity_fkey foreign key (activity_id, home_id)
    references private.pet_care_activities (id, home_id) on delete cascade,
  -- One occurrence per activity and date, whatever retries, races or splits do.
  constraint pet_care_occurrences_date_key unique (activity_id, scheduled_on),
  constraint pet_care_occurrences_state_check check (
    (status = 'completed') = (completed_at is not null)
    and (status = 'skipped') = (skipped_at is not null)
    and (status = 'completed' or (note is null and completed_by is null))
    and (status = 'skipped' or skipped_by is null))
);

create index pet_care_occurrences_open_idx on private.pet_care_occurrences (home_id, due_on)
  where status = 'open';
create index pet_care_occurrences_activity_idx on private.pet_care_occurrences (activity_id, scheduled_on desc);
create index pet_care_occurrences_part_idx on private.pet_care_occurrences (part_id) where part_id is not null;

create table private.pet_care_occurrence_members (
  occurrence_id uuid not null,
  home_id uuid not null,
  user_id uuid not null,
  primary key (occurrence_id, user_id),
  foreign key (occurrence_id, home_id) references private.pet_care_occurrences (id, home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index pet_care_occurrence_members_member_idx on private.pet_care_occurrence_members (home_id, user_id);

-- Every completion, skip, reopen and correction of an occurrence, in order (append-only), so nothing
-- that was recorded is lost: who did it, when the care was given, the note, and a correction's values
-- before and after.
create table private.pet_care_events (
  id bigint generated always as identity primary key,
  occurrence_id uuid not null references private.pet_care_occurrences (id) on delete cascade,
  kind text not null constraint pet_care_events_kind_check
    check (kind in ('completed', 'skipped', 'reopened', 'corrected')),
  actor_id uuid references auth.users (id) on delete set null,
  completed_at timestamptz,
  previous_completed_at timestamptz,
  note text,
  previous_note text,
  created_at timestamptz not null default now()
);

create index pet_care_events_occurrence_idx on private.pet_care_events (occurrence_id, id);

alter table private.pet_care_activities enable row level security;
alter table private.pet_care_parts enable row level security;
alter table private.pet_care_part_members enable row level security;
alter table private.pet_care_occurrences enable row level security;
alter table private.pet_care_occurrence_members enable row level security;
alter table private.pet_care_events enable row level security;

revoke all on private.pet_care_activities, private.pet_care_parts, private.pet_care_part_members,
  private.pet_care_occurrences, private.pet_care_occurrence_members, private.pet_care_events
  from public, anon, authenticated, service_role;

-- Access ------------------------------------------------------------------------------------------------

-- Whether a reader must not see the activity's texts: medical details without medical view now.
create function private.pet_care_concealed(p_activity private.pet_care_activities, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_activity.medical and not private.pet_medical_can_view(p_activity.home_id, p_user_id);
  $$;

-- Whether a person may create, edit or delete the activity: pet manage, plus medical manage for one
-- with medical details.
create function private.pet_care_may_edit(p_home_id uuid, p_medical boolean, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(private.pet_access(p_home_id, p_user_id) = 'manage', false)
    and (not p_medical or private.pet_medical_can_manage(p_home_id, p_user_id));
  $$;

create function private.pet_care_may_manage(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(private.pet_access(p_home_id, p_user_id) = 'manage', false);
  $$;

-- The activity, locked, when the caller may see it now (a current member, the activity and its pet not
-- in the trash); otherwise an empty row. Lock order: pet, activity, occurrence.
create function private.lock_pet_care(p_activity_id uuid, p_user_id uuid) returns private.pet_care_activities
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_activity private.pet_care_activities;
  begin
    select * into v_activity from private.pet_care_activities a where a.id = p_activity_id for update;
    if not found or v_activity.deleted_at is not null
       or private.pet_access(v_activity.home_id, p_user_id) is null
       or exists (select 1 from private.pets p where p.id = v_activity.pet_id and p.deleted_at is not null) then
      return null;
    end if;
    return v_activity;
  end
  $$;

create function private.pet_care_head(p_activity_id uuid) returns private.pet_care_parts
  language sql stable security definer set search_path = '' as $$
  select * from private.pet_care_parts p where p.activity_id = p_activity_id and p.superseded_at is null;
  $$;

create function private.audit_pet_care(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids, states and counts only: never a title, instructions or a note.
  select private.audit(p_action, p_home_id, p_subject_type, p_subject_id, p_details);
  $$;

-- Schedule arithmetic (the S19 rule, private.series_first_on_or_after) ----------------------------------

-- The first date of a part on or after p_from within its end, or null.
create function private.pet_care_part_next(p_part private.pet_care_parts, p_from date) returns date
  language sql immutable set search_path = '' as $$
  select case
    when x.d is null then null
    when p_part.until_date is not null and x.d > p_part.until_date then null
    when p_part.ends_on is not null and x.d > p_part.ends_on then null
    else x.d
  end
  from (select case
      when p_part.frequency = 'once' then case when p_from <= p_part.starts_on then p_part.starts_on end
      else private.series_first_on_or_after(p_part.frequency, p_part.interval_count, p_part.weekdays,
        p_part.starts_on, p_from)
    end as d) x;
  $$;

-- Reminders -------------------------------------------------------------------------------------------

-- The reminder moment of an occurrence: its time (08:00 Home time without one) minus the activity's
-- offset, in the Home's timezone (PostgreSQL resolves a time a daylight-saving change skips or repeats).
-- "1 day before" is the same wall-clock time the day before, also across a daylight-saving change.
create function private.pet_care_reminder_at(
  p_occurrence private.pet_care_occurrences, p_activity private.pet_care_activities
) returns timestamptz
  language sql stable security definer set search_path = '' as $$
  select case when p_activity.reminder_minutes is null then null else
  case when p_activity.reminder_minutes = 1440 then
    ((p_occurrence.due_on - 1) + coalesce(p_occurrence.at_time, time '08:00'))
      at time zone coalesce(private.home_zone(p_occurrence.home_id), 'UTC')
  else
    ((p_occurrence.due_on + coalesce(p_occurrence.at_time, time '08:00'))
      at time zone coalesce(private.home_zone(p_occurrence.home_id), 'UTC'))
    - pg_catalog.make_interval(mins => p_activity.reminder_minutes)
  end end;
  $$;

-- Queues the reminder of an open occurrence of an active activity with responsible members, when its
-- moment is still ahead (never a retroactive reminder). The key names the occurrence and the moment, so
-- a retry or a change that keeps the moment queues it once; a job whose moment no longer matches finds
-- that out at delivery and does nothing.
create function private.schedule_pet_care_reminder(p_occurrence_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
    v_at timestamptz;
  begin
    select * into v_occurrence from private.pet_care_occurrences o where o.id = p_occurrence_id;
    select * into v_activity from private.pet_care_activities a where a.id = v_occurrence.activity_id;
    if v_occurrence.id is null or v_occurrence.status <> 'open' or v_activity.state <> 'active'
       or v_activity.deleted_at is not null
       or not exists (select 1 from private.pet_care_occurrence_members m where m.occurrence_id = v_occurrence.id) then
      return;
    end if;
    v_at := private.pet_care_reminder_at(v_occurrence, v_activity);
    if v_at is null or v_at <= pg_catalog.now() then
      return;
    end if;
    perform private.enqueue_job('pet-care-reminder', 1,
      'pet-care-reminder:' || v_occurrence.id::text || ':' || extract(epoch from v_at)::bigint::text,
      pg_catalog.jsonb_build_object('occurrenceId', v_occurrence.id, 'at', private.habit_utc_text(v_at)),
      null, v_at);
  end
  $$;

-- The reminders of every open occurrence of an activity from today on (after a change of its reminder,
-- state or schedule).
create function private.schedule_pet_care_reminders(p_activity_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    for v_id in
      select o.id from private.pet_care_occurrences o
      join private.pet_care_activities a on a.id = o.activity_id
      where o.activity_id = p_activity_id and o.status = 'open' and o.due_on >= private.pet_today(a.home_id)
      order by o.id
    loop
      perform private.schedule_pet_care_reminder(v_id);
    end loop;
  end
  $$;

-- Occurrences ---------------------------------------------------------------------------------------------

-- Creates the part's occurrence for one date with the part's responsible members, unless the activity
-- already has one for that date (a retry, a race or a split).
create function private.create_pet_care_occurrence(p_part private.pet_care_parts, p_date date) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    insert into private.pet_care_occurrences (id, activity_id, home_id, part_id, scheduled_on, due_on, at_time)
      values (gen_random_uuid(), p_part.activity_id, p_part.home_id, p_part.id, p_date, p_date, p_part.at_time)
      on conflict (activity_id, scheduled_on) do nothing
      returning id into v_id;
    if v_id is null then
      return null;
    end if;
    insert into private.pet_care_occurrence_members (occurrence_id, home_id, user_id)
      select v_id, m.home_id, m.user_id from private.pet_care_part_members m where m.part_id = p_part.id;
    perform private.schedule_pet_care_reminder(v_id);
    return v_id;
  end
  $$;

-- Brings an active activity (locked by the caller) up to date: its occurrences up to the horizon, at
-- most catch_up per call. Every part that still has dates is advanced: a part a schedule change ended
-- at a later date keeps creating its dates until then. A missed date stays an open, overdue occurrence;
-- dates older than the window are not created late. Returns how many it created.
create function private.advance_pet_care_activity(p_activity_id uuid, p_today date) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_activity private.pet_care_activities;
    v_part private.pet_care_parts;
    v_next date;
    v_created integer := 0;
    v_steps integer := 0;
  begin
    select * into v_activity from private.pet_care_activities a where a.id = p_activity_id;
    if v_activity.id is null or v_activity.state <> 'active' or v_activity.deleted_at is not null
       or exists (select 1 from private.pets p where p.id = v_activity.pet_id and p.deleted_at is not null) then
      return 0;
    end if;
    for v_part in
      select * from private.pet_care_parts p
      where p.activity_id = p_activity_id and p.next_date is not null
      order by p.starts_on, p.created_at
    loop
      v_next := v_part.next_date;
      if v_next < p_today - private.pet_care_limit('window') then
        v_next := private.pet_care_part_next(v_part, p_today - private.pet_care_limit('window'));
      end if;
      while v_next is not null and v_next <= p_today + private.pet_care_limit('horizon')
        and v_created < private.pet_care_limit('catch_up') and v_steps < 1000 loop
        v_steps := v_steps + 1;
        if private.create_pet_care_occurrence(v_part, v_next) is not null then
          v_created := v_created + 1;
        end if;
        v_next := private.pet_care_part_next(v_part, v_next + 1);
      end loop;
      if v_next is distinct from v_part.next_date then
        update private.pet_care_parts p set next_date = v_next where p.id = v_part.id;
      end if;
    end loop;
    return v_created;
  end
  $$;

-- Sets every part of an activity that can still have dates on or after p_from to its first one (resume,
-- restore); a part that ended before p_from stays done.
create function private.rewind_pet_care_parts(p_activity_id uuid, p_from date) returns void
  language sql volatile security definer set search_path = '' as $$
  update private.pet_care_parts p set next_date = private.pet_care_part_next(p, p_from)
    where p.activity_id = p_activity_id and (p.superseded_at is null or p.until_date >= p_from);
  $$;

-- Brings the Home's activities (or one pet's) up to date, those furthest behind first, locking one
-- activity at a time so two page loads queue instead of creating anything twice.
create function private.advance_pet_care_home(p_home_id uuid, p_pet_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_today date := private.pet_today(p_home_id);
    v_id uuid;
    v_created integer := 0;
  begin
    for v_id in
      select a.id from private.pet_care_activities a
      join private.pet_care_parts p on p.activity_id = a.id
      join private.pets pet on pet.id = a.pet_id
      where a.home_id = p_home_id and (p_pet_id is null or a.pet_id = p_pet_id)
        and a.deleted_at is null and a.state = 'active' and pet.deleted_at is null
        and p.next_date is not null and p.next_date <= v_today + private.pet_care_limit('horizon')
      group by a.id
      order by min(p.next_date), a.id
      limit private.pet_care_limit('per_advance')
    loop
      perform 1 from private.pet_care_activities a where a.id = v_id for update;
      v_created := v_created + private.advance_pet_care_activity(v_id, v_today);
    end loop;
    return v_created;
  end
  $$;

-- The hourly job (task-reminder-advance): brings every Home's pet care up to date, so occurrences and
-- their reminders exist even when nobody opens the pages. At most p_limit activities per call.
create function public.advance_all_pet_care(p_limit integer) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_row record;
    v_created integer := 0;
  begin
    if p_limit is null or p_limit not between 1 and 5000 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    for v_row in
      select a.id, private.pet_today(a.home_id) as today from private.pet_care_activities a
      join private.pet_care_parts p on p.activity_id = a.id and p.superseded_at is null
      join private.pets pet on pet.id = a.pet_id
      where a.deleted_at is null and a.state = 'active' and pet.deleted_at is null
        and p.next_date is not null and p.next_date <= private.pet_today(a.home_id) + private.pet_care_limit('horizon')
      order by p.next_date, a.id
      limit p_limit
    loop
      perform 1 from private.pet_care_activities a where a.id = v_row.id for update;
      v_created := v_created + private.advance_pet_care_activity(v_row.id, v_row.today);
    end loop;
    return v_created;
  end
  $$;

-- Reading request values -----------------------------------------------------------------------------------

-- An activity's own fields from the API: {title, category, instructions, medical, reminder}. 22023 for
-- anything invalid. Medication always has medical details.
create function private.pet_care_activity_values(p_body jsonb)
returns table (title text, category text, instructions text, medical boolean, reminder integer)
  language plpgsql immutable set search_path = '' as $$
  declare
    v_title text;
    v_category text;
    v_reminder numeric;
  begin
    if p_body is null or pg_catalog.jsonb_typeof(p_body) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_title := private.pet_json_text(p_body, 'title', private.pet_care_limit('title'), true);
    if v_title is null or not private.is_visible_name(v_title, private.pet_care_limit('title')) then
      raise exception 'invalid title' using errcode = '22023';
    end if;
    v_category := coalesce(private.pet_json_choice(p_body, 'category', private.pet_care_categories()), 'other');
    v_reminder := private.pet_json_number(p_body, 'reminder');
    if v_reminder is not null and v_reminder not in (0, 15, 60, 1440) then
      raise exception 'invalid reminder' using errcode = '22023';
    end if;
    return query select v_title, v_category,
      private.pet_json_text(p_body, 'instructions', private.pet_care_limit('instructions'), false),
      v_category = 'medication' or coalesce(private.pet_json_bool(p_body, 'medical'), false),
      v_reminder::integer;
  end
  $$;

-- Membership ids of the Home as account ids; null when any is not a current member, appears twice, or
-- there are more than the limit.
create function private.pet_care_member_users(p_home_id uuid, p_member_ids uuid[]) returns uuid[]
  language sql stable security definer set search_path = '' as $$
  select case
    when cardinality(coalesce(p_member_ids, '{}')) > private.pet_care_limit('members') then null
    when (select count(distinct x) from unnest(coalesce(p_member_ids, '{}')) as x)
      <> cardinality(coalesce(p_member_ids, '{}')) then null
    when (select count(*) from public.home_memberships m
          where m.home_id = p_home_id and m.id = any (coalesce(p_member_ids, '{}')))
      <> cardinality(coalesce(p_member_ids, '{}')) then null
    else coalesce((select array_agg(m.user_id order by m.user_id) from public.home_memberships m
      where m.home_id = p_home_id and m.id = any (coalesce(p_member_ids, '{}'))), '{}'::uuid[])
  end;
  $$;

-- A list of uuids from the API (22023 when malformed).
create function private.pet_json_uuids(p_body jsonb, p_key text) returns uuid[]
  language plpgsql immutable set search_path = '' as $$
  declare
    v_ids uuid[];
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return '{}';
    end if;
    if pg_catalog.jsonb_typeof(p_body -> p_key) <> 'array'
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_body -> p_key) e
         where pg_catalog.jsonb_typeof(e) <> 'string'
           or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    select coalesce(pg_catalog.array_agg(e::uuid), '{}') into v_ids
      from pg_catalog.jsonb_array_elements_text(p_body -> p_key) e;
    return v_ids;
  end
  $$;

-- A time of day "HH:MM" from the API, or null (22023 when malformed).
create function private.pet_json_time(p_body jsonb, p_key text) returns time
  language plpgsql immutable set search_path = '' as $$
  declare
    v_value text;
  begin
    if p_body is null or not (p_body ? p_key) or pg_catalog.jsonb_typeof(p_body -> p_key) = 'null' then
      return null;
    end if;
    v_value := case when pg_catalog.jsonb_typeof(p_body -> p_key) = 'string' then p_body ->> p_key end;
    if v_value is null or v_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'invalid %', p_key using errcode = '22023';
    end if;
    return v_value::time;
  end
  $$;

-- A schedule from the API: {frequency, interval, weekdays, startsOn, endsOn, time, members}. 22023 for
-- anything malformed; users null when a member is not a current member of the Home.
create function private.pet_care_schedule_values(p_home_id uuid, p_body jsonb)
returns table (frequency text, interval_count integer, weekdays smallint[], starts_on date, ends_on date,
  at_time time, users uuid[])
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_frequency text;
    v_interval numeric;
    v_weekdays smallint[];
    v_starts date;
    v_ends date;
  begin
    if p_body is null or pg_catalog.jsonb_typeof(p_body) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_frequency := private.pet_json_choice(p_body, 'frequency', private.pet_care_frequencies());
    v_interval := coalesce(private.pet_json_number(p_body, 'interval'), 1);
    v_starts := private.pet_json_date(p_body, 'startsOn');
    v_ends := private.pet_json_date(p_body, 'endsOn');
    if v_frequency is null or v_starts is null or v_interval <> pg_catalog.trunc(v_interval)
       or v_interval not between 1 and 99 or (v_frequency = 'once' and (v_interval <> 1 or v_ends is not null)) then
      raise exception 'invalid schedule' using errcode = '22023';
    end if;
    if v_frequency = 'weekly' then
      if pg_catalog.jsonb_typeof(p_body -> 'weekdays') <> 'array'
         or exists (select 1 from pg_catalog.jsonb_array_elements(p_body -> 'weekdays') e
           where pg_catalog.jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[1-7]$') then
        raise exception 'invalid weekdays' using errcode = '22023';
      end if;
      select pg_catalog.array_agg(distinct (e #>> '{}')::smallint order by (e #>> '{}')::smallint) into v_weekdays
        from pg_catalog.jsonb_array_elements(p_body -> 'weekdays') e;
      if v_weekdays is null then
        raise exception 'invalid weekdays' using errcode = '22023';
      end if;
    elsif p_body ? 'weekdays' and pg_catalog.jsonb_typeof(p_body -> 'weekdays') <> 'null' then
      raise exception 'invalid weekdays' using errcode = '22023';
    end if;
    return query select v_frequency, v_interval::integer, v_weekdays, v_starts, v_ends,
      private.pet_json_time(p_body, 'time'),
      private.pet_care_member_users(p_home_id, private.pet_json_uuids(p_body, 'members'));
  end
  $$;

-- Whether a schedule's dates are acceptable: a start from a year back to two years ahead, an end on or
-- after the start and within five years.
create function private.pet_care_dates_ok(p_starts date, p_ends date, p_today date) returns boolean
  language sql immutable set search_path = '' as $$
  select p_starts between p_today - 366 and p_today + 731
    and (p_ends is null or (p_ends >= p_starts and p_ends <= p_today + 1827));
  $$;

-- Output -------------------------------------------------------------------------------------------------

-- An occurrence's status as people read it.
create function private.pet_care_status(
  p_occurrence private.pet_care_occurrences, p_state text, p_today date, p_now time
) returns text
  language sql immutable set search_path = '' as $$
  select case
    when p_occurrence.status <> 'open' then p_occurrence.status
    when p_state = 'paused' then 'paused'
    when p_occurrence.due_on > p_today then 'upcoming'
    when p_occurrence.due_on = p_today and (p_occurrence.at_time is null or p_occurrence.at_time > p_now)
      then 'due'
    else 'overdue'
  end;
  $$;

create function private.pet_care_time_text(p_time time) returns text
  language sql immutable set search_path = '' as $$
  select pg_catalog.to_char(p_time, 'HH24:MI');
  $$;

-- One occurrence for a reader: the completion note only when the activity's texts are not concealed
-- from them; people as membership ids (null for someone no longer in the Home).
create function private.pet_care_occurrence_json(
  p_occurrence private.pet_care_occurrences, p_activity private.pet_care_activities, p_user_id uuid,
  p_today date, p_now time
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_occurrence.id,
    'activityId', p_occurrence.activity_id,
    'scheduledOn', p_occurrence.scheduled_on,
    'dueOn', p_occurrence.due_on,
    'time', private.pet_care_time_text(p_occurrence.at_time),
    'status', private.pet_care_status(p_occurrence, p_activity.state, p_today, p_now),
    'detached', p_occurrence.detached,
    'revision', p_occurrence.revision,
    'members', coalesce((select pg_catalog.jsonb_agg(private.member_ref(m.home_id, m.user_id) order by m.user_id)
      from private.pet_care_occurrence_members m where m.occurrence_id = p_occurrence.id), '[]'::jsonb),
    'mine', exists (select 1 from private.pet_care_occurrence_members m
      where m.occurrence_id = p_occurrence.id and m.user_id = p_user_id),
    'completedAt', private.habit_utc_text(p_occurrence.completed_at),
    'completedBy', private.member_ref(p_occurrence.home_id, p_occurrence.completed_by),
    'recordedByMe', p_occurrence.completed_by is not distinct from p_user_id and p_occurrence.completed_by is not null,
    'note', case when private.pet_care_concealed(p_activity, p_user_id) then null else p_occurrence.note end,
    'skippedAt', private.habit_utc_text(p_occurrence.skipped_at),
    'skippedBy', private.member_ref(p_occurrence.home_id, p_occurrence.skipped_by),
    'corrected', exists (select 1 from private.pet_care_events e
      where e.occurrence_id = p_occurrence.id and e.kind = 'corrected')
  );
  $$;

-- An activity for a reader, concealed when it has medical details and they have no medical view.
create function private.pet_care_activity_json(
  p_activity private.pet_care_activities, p_user_id uuid, p_today date, p_now time
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_concealed boolean := private.pet_care_concealed(p_activity, p_user_id);
    v_part private.pet_care_parts := private.pet_care_head(p_activity.id);
    v_next private.pet_care_occurrences;
  begin
    select * into v_next from private.pet_care_occurrences o
      where o.activity_id = p_activity.id and o.status = 'open'
      order by o.due_on, o.at_time nulls first, o.id limit 1;
    return pg_catalog.jsonb_build_object(
      'id', p_activity.id,
      'petId', p_activity.pet_id,
      'title', case when v_concealed then null else p_activity.title end,
      'category', p_activity.category,
      'instructions', case when v_concealed then null else p_activity.instructions end,
      'medical', p_activity.medical,
      'concealed', v_concealed,
      'reminder', p_activity.reminder_minutes,
      'state', p_activity.state,
      'revision', p_activity.revision,
      'canEdit', private.pet_care_may_edit(p_activity.home_id, p_activity.medical, p_user_id),
      'canManage', private.pet_care_may_manage(p_activity.home_id, p_user_id),
      'schedule', case when v_part.id is null then null else pg_catalog.jsonb_build_object(
        'frequency', v_part.frequency,
        'interval', v_part.interval_count,
        'weekdays', pg_catalog.to_jsonb(v_part.weekdays),
        'startsOn', v_part.starts_on,
        'endsOn', v_part.ends_on,
        'time', private.pet_care_time_text(v_part.at_time),
        'members', coalesce((select pg_catalog.jsonb_agg(private.member_ref(m.home_id, m.user_id) order by m.user_id)
          from private.pet_care_part_members m where m.part_id = v_part.id), '[]'::jsonb)) end,
      'next', case when v_next.id is null then null
        else private.pet_care_occurrence_json(v_next, p_activity, p_user_id, p_today, p_now) end,
      'overdue', (select count(*) from private.pet_care_occurrences o
        where o.activity_id = p_activity.id and o.status = 'open'
          and private.pet_care_status(o, p_activity.state, p_today, p_now) = 'overdue')
    );
  end
  $$;

-- Reading ------------------------------------------------------------------------------------------------

-- A pet's care activities (oldest first, never ordered by a title someone may not see) with what the
-- caller may do; null when they may not see the pet. Brings the pet's schedules up to date first.
create function public.get_pet_care(p_pet_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_today date;
    v_now time;
  begin
    select * into v_pet from private.pets p where p.id = p_pet_id;
    if not found or v_pet.deleted_at is not null or private.pet_access(v_pet.home_id, v_user_id) is null then
      return null;
    end if;
    perform private.advance_pet_care_home(v_pet.home_id, v_pet.id);
    v_today := private.pet_today(v_pet.home_id);
    v_now := private.pet_care_now(v_pet.home_id);
    return pg_catalog.jsonb_build_object(
      'petId', v_pet.id,
      'today', v_today,
      'canManage', private.pet_care_may_manage(v_pet.home_id, v_user_id),
      'canManageMedical', private.pet_care_may_edit(v_pet.home_id, true, v_user_id),
      'activities', coalesce((
        select pg_catalog.jsonb_agg(private.pet_care_activity_json(a, v_user_id, v_today, v_now)
          order by case a.state when 'active' then 0 when 'paused' then 1 else 2 end, a.created_at, a.id)
        from private.pet_care_activities a where a.pet_id = v_pet.id and a.deleted_at is null), '[]'::jsonb)
    );
  end
  $$;

-- One activity with its open occurrences (up to the horizon) and its recent closed ones; null when the
-- caller may not see it.
create function public.get_pet_care_activity(p_activity_id uuid) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_activity private.pet_care_activities;
    v_today date;
    v_now time;
  begin
    v_activity := private.lock_pet_care(p_activity_id, v_user_id);
    if v_activity.id is null then
      return null;
    end if;
    v_today := private.pet_today(v_activity.home_id);
    v_now := private.pet_care_now(v_activity.home_id);
    perform private.advance_pet_care_activity(v_activity.id, v_today);
    return private.pet_care_activity_json(v_activity, v_user_id, v_today, v_now) || pg_catalog.jsonb_build_object(
      'homeId', v_activity.home_id,
      'timeZone', coalesce(private.home_zone(v_activity.home_id), 'UTC'),
      'today', v_today,
      'open', coalesce((
        select pg_catalog.jsonb_agg(private.pet_care_occurrence_json(o, v_activity, v_user_id, v_today, v_now)
          order by o.due_on, o.at_time nulls first, o.id)
        from (select * from private.pet_care_occurrences o
          where o.activity_id = v_activity.id and o.status = 'open'
            and o.due_on <= v_today + private.pet_care_limit('horizon')
          order by o.due_on, o.at_time nulls first, o.id limit private.pet_care_limit('open')) o), '[]'::jsonb),
      'recent', coalesce((
        select pg_catalog.jsonb_agg(private.pet_care_occurrence_json(o, v_activity, v_user_id, v_today, v_now)
          order by o.due_on desc, o.at_time desc nulls last, o.id)
        from (select * from private.pet_care_occurrences o
          where o.activity_id = v_activity.id and o.status <> 'open'
          order by o.due_on desc, o.at_time desc nulls last, o.id limit private.pet_care_limit('recent')) o),
        '[]'::jsonb)
    );
  end
  $$;

-- The pet-care widget: open occurrences of active activities in the Home (or of one of its pets) from
-- the overdue window up to p_days ahead (1 today, 3, 7), for everyone, the caller ('me') or nobody
-- ('unassigned'); overdue first, then by date and time. Concealed as everywhere. 42501 for a Home the
-- caller is not in; a pet of another Home simply has no rows.
create function public.list_home_pet_care(
  p_home_id uuid, p_pet_id uuid, p_days integer, p_who text, p_limit integer
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_now time;
    v_rows jsonb;
  begin
    if p_days is null or p_days not in (1, 3, 7) or p_who is null or p_who not in ('all', 'me', 'unassigned')
       or p_limit is null or p_limit not between 1 and private.pet_care_limit('widget') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.require_pet_home(p_home_id, v_user_id);
    perform private.advance_pet_care_home(p_home_id, p_pet_id);
    v_today := private.pet_today(p_home_id);
    v_now := private.pet_care_now(p_home_id);
    select coalesce(pg_catalog.jsonb_agg(x.item order by x.n), '[]'::jsonb) into v_rows from (
      select row_number() over (order by o.due_on, o.at_time nulls first, o.id) as n,
        private.pet_care_occurrence_json(o, a, v_user_id, v_today, v_now) || pg_catalog.jsonb_build_object(
          'petId', p.id, 'petName', p.name,
          'activity', pg_catalog.jsonb_build_object(
            'title', case when private.pet_care_concealed(a, v_user_id) then null else a.title end,
            'category', a.category, 'medical', a.medical,
            'concealed', private.pet_care_concealed(a, v_user_id))) as item
      from private.pet_care_occurrences o
      join private.pet_care_activities a on a.id = o.activity_id
      join private.pets p on p.id = a.pet_id
      where o.home_id = p_home_id and o.status = 'open'
        and a.deleted_at is null and a.state = 'active' and p.deleted_at is null
        and (p_pet_id is null or p.id = p_pet_id)
        and o.due_on between v_today - private.pet_care_limit('window') and v_today + p_days - 1
        and (p_who = 'all'
          or (p_who = 'me' and exists (select 1 from private.pet_care_occurrence_members m
            where m.occurrence_id = o.id and m.user_id = v_user_id))
          or (p_who = 'unassigned' and not exists (select 1 from private.pet_care_occurrence_members m
            where m.occurrence_id = o.id)))
      order by o.due_on, o.at_time nulls first, o.id
      limit p_limit + 1
    ) x;
    return pg_catalog.jsonb_build_object(
      'today', v_today,
      'rows', coalesce((select pg_catalog.jsonb_agg(e order by i) from pg_catalog.jsonb_array_elements(v_rows)
        with ordinality as t (e, i) where i <= p_limit), '[]'::jsonb),
      'hasMore', pg_catalog.jsonb_array_length(v_rows) > p_limit
    );
  end
  $$;

-- The names in the caller's pet-care notifications, for occurrences they may still see: the pet's name,
-- the category, and the title only when it is not concealed from them.
create function public.pet_care_notice_names(p_occurrence_ids uuid[])
returns table (occurrence_id uuid, pet_name text, title text, category text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_occurrence_ids is null or cardinality(p_occurrence_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    return query
      select o.id, p.name,
        case when private.pet_care_concealed(a, v_user_id) then null else a.title end,
        a.category
      from private.pet_care_occurrences o
      join private.pet_care_activities a on a.id = o.activity_id
      join private.pets p on p.id = a.pet_id
      where o.id = any (p_occurrence_ids) and a.deleted_at is null and p.deleted_at is null
        and private.pet_access(a.home_id, v_user_id) is not null;
  end
  $$;

-- Activities: create, change, pause, resume, end, delete -------------------------------------------------

-- Writes a part's responsible members.
create function private.set_pet_care_part_members(p_part_id uuid, p_home_id uuid, p_users uuid[]) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.pet_care_part_members (part_id, home_id, user_id)
    select p_part_id, p_home_id, u from unnest(coalesce(p_users, '{}')) as u on conflict do nothing;
  $$;

-- Starts a new head part for an activity from p_values (after the caller retired the old one).
create function private.start_pet_care_part(
  p_activity private.pet_care_activities, p_frequency text, p_interval integer, p_weekdays smallint[],
  p_starts date, p_ends date, p_time time, p_users uuid[], p_user_id uuid
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_part private.pet_care_parts;
  begin
    insert into private.pet_care_parts (activity_id, home_id, frequency, interval_count, weekdays, starts_on,
        ends_on, at_time, created_by)
      values (p_activity.id, p_activity.home_id, p_frequency, p_interval, p_weekdays, p_starts, p_ends, p_time,
        p_user_id)
      returning * into v_part;
    update private.pet_care_parts p set next_date = private.pet_care_part_next(v_part, v_part.starts_on)
      where p.id = v_part.id;
    perform private.set_pet_care_part_members(v_part.id, p_activity.home_id, p_users);
  end
  $$;

-- Creates an activity for a pet (pet managers; medical manage too for one with medical details). A retry
-- with the same id by the same person answers 'exists'. Outcomes: 'created', 'exists', 'id_taken',
-- 'not_found', 'not_permitted', 'limit_reached', 'invalid_member', 'invalid_dates'. 22023 for invalid
-- fields.
create function public.create_pet_care(p_id uuid, p_pet_id uuid, p_activity jsonb, p_schedule jsonb)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pet private.pets;
    v_existing private.pet_care_activities;
    v_values record;
    v_schedule record;
    v_activity private.pet_care_activities;
    v_today date;
  begin
    if p_id is null or p_pet_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_values from private.pet_care_activity_values(p_activity);
    v_pet := private.lock_pet(p_pet_id, v_user_id);
    if v_pet.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_schedule from private.pet_care_schedule_values(v_pet.home_id, p_schedule);
    select * into v_existing from private.pet_care_activities a where a.id = p_id;
    if found then
      if v_existing.pet_id = v_pet.id and v_existing.created_by = v_user_id then
        return pg_catalog.jsonb_build_object('outcome', 'exists', 'id', v_existing.id, 'revision', v_existing.revision);
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    if not private.pet_care_may_edit(v_pet.home_id, v_values.medical, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_schedule.users is null then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_member');
    end if;
    v_today := private.pet_today(v_pet.home_id);
    if not private.pet_care_dates_ok(v_schedule.starts_on, v_schedule.ends_on, v_today) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
    end if;
    if (select count(*) from private.pet_care_activities a where a.pet_id = v_pet.id and a.deleted_at is null)
       >= private.pet_care_limit('activities') then
      return pg_catalog.jsonb_build_object('outcome', 'limit_reached');
    end if;
    insert into private.pet_care_activities (id, home_id, pet_id, title, category, instructions, medical,
        reminder_minutes, created_by, updated_by)
      values (p_id, v_pet.home_id, v_pet.id, v_values.title, v_values.category, v_values.instructions,
        v_values.medical, v_values.reminder, v_user_id, v_user_id)
      returning * into v_activity;
    perform private.start_pet_care_part(v_activity, v_schedule.frequency, v_schedule.interval_count,
      v_schedule.weekdays, v_schedule.starts_on, v_schedule.ends_on, v_schedule.at_time, v_schedule.users,
      v_user_id);
    perform private.advance_pet_care_activity(v_activity.id, v_today);
    perform private.audit_pet_care('pet.care.created', v_pet.home_id, 'pet_care_activity', v_activity.id,
      pg_catalog.jsonb_build_object('petId', v_pet.id, 'medical', v_activity.medical));
    return pg_catalog.jsonb_build_object('outcome', 'created', 'id', v_activity.id, 'revision', 1);
  end
  $$;

-- Changes an activity (pet managers; medical manage too when it has or gets medical details). The
-- activity's own fields always apply to the whole activity. With p_schedule, the schedule changes from
-- p_from on ("from this occurrence on"; from the new start when that is earlier): the current part ends
-- the day before, open occurrences from then on that were not changed on their own go, and a new part
-- starts.
-- Outcomes: 'saved', 'stale', 'not_found', 'not_permitted', 'invalid_member', 'invalid_dates',
-- 'invalid_state' (an ended activity's schedule).
create function public.update_pet_care(
  p_activity_id uuid, p_expected_revision integer, p_activity jsonb, p_schedule jsonb default null,
  p_from date default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_activity private.pet_care_activities;
    v_values record;
    v_schedule record;
    v_head private.pet_care_parts;
    v_today date;
    v_split date;
  begin
    if p_activity_id is null or p_expected_revision is null or (p_schedule is null) <> (p_from is null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_values from private.pet_care_activity_values(p_activity);
    v_activity := private.lock_pet_care(p_activity_id, v_user_id);
    if v_activity.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if p_schedule is not null then
      select * into v_schedule from private.pet_care_schedule_values(v_activity.home_id, p_schedule);
    end if;
    if not private.pet_care_may_edit(v_activity.home_id, v_activity.medical or v_values.medical, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_activity.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_activity.revision);
    end if;
    v_today := private.pet_today(v_activity.home_id);
    if p_schedule is not null then
      if v_activity.state = 'ended' then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_state');
      end if;
      if v_schedule.users is null then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_member');
      end if;
      v_head := private.pet_care_head(v_activity.id);
      -- The change applies from p_from, or from the new start when that is earlier.
      v_split := least(p_from, v_schedule.starts_on);
      if not private.pet_care_dates_ok(v_schedule.starts_on, v_schedule.ends_on, v_today)
         or v_split < v_today - private.pet_care_limit('window') then
        return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
      end if;
      -- The old part keeps creating its dates up to the day before the split (a split beyond the 7 days
      -- ahead leaves no gap); dates it already passed stay passed.
      update private.pet_care_parts p set superseded_at = pg_catalog.now(), until_date = v_split - 1,
          next_date = case when p.next_date > v_split - 1 then null else p.next_date end
        where p.id = v_head.id;
      delete from private.pet_care_occurrences o
        where o.activity_id = v_activity.id and o.status = 'open' and not o.detached and o.scheduled_on >= v_split;
      perform private.start_pet_care_part(v_activity, v_schedule.frequency, v_schedule.interval_count,
        v_schedule.weekdays, v_schedule.starts_on, v_schedule.ends_on, v_schedule.at_time, v_schedule.users,
        v_user_id);
    end if;
    update private.pet_care_activities a set title = v_values.title, category = v_values.category,
        instructions = v_values.instructions, medical = v_values.medical, reminder_minutes = v_values.reminder,
        revision = a.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where a.id = v_activity.id;
    perform private.advance_pet_care_activity(v_activity.id, v_today);
    perform private.schedule_pet_care_reminders(v_activity.id);
    perform private.audit_pet_care('pet.care.updated', v_activity.home_id, 'pet_care_activity', v_activity.id,
      pg_catalog.jsonb_build_object('schedule', p_schedule is not null, 'medical', v_values.medical));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_activity.revision + 1);
  end
  $$;

-- Pauses, resumes or ends an activity (pet managers). Pausing removes open occurrences from today on that
-- were not changed on their own and creates none until it is resumed; resuming continues from today
-- (nothing is created for the paused days); ending stops the schedule for good and removes every open
-- occurrence from today on. Outcomes: 'saved', 'stale', 'not_found', 'not_permitted', 'invalid_state'.
create function public.set_pet_care_state(p_activity_id uuid, p_expected_revision integer, p_state text)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_activity private.pet_care_activities;
    v_head private.pet_care_parts;
    v_today date;
  begin
    if p_activity_id is null or p_expected_revision is null or p_state is null
       or p_state not in ('active', 'paused', 'ended') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_activity := private.lock_pet_care(p_activity_id, v_user_id);
    if v_activity.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.pet_care_may_manage(v_activity.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_activity.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_activity.revision);
    end if;
    if v_activity.state = 'ended' or v_activity.state = p_state then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_state');
    end if;
    v_today := private.pet_today(v_activity.home_id);
    v_head := private.pet_care_head(v_activity.id);
    if p_state = 'paused' then
      delete from private.pet_care_occurrences o
        where o.activity_id = v_activity.id and o.status = 'open' and not o.detached and o.due_on >= v_today;
    elsif p_state = 'ended' then
      delete from private.pet_care_occurrences o
        where o.activity_id = v_activity.id and o.status = 'open' and o.due_on >= v_today;
      update private.pet_care_parts p set next_date = null where p.activity_id = v_activity.id;
    else
      perform private.rewind_pet_care_parts(v_activity.id, v_today);
    end if;
    update private.pet_care_activities a set state = p_state, state_changed_at = pg_catalog.now(),
        state_changed_by = v_user_id, revision = a.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where a.id = v_activity.id;
    if p_state = 'active' then
      perform private.advance_pet_care_activity(v_activity.id, v_today);
      perform private.schedule_pet_care_reminders(v_activity.id);
    end if;
    perform private.audit_pet_care(
      case p_state when 'paused' then 'pet.care.paused' when 'ended' then 'pet.care.ended' else 'pet.care.resumed' end,
      v_activity.home_id, 'pet_care_activity', v_activity.id);
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_activity.revision + 1);
  end
  $$;

-- Moves an activity with its occurrences to the Home's trash (pet managers; medical manage too for one
-- with medical details). Outcomes: 'deleted' (with the trash entry id), 'stale', 'not_found',
-- 'not_permitted'.
create function public.delete_pet_care(p_activity_id uuid, p_expected_revision integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_activity private.pet_care_activities;
    v_entry uuid;
  begin
    if p_activity_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_activity := private.lock_pet_care(p_activity_id, v_user_id);
    if v_activity.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.pet_care_may_edit(v_activity.home_id, v_activity.medical, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_activity.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_activity.revision);
    end if;
    update private.pet_care_activities a set deleted_at = pg_catalog.now(), revision = a.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where a.id = v_activity.id;
    v_entry := private.trash_move(v_user_id, 'pets', 'pet_care_activity', v_activity.id, null,
      v_activity.home_id, v_activity.title, '{}'::uuid[]);
    perform private.audit_pet_care('pet.care.deleted', v_activity.home_id, 'pet_care_activity', v_activity.id);
    return pg_catalog.jsonb_build_object('outcome', 'deleted', 'entryId', v_entry);
  end
  $$;

-- Occurrences: complete, skip, reopen, correct, change one ----------------------------------------------

-- The occurrence, locked after its activity, when the caller may see them now; otherwise an empty row.
create function private.lock_pet_care_occurrence(p_occurrence_id uuid, p_user_id uuid)
returns private.pet_care_occurrences
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_activity private.pet_care_activities;
    v_occurrence private.pet_care_occurrences;
  begin
    v_activity := private.lock_pet_care(
      (select o.activity_id from private.pet_care_occurrences o where o.id = p_occurrence_id), p_user_id);
    if v_activity.id is null then
      return null;
    end if;
    select * into v_occurrence from private.pet_care_occurrences o where o.id = p_occurrence_id for update;
    return v_occurrence;
  end
  $$;

-- A completion time from the API: not in the future, at most a year back. Null: now.
create function private.pet_care_completed_at(p_at timestamptz) returns timestamptz
  language plpgsql stable set search_path = '' as $$
  begin
    if p_at is null then
      return pg_catalog.now();
    end if;
    if p_at > pg_catalog.now() + interval '1 minute' or p_at < pg_catalog.now() - interval '366 days' then
      raise exception 'invalid completion time' using errcode = '22023';
    end if;
    return least(p_at, pg_catalog.now());
  end
  $$;

-- Records that the care was given (any current member, whoever is responsible). p_completed_at: when it
-- was given (default now). A retry by the same person answers 'completed' again. Outcomes: 'completed',
-- 'closed' (someone else already completed or skipped it), 'stale', 'not_found'.
create function public.complete_pet_care_occurrence(
  p_occurrence_id uuid, p_expected_revision integer, p_completed_at timestamptz default null,
  p_note text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
    v_at timestamptz := private.pet_care_completed_at(p_completed_at);
    v_note text := nullif(pg_catalog.btrim(p_note), '');
  begin
    if p_occurrence_id is null or p_expected_revision is null
       or (v_note is not null and not private.is_plain_text(v_note, private.pet_care_limit('note'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_pet_care_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if v_occurrence.status = 'completed' and v_occurrence.completed_by = v_user_id then
      return pg_catalog.jsonb_build_object('outcome', 'completed', 'revision', v_occurrence.revision);
    end if;
    if v_occurrence.status <> 'open' then
      return pg_catalog.jsonb_build_object('outcome', 'closed', 'revision', v_occurrence.revision);
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_occurrence.revision);
    end if;
    update private.pet_care_occurrences o set status = 'completed', completed_at = v_at, completed_by = v_user_id,
        note = v_note, revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id;
    insert into private.pet_care_events (occurrence_id, kind, actor_id, completed_at, note)
      values (v_occurrence.id, 'completed', v_user_id, v_at, v_note);
    return pg_catalog.jsonb_build_object('outcome', 'completed', 'revision', v_occurrence.revision + 1);
  end
  $$;

-- Skips an open occurrence (a responsible member or a pet manager). Outcomes: 'skipped', 'closed',
-- 'stale', 'not_found', 'not_permitted'.
create function public.skip_pet_care_occurrence(p_occurrence_id uuid, p_expected_revision integer)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
  begin
    if p_occurrence_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_pet_care_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_activity from private.pet_care_activities a where a.id = v_occurrence.activity_id;
    if not private.pet_care_may_manage(v_activity.home_id, v_user_id)
       and not exists (select 1 from private.pet_care_occurrence_members m
         where m.occurrence_id = v_occurrence.id and m.user_id = v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_occurrence.status <> 'open' then
      return pg_catalog.jsonb_build_object('outcome', 'closed', 'revision', v_occurrence.revision);
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_occurrence.revision);
    end if;
    update private.pet_care_occurrences o set status = 'skipped', skipped_at = pg_catalog.now(),
        skipped_by = v_user_id, revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id;
    insert into private.pet_care_events (occurrence_id, kind, actor_id) values (v_occurrence.id, 'skipped', v_user_id);
    return pg_catalog.jsonb_build_object('outcome', 'skipped', 'revision', v_occurrence.revision + 1);
  end
  $$;

-- Reopens a completed or skipped occurrence (whoever recorded it, or a pet manager). Outcomes:
-- 'reopened', 'stale', 'not_found', 'not_permitted', 'invalid_state' (it is open).
create function public.reopen_pet_care_occurrence(p_occurrence_id uuid, p_expected_revision integer)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
  begin
    if p_occurrence_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_pet_care_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_activity from private.pet_care_activities a where a.id = v_occurrence.activity_id;
    if not private.pet_care_may_manage(v_activity.home_id, v_user_id)
       and v_occurrence.completed_by is distinct from v_user_id and v_occurrence.skipped_by is distinct from v_user_id then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_occurrence.revision);
    end if;
    if v_occurrence.status = 'open' then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_state');
    end if;
    update private.pet_care_occurrences o set status = 'open', completed_at = null, completed_by = null,
        note = null, skipped_at = null, skipped_by = null, revision = o.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where o.id = v_occurrence.id;
    insert into private.pet_care_events (occurrence_id, kind, actor_id, previous_completed_at, previous_note)
      values (v_occurrence.id, 'reopened', v_user_id, v_occurrence.completed_at, v_occurrence.note);
    perform private.schedule_pet_care_reminder(v_occurrence.id);
    perform private.audit_pet_care('pet.care.occurrence.reopened', v_activity.home_id, 'pet_care_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('activityId', v_activity.id));
    return pg_catalog.jsonb_build_object('outcome', 'reopened', 'revision', v_occurrence.revision + 1);
  end
  $$;

-- Corrects a completion: when the care was given and the note (whoever recorded it, or a pet manager;
-- the note only by someone who may see it). Outcomes: 'saved', 'stale', 'not_found', 'not_permitted',
-- 'invalid_state' (not completed).
create function public.correct_pet_care_completion(
  p_occurrence_id uuid, p_expected_revision integer, p_completed_at timestamptz, p_note text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
    v_at timestamptz;
    v_note text := nullif(pg_catalog.btrim(p_note), '');
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_completed_at is null
       or (v_note is not null and not private.is_plain_text(v_note, private.pet_care_limit('note'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_at := private.pet_care_completed_at(p_completed_at);
    v_occurrence := private.lock_pet_care_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_activity from private.pet_care_activities a where a.id = v_occurrence.activity_id;
    if (not private.pet_care_may_manage(v_activity.home_id, v_user_id)
        and v_occurrence.completed_by is distinct from v_user_id)
       or private.pet_care_concealed(v_activity, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_occurrence.revision);
    end if;
    if v_occurrence.status <> 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_state');
    end if;
    update private.pet_care_occurrences o set completed_at = v_at, note = v_note, revision = o.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id;
    insert into private.pet_care_events (occurrence_id, kind, actor_id, completed_at, previous_completed_at, note,
        previous_note)
      values (v_occurrence.id, 'corrected', v_user_id, v_at, v_occurrence.completed_at, v_note, v_occurrence.note);
    perform private.audit_pet_care('pet.care.occurrence.corrected', v_activity.home_id, 'pet_care_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('activityId', v_activity.id));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_occurrence.revision + 1);
  end
  $$;

-- Changes only this occurrence (pet managers): its date, time and responsible members. Later schedule
-- changes leave it as it is. Outcomes: 'saved', 'stale', 'not_found', 'not_permitted', 'invalid_member',
-- 'invalid_dates', 'invalid_state' (not open).
create function public.update_pet_care_occurrence(
  p_occurrence_id uuid, p_expected_revision integer, p_due_on date, p_time text, p_members uuid[]
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
    v_time time := private.pet_json_time(pg_catalog.jsonb_build_object('time', p_time), 'time');
    v_users uuid[];
    v_today date;
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_due_on is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_pet_care_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    select * into v_activity from private.pet_care_activities a where a.id = v_occurrence.activity_id;
    if not private.pet_care_may_manage(v_activity.home_id, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_occurrence.revision);
    end if;
    if v_occurrence.status <> 'open' then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_state');
    end if;
    v_users := private.pet_care_member_users(v_activity.home_id, p_members);
    if v_users is null then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_member');
    end if;
    v_today := private.pet_today(v_activity.home_id);
    if p_due_on < v_today - private.pet_care_limit('window') or p_due_on > v_today + 731 then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
    end if;
    update private.pet_care_occurrences o set due_on = p_due_on, at_time = v_time, detached = true,
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id;
    delete from private.pet_care_occurrence_members m where m.occurrence_id = v_occurrence.id;
    insert into private.pet_care_occurrence_members (occurrence_id, home_id, user_id)
      select v_occurrence.id, v_activity.home_id, u from unnest(v_users) u;
    perform private.schedule_pet_care_reminder(v_occurrence.id);
    perform private.audit_pet_care('pet.care.occurrence.updated', v_activity.home_id, 'pet_care_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('activityId', v_activity.id,
        'members', cardinality(v_users)));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_occurrence.revision + 1);
  end
  $$;

-- Reminder delivery -----------------------------------------------------------------------------------

-- Delivers one occurrence's reminder (the pet-care-reminder job; service role only). Rechecks
-- everything: the occurrence is still open and its moment is still p_at, the activity is active and
-- neither it nor its pet is in the trash. Notifies each responsible member still in the Home, once per
-- person and moment (their choices and quiet hours apply in notify_user). The notice carries ids only.
-- Outcomes: 'notified', 'stale', 'inactive', 'late', 'not_due'.
create function public.deliver_pet_care_reminder(p_occurrence_id uuid, p_at timestamptz) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.pet_care_occurrences;
    v_activity private.pet_care_activities;
    v_user_id uuid;
  begin
    if p_occurrence_id is null or p_at is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_occurrence from private.pet_care_occurrences o where o.id = p_occurrence_id;
    select * into v_activity from private.pet_care_activities a where a.id = v_occurrence.activity_id for update;
    if v_activity.id is null or v_activity.deleted_at is not null
       or exists (select 1 from private.pets p where p.id = v_activity.pet_id and p.deleted_at is not null) then
      return 'stale';
    end if;
    select * into v_occurrence from private.pet_care_occurrences o where o.id = p_occurrence_id for update;
    if private.pet_care_reminder_at(v_occurrence, v_activity) is distinct from p_at then
      -- The moment moved without a change that queued it (the Home's timezone changed): queue the new
      -- one. The key names the moment, so a moment already queued is not queued twice.
      perform private.schedule_pet_care_reminder(v_occurrence.id);
      return 'stale';
    end if;
    if p_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    if pg_catalog.now() > p_at + pg_catalog.make_interval(mins => private.pet_care_limit('late_minutes')) then
      return 'late';
    end if;
    if v_occurrence.status <> 'open' or v_activity.state <> 'active' then
      return 'inactive';
    end if;
    for v_user_id in
      select m.user_id from private.pet_care_occurrence_members m where m.occurrence_id = v_occurrence.id
      order by m.user_id
    loop
      perform private.notify_user(v_user_id, v_activity.home_id, 'reminders', 'pet_care.reminder',
        pg_catalog.jsonb_build_object('homeId', v_activity.home_id, 'petId', v_activity.pet_id,
          'activityId', v_activity.id, 'occurrenceId', v_occurrence.id, 'dueDate', v_occurrence.due_on),
        'pet-care-reminder:' || v_occurrence.id::text || ':' || v_user_id::text || ':'
          || extract(epoch from p_at)::bigint::text,
        true);
    end loop;
    return 'notified';
  end
  $$;

-- The vacation reminder (S22) surfaces pet care -----------------------------------------------------------

-- The active pet-care activities of a Home with a date between p_from and p_to, and how many of those
-- have nobody responsible. Vacations never pause pet care (PS L1925); this only tells the managers.
create function private.vacation_pet_care(p_home_id uuid, p_from date, p_to date)
returns table (activities integer, unassigned integer)
  language sql stable security definer set search_path = '' as $$
  -- Every part with a date in the period counts (also one a schedule change ends during the vacation);
  -- an activity is unassigned when none of those parts has anyone responsible.
  select count(*)::integer, count(*) filter (where not x.assigned)::integer
  from (
    select a.id, pg_catalog.bool_or(exists (select 1 from private.pet_care_part_members m where m.part_id = p.id))
      as assigned
    from private.pet_care_activities a
    join private.pet_care_parts p on p.activity_id = a.id
      and (p.superseded_at is null or p.until_date >= p_from)
    join private.pets pet on pet.id = a.pet_id
    where a.home_id = p_home_id and a.deleted_at is null and a.state = 'active' and pet.deleted_at is null
      and private.pet_care_part_next(p, p_from) <= p_to
    group by a.id
  ) x;
  $$;

-- As in 20261104090000_home_vacations.sql, plus the pet care during the vacation in the notice
-- ('petCare', 'petCareUnassigned').
create or replace function public.deliver_vacation_reminder(p_vacation_id uuid, p_starts_on date, p_days integer)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_vacation private.home_vacations;
    v_at timestamptz;
    v_review jsonb;
    v_claimed integer;
    v_care record;
    v_user uuid;
  begin
    if p_vacation_id is null or p_starts_on is null or p_days is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id for update;
    if not found or v_vacation.cancelled_at is not null
       or private.task_today(v_vacation.home_id, null) >= v_vacation.starts_on then
      return 'not_sent';
    end if;
    if v_vacation.starts_on <> p_starts_on or v_vacation.reminder_days is distinct from p_days then
      return 'stale';
    end if;
    v_at := ((v_vacation.starts_on - v_vacation.reminder_days)::timestamp + time '09:00')
      at time zone coalesce(private.home_zone(v_vacation.home_id), 'UTC');
    if v_at > pg_catalog.now() + interval '1 minute' then
      return 'not_due';
    end if;
    v_review := private.vacation_review_items(v_vacation, null);
    select count(*)::integer into v_claimed from private.chore_occurrences o
      where o.home_id = v_vacation.home_id and o.status = 'open' and o.deleted_at is null
        and o.claimed_by is not null and o.due_date between v_vacation.starts_on and v_vacation.ends_on;
    select * into v_care from private.vacation_pet_care(v_vacation.home_id, v_vacation.starts_on, v_vacation.ends_on);
    for v_user in
      select m.user_id from public.home_memberships m
      where m.home_id = v_vacation.home_id and private.can_manage_chores(v_vacation.home_id, m.user_id)
      order by m.user_id
    loop
      perform private.notify_user(
        v_user, v_vacation.home_id, 'reminders', 'vacation.reminder',
        pg_catalog.jsonb_build_object('homeId', v_vacation.home_id, 'vacationId', v_vacation.id,
          'startsOn', v_vacation.starts_on,
          'decisions', (select count(*)::integer from pg_catalog.jsonb_array_elements(v_review) e
            where e -> 'decision' = 'null'::jsonb and not (e ->> 'protected')::boolean),
          'claimed', v_claimed,
          'petCare', v_care.activities,
          'petCareUnassigned', v_care.unassigned),
        'vacation-reminder:' || v_vacation.id::text || ':' || v_vacation.starts_on::text || ':'
          || v_vacation.reminder_days::text,
        true);
    end loop;
    return 'notified';
  end
  $$;

-- Trash --------------------------------------------------------------------------------------------------

-- A care activity's trash entry is for pet managers, and for one with medical details only those with
-- medical manage too (so its title never reaches anyone else). Rechecked on every list, restore and purge.
alter function private.can_see_trash_entry(private.trash_entries, uuid) rename to can_see_trash_entry_before_pet_care;

create function private.can_see_trash_entry(p_entry private.trash_entries, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select case
    when p_entry.item_type <> 'pet_care_activity' then private.can_see_trash_entry_before_pet_care(p_entry, p_user_id)
    when p_user_id is null or p_entry.owner_home_id is null then false
    else coalesce((select private.pet_care_may_edit(p_entry.owner_home_id, a.medical, p_user_id)
      from private.pet_care_activities a where a.id = p_entry.subject_id), false)
  end;
  $$;

alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_pet_care;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_pet_care;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_pet_care;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_pet_care;

-- An activity's conflicts: its pet is in the trash ('pet_in_trash'; restore the pet first) or has 100
-- activities ('care_limit'). Neither can be resolved from the trash.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_activity private.pet_care_activities;
  begin
    if p_entry.item_type <> 'pet_care_activity' then
      return private.trash_conflict_before_pet_care(p_entry);
    end if;
    select * into v_activity from private.pet_care_activities a where a.id = p_entry.subject_id;
    if not found or v_activity.deleted_at is null then
      return 'item_missing';
    end if;
    if exists (select 1 from private.pets p where p.id = v_activity.pet_id and p.deleted_at is not null) then
      return 'pet_in_trash';
    end if;
    if (select count(*) from private.pet_care_activities a
        where a.pet_id = v_activity.pet_id and a.deleted_at is null) >= private.pet_care_limit('activities') then
      return 'care_limit';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case when p_kind = 'care_limit' then array[]::text[]
    else private.trash_conflict_options_before_pet_care(p_kind) end;
  $$;

-- An activity comes back as it was deleted; its schedule continues from today (nothing is created for
-- the days it was in the trash).
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_activity private.pet_care_activities;
    v_head private.pet_care_parts;
    v_today date;
  begin
    if p_entry.item_type <> 'pet_care_activity' then
      return private.trash_item_restore_before_pet_care(p_entry);
    end if;
    select * into v_activity from private.pet_care_activities a
      where a.id = p_entry.subject_id and a.deleted_at is not null;
    if v_activity.id is null then
      raise exception 'activity unavailable' using errcode = '23505';
    end if;
    perform 1 from private.pets p where p.id = v_activity.pet_id for update;
    perform 1 from private.pet_care_activities a where a.id = v_activity.id for update;
    if private.trash_conflict(p_entry) is not null then
      raise exception 'pet care restore conflict' using errcode = '23505';
    end if;
    v_today := private.pet_today(v_activity.home_id);
    v_head := private.pet_care_head(v_activity.id);
    if v_activity.state = 'active' and v_head.id is not null then
      perform private.rewind_pet_care_parts(v_activity.id, v_today);
    end if;
    update private.pet_care_activities a set deleted_at = null, revision = a.revision + 1, updated_at = pg_catalog.now()
      where a.id = v_activity.id;
    perform private.advance_pet_care_activity(v_activity.id, v_today);
    perform private.schedule_pet_care_reminders(v_activity.id);
    perform private.audit_pet_care('pet.care.restored', v_activity.home_id, 'pet_care_activity', v_activity.id);
    return 0;
  end
  $$;

-- Removes an activity for good. Purging a pet first settles the open trash entries of its activities, so
-- nothing is left that could never be restored.
create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_other uuid;
  begin
    if p_entry.item_type = 'pet_care_activity' then
      delete from private.pet_care_activities a where a.id = p_entry.subject_id and a.deleted_at is not null;
      return;
    end if;
    if p_entry.item_type = 'pet' then
      for v_other in
        select t.id from private.trash_entries t
        where t.status = 'trashed' and t.item_type = 'pet_care_activity'
          and t.owner_home_id = p_entry.owner_home_id
          and t.subject_id in (select a.id from private.pet_care_activities a where a.pet_id = p_entry.subject_id)
        order by t.id
      loop
        perform private.trash_purge_one(null, v_other);
      end loop;
    end if;
    perform private.trash_item_purge_before_pet_care(p_entry);
  end
  $$;

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The pet-care API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_pet_care', 'get_pet_care_activity', 'list_home_pet_care', 'pet_care_notice_names', 'create_pet_care',
      'update_pet_care', 'set_pet_care_state', 'delete_pet_care', 'complete_pet_care_occurrence',
      'skip_pet_care_occurrence', 'reopen_pet_care_occurrence', 'correct_pet_care_completion',
      'update_pet_care_occurrence'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The jobs: the service role only.
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('deliver_pet_care_reminder', 'advance_all_pet_care',
      'deliver_vacation_reminder')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%pet%'
      or p.proname in ('can_see_trash_entry', 'trash_conflict', 'trash_conflict_options',
        'trash_item_restore', 'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
