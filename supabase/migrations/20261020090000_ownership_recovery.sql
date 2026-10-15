-- S12b: verified Home ownership recovery (brief S12b; spec "Confirmed verified Home ownership
-- recovery", "Confirmed exactly one Home Owner"; architecture.md §43 and ADR 0015 for staff).
--
-- When a Home's only Owner can no longer reach their account and normal account recovery fails, an
-- eligible adult member may ask Madeora to review a takeover. Nothing changes until:
-- 1. a Madeora staff member (private.madeora_staff) reviews the private statement, verifies the
--    person outside the app and approves, with a recent sign-in;
-- 2. a 14-day objection period passes without an objection, a cancellation by the Owner, or the
--    Owner showing that they have access again (signing in, or opening the Home);
-- 3. the person who asked accepts. Under the Home lock everything is checked again, and the Owner
--    steps down (to Member, or out of the Home when staff decided so) and the person becomes Owner
--    in one transaction.
-- Statements, objections, appeals and staff reasons are readable by no API role; members see only
-- that a review is open. Staff get no Home access: each staff function checks staff status itself
-- and returns only what reviewing needs.

-- Audit subjects ----------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery'
  ));

-- Staff -------------------------------------------------------------------------------------------

-- Madeora staff accounts. No API role can read or write this table: the owner adds and removes
-- staff by running SQL in the hosted project's SQL Editor (docs/staff-operations.md).
create table private.madeora_staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  note text constraint madeora_staff_note_check check (char_length(note) <= 200)
);

comment on table private.madeora_staff is
  'Madeora staff accounts (architecture.md §43). Managed only through the SQL Editor.';

