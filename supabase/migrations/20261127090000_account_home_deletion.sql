-- S40 (part 1): Home deletion ("Close Home") and account deletion, each with a 30-day recovery
-- period, the final purge, and "Former member" anonymization.
--
-- Spec: Project-specification.md "Confirmed Madeora account deletion and recovery", "Confirmed Home
-- deletion and recovery", "Confirmed guided transfer-or-close for departing Home Owner", "Confirmed
-- anonymization after permanent account deletion" (12-13 October 2026). Brief: plans/steps/S40-brief.md.
--
-- A Home pending deletion is inaccessible to every member, Owner included, on every path. Every
-- policy, permission helper, RPC and job resolves access through public.home_memberships, so that
-- name becomes a view over the renamed table private.home_memberships_all that leaves out Homes
-- pending deletion. The table keeps its constraints, indexes, triggers and foreign keys (they follow
-- the table, not its name). Only the one-Owner check and this file's own functions read the table.
--
-- An account pending deletion is suspended exactly like an S38 deactivation (it has a row in
-- private.account_deactivations too): sessions end, notifications are security-only, members see
-- "inactive", and its only use is to see the state and cancel. Its memberships stay until the final
-- deletion, so members can still remove it meanwhile and that removal stands.

-- Settings ---------------------------------------------------------------------------------------

-- Values awaiting Ward's approval (plans/steps/S40-brief.md).
create function private.deletion_recovery_period() returns interval
  language sql immutable set search_path = '' as $$ select interval '30 days' $$;

-- Re-authentication: two more actions -------------------------------------------------------------

alter table private.account_change_grants drop constraint account_change_grants_action_check;
alter table private.account_change_grants
  add constraint account_change_grants_action_check check (action in (
    'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
    'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account',
    'data_export', 'delete_account', 'close_home'
  ));

-- As S39, with two more actions: 'delete_account' and 'close_home' (close and restore a Home).
create or replace function public.authorize_account_change(p_action text, p_session_id uuid)
returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_expires_at timestamptz;
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_action is null or p_action not in (
      'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
      'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account',
      'data_export', 'delete_account', 'close_home'
    ) then
      raise exception 'unknown action' using errcode = '22023';
    end if;
    if not private.is_recent_reauthentication(v_user_id, v_session_id, p_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if p_session_id is null or p_session_id = v_session_id
       or not private.session_is_live(v_user_id, p_session_id) then
      raise exception 'unknown session' using errcode = '42501', hint = 'session_required';
    end if;
    if p_action = 'two_factor_enroll' and private.has_two_factor(v_user_id) then
      raise exception 'two-factor sign-in is already on' using errcode = '42501';
    end if;
    if p_action in ('two_factor_disable', 'recovery_codes')
       and not private.has_two_factor(v_user_id) then
      raise exception 'two-factor sign-in is off' using errcode = '42501';
    end if;

    perform private.lock_sign_in_methods(v_user_id);
    v_expires_at := pg_catalog.now() + private.account_change_grant_lifetime();
    insert into private.account_change_grants (user_id, action, session_id, expires_at)
      values (v_user_id, p_action, p_session_id, v_expires_at)
      on conflict (user_id, action) do update
        set session_id = excluded.session_id, expires_at = excluded.expires_at,
            created_at = pg_catalog.now();
    perform private.record_security_event(v_user_id, 'reauthenticated', v_session_id);
    return v_expires_at;
  end
  $$;

-- Home deletions -----------------------------------------------------------------------------------

create table private.home_deletions (
  home_id uuid primary key references public.homes (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  -- The purge job's last failure, for operators; never shown to members.
  purge_attempts integer not null default 0,
  purge_error text,
  constraint home_deletions_window_check check (purge_after > requested_at)
);

create index home_deletions_due_idx on private.home_deletions (purge_after);

revoke all on table private.home_deletions from public;

comment on table private.home_deletions is
  'S40: Homes closed by their Owner, inaccessible until restored or purged. Not exposed.';

-- Memberships: the table moves aside, the name becomes the filtered view ---------------------------

alter table public.home_memberships set schema private;
alter table private.home_memberships rename to home_memberships_all;

comment on table private.home_memberships_all is
  'Every Home membership, including Homes pending deletion (S40). Read public.home_memberships '
  'instead; only integrity checks and the deletion functions read this table directly.';

-- Whether a Home is not pending deletion. The membership view below runs as its reader (as every
-- view in schema public must), so the API roles need to execute this; it reveals nothing more than
-- whether a Home id is closed.
create function private.home_is_open(p_home_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
    select not exists (select 1 from private.home_deletions d where d.home_id = p_home_id)
  $$;

revoke all on function private.home_is_open(uuid) from public;
grant execute on function private.home_is_open(uuid) to authenticated, service_role;

-- The view runs as its reader: the API roles keep the table's row-level policy (their own rows
-- only, through the select grant kept below), security definer functions and the service role see
-- every membership. The check option refuses any write that would put a membership into a Home
-- pending deletion.
create view public.home_memberships with (security_invoker = true, security_barrier = true) as
  select m.id, m.home_id, m.user_id, m.role, m.created_at
  from private.home_memberships_all m
  where private.home_is_open(m.home_id)
  with cascaded check option;

comment on view public.home_memberships is
  'Current Home memberships with their role; exactly one Owner per Home (S09). Homes pending '
  'deletion are left out (S40).';

revoke all on table public.home_memberships from public, anon, authenticated;
grant select (id, home_id, user_id, role, created_at) on table public.home_memberships
  to authenticated;

-- Policies are stored bound to the table, not its name: the seven that read memberships follow it
-- unless they are recreated against the view. Same text as before (S09, S11, S13, S22, S26).
drop policy homes_select_member on public.homes;
create policy homes_select_member on public.homes
  for select
  to authenticated
  using (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = homes.id and m.user_id = (select auth.uid())
    )
  );

drop policy home_member_profiles_select_own on public.home_member_profiles;
create policy home_member_profiles_select_own on public.home_member_profiles
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  );

