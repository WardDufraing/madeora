-- S22: Home vacations and temporary chore absences (brief plans/steps/S22-brief.md; ADR 0029; spec
-- "Confirmed recurring chore pauses and Home vacation periods", "Confirmed member-scoped vacations and
-- participant approval", "Confirmed expiration of unanswered vacation invitations", "Confirmed
-- individual participant vacation date ranges", "Confirmed participant approval for shared vacation
-- date changes", "Confirmed member withdrawal from group vacations", "Confirmed automatic Home
-- vacation statuses", "Confirmed silent Home vacation change updates", "Confirmed early ending of Home
-- vacations with impact preview", "Confirmed overlapping Home vacations with combined module pauses",
-- "Confirmed optional pre-vacation manager reminders", "Confirmed optional Home vacation names",
-- "Confirmed optional Home vacation dashboard widget", "Confirmed non-recurring Home vacation
-- periods", "Confirmed one-time chore handling during Home vacations", "Confirmed vacation-aware
-- recurring chore rotation", "Confirmed per-occurrence vacation rotation override", "Confirmed
-- no-available-participant rotation resolution" and "Confirmed temporary chore absence periods").
--
-- A vacation (private.home_vacations) is one bounded, non-recurring record of a Home with an explicit
-- set of participants (private.home_vacation_participants), each with their own inclusive dates in
-- the Home's timezone. A participant added by a chore manager, or the creator themselves, is Accepted
-- at once; a member suggested by someone else waits as Pending until they accept, and expires at the
-- start of their proposed start day. A participant changes their own dates; a chore manager changes
-- those of participants a manager added; anyone else's change to a participant's dates is a proposal
-- (private.home_vacation_date_proposals) that only that participant's acceptance makes effective.
-- The vacation's dates are the envelope of its accepted participants' dates; its status (Upcoming,
-- Active, Ended) is derived from them and the Home's today, and Cancelled is final.
--
-- Effects on chores, applied once per occurrence however many vacations overlap:
--   * A member is away on a date when they are an accepted participant of a vacation that is not
--     cancelled and their own dates cover it (never the envelope, pending invitations or proposals).
--   * The Home's chores are paused on a date only when a chore manager confirmed the Home-wide pause
--     of a vacation for that date (home_pause_dates, the dates on which every current member was its
--     accepted participant at confirmation) and every current member is still away in that vacation.
--     So it shrinks on its own (a withdrawal, a shorter stay, a new member) and never grows without a
--     new confirmation; two partial vacations never add up to a Home pause.
--   * Recurring occurrences on a paused date take the status 'paused': not open, not overdue, not
--     claimable, no reminders, no release, no points. New ones are created paused, so a cancelled
--     vacation brings them back; once their date has passed they stay paused (no backfill).
--   * A rotating occurrence whose turn member is away goes to the next member in the rotation order
--     who is a current member and not away; with nobody available it is unassigned and flagged
--     (Needs assignment review). The order and the turns never change; nobody owes catch-up turns.
--   * These rules only touch occurrences nobody touched (open, from today on, not claimed, not in
--     rework, no ticked step, not changed on their own, no open handover or volunteer request, no
--     recorded vacation decision, and still as generated or as a vacation rule left them). A person's
--     change to the assignees ends the vacation handling of that occurrence.
--   * Everything else of an away member (fixed, claimed, one-off, manager-assigned work) is listed in
--     the vacation's review, where a chore manager keeps, skips or reassigns it
--     (private.chore_vacation_decisions). One-off chores due on a paused date are flagged Needs
--     vacation review until decided: not claimable, no automatic release.
--
-- Temporary absences (private.chore_absences) are only a planning signal: nothing changes on its own;
-- the same review lets a chore manager keep, skip or reassign the absent member's work.
--
-- Silent rule: vacation changes notify nobody. Only actionable requests do (an invitation, a date
-- proposal: category 'chores') and the optional pre-vacation reminder to chore managers ('reminders').
--
-- Concurrency: every vacation or absence change takes the Home's vacation lock first, then the
-- vacation row, then chores one at a time in chore order (the S20 rule). Chore pages re-apply the
-- vacation rules lazily (advance_chores), deciding each occurrence again under its chore's lock.

-- Audit subjects, event kinds, occurrence states ---------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence'
  ));

alter table private.chore_occurrence_events drop constraint chore_occurrence_events_kind_check;
alter table private.chore_occurrence_events add constraint chore_occurrence_events_kind_check
  check (kind in ('completed', 'skipped', 'reopened', 'submitted', 'approved', 'rejected',
    'withdrawn', 'corrected', 'claimed', 'released', 'expired', 'reassigned', 'volunteered',
    'assignment_corrected', 'vacation_paused', 'vacation_resumed', 'vacation_substituted',
    'vacation_restored'));
-- For 'vacation_substituted': previous_contributor_id the away member whose turn it was,
-- contributor_id the substitute (null: nobody was available). For 'vacation_restored':
-- previous_contributor_id the former substitute, contributor_id the member whose turn it is.

alter table private.chore_occurrences drop constraint chore_occurrences_status_check;
alter table private.chore_occurrences add constraint chore_occurrences_status_check
  check (status in ('open', 'pending_approval', 'completed', 'skipped', 'expired', 'paused'));

alter table private.chore_occurrences
  -- How a vacation rule left an untouched occurrence: 'substitute' (the turn passed to another
  -- member), 'review' (nobody available: flagged), 'paused' (a Home-paused date). Null: as generated,
  -- or a person changed it.
  add column vacation_state text
    constraint chore_occurrences_vacation_state_check check (vacation_state in ('substitute', 'review', 'paused')),
  -- The away member whose turn it was (substitute and review).
  add column substitute_for uuid references auth.users (id) on delete set null,
  -- Needs vacation review: an open occurrence due on a Home-paused date that a vacation rule cannot
  -- handle (a one-off chore, or one a person touched) and no chore manager decided yet.
  add column vacation_review boolean not null default false,
  add column paused_at timestamptz;

alter table private.chore_occurrences add constraint chore_occurrences_vacation_check check (
  (status = 'paused') = (paused_at is not null)
  and (status = 'paused') = coalesce(vacation_state = 'paused', false)
  and (status = 'open' or not vacation_review));

create index chore_occurrences_home_review_idx on private.chore_occurrences (home_id)
  where vacation_review and deleted_at is null;

-- Tables -------------------------------------------------------------------------------------------------

create table private.home_vacations (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  -- Optional display name (trimmed; empty is none: the generic "Home vacation").
  name text constraint home_vacations_name_check check (name is null or private.is_visible_name(name, 80)),
  -- The envelope of the accepted participants' dates (kept as they were when nobody is left).
  starts_on date not null,
  ends_on date not null,
  created_by uuid references auth.users (id) on delete set null,
  -- Pre-vacation reminder to chore managers, this many days before the start (null: off).
  reminder_days integer constraint home_vacations_reminder_check check (reminder_days between 1 and 30),
  -- The confirmed Home-wide chore pause: the dates on which every current member was an accepted
  -- participant when a chore manager confirmed it (null: none).
  home_pause_dates datemultirange,
  home_pause_by uuid references auth.users (id) on delete set null,
  home_pause_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint home_vacations_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint home_vacations_id_home_key unique (id, home_id),
  constraint home_vacations_dates_check check (ends_on >= starts_on),
  constraint home_vacations_pause_check check ((home_pause_dates is null) = (home_pause_at is null))
);

create index home_vacations_home_idx on private.home_vacations (home_id, ends_on desc);

-- One member's participation in a vacation (one row per invitation or addition; a new invitation
-- after an expired, declined or withdrawn one is a new row, so nothing is ever revived).
create table private.home_vacation_participants (
  id uuid primary key,
  vacation_id uuid not null,
  home_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  status text not null constraint home_vacation_participants_status_check
    check (status in ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
  -- Accepted: the effective dates. Pending: the proposed dates (the invitation expires at the start).
  starts_on date not null,
  ends_on date not null,
  -- Added by a chore manager: a manager changes their dates directly.
  direct boolean not null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  -- Who ended an accepted or pending participation, and why: 'self', 'manager', 'creator',
  -- 'shortened', 'cancelled', 'departure'.
  ended_by uuid references auth.users (id) on delete set null,
  ended_reason text constraint home_vacation_participants_reason_check
    check (ended_reason in ('self', 'manager', 'creator', 'shortened', 'cancelled', 'departure')),
  revision integer not null default 1 constraint home_vacation_participants_revision_check check (revision >= 1),
  constraint home_vacation_participants_dates_check check (ends_on >= starts_on),
  foreign key (vacation_id, home_id) references private.home_vacations (id, home_id) on delete cascade
);

create unique index home_vacation_participants_one_open on private.home_vacation_participants (vacation_id, user_id)
  where status in ('pending', 'accepted');
create index home_vacation_participants_member_idx on private.home_vacation_participants (home_id, user_id)
  where status = 'accepted';
create index home_vacation_participants_vacation_idx on private.home_vacation_participants (vacation_id);

-- A proposed change to an accepted participant's dates, waiting for that participant.
create table private.home_vacation_date_proposals (
  id uuid primary key,
  participant_id uuid not null references private.home_vacation_participants (id) on delete cascade,
  vacation_id uuid not null,
  home_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  proposed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  status text not null default 'pending' constraint home_vacation_date_proposals_status_check
    check (status in ('pending', 'accepted', 'declined', 'superseded', 'withdrawn')),
  decided_at timestamptz,
  constraint home_vacation_date_proposals_dates_check check (ends_on >= starts_on),
  constraint home_vacation_date_proposals_decision_check check ((status = 'pending') = (decided_at is null)),
  foreign key (vacation_id, home_id) references private.home_vacations (id, home_id) on delete cascade
);

create unique index home_vacation_date_proposals_one_pending on private.home_vacation_date_proposals (participant_id)
  where status = 'pending';

-- Every change to a vacation, in order (append-only): who did what, to whom, with which dates.
create table private.home_vacation_events (
  id bigint generated always as identity primary key,
  vacation_id uuid not null references private.home_vacations (id) on delete cascade,
  kind text not null constraint home_vacation_events_kind_check check (kind in (
    'created', 'renamed', 'invited', 'added', 'accepted', 'declined', 'withdrawn', 'removed',
    'invitation_withdrawn', 'dates_changed', 'dates_proposed', 'proposal_accepted',
    'proposal_declined', 'proposal_withdrawn', 'shortened', 'cancelled', 'home_pause_confirmed',
    'home_pause_removed', 'reminder_changed', 'left_home')),
  actor_id uuid references auth.users (id) on delete set null,
  subject_id uuid references auth.users (id) on delete set null,
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now()
);

create index home_vacation_events_vacation_idx on private.home_vacation_events (vacation_id, id);

-- A member's temporary chore absence: a planning signal only.
create table private.chore_absences (
  id uuid primary key,
  home_id uuid not null,
  user_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  reason text constraint chore_absences_reason_check check (reason is null or private.is_plain_text(reason, 200)),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  revision integer not null default 1 constraint chore_absences_revision_check check (revision >= 1),
  constraint chore_absences_dates_check check (ends_on >= starts_on),
  -- The absence ends with the membership.
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index chore_absences_member_idx on private.chore_absences (home_id, user_id, ends_on);

-- A chore manager's decision on one occurrence for one vacation or absence (never asked again for
-- that source, never reverted by a later change).
create table private.chore_vacation_decisions (
  id bigint generated always as identity primary key,
  occurrence_id uuid not null,
  home_id uuid not null,
  source_kind text not null constraint chore_vacation_decisions_source_check
    check (source_kind in ('vacation', 'absence')),
  source_id uuid not null,
  decision text not null constraint chore_vacation_decisions_decision_check
    check (decision in ('keep', 'skip', 'reassign', 'reschedule')),
  to_user uuid references auth.users (id) on delete set null,
  new_date date,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz not null default now(),
  foreign key (occurrence_id, home_id) references private.chore_occurrences (id, home_id) on delete cascade,
  constraint chore_vacation_decisions_once unique (occurrence_id, source_kind, source_id)
);

create index chore_vacation_decisions_source_idx on private.chore_vacation_decisions (source_id);

alter table private.home_vacations enable row level security;
alter table private.home_vacation_participants enable row level security;
alter table private.home_vacation_date_proposals enable row level security;
alter table private.home_vacation_events enable row level security;
alter table private.chore_absences enable row level security;
alter table private.chore_vacation_decisions enable row level security;
revoke all on table private.home_vacations, private.home_vacation_participants,
  private.home_vacation_date_proposals, private.home_vacation_events, private.chore_absences,
  private.chore_vacation_decisions from public, anon, authenticated;

comment on table private.home_vacations is 'S22: Home vacations. Not exposed through the API.';
comment on table private.chore_absences is 'S22: temporary chore absences. Not exposed through the API.';

-- Vacations move the chore pool's Realtime signal (the pool and widgets show their effects).
create constraint trigger home_vacations_signal after insert or update on private.home_vacations
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger home_vacation_participants_signal after insert or update on private.home_vacation_participants
  deferrable initially deferred for each row execute function private.bump_chore_signal();

-- Limits and small helpers -------------------------------------------------------------------------------

-- apps/web/src/vacations/schema.ts uses the same numbers.
create function private.vacation_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'name' then 80
    when 'people' then 20              -- participants one change names
    when 'days' then 366               -- the longest stay of one participant (inclusive days)
    when 'ahead' then 730              -- how far ahead a stay may start
    when 'reminder_days' then 30
    when 'reason' then 200             -- an absence's reason
    when 'review' then 200             -- occurrences one review read returns
    when 'planned' then 50             -- planned dates one review read returns
    when 'history' then 100            -- ended and cancelled vacations one list returns
    when 'events' then 100             -- history entries one vacation read returns
    when 'absences' then 200           -- absences one list returns
    when 'calendar_days' then 42
  end;
  $$;

-- A vacation name from the API: whitespace runs read as one space, trimmed; empty is no name.
create function private.vacation_name(p_text text) returns text
  language sql immutable set search_path = '' as $$
  select nullif(pg_catalog.btrim(pg_catalog.regexp_replace(p_text, '\s+', ' ', 'g')), '');
  $$;

-- Whether a stay is acceptable as new dates: starting no earlier than p_earliest (today, or the
-- current start of a stay already under way) and at most 'ahead' days ahead, ending no earlier than
-- yesterday (ending early), at most 'days' days long.
create function private.valid_vacation_stay(
  p_starts_on date, p_ends_on date, p_today date, p_earliest date
) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_starts_on >= least(p_today, p_earliest) and p_starts_on <= p_today + private.vacation_limit('ahead')
    and p_ends_on >= p_starts_on and p_ends_on >= p_today - 1
    and p_ends_on - p_starts_on < private.vacation_limit('days'), false);
  $$;