-- The caller, when they are staff with a confirmed account; with p_recent, also signed in within
-- the last 15 minutes in this very session (staff decisions): the session in the caller's token
-- must have a sign-in recorded in that window, so a sign-in on another device does not refresh an
-- older, possibly stolen session. Raises 42501 otherwise, the same for everyone.
create function private.require_staff(p_recent boolean) returns uuid
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_session_id uuid;
  begin
    if not exists (select 1 from private.madeora_staff s where s.user_id = v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if p_recent then
      begin
        v_session_id := (auth.jwt() ->> 'session_id')::uuid;
      exception when invalid_text_representation then
        v_session_id := null;
      end;
    end if;
    if p_recent and (v_session_id is null or not exists (
      select 1
      from auth.sessions s
      join auth.mfa_amr_claims c on c.session_id = s.id
      where s.id = v_session_id
        and s.user_id = v_user_id
        and (s.not_after is null or s.not_after > pg_catalog.now())
        and c.updated_at > pg_catalog.now() - interval '15 minutes'
    )) then
      raise exception 'recent sign-in required' using errcode = '42501', hint = 'reauthenticate';
    end if;
    return v_user_id;
  end
  $$;

-- Whether a staff member is a party to a case or belongs to its Home. Such a staff member may not
-- see or decide it: the review must be independent of the Home (another staff member decides).
create function private.staff_is_involved(p_home_id uuid, p_claimant_id uuid, p_owner_id uuid,
  p_staff_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_staff_id = p_claimant_id or p_staff_id = p_owner_id or exists (
    select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_staff_id
  );
  $$;

-- Whether the caller is staff: for the app to show the staff link. Not a permission by itself.
create function public.is_madeora_staff() returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.madeora_staff s where s.user_id = auth.uid());
  $$;

-- Recovery cases ----------------------------------------------------------------------------------

create table private.home_ownership_recoveries (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  claimant_id uuid not null references auth.users (id) on delete cascade,
  -- The Owner when the request was made; the takeover is only ever from this account.
  owner_id uuid not null references auth.users (id) on delete cascade,
  statement text not null
    constraint home_ownership_recoveries_statement_check
      check (char_length(btrim(statement)) between 50 and 4000),
  status text not null default 'submitted'
    constraint home_ownership_recoveries_status_check check (status in (
      'submitted', 'in_review', 'approved', 'paused', 'completed', 'rejected', 'withdrawn',
      'cancelled', 'owner_returned', 'invalid'
    )),
  -- clock_timestamp: two requests in one transaction (tests) still have an order.
  created_at timestamptz not null default clock_timestamp(),
  creation_request_id uuid not null,
  -- The Owner opened the Home after the request: they have access again.
  owner_seen_at timestamptz,
  review_started_at timestamptz,
  review_started_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  objection_ends_at timestamptz,
  -- What happens to the former Owner, decided by staff on approval.
  former_owner_outcome text
    constraint home_ownership_recoveries_outcome_check
      check (former_owner_outcome in ('member', 'removed')),
  paused_from text
    constraint home_ownership_recoveries_paused_from_check
      check (paused_from in ('submitted', 'in_review', 'approved')),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  -- Staff's reasons for approving, pausing, rejecting; never shown to members.
  staff_notes text
    constraint home_ownership_recoveries_notes_check check (char_length(staff_notes) <= 40000),
  constraint home_ownership_recoveries_paused_check check ((status = 'paused') = (paused_from is not null)),
  constraint home_ownership_recoveries_approved_check check (
    status not in ('approved', 'completed') or (approved_at is not null and objection_ends_at is not null
      and former_owner_outcome is not null)
  )
);

-- One open request per person per Home; several people may have one each (competing claimants).
create unique index home_ownership_recoveries_one_open
  on private.home_ownership_recoveries (home_id, claimant_id)
  where status in ('submitted', 'in_review', 'approved', 'paused');
create unique index home_ownership_recoveries_request_key
  on private.home_ownership_recoveries (claimant_id, creation_request_id);
create index home_ownership_recoveries_home_idx on private.home_ownership_recoveries (home_id);

comment on table private.home_ownership_recoveries is
  'Verified Home ownership recovery cases (S12b). Statements and staff notes are private.';

-- Objections from adult members or the Owner while a case is open. They pause the case.
create table private.home_ownership_recovery_objections (
  id uuid primary key default gen_random_uuid(),
  recovery_id uuid not null references private.home_ownership_recoveries (id) on delete cascade,
  objector_id uuid references auth.users (id) on delete set null,
  objector_role text not null
    constraint recovery_objections_role_check check (objector_role in ('owner', 'administrator', 'member')),
  reason text not null
    constraint recovery_objections_reason_check check (char_length(btrim(reason)) between 10 and 2000),
  created_at timestamptz not null default clock_timestamp()
);

-- Appeals by a former Owner after a completed recovery. Recorded for staff; nothing is reversed
-- automatically.
create table private.home_ownership_recovery_appeals (
  id uuid primary key default gen_random_uuid(),
  recovery_id uuid not null references private.home_ownership_recoveries (id) on delete cascade,
  appellant_id uuid references auth.users (id) on delete set null,
  reason text not null
    constraint recovery_appeals_reason_check check (char_length(btrim(reason)) between 10 and 4000),
  status text not null default 'open'
    constraint recovery_appeals_status_check check (status in ('open', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  staff_notes text constraint recovery_appeals_notes_check check (char_length(staff_notes) <= 8000)
);

create unique index recovery_appeals_one_open
  on private.home_ownership_recovery_appeals (recovery_id) where status = 'open';

-- State --------------------------------------------------------------------------------------------

-- What a case is now: its stored status, 'owner_returned' for an open case whose Owner has shown
-- access since the request (signed in, or opened the Home), and 'ready' for an approved case whose
-- objection period has ended.
create function private.recovery_state(p_case private.home_ownership_recoveries) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_case.status in ('submitted', 'in_review', 'approved', 'paused')
      and (p_case.owner_seen_at is not null or exists (
        select 1 from auth.users u
        where u.id = p_case.owner_id and u.last_sign_in_at > p_case.created_at
      ))
      then 'owner_returned'
    when p_case.status = 'approved' and p_case.objection_ends_at <= pg_catalog.now() then 'ready'
    else p_case.status
  end;
  $$;

-- Stores 'owner_returned' on the Home's open cases whose Owner is back (the Home is locked).
create function private.settle_owner_returned(p_home_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    for v_id in
      update private.home_ownership_recoveries r
        set status = 'owner_returned', paused_from = null, decided_at = pg_catalog.now()
        where r.home_id = p_home_id and r.status in ('submitted', 'in_review', 'approved', 'paused')
          and private.recovery_state(r) = 'owner_returned'
        returning r.id
    loop
      perform private.audit('ownership_recovery.owner_returned', p_home_id, 'ownership_recovery', v_id);
    end loop;
  end
  $$;

-- Whether p_user may ask for a recovery in p_home now: an Administrator or Member with a confirmed
-- account, a member for at least 30 days, and not the Owner.
create function private.can_request_recovery(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.confirmed_email(p_user_id) is not null and exists (
    select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id = p_user_id
      and m.role in ('administrator', 'member')
      and m.created_at <= pg_catalog.now() - interval '30 days'
  );
  $$;

-- A membership that ends, or an Owner who stops being the Owner by any other path, ends the cases
-- it makes impossible: the claimant leaving or being removed, or the Owner changing.
create function private.invalidate_ownership_recoveries() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    if tg_op = 'DELETE' or (old.role = 'owner' and new.role <> 'owner') then
      for v_id in
        update private.home_ownership_recoveries r
          set status = 'invalid', paused_from = null, decided_at = pg_catalog.now()
          where r.home_id = old.home_id
            and r.status in ('submitted', 'in_review', 'approved', 'paused')
            and (r.claimant_id = old.user_id or r.owner_id = old.user_id)
          returning r.id
      loop
        perform private.audit('ownership_recovery.invalid', old.home_id, 'ownership_recovery', v_id);
      end loop;
    end if;
    return null;
  end
  $$;

create trigger home_memberships_invalidate_recoveries
  after update of role or delete on public.home_memberships
  for each row execute function private.invalidate_ownership_recoveries();

-- Members ------------------------------------------------------------------------------------------

-- What the caller may see of recovery in a Home they belong to, one row per visible case:
-- - the person who asked: their own open or recently ended case, with its state;
-- - the Owner: every open case, with who asked (the Owner is the one it is about); opening this
--   as the Owner shows they have access, which stops every open case;
-- - other members: only that a review is open, and whether they have objected.
-- Never the statement, objections or staff notes. Errors (42501) for non-members.
create function public.home_ownership_recovery_status(p_home_id uuid)
returns table (
  id uuid, viewer text, state text, created_at timestamptz, objection_ends_at timestamptz,
  claimant_membership_id uuid, objected boolean
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_role text;
  begin
    v_role := private.home_role(p_home_id, v_user_id);
    if v_role is null then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    if v_role = 'owner' then
      -- The Home lock first, as every function that changes cases takes it (no deadlock with an
      -- acceptance in progress).
      perform private.lock_home(p_home_id);
      update private.home_ownership_recoveries r
        set owner_seen_at = pg_catalog.now()
        where r.home_id = p_home_id and r.owner_id = v_user_id and r.owner_seen_at is null
          and r.status in ('submitted', 'in_review', 'approved', 'paused');
    end if;
    return query
      select r.id,
        case when r.claimant_id = v_user_id then 'claimant'
             when v_role = 'owner' then 'owner' else 'member' end,
        private.recovery_state(r), r.created_at,
        case when r.claimant_id = v_user_id or v_role = 'owner' then r.objection_ends_at end,
        case when v_role = 'owner' then (
          select m.id from public.home_memberships m
          where m.home_id = p_home_id and m.user_id = r.claimant_id
        ) end,
        exists (
          select 1 from private.home_ownership_recovery_objections o
          where o.recovery_id = r.id and o.objector_id = v_user_id
        )
      from private.home_ownership_recoveries r
      where r.home_id = p_home_id
        and (
          (r.claimant_id = v_user_id
            and (r.status in ('submitted', 'in_review', 'approved', 'paused')
                 or r.decided_at > pg_catalog.now() - interval '30 days'))
          or (r.claimant_id <> v_user_id
            and r.status in ('submitted', 'in_review', 'approved', 'paused'))
        )
      order by r.created_at desc;
  end
  $$;

-- An eligible member asks for a recovery review. A repeated request id returns the case it made.
-- Outcomes: 'submitted', 'not_found', 'not_permitted' (the Owner, too new a member, unconfirmed),
-- 'already_open'.
create function public.request_ownership_recovery(
  p_home_id uuid, p_statement text, p_request_id uuid
) returns table (outcome text, recovery_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing uuid;
    v_owner uuid;
    v_id uuid;
  begin
    if p_request_id is null or p_statement is null
       or char_length(btrim(p_statement)) not between 50 and 4000 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select r.id into v_existing from private.home_ownership_recoveries r
      where r.claimant_id = v_user_id and r.creation_request_id = p_request_id;
    if found then
      return query select 'submitted'::text, v_existing;
      return;
    end if;
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if not private.can_request_recovery(p_home_id, v_user_id) then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;
    perform private.settle_owner_returned(p_home_id);
    if exists (
      select 1 from private.home_ownership_recoveries r
      where r.home_id = p_home_id and r.claimant_id = v_user_id
        and r.status in ('submitted', 'in_review', 'approved', 'paused')
    ) then
      return query select 'already_open'::text, null::uuid;
      return;
    end if;
    select m.user_id into v_owner from public.home_memberships m
      where m.home_id = p_home_id and m.role = 'owner';
    insert into private.home_ownership_recoveries (
      home_id, claimant_id, owner_id, statement, creation_request_id
    ) values (p_home_id, v_user_id, v_owner, btrim(p_statement), p_request_id)
    returning id into v_id;
    perform private.audit('ownership_recovery.requested', p_home_id, 'ownership_recovery', v_id);
    return query select 'submitted'::text, v_id;
  end
  $$;

-- The person who asked withdraws their open request. Outcomes: 'withdrawn', 'not_found',
-- 'already_decided'.
create function public.withdraw_ownership_recovery(p_home_id uuid, p_recovery_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_case private.home_ownership_recoveries;
  begin
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    select * into v_case from private.home_ownership_recoveries r
      where r.id = p_recovery_id and r.home_id = p_home_id and r.claimant_id = v_user_id for update;
    if not found then
      return 'not_found';
    end if;
    if v_case.status not in ('submitted', 'in_review', 'approved', 'paused') then
      return 'already_decided';
    end if;
    update private.home_ownership_recoveries
      set status = 'withdrawn', paused_from = null, decided_at = pg_catalog.now(), decided_by = v_user_id
      where id = v_case.id;
    perform private.audit('ownership_recovery.withdrawn', p_home_id, 'ownership_recovery', v_case.id);
    return 'withdrawn';
  end
  $$;

-- The Owner, who evidently has access, ends every open request about their Home. Outcomes:
-- 'cancelled' (with the number ended), 'not_permitted' (not the Owner), 'not_found'.
create function public.cancel_ownership_recoveries(p_home_id uuid)
returns table (outcome text, cancelled integer)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_role text;
    v_count integer := 0;
    v_id uuid;
  begin
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, 0;
      return;
    end if;
    v_role := private.home_role(p_home_id, v_user_id);
    if v_role is null then
      return query select 'not_found'::text, 0;
      return;
    end if;
    if v_role <> 'owner' then
      return query select 'not_permitted'::text, 0;
      return;
    end if;
    for v_id in
      update private.home_ownership_recoveries r
        set status = 'cancelled', paused_from = null, decided_at = pg_catalog.now(),
          decided_by = v_user_id
        where r.home_id = p_home_id and r.status in ('submitted', 'in_review', 'approved', 'paused')
        returning r.id
    loop
      v_count := v_count + 1;
      perform private.audit('ownership_recovery.cancelled_by_owner', p_home_id, 'ownership_recovery', v_id);
    end loop;
    return query select 'cancelled'::text, v_count;
  end
  $$;

-- Any adult member other than the person who asked objects; every open case of the Home pauses
-- for staff to look at. The reason is private to staff. Outcomes: 'objected', 'not_found',
-- 'nothing_open', 'not_permitted' (the person who asked).
create function public.object_to_ownership_recovery(p_home_id uuid, p_reason text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_role text;
    v_case private.home_ownership_recoveries;
    v_objected boolean := false;
  begin
    if p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
      raise exception 'invalid reason' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    v_role := private.home_role(p_home_id, v_user_id);
    if v_role is null then
      return 'not_found';
    end if;
    perform private.settle_owner_returned(p_home_id);
    for v_case in
      select * from private.home_ownership_recoveries r
      where r.home_id = p_home_id and r.status in ('submitted', 'in_review', 'approved', 'paused')
      for update
    loop
      if v_case.claimant_id = v_user_id then
        continue;
      end if;
      insert into private.home_ownership_recovery_objections (recovery_id, objector_id, objector_role, reason)
        values (v_case.id, v_user_id, v_role, btrim(p_reason));
      if v_case.status <> 'paused' then
        update private.home_ownership_recoveries
          set status = 'paused', paused_from = v_case.status
          where id = v_case.id;
      end if;
      perform private.audit('ownership_recovery.objected', p_home_id, 'ownership_recovery', v_case.id,
        pg_catalog.jsonb_build_object('role', v_role));
      v_objected := true;
    end loop;
    if v_objected then
      return 'objected';
    end if;
    if exists (
      select 1 from private.home_ownership_recoveries r
      where r.home_id = p_home_id and r.claimant_id = v_user_id
        and r.status in ('submitted', 'in_review', 'approved', 'paused')
    ) then
      return 'not_permitted';
    end if;
    return 'nothing_open';
  end
  $$;

-- After the objection period, the person who asked accepts and becomes the Owner. Under the Home
-- lock: the case is approved, its period over, not paused; the Owner is still the account the
-- request was about and has not shown access since; the person is still an adult member with a
-- confirmed account. Then the former Owner steps down (to Member, or out of the Home when staff
-- decided so), the person becomes Owner, and every other open case and pending transfer of the
-- Home ends. Outcomes: 'completed', 'not_found', 'not_ready', 'owner_returned', 'no_longer_valid'.
create function public.accept_ownership_recovery(p_home_id uuid, p_recovery_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_case private.home_ownership_recoveries;
    v_state text;
    v_id uuid;
  begin
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    select * into v_case from private.home_ownership_recoveries r
      where r.id = p_recovery_id and r.home_id = p_home_id and r.claimant_id = v_user_id for update;
    if not found then
      return 'not_found';
    end if;
    v_state := private.recovery_state(v_case);
    if v_state = 'owner_returned' then
      perform private.settle_owner_returned(p_home_id);
      return 'owner_returned';
    end if;
    -- Ended because a membership changed (the Owner or the person no longer in place).
    if v_state = 'invalid' then
      return 'no_longer_valid';
    end if;
    if v_state <> 'ready' then
      return 'not_ready';
    end if;
    if private.home_role(p_home_id, v_case.owner_id) is distinct from 'owner'
       or coalesce(private.home_role(p_home_id, v_user_id), '') not in ('administrator', 'member')
       or private.confirmed_email(v_user_id) is null then
      update private.home_ownership_recoveries
        set status = 'invalid', decided_at = pg_catalog.now()
        where id = v_case.id;
      perform private.audit('ownership_recovery.invalid', p_home_id, 'ownership_recovery', v_case.id);
      return 'no_longer_valid';
    end if;

    -- Completed first, so the triggers that end open cases when the Owner changes leave this one.
    update private.home_ownership_recoveries
      set status = 'completed', decided_at = pg_catalog.now()
      where id = v_case.id;
    update public.home_memberships set role = 'member'
      where home_id = p_home_id and user_id = v_case.owner_id;
    update public.home_memberships set role = 'owner'
      where home_id = p_home_id and user_id = v_user_id;
    if v_case.former_owner_outcome = 'removed' then
      perform pg_catalog.set_config('madeora.membership_end', 'removed', true);
      delete from public.home_memberships
        where home_id = p_home_id and user_id = v_case.owner_id;
      perform pg_catalog.set_config('madeora.membership_end', '', true);
    end if;
    -- Other people's open requests end with the change of Owner (the role trigger above); any
    -- still open, for example a request by the former Owner's co-claimant, end here too.
    for v_id in
      update private.home_ownership_recoveries r
        set status = 'invalid', paused_from = null, decided_at = pg_catalog.now()
        where r.home_id = p_home_id and r.id <> v_case.id
          and r.status in ('submitted', 'in_review', 'approved', 'paused')
        returning r.id
    loop
      perform private.audit('ownership_recovery.invalid', p_home_id, 'ownership_recovery', v_id);
    end loop;
    perform private.audit('ownership_recovery.completed', p_home_id, 'ownership_recovery', v_case.id,
      pg_catalog.jsonb_build_object('former_owner', v_case.former_owner_outcome));
    return 'completed';
  end
  $$;

-- For a former Owner: the Homes taken over from them through a completed recovery, with any
-- appeal, so they can see what happened and appeal, even when they were removed from the Home.
create function public.my_recovered_homes()
returns table (
  recovery_id uuid, home_name text, completed_at timestamptz, still_member boolean,
  appeal_status text
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select r.id, h.name, r.decided_at,
        exists (select 1 from public.home_memberships m
          where m.home_id = r.home_id and m.user_id = v_user_id),
        (select a.status from private.home_ownership_recovery_appeals a
          where a.recovery_id = r.id order by a.created_at desc limit 1)
      from private.home_ownership_recoveries r
      join public.homes h on h.id = r.home_id
      where r.owner_id = v_user_id and r.status = 'completed'
      order by r.decided_at desc;
  end
  $$;

-- The former Owner appeals a completed recovery; staff review it. Outcomes: 'appealed',
-- 'not_found', 'already_open'.
create function public.appeal_ownership_recovery(p_recovery_id uuid, p_reason text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_case private.home_ownership_recoveries;
  begin
    if p_reason is null or char_length(btrim(p_reason)) not between 10 and 4000 then
      raise exception 'invalid reason' using errcode = '22023';
    end if;
    select * into v_case from private.home_ownership_recoveries r
      where r.id = p_recovery_id and r.owner_id = v_user_id and r.status = 'completed'
      for update;
    if not found then
      return 'not_found';
    end if;
    if exists (
      select 1 from private.home_ownership_recovery_appeals a
      where a.recovery_id = v_case.id and a.status = 'open'
    ) then
      return 'already_open';
    end if;
    insert into private.home_ownership_recovery_appeals (recovery_id, appellant_id, reason)
      values (v_case.id, v_user_id, btrim(p_reason));
    perform private.audit('ownership_recovery.appealed', v_case.home_id, 'ownership_recovery', v_case.id);
    return 'appealed';
  end
  $$;

-- Staff --------------------------------------------------------------------------------------------

-- Every case, newest first, for the staff queue: what needs attention, without statements.
create function public.staff_ownership_recoveries()
returns table (
  id uuid, home_name text, state text, created_at timestamptz, objection_ends_at timestamptz,
  objections integer, open_appeals integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_staff uuid := private.require_staff(false);
  begin
    return query
      select r.id, h.name, private.recovery_state(r), r.created_at, r.objection_ends_at,
        (select pg_catalog.count(*)::integer from private.home_ownership_recovery_objections o
          where o.recovery_id = r.id),
        (select pg_catalog.count(*)::integer from private.home_ownership_recovery_appeals a
          where a.recovery_id = r.id and a.status = 'open')
      from private.home_ownership_recoveries r
      join public.homes h on h.id = r.home_id
      where not private.staff_is_involved(r.home_id, r.claimant_id, r.owner_id, v_staff)
      order by (private.recovery_state(r) in ('submitted', 'in_review', 'paused', 'ready')) desc,
        r.created_at desc
      limit 200;
  end
  $$;

-- One case in full, for staff only: what reviewing it needs, and nothing of the Home's content.
-- Each read is audited with the staff account.
create function public.staff_ownership_recovery(p_recovery_id uuid)
returns table (
  id uuid, home_id uuid, home_name text, home_time_zone text, state text, created_at timestamptz,
  statement text, staff_notes text, former_owner_outcome text,
  review_started_at timestamptz, approved_at timestamptz, objection_ends_at timestamptz,
  decided_at timestamptz,
  owner_email text, owner_locale text, owner_last_sign_in_at timestamptz,
  owner_seen_at timestamptz, owner_is_owner boolean,
  claimant_email text, claimant_name text, claimant_role text, claimant_member_since timestamptz,
  member_count integer,
  objections jsonb, appeals jsonb
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_staff uuid := private.require_staff(false);
    v_case private.home_ownership_recoveries;
  begin
    select * into v_case from private.home_ownership_recoveries r where r.id = p_recovery_id;
    if not found
       or private.staff_is_involved(v_case.home_id, v_case.claimant_id, v_case.owner_id, v_staff) then
      return;
    end if;
    perform private.audit('ownership_recovery.viewed_by_staff', v_case.home_id, 'ownership_recovery',
      v_case.id);
    return query
      select v_case.id, v_case.home_id, h.name, h.timezone, private.recovery_state(v_case), v_case.created_at,
        v_case.statement, v_case.staff_notes, v_case.former_owner_outcome,
        v_case.review_started_at, v_case.approved_at, v_case.objection_ends_at, v_case.decided_at,
        private.confirmed_email(v_case.owner_id),
        (select p.locale from public.user_preferences p where p.user_id = v_case.owner_id),
        (select u.last_sign_in_at from auth.users u where u.id = v_case.owner_id),
        v_case.owner_seen_at,
        coalesce(private.home_role(v_case.home_id, v_case.owner_id) = 'owner', false),
        private.confirmed_email(v_case.claimant_id),
        (select p.display_name from public.user_preferences p where p.user_id = v_case.claimant_id),
        private.home_role(v_case.home_id, v_case.claimant_id),
        (select m.created_at from public.home_memberships m
          where m.home_id = v_case.home_id and m.user_id = v_case.claimant_id),
        (select pg_catalog.count(*)::integer from public.home_memberships m
          where m.home_id = v_case.home_id),
        coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'role', o.objector_role, 'reason', o.reason, 'createdAt', o.created_at)
            order by o.created_at)
          from private.home_ownership_recovery_objections o where o.recovery_id = v_case.id
        ), '[]'::jsonb),
        coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', a.id, 'reason', a.reason, 'status', a.status, 'createdAt', a.created_at,
            'staffNotes', a.staff_notes)
            order by a.created_at)
          from private.home_ownership_recovery_appeals a where a.recovery_id = v_case.id
        ), '[]'::jsonb)
      from public.homes h where h.id = v_case.home_id;
  end
  $$;

-- Staff act on a case: 'start_review' (submitted → in_review), 'approve' (in_review → approved,
-- the 14-day objection period starts; other open cases of the Home are rejected), 'pause',
-- 'resume' (back to where it was; an approved case starts a fresh 14-day period), 'reject'.
-- Every decision needs a staff sign-in within 15 minutes and is audited with the staff account;
-- p_notes is appended to the case's private notes. Outcomes: 'ok', 'not_found' (also when the staff
-- member made the request, is its Owner or belongs to its Home), 'not_allowed'
-- (the action does not fit the case's state), 'owner_returned', 'no_longer_valid'.
create function public.staff_decide_ownership_recovery(
  p_recovery_id uuid, p_action text, p_notes text, p_former_owner_outcome text default null
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_staff uuid := private.require_staff(true);
    v_case private.home_ownership_recoveries;
    v_state text;
    v_id uuid;
  begin
    if p_action is null
       or p_action not in ('start_review', 'approve', 'pause', 'resume', 'reject')
       or char_length(coalesce(p_notes, '')) > 2000
       or (p_action in ('approve', 'pause', 'reject') and char_length(btrim(coalesce(p_notes, ''))) < 10)
       or (p_action = 'approve' and p_former_owner_outcome is distinct from 'member'
           and p_former_owner_outcome is distinct from 'removed') then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    select r.home_id into v_id from private.home_ownership_recoveries r where r.id = p_recovery_id;
    if not found then
      return 'not_found';
    end if;
    -- The Home lock first, as everywhere else; then the case, fresh.
    if not private.lock_home(v_id) then
      return 'not_found';
    end if;
    perform private.settle_owner_returned(v_id);
    select * into v_case from private.home_ownership_recoveries r where r.id = p_recovery_id for update;
    if not found
       or private.staff_is_involved(v_case.home_id, v_case.claimant_id, v_case.owner_id, v_staff) then
      return 'not_found';
    end if;
    v_state := private.recovery_state(v_case);
    if v_state = 'owner_returned' then
      return 'owner_returned';
    end if;
    if not (
      (p_action = 'start_review' and v_state = 'submitted')
      or (p_action = 'approve' and v_state = 'in_review')
      or (p_action = 'pause' and v_state in ('submitted', 'in_review', 'approved', 'ready'))
      or (p_action = 'resume' and v_state = 'paused')
      or (p_action = 'reject' and v_state in ('submitted', 'in_review', 'approved', 'ready', 'paused'))
    ) then
      return 'not_allowed';
    end if;
    if p_action in ('approve', 'resume')
       and (private.home_role(v_case.home_id, v_case.owner_id) is distinct from 'owner'
            or coalesce(private.home_role(v_case.home_id, v_case.claimant_id), '')
              not in ('administrator', 'member')) then
      update private.home_ownership_recoveries
        set status = 'invalid', paused_from = null, decided_at = pg_catalog.now(), decided_by = v_staff
        where id = v_case.id;
      perform private.audit('ownership_recovery.invalid', v_case.home_id, 'ownership_recovery', v_case.id);
      return 'no_longer_valid';
    end if;

    update private.home_ownership_recoveries r set
      status = case p_action
        when 'start_review' then 'in_review'
        when 'approve' then 'approved'
        when 'pause' then 'paused'
        when 'resume' then v_case.paused_from
        else 'rejected' end,
      paused_from = case p_action when 'pause' then v_case.status else null end,
      review_started_at = case when p_action = 'start_review' then pg_catalog.now() else r.review_started_at end,
      review_started_by = case when p_action = 'start_review' then v_staff else r.review_started_by end,
      approved_at = case when p_action = 'approve' then pg_catalog.now() else r.approved_at end,
      approved_by = case when p_action = 'approve' then v_staff else r.approved_by end,
      former_owner_outcome = case when p_action = 'approve' then p_former_owner_outcome
        else r.former_owner_outcome end,
      objection_ends_at = case
        when p_action = 'approve' or (p_action = 'resume' and v_case.paused_from = 'approved')
          then pg_catalog.now() + interval '14 days'
        else r.objection_ends_at end,
      decided_at = case when p_action = 'reject' then pg_catalog.now() else r.decided_at end,
      decided_by = case when p_action = 'reject' then v_staff else r.decided_by end,
      staff_notes = case when btrim(coalesce(p_notes, '')) = '' then r.staff_notes
        else pg_catalog.concat_ws(E'\n\n', r.staff_notes,
          pg_catalog.to_char(pg_catalog.now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC, '
            || p_action || ': ' || btrim(p_notes)) end
      where r.id = v_case.id;
    perform private.audit('ownership_recovery.staff_' || p_action, v_case.home_id, 'ownership_recovery',
      v_case.id, pg_catalog.jsonb_build_object('staff', v_staff));

    -- Approving one request ends the competing ones.
    if p_action = 'approve' then
      for v_id in
        update private.home_ownership_recoveries r
          set status = 'rejected', paused_from = null, decided_at = pg_catalog.now(), decided_by = v_staff,
            staff_notes = pg_catalog.concat_ws(E'\n\n', r.staff_notes, 'Another request was approved.')
          where r.home_id = v_case.home_id and r.id <> v_case.id
            and r.status in ('submitted', 'in_review', 'approved', 'paused')
          returning r.id
      loop
        perform private.audit('ownership_recovery.staff_reject', v_case.home_id, 'ownership_recovery',
          v_id, pg_catalog.jsonb_build_object('staff', v_staff));
      end loop;
    end if;
    return 'ok';
  end
  $$;

-- Staff close an appeal with their note. Nothing about the Home changes here; a reversal, if
-- warranted, goes through the Home's normal ownership transfer. Outcomes: 'closed', 'not_found'.
create function public.staff_close_recovery_appeal(p_appeal_id uuid, p_notes text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_staff uuid := private.require_staff(true);
    v_case private.home_ownership_recoveries;
  begin
    if p_notes is null or char_length(btrim(p_notes)) not between 10 and 2000 then
      raise exception 'invalid notes' using errcode = '22023';
    end if;
    select r.* into v_case from private.home_ownership_recoveries r
      join private.home_ownership_recovery_appeals a on a.recovery_id = r.id
      where a.id = p_appeal_id;
    if not found
       or private.staff_is_involved(v_case.home_id, v_case.claimant_id, v_case.owner_id, v_staff) then
      return 'not_found';
    end if;
    update private.home_ownership_recovery_appeals a
      set status = 'closed', closed_at = pg_catalog.now(), closed_by = v_staff, staff_notes = btrim(p_notes)
      where a.id = p_appeal_id and a.status = 'open';
    if not found then
      return 'not_found';
    end if;
    perform private.audit('ownership_recovery.appeal_closed', v_case.home_id, 'ownership_recovery',
      v_case.id, pg_catalog.jsonb_build_object('staff', v_staff, 'appeal', p_appeal_id));
    return 'closed';
  end
  $$;

-- API access --------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.is_madeora_staff()',
    'public.home_ownership_recovery_status(uuid)',
    'public.request_ownership_recovery(uuid, text, uuid)',
    'public.withdraw_ownership_recovery(uuid, uuid)',
    'public.cancel_ownership_recoveries(uuid)',
    'public.object_to_ownership_recovery(uuid, text)',
    'public.accept_ownership_recovery(uuid, uuid)',
    'public.my_recovered_homes()',
    'public.appeal_ownership_recovery(uuid, text)',
    'public.staff_ownership_recoveries()',
    'public.staff_ownership_recovery(uuid)',
    'public.staff_decide_ownership_recovery(uuid, text, text, text)',
    'public.staff_close_recovery_appeal(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
end
$$;