drop policy home_member_profiles_insert_own on public.home_member_profiles;
create policy home_member_profiles_insert_own on public.home_member_profiles
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  );

drop policy home_member_profiles_update_own on public.home_member_profiles;
create policy home_member_profiles_update_own on public.home_member_profiles
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.home_memberships m
      where m.home_id = home_member_profiles.home_id and m.user_id = (select auth.uid())
    )
  );

drop policy notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select
  to authenticated
  using (
    user_id = (select auth.uid()) and show_in_app
    and (
      home_id is null
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = notifications.home_id and m.user_id = (select auth.uid())
      )
    )
  );

drop policy chore_pool_signals_select_member on public.chore_pool_signals;
create policy chore_pool_signals_select_member on public.chore_pool_signals
  for select
  to authenticated
  using (
    exists (
      select 1 from public.home_memberships m
      where m.home_id = chore_pool_signals.home_id and m.user_id = (select auth.uid())
    )
  );

drop policy shopping_signals_select_own on public.shopping_signals;
create policy shopping_signals_select_own on public.shopping_signals
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.home_memberships m
      where m.home_id = shopping_signals.home_id and m.user_id = (select auth.uid())
    )
  );

-- As S09, reading the table: a Home pending deletion still has its Owner.
create or replace function private.check_home_has_owner() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_home_id uuid;
  begin
    if tg_table_name = 'homes' then
      v_home_id := new.id;
    else
      v_home_id := old.home_id;
    end if;

    if exists (select 1 from public.homes h where h.id = v_home_id)
       and not exists (
         select 1 from private.home_memberships_all m
         where m.home_id = v_home_id and m.role = 'owner'
       ) then
      raise exception 'a Home must always have an Owner'
        using errcode = '23514',
              hint = 'Ownership changes only through an accepted transfer (S12).';
    end if;
    return null;
  end
  $$;

