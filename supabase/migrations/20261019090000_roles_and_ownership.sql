-- S12: role management and ownership (brief S12; spec "Confirmed Home ownership transfer",
-- "Confirmed exactly one Home Owner", "Confirmed customizable Administrator permissions",
-- "Confirmed Home member-removal authority" and its reaffirmation, "Confirmed privacy-minimized
-- Home history after adult departure", "Confirmed voluntary Home departure", "Confirmed guided
-- transfer-or-close for departing Home Owner").
--
-- What the API can do here, and nothing more, always through the security definer functions below:
-- - the Owner makes a Member an Administrator or an Administrator a Member, and grants or revokes
--   an Administrator's individual capabilities;
-- - the Owner removes Members and Administrators; an Administrator granted removeMembers removes
--   Members only; nobody removes the Owner;
-- - Members and Administrators leave; the Owner cannot leave while they are the Owner;
-- - the Owner nominates an existing member as the next Owner; only that member accepts or
--   declines; the Owner cancels. Acceptance swaps the two roles in one transaction.
-- Memberships and capabilities still have no direct API write path. Every function that changes a
-- membership locks the Home's row first, so all such changes in one Home run one at a time and
-- re-check authority after the lock (one lock order: Home, then anything else).

-- Audit subjects ----------------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in ('home', 'user', 'invitation', 'join_request', 'ownership_transfer'));

-- Administrator capabilities ----------------------------------------------------------------------

-- The capabilities the Owner may grant an Administrator, one by one (packages/domain
-- delegableCapabilities). None of them reaches an Owner-only power (ownership transfer, Home
-- deletion, managing Administrators or their capabilities).
create function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in ('manageHomeSettings', 'manageInvitations', 'removeMembers');
  $$;

create table private.home_admin_capabilities (
  home_id uuid not null,
  user_id uuid not null,
  capability text not null
    constraint home_admin_capabilities_capability_check
      check (private.is_delegable_capability(capability)),
  granted_by uuid,
  granted_at timestamptz not null default now(),
  constraint home_admin_capabilities_pkey primary key (home_id, user_id, capability),
  -- A grant belongs to the membership: it ends with it, so it never survives a departure or
  -- reappears on a later re-join.
  constraint home_admin_capabilities_membership_fkey foreign key (home_id, user_id)
    references public.home_memberships (home_id, user_id) on delete cascade
);

comment on table private.home_admin_capabilities is
  'Capabilities the Owner granted to an Administrator of a Home (S12). Not exposed through the API.';

-- Only Administrators hold capabilities, whatever path writes them.
create function private.check_capability_holder() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if not exists (
      select 1 from public.home_memberships m
      where m.home_id = new.home_id and m.user_id = new.user_id and m.role = 'administrator'
    ) then
      raise exception 'only Administrators hold capabilities' using errcode = '23514';
    end if;
    return new;
  end
  $$;

create trigger home_admin_capabilities_holder
  before insert or update on private.home_admin_capabilities
  for each row execute function private.check_capability_holder();

-- A role change away from Administrator (to Member, or to Owner through a transfer) drops every
-- grant, so a later promotion starts again from none.
create function private.drop_capabilities_on_role_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if new.role <> 'administrator' and old.role = 'administrator' then
      delete from private.home_admin_capabilities c
        where c.home_id = new.home_id and c.user_id = new.user_id;
    end if;
    return null;
  end
  $$;

create trigger home_memberships_drop_capabilities
  after update of role on public.home_memberships
  for each row execute function private.drop_capabilities_on_role_change();

-- The one SQL authority rule for delegable actions: the Owner always, an Administrator only with
-- the grant (packages/domain decideHomeAction makes the same decision).
create function private.has_home_capability(p_home_id uuid, p_user_id uuid, p_capability text)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and exists (
    select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id = p_user_id
      and (
        m.role = 'owner'
        or (m.role = 'administrator' and exists (
          select 1 from private.home_admin_capabilities c
          where c.home_id = m.home_id and c.user_id = m.user_id and c.capability = p_capability
        ))
      )
  );
  $$;

