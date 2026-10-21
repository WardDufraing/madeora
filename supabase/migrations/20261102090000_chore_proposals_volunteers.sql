-- S21b: member-proposed chores and targeted volunteer requests (brief plans/steps/S21-brief.md;
-- ADR 0027; spec "Confirmed member-proposed unassigned chores and manager approval", "Confirmed
-- targeted chore volunteer requests", "Confirmed minimal volunteer request details", "Confirmed
-- manager visibility of volunteer invitation responses", "Confirmed withdrawal of individual pending
-- volunteer invitations", "Confirmed adding recipients to active volunteer requests", "Confirmed
-- volunteer request expiration at chore due date", "Confirmed no reopening expired volunteer
-- requests" and "Confirmed manager correction of accepted volunteer assignments").
--
-- Proposals: any current member suggests a one-off unassigned chore. It is only a proposal: nothing
-- is scheduled, reserved or rewarded. A chore manager approves it (possibly revised) or rejects it
-- with a reason; the proposer may withdraw it while it waits. Approval publishes exactly one
-- unassigned one-off chore through create_chore, with the proposal's id as the chore's id, under the
-- proposal's row lock and at the revision the reviewer saw: two reviewers cannot publish twice, and
-- a retry finds it approved. Points come with S23.
--
-- Volunteer requests: for an open occurrence in Needs assignment review (flagged, nobody assigned) a
-- chore manager invites selected current members. While the request is open the occurrence shows
-- Awaiting volunteer and stays out of the pool (flagged occurrences are never claimable). The first
-- valid acceptance wins under the chore lock; the other invitations close. The request expires at
-- the end of the due day in the Home's timezone (chores are date-only); an acceptance at or after
-- that moment is refused even before anything marked it expired. An expired request is never
-- reopened. Invitees see the chore and their own invitation only; managers see every invitation.

-- Notifications: the new chore kinds use the S21 category 'chores'; nothing to change here.

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request'
  ));

alter table private.chore_occurrence_events drop constraint chore_occurrence_events_kind_check;
alter table private.chore_occurrence_events add constraint chore_occurrence_events_kind_check
  check (kind in ('completed', 'skipped', 'reopened', 'submitted', 'approved', 'rejected',
    'withdrawn', 'corrected', 'claimed', 'released', 'expired', 'reassigned', 'volunteered',
    'assignment_corrected'));
-- For 'volunteered': contributor_id the member who accepted. For 'assignment_corrected':
-- previous_contributor_id the volunteer, contributor_id the new assignee (null: back to review) and
-- reason the manager's reason.

create function private.chore_volunteer_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'pending_proposals' then 100      -- proposals waiting for review per Home
    when 'own_pending' then 20             -- of them by one member
    when 'proposal_days' then 365          -- how far ahead a proposed due day may be
    when 'proposals_page' then 100
    when 'recipients' then 20              -- invitations one request holds
    when 'requests' then 10                -- volunteer requests one occurrence read returns
  end;
  $$;

-- Tables -------------------------------------------------------------------------------------------------

create table private.chore_proposals (
  id uuid primary key,
  home_id uuid not null references public.homes (id) on delete cascade,
  proposed_by uuid references auth.users (id) on delete set null,
  title text not null constraint chore_proposals_title_check check (private.is_visible_name(title, 200)),
  instructions text constraint chore_proposals_instructions_check
    check (instructions is null or private.is_plain_text(instructions, 2000)),
  category_id uuid,
  estimated_minutes integer constraint chore_proposals_minutes_check check (estimated_minutes between 1 and 1440),
  -- The checklist as create_chore takes it: [{"label": text, "mandatory": boolean}].
  steps jsonb not null default '[]'::jsonb,
  due_date date not null,
  status text not null default 'pending' constraint chore_proposals_status_check
    check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  -- The reviewer's reason for a rejection, shown to the proposer.
  feedback text constraint chore_proposals_feedback_check
    check (feedback is null or private.is_plain_text(feedback, 500)),
  -- Changed by the reviewer before approving.
  revised boolean not null default false,
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  revision integer not null default 1 constraint chore_proposals_revision_check check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chore_proposals_category_fkey foreign key (category_id)
    references private.chore_categories (id) on delete set null,
  constraint chore_proposals_state_check check (
    (status = 'pending') = (decided_at is null)
    and (status = 'rejected') = (feedback is not null))
);

create index chore_proposals_home_idx on private.chore_proposals (home_id, created_at desc);
create index chore_proposals_pending_idx on private.chore_proposals (home_id, proposed_by)
  where status = 'pending';