-- The Owner of a Home, also while it is pending deletion.
create function private.home_owner_any(p_home_id uuid) returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from private.home_memberships_all m
    where m.home_id = p_home_id and m.role = 'owner'
  $$;

revoke all on function private.home_owner_any(uuid) from public;

-- Departure work: the three assignment rules as callable functions ----------------------------------
--
-- The departure triggers (S18, S19, S21-S23) stay as they are in behaviour; their bodies move here so
-- an account deletion can apply the same rules while the membership still exists.

create function private.flag_member_tasks(p_home_id uuid, p_user_id uuid) returns void
  language sql security definer set search_path = '' as $$
    update private.tasks t set needs_reassignment = true
      where t.owner_home_id = p_home_id and t.completed_at is null and not t.needs_reassignment
        and exists (
          select 1 from private.task_assignees a where a.task_id = t.id and a.user_id = p_user_id
        );
  $$;

create function private.flag_member_series(p_home_id uuid, p_user_id uuid) returns void
  language sql security definer set search_path = '' as $$
    update private.task_series s set needs_reassignment = true
      where s.owner_home_id = p_home_id and s.deleted_at is null and s.superseded_at is null
        and not s.needs_reassignment
        and exists (
          select 1 from private.task_series_assignees a where a.series_id = s.id and a.user_id = p_user_id
        );
  $$;

-- p_departed false: the account deletion request (S40), while the person is still a member; the
-- releases and ended requests then carry neutral reasons. Either way, while the transaction is
-- deleting this person's account (madeora.account_deletion), nobody else is notified: the spec keeps
-- account deletion and the reassignments it causes free of alerts to other members.
create function private.release_member_chores(
  p_home_id uuid, p_user_id uuid, p_departed boolean default true
) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_request private.chore_reassignment_requests;
    v_released uuid[];
    v_silent boolean := coalesce(pg_catalog.current_setting('madeora.account_deletion', true), '')
      = p_user_id::text;
  begin
    with released as (
      update private.chore_occurrences o set claimed_by = null, claimed_at = null,
          revision = o.revision + 1, updated_at = pg_catalog.now()
        where o.home_id = p_home_id and o.status = 'open' and o.claimed_by = p_user_id
        returning o.id
    )
    select coalesce(array_agg(r.id), '{}') into v_released from released r;
    update private.chore_occurrence_steps s set checked_at = null, checked_by = null
      where s.occurrence_id = any (v_released) and s.checked_at is not null;
    insert into private.chore_occurrence_events (occurrence_id, kind, reason, previous_contributor_id)
      select r, 'released', case when p_departed then 'departure' else 'unavailable' end, p_user_id
      from unnest(v_released) as r;
    update private.chore_occurrences o set needs_reassignment = true
      where o.home_id = p_home_id and o.status = 'open' and not o.needs_reassignment
        and not (o.id = any (v_released))
        and exists (
          select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = o.id and a.user_id = p_user_id
        );
    update private.chore_schedules s set needs_reassignment = true
      where s.home_id = p_home_id and s.superseded_at is null and not s.needs_reassignment
        and exists (
          select 1 from private.chore_schedule_members m
          where m.schedule_id = s.id and m.user_id = p_user_id
        );
    for v_request in
      select * from private.chore_reassignment_requests r
      where r.home_id = p_home_id and r.status in ('pending', 'awaiting_manager')
        and p_user_id in (r.from_user, r.to_user, r.requested_by)
    loop
      if v_silent then
        update private.chore_reassignment_requests r
          set status = 'invalidated', decided_at = pg_catalog.now(),
              invalid_reason = case when p_departed then 'member_left' else 'assignment_changed' end
          where r.id = v_request.id and r.status in ('pending', 'awaiting_manager');
      else
        perform private.invalidate_chore_request(
          v_request, case when p_departed then 'member_left' else 'assignment_changed' end);
      end if;
    end loop;
  end
  $$;