-- The same rule for the signed-in caller only, for RLS policies. It can only ever answer about the
-- caller themselves, so granting it to the API role reveals nothing about anyone else.
create function private.caller_has_home_capability(p_home_id uuid, p_capability text)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.has_home_capability(p_home_id, auth.uid(), p_capability);
  $$;

revoke all on function private.caller_has_home_capability(uuid, text) from public, anon;
grant execute on function private.caller_has_home_capability(uuid, text) to authenticated;

-- Home settings: the Owner, or an Administrator granted manageHomeSettings (was Owner only).
drop policy homes_update_owner on public.homes;
create policy homes_update_manager on public.homes
  for update
  to authenticated
  using (private.caller_has_home_capability(homes.id, 'manageHomeSettings'))
  with check (private.caller_has_home_capability(homes.id, 'manageHomeSettings'));

-- Invitations: the Owner for both roles; an Administrator granted manageInvitations for the Member
-- role only (inviting or admitting Administrators stays Owner-only). invitation_state re-checks the
-- inviter with this rule, so an Administrator's invitations stop working the moment the grant is
-- revoked or they stop being an Administrator.
create or replace function private.can_manage_invitations(p_home_id uuid, p_user_id uuid, p_role text)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_role in ('member', 'administrator') and exists (
    select 1 from public.home_memberships m
    where m.home_id = p_home_id and m.user_id = p_user_id
      and (
        m.role = 'owner'
        or (p_role = 'member' and m.role = 'administrator' and exists (
          select 1 from private.home_admin_capabilities c
          where c.home_id = m.home_id and c.user_id = m.user_id
            and c.capability = 'manageInvitations'
        ))
      )
  );
  $$;

-- Ownership transfers -----------------------------------------------------------------------------

create table private.home_ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  home_id uuid not null references public.homes (id) on delete cascade,
  -- The Owner who nominated and the member nominated. No foreign keys to accounts: the record
  -- outlives a departure, and its state, not the account, decides what it can do.
  from_user_id uuid not null,
  to_user_id uuid not null,
  status text not null default 'pending'
    constraint home_ownership_transfers_status_check
      check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'invalid')),
  -- clock_timestamp(), so transfers started in one transaction still have an order.
  created_at timestamptz not null default clock_timestamp(),
  -- The spec leaves expiry open; 7 days is the S12 default (brief).
  expires_at timestamptz not null,
  decided_at timestamptz,
  creation_request_id uuid not null,
  constraint home_ownership_transfers_parties_check check (from_user_id <> to_user_id),
  constraint home_ownership_transfers_decided_check check ((status = 'pending') = (decided_at is null))
);

-- At most one pending transfer per Home, whoever starts it and however simultaneously.
create unique index home_ownership_transfers_one_pending
  on private.home_ownership_transfers (home_id) where status = 'pending';
create unique index home_ownership_transfers_request_key
  on private.home_ownership_transfers (from_user_id, creation_request_id);
create index home_ownership_transfers_home_idx
  on private.home_ownership_transfers (home_id, created_at desc);

comment on table private.home_ownership_transfers is
  'Ownership transfers: nomination, acceptance, decline, cancellation, expiry (S12). Not exposed.';

-- A pending transfer stops being acceptable as soon as its recipient leaves or is removed, or its
-- sender stops being the Owner, whatever path made that happen.
create function private.invalidate_ownership_transfers() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    if tg_op = 'DELETE' or (old.role = 'owner' and new.role <> 'owner') then
      for v_id in
        update private.home_ownership_transfers t
          set status = 'invalid', decided_at = pg_catalog.now()
          where t.home_id = old.home_id and t.status = 'pending'
            and (t.to_user_id = old.user_id or t.from_user_id = old.user_id)
          returning t.id
      loop
        perform private.audit('home_ownership.transfer_invalid', old.home_id, 'ownership_transfer',
          v_id);
      end loop;
    end if;
    return null;
  end
  $$;

create trigger home_memberships_invalidate_transfers
  after update of role or delete on public.home_memberships
  for each row execute function private.invalidate_ownership_transfers();

-- Departure: privacy-minimized history -------------------------------------------------------------