-- The derived status of a vacation on the Home's today.
create function private.vacation_status(p_vacation private.home_vacations, p_today date) returns text
  language sql immutable set search_path = '' as $$
  select case
    when p_vacation.cancelled_at is not null then 'cancelled'
    when p_today < p_vacation.starts_on then 'upcoming'
    when p_today <= p_vacation.ends_on then 'active'
    else 'ended' end;
  $$;

-- A participation's state, with a pending invitation read as expired from its proposed start day.
create function private.vacation_participant_status(
  p_participant private.home_vacation_participants, p_today date
) returns text
  language sql immutable set search_path = '' as $$
  select case when p_participant.status = 'pending' and p_today >= p_participant.starts_on
    then 'expired' else p_participant.status end;
  $$;

-- Serializes vacation and absence changes within one Home.
create function private.lock_home_vacations(p_home_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select private.lock_chore_home('vacations', p_home_id);
  $$;

create function private.audit_vacation(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids, counts and flags only: never names, reasons or dates of a person.
  select private.audit(p_action, p_home_id, p_subject_type, p_subject_id, p_details);
  $$;

create function private.vacation_event(
  p_vacation_id uuid, p_kind text, p_actor uuid, p_subject uuid default null,
  p_starts_on date default null, p_ends_on date default null
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.home_vacation_events (vacation_id, kind, actor_id, subject_id, starts_on, ends_on)
  values (p_vacation_id, p_kind, p_actor, p_subject, p_starts_on, p_ends_on);
  $$;

-- People from the API: an array of {"memberId": membership id, "startsOn": date, "endsOn": date},
-- 1–20, no member twice. 22023 when malformed; user_id null for one who is not a current member.
create function private.vacation_people(p_home_id uuid, p_people jsonb)
returns table (user_id uuid, member_id uuid, starts_on date, ends_on date)
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_people is null or pg_catalog.jsonb_typeof(p_people) <> 'array'
       or pg_catalog.jsonb_array_length(p_people) not between 1 and private.vacation_limit('people')
       or exists (
         select 1 from pg_catalog.jsonb_array_elements(p_people) e (p)
         where pg_catalog.jsonb_typeof(e.p) <> 'object'
           or pg_catalog.jsonb_typeof(e.p -> 'memberId') <> 'string'
           or (e.p ->> 'memberId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or pg_catalog.jsonb_typeof(e.p -> 'startsOn') <> 'string'
           or (e.p ->> 'startsOn') !~ '^\d{4}-\d{2}-\d{2}$'
           or pg_catalog.jsonb_typeof(e.p -> 'endsOn') <> 'string'
           or (e.p ->> 'endsOn') !~ '^\d{4}-\d{2}-\d{2}$')
       or (select count(distinct e.p ->> 'memberId') from pg_catalog.jsonb_array_elements(p_people) e (p))
         <> pg_catalog.jsonb_array_length(p_people) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    begin
      return query
        select m.user_id, (e.p ->> 'memberId')::uuid, (e.p ->> 'startsOn')::date, (e.p ->> 'endsOn')::date
        from pg_catalog.jsonb_array_elements(p_people) with ordinality as e (p, o)
        left join public.home_memberships m on m.home_id = p_home_id and m.id = (e.p ->> 'memberId')::uuid
        order by e.o;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'invalid request' using errcode = '22023';
    end;
  end
  $$;

-- Who is away when ---------------------------------------------------------------------------------------

-- Whether a member is away on a date: an accepted participant of a vacation that is not cancelled,
-- whose own dates cover it.
create function private.vacation_away(p_home_id uuid, p_user_id uuid, p_date date) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_user_id is not null and exists (
    select 1 from private.home_vacation_participants p
    join private.home_vacations v on v.id = p.vacation_id
    where p.home_id = p_home_id and p.user_id = p_user_id and p.status = 'accepted'
      and v.cancelled_at is null and p_date between p.starts_on and p.ends_on), false);
  $$;

-- Whether every current member of the Home is an accepted participant of this vacation on a date.
create function private.vacation_everyone_away(p_vacation private.home_vacations, p_date date) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.home_memberships m where m.home_id = p_vacation.home_id)
    and not exists (
      select 1 from public.home_memberships m
      where m.home_id = p_vacation.home_id and not exists (
        select 1 from private.home_vacation_participants p
        where p.vacation_id = p_vacation.id and p.user_id = m.user_id and p.status = 'accepted'
          and p_date between p.starts_on and p.ends_on));
  $$;

-- The dates of a vacation, from p_from on, on which every current member is its accepted participant.
create function private.vacation_full_dates(p_vacation private.home_vacations, p_from date) returns datemultirange
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.range_agg(pg_catalog.daterange(d::date, d::date + 1)), '{}'::datemultirange)
  from pg_catalog.generate_series(greatest(p_vacation.starts_on, p_from)::timestamp,
    p_vacation.ends_on::timestamp, interval '1 day') as g (d)
  where p_vacation.cancelled_at is null and private.vacation_everyone_away(p_vacation, d::date);
  $$;

-- The dates on which a vacation pauses the Home's chores now: confirmed, and still everyone away.
create function private.vacation_pause_dates(p_vacation private.home_vacations) returns datemultirange
  language sql stable security definer set search_path = '' as $$
  select case when p_vacation.home_pause_dates is null or p_vacation.cancelled_at is not null
    then '{}'::datemultirange
    else p_vacation.home_pause_dates * private.vacation_full_dates(p_vacation, p_vacation.starts_on) end;
  $$;

-- Whether the Home's chores are paused on a date (by at least one vacation).
create function private.home_chores_paused_on(p_home_id uuid, p_date date) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(exists (
    select 1 from private.home_vacations v
    where v.home_id = p_home_id and v.cancelled_at is null and v.home_pause_dates @> p_date
      and private.vacation_everyone_away(v, p_date)), false);
  $$;

-- Re-reads a vacation's envelope from its accepted participants (unchanged when there are none).
create function private.refresh_vacation_envelope(p_vacation_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.home_vacations v set starts_on = x.s, ends_on = x.e
      from (select min(p.starts_on) as s, max(p.ends_on) as e from private.home_vacation_participants p
        where p.vacation_id = p_vacation_id and p.status = 'accepted') x
      where v.id = p_vacation_id and x.s is not null
        and (v.starts_on is distinct from x.s or v.ends_on is distinct from x.e);
  end
  $$;

-- Applying the rules to occurrences ----------------------------------------------------------------------

-- The rotation member who takes a turn whose member is away: the next place in the order after the
-- turn's place (wrapping) held by a current member who is not away on that date; null when none.
create function private.chore_vacation_substitute(p_part private.chore_schedules, p_date date) returns uuid
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_places integer;
    v_turn integer;
    v_user uuid;
  begin
    select count(*)::integer into v_places from private.chore_schedule_members m where m.schedule_id = p_part.id;
    if v_places < 2 then
      return null;
    end if;
    v_turn := private.chore_turn(p_part.frequency, p_part.interval_count, p_part.weekdays, p_part.starts_on,
      p_part.rotation_from, p_date) % v_places;
    for i in 1 .. v_places - 1 loop
      select m.user_id into v_user from private.chore_schedule_members m
        where m.schedule_id = p_part.id and m.position = (v_turn + i) % v_places;
      if v_user is not null and not private.vacation_away(p_part.home_id, v_user, p_date) then
        return v_user;
      end if;
    end loop;
    return null;
  end
  $$;

-- What the vacation rules want for an occurrence: whether they manage it (untouched, from p_from
-- on), its status, assignees (sorted), flag, vacation state and substitute_for, and whether it
-- needs a vacation review. For one they do not manage, everything but the review flag stays.
-- `orphan`: a paused occurrence its chore would no longer have (the chore ended, its own pause
-- covers the date, or a schedule change or "delete following" dropped the date). The chore
-- functions only change open occurrences, so the rules remove these instead of ever reopening
-- them: the stricter pause wins, and a date the schedule still has is created again when due.
create function private.chore_vacation_target(
  p_occurrence private.chore_occurrences, p_from date,
  out managed boolean, out status text, out users uuid[], out flagged boolean, out state text,
  out substitute_for uuid, out review boolean, out orphan boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_chore private.chores;
    v_part private.chore_schedules;
    v_base uuid[];
    v_base_flag boolean;
    v_sub uuid;
    v_decided boolean;
  begin
    managed := false;
    orphan := false;
    status := p_occurrence.status;
    flagged := p_occurrence.needs_reassignment;
    state := p_occurrence.vacation_state;
    substitute_for := p_occurrence.substitute_for;
    select coalesce(array_agg(a.user_id order by a.user_id), '{}') into users
      from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence.id;
    review := p_occurrence.vacation_review;
    select * into v_chore from private.chores c where c.id = p_occurrence.chore_id;
    if p_occurrence.deleted_at is not null or v_chore.deleted_at is not null then
      return;
    end if;
    if p_occurrence.status = 'paused' and p_occurrence.schedule_id is not null
       and p_occurrence.scheduled_date >= p_from then
      select * into v_part from private.chore_schedules s where s.id = p_occurrence.schedule_id;
      if v_chore.ended_at is not null or not found
         or not private.chore_part_has_date(v_part, p_occurrence.scheduled_date)
         or private.chore_paused_on(v_part, p_occurrence.scheduled_date) then
        orphan := true;
        return;
      end if;
    end if;
    v_decided := exists (select 1 from private.chore_vacation_decisions d where d.occurrence_id = p_occurrence.id);
    if p_occurrence.schedule_id is not null and p_occurrence.status in ('open', 'paused')
       and v_chore.ended_at is null and not p_occurrence.in_rework and not p_occurrence.detached
       and p_occurrence.claimed_by is null and p_occurrence.scheduled_date >= p_from and not v_decided
       and not private.chore_has_progress(p_occurrence.id)
       and not exists (select 1 from private.chore_reassignment_requests r
         where r.occurrence_id = p_occurrence.id and r.status in ('pending', 'awaiting_manager'))
       and not exists (select 1 from private.chore_volunteer_requests r
         where r.occurrence_id = p_occurrence.id and r.status = 'open') then
      select * into v_part from private.chore_schedules s where s.id = p_occurrence.schedule_id;
      if found then
        select coalesce((select array_agg(u order by u) from unnest(a.user_ids) u), '{}'), a.flagged
          into v_base, v_base_flag
          from private.chore_part_assignees(v_part, p_occurrence.scheduled_date) a;
        managed := p_occurrence.vacation_state is not null
          or (users = v_base and p_occurrence.needs_reassignment = v_base_flag);
      end if;
    end if;
    if managed then
      review := false;
      if private.home_chores_paused_on(p_occurrence.home_id, p_occurrence.scheduled_date) then
        status := 'paused';
        users := v_base;
        flagged := v_base_flag;
        state := 'paused';
        substitute_for := null;
      elsif v_part.assignment = 'rotating' and cardinality(v_base) = 1
         and private.vacation_away(p_occurrence.home_id, v_base[1], p_occurrence.scheduled_date) then
        v_sub := private.chore_vacation_substitute(v_part, p_occurrence.scheduled_date);
        status := 'open';
        substitute_for := v_base[1];
        if v_sub is not null then
          users := array[v_sub];
          flagged := false;
          state := 'substitute';
        else
          users := '{}';
          flagged := true;
          state := 'review';
        end if;
      else
        status := 'open';
        users := v_base;
        flagged := v_base_flag;
        state := null;
        substitute_for := null;
      end if;
      return;
    end if;
    review := p_occurrence.status = 'open' and not v_decided
      and private.home_chores_paused_on(p_occurrence.home_id, p_occurrence.due_date);
  end
  $$;

-- Whether the rules want a change to the occurrence.
create function private.chore_vacation_differs(p_occurrence private.chore_occurrences, p_from date) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  declare
    t record;
  begin
    select * into t from private.chore_vacation_target(p_occurrence, p_from);
    return t.orphan or t.status is distinct from p_occurrence.status
      or t.flagged is distinct from p_occurrence.needs_reassignment
      or t.state is distinct from p_occurrence.vacation_state
      or t.substitute_for is distinct from p_occurrence.substitute_for
      or t.review is distinct from p_occurrence.vacation_review
      or t.users is distinct from coalesce((select array_agg(a.user_id order by a.user_id)
        from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence.id), '{}');
  end
  $$;

-- Applies the rules to one occurrence (its chore locked by the caller). Returns what changed, for
-- previews: {occurrenceId, choreId, title, date, dueDate, change, from, to, for}, or null.
-- change: 'paused', 'resumed', 'substituted', 'no_substitute', 'restored', 'needs_review',
-- 'review_cleared'.
create function private.apply_chore_vacation(p_occurrence_id uuid, p_from date) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_o private.chore_occurrences;
    t record;
    v_current uuid[];
    v_change text;
    v_title text;
  begin
    select * into v_o from private.chore_occurrences o where o.id = p_occurrence_id for update;
    if not found then
      return null;
    end if;
    select * into t from private.chore_vacation_target(v_o, p_from);
    if t.orphan then
      -- Like an untouched occurrence a chore pause or schedule change removes (S20).
      delete from private.chore_occurrences o where o.id = v_o.id;
      return null;
    end if;
    select coalesce(array_agg(a.user_id order by a.user_id), '{}') into v_current
      from private.chore_occurrence_assignees a where a.occurrence_id = v_o.id;
    if t.status is not distinct from v_o.status and t.users is not distinct from v_current
       and t.flagged is not distinct from v_o.needs_reassignment
       and t.state is not distinct from v_o.vacation_state
       and t.substitute_for is not distinct from v_o.substitute_for
       and t.review is not distinct from v_o.vacation_review then
      return null;
    end if;
    v_change := case
      when t.status = 'paused' and v_o.status <> 'paused' then 'paused'
      when v_o.status = 'paused' and t.status <> 'paused' then 'resumed'
      when t.state = 'substitute' then 'substituted'
      when t.state = 'review' then 'no_substitute'
      when t.state is null and v_o.vacation_state is not null then 'restored'
      when t.review then 'needs_review'
      else 'review_cleared' end;
    -- The assignee trigger leaves the vacation state alone for changes made here.
    perform pg_catalog.set_config('madeora.vacation_apply', 'on', true);
    if t.users is distinct from v_current then
      perform private.set_occurrence_assignees(v_o.id, v_o.home_id, t.users);
    end if;
    update private.chore_occurrences o
      set status = t.status,
        paused_at = case when t.status = 'paused' then coalesce(o.paused_at, pg_catalog.now()) end,
        vacation_state = t.state, substitute_for = t.substitute_for, needs_reassignment = t.flagged,
        vacation_review = t.review, revision = o.revision + 1, updated_at = pg_catalog.now()
      where o.id = v_o.id;
    perform pg_catalog.set_config('madeora.vacation_apply', 'off', true);
    if v_change in ('paused', 'resumed') then
      insert into private.chore_occurrence_events (occurrence_id, kind)
        values (v_o.id, 'vacation_' || v_change);
    elsif v_change in ('substituted', 'no_substitute') then
      insert into private.chore_occurrence_events (occurrence_id, kind, contributor_id, previous_contributor_id)
        values (v_o.id, 'vacation_substituted', t.users[1], t.substitute_for);
    elsif v_change = 'restored' then
      insert into private.chore_occurrence_events (occurrence_id, kind, contributor_id, previous_contributor_id)
        values (v_o.id, 'vacation_restored', t.users[1], v_current[1]);
    end if;
    select c.title into v_title from private.chores c where c.id = v_o.chore_id;
    return pg_catalog.jsonb_build_object(
      'occurrenceId', v_o.id, 'choreId', v_o.chore_id, 'title', v_title, 'date', v_o.scheduled_date,
      'dueDate', v_o.due_date, 'change', v_change,
      'from', coalesce((select pg_catalog.jsonb_agg(private.member_ref(v_o.home_id, u) order by u)
        from unnest(v_current) u), '[]'::jsonb),
      'to', coalesce((select pg_catalog.jsonb_agg(private.member_ref(v_o.home_id, u) order by u)
        from unnest(t.users) u), '[]'::jsonb),
      'for', private.member_ref(v_o.home_id, t.substitute_for));
  end
  $$;

-- Applies the rules to the Home's occurrences that may need it (from today on, and open ones flagged
-- for review), one chore lock at a time in chore order, deciding each again under its lock. Only
-- occurrences whose state differs are locked. Returns the changes.
create function private.reconcile_chore_vacations(p_home_id uuid, p_chore_id uuid default null) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_today date := private.task_today(p_home_id, null);
    v_item record;
    v_occurrence private.chore_occurrences;
    v_change jsonb;
    v_changes jsonb := '[]'::jsonb;
  begin
    for v_item in
      select o.id, o.chore_id from private.chore_occurrences o
      join private.chores c on c.id = o.chore_id
      where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
        and (p_chore_id is null or o.chore_id = p_chore_id)
        and ((o.status in ('open', 'paused') and o.scheduled_date >= v_today)
          or (o.status = 'open' and (o.vacation_review or o.due_date >= v_today)))
      order by o.chore_id, o.id
    loop
      select * into v_occurrence from private.chore_occurrences o where o.id = v_item.id;
      if not private.chore_vacation_differs(v_occurrence, v_today) then
        continue;
      end if;
      perform 1 from private.chores c where c.id = v_item.chore_id for update;
      v_change := private.apply_chore_vacation(v_item.id, v_today);
      if v_change is not null then
        v_changes := v_changes || pg_catalog.jsonb_build_array(v_change);
      end if;
    end loop;
    return v_changes;
  end
  $$;

-- A person changing an occurrence's assignees ends its vacation handling (it is theirs now).
create function private.chore_vacation_assignees_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if pg_catalog.current_setting('madeora.vacation_apply', true) = 'on' then
      return null;
    end if;
    update private.chore_occurrences o set vacation_state = null, substitute_for = null
      where o.id = case when tg_op = 'DELETE' then old.occurrence_id else new.occurrence_id end
        and o.vacation_state in ('substitute', 'review');
    return null;
  end
  $$;

create trigger chore_occurrence_assignees_vacation after insert or delete on private.chore_occurrence_assignees
  for each row execute function private.chore_vacation_assignees_changed();

-- An occurrence that leaves 'open' (completed, submitted, skipped, expired) no longer needs a review;
-- one that leaves 'paused' other than through the rules drops its pause marks.
create function private.chore_vacation_status_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.status <> 'open' then
      new.vacation_review := false;
    end if;
    if old.status = 'paused' and new.status <> 'paused' then
      new.paused_at := null;
      if new.vacation_state = 'paused' then
        new.vacation_state := null;
      end if;
    end if;
    return new;
  end
  $$;

create trigger chore_occurrences_vacation_status before update of status on private.chore_occurrences
  for each row when (new.status is distinct from old.status)
  execute function private.chore_vacation_status_changed();

-- Chore functions follow the rules ------------------------------------------------------------------------

-- New occurrences are created with the rules applied (paused on a Home-paused date, a substitute for
-- an away rotation member), whatever their date: nobody touched them yet.
alter function private.create_chore_occurrence(private.chore_schedules, date)
  rename to create_chore_occurrence_before_vacations;

create function private.create_chore_occurrence(p_part private.chore_schedules, p_date date) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid := private.create_chore_occurrence_before_vacations(p_part, p_date);
  begin
    if v_id is not null then
      perform private.apply_chore_vacation(v_id, '-infinity'::date);
    end if;
    return v_id;
  end
  $$;

-- Chore pages re-apply the rules (membership changes, time passing, vacations changed elsewhere).
alter function public.advance_chores(uuid) set schema private;
alter function private.advance_chores(uuid) rename to advance_chores_before_vacations;

create function public.advance_chores(p_home_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_created integer := private.advance_chores_before_vacations(p_home_id);
  begin
    perform private.reconcile_chore_vacations(p_home_id, null);
    return v_created;
  end
  $$;

-- A series change rebuilds untouched occurrences from the schedule; the rules then apply again.
alter function public.update_chore_series(uuid, text, integer, integer, boolean, jsonb, jsonb, boolean,
  integer, boolean, text, integer, smallint[], date, date, integer) set schema private;
alter function private.update_chore_series(uuid, text, integer, integer, boolean, jsonb, jsonb, boolean,
  integer, boolean, text, integer, smallint[], date, date, integer) rename to update_chore_series_before_vacations;

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
    v_row record;
    v_home uuid;
    v_chore uuid;
  begin
    select * into v_row from private.update_chore_series_before_vacations(p_occurrence_id, p_scope,
      p_expected_revision, p_expected_schedule_revision, p_dry_run, p_assignment, p_steps,
      p_set_minutes, p_minutes, p_set_schedule, p_frequency, p_interval, p_weekdays, p_starts_on,
      p_ends_on, p_max_count) x;
    if v_row.outcome = 'saved' then
      select o.home_id, o.chore_id into v_home, v_chore from private.chore_occurrences o
        where o.id = coalesce(v_row.occurrence_id, p_occurrence_id);
      if v_chore is not null then
        perform private.reconcile_chore_vacations(v_home, v_chore);
      end if;
    end if;
    return query select v_row.outcome, v_row.impact, v_row.revision, v_row.occurrence_id;
  end
  $$;

-- A paused occurrence cannot be completed, skipped or reopened (it is not outstanding work).
alter function public.complete_chore_occurrence(uuid, uuid, text) set schema private;
alter function private.complete_chore_occurrence(uuid, uuid, text) rename to complete_chore_occurrence_before_vacations;

create function public.complete_chore_occurrence(
  p_occurrence_id uuid, p_contributor uuid, p_note text default null
) returns table (
  outcome text, completed_at timestamptz, completed_by_me boolean, completed_by_member uuid,
  contributor_me boolean, contributor_member uuid, open_mandatory integer, revision integer
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, private.require_confirmed_caller());
    if v_occurrence.status = 'paused' then
      return query select 'occurrence_closed', null::timestamptz, false, null::uuid, false, null::uuid,
        null::integer, v_occurrence.revision;
      return;
    end if;
    return query select * from private.complete_chore_occurrence_before_vacations(p_occurrence_id, p_contributor, p_note);
  end
  $$;

alter function public.skip_chore_occurrence(uuid, text) set schema private;
alter function private.skip_chore_occurrence(uuid, text) rename to skip_chore_occurrence_before_vacations;

create function public.skip_chore_occurrence(p_occurrence_id uuid, p_reason text default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, private.require_confirmed_caller());
    if v_occurrence.status = 'paused' then
      return query select 'occurrence_closed', v_occurrence.revision;
      return;
    end if;
    return query select * from private.skip_chore_occurrence_before_vacations(p_occurrence_id, p_reason);
  end
  $$;

alter function public.reopen_chore_occurrence(uuid) set schema private;
alter function private.reopen_chore_occurrence(uuid) rename to reopen_chore_occurrence_before_vacations;

create function public.reopen_chore_occurrence(p_occurrence_id uuid)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, private.require_confirmed_caller());
    if v_occurrence.status = 'paused' then
      return query select 'occurrence_closed', v_occurrence.revision;
      return;
    end if;
    return query select * from private.reopen_chore_occurrence_before_vacations(p_occurrence_id);
  end
  $$;

-- Claims: a paused occurrence, or one waiting for a vacation review, is not claimable (S21's rule
-- otherwise unchanged).
create or replace function private.chore_claim_block(
  p_occurrence private.chore_occurrences, p_chore private.chores, p_user uuid, p_today date,
  p_week_start text
) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_cutoff date;
  begin
    case p_occurrence.status
      when 'pending_approval' then return 'pending_approval';
      when 'completed' then return 'already_completed';
      when 'skipped' then return 'already_skipped';
      when 'expired' then return 'expired';
      when 'paused' then return 'not_claimable';
      else null;
    end case;
    if exists (select 1 from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence.id) then
      return case when p_occurrence.claimed_by is not null then 'already_claimed' else 'assigned' end;
    end if;
    if p_occurrence.needs_reassignment or p_occurrence.vacation_review or p_chore.ended_at is not null
       or p_chore.claim_mode = 'none' then
      return 'not_claimable';
    end if;
    v_cutoff := private.chore_claim_cutoff(p_occurrence, p_chore, p_week_start);
    if v_cutoff is not null and p_today >= v_cutoff then
      return 'expired';
    end if;
    if p_chore.claim_mode = 'selected' and not exists (
      select 1 from private.chore_claimants k where k.chore_id = p_chore.id and k.user_id = p_user
    ) then
      return 'not_eligible';
    end if;
    return null;
  end
  $$;

-- Nor does one waiting for a vacation review close unclaimed at the end of its week.
create or replace function private.chore_expires(
  p_occurrence private.chore_occurrences, p_chore private.chores, p_week_start text, p_today date
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_occurrence.status = 'open' and p_occurrence.deleted_at is null
    and not p_occurrence.needs_reassignment and not p_occurrence.vacation_review
    and p_chore.claim_mode <> 'none' and p_chore.deleted_at is null
    and p_today >= private.chore_claim_cutoff(p_occurrence, p_chore, p_week_start)
    and not exists (select 1 from private.chore_occurrence_assignees a
      where a.occurrence_id = p_occurrence.id), false);
  $$;

-- Automatic release waits while the occurrence needs a vacation review or its claimant is away
-- (spec: release timers are suspended during vacations; they apply again afterwards).
create or replace function private.auto_release_chore_claim(p_occurrence_id uuid, p_claim integer) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_at timestamptz;
    v_status text;
  begin
    select * into v_occurrence from private.chore_occurrences o where o.id = p_occurrence_id for update;
    if not found or v_occurrence.deleted_at is not null or v_occurrence.status <> 'open'
       or v_occurrence.in_rework or v_occurrence.claimed_by is null or v_occurrence.vacation_review
       or (p_claim is not null and v_occurrence.claim_count <> p_claim)
       or private.vacation_away(v_occurrence.home_id, v_occurrence.claimed_by,
         private.task_today(v_occurrence.home_id, null)) then
      return null;
    end if;
    select * into v_chore from private.chores c where c.id = v_occurrence.chore_id;
    v_at := private.chore_release_at(v_occurrence, v_chore, private.home_zone(v_occurrence.home_id));
    if v_at is null or v_at > pg_catalog.now() then
      return null;
    end if;
    v_status := private.end_chore_claim(v_occurrence, null, 'auto');
    perform private.notify_user(
      v_occurrence.claimed_by, v_occurrence.home_id, 'chores', 'chore.claim_released',
      pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id,
        'reason', 'auto'),
      'chore-claim-released:' || v_occurrence.id::text || ':' || v_occurrence.claim_count::text, true);
    perform private.audit_chore('chore_occurrence.released', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('reason', 'auto'));
    return v_status;
  end
  $$;

-- The pool leaves out occurrences waiting for a vacation review.
alter function public.list_chore_pool(uuid, date) set schema private;
alter function private.list_chore_pool(uuid, date) rename to list_chore_pool_before_vacations;

create function public.list_chore_pool(p_home_id uuid, p_date date default null)
returns table (
  id uuid, chore_id uuid, title text, kind text, category_id uuid, category_name text,
  category_color text, scheduled_date date, due_date date, section text, overdue boolean,
  minutes integer, steps_total integer, requires_approval boolean, restricted boolean,
  eligible boolean, closes_on date, revision integer, week_start date, today date, truncated boolean
)
  language sql stable security definer set search_path = '' as $$
  select l.* from private.list_chore_pool_before_vacations(p_home_id, p_date) l
  where not exists (select 1 from private.chore_occurrences o where o.id = l.id and o.vacation_review);
  $$;

-- Assigning a member who is away on the due date is an explicit override (spec "per-occurrence
-- vacation rotation override"): the answer is 'member_away' with who and when, unless p_confirm_away.
-- The preview names them as well. Eligibility rules are unchanged.
alter function public.update_chore_occurrence(uuid, integer, boolean, date, uuid[], boolean, integer,
  jsonb, boolean, boolean) set schema private;
alter function private.update_chore_occurrence(uuid, integer, boolean, date, uuid[], boolean, integer,
  jsonb, boolean, boolean) rename to update_chore_occurrence_before_vacations;

create function public.update_chore_occurrence(
  p_occurrence_id uuid, p_expected_revision integer, p_dry_run boolean,
  p_due_date date default null, p_assignee_ids uuid[] default null,
  p_set_minutes boolean default false, p_minutes integer default null,
  p_steps jsonb default null, p_confirm_checklist boolean default false,
  p_confirm_release boolean default false, p_confirm_away boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
    v_users uuid[];
    v_current uuid[];
    v_due date;
    v_away jsonb := '[]'::jsonb;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, private.require_confirmed_caller());
    if v_occurrence.id is not null and v_occurrence.status = 'open'
       and (p_assignee_ids is not null or p_due_date is not null) then
      v_due := coalesce(p_due_date, v_occurrence.due_date);
      select coalesce(array_agg(a.user_id), '{}') into v_current
        from private.chore_occurrence_assignees a where a.occurrence_id = v_occurrence.id;
      v_users := case when p_assignee_ids is null then v_current
        else coalesce(private.chore_member_users(v_occurrence.home_id, p_assignee_ids), '{}') end;
      -- Newly assigned people away on the due date (people kept on a moved date are the move's own
      -- business: the review lists them).
      select coalesce(pg_catalog.jsonb_agg(private.member_ref(v_occurrence.home_id, u) order by u), '[]'::jsonb)
        into v_away
        from unnest(v_users) u
        where not (u = any (v_current)) and private.vacation_away(v_occurrence.home_id, u, v_due);
    end if;
    if pg_catalog.jsonb_array_length(v_away) > 0 and not coalesce(p_dry_run, false)
       and not coalesce(p_confirm_away, false) then
      return query
        select case when u.outcome = 'preview' then 'member_away' else u.outcome end,
          case when u.impact is null then null else u.impact || pg_catalog.jsonb_build_object('away', v_away) end,
          u.revision
        from private.update_chore_occurrence_before_vacations(p_occurrence_id, p_expected_revision,
          true, p_due_date, p_assignee_ids, p_set_minutes, p_minutes, p_steps,
          p_confirm_checklist, p_confirm_release) u;
      return;
    end if;
    return query
      select u.outcome, case when u.impact is null then null
          else u.impact || pg_catalog.jsonb_build_object('away', v_away) end, u.revision
      from private.update_chore_occurrence_before_vacations(p_occurrence_id, p_expected_revision,
        p_dry_run, p_due_date, p_assignee_ids, p_set_minutes, p_minutes, p_steps,
        p_confirm_checklist, p_confirm_release) u;
  end
  $$;

-- Reviews: what a vacation or absence leaves for a chore manager ----------------------------------------

-- Date ranges as [{from, to}] with inclusive ends.
create function private.vacation_ranges_json(p_dates datemultirange) returns jsonb
  language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'from', pg_catalog.lower(r), 'to', pg_catalog.upper(r) - 1) order by pg_catalog.lower(r)), '[]'::jsonb)
  from unnest(coalesce(p_dates, '{}'::datemultirange)) as r;
  $$;

