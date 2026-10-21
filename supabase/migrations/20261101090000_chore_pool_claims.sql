-- S21: the unassigned chore pool, claims and reassignment requests (brief plans/steps/S21-brief.md;
-- ADR 0027; spec "Confirmed weekly unassigned chore pool and self-claiming", "Confirmed immediate
-- first-come-first-served claims for approved unassigned chores", "Confirmed instant chore claiming
-- with brief Undo", "Confirmed no chore reservations", "Confirmed per-occurrence claiming for
-- recurring unassigned chores", "Confirmed unlimited eligible self-claims of unassigned chores",
-- "Confirmed per-chore eligibility for claiming unassigned chores", "Confirmed self-release of
-- voluntarily claimed chores", "Confirmed configurable end-of-week expiry for unclaimed chores",
-- "Confirmed automatic release of overdue self-claimed chores", "Confirmed unassigned chore pool
-- filtering and sorting" and "Confirmed request-based chore reassignment").
--
-- The pool: an open occurrence with nobody assigned, not flagged for reassignment, of a chore that is
-- not ended and whose claim policy (chores.claim_mode) is not 'none'. Every current member sees it;
-- who may claim it is the policy: 'all' members (the default), or the 'selected' ones
-- (private.chore_claimants). The policies belong to the chore (default picked in the brief: no
-- occurrence or series scope) and apply to its open occurrences from the moment they change.
--
-- A claim makes the claimant the occurrence's only assignee at once (no dialog, no reservation, no
-- quota) and records it (claimed_by, claimed_at, a claim event). It locks the chore row first, like
-- every chore change, and decides under that lock, so of two people claiming at once exactly one
-- wins and the other is told it is already claimed. A claim never changes the schedule, the rotation
-- or other occurrences, and never awards points (S23).
--
-- Release (and the brief Undo, which is a release too) clears the assignee and the checklist
-- progress, so the next claimant does not inherit it (the events keep what happened). It is for the
-- claimant before submission, and for chore managers. A manager changing the assignees in any other
-- way ends the claim as well (a trigger on the assignees).
--
-- Week boundaries: the Home's week (private.home_chore_settings.week_start, Monday unless a chore
-- manager chose otherwise) in the Home's timezone. An occurrence belongs to the week of its due date.
-- A chore whose expiry policy is 'week_end' closes its still-unclaimed occurrences when that week
-- ends: status 'expired' ("Closed - unclaimed"), never completed, no points, distinct from skipped,
-- not reopened. A claim checks the cutoff itself, so a claim after it fails even if nothing has
-- closed the occurrence yet.
--
-- Automatic release (per chore, off by default): a self-claimed, open occurrence that is not in
-- Needs rework is released a chosen number of hours after the end of its due day. Expiry and
-- automatic release are applied lazily before chore pages read (advance_chores) and, for release,
-- by a delayed job at the deadline (chore-claim-release), both idempotent under the chore lock.
--
-- Reassignment requests: an assignee asks another current member to take over one open
-- occurrence. The recipient accepts or declines; when the Home requires it, an accepted request
-- waits for a chore manager's confirmation. Acceptance (and confirmation) re-checks everything under
-- the chore lock and swaps that one assignee on that one occurrence. Completion, skip, deletion, a
-- changed assignment or a departure invalidates a request that is still open (triggers).
--
-- Realtime (architecture.md §8, per-feature mechanism picked in the brief): Postgres Changes on one
-- row per Home (public.chore_pool_signals) whose version moves, once per transaction and at commit,
-- whenever a chore, an occurrence, its assignees, a claim policy or the chore settings change. RLS
-- lets only the Home's current members see the row; it carries no chore content. Pages refetch the
-- authoritative state when it moves.

-- Notifications: the optional category 'chores' (in-app on, email opt-in) --------------------------

create or replace function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category
    when 'security' then true when 'storage' then true
    when 'invitations' then false when 'reminders' then false when 'approvals' then false
    when 'chores' then false
  end;
  $$;

alter table public.notifications drop constraint notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('security', 'invitations', 'storage', 'reminders', 'approvals', 'chores'));

alter table public.notification_preferences drop constraint notification_preferences_category_check;
alter table public.notification_preferences add constraint notification_preferences_category_check
  check (category in ('invitations', 'reminders', 'approvals', 'chores'));

-- packages/domain optionalNotificationCategories lists the same.
create or replace function private.notification_category_optional(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select coalesce(p_category in ('invitations', 'reminders', 'approvals', 'chores'), false);
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
      cross join (values ('invitations'), ('reminders'), ('approvals'), ('chores')) c (category)
      cross join (values ('in_app'), ('email')) ch (channel)
      order by s.home_id nulls first, c.category, ch.channel;
  end
  $$;

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment'
  ));

-- Tables ---------------------------------------------------------------------------------------------

-- Who may claim a chore's unassigned occurrences, and what happens to them (chore managers set it).
alter table private.chores
  add column claim_mode text not null default 'all'
    constraint chores_claim_mode_check check (claim_mode in ('all', 'selected', 'none')),
  add column expiry_policy text not null default 'overdue'
    constraint chores_expiry_policy_check check (expiry_policy in ('overdue', 'week_end')),
  -- Hours after the end of the due day (Home timezone) after which a self-claimed, unsubmitted
  -- occurrence is released; null: never.
  add column auto_release_hours integer
    constraint chores_auto_release_check check (auto_release_hours between 0 and 720);

-- The members who may claim a chore whose claim_mode is 'selected' (current members by construction:
-- the row ends with the membership).
create table private.chore_claimants (
  chore_id uuid not null,
  home_id uuid not null,
  user_id uuid not null,
  primary key (chore_id, user_id),
  foreign key (chore_id, home_id) references private.chores (id, home_id) on delete cascade,
  foreign key (home_id, user_id) references public.home_memberships (home_id, user_id) on delete cascade
);

create index chore_claimants_member_idx on private.chore_claimants (home_id, user_id);