revoke all on function private.flag_member_tasks(uuid, uuid) from public;
revoke all on function private.flag_member_series(uuid, uuid) from public;
revoke all on function private.release_member_chores(uuid, uuid, boolean) from public;

create or replace function private.flag_departed_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.flag_member_tasks(old.home_id, old.user_id);
    return old;
  end
  $$;

create or replace function private.flag_departed_series_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.flag_member_series(old.home_id, old.user_id);
    return old;
  end
  $$;

create or replace function private.flag_departed_chore_assignments() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.release_member_chores(old.home_id, old.user_id);
    return old;
  end
  $$;

-- Close a Home -------------------------------------------------------------------------------------

-- Invitations ended by a Home deletion never become valid again (spec).
alter table private.home_invitations drop constraint home_invitations_end_check;
alter table private.home_invitations
  add constraint home_invitations_end_check
  check ((end_reason is null) = (ended_at is null)
    and end_reason in ('revoked', 'declined', 'home_closed'));

-- What closing a Home affects, for its Owner's confirmation page. Counts only: no names.
create function public.home_closure_summary(p_home_id uuid)
returns table (member_count integer, pending_invitations integer, shared_calendars integer)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if private.home_role(p_home_id, v_user_id) is distinct from 'owner' then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    return query
      select
        (select count(*)::integer from public.home_memberships m where m.home_id = p_home_id),
        (select count(*)::integer from private.home_invitations i
          where i.home_id = p_home_id and i.ended_at is null and i.expires_at > pg_catalog.now()
            and (i.max_admissions is null or i.admissions < i.max_admissions)),
        (select count(*)::integer from private.google_calendar_home_shares s
          where s.home_id = p_home_id);
  end
  $$;

