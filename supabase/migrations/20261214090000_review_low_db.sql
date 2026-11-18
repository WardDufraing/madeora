-- Review backlog Part 5: the open LOW database findings (plans/steps/fix-review-backlog-brief.md,
-- "Open LOW", area db) and the database follow-ups the earlier parts left (the reminder-lead cap of
-- S30b-M1, vacation-review chores shown overdue, reopening an achieved goal above the limit).
-- Every function here already exists and is replaced in place with the same signature (privileges are
-- kept); only new helpers are created. No table or column is dropped and no data is rewritten; two
-- indexes are added (S24-L7).
-- Forward-only. Rollback: re-apply the replaced function bodies from their previous migrations (named at
-- each function) and drop the added helpers and indexes.

-- Accounts and Homes ---------------------------------------------------------------------------------------

-- S09-L3, S43-L8: as 20261016090000_homes.sql, plus: a child or a Household Display never creates a Home,
-- whatever their account looks like (not only because the session gate refuses them first).
create or replace function public.create_home(p_name text, p_timezone text, p_request_id uuid)
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_home_id uuid;
  begin
    if v_user_id is null or not exists (
      select 1 from auth.users u where u.id = v_user_id and u.email_confirmed_at is not null
    ) or private.is_child(v_user_id) or private.is_display(v_user_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_request_id is null then
      raise exception 'a request id is required' using errcode = '22023';
    end if;

    -- One creation at a time per account, so two concurrent retries of one request cannot both
    -- miss the existing Home and then collide on the unique index.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('madeora.create_home:' || v_user_id::text, 0)
    );

    select h.id into v_home_id
      from public.homes h
      where h.created_by = v_user_id and h.creation_request_id = p_request_id;
    if v_home_id is not null then
      return v_home_id;
    end if;

    insert into public.homes (name, timezone, created_by, creation_request_id)
      values (p_name, p_timezone, v_user_id, p_request_id)
      returning id into v_home_id;
    insert into public.home_memberships (home_id, user_id, role)
      values (v_home_id, v_user_id, 'owner');
    return v_home_id;
  end
  $$;

-- S12-L2: as 20261019090000_roles_and_ownership.sql, except that a pending transfer past its expiry is
-- no longer shown to its recipient (nothing is left to answer), and to its sender only for 7 days after
-- it expired, like any other ended transfer.
create or replace function public.home_ownership_transfer(p_home_id uuid)
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
          (t.status = 'pending' and t.expires_at > pg_catalog.now()
            and (t.from_user_id = v_user_id or t.to_user_id = v_user_id))
          or (t.status = 'pending' and t.expires_at <= pg_catalog.now() and t.from_user_id = v_user_id
              and t.expires_at > pg_catalog.now() - interval '7 days')
          or (t.status <> 'pending' and t.status <> 'accepted' and t.from_user_id = v_user_id
              and t.decided_at > pg_catalog.now() - interval '7 days')
        )
      order by t.created_at desc
      limit 1;
  end
  $$;

