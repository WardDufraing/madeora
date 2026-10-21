-- S20: chores core (brief plans/steps/S20-brief.md; ADR 0026; spec "Confirmed fixed and rotating
-- recurring chore assignments", "Confirmed missed rotating chore behavior", "Confirmed skipping
-- recurring chore occurrences", "Confirmed completion of another member's chore", "Confirmed
-- optional per-occurrence chore completion notes", "Confirmed optional recurring chore checklists",
-- "Confirmed optional chore estimated duration", "Confirmed custom Home chore categories",
-- "Confirmed no chore difficulty levels", "Confirmed recurring chore pauses and Home vacation
-- periods" (the individual pause), "Confirmed recurring task and chore editing scope" and "deletion
-- scope", "Confirmed member departure and removal: content ownership" (reassignment rule)).
--
-- Chores belong to one Home. A chore (private.chores) is the stable identity: title, instructions
-- and category. A recurring chore has schedule parts (private.chore_schedules) like the S19 task
-- series parts: the rule (the S19 schedule functions, unchanged), the assignment (nobody, fixed
-- members, or a rotation order), the checklist template and the estimated duration. A change to
-- "this and following" ends the current part the day before and starts a new head part. Every
-- occurrence (private.chore_occurrences) keeps its original scheduled date (unique per chore, deleted
-- rows included, so retries, races and splits never create a date twice), its own assignees, its
-- own copy of the checklist with its own progress, and on completion or skip a snapshot of the
-- chore's title and category name. A one-off chore has exactly one occurrence and no part.
--
-- Rotation: a part numbers the dates of its rule from where its rotation starts (rotation_from):
-- turn 0, 1, 2, ... Every date of the rule counts, even one suppressed by a pause, so a skip, a miss
-- or a pause never shifts the order; turn n goes to the place n modulo the order's length
-- (packages/domain/src/chores/rotation.ts previews the same; shared vectors test both). A departed
-- participant's place stays in the order, empty, so the order does not shift: occurrences that fall
-- on it are created unassigned and flagged for reassignment.
--
-- Who may do what (default picked in the brief; the per-module matrix is open in the spec).
-- packages/domain/src/permissions/chores.ts makes the same decisions: every current member sees the
-- Home's chores, checklists, notes and history, ticks steps and completes any open occurrence,
-- naming the actual contributor (any current member); chore managers (the Owner, Administrators
-- granted the new delegable capability manageHomeChores) create, edit (every scope), pause and
-- delete chores, skip and reopen occurrences and manage categories.
--
-- Like tasks, nothing is exposed as a table: people use security-definer functions that recheck
-- the confirmed caller and their current membership on every call. A Home the caller does not
-- belong to answers 42501 "not permitted" exactly like one that does not exist; a chore, occurrence,
-- step or category they may not see answers 'not_found' exactly like a missing one. People are named
-- by membership id (public.home_directory), never by account id; a departed member reads as null.
--
-- Approval (spec "Confirmed optional approval of chore completions", "self-approval", "rejected
-- chore completion rework and resubmission", "correction and reversal", "chore-approval reviewer
-- notifications"): a chore manager turns approval on per chore (prospective). Completing such a
-- chore records a submission (private.chore_submissions: submitter, contributor, reported time,
-- note, the checklist as it stood) and the occurrence is Pending approval until a reviewer (the
-- Owner, Administrators granted the delegable approveHomeChores; ordinary completion rights never
-- review) approves it (it is completed with the submission's details; the reviewer may be the
-- contributor) or rejects it with a reason (it is open again and Needs rework; the submission stays;
-- the next completion is a new attempt). Reviewers are notified in-app (email opt-in), grouped per
-- Home while their queue is not empty. Chore managers correct a completion's contributor, time and
-- note; every submission, decision, reopen and correction is an append-only event. Points (S23)
-- reconcile on these events later; nothing here awards points.
--
-- Concurrency: every change to a chore or its occurrences locks the chore row first, so changes to
-- one chore queue and never deadlock. Edits name the revision they started from and a stale one
-- answers 'conflict'. Completion and skip are set-to-state under that lock: of two people completing
-- at once one is recorded and the other is told it is already done. Creates take a client id, so a
-- retry returns the same row.

-- Audit subjects, the new capability, trash types -----------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal'
  ));

-- Notifications: the optional category 'approvals' (reviewers; in-app on, email opt-in) ------------

create or replace function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category
    when 'security' then true when 'storage' then true
    when 'invitations' then false when 'reminders' then false when 'approvals' then false
  end;
  $$;

alter table public.notifications drop constraint notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('security', 'invitations', 'storage', 'reminders', 'approvals'));

alter table public.notification_preferences drop constraint notification_preferences_category_check;
alter table public.notification_preferences add constraint notification_preferences_category_check
  check (category in ('invitations', 'reminders', 'approvals'));

-- packages/domain optionalNotificationCategories lists the same.
create or replace function private.notification_category_optional(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_category in ('invitations', 'reminders', 'approvals'), false);
  $$;

create or replace function public.get_notification_settings()
returns table (home_id uuid, category text, channel text, enabled boolean, overridden boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select s.home_id, c.category, ch.channel,
        private.effective_notification_channel(v_user_id, s.home_id, c.category, ch.channel),
        exists (
          select 1 from public.notification_preferences p
          where p.user_id = v_user_id and p.home_id is not distinct from s.home_id
            and p.category = c.category and p.channel = ch.channel
        )
      from (
        select null::uuid as home_id
        union all
        select m.home_id from public.home_memberships m where m.user_id = v_user_id
      ) s
      cross join (values ('invitations'), ('reminders'), ('approvals')) c (category)
      cross join (values ('in_app'), ('email')) ch (channel)
      order by s.home_id nulls first, c.category, ch.channel;
  end
  $$;

-- Limits and text rules ----------------------------------------------------------------------------

-- apps/web/src/chores/schema.ts uses the same numbers.
create function private.chore_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'chores' then 500             -- active (not deleted, not ended) chores per Home
    when 'categories' then 50          -- categories per Home
    when 'category_name' then 40
    when 'title' then 200
    when 'instructions' then 2000
    when 'steps' then 30               -- checklist steps per chore or occurrence
    when 'step_label' then 120
    when 'members' then 20             -- fixed assignees, or places in a rotation
    when 'minutes' then 1440           -- the longest estimated duration (24 hours)
    when 'note' then 500               -- completion note
    when 'reason' then 500             -- skip reason, rejection reason, correction reason
    when 'page' then 100               -- occurrences one overview read returns
    when 'history_page' then 50
    when 'max_offset' then 10000
    when 'horizon' then 7              -- days ahead the overview shows
    when 'parts_per_advance' then 50
    when 'catch_up' then 100           -- occurrences one advance creates per part
    when 'preview_dates' then 5
    when 'approvals_page' then 100     -- pending submissions one review queue read returns
  end;
  $$;

-- Notes and reasons: surrounding whitespace removed and every run of whitespace (line breaks
-- included) read as one space; empty is no text (null).
create function private.chore_short_text(p_text text) returns text
  language sql immutable set search_path = '' as $$
  select nullif(pg_catalog.btrim(pg_catalog.regexp_replace(p_text, '\s+', ' ', 'g')), '');
  $$;

-- Tables -------------------------------------------------------------------------------------------

create table private.chore_categories (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null constraint chore_categories_name_check check (private.is_visible_name(name, 40)),
  color text not null constraint chore_categories_color_check
    check (color is not null and private.is_task_label_color(color)),
  position integer not null default 0,
  archived_at timestamptz,
  revision integer not null default 1 constraint chore_categories_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint chore_categories_id_home_key unique (id, home_id)
);

create index chore_categories_home_idx on private.chore_categories (home_id, position);

create table private.chores (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  kind text not null constraint chores_kind_check check (kind in ('one_off', 'recurring')),
  title text not null constraint chores_title_check check (private.is_visible_name(title, 200)),
  instructions text constraint chores_instructions_check
    check (instructions is null or private.is_plain_text(instructions, 2000)),
  category_id uuid,
  -- Completions wait for a reviewer's approval (off unless a chore manager turns it on; a change
  -- applies to completions submitted after it).
  requires_approval boolean not null default false,
  -- The whole series was deleted (open occurrences in the trash); its history stays.
  ended_at timestamptz,
  ended_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint chores_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint chores_id_home_key unique (id, home_id),
  -- Only a category of the chore's own Home; deleting the category leaves the chore uncategorized.
  constraint chores_category_fkey foreign key (category_id, home_id)
    references private.chore_categories (id, home_id) on delete set null (category_id)
);

create index chores_home_idx on private.chores (home_id) where deleted_at is null;
create index chores_category_idx on private.chores (category_id) where category_id is not null;

-- One part of a recurring chore's schedule. Only the head (superseded_at null) creates occurrences.
-- next_date is the next date to create (null: none); last_date the latest created so far.
create table private.chore_schedules (
  id uuid primary key,
  chore_id uuid not null,
  home_id uuid not null,
  previous_id uuid,
  frequency text not null constraint chore_schedules_frequency_check
    check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  interval_count integer not null constraint chore_schedules_interval_check check (interval_count between 1 and 99),
  weekdays smallint[] constraint chore_schedules_weekdays_check check (
    (frequency = 'weekly') = (weekdays is not null)
    and (weekdays is null or (cardinality(weekdays) between 1 and 7 and weekdays <@ '{1,2,3,4,5,6,7}'))
  ),
  starts_on date not null,
  -- After a split that kept the schedule: the first date this part may create. Null: starts_on.
  active_from date,
  ends_on date,
  max_count integer constraint chore_schedules_count_check check (max_count between 1 and 999),
  until_date date,
  next_date date,
  last_date date,
  -- A pause from paused_from to paused_until (inclusive), or indefinitely (paused_until null).
  paused_from date,
  paused_until date,
  paused_by uuid references auth.users (id) on delete set null,
  superseded_at timestamptz,
  assignment text not null constraint chore_schedules_assignment_check
    check (assignment in ('none', 'fixed', 'rotating')),
  -- Where the rotation's turns are counted from (rotating only).
  rotation_from date,
  estimated_minutes integer constraint chore_schedules_minutes_check check (estimated_minutes between 1 and 1440),
  needs_reassignment boolean not null default false,
  revision integer not null default 1 constraint chore_schedules_revision_check check (revision >= 1),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint chore_schedules_id_home_key unique (id, home_id),
  constraint chore_schedules_chore_fkey foreign key (chore_id, home_id)
    references private.chores (id, home_id) on delete cascade,
  constraint chore_schedules_ends_check check (ends_on is null or ends_on >= starts_on),
  constraint chore_schedules_until_check check (until_date is null or until_date >= starts_on - 1),
  constraint chore_schedules_pause_check check (
    (paused_from is null and paused_until is null) or (paused_from is not null
      and (paused_until is null or paused_until >= paused_from))),
  constraint chore_schedules_rotation_check check ((assignment = 'rotating') = (rotation_from is not null))
);

create index chore_schedules_chore_idx on private.chore_schedules (chore_id);
create unique index chore_schedules_one_head on private.chore_schedules (chore_id)
  where superseded_at is null;
create index chore_schedules_home_head_idx on private.chore_schedules (home_id, last_date)
  where superseded_at is null;

-- A part's assignees (fixed) or rotation order (rotating), by position. A departed member's place
-- stays with user_id null (spec: future assignments to them are cleared; the order does not shift).
create table private.chore_schedule_members (
  schedule_id uuid not null,
  home_id uuid not null,
  position integer not null constraint chore_schedule_members_position_check check (position between 0 and 19),
  user_id uuid,
  primary key (schedule_id, position),
  foreign key (schedule_id, home_id) references private.chore_schedules (id, home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id)
    on delete set null (user_id)
);

create unique index chore_schedule_members_user_key on private.chore_schedule_members (schedule_id, user_id)
  where user_id is not null;
create index chore_schedule_members_member_idx on private.chore_schedule_members (home_id, user_id);

-- The checklist each new occurrence of the part starts with.
create table private.chore_schedule_steps (
  schedule_id uuid not null references private.chore_schedules (id) on delete cascade,
  position integer not null,
  label text not null constraint chore_schedule_steps_label_check check (private.is_visible_name(label, 120)),
  mandatory boolean not null default false,
  primary key (schedule_id, position)
);

create table private.chore_occurrences (
  id uuid primary key,
  chore_id uuid not null,
  home_id uuid not null,
  schedule_id uuid references private.chore_schedules (id) on delete set null,
  scheduled_date date not null,
  due_date date not null,
  estimated_minutes integer constraint chore_occurrences_minutes_check check (estimated_minutes between 1 and 1440),
  -- pending_approval: a submission waits for a reviewer (private.chore_submissions).
  status text not null default 'open'
    constraint chore_occurrences_status_check
    check (status in ('open', 'pending_approval', 'completed', 'skipped')),
  -- Open again after a reviewer rejected its last submission (Needs rework).
  in_rework boolean not null default false,
  -- Changed on its own ("this occurrence"): later series changes leave it as it is.
  detached boolean not null default false,
  needs_reassignment boolean not null default false,
  completed_at timestamptz,
  -- Who recorded the completion, and who actually did the work (spec: kept apart).
  completed_by uuid references auth.users (id) on delete set null,
  contributor_id uuid references auth.users (id) on delete set null,
  note text constraint chore_occurrences_note_check check (note is null or private.is_plain_text(note, 500)),
  skipped_at timestamptz,
  skipped_by uuid references auth.users (id) on delete set null,
  skip_reason text constraint chore_occurrences_reason_check
    check (skip_reason is null or private.is_plain_text(skip_reason, 500)),
  -- What the chore was called, and its category, when the occurrence was closed (history is never
  -- rewritten by a rename).
  closed_title text,
  closed_category text,
  -- Approved by a reviewer (the completion came through a submission).
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  reopened_at timestamptz,
  reopened_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint chore_occurrences_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint chore_occurrences_id_home_key unique (id, home_id),
  constraint chore_occurrences_chore_fkey foreign key (chore_id, home_id)
    references private.chores (id, home_id) on delete cascade,
  -- One occurrence per chore and date, whatever retries, races or splits do (deleted rows count, so
  -- a date in the trash is not created again).
  constraint chore_occurrences_date_key unique (chore_id, scheduled_date),
  constraint chore_occurrences_state_check check (
    (status = 'completed') = (completed_at is not null)
    and (status = 'skipped') = (skipped_at is not null)
    and (status = 'completed' or (note is null and contributor_id is null and completed_by is null))
    and (status = 'skipped' or skip_reason is null)
    and (status = 'completed' or (approved_at is null and approved_by is null))
    and (status = 'open' or not in_rework))
);

create index chore_occurrences_home_open_idx on private.chore_occurrences (home_id, due_date)
  where status = 'open' and deleted_at is null;
create index chore_occurrences_home_pending_idx on private.chore_occurrences (home_id)
  where status = 'pending_approval' and deleted_at is null;
create index chore_occurrences_chore_idx on private.chore_occurrences (chore_id, scheduled_date desc);
create index chore_occurrences_schedule_idx on private.chore_occurrences (schedule_id)
  where schedule_id is not null;