-- When a membership ends, the records that kept the person's verified email and display name for
-- managers (all their join requests in that Home, whatever their state, and the email invitation
-- they accepted) are deleted. The audit log keeps the id-only record of what happened. The Home profile already goes
-- with the membership (S11), and so do Administrator capabilities (above).
create function private.forget_departed_member() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    delete from private.home_invitations i
      where i.home_id = old.home_id and i.kind = 'email'
        and i.id in (
          select r.invitation_id from private.home_join_requests r
          where r.home_id = old.home_id and r.applicant_id = old.user_id and r.status = 'approved'
        );
    delete from private.home_join_requests r
      where r.home_id = old.home_id and r.applicant_id = old.user_id;
    return null;
  end
  $$;

create trigger home_memberships_forget_departed
  after delete on public.home_memberships
  for each row execute function private.forget_departed_member();

-- Membership audit: removed or left ---------------------------------------------------------------

-- As S09, plus why a membership ended: remove_home_member and leave_home set
-- madeora.membership_end for their own transaction; anything else (account deletion, Home deletion)
-- stays the generic 'ended'.
create or replace function private.audit_membership_change() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_reason text := pg_catalog.current_setting('madeora.membership_end', true);
  begin
    if tg_op = 'INSERT' then
      insert into private.audit_events (
        actor_user_id, home_id, action, subject_type, subject_id, details
      )
        values (
          auth.uid(), new.home_id, 'home_membership.created', 'user', new.user_id,
          pg_catalog.jsonb_build_object('role', new.role)
        );
    elsif tg_op = 'UPDATE' then
      if new.role is distinct from old.role then
        insert into private.audit_events (
          actor_user_id, home_id, action, subject_type, subject_id, details
        )
          values (
            auth.uid(), new.home_id, 'home_membership.role_changed', 'user', new.user_id,
            pg_catalog.jsonb_build_object('from', old.role, 'to', new.role)
          );
      end if;
    else
      insert into private.audit_events (
        actor_user_id, home_id, action, subject_type, subject_id, details
      )
        values (
          auth.uid(), old.home_id,
          case when v_reason in ('removed', 'left')
            then 'home_membership.' || v_reason else 'home_membership.ended' end,
          'user', old.user_id,
          pg_catalog.jsonb_build_object('role', old.role)
        );
    end if;
    return null;
  end
  $$;

-- Helpers ------------------------------------------------------------------------------------------