-- One occurrence as a review entry: why it is listed, its state, its assignees (and which of them are
-- away on its due date) and the decision taken for this source, if any.
create function private.chore_review_entry(
  p_occurrence_id uuid, p_reason text, p_source_kind text, p_source_id uuid, p_viewer uuid
) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'occurrenceId', o.id, 'choreId', o.chore_id, 'title', c.title, 'kind', c.kind,
    'scheduledDate', o.scheduled_date, 'dueDate', o.due_date, 'status', o.status,
    'inRework', o.in_rework, 'claimed', o.claimed_by is not null, 'reason', p_reason,
    'protected', o.status = 'pending_approval' or o.in_rework, 'revision', o.revision,
    'substituteFor', private.member_ref(o.home_id, o.substitute_for),
    'assignees', coalesce((select pg_catalog.jsonb_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
      from private.chore_occurrence_assignees a where a.occurrence_id = o.id), '[]'::jsonb),
    'away', coalesce((select pg_catalog.jsonb_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
      from private.chore_occurrence_assignees a where a.occurrence_id = o.id
        and (private.vacation_away(o.home_id, a.user_id, o.due_date) or exists (
          select 1 from private.chore_absences b where b.home_id = o.home_id and b.user_id = a.user_id
            and o.due_date between b.starts_on and b.ends_on
            -- Absences are private to their member and chore managers.
            and (b.user_id = p_viewer or private.can_manage_chores(o.home_id, p_viewer))))), '[]'::jsonb),
    'decision', (select pg_catalog.jsonb_build_object('decision', d.decision, 'at', d.decided_at,
        'by', private.chore_person(o.home_id, d.decided_by, p_viewer),
        'to', private.member_ref(o.home_id, d.to_user), 'newDate', d.new_date)
      from private.chore_vacation_decisions d
      where d.occurrence_id = o.id and d.source_kind = p_source_kind and d.source_id = p_source_id))
  from private.chore_occurrences o join private.chores c on c.id = o.chore_id
  where o.id = p_occurrence_id;
  $$;