-- An occurrence's assignees; current members by construction (the row ends with the membership).
create table private.chore_occurrence_assignees (
  occurrence_id uuid not null,
  home_id uuid not null,
  user_id uuid not null,
  primary key (occurrence_id, user_id),
  foreign key (occurrence_id, home_id) references private.chore_occurrences (id, home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index chore_occurrence_assignees_member_idx on private.chore_occurrence_assignees (home_id, user_id);

-- An occurrence's own checklist and progress.
create table private.chore_occurrence_steps (
  id uuid primary key,
  occurrence_id uuid not null references private.chore_occurrences (id) on delete cascade,
  position integer not null,
  label text not null constraint chore_occurrence_steps_label_check check (private.is_visible_name(label, 120)),
  mandatory boolean not null default false,
  checked_at timestamptz,
  checked_by uuid references auth.users (id) on delete set null,
  constraint chore_occurrence_steps_position_key unique (occurrence_id, position) deferrable initially deferred
);

-- Every attempt to complete an occurrence of a chore that requires approval, numbered per
-- occurrence. Never changed after its decision: a rejected attempt stays with its reason, and the
-- next completion is a new attempt. At most one pending per occurrence.
create table private.chore_submissions (
  id uuid primary key,
  -- Order of arrival across the Home (submitted_at ties within a transaction).
  seq bigint generated always as identity,
  occurrence_id uuid not null,
  home_id uuid not null,
  attempt integer not null constraint chore_submissions_attempt_check check (attempt >= 1),
  submitted_by uuid references auth.users (id) on delete set null,
  contributor_id uuid references auth.users (id) on delete set null,
  -- The reported completion time (the late-points policy of S23 uses this, not the review time).
  submitted_at timestamptz not null default now(),
  note text constraint chore_submissions_note_check check (note is null or private.is_plain_text(note, 500)),
  -- The checklist as it stood: [{label, mandatory, checked}].
  steps jsonb not null default '[]'::jsonb,
  status text not null default 'pending' constraint chore_submissions_status_check
    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  reason text constraint chore_submissions_reason_check
    check (reason is null or private.is_plain_text(reason, 500)),
  foreign key (occurrence_id, home_id) references private.chore_occurrences (id, home_id) on delete cascade,
  constraint chore_submissions_attempt_key unique (occurrence_id, attempt),
  constraint chore_submissions_decision_check check (
    (status = 'pending') = (decided_at is null)
    and (status = 'rejected') = (reason is not null))
);

create unique index chore_submissions_one_pending on private.chore_submissions (occurrence_id)
  where status = 'pending';
create index chore_submissions_home_pending_idx on private.chore_submissions (home_id, seq)
  where status = 'pending';

-- Every completion, submission, decision, skip, reopen and correction of an occurrence, in order
-- (append-only), so nothing that was recorded is lost: who completed it, for whom, the note, the
-- skip or rejection reason, and a correction's values before and after.
create table private.chore_occurrence_events (
  id bigint generated always as identity primary key,
  occurrence_id uuid not null references private.chore_occurrences (id) on delete cascade,
  kind text not null constraint chore_occurrence_events_kind_check
    check (kind in ('completed', 'skipped', 'reopened', 'submitted', 'approved', 'rejected',
      'withdrawn', 'corrected')),
  actor_id uuid references auth.users (id) on delete set null,
  contributor_id uuid references auth.users (id) on delete set null,
  note text,
  reason text,
  submission_id uuid references private.chore_submissions (id) on delete set null,
  -- A correction: the completion time before and after, the contributor and note before.
  completed_at timestamptz,
  previous_completed_at timestamptz,
  previous_contributor_id uuid references auth.users (id) on delete set null,
  previous_note text,
  created_at timestamptz not null default now()
);

create index chore_occurrence_events_occurrence_idx on private.chore_occurrence_events (occurrence_id, id);

-- What deleting following or all occurrences took away, so the trash can bring it back.
create table private.chore_removals (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null,
  home_id uuid not null,
  head_id uuid not null,
  mode text not null constraint chore_removals_mode_check check (mode in ('following', 'series')),
  from_date date,
  occurrence_ids uuid[] not null,
  -- The head's revision right after the removal: a different one later means the schedule changed.
  head_revision integer not null,
  previous_until_date date,
  -- Set by the restore resolution 'restore_occurrences_only'.
  occurrences_only boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (chore_id, home_id) references private.chores (id, home_id) on delete cascade
);

alter table private.chore_categories enable row level security;
alter table private.chores enable row level security;
alter table private.chore_schedules enable row level security;
alter table private.chore_schedule_members enable row level security;
alter table private.chore_schedule_steps enable row level security;
alter table private.chore_occurrences enable row level security;
alter table private.chore_occurrence_assignees enable row level security;
alter table private.chore_occurrence_steps enable row level security;
alter table private.chore_removals enable row level security;
alter table private.chore_occurrence_events enable row level security;
alter table private.chore_submissions enable row level security;
revoke all on table private.chore_categories, private.chores, private.chore_schedules,
  private.chore_schedule_members, private.chore_schedule_steps, private.chore_occurrences,
  private.chore_occurrence_assignees, private.chore_occurrence_steps, private.chore_removals,
  private.chore_occurrence_events, private.chore_submissions
  from public, anon, authenticated;

comment on table private.chores is 'S20: Home chores. Not exposed through the API.';
comment on table private.chore_occurrences is 'S20: chore occurrences. Not exposed through the API.';

-- Member departure (spec "Confirmed task reassignment rule": also outstanding chores) ---------------

-- Before a membership ends, the open occurrences the person was assigned to, and the schedule parts
-- they are in, are flagged for reassignment (new occurrences on their place then carry the flag);
-- their assignments end through the foreign keys. Completed and skipped records keep attribution.
create function private.flag_departed_chore_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    update private.chore_occurrences o set needs_reassignment = true
      where o.home_id = old.home_id and o.status = 'open' and not o.needs_reassignment
        and exists (
          select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = o.id and a.user_id = old.user_id
        );
    update private.chore_schedules s set needs_reassignment = true
      where s.home_id = old.home_id and s.superseded_at is null and not s.needs_reassignment
        and exists (
          select 1 from private.chore_schedule_members m
          where m.schedule_id = s.id and m.user_id = old.user_id
        );
    return old;
  end
  $$;

create trigger home_memberships_flag_chore_assignments
  before delete on public.home_memberships
  for each row execute function private.flag_departed_chore_assignments();

-- Permission helpers (packages/domain decideChoreAction mirrors these) -----------------------------

-- Chore managers: the Owner, and Administrators granted manageHomeChores (home.chores.manage).
create function private.can_manage_chores(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and private.has_home_capability(p_home_id, p_user_id, 'manageHomeChores');
  $$;

-- Chore reviewers: the Owner, and Administrators granted approveHomeChores (home.chores.review).
-- Ordinary completion rights never review; a reviewer may approve their own completion.
create function private.can_review_chores(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_home_id is not null and p_user_id is not null
    and private.has_home_capability(p_home_id, p_user_id, 'approveHomeChores');
  $$;

-- Tells the Home's current reviewers, except the submitter, that a completion waits for them
-- (spec "Confirmed chore-approval reviewer notifications"): in-app, and by email only for those who
-- opted in. Grouped: one notice per reviewer while the Home's queue is not empty (the key is the
-- oldest pending submission), so a retry or a second submission adds nothing; once the queue was
-- emptied, the next submission notifies again. The notice names no chore or person.
create function private.notify_chore_reviewers(p_home_id uuid, p_submitter uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_oldest uuid;
    v_user uuid;
  begin
    select s.id into v_oldest from private.chore_submissions s
      where s.home_id = p_home_id and s.status = 'pending'
      order by s.seq limit 1;
    if v_oldest is null then
      return;
    end if;
    for v_user in
      select m.user_id from public.home_memberships m
      where m.home_id = p_home_id and m.user_id is distinct from p_submitter
        and private.can_review_chores(p_home_id, m.user_id)
      order by m.user_id
    loop
      perform private.notify_user(
        v_user, p_home_id, 'approvals', 'chore.approval_requested',
        pg_catalog.jsonb_build_object('homeId', p_home_id),
        'chore-approvals:' || v_oldest::text, true);
    end loop;
  end
  $$;

-- 42501 "not permitted" for a Home the caller does not belong to (or that does not exist).
create function private.require_chore_home(p_home_id uuid, p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if p_home_id is null or not private.is_home_member(p_home_id, p_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
  end
  $$;

-- Serializes name checks and limits within one Home, so two creates cannot both pass.
create function private.lock_chore_home(p_kind text, p_home_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('chores:' || p_kind || ':' || p_home_id::text, 0));
  $$;

-- A chore for a change by p_user_id, locked: the first lock every change to a chore and its
-- occurrences takes. Null when missing, deleted, or not in a Home they belong to.
create function private.lock_chore(p_chore_id uuid, p_user_id uuid) returns private.chores
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_chore private.chores;
  begin
    select * into v_chore from private.chores c where c.id = p_chore_id for update;
    if not found or v_chore.deleted_at is not null
       or not private.is_home_member(v_chore.home_id, p_user_id) then
      return null;
    end if;
    return v_chore;
  end
  $$;

-- An occurrence for a change, locked after its chore. Null when either is missing, deleted or not
-- the caller's to see.
create function private.lock_chore_occurrence(p_occurrence_id uuid, p_user_id uuid)
returns private.chore_occurrences
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
  begin
    if private.lock_chore(
      (select o.chore_id from private.chore_occurrences o where o.id = p_occurrence_id), p_user_id
    ) is null then
      return null;
    end if;
    select * into v_occurrence from private.chore_occurrences o where o.id = p_occurrence_id for update;
    if not found or v_occurrence.deleted_at is not null then
      return null;
    end if;
    return v_occurrence;
  end
  $$;

-- The head part of a chore (locked: callers hold the chore's lock already).
create function private.chore_head(p_chore_id uuid) returns private.chore_schedules
  language sql stable security definer set search_path = '' as $$
  select * from private.chore_schedules s where s.chore_id = p_chore_id and s.superseded_at is null;
  $$;

create function private.audit_chore(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids and counts only: never titles, instructions, notes, reasons or names.
  select private.audit(p_action, p_home_id, p_subject_type, p_subject_id, p_details);
  $$;

-- Schedule arithmetic (the S19 rule functions, private.series_first_on_or_after and friends) -------

-- The next date of a part on or after p_from within its end, or null (pauses aside).
create function private.chore_part_next(p_part private.chore_schedules, p_from date) returns date
  language sql immutable set search_path = '' as $$
  select case when p_part.until_date is null or d <= p_part.until_date then d end
  from (select private.series_first_on_or_after(p_part.frequency, p_part.interval_count,
    p_part.weekdays, p_part.starts_on,
    greatest(p_from, coalesce(p_part.active_from, p_part.starts_on))) as d) x;
  $$;

create function private.chore_part_has_date(p_part private.chore_schedules, p_date date) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(private.chore_part_next(p_part, p_date) = p_date, false);
  $$;

-- Whether a date falls inside the part's pause (inclusive; open-ended when paused_until is null).
create function private.chore_paused_on(p_part private.chore_schedules, p_date date) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_part.paused_from is not null and p_date >= p_part.paused_from
    and (p_part.paused_until is null or p_date <= p_part.paused_until), false);
  $$;

-- The turn of a date in a rotation: how many dates of the pattern lie on or after p_rotation_from
-- and before p_date (packages/domain rotationTurn; tests/db/rls/chore-rotation-vectors.test.ts).
create function private.chore_turn(
  p_frequency text, p_interval integer, p_weekdays smallint[], p_starts_on date,
  p_rotation_from date, p_date date
) returns integer
  language plpgsql immutable set search_path = '' as $$
  declare
    v_first date := private.series_first_on_or_after(p_frequency, p_interval, p_weekdays, p_starts_on,
      p_rotation_from);
    v_next date;
    v_turn integer := 0;
  begin
    if v_first is null or p_date is null or p_date <= v_first then
      return 0;
    end if;
    if p_frequency = 'daily' then
      return ((p_date - v_first) + p_interval - 1) / p_interval;
    end if;
    v_next := v_first;
    while v_next < p_date loop
      v_turn := v_turn + 1;
      v_next := private.series_first_on_or_after(p_frequency, p_interval, p_weekdays, p_starts_on,
        v_next + 1);
    end loop;
    return v_turn;
  end
  $$;

-- Who a part assigns an occurrence on p_date to, and whether it must be flagged for reassignment:
-- fixed: its members (flagged while a departed member's place is unfilled); rotating: the member
-- whose turn it is (none and flagged when that place is empty); none: nobody.
create function private.chore_part_assignees(p_part private.chore_schedules, p_date date)
returns table (user_ids uuid[], flagged boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_places integer;
    v_user uuid;
  begin
    if p_part.assignment = 'fixed' then
      return query select
        coalesce((select array_agg(m.user_id order by m.position) from private.chore_schedule_members m
          where m.schedule_id = p_part.id and m.user_id is not null), '{}'::uuid[]),
        p_part.needs_reassignment;
      return;
    end if;
    if p_part.assignment = 'rotating' then
      select count(*)::integer into v_places from private.chore_schedule_members m
        where m.schedule_id = p_part.id;
      if v_places > 0 then
        select m.user_id into v_user from private.chore_schedule_members m
          where m.schedule_id = p_part.id
            and m.position = private.chore_turn(p_part.frequency, p_part.interval_count,
              p_part.weekdays, p_part.starts_on, p_part.rotation_from, p_date) % v_places;
      end if;
      return query select case when v_user is null then '{}'::uuid[] else array[v_user] end,
        v_user is null;
      return;
    end if;
    return query select '{}'::uuid[], false;
  end
  $$;

-- Up to p_limit dates of a part on or after p_from that are not paused, with their assignees as
-- membership ids (null for an empty place), for previews.
create function private.chore_part_preview(p_part private.chore_schedules, p_from date, p_limit integer)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_result jsonb := '[]'::jsonb;
    v_next date := private.chore_part_next(p_part, p_from);
    v_users uuid[];
    v_guard integer := 0;
  begin
    while v_next is not null and pg_catalog.jsonb_array_length(v_result) < p_limit and v_guard < 1000 loop
      v_guard := v_guard + 1;
      if private.chore_paused_on(p_part, v_next) then
        exit when p_part.paused_until is null;
        v_next := private.chore_part_next(p_part, p_part.paused_until + 1);
        continue;
      end if;
      select a.user_ids into v_users from private.chore_part_assignees(p_part, v_next) a;
      v_result := v_result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'date', v_next,
        'assignees', coalesce((select pg_catalog.jsonb_agg(private.member_ref(p_part.home_id, u) order by o)
          from unnest(v_users) with ordinality as x (u, o)), '[]'::jsonb)));
      v_next := private.chore_part_next(p_part, v_next + 1);
    end loop;
    return v_result;
  end
  $$;

-- Input checks ---------------------------------------------------------------------------------------

-- Membership ids of the Home as account ids, in the given order; null when any is not a current
-- member, appears twice, or there are more than the limit.
create function private.chore_member_users(p_home_id uuid, p_member_ids uuid[]) returns uuid[]
  language sql stable security definer set search_path = '' as $$
  select case
    when cardinality(coalesce(p_member_ids, '{}')) > private.chore_limit('members') then null
    when (select count(distinct x) from unnest(coalesce(p_member_ids, '{}')) as x)
      <> cardinality(coalesce(p_member_ids, '{}')) then null
    when (select count(*) from public.home_memberships m
          where m.home_id = p_home_id and m.id = any (coalesce(p_member_ids, '{}')))
      <> cardinality(coalesce(p_member_ids, '{}')) then null
    else coalesce((select array_agg(m.user_id order by x.o)
      from unnest(coalesce(p_member_ids, '{}')) with ordinality as x (id, o)
      join public.home_memberships m on m.home_id = p_home_id and m.id = x.id), '{}'::uuid[])
  end;
  $$;

-- An assignment from the API: {"mode": "none" | "fixed" | "rotating", "members": [membership ids,
-- in order]}. none: no members; fixed: 1–20; rotating (recurring only): 2–20. 22023 when it is
-- malformed; users null when a member is not a current member of the Home (invalid_assignee).
create function private.chore_assignment(p_home_id uuid, p_assignment jsonb, p_recurring boolean)
returns table (mode text, users uuid[])
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_mode text;
    v_ids uuid[];
  begin
    if p_assignment is null or pg_catalog.jsonb_typeof(p_assignment) <> 'object'
       or pg_catalog.jsonb_typeof(p_assignment -> 'mode') <> 'string'
       or pg_catalog.jsonb_typeof(p_assignment -> 'members') <> 'array' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_mode := p_assignment ->> 'mode';
    begin
      select coalesce(array_agg(x::uuid order by o), '{}') into v_ids
        from pg_catalog.jsonb_array_elements_text(p_assignment -> 'members') with ordinality as e (x, o);
    exception when invalid_text_representation then
      raise exception 'invalid request' using errcode = '22023';
    end;
    if v_mode not in ('none', 'fixed', 'rotating')
       or (v_mode = 'none' and cardinality(v_ids) <> 0)
       or (v_mode = 'fixed' and cardinality(v_ids) not between 1 and private.chore_limit('members'))
       or (v_mode = 'rotating' and (not p_recurring
         or cardinality(v_ids) not between 2 and private.chore_limit('members'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return query select v_mode, private.chore_member_users(p_home_id, v_ids);
  end
  $$;

-- A checklist from the API: an array of {"label": text, "mandatory": boolean} (and for an
-- occurrence's own checklist, "id": an existing step to keep). At most 30 steps, no two labels that
-- read alike (spec: "duplicate/confusing entries"), no id twice. 22023 otherwise.
create function private.chore_steps(p_steps jsonb)
returns table (step_position integer, label text, mandatory boolean, step_id uuid)
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_steps is null or pg_catalog.jsonb_typeof(p_steps) <> 'array'
       or pg_catalog.jsonb_array_length(p_steps) > private.chore_limit('steps')
       or exists (
         select 1 from pg_catalog.jsonb_array_elements(p_steps) as e (s)
         where pg_catalog.jsonb_typeof(e.s) <> 'object'
           or pg_catalog.jsonb_typeof(e.s -> 'label') <> 'string'
           or not private.is_visible_name(e.s ->> 'label', private.chore_limit('step_label'))
           or pg_catalog.jsonb_typeof(e.s -> 'mandatory') <> 'boolean'
           or (e.s ? 'id' and pg_catalog.jsonb_typeof(e.s -> 'id') not in ('string', 'null'))
           or (pg_catalog.jsonb_typeof(e.s -> 'id') = 'string' and not (e.s ->> 'id')
             ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       )
       or (select count(distinct private.task_name_key(e.s ->> 'label'))
           from pg_catalog.jsonb_array_elements(p_steps) as e (s)) <> pg_catalog.jsonb_array_length(p_steps)
       or (select count(e.s ->> 'id') - count(distinct e.s ->> 'id')
           from pg_catalog.jsonb_array_elements(p_steps) as e (s)) <> 0 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    return query select (o - 1)::integer, e.s ->> 'label', (e.s ->> 'mandatory')::boolean,
        (e.s ->> 'id')::uuid
      from pg_catalog.jsonb_array_elements(p_steps) with ordinality as e (s, o)
      order by o;
  end
  $$;

-- Whether the chore-level fields are well formed.
create function private.valid_chore_fields(p_title text, p_instructions text, p_minutes integer)
returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(
    p_title is not null and private.is_visible_name(p_title, private.chore_limit('title'))
    and (p_instructions is null or private.is_plain_text(p_instructions, private.chore_limit('instructions')))
    and (p_minutes is null or p_minutes between 1 and private.chore_limit('minutes')),
    false);
  $$;

-- Whether a category id names a category of the Home that is not archived (null: uncategorized).
create function private.usable_chore_category(p_home_id uuid, p_category_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_category_id is null or exists (
    select 1 from private.chore_categories c
    where c.id = p_category_id and c.home_id = p_home_id and c.archived_at is null
  );
  $$;

-- Occurrences ----------------------------------------------------------------------------------------

-- Writes an occurrence's assignees (replacing what was there).
create function private.set_occurrence_assignees(p_occurrence_id uuid, p_home_id uuid, p_users uuid[])
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    delete from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence_id;
    insert into private.chore_occurrence_assignees (occurrence_id, home_id, user_id)
      select p_occurrence_id, p_home_id, u from unnest(coalesce(p_users, '{}')) as u
      on conflict do nothing;
  end
  $$;

-- Gives an occurrence a fresh, unchecked copy of a part's checklist (replacing its own).
create function private.copy_part_steps(p_occurrence_id uuid, p_part_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    delete from private.chore_occurrence_steps s where s.occurrence_id = p_occurrence_id;
    insert into private.chore_occurrence_steps (id, occurrence_id, position, label, mandatory)
      select gen_random_uuid(), p_occurrence_id, s.position, s.label, s.mandatory
      from private.chore_schedule_steps s where s.schedule_id = p_part_id;
  end
  $$;

-- Whether an open occurrence has progress a series change must not undo: changed on its own, or a
-- ticked step.
create function private.chore_occurrence_touched(p_occurrence private.chore_occurrences) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_occurrence.detached or exists (
    select 1 from private.chore_occurrence_steps s
    where s.occurrence_id = p_occurrence.id and s.checked_at is not null
  );
  $$;

create function private.chore_has_progress(p_occurrence_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.chore_occurrence_steps s
    where s.occurrence_id = p_occurrence_id and s.checked_at is not null
  );
  $$;

-- Creates the part's occurrence for one date, unless the chore already has one for that date (a
-- retry, a race, a split, or one in the trash).
create function private.create_chore_occurrence(p_part private.chore_schedules, p_date date) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid := gen_random_uuid();
    v_users uuid[];
    v_flagged boolean;
  begin
    select a.user_ids, a.flagged into v_users, v_flagged from private.chore_part_assignees(p_part, p_date) a;
    insert into private.chore_occurrences (
      id, chore_id, home_id, schedule_id, scheduled_date, due_date, estimated_minutes,
      needs_reassignment, updated_by
    ) values (
      v_id, p_part.chore_id, p_part.home_id, p_part.id, p_date, p_date, p_part.estimated_minutes,
      v_flagged, p_part.created_by
    )
    on conflict (chore_id, scheduled_date) do nothing;
    if not found then
      return null;
    end if;
    perform private.set_occurrence_assignees(v_id, p_part.home_id, v_users);
    perform private.copy_part_steps(v_id, p_part.id);
    return v_id;
  end
  $$;

-- Brings a head part up to date (its chore locked by the caller): every occurrence up to p_today
-- plus one upcoming, at most catch_up per call. A missed date stays an open, overdue occurrence; a
-- paused date is passed over (never created later). Returns how many it created.
create function private.advance_chore_part(p_part private.chore_schedules, p_today date) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_next date := p_part.next_date;
    v_last date := p_part.last_date;
    v_created integer := 0;
    v_steps integer := 0;
  begin
    if p_part.id is null or p_part.superseded_at is not null or v_next is null then
      return 0;
    end if;
    while v_next is not null and v_created < private.chore_limit('catch_up') and v_steps < 1000
      and (v_next <= p_today or v_last is null or v_last <= p_today) loop
      v_steps := v_steps + 1;
      if private.chore_paused_on(p_part, v_next) then
        exit when p_part.paused_until is null;
        v_next := private.chore_part_next(p_part, p_part.paused_until + 1);
        continue;
      end if;
      perform private.create_chore_occurrence(p_part, v_next);
      v_created := v_created + 1;
      v_last := greatest(v_last, v_next);
      v_next := private.chore_part_next(p_part, v_next + 1);
    end loop;
    if v_next is distinct from p_part.next_date or v_last is distinct from p_part.last_date then
      update private.chore_schedules s set next_date = v_next, last_date = v_last where s.id = p_part.id;
    end if;
    return v_created;
  end
  $$;

-- Creates the occurrences due in the Home (up to today plus one upcoming per recurring chore).
-- Chore pages call it before they read, so occurrences appear without a background job. Looks at
-- most parts_per_advance chores per call, those furthest behind first. Returns how many it created.
create function public.advance_chores(p_home_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_chore_id uuid;
    v_chore private.chores;
    v_part private.chore_schedules;
    v_created integer := 0;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    -- Locked one chore at a time, chore before part (the order every change uses), so two page loads
    -- queue instead of creating anything twice.
    for v_chore_id in
      select s.chore_id from private.chore_schedules s
      join private.chores c on c.id = s.chore_id
      where s.home_id = p_home_id and s.superseded_at is null and s.next_date is not null
        and (s.last_date is null or s.last_date <= v_today)
        and c.deleted_at is null and c.ended_at is null
      order by s.last_date nulls first, s.id
      limit private.chore_limit('parts_per_advance')
    loop
      select * into v_chore from private.chores c where c.id = v_chore_id for update;
      if v_chore.deleted_at is null and v_chore.ended_at is null then
        v_part := private.chore_head(v_chore.id);
        v_created := v_created + private.advance_chore_part(v_part, v_today);
      end if;
    end loop;
    return v_created;
  end
  $$;

-- The caller's Home -------------------------------------------------------------------------------

-- What the caller may do with the Home's chores, and its "today". 42501 for a Home they are not in.
create function public.get_chore_context(p_home_id uuid)
returns table (can_manage boolean, can_review boolean, pending_count integer, today date)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_review boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_review := private.can_review_chores(p_home_id, v_user_id);
    -- How many submissions wait: for reviewers only (others see pending state on each occurrence).
    return query select private.can_manage_chores(p_home_id, v_user_id), v_review,
      case when v_review then (select count(*)::integer from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.status = 'pending_approval' and o.deleted_at is null
          and c.deleted_at is null) else 0 end,
      private.task_today(p_home_id, null);
  end
  $$;

-- Categories (spec "Confirmed custom Home chore categories") ---------------------------------------

-- The Home's categories in their order, with how many active chores use each (the impact count
-- before deleting: every member sees every chore, so the count reveals nothing hidden). Archived
-- (retired) ones only when asked.
create function public.list_chore_categories(p_home_id uuid, p_include_archived boolean default false)
returns table (id uuid, name text, color text, "position" integer, archived boolean, revision integer,
  chore_count integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    return query
      select c.id, c.name, c.color, c.position, c.archived_at is not null, c.revision,
        (select count(*)::integer from private.chores h
          where h.category_id = c.id and h.deleted_at is null and h.ended_at is null)
      from private.chore_categories c
      where c.home_id = p_home_id and (coalesce(p_include_archived, false) or c.archived_at is null)
      order by c.position, c.created_at, c.id;
  end
  $$;

create function private.chore_category_name_taken(p_home_id uuid, p_name text, p_except uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.chore_categories c
    where c.home_id = p_home_id and c.id is distinct from p_except
      and private.task_name_key(c.name) = private.task_name_key(p_name)
  );
  $$;

-- Creates a category (chore managers). Outcomes: 'created', 'exists' (a retry of the caller's own
-- create), 'id_taken', 'duplicate_name', 'limit_reached', 'not_permitted'. 22023 for an invalid
-- name or colour.
create function public.create_chore_category(p_id uuid, p_home_id uuid, p_name text, p_color text)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.chore_categories;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_name is null or p_color is null
       or not private.is_visible_name(p_name, private.chore_limit('category_name'))
       or not private.is_task_label_color(p_color) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.chore_categories c where c.id = p_id;
    if found then
      if v_existing.created_by = v_user_id and v_existing.home_id = p_home_id then
        return query select 'exists', v_existing.revision;
      else
        return query select 'id_taken', null::integer;
      end if;
      return;
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    perform private.lock_chore_home('categories', p_home_id);
    if private.chore_category_name_taken(p_home_id, p_name, null) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    if (select count(*) from private.chore_categories c where c.home_id = p_home_id)
       >= private.chore_limit('categories') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.chore_categories (id, home_id, name, color, position, created_by, updated_by)
      values (p_id, p_home_id, p_name, p_color,
        coalesce((select max(c.position) + 1 from private.chore_categories c where c.home_id = p_home_id), 0),
        v_user_id, v_user_id)
      on conflict (id) do nothing;
    if not found then
      return query select case when c.created_by = v_user_id then 'exists' else 'id_taken' end,
        case when c.created_by = v_user_id then c.revision end
        from private.chore_categories c where c.id = p_id;
      return;
    end if;
    perform private.audit_chore('chore_category.created', p_home_id, 'chore_category', p_id);
    return query select 'created', 1;
  end
  $$;

-- Renames, recolours, archives (retires) or unarchives a category (chore managers). Chores show the
-- change at once; their schedules, checklists, assignments and closed records do not change.
-- Outcomes: 'saved', 'conflict' (with the current revision), 'duplicate_name', 'not_found',
-- 'not_permitted'.
create function public.update_chore_category(
  p_id uuid, p_expected_revision integer, p_name text, p_color text, p_archived boolean
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_category private.chore_categories;
  begin
    if p_id is null or p_expected_revision is null or p_archived is null or p_name is null
       or p_color is null or not private.is_visible_name(p_name, private.chore_limit('category_name'))
       or not private.is_task_label_color(p_color) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_category from private.chore_categories c where c.id = p_id;
    if not found or not private.is_home_member(v_category.home_id, v_user_id) then
      return query select 'not_found', null::integer;
      return;
    end if;
    perform private.lock_chore_home('categories', v_category.home_id);
    select * into v_category from private.chore_categories c where c.id = p_id for update;
    if not found then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_category.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_category.revision <> p_expected_revision then
      return query select 'conflict', v_category.revision;
      return;
    end if;
    if private.chore_category_name_taken(v_category.home_id, p_name, v_category.id) then
      return query select 'duplicate_name', null::integer;
      return;
    end if;
    update private.chore_categories c
      set name = p_name, color = p_color,
        archived_at = case when p_archived then coalesce(c.archived_at, pg_catalog.now()) end,
        revision = c.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where c.id = v_category.id
      returning * into v_category;
    perform private.audit_chore('chore_category.updated', v_category.home_id, 'chore_category',
      v_category.id, pg_catalog.jsonb_build_object('archived', p_archived));
    return query select 'saved', v_category.revision;
  end
  $$;

-- Puts the Home's categories in the given order (chore managers); categories not named keep their
-- place after the named ones. Outcomes: 'saved', 'not_permitted'.
create function public.reorder_chore_categories(p_home_id uuid, p_ids uuid[]) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_ids is null or cardinality(p_ids) not between 1 and private.chore_limit('categories') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return 'not_permitted';
    end if;
    perform private.lock_chore_home('categories', p_home_id);
    update private.chore_categories c
      set position = coalesce(o.ord, cardinality(p_ids) + c.position)::integer,
        updated_at = pg_catalog.now()
      from private.chore_categories c2
      left join (select x.id, x.ord from unnest(p_ids) with ordinality as x (id, ord)) o on o.id = c2.id
      where c.id = c2.id and c.home_id = p_home_id;
    return 'saved';
  end
  $$;

-- Deletes a category (chore managers) after the impact review: its chores become uncategorized, and
-- nothing else about them changes; closed occurrences keep the name they were closed under.
-- p_dry_run answers the count only. Outcomes: 'preview' and 'deleted' (with how many chores it was
-- on), 'conflict', 'not_found', 'not_permitted'.
create function public.delete_chore_category(p_id uuid, p_expected_revision integer, p_dry_run boolean)
returns table (outcome text, chore_count integer, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_category private.chore_categories;
    v_count integer;
  begin
    if p_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_category from private.chore_categories c where c.id = p_id;
    if not found or not private.is_home_member(v_category.home_id, v_user_id) then
      return query select 'not_found', null::integer, null::integer;
      return;
    end if;
    perform private.lock_chore_home('categories', v_category.home_id);
    select * into v_category from private.chore_categories c where c.id = p_id for update;
    if not found then
      return query select 'not_found', null::integer, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_category.home_id, v_user_id) then
      return query select 'not_permitted', null::integer, null::integer;
      return;
    end if;
    if v_category.revision <> p_expected_revision then
      return query select 'conflict', null::integer, v_category.revision;
      return;
    end if;
    select count(*)::integer into v_count from private.chores h
      where h.category_id = v_category.id and h.deleted_at is null;
    if p_dry_run then
      return query select 'preview', v_count, v_category.revision;
      return;
    end if;
    -- The foreign key leaves the chores uncategorized (on delete set null).
    delete from private.chore_categories c where c.id = v_category.id;
    perform private.audit_chore('chore_category.deleted', v_category.home_id, 'chore_category',
      v_category.id, pg_catalog.jsonb_build_object('chores', v_count));
    return query select 'deleted', v_count, null::integer;
  end
  $$;

-- Creating and editing a chore ------------------------------------------------------------------------

-- Writes a part's assignment (members by position) and checklist template.
create function private.set_part_template(
  p_part_id uuid, p_home_id uuid, p_users uuid[], p_steps jsonb
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_users is not null then
      delete from private.chore_schedule_members m where m.schedule_id = p_part_id;
      insert into private.chore_schedule_members (schedule_id, home_id, position, user_id)
        select p_part_id, p_home_id, (o - 1)::integer, u from unnest(p_users) with ordinality as x (u, o);
    end if;
    if p_steps is not null then
      delete from private.chore_schedule_steps s where s.schedule_id = p_part_id;
      insert into private.chore_schedule_steps (schedule_id, position, label, mandatory)
        select p_part_id, s.step_position, s.label, s.mandatory from private.chore_steps(p_steps) s;
    end if;
  end
  $$;

-- Creates a chore (chore managers): one-off (p_due_date, no rule) or recurring (the rule, from
-- p_starts_on, never creating dates before today: no back-fill; a rotation starts with the first
-- member at the first date created). p_assignment as
-- private.chore_assignment; rotation only for recurring chores. p_steps the checklist
-- (private.chore_steps, without ids). p_id is the chore id from the client, so a retry returns the
-- same chore. p_requires_approval: completions wait for a reviewer. Outcomes: 'created', 'exists', 'id_taken', 'not_permitted', 'limit_reached',
-- 'invalid_category', 'invalid_assignee', 'ended' (the rule allows no date from today).
-- occurrence_id is the first occurrence (to open it). 22023 for invalid fields.
create function public.create_chore(
  p_id uuid, p_home_id uuid, p_title text, p_assignment jsonb, p_steps jsonb default '[]'::jsonb,
  p_instructions text default null, p_category_id uuid default null, p_minutes integer default null,
  p_due_date date default null,
  p_frequency text default null, p_interval integer default null, p_starts_on date default null,
  p_weekdays smallint[] default null, p_ends_on date default null, p_max_count integer default null,
  p_requires_approval boolean default false
) returns table (outcome text, occurrence_id uuid, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recurring boolean := p_frequency is not null;
    v_existing private.chores;
    v_mode text;
    v_users uuid[];
    v_today date;
    v_part private.chore_schedules;
    v_occurrence uuid;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_requires_approval is null
       or not private.valid_chore_fields(p_title, p_instructions, p_minutes)
       or (v_recurring and (p_due_date is not null or not private.valid_series_rule(
         p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count)))
       or (not v_recurring and (p_due_date is null
         or p_due_date not between date '2000-01-01' and date '2199-12-31'
         or p_interval is not null or p_starts_on is not null or p_weekdays is not null
         or p_ends_on is not null or p_max_count is not null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform 1 from private.chore_steps(coalesce(p_steps, '[]'::jsonb)) s where s.step_id is not null;
    if found then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select a.mode, a.users into v_mode, v_users from private.chore_assignment(p_home_id, p_assignment, v_recurring) a;
    v_today := private.task_today(p_home_id, null);
    select * into v_existing from private.chores c where c.id = p_id;
    if found then
      if v_existing.created_by = v_user_id and v_existing.home_id = p_home_id then
        return query select 'exists',
          (select o.id from private.chore_occurrences o where o.chore_id = v_existing.id
            and o.deleted_at is null order by o.scheduled_date limit 1),
          v_existing.revision;
      else
        return query select 'id_taken', null::uuid, null::integer;
      end if;
      return;
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select 'not_permitted', null::uuid, null::integer;
      return;
    end if;
    if not private.usable_chore_category(p_home_id, p_category_id) then
      return query select 'invalid_category', null::uuid, null::integer;
      return;
    end if;
    if v_users is null then
      return query select 'invalid_assignee', null::uuid, null::integer;
      return;
    end if;
    -- The per-Home limit, counted under the Home lock so two creates cannot both pass.
    perform private.lock_chore_home('chores', p_home_id);
    if (select count(*) from private.chores c
        where c.home_id = p_home_id and c.deleted_at is null and c.ended_at is null)
       >= private.chore_limit('chores') then
      return query select 'limit_reached', null::uuid, null::integer;
      return;
    end if;
    insert into private.chores (
      id, home_id, kind, title, instructions, category_id, requires_approval, created_by, updated_by
    ) values (p_id, p_home_id, case when v_recurring then 'recurring' else 'one_off' end, p_title,
        p_instructions, p_category_id, p_requires_approval, v_user_id, v_user_id)
      on conflict (id) do nothing;
    if not found then
      return query select case when c.created_by = v_user_id then 'exists' else 'id_taken' end,
        null::uuid, case when c.created_by = v_user_id then c.revision end
        from private.chores c where c.id = p_id;
      return;
    end if;

    if not v_recurring then
      v_occurrence := gen_random_uuid();
      insert into private.chore_occurrences (
        id, chore_id, home_id, scheduled_date, due_date, estimated_minutes, updated_by
      ) values (v_occurrence, p_id, p_home_id, p_due_date, p_due_date, p_minutes, v_user_id);
      perform private.set_occurrence_assignees(v_occurrence, p_home_id, v_users);
      insert into private.chore_occurrence_steps (id, occurrence_id, position, label, mandatory)
        select gen_random_uuid(), v_occurrence, s.step_position, s.label, s.mandatory
        from private.chore_steps(coalesce(p_steps, '[]'::jsonb)) s;
    else
      insert into private.chore_schedules (
        id, chore_id, home_id, frequency, interval_count, weekdays, starts_on, ends_on, max_count,
        until_date, assignment, rotation_from, estimated_minutes, created_by, updated_by
      ) values (
        gen_random_uuid(), p_id, p_home_id, p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on,
        p_max_count,
        private.series_until(p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count),
        v_mode, case when v_mode = 'rotating' then greatest(p_starts_on, v_today) end, p_minutes,
        v_user_id, v_user_id
      ) returning * into v_part;
      v_part.next_date := private.chore_part_next(v_part, greatest(v_today, p_starts_on));
      if v_part.next_date is null then
        -- Every date of the rule is in the past: nothing would ever be created.
        delete from private.chores c where c.id = p_id;
        return query select 'ended', null::uuid, null::integer;
        return;
      end if;
      update private.chore_schedules s set next_date = v_part.next_date where s.id = v_part.id;
      perform private.set_part_template(v_part.id, p_home_id, v_users, coalesce(p_steps, '[]'::jsonb));
      perform private.advance_chore_part(v_part, v_today);
      select o.id into v_occurrence from private.chore_occurrences o
        where o.chore_id = p_id order by o.scheduled_date limit 1;
    end if;
    perform private.audit_chore('chore.created', p_home_id, 'chore', p_id,
      pg_catalog.jsonb_build_object('kind', case when v_recurring then 'recurring' else 'one_off' end,
        'assignment', v_mode, 'members', cardinality(v_users), 'approval', p_requires_approval));
    return query select 'created', v_occurrence, 1;
  end
  $$;

-- Changes a chore's own fields (chore managers): title, instructions, category and whether
-- completions need approval (p_requires_approval; null keeps it). Open occurrences show them at
-- once; completed and skipped ones keep the title and category they were closed under. Approval
-- applies to completions submitted after the change: a submission already waiting stays pending
-- for a reviewer, and nothing finalized changes. An archived category may stay, not be newly chosen. Outcomes: 'saved', 'conflict' (with the
-- current revision), 'invalid_category', 'not_found', 'not_permitted'.
create function public.update_chore(
  p_chore_id uuid, p_expected_revision integer, p_title text, p_instructions text default null,
  p_category_id uuid default null, p_requires_approval boolean default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_chore private.chores;
    v_approval_before boolean;
  begin
    if p_chore_id is null or p_expected_revision is null
       or not private.valid_chore_fields(p_title, p_instructions, null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_chore := private.lock_chore(p_chore_id, v_user_id);
    if v_chore.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_chore.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_chore.revision <> p_expected_revision then
      return query select 'conflict', v_chore.revision;
      return;
    end if;
    if p_category_id is distinct from v_chore.category_id
       and not private.usable_chore_category(v_chore.home_id, p_category_id) then
      return query select 'invalid_category', null::integer;
      return;
    end if;
    v_approval_before := v_chore.requires_approval;
    update private.chores c
      set title = p_title, instructions = p_instructions, category_id = p_category_id,
        requires_approval = coalesce(p_requires_approval, c.requires_approval),
        revision = c.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where c.id = v_chore.id
      returning * into v_chore;
    perform private.audit_chore('chore.updated', v_chore.home_id, 'chore', v_chore.id,
      case when v_chore.requires_approval <> v_approval_before
        then pg_catalog.jsonb_build_object('approval', v_chore.requires_approval)
        else '{}'::jsonb end);
    return query select 'saved', v_chore.revision;
  end
  $$;

-- Working on an occurrence ------------------------------------------------------------------------------

-- Ticks or unticks one step of an open occurrence (every current member; set-to-state, so a retry
-- or two people ticking at once change nothing twice). Outcomes: 'saved' (with the occurrence's
-- progress), 'occurrence_closed' (completed or skipped: its checklist is part of the record),
-- 'not_found'.
create function public.set_chore_step(p_step_id uuid, p_checked boolean)
returns table (outcome text, checked boolean, done integer, total integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_step private.chore_occurrence_steps;
    v_occurrence private.chore_occurrences;
  begin
    if p_step_id is null or p_checked is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(
      (select s.occurrence_id from private.chore_occurrence_steps s where s.id = p_step_id), v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::boolean, null::integer, null::integer;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select 'occurrence_closed', null::boolean, null::integer, null::integer;
      return;
    end if;
    select * into v_step from private.chore_occurrence_steps s where s.id = p_step_id for update;
    if (v_step.checked_at is not null) <> p_checked then
      update private.chore_occurrence_steps s
        set checked_at = case when p_checked then pg_catalog.now() end,
          checked_by = case when p_checked then v_user_id end
        where s.id = v_step.id;
    end if;
    return query select 'saved', p_checked,
      (select count(*)::integer from private.chore_occurrence_steps s
        where s.occurrence_id = v_occurrence.id and s.checked_at is not null),
      (select count(*)::integer from private.chore_occurrence_steps s where s.occurrence_id = v_occurrence.id);
  end
  $$;

-- Completes an open occurrence (every current member, including someone else's: spec "Confirmed
-- completion of another member's chore"). p_contributor is the membership id of who actually did
-- the work (any current member; the interface asks explicitly when it is not the caller's own
-- chore); the caller is recorded separately as the one who completed it. Every mandatory step must
-- be ticked. p_note: an optional short plain-text note (whitespace runs read as one space, at most
-- 500 characters), kept with this occurrence only. Assignees and the rotation never change.
-- A chore that requires approval is not completed: the attempt is recorded as a submission, the
-- occurrence is Pending approval and the reviewers are notified ('submitted'). From Needs rework
-- this is the resubmission (a new attempt).
-- Outcomes: 'completed', 'submitted', 'already_completed' (someone was first; with who),
-- 'already_submitted' (a submission waits; with who), 'already_skipped', 'steps_incomplete' (with
-- how many mandatory steps are open), 'invalid_contributor', 'not_found'.
create function public.complete_chore_occurrence(
  p_occurrence_id uuid, p_contributor uuid, p_note text default null
) returns table (
  outcome text, completed_at timestamptz, completed_by_me boolean, completed_by_member uuid,
  contributor_me boolean, contributor_member uuid, open_mandatory integer, revision integer
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_occurrence private.chore_occurrences;
    v_submission private.chore_submissions;
    v_contributor uuid;
    v_open integer;
  begin
    if p_occurrence_id is null or p_contributor is null
       or (v_note is not null and not private.is_plain_text(v_note, private.chore_limit('note'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::timestamptz, false, null::uuid, false, null::uuid,
        null::integer, null::integer;
      return;
    end if;
    if v_occurrence.status = 'pending_approval' then
      select * into v_submission from private.chore_submissions s
        where s.occurrence_id = v_occurrence.id and s.status = 'pending';
      return query select 'already_submitted', v_submission.submitted_at,
        coalesce(v_submission.submitted_by = v_user_id, false),
        private.member_ref(v_occurrence.home_id, v_submission.submitted_by),
        coalesce(v_submission.contributor_id = v_user_id, false),
        private.member_ref(v_occurrence.home_id, v_submission.contributor_id), null::integer,
        v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select
        case v_occurrence.status when 'completed' then 'already_completed' else 'already_skipped' end,
        v_occurrence.completed_at, coalesce(v_occurrence.completed_by = v_user_id, false),
        private.member_ref(v_occurrence.home_id, v_occurrence.completed_by),
        coalesce(v_occurrence.contributor_id = v_user_id, false),
        private.member_ref(v_occurrence.home_id, v_occurrence.contributor_id), null::integer,
        v_occurrence.revision;
      return;
    end if;
    select m.user_id into v_contributor from public.home_memberships m
      where m.home_id = v_occurrence.home_id and m.id = p_contributor;
    if v_contributor is null then
      return query select 'invalid_contributor', null::timestamptz, false, null::uuid, false, null::uuid,
        null::integer, null::integer;
      return;
    end if;
    select count(*)::integer into v_open from private.chore_occurrence_steps s
      where s.occurrence_id = v_occurrence.id and s.mandatory and s.checked_at is null;
    if v_open > 0 then
      return query select 'steps_incomplete', null::timestamptz, false, null::uuid, false, null::uuid,
        v_open, v_occurrence.revision;
      return;
    end if;

    if (select c.requires_approval from private.chores c where c.id = v_occurrence.chore_id) then
      insert into private.chore_submissions (
        id, occurrence_id, home_id, attempt, submitted_by, contributor_id, note, steps
      ) values (
        gen_random_uuid(), v_occurrence.id, v_occurrence.home_id,
        coalesce((select max(s.attempt) from private.chore_submissions s
          where s.occurrence_id = v_occurrence.id), 0) + 1,
        v_user_id, v_contributor, v_note,
        coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', s.label, 'mandatory', s.mandatory, 'checked', s.checked_at is not null)
            order by s.position)
          from private.chore_occurrence_steps s where s.occurrence_id = v_occurrence.id), '[]'::jsonb)
      ) returning * into v_submission;
      update private.chore_occurrences o
        set status = 'pending_approval', in_rework = false, revision = o.revision + 1,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where o.id = v_occurrence.id
        returning * into v_occurrence;
      insert into private.chore_occurrence_events (
        occurrence_id, kind, actor_id, contributor_id, note, submission_id
      ) values (v_occurrence.id, 'submitted', v_user_id, v_contributor, v_note, v_submission.id);
      perform private.audit_chore('chore_occurrence.submitted', v_occurrence.home_id, 'chore_occurrence',
        v_occurrence.id, pg_catalog.jsonb_build_object('attempt', v_submission.attempt,
          'forOther', v_contributor <> v_user_id, 'note', v_note is not null));
      perform private.notify_chore_reviewers(v_occurrence.home_id, v_user_id);
      return query select 'submitted', v_submission.submitted_at, true,
        private.member_ref(v_occurrence.home_id, v_user_id), v_contributor = v_user_id,
        p_contributor, 0, v_occurrence.revision;
      return;
    end if;

    update private.chore_occurrences o
      set status = 'completed', in_rework = false, completed_at = pg_catalog.now(),
        completed_by = v_user_id, contributor_id = v_contributor, note = v_note,
        closed_title = c.title,
        closed_category = (select g.name from private.chore_categories g where g.id = c.category_id),
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      from private.chores c
      where o.id = v_occurrence.id and c.id = o.chore_id
      returning o.* into v_occurrence;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id, contributor_id, note)
      values (v_occurrence.id, 'completed', v_user_id, v_contributor, v_note);
    perform private.audit_chore('chore_occurrence.completed', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('forOther', v_contributor <> v_user_id,
        'note', v_note is not null));
    return query select 'completed', v_occurrence.completed_at, true,
      private.member_ref(v_occurrence.home_id, v_user_id), v_contributor = v_user_id,
      p_contributor, 0, v_occurrence.revision;
  end
  $$;

-- Approves or rejects the pending submission of an occurrence (chore reviewers; spec "Confirmed
-- optional approval", "self-approval", "rejected chore completion rework"). p_expected_revision is
-- the occurrence's revision the reviewer saw, so a decision on something that changed is refused.
-- Approve: the occurrence is completed with the submission's submitter, contributor, reported time
-- and note, and the reviewer recorded as approver (the reviewer may be the contributor or the
-- submitter: self-approval is permitted by the permission itself). The contributor must still be
-- a current member. Reject: p_reason is required (1-500 characters after whitespace
-- normalization); the occurrence is open again, Needs rework, with its assignees and checklist as
-- they are; the submission stays with the reason. Outcomes: 'approved', 'rejected', 'not_pending'
-- (with the current status: already decided, withdrawn, or never submitted), 'conflict' (with the
-- current revision), 'contributor_unavailable', 'not_found', 'not_permitted'.
create function public.review_chore_submission(
  p_occurrence_id uuid, p_expected_revision integer, p_decision text, p_reason text default null
) returns table (outcome text, status text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_occurrence private.chore_occurrences;
    v_submission private.chore_submissions;
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_decision is null
       or p_decision not in ('approve', 'reject')
       or (v_reason is not null and not private.is_plain_text(v_reason, private.chore_limit('reason')))
       or (p_decision = 'reject' and v_reason is null)
       or (p_decision = 'approve' and p_reason is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::text, null::integer;
      return;
    end if;
    if not private.can_review_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::text, null::integer;
      return;
    end if;
    if v_occurrence.status <> 'pending_approval' then
      return query select 'not_pending', v_occurrence.status, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', v_occurrence.status, v_occurrence.revision;
      return;
    end if;
    select * into v_submission from private.chore_submissions s
      where s.occurrence_id = v_occurrence.id and s.status = 'pending' for update;

    if p_decision = 'approve' then
      if v_submission.contributor_id is null
         or not private.is_home_member(v_occurrence.home_id, v_submission.contributor_id) then
        return query select 'contributor_unavailable', v_occurrence.status, v_occurrence.revision;
        return;
      end if;
      update private.chore_submissions s
        set status = 'approved', decided_at = pg_catalog.now(), decided_by = v_user_id
        where s.id = v_submission.id;
      update private.chore_occurrences o
        set status = 'completed', completed_at = v_submission.submitted_at,
          completed_by = v_submission.submitted_by, contributor_id = v_submission.contributor_id,
          note = v_submission.note, approved_at = pg_catalog.now(), approved_by = v_user_id,
          closed_title = c.title,
          closed_category = (select g.name from private.chore_categories g where g.id = c.category_id),
          revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        from private.chores c
        where o.id = v_occurrence.id and c.id = o.chore_id
        returning o.* into v_occurrence;
      insert into private.chore_occurrence_events (
        occurrence_id, kind, actor_id, contributor_id, submission_id
      ) values (v_occurrence.id, 'approved', v_user_id, v_submission.contributor_id, v_submission.id);
      perform private.audit_chore('chore_occurrence.approved', v_occurrence.home_id, 'chore_occurrence',
        v_occurrence.id, pg_catalog.jsonb_build_object('attempt', v_submission.attempt,
          'selfApproved', v_user_id in (v_submission.contributor_id, v_submission.submitted_by)));
      return query select 'approved', v_occurrence.status, v_occurrence.revision;
      return;
    end if;

    update private.chore_submissions s
      set status = 'rejected', decided_at = pg_catalog.now(), decided_by = v_user_id, reason = v_reason
      where s.id = v_submission.id;
    update private.chore_occurrences o
      set status = 'open', in_rework = true, revision = o.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    insert into private.chore_occurrence_events (
      occurrence_id, kind, actor_id, contributor_id, reason, submission_id
    ) values (v_occurrence.id, 'rejected', v_user_id, v_submission.contributor_id, v_reason, v_submission.id);
    perform private.audit_chore('chore_occurrence.rejected', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('attempt', v_submission.attempt));
    return query select 'rejected', v_occurrence.status, v_occurrence.revision;
  end
  $$;

-- Corrects a completed occurrence's record (chore managers; spec "Confirmed correction and reversal
-- of completed chores"): who actually did it (p_contributor, a current member's membership id; null
-- keeps it, also a former member's), when (p_completed_at; null keeps it; never in the future), and
-- the note (p_set_note with p_note, null clearing it). The values before are kept in the event, so
-- the original record is never lost; p_reason is optional. Points (S23) reconcile on the event.
-- Outcomes: 'corrected', 'unchanged', 'not_completed', 'conflict' (with the current revision),
-- 'invalid_contributor', 'not_found', 'not_permitted'.
create function public.correct_chore_completion(
  p_occurrence_id uuid, p_expected_revision integer, p_contributor uuid default null,
  p_completed_at timestamptz default null, p_set_note boolean default false, p_note text default null,
  p_reason text default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_reason text := private.chore_short_text(p_reason);
    v_occurrence private.chore_occurrences;
    v_before private.chore_occurrences;
    v_contributor uuid;
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_set_note is null
       or (v_note is not null and not private.is_plain_text(v_note, private.chore_limit('note')))
       or (v_reason is not null and not private.is_plain_text(v_reason, private.chore_limit('reason')))
       or (not p_set_note and p_note is not null)
       or p_completed_at > pg_catalog.now() + interval '5 minutes'
       or p_completed_at < timestamptz '2000-01-01 00:00:00+00' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_occurrence.status <> 'completed' then
      return query select 'not_completed', v_occurrence.revision;
      return;
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', v_occurrence.revision;
      return;
    end if;
    v_contributor := v_occurrence.contributor_id;
    if p_contributor is not null then
      select m.user_id into v_contributor from public.home_memberships m
        where m.home_id = v_occurrence.home_id and m.id = p_contributor;
      if v_contributor is null then
        return query select 'invalid_contributor', null::integer;
        return;
      end if;
    end if;
    v_before := v_occurrence;
    if v_contributor is not distinct from v_before.contributor_id
       and coalesce(p_completed_at, v_before.completed_at) = v_before.completed_at
       and (not p_set_note or v_note is not distinct from v_before.note) then
      return query select 'unchanged', v_occurrence.revision;
      return;
    end if;
    update private.chore_occurrences o
      set contributor_id = v_contributor,
        completed_at = least(coalesce(p_completed_at, o.completed_at), pg_catalog.now()),
        note = case when p_set_note then v_note else o.note end,
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    insert into private.chore_occurrence_events (
      occurrence_id, kind, actor_id, contributor_id, note, reason, completed_at,
      previous_completed_at, previous_contributor_id, previous_note
    ) values (
      v_occurrence.id, 'corrected', v_user_id, v_occurrence.contributor_id, v_occurrence.note, v_reason,
      v_occurrence.completed_at, v_before.completed_at, v_before.contributor_id, v_before.note
    );
    perform private.audit_chore('chore_occurrence.corrected', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object(
        'contributor', v_occurrence.contributor_id is distinct from v_before.contributor_id,
        'time', v_occurrence.completed_at <> v_before.completed_at,
        'note', v_occurrence.note is distinct from v_before.note));
    return query select 'corrected', v_occurrence.revision;
  end
  $$;

-- Skips an open occurrence (chore managers; spec "Confirmed skipping recurring chore occurrences"):
-- it closes as Skipped, never completed, with an optional reason; the schedule and the rotation do
-- not change. Needs rework ends with it. A submission that waits for a reviewer is not skipped
-- ('pending_approval': it is decided or withdrawn first). Outcomes: 'skipped', 'already_skipped',
-- 'already_completed', 'pending_approval', 'not_found', 'not_permitted'.
create function public.skip_chore_occurrence(p_occurrence_id uuid, p_reason text default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_occurrence private.chore_occurrences;
  begin
    if p_occurrence_id is null
       or (v_reason is not null and not private.is_plain_text(v_reason, private.chore_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select case v_occurrence.status when 'skipped' then 'already_skipped'
        when 'pending_approval' then 'pending_approval' else 'already_completed' end,
        v_occurrence.revision;
      return;
    end if;
    update private.chore_occurrences o
      set status = 'skipped', in_rework = false, skipped_at = pg_catalog.now(), skipped_by = v_user_id,
        skip_reason = v_reason, closed_title = c.title,
        closed_category = (select g.name from private.chore_categories g where g.id = c.category_id),
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      from private.chores c
      where o.id = v_occurrence.id and c.id = o.chore_id
      returning o.* into v_occurrence;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id, reason)
      values (v_occurrence.id, 'skipped', v_user_id, v_reason);
    perform private.audit_chore('chore_occurrence.skipped', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('reason', v_reason is not null));
    return query select 'skipped', v_occurrence.revision;
  end
  $$;

-- Reopens a completed or skipped occurrence (chore managers; spec "Confirmed correction and
-- reversal": undo): it is outstanding (or overdue) again with its assignees and checklist progress
-- as they were; the schedule and the rotation do not change. What was recorded stays in its events
-- (an approved completion's submission stays approved there). A pending submission is withdrawn
-- the same way (kept as 'withdrawn'). Outcomes: 'reopened', 'already_open', 'not_found',
-- 'not_permitted'.
create function public.reopen_chore_occurrence(p_occurrence_id uuid)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_was text;
  begin
    if p_occurrence_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_occurrence.status = 'open' then
      return query select 'already_open', v_occurrence.revision;
      return;
    end if;
    v_was := v_occurrence.status;
    if v_was = 'pending_approval' then
      update private.chore_submissions s
        set status = 'withdrawn', decided_at = pg_catalog.now(), decided_by = v_user_id
        where s.occurrence_id = v_occurrence.id and s.status = 'pending';
    end if;
    update private.chore_occurrences o
      set status = 'open', in_rework = false, completed_at = null, completed_by = null,
        contributor_id = null, note = null, approved_at = null, approved_by = null,
        skipped_at = null, skipped_by = null, skip_reason = null, closed_title = null,
        closed_category = null, reopened_at = pg_catalog.now(), reopened_by = v_user_id,
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id)
      values (v_occurrence.id, case when v_was = 'pending_approval' then 'withdrawn' else 'reopened' end,
        v_user_id);
    perform private.audit_chore('chore_occurrence.reopened', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('was', v_was));
    return query select 'reopened', v_occurrence.revision;
  end
  $$;

-- Changing one occurrence ("this occurrence") ------------------------------------------------------

-- Changes one open occurrence only (chore managers): due date, assignees, estimated duration and its
-- own checklist; a recurring one becomes individually changed, so later series changes leave it as
-- it is. Each part is optional (null keeps it; p_set_minutes with p_minutes null clears the
-- estimate). p_steps lists the occurrence's checklist as it should be: a step with an "id" of this
-- occurrence is kept with its progress (label and mandatory flag may change), one without is new,
-- one left out is removed. Removing a ticked step needs p_confirm_checklist (spec: "explicitly
-- resolve removed or newly mandatory steps before saving"); the preview names them.
-- p_dry_run: the same checks, changing nothing. Outcomes: 'preview' and 'saved' (with impact:
-- removed, removedChecked, added, newlyMandatory), 'needs_confirmation' (with impact), 'conflict'
-- (with the current revision), 'occurrence_closed', 'invalid_assignee', 'not_found',
-- 'not_permitted'.
create function public.update_chore_occurrence(
  p_occurrence_id uuid, p_expected_revision integer, p_dry_run boolean,
  p_due_date date default null, p_assignee_ids uuid[] default null,
  p_set_minutes boolean default false, p_minutes integer default null,
  p_steps jsonb default null, p_confirm_checklist boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_users uuid[];
    v_impact jsonb;
    v_removed integer := 0;
    v_removed_checked integer := 0;
    v_added integer := 0;
    v_newly_mandatory integer := 0;
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_dry_run is null
       or p_set_minutes is null or p_confirm_checklist is null
       or (p_due_date is not null and p_due_date not between date '2000-01-01' and date '2199-12-31')
       or (p_set_minutes and p_minutes is not null and p_minutes not between 1 and private.chore_limit('minutes'))
       or not (p_due_date is not null or p_assignee_ids is not null or p_set_minutes or p_steps is not null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_steps is not null then
      perform 1 from private.chore_steps(p_steps);
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select 'occurrence_closed', null::jsonb, v_occurrence.revision;
      return;
    end if;
    if p_assignee_ids is not null then
      v_users := private.chore_member_users(v_occurrence.home_id, p_assignee_ids);
      if v_users is null then
        return query select 'invalid_assignee', null::jsonb, null::integer;
        return;
      end if;
    end if;
    if p_steps is not null then
      -- Ids must be steps of this occurrence.
      if exists (
        select 1 from private.chore_steps(p_steps) n
        where n.step_id is not null and not exists (
          select 1 from private.chore_occurrence_steps s
          where s.id = n.step_id and s.occurrence_id = v_occurrence.id)
      ) then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      select count(*)::integer, count(*) filter (where s.checked_at is not null)::integer
        into v_removed, v_removed_checked
        from private.chore_occurrence_steps s
        where s.occurrence_id = v_occurrence.id
          and s.id not in (select n.step_id from private.chore_steps(p_steps) n where n.step_id is not null);
      select count(*) filter (where n.step_id is null)::integer,
          count(*) filter (where n.mandatory and (n.step_id is null or exists (
            select 1 from private.chore_occurrence_steps s
            where s.id = n.step_id and not s.mandatory and s.checked_at is null)))::integer
        into v_added, v_newly_mandatory
        from private.chore_steps(p_steps) n;
    end if;
    v_impact := pg_catalog.jsonb_build_object('removed', v_removed, 'removedChecked', v_removed_checked,
      'added', v_added, 'newlyMandatory', v_newly_mandatory);
    if p_dry_run then
      return query select 'preview', v_impact, v_occurrence.revision;
      return;
    end if;
    if v_removed_checked > 0 and not p_confirm_checklist then
      return query select 'needs_confirmation', v_impact, v_occurrence.revision;
      return;
    end if;
    if p_steps is not null then
      delete from private.chore_occurrence_steps s
        where s.occurrence_id = v_occurrence.id
          and s.id not in (select n.step_id from private.chore_steps(p_steps) n where n.step_id is not null);
      update private.chore_occurrence_steps s
        set position = n.step_position, label = n.label, mandatory = n.mandatory
        from private.chore_steps(p_steps) n
        where n.step_id = s.id and s.occurrence_id = v_occurrence.id;
      insert into private.chore_occurrence_steps (id, occurrence_id, position, label, mandatory)
        select gen_random_uuid(), v_occurrence.id, n.step_position, n.label, n.mandatory
        from private.chore_steps(p_steps) n where n.step_id is null;
    end if;
    if v_users is not null then
      perform private.set_occurrence_assignees(v_occurrence.id, v_occurrence.home_id, v_users);
    end if;
    update private.chore_occurrences o
      set due_date = coalesce(p_due_date, o.due_date),
        estimated_minutes = case when p_set_minutes then p_minutes else o.estimated_minutes end,
        needs_reassignment = case when v_users is not null then false else o.needs_reassignment end,
        detached = o.schedule_id is not null or o.detached,
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    perform private.audit_chore('chore_occurrence.updated', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('due', p_due_date is not null,
        'assignees', v_users is not null, 'steps', p_steps is not null));
    return query select 'saved', v_impact, v_occurrence.revision;
  end
  $$;

-- Changing following or all occurrences ------------------------------------------------------------

-- A change to a recurring chore's following or all occurrences (spec "Confirmed recurring task and
-- chore editing scope"; chore managers). One occurrence is changed with update_chore_occurrence.
--
--   p_scope 'following': this open occurrence of the head part and later ones. The head ends the
--     day before and a new head starts here with the change; open later occurrences move to it.
--     With no earlier occurrence it is the same as 'series'.
--   p_scope 'series': the head and every open occurrence of the chore.
--   Parts, each optional: the assignment (p_assignment, as create_chore), the checklist template
--   (p_steps, without ids), the estimated duration (p_set_minutes, p_minutes), the schedule
--   (p_set_schedule and the rule).
--
-- Never changed: completed and skipped occurrences; open ones changed individually (kept; this
-- occurrence itself is always changed). An open occurrence with ticked steps keeps its checklist
-- (stepsKept), so no progress is lost. Overdue open occurrences other than this one keep their
-- assignees (overdueKept: missed work stays with its member). A new or changed rotation starts at
-- the first occurrence it affects (this one for 'following', today for 'series'); a schedule change
-- that keeps the rotation keeps its order, starting with whoever's turn was next. A schedule change
-- removes upcoming open occurrences that are no longer on it unless touched (kept), and creates from
-- today on (no back-fill).
--
-- p_dry_run: the same work, rolled back, so the preview cannot disagree with the change. Outcomes:
-- 'preview' and 'saved' (with impact: scope, updated, kept, removed, completed, overdueKept,
-- stepsKept, selectedRemoved, next: the next dates with their assignees), 'conflict' (either
-- revision is stale; revision: the schedule's current one), 'not_found', 'not_recurring',
-- 'not_permitted', 'scope_unavailable', 'invalid_assignee', 'ended'. occurrence_id: this occurrence,
-- or when the schedule change removed it the chore's next open one.
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
    v_selected private.chore_occurrences;
    v_head private.chore_schedules;
    v_target private.chore_schedules;
    v_scope text := p_scope;
    v_today date;
    v_mode text;
    v_users uuid[];
    v_boundary date;
    v_first date;
    v_turn integer;
    v_places integer;
    v_redeal boolean;
    v_updated integer := 0;
    v_kept integer := 0;
    v_removed integer := 0;
    v_completed integer := 0;
    v_overdue_kept integer := 0;
    v_steps_kept integer := 0;
    v_selected_removed boolean := false;
    v_changed boolean;
    v_assignees uuid[];
    v_flagged boolean;
    v_impact jsonb;
    v_next uuid;
  begin
    if p_occurrence_id is null or p_scope is null or p_scope not in ('following', 'series')
       or p_expected_revision is null or p_expected_schedule_revision is null or p_dry_run is null
       or p_set_minutes is null or p_set_schedule is null
       or (p_set_minutes and p_minutes is not null and p_minutes not between 1 and private.chore_limit('minutes'))
       or (p_set_schedule and not private.valid_series_rule(
         p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count))
       or not (p_assignment is not null or p_steps is not null or p_set_minutes or p_set_schedule) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_steps is not null then
      perform 1 from private.chore_steps(p_steps) s where s.step_id is not null;
      if found then
        raise exception 'invalid request' using errcode = '22023';
      end if;
    end if;
    v_selected := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_selected.id is null then
      return query select 'not_found', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    select * into v_head from private.chore_schedules s
      where s.chore_id = v_selected.chore_id and s.superseded_at is null for update;
    if v_head.id is null then
      return query select 'not_recurring', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if not private.can_manage_chores(v_selected.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if v_selected.revision <> p_expected_revision or v_head.revision <> p_expected_schedule_revision then
      return query select 'conflict', null::jsonb, v_head.revision, null::uuid;
      return;
    end if;
    if v_selected.status <> 'open'
       or (p_scope = 'following' and v_selected.schedule_id is distinct from v_head.id) then
      return query select 'scope_unavailable', null::jsonb, null::integer, null::uuid;
      return;
    end if;
    if p_assignment is not null then
      select a.mode, a.users into v_mode, v_users
        from private.chore_assignment(v_head.home_id, p_assignment, true) a;
      if v_users is null then
        return query select 'invalid_assignee', null::jsonb, null::integer, null::uuid;
        return;
      end if;
    end if;
    v_today := private.task_today(v_head.home_id, null);
    v_boundary := v_selected.scheduled_date;
    if v_scope = 'following' and not exists (
      select 1 from private.chore_occurrences o
      where o.chore_id = v_head.chore_id and o.deleted_at is null and o.scheduled_date < v_boundary
    ) then
      v_scope := 'series';
    end if;
    -- Where a new or carried-over rotation starts counting.
    v_first := case when v_scope = 'following' then v_boundary else v_today end;

    begin
      if v_scope = 'following' then
        -- The old head ends the day before (never before its own start: S19 review H2), first, so
        -- the chore never has two heads; the new head takes the old head's values as loaded.
        update private.chore_schedules s
          set superseded_at = pg_catalog.now(), next_date = null,
            until_date = greatest(least(coalesce(s.until_date, v_boundary - 1), v_boundary - 1),
              s.starts_on - 1),
            updated_by = v_user_id, updated_at = pg_catalog.now()
          where s.id = v_head.id;
        insert into private.chore_schedules (
          id, chore_id, home_id, previous_id, frequency, interval_count, weekdays, starts_on,
          active_from, ends_on, max_count, until_date, next_date, last_date, paused_from,
          paused_until, paused_by, assignment, rotation_from, estimated_minutes, needs_reassignment,
          revision, created_by, created_at, updated_by
        )
        select gen_random_uuid(), h.chore_id, h.home_id, h.id, h.frequency, h.interval_count,
          h.weekdays, h.starts_on, greatest(v_boundary, coalesce(h.active_from, h.starts_on)),
          h.ends_on, h.max_count, v_head.until_date, v_head.next_date, h.last_date, h.paused_from,
          h.paused_until, h.paused_by, h.assignment, h.rotation_from, h.estimated_minutes,
          h.needs_reassignment, h.revision + 1, h.created_by, h.created_at, v_user_id
        from private.chore_schedules h where h.id = v_head.id
        returning * into v_target;
        insert into private.chore_schedule_members (schedule_id, home_id, position, user_id)
          select v_target.id, m.home_id, m.position, m.user_id
          from private.chore_schedule_members m where m.schedule_id = v_head.id;
        insert into private.chore_schedule_steps (schedule_id, position, label, mandatory)
          select v_target.id, s.position, s.label, s.mandatory
          from private.chore_schedule_steps s where s.schedule_id = v_head.id;
        update private.chore_occurrences o set schedule_id = v_target.id
          where o.schedule_id = v_head.id and o.scheduled_date >= v_boundary
            and o.deleted_at is null and o.status = 'open';
      else
        v_target := v_head;
        v_target.revision := v_head.revision + 1;
      end if;

      -- The rotation: a schedule change that keeps the rotation starts the same order at whoever's
      -- turn was next under the old rule; a new assignment starts as given.
      v_redeal := p_assignment is not null;
      if p_assignment is null and p_set_schedule and v_target.assignment = 'rotating' then
        select count(*)::integer into v_places from private.chore_schedule_members m
          where m.schedule_id = v_target.id;
        v_turn := private.chore_turn(v_target.frequency, v_target.interval_count, v_target.weekdays,
          v_target.starts_on, v_target.rotation_from, v_first) % greatest(v_places, 1);
        -- The same order (empty places included), turned so that place v_turn comes first.
        select array_agg(m.user_id order by (m.position - v_turn + v_places) % v_places) into v_users
          from private.chore_schedule_members m where m.schedule_id = v_target.id;
        v_target.rotation_from := v_first;
        v_redeal := true;
      end if;
      if p_assignment is not null then
        v_target.assignment := v_mode;
        v_target.rotation_from := case when v_mode = 'rotating' then v_first end;
        v_target.needs_reassignment := false;
      end if;
      if p_set_minutes then
        v_target.estimated_minutes := p_minutes;
      end if;
      if p_set_schedule then
        v_target.frequency := p_frequency;
        v_target.interval_count := p_interval;
        v_target.weekdays := p_weekdays;
        v_target.starts_on := p_starts_on;
        v_target.active_from := case when v_scope = 'following' then v_boundary end;
        v_target.ends_on := p_ends_on;
        v_target.max_count := p_max_count;
        v_target.until_date := private.series_until(
          p_frequency, p_interval, p_weekdays, p_starts_on, p_ends_on, p_max_count);
      end if;
      update private.chore_schedules s
        set frequency = v_target.frequency, interval_count = v_target.interval_count,
          weekdays = v_target.weekdays, starts_on = v_target.starts_on,
          active_from = v_target.active_from, ends_on = v_target.ends_on,
          max_count = v_target.max_count, until_date = v_target.until_date,
          next_date = case when p_set_schedule then null else s.next_date end,
          assignment = v_target.assignment, rotation_from = v_target.rotation_from,
          estimated_minutes = v_target.estimated_minutes,
          needs_reassignment = v_target.needs_reassignment, revision = v_target.revision,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where s.id = v_target.id
        returning * into v_target;
      perform private.set_part_template(v_target.id, v_target.home_id, v_users, p_steps);

      -- The open occurrences in scope, locked in id order.
      for v_occurrence in
        select * from private.chore_occurrences o
        where o.chore_id = v_head.chore_id and o.deleted_at is null and o.status = 'open'
          and (v_scope = 'series' or o.schedule_id = v_target.id)
        order by o.id
        for update
      loop
        if v_occurrence.id <> v_selected.id and v_occurrence.detached then
          v_kept := v_kept + 1;
          continue;
        end if;
        if p_set_schedule and v_occurrence.scheduled_date > v_today
           and not private.chore_part_has_date(v_target, v_occurrence.scheduled_date) then
          if private.chore_occurrence_touched(v_occurrence) then
            update private.chore_occurrences o set detached = true where o.id = v_occurrence.id;
            v_kept := v_kept + 1;
          else
            delete from private.chore_occurrences o where o.id = v_occurrence.id;
            v_removed := v_removed + 1;
            v_selected_removed := v_selected_removed or v_occurrence.id = v_selected.id;
          end if;
          continue;
        end if;
        v_changed := p_set_minutes;
        if p_steps is not null then
          if private.chore_has_progress(v_occurrence.id) then
            v_steps_kept := v_steps_kept + 1;
          else
            perform private.copy_part_steps(v_occurrence.id, v_target.id);
            v_changed := true;
          end if;
        end if;
        if v_redeal then
          if v_occurrence.due_date < v_today and v_occurrence.id <> v_selected.id then
            v_overdue_kept := v_overdue_kept + 1;
          else
            select a.user_ids, a.flagged into v_assignees, v_flagged
              from private.chore_part_assignees(v_target, v_occurrence.scheduled_date) a;
            perform private.set_occurrence_assignees(v_occurrence.id, v_occurrence.home_id, v_assignees);
            update private.chore_occurrences o set needs_reassignment = v_flagged where o.id = v_occurrence.id;
            v_changed := true;
          end if;
        end if;
        if v_changed then
          update private.chore_occurrences o
            set estimated_minutes = case when p_set_minutes then p_minutes else o.estimated_minutes end,
              revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
            where o.id = v_occurrence.id;
          v_updated := v_updated + 1;
        end if;
      end loop;
      select count(*)::integer into v_completed from private.chore_occurrences o
        where o.chore_id = v_head.chore_id and o.deleted_at is null and o.status <> 'open'
          and (v_scope = 'series' or o.scheduled_date >= v_boundary);

      if p_set_schedule then
        -- Creation restarts from today (no back-fill), after whatever the chore still has.
        v_target.next_date := private.chore_part_next(v_target, v_today);
        if v_target.next_date is null then
          raise exception 'schedule ended' using errcode = 'MD002';
        end if;
        select max(o.scheduled_date) into v_target.last_date from private.chore_occurrences o
          where o.chore_id = v_head.chore_id;
        update private.chore_schedules s set next_date = v_target.next_date, last_date = v_target.last_date
          where s.id = v_target.id
          returning * into v_target;
      end if;
      perform private.advance_chore_part(v_target, v_today);
      select * into v_target from private.chore_schedules s where s.id = v_target.id;

      v_impact := pg_catalog.jsonb_build_object(
        'scope', v_scope,
        'updated', v_updated,
        'kept', v_kept,
        'removed', v_removed,
        'completed', v_completed,
        'overdueKept', v_overdue_kept,
        'stepsKept', v_steps_kept,
        'selectedRemoved', v_selected_removed,
        'next', private.chore_part_preview(v_target, v_today, private.chore_limit('preview_dates')));
      if v_selected_removed then
        select o.id into v_next from private.chore_occurrences o
          where o.chore_id = v_head.chore_id and o.deleted_at is null and o.status = 'open'
            and o.scheduled_date >= v_today
          order by o.scheduled_date limit 1;
      else
        v_next := v_selected.id;
      end if;
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        -- Everything above is rolled back; the impact stays.
        return query select 'preview', v_impact, v_head.revision, v_selected.id;
        return;
      when sqlstate 'MD002' then
        return query select 'ended', null::jsonb, null::integer, null::uuid;
        return;
    end;
    perform private.audit_chore('chore.series_updated', v_head.home_id, 'chore', v_head.chore_id,
      pg_catalog.jsonb_build_object('scope', v_scope, 'updated', v_updated, 'kept', v_kept,
        'removed', v_removed, 'schedule', p_set_schedule, 'assignment', p_assignment is not null));
    return query select 'saved', v_impact, v_target.revision, v_next;
  end
  $$;

-- Pausing a recurring chore (spec "Confirmed recurring chore pauses and Home vacation periods":
-- the individual pause) --------------------------------------------------------------------------------

-- Pauses a recurring chore from today until p_until (inclusive) or indefinitely (p_until null), or
-- resumes it (chore managers). No occurrence is created for a date in the pause, and none is created
-- later for it (no back-fill); untouched open occurrences from today inside the pause are removed,
-- touched ones (individually changed or with ticked steps) are kept. Resuming, or the end date
-- passing, continues from today. Overdue occurrences are never changed. p_dry_run: the same work,
-- rolled back. Outcomes: 'preview' and 'saved' (with impact: removed, kept, next), 'conflict' (with
-- the current revision), 'not_found', 'not_recurring', 'not_permitted'.
create function public.set_chore_paused(
  p_chore_id uuid, p_expected_schedule_revision integer, p_paused boolean, p_until date default null,
  p_dry_run boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_chore private.chores;
    v_head private.chore_schedules;
    v_today date;
    v_occurrence private.chore_occurrences;
    v_removed integer := 0;
    v_kept integer := 0;
    v_impact jsonb;
  begin
    if p_chore_id is null or p_expected_schedule_revision is null or p_paused is null or p_dry_run is null
       or (not p_paused and p_until is not null)
       or (p_until is not null and p_until > date '2199-12-31') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_chore := private.lock_chore(p_chore_id, v_user_id);
    if v_chore.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    select * into v_head from private.chore_schedules s
      where s.chore_id = v_chore.id and s.superseded_at is null for update;
    if v_head.id is null or v_chore.ended_at is not null then
      return query select 'not_recurring', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_chore.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_head.revision <> p_expected_schedule_revision then
      return query select 'conflict', null::jsonb, v_head.revision;
      return;
    end if;
    v_today := private.task_today(v_chore.home_id, null);
    if p_until is not null and p_until < v_today then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    begin
      if p_paused then
        update private.chore_schedules s
          set paused_from = case when s.paused_from is not null and s.paused_from <= v_today
              and (s.paused_until is null or s.paused_until >= v_today) then s.paused_from else v_today end,
            paused_until = p_until, paused_by = v_user_id,
            revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
          where s.id = v_head.id
          returning * into v_head;
        for v_occurrence in
          select * from private.chore_occurrences o
          where o.chore_id = v_chore.id and o.deleted_at is null and o.status = 'open'
            and o.scheduled_date >= v_today
          order by o.id for update
        loop
          continue when not private.chore_paused_on(v_head, v_occurrence.scheduled_date);
          if private.chore_occurrence_touched(v_occurrence) then
            v_kept := v_kept + 1;
          else
            delete from private.chore_occurrences o where o.id = v_occurrence.id;
            v_removed := v_removed + 1;
          end if;
        end loop;
      else
        update private.chore_schedules s
          set paused_from = null, paused_until = null, paused_by = null,
            revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
          where s.id = v_head.id
          returning * into v_head;
      end if;
      -- Creation continues from today (or after the pause), never for a date already passed.
      update private.chore_schedules s
        set next_date = private.chore_part_next(v_head, greatest(v_today,
            coalesce(case when p_paused and p_until is not null then p_until + 1 end, v_today))),
          last_date = (select max(o.scheduled_date) from private.chore_occurrences o where o.chore_id = v_chore.id)
        where s.id = v_head.id
        returning * into v_head;
      perform private.advance_chore_part(v_head, v_today);
      select * into v_head from private.chore_schedules s where s.id = v_head.id;
      v_impact := pg_catalog.jsonb_build_object('removed', v_removed, 'kept', v_kept,
        'next', private.chore_part_preview(v_head, v_today, private.chore_limit('preview_dates')));
      if p_dry_run then
        raise exception 'dry run' using errcode = 'MD001';
      end if;
    exception
      when sqlstate 'MD001' then
        return query select 'preview', v_impact, p_expected_schedule_revision;
        return;
    end;
    perform private.audit_chore(case when p_paused then 'chore.paused' else 'chore.resumed' end,
      v_chore.home_id, 'chore', v_chore.id,
      pg_catalog.jsonb_build_object('until', p_until is not null, 'removed', v_removed));
    return query select 'saved', v_impact, v_head.revision;
  end
  $$;

-- Deleting -------------------------------------------------------------------------------------------

-- Deletes occurrences of a chore (chore managers; spec "Confirmed recurring task and chore deletion
-- scope"). Completed and skipped occurrences always stay (history).
--   'occurrence': a one-off chore goes to the trash whole (item type chore); one open occurrence of a
--     recurring chore goes to the trash alone (chore_occurrence).
--   'following': from an open occurrence of the head part; the schedule ends the day before, and
--     this and later open occurrences go to the trash together (chore_removal).
--   'series': the chore ends and every open occurrence goes to the trash together; its history stays
--     and the chore is listed as ended. A recurring chore with no history yet goes to the trash whole.
-- With no earlier occurrence, 'following' is 'series'. p_dry_run returns the impact only.
-- Outcomes: 'preview', 'deleted' (with the entry), 'conflict' (with the current revision),
-- 'not_found', 'not_permitted', 'scope_unavailable'. impact: scope, removed, kept (history).
create function public.delete_chore_occurrences(
  p_occurrence_id uuid, p_scope text, p_expected_revision integer, p_dry_run boolean
) returns table (outcome text, impact jsonb, entry_id uuid, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_selected private.chore_occurrences;
    v_chore private.chores;
    v_head private.chore_schedules;
    v_scope text := p_scope;
    v_ids uuid[];
    v_history integer;
    v_impact jsonb;
    v_entry uuid;
    v_removal uuid;
  begin
    if p_occurrence_id is null or p_scope is null or p_scope not in ('occurrence', 'following', 'series')
       or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_selected := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_selected.id is null then
      return query select 'not_found', null::jsonb, null::uuid, null::integer;
      return;
    end if;
    select * into v_chore from private.chores c where c.id = v_selected.chore_id;
    if not private.can_manage_chores(v_chore.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::uuid, null::integer;
      return;
    end if;
    if v_selected.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, null::uuid, v_selected.revision;
      return;
    end if;
    select * into v_head from private.chore_schedules s
      where s.chore_id = v_chore.id and s.superseded_at is null for update;

    if v_chore.kind = 'one_off' then
      if v_scope <> 'occurrence' then
        return query select 'scope_unavailable', null::jsonb, null::uuid, null::integer;
        return;
      end if;
      v_impact := pg_catalog.jsonb_build_object('scope', 'chore', 'removed', 1, 'kept', 0);
      if p_dry_run then
        return query select 'preview', v_impact, null::uuid, v_selected.revision;
        return;
      end if;
      update private.chores c set deleted_at = pg_catalog.now(), updated_by = v_user_id where c.id = v_chore.id;
      v_entry := private.trash_move(v_user_id, 'chores', 'chore', v_chore.id, null, v_chore.home_id,
        v_chore.title);
      perform private.audit_chore('chore.deleted', v_chore.home_id, 'chore', v_chore.id);
      return query select 'deleted', v_impact, v_entry, null::integer;
      return;
    end if;

    if v_selected.status <> 'open' or v_chore.ended_at is not null
       or (v_scope = 'following' and v_selected.schedule_id is distinct from v_head.id) then
      return query select 'scope_unavailable', null::jsonb, null::uuid, null::integer;
      return;
    end if;
    if v_scope = 'following' and not exists (
      select 1 from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.deleted_at is null and o.scheduled_date < v_selected.scheduled_date
    ) then
      v_scope := 'series';
    end if;

    if v_scope = 'occurrence' then
      v_impact := pg_catalog.jsonb_build_object('scope', 'occurrence', 'removed', 1, 'kept', 0);
      if p_dry_run then
        return query select 'preview', v_impact, null::uuid, v_selected.revision;
        return;
      end if;
      update private.chore_occurrences o set deleted_at = pg_catalog.now(), updated_by = v_user_id
        where o.id = v_selected.id;
      v_entry := private.trash_move(v_user_id, 'chores', 'chore_occurrence', v_selected.id, null,
        v_chore.home_id, v_chore.title);
      perform private.audit_chore('chore_occurrence.deleted', v_chore.home_id, 'chore_occurrence', v_selected.id);
      return query select 'deleted', v_impact, v_entry, null::integer;
      return;
    end if;

    select coalesce(array_agg(o.id order by o.scheduled_date), '{}') into v_ids
      from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.deleted_at is null and o.status = 'open'
        and (v_scope = 'series' or o.scheduled_date >= v_selected.scheduled_date);
    select count(*)::integer into v_history from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.deleted_at is null and o.status <> 'open';
    v_impact := pg_catalog.jsonb_build_object('scope', v_scope, 'removed', cardinality(v_ids),
      'kept', v_history);
    if p_dry_run then
      return query select 'preview', v_impact, null::uuid, v_selected.revision;
      return;
    end if;

    if v_scope = 'series' and v_history = 0 then
      -- Nothing to keep: the whole chore goes to the trash (and comes back whole).
      update private.chores c set deleted_at = pg_catalog.now(), updated_by = v_user_id where c.id = v_chore.id;
      v_entry := private.trash_move(v_user_id, 'chores', 'chore', v_chore.id, null, v_chore.home_id,
        v_chore.title);
      perform private.audit_chore('chore.deleted', v_chore.home_id, 'chore', v_chore.id);
      return query select 'deleted', v_impact || '{"scope": "chore"}'::jsonb, v_entry, null::integer;
      return;
    end if;

    update private.chore_occurrences o set deleted_at = pg_catalog.now(), updated_by = v_user_id
      where o.id = any (v_ids);
    insert into private.chore_removals (
      chore_id, home_id, head_id, mode, from_date, occurrence_ids, head_revision, previous_until_date
    ) values (
      v_chore.id, v_chore.home_id, v_head.id, v_scope,
      case when v_scope = 'following' then v_selected.scheduled_date end, v_ids, v_head.revision + 1,
      v_head.until_date
    ) returning id into v_removal;
    update private.chore_schedules s
      set until_date = case when v_scope = 'following'
          then greatest(least(coalesce(s.until_date, v_selected.scheduled_date - 1),
            v_selected.scheduled_date - 1), s.starts_on - 1)
          else s.until_date end,
        next_date = null,
        revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_head.id;
    if v_scope = 'series' then
      update private.chores c
        set ended_at = pg_catalog.now(), ended_by = v_user_id, revision = c.revision + 1,
          updated_by = v_user_id, updated_at = pg_catalog.now()
        where c.id = v_chore.id;
    end if;
    v_entry := private.trash_move(v_user_id, 'chores', 'chore_removal', v_removal, null, v_chore.home_id,
      v_chore.title);
    perform private.audit_chore('chore.occurrences_deleted', v_chore.home_id, 'chore', v_chore.id,
      pg_catalog.jsonb_build_object('scope', v_scope, 'removed', cardinality(v_ids)));
    return query select 'deleted', v_impact, v_entry, null::integer;
  end
  $$;

-- Reading ------------------------------------------------------------------------------------------

-- A person as a chore answer names them: {"me": ..., "member": membership id or null (departed)}.
create function private.chore_person(p_home_id uuid, p_user_id uuid, p_viewer uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select case when p_user_id is null then null else pg_catalog.jsonb_build_object(
    'me', p_user_id = p_viewer, 'member', private.member_ref(p_home_id, p_user_id)) end;
  $$;

-- One occurrence with its chore, checklist, record, attempts and (recurring) schedule, or null when
-- it is missing, deleted, or not the caller's to see (every current member of its Home sees it,
-- including pending and rejected attempts with their notes and reasons: the same members see the
-- completion notes; default picked in the brief).
create function public.get_chore_occurrence(p_occurrence_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_head private.chore_schedules;
    v_category private.chore_categories;
    v_today date;
    v_manage boolean;
    v_review boolean;
    v_schedule jsonb;
  begin
    if p_occurrence_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_occurrence from private.chore_occurrences o
      where o.id = p_occurrence_id and o.deleted_at is null;
    if not found or not private.is_home_member(v_occurrence.home_id, v_user_id) then
      return null;
    end if;
    select * into v_chore from private.chores c where c.id = v_occurrence.chore_id and c.deleted_at is null;
    if not found then
      return null;
    end if;
    select * into v_category from private.chore_categories g where g.id = v_chore.category_id;
    v_today := private.task_today(v_chore.home_id, null);
    v_manage := private.can_manage_chores(v_chore.home_id, v_user_id);
    v_review := private.can_review_chores(v_chore.home_id, v_user_id);
    if v_chore.kind = 'recurring' then
      v_head := private.chore_head(v_chore.id);
      v_schedule := pg_catalog.jsonb_build_object(
        'revision', v_head.revision,
        'frequency', v_head.frequency,
        'interval', v_head.interval_count,
        'weekdays', v_head.weekdays,
        'startsOn', v_head.starts_on,
        'endsOn', v_head.ends_on,
        'count', v_head.max_count,
        'assignment', v_head.assignment,
        'rotationFrom', v_head.rotation_from,
        'members', coalesce((select pg_catalog.jsonb_agg(private.member_ref(v_head.home_id, m.user_id)
            order by m.position)
          from private.chore_schedule_members m where m.schedule_id = v_head.id), '[]'::jsonb),
        'minutes', v_head.estimated_minutes,
        'steps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', s.label, 'mandatory', s.mandatory) order by s.position)
          from private.chore_schedule_steps s where s.schedule_id = v_head.id), '[]'::jsonb),
        'paused', case when v_head.paused_from is not null
            and (v_head.paused_until is null or v_head.paused_until >= v_today)
          then pg_catalog.jsonb_build_object('from', v_head.paused_from, 'until', v_head.paused_until) end,
        'ended', v_chore.ended_at is not null,
        'finished', v_head.next_date is null and v_chore.ended_at is null,
        'inHead', v_occurrence.schedule_id is not distinct from v_head.id,
        'needsReassignment', v_head.needs_reassignment,
        'next', case when v_chore.ended_at is null
          then private.chore_part_preview(v_head, v_today, private.chore_limit('preview_dates'))
          else '[]'::jsonb end);
    end if;
    return pg_catalog.jsonb_build_object(
      'id', v_occurrence.id,
      'homeId', v_occurrence.home_id,
      'chore', pg_catalog.jsonb_build_object(
        'id', v_chore.id,
        'kind', v_chore.kind,
        'title', v_chore.title,
        'instructions', v_chore.instructions,
        'category', case when v_category.id is not null then pg_catalog.jsonb_build_object(
          'id', v_category.id, 'name', v_category.name, 'color', v_category.color,
          'archived', v_category.archived_at is not null) end,
        'requiresApproval', v_chore.requires_approval,
        'revision', v_chore.revision),
      'scheduledDate', v_occurrence.scheduled_date,
      'dueDate', v_occurrence.due_date,
      'today', v_today,
      'status', v_occurrence.status,
      'overdue', v_occurrence.status = 'open' and v_occurrence.due_date < v_today,
      'inRework', v_occurrence.in_rework,
      'minutes', v_occurrence.estimated_minutes,
      'detached', v_occurrence.detached,
      'needsReassignment', v_occurrence.needs_reassignment,
      'revision', v_occurrence.revision,
      'assignees', coalesce((select pg_catalog.jsonb_agg(private.member_ref(a.home_id, a.user_id)
          order by a.user_id)
        from private.chore_occurrence_assignees a where a.occurrence_id = v_occurrence.id), '[]'::jsonb),
      'assignedToMe', exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_user_id),
      'steps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', s.id, 'label', s.label, 'mandatory', s.mandatory, 'checked', s.checked_at is not null)
          order by s.position)
        from private.chore_occurrence_steps s where s.occurrence_id = v_occurrence.id), '[]'::jsonb),
      'completion', case when v_occurrence.status = 'completed' then pg_catalog.jsonb_build_object(
        'at', v_occurrence.completed_at,
        'by', private.chore_person(v_occurrence.home_id, v_occurrence.completed_by, v_user_id),
        'contributor', private.chore_person(v_occurrence.home_id, v_occurrence.contributor_id, v_user_id),
        'note', v_occurrence.note,
        'approvedAt', v_occurrence.approved_at,
        'approvedBy', private.chore_person(v_occurrence.home_id, v_occurrence.approved_by, v_user_id)) end,
      'skip', case when v_occurrence.status = 'skipped' then pg_catalog.jsonb_build_object(
        'at', v_occurrence.skipped_at,
        'by', private.chore_person(v_occurrence.home_id, v_occurrence.skipped_by, v_user_id),
        'reason', v_occurrence.skip_reason) end,
      'closedTitle', v_occurrence.closed_title,
      'closedCategory', v_occurrence.closed_category,
      'submissions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', b.id, 'attempt', b.attempt, 'status', b.status, 'at', b.submitted_at,
          'by', private.chore_person(v_occurrence.home_id, b.submitted_by, v_user_id),
          'contributor', private.chore_person(v_occurrence.home_id, b.contributor_id, v_user_id),
          'note', b.note, 'steps', b.steps, 'decidedAt', b.decided_at,
          'decidedBy', private.chore_person(v_occurrence.home_id, b.decided_by, v_user_id),
          'reason', b.reason,
          'selfApproved', b.status = 'approved' and b.decided_by in (b.contributor_id, b.submitted_by))
          order by b.attempt desc)
        from private.chore_submissions b where b.occurrence_id = v_occurrence.id), '[]'::jsonb),
      'events', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'kind', e.kind, 'at', e.created_at,
          'by', private.chore_person(v_occurrence.home_id, e.actor_id, v_user_id),
          'contributor', private.chore_person(v_occurrence.home_id, e.contributor_id, v_user_id),
          'note', e.note, 'reason', e.reason,
          'completedAt', e.completed_at, 'previousCompletedAt', e.previous_completed_at,
          'previousContributor', private.chore_person(v_occurrence.home_id, e.previous_contributor_id,
            v_user_id),
          'previousNote', e.previous_note) order by e.id)
        from private.chore_occurrence_events e where e.occurrence_id = v_occurrence.id), '[]'::jsonb),
      'schedule', v_schedule,
      'can', pg_catalog.jsonb_build_object(
        'complete', v_occurrence.status = 'open',
        'review', v_review and v_occurrence.status = 'pending_approval',
        'correct', v_manage and v_occurrence.status = 'completed',
        'manage', v_manage));
  end
  $$;

-- The Home's current open occurrences: overdue, due today and due in the next days (horizon), and
-- any flagged for reassignment, plus every one waiting for approval, earliest due first. Filters: p_assignee 'any', 'me', 'member'
-- (p_member: a membership id), 'unassigned'; p_category 'any', 'none' (uncategorized) or 'one'
-- (p_category_id). 42501 for a Home the caller is not in.
create function public.list_chore_occurrences(
  p_home_id uuid, p_assignee text default 'any', p_member uuid default null,
  p_category text default 'any', p_category_id uuid default null,
  p_limit integer default 100, p_offset integer default 0
) returns table (
  id uuid, chore_id uuid, title text, kind text, category_id uuid, category_name text,
  category_color text, scheduled_date date, due_date date, overdue boolean, due_today boolean,
  needs_reassignment boolean, assignee_member_ids uuid[], assigned_to_me boolean, steps_done integer,
  steps_total integer, mandatory_open integer, minutes integer, status text, in_rework boolean,
  requires_approval boolean, revision integer, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_member_user uuid;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_assignee is null or p_assignee not in ('any', 'me', 'member', 'unassigned')
       or (p_assignee = 'member') <> (p_member is not null)
       or p_category is null or p_category not in ('any', 'none', 'one')
       or (p_category = 'one') <> (p_category_id is not null)
       or p_limit is null or p_limit not between 1 and private.chore_limit('page')
       or p_offset is null or p_offset not between 0 and private.chore_limit('max_offset') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, null);
    if p_assignee = 'member' then
      select m.user_id into v_member_user from public.home_memberships m
        where m.home_id = p_home_id and m.id = p_member;
    end if;
    return query
      with matching as (
        select o.*, c.title as chore_title, c.kind as chore_kind, c.category_id as chore_category,
          c.requires_approval as chore_approval
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.status in ('open', 'pending_approval') and o.deleted_at is null
          and c.deleted_at is null
          and (o.due_date <= v_today + private.chore_limit('horizon') or o.needs_reassignment
            or o.status = 'pending_approval')
          and case p_assignee
            when 'me' then exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id and a.user_id = v_user_id)
            when 'member' then v_member_user is not null and exists (
              select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id and a.user_id = v_member_user)
            when 'unassigned' then not exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id)
            else true end
          and case p_category
            when 'none' then c.category_id is null
            when 'one' then c.category_id = p_category_id
            else true end
      )
      select m.id, m.chore_id, m.chore_title, m.chore_kind, g.id, g.name, g.color, m.scheduled_date,
        m.due_date, m.status = 'open' and m.due_date < v_today, m.due_date = v_today,
        m.needs_reassignment,
        coalesce((select array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
          from private.chore_occurrence_assignees a where a.occurrence_id = m.id), '{}'::uuid[]),
        exists (select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = m.id and a.user_id = v_user_id),
        (select count(*)::integer from private.chore_occurrence_steps s
          where s.occurrence_id = m.id and s.checked_at is not null),
        (select count(*)::integer from private.chore_occurrence_steps s where s.occurrence_id = m.id),
        (select count(*)::integer from private.chore_occurrence_steps s
          where s.occurrence_id = m.id and s.mandatory and s.checked_at is null),
        m.estimated_minutes, m.status, m.in_rework, m.chore_approval, m.revision,
        (count(*) over ())::integer
      from matching m
      left join private.chore_categories g on g.id = m.chore_category
      order by m.due_date, m.chore_title, m.id
      limit p_limit offset p_offset;
  end
  $$;

-- One page of a chore's history (spec "Confirmed searchable Home-wide chore completion history":
-- the individual history), newest scheduled date first: completed, skipped, pending approval, needs
-- rework and missed (open and overdue) occurrences and today's; future open ones never. Filter
-- 'all', 'completed', 'skipped', 'missed', 'pending_approval', 'rework'. Every current member of the chore's Home reads it, including an ended chore's. 22023
-- for a chore that is missing, deleted or not theirs to see (the caller answers not-found).
create function public.list_chore_history(
  p_chore_id uuid, p_filter text default 'all', p_offset integer default 0, p_limit integer default 50
) returns table (
  id uuid, scheduled_date date, due_date date, status text, title text, category text,
  completed_at timestamptz, completed_by_me boolean, completed_by_member uuid,
  contributor_me boolean, contributor_member uuid, note text,
  skipped_at timestamptz, skipped_by_me boolean, skipped_by_member uuid, skip_reason text,
  approved_at timestamptz, approved_by_me boolean, approved_by_member uuid, attempts integer,
  total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_chore private.chores;
    v_today date;
  begin
    if p_chore_id is null or p_filter is null
       or p_filter not in ('all', 'completed', 'skipped', 'missed', 'pending_approval', 'rework')
       or p_offset is null or p_offset not between 0 and private.chore_limit('max_offset')
       or p_limit is null or p_limit not between 1 and private.chore_limit('history_page') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_chore from private.chores c where c.id = p_chore_id and c.deleted_at is null;
    if not found or not private.is_home_member(v_chore.home_id, v_user_id) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(v_chore.home_id, null);
    return query
      with rows as (
        select o.*,
          case
            when o.status <> 'open' then o.status
            when o.in_rework then 'rework'
            when o.due_date < v_today then 'missed'
            when o.due_date = v_today then 'due_today'
            else 'open'
          end as shown
        from private.chore_occurrences o
        where o.chore_id = v_chore.id and o.deleted_at is null
          and (o.status <> 'open' or o.in_rework or o.scheduled_date <= v_today)
      )
      select r.id, r.scheduled_date, r.due_date, r.shown,
        coalesce(r.closed_title, v_chore.title),
        case when r.status = 'open' then (select g.name from private.chore_categories g
          where g.id = v_chore.category_id) else r.closed_category end,
        r.completed_at, coalesce(r.completed_by = v_user_id, false),
        private.member_ref(r.home_id, r.completed_by),
        coalesce(r.contributor_id = v_user_id, false), private.member_ref(r.home_id, r.contributor_id),
        r.note, r.skipped_at, coalesce(r.skipped_by = v_user_id, false),
        private.member_ref(r.home_id, r.skipped_by), r.skip_reason,
        r.approved_at, coalesce(r.approved_by = v_user_id, false),
        private.member_ref(r.home_id, r.approved_by),
        (select count(*)::integer from private.chore_submissions b where b.occurrence_id = r.id),
        (count(*) over ())::integer
      from rows r
      where p_filter = 'all' or r.shown = p_filter
      order by r.scheduled_date desc, r.id
      limit p_limit offset p_offset;
  end
  $$;

-- The Home's review queue (chore reviewers; spec "Confirmed optional approval": "show pending items
-- and review actions to authorized reviewers"): every occurrence waiting for approval, oldest
-- submission first, with its pending attempt. Someone who is not a reviewer gets no rows (their
-- page says so; context.can_review). 42501 for a Home the caller is not in.
create function public.list_chore_approvals(p_home_id uuid, p_limit integer default 100)
returns table (
  occurrence_id uuid, chore_id uuid, title text, category_name text, category_color text,
  scheduled_date date, due_date date, late boolean, assignee_member_ids uuid[],
  submission_id uuid, attempt integer, submitted_at timestamptz, submitted_by_me boolean,
  submitted_by_member uuid, contributor_me boolean, contributor_member uuid,
  contributor_current boolean, note text, steps_done integer, steps_total integer,
  revision integer, total_count integer
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
        o.revision, (count(*) over ())::integer
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

-- The Home's chores for managing them: active ones (p_ended false) or ended ones, by title, with
-- their state and the occurrence to open (the next open one, or the latest).
create function public.list_chores(p_home_id uuid, p_ended boolean default false)
returns table (
  id uuid, title text, kind text, category_id uuid, category_name text, category_color text,
  assignment text, paused boolean, finished boolean, open_count integer, next_due date,
  occurrence_id uuid, revision integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    return query
      select c.id, c.title, c.kind, g.id, g.name, g.color,
        coalesce(s.assignment, case when exists (select 1 from private.chore_occurrence_assignees a
          join private.chore_occurrences o on o.id = a.occurrence_id where o.chore_id = c.id)
          then 'fixed' else 'none' end),
        coalesce(s.paused_from is not null and (s.paused_until is null or s.paused_until >= v_today), false),
        coalesce(c.kind = 'recurring' and s.next_date is null and c.ended_at is null, false),
        (select count(*)::integer from private.chore_occurrences o
          where o.chore_id = c.id and o.deleted_at is null and o.status = 'open'),
        (select min(o.due_date) from private.chore_occurrences o
          where o.chore_id = c.id and o.deleted_at is null and o.status = 'open'),
        coalesce(
          (select o.id from private.chore_occurrences o where o.chore_id = c.id and o.deleted_at is null
            and o.status = 'open' order by o.due_date, o.scheduled_date limit 1),
          (select o.id from private.chore_occurrences o where o.chore_id = c.id and o.deleted_at is null
            order by o.scheduled_date desc limit 1)),
        c.revision
      from private.chores c
      left join private.chore_schedules s on s.chore_id = c.id and s.superseded_at is null
      left join private.chore_categories g on g.id = c.category_id
      where c.home_id = p_home_id and c.deleted_at is null
        and (c.ended_at is not null) = coalesce(p_ended, false)
      order by private.task_name_key(c.title), c.id;
  end
  $$;

-- Trash ------------------------------------------------------------------------------------------------

-- The dispatch functions as they stood before chores keep handling every other item type; the new
-- ones handle the chores module and hand the rest on. So this migration does not repeat the task
-- cases, and a later module can wrap these the same way.
alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_chores;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_chores;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_chores;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_chores;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_chores;

-- Conflicts for chores: the chore is in the trash or gone ('chore_unavailable': restore it first);
-- a removal's schedule changed since (edited, split, paused, deleted again: 'schedule_changed',
-- resolved by bringing back only the occurrences); the Home has the most active chores
-- ('chore_limit').
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_chore private.chores;
    v_occurrence private.chore_occurrences;
    v_removal private.chore_removals;
    v_head private.chore_schedules;
  begin
    if p_entry.module <> 'chores' then
      return private.trash_conflict_before_chores(p_entry);
    end if;
    case p_entry.item_type
      when 'chore' then
        select * into v_chore from private.chores c where c.id = p_entry.subject_id;
        if not found or v_chore.deleted_at is null then
          return 'item_missing';
        end if;
        if v_chore.ended_at is null and (select count(*) from private.chores c
            where c.home_id = v_chore.home_id and c.deleted_at is null and c.ended_at is null)
           >= private.chore_limit('chores') then
          return 'chore_limit';
        end if;
        return null;
      when 'chore_occurrence' then
        select * into v_occurrence from private.chore_occurrences o where o.id = p_entry.subject_id;
        if not found or v_occurrence.deleted_at is null then
          return 'item_missing';
        end if;
        if not exists (select 1 from private.chores c where c.id = v_occurrence.chore_id and c.deleted_at is null) then
          return 'chore_unavailable';
        end if;
        return null;
      when 'chore_removal' then
        select * into v_removal from private.chore_removals r where r.id = p_entry.subject_id;
        if not found then
          return 'item_missing';
        end if;
        if not exists (select 1 from private.chores c where c.id = v_removal.chore_id and c.deleted_at is null) then
          return 'chore_unavailable';
        end if;
        if not v_removal.occurrences_only then
          v_head := private.chore_head(v_removal.chore_id);
          if v_head.id is distinct from v_removal.head_id or v_head.revision <> v_removal.head_revision then
            return 'schedule_changed';
          end if;
        end if;
        return null;
    end case;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_kind
    -- Bring back the deleted occurrences and leave the schedule as it is now.
    when 'schedule_changed' then array['restore_occurrences_only']
    when 'chore_unavailable' then array[]::text[]
    when 'chore_limit' then array[]::text[]
    else private.trash_conflict_options_before_chores(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'chores' then
      perform private.trash_resolve_before_chores(p_entry, p_resolution);
      return;
    end if;
    if p_entry.item_type = 'chore_removal' and p_resolution = 'restore_occurrences_only' then
      update private.chore_removals r set occurrences_only = true where r.id = p_entry.subject_id;
    end if;
  end
  $$;

-- Restoring never back-fills: a schedule that comes back continues from today. A chore that changed
-- or went away between the conflict check and here raises unique_violation, which the caller turns
-- into a fresh conflict.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_chore private.chores;
    v_occurrence private.chore_occurrences;
    v_removal private.chore_removals;
    v_head private.chore_schedules;
    v_today date;
  begin
    if p_entry.module <> 'chores' then
      return private.trash_item_restore_before_chores(p_entry);
    end if;
    case p_entry.item_type
      when 'chore' then
        select * into v_chore from private.chores c where c.id = p_entry.subject_id for update;
        if v_chore.id is null or v_chore.deleted_at is null then
          raise exception 'chore unavailable' using errcode = '23505';
        end if;
        update private.chores c set deleted_at = null, updated_at = pg_catalog.now() where c.id = v_chore.id;
        v_head := private.chore_head(v_chore.id);
        if v_head.id is not null and v_head.next_date is not null then
          v_today := private.task_today(v_chore.home_id, null);
          update private.chore_schedules s
            set next_date = private.chore_part_next(v_head, greatest(v_head.next_date, v_today))
            where s.id = v_head.id;
        end if;
      when 'chore_occurrence' then
        select * into v_occurrence from private.chore_occurrences o where o.id = p_entry.subject_id;
        select * into v_chore from private.chores c where c.id = v_occurrence.chore_id for update;
        if v_chore.id is null or v_chore.deleted_at is not null then
          raise exception 'chore unavailable' using errcode = '23505';
        end if;
        update private.chore_occurrences o set deleted_at = null where o.id = v_occurrence.id;
      when 'chore_removal' then
        select * into v_removal from private.chore_removals r where r.id = p_entry.subject_id;
        select * into v_chore from private.chores c where c.id = v_removal.chore_id for update;
        if v_chore.id is null or v_chore.deleted_at is not null then
          raise exception 'chore unavailable' using errcode = '23505';
        end if;
        update private.chore_occurrences o set deleted_at = null
          where o.id = any (v_removal.occurrence_ids) and o.deleted_at is not null;
        if not v_removal.occurrences_only then
          select * into v_head from private.chore_schedules s
            where s.chore_id = v_chore.id and s.superseded_at is null for update;
          if v_head.id is distinct from v_removal.head_id or v_head.revision <> v_removal.head_revision then
            raise exception 'schedule changed' using errcode = '23505';
          end if;
          v_today := private.task_today(v_chore.home_id, null);
          update private.chore_schedules s
            set until_date = v_removal.previous_until_date, revision = s.revision + 1,
              updated_at = pg_catalog.now()
            where s.id = v_head.id
            returning * into v_head;
          update private.chore_schedules s
            set next_date = private.chore_part_next(v_head, greatest(v_today,
              coalesce(v_head.last_date + 1, v_today)))
            where s.id = v_head.id;
          if v_removal.mode = 'series' then
            update private.chores c set ended_at = null, ended_by = null, revision = c.revision + 1,
              updated_at = pg_catalog.now()
              where c.id = v_chore.id;
          end if;
        end if;
    end case;
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'chores' then
      perform private.trash_item_purge_before_chores(p_entry);
      return;
    end if;
    case p_entry.item_type
      when 'chore' then
        -- Its schedule, occurrences, checklists and assignees go with it (on delete cascade).
        delete from private.chores c where c.id = p_entry.subject_id and c.deleted_at is not null;
      when 'chore_occurrence' then
        delete from private.chore_occurrences o where o.id = p_entry.subject_id and o.deleted_at is not null;
      when 'chore_removal' then
        delete from private.chore_occurrences o
          using private.chore_removals r
          where r.id = p_entry.subject_id and o.id = any (r.occurrence_ids) and o.deleted_at is not null;
        delete from private.chore_removals r where r.id = p_entry.subject_id;
    end case;
  end
  $$;

-- Grants ------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The chore API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'get_chore_context', 'list_chore_categories', 'create_chore_category', 'update_chore_category',
      'reorder_chore_categories', 'delete_chore_category', 'create_chore', 'update_chore',
      'advance_chores', 'set_chore_step', 'complete_chore_occurrence', 'skip_chore_occurrence',
      'reopen_chore_occurrence', 'update_chore_occurrence', 'update_chore_series', 'set_chore_paused',
      'delete_chore_occurrences', 'get_chore_occurrence', 'list_chore_occurrences',
      'list_chore_history', 'list_chores', 'review_chore_submission', 'correct_chore_completion',
      'list_chore_approvals'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%chore%'
      or p.proname in ('set_part_template', 'set_occurrence_assignees', 'copy_part_steps',
        'is_delegable_capability', 'trash_conflict', 'trash_conflict_options', 'trash_resolve',
        'trash_item_restore', 'trash_item_purge')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