create table private.chore_volunteer_requests (
  id uuid primary key,
  home_id uuid not null,
  occurrence_id uuid not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- open; accepted (by accepted_by); cancelled by a manager; resolved (the occurrence was assigned,
  -- closed or deleted some other way); closed (nobody left to answer); expired (its deadline passed).
  status text not null default 'open' constraint chore_volunteer_requests_status_check
    check (status in ('open', 'accepted', 'cancelled', 'resolved', 'closed', 'expired')),
  accepted_by uuid references auth.users (id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  foreign key (occurrence_id, home_id) references private.chore_occurrences (id, home_id) on delete cascade,
  constraint chore_volunteer_requests_state_check check ((status = 'open') = (closed_at is null))
);

-- One open request per occurrence (spec: no duplicate requests).
create unique index chore_volunteer_requests_one_open on private.chore_volunteer_requests (occurrence_id)
  where status = 'open';
create index chore_volunteer_requests_home_idx on private.chore_volunteer_requests (home_id, created_at desc);
create index chore_volunteer_requests_occurrence_idx on private.chore_volunteer_requests (occurrence_id, created_at desc);

create table private.chore_volunteer_invitations (
  request_id uuid not null references private.chore_volunteer_requests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  home_id uuid not null,
  invited_by uuid references auth.users (id) on delete set null,
  invited_at timestamptz not null default now(),
  -- pending; accepted; declined; withdrawn by a manager; expired at the deadline; closed (someone else
  -- accepted, the request was cancelled or resolved, or the member left).
  status text not null default 'pending' constraint chore_volunteer_invitations_status_check
    check (status in ('pending', 'accepted', 'declined', 'withdrawn', 'expired', 'closed')),
  responded_at timestamptz,
  withdrawn_by uuid references auth.users (id) on delete set null,
  primary key (request_id, user_id),
  constraint chore_volunteer_invitations_state_check check ((status = 'pending') = (responded_at is null))
);

create index chore_volunteer_invitations_user_idx on private.chore_volunteer_invitations (home_id, user_id)
  where status = 'pending';

alter table private.chore_proposals enable row level security;
alter table private.chore_volunteer_requests enable row level security;
alter table private.chore_volunteer_invitations enable row level security;
revoke all on table private.chore_proposals, private.chore_volunteer_requests,
  private.chore_volunteer_invitations from public, anon, authenticated;

comment on table private.chore_proposals is 'S21: chores members propose. Not exposed through the API.';
comment on table private.chore_volunteer_requests is 'S21: volunteer requests. Not exposed through the API.';

-- The Realtime signal follows proposals and volunteer requests too (they change what pages show).
create constraint trigger chore_proposals_signal after insert or update on private.chore_proposals
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger chore_volunteer_requests_signal after insert or update on private.chore_volunteer_requests
  deferrable initially deferred for each row execute function private.bump_chore_signal();
create constraint trigger chore_volunteer_invitations_signal after insert or update on private.chore_volunteer_invitations
  deferrable initially deferred for each row execute function private.bump_chore_signal();

-- Volunteer request helpers --------------------------------------------------------------------------------

-- When a request for the occurrence expires: the end of its due day in the Home's timezone. Computed,
-- never stored, so a changed due date moves it.
create function private.chore_volunteer_deadline(p_occurrence private.chore_occurrences) returns timestamptz
  language sql stable security definer set search_path = '' as $$
  select (p_occurrence.due_date + 1)::timestamp at time zone coalesce(private.home_zone(p_occurrence.home_id), 'UTC');
  $$;

-- Whether an occurrence is in Needs assignment review: open, flagged, nobody assigned.
create function private.chore_in_review(p_occurrence private.chore_occurrences) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_occurrence.status = 'open' and p_occurrence.deleted_at is null
    and p_occurrence.needs_reassignment
    and not exists (select 1 from private.chore_occurrence_assignees a where a.occurrence_id = p_occurrence.id),
    false);
  $$;

-- Ends an open request: the request takes p_status, its pending invitations p_invitation_status.
create function private.end_chore_volunteer_request(
  p_request_id uuid, p_status text, p_invitation_status text, p_actor uuid
) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.chore_volunteer_requests r
      set status = p_status, closed_at = pg_catalog.now(), closed_by = p_actor
      where r.id = p_request_id and r.status = 'open';
    if not found then
      return;
    end if;
    update private.chore_volunteer_invitations i
      set status = p_invitation_status, responded_at = pg_catalog.now()
      where i.request_id = p_request_id and i.status = 'pending';
  end
  $$;