-- The planned (not yet created) dates of recurring chores within a range on which a member would be
-- assigned: fixed assignments, and rotations too when p_rotating (absences: nothing is substituted).
create function private.chore_planned_for(
  p_home_id uuid, p_user_id uuid, p_from date, p_to date, p_rotating boolean, p_limit integer
) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_item record;
    v_part private.chore_schedules;
    v_title text;
    v_date date;
    v_users uuid[];
    v_result jsonb := '[]'::jsonb;
    v_guard integer;
  begin
    for v_item in
      select s.id, c.title from private.chore_schedules s
      join private.chores c on c.id = s.chore_id
      where s.home_id = p_home_id and s.superseded_at is null and s.next_date is not null
        and c.deleted_at is null and c.ended_at is null
        and (s.assignment = 'fixed' or (p_rotating and s.assignment = 'rotating'))
        and exists (select 1 from private.chore_schedule_members m where m.schedule_id = s.id and m.user_id = p_user_id)
      order by c.title, s.id
    loop
      select * into v_part from private.chore_schedules s where s.id = v_item.id;
      v_title := v_item.title;
      v_date := private.chore_part_next(v_part, greatest(p_from, coalesce(v_part.last_date + 1, p_from)));
      v_guard := 0;
      while v_date is not null and v_date <= p_to and v_guard < 400
        and pg_catalog.jsonb_array_length(v_result) < p_limit loop
        v_guard := v_guard + 1;
        if not private.chore_paused_on(v_part, v_date) and not private.home_chores_paused_on(p_home_id, v_date) then
          select a.user_ids into v_users from private.chore_part_assignees(v_part, v_date) a;
          if p_user_id = any (v_users) then
            v_result := v_result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'choreId', v_part.chore_id, 'title', v_title, 'date', v_date, 'assignment', v_part.assignment,
              'member', private.member_ref(p_home_id, p_user_id)));
          end if;
        end if;
        v_date := private.chore_part_next(v_part, v_date + 1);
      end loop;
    end loop;
    return v_result;
  end
  $$;

-- What a vacation leaves for review: occurrences of away participants the rules did not handle
-- ('away': fixed, claimed, one-off or changed work due during their stay), rotations with nobody
-- available ('no_substitute'), work due on a paused date that waits for a decision ('paused_date'),
-- and their work overdue before the vacation ('overdue_before'). Pending approval and Needs rework
-- are listed as protected.
create function private.vacation_review_items(p_vacation private.home_vacations, p_viewer uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  with stays as (
    select p.user_id, p.starts_on, p.ends_on from private.home_vacation_participants p
    where p.vacation_id = p_vacation.id and p.status = 'accepted' and p.user_id is not null
  ), listed as (
    select o.id, o.due_date, c.title,
      case
        when o.vacation_state = 'review' and exists (select 1 from stays s
          where s.user_id = o.substitute_for and o.scheduled_date between s.starts_on and s.ends_on) then 'no_substitute'
        when o.vacation_review and private.vacation_pause_dates(p_vacation) @> o.due_date then 'paused_date'
        when exists (select 1 from private.chore_occurrence_assignees a join stays s on s.user_id = a.user_id
          where a.occurrence_id = o.id and o.due_date between s.starts_on and s.ends_on) then 'away'
        when o.status = 'open' and o.due_date < p_vacation.starts_on
          and o.due_date < private.task_today(p_vacation.home_id, null)
          and exists (select 1 from private.chore_occurrence_assignees a join stays s on s.user_id = a.user_id
            where a.occurrence_id = o.id) then 'overdue_before'
      end as reason
    from private.chore_occurrences o join private.chores c on c.id = o.chore_id
    where o.home_id = p_vacation.home_id and o.deleted_at is null and c.deleted_at is null
      and o.status in ('open', 'pending_approval') and p_vacation.cancelled_at is null
  )
  select coalesce(pg_catalog.jsonb_agg(private.chore_review_entry(l.id, l.reason, 'vacation', p_vacation.id, p_viewer)
      order by l.due_date, l.title, l.id), '[]'::jsonb)
  from (select * from listed where reason is not null order by due_date, title, id
    limit private.vacation_limit('review')) l;
  $$;

-- What an absence leaves for review: the member's open or pending work due during it ('away') and
-- their work already overdue before it ('overdue_before').
create function private.absence_review_items(p_absence private.chore_absences, p_viewer uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  with listed as (
    select o.id, o.due_date, c.title,
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
  select coalesce(pg_catalog.jsonb_agg(private.chore_review_entry(l.id, l.reason, 'absence', p_absence.id, p_viewer)
      order by l.due_date, l.title, l.id), '[]'::jsonb)
  from (select * from listed where reason is not null order by due_date, title, id
    limit private.vacation_limit('review')) l;
  $$;

-- The preview of a vacation change: what the rules changed, what is left for review, and the pause.
create function private.vacation_impact(p_vacation private.home_vacations, p_changes jsonb, p_viewer uuid)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'changes', coalesce(p_changes, '[]'::jsonb),
    'review', private.vacation_review_items(p_vacation, p_viewer),
    'startsOn', p_vacation.starts_on, 'endsOn', p_vacation.ends_on,
    'pauseDates', private.vacation_ranges_json(private.vacation_pause_dates(p_vacation)),
    'fullDates', private.vacation_ranges_json(private.vacation_full_dates(p_vacation,
      private.task_today(p_vacation.home_id, null))));
  $$;

-- The pre-vacation reminder ---------------------------------------------------------------------------------

-- Queues the reminder (vacation-reminder) for 09:00 Home time, reminder_days before the start, when
-- it has one, is not cancelled and that moment is still ahead. The key holds the start and the lead
-- days, so changed dates queue a new run and the old one finds itself stale.
create function private.schedule_vacation_reminder(p_vacation private.home_vacations) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_at timestamptz;
  begin
    if p_vacation.reminder_days is null or p_vacation.cancelled_at is not null then
      return;
    end if;
    v_at := ((p_vacation.starts_on - p_vacation.reminder_days)::timestamp + time '09:00')
      at time zone coalesce(private.home_zone(p_vacation.home_id), 'UTC');
    if v_at <= pg_catalog.now() then
      return;
    end if;
    perform private.enqueue_job(
      'vacation-reminder', 1,
      'vacation-reminder:' || p_vacation.id::text || ':' || p_vacation.starts_on::text || ':'
        || p_vacation.reminder_days::text,
      pg_catalog.jsonb_build_object('vacationId', p_vacation.id, 'startsOn', p_vacation.starts_on,
        'days', p_vacation.reminder_days),
      null, v_at);
  end
  $$;

-- Delivers a pre-vacation reminder (the vacation-reminder job; service role only): to every chore
-- manager of the Home, with the counts of what waits for a decision and the claimed chores in the
-- period at that moment. Nothing changes. Outcomes: 'notified', 'not_sent' (cancelled, already
-- started), 'stale' (dates or lead days changed), 'not_due' (early: the job retries).
create function public.deliver_vacation_reminder(p_vacation_id uuid, p_starts_on date, p_days integer)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_vacation private.home_vacations;
    v_at timestamptz;
    v_review jsonb;
    v_claimed integer;
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
          'claimed', v_claimed),
        'vacation-reminder:' || v_vacation.id::text || ':' || v_vacation.starts_on::text || ':'
          || v_vacation.reminder_days::text,
        true);
    end loop;
    return 'notified';
  end
  $$;

-- Creating and changing vacations -------------------------------------------------------------------------

-- Ends the stale pending invitations of a vacation (their proposed start has come), so a new
-- invitation can be made; under the Home's vacation lock.
create function private.expire_vacation_invitations(p_vacation_id uuid, p_today date) returns void
  language sql volatile security definer set search_path = '' as $$
  update private.home_vacation_participants p
    set status = 'expired', revision = p.revision + 1
    where p.vacation_id = p_vacation_id and p.status = 'pending' and p.starts_on <= p_today;
  $$;

-- Tells an invitee about an invitation (actionable request; category 'chores').
create function private.notify_vacation_invitation(p_participant private.home_vacation_participants)
returns void
  language sql volatile security definer set search_path = '' as $$
  select private.notify_user(
    p_participant.user_id, p_participant.home_id, 'chores', 'vacation.invited',
    pg_catalog.jsonb_build_object('homeId', p_participant.home_id, 'vacationId', p_participant.vacation_id,
      'startsOn', p_participant.starts_on, 'endsOn', p_participant.ends_on),
    'vacation-invited:' || p_participant.id::text, true);
  $$;