-- Closes a Home: the Owner only, with a fresh 'close_home' re-authentication from this session and
-- the Home's exact name typed. Every member (the Owner included) loses access at once; pending
-- invitations, join requests, ownership offers and recovery cases end for good; exports of the Home
-- end. Every member gets an in-app notice and an email. It carries no Home id (they can no longer
-- open it) but the Home's name, which every member already knew, so they can tell which Home it is.
-- A repeated call by the Owner returns the same deadline.
create function public.close_home(p_home_id uuid, p_confirm_name text) returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_home public.homes;
    v_purge_after timestamptz;
    v_member uuid;
    v_id uuid;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if not private.lock_home(p_home_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    -- Already closed (a retry, a double click): the same answer, once more, for the Owner only.
    select d.purge_after into v_purge_after from private.home_deletions d where d.home_id = p_home_id;
    if v_purge_after is not null then
      if private.home_owner_any(p_home_id) = v_user_id then
        return v_purge_after;
      end if;
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if private.home_role(p_home_id, v_user_id) is distinct from 'owner' then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    select * into v_home from public.homes h where h.id = p_home_id;
    if p_confirm_name is null or pg_catalog.btrim(p_confirm_name) <> v_home.name then
      raise exception 'confirmation does not match' using errcode = '22023', hint = 'confirmation';
    end if;
    if not private.consume_account_change_grant(v_user_id, 'close_home', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    v_purge_after := pg_catalog.now() + private.deletion_recovery_period();

    -- Exports that hold this Home end now (data_export_homes still sees the Home here).
    for v_id in
      select e.id from private.data_exports e
      where e.status in ('queued', 'preparing', 'ready')
        and ((e.kind = 'home' and e.home_id = p_home_id)
          or (e.kind = 'personal' and p_home_id = any (private.data_export_homes(e))))
    loop
      perform private.end_data_export(v_id, 'invalidated', 'access_changed');
    end loop;

    update private.home_invitations i
      set ended_at = pg_catalog.now(), ended_by = v_user_id, end_reason = 'home_closed'
      where i.home_id = p_home_id and i.ended_at is null;
    update private.home_join_requests r
      set status = 'expired', decided_at = pg_catalog.now()
      where r.home_id = p_home_id and r.status = 'pending';
    update private.home_ownership_transfers t
      set status = 'invalid', decided_at = pg_catalog.now()
      where t.home_id = p_home_id and t.status = 'pending';
    update private.home_ownership_recoveries r
      set status = 'invalid', decided_at = pg_catalog.now(), paused_from = null
      where r.home_id = p_home_id and r.status in ('submitted', 'in_review', 'approved', 'paused');

    insert into private.home_deletions (home_id, requested_by, purge_after)
      values (p_home_id, v_user_id, v_purge_after);

    perform private.audit('home.deletion_requested', p_home_id, 'home', p_home_id,
      pg_catalog.jsonb_build_object('purge_after', v_purge_after));
    perform private.record_account_activity(v_user_id, 'home_memberships', 'home.closed', 'pending',
      p_home_id);
    for v_member in
      select m.user_id from private.home_memberships_all m where m.home_id = p_home_id
      order by m.user_id
    loop
      perform private.notify_user(
        v_member, null, 'security', 'home.deletion_started',
        pg_catalog.jsonb_build_object('homeId', p_home_id, 'homeName', v_home.name,
          'purgeAt', v_purge_after),
        'home.deletion_started:' || p_home_id::text || ':'
          || pg_catalog.to_char(v_purge_after at time zone 'UTC', 'YYYYMMDDHH24MISS'), true);
    end loop;
    return v_purge_after;
  end
  $$;

-- The caller's closed Homes (they are the Owner), with the deadline, for the restore page.
create function public.my_closed_homes()
returns table (home_id uuid, home_name text, requested_at timestamptz, purge_after timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return query
      select h.id, h.name, d.requested_at, d.purge_after
      from private.home_deletions d
      join public.homes h on h.id = d.home_id
      join private.home_memberships_all m
        on m.home_id = d.home_id and m.user_id = v_user_id and m.role = 'owner'
      where d.purge_after > pg_catalog.now()
      order by d.purge_after, h.id;
  end
  $$;

-- Restores a closed Home before its deadline: its current Owner only, with a fresh 'close_home'
-- re-authentication. Everything that stayed (members, roles, content, settings) is accessible
-- again; ended invitations stay ended. Every member is told (in-app and email).
create function public.restore_home(p_home_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_deletion private.home_deletions;
    v_name text;
    v_member uuid;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if not private.lock_home(p_home_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    select * into v_deletion from private.home_deletions d where d.home_id = p_home_id for update;
    if not found or private.home_owner_any(p_home_id) is distinct from v_user_id then
      -- Not closed (perhaps restored by a double click), or not theirs: the Owner of an open Home
      -- gets a quiet success, anyone else nothing.
      if not found and private.home_role(p_home_id, v_user_id) = 'owner' then
        return;
      end if;
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_deletion.purge_after <= pg_catalog.now() then
      raise exception 'recovery period ended' using errcode = 'P0001', hint = 'expired';
    end if;
    if not private.consume_account_change_grant(v_user_id, 'close_home', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    delete from private.home_deletions d where d.home_id = p_home_id;
    select h.name into v_name from public.homes h where h.id = p_home_id;
    perform private.audit('home.restored', p_home_id, 'home', p_home_id);
    perform private.record_account_activity(v_user_id, 'home_memberships', 'home.restored', 'completed',
      p_home_id);
    for v_member in
      select m.user_id from private.home_memberships_all m where m.home_id = p_home_id
      order by m.user_id
    loop
      perform private.notify_user(
        v_member, null, 'security', 'home.restored',
        pg_catalog.jsonb_build_object('homeId', p_home_id, 'homeName', v_name),
        'home.restored:' || p_home_id::text || ':' || pg_catalog.gen_random_uuid()::text, true);
    end loop;
  end
  $$;

-- Account deletion -----------------------------------------------------------------------------------

create table private.account_deletions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  purge_attempts integer not null default 0,
  purge_error text,
  constraint account_deletions_window_check check (purge_after > requested_at)
);

create index account_deletions_due_idx on private.account_deletions (purge_after);

revoke all on table private.account_deletions from public;

comment on table private.account_deletions is
  'S40: accounts whose holder asked for deletion; suspended until cancelled or purged. Not exposed.';

-- What an account suspension does beyond its marker row (S38 deactivation, S40 deletion): no browser
-- stays trusted, pending ownership offers to or from the account end, Google Calendar pauses until
-- the person reconnects it, and every session ends.
create function private.suspend_account(p_user_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_transfer record;
  begin
    perform private.revoke_all_trust(p_user_id);
    for v_transfer in
      update private.home_ownership_transfers t
        set status = 'invalid', decided_at = pg_catalog.now()
        where t.status = 'pending' and (t.to_user_id = p_user_id or t.from_user_id = p_user_id)
        returning t.id, t.home_id
    loop
      perform private.audit('home_ownership.transfer_invalid', v_transfer.home_id,
        'ownership_transfer', v_transfer.id);
    end loop;

    perform pg_catalog.set_config('madeora.deactivating', p_user_id::text, true);
    update private.google_calendar_connections c
      set status = 'authorization_expired', status_changed_at = pg_catalog.now()
      where c.user_id = p_user_id and c.status = 'connected';
    perform pg_catalog.set_config('madeora.deactivating', '', true);

    delete from auth.sessions s where s.user_id = p_user_id;
  end
  $$;

revoke all on function private.suspend_account(uuid) from public;

-- As S38, with the shared suspension steps in private.suspend_account.
create or replace function public.deactivate_my_account() returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if private.is_deactivated(v_user_id) then
      return;
    end if;
    perform private.lock_home(m.home_id) from public.home_memberships m
      where m.user_id = v_user_id order by m.home_id;
    if exists (select 1 from public.my_deactivation_blockers()) then
      raise exception 'sole owner' using errcode = 'P0001', hint = 'sole_owner';
    end if;
    if not private.consume_account_change_grant(v_user_id, 'deactivate_account', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    perform private.record_security_event(v_user_id, 'account_deactivated', v_session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.deactivated', '{}'::jsonb,
      'account.deactivated:' || pg_catalog.gen_random_uuid()::text, true);
    insert into private.account_deactivations (user_id) values (v_user_id);
    perform private.suspend_account(v_user_id);
  end
  $$;

-- Asks for the caller's account to be deleted. Needs a fresh 'delete_account' re-authentication
-- from this session and no active Home the caller owns (a Home they closed does not block: it is
-- purged with the account). The account is suspended at once; its Home-owned open tasks, recurring
-- series and chores are flagged for reassignment (claims released) without any notice to other
-- members. Returns the permanent-deletion deadline.
create function public.request_account_deletion() returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_purge_after timestamptz;
    v_home uuid;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    select d.purge_after into v_purge_after from private.account_deletions d where d.user_id = v_user_id;
    if v_purge_after is not null then
      return v_purge_after;
    end if;
    perform private.lock_home(m.home_id) from public.home_memberships m
      where m.user_id = v_user_id order by m.home_id;
    if exists (select 1 from public.my_deactivation_blockers()) then
      raise exception 'sole owner' using errcode = 'P0001', hint = 'sole_owner';
    end if;
    if not private.consume_account_change_grant(v_user_id, 'delete_account', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    v_purge_after := pg_catalog.now() + private.deletion_recovery_period();
    perform private.record_account_activity(v_user_id, 'privacy', 'account_deletion_requested', 'pending');
    perform private.notify_user(
      v_user_id, null, 'security', 'account.deletion_requested',
      pg_catalog.jsonb_build_object('purgeAt', v_purge_after),
      'account.deletion_requested:' || pg_catalog.gen_random_uuid()::text, true);

    perform pg_catalog.set_config('madeora.account_deletion', v_user_id::text, true);
    for v_home in
      select m.home_id from public.home_memberships m where m.user_id = v_user_id order by m.home_id
    loop
      perform private.flag_member_tasks(v_home, v_user_id);
      perform private.flag_member_series(v_home, v_user_id);
      perform private.release_member_chores(v_home, v_user_id, false);
    end loop;
    perform pg_catalog.set_config('madeora.account_deletion', '', true);

    insert into private.account_deletions (user_id, purge_after) values (v_user_id, v_purge_after);
    insert into private.account_deactivations (user_id) values (v_user_id)
      on conflict (user_id) do nothing;
    perform private.suspend_account(v_user_id);
    return v_purge_after;
  end
  $$;

-- As S38, plus when the account is pending deletion, and until when.
drop function public.my_account_state();
create function public.my_account_state()
returns table (
  deactivated_at timestamptz, review_due boolean,
  deletion_requested_at timestamptz, deletion_purge_after timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    return query
      select d.deactivated_at,
             coalesce((select i.review_due from private.account_inactivity i where i.user_id = v_user_id), false),
             x.requested_at, x.purge_after
      from (select 1) one
      left join private.account_deactivations d on d.user_id = v_user_id
      left join private.account_deletions x on x.user_id = v_user_id;
  end
  $$;

-- As S38. For an account pending deletion this is the cancellation: the account is restored with
-- the memberships that still exist (anyone removed meanwhile stays removed), transferred ownership
-- stays transferred, Google Calendar stays paused until reconnected, flagged work stays flagged. Too
-- late (the deadline passed and the purge has not run yet) is refused.
create or replace function public.reactivate_my_account() returns timestamptz
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_since timestamptz;
    v_deletion private.account_deletions;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id)
       or private.request_session_state() not in ('ok', 'account_deactivated') then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    select * into v_deletion from private.account_deletions x where x.user_id = v_user_id for update;
    if found and v_deletion.purge_after <= pg_catalog.now() then
      raise exception 'recovery period ended' using errcode = 'P0001', hint = 'expired';
    end if;
    delete from private.account_deactivations d where d.user_id = v_user_id
      returning d.deactivated_at into v_since;
    if v_since is null then
      raise exception 'not deactivated' using errcode = 'P0002';
    end if;
    insert into private.account_inactivity (user_id, last_active_at)
      values (v_user_id, pg_catalog.now())
      on conflict (user_id) do update
        set last_active_at = excluded.last_active_at, reminders_sent = 0, last_reminder_at = null;
    if v_deletion.user_id is not null then
      delete from private.account_deletions x where x.user_id = v_user_id;
      perform private.record_account_activity(v_user_id, 'privacy', 'account_deletion_canceled', 'completed');
      perform private.notify_user(
        v_user_id, null, 'security', 'account.deletion_canceled', '{}'::jsonb,
        'account.deletion_canceled:' || pg_catalog.gen_random_uuid()::text, true);
    else
      perform private.record_security_event(v_user_id, 'account_reactivated', v_session_id);
      perform private.notify_user(
        v_user_id, null, 'security', 'account.reactivated', '{}'::jsonb,
        'account.reactivated:' || pg_catalog.gen_random_uuid()::text, true);
    end if;
    delete from auth.sessions s where s.id = v_session_id;
    return v_since;
  end
  $$;

-- Purge (service role; the hourly job) ---------------------------------------------------------------

-- Deletes a Home with everything it owns. The memberships go first, while the Home still exists:
-- their departure rules update Home rows (tasks, chores), which must not happen after the Home row
-- itself is gone in the same statement.
create function private.purge_home(p_home_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.home_memberships_all m where m.home_id = p_home_id;
    delete from public.homes h where h.id = p_home_id;
    -- The closing and restoring notices carry the Home's name without a Home id column (members
    -- could not read them otherwise); they go with the Home.
    delete from public.notifications n
      where n.home_id is null and n.kind in ('home.deletion_started', 'home.restored')
        and n.params ->> 'homeId' = p_home_id::text;
    perform private.audit('home.purged', p_home_id, 'home', p_home_id);
  end
  $$;

revoke all on function private.purge_home(uuid) from public;

-- Permanently deletes Homes and accounts whose recovery period has ended, at most p_limit of each.
-- A Home goes with all of its data (members' personal originals stay; their shares into it end with
-- it). An account first takes the Homes it owns that are pending deletion (nobody else could restore
-- them), then goes itself: its personal data with it, its memberships end under the departure rules,
-- and Home-owned history keeps its rows with the person's id gone ("Former member"). Each item runs
-- in its own sub-transaction; a failure is recorded and retried next time. Returns the counts.
create function public.purge_due_deletions(p_limit integer default 20) returns jsonb
  language plpgsql security definer set search_path = '' as $$
  declare
    v_home uuid;
    v_user uuid;
    v_homes integer := 0;
    v_accounts integer := 0;
    v_failed integer := 0;
    v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  begin
    for v_home in
      select d.home_id from private.home_deletions d
      where d.purge_after <= pg_catalog.now()
      order by d.purge_attempts, d.purge_after
      limit v_limit
    loop
      begin
        perform 1 from private.home_deletions d
          where d.home_id = v_home and d.purge_after <= pg_catalog.now() for update skip locked;
        if found then
          perform private.purge_home(v_home);
          -- Run the deferred checks now, inside this item, so a failure stays with it.
          set constraints all immediate;
          set constraints all deferred;
          v_homes := v_homes + 1;
        end if;
      exception when others then
        set constraints all deferred;
        v_failed := v_failed + 1;
        update private.home_deletions d
          set purge_attempts = d.purge_attempts + 1, purge_error = sqlstate
          where d.home_id = v_home;
      end;
    end loop;

    for v_user in
      select x.user_id from private.account_deletions x
      where x.purge_after <= pg_catalog.now()
      order by x.purge_attempts, x.purge_after
      limit v_limit
    loop
      begin
        perform 1 from private.account_deletions x
          where x.user_id = v_user and x.purge_after <= pg_catalog.now() for update skip locked;
        if found then
          -- Closed Homes the account owns go first; an active one it owns (it cannot have one: the
          -- request refused it and nobody can offer it ownership while suspended) stops the purge.
          perform private.purge_home(d.home_id)
            from private.home_deletions d
            join private.home_memberships_all m on m.home_id = d.home_id
            where m.user_id = v_user and m.role = 'owner';
          -- The memberships end first, under the departure rules but without notices to anyone
          -- (release_member_chores), then the account with its personal data.
          perform pg_catalog.set_config('madeora.account_deletion', v_user::text, true);
          delete from private.home_memberships_all m where m.user_id = v_user;
          delete from auth.users u where u.id = v_user;
          set constraints all immediate;
          set constraints all deferred;
          perform pg_catalog.set_config('madeora.account_deletion', '', true);
          perform private.audit('account.purged', null, 'user', v_user);
          v_accounts := v_accounts + 1;
        end if;
      exception when others then
        set constraints all deferred;
        perform pg_catalog.set_config('madeora.account_deletion', '', true);
        v_failed := v_failed + 1;
        update private.account_deletions x
          set purge_attempts = x.purge_attempts + 1, purge_error = sqlstate
          where x.user_id = v_user;
      end;
    end loop;

    return pg_catalog.jsonb_build_object('homes', v_homes, 'accounts', v_accounts, 'failed', v_failed);
  end
  $$;

-- Grants -----------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.authorize_account_change(text, uuid)',
    'public.home_closure_summary(uuid)',
    'public.close_home(uuid, text)',
    'public.my_closed_homes()',
    'public.restore_home(uuid)',
    'public.deactivate_my_account()',
    'public.request_account_deletion()',
    'public.my_account_state()',
    'public.reactivate_my_account()'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
end
$$;

revoke all on function public.purge_due_deletions(integer) from public, anon, authenticated;
grant execute on function public.purge_due_deletions(integer) to service_role;