-- A Home's chore settings (chore managers). No row: the defaults.
create table private.home_chore_settings (
  home_id uuid primary key references public.homes (id) on delete cascade,
  week_start text not null default 'monday'
    constraint home_chore_settings_week_start_check check (week_start in ('monday', 'saturday', 'sunday')),
  -- An accepted reassignment request waits for a chore manager's confirmation.
  reassignment_confirmation boolean not null default false,
  revision integer not null default 1 constraint home_chore_settings_revision_check check (revision >= 1),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table private.chore_occurrences drop constraint chore_occurrences_status_check;
alter table private.chore_occurrences add constraint chore_occurrences_status_check
  check (status in ('open', 'pending_approval', 'completed', 'skipped', 'expired'));

alter table private.chore_occurrences
  -- The current claim: who claimed it from the pool, and when (null: assigned some other way, or
  -- nobody). claim_count numbers the claims, so a delayed release job acts on its own claim only.
  add column claimed_by uuid references auth.users (id) on delete set null,
  add column claimed_at timestamptz,
  add column claim_count integer not null default 0
    constraint chore_occurrences_claim_count_check check (claim_count >= 0),
  -- Closed unclaimed at the end of its week (the end of the week, not when it was noticed).
  add column expired_at timestamptz;

alter table private.chore_occurrences drop constraint chore_occurrences_state_check;
alter table private.chore_occurrences add constraint chore_occurrences_state_check check (
  (status = 'completed') = (completed_at is not null)
  and (status = 'skipped') = (skipped_at is not null)
  and (status = 'expired') = (expired_at is not null)
  and (status = 'completed' or (note is null and contributor_id is null and completed_by is null))
  and (status = 'skipped' or skip_reason is null)
  and (status = 'completed' or (approved_at is null and approved_by is null))
  and (status = 'open' or not in_rework)
  and (claimed_by is null or claimed_at is not null));

create index chore_occurrences_home_claimed_idx on private.chore_occurrences (home_id)
  where claimed_by is not null and status = 'open' and deleted_at is null;

alter table private.chore_occurrence_events drop constraint chore_occurrence_events_kind_check;
alter table private.chore_occurrence_events add constraint chore_occurrence_events_kind_check
  check (kind in ('completed', 'skipped', 'reopened', 'submitted', 'approved', 'rejected',
    'withdrawn', 'corrected', 'claimed', 'released', 'expired', 'reassigned'));
-- For 'released': reason is 'self', 'undo', 'manager', 'auto' or 'departure' and
-- previous_contributor_id the former claimant. For 'reassigned': contributor_id the new assignee and
-- previous_contributor_id the one before.

-- A request to hand one occurrence from one of its assignees to another member.
create table private.chore_reassignment_requests (
  id uuid primary key,
  home_id uuid not null,
  occurrence_id uuid not null,
  from_user uuid references auth.users (id) on delete set null,
  to_user uuid references auth.users (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  note text constraint chore_reassignment_requests_note_check
    check (note is null or private.is_plain_text(note, 200)),
  status text not null default 'pending' constraint chore_reassignment_requests_status_check
    check (status in ('pending', 'awaiting_manager', 'accepted', 'declined', 'cancelled',
      'invalidated', 'refused')),
  created_at timestamptz not null default now(),
  -- The recipient's answer.
  responded_at timestamptz,
  -- The final decision (accepted, declined, cancelled, invalidated, refused) and who made it.
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  invalid_reason text constraint chore_reassignment_requests_reason_check
    check (invalid_reason in ('occurrence_closed', 'assignment_changed', 'member_left')),
  foreign key (occurrence_id, home_id) references private.chore_occurrences (id, home_id) on delete cascade,
  constraint chore_reassignment_requests_state_check check (
    (status in ('pending', 'awaiting_manager')) = (decided_at is null)
    and (status = 'invalidated') = (invalid_reason is not null))
);

-- At most one open request per occurrence (spec: no duplicate or competing transfers).
create unique index chore_reassignment_requests_one_open on private.chore_reassignment_requests (occurrence_id)
  where status in ('pending', 'awaiting_manager');
create index chore_reassignment_requests_home_idx on private.chore_reassignment_requests (home_id, created_at desc);

alter table private.chore_claimants enable row level security;
alter table private.home_chore_settings enable row level security;
alter table private.chore_reassignment_requests enable row level security;
revoke all on table private.chore_claimants, private.home_chore_settings,
  private.chore_reassignment_requests from public, anon, authenticated;

-- The Realtime signal: one row per Home, readable by its current members only.
create table public.chore_pool_signals (
  home_id uuid primary key references public.homes (id) on delete cascade,
  version bigint not null default 1,
  changed_at timestamptz not null default now()
);

alter table public.chore_pool_signals enable row level security;
revoke all on table public.chore_pool_signals from public, anon, authenticated;
grant select on table public.chore_pool_signals to authenticated;

create policy chore_pool_signals_select_member on public.chore_pool_signals
  for select
  to authenticated
  using (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = chore_pool_signals.home_id and m.user_id = (select auth.uid())
    )
  );

comment on table public.chore_pool_signals is
  'S21: a per-Home version that moves when its chores change (Realtime). No chore content.';

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chore_pool_signals;
  end if;
end
$$;

-- Limits ------------------------------------------------------------------------------------------------

-- apps/web/src/chores/schema.ts uses the same numbers.
create function private.chore_pool_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'pool' then 200               -- occurrences one pool read returns
    when 'process' then 200            -- expiries and releases one advance applies
    when 'request_note' then 200
    when 'requests' then 10            -- reassignment requests one occurrence read returns
    when 'auto_release_hours' then 720
  end;
  $$;

-- Settings and time -----------------------------------------------------------------------------------

-- A Home's chore settings, or the defaults when no chore manager changed them.
create function private.chore_settings(p_home_id uuid) returns private.home_chore_settings
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_settings private.home_chore_settings;
  begin
    select * into v_settings from private.home_chore_settings s where s.home_id = p_home_id;
    if not found then
      v_settings.home_id := p_home_id;
      v_settings.week_start := 'monday';
      v_settings.reassignment_confirmation := false;
      v_settings.revision := 0;
    end if;
    return v_settings;
  end
  $$;

-- The first day of the week that holds p_date, for a week starting on p_week_start.
create function private.chore_week_start(p_week_start text, p_date date) returns date
  language sql immutable set search_path = '' as $$
  select p_date - ((extract(isodow from p_date)::integer
    - case p_week_start when 'saturday' then 6 when 'sunday' then 7 else 1 end + 7) % 7);
  $$;

-- The day an unclaimed occurrence closes (its week has ended), or null when its chore keeps it
-- available as overdue.
create function private.chore_claim_cutoff(
  p_occurrence private.chore_occurrences, p_chore private.chores, p_week_start text
) returns date
  language sql immutable set search_path = '' as $$
  select case when p_chore.expiry_policy = 'week_end'
    then private.chore_week_start(p_week_start, p_occurrence.due_date) + 7 end;
  $$;

-- Whether an occurrence is due to close unclaimed on p_today: open, nobody assigned, in the pool (not
-- flagged, its chore open to claims) and its chore closing unclaimed work after its week, which has
-- ended.
create function private.chore_expires(
  p_occurrence private.chore_occurrences, p_chore private.chores, p_week_start text, p_today date
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_occurrence.status = 'open' and p_occurrence.deleted_at is null
    and not p_occurrence.needs_reassignment and p_chore.claim_mode <> 'none'
    and p_chore.deleted_at is null
    and p_today >= private.chore_claim_cutoff(p_occurrence, p_chore, p_week_start)
    and not exists (select 1 from private.chore_occurrence_assignees a
      where a.occurrence_id = p_occurrence.id), false);
  $$;

-- When a self-claimed occurrence is released automatically, or null: the end of its due day in the
-- Home's timezone (local midnight, so daylight saving is handled by the zone) plus the chore's hours.
create function private.chore_release_at(
  p_occurrence private.chore_occurrences, p_chore private.chores, p_zone text
) returns timestamptz
  language sql stable set search_path = '' as $$
  select case when p_chore.auto_release_hours is not null and p_occurrence.claimed_by is not null
    then ((p_occurrence.due_date + 1)::timestamp at time zone coalesce(p_zone, 'UTC'))
      + pg_catalog.make_interval(hours => p_chore.auto_release_hours) end;
  $$;

create function private.home_zone(p_home_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select h.timezone from public.homes h where h.id = p_home_id;
  $$;

-- Why p_user cannot claim the occurrence now, or null when they can. 'already_claimed' when someone
-- claimed it (the caller tells a retry of their own claim apart), 'assigned' when it is assigned
-- some other way, 'not_claimable' (flagged for reassignment, the chore is ended or not open to
-- claims), 'not_eligible' (restricted to selected members), 'expired' (its week ended), or the
-- closed state ('pending_approval', 'already_completed', 'already_skipped').
create function private.chore_claim_block(
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
      else null;
    end case;
    if exists (select 1 from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence.id) then
      return case when p_occurrence.claimed_by is not null then 'already_claimed' else 'assigned' end;
    end if;
    if p_occurrence.needs_reassignment or p_chore.ended_at is not null or p_chore.claim_mode = 'none' then
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

-- Queues the delayed release of a claim (chore-claim-release) for its deadline, when the chore has
-- one. The key holds the claim and the deadline, so a moved deadline queues a new run and an old one
-- finds itself not due or stale.
create function private.schedule_chore_release(
  p_occurrence private.chore_occurrences, p_chore private.chores
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_at timestamptz := private.chore_release_at(p_occurrence, p_chore, private.home_zone(p_occurrence.home_id));
  begin
    if v_at is null or p_occurrence.status <> 'open' then
      return;
    end if;
    perform private.enqueue_job(
      'chore-claim-release', 1,
      'chore-claim-release:' || p_occurrence.id::text || ':' || p_occurrence.claim_count::text || ':'
        || pg_catalog.floor(extract(epoch from v_at))::bigint::text,
      pg_catalog.jsonb_build_object('occurrenceId', p_occurrence.id, 'claim', p_occurrence.claim_count),
      null, v_at);
  end
  $$;

-- Closes an open, unassigned occurrence as expired (its chore locked by the caller), at the moment
-- its week ended.
create function private.expire_chore_occurrence(p_occurrence_id uuid, p_cutoff date, p_zone text)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.chore_occurrences o
      set status = 'expired', in_rework = false,
        expired_at = least(p_cutoff::timestamp at time zone coalesce(p_zone, 'UTC'), pg_catalog.now()),
        closed_title = c.title,
        closed_category = (select g.name from private.chore_categories g where g.id = c.category_id),
        revision = o.revision + 1, updated_at = pg_catalog.now()
      from private.chores c
      where o.id = p_occurrence_id and c.id = o.chore_id;
    insert into private.chore_occurrence_events (occurrence_id, kind) values (p_occurrence_id, 'expired');
  end
  $$;

-- Ends the current claim of an open occurrence (its chore locked by the caller): the assignee and the
-- checklist progress go, a release event keeps who it was and why. Past the cutoff of a closing
-- chore it is expired at once rather than offered again. Returns the status afterwards.
create function private.end_chore_claim(
  p_occurrence private.chore_occurrences, p_actor uuid, p_reason text
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_chore private.chores;
    v_settings private.home_chore_settings := private.chore_settings(p_occurrence.home_id);
    v_cutoff date;
  begin
    select * into v_chore from private.chores c where c.id = p_occurrence.chore_id;
    update private.chore_occurrences o
      set claimed_by = null, claimed_at = null, revision = o.revision + 1, updated_by = p_actor,
        updated_at = pg_catalog.now()
      where o.id = p_occurrence.id;
    delete from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence.id;
    update private.chore_occurrence_steps s set checked_at = null, checked_by = null
      where s.occurrence_id = p_occurrence.id and s.checked_at is not null;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id, reason, previous_contributor_id)
      values (p_occurrence.id, 'released', p_actor, p_reason, p_occurrence.claimed_by);
    select * into p_occurrence from private.chore_occurrences o where o.id = p_occurrence.id;
    if private.chore_expires(p_occurrence, v_chore, v_settings.week_start,
        private.task_today(p_occurrence.home_id, null)) then
      v_cutoff := private.chore_claim_cutoff(p_occurrence, v_chore, v_settings.week_start);
      perform private.expire_chore_occurrence(p_occurrence.id, v_cutoff, private.home_zone(p_occurrence.home_id));
      return 'expired';
    end if;
    return 'open';
  end
  $$;

-- Releases one claim whose automatic-release time has passed (its chore locked by the caller), and
-- tells the former claimant (once per claim). Returns the status afterwards, or null when it no
-- longer qualifies (submitted, in rework, released, another claim, a later deadline).
create function private.auto_release_chore_claim(p_occurrence_id uuid, p_claim integer) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_at timestamptz;
    v_status text;
  begin
    select * into v_occurrence from private.chore_occurrences o where o.id = p_occurrence_id for update;
    if not found or v_occurrence.deleted_at is not null or v_occurrence.status <> 'open'
       or v_occurrence.in_rework or v_occurrence.claimed_by is null
       or (p_claim is not null and v_occurrence.claim_count <> p_claim) then
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

-- Applies the Home's due expiries and automatic releases (at most 'process' of each per call), one
-- chore lock at a time in chore order. Idempotent: what is done is not found again.
create function private.process_chore_pool(p_home_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_settings private.home_chore_settings := private.chore_settings(p_home_id);
    v_zone text := private.home_zone(p_home_id);
    v_today date := private.task_today(p_home_id, null);
    v_item record;
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_cutoff date;
    v_done integer := 0;
  begin
    for v_item in
      select o.id, o.chore_id from private.chore_occurrences o
      join private.chores c on c.id = o.chore_id
      where o.home_id = p_home_id and o.status = 'open' and o.deleted_at is null
        and c.expiry_policy = 'week_end'
        and private.chore_week_start(v_settings.week_start, o.due_date) + 7 <= v_today
        and private.chore_expires(o, c, v_settings.week_start, v_today)
      order by o.chore_id, o.id
      limit private.chore_pool_limit('process')
    loop
      select * into v_chore from private.chores c where c.id = v_item.chore_id for update;
      select * into v_occurrence from private.chore_occurrences o where o.id = v_item.id for update;
      if private.chore_expires(v_occurrence, v_chore, v_settings.week_start, v_today) then
        v_cutoff := private.chore_claim_cutoff(v_occurrence, v_chore, v_settings.week_start);
        perform private.expire_chore_occurrence(v_occurrence.id, v_cutoff, v_zone);
        v_done := v_done + 1;
      end if;
    end loop;
    for v_item in
      select o.id, o.chore_id, o.claim_count from private.chore_occurrences o
      join private.chores c on c.id = o.chore_id
      where o.home_id = p_home_id and o.status = 'open' and o.deleted_at is null and not o.in_rework
        and o.claimed_by is not null and c.deleted_at is null and c.auto_release_hours is not null
        and private.chore_release_at(o, c, v_zone) <= pg_catalog.now()
      order by o.chore_id, o.id
      limit private.chore_pool_limit('process')
    loop
      perform 1 from private.chores c where c.id = v_item.chore_id for update;
      if private.auto_release_chore_claim(v_item.id, v_item.claim_count) is not null then
        v_done := v_done + 1;
      end if;
    end loop;
    return v_done;
  end
  $$;

-- The chore lock and the Realtime signal ---------------------------------------------------------------

-- Moves the Home's signal once per transaction, at commit (a deferred constraint trigger), so it is
-- taken after every chore lock and never inside them. A Home deleted in the same transaction gets
-- none.
create function private.bump_chore_signal() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_home uuid := case when tg_op = 'DELETE' then old.home_id else new.home_id end;
    v_key text;
  begin
    if v_home is null then
      return null;
    end if;
    v_key := 'madeora.chore_signal_' || pg_catalog.replace(v_home::text, '-', '');
    if pg_catalog.current_setting(v_key, true) = pg_catalog.txid_current()::text then
      return null;
    end if;
    perform pg_catalog.set_config(v_key, pg_catalog.txid_current()::text, true);
    insert into public.chore_pool_signals as s (home_id)
      select v_home where exists (select 1 from public.homes h where h.id = v_home)
      on conflict (home_id) do update set version = s.version + 1, changed_at = pg_catalog.now();
    return null;
  end
  $$;

create constraint trigger chore_occurrences_signal after insert or update or delete on private.chore_occurrences
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger chore_occurrence_assignees_signal after insert or delete on private.chore_occurrence_assignees
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger chores_signal after insert or update on private.chores
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger chore_claimants_signal after insert or delete on private.chore_claimants
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger home_chore_settings_signal after insert or update on private.home_chore_settings
  deferrable initially deferred for each row execute function private.bump_chore_signal();

-- Claims and requests follow the assignees -------------------------------------------------------------

-- Ends an open request with p_reason and tells both people (in-app; email for those who opted in).
create function private.invalidate_chore_request(p_request private.chore_reassignment_requests, p_reason text)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user uuid;
  begin
    update private.chore_reassignment_requests r
      set status = 'invalidated', invalid_reason = p_reason, decided_at = pg_catalog.now()
      where r.id = p_request.id and r.status in ('pending', 'awaiting_manager');
    if not found then
      return;
    end if;
    foreach v_user in array array[p_request.requested_by, p_request.to_user] loop
      perform private.notify_user(
        v_user, p_request.home_id, 'chores', 'chore.reassignment_invalidated',
        pg_catalog.jsonb_build_object('homeId', p_request.home_id, 'occurrenceId', p_request.occurrence_id),
        'chore-reassignment-invalidated:' || p_request.id::text, true);
    end loop;
  end
  $$;

-- An assignee leaving an occurrence ends their claim and the open request that would move it away
-- from them; a new assignee ends a request that would hand it to them.
create function private.chore_assignees_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request private.chore_reassignment_requests;
  begin
    if tg_op = 'DELETE' then
      update private.chore_occurrences o set claimed_by = null, claimed_at = null
        where o.id = old.occurrence_id and o.claimed_by = old.user_id;
      for v_request in
        select * from private.chore_reassignment_requests r
        where r.occurrence_id = old.occurrence_id and r.from_user = old.user_id
          and r.status in ('pending', 'awaiting_manager')
      loop
        perform private.invalidate_chore_request(v_request, 'assignment_changed');
      end loop;
    else
      for v_request in
        select * from private.chore_reassignment_requests r
        where r.occurrence_id = new.occurrence_id and r.to_user = new.user_id
          and r.status in ('pending', 'awaiting_manager')
      loop
        perform private.invalidate_chore_request(v_request, 'assignment_changed');
      end loop;
    end if;
    return null;
  end
  $$;

create trigger chore_occurrence_assignees_changed after insert or delete on private.chore_occurrence_assignees
  for each row execute function private.chore_assignees_changed();

-- An occurrence that is no longer open (completed, submitted, skipped, expired, in the trash) ends
-- its open request.
create function private.chore_occurrence_closed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request private.chore_reassignment_requests;
  begin
    for v_request in
      select * from private.chore_reassignment_requests r
      where r.occurrence_id = new.id and r.status in ('pending', 'awaiting_manager')
    loop
      perform private.invalidate_chore_request(v_request, 'occurrence_closed');
    end loop;
    return null;
  end
  $$;

create trigger chore_occurrences_closed after update of status, deleted_at on private.chore_occurrences
  for each row when (new.status <> 'open' or new.deleted_at is not null)
  execute function private.chore_occurrence_closed();

-- Departure (replaces S20's): a departing member's claims return to the pool (no flag: nobody else
-- was meant to do them; their progress is cleared, a release event keeps who it was); their other
-- open assignments are flagged for reassignment as before. Their open requests (either side) end.
create or replace function private.flag_departed_chore_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request private.chore_reassignment_requests;
    v_released uuid[];
  begin
    with released as (
      update private.chore_occurrences o set claimed_by = null, claimed_at = null,
          revision = o.revision + 1, updated_at = pg_catalog.now()
        where o.home_id = old.home_id and o.status = 'open' and o.claimed_by = old.user_id
        returning o.id
    )
    select coalesce(array_agg(r.id), '{}') into v_released from released r;
    update private.chore_occurrence_steps s set checked_at = null, checked_by = null
      where s.occurrence_id = any (v_released) and s.checked_at is not null;
    insert into private.chore_occurrence_events (occurrence_id, kind, reason, previous_contributor_id)
      select r, 'released', 'departure', old.user_id from unnest(v_released) as r;
    update private.chore_occurrences o set needs_reassignment = true
      where o.home_id = old.home_id and o.status = 'open' and not o.needs_reassignment
        and not (o.id = any (v_released))
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
    for v_request in
      select * from private.chore_reassignment_requests r
      where r.home_id = old.home_id and r.status in ('pending', 'awaiting_manager')
        and old.user_id in (r.from_user, r.to_user, r.requested_by)
    loop
      perform private.invalidate_chore_request(v_request, 'member_left');
    end loop;
    return old;
  end
  $$;

-- A series change (update_chore_series) leaves claimed occurrences with their claimant (spec: a
-- claim is not undone by series edits); every other caller replaces the assignees as before.
create or replace function private.set_occurrence_assignees(p_occurrence_id uuid, p_home_id uuid, p_users uuid[])
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if pg_catalog.current_setting('madeora.keep_chore_claims', true) = 'on' and exists (
      select 1 from private.chore_occurrences o
      where o.id = p_occurrence_id and o.status = 'open' and o.claimed_by is not null
    ) then
      return;
    end if;
    delete from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence_id;
    insert into private.chore_occurrence_assignees (occurrence_id, home_id, user_id)
      select p_occurrence_id, p_home_id, u from unnest(coalesce(p_users, '{}')) as u
      on conflict do nothing;
  end
  $$;

-- A claimed occurrence counts as having progress: a schedule change or a pause keeps it.
create or replace function private.chore_occurrence_touched(p_occurrence private.chore_occurrences) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_occurrence.detached or p_occurrence.claimed_by is not null or exists (
    select 1 from private.chore_occurrence_steps s
    where s.occurrence_id = p_occurrence.id and s.checked_at is not null
  );
  $$;

-- S20 functions wrapped for the new states -------------------------------------------------------------

alter function public.advance_chores(uuid) set schema private;
alter function private.advance_chores(uuid) rename to advance_chores_before_pool;

-- Creates the due occurrences (S20), then applies due expiries and automatic releases.
create function public.advance_chores(p_home_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_created integer := private.advance_chores_before_pool(p_home_id);
  begin
    perform private.process_chore_pool(p_home_id);
    return v_created;
  end
  $$;

alter function public.complete_chore_occurrence(uuid, uuid, text) set schema private;
alter function private.complete_chore_occurrence(uuid, uuid, text) rename to complete_chore_occurrence_before_pool;

-- As S20, and an expired occurrence answers 'occurrence_closed'.
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
    if v_occurrence.status = 'expired' then
      return query select 'occurrence_closed', null::timestamptz, false, null::uuid, false, null::uuid,
        null::integer, v_occurrence.revision;
      return;
    end if;
    return query select * from private.complete_chore_occurrence_before_pool(p_occurrence_id, p_contributor, p_note);
  end
  $$;

alter function public.skip_chore_occurrence(uuid, text) set schema private;
alter function private.skip_chore_occurrence(uuid, text) rename to skip_chore_occurrence_before_pool;

-- As S20, and an expired occurrence answers 'occurrence_closed'.
create function public.skip_chore_occurrence(p_occurrence_id uuid, p_reason text default null)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, private.require_confirmed_caller());
    if v_occurrence.status = 'expired' then
      return query select 'occurrence_closed', v_occurrence.revision;
      return;
    end if;
    return query select * from private.skip_chore_occurrence_before_pool(p_occurrence_id, p_reason);
  end
  $$;

alter function public.reopen_chore_occurrence(uuid) set schema private;
alter function private.reopen_chore_occurrence(uuid) rename to reopen_chore_occurrence_before_pool;

-- As S20; an expired occurrence stays closed (spec: never silently reopened) and answers
-- 'occurrence_closed'.
create function public.reopen_chore_occurrence(p_occurrence_id uuid)
returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_occurrence private.chore_occurrences;
  begin
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, private.require_confirmed_caller());
    if v_occurrence.status = 'expired' then
      return query select 'occurrence_closed', v_occurrence.revision;
      return;
    end if;
    return query select * from private.reopen_chore_occurrence_before_pool(p_occurrence_id);
  end
  $$;

alter function public.update_chore_series(uuid, text, integer, integer, boolean, jsonb, jsonb, boolean,
  integer, boolean, text, integer, smallint[], date, date, integer) set schema private;
alter function private.update_chore_series(uuid, text, integer, integer, boolean, jsonb, jsonb, boolean,
  integer, boolean, text, integer, smallint[], date, date, integer) rename to update_chore_series_before_pool;

-- As S20, except that claimed occurrences keep their claimant (and are never flagged for
-- reassignment by a new rotation).
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
  begin
    perform pg_catalog.set_config('madeora.keep_chore_claims', 'on', true);
    select * into v_row from private.update_chore_series_before_pool(p_occurrence_id, p_scope,
      p_expected_revision, p_expected_schedule_revision, p_dry_run, p_assignment, p_steps,
      p_set_minutes, p_minutes, p_set_schedule, p_frequency, p_interval, p_weekdays, p_starts_on,
      p_ends_on, p_max_count) x;
    perform pg_catalog.set_config('madeora.keep_chore_claims', 'off', true);
    if v_row.outcome = 'saved' then
      update private.chore_occurrences o set needs_reassignment = false
        where o.chore_id = (select x.chore_id from private.chore_occurrences x where x.id = p_occurrence_id)
          and o.status = 'open' and o.claimed_by is not null and o.needs_reassignment;
    end if;
    return query select v_row.outcome, v_row.impact, v_row.revision, v_row.occurrence_id;
  end
  $$;

-- Claiming and releasing ---------------------------------------------------------------------------------

-- Claims an occurrence from the pool for the caller (spec "Confirmed immediate first-come-first-served
-- claims"): they become its only assignee at once; nothing else changes. Of two simultaneous claims
-- one wins; the other is told 'already_claimed' with who has it. A retry of the caller's own claim
-- answers 'claimed' again. Outcomes: 'claimed', 'already_claimed', 'assigned', 'not_claimable',
-- 'not_eligible', 'expired', 'pending_approval', 'already_completed', 'already_skipped', 'not_found'.
create function public.claim_chore_occurrence(p_occurrence_id uuid)
returns table (outcome text, revision integer, claimed_by_me boolean, claimant_member uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_block text;
  begin
    if p_occurrence_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::integer, false, null::uuid;
      return;
    end if;
    select * into v_chore from private.chores c where c.id = v_occurrence.chore_id;
    v_block := private.chore_claim_block(v_occurrence, v_chore, v_user_id,
      private.task_today(v_occurrence.home_id, null), (private.chore_settings(v_occurrence.home_id)).week_start);
    if v_block = 'already_claimed' then
      return query select case when v_occurrence.claimed_by = v_user_id then 'claimed' else 'already_claimed' end,
        v_occurrence.revision, v_occurrence.claimed_by = v_user_id,
        private.member_ref(v_occurrence.home_id, v_occurrence.claimed_by);
      return;
    end if;
    if v_block is not null then
      return query select v_block, v_occurrence.revision, false, null::uuid;
      return;
    end if;
    insert into private.chore_occurrence_assignees (occurrence_id, home_id, user_id)
      values (v_occurrence.id, v_occurrence.home_id, v_user_id);
    update private.chore_occurrences o
      set claimed_by = v_user_id, claimed_at = pg_catalog.now(), claim_count = o.claim_count + 1,
        revision = o.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id)
      values (v_occurrence.id, 'claimed', v_user_id);
    perform private.schedule_chore_release(v_occurrence, v_chore);
    perform private.audit_chore('chore_occurrence.claimed', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id);
    return query select 'claimed', v_occurrence.revision, true,
      private.member_ref(v_occurrence.home_id, v_user_id);
  end
  $$;

-- Releases a claimed occurrence back to the pool (spec "Confirmed self-release", "instant claiming
-- with brief Undo"): by its claimant (p_undo marks the Undo right after claiming) or a chore
-- manager, while it is open (not submitted). The checklist progress is cleared. A chore that closes
-- its unclaimed occurrences after their week closes it at once when that week has ended ('expired').
-- Outcomes: 'released' (with the status afterwards: 'open' or 'expired'), 'not_claimed' (assigned
-- some other way, or nobody: a retry after it was released), 'pending_approval',
-- 'occurrence_closed', 'not_permitted', 'not_found'.
create function public.release_chore_occurrence(p_occurrence_id uuid, p_undo boolean default false)
returns table (outcome text, status text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_status text;
    v_reason text;
  begin
    if p_occurrence_id is null or p_undo is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::text, null::integer;
      return;
    end if;
    if v_occurrence.status = 'pending_approval' then
      return query select 'pending_approval', v_occurrence.status, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select 'occurrence_closed', v_occurrence.status, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.claimed_by is null then
      return query select 'not_claimed', v_occurrence.status, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.claimed_by = v_user_id then
      v_reason := case when p_undo then 'undo' else 'self' end;
    elsif private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      v_reason := 'manager';
    else
      return query select 'not_permitted', null::text, null::integer;
      return;
    end if;
    v_status := private.end_chore_claim(v_occurrence, v_user_id, v_reason);
    perform private.audit_chore('chore_occurrence.released', v_occurrence.home_id, 'chore_occurrence',
      v_occurrence.id, pg_catalog.jsonb_build_object('reason', v_reason));
    if v_reason = 'manager' then
      perform private.notify_user(
        v_occurrence.claimed_by, v_occurrence.home_id, 'chores', 'chore.claim_released',
        pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id,
          'reason', 'manager'),
        'chore-claim-released:' || v_occurrence.id::text || ':' || v_occurrence.claim_count::text, true);
    end if;
    return query select 'released', v_status,
      (select o.revision from private.chore_occurrences o where o.id = v_occurrence.id);
  end
  $$;

-- The delayed job (service role only): releases the claim p_claim of an occurrence when its
-- automatic-release time has passed. 'released', 'stale' (submitted, released, claimed again, in
-- rework or no longer due: nothing to do), 'missing'.
create function public.release_overdue_chore_claim(p_occurrence_id uuid, p_claim integer) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_chore_id uuid;
  begin
    select o.chore_id into v_chore_id from private.chore_occurrences o where o.id = p_occurrence_id;
    if v_chore_id is null then
      return 'missing';
    end if;
    perform 1 from private.chores c where c.id = v_chore_id for update;
    return case when private.auto_release_chore_claim(p_occurrence_id, p_claim) is null
      then 'stale' else 'released' end;
  end
  $$;

-- The pool ----------------------------------------------------------------------------------------------

-- The Home's claimable work (spec "Confirmed weekly unassigned chore pool"): the open, unassigned
-- occurrences of the Home-local week that holds p_date (today when null), section 'week', and every
-- earlier one still available, section 'overdue' (due before the current week). eligible: whether
-- the caller may claim it (a restricted chore says only that, never who may). Earliest due first, at
-- most 'pool' rows (truncated tells). 42501 for a Home the caller is not in.
create function public.list_chore_pool(p_home_id uuid, p_date date default null)
returns table (
  id uuid, chore_id uuid, title text, kind text, category_id uuid, category_name text,
  category_color text, scheduled_date date, due_date date, section text, overdue boolean,
  minutes integer, steps_total integer, requires_approval boolean, restricted boolean,
  eligible boolean, closes_on date, revision integer, week_start date, today date, truncated boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_settings private.home_chore_settings;
    v_today date;
    v_week date;
    v_current date;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_date is not null and p_date not between date '2000-01-01' and date '2199-12-31' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_settings := private.chore_settings(p_home_id);
    v_today := private.task_today(p_home_id, null);
    v_current := private.chore_week_start(v_settings.week_start, v_today);
    v_week := private.chore_week_start(v_settings.week_start, coalesce(p_date, v_today));
    return query
      with pool as (
        select o.*, c.title as chore_title, c.kind as chore_kind, c.category_id as chore_category,
          c.requires_approval as chore_approval, c.claim_mode,
          private.chore_claim_cutoff(o, c, v_settings.week_start) as cutoff,
          case when o.due_date between v_week and v_week + 6 then 'week' else 'overdue' end as section_name
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.status = 'open' and o.deleted_at is null
          and not o.needs_reassignment and c.deleted_at is null and c.ended_at is null
          and c.claim_mode <> 'none'
          and not exists (select 1 from private.chore_occurrence_assignees a where a.occurrence_id = o.id)
          and (o.due_date between v_week and v_week + 6 or o.due_date < v_current)
      ), rows as (
        select p.* from pool p where p.cutoff is null or v_today < p.cutoff
        order by p.due_date, private.task_name_key(p.chore_title), p.id
        limit private.chore_pool_limit('pool') + 1
      )
      select r.id, r.chore_id, r.chore_title, r.chore_kind, g.id, g.name, g.color, r.scheduled_date,
        r.due_date, r.section_name, r.due_date < v_today, r.estimated_minutes,
        (select count(*)::integer from private.chore_occurrence_steps s where s.occurrence_id = r.id),
        r.chore_approval, r.claim_mode = 'selected',
        r.claim_mode = 'all' or exists (select 1 from private.chore_claimants k
          where k.chore_id = r.chore_id and k.user_id = v_user_id),
        r.cutoff, r.revision, v_week, v_today,
        (select count(*) from rows) > private.chore_pool_limit('pool')
      from rows r
      left join private.chore_categories g on g.id = r.chore_category
      order by r.due_date, private.task_name_key(r.chore_title), r.id
      limit private.chore_pool_limit('pool');
  end
  $$;

-- What the caller sees about one occurrence's claim and reassignment (null when it is not theirs to
-- see): the chore's policies, whether they can claim it (and if not why), the current claim, whether
-- they can release it and when it would be released automatically, the day it closes unclaimed, and
-- the reassignment requests they are part of (chore managers see every one; the newest
-- 'requests'). Who else may claim a restricted chore is never shown here.
create function public.get_chore_claim_state(p_occurrence_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_chore private.chores;
    v_settings private.home_chore_settings;
    v_manage boolean;
    v_block text;
    v_assigned boolean;
    v_open_request boolean;
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
    v_settings := private.chore_settings(v_occurrence.home_id);
    v_manage := private.can_manage_chores(v_occurrence.home_id, v_user_id);
    v_block := private.chore_claim_block(v_occurrence, v_chore, v_user_id,
      private.task_today(v_occurrence.home_id, null), v_settings.week_start);
    v_assigned := exists (select 1 from private.chore_occurrence_assignees a
      where a.occurrence_id = v_occurrence.id and a.user_id = v_user_id);
    v_open_request := exists (select 1 from private.chore_reassignment_requests r
      where r.occurrence_id = v_occurrence.id and r.status in ('pending', 'awaiting_manager'));
    return pg_catalog.jsonb_build_object(
      'claimMode', v_chore.claim_mode,
      'expiryPolicy', v_chore.expiry_policy,
      'autoReleaseHours', v_chore.auto_release_hours,
      'claimable', v_block is null,
      'block', v_block,
      'claimedBy', private.chore_person(v_occurrence.home_id, v_occurrence.claimed_by, v_user_id),
      'claimedAt', v_occurrence.claimed_at,
      'canRelease', v_occurrence.status = 'open' and v_occurrence.claimed_by is not null
        and (v_occurrence.claimed_by = v_user_id or v_manage),
      'releaseAt', case when v_occurrence.status = 'open' and not v_occurrence.in_rework
        then private.chore_release_at(v_occurrence, v_chore, private.home_zone(v_occurrence.home_id)) end,
      'closesOn', case when v_occurrence.status = 'open'
        then private.chore_claim_cutoff(v_occurrence, v_chore, v_settings.week_start) end,
      'expiredAt', v_occurrence.expired_at,
      'canRequest', v_occurrence.status = 'open' and not v_open_request
        and (v_assigned or (v_manage and exists (select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = v_occurrence.id))),
      'canRequestForOthers', v_manage,
      'confirmationRequired', v_settings.reassignment_confirmation,
      'requests', coalesce((select pg_catalog.jsonb_agg(x.item order by x.created_at desc) from (
          select r.created_at, pg_catalog.jsonb_build_object(
            'id', r.id, 'status', r.status,
            'from', private.chore_person(r.home_id, r.from_user, v_user_id),
            'to', private.chore_person(r.home_id, r.to_user, v_user_id),
            'by', private.chore_person(r.home_id, r.requested_by, v_user_id),
            'note', r.note, 'createdAt', r.created_at, 'respondedAt', r.responded_at,
            'decidedAt', r.decided_at,
            'decidedBy', private.chore_person(r.home_id, r.decided_by, v_user_id),
            'invalidReason', r.invalid_reason,
            'canAnswer', r.status = 'pending' and r.to_user = v_user_id,
            'canCancel', r.status in ('pending', 'awaiting_manager') and r.requested_by = v_user_id,
            'canConfirm', r.status = 'awaiting_manager' and v_manage) as item
          from private.chore_reassignment_requests r
          where r.occurrence_id = v_occurrence.id
            and (v_manage or v_user_id in (r.requested_by, r.to_user, r.from_user))
          order by r.created_at desc
          limit private.chore_pool_limit('requests')) x), '[]'::jsonb));
  end
  $$;

-- Claim policies (chore managers) ------------------------------------------------------------------------

-- A chore's claim policies for its editor: who may claim (with the selected members as membership
-- ids for chore managers only), the expiry policy and the automatic release. Null when it is not the
-- caller's to see.
create function public.get_chore_claim_policy(p_chore_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_chore private.chores;
  begin
    select * into v_chore from private.chores c where c.id = p_chore_id and c.deleted_at is null;
    if not found or not private.is_home_member(v_chore.home_id, v_user_id) then
      return null;
    end if;
    return pg_catalog.jsonb_build_object(
      'claimMode', v_chore.claim_mode,
      'members', case when private.can_manage_chores(v_chore.home_id, v_user_id)
        then coalesce((select pg_catalog.jsonb_agg(private.member_ref(k.home_id, k.user_id)
          order by k.user_id) from private.chore_claimants k where k.chore_id = v_chore.id), '[]'::jsonb) end,
      'expiryPolicy', v_chore.expiry_policy,
      'autoReleaseHours', v_chore.auto_release_hours,
      'revision', v_chore.revision);
  end
  $$;

-- Sets who may claim a chore's unassigned occurrences, whether they close at the end of their week,
-- and the automatic release (chore managers; spec "per-chore eligibility", "configurable end-of-week
-- expiry", "automatic release"). p_mode 'all', 'selected' (p_member_ids: 1-20 current members) or
-- 'none'; p_expiry 'overdue' or 'week_end'; p_auto_release_hours null (off) or 0-720. Applies to the
-- chore's open occurrences from now on; claims already made stay (claimedIneligible counts those the
-- new rule would not have allowed, for the manager to review). impact: expireNow (unclaimed
-- occurrences whose week already ended, closed at once), releaseNow (claims past the new release
-- time, released at once), claimedIneligible. A change with immediate effects needs p_confirm.
-- p_dry_run answers the impact only. Outcomes: 'preview', 'saved', 'needs_confirmation' (with
-- impact), 'conflict' (with the current revision), 'invalid_member', 'not_found', 'not_permitted'.
create function public.set_chore_claim_policy(
  p_chore_id uuid, p_expected_revision integer, p_mode text, p_member_ids uuid[], p_expiry text,
  p_auto_release_hours integer default null, p_dry_run boolean default false,
  p_confirm boolean default false
) returns table (outcome text, impact jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_chore private.chores;
    v_new private.chores;
    v_users uuid[] := '{}';
    v_settings private.home_chore_settings;
    v_zone text;
    v_today date;
    v_expire integer;
    v_release integer;
    v_ineligible integer;
    v_impact jsonb;
    v_occurrence private.chore_occurrences;
  begin
    if p_chore_id is null or p_expected_revision is null or p_dry_run is null or p_confirm is null
       or p_mode is null or p_mode not in ('all', 'selected', 'none')
       or p_expiry is null or p_expiry not in ('overdue', 'week_end')
       or (p_auto_release_hours is not null
         and p_auto_release_hours not between 0 and private.chore_pool_limit('auto_release_hours'))
       or (p_mode = 'selected') <> (cardinality(coalesce(p_member_ids, '{}')) > 0) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_chore := private.lock_chore(p_chore_id, v_user_id);
    if v_chore.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_chore.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_chore.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_chore.revision;
      return;
    end if;
    if p_mode = 'selected' then
      v_users := private.chore_member_users(v_chore.home_id, p_member_ids);
      if v_users is null then
        return query select 'invalid_member', null::jsonb, null::integer;
        return;
      end if;
    end if;
    v_settings := private.chore_settings(v_chore.home_id);
    v_zone := private.home_zone(v_chore.home_id);
    v_today := private.task_today(v_chore.home_id, null);
    v_new := v_chore;
    v_new.claim_mode := p_mode;
    v_new.expiry_policy := p_expiry;
    v_new.auto_release_hours := p_auto_release_hours;
    select count(*)::integer into v_expire from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.status = 'open'
        and private.chore_expires(o, v_new, v_settings.week_start, v_today);
    select count(*)::integer into v_release from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.status = 'open' and o.deleted_at is null and not o.in_rework
        and o.claimed_by is not null and private.chore_release_at(o, v_new, v_zone) <= pg_catalog.now();
    select count(*)::integer into v_ineligible from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.status in ('open', 'pending_approval') and o.deleted_at is null
        and o.claimed_by is not null
        and (p_mode = 'none' or (p_mode = 'selected' and not (o.claimed_by = any (v_users))));
    v_impact := pg_catalog.jsonb_build_object('expireNow', v_expire, 'releaseNow', v_release,
      'claimedIneligible', v_ineligible);
    if p_dry_run then
      return query select 'preview', v_impact, v_chore.revision;
      return;
    end if;
    if v_expire + v_release > 0 and not p_confirm then
      return query select 'needs_confirmation', v_impact, v_chore.revision;
      return;
    end if;
    update private.chores c
      set claim_mode = p_mode, expiry_policy = p_expiry, auto_release_hours = p_auto_release_hours,
        revision = c.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where c.id = v_chore.id
      returning * into v_chore;
    delete from private.chore_claimants k
      where k.chore_id = v_chore.id and not (k.user_id = any (v_users));
    insert into private.chore_claimants (chore_id, home_id, user_id)
      select v_chore.id, v_chore.home_id, u from unnest(v_users) as u
      on conflict do nothing;
    -- Claims get (or keep) their release time under the new policy.
    for v_occurrence in
      select * from private.chore_occurrences o
      where o.chore_id = v_chore.id and o.status = 'open' and o.deleted_at is null
        and o.claimed_by is not null
      order by o.id
    loop
      perform private.schedule_chore_release(v_occurrence, v_chore);
    end loop;
    perform private.audit_chore('chore.claim_policy_updated', v_chore.home_id, 'chore', v_chore.id,
      pg_catalog.jsonb_build_object('mode', p_mode, 'members', cardinality(v_users), 'expiry', p_expiry,
        'autoRelease', p_auto_release_hours is not null) || v_impact);
    perform private.process_chore_pool(v_chore.home_id);
    return query select 'saved', v_impact, v_chore.revision;
  end
  $$;

-- Home chore settings -----------------------------------------------------------------------------------

-- The Home's week start and whether reassignment requests need a manager's confirmation, for every
-- member (they shape what everyone sees); can_manage says who may change them.
create function public.get_chore_settings(p_home_id uuid)
returns table (week_start text, reassignment_confirmation boolean, revision integer, can_manage boolean)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_settings private.home_chore_settings;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_settings := private.chore_settings(p_home_id);
    return query select v_settings.week_start, v_settings.reassignment_confirmation, v_settings.revision,
      private.can_manage_chores(p_home_id, v_user_id);
  end
  $$;

-- Changes them (chore managers). p_expected_revision 0 when they were never changed. A new week
-- start moves every week boundary from now on (closed occurrences stay closed). Outcomes: 'saved',
-- 'conflict' (with the current revision), 'not_permitted'.
create function public.update_chore_settings(
  p_home_id uuid, p_expected_revision integer, p_week_start text, p_reassignment_confirmation boolean
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_settings private.home_chore_settings;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_expected_revision is null or p_expected_revision < 0 or p_week_start is null
       or p_week_start not in ('monday', 'saturday', 'sunday') or p_reassignment_confirmation is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    perform private.lock_chore_home('settings', p_home_id);
    v_settings := private.chore_settings(p_home_id);
    if v_settings.revision <> p_expected_revision then
      return query select 'conflict', v_settings.revision;
      return;
    end if;
    insert into private.home_chore_settings as s (home_id, week_start, reassignment_confirmation, updated_by)
      values (p_home_id, p_week_start, p_reassignment_confirmation, v_user_id)
      on conflict (home_id) do update
        set week_start = excluded.week_start, reassignment_confirmation = excluded.reassignment_confirmation,
          revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      returning * into v_settings;
    perform private.audit_chore('chore_settings.updated', p_home_id, 'home', p_home_id,
      pg_catalog.jsonb_build_object('weekStart', p_week_start, 'confirmation', p_reassignment_confirmation));
    return query select 'saved', v_settings.revision;
  end
  $$;

-- Reassignment requests (spec "Confirmed request-based chore reassignment") ------------------------------

-- Asks p_to_member (a current member's membership id) to take over the caller's part of an open
-- occurrence they are assigned to, with an optional note (whitespace runs as one space, at most 200
-- characters). p_id from the client, so a retry returns the same request. Nothing changes until the
-- recipient accepts. Outcomes: 'requested', 'exists', 'id_taken', 'not_assignee', 'invalid_recipient'
-- (not a current member, the caller, or already assigned), 'request_open' (one is open already),
-- 'pending_approval', 'occurrence_closed', 'not_found'.
create function public.request_chore_reassignment(
  p_id uuid, p_occurrence_id uuid, p_to_member uuid, p_note text default null,
  p_from_member uuid default null
) returns table (outcome text, status text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_note text := private.chore_short_text(p_note);
    v_occurrence private.chore_occurrences;
    v_existing private.chore_reassignment_requests;
    v_to uuid;
    v_from uuid := v_user_id;
  begin
    if p_id is null or p_occurrence_id is null or p_to_member is null
       or (v_note is not null and not private.is_plain_text(v_note, private.chore_pool_limit('request_note'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::text;
      return;
    end if;
    select * into v_existing from private.chore_reassignment_requests r where r.id = p_id;
    if found then
      return query select case when v_existing.requested_by = v_user_id
          and v_existing.occurrence_id = v_occurrence.id then 'exists' else 'id_taken' end,
        case when v_existing.requested_by = v_user_id then v_existing.status end;
      return;
    end if;
    if v_occurrence.status = 'pending_approval' then
      return query select 'pending_approval', null::text;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select 'occurrence_closed', null::text;
      return;
    end if;
    -- A chore manager may ask for any assignee (p_from_member); anyone else only for themselves.
    if p_from_member is not null then
      select m.user_id into v_from from public.home_memberships m
        where m.home_id = v_occurrence.home_id and m.id = p_from_member;
      if v_from is distinct from v_user_id
         and not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
        return query select 'not_permitted', null::text;
        return;
      end if;
    end if;
    if v_from is null or not exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_from) then
      return query select 'not_assignee', null::text;
      return;
    end if;
    select m.user_id into v_to from public.home_memberships m
      where m.home_id = v_occurrence.home_id and m.id = p_to_member;
    if v_to is null or v_to = v_from or exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_to) then
      return query select 'invalid_recipient', null::text;
      return;
    end if;
    if exists (select 1 from private.chore_reassignment_requests r
        where r.occurrence_id = v_occurrence.id and r.status in ('pending', 'awaiting_manager')) then
      return query select 'request_open', null::text;
      return;
    end if;
    insert into private.chore_reassignment_requests (
      id, home_id, occurrence_id, from_user, to_user, requested_by, note
    ) values (p_id, v_occurrence.home_id, v_occurrence.id, v_from, v_to, v_user_id, v_note);
    perform private.notify_user(
      v_to, v_occurrence.home_id, 'chores', 'chore.reassignment_requested',
      pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id),
      'chore-reassignment-requested:' || p_id::text, true);
    perform private.audit_chore('chore_reassignment.requested', v_occurrence.home_id, 'chore_reassignment',
      p_id, pg_catalog.jsonb_build_object('occurrence', v_occurrence.id, 'note', v_note is not null));
    return query select 'requested', 'pending';
  end
  $$;

-- Hands the occurrence over (the caller holds the chore lock and has re-checked the request): the
-- request is accepted first, so the assignee triggers find no open request to end.
create function private.transfer_chore_occurrence(
  p_request private.chore_reassignment_requests, p_actor uuid
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.chore_reassignment_requests r
      set status = 'accepted', decided_at = pg_catalog.now(), decided_by = p_actor,
        responded_at = coalesce(r.responded_at, pg_catalog.now())
      where r.id = p_request.id;
    delete from private.chore_occurrence_assignees a
      where a.occurrence_id = p_request.occurrence_id and a.user_id = p_request.from_user;
    insert into private.chore_occurrence_assignees (occurrence_id, home_id, user_id)
      values (p_request.occurrence_id, p_request.home_id, p_request.to_user)
      on conflict do nothing;
    update private.chore_occurrences o
      set needs_reassignment = false, revision = o.revision + 1, updated_by = p_actor,
        updated_at = pg_catalog.now()
      where o.id = p_request.occurrence_id;
    insert into private.chore_occurrence_events (
      occurrence_id, kind, actor_id, contributor_id, previous_contributor_id
    ) values (p_request.occurrence_id, 'reassigned', p_actor, p_request.to_user, p_request.from_user);
    perform private.audit_chore('chore_reassignment.accepted', p_request.home_id, 'chore_reassignment',
      p_request.id, pg_catalog.jsonb_build_object('occurrence', p_request.occurrence_id));
  end
  $$;

-- Answers a request. 'accept' or 'decline': the recipient, while it is pending; 'cancel': the
-- requester, while it is open; 'confirm' or 'refuse': a chore manager, while an accepted request
-- waits for confirmation. Accepting and confirming re-check that the occurrence is open, the
-- requester's assignee is still on it and the recipient is a current member not yet on it
-- (otherwise the request is invalidated); where the Home requires confirmation (and the recipient
-- is not a chore manager), accepting makes it wait for one. Outcomes: 'accepted', 'awaiting_manager',
-- 'declined', 'cancelled', 'refused', 'invalidated', 'not_open' (with its status: already
-- answered or decided), 'not_permitted', 'not_found'.
create function public.answer_chore_reassignment(p_request_id uuid, p_action text)
returns table (outcome text, status text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.chore_reassignment_requests;
    v_occurrence private.chore_occurrences;
    v_manage boolean;
    v_valid boolean;
    v_user uuid;
  begin
    if p_request_id is null or p_action is null
       or p_action not in ('accept', 'decline', 'cancel', 'confirm', 'refuse') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_request from private.chore_reassignment_requests r where r.id = p_request_id;
    if not found then
      return query select 'not_found', null::text;
      return;
    end if;
    v_occurrence := private.lock_chore_occurrence(v_request.occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::text;
      return;
    end if;
    v_manage := private.can_manage_chores(v_request.home_id, v_user_id);
    select * into v_request from private.chore_reassignment_requests r where r.id = p_request_id for update;
    if not (v_manage or v_user_id in (v_request.requested_by, v_request.to_user, v_request.from_user)) then
      return query select 'not_found', null::text;
      return;
    end if;
    if (p_action in ('accept', 'decline') and v_request.to_user is distinct from v_user_id)
       or (p_action = 'cancel' and v_request.requested_by is distinct from v_user_id)
       or (p_action in ('confirm', 'refuse') and not v_manage) then
      return query select 'not_permitted', null::text;
      return;
    end if;
    if (p_action in ('accept', 'decline') and v_request.status <> 'pending')
       or (p_action = 'cancel' and v_request.status not in ('pending', 'awaiting_manager'))
       or (p_action in ('confirm', 'refuse') and v_request.status <> 'awaiting_manager') then
      return query select 'not_open', v_request.status;
      return;
    end if;

    if p_action in ('decline', 'cancel', 'refuse') then
      update private.chore_reassignment_requests r
        set status = case p_action when 'decline' then 'declined' when 'cancel' then 'cancelled' else 'refused' end,
          responded_at = case when p_action = 'decline' then pg_catalog.now() else r.responded_at end,
          decided_at = pg_catalog.now(), decided_by = v_user_id
        where r.id = v_request.id
        returning * into v_request;
      if p_action = 'decline' then
        perform private.notify_user(
          v_request.requested_by, v_request.home_id, 'chores', 'chore.reassignment_answered',
          pg_catalog.jsonb_build_object('homeId', v_request.home_id, 'occurrenceId', v_request.occurrence_id,
            'decision', 'declined'),
          'chore-reassignment-answered:' || v_request.id::text, true);
      elsif p_action = 'refuse' then
        foreach v_user in array array[v_request.requested_by, v_request.to_user] loop
          perform private.notify_user(
            v_user, v_request.home_id, 'chores', 'chore.reassignment_decided',
            pg_catalog.jsonb_build_object('homeId', v_request.home_id, 'occurrenceId', v_request.occurrence_id,
              'decision', 'refused'),
            'chore-reassignment-decided:' || v_request.id::text, true);
        end loop;
      end if;
      perform private.audit_chore('chore_reassignment.' || v_request.status, v_request.home_id,
        'chore_reassignment', v_request.id);
      return query select v_request.status, v_request.status;
      return;
    end if;

    -- accept or confirm: is the hand-over still possible?
    v_valid := v_occurrence.status = 'open'
      and exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_request.from_user)
      and v_request.to_user is not null and private.is_home_member(v_request.home_id, v_request.to_user)
      and not exists (select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_request.to_user);
    if not v_valid then
      perform private.invalidate_chore_request(v_request,
        case when v_occurrence.status <> 'open' then 'occurrence_closed' else 'assignment_changed' end);
      return query select 'invalidated', 'invalidated';
      return;
    end if;
    if p_action = 'accept' and (private.chore_settings(v_request.home_id)).reassignment_confirmation
       and not private.can_manage_chores(v_request.home_id, v_request.to_user) then
      update private.chore_reassignment_requests r
        set status = 'awaiting_manager', responded_at = pg_catalog.now()
        where r.id = v_request.id;
      perform private.notify_user(
        v_request.requested_by, v_request.home_id, 'chores', 'chore.reassignment_answered',
        pg_catalog.jsonb_build_object('homeId', v_request.home_id, 'occurrenceId', v_request.occurrence_id,
          'decision', 'awaiting_manager'),
        'chore-reassignment-answered:' || v_request.id::text, true);
      for v_user in
        select m.user_id from public.home_memberships m
        where m.home_id = v_request.home_id and m.user_id is distinct from v_request.to_user
          and m.user_id is distinct from v_request.requested_by
          and private.can_manage_chores(v_request.home_id, m.user_id)
        order by m.user_id
      loop
        perform private.notify_user(
          v_user, v_request.home_id, 'chores', 'chore.reassignment_confirmation_needed',
          pg_catalog.jsonb_build_object('homeId', v_request.home_id, 'occurrenceId', v_request.occurrence_id),
          'chore-reassignment-confirm:' || v_request.id::text, true);
      end loop;
      perform private.audit_chore('chore_reassignment.awaiting_manager', v_request.home_id,
        'chore_reassignment', v_request.id);
      return query select 'awaiting_manager', 'awaiting_manager';
      return;
    end if;
    perform private.transfer_chore_occurrence(v_request, v_user_id);
    if p_action = 'accept' then
      perform private.notify_user(
        v_request.requested_by, v_request.home_id, 'chores', 'chore.reassignment_answered',
        pg_catalog.jsonb_build_object('homeId', v_request.home_id, 'occurrenceId', v_request.occurrence_id,
          'decision', 'accepted'),
        'chore-reassignment-answered:' || v_request.id::text, true);
    else
      foreach v_user in array array[v_request.requested_by, v_request.to_user] loop
        perform private.notify_user(
          v_user, v_request.home_id, 'chores', 'chore.reassignment_decided',
          pg_catalog.jsonb_build_object('homeId', v_request.home_id, 'occurrenceId', v_request.occurrence_id,
            'decision', 'confirmed'),
          'chore-reassignment-decided:' || v_request.id::text, true);
      end loop;
    end if;
    return query select 'accepted', 'accepted';
  end
  $$;

-- The caller's open requests in a Home: those waiting for their answer ('incoming'), those they
-- made ('outgoing'), and for chore managers those waiting for confirmation ('confirm'). Newest
-- first, at most 50. 42501 for a Home the caller is not in.
create function public.list_chore_reassignment_requests(p_home_id uuid)
returns table (
  id uuid, occurrence_id uuid, title text, due_date date, status text, box text,
  from_me boolean, from_member uuid, to_me boolean, to_member uuid, note text, created_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_manage boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_manage := private.can_manage_chores(p_home_id, v_user_id);
    return query
      select r.id, r.occurrence_id, c.title, o.due_date, r.status,
        case when r.status = 'pending' and r.to_user = v_user_id then 'incoming'
          when r.requested_by = v_user_id then 'outgoing' else 'confirm' end,
        coalesce(r.from_user = v_user_id, false), private.member_ref(r.home_id, r.from_user),
        coalesce(r.to_user = v_user_id, false), private.member_ref(r.home_id, r.to_user),
        r.note, r.created_at
      from private.chore_reassignment_requests r
      join private.chore_occurrences o on o.id = r.occurrence_id
      join private.chores c on c.id = o.chore_id
      where r.home_id = p_home_id and r.status in ('pending', 'awaiting_manager')
        and o.deleted_at is null and c.deleted_at is null
        and ((r.status = 'pending' and r.to_user = v_user_id) or r.requested_by = v_user_id
          or (r.status = 'awaiting_manager' and v_manage))
      order by r.created_at desc
      limit 50;
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
      'advance_chores', 'complete_chore_occurrence', 'skip_chore_occurrence', 'reopen_chore_occurrence',
      'update_chore_series', 'claim_chore_occurrence', 'release_chore_occurrence', 'list_chore_pool',
      'get_chore_claim_state', 'get_chore_claim_policy', 'set_chore_claim_policy', 'get_chore_settings',
      'update_chore_settings', 'request_chore_reassignment', 'answer_chore_reassignment',
      'list_chore_reassignment_requests'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The release job: the service role only.
  execute 'revoke all on function public.release_overdue_chore_claim(uuid, integer) from public, anon, authenticated';
  execute 'grant execute on function public.release_overdue_chore_claim(uuid, integer) to service_role';

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%chore%'
      or p.proname in ('set_occurrence_assignees', 'home_zone')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