-- Creates a vacation (spec "member-scoped vacations and participant approval"). p_people lists the
-- participants with their own dates (private.vacation_people). A chore manager adds them directly
-- (accepted, managed by managers). Any other member must include themselves (accepted at once) and
-- may suggest others, who are invited with their proposed dates (Pending; the start must be after
-- today, as an invitation expires at its start). Optional name and (chore managers) reminder.
-- p_dry_run: the same work, rolled back. The id comes from the client: a retry answers 'exists'.
-- Outcomes: 'created' and 'preview' (impact: changes, review, startsOn, endsOn, pauseDates,
-- fullDates), 'exists', 'invalid_member', 'invalid_dates', 'not_permitted'.
create function public.create_home_vacation(
  p_id uuid, p_home_id uuid, p_name text, p_people jsonb, p_reminder_days integer default null,
  p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_name text := private.vacation_name(p_name);
    v_today date;
    v_manage boolean;
    v_existing private.home_vacations;
    v_person record;
    v_self boolean := false;
    v_vacation private.home_vacations;
    v_participant private.home_vacation_participants;
    v_changes jsonb;
    v_impact jsonb;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_dry_run is null
       or (v_name is not null and not private.is_visible_name(v_name, private.vacation_limit('name')))
       or (p_reminder_days is not null
         and p_reminder_days not between 1 and private.vacation_limit('reminder_days')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform 1 from private.vacation_people(p_home_id, p_people);
    perform private.lock_home_vacations(p_home_id);
    select * into v_existing from private.home_vacations v where v.id = p_id;
    if found then
      return query select 'exists', null::jsonb,
        case when v_existing.home_id = p_home_id and v_existing.created_by = v_user_id then v_existing.revision end;
      return;
    end if;
    v_manage := private.can_manage_chores(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    if p_reminder_days is not null and not v_manage then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if exists (select 1 from private.vacation_people(p_home_id, p_people) x where x.user_id is null) then
      return query select 'invalid_member', null::jsonb, null::integer;
      return;
    end if;
    for v_person in select * from private.vacation_people(p_home_id, p_people) loop
      if v_person.user_id = v_user_id then
        v_self := true;
      end if;
      if not private.valid_vacation_stay(v_person.starts_on, v_person.ends_on, v_today, v_today)
         or (not v_manage and v_person.user_id <> v_user_id and v_person.starts_on <= v_today) then
        return query select 'invalid_dates', null::jsonb, null::integer;
        return;
      end if;
    end loop;
    if not v_manage and not v_self then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;

    begin
      insert into private.home_vacations (id, home_id, name, starts_on, ends_on, created_by, reminder_days,
        updated_by)
        select p_id, p_home_id, v_name, min(x.starts_on), max(x.ends_on), v_user_id, p_reminder_days, v_user_id
        from private.vacation_people(p_home_id, p_people) x
        where v_manage or x.user_id = v_user_id
        returning * into v_vacation;
      perform private.vacation_event(p_id, 'created', v_user_id, null, v_vacation.starts_on, v_vacation.ends_on);
      for v_person in select * from private.vacation_people(p_home_id, p_people) loop
        insert into private.home_vacation_participants (id, vacation_id, home_id, user_id, status, starts_on,
          ends_on, direct, invited_by, responded_at)
          values (gen_random_uuid(), p_id, p_home_id, v_person.user_id,
            case when v_manage or v_person.user_id = v_user_id then 'accepted' else 'pending' end,
            v_person.starts_on, v_person.ends_on, v_manage, v_user_id,
            case when v_manage or v_person.user_id = v_user_id then pg_catalog.now() end)
          returning * into v_participant;
        perform private.vacation_event(p_id,
          case when v_participant.status = 'accepted' then 'added' else 'invited' end,
          v_user_id, v_person.user_id, v_person.starts_on, v_person.ends_on);
        if v_participant.status = 'pending' then
          perform private.notify_vacation_invitation(v_participant);
        end if;
      end loop;
      v_changes := private.reconcile_chore_vacations(p_home_id, null);
      v_impact := private.vacation_impact(v_vacation, v_changes, v_user_id);
      perform private.schedule_vacation_reminder(v_vacation);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, null::integer;
        return;
    end;
    perform private.audit_vacation('home_vacation.created', p_home_id, 'home_vacation', p_id,
      pg_catalog.jsonb_build_object('people', pg_catalog.jsonb_array_length(p_people), 'manager', v_manage,
        'named', v_name is not null, 'reminder', p_reminder_days is not null,
        'changes', pg_catalog.jsonb_array_length(v_changes)));
    return query select 'created', v_impact, v_vacation.revision;
  end
  $$;

-- A change to a whole vacation, on the revision the person saw. Actions:
--   'rename' (the creator or a chore manager; p_name, empty clears it): display only, no effects;
--   'reminder' (chore managers; p_reminder_days, null turns it off);
--   'shorten' (chore managers; p_ends_on from max(start, yesterday) up to the day before the
--     current end): every stay is cut there, stays starting after it end ('shortened'), waiting
--     proposals are withdrawn, the confirmed pause is cut too; ending yesterday ends it now;
--   'cancel' (chore managers, or the creator while nobody else is an accepted participant): final;
--     pending invitations and proposals are withdrawn;
--   'pause' / 'unpause' (chore managers): confirms the Home-wide chore pause for the dates on which
--     every current member is an accepted participant from today on ('not_whole_home' when there
--     are none), or removes it.
-- p_dry_run: the same work, rolled back. Outcomes: 'saved' and 'preview' (impact as
-- create_home_vacation), 'unchanged', 'conflict' (with the current revision), 'cancelled', 'ended',
-- 'invalid_dates', 'not_whole_home', 'not_permitted', 'not_found'.
create function public.update_home_vacation(
  p_vacation_id uuid, p_expected_revision integer, p_action text, p_dry_run boolean,
  p_name text default null, p_ends_on date default null, p_reminder_days integer default null
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_name text := private.vacation_name(p_name);
    v_home uuid;
    v_vacation private.home_vacations;
    v_today date;
    v_manage boolean;
    v_status text;
    v_full datemultirange;
    v_changes jsonb := '[]'::jsonb;
    v_impact jsonb;
  begin
    if p_vacation_id is null or p_expected_revision is null or p_dry_run is null or p_action is null
       or p_action not in ('rename', 'reminder', 'shorten', 'cancel', 'pause', 'unpause')
       or (p_action = 'rename' and v_name is not null
         and not private.is_visible_name(v_name, private.vacation_limit('name')))
       or (p_action <> 'rename' and p_name is not null)
       or (p_action <> 'reminder' and p_reminder_days is not null)
       or (p_reminder_days is not null and p_reminder_days not between 1 and private.vacation_limit('reminder_days'))
       or (p_action = 'shorten') <> (p_ends_on is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select v.home_id into v_home from private.home_vacations v where v.id = p_vacation_id;
    if v_home is null or not private.is_home_member(v_home, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    perform private.lock_home_vacations(v_home);
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id for update;
    v_today := private.task_today(v_home, null);
    v_manage := private.can_manage_chores(v_home, v_user_id);
    v_status := private.vacation_status(v_vacation, v_today);
    if not (v_manage or (p_action = 'rename' and v_vacation.created_by = v_user_id)
        or (p_action = 'cancel' and v_vacation.created_by = v_user_id and not exists (
          select 1 from private.home_vacation_participants p
          where p.vacation_id = v_vacation.id and p.status = 'accepted' and p.user_id <> v_user_id))) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_vacation.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_vacation.revision;
      return;
    end if;
    if v_status = 'cancelled' then
      return query select 'cancelled', null::jsonb, v_vacation.revision;
      return;
    end if;
    if v_status = 'ended' and p_action in ('shorten', 'cancel', 'pause') then
      return query select 'ended', null::jsonb, v_vacation.revision;
      return;
    end if;
    if (p_action = 'rename' and v_name is not distinct from v_vacation.name)
       or (p_action = 'reminder' and p_reminder_days is not distinct from v_vacation.reminder_days)
       or (p_action = 'unpause' and v_vacation.home_pause_dates is null) then
      return query select 'unchanged', null::jsonb, v_vacation.revision;
      return;
    end if;
    if p_action = 'shorten' and (p_ends_on < greatest(v_vacation.starts_on, v_today - 1)
        or p_ends_on >= v_vacation.ends_on) then
      return query select 'invalid_dates', null::jsonb, v_vacation.revision;
      return;
    end if;
    if p_action = 'pause' then
      v_full := private.vacation_full_dates(v_vacation, v_today);
      if pg_catalog.isempty(v_full) then
        return query select 'not_whole_home', null::jsonb, v_vacation.revision;
        return;
      end if;
    end if;

    begin
      case p_action
        when 'rename' then
          update private.home_vacations v set name = v_name where v.id = v_vacation.id;
          perform private.vacation_event(v_vacation.id, 'renamed', v_user_id);
        when 'reminder' then
          update private.home_vacations v set reminder_days = p_reminder_days where v.id = v_vacation.id;
          perform private.vacation_event(v_vacation.id, 'reminder_changed', v_user_id);
        when 'shorten' then
          perform private.expire_vacation_invitations(v_vacation.id, v_today);
          update private.home_vacation_participants p
            set status = 'withdrawn', ended_by = v_user_id, ended_reason = 'shortened',
              responded_at = coalesce(p.responded_at, pg_catalog.now()), revision = p.revision + 1
            where p.vacation_id = v_vacation.id and p.status in ('pending', 'accepted') and p.starts_on > p_ends_on;
          update private.home_vacation_participants p
            set ends_on = p_ends_on, revision = p.revision + 1
            where p.vacation_id = v_vacation.id and p.status in ('pending', 'accepted') and p.ends_on > p_ends_on;
          update private.home_vacation_date_proposals d set status = 'withdrawn', decided_at = pg_catalog.now()
            where d.vacation_id = v_vacation.id and d.status = 'pending';
          update private.home_vacations v
            set ends_on = p_ends_on,
              home_pause_dates = case when v.home_pause_dates is not null
                then v.home_pause_dates * pg_catalog.datemultirange(pg_catalog.daterange(null, p_ends_on + 1)) end
            where v.id = v_vacation.id;
          perform private.refresh_vacation_envelope(v_vacation.id);
          perform private.vacation_event(v_vacation.id, 'shortened', v_user_id, null, null, p_ends_on);
        when 'cancel' then
          update private.home_vacation_participants p
            set status = 'withdrawn', ended_by = v_user_id, ended_reason = 'cancelled',
              responded_at = coalesce(p.responded_at, pg_catalog.now()), revision = p.revision + 1
            where p.vacation_id = v_vacation.id and p.status = 'pending';
          update private.home_vacation_date_proposals d set status = 'withdrawn', decided_at = pg_catalog.now()
            where d.vacation_id = v_vacation.id and d.status = 'pending';
          update private.home_vacations v set cancelled_at = pg_catalog.now(), cancelled_by = v_user_id
            where v.id = v_vacation.id;
          perform private.vacation_event(v_vacation.id, 'cancelled', v_user_id);
        when 'pause' then
          update private.home_vacations v set home_pause_dates = v_full, home_pause_by = v_user_id,
              home_pause_at = pg_catalog.now()
            where v.id = v_vacation.id;
          perform private.vacation_event(v_vacation.id, 'home_pause_confirmed', v_user_id, null,
            pg_catalog.lower(v_full), pg_catalog.upper(v_full) - 1);
        when 'unpause' then
          update private.home_vacations v set home_pause_dates = null, home_pause_by = null, home_pause_at = null
            where v.id = v_vacation.id;
          perform private.vacation_event(v_vacation.id, 'home_pause_removed', v_user_id);
      end case;
      update private.home_vacations v set revision = v.revision + 1, updated_by = v_user_id,
          updated_at = pg_catalog.now()
        where v.id = v_vacation.id
        returning * into v_vacation;
      if p_action in ('shorten', 'cancel', 'pause', 'unpause') then
        v_changes := private.reconcile_chore_vacations(v_home, null);
      end if;
      v_impact := private.vacation_impact(v_vacation, v_changes, v_user_id);
      perform private.schedule_vacation_reminder(v_vacation);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, p_expected_revision;
        return;
    end;
    perform private.audit_vacation('home_vacation.' || p_action, v_home, 'home_vacation', v_vacation.id,
      pg_catalog.jsonb_build_object('changes', pg_catalog.jsonb_array_length(v_changes)));
    return query select 'saved', v_impact, v_vacation.revision;
  end
  $$;

-- Adds participants to a vacation that is not cancelled or ended: a chore manager adds them directly
-- (accepted); the creator invites them (pending, start after today). Someone already pending or
-- accepted answers 'already_participant'. p_dry_run as above. Outcomes: 'saved', 'preview',
-- 'conflict', 'cancelled', 'ended', 'already_participant', 'invalid_member', 'invalid_dates',
-- 'not_permitted', 'not_found'.
create function public.add_vacation_participants(
  p_vacation_id uuid, p_expected_revision integer, p_people jsonb, p_dry_run boolean
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_home uuid;
    v_vacation private.home_vacations;
    v_today date;
    v_manage boolean;
    v_person record;
    v_participant private.home_vacation_participants;
    v_changes jsonb;
    v_impact jsonb;
  begin
    if p_vacation_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select v.home_id into v_home from private.home_vacations v where v.id = p_vacation_id;
    if v_home is null or not private.is_home_member(v_home, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    perform 1 from private.vacation_people(v_home, p_people);
    perform private.lock_home_vacations(v_home);
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id for update;
    v_today := private.task_today(v_home, null);
    v_manage := private.can_manage_chores(v_home, v_user_id);
    if not v_manage and v_vacation.created_by is distinct from v_user_id then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_vacation.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_vacation.revision;
      return;
    end if;
    if private.vacation_status(v_vacation, v_today) in ('cancelled', 'ended') then
      return query select private.vacation_status(v_vacation, v_today), null::jsonb, v_vacation.revision;
      return;
    end if;
    if exists (select 1 from private.vacation_people(v_home, p_people) x where x.user_id is null) then
      return query select 'invalid_member', null::jsonb, null::integer;
      return;
    end if;
    perform private.expire_vacation_invitations(v_vacation.id, v_today);
    if exists (select 1 from private.vacation_people(v_home, p_people) x
        join private.home_vacation_participants p on p.vacation_id = v_vacation.id and p.user_id = x.user_id
        where p.status in ('pending', 'accepted')) then
      return query select 'already_participant', null::jsonb, v_vacation.revision;
      return;
    end if;
    for v_person in select * from private.vacation_people(v_home, p_people) loop
      if not private.valid_vacation_stay(v_person.starts_on, v_person.ends_on, v_today, v_today)
         or (not v_manage and v_person.starts_on <= v_today) then
        return query select 'invalid_dates', null::jsonb, v_vacation.revision;
        return;
      end if;
    end loop;

    begin
      for v_person in select * from private.vacation_people(v_home, p_people) loop
        insert into private.home_vacation_participants (id, vacation_id, home_id, user_id, status, starts_on,
          ends_on, direct, invited_by, responded_at)
          values (gen_random_uuid(), v_vacation.id, v_home, v_person.user_id,
            case when v_manage then 'accepted' else 'pending' end, v_person.starts_on, v_person.ends_on,
            v_manage, v_user_id, case when v_manage then pg_catalog.now() end)
          returning * into v_participant;
        perform private.vacation_event(v_vacation.id, case when v_manage then 'added' else 'invited' end,
          v_user_id, v_person.user_id, v_person.starts_on, v_person.ends_on);
        if not v_manage then
          perform private.notify_vacation_invitation(v_participant);
        end if;
      end loop;
      perform private.refresh_vacation_envelope(v_vacation.id);
      update private.home_vacations v set revision = v.revision + 1, updated_by = v_user_id,
          updated_at = pg_catalog.now()
        where v.id = v_vacation.id
        returning * into v_vacation;
      v_changes := private.reconcile_chore_vacations(v_home, null);
      v_impact := private.vacation_impact(v_vacation, v_changes, v_user_id);
      perform private.schedule_vacation_reminder(v_vacation);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, p_expected_revision;
        return;
    end;
    perform private.audit_vacation('home_vacation.participants_added', v_home, 'home_vacation', v_vacation.id,
      pg_catalog.jsonb_build_object('people', pg_catalog.jsonb_array_length(p_people), 'manager', v_manage));
    return query select 'saved', v_impact, v_vacation.revision;
  end
  $$;

-- A change to one participation, on the participation's revision the person saw. Actions:
--   'accept', 'decline' (the invitee, while pending and before the proposed start: 'expired' after);
--   'withdraw' (the participant, while accepted: their own participation only);
--   'remove' (chore managers: an accepted or pending participation);
--   'cancel_invitation' (the creator or a chore manager: a pending one);
--   'change_dates' (the participant, or a chore manager for one a manager added): new dates
--     (p_starts_on, p_ends_on); a stay already under way keeps its start;
--   'propose_dates' (the creator or a chore manager, for an accepted participant other than
--     themselves who joined by invitation or created it): a proposal that only the participant's
--     acceptance makes effective; a waiting one is superseded.
-- p_dry_run: the same work, rolled back (an invitee's personal preview). Outcomes: 'saved' and
-- 'preview' (impact as create_home_vacation), 'unchanged', 'conflict' (with the current revision),
-- 'expired', 'not_open' (with nothing to answer), 'cancelled', 'invalid_dates', 'not_permitted',
-- 'not_found'. revision: the participation's.
create function public.change_vacation_participation(
  p_participant_id uuid, p_expected_revision integer, p_action text, p_dry_run boolean,
  p_starts_on date default null, p_ends_on date default null
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_home uuid;
    v_vacation private.home_vacations;
    v_participant private.home_vacation_participants;
    v_today date;
    v_manage boolean;
    v_self boolean;
    v_status text;
    v_proposal private.home_vacation_date_proposals;
    v_changes jsonb;
    v_impact jsonb;
  begin
    if p_participant_id is null or p_expected_revision is null or p_dry_run is null or p_action is null
       or p_action not in ('accept', 'decline', 'withdraw', 'remove', 'cancel_invitation', 'change_dates',
         'propose_dates')
       or (p_action in ('change_dates', 'propose_dates')) <> (p_starts_on is not null and p_ends_on is not null)
       or (p_action not in ('change_dates', 'propose_dates') and (p_starts_on is not null or p_ends_on is not null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select p.home_id into v_home from private.home_vacation_participants p where p.id = p_participant_id;
    if v_home is null or not private.is_home_member(v_home, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    perform private.lock_home_vacations(v_home);
    select * into v_vacation from private.home_vacations v
      where v.id = (select p.vacation_id from private.home_vacation_participants p where p.id = p_participant_id)
      for update;
    select * into v_participant from private.home_vacation_participants p where p.id = p_participant_id for update;
    v_today := private.task_today(v_home, null);
    v_manage := private.can_manage_chores(v_home, v_user_id);
    v_self := v_participant.user_id = v_user_id;
    v_status := private.vacation_participant_status(v_participant, v_today);
    if not (case p_action
        when 'accept' then v_self
        when 'decline' then v_self
        when 'withdraw' then v_self
        when 'remove' then v_manage
        when 'cancel_invitation' then v_manage or v_vacation.created_by = v_user_id
        when 'change_dates' then v_self or (v_manage and v_participant.direct)
        when 'propose_dates' then not v_self and (v_manage or v_vacation.created_by = v_user_id)
          and not (v_manage and v_participant.direct)
      end) then
      -- Someone who may not see a pending invitation of another member learns nothing about it.
      return query select case when v_status = 'accepted' or v_self or v_manage
          or v_vacation.created_by = v_user_id then 'not_permitted' else 'not_found' end,
        null::jsonb, null::integer;
      return;
    end if;
    if v_participant.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_participant.revision;
      return;
    end if;
    if v_vacation.cancelled_at is not null then
      return query select 'cancelled', null::jsonb, v_participant.revision;
      return;
    end if;
    if v_status = 'expired' and v_participant.status = 'pending' then
      perform private.expire_vacation_invitations(v_vacation.id, v_today);
      return query select 'expired', null::jsonb, v_participant.revision + 1;
      return;
    end if;
    if (p_action in ('accept', 'decline', 'cancel_invitation') and v_status <> 'pending')
       or (p_action in ('withdraw', 'change_dates', 'propose_dates') and v_status <> 'accepted')
       or (p_action = 'remove' and v_status not in ('pending', 'accepted')) then
      return query select 'not_open', null::jsonb, v_participant.revision;
      return;
    end if;
    if p_action in ('change_dates', 'propose_dates') then
      if (v_participant.starts_on < v_today and p_starts_on <> v_participant.starts_on)
         or not private.valid_vacation_stay(p_starts_on, p_ends_on, v_today, v_participant.starts_on) then
        return query select 'invalid_dates', null::jsonb, v_participant.revision;
        return;
      end if;
      if p_starts_on = v_participant.starts_on and p_ends_on = v_participant.ends_on then
        return query select 'unchanged', null::jsonb, v_participant.revision;
        return;
      end if;
    end if;

    begin
      case p_action
        when 'accept' then
          update private.home_vacation_participants p set status = 'accepted', responded_at = pg_catalog.now()
            where p.id = v_participant.id;
          perform private.vacation_event(v_vacation.id, 'accepted', v_user_id, v_user_id,
            v_participant.starts_on, v_participant.ends_on);
        when 'decline' then
          update private.home_vacation_participants p set status = 'declined', responded_at = pg_catalog.now()
            where p.id = v_participant.id;
          perform private.vacation_event(v_vacation.id, 'declined', v_user_id, v_user_id);
        when 'withdraw', 'remove', 'cancel_invitation' then
          update private.home_vacation_participants p
            set status = 'withdrawn', ended_by = v_user_id,
              ended_reason = case when v_self then 'self' when v_manage then 'manager' else 'creator' end,
              responded_at = coalesce(p.responded_at, pg_catalog.now())
            where p.id = v_participant.id;
          update private.home_vacation_date_proposals d set status = 'withdrawn', decided_at = pg_catalog.now()
            where d.participant_id = v_participant.id and d.status = 'pending';
          perform private.vacation_event(v_vacation.id,
            case p_action when 'withdraw' then 'withdrawn' when 'remove' then 'removed'
              else 'invitation_withdrawn' end,
            v_user_id, v_participant.user_id);
        when 'change_dates' then
          update private.home_vacation_participants p set starts_on = p_starts_on, ends_on = p_ends_on
            where p.id = v_participant.id;
          update private.home_vacation_date_proposals d set status = 'superseded', decided_at = pg_catalog.now()
            where d.participant_id = v_participant.id and d.status = 'pending';
          perform private.vacation_event(v_vacation.id, 'dates_changed', v_user_id, v_participant.user_id,
            p_starts_on, p_ends_on);
        when 'propose_dates' then
          update private.home_vacation_date_proposals d set status = 'superseded', decided_at = pg_catalog.now()
            where d.participant_id = v_participant.id and d.status = 'pending';
          insert into private.home_vacation_date_proposals (id, participant_id, vacation_id, home_id, starts_on,
            ends_on, proposed_by)
            values (gen_random_uuid(), v_participant.id, v_vacation.id, v_home, p_starts_on, p_ends_on, v_user_id)
            returning * into v_proposal;
          perform private.vacation_event(v_vacation.id, 'dates_proposed', v_user_id, v_participant.user_id,
            p_starts_on, p_ends_on);
          perform private.notify_user(
            v_participant.user_id, v_home, 'chores', 'vacation.dates_proposed',
            pg_catalog.jsonb_build_object('homeId', v_home, 'vacationId', v_vacation.id,
              'startsOn', p_starts_on, 'endsOn', p_ends_on),
            'vacation-dates-proposed:' || v_proposal.id::text, true);
      end case;
      update private.home_vacation_participants p set revision = p.revision + 1
        where p.id = v_participant.id
        returning * into v_participant;
      perform private.refresh_vacation_envelope(v_vacation.id);
      update private.home_vacations v set updated_by = v_user_id, updated_at = pg_catalog.now()
        where v.id = v_vacation.id
        returning * into v_vacation;
      v_changes := private.reconcile_chore_vacations(v_home, null);
      v_impact := private.vacation_impact(v_vacation, v_changes, v_user_id);
      perform private.schedule_vacation_reminder(v_vacation);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, p_expected_revision;
        return;
    end;
    perform private.audit_vacation('home_vacation.participation_' || p_action, v_home, 'home_vacation',
      v_vacation.id, pg_catalog.jsonb_build_object('participant', v_participant.id,
        'changes', pg_catalog.jsonb_array_length(v_changes)));
    return query select 'saved', v_impact, v_participant.revision;
  end
  $$;

-- Answers a date proposal: 'accept' or 'decline' (its participant), 'withdraw' (its proposer or a
-- chore manager), while it waits. Accepting re-checks the dates against today ('stale' when they can
-- no longer apply) and the participation (still accepted). p_dry_run: the same work, rolled back.
-- Outcomes: 'saved', 'preview', 'not_open', 'stale', 'cancelled', 'not_permitted', 'not_found'.
create function public.answer_vacation_date_proposal(p_proposal_id uuid, p_action text, p_dry_run boolean)
returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_home uuid;
    v_vacation private.home_vacations;
    v_participant private.home_vacation_participants;
    v_proposal private.home_vacation_date_proposals;
    v_today date;
    v_manage boolean;
    v_changes jsonb := '[]'::jsonb;
    v_impact jsonb;
  begin
    if p_proposal_id is null or p_dry_run is null or p_action is null
       or p_action not in ('accept', 'decline', 'withdraw') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select d.home_id into v_home from private.home_vacation_date_proposals d where d.id = p_proposal_id;
    if v_home is null or not private.is_home_member(v_home, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    perform private.lock_home_vacations(v_home);
    select * into v_proposal from private.home_vacation_date_proposals d where d.id = p_proposal_id for update;
    select * into v_vacation from private.home_vacations v where v.id = v_proposal.vacation_id for update;
    select * into v_participant from private.home_vacation_participants p where p.id = v_proposal.participant_id
      for update;
    v_today := private.task_today(v_home, null);
    v_manage := private.can_manage_chores(v_home, v_user_id);
    if not (case p_action
        when 'withdraw' then v_proposal.proposed_by = v_user_id or v_manage
        else v_participant.user_id = v_user_id end) then
      return query select case when v_participant.user_id = v_user_id or v_manage
          or v_proposal.proposed_by = v_user_id then 'not_permitted' else 'not_found' end,
        null::jsonb, null::integer;
      return;
    end if;
    if v_proposal.status <> 'pending' then
      return query select 'not_open', null::jsonb, null::integer;
      return;
    end if;
    if v_vacation.cancelled_at is not null then
      return query select 'cancelled', null::jsonb, null::integer;
      return;
    end if;
    if p_action = 'accept' and (v_participant.status <> 'accepted'
        or (v_participant.starts_on < v_today and v_proposal.starts_on <> v_participant.starts_on)
        or not private.valid_vacation_stay(v_proposal.starts_on, v_proposal.ends_on, v_today,
          v_participant.starts_on)) then
      return query select 'stale', null::jsonb, null::integer;
      return;
    end if;

    begin
      update private.home_vacation_date_proposals d
        set status = case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'withdrawn' end,
          decided_at = pg_catalog.now()
        where d.id = v_proposal.id;
      perform private.vacation_event(v_vacation.id, 'proposal_' || case p_action when 'accept' then 'accepted'
          when 'decline' then 'declined' else 'withdrawn' end,
        v_user_id, v_participant.user_id, v_proposal.starts_on, v_proposal.ends_on);
      if p_action = 'accept' then
        update private.home_vacation_participants p
          set starts_on = v_proposal.starts_on, ends_on = v_proposal.ends_on, revision = p.revision + 1
          where p.id = v_participant.id;
        perform private.refresh_vacation_envelope(v_vacation.id);
        update private.home_vacations v set updated_by = v_user_id, updated_at = pg_catalog.now()
          where v.id = v_vacation.id
          returning * into v_vacation;
        v_changes := private.reconcile_chore_vacations(v_home, null);
        perform private.schedule_vacation_reminder(v_vacation);
      end if;
      v_impact := private.vacation_impact(v_vacation, v_changes, v_user_id);
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, null::integer;
        return;
    end;
    perform private.audit_vacation('home_vacation.proposal_' || p_action, v_home, 'home_vacation',
      v_vacation.id, pg_catalog.jsonb_build_object('changes', pg_catalog.jsonb_array_length(v_changes)));
    return query select 'saved', v_impact, null::integer;
  end
  $$;

-- Decisions on reviewed occurrences -------------------------------------------------------------------------

-- A chore manager's decision on one occurrence listed by a vacation or an absence (p_source_kind
-- 'vacation' or 'absence'), on the occurrence revision they saw:
--   'keep' (it stays as it is; a vacation review flag ends), 'skip' (the S20 skip: no points),
--   'reassign' (p_member, any current member; one away on the due date needs p_confirm_away, the
--     per-occurrence override: 'member_away' otherwise), 'reschedule' (one-off chores; p_due_date
--     from today on).
-- Recorded once per occurrence and source: the occurrence is then left alone by the vacation rules
-- and never asked about again for that source. Pending approval and Needs rework are protected.
-- Outcomes: 'decided', 'already_decided', 'protected', 'occurrence_closed', 'conflict' (with the
-- current revision), 'nobody_assigned', 'not_one_off', 'invalid_dates', 'member_away' (impact.away),
-- 'invalid_assignee', 'cancelled', 'not_permitted', 'not_found'.
create function public.decide_chore_vacation_item(
  p_source_kind text, p_source_id uuid, p_occurrence_id uuid, p_expected_revision integer,
  p_decision text, p_member uuid default null, p_due_date date default null,
  p_confirm_away boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_home uuid;
    v_cancelled boolean := false;
    v_occurrence private.chore_occurrences;
    v_row record;
    v_to uuid;
    v_today date;
  begin
    if p_source_kind is null or p_source_kind not in ('vacation', 'absence') or p_source_id is null
       or p_occurrence_id is null or p_expected_revision is null or p_confirm_away is null
       or p_decision is null or p_decision not in ('keep', 'skip', 'reassign', 'reschedule')
       or (p_decision = 'reassign') <> (p_member is not null)
       or (p_decision = 'reschedule') <> (p_due_date is not null)
       or (p_source_kind = 'absence' and p_decision = 'reschedule') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_source_kind = 'vacation' then
      select v.home_id, v.cancelled_at is not null into v_home, v_cancelled
        from private.home_vacations v where v.id = p_source_id;
    else
      select b.home_id into v_home from private.chore_absences b where b.id = p_source_id;
    end if;
    if v_home is null or not private.is_home_member(v_home, v_user_id) then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_home, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_cancelled then
      return query select 'cancelled', null::jsonb, null::integer;
      return;
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null or v_occurrence.home_id <> v_home then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if exists (select 1 from private.chore_vacation_decisions d where d.occurrence_id = v_occurrence.id
        and d.source_kind = p_source_kind and d.source_id = p_source_id) then
      return query select 'already_decided', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status = 'pending_approval' or v_occurrence.in_rework then
      return query select 'protected', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select 'occurrence_closed', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_occurrence.revision;
      return;
    end if;
    v_today := private.task_today(v_home, null);
    case p_decision
      when 'keep' then
        if not exists (select 1 from private.chore_occurrence_assignees a where a.occurrence_id = v_occurrence.id) then
          return query select 'nobody_assigned', null::jsonb, v_occurrence.revision;
          return;
        end if;
      when 'skip' then
        select * into v_row from public.skip_chore_occurrence(v_occurrence.id, null);
        if v_row.outcome <> 'skipped' then
          return query select v_row.outcome, null::jsonb, v_row.revision;
          return;
        end if;
      when 'reassign' then
        select * into v_row from public.update_chore_occurrence(v_occurrence.id, p_expected_revision, false,
          p_assignee_ids => array[p_member], p_confirm_away => p_confirm_away);
        if v_row.outcome <> 'saved' then
          return query select v_row.outcome, v_row.impact, v_row.revision;
          return;
        end if;
        select m.user_id into v_to from public.home_memberships m where m.home_id = v_home and m.id = p_member;
      when 'reschedule' then
        if v_occurrence.schedule_id is not null then
          return query select 'not_one_off', null::jsonb, v_occurrence.revision;
          return;
        end if;
        if p_due_date < v_today or p_due_date > v_today + private.vacation_limit('ahead') then
          return query select 'invalid_dates', null::jsonb, v_occurrence.revision;
          return;
        end if;
        select * into v_row from public.update_chore_occurrence(v_occurrence.id, p_expected_revision, false,
          p_due_date => p_due_date, p_confirm_release => true);
        if v_row.outcome <> 'saved' then
          return query select v_row.outcome, v_row.impact, v_row.revision;
          return;
        end if;
    end case;
    insert into private.chore_vacation_decisions (occurrence_id, home_id, source_kind, source_id, decision,
      to_user, new_date, decided_by)
      values (v_occurrence.id, v_home, p_source_kind, p_source_id, p_decision, v_to, p_due_date, v_user_id);
    perform private.apply_chore_vacation(v_occurrence.id, v_today);
    perform private.audit_vacation('chore_vacation.decided', v_home, 'chore_occurrence', v_occurrence.id,
      pg_catalog.jsonb_build_object('source', p_source_kind, 'decision', p_decision));
    return query select 'decided', null::jsonb,
      (select o.revision from private.chore_occurrences o where o.id = v_occurrence.id);
  end
  $$;

-- Absences ----------------------------------------------------------------------------------------------------

-- Creates (p_expected_revision null) or changes an absence. A member registers their own; a chore
-- manager anyone's (p_member: a membership id; it cannot change later). Dates as vacation stays; one
-- under way keeps its start. The reason is optional (1–200 characters) and private to the member and
-- chore managers. Nothing changes on its own. Outcomes: 'created', 'saved', 'unchanged', 'exists',
-- 'conflict' (with the current revision), 'invalid_member', 'invalid_dates', 'not_permitted',
-- 'not_found'.
create function public.save_chore_absence(
  p_id uuid, p_home_id uuid, p_member uuid, p_starts_on date, p_ends_on date,
  p_reason text default null, p_expected_revision integer default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_member_user uuid;
    v_existing private.chore_absences;
    v_manage boolean;
    v_today date;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_member is null or p_starts_on is null or p_ends_on is null
       or (v_reason is not null and not private.is_plain_text(v_reason, private.vacation_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform private.lock_home_vacations(p_home_id);
    v_manage := private.can_manage_chores(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    select m.user_id into v_member_user from public.home_memberships m where m.home_id = p_home_id and m.id = p_member;
    select * into v_existing from private.chore_absences b where b.id = p_id for update;
    if p_expected_revision is null then
      if v_existing.id is not null then
        return query select 'exists', case when v_existing.home_id = p_home_id
          and (v_existing.user_id = v_user_id or v_manage) then v_existing.revision end;
        return;
      end if;
      if v_member_user is null then
        return query select 'invalid_member', null::integer;
        return;
      end if;
      if v_member_user <> v_user_id and not v_manage then
        return query select 'not_permitted', null::integer;
        return;
      end if;
      if not private.valid_vacation_stay(p_starts_on, p_ends_on, v_today, v_today) then
        return query select 'invalid_dates', null::integer;
        return;
      end if;
      insert into private.chore_absences (id, home_id, user_id, starts_on, ends_on, reason, created_by, updated_by)
        values (p_id, p_home_id, v_member_user, p_starts_on, p_ends_on, v_reason, v_user_id, v_user_id);
      perform private.audit_vacation('chore_absence.created', p_home_id, 'chore_absence', p_id,
        pg_catalog.jsonb_build_object('own', v_member_user = v_user_id));
      return query select 'created', 1;
      return;
    end if;
    if v_existing.id is null or v_existing.home_id <> p_home_id
       or not (v_existing.user_id = v_user_id or v_manage) then
      return query select 'not_found', null::integer;
      return;
    end if;
    if v_member_user is distinct from v_existing.user_id then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if v_existing.revision <> p_expected_revision then
      return query select 'conflict', v_existing.revision;
      return;
    end if;
    if (v_existing.starts_on < v_today and p_starts_on <> v_existing.starts_on)
       or not private.valid_vacation_stay(p_starts_on, p_ends_on, v_today, v_existing.starts_on) then
      return query select 'invalid_dates', v_existing.revision;
      return;
    end if;
    if p_starts_on = v_existing.starts_on and p_ends_on = v_existing.ends_on
       and v_reason is not distinct from v_existing.reason then
      return query select 'unchanged', v_existing.revision;
      return;
    end if;
    update private.chore_absences b
      set starts_on = p_starts_on, ends_on = p_ends_on, reason = v_reason, revision = b.revision + 1,
        updated_by = v_user_id, updated_at = pg_catalog.now()
      where b.id = p_id
      returning * into v_existing;
    perform private.audit_vacation('chore_absence.updated', p_home_id, 'chore_absence', p_id);
    return query select 'saved', v_existing.revision;
  end
  $$;

-- Removes an absence (its member or a chore manager). Decisions taken stay. Outcomes: 'deleted',
-- 'conflict', 'not_found'.
create function public.delete_chore_absence(p_id uuid, p_expected_revision integer)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.chore_absences;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.chore_absences b where b.id = p_id;
    if v_existing.id is null or not private.is_home_member(v_existing.home_id, v_user_id)
       or not (v_existing.user_id = v_user_id or private.can_manage_chores(v_existing.home_id, v_user_id)) then
      return query select 'not_found', null::integer;
      return;
    end if;
    perform private.lock_home_vacations(v_existing.home_id);
    select * into v_existing from private.chore_absences b where b.id = p_id for update;
    if v_existing.revision <> p_expected_revision then
      return query select 'conflict', v_existing.revision;
      return;
    end if;
    delete from private.chore_absences b where b.id = p_id;
    perform private.audit_vacation('chore_absence.deleted', v_existing.home_id, 'chore_absence', p_id);
    return query select 'deleted', null::integer;
  end
  $$;

-- The absences the caller may see in a Home (their own; chore managers every one), current and
-- upcoming first, with how many listed occurrences still wait for a decision. 42501 for a Home they
-- are not in.
create function public.list_chore_absences(p_home_id uuid) returns jsonb
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
          'undecided', (select count(*)::integer from pg_catalog.jsonb_array_elements(
              private.absence_review_items(b, v_user_id)) e
            where e -> 'decision' = 'null'::jsonb and not (e ->> 'protected')::boolean))
          order by b.ends_on < v_today, b.starts_on, b.id)
        from (select * from private.chore_absences x
          where x.home_id = p_home_id and (x.user_id = v_user_id or v_manage)
          order by x.ends_on < v_today, x.starts_on desc
          limit private.vacation_limit('absences')) b), '[]'::jsonb));
  end
  $$;

-- An absence's review (its member and chore managers): listed occurrences, planned dates of their
-- recurring chores, and whether the caller decides. Null when it is not theirs to see.
create function public.list_absence_review(p_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_absence private.chore_absences;
    v_manage boolean;
    v_today date;
  begin
    if p_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_absence from private.chore_absences b where b.id = p_id;
    if v_absence.id is null or not private.is_home_member(v_absence.home_id, v_user_id) then
      return null;
    end if;
    v_manage := private.can_manage_chores(v_absence.home_id, v_user_id);
    if v_absence.user_id <> v_user_id and not v_manage then
      return null;
    end if;
    v_today := private.task_today(v_absence.home_id, null);
    return pg_catalog.jsonb_build_object(
      'id', v_absence.id, 'homeId', v_absence.home_id, 'today', v_today,
      'member', private.chore_person(v_absence.home_id, v_absence.user_id, v_user_id),
      'startsOn', v_absence.starts_on, 'endsOn', v_absence.ends_on, 'reason', v_absence.reason,
      'revision', v_absence.revision, 'canDecide', v_manage,
      'items', private.absence_review_items(v_absence, v_user_id),
      'planned', private.chore_planned_for(v_absence.home_id, v_absence.user_id,
        greatest(v_absence.starts_on, v_today), v_absence.ends_on, true, private.vacation_limit('planned')));
  end
  $$;

-- Reading vacations ------------------------------------------------------------------------------------------

-- A vacation as listed: dates, status, name (every member of the Home sees it), the accepted
-- participants with their own dates, and whether it pauses the Home's chores.
create function private.vacation_summary(p_vacation private.home_vacations, p_viewer uuid, p_today date)
returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_vacation.id, 'name', p_vacation.name, 'status', private.vacation_status(p_vacation, p_today),
    'startsOn', p_vacation.starts_on, 'endsOn', p_vacation.ends_on, 'revision', p_vacation.revision,
    'createdBy', private.chore_person(p_vacation.home_id, p_vacation.created_by, p_viewer),
    'participants', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'member', private.chore_person(p.home_id, p.user_id, p_viewer),
        'startsOn', p.starts_on, 'endsOn', p.ends_on) order by p.starts_on, p.id)
      from private.home_vacation_participants p
      where p.vacation_id = p_vacation.id and p.status = 'accepted'), '[]'::jsonb),
    'memberCount', (select count(*)::integer from public.home_memberships m where m.home_id = p_vacation.home_id),
    'me', exists (select 1 from private.home_vacation_participants p
      where p.vacation_id = p_vacation.id and p.status = 'accepted' and p.user_id = p_viewer),
    'pauseDates', private.vacation_ranges_json(private.vacation_pause_dates(p_vacation)));
  $$;

-- The caller's Home vacations: current and upcoming ones (active first), recent history, their own
-- pending invitations and date proposals, and whether the Home's chores are paused today. 42501 for a
-- Home they are not in.
create function public.list_home_vacations(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    return pg_catalog.jsonb_build_object(
      'today', v_today,
      'canManage', private.can_manage_chores(p_home_id, v_user_id),
      'pausedToday', private.home_chores_paused_on(p_home_id, v_today),
      'current', coalesce((select pg_catalog.jsonb_agg(private.vacation_summary(v, v_user_id, v_today)
          order by v.starts_on > v_today, v.starts_on, v.id)
        from private.home_vacations v
        where v.home_id = p_home_id and v.cancelled_at is null and v.ends_on >= v_today), '[]'::jsonb),
      'history', coalesce((select pg_catalog.jsonb_agg(private.vacation_summary(v, v_user_id, v_today)
          order by v.ends_on desc, v.id)
        from (select * from private.home_vacations x
          where x.home_id = p_home_id and (x.cancelled_at is not null or x.ends_on < v_today)
          order by x.ends_on desc, x.id limit private.vacation_limit('history')) v), '[]'::jsonb),
      'invitations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'participantId', p.id, 'vacationId', v.id, 'name', v.name, 'startsOn', p.starts_on,
          'endsOn', p.ends_on, 'deadline', p.starts_on, 'revision', p.revision,
          'invitedBy', private.chore_person(p_home_id, p.invited_by, v_user_id)) order by p.starts_on, p.id)
        from private.home_vacation_participants p
        join private.home_vacations v on v.id = p.vacation_id
        where p.home_id = p_home_id and p.user_id = v_user_id and v.cancelled_at is null
          and private.vacation_participant_status(p, v_today) = 'pending'), '[]'::jsonb),
      'proposals', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'proposalId', d.id, 'vacationId', v.id, 'name', v.name, 'startsOn', d.starts_on, 'endsOn', d.ends_on,
          'currentStartsOn', p.starts_on, 'currentEndsOn', p.ends_on,
          'proposedBy', private.chore_person(p_home_id, d.proposed_by, v_user_id)) order by d.created_at, d.id)
        from private.home_vacation_date_proposals d
        join private.home_vacation_participants p on p.id = d.participant_id
        join private.home_vacations v on v.id = d.vacation_id
        where d.home_id = p_home_id and p.user_id = v_user_id and d.status = 'pending'
          and v.cancelled_at is null), '[]'::jsonb));
  end
  $$;

-- One vacation with what the caller may see and do, or null when it is not theirs to see. Every
-- member sees accepted participants; pending, declined, withdrawn and expired participations, and
-- waiting proposals, are seen by that participant, the creator and chore managers; the history by
-- the creator and chore managers.
create function public.get_home_vacation(p_vacation_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_vacation private.home_vacations;
    v_today date;
    v_manage boolean;
    v_creator boolean;
    v_status text;
    v_open boolean;
  begin
    if p_vacation_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id;
    if not found or not private.is_home_member(v_vacation.home_id, v_user_id) then
      return null;
    end if;
    v_today := private.task_today(v_vacation.home_id, null);
    v_manage := private.can_manage_chores(v_vacation.home_id, v_user_id);
    v_creator := v_vacation.created_by = v_user_id;
    v_status := private.vacation_status(v_vacation, v_today);
    v_open := v_status in ('upcoming', 'active');
    return private.vacation_summary(v_vacation, v_user_id, v_today) || pg_catalog.jsonb_build_object(
      'homeId', v_vacation.home_id,
      'today', v_today,
      'createdAt', v_vacation.created_at,
      'cancelledAt', v_vacation.cancelled_at,
      'cancelledBy', private.chore_person(v_vacation.home_id, v_vacation.cancelled_by, v_user_id),
      'reminderDays', case when v_manage or v_creator then v_vacation.reminder_days end,
      'homePause', pg_catalog.jsonb_build_object(
        'confirmed', case when v_vacation.home_pause_dates is not null
          then private.vacation_ranges_json(v_vacation.home_pause_dates) end,
        'effective', private.vacation_ranges_json(private.vacation_pause_dates(v_vacation)),
        'available', private.vacation_ranges_json(
          private.vacation_full_dates(v_vacation, v_today) - coalesce(v_vacation.home_pause_dates, '{}'::datemultirange)),
        'by', private.chore_person(v_vacation.home_id, v_vacation.home_pause_by, v_user_id),
        'at', v_vacation.home_pause_at),
      'people', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', p.id, 'member', private.chore_person(p.home_id, p.user_id, v_user_id),
          'status', private.vacation_participant_status(p, v_today),
          'startsOn', p.starts_on, 'endsOn', p.ends_on, 'direct', p.direct,
          'invitedBy', private.chore_person(p.home_id, p.invited_by, v_user_id),
          'createdAt', p.created_at, 'respondedAt', p.responded_at, 'endedReason', p.ended_reason,
          'revision', p.revision,
          'proposal', (select pg_catalog.jsonb_build_object('id', d.id, 'startsOn', d.starts_on,
              'endsOn', d.ends_on, 'createdAt', d.created_at,
              'proposedBy', private.chore_person(d.home_id, d.proposed_by, v_user_id),
              'mine', d.proposed_by = v_user_id)
            from private.home_vacation_date_proposals d where d.participant_id = p.id and d.status = 'pending'
              and (p.user_id = v_user_id or d.proposed_by = v_user_id or v_manage)),
          'can', pg_catalog.jsonb_build_object(
            'answer', v_open and p.user_id = v_user_id
              and private.vacation_participant_status(p, v_today) = 'pending',
            'withdraw', v_open and p.user_id = v_user_id and p.status = 'accepted',
            'remove', v_open and v_manage and private.vacation_participant_status(p, v_today) in ('pending', 'accepted'),
            'cancelInvitation', v_open and (v_manage or v_creator)
              and private.vacation_participant_status(p, v_today) = 'pending',
            'changeDates', v_open and p.status = 'accepted' and (p.user_id = v_user_id or (v_manage and p.direct)),
            'proposeDates', v_open and p.status = 'accepted' and p.user_id <> v_user_id
              and (v_manage or v_creator) and not (v_manage and p.direct)))
          order by p.status <> 'accepted', p.starts_on, p.created_at, p.id)
        from private.home_vacation_participants p
        where p.vacation_id = v_vacation.id
          and (p.status = 'accepted' or p.user_id = v_user_id or v_manage or v_creator)), '[]'::jsonb),
      'history', case when v_manage or v_creator then coalesce((select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('kind', e.kind, 'at', e.created_at,
            'by', private.chore_person(v_vacation.home_id, e.actor_id, v_user_id),
            'subject', private.chore_person(v_vacation.home_id, e.subject_id, v_user_id),
            'startsOn', e.starts_on, 'endsOn', e.ends_on) order by e.id desc)
        from (select * from private.home_vacation_events x where x.vacation_id = v_vacation.id
          order by x.id desc limit private.vacation_limit('events')) e), '[]'::jsonb) end,
      'can', pg_catalog.jsonb_build_object(
        'rename', v_status <> 'cancelled' and (v_manage or v_creator),
        'reminder', v_status = 'upcoming' and v_manage,
        'shorten', v_open and v_manage,
        'cancel', v_open and (v_manage or (v_creator and not exists (
          select 1 from private.home_vacation_participants p
          where p.vacation_id = v_vacation.id and p.status = 'accepted' and p.user_id <> v_user_id))),
        'pause', v_open and v_manage,
        'invite', v_open and (v_manage or v_creator),
        'addDirectly', v_open and v_manage,
        'decide', v_status <> 'cancelled' and v_manage));
  end
  $$;