-- Locks the Home's row for the rest of the transaction, so every membership change in that Home
-- runs one at a time; returns false when the Home does not exist. Call it in a statement of its
-- own: in READ COMMITTED each later statement sees what other transactions committed while this
-- one waited for the lock, but an expression evaluated together with the lock does not.
create function private.lock_home(p_home_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
  begin
    perform 1 from public.homes h where h.id = p_home_id for update;
    return found;
  end
  $$;

-- The caller's role in a Home now, or null.
create function private.home_role(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select m.role from public.home_memberships m
  where m.home_id = p_home_id and m.user_id = p_user_id;
  $$;

-- What a transfer can do now: its stored status, or 'expired' for a pending one past its expiry.
create function private.transfer_state(p_transfer private.home_ownership_transfers) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_transfer.status = 'pending' and p_transfer.expires_at <= pg_catalog.now() then 'expired'
    else p_transfer.status
  end;
  $$;

-- Marks pending transfers of a Home that have passed their expiry as expired (the Home is locked).
create function private.expire_ownership_transfers(p_home_id uuid) returns void
  language plpgsql security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    for v_id in
      update private.home_ownership_transfers t
        set status = 'expired', decided_at = t.expires_at
        where t.home_id = p_home_id and t.status = 'pending' and t.expires_at <= pg_catalog.now()
        returning t.id
    loop
      perform private.audit('home_ownership.transfer_expired', p_home_id, 'ownership_transfer', v_id);
    end loop;
  end
  $$;

-- Reading -----------------------------------------------------------------------------------------

-- The Administrator capabilities in a Home the caller belongs to. The Owner sees every
-- Administrator's grants (to inspect and edit them); anyone else sees only their own. Rows carry
-- membership ids, never account ids. Anyone who is not a member gets an error (42501).
create function public.home_capabilities(p_home_id uuid)
returns table (membership_id uuid, is_self boolean, capability text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_role text := private.home_role(p_home_id, v_user_id);
  begin
    if v_user_id is null or v_role is null then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;
    return query
      select m.id, m.user_id = v_user_id, c.capability
      from private.home_admin_capabilities c
      join public.home_memberships m on m.home_id = c.home_id and m.user_id = c.user_id
      where c.home_id = p_home_id and (v_role = 'owner' or c.user_id = v_user_id)
      order by m.id, c.capability;
  end
  $$;

comment on function public.home_capabilities(uuid) is
  'S12: Administrator grants in a Home; the Owner sees all, everyone else only their own.';

-- The Home's current ownership transfer as the caller may see it: a pending one to the Owner who
-- started it and to the member it nominates; a finished one only to the person who started it, for
-- 7 days, so they see that it was declined, expired or became invalid. Nothing for anyone else.
create function public.home_ownership_transfer(p_home_id uuid)
returns table (
  id uuid,
  state text,
  is_sender boolean,
  is_recipient boolean,
  recipient_membership_id uuid,
  created_at timestamptz,
  expires_at timestamptz,
  decided_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or private.home_role(p_home_id, v_user_id) is null then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;
    return query
      select t.id, private.transfer_state(t), t.from_user_id = v_user_id, t.to_user_id = v_user_id,
        m.id, t.created_at, t.expires_at,
        case when private.transfer_state(t) = 'expired' then coalesce(t.decided_at, t.expires_at)
          else t.decided_at end
      from private.home_ownership_transfers t
      left join public.home_memberships m on m.home_id = t.home_id and m.user_id = t.to_user_id
      where t.home_id = p_home_id
        and (
          (t.status = 'pending' and (t.from_user_id = v_user_id or t.to_user_id = v_user_id))
          or (t.status <> 'pending' and t.status <> 'accepted' and t.from_user_id = v_user_id
              and t.decided_at > pg_catalog.now() - interval '7 days')
        )
      order by t.created_at desc
      limit 1;
  end
  $$;

comment on function public.home_ownership_transfer(uuid) is
  'S12: the pending or recently ended ownership transfer visible to its sender or recipient.';

-- Roles and capabilities --------------------------------------------------------------------------

-- The Owner makes a Member an Administrator or an Administrator a Member. Never Owner (that is the
-- transfer) and never the Owner's own membership. p_expected_role is the target's role as the
-- Owner saw it: if it changed meanwhile nothing happens ('stale'). Outcomes: 'ok', 'unchanged',
-- 'not_found', 'not_permitted', 'stale'.
create function public.change_home_member_role(
  p_home_id uuid, p_membership_id uuid, p_role text, p_expected_role text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
  begin
    if p_role is null or p_role not in ('member', 'administrator')
       or p_expected_role is null or p_expected_role not in ('member', 'administrator') then
      raise exception 'invalid role' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) <> 'owner' then
      return 'not_permitted';
    end if;
    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    if v_target.role = 'owner' then
      return 'not_permitted';
    end if;
    if v_target.role <> p_expected_role then
      return 'stale';
    end if;
    if v_target.role = p_role then
      return 'unchanged';
    end if;
    -- The S09 trigger audits the change; the trigger above drops a demoted Administrator's grants.
    update public.home_memberships set role = p_role where id = v_target.id;
    return 'ok';
  end
  $$;

-- The Owner replaces an Administrator's capabilities with exactly p_capabilities (an empty array
-- revokes all). Unknown or repeated names are refused (22023). Outcomes: 'ok', 'unchanged',
-- 'not_found', 'not_permitted', 'stale' (the target is no longer an Administrator).
create function public.set_administrator_capabilities(
  p_home_id uuid, p_membership_id uuid, p_capabilities text[]
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_before text[];
    v_after text[];
  begin
    if p_capabilities is null
       or pg_catalog.array_ndims(p_capabilities) > 1
       or exists (
         select 1 from pg_catalog.unnest(p_capabilities) c(name)
         where c.name is null or not private.is_delegable_capability(c.name)
       )
       or (select pg_catalog.count(distinct c.name) from pg_catalog.unnest(p_capabilities) c(name))
          <> pg_catalog.cardinality(p_capabilities) then
      raise exception 'invalid capabilities' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) <> 'owner' then
      return 'not_permitted';
    end if;
    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    if v_target.role = 'owner' then
      return 'not_permitted';
    end if;
    if v_target.role <> 'administrator' then
      return 'stale';
    end if;

    select coalesce(pg_catalog.array_agg(c.capability order by c.capability), '{}')
      into v_before
      from private.home_admin_capabilities c
      where c.home_id = p_home_id and c.user_id = v_target.user_id;
    select coalesce(pg_catalog.array_agg(c.name order by c.name), '{}')
      into v_after
      from pg_catalog.unnest(p_capabilities) c(name);
    if v_before = v_after then
      return 'unchanged';
    end if;

    delete from private.home_admin_capabilities c
      where c.home_id = p_home_id and c.user_id = v_target.user_id
        and c.capability <> all (v_after);
    insert into private.home_admin_capabilities (home_id, user_id, capability, granted_by)
      select p_home_id, v_target.user_id, c.name, v_user_id
      from pg_catalog.unnest(v_after) c(name)
      where c.name <> all (v_before);
    perform private.audit('home_membership.capabilities_changed', p_home_id, 'user',
      v_target.user_id,
      pg_catalog.jsonb_build_object('from', pg_catalog.to_jsonb(v_before),
        'to', pg_catalog.to_jsonb(v_after)));
    return 'ok';
  end
  $$;

-- Removal and departure ---------------------------------------------------------------------------

-- Removes another member. The Owner removes Members and Administrators; an Administrator granted
-- removeMembers removes Members only; nobody removes the Owner; nobody removes themselves (that is
-- leave_home). Authority, the target's current role (p_expected_role, as the remover saw it) and
-- membership are re-checked under the Home lock. Outcomes: 'removed', 'not_found' (also when the
-- person was already removed: reported, never repeated), 'not_permitted', 'stale'.
create function public.remove_home_member(
  p_home_id uuid, p_membership_id uuid, p_expected_role text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_actor_role text;
    v_target public.home_memberships;
  begin
    if p_expected_role is null or p_expected_role not in ('member', 'administrator', 'owner') then
      raise exception 'invalid role' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    v_actor_role := private.home_role(p_home_id, v_user_id);
    if v_actor_role is null then
      return 'not_found';
    end if;
    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return 'not_found';
    end if;
    if v_target.role <> p_expected_role then
      return 'stale';
    end if;
    if v_target.user_id = v_user_id or v_target.role = 'owner' then
      return 'not_permitted';
    end if;
    if not (
      v_actor_role = 'owner'
      or (v_target.role = 'member'
          and private.has_home_capability(p_home_id, v_user_id, 'removeMembers'))
    ) then
      return 'not_permitted';
    end if;

    perform pg_catalog.set_config('madeora.membership_end', 'removed', true);
    delete from public.home_memberships where id = v_target.id;
    perform pg_catalog.set_config('madeora.membership_end', '', true);
    return 'removed';
  end
  $$;

-- The caller leaves a Home. Members and Administrators may leave at any time without anyone's
-- approval; the Owner cannot while they are the Owner (a pending or declined transfer is not
-- enough). Outcomes: 'left', 'not_found', 'owner_must_transfer'.
create function public.leave_home(p_home_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_role text;
  begin
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    v_role := private.home_role(p_home_id, v_user_id);
    if v_role is null then
      return 'not_found';
    end if;
    if v_role = 'owner' then
      return 'owner_must_transfer';
    end if;
    perform pg_catalog.set_config('madeora.membership_end', 'left', true);
    delete from public.home_memberships m where m.home_id = p_home_id and m.user_id = v_user_id;
    perform pg_catalog.set_config('madeora.membership_end', '', true);
    return 'left';
  end
  $$;

-- Ownership transfer ------------------------------------------------------------------------------

-- The Owner nominates an existing member (Member or Administrator; every account is an adult until
-- children and displays arrive, which must be refused here then) as the next Owner. Nothing changes
-- until they accept. One pending transfer per Home; a repeated p_request_id returns the transfer
-- that request already started. Outcomes: 'started', 'not_found', 'not_permitted',
-- 'pending_exists', 'invalid_target'.
create function public.start_ownership_transfer(
  p_home_id uuid, p_membership_id uuid, p_request_id uuid
) returns table (outcome text, transfer_id uuid)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_target public.home_memberships;
    v_existing private.home_ownership_transfers;
    v_id uuid;
  begin
    if p_request_id is null then
      raise exception 'a request id is required' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if private.home_role(p_home_id, v_user_id) <> 'owner' then
      return query select 'not_permitted'::text, null::uuid;
      return;
    end if;

    select * into v_existing from private.home_ownership_transfers t
      where t.from_user_id = v_user_id and t.creation_request_id = p_request_id;
    if found then
      return query select
        case when v_existing.home_id = p_home_id then 'started' else 'not_found' end,
        case when v_existing.home_id = p_home_id then v_existing.id end;
      return;
    end if;

    select * into v_target from public.home_memberships m
      where m.id = p_membership_id and m.home_id = p_home_id;
    if not found then
      return query select 'not_found'::text, null::uuid;
      return;
    end if;
    if v_target.user_id = v_user_id or v_target.role = 'owner'
       or private.confirmed_email(v_target.user_id) is null then
      return query select 'invalid_target'::text, null::uuid;
      return;
    end if;

    perform private.expire_ownership_transfers(p_home_id);
    if exists (
      select 1 from private.home_ownership_transfers t
      where t.home_id = p_home_id and t.status = 'pending'
    ) then
      return query select 'pending_exists'::text, null::uuid;
      return;
    end if;

    insert into private.home_ownership_transfers (
      home_id, from_user_id, to_user_id, expires_at, creation_request_id
    )
      values (
        p_home_id, v_user_id, v_target.user_id, pg_catalog.now() + interval '7 days', p_request_id
      )
      returning id into v_id;
    perform private.audit('home_ownership.transfer_started', p_home_id, 'ownership_transfer', v_id,
      pg_catalog.jsonb_build_object('to', v_target.user_id));
    return query select 'started'::text, v_id;
  end
  $$;

-- The Owner who started a pending transfer cancels it. Outcomes: 'cancelled', 'not_found',
-- 'not_permitted', 'already_decided' (also when it has expired or become invalid).
create function public.cancel_ownership_transfer(p_home_id uuid, p_transfer_id uuid) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_transfer private.home_ownership_transfers;
  begin
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    perform private.expire_ownership_transfers(p_home_id);
    select * into v_transfer from private.home_ownership_transfers t
      where t.id = p_transfer_id and t.home_id = p_home_id for update;
    if not found or (v_transfer.from_user_id <> v_user_id and v_transfer.to_user_id <> v_user_id) then
      return 'not_found';
    end if;
    if v_transfer.from_user_id <> v_user_id then
      return 'not_permitted';
    end if;
    if v_transfer.status <> 'pending' then
      return 'already_decided';
    end if;
    update private.home_ownership_transfers
      set status = 'cancelled', decided_at = pg_catalog.now()
      where id = v_transfer.id;
    perform private.audit('home_ownership.transfer_cancelled', p_home_id, 'ownership_transfer',
      v_transfer.id);
    return 'cancelled';
  end
  $$;

-- The nominated member accepts or declines. Acceptance re-checks, under the Home lock, that the
-- transfer is still pending and unexpired, that its sender is still the Owner and that the
-- recipient is still a member with a confirmed account; then the former Owner becomes a Member and
-- the recipient the Owner in one transaction. The S09 unique index allows at most one Owner at any
-- moment and the deferred trigger at least one at commit, so no committed state has none or two.
-- Outcomes: 'accepted', 'declined', 'not_found', 'already_decided', 'expired', 'no_longer_valid'.
create function public.respond_to_ownership_transfer(
  p_home_id uuid, p_transfer_id uuid, p_decision text
) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_transfer private.home_ownership_transfers;
  begin
    if p_decision is null or p_decision not in ('accept', 'decline') then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if private.home_role(p_home_id, v_user_id) is null then
      return 'not_found';
    end if;
    perform private.expire_ownership_transfers(p_home_id);
    select * into v_transfer from private.home_ownership_transfers t
      where t.id = p_transfer_id and t.home_id = p_home_id for update;
    if not found or v_transfer.to_user_id <> v_user_id then
      return 'not_found';
    end if;
    if v_transfer.status = 'expired' then
      return 'expired';
    end if;
    if v_transfer.status <> 'pending' then
      return 'already_decided';
    end if;

    if p_decision = 'decline' then
      update private.home_ownership_transfers
        set status = 'declined', decided_at = pg_catalog.now()
        where id = v_transfer.id;
      perform private.audit('home_ownership.transfer_declined', p_home_id, 'ownership_transfer',
        v_transfer.id);
      return 'declined';
    end if;

    if private.home_role(p_home_id, v_transfer.from_user_id) is distinct from 'owner'
       or private.confirmed_email(v_user_id) is null then
      update private.home_ownership_transfers
        set status = 'invalid', decided_at = pg_catalog.now()
        where id = v_transfer.id;
      perform private.audit('home_ownership.transfer_invalid', p_home_id, 'ownership_transfer',
        v_transfer.id);
      return 'no_longer_valid';
    end if;

    -- Marked accepted first, so the triggers that invalidate pending transfers on role changes
    -- leave this one alone. Then the swap: the former Owner steps down first (the one-Owner index
    -- is checked per statement), and the recipient becomes the Owner before the transaction ends.
    update private.home_ownership_transfers
      set status = 'accepted', decided_at = pg_catalog.now()
      where id = v_transfer.id;
    update public.home_memberships set role = 'member'
      where home_id = p_home_id and user_id = v_transfer.from_user_id;
    update public.home_memberships set role = 'owner'
      where home_id = p_home_id and user_id = v_user_id;
    perform private.audit('home_ownership.transfer_accepted', p_home_id, 'ownership_transfer',
      v_transfer.id, pg_catalog.jsonb_build_object('from', v_transfer.from_user_id));
    return 'accepted';
  end
  $$;

-- Join-request approval takes the Home lock too ----------------------------------------------------

-- As S10, with one change: the Home's row is locked before anything else, so an approval and a
-- simultaneous role change, removal or ownership transfer in the same Home run one after the other,
-- and the approver's authority is checked after the lock (an Owner who has just handed over
-- ownership can no longer admit an Administrator). Lock order: Home, request, invitation.
create or replace function public.decide_join_request(p_home_id uuid, p_request_id uuid, p_decision text)
returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_request private.home_join_requests;
    v_inv private.home_invitations;
  begin
    if p_decision is null or p_decision not in ('approve', 'decline') then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    -- The lock is its own statement: checks after it read what committed while it waited.
    if not private.lock_home(p_home_id) then
      return 'not_found';
    end if;
    if not exists (
      select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      return 'not_found';
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      return 'not_permitted';
    end if;

    select * into v_request from private.home_join_requests r
      where r.id = p_request_id and r.home_id = p_home_id for update;
    if not found then
      return 'not_found';
    end if;
    if not private.can_manage_invitations(p_home_id, v_user_id, v_request.role) then
      return 'not_permitted';
    end if;
    if v_request.status <> 'pending' then
      return 'already_decided';
    end if;
    select * into v_inv from private.home_invitations i where i.id = v_request.invitation_id
      for update;

    if p_decision = 'decline' then
      update private.home_join_requests
        set status = 'declined', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      -- An email invitation has one possible recipient: once they are declined it is finished.
      if v_inv.kind = 'email' and v_inv.end_reason is null then
        update private.home_invitations
          set ended_at = pg_catalog.now(), ended_by = v_user_id, end_reason = 'declined'
          where id = v_inv.id;
      end if;
      perform private.audit('join_request.declined', p_home_id, 'join_request', p_request_id,
        pg_catalog.jsonb_build_object('role', v_request.role));
      return 'declined';
    end if;

    if exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_request.applicant_id
    ) then
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      perform private.audit('join_request.expired', p_home_id, 'join_request', p_request_id,
        pg_catalog.jsonb_build_object('reason', 'already_member'));
      return 'already_member';
    end if;

    if private.invitation_state(v_inv) <> 'active'
       or v_request.role <> v_inv.role
       or private.confirmed_email(v_request.applicant_id) is null
       or (v_inv.kind = 'email'
           and v_inv.recipient_email is distinct from private.confirmed_email(v_request.applicant_id))
    then
      update private.home_join_requests
        set status = 'expired', decided_at = pg_catalog.now(), decided_by = v_user_id
        where id = p_request_id;
      perform private.audit('join_request.expired', p_home_id, 'join_request', p_request_id);
      return 'no_longer_valid';
    end if;

    -- The S09 trigger audits the new membership with the approver as the actor.
    insert into public.home_memberships (home_id, user_id, role)
      values (p_home_id, v_request.applicant_id, v_request.role);
    update private.home_invitations set admissions = admissions + 1 where id = v_inv.id;
    update private.home_join_requests
      set status = 'approved', decided_at = pg_catalog.now(), decided_by = v_user_id
      where id = p_request_id;
    perform private.audit('join_request.approved', p_home_id, 'join_request', p_request_id,
      pg_catalog.jsonb_build_object('role', v_request.role, 'kind', v_inv.kind));
    return 'approved';
  end
  $$;

-- The invitation and join-request lists, as S10, but each row only for someone allowed to manage
-- its role: an Administrator with manageInvitations sees Member invitations and requests only,
-- never the Owner's Administrator links, codes, invited emails or applicants.
create or replace function public.list_home_invitations(p_home_id uuid)
returns table (
  id uuid, kind text, role text, recipient_email text, email_locale text, state text,
  created_at timestamptz, expires_at timestamptz, ended_at timestamptz,
  max_admissions integer, admissions integer, pending_requests integer,
  delivery_status text, last_sent_at timestamptz, token text
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select i.id, i.kind, i.role, i.recipient_email, i.email_locale, s.state,
        i.created_at, i.expires_at, i.ended_at, i.max_admissions, i.admissions,
        (select pg_catalog.count(*)::integer from private.home_join_requests r
          where r.invitation_id = i.id and r.status = 'pending'),
        i.delivery_status, i.last_sent_at,
        case when s.state = 'active' and i.kind <> 'email' then i.token end
      from private.home_invitations i
      cross join lateral (select private.invitation_state(i) as state) s
      where i.home_id = p_home_id
        and private.can_manage_invitations(p_home_id, v_user_id, i.role)
        and (s.state = 'active' or coalesce(i.ended_at, i.expires_at) > pg_catalog.now() - interval '30 days'
             or i.created_at > pg_catalog.now() - interval '30 days')
      order by (s.state = 'active') desc, i.created_at desc
      limit 200;
  end
  $$;

create or replace function public.list_home_join_requests(p_home_id uuid)
returns table (
  id uuid, applicant_name text, applicant_email text, role text, kind text, state text,
  created_at timestamptz, decided_at timestamptz, can_decide boolean
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if not private.can_manage_invitations(p_home_id, v_user_id, 'member') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select r.id, r.applicant_name, r.applicant_email, r.role, i.kind, s.state,
        r.created_at, r.decided_at,
        s.state = 'pending' and private.can_manage_invitations(p_home_id, v_user_id, r.role)
      from private.home_join_requests r
      join private.home_invitations i on i.id = r.invitation_id
      cross join lateral (select private.request_state(r) as state) s
      where r.home_id = p_home_id
        and private.can_manage_invitations(p_home_id, v_user_id, r.role)
        and (r.status = 'pending' or r.decided_at > pg_catalog.now() - interval '30 days')
      order by (s.state = 'pending') desc, r.created_at desc
      limit 200;
  end
  $$;

-- API access --------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.home_capabilities(uuid)',
    'public.home_ownership_transfer(uuid)',
    'public.change_home_member_role(uuid, uuid, text, text)',
    'public.set_administrator_capabilities(uuid, uuid, text[])',
    'public.remove_home_member(uuid, uuid, text)',
    'public.leave_home(uuid)',
    'public.start_ownership_transfer(uuid, uuid, uuid)',
    'public.cancel_ownership_transfer(uuid, uuid)',
    'public.respond_to_ownership_transfer(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
end
$$;