-- Closes an open request nobody can answer any more (every invitation answered, withdrawn or closed,
-- none accepted). The occurrence stays in review.
create function private.close_unanswerable_volunteer_request(p_request_id uuid, p_actor uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if exists (select 1 from private.chore_volunteer_invitations i
        where i.request_id = p_request_id and i.status = 'pending') then
      return false;
    end if;
    perform private.end_chore_volunteer_request(p_request_id, 'closed', 'closed', p_actor);
    return true;
  end
  $$;

-- Expires an open request whose deadline has passed (the occurrence's chore locked by the caller).
create function private.expire_chore_volunteer_requests(p_occurrence private.chore_occurrences) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_request uuid;
  begin
    if private.chore_volunteer_deadline(p_occurrence) > pg_catalog.now() then
      return;
    end if;
    for v_request in
      select r.id from private.chore_volunteer_requests r
      where r.occurrence_id = p_occurrence.id and r.status = 'open'
    loop
      perform private.end_chore_volunteer_request(v_request, 'expired', 'expired', null);
    end loop;
  end
  $$;

-- Member users from membership ids for invitations: current members of the Home, distinct, 1–20.
-- Null when one is not a current member.
create function private.chore_volunteer_users(p_home_id uuid, p_member_ids uuid[]) returns uuid[]
  language sql stable security definer set search_path = '' as $$
  select case when cardinality(coalesce(p_member_ids, '{}')) between 1 and private.chore_volunteer_limit('recipients')
    then private.chore_member_users(p_home_id, p_member_ids) end;
  $$;

-- Triggers: requests follow the occurrence and the members ----------------------------------------------

-- Someone assigned to an occurrence some other way (a manager, a rotation change) resolves its open
-- request. An acceptance marks the request accepted before assigning, so it finds nothing open.
create function private.chore_volunteer_assigned() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request uuid;
  begin
    for v_request in
      select r.id from private.chore_volunteer_requests r
      where r.occurrence_id = new.occurrence_id and r.status = 'open'
    loop
      perform private.end_chore_volunteer_request(v_request, 'resolved', 'closed', null);
    end loop;
    return null;
  end
  $$;

create trigger chore_occurrence_assignees_volunteer after insert on private.chore_occurrence_assignees
  for each row execute function private.chore_volunteer_assigned();

-- An occurrence that closes (completed, submitted, skipped, expired, in the trash) resolves its open
-- request; a due date moved into the past expires it.
create function private.chore_volunteer_occurrence_changed() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request uuid;
  begin
    if new.status <> 'open' or new.deleted_at is not null then
      for v_request in
        select r.id from private.chore_volunteer_requests r
        where r.occurrence_id = new.id and r.status = 'open'
      loop
        perform private.end_chore_volunteer_request(v_request, 'resolved', 'closed', null);
      end loop;
    elsif new.due_date is distinct from old.due_date then
      perform private.expire_chore_volunteer_requests(new);
    end if;
    return null;
  end
  $$;

create trigger chore_occurrences_volunteer after update of status, deleted_at, due_date on private.chore_occurrences
  for each row execute function private.chore_volunteer_occurrence_changed();

-- A departing member: their pending invitations close (a request left with nobody to answer closes)
-- and their pending proposals are withdrawn.
create function private.chore_volunteer_member_left() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request uuid;
  begin
    for v_request in
      update private.chore_volunteer_invitations i
        set status = 'closed', responded_at = pg_catalog.now()
        where i.home_id = old.home_id and i.user_id = old.user_id and i.status = 'pending'
        returning i.request_id
    loop
      perform private.close_unanswerable_volunteer_request(v_request, null);
    end loop;
    update private.chore_proposals p
      set status = 'withdrawn', decided_at = pg_catalog.now(), revision = p.revision + 1,
        updated_at = pg_catalog.now()
      where p.home_id = old.home_id and p.proposed_by = old.user_id and p.status = 'pending';
    return old;
  end
  $$;

create trigger home_memberships_chore_volunteers before delete on public.home_memberships
  for each row execute function private.chore_volunteer_member_left();

-- advance_chores also expires volunteer requests whose deadline passed ----------------------------------

alter function public.advance_chores(uuid) set schema private;
alter function private.advance_chores(uuid) rename to advance_chores_before_volunteers;

create function public.advance_chores(p_home_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_created integer := private.advance_chores_before_volunteers(p_home_id);
    v_item record;
    v_occurrence private.chore_occurrences;
  begin
    for v_item in
      select o.id, o.chore_id from private.chore_volunteer_requests r
      join private.chore_occurrences o on o.id = r.occurrence_id
      where r.home_id = p_home_id and r.status = 'open'
        and private.chore_volunteer_deadline(o) <= pg_catalog.now()
      order by o.chore_id, o.id
      limit private.chore_pool_limit('process')
    loop
      perform 1 from private.chores c where c.id = v_item.chore_id for update;
      select * into v_occurrence from private.chore_occurrences o where o.id = v_item.id for update;
      perform private.expire_chore_volunteer_requests(v_occurrence);
    end loop;
    return v_created;
  end
  $$;

-- Proposals ------------------------------------------------------------------------------------------------

-- Whether a proposed due day is acceptable: today (Home) up to a year ahead.
create function private.valid_proposal_date(p_home_id uuid, p_due_date date) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(p_due_date between private.task_today(p_home_id, null)
    and private.task_today(p_home_id, null) + private.chore_volunteer_limit('proposal_days'), false);
  $$;

-- Proposes a chore (any current member). p_id is the client's id, so a retry answers 'exists'.
-- Outcomes: 'proposed', 'exists', 'id_taken', 'duplicate' (the caller already proposes a chore with
-- that title), 'invalid_category', 'invalid_date', 'limit_reached'. 22023 for malformed fields.
create function public.propose_chore(
  p_id uuid, p_home_id uuid, p_title text, p_due_date date, p_steps jsonb default '[]'::jsonb,
  p_instructions text default null, p_category_id uuid default null, p_minutes integer default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.chore_proposals;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_due_date is null
       or not private.valid_chore_fields(p_title, p_instructions, p_minutes) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    perform 1 from private.chore_steps(coalesce(p_steps, '[]'::jsonb)) s where s.step_id is not null;
    if found then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_existing from private.chore_proposals p where p.id = p_id;
    if found then
      return query select case when v_existing.proposed_by = v_user_id and v_existing.home_id = p_home_id
        then 'exists' else 'id_taken' end, null::integer;
      return;
    end if;
    if not private.usable_chore_category(p_home_id, p_category_id) then
      return query select 'invalid_category', null::integer;
      return;
    end if;
    if not private.valid_proposal_date(p_home_id, p_due_date) then
      return query select 'invalid_date', null::integer;
      return;
    end if;
    perform private.lock_chore_home('proposals', p_home_id);
    if exists (select 1 from private.chore_proposals p
        where p.home_id = p_home_id and p.proposed_by = v_user_id and p.status = 'pending'
          and private.task_name_key(p.title) = private.task_name_key(p_title)) then
      return query select 'duplicate', null::integer;
      return;
    end if;
    if (select count(*) from private.chore_proposals p where p.home_id = p_home_id and p.status = 'pending')
         >= private.chore_volunteer_limit('pending_proposals')
       or (select count(*) from private.chore_proposals p
           where p.home_id = p_home_id and p.status = 'pending' and p.proposed_by = v_user_id)
         >= private.chore_volunteer_limit('own_pending') then
      return query select 'limit_reached', null::integer;
      return;
    end if;
    insert into private.chore_proposals (
      id, home_id, proposed_by, title, instructions, category_id, estimated_minutes, steps, due_date
    ) values (p_id, p_home_id, v_user_id, p_title, p_instructions, p_category_id, p_minutes,
      coalesce(p_steps, '[]'::jsonb), p_due_date);
    perform private.audit_chore('chore_proposal.submitted', p_home_id, 'chore_proposal', p_id);
    return query select 'proposed', 1;
  end
  $$;

-- Withdraws the caller's own waiting proposal. Outcomes: 'withdrawn', 'not_open' (with its status),
-- 'conflict', 'not_permitted', 'not_found'.
create function public.withdraw_chore_proposal(p_id uuid, p_expected_revision integer)
returns table (outcome text, status text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_proposal private.chore_proposals;
  begin
    if p_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_proposal from private.chore_proposals p where p.id = p_id for update;
    if not found or not private.is_home_member(v_proposal.home_id, v_user_id) then
      return query select 'not_found', null::text, null::integer;
      return;
    end if;
    if v_proposal.proposed_by is distinct from v_user_id then
      return query select 'not_permitted', null::text, null::integer;
      return;
    end if;
    if v_proposal.status <> 'pending' then
      return query select case when v_proposal.status = 'withdrawn' then 'withdrawn' else 'not_open' end,
        v_proposal.status, v_proposal.revision;
      return;
    end if;
    if v_proposal.revision <> p_expected_revision then
      return query select 'conflict', v_proposal.status, v_proposal.revision;
      return;
    end if;
    update private.chore_proposals p
      set status = 'withdrawn', decided_at = pg_catalog.now(), decided_by = v_user_id,
        revision = p.revision + 1, updated_at = pg_catalog.now()
      where p.id = p_id
      returning * into v_proposal;
    perform private.audit_chore('chore_proposal.withdrawn', v_proposal.home_id, 'chore_proposal', p_id);
    return query select 'withdrawn', v_proposal.status, v_proposal.revision;
  end
  $$;

-- A chore manager's decision on a waiting proposal, at the revision they saw.
--   'approve': publishes it with the given final fields (title, due day, checklist, instructions,
--     category, estimate; the reviewer saw and confirmed them) as one unassigned one-off chore whose
--     id is the proposal's. A reviewer may approve their own proposal: they hold the right.
--   'reject': with a reason (1–500), shown to the proposer.
-- The proposer is told either way. Outcomes: 'approved' (with occurrence_id), 'rejected',
-- 'not_open' (decided already; with its status), 'conflict', 'invalid_category', 'invalid_date',
-- 'limit_reached', 'not_permitted', 'not_found'.
create function public.review_chore_proposal(
  p_id uuid, p_expected_revision integer, p_decision text, p_reason text default null,
  p_title text default null, p_due_date date default null, p_steps jsonb default null,
  p_instructions text default null, p_category_id uuid default null, p_minutes integer default null
) returns table (outcome text, status text, occurrence_id uuid, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_proposal private.chore_proposals;
    v_reason text := private.chore_short_text(p_reason);
    v_created record;
    v_occurrence uuid;
    v_revised boolean;
  begin
    if p_id is null or p_expected_revision is null or p_decision is null
       or p_decision not in ('approve', 'reject')
       or (p_decision = 'reject' and (v_reason is null
         or pg_catalog.char_length(v_reason) > private.chore_limit('reason')))
       or (p_decision = 'approve' and (p_due_date is null
         or not private.valid_chore_fields(p_title, p_instructions, p_minutes) or p_steps is null)) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_decision = 'approve' then
      perform 1 from private.chore_steps(p_steps) s where s.step_id is not null;
      if found then
        raise exception 'invalid request' using errcode = '22023';
      end if;
    end if;
    select * into v_proposal from private.chore_proposals p where p.id = p_id for update;
    if not found or not private.is_home_member(v_proposal.home_id, v_user_id) then
      return query select 'not_found', null::text, null::uuid, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_proposal.home_id, v_user_id) then
      return query select 'not_permitted', null::text, null::uuid, null::integer;
      return;
    end if;
    if v_proposal.status <> 'pending' then
      return query select 'not_open', v_proposal.status,
        (select o.id from private.chore_occurrences o where o.chore_id = v_proposal.id
          order by o.scheduled_date limit 1),
        v_proposal.revision;
      return;
    end if;
    if v_proposal.revision <> p_expected_revision then
      return query select 'conflict', v_proposal.status, null::uuid, v_proposal.revision;
      return;
    end if;
    if p_decision = 'reject' then
      update private.chore_proposals p
        set status = 'rejected', feedback = v_reason, decided_at = pg_catalog.now(),
          decided_by = v_user_id, revision = p.revision + 1, updated_at = pg_catalog.now()
        where p.id = p_id
        returning * into v_proposal;
    else
      if not private.usable_chore_category(v_proposal.home_id, p_category_id) then
        return query select 'invalid_category', v_proposal.status, null::uuid, v_proposal.revision;
        return;
      end if;
      if not private.valid_proposal_date(v_proposal.home_id, p_due_date) then
        return query select 'invalid_date', v_proposal.status, null::uuid, v_proposal.revision;
        return;
      end if;
      select * into v_created from public.create_chore(
        v_proposal.id, v_proposal.home_id, p_title,
        pg_catalog.jsonb_build_object('mode', 'none', 'members', pg_catalog.jsonb_build_array()),
        p_steps, p_instructions, p_category_id, p_minutes, p_due_date) c;
      if v_created.outcome <> 'created' then
        return query select case when v_created.outcome = 'limit_reached' then 'limit_reached'
            when v_created.outcome = 'invalid_category' then 'invalid_category' else 'conflict' end,
          v_proposal.status, null::uuid, v_proposal.revision;
        return;
      end if;
      v_occurrence := v_created.occurrence_id;
      v_revised := p_title is distinct from v_proposal.title or p_due_date is distinct from v_proposal.due_date
        or p_steps is distinct from v_proposal.steps or p_instructions is distinct from v_proposal.instructions
        or p_category_id is distinct from v_proposal.category_id
        or p_minutes is distinct from v_proposal.estimated_minutes;
      update private.chore_proposals p
        set status = 'approved', title = p_title, due_date = p_due_date, steps = p_steps,
          instructions = p_instructions, category_id = p_category_id, estimated_minutes = p_minutes,
          revised = v_revised, decided_at = pg_catalog.now(), decided_by = v_user_id,
          revision = p.revision + 1, updated_at = pg_catalog.now()
        where p.id = p_id
        returning * into v_proposal;
    end if;
    if v_proposal.proposed_by is not null and v_proposal.proposed_by <> v_user_id then
      perform private.notify_user(
        v_proposal.proposed_by, v_proposal.home_id, 'chores', 'chore.proposal_decided',
        pg_catalog.jsonb_build_object('homeId', v_proposal.home_id,
          'decision', case when p_decision = 'approve' then 'approved' else 'rejected' end),
        'chore-proposal-decided:' || v_proposal.id::text, true);
    end if;
    perform private.audit_chore('chore_proposal.' || v_proposal.status, v_proposal.home_id, 'chore_proposal',
      v_proposal.id, pg_catalog.jsonb_build_object('revised', v_proposal.revised));
    return query select v_proposal.status, v_proposal.status, v_occurrence, v_proposal.revision;
  end
  $$;

-- The proposals the caller may see in a Home: chore managers every waiting one and those decided in
-- the last 30 days; anyone else their own (any state, last 30 days for decided ones). Waiting first,
-- then newest first. possibleDuplicate (managers): another waiting proposal or an open chore of the
-- Home has the same title.
create function public.list_chore_proposals(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_manage boolean;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_manage := private.can_manage_chores(p_home_id, v_user_id);
    return pg_catalog.jsonb_build_object(
      'canReview', v_manage,
      'proposals', coalesce((select pg_catalog.jsonb_agg(x.item order by x.waiting desc, x.created_at desc) from (
        select p.status = 'pending' as waiting, p.created_at, pg_catalog.jsonb_build_object(
          'id', p.id, 'status', p.status, 'title', p.title, 'instructions', p.instructions,
          'category', case when g.id is not null then pg_catalog.jsonb_build_object(
            'id', g.id, 'name', g.name, 'color', g.color) end,
          'minutes', p.estimated_minutes, 'steps', p.steps, 'dueDate', p.due_date,
          'feedback', p.feedback, 'revised', p.revised,
          'by', private.chore_person(p.home_id, p.proposed_by, v_user_id),
          'createdAt', p.created_at, 'decidedAt', p.decided_at,
          'decidedBy', private.chore_person(p.home_id, p.decided_by, v_user_id),
          'revision', p.revision,
          'occurrenceId', case when p.status = 'approved' then (select o.id from private.chore_occurrences o
            where o.chore_id = p.id and o.deleted_at is null order by o.scheduled_date limit 1) end,
          'canWithdraw', p.status = 'pending' and p.proposed_by = v_user_id,
          'canReview', p.status = 'pending' and v_manage,
          'possibleDuplicate', v_manage and p.status = 'pending' and (
            exists (select 1 from private.chore_proposals q
              where q.home_id = p.home_id and q.id <> p.id and q.status = 'pending'
                and private.task_name_key(q.title) = private.task_name_key(p.title))
            or exists (select 1 from private.chores c
              where c.home_id = p.home_id and c.deleted_at is null and c.ended_at is null
                and private.task_name_key(c.title) = private.task_name_key(p.title)
                and exists (select 1 from private.chore_occurrences o
                  where o.chore_id = c.id and o.status = 'open' and o.deleted_at is null)))) as item
        from private.chore_proposals p
        left join private.chore_categories g on g.id = p.category_id
        where p.home_id = p_home_id
          and (v_manage or p.proposed_by = v_user_id)
          and (p.status = 'pending' or p.decided_at > pg_catalog.now() - interval '30 days')
        order by p.status = 'pending' desc, p.created_at desc
        limit private.chore_volunteer_limit('proposals_page')) x), '[]'::jsonb),
      'pendingCount', case when v_manage then (select count(*) from private.chore_proposals p
        where p.home_id = p_home_id and p.status = 'pending') end);
  end
  $$;

-- Volunteer requests -----------------------------------------------------------------------------------------

-- Sends a volunteer request for an occurrence in review (chore managers) to 1–20 current members
-- (membership ids), at the occurrence revision the manager saw. p_dry_run: the preview (deadline,
-- each recipient). Outcomes: 'preview', 'sent', 'exists' (a retry with the same id), 'id_taken',
-- 'request_open', 'not_in_review', 'deadline_passed', 'invalid_recipient', 'conflict',
-- 'not_permitted', 'not_found'.
create function public.create_chore_volunteer_request(
  p_id uuid, p_occurrence_id uuid, p_expected_revision integer, p_member_ids uuid[], p_dry_run boolean
) returns table (outcome text, deadline timestamptz, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_users uuid[];
    v_deadline timestamptz;
    v_user uuid;
  begin
    if p_id is null or p_occurrence_id is null or p_expected_revision is null or p_dry_run is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::timestamptz, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::timestamptz, null::integer;
      return;
    end if;
    if exists (select 1 from private.chore_volunteer_requests r where r.id = p_id) then
      return query select case when exists (select 1 from private.chore_volunteer_requests r
          where r.id = p_id and r.occurrence_id = p_occurrence_id and r.created_by = v_user_id)
        then 'exists' else 'id_taken' end, null::timestamptz, v_occurrence.revision;
      return;
    end if;
    perform private.expire_chore_volunteer_requests(v_occurrence);
    v_deadline := private.chore_volunteer_deadline(v_occurrence);
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', v_deadline, v_occurrence.revision;
      return;
    end if;
    if not private.chore_in_review(v_occurrence) then
      return query select 'not_in_review', v_deadline, v_occurrence.revision;
      return;
    end if;
    if exists (select 1 from private.chore_volunteer_requests r
        where r.occurrence_id = v_occurrence.id and r.status = 'open') then
      return query select 'request_open', v_deadline, v_occurrence.revision;
      return;
    end if;
    if v_deadline <= pg_catalog.now() then
      return query select 'deadline_passed', v_deadline, v_occurrence.revision;
      return;
    end if;
    v_users := private.chore_volunteer_users(v_occurrence.home_id, p_member_ids);
    if v_users is null then
      return query select 'invalid_recipient', v_deadline, v_occurrence.revision;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_deadline, v_occurrence.revision;
      return;
    end if;
    insert into private.chore_volunteer_requests (id, home_id, occurrence_id, created_by)
      values (p_id, v_occurrence.home_id, v_occurrence.id, v_user_id);
    foreach v_user in array v_users loop
      insert into private.chore_volunteer_invitations (request_id, user_id, home_id, invited_by)
        values (p_id, v_user, v_occurrence.home_id, v_user_id);
      perform private.notify_user(
        v_user, v_occurrence.home_id, 'chores', 'chore.volunteer_invited',
        pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id),
        'chore-volunteer-invited:' || p_id::text || ':' || v_user::text, true);
    end loop;
    perform private.audit_chore('chore_volunteer_request.sent', v_occurrence.home_id,
      'chore_volunteer_request', p_id, pg_catalog.jsonb_build_object('recipients', cardinality(v_users)));
    return query select 'sent', v_deadline, v_occurrence.revision;
  end
  $$;

-- An invitee's answer. 'accept': the first valid acceptance wins under the chore lock (the
-- request open, the invitation pending, the deadline not reached, the occurrence still in review);
-- the accepter becomes its only assignee and the other invitations close. 'decline': no reason, no
-- penalty. Outcomes: 'accepted', 'declined', 'not_open' (with the invitation's status: someone else
-- accepted, it was withdrawn, closed or expired), 'expired' (the deadline passed), 'not_invited'.
create function public.answer_chore_volunteer_invitation(p_request_id uuid, p_action text)
returns table (outcome text, status text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.chore_volunteer_requests;
    v_invitation private.chore_volunteer_invitations;
    v_occurrence private.chore_occurrences;
  begin
    if p_request_id is null or p_action is null or p_action not in ('accept', 'decline') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_request from private.chore_volunteer_requests r where r.id = p_request_id;
    if not found then
      return query select 'not_invited', null::text;
      return;
    end if;
    v_occurrence := private.lock_chore_occurrence(v_request.occurrence_id, v_user_id);
    select * into v_invitation from private.chore_volunteer_invitations i
      where i.request_id = p_request_id and i.user_id = v_user_id for update;
    if v_occurrence.id is null or v_invitation.request_id is null then
      return query select 'not_invited', null::text;
      return;
    end if;
    select * into v_request from private.chore_volunteer_requests r where r.id = p_request_id for update;
    perform private.expire_chore_volunteer_requests(v_occurrence);
    select * into v_invitation from private.chore_volunteer_invitations i
      where i.request_id = p_request_id and i.user_id = v_user_id;
    if v_invitation.status = 'expired' then
      return query select 'expired', v_invitation.status;
      return;
    end if;
    if v_invitation.status <> 'pending' then
      return query select case
          when v_invitation.status = 'accepted' and p_action = 'accept' then 'accepted'
          when v_invitation.status = 'declined' and p_action = 'decline' then 'declined'
          else 'not_open' end, v_invitation.status;
      return;
    end if;
    if p_action = 'decline' then
      update private.chore_volunteer_invitations i
        set status = 'declined', responded_at = pg_catalog.now()
        where i.request_id = p_request_id and i.user_id = v_user_id;
      perform private.close_unanswerable_volunteer_request(p_request_id, null);
      return query select 'declined', 'declined';
      return;
    end if;
    if not private.chore_in_review(v_occurrence) then
      -- Resolved some other way in the meantime (the triggers normally closed it already).
      perform private.end_chore_volunteer_request(p_request_id, 'resolved', 'closed', null);
      return query select 'not_open', 'closed';
      return;
    end if;
    update private.chore_volunteer_invitations i
      set status = 'accepted', responded_at = pg_catalog.now()
      where i.request_id = p_request_id and i.user_id = v_user_id;
    update private.chore_volunteer_requests r
      set status = 'accepted', accepted_by = v_user_id, closed_at = pg_catalog.now(), closed_by = v_user_id
      where r.id = p_request_id;
    update private.chore_volunteer_invitations i
      set status = 'closed', responded_at = pg_catalog.now()
      where i.request_id = p_request_id and i.status = 'pending';
    insert into private.chore_occurrence_assignees (occurrence_id, home_id, user_id)
      values (v_occurrence.id, v_occurrence.home_id, v_user_id);
    update private.chore_occurrences o
      set needs_reassignment = false, revision = o.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where o.id = v_occurrence.id;
    insert into private.chore_occurrence_events (occurrence_id, kind, actor_id, contributor_id)
      values (v_occurrence.id, 'volunteered', v_user_id, v_user_id);
    if v_request.created_by is not null and v_request.created_by <> v_user_id
       and private.can_manage_chores(v_occurrence.home_id, v_request.created_by) then
      perform private.notify_user(
        v_request.created_by, v_occurrence.home_id, 'chores', 'chore.volunteer_accepted',
        pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id),
        'chore-volunteer-accepted:' || p_request_id::text, true);
    end if;
    perform private.audit_chore('chore_volunteer_request.accepted', v_occurrence.home_id,
      'chore_volunteer_request', p_request_id);
    return query select 'accepted', 'accepted';
  end
  $$;

-- A chore manager's change to an open request:
--   'withdraw' the pending invitations of p_member_ids (others stay open; with none left it closes),
--   'add' new recipients (current members never invited on this request; the same deadline, which
--     must still be ahead), 'cancel' the request (pending invitations close).
-- Outcomes: 'withdrawn' (closed: whether the request closed), 'added' (skipped: membership ids not
-- added because they were invited before), 'cancelled', 'not_open' (with its status),
-- 'deadline_passed', 'invalid_recipient', 'not_permitted', 'not_found'.
create function public.change_chore_volunteer_request(
  p_request_id uuid, p_action text, p_member_ids uuid[] default null
) returns table (outcome text, status text, closed boolean, skipped uuid[])
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.chore_volunteer_requests;
    v_occurrence private.chore_occurrences;
    v_users uuid[];
    v_user uuid;
    v_skipped uuid[] := '{}';
    v_closed boolean := false;
  begin
    if p_request_id is null or p_action is null or p_action not in ('withdraw', 'add', 'cancel')
       or (p_action <> 'cancel' and cardinality(coalesce(p_member_ids, '{}')) = 0) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_request from private.chore_volunteer_requests r where r.id = p_request_id;
    if not found then
      return query select 'not_found', null::text, false, null::uuid[];
      return;
    end if;
    v_occurrence := private.lock_chore_occurrence(v_request.occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::text, false, null::uuid[];
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::text, false, null::uuid[];
      return;
    end if;
    perform private.expire_chore_volunteer_requests(v_occurrence);
    select * into v_request from private.chore_volunteer_requests r where r.id = p_request_id for update;
    if v_request.status <> 'open' then
      return query select case when v_request.status = 'cancelled' and p_action = 'cancel'
        then 'cancelled' else 'not_open' end, v_request.status, true, null::uuid[];
      return;
    end if;
    if p_action = 'cancel' then
      perform private.end_chore_volunteer_request(p_request_id, 'cancelled', 'closed', v_user_id);
      perform private.audit_chore('chore_volunteer_request.cancelled', v_occurrence.home_id,
        'chore_volunteer_request', p_request_id);
      return query select 'cancelled', 'cancelled', true, null::uuid[];
      return;
    end if;
    v_users := private.chore_member_users(v_occurrence.home_id, p_member_ids);
    if v_users is null then
      return query select 'invalid_recipient', v_request.status, false, null::uuid[];
      return;
    end if;
    if p_action = 'withdraw' then
      update private.chore_volunteer_invitations i
        set status = 'withdrawn', responded_at = pg_catalog.now(), withdrawn_by = v_user_id
        where i.request_id = p_request_id and i.status = 'pending' and i.user_id = any (v_users);
      v_closed := private.close_unanswerable_volunteer_request(p_request_id, v_user_id);
      perform private.audit_chore('chore_volunteer_request.withdrawn', v_occurrence.home_id,
        'chore_volunteer_request', p_request_id,
        pg_catalog.jsonb_build_object('recipients', cardinality(v_users)));
      return query select 'withdrawn', case when v_closed then 'closed' else 'open' end, v_closed, null::uuid[];
      return;
    end if;
    if private.chore_volunteer_deadline(v_occurrence) <= pg_catalog.now() then
      return query select 'deadline_passed', v_request.status, false, null::uuid[];
      return;
    end if;
    if (select count(*) from private.chore_volunteer_invitations i where i.request_id = p_request_id)
       + cardinality(v_users) > private.chore_volunteer_limit('recipients') then
      return query select 'invalid_recipient', v_request.status, false, null::uuid[];
      return;
    end if;
    foreach v_user in array v_users loop
      insert into private.chore_volunteer_invitations (request_id, user_id, home_id, invited_by)
        values (p_request_id, v_user, v_occurrence.home_id, v_user_id)
        on conflict do nothing;
      if found then
        perform private.notify_user(
          v_user, v_occurrence.home_id, 'chores', 'chore.volunteer_invited',
          pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id),
          'chore-volunteer-invited:' || p_request_id::text || ':' || v_user::text, true);
      else
        v_skipped := v_skipped || private.member_ref(v_occurrence.home_id, v_user);
      end if;
    end loop;
    perform private.audit_chore('chore_volunteer_request.added', v_occurrence.home_id,
      'chore_volunteer_request', p_request_id,
      pg_catalog.jsonb_build_object('recipients', cardinality(v_users) - cardinality(v_skipped)));
    return query select 'added', 'open', false, v_skipped;
  end
  $$;

-- Corrects an accepted volunteer assignment (chore managers), before submission, with a reason:
-- back to Needs assignment review (p_member_id null) or to another current member. The accepted
-- invitation stays accepted; an 'assignment_corrected' event records it. p_dry_run: the preview.
-- Outcomes: 'preview', 'corrected', 'not_volunteered' (no accepted request whose volunteer is still
-- the assignee), 'pending_approval', 'occurrence_closed', 'invalid_assignee', 'conflict',
-- 'not_permitted', 'not_found'.
create function public.correct_chore_volunteer_assignment(
  p_occurrence_id uuid, p_expected_revision integer, p_reason text, p_dry_run boolean,
  p_member_id uuid default null
) returns table (outcome text, volunteer_member uuid, overdue boolean, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_request private.chore_volunteer_requests;
    v_reason text := private.chore_short_text(p_reason);
    v_to uuid;
    v_overdue boolean;
  begin
    if p_occurrence_id is null or p_expected_revision is null or p_dry_run is null
       or v_reason is null or pg_catalog.char_length(v_reason) > private.chore_limit('reason') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_occurrence := private.lock_chore_occurrence(p_occurrence_id, v_user_id);
    if v_occurrence.id is null then
      return query select 'not_found', null::uuid, false, null::integer;
      return;
    end if;
    if not private.can_manage_chores(v_occurrence.home_id, v_user_id) then
      return query select 'not_permitted', null::uuid, false, null::integer;
      return;
    end if;
    v_overdue := v_occurrence.due_date < private.task_today(v_occurrence.home_id, null);
    if v_occurrence.status = 'pending_approval' or v_occurrence.in_rework then
      return query select 'pending_approval', null::uuid, v_overdue, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.status <> 'open' then
      return query select 'occurrence_closed', null::uuid, v_overdue, v_occurrence.revision;
      return;
    end if;
    select * into v_request from private.chore_volunteer_requests r
      where r.occurrence_id = v_occurrence.id and r.status = 'accepted'
      order by r.closed_at desc limit 1;
    if v_request.id is null or v_request.accepted_by is null or not exists (
        select 1 from private.chore_occurrence_assignees a
        where a.occurrence_id = v_occurrence.id and a.user_id = v_request.accepted_by)
       or exists (select 1 from private.chore_occurrence_events e
        where e.occurrence_id = v_occurrence.id and e.kind = 'assignment_corrected'
          and e.id > (select max(e2.id) from private.chore_occurrence_events e2
            where e2.occurrence_id = v_occurrence.id and e2.kind = 'volunteered')) then
      return query select 'not_volunteered', null::uuid, v_overdue, v_occurrence.revision;
      return;
    end if;
    if v_occurrence.revision <> p_expected_revision then
      return query select 'conflict', private.member_ref(v_occurrence.home_id, v_request.accepted_by),
        v_overdue, v_occurrence.revision;
      return;
    end if;
    if p_member_id is not null then
      select m.user_id into v_to from public.home_memberships m
        where m.home_id = v_occurrence.home_id and m.id = p_member_id;
      if v_to is null or v_to = v_request.accepted_by then
        return query select 'invalid_assignee', private.member_ref(v_occurrence.home_id, v_request.accepted_by),
          v_overdue, v_occurrence.revision;
        return;
      end if;
    end if;
    if p_dry_run then
      return query select 'preview', private.member_ref(v_occurrence.home_id, v_request.accepted_by),
        v_overdue, v_occurrence.revision;
      return;
    end if;
    perform private.set_occurrence_assignees(v_occurrence.id, v_occurrence.home_id,
      case when v_to is null then '{}'::uuid[] else array[v_to] end);
    update private.chore_occurrences o
      set needs_reassignment = v_to is null, revision = o.revision + 1, updated_by = v_user_id,
        updated_at = pg_catalog.now()
      where o.id = v_occurrence.id
      returning * into v_occurrence;
    insert into private.chore_occurrence_events (
      occurrence_id, kind, actor_id, contributor_id, previous_contributor_id, reason
    ) values (v_occurrence.id, 'assignment_corrected', v_user_id, v_to, v_request.accepted_by, v_reason);
    perform private.notify_user(
      v_request.accepted_by, v_occurrence.home_id, 'chores', 'chore.assignment_corrected',
      pg_catalog.jsonb_build_object('homeId', v_occurrence.home_id, 'occurrenceId', v_occurrence.id),
      'chore-assignment-corrected:' || v_occurrence.id::text || ':' || v_occurrence.revision::text, true);
    perform private.audit_chore('chore_occurrence.assignment_corrected', v_occurrence.home_id,
      'chore_occurrence', v_occurrence.id, pg_catalog.jsonb_build_object('toReview', v_to is null));
    return query select 'corrected', private.member_ref(v_occurrence.home_id, v_request.accepted_by),
      v_overdue, v_occurrence.revision;
  end
  $$;

-- The volunteer side of one occurrence for the caller. Chore managers: whether it is in review,
-- whether a request can be sent, the deadline, every request with every invitation, and whether the
-- accepted volunteer can be corrected. An invitee: their own invitations only (never the roster or
-- others' answers). Anyone else: whether it awaits a volunteer. Null when not the caller's to see.
create function public.get_chore_volunteer_state(p_occurrence_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_occurrence private.chore_occurrences;
    v_manage boolean;
    v_deadline timestamptz;
    v_open boolean;
    v_accepted private.chore_volunteer_requests;
  begin
    if p_occurrence_id is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_occurrence from private.chore_occurrences o
      where o.id = p_occurrence_id and o.deleted_at is null;
    if not found or not private.is_home_member(v_occurrence.home_id, v_user_id)
       or not exists (select 1 from private.chores c where c.id = v_occurrence.chore_id and c.deleted_at is null) then
      return null;
    end if;
    v_manage := private.can_manage_chores(v_occurrence.home_id, v_user_id);
    v_deadline := private.chore_volunteer_deadline(v_occurrence);
    -- An open request past its deadline reads as expired before anything marked it.
    v_open := exists (select 1 from private.chore_volunteer_requests r
      where r.occurrence_id = v_occurrence.id and r.status = 'open') and v_deadline > pg_catalog.now();
    select * into v_accepted from private.chore_volunteer_requests r
      where r.occurrence_id = v_occurrence.id and r.status = 'accepted'
      order by r.closed_at desc limit 1;
    return pg_catalog.jsonb_build_object(
      'inReview', private.chore_in_review(v_occurrence),
      'awaitingVolunteer', v_open,
      'deadline', v_deadline,
      'canRequest', v_manage and private.chore_in_review(v_occurrence) and not v_open
        and v_deadline > pg_catalog.now(),
      'canCorrect', v_manage and v_occurrence.status = 'open' and not v_occurrence.in_rework
        and v_accepted.id is not null and exists (select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = v_occurrence.id and a.user_id = v_accepted.accepted_by)
        and not exists (select 1 from private.chore_occurrence_events e
          where e.occurrence_id = v_occurrence.id and e.kind = 'assignment_corrected'
            and e.id > (select max(e2.id) from private.chore_occurrence_events e2
              where e2.occurrence_id = v_occurrence.id and e2.kind = 'volunteered')),
      'volunteer', case when v_manage then private.chore_person(v_occurrence.home_id, v_accepted.accepted_by, v_user_id) end,
      'requests', coalesce((select pg_catalog.jsonb_agg(x.item order by x.created_at desc) from (
          select r.created_at, pg_catalog.jsonb_build_object(
            'id', r.id,
            'status', case when r.status = 'open' and v_deadline <= pg_catalog.now() then 'expired' else r.status end,
            'createdAt', r.created_at, 'closedAt', r.closed_at,
            'by', case when v_manage then private.chore_person(r.home_id, r.created_by, v_user_id) end,
            'acceptedBy', case when v_manage then private.chore_person(r.home_id, r.accepted_by, v_user_id) end,
            'canChange', v_manage and r.status = 'open' and v_deadline > pg_catalog.now(),
            'invitations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'member', private.chore_person(i.home_id, i.user_id, v_user_id),
                'status', case when i.status = 'pending' and v_deadline <= pg_catalog.now() then 'expired' else i.status end,
                'invitedAt', i.invited_at, 'respondedAt', i.responded_at,
                'canAnswer', i.user_id = v_user_id and i.status = 'pending' and r.status = 'open'
                  and v_deadline > pg_catalog.now())
                order by i.invited_at, i.user_id)
              from private.chore_volunteer_invitations i
              where i.request_id = r.id and (v_manage or i.user_id = v_user_id)), '[]'::jsonb)) as item
          from private.chore_volunteer_requests r
          where r.occurrence_id = v_occurrence.id
            and (v_manage or exists (select 1 from private.chore_volunteer_invitations i
              where i.request_id = r.id and i.user_id = v_user_id))
          order by r.created_at desc
          limit private.chore_volunteer_limit('requests')) x), '[]'::jsonb));
  end
  $$;

-- The caller's pending volunteer invitations in a Home, with only what they need to decide: the
-- chore's title, due day, instructions, checklist and estimate, and the deadline.
create function public.list_chore_volunteer_offers(p_home_id uuid)
returns table (
  request_id uuid, occurrence_id uuid, title text, due_date date, deadline timestamptz,
  instructions text, minutes integer, steps jsonb, invited_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    return query
      select r.id, o.id, c.title, o.due_date, private.chore_volunteer_deadline(o), c.instructions,
        o.estimated_minutes,
        coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', s.label, 'mandatory', s.mandatory) order by s.position)
          from private.chore_occurrence_steps s where s.occurrence_id = o.id), '[]'::jsonb),
        i.invited_at
      from private.chore_volunteer_invitations i
      join private.chore_volunteer_requests r on r.id = i.request_id
      join private.chore_occurrences o on o.id = r.occurrence_id
      join private.chores c on c.id = o.chore_id
      where i.home_id = p_home_id and i.user_id = v_user_id and i.status = 'pending'
        and r.status = 'open' and o.deleted_at is null and c.deleted_at is null
        and private.chore_volunteer_deadline(o) > pg_catalog.now()
      order by o.due_date, r.id
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
      'advance_chores', 'propose_chore', 'withdraw_chore_proposal', 'review_chore_proposal',
      'list_chore_proposals', 'create_chore_volunteer_request', 'answer_chore_volunteer_invitation',
      'change_chore_volunteer_request', 'correct_chore_volunteer_assignment',
      'get_chore_volunteer_state', 'list_chore_volunteer_offers'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (p.proname like '%chore%' or p.proname = 'valid_proposal_date')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