-- A vacation's review (every member of the Home sees it; chore managers decide): listed occurrences,
-- and planned dates of fixed chores of its participants during their stays. Null when not visible.
create function public.list_vacation_review(p_vacation_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_vacation private.home_vacations;
    v_today date;
  begin
    if p_vacation_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_vacation from private.home_vacations v where v.id = p_vacation_id;
    if not found or not private.is_home_member(v_vacation.home_id, v_user_id) then
      return null;
    end if;
    v_today := private.task_today(v_vacation.home_id, null);
    return pg_catalog.jsonb_build_object(
      'vacationId', v_vacation.id, 'homeId', v_vacation.home_id, 'today', v_today,
      'canDecide', v_vacation.cancelled_at is null and private.can_manage_chores(v_vacation.home_id, v_user_id),
      'items', private.vacation_review_items(v_vacation, v_user_id),
      'planned', case when v_vacation.cancelled_at is null then coalesce((select pg_catalog.jsonb_agg(x.e)
        from (select pg_catalog.jsonb_array_elements(private.chore_planned_for(v_vacation.home_id, p.user_id,
            greatest(p.starts_on, v_today), p.ends_on, false, private.vacation_limit('planned'))) as e
          from private.home_vacation_participants p
          where p.vacation_id = v_vacation.id and p.status = 'accepted' and p.user_id is not null
            and p.ends_on >= v_today
          limit private.vacation_limit('planned')) x), '[]'::jsonb) else '[]'::jsonb end);
  end
  $$;

-- The Home vacation widget: the active vacation (the earliest started), else the next upcoming one,
-- with its dates, a scope for the label (everyone, only the viewer, or a number of members), whether
-- the viewer is away, and the dates its Home-wide pause covers. 42501 for a Home the caller is not in.
create function public.get_home_vacation_widget(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_vacation private.home_vacations;
    v_accepted integer;
    v_members integer;
    v_me boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    select * into v_vacation from private.home_vacations v
      where v.home_id = p_home_id and v.cancelled_at is null and v.ends_on >= v_today
      order by v.starts_on > v_today, v.starts_on, v.id
      limit 1;
    if not found then
      return pg_catalog.jsonb_build_object('today', v_today, 'vacation', null, 'others', 0,
        'pausedToday', false);
    end if;
    select count(distinct p.user_id)::integer, coalesce(bool_or(p.user_id = v_user_id), false)
      into v_accepted, v_me
      from private.home_vacation_participants p
      where p.vacation_id = v_vacation.id and p.status = 'accepted' and p.user_id is not null;
    select count(*)::integer into v_members from public.home_memberships m where m.home_id = p_home_id;
    return pg_catalog.jsonb_build_object(
      'today', v_today,
      'pausedToday', private.home_chores_paused_on(p_home_id, v_today),
      'others', (select count(*)::integer from private.home_vacations v
        where v.home_id = p_home_id and v.cancelled_at is null and v.ends_on >= v_today and v.id <> v_vacation.id),
      'vacation', pg_catalog.jsonb_build_object(
        'id', v_vacation.id, 'name', v_vacation.name,
        'status', private.vacation_status(v_vacation, v_today),
        'startsOn', v_vacation.starts_on, 'endsOn', v_vacation.ends_on,
        'scope', case when v_accepted >= v_members and v_members > 0 then 'everyone'
          when v_accepted = 1 and v_me then 'me' else 'members' end,
        'awayCount', v_accepted, 'me', v_me,
        'pauseDates', private.vacation_ranges_json(private.vacation_pause_dates(v_vacation))));
  end
  $$;

-- Vacation days for the chores calendar (at most 42 days): per day with something to show, whether
-- the Home's chores are paused, how many members are away and whether the caller is; and the
-- vacations overlapping the range. 42501 for a Home the caller is not in.
create function public.list_home_vacation_days(p_home_id uuid, p_from date, p_to date) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_from is null or p_to is null or p_to < p_from
       or p_to - p_from >= private.vacation_limit('calendar_days') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, null);
    return pg_catalog.jsonb_build_object(
      'days', coalesce((select pg_catalog.jsonb_agg(x.day order by x.d) from (
          select g.d::date as d, pg_catalog.jsonb_build_object(
              'date', g.d::date,
              'paused', private.home_chores_paused_on(p_home_id, g.d::date),
              'away', (select count(distinct p.user_id)::integer from private.home_vacation_participants p
                join private.home_vacations v on v.id = p.vacation_id
                where p.home_id = p_home_id and p.status = 'accepted' and v.cancelled_at is null
                  and g.d::date between p.starts_on and p.ends_on),
              'me', private.vacation_away(p_home_id, v_user_id, g.d::date)) as day
          from pg_catalog.generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g (d)) x
        where (x.day ->> 'away')::integer > 0), '[]'::jsonb),
      'vacations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', v.id, 'name', v.name, 'startsOn', v.starts_on, 'endsOn', v.ends_on,
          'status', private.vacation_status(v, v_today)) order by v.starts_on, v.id)
        from private.home_vacations v
        where v.home_id = p_home_id and v.cancelled_at is null and v.starts_on <= p_to and v.ends_on >= p_from),
        '[]'::jsonb));
  end
  $$;