-- S15-L1: as 20261023090000_file_storage.sql, plus: the owner's storage pool is locked first (when they
-- have one; no pool means no file), the lock set_my_avatar takes, so a departure that drops a Home
-- avatar cannot retire a file that a concurrent set_my_avatar just chose as the global avatar.
create or replace function private.retire_avatar_if_unused(p_user_id uuid, p_file_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_file_id is null then
      return;
    end if;
    perform 1 from private.storage_pools p where p.owner_user_id = p_user_id for update;
    if exists (
      select 1 from public.user_preferences up
      where up.user_id = p_user_id and up.avatar_file_id = p_file_id
    ) or exists (
      select 1 from public.home_member_profiles hp
      where hp.user_id = p_user_id and hp.avatar_file_id = p_file_id
    ) then
      return;
    end if;
    perform private.retire_file(p_file_id);
  end
  $$;

-- Meals ----------------------------------------------------------------------------------------------------

-- S27-L1: as 20261109090000_meal_planner.sql, plus: going back to the standard name (null) is refused
-- ('name_taken') when another slot of the context already uses one of that slot's standard names.
create or replace function public.update_meal_slot(
  -- p_name and p_enabled default to null only so a null name (the standard one) can be omitted; a
  -- missing p_enabled is refused below.
  p_slot_id uuid, p_expected_revision integer, p_name text default null, p_enabled boolean default null,
  p_impact_token text default null, p_today date default null
) returns table (outcome text, revision integer, impact jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_slot private.meal_slots;
    v_name text := pg_catalog.btrim(p_name);
    v_impact jsonb;
  begin
    if p_slot_id is null or p_expected_revision is null or p_enabled is null
       or (p_name is not null and (not private.is_visible_name(p_name, private.meal_limit('slot_name')) or v_name = '')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_slot := private.meal_slot_for(p_slot_id, v_user_id);
    if v_slot.id is null then
      return query select 'not_found', null::integer, null::jsonb;
      return;
    end if;
    if p_name is null and v_slot.standard_key is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(v_slot.owner_home_id, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer, null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(v_slot.owner_home_id, v_user_id);
    select * into v_slot from private.meal_slots s where s.id = p_slot_id for update;
    if v_slot.revision <> p_expected_revision then
      return query select 'conflict', v_slot.revision, null::jsonb;
      return;
    end if;
    if v_name is not null and v_name is distinct from v_slot.name
       and not private.meal_slot_name_free(v_slot.owner_home_id, v_user_id, v_name, v_slot.id) then
      return query select 'name_taken', null::integer, null::jsonb;
      return;
    end if;
    if v_name is null and v_slot.name is not null and exists (
        select 1 from unnest(private.meal_standard_names(v_slot.standard_key)) n
        where not private.meal_slot_name_free(v_slot.owner_home_id, v_user_id, n, v_slot.id)) then
      return query select 'name_taken', null::integer, null::jsonb;
      return;
    end if;
    if v_slot.enabled and not p_enabled then
      v_impact := private.meal_slot_impact_json(v_slot, private.meal_today(v_slot.owner_home_id, p_today));
      if ((v_impact ->> 'futureMeals')::integer > 0 or (v_impact ->> 'pastMeals')::integer > 0
          or (v_impact ->> 'series')::integer > 0)
         and p_impact_token is distinct from v_impact ->> 'token' then
        return query select 'impact_required', null::integer, v_impact;
        return;
      end if;
    end if;
    update private.meal_slots s set name = v_name, enabled = p_enabled, revision = s.revision + 1
      where s.id = v_slot.id returning s.revision into v_slot.revision;
    perform private.audit_meals('meal_slot.updated', v_slot.owner_home_id, v_slot.id,
      pg_catalog.jsonb_build_object('enabled', p_enabled));
    return query select 'saved', v_slot.revision, null::jsonb;
  end
  $$;


-- Chores ---------------------------------------------------------------------------------------------------

-- S21-L7: as 20261102090000_chore_proposals_volunteers.sql, except that the recipient limit counts only
-- the people this call really adds: someone invited before on this request (who is skipped) no longer
-- counts twice.
create or replace function public.change_chore_volunteer_request(
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
       + (select count(*) from unnest(v_users) u
          where not exists (select 1 from private.chore_volunteer_invitations i
            where i.request_id = p_request_id and i.user_id = u)) > private.chore_volunteer_limit('recipients') then
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


-- S20-L2: as 20261127090000_account_home_deletion.sql, plus: an occurrence waiting for approval that was
-- assigned to the departing member is flagged for reassignment too, so a later rejection does not leave
-- it open, unassigned and unflagged.
create or replace function private.release_member_chores(
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
      where o.home_id = p_home_id and o.status in ('open', 'pending_approval') and not o.needs_reassignment
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


-- S20-L1: as 20261104090000_home_vacations.sql, plus: making steps mandatory on an occurrence that has
-- progress (a checked step) needs the same explicit confirmation as removing a checked step
-- ('needs_confirmation' with the impact, unless p_confirm_checklist), as the page already asks.
create or replace function public.update_chore_occurrence(
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
    v_preview record;
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
    if v_occurrence.id is not null and p_steps is not null and not coalesce(p_dry_run, false)
       and not coalesce(p_confirm_checklist, false)
       and exists (select 1 from private.chore_occurrence_steps s
         where s.occurrence_id = v_occurrence.id and s.checked_at is not null) then
      select u.outcome, u.impact, u.revision into v_preview
        from private.update_chore_occurrence_before_vacations(p_occurrence_id, p_expected_revision,
          true, p_due_date, p_assignee_ids, p_set_minutes, p_minutes, p_steps,
          p_confirm_checklist, p_confirm_release) u;
      if v_preview.outcome = 'preview' and coalesce((v_preview.impact ->> 'newlyMandatory')::integer, 0) > 0 then
        return query select 'needs_confirmation', v_preview.impact || pg_catalog.jsonb_build_object('away', v_away),
          v_preview.revision;
        return;
      end if;
    end if;
    return query
      select u.outcome, case when u.impact is null then null
          else u.impact || pg_catalog.jsonb_build_object('away', v_away) end, u.revision
      from private.update_chore_occurrence_before_vacations(p_occurrence_id, p_expected_revision,
        p_dry_run, p_due_date, p_assignee_ids, p_set_minutes, p_minutes, p_steps,
        p_confirm_checklist, p_confirm_release) u;
  end
  $$;


-- S20-L3: as 20261031090000_chore_templates_history_bulk.sql, plus: the chores of the selected
-- occurrences are locked first, in id order, so two bulk actions over the same chores (sent in different
-- orders) wait for each other instead of deadlocking. Results keep the order given.
create or replace function public.bulk_chore_occurrences(
  p_home_id uuid, p_action text, p_items jsonb, p_dry_run boolean,
  p_member uuid default null, p_due_date date default null, p_reason text default null
) returns table (
  occurrence_id uuid, outcome text, title text, due_before date, due_after date,
  assignees_before uuid[], assignees_after uuid[], revision integer
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_item record;
    v_occurrence private.chore_occurrences;
    v_title text;
    v_before uuid[];
    v_after uuid[];
    v_outcome text;
    v_revision integer;
    v_due date;
    v_applied integer := 0;
    v_chore_id uuid;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_action is null or p_action not in ('reassign', 'skip', 'due_date') or p_dry_run is null
       or p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array'
       or pg_catalog.jsonb_array_length(p_items) not between 1 and 100
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_items) e (i)
         where pg_catalog.jsonb_typeof(e.i -> 'id') <> 'string'
           or (e.i ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or pg_catalog.jsonb_typeof(e.i -> 'revision') <> 'number'
           or (e.i ->> 'revision') !~ '^[1-9][0-9]{0,8}$')
       or (select count(distinct e.i ->> 'id') from pg_catalog.jsonb_array_elements(p_items) e (i))
         <> pg_catalog.jsonb_array_length(p_items)
       or (p_action = 'reassign') <> (p_member is not null)
       or (p_action = 'due_date') <> (p_due_date is not null)
       or (p_action <> 'skip' and p_reason is not null)
       or (p_due_date is not null and p_due_date not between date '2000-01-01' and date '2199-12-31')
       or (private.chore_short_text(p_reason) is not null
         and not private.is_plain_text(private.chore_short_text(p_reason), private.chore_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_chores(p_home_id, v_user_id) then
      return query select (e.i ->> 'id')::uuid, 'not_permitted', null::text, null::date, null::date,
          null::uuid[], null::uuid[], null::integer
        from pg_catalog.jsonb_array_elements(p_items) with ordinality e (i, o) order by e.o;
      return;
    end if;

    for v_chore_id in
      select distinct o.chore_id from private.chore_occurrences o
      where o.home_id = p_home_id
        and o.id in (select (e.i ->> 'id')::uuid from pg_catalog.jsonb_array_elements(p_items) e (i))
      order by o.chore_id
    loop
      perform private.lock_chore(v_chore_id, v_user_id);
    end loop;
    for v_item in
      select (e.i ->> 'id')::uuid as id, (e.i ->> 'revision')::integer as expected
      from pg_catalog.jsonb_array_elements(p_items) with ordinality e (i, o) order by e.o
    loop
      v_title := null; v_before := null; v_after := null; v_due := null; v_revision := null;
      begin
        v_occurrence := private.lock_chore_occurrence(v_item.id, v_user_id);
        if v_occurrence.id is null or v_occurrence.home_id <> p_home_id then
          v_outcome := 'not_found';
        else
          select c.title into v_title from private.chores c where c.id = v_occurrence.chore_id;
          select coalesce(array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id),
              '{}'::uuid[]) into v_before
            from private.chore_occurrence_assignees a where a.occurrence_id = v_occurrence.id;
          v_due := v_occurrence.due_date;
          if p_action = 'skip' then
            if v_occurrence.revision <> v_item.expected then
              v_outcome := 'conflict';
            elsif v_occurrence.status = 'pending_approval' then
              v_outcome := 'pending_approval';
            elsif v_occurrence.status <> 'open' then
              v_outcome := 'occurrence_closed';
            elsif p_dry_run then
              v_outcome := 'preview';
            else
              select s.outcome into v_outcome
                from public.skip_chore_occurrence(v_occurrence.id, p_reason) s;
            end if;
          elsif v_occurrence.status = 'pending_approval' and v_occurrence.revision = v_item.expected then
            v_outcome := 'pending_approval';
          else
            select u.outcome into v_outcome
              from public.update_chore_occurrence(v_occurrence.id, v_item.expected, p_dry_run,
                p_due_date => case when p_action = 'due_date' then p_due_date end,
                p_assignee_ids => case when p_action = 'reassign' then array[p_member] end) u;
          end if;
        end if;
      exception when others then
        -- One occurrence's failure never undoes the others (it is reported).
        v_outcome := 'failed';
      end;
      if v_outcome in ('preview', 'saved', 'skipped') then
        v_after := case when p_action = 'reassign' then array[p_member] else v_before end;
      end if;
      if v_outcome in ('saved', 'skipped') then
        v_applied := v_applied + 1;
      end if;
      select o.revision into v_revision from private.chore_occurrences o where o.id = v_item.id
        and o.home_id = p_home_id;
      return query select v_item.id, v_outcome, v_title, v_due,
        case when v_outcome in ('preview', 'saved') and p_action = 'due_date' then p_due_date
          when v_outcome in ('preview', 'saved', 'skipped') then v_due end,
        v_before, v_after, v_revision;
    end loop;
    if v_applied > 0 then
      perform private.audit_chore('chore_occurrence.bulk', p_home_id, 'home', p_home_id,
        pg_catalog.jsonb_build_object('action', p_action, 'count', v_applied,
          'requested', pg_catalog.jsonb_array_length(p_items)));
    end if;
  end
  $$;


-- Follow-up of S22-M5 (PR #93 review M-1): an occurrence waiting for a vacation review is not overdue in
-- the chore detail, the occurrence list and the chore widget either (as in the schedule and summaries).
-- As 20261030090000_chores.sql.
create or replace function public.get_chore_occurrence(p_occurrence_id uuid) returns jsonb
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
      'overdue', v_occurrence.status = 'open' and v_occurrence.due_date < v_today and not v_occurrence.vacation_review,
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


-- As 20261030090000_chores.sql, with the same overdue rule.
create or replace function public.list_chore_occurrences(
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
        m.due_date, m.status = 'open' and m.due_date < v_today and not m.vacation_review, m.due_date = v_today,
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


-- As 20261031090000_chore_templates_history_bulk.sql, with the same overdue rule (the 'overdue' filter
-- included).
create or replace function public.list_chore_widget(
  p_home_id uuid, p_view text, p_state text, p_from date default null, p_to date default null,
  p_member uuid default null, p_unassigned boolean default false, p_limit integer default 10
) returns table (
  id uuid, chore_id uuid, title text, category_name text, category_color text, due_date date,
  status text, overdue boolean, in_rework boolean, requires_approval boolean,
  assignee_member_ids uuid[], assigned_to_me boolean, mandatory_open integer,
  completed_at timestamptz, contributor_me boolean, contributor_member uuid,
  revision integer, total_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_zone text;
    v_member_user uuid;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_view is null or p_view not in ('mine', 'all')
       or p_state is null or p_state not in ('outstanding', 'overdue', 'pending_approval', 'rework', 'completed')
       or (p_from is not null and p_to is not null and p_to < p_from)
       or p_unassigned is null or (p_unassigned and (p_member is not null or p_view = 'mine'))
       or (p_member is not null and p_view = 'mine')
       or p_limit is null or p_limit not between 1 and 20 then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_today := private.task_today(p_home_id, null);
    select h.timezone into v_zone from public.homes h where h.id = p_home_id;
    v_member_user := case when p_view = 'mine' then v_user_id end;
    if p_member is not null then
      select m.user_id into v_member_user from public.home_memberships m
        where m.home_id = p_home_id and m.id = p_member;
    end if;
    return query
      with matching as (
        select o.*, c.title as chore_title, c.category_id as chore_category,
          c.requires_approval as chore_approval
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = p_home_id and o.deleted_at is null and c.deleted_at is null
          and case p_state
            when 'outstanding' then o.status in ('open', 'pending_approval')
              and (o.due_date <= v_today + private.chore_limit('horizon') or o.status = 'pending_approval')
            when 'overdue' then o.status = 'open' and o.due_date < v_today and not o.vacation_review
            when 'pending_approval' then o.status = 'pending_approval'
            when 'rework' then o.status = 'open' and o.in_rework
            else o.status = 'completed' end
          and case when p_state = 'completed' then
              (p_from is null or (o.completed_at at time zone v_zone)::date >= p_from)
              and (p_to is null or (o.completed_at at time zone v_zone)::date <= p_to)
            else (p_from is null or o.due_date >= p_from) and (p_to is null or o.due_date <= p_to) end
          and case
            when p_unassigned then not exists (select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id)
            when p_view = 'mine' or p_member is not null then v_member_user is not null and exists (
              select 1 from private.chore_occurrence_assignees a
              where a.occurrence_id = o.id and a.user_id = v_member_user)
            else true end
      )
      select m.id, m.chore_id, m.chore_title, g.name, g.color, m.due_date, m.status,
        m.status = 'open' and m.due_date < v_today and not m.vacation_review, m.in_rework, m.chore_approval,
        coalesce((select array_agg(private.member_ref(a.home_id, a.user_id) order by a.user_id)
          from private.chore_occurrence_assignees a where a.occurrence_id = m.id), '{}'::uuid[]),
        exists (select 1 from private.chore_occurrence_assignees a
          where a.occurrence_id = m.id and a.user_id = v_user_id),
        (select count(*)::integer from private.chore_occurrence_steps s
          where s.occurrence_id = m.id and s.mandatory and s.checked_at is null),
        m.completed_at, coalesce(m.contributor_id = v_user_id, false),
        private.member_ref(m.home_id, m.contributor_id),
        m.revision, (count(*) over ())::integer
      from matching m
      left join private.chore_categories g on g.id = m.chore_category
      order by case when p_state = 'completed' then m.completed_at end desc nulls last,
        m.due_date, m.chore_title, m.id
      limit p_limit;
  end
  $$;


-- Trash: limits and targets on restore ---------------------------------------------------------------------

-- Whether restoring p_entry would take a context past one of its limits, or put an item where it cannot
-- be: the conflict kind, or null. Checked by trash_conflict below, and again by trash_item_restore under
-- the lock that module's creates take for the same limit.
--   S19-L7  a removed entire task series comes back as an active series: 'series_limit' at 200;
--   S20-L4  an entire chore-series removal un-ends its chore: 'chore_limit' at the Home's chore limit;
--   S28-L1  a habit that was not archived comes back active: 'habit_limit' at the 100 of its context;
--   S27-L3  a meal in a slot that is disabled now: 'meal_slot_disabled_series' when a repeating meal of
--           that slot would also fall on its date once the slot is enabled again;
--   S26-L5  a shopping item (or cleared items) into a list that is archived now: 'shopping_list_archived'
--           (the person unarchives the list first).
create function private.trash_restore_limit_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_task_removal private.task_series_removals;
    v_chore_removal private.chore_removals;
    v_habit private.habits;
    v_meal private.meal_entries;
    v_list_archived boolean;
  begin
    if p_entry.module = 'tasks' and p_entry.item_type = 'task_series_removal' then
      select * into v_task_removal from private.task_series_removals r where r.id = p_entry.subject_id;
      if v_task_removal.id is not null and v_task_removal.mode = 'series' and not v_task_removal.tasks_only
         and exists (select 1 from private.task_series s
           where s.id = v_task_removal.head_id and s.deleted_at is not null)
         and (select count(*) from private.task_series s
           where ((v_task_removal.owner_home_id is null and s.owner_user_id = v_task_removal.owner_user_id)
               or s.owner_home_id = v_task_removal.owner_home_id)
             and s.superseded_at is null and s.deleted_at is null) >= private.task_limit('series') then
        return 'series_limit';
      end if;
    elsif p_entry.module = 'chores' and p_entry.item_type = 'chore_removal' then
      select * into v_chore_removal from private.chore_removals r where r.id = p_entry.subject_id;
      if v_chore_removal.id is not null and v_chore_removal.mode = 'series' and not v_chore_removal.occurrences_only
         and exists (select 1 from private.chores c
           where c.id = v_chore_removal.chore_id and c.ended_at is not null and c.deleted_at is null)
         and (select count(*) from private.chores c
           where c.home_id = (select x.home_id from private.chores x where x.id = v_chore_removal.chore_id)
             and c.deleted_at is null and c.ended_at is null) >= private.chore_limit('chores') then
        return 'chore_limit';
      end if;
    elsif p_entry.module = 'habits' then
      select * into v_habit from private.habits h where h.id = p_entry.subject_id and h.deleted_at is not null;
      if v_habit.id is not null and v_habit.archived_at is null
         and (select count(*) from private.habits h
           where h.deleted_at is null and h.archived_at is null
             and h.owner_user_id is not distinct from v_habit.owner_user_id
             and h.owner_home_id is not distinct from v_habit.owner_home_id) >= private.habit_limit('habits') then
        return 'habit_limit';
      end if;
    elsif p_entry.module = 'meals' then
      select * into v_meal from private.meal_entries e where e.id = p_entry.subject_id and e.deleted_at is not null;
      if v_meal.id is not null and exists (
          select 1 from private.meal_recurrences r
          join private.meal_slots sl on sl.id = r.slot_id and not sl.enabled
          where r.slot_id = v_meal.slot_id
            and r.start_on <= v_meal.on_date and (r.end_on is null or r.end_on >= v_meal.on_date)
            and private.meal_occurs(r, v_meal.on_date)
            and not exists (select 1 from private.meal_occurrence_exceptions x
              where x.recurrence_id = r.id and x.on_date = v_meal.on_date)) then
        return 'meal_slot_disabled_series';
      end if;
    elsif p_entry.module = 'shopping' and p_entry.item_type in ('shopping_item', 'shopping_clear') then
      select l.archived_at is not null into v_list_archived
        from private.shopping_lists l
        where l.id = case p_entry.item_type
          when 'shopping_item' then (select i.list_id from private.shopping_items i where i.id = p_entry.subject_id)
          else (select c.list_id from private.shopping_clears c where c.id = p_entry.subject_id) end;
      if coalesce(v_list_archived, false) then
        return 'shopping_list_archived';
      end if;
    end if;
    return null;
  end
  $$;

revoke all on function private.trash_restore_limit_conflict(private.trash_entries) from public, anon, authenticated;

-- As 20261211090000_review_medium_db_rls.sql, plus the restore limits and targets above.
create or replace function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_kind text := private.trash_conflict_before_review_fixes(p_entry);
    v_root uuid;
  begin
    if v_kind is not null then
      return v_kind;
    end if;
    if p_entry.module = 'chores' and private.chore_entry_blocked_by_end(p_entry) then
      return 'chore_unavailable';
    end if;
    if p_entry.module = 'tasks' and p_entry.item_type = 'task_series_attachment' then
      select s.root_id into v_root from private.task_series_attachments s where s.id = p_entry.subject_id;
      if (select count(*) from private.task_series_attachments s
          where s.root_id = v_root and s.removed_at is null) >= private.task_limit('attachments') then
        return 'attachment_limit';
      end if;
    end if;
    return private.trash_restore_limit_conflict(p_entry);
  end
  $$;

-- As 20261211090000_review_medium_db_rls.sql, plus: the restore limits and targets are checked again
-- under the lock that module's creates take for the same limit (the series context, the Home's chore
-- lock after the chore, the habit and then its context, the meal context, the list); a change in
-- between raises unique_violation, which the caller turns into a fresh conflict.
create or replace function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_root uuid;
    v_removal private.task_series_removals;
    v_chore_id uuid;
    v_habit private.habits;
    v_meal private.meal_entries;
    v_list_id uuid;
  begin
    if p_entry.module = 'chores' and p_entry.item_type in ('chore_occurrence', 'chore_removal') then
      v_chore_id := case p_entry.item_type
        when 'chore_occurrence' then (select o.chore_id from private.chore_occurrences o
          where o.id = p_entry.subject_id)
        else (select r.chore_id from private.chore_removals r where r.id = p_entry.subject_id) end;
      perform 1 from private.chores c where c.id = v_chore_id for update;
      if private.chore_entry_blocked_by_end(p_entry) then
        raise exception 'chore unavailable' using errcode = '23505';
      end if;
      if p_entry.item_type = 'chore_removal' then
        perform private.lock_chore_home('chores', (select c.home_id from private.chores c where c.id = v_chore_id));
      end if;
    elsif p_entry.module = 'tasks' and p_entry.item_type = 'task_series_attachment' then
      select s.root_id into v_root from private.task_series_attachments s where s.id = p_entry.subject_id;
      perform private.lock_series_head(v_root);
      if (select count(*) from private.task_series_attachments s
          where s.root_id = v_root and s.removed_at is null) >= private.task_limit('attachments') then
        raise exception 'attachment limit' using errcode = '23505';
      end if;
    elsif p_entry.module = 'tasks' and p_entry.item_type = 'task_series_removal' then
      select * into v_removal from private.task_series_removals r where r.id = p_entry.subject_id;
      if v_removal.id is not null then
        perform private.lock_task_context('task_series', v_removal.owner_home_id, v_removal.owner_user_id);
      end if;
    elsif p_entry.module = 'habits' then
      select * into v_habit from private.habits h where h.id = p_entry.subject_id for update;
      if v_habit.id is not null then
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'habits:' || coalesce(v_habit.owner_home_id, v_habit.owner_user_id)::text, 0));
      end if;
    elsif p_entry.module = 'meals' then
      select * into v_meal from private.meal_entries e where e.id = p_entry.subject_id;
      if v_meal.id is not null then
        perform private.lock_meal_context(v_meal.owner_home_id, v_meal.owner_user_id);
      end if;
    elsif p_entry.module = 'shopping' and p_entry.item_type in ('shopping_item', 'shopping_clear') then
      v_list_id := case p_entry.item_type
        when 'shopping_item' then (select i.list_id from private.shopping_items i where i.id = p_entry.subject_id)
        else (select c.list_id from private.shopping_clears c where c.id = p_entry.subject_id) end;
      perform 1 from private.shopping_lists l where l.id = v_list_id for update;
    end if;
    if private.trash_restore_limit_conflict(p_entry) is not null then
      raise exception 'restore limit' using errcode = '23505';
    end if;
    return private.trash_item_restore_before_review_fixes(p_entry);
  end
  $$;


-- Shopping -------------------------------------------------------------------------------------------------

-- As 20261108090000_shopping_lists.sql, plus:
--   S26-L2  an item of an archived list is neither moved nor copied ('conflict': the item is no longer
--           where it was read, in an active list; transfers are between two active lists);
--   S26-L1  two identical copy requests at the same moment answer 'exists' (or 'id_taken') instead of a
--           primary-key error.
create or replace function public.transfer_shopping_item(
  p_item_id uuid, p_mode text, p_destination_list_id uuid, p_expected_revision integer,
  p_category_id uuid default null, p_keep_completed boolean default true,
  p_allow_duplicate boolean default false, p_copy_id uuid default null
) returns table (outcome text, item_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_source_list_id uuid;
    v_first private.shopping_lists;
    v_second private.shopping_lists;
    v_source private.shopping_lists;
    v_destination private.shopping_lists;
    v_item private.shopping_items;
    v_existing private.shopping_items;
    v_keep boolean := coalesce(p_keep_completed, true);
  begin
    if p_item_id is null or coalesce(p_mode, '') not in ('move', 'copy') or p_destination_list_id is null
       or p_expected_revision is null or (p_mode = 'copy' and p_copy_id is null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_mode = 'copy' then
      select * into v_existing from private.shopping_items i where i.id = p_copy_id;
      if found then
        return query select case when v_existing.created_by = v_user_id
          and v_existing.list_id = p_destination_list_id then 'exists' else 'id_taken' end, p_copy_id;
        return;
      end if;
    end if;
    select i.list_id into v_source_list_id from private.shopping_items i where i.id = p_item_id;
    if v_source_list_id is null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if v_source_list_id = p_destination_list_id then
      return query select 'same_list', null::uuid;
      return;
    end if;
    -- Both lists in id order, so two transfers between the same lists cannot wait on each other.
    v_first := private.lock_shopping_list(least(v_source_list_id, p_destination_list_id), v_user_id);
    v_second := private.lock_shopping_list(greatest(v_source_list_id, p_destination_list_id), v_user_id);
    if v_first.id = v_source_list_id then
      v_source := v_first;
      v_destination := v_second;
    else
      v_source := v_second;
      v_destination := v_first;
    end if;
    select * into v_item from private.shopping_items i where i.id = p_item_id for update;
    if v_source.id is null or v_item.id is null or v_item.deleted_at is not null then
      return query select 'not_found', null::uuid;
      return;
    end if;
    if v_item.list_id <> v_source.id or v_source.archived_at is not null then
      -- Moved elsewhere while this request waited for the lists: it is no longer where it was read.
      return query select 'conflict', null::uuid;
      return;
    end if;
    if not private.shopping_may(v_source, v_user_id, case when p_mode = 'move' then 'edit' else 'view' end) then
      return query select 'not_permitted', null::uuid;
      return;
    end if;
    -- Never across contexts: Personal to Home, Home to Personal, or another Home.
    if v_destination.id is null
       or v_destination.owner_home_id is distinct from v_source.owner_home_id
       or v_destination.owner_user_id is distinct from v_source.owner_user_id then
      return query select case when v_destination.id is null then 'destination_unavailable' else 'not_permitted' end, null::uuid;
      return;
    end if;
    if v_destination.archived_at is not null or not private.shopping_may(v_destination, v_user_id, 'edit') then
      return query select 'destination_unavailable', null::uuid;
      return;
    end if;
    if v_item.revision <> p_expected_revision then
      return query select 'conflict', null::uuid;
      return;
    end if;
    if p_category_id is not null and not exists (
        select 1 from private.shopping_categories c where c.id = p_category_id and c.list_id = v_destination.id) then
      return query select 'invalid_category', null::uuid;
      return;
    end if;
    if not coalesce(p_allow_duplicate, false) and private.shopping_duplicate(v_destination.id, v_item.name) then
      return query select 'duplicate', null::uuid;
      return;
    end if;
    if private.shopping_item_count(v_destination.id) >= private.shopping_limit('items') then
      return query select 'limit_reached', null::uuid;
      return;
    end if;
    if p_mode = 'move' then
      update private.shopping_items i
        set list_id = v_destination.id, category_id = p_category_id,
          position = private.shopping_next_position(v_destination.id),
          completed_at = case when v_keep then i.completed_at end,
          completed_by = case when v_keep then i.completed_by end,
          recurrence_id = null, occurrence_on = null,
          revision = i.revision + 1, updated_at = pg_catalog.now()
        where i.id = v_item.id;
      perform private.shopping_event(v_item.id, 'moved_out', v_user_id, v_destination.id);
      perform private.shopping_event(v_item.id, 'moved_in', v_user_id, v_source.id);
      if v_item.completed_at is not null and not v_keep then
        perform private.shopping_event(v_item.id, 'reopened', v_user_id);
      end if;
      return query select 'moved', v_item.id;
      return;
    end if;
    begin
      insert into private.shopping_items (
        id, list_id, category_id, name, quantity, unit, packaging, notes, position,
        completed_at, completed_by, created_by
      ) values (
        p_copy_id, v_destination.id, p_category_id, v_item.name, v_item.quantity, v_item.unit,
        v_item.packaging, v_item.notes, private.shopping_next_position(v_destination.id),
        case when v_keep then v_item.completed_at end, case when v_keep then v_item.completed_by end,
        v_user_id
      );
    exception when unique_violation then
      select * into v_existing from private.shopping_items i where i.id = p_copy_id;
      return query select case when v_existing.created_by = v_user_id
        and v_existing.list_id = p_destination_list_id then 'exists' else 'id_taken' end, p_copy_id;
      return;
    end;
    perform private.shopping_event(p_copy_id, 'copied', v_user_id, v_source.id);
    return query select 'copied', p_copy_id;
  end
  $$;


-- S26-L4: as 20261108090000_shopping_lists.sql, except that the recurring rules restart only when the
-- list comes back from the archive, not on every save (a rename no longer skips a due occurrence).
create or replace function public.update_shopping_list(
  p_list_id uuid, p_expected_revision integer, p_name text, p_member_access text, p_archived boolean
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_was_archived boolean;
  begin
    if p_list_id is null or p_expected_revision is null or p_archived is null or p_name is null
       or not private.is_visible_name(p_name, private.shopping_limit('list_name'))
       or coalesce(p_member_access, '') not in ('edit', 'check', 'view') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_list := private.lock_shopping_list(p_list_id, v_user_id);
    if v_list.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if not private.shopping_may(v_list, v_user_id, 'manage') then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if v_list.revision <> p_expected_revision then
      return query select 'conflict', v_list.revision;
      return;
    end if;
    v_was_archived := v_list.archived_at is not null;
    update private.shopping_lists l
      set name = p_name,
        member_access = case when l.owner_home_id is null then 'edit' else p_member_access end,
        archived_at = case when p_archived then coalesce(l.archived_at, pg_catalog.now()) end,
        revision = l.revision + 1, updated_at = pg_catalog.now()
      where l.id = v_list.id
      returning * into v_list;
    if not p_archived and v_was_archived then
      perform private.restart_shopping_rules(v_list);
    end if;
    perform private.audit_shopping('shopping_list.updated', v_list.owner_home_id, v_list.id,
      pg_catalog.jsonb_build_object('archived', p_archived, 'memberAccess', v_list.member_access));
    return query select 'saved', v_list.revision;
  end
  $$;


-- S26-L7: as 20261108090000_shopping_lists.sql, plus: the context's lists are locked in id order before
-- the order is normalized, the order advance_shopping locks them in, so the two cannot deadlock.
create or replace function public.move_shopping_list(p_list_id uuid, p_direction text) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_list private.shopping_lists;
    v_other private.shopping_lists;
  begin
    if p_list_id is null or coalesce(p_direction, '') not in ('up', 'down') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    if not found or private.shopping_access(v_list, v_user_id) is null then
      return 'not_found';
    end if;
    perform private.lock_shopping_context(v_list.owner_home_id, v_list.owner_user_id);
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    if private.shopping_access(v_list, v_user_id) is null or v_list.archived_at is not null then
      return 'not_found';
    end if;
    if not private.can_manage_shopping(v_list.owner_user_id, v_list.owner_home_id, v_user_id) then
      return 'not_permitted';
    end if;
    perform 1 from private.shopping_lists x
      where ((v_list.owner_home_id is null and x.owner_user_id = v_list.owner_user_id)
          or x.owner_home_id = v_list.owner_home_id)
        and x.deleted_at is null and x.archived_at is null
      order by x.id
      for update;
    -- Normalize the order first (0, 1, 2, ... by the order shown), so ties never stall a move.
    update private.shopping_lists l set position = o.ord::integer
      from (
        select x.id, row_number() over (order by x.position, x.created_at, x.id) - 1 as ord
        from private.shopping_lists x
        where ((v_list.owner_home_id is null and x.owner_user_id = v_list.owner_user_id)
            or x.owner_home_id = v_list.owner_home_id)
          and x.deleted_at is null and x.archived_at is null
      ) o
      where l.id = o.id and l.position <> o.ord;
    select * into v_list from private.shopping_lists l where l.id = p_list_id;
    select * into v_other from private.shopping_lists l
      where ((v_list.owner_home_id is null and l.owner_user_id = v_list.owner_user_id)
          or l.owner_home_id = v_list.owner_home_id)
        and l.deleted_at is null and l.archived_at is null
        and l.position = v_list.position + case when p_direction = 'up' then -1 else 1 end;
    if not found then
      return 'unchanged';
    end if;
    update private.shopping_lists l set position = v_other.position, updated_at = pg_catalog.now()
      where l.id = v_list.id;
    update private.shopping_lists l set position = v_list.position, updated_at = pg_catalog.now()
      where l.id = v_other.id;
    return 'saved';
  end
  $$;


-- Points ---------------------------------------------------------------------------------------------------

-- S23-L3: as 20261105090000_points_rewards.sql, plus: the client id is checked again once the account
-- is locked, so a retry that raced the first call answers 'exists' instead of a primary-key error.
create or replace function public.adjust_points(
  p_id uuid, p_home_id uuid, p_member uuid, p_kind text, p_amount integer, p_reason text,
  p_dry_run boolean default false
) returns table (outcome text, preview jsonb, entry_id uuid)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_target uuid;
    v_account private.point_accounts;
    v_existing private.point_entries;
    v_entry private.point_entries;
    v_preview jsonb;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    if p_id is null or p_member is null or p_kind is null or p_kind not in ('bonus', 'correction')
       or p_amount is null or p_amount = 0 or abs(p_amount) > private.points_limit('adjustment')
       or (p_kind = 'bonus' and p_amount < 0) or p_dry_run is null
       or v_reason is null or pg_catalog.char_length(v_reason) < private.points_limit('reason_min')
       or not private.is_plain_text(v_reason, private.points_limit('reason')) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.can_manage_points(p_home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::uuid;
      return;
    end if;
    select * into v_existing from private.point_entries e where e.id = p_id;
    if found then
      if v_existing.home_id <> p_home_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', null::jsonb, v_existing.id;
      return;
    end if;
    select m.user_id into v_target from public.home_memberships m where m.home_id = p_home_id and m.id = p_member;
    if v_target is null then
      return query select 'member_unavailable', null::jsonb, null::uuid;
      return;
    end if;
    v_account := private.lock_point_account(p_home_id, v_target);
    select * into v_existing from private.point_entries e where e.id = p_id;
    if found then
      if v_existing.home_id <> p_home_id then
        raise exception 'invalid request' using errcode = '22023';
      end if;
      return query select 'exists', null::jsonb, v_existing.id;
      return;
    end if;
    v_preview := pg_catalog.jsonb_build_object(
      'person', private.chore_person(p_home_id, v_target, v_user_id), 'kind', p_kind, 'amount', p_amount,
      'available', v_account.balance - v_account.reserved, 'reserved', v_account.reserved,
      'availableAfter', v_account.balance - v_account.reserved + p_amount);
    if p_amount < 0 and v_account.balance - v_account.reserved + p_amount < 0 then
      return query select 'insufficient_points', v_preview, null::uuid;
      return;
    end if;
    if p_dry_run then
      return query select 'preview', v_preview, null::uuid;
      return;
    end if;
    v_entry := private.post_point_entry(v_account.id, p_kind, p_amount, null, null, null, null, v_reason,
      v_user_id, null, p_id);
    perform private.notify_point_adjustment(v_entry);
    perform private.audit('point_entry.adjusted', p_home_id, 'point_entry', v_entry.id,
      pg_catalog.jsonb_build_object('kind', p_kind, 'amount', p_amount));
    return query select 'posted', v_preview, v_entry.id;
  end
  $$;


-- S23-L1: as 20261105090000_points_rewards.sql, plus: a reward whose start was moved after today since
-- the request is unavailable too ('reward_unavailable' with reason 'not_started', unless p_confirm).
create or replace function public.review_reward_redemption(
  p_redemption_id uuid, p_expected_revision integer, p_decision text, p_reason text default null,
  p_confirm boolean default false
) returns table (outcome text, detail jsonb, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_reason text := private.chore_short_text(p_reason);
    v_redemption private.reward_redemptions;
    v_reward private.rewards;
    v_block text;
  begin
    if p_redemption_id is null or p_expected_revision is null or p_decision is null
       or p_decision not in ('approve', 'reject') or p_confirm is null
       or (p_decision = 'approve' and v_reason is not null)
       or (v_reason is not null and not private.is_plain_text(v_reason, private.points_limit('reason'))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_redemption := private.lock_redemption(p_redemption_id, v_user_id);
    if v_redemption.id is null then
      return query select 'not_found', null::jsonb, null::integer;
      return;
    end if;
    if not private.can_approve_rewards(v_redemption.home_id, v_user_id) then
      return query select 'not_permitted', null::jsonb, null::integer;
      return;
    end if;
    if v_redemption.requested_by = v_user_id then
      return query select 'own_request', null::jsonb, v_redemption.revision;
      return;
    end if;
    if v_redemption.status <> 'pending' then
      return query select 'not_pending', pg_catalog.jsonb_build_object('status', v_redemption.status),
        v_redemption.revision;
      return;
    end if;
    if v_redemption.revision <> p_expected_revision then
      return query select 'conflict', null::jsonb, v_redemption.revision;
      return;
    end if;
    perform 1 from private.point_accounts a where a.id = v_redemption.account_id for update;
    if p_decision = 'approve' then
      if v_redemption.requested_by is null
         or not private.is_home_member(v_redemption.home_id, v_redemption.requested_by) then
        return query select 'requester_unavailable', null::jsonb, v_redemption.revision;
        return;
      end if;
      select * into v_reward from private.rewards w where w.id = v_redemption.reward_id;
      v_block := case
        when v_reward.archived_at is not null then 'archived'
        when not v_reward.enabled then 'disabled'
        when v_reward.available_from is not null
          and private.task_today(v_reward.home_id, null) < v_reward.available_from then 'not_started'
        when v_reward.available_until is not null
          and private.task_today(v_reward.home_id, null) > v_reward.available_until then 'ended'
      end;
      if v_block is not null and not p_confirm then
        return query select 'reward_unavailable', pg_catalog.jsonb_build_object('reason', v_block),
          v_redemption.revision;
        return;
      end if;
      perform private.change_reserved(v_redemption.account_id, -v_redemption.cost);
      perform private.post_point_entry(v_redemption.account_id, 'redemption', -v_redemption.cost,
        null, null, v_redemption.id, null, null, v_user_id, null);
      update private.reward_redemptions r
        set status = 'redeemed', decided_at = pg_catalog.now(), decided_by = v_user_id,
          redeemed_at = pg_catalog.now(), fulfillment = 'pending', revision = r.revision + 1
        where r.id = v_redemption.id
        returning * into v_redemption;
      perform private.redemption_event(v_redemption.id, 'approved', v_user_id, null,
        case when v_block is not null then pg_catalog.jsonb_build_object('confirmedUnavailable', v_block)
          else '{}'::jsonb end);
      perform private.notify_requester(v_redemption, 'reward.approved');
      perform private.audit('rewards.approved', v_redemption.home_id, 'reward_redemption', v_redemption.id,
        pg_catalog.jsonb_build_object('cost', v_redemption.cost));
      return query select 'approved', null::jsonb, v_redemption.revision;
      return;
    end if;
    perform private.change_reserved(v_redemption.account_id, -v_redemption.cost);
    update private.reward_redemptions r
      set status = 'rejected', decided_at = pg_catalog.now(), decided_by = v_user_id,
        decision_reason = v_reason, revision = r.revision + 1
      where r.id = v_redemption.id
      returning * into v_redemption;
    perform private.redemption_event(v_redemption.id, 'rejected', v_user_id, v_reason);
    perform private.notify_requester(v_redemption, 'reward.rejected');
    perform private.audit('rewards.rejected', v_redemption.home_id, 'reward_redemption', v_redemption.id);
    return query select 'rejected', null::jsonb, v_redemption.revision;
  end
  $$;


-- Recipes --------------------------------------------------------------------------------------------------

-- S24-L7: deleting an account sets these references to null; without an index every deletion scans the
-- recipes table. Partial, so the many null rows cost nothing.
create index if not exists recipes_created_by_idx on private.recipes (created_by) where created_by is not null;
create index if not exists recipes_updated_by_idx on private.recipes (updated_by) where updated_by is not null;


-- Habits ---------------------------------------------------------------------------------------------------

-- S28-L3: as 20261112090000_numeric_habits.sql, plus: without a date (a weekly reminder's Complete), a
-- retry of the caller's own check-in matches it on habit and person only, so a retry after local
-- midnight answers 'exists' instead of 'id_taken'.
create or replace function public.complete_habit(
  p_checkin_id uuid, p_habit_id uuid, p_on date default null, p_note text default null,
  p_source text default 'app'
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits := private.habit_for(p_habit_id, v_user_id);
  begin
    if p_on is null and v_habit.id is not null then
      select c.on_date into p_on from private.habit_checkins c
        where c.id = p_checkin_id and c.habit_id = v_habit.id and c.completed_by = v_user_id;
    end if;
    if v_habit.id is not null
       and coalesce((private.habit_tracking_on(v_habit.id, coalesce(p_on, private.habit_today(v_habit)))).mode, 'once') = 'numeric'
       and private.habit_may(v_habit, v_user_id, 'complete') then
      return pg_catalog.jsonb_build_object('outcome', 'numeric_required',
        'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    return private.complete_habit_before_numeric(p_checkin_id, p_habit_id, p_on, p_note, p_source);
  end
  $$;


-- S29-L1: as 20261212090000_review_backlog_api_jobs_perf.sql, plus the same for a contribution sent
-- without a date: a retry of the caller's own contribution keeps its date across local midnight.
create or replace function public.add_habit_contribution(
  p_id uuid, p_habit_id uuid, p_quantity numeric, p_on date default null,
  p_entered_unit text default null, p_source text default 'app', p_expected_revision integer default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_habit private.habits;
    v_existing private.habit_contributions;
    v_contribution private.habit_contributions;
    v_tracking private.habit_tracking;
    v_entered_dimension text;
    v_entered_factor numeric;
    v_unit_dimension text;
    v_unit_factor numeric;
    v_today date;
    v_block text;
    v_quantity numeric := p_quantity;
    v_converted numeric;
    v_before integer;
    v_sync jsonb;
    v_same boolean;
  begin
    if p_id is null or p_habit_id is null or p_quantity is null or p_quantity <= 0 or p_quantity > 1000000
       or p_source is null or p_source not in ('app', 'widget')
       or (p_entered_unit is not null and not private.valid_habit_unit(p_entered_unit, 'preset')) then
      raise exception 'invalid contribution' using errcode = '22023';
    end if;
    v_habit := private.habit_lock(p_habit_id, v_user_id);
    if v_habit.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_today := private.habit_today(v_habit);
    if p_on is null then
      select c.on_date into p_on from private.habit_contributions c
        where c.id = p_id and c.habit_id = v_habit.id and c.contributed_by = v_user_id;
    end if;
    p_on := coalesce(p_on, v_today);
    select * into v_existing from private.habit_contributions c where c.id = p_id;
    if v_existing.id is not null then
      -- S29-M1: the same id with another amount is a different request, never a retry. A row kept
      -- without an entered unit was entered in the tracking unit (or none), so a retry names no unit
      -- or that one (review L4).
      v_same := v_existing.habit_id = v_habit.id and v_existing.contributed_by = v_user_id and v_existing.on_date = p_on
        and (select case when v_existing.entered_quantity is not null
          then v_existing.entered_quantity = p_quantity and v_existing.entered_unit is not distinct from p_entered_unit
          else coalesce(v_existing.original_quantity, v_existing.quantity) = p_quantity
            and (p_entered_unit is null or exists (
              select 1 from private.habit_tracking_on(v_habit.id, p_on) t
              where t.unit_kind = 'preset' and t.unit = p_entered_unit)) end);
      if v_same then
        return pg_catalog.jsonb_build_object('outcome', 'exists',
          'progress', private.habit_progress_json(v_habit, p_on),
          'habit', private.habit_summary_json(v_habit, v_user_id));
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    if not private.habit_may(v_habit, v_user_id, 'complete') then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if p_expected_revision is not null and p_expected_revision <> v_habit.revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    v_block := private.habit_contribution_block(v_habit, p_on, v_today);
    if v_block is not null then
      return pg_catalog.jsonb_build_object('outcome', v_block, 'habit', private.habit_summary_json(v_habit, v_user_id));
    end if;
    v_tracking := private.habit_tracking_on(v_habit.id, p_on);
    if p_entered_unit is not null and not (v_tracking.unit_kind = 'preset' and p_entered_unit = v_tracking.unit) then
      select i.dimension, i.factor into v_entered_dimension, v_entered_factor
        from private.habit_unit_info(p_entered_unit, 'preset') i;
      select i.dimension, i.factor into v_unit_dimension, v_unit_factor
        from private.habit_unit_info(v_tracking.unit, v_tracking.unit_kind) i;
      if v_entered_dimension is distinct from v_unit_dimension or v_tracking.unit_kind <> 'preset' then
        return pg_catalog.jsonb_build_object('outcome', 'unit_mismatch');
      end if;
      if p_quantity <> pg_catalog.round(p_quantity, 3) then
        raise exception 'invalid contribution' using errcode = '22023';
      end if;
      v_converted := p_quantity * v_entered_factor / v_unit_factor;
      if v_converted <> pg_catalog.round(v_converted, 3) or v_converted <= 0 then
        return pg_catalog.jsonb_build_object('outcome', 'precision', 'converted', pg_catalog.round(v_converted, 3));
      end if;
      v_quantity := pg_catalog.round(v_converted, 3);
    elsif p_entered_unit is not null then
      p_entered_unit := null;
    end if;
    if not private.valid_habit_quantity(v_quantity,
        (select i.discrete from private.habit_unit_info(v_tracking.unit, v_tracking.unit_kind) i)) then
      raise exception 'invalid contribution' using errcode = '22023';
    end if;
    select s.current_count into v_before from private.habit_streak(v_habit, v_today) s;
    insert into private.habit_contributions (id, habit_id, on_date, quantity, entered_quantity, entered_unit,
        contributed_by, source)
      values (p_id, v_habit.id, p_on, v_quantity, case when p_entered_unit is not null then p_quantity end,
        p_entered_unit, v_user_id, p_source)
      returning * into v_contribution;
    v_sync := private.habit_numeric_sync(v_habit, p_on, v_user_id, p_on = v_today);
    return pg_catalog.jsonb_build_object('outcome', 'added',
      'contributionId', v_contribution.id,
      'completedNow', (v_sync ->> 'changed') is not distinct from 'completed',
      'progress', private.habit_progress_json(v_habit, p_on),
      'streakBefore', v_before,
      'milestone', v_sync -> 'milestone',
      'habit', private.habit_summary_json(v_habit, v_user_id));
  end
  $$;


-- Goals ----------------------------------------------------------------------------------------------------

-- S30b-M1 (database part): the longest advance reminder a series of p_frequency can use, so it can fire
-- inside one period: weekly 6 days, monthly 27, yearly the general limit (90). The same rule as
-- goalSeriesLeadDaysMax in packages/domain.
create function private.goal_series_lead_days_max(p_frequency text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_frequency when 'weekly' then 6 when 'monthly' then 27 else 90 end;
  $$;

revoke all on function private.goal_series_lead_days_max(text) from public, anon, authenticated;


-- S30b-M1: as 20261114090000_recurring_goals.sql, except that the advance reminder must fit in one
-- period of the series' frequency (22023 otherwise, as for any invalid field).
create or replace function public.create_goal_series(
  p_id uuid, p_home_id uuid default null, p_kind text default null, p_frequency text default null,
  p_title text default null, p_description text default null, p_target numeric default null,
  p_unit text default null, p_unit_kind text default null, p_week_start text default 'monday',
  p_first_period date default null, p_ends_on date default null, p_time_zone text default null,
  p_reminder_lead_days smallint default null, p_reminder_at_time time default null,
  p_dry_run boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.goal_series;
    v_series private.goal_series;
    v_zone text;
    v_today date;
    v_current date;
    v_first date;
    v_goal_id uuid;
  begin
    perform private.require_goal_context(p_home_id, v_user_id);
    if p_id is null or p_dry_run is null or p_title is null
       or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description')))
       or p_kind is null or p_kind not in ('completion', 'measurable')
       or p_frequency is null or p_frequency not in ('weekly', 'monthly', 'yearly')
       or (p_kind = 'completion' and p_frequency = 'weekly')
       or p_week_start is null or p_week_start not in ('monday', 'saturday', 'sunday')
       or not private.valid_goal_shape(p_kind, p_target, p_unit, p_unit_kind)
       or p_first_period is null
       or (p_home_id is null and not private.valid_time_zone(p_time_zone))
       or (p_reminder_lead_days is null) <> (p_reminder_at_time is null)
       or (p_reminder_lead_days is not null and p_reminder_lead_days not between 1 and private.goal_limit('lead_days'))
       or (p_reminder_lead_days is not null and p_reminder_lead_days > private.goal_series_lead_days_max(p_frequency))
       or (p_reminder_at_time is not null and p_reminder_at_time <> date_trunc('minute', p_reminder_at_time)) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    if private.goal_access(p_home_id, v_user_id) is distinct from 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_zone := case when p_home_id is null then p_time_zone
      else (select h.timezone from public.homes h where h.id = p_home_id) end;
    v_today := (pg_catalog.now() at time zone v_zone)::date;
    select b.period_start into v_current from private.goal_period_bounds(p_frequency, p_week_start, v_today) b;
    select b.period_start into v_first from private.goal_period_bounds(p_frequency, p_week_start, p_first_period) b;
    if v_first < v_current or (p_ends_on is not null and p_ends_on < v_first) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_dates');
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'startsNow', v_first = v_current,
        'periods', private.goal_series_preview(p_frequency, p_week_start, v_first, p_ends_on));
    end if;
    select * into v_existing from private.goal_series s where s.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by = v_user_id and v_existing.owner_home_id is not distinct from p_home_id then
        return pg_catalog.jsonb_build_object('outcome', 'exists', 'revision', v_existing.revision);
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'id_taken');
    end if;
    -- Counted under the context lock, so two creates cannot both pass the limit.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('goals:' || coalesce(p_home_id, v_user_id)::text, 0));
    if (select count(*) from private.goal_series s
        where s.deleted_at is null and s.state <> 'stopped'
          and ((p_home_id is null and s.owner_home_id is null and s.owner_user_id = v_user_id)
            or (p_home_id is not null and s.owner_home_id = p_home_id))) >= private.goal_limit('series') then
      return pg_catalog.jsonb_build_object('outcome', 'too_many');
    end if;
    insert into private.goal_series (id, owner_user_id, owner_home_id, kind, frequency, week_start, title,
        description, time_zone, first_period_start, ends_on, reminder_lead_days, reminder_at_time,
        created_by, updated_by)
      values (p_id, case when p_home_id is null then v_user_id end, p_home_id, p_kind, p_frequency, p_week_start,
        p_title, p_description, case when p_home_id is null then p_time_zone end, v_first, p_ends_on,
        p_reminder_lead_days, p_reminder_at_time, v_user_id, v_user_id)
      returning * into v_series;
    if p_kind = 'measurable' then
      insert into private.goal_series_targets (series_id, effective_from, target, unit, unit_kind, created_by)
        values (v_series.id, v_first, p_target, p_unit, p_unit_kind, v_user_id);
    end if;
    perform private.goal_series_event(v_series.id, 'created', v_user_id,
      pg_catalog.jsonb_build_object('kind', p_kind, 'frequency', p_frequency, 'firstPeriodStart', v_first,
        'endsOn', p_ends_on, 'target', p_target));
    perform private.audit_goal_series('goal_series.created', v_series);
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    select g.id into v_goal_id from private.goals g where g.series_id = v_series.id and g.period_start = v_first;
    return pg_catalog.jsonb_build_object('outcome', 'created', 'revision', v_series.revision,
      'currentGoalId', v_goal_id);
  end
  $$;


-- S30b-M1: as 20261114090000_recurring_goals.sql, except that a changed advance reminder must fit in one
-- period of the series' frequency (an unchanged one saved before this rule is kept).
create or replace function public.update_goal_series(
  p_id uuid, p_expected_revision integer, p_title text, p_description text default null,
  p_ends_on date default null, p_time_zone text default null,
  p_reminder_lead_days smallint default null, p_reminder_at_time time default null
) returns table (outcome text, revision integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
    v_zone_changed boolean;
    v_current date;
    v_goal_id uuid;
  begin
    if p_id is null or p_expected_revision is null or p_title is null
       or not private.is_visible_name(p_title, private.goal_limit('title'))
       or (p_description is not null and not private.is_plain_text(p_description, private.goal_limit('description')))
       or (p_reminder_lead_days is null) <> (p_reminder_at_time is null)
       or (p_reminder_lead_days is not null and p_reminder_lead_days not between 1 and private.goal_limit('lead_days'))
       or (p_reminder_at_time is not null and p_reminder_at_time <> date_trunc('minute', p_reminder_at_time)) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    v_series := private.goal_series_lock(p_id, v_user_id);
    if v_series.id is null then
      return query select 'not_found', null::integer;
      return;
    end if;
    if private.goal_series_role(v_series, v_user_id) is distinct from 'manage' then
      return query select 'not_permitted', null::integer;
      return;
    end if;
    if p_reminder_lead_days is not null and p_reminder_lead_days is distinct from v_series.reminder_lead_days
       and p_reminder_lead_days > private.goal_series_lead_days_max(v_series.frequency) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    if v_series.owner_home_id is null and not private.valid_time_zone(p_time_zone) then
      raise exception 'invalid series' using errcode = '22023';
    end if;
    if v_series.revision <> p_expected_revision then
      return query select 'conflict', v_series.revision;
      return;
    end if;
    v_zone_changed := v_series.owner_home_id is null and p_time_zone <> v_series.time_zone;
    if p_title = v_series.title and p_description is not distinct from v_series.description
       and p_ends_on is not distinct from v_series.ends_on and not v_zone_changed
       and p_reminder_lead_days is not distinct from v_series.reminder_lead_days
       and p_reminder_at_time is not distinct from v_series.reminder_at_time then
      return query select 'unchanged', v_series.revision;
      return;
    end if;
    select b.period_start into v_current from private.goal_period_bounds(v_series.frequency, v_series.week_start,
      (pg_catalog.now() at time zone case when v_zone_changed then p_time_zone
        else private.goal_series_zone(v_series) end)::date) b;
    if p_ends_on is distinct from v_series.ends_on and p_ends_on is not null
       and p_ends_on < greatest(v_current, v_series.first_period_start) then
      return query select 'invalid_dates', v_series.revision;
      return;
    end if;
    update private.goal_series s set title = p_title, description = p_description, ends_on = p_ends_on,
        time_zone = case when s.owner_home_id is null then p_time_zone end,
        reminder_lead_days = p_reminder_lead_days, reminder_at_time = p_reminder_at_time,
        revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_series.id returning * into v_series;
    if v_zone_changed then
      for v_goal_id in select g.id from private.goals g where g.series_id = v_series.id and g.finalized_at is null
          order by g.period_start for update loop
        update private.goals g set time_zone = p_time_zone, revision = g.revision + 1 where g.id = v_goal_id;
        perform private.reschedule_goal_reminders(v_goal_id);
      end loop;
    end if;
    perform private.goal_series_event(v_series.id, 'edited', v_user_id,
      pg_catalog.jsonb_build_object('endsOn', v_series.ends_on, 'timeZone', v_zone_changed,
        'reminder', v_series.reminder_lead_days is not null));
    perform private.audit_goal_series('goal_series.updated', v_series);
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    return query select 'saved', (select s.revision from private.goal_series s where s.id = v_series.id);
  end
  $$;


-- S30b-L3: as 20261114090000_recurring_goals.sql (renamed by 20261115090000_habit_goal_links.sql), except
-- that an archived current period is left as it is: the new target applies to the series from that
-- period on, and the impact says 'currentArchived' (a single goal refuses changes while archived too).
create or replace function private.change_goal_series_target_before_links(
  p_id uuid, p_expected_revision integer, p_effective_from date, p_target numeric, p_unit text,
  p_unit_kind text, p_dry_run boolean default false, p_confirm_unit boolean default false,
  p_confirm_status boolean default false
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_series private.goal_series;
    v_today date;
    v_current date;
    v_before private.goal_series_targets;
    v_until date;
    v_goal private.goals;
    v_total numeric;
    v_unit_changed boolean;
    v_reached_before boolean;
    v_reached_after boolean;
    v_reopens boolean := false;
    v_impact jsonb;
    v_current_archived boolean := false;
  begin
    if p_id is null or p_expected_revision is null or p_effective_from is null or p_dry_run is null
       or p_confirm_unit is null or p_confirm_status is null
       or not private.valid_goal_shape('measurable', p_target, p_unit, p_unit_kind) then
      raise exception 'invalid target' using errcode = '22023';
    end if;
    v_series := private.goal_series_lock(p_id, v_user_id);
    if v_series.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if private.goal_series_role(v_series, v_user_id) is distinct from 'manage' then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_series.kind <> 'measurable' then
      return pg_catalog.jsonb_build_object('outcome', 'not_measurable');
    end if;
    if v_series.state = 'stopped' then
      return pg_catalog.jsonb_build_object('outcome', 'stopped');
    end if;
    if v_series.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', v_series.revision);
    end if;
    -- The period running now exists (or does not) before anything is decided about it.
    perform private.roll_goal_series(v_series.id, pg_catalog.now());
    select * into v_series from private.goal_series s where s.id = v_series.id;
    v_today := (pg_catalog.now() at time zone private.goal_series_zone(v_series))::date;
    select b.period_start into v_current from private.goal_period_bounds(v_series.frequency, v_series.week_start, v_today) b;
    if (select b.period_start from private.goal_period_bounds(v_series.frequency, v_series.week_start, p_effective_from) b)
         <> p_effective_from
       or p_effective_from < greatest(v_current, v_series.first_period_start)
       or (v_series.ends_on is not null and p_effective_from > v_series.ends_on) then
      return pg_catalog.jsonb_build_object('outcome', 'invalid_period');
    end if;
    v_before := private.goal_series_target_for(v_series.id, p_effective_from);
    select min(t.effective_from) into v_until from private.goal_series_targets t
      where t.series_id = v_series.id and t.effective_from > p_effective_from;
    if p_effective_from = v_current then
      select * into v_goal from private.goals g
        where g.series_id = v_series.id and g.period_start = v_current and g.deleted_at is null for update;
      if v_goal.archived_at is not null then
        v_current_archived := true;
        v_goal := null;
      end if;
    end if;
    v_unit_changed := p_unit <> v_before.unit or p_unit_kind <> v_before.unit_kind;
    if v_goal.id is not null then
      v_total := private.goal_total(v_goal);
      v_reached_before := v_total >= v_goal.target;
      v_reached_after := v_total >= p_target;
      v_reopens := v_goal.achieved_at is not null and v_total < p_target;
    end if;
    v_impact := pg_catalog.jsonb_build_object(
      'effectiveFrom', p_effective_from, 'until', v_until, 'current', p_effective_from = v_current,
      'targetBefore', v_before.target, 'targetAfter', p_target,
      'unitBefore', v_before.unit, 'unitKindBefore', v_before.unit_kind,
      'unitAfter', p_unit, 'unitKindAfter', p_unit_kind, 'unitChanged', v_unit_changed,
      'goalId', v_goal.id, 'total', v_total, 'reachedBefore', v_reached_before, 'reachedAfter', v_reached_after,
      'achieved', v_goal.achieved_at is not null, 'reopens', v_reopens, 'currentArchived', v_current_archived,
      'reminders', coalesce((select r.enabled from private.goal_reminders r where r.goal_id = v_goal.id), false));
    if p_target = v_before.target and not v_unit_changed then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    if v_goal.id is not null and v_unit_changed and not p_confirm_unit
       and exists (select 1 from private.goal_entries e where e.goal_id = v_goal.id and e.status = 'active' and e.quantity <> 0) then
      return pg_catalog.jsonb_build_object('outcome', 'confirm_unit', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    if v_goal.id is not null and (v_reached_before <> v_reached_after or v_reopens) and not p_confirm_status then
      return pg_catalog.jsonb_build_object('outcome', 'confirm_status', 'revision', v_series.revision, 'impact', v_impact);
    end if;
    insert into private.goal_series_targets as t (series_id, effective_from, target, unit, unit_kind, created_by)
      values (v_series.id, p_effective_from, p_target, p_unit, p_unit_kind, v_user_id)
      on conflict (series_id, effective_from) do update set target = excluded.target, unit = excluded.unit,
        unit_kind = excluded.unit_kind, created_by = excluded.created_by, created_at = pg_catalog.now();
    if v_goal.id is not null then
      update private.goals g set target = p_target, unit = p_unit, unit_kind = p_unit_kind,
          achieved_at = case when v_reopens then null else g.achieved_at end,
          achieved_by = case when v_reopens then null else g.achieved_by end,
          revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where g.id = v_goal.id;
      if v_reopens then
        update private.goal_achievements a set reopened_at = pg_catalog.now(), reopened_by = v_user_id
          where a.goal_id = v_goal.id and a.reopened_at is null;
      end if;
      perform private.goal_event(v_goal.id, 'target_changed', v_user_id, null,
        pg_catalog.jsonb_build_object('targetBefore', v_goal.target, 'targetAfter', p_target,
          'unitBefore', v_goal.unit, 'unitKindBefore', v_goal.unit_kind, 'unitAfter', p_unit,
          'unitKindAfter', p_unit_kind, 'unitChanged', v_unit_changed, 'reopened', v_reopens, 'series', true));
      if v_reopens then
        perform private.reschedule_goal_reminders(v_goal.id);
      end if;
    end if;
    update private.goal_series s set revision = s.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where s.id = v_series.id returning * into v_series;
    perform private.goal_series_event(v_series.id, 'target_scheduled', v_user_id,
      pg_catalog.jsonb_build_object('effectiveFrom', p_effective_from, 'targetBefore', v_before.target,
        'targetAfter', p_target, 'unitBefore', v_before.unit, 'unitAfter', p_unit, 'unitChanged', v_unit_changed,
        'current', v_goal.id is not null, 'reopened', v_reopens));
    perform private.audit_goal_series('goal_series.target_changed', v_series,
      pg_catalog.jsonb_build_object('unitChanged', v_unit_changed, 'reopened', v_reopens));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_series.revision, 'impact', v_impact);
  end
  $$;


-- Follow-up of S30-L4 (Part 4b): as 20261114090000_recurring_goals.sql, plus: reopening an achieved goal
-- (not a series period) makes it active again, so it is refused ('too_many') when its context already
-- holds the most active goals, counted under the context lock creates take. A reopening caused by a
-- target or entry change is never refused (it corrects data), so the limit can still be passed that way.
create or replace function public.set_goal_achievement(
  p_id uuid, p_expected_revision integer, p_achieved boolean, p_reason text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_goal private.goals;
    v_total numeric;
  begin
    if p_id is null or p_expected_revision is null or p_achieved is null
       or (p_reason is not null and (p_achieved or not private.is_plain_text(p_reason, private.goal_limit('reason')))) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_goal := private.goal_lock(p_id, v_user_id);
    if v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_may(v_goal, v_user_id,
        case when p_achieved and v_goal.kind = 'completion' and not private.goal_period_ended(v_goal)
          then 'contribute' else 'manage' end) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_goal.archived_at is not null then
      return pg_catalog.jsonb_build_object('outcome', 'archived');
    end if;
    if (v_goal.achieved_at is not null) = p_achieved then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', v_goal.revision,
        'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if v_goal.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'conflict', 'revision', v_goal.revision);
    end if;
    if not p_achieved and v_goal.series_id is null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'goals:' || coalesce(v_goal.owner_home_id, v_goal.owner_user_id)::text, 0));
      if (select count(*) from private.goals g
          where g.deleted_at is null and g.archived_at is null and g.achieved_at is null and g.series_id is null
            and g.owner_user_id is not distinct from v_goal.owner_user_id
            and g.owner_home_id is not distinct from v_goal.owner_home_id) >= private.goal_limit('goals') then
        return pg_catalog.jsonb_build_object('outcome', 'too_many', 'revision', v_goal.revision);
      end if;
    end if;
    v_total := private.goal_total(v_goal);
    if p_achieved and v_goal.kind = 'measurable' and v_total < v_goal.target then
      return pg_catalog.jsonb_build_object('outcome', 'target_not_reached',
        'goal', private.goal_summary_json(v_goal, v_user_id));
    end if;
    if p_achieved then
      insert into private.goal_achievements (goal_id, achieved_by, total, target, unit, unit_kind)
        values (v_goal.id, v_user_id, v_total, v_goal.target, v_goal.unit, v_goal.unit_kind);
      update private.goals g set achieved_at = pg_catalog.now(), achieved_by = v_user_id,
          revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where g.id = v_goal.id returning * into v_goal;
    else
      update private.goal_achievements a set reopened_at = pg_catalog.now(), reopened_by = v_user_id,
          reopen_reason = p_reason
        where a.goal_id = v_goal.id and a.reopened_at is null;
      update private.goals g set achieved_at = null, achieved_by = null,
          revision = g.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
        where g.id = v_goal.id returning * into v_goal;
      perform private.reschedule_goal_reminders(v_goal.id);
    end if;
    perform private.goal_event(v_goal.id, case when p_achieved then 'achieved' else 'reopened' end, v_user_id, null,
      pg_catalog.jsonb_build_object('total', v_total, 'target', v_goal.target));
    perform private.audit_goal(case when p_achieved then 'goal.achieved' else 'goal.reopened' end, v_goal);
    perform private.recheck_goal_outcome(v_goal.id, v_user_id);
    select * into v_goal from private.goals g where g.id = v_goal.id;
    return pg_catalog.jsonb_build_object('outcome', case when p_achieved then 'achieved' else 'reopened' end,
      'revision', v_goal.revision, 'goal', private.goal_summary_json(v_goal, v_user_id));
  end
  $$;


-- S30c-L5: as 20261115090000_habit_goal_links.sql, plus: the caller must be able to see the link's goal
-- or series before its habit is locked, so a link id of another Home locks nothing.
create or replace function public.remove_goal_link(
  p_id uuid, p_mode text, p_dry_run boolean default false, p_expected_revision integer default null,
  p_expected_amount numeric default null
) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_link private.goal_habit_links;
    v_series private.goal_series;
    v_goal private.goals;
    v_impact jsonb;
    v_token integer;
    v_row record;
    v_entries jsonb := '{}'::jsonb;
    v_entry_id uuid;
    v_target private.goals;
  begin
    if p_id is null or p_dry_run is null or p_mode is null or p_mode not in ('keep', 'remove')
       or (not p_dry_run and (p_expected_revision is null or p_expected_amount is null)) then
      raise exception 'invalid link' using errcode = '22023';
    end if;
    select * into v_link from private.goal_habit_links l where l.id = p_id;
    if v_link.id is null or v_link.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if v_link.series_id is not null then
      select * into v_series from private.goal_series s where s.id = v_link.series_id;
      if private.goal_series_role(v_series, v_user_id) is null then
        return pg_catalog.jsonb_build_object('outcome', 'not_found');
      end if;
    else
      select * into v_goal from private.goals g where g.id = v_link.goal_id;
      if v_goal.id is null or not private.goal_may(v_goal, v_user_id, 'view') then
        return pg_catalog.jsonb_build_object('outcome', 'not_found');
      end if;
    end if;
    -- Lock order: the habit (when it still exists, even in the trash), then the destination.
    perform 1 from private.habits h where h.id = v_link.habit_id for update;
    if v_link.series_id is not null then
      v_series := private.goal_series_lock(v_link.series_id, v_user_id);
    else
      -- A goal in the trash keeps its links: it is restored or purged with them.
      v_goal := private.goal_lock(v_link.goal_id, v_user_id);
    end if;
    if v_series.id is null and v_goal.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    perform private.goal_link_lock_destination(v_link.goal_id, v_link.series_id);
    select * into v_link from private.goal_habit_links l where l.id = p_id;
    if v_link.state <> 'active' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.goal_link_manager(v_link, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    v_impact := private.goal_link_impact(v_link.id, null, null, v_link.goal_id, v_link.series_id, p_mode)
      || pg_catalog.jsonb_build_object('mode', p_mode, 'startsOn', v_link.starts_on,
        'habit', case when v_link.habit_id is not null then (select pg_catalog.jsonb_build_object('id', h.id, 'name', h.name)
          from private.habits h where h.id = v_link.habit_id) end,
        'source', private.goal_link_source_state(v_link));
    v_token := private.goal_link_token(v_link.revision, v_impact);
    if p_dry_run then
      return pg_catalog.jsonb_build_object('outcome', 'preview', 'revision', v_token, 'impact', v_impact);
    end if;
    if p_expected_revision <> v_token or p_expected_amount <> (v_impact ->> 'amountBefore')::numeric then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_token, 'impact', v_impact);
    end if;
    if p_mode = 'keep' then
      for v_row in select d.goal_id, sum(d.quantity) as q from private.goal_link_days d
          where d.link_id = v_link.id and d.counted group by d.goal_id having sum(d.quantity) <> 0 loop
        select * into v_target from private.goals g where g.id = v_row.goal_id;
        v_entry_id := gen_random_uuid();
        insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, contributed_by, source)
          values (v_entry_id, v_target.id, 'adjustment', v_row.q, v_target.unit, v_target.unit_kind, v_user_id, 'link');
        v_entries := v_entries || pg_catalog.jsonb_build_object(v_target.id::text, v_entry_id);
      end loop;
    end if;
    delete from private.goal_link_days d where d.link_id = v_link.id;
    update private.goal_habit_links l set state = 'removed', removal = p_mode, removed_at = pg_catalog.now(),
        removed_by = v_user_id, revision = l.revision + 1, updated_by = v_user_id, updated_at = pg_catalog.now()
      where l.id = v_link.id returning * into v_link;
    for v_row in select (x ->> 'goalId')::uuid as goal_id from pg_catalog.jsonb_array_elements(v_impact -> 'goals') x loop
      perform private.recheck_goal_outcome(v_row.goal_id, v_user_id);
    end loop;
    perform private.goal_link_record(v_link, 'link_removed', v_user_id, v_impact,
      pg_catalog.jsonb_build_object('linkId', v_link.id, 'habitId', v_link.habit_id, 'mode', p_mode,
        'amount', v_impact -> 'amountBefore'), v_entries);
    return pg_catalog.jsonb_build_object('outcome', 'removed', 'impact', v_impact);
  end
  $$;


-- Pets -----------------------------------------------------------------------------------------------------

-- S31-L2: as 20261116090000_pets.sql, plus: the caller's access to the pet's Home is checked before the
-- row is locked, so a pet id of another Home locks nothing (the check is repeated under the lock).
create or replace function private.lock_pet(p_pet_id uuid, p_user_id uuid) returns private.pets
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pet private.pets;
  begin
    select * into v_pet from private.pets p where p.id = p_pet_id;
    if not found or private.pet_access(v_pet.home_id, p_user_id) is null then
      return null;
    end if;
    select * into v_pet from private.pets p where p.id = p_pet_id for update;
    if not found or v_pet.deleted_at is not null or private.pet_access(v_pet.home_id, p_user_id) is null then
      return null;
    end if;
    return v_pet;
  end
  $$;


-- S31c-L1: as 20261117090000_pet_care.sql, except that overdue care comes first (a timed occurrence of
-- today whose time has passed now comes before today's untimed ones), then by date and time.
create or replace function public.list_home_pet_care(
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
      select row_number() over (order by
          case when o.due_on < v_today or (o.due_on = v_today and o.at_time <= v_now) then 0 else 1 end,
          o.due_on, o.at_time nulls first, o.id) as n,
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
      order by case when o.due_on < v_today or (o.due_on = v_today and o.at_time <= v_now) then 0 else 1 end,
        o.due_on, o.at_time nulls first, o.id
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


-- Account activity -----------------------------------------------------------------------------------------

-- S38-L1: as 20261124090000_activity_history.sql, except that a response is final once reported: a
-- repeated report (or a later "This was me") records nothing again, but still signs the reported session
-- out when it is live and not the current one ('signed_out'; otherwise 'reported'). A repeated "This was
-- me" answers 'confirmed' without a change. A confirmed sign-in can still be reported.
create or replace function public.respond_to_sign_in(p_event_id uuid, p_response text) returns text
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_current uuid := private.jwt_session_id();
    v_event private.account_activity_events;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_current) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_response is null or p_response not in ('confirmed', 'reported') then
      raise exception 'invalid response' using errcode = '22023';
    end if;
    select * into v_event from private.account_activity_events a
      where a.id = p_event_id and a.user_id = v_user_id
        and a.kind in ('signed_in', 'sign_in_unfinished')
        and a.created_at > pg_catalog.now() - private.activity_retention()
      for update;
    if v_event.id is null then
      raise exception 'unknown sign-in' using errcode = 'P0002';
    end if;
    if v_event.response = 'reported' then
      if v_event.session_id is not null and v_event.session_id <> v_current
         and private.session_is_live(v_user_id, v_event.session_id)
         and public.revoke_my_session(v_event.session_id, true) then
        return 'signed_out';
      end if;
      return 'reported';
    end if;
    if v_event.response = 'confirmed' and p_response = 'confirmed' then
      return 'confirmed';
    end if;
    update private.account_activity_events a
      set response = p_response, responded_at = pg_catalog.now()
      where a.id = v_event.id;
    if p_response = 'confirmed' then
      return 'confirmed';
    end if;
    if v_event.session_id is not null and v_event.session_id <> v_current
       and private.session_is_live(v_user_id, v_event.session_id)
       and public.revoke_my_session(v_event.session_id, true) then
      return 'signed_out';
    end if;
    perform private.record_security_event(v_user_id, 'session_reported', v_event.session_id);
    perform private.notify_user(
      v_user_id, null, 'security', 'account.session_reported', '{}'::jsonb,
      'account.session_reported:' || coalesce(v_event.session_id, v_event.id)::text, true);
    return 'reported';
  end
  $$;


-- Copies to a Home ------------------------------------------------------------------------------------------

-- S40P2-L2: as 20261128090000_category_deletion_home_copies.sql, plus: the request row and then the
-- destination pool are locked before its reserved files are removed and its usage reassessed (request,
-- pool, files: the order commit_home_copy takes them in).
create or replace function private.end_home_copy(p_request_id uuid, p_status text, p_code text default null)
returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool uuid;
  begin
    if p_status not in ('rejected', 'cancelled', 'expired', 'invalidated', 'failed') then
      raise exception 'not an end status' using errcode = '22023';
    end if;
    select f.pool_id into v_pool from private.home_copy_files c
      join private.stored_files f on f.id = c.dest_file_id
      where c.request_id = p_request_id limit 1;
    perform 1 from private.home_copy_requests r where r.id = p_request_id for update;
    if v_pool is not null then
      perform 1 from private.storage_pools p where p.id = v_pool for update;
    end if;
    delete from private.stored_files f
      using private.home_copy_files c
      where c.request_id = p_request_id and f.id = c.dest_file_id and f.status = 'pending';
    update private.home_copy_requests r
      set status = p_status, end_code = p_code, ended_at = pg_catalog.now()
      where r.id = p_request_id and r.status in ('pending', 'copying');
    if not found then
      return false;
    end if;
    if v_pool is not null then
      perform private.storage_reassess(v_pool);
    end if;
    return true;
  end
  $$;


-- As 20261128090000_category_deletion_home_copies.sql, plus:
--   S40P2-L2  the destination pool is locked before the reserved files become ready and its usage is
--             reassessed;
--   S40P2-L5  a calendar exception that only changed participants (which are never copied) is not copied
--             as an empty change.
create or replace function private.commit_home_copy(p_request_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_req private.home_copy_requests;
    v_copy uuid := pg_catalog.gen_random_uuid();
    v_cover uuid;
    v_pool uuid;
    v_now timestamptz := pg_catalog.now();
  begin
    select * into v_req from private.home_copy_requests r where r.id = p_request_id for update;
    if not found or v_req.status not in ('pending', 'copying') then
      return 'invalidated';
    end if;
    if v_req.requester_id is null or private.home_role(v_req.home_id, v_req.requester_id) is null then
      perform private.end_home_copy(v_req.id, 'invalidated', 'not_member');
      return 'invalidated';
    end if;
    if not private.copy_item_eligible(v_req.item_type, v_req.source_id, v_req.requester_id) then
      perform private.end_home_copy(v_req.id, 'invalidated', 'item_unavailable');
      return 'invalidated';
    end if;
    -- The authority behind the copy must still hold at execution: the requester's creation right for
    -- a direct copy, the approver's right to approve that content in the Home otherwise.
    if (v_req.direct and not private.copy_can_create(v_req.item_type, v_req.home_id, v_req.requester_id))
       or (not v_req.direct and (v_req.decided_by is null
           or not private.copy_can_approve(v_req.item_type, v_req.home_id, v_req.decided_by))) then
      perform private.end_home_copy(v_req.id, 'invalidated', 'not_authorized');
      return 'invalidated';
    end if;
    -- Every reserved file must still be waiting (an expired reservation was removed meanwhile).
    if exists (select 1 from private.home_copy_files c join private.stored_files f on f.id = c.dest_file_id
               where c.request_id = v_req.id and f.status <> 'pending') then
      perform private.end_home_copy(v_req.id, 'failed', 'files_lost');
      return 'failed';
    end if;

    if v_req.item_type = 'recipe' then
      perform private.lock_recipe_context(v_req.home_id, null);
      if private.recipe_context_full(v_req.home_id, null) then
        perform private.end_home_copy(v_req.id, 'failed', 'limit');
        return 'failed';
      end if;
      select c.dest_file_id into v_cover from private.home_copy_files c where c.request_id = v_req.id limit 1;
      insert into private.recipes (
        id, owner_home_id, status, name, name_key, servings, servings_label, prep_minutes,
        cook_minutes, notes, tags, tag_keys, cover_file_id, source_url, source_name, created_by,
        updated_by, published_at, copied_from_personal_at)
      select v_copy, v_req.home_id, 'published', r.name, r.name_key, r.servings, r.servings_label,
             r.prep_minutes, r.cook_minutes, r.notes, r.tags, r.tag_keys, v_cover, r.source_url,
             r.source_name, v_req.requester_id, v_req.requester_id, v_now, v_now
        from private.recipes r where r.id = v_req.source_id;
      insert into private.recipe_ingredients (recipe_id, position, name, name_key, quantity_num,
                                              quantity_den, quantity_style, unit, note)
        select v_copy, i.position, i.name, i.name_key, i.quantity_num, i.quantity_den,
               i.quantity_style, i.unit, i.note
          from private.recipe_ingredients i where i.recipe_id = v_req.source_id;
      insert into private.recipe_steps (recipe_id, position, body)
        select v_copy, s.position, s.body from private.recipe_steps s where s.recipe_id = v_req.source_id;
      delete from private.recipe_shares s where s.recipe_id = v_req.source_id and s.home_id = v_req.home_id;

    elsif v_req.item_type = 'calendar_event' then
      perform private.lock_calendar_owner(null, v_req.home_id);
      if private.calendar_owner_full(null, v_req.home_id) then
        perform private.end_home_copy(v_req.id, 'failed', 'limit');
        return 'failed';
      end if;
      -- Reminders and participants are the Home's to set: a copy starts without them.
      insert into private.calendar_events (
        id, home_id, title, location, description, all_day, starts_on, ends_on, start_time,
        end_time, timezone, frequency, interval_count, weekdays, repeat_ends_on, max_count,
        until_date, created_by, updated_by, copied_from_personal_at)
      select v_copy, v_req.home_id, e.title, e.location, e.description, e.all_day, e.starts_on,
             e.ends_on, e.start_time, e.end_time, e.timezone, e.frequency, e.interval_count,
             e.weekdays, e.repeat_ends_on, e.max_count, e.until_date, v_req.requester_id,
             v_req.requester_id, v_now
        from private.calendar_events e where e.id = v_req.source_id;
      insert into private.calendar_event_exceptions (
        event_id, original_date, cancelled, fields, title, location, description, all_day,
        starts_on, ends_on, start_time, end_time, participants, updated_by)
      select v_copy, x.original_date, x.cancelled,
             pg_catalog.array_remove(x.fields, 'participants'), x.title, x.location, x.description,
             x.all_day, x.starts_on, x.ends_on, x.start_time, x.end_time, null, v_req.requester_id
        from private.calendar_event_exceptions x
        where x.event_id = v_req.source_id
          and (x.cancelled or cardinality(pg_catalog.array_remove(x.fields, 'participants')) > 0);
      delete from private.calendar_event_shares s where s.event_id = v_req.source_id and s.home_id = v_req.home_id;

    elsif v_req.item_type = 'photo_album' then
      perform private.lock_photo_library(null, v_req.home_id);
      if private.photo_albums_full(null, v_req.home_id) then
        perform private.end_home_copy(v_req.id, 'failed', 'limit');
        return 'failed';
      end if;
      insert into private.photo_albums (id, owner_home_id, created_by, name, copied_from_personal_at)
        select v_copy, v_req.home_id, v_req.requester_id, a.name, v_now
          from private.photo_albums a where a.id = v_req.source_id;
      with copied as (
        insert into private.photos (id, file_id, owner_home_id, created_by, width, height,
                                    copied_from_personal_at)
        select pg_catalog.gen_random_uuid(), c.dest_file_id, v_req.home_id, v_req.requester_id,
               p.width, p.height, v_now
          from private.home_copy_files c join private.photos p on p.id = c.source_photo_id
          where c.request_id = v_req.id
        returning id
      )
      insert into private.photo_album_items (album_id, photo_id, added_by, added_at)
        select v_copy, copied.id, v_req.requester_id, v_now from copied;
      delete from private.photo_album_shares s where s.album_id = v_req.source_id and s.home_id = v_req.home_id;
    end if;

    select f.pool_id into v_pool from private.home_copy_files c
      join private.stored_files f on f.id = c.dest_file_id where c.request_id = v_req.id limit 1;
    if v_pool is not null then
      perform 1 from private.storage_pools p where p.id = v_pool for update;
    end if;
    -- The new files become the Home's own: the source's verified facts (a byte-exact copy).
    update private.stored_files d
      set status = 'ready', content_type = s.content_type, size_bytes = s.size_bytes,
          sha256 = s.sha256, finalized_at = v_now
      from private.home_copy_files c join private.stored_files s on s.id = c.source_file_id
      where c.request_id = v_req.id and d.id = c.dest_file_id;
    update private.photo_variants d
      set size_bytes = s.size_bytes, width = s.width, height = s.height, sha256 = s.sha256
      from private.home_copy_files c join private.photo_variants s on s.file_id = c.source_file_id
      where c.request_id = v_req.id and d.file_id = c.dest_file_id and d.kind = s.kind;
    select f.pool_id into v_pool from private.home_copy_files c
      join private.stored_files f on f.id = c.dest_file_id where c.request_id = v_req.id limit 1;
    delete from private.home_copy_files c where c.request_id = v_req.id;
    if v_pool is not null then
      perform private.storage_reassess(v_pool);
    end if;

    update private.home_copy_requests r
      set status = 'completed', copy_id = v_copy, ended_at = v_now, end_code = null
      where r.id = v_req.id;
    perform private.audit('copy_request.completed', v_req.home_id, 'home_copy', v_req.id,
      pg_catalog.jsonb_build_object('itemType', v_req.item_type, 'copyId', v_copy,
        'requestedBy', v_req.requester_id, 'approvedBy', v_req.decided_by, 'direct', v_req.direct));
    return 'completed';
  end
  $$;


-- S40P2-L3: as 20261128090000_category_deletion_home_copies.sql, except that only the destination Homes
-- the caller belongs to are locked (another Home's id is answered 'not_member' without taking its lock).
create or replace function public.request_home_copies(p_item_type text, p_item_id uuid, p_home_ids uuid[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_batch uuid := pg_catalog.gen_random_uuid();
    v_home uuid;
    v_id uuid;
    v_outcome text;
    v_out jsonb := '[]';
    v_approver uuid;
    v_req private.home_copy_requests;
  begin
    if not private.session_is_live(v_user_id, private.jwt_session_id()) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_item_type is null or p_item_type not in ('recipe', 'calendar_event', 'photo_album')
       or p_home_ids is null or cardinality(p_home_ids) = 0
       or cardinality(p_home_ids) > private.home_copy_limit('homes')
       or exists (select 1 from pg_catalog.unnest(p_home_ids) x(id) where x.id is null) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- Destination Homes first (lock order), then the item.
    for v_home in select distinct x.id from pg_catalog.unnest(p_home_ids) x(id)
        where private.home_role(x.id, v_user_id) is not null order by x.id loop
      perform private.lock_home(v_home);
    end loop;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('home-copies:' || v_user_id::text, 0));
    if not private.copy_item_eligible(p_item_type, p_item_id, v_user_id) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if (select count(*) from private.home_copy_requests r
        where r.requester_id = v_user_id and r.status in ('pending', 'copying'))
       + cardinality(p_home_ids) > private.home_copy_limit('open_requests') then
      raise exception 'too many open requests' using errcode = '54000';
    end if;

    for v_home in select distinct x.id from pg_catalog.unnest(p_home_ids) x(id) order by x.id loop
      v_id := null;
      if private.home_role(v_home, v_user_id) is null then
        v_outcome := 'not_member';
      elsif exists (select 1 from private.home_copy_requests r
                    where r.item_type = p_item_type and r.source_id = p_item_id and r.home_id = v_home
                      and r.status in ('pending', 'copying')) then
        v_outcome := 'already_open';
      else
        insert into private.home_copy_requests (
          batch_id, requester_id, home_id, item_type, source_id, status, direct, expires_at)
        values (
          v_batch, v_user_id, v_home, p_item_type, p_item_id, 'pending',
          private.copy_can_create(p_item_type, v_home, v_user_id),
          pg_catalog.now() + private.home_copy_request_lifetime())
        returning * into v_req;
        v_id := v_req.id;
        perform private.audit('copy_request.requested', v_home, 'home_copy', v_req.id,
          pg_catalog.jsonb_build_object('itemType', p_item_type, 'direct', v_req.direct));
        if v_req.direct then
          v_outcome := private.start_home_copy(v_req.id);
        else
          v_outcome := 'pending';
          for v_approver in
            select m.user_id from public.home_memberships m
              where m.home_id = v_home and m.user_id <> v_user_id
                and private.copy_can_approve(p_item_type, v_home, m.user_id)
              order by m.user_id
          loop
            perform private.notify_user(
              v_approver, v_home, 'approvals', 'home_copy.approval_requested',
              pg_catalog.jsonb_build_object('itemType', p_item_type, 'requestId', v_req.id),
              'home_copy.approval_requested:' || v_req.id::text, true);
          end loop;
        end if;
      end if;
      v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'homeId', v_home, 'outcome', v_outcome, 'requestId', v_id,
        'code', (select r.end_code from private.home_copy_requests r where r.id = v_id))));
    end loop;
    return pg_catalog.jsonb_build_object('batchId', v_batch, 'homes', v_out);
  end
  $$;


-- Children -------------------------------------------------------------------------------------------------

-- S42P-L4: as 20261202090000_child_independent_account.sql, except that "today" for the birth date and
-- the age check is the Home's calendar date, not the database server's (UTC) one.
create or replace function public.start_child_transition(
  p_home_id uuid, p_child_membership_id uuid, p_birth_date date
) returns table (outcome text, token text, expires_at timestamptz, eligible_on date)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_child uuid;
    v_age integer;
    v_token text;
    v_id uuid;
    v_expires timestamptz := pg_catalog.now() + interval '7 days';
    v_today date := (pg_catalog.now() at time zone coalesce(
      (select h.timezone from public.homes h where h.id = p_home_id), 'UTC'))::date;
  begin
    if p_birth_date is null or p_birth_date > v_today
       or p_birth_date < v_today - interval '120 years' then
      raise exception 'invalid birth date' using errcode = '22023';
    end if;
    if not private.lock_home(p_home_id) then
      return query select 'not_found'::text, null::text, null::timestamptz, null::date;
      return;
    end if;
    v_child := private.child_of_membership(p_home_id, p_child_membership_id);
    if v_child is null or private.child_guardian_role(p_home_id, v_child, v_user_id) is null then
      return query select 'not_found'::text, null::text, null::timestamptz, null::date;
      return;
    end if;
    if not private.child_identity_authority(v_child, v_user_id) then
      return query select 'not_permitted'::text, null::text, null::timestamptz, null::date;
      return;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('child_transition:' || v_child::text, 0));
    v_age := private.child_independence_age(v_child);
    if (p_birth_date + pg_catalog.make_interval(years => v_age))::date > v_today then
      perform private.audit('child.transition_not_eligible', p_home_id, 'user', v_child,
        pg_catalog.jsonb_build_object('required_age', v_age));
      return query select 'not_eligible'::text, null::text, null::timestamptz,
                          (p_birth_date + pg_catalog.make_interval(years => v_age))::date;
      return;
    end if;

    update private.child_transitions t set status = 'cancelled'
      where t.child_user_id = v_child and t.status = 'started';
    v_token := private.new_invitation_token('link');
    insert into private.child_transitions (child_user_id, started_by, required_age, claim_token_hash,
                                           claim_expires_at)
      values (v_child, v_user_id, v_age, private.token_hash(v_token), v_expires)
      returning id into v_id;
    -- Every other guardian, in any of the child's Homes, is told so they can cancel in time.
    perform private.notify_user(g.guardian_user_id, g.home_id, 'security', 'child.transition_started',
      '{}'::jsonb, 'child.transition_started:' || v_id::text || ':' || g.guardian_user_id::text)
    from (select distinct on (x.guardian_user_id) x.guardian_user_id, x.home_id
          from public.child_guardians x
          where x.child_user_id = v_child and x.guardian_user_id <> v_user_id
          order by x.guardian_user_id, x.assigned_at) g;
    perform private.audit('child.transition_started', p_home_id, 'user', v_child,
      pg_catalog.jsonb_build_object('required_age', v_age));
    return query select 'started'::text, v_token, v_expires, null::date;
  end
  $$;


-- Household devices ----------------------------------------------------------------------------------------

-- S42P-L7: as 20261213090000_review_decisions.sql, plus: a deactivated member is not listed on the
-- device's board (they cannot act while deactivated).
create or replace function public.shared_device_board(p_device_hash text) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_device private.household_devices := private.approved_device(coalesce(p_device_hash, ''));
    v_today date;
  begin
    if v_device.id is null then
      return null;
    end if;
    v_today := private.task_today(v_device.home_id, null);
    return jsonb_build_object(
      'require_pin', coalesce((select s.require_pin from private.shared_device_settings s
                               where s.home_id = v_device.home_id), false),
      'members', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'membership_id', m.id,
                 'name', coalesce(p.nickname, p.display_name, up.display_name),
                 'accent_color', coalesce(p.accent_color, up.accent_color),
                 'is_child', private.is_child(m.user_id),
                 'requires_pin', exists (select 1 from private.shared_device_member_rules r
                                         where r.home_id = m.home_id and r.user_id = m.user_id),
                 'has_pin', case when private.is_child(m.user_id)
                   then exists (select 1 from private.child_home_pins hp
                                where hp.home_id = m.home_id and hp.child_user_id = m.user_id)
                   else exists (select 1 from private.member_device_pins dp
                                where dp.user_id = m.user_id) end)
               order by m.created_at, m.id)
        from public.home_memberships m
        left join public.home_member_profiles p on p.home_id = m.home_id and p.user_id = m.user_id
        left join public.user_preferences up on up.user_id = m.user_id
        where m.home_id = v_device.home_id
          and not private.is_deactivated(m.user_id)
          and not (private.is_child(m.user_id) and private.child_on_hold(m.home_id, m.user_id))), '[]'::jsonb),
      'chores', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'occurrence_id', o.id,
                 'title', c.title,
                 'due_date', o.due_date,
                 'overdue', o.due_date < v_today,
                 'assignee_ids', coalesce((
                   select jsonb_agg(private.member_ref(a.home_id, a.user_id))
                   from private.chore_occurrence_assignees a where a.occurrence_id = o.id),
                   '[]'::jsonb),
                 'mandatory_open', (select count(*) from private.chore_occurrence_steps st
                   where st.occurrence_id = o.id and st.mandatory and st.checked_at is null),
                 'requires_approval', c.requires_approval,
                 'requires_pin', exists (select 1 from private.shared_device_chore_rules r
                                         where r.chore_id = c.id))
               order by o.due_date, c.title, o.id)
        from private.chore_occurrences o
        join private.chores c on c.id = o.chore_id
        where o.home_id = v_device.home_id and o.status = 'open' and o.deleted_at is null
          and c.deleted_at is null and o.due_date <= v_today), '[]'::jsonb)
    );
  end
  $$;


-- S42P-L7: as 20261213090000_review_decisions.sql, plus: a deactivated member cannot be named for a chore
-- on the device either.
create or replace function private.device_member(
  p_device private.household_devices, p_occurrence_id uuid, p_membership_id uuid
) returns uuid
  language sql stable security definer set search_path = '' as $$
    select m.user_id from public.home_memberships m
    join private.chore_occurrences o on o.id = p_occurrence_id and o.home_id = m.home_id
    where m.home_id = p_device.home_id and m.id = p_membership_id and o.deleted_at is null
      and not private.is_deactivated(m.user_id)
      and (not private.is_child(m.user_id)
           or (exists (select 1 from private.chore_occurrence_assignees a
                       where a.occurrence_id = o.id and a.user_id = m.user_id)
               and not private.child_on_hold(m.home_id, m.user_id)))
  $$;