-- An occurrence's vacation details for its page: how a vacation rule left it (substitute for whom,
-- no substitute, paused), whether it waits for a vacation review, which assignees are away on its due
-- date (vacations; absences only for chore managers and the absent member) and the decisions taken
-- on it (chore managers). Null when it is not the caller's to see.
create function public.get_chore_vacation_state(p_occurrence_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_manage boolean;
  begin
    if p_occurrence_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_occurrence from private.chore_occurrences o where o.id = p_occurrence_id and o.deleted_at is null;
    if not found or not private.is_home_member(v_occurrence.home_id, v_user_id) then
      return null;
    end if;
    v_manage := private.can_manage_chores(v_occurrence.home_id, v_user_id);
    return pg_catalog.jsonb_build_object(
      'state', v_occurrence.vacation_state,
      'substituteFor', private.chore_person(v_occurrence.home_id, v_occurrence.substitute_for, v_user_id),
      'review', v_occurrence.vacation_review,
      'pausedAt', v_occurrence.paused_at,
      'away', coalesce((select pg_catalog.jsonb_agg(private.chore_person(a.home_id, a.user_id, v_user_id)
          order by a.user_id)
        from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id
          and private.vacation_away(a.home_id, a.user_id, v_occurrence.due_date)), '[]'::jsonb),
      'absent', coalesce((select pg_catalog.jsonb_agg(private.chore_person(a.home_id, a.user_id, v_user_id)
          order by a.user_id)
        from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and (v_manage or a.user_id = v_user_id)
          and exists (select 1 from private.chore_absences b where b.home_id = a.home_id and b.user_id = a.user_id
            and v_occurrence.due_date between b.starts_on and b.ends_on)), '[]'::jsonb),
      'decisions', case when v_manage then coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'sourceKind', d.source_kind, 'sourceId', d.source_id, 'decision', d.decision, 'at', d.decided_at,
          'by', private.chore_person(d.home_id, d.decided_by, v_user_id)) order by d.id)
        from private.chore_vacation_decisions d where d.occurrence_id = v_occurrence.id), '[]'::jsonb)
        else '[]'::jsonb end);
  end
  $$;

-- Departure -------------------------------------------------------------------------------------------------

-- A departing member's pending and accepted participations end ('departure', kept in the history),
-- their waiting proposals are withdrawn and the envelopes follow. Their absences end with the
-- membership. Chore pages then re-apply the rules (advance_chores).
create function private.vacation_member_left() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_row record;
  begin
    for v_row in
      update private.home_vacation_participants p
        set status = 'withdrawn', ended_reason = 'departure',
          responded_at = coalesce(p.responded_at, pg_catalog.now()), revision = p.revision + 1
        where p.home_id = old.home_id and p.user_id = old.user_id and p.status in ('pending', 'accepted')
        returning p.id, p.vacation_id
    loop
      update private.home_vacation_date_proposals d set status = 'withdrawn', decided_at = pg_catalog.now()
        where d.participant_id = v_row.id and d.status = 'pending';
      perform private.vacation_event(v_row.vacation_id, 'left_home', null, old.user_id);
      perform private.refresh_vacation_envelope(v_row.vacation_id);
    end loop;
    return old;
  end
  $$;

create trigger home_memberships_vacations before delete on public.home_memberships
  for each row execute function private.vacation_member_left();

-- Grants -------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'advance_chores', 'update_chore_series', 'complete_chore_occurrence', 'skip_chore_occurrence',
      'reopen_chore_occurrence', 'list_chore_pool', 'update_chore_occurrence', 'create_home_vacation',
      'update_home_vacation', 'add_vacation_participants', 'change_vacation_participation',
      'answer_vacation_date_proposal', 'decide_chore_vacation_item', 'save_chore_absence',
      'delete_chore_absence', 'list_chore_absences', 'list_absence_review', 'list_home_vacations',
      'get_home_vacation', 'list_vacation_review', 'get_home_vacation_widget', 'list_home_vacation_days',
      'get_chore_vacation_state'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The job: the service role only.
  execute 'revoke all on function public.deliver_vacation_reminder(uuid, date, integer) from public, anon, authenticated';
  execute 'grant execute on function public.deliver_vacation_reminder(uuid, date, integer) to service_role';

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like '%chore%' or p.proname like '%vacation%'
      or p.proname like '%absence%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
