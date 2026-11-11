-- S40 (part 2): deleting personal data by category, and copying personal items into Homes
-- (brief plans/steps/S40-brief.md, "Part 2"; ADR 0050).
--
-- Spec: Project-specification.md "Confirmed category-based deletion of adult personal data",
-- "Confirmed origin metadata for independent Home-owned copies", "Confirmed independent attachment
-- ownership for Home copies", "Confirmed retention of personal original after Home ownership
-- transfer", "Confirmed personal-to-Home ownership transfers at any time", "Confirmed transfer of
-- personally owned shared content before account deletion", "Confirmed multi-Home transfer copies
-- before account deletion", "Confirmed permissions for receiving personal-to-Home ownership
-- transfers", "Confirmed self-approval for personal-to-Home transfers", "Confirmed content transfer
-- approval expiry", "Confirmed transfer approval notifications", "Confirmed pending content
-- transfers during account deletion".
--
-- Part A, category deletion: one call deletes the chosen categories of the caller's own personal
-- data for good, each category in its own sub-transaction so one failure never undoes the others.
-- It needs a fresh 'delete_personal_data' re-authentication and is idempotent per request id.
-- Nothing Home-owned is touched; shares of deleted items end with them; their files are deleted
-- and their objects queued for removal; open personal exports are invalidated by the S39 triggers.
--
-- Part B, Home copies: a person asks for an independent Home-owned copy of one of their personal
-- recipes, calendar events or photo albums in one or more of their Homes. Each Home is decided on
-- its own: directly when the person may create that content there, otherwise as a pending request
-- for that Home's approvers (Owner, Administrators, holders of the content's creation right; an
-- approver may approve their own request). Everything is checked again when approved and when the
-- copy is made. A copy without files is made in the same transaction; with files, the Home's space
-- is reserved, new Home files are created and the home-copy-files job copies the objects in the
-- bucket, then the copy appears in one transaction. The original stays personal; the destination
-- Home leaves its share list. Nothing ever synchronizes.
--
-- Lock order: the destination Home row, then the request row, then the storage pool.

-- Settings -----------------------------------------------------------------------------------------

-- Values awaiting Ward's approval (plans/steps/S40-brief.md, Part 2).
create function private.home_copy_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'album_photos' then 200     -- photos one album copy may hold
    when 'open_requests' then 50     -- pending or running requests per person
    when 'homes' then 50             -- destination Homes in one request
    when 'copy_hours' then 6         -- a file copy that has not finished after this long failed
  end;
  $$;

create function private.home_copy_request_lifetime() returns interval
  language sql immutable set search_path = '' as $$ select interval '30 days' $$;

-- Personal categories that can be deleted here, in the order the app shows them (the personal
-- export's keys without 'account' and 'home_contributions').
create function private.personal_deletion_categories() returns text[]
  language sql immutable set search_path = '' as $$
  select array['calendar', 'tasks', 'recipes', 'shopping', 'meals', 'habits_goals', 'media']::text[];
  $$;

-- Re-authentication: one more action ---------------------------------------------------------------

alter table private.account_change_grants drop constraint account_change_grants_action_check;
alter table private.account_change_grants
  add constraint account_change_grants_action_check check (action in (
    'password', 'email', 'two_factor_enroll', 'two_factor_disable', 'recovery_codes',
    'backup_email', 'account_recovery_codes', 'security_report', 'deactivate_account',
    'data_export', 'delete_account', 'close_home', 'delete_personal_data'
  ));

-- As S40 part 1, with one more action: 'delete_personal_data'.
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
      'data_export', 'delete_account', 'close_home', 'delete_personal_data'
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

-- Audit subjects: one more ------------------------------------------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series', 'pet',
    'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity', 'pet_care_occurrence',
    'calendar_event', 'photo', 'photo_album', 'home_copy'
  ));

-- Origin label on Home copies -----------------------------------------------------------------------

-- When a Home-owned item was copied from someone's personal item. Nothing else is kept about the
-- source: no id, no person, no link (spec "Confirmed origin metadata for independent Home-owned
-- copies").
alter table private.recipes add column copied_from_personal_at timestamptz,
  add constraint recipes_copied_check check (copied_from_personal_at is null or owner_home_id is not null);
alter table private.calendar_events add column copied_from_personal_at timestamptz,
  add constraint calendar_events_copied_check check (copied_from_personal_at is null or home_id is not null);
alter table private.photo_albums add column copied_from_personal_at timestamptz,
  add constraint photo_albums_copied_check check (copied_from_personal_at is null or owner_home_id is not null);
alter table private.photos add column copied_from_personal_at timestamptz,
  add constraint photos_copied_check check (copied_from_personal_at is null or owner_home_id is not null);

-- ==================================================================================================
-- Part B tables first (Part A ends open copy requests of what it deletes)
-- ==================================================================================================

-- One row per item and destination Home. `source_id` is the personal item (no foreign key: three
-- tables; it is read only for its owner and the destination's approvers while the request is open).
create table private.home_copy_requests (
  id uuid primary key default gen_random_uuid(),
  -- One submission for several Homes shares a batch id (for "per-Home outcome" displays).
  batch_id uuid not null,
  requester_id uuid references auth.users (id) on delete set null,
  home_id uuid not null references public.homes (id) on delete cascade,
  item_type text not null constraint home_copy_requests_item_type_check
    check (item_type in ('recipe', 'calendar_event', 'photo_album')),
  source_id uuid not null,
  status text not null constraint home_copy_requests_status_check check (status in (
    'pending', 'copying', 'completed', 'rejected', 'cancelled', 'expired', 'invalidated', 'failed'
  )),
  -- No approval was needed (the requester could create that content in the Home).
  direct boolean not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  ended_at timestamptz,
  -- The Home item once completed (no foreign key; the Home may delete it later).
  copy_id uuid,
  -- Why it was invalidated or failed: a short code, never content.
  end_code text constraint home_copy_requests_end_code_check
    check (end_code is null or end_code ~ '^[a-z_]{1,40}$'),
  constraint home_copy_requests_open_check check (
    (status in ('pending', 'copying')) = (ended_at is null)),
  constraint home_copy_requests_copy_check check ((status = 'completed') = (copy_id is not null))
);

create unique index home_copy_requests_one_open_idx on private.home_copy_requests (item_type, source_id, home_id)
  where status in ('pending', 'copying');
create index home_copy_requests_requester_idx on private.home_copy_requests (requester_id, requested_at desc);
create index home_copy_requests_home_idx on private.home_copy_requests (home_id, requested_at)
  where status = 'pending';
create index home_copy_requests_open_idx on private.home_copy_requests (status, expires_at)
  where status in ('pending', 'copying');

-- The new Home files of a running copy: one per source file (a recipe cover, an album's photos).
create table private.home_copy_files (
  request_id uuid not null references private.home_copy_requests (id) on delete cascade,
  source_file_id uuid not null,
  dest_file_id uuid not null references private.stored_files (id) on delete cascade,
  -- Album copies: the personal photo it copies (its size, width and height).
  source_photo_id uuid,
  primary key (request_id, dest_file_id)
);

alter table private.home_copy_requests enable row level security;
alter table private.home_copy_files enable row level security;
revoke all on private.home_copy_requests, private.home_copy_files from public, anon, authenticated;

comment on table private.home_copy_requests is
  'S40 part 2: personal-to-Home copy requests, one per item and destination Home. Not exposed.';

-- ==================================================================================================
-- Part B helpers
-- ==================================================================================================

-- Whether p_user may create that kind of Home content in p_home now.
create function private.copy_can_create(p_item_type text, p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(case p_item_type
    when 'recipe' then private.has_home_capability(p_home_id, p_user_id, 'manageHomeRecipes')
    when 'calendar_event' then private.calendar_level_allows(private.calendar_level(p_home_id, p_user_id), 'edit')
    when 'photo_album' then private.photo_access(p_home_id, p_user_id) is not null
  end, false);
  $$;

-- Whether p_user may approve a copy of that kind into p_home now: the Owner, every Administrator,
-- and whoever may create that content there.
create function private.copy_can_approve(p_item_type text, p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(private.home_role(p_home_id, p_user_id) in ('owner', 'administrator'), false)
    or private.copy_can_create(p_item_type, p_home_id, p_user_id);
  $$;

-- Whether p_id is p_user's own personal item of that kind, not in the trash, that may be copied.
create function private.copy_item_eligible(p_item_type text, p_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and coalesce(case p_item_type
    when 'recipe' then exists (select 1 from private.recipes r
      where r.id = p_id and r.owner_user_id = p_user_id and r.deleted_at is null and r.status = 'published')
    when 'calendar_event' then exists (select 1 from private.calendar_events e
      where e.id = p_id and e.owner_user_id = p_user_id and e.deleted_at is null)
    when 'photo_album' then exists (select 1 from private.photo_albums a
      where a.id = p_id and a.owner_user_id = p_user_id and a.deleted_at is null)
  end, false);
  $$;

-- The item's title as its owner wrote it (shown to its owner and to the destination's approvers).
create function private.copy_item_label(p_item_type text, p_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case p_item_type
    when 'recipe' then (select r.name from private.recipes r where r.id = p_id and r.owner_user_id is not null)
    when 'calendar_event' then (select e.title from private.calendar_events e where e.id = p_id and e.owner_user_id is not null)
    when 'photo_album' then (select a.name from private.photo_albums a where a.id = p_id and a.owner_user_id is not null)
  end;
  $$;

-- The personal files a copy takes along: a recipe's cover, an album's photos that are the owner's own
-- (ready, not in the trash). Other people's photos in a shared album are never copied.
create function private.copy_item_files(p_item_type text, p_id uuid, p_user_id uuid)
returns table (file_id uuid, photo_id uuid, size_bytes bigint)
  language sql stable security definer set search_path = '' as $$
  select f.id, null::uuid, f.size_bytes
    from private.recipes r join private.stored_files f on f.id = r.cover_file_id
    where p_item_type = 'recipe' and r.id = p_id and r.owner_user_id = p_user_id and f.status = 'ready'
  union all
  select f.id, p.id, f.size_bytes
    from private.photo_album_items i
    join private.photos p on p.id = i.photo_id
    join private.stored_files f on f.id = p.file_id
    where p_item_type = 'photo_album' and i.album_id = p_id and p.owner_user_id = p_user_id
      and p.deleted_at is null and f.status = 'ready';
  $$;

-- Whether the item is shared with the Home now (its share ends once the copy exists).
create function private.copy_item_shared(p_item_type text, p_id uuid, p_home_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select coalesce(case p_item_type
    when 'recipe' then exists (select 1 from private.recipe_shares s where s.recipe_id = p_id and s.home_id = p_home_id)
    when 'calendar_event' then exists (select 1 from private.calendar_event_shares s where s.event_id = p_id and s.home_id = p_home_id)
    when 'photo_album' then exists (select 1 from private.photo_album_shares s where s.album_id = p_id and s.home_id = p_home_id)
  end, false);
  $$;

-- Ends an open request: removes the files a running copy had reserved (their objects are queued for
-- removal by the stored_files triggers) and records the status. Returns whether it was open.
create function private.end_home_copy(p_request_id uuid, p_status text, p_code text default null)
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

-- Ends every open request for the given personal items (they were deleted or moved to the trash).
create function private.end_home_copies_of(p_item_type text, p_ids uuid[], p_code text) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid;
    v_count integer := 0;
  begin
    for v_id in
      select r.id from private.home_copy_requests r
        where r.item_type = p_item_type and r.source_id = any (p_ids) and r.status in ('pending', 'copying')
        order by r.id
    loop
      if private.end_home_copy(v_id, 'invalidated', p_code) then
        v_count := v_count + 1;
      end if;
    end loop;
    return v_count;
  end
  $$;

-- Tells the requester how their request ended. A Home notice when they are still a member,
-- otherwise none (the Home notice would be invisible to them and the outcome concerns that Home).
create function private.notify_copy_requester(p_request private.home_copy_requests, p_kind text)
returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_request.requester_id is null then
      return;
    end if;
    perform private.notify_user(
      p_request.requester_id, p_request.home_id, 'approvals', p_kind,
      pg_catalog.jsonb_build_object('itemType', p_request.item_type, 'requestId', p_request.id),
      p_kind || ':' || p_request.id::text, false);
  end
  $$;

-- ==================================================================================================
-- Part A: category deletion
-- ==================================================================================================

create table private.personal_data_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The client's id for this request: the same id again returns the stored result.
  request_id uuid not null,
  categories text[] not null constraint personal_data_deletions_categories_check
    check (cardinality(categories) between 1 and 7 and categories <@ private.personal_deletion_categories()),
  status text not null default 'processing' constraint personal_data_deletions_status_check
    check (status in ('processing', 'completed', 'partial', 'failed')),
  -- Per category: {"outcome": "deleted" | "failed", "count": n}. Counts and codes only.
  results jsonb not null default '{}',
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint personal_data_deletions_request_key unique (user_id, request_id)
);

alter table private.personal_data_deletions enable row level security;
revoke all on private.personal_data_deletions from public, anon, authenticated;

-- Deletes the caller's files in p_ids for good (only files in their own personal pool): the
-- stored_files triggers queue their objects (and photo variants) for removal.
create function private.delete_personal_files(p_user_id uuid, p_ids uuid[]) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool private.storage_pools;
  begin
    if p_ids is null or cardinality(p_ids) = 0 then
      return;
    end if;
    v_pool := private.lock_storage_pool(p_user_id, null);
    delete from private.stored_files f where f.id = any (p_ids) and f.pool_id = v_pool.id;
    perform private.storage_reassess(v_pool.id);
  end
  $$;

-- Deletes one category of p_user_id's personal data for good. Returns how many top-level items
-- went (lists, tasks, recipes, events, ...). Home-owned records are never touched: every statement
-- selects on the personal owner column.
create function private.delete_personal_category(p_user_id uuid, p_category text) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_count integer := 0;
    v_n integer;
    v_ids uuid[];
    v_files uuid[];
  begin
    if p_category = 'calendar' then
      select coalesce(pg_catalog.array_agg(e.id), '{}') into v_ids
        from private.calendar_events e where e.owner_user_id = p_user_id;
      perform private.end_home_copies_of('calendar_event', v_ids, 'item_deleted');
      delete from private.trash_entries t where t.owner_user_id = p_user_id and t.module = 'calendar';
      delete from private.calendar_events e where e.owner_user_id = p_user_id;
      get diagnostics v_count = row_count;

    elsif p_category = 'tasks' then
      select coalesce(pg_catalog.array_agg(distinct x.file_id), '{}') into v_files from (
        select a.file_id from private.task_attachments a
          join private.tasks t on t.id = a.task_id where t.owner_user_id = p_user_id
        union all
        select a.file_id from private.task_series_attachments a where a.owner_user_id = p_user_id
      ) x;
      delete from private.trash_entries t where t.owner_user_id = p_user_id and t.module = 'tasks';
      delete from private.tasks t where t.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.task_series s where s.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.task_series_attachments a where a.owner_user_id = p_user_id;
      delete from private.task_series_removals r where r.owner_user_id = p_user_id;
      delete from private.task_lists l where l.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.task_templates x where x.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.task_labels x where x.owner_user_id = p_user_id;
      perform private.delete_personal_files(p_user_id, v_files);

    elsif p_category = 'recipes' then
      select coalesce(pg_catalog.array_agg(r.id), '{}'),
             coalesce(pg_catalog.array_agg(r.cover_file_id) filter (where r.cover_file_id is not null), '{}')
        into v_ids, v_files
        from private.recipes r where r.owner_user_id = p_user_id;
      perform private.end_home_copies_of('recipe', v_ids, 'item_deleted');
      delete from private.trash_entries t where t.owner_user_id = p_user_id and t.module = 'recipes';
      delete from private.recipes r where r.owner_user_id = p_user_id;
      get diagnostics v_count = row_count;
      perform private.delete_personal_files(p_user_id, v_files);

    elsif p_category = 'shopping' then
      delete from private.trash_entries t where t.owner_user_id = p_user_id and t.module = 'shopping';
      delete from private.shopping_lists l where l.owner_user_id = p_user_id;
      get diagnostics v_count = row_count;

    elsif p_category = 'meals' then
      delete from private.trash_entries t where t.owner_user_id = p_user_id and t.module = 'meals';
      delete from private.meal_entries e where e.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.meal_series s where s.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.meal_shopping_transfers x where x.owner_user_id = p_user_id;
      delete from private.meal_slots s where s.owner_user_id = p_user_id;

    elsif p_category = 'habits_goals' then
      delete from private.trash_entries t
        where t.owner_user_id = p_user_id and t.module in ('habits', 'goals');
      delete from private.goals g where g.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.goal_series s where s.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.habits h where h.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.personal_reward_redemption_events x where x.user_id = p_user_id;
      delete from private.personal_reward_redemptions x where x.user_id = p_user_id;
      delete from private.personal_rewards x where x.user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.personal_point_entries x where x.user_id = p_user_id;
      delete from private.personal_point_accounts x where x.user_id = p_user_id;

    elsif p_category = 'media' then
      select coalesce(pg_catalog.array_agg(a.id), '{}') into v_ids
        from private.photo_albums a where a.owner_user_id = p_user_id;
      perform private.end_home_copies_of('photo_album', v_ids, 'item_deleted');
      select coalesce(pg_catalog.array_agg(p.file_id), '{}') into v_files
        from private.photos p where p.owner_user_id = p_user_id;
      delete from private.trash_entries t where t.owner_user_id = p_user_id and t.module = 'photos';
      delete from private.photo_albums a where a.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      delete from private.photos p where p.owner_user_id = p_user_id;
      get diagnostics v_n = row_count;
      v_count := v_count + v_n;
      perform private.delete_personal_files(p_user_id, v_files);

    else
      raise exception 'unknown category' using errcode = '22023';
    end if;
    return v_count;
  end
  $$;

revoke all on function private.delete_personal_category(uuid, text) from public;

-- What deleting the chosen categories affects, for the caller's preview: per category the items
-- (with those in the trash), how many are shared into the caller's Homes, their files, the open
-- copy requests that end, and the personal exports in preparation or ready that become unavailable
-- (a queued export has collected nothing yet and will reflect the deletion). Counts only.
create function public.personal_deletion_preview(p_categories text[]) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_category text;
    v_out jsonb := '{}';
    v_items bigint;
    v_trash bigint;
    v_shared bigint;
    v_files bigint;
  begin
    if p_categories is null or cardinality(p_categories) = 0
       or not (p_categories <@ private.personal_deletion_categories()) then
      raise exception 'invalid categories' using errcode = '22023';
    end if;
    foreach v_category in array private.personal_deletion_categories() loop
      continue when not (v_category = any (p_categories));
      v_shared := 0;
      v_files := 0;
      if v_category = 'calendar' then
        select count(*), count(*) filter (where e.deleted_at is not null),
               count(*) filter (where exists (select 1 from private.calendar_event_shares s where s.event_id = e.id))
          into v_items, v_trash, v_shared
          from private.calendar_events e where e.owner_user_id = v_user_id;
      elsif v_category = 'tasks' then
        select count(*), count(*) filter (where t.deleted_at is not null) into v_items, v_trash
          from private.tasks t where t.owner_user_id = v_user_id;
        select v_items + count(*) into v_items from private.task_series s
          where s.owner_user_id = v_user_id and s.superseded_at is null;
        select count(*) into v_files from private.task_attachments a
          join private.tasks t on t.id = a.task_id where t.owner_user_id = v_user_id;
      elsif v_category = 'recipes' then
        select count(*), count(*) filter (where r.deleted_at is not null),
               count(*) filter (where exists (select 1 from private.recipe_shares s where s.recipe_id = r.id)),
               count(r.cover_file_id)
          into v_items, v_trash, v_shared, v_files
          from private.recipes r where r.owner_user_id = v_user_id;
      elsif v_category = 'shopping' then
        select count(*), count(*) filter (where l.deleted_at is not null) into v_items, v_trash
          from private.shopping_lists l where l.owner_user_id = v_user_id;
      elsif v_category = 'meals' then
        select count(*), count(*) filter (where e.deleted_at is not null) into v_items, v_trash
          from private.meal_entries e where e.owner_user_id = v_user_id;
        select v_items + count(*) into v_items from private.meal_series s where s.owner_user_id = v_user_id;
      elsif v_category = 'habits_goals' then
        select count(*), count(*) filter (where h.deleted_at is not null) into v_items, v_trash
          from private.habits h where h.owner_user_id = v_user_id;
        select v_items + count(*), v_trash + count(*) filter (where g.deleted_at is not null)
          into v_items, v_trash from private.goals g where g.owner_user_id = v_user_id;
        select v_items + count(*) into v_items from private.personal_rewards x where x.user_id = v_user_id;
      elsif v_category = 'media' then
        select count(*), count(*) filter (where p.deleted_at is not null) into v_items, v_trash
          from private.photos p where p.owner_user_id = v_user_id;
        v_files := v_items;
        select v_items + count(*), v_trash + count(*) filter (where a.deleted_at is not null),
               count(*) filter (where exists (select 1 from private.photo_album_shares s where s.album_id = a.id))
          into v_items, v_trash, v_shared
          from private.photo_albums a where a.owner_user_id = v_user_id;
      end if;
      v_out := v_out || pg_catalog.jsonb_build_object(v_category, pg_catalog.jsonb_build_object(
        'items', v_items, 'inTrash', v_trash, 'shared', v_shared, 'files', v_files,
        'openCopies', (select count(*) from private.home_copy_requests r
          where r.requester_id = v_user_id and r.status in ('pending', 'copying')
            and r.item_type = case v_category when 'recipes' then 'recipe'
              when 'calendar' then 'calendar_event' when 'media' then 'photo_album' end)));
    end loop;
    return pg_catalog.jsonb_build_object(
      'categories', v_out,
      'openExports', (select count(*) from private.data_exports e
        where e.requester_id = v_user_id and e.kind = 'personal'
          and e.status in ('preparing', 'ready')));
  end
  $$;

-- Deletes the chosen categories of the caller's personal data for good. Needs a fresh
-- 'delete_personal_data' re-authentication from this session. p_request_id makes it idempotent:
-- the same id again returns the stored result without deleting anything (or asking for a new
-- re-authentication). Concurrent requests of one person run one after the other. Each category
-- runs in its own sub-transaction: a failure is reported for that category and the others stand.
-- Returns {"status", "results": {category: {"outcome", "count"}}}.
create function public.delete_personal_data(p_request_id uuid, p_categories text[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_session_id uuid := private.jwt_session_id();
    v_row private.personal_data_deletions;
    v_categories text[];
    v_category text;
    v_count integer;
    v_results jsonb := '{}';
    v_ok integer := 0;
    v_failed integer := 0;
    v_status text;
  begin
    if not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_request_id is null or p_categories is null or cardinality(p_categories) = 0
       or not (p_categories <@ private.personal_deletion_categories()) then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- The app's order, without repeats.
    select pg_catalog.array_agg(c order by o) into v_categories
      from pg_catalog.unnest(private.personal_deletion_categories()) with ordinality as x(c, o)
      where c = any (p_categories);

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('personal-deletion:' || v_user_id::text, 0));
    select * into v_row from private.personal_data_deletions d
      where d.user_id = v_user_id and d.request_id = p_request_id;
    if found then
      if v_row.categories <> v_categories then
        raise exception 'request id reused' using errcode = '22023';
      end if;
      return pg_catalog.jsonb_build_object('status', v_row.status, 'results', v_row.results);
    end if;
    if not private.consume_account_change_grant(v_user_id, 'delete_personal_data', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;

    insert into private.personal_data_deletions (user_id, request_id, categories)
      values (v_user_id, p_request_id, v_categories) returning * into v_row;
    foreach v_category in array v_categories loop
      begin
        v_count := private.delete_personal_category(v_user_id, v_category);
        v_results := v_results || pg_catalog.jsonb_build_object(v_category,
          pg_catalog.jsonb_build_object('outcome', 'deleted', 'count', v_count));
        v_ok := v_ok + 1;
      exception when others then
        -- The category is left as it was; only the sqlstate is logged.
        raise warning 'delete_personal_data: category failed (sqlstate %)', sqlstate;
        v_results := v_results || pg_catalog.jsonb_build_object(v_category,
          pg_catalog.jsonb_build_object('outcome', 'failed', 'count', 0));
        v_failed := v_failed + 1;
      end;
    end loop;
    v_status := case when v_failed = 0 then 'completed' when v_ok = 0 then 'failed' else 'partial' end;
    update private.personal_data_deletions d
      set status = v_status, results = v_results, finished_at = pg_catalog.now()
      where d.id = v_row.id;
    perform private.record_account_activity(
      v_user_id, 'privacy', 'personal_data_deleted',
      case when v_status = 'completed' then 'completed' else 'failed' end,
      null, 'self', pg_catalog.jsonb_build_object('categories', pg_catalog.to_jsonb(v_categories)));
    return pg_catalog.jsonb_build_object('status', v_status, 'results', v_results);
  end
  $$;

-- ==================================================================================================
-- Part B: making a copy
-- ==================================================================================================

-- Creates the Home item from the personal source and finishes the request. Everything is checked
-- again first; any check that fails ends the request (invalidated, or failed for a full Home).
-- Files must already be in place (pending Home files whose objects were copied), or none needed.
-- Returns the end status: 'completed', 'invalidated' or 'failed'.
create function private.commit_home_copy(p_request_id uuid) returns text
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
        from private.calendar_event_exceptions x where x.event_id = v_req.source_id;
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

-- Starts making the copy of an approved (or direct) request: without files it is made at once;
-- with files the Home's space is reserved, pending Home files are created with new keys and the
-- home-copy-files job is queued. Returns 'completed', 'copying', 'failed' or 'invalidated'.
create function private.start_home_copy(p_request_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_req private.home_copy_requests;
    v_pool private.storage_pools;
    v_need bigint;
    v_count integer;
    v_used record;
    v_file record;
    v_dest uuid;
  begin
    select * into v_req from private.home_copy_requests r where r.id = p_request_id for update;
    if not found or v_req.status <> 'pending' then
      return 'invalidated';
    end if;
    select count(*), coalesce(sum(f.size_bytes), 0) into v_count, v_need
      from private.copy_item_files(v_req.item_type, v_req.source_id, v_req.requester_id) f;
    if v_count = 0 then
      return private.commit_home_copy(v_req.id);
    end if;
    if v_req.item_type = 'photo_album' and v_count > private.home_copy_limit('album_photos') then
      perform private.end_home_copy(v_req.id, 'failed', 'too_many_photos');
      return 'failed';
    end if;

    v_pool := private.lock_storage_pool(null, v_req.home_id);
    select * into v_used from private.storage_usage(v_pool.id);
    if v_used.ready_bytes + v_used.deleted_bytes + v_used.reserved_bytes + v_need
       > private.storage_allowance(v_pool) then
      perform private.end_home_copy(v_req.id, 'failed', 'storage_full');
      return 'failed';
    end if;

    for v_file in
      select f.file_id, f.photo_id, s.purpose, s.content_type, s.size_bytes
        from private.copy_item_files(v_req.item_type, v_req.source_id, v_req.requester_id) f
        join private.stored_files s on s.id = f.file_id
        order by f.file_id
    loop
      insert into private.stored_files (
        pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
        declared_size, status, expires_at)
      values (
        v_pool.id, v_file.purpose, v_req.requester_id, pg_catalog.gen_random_uuid(),
        private.new_object_key('h'), private.new_object_key('h'), v_file.content_type,
        v_file.size_bytes, 'pending',
        pg_catalog.now() + pg_catalog.make_interval(hours => private.home_copy_limit('copy_hours')))
      returning id into v_dest;
      insert into private.photo_variants (file_id, kind, object_key)
        select v_dest, v.kind, private.new_object_key('h')
          from private.photo_variants v where v.file_id = v_file.file_id;
      insert into private.home_copy_files (request_id, source_file_id, dest_file_id, source_photo_id)
        values (v_req.id, v_file.file_id, v_dest, v_file.photo_id);
    end loop;
    perform private.storage_reassess(v_pool.id);

    update private.home_copy_requests r set status = 'copying' where r.id = v_req.id;
    perform private.enqueue_job('home-copy-files', 1, 'home-copy-files:' || v_req.id::text,
      pg_catalog.jsonb_build_object('requestId', v_req.id));
    return 'copying';
  end
  $$;

-- The Homes the caller could copy one of their items into, with how (direct or by approval) and
-- whether a request is already open there or the item is shared there now. 42501 for an item that
-- is not the caller's own eligible item (the same as a missing one).
create function public.list_copy_destinations(p_item_type text, p_item_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_item_type is null or p_item_type not in ('recipe', 'calendar_event', 'photo_album') then
      raise exception 'invalid item type' using errcode = '22023';
    end if;
    if not private.copy_item_eligible(p_item_type, p_item_id, v_user_id) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    return pg_catalog.jsonb_build_object(
      'label', private.copy_item_label(p_item_type, p_item_id),
      'files', (select count(*) from private.copy_item_files(p_item_type, p_item_id, v_user_id)),
      'homes', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'homeId', h.id, 'name', h.name,
          'mode', case when private.copy_can_create(p_item_type, h.id, v_user_id) then 'direct' else 'approval' end,
          'shared', private.copy_item_shared(p_item_type, p_item_id, h.id),
          'open', exists (select 1 from private.home_copy_requests r
            where r.item_type = p_item_type and r.source_id = p_item_id and r.home_id = h.id
              and r.status in ('pending', 'copying')))
          order by h.name, h.id), '[]')
        from public.home_memberships m join public.homes h on h.id = m.home_id
        where m.user_id = v_user_id));
  end
  $$;

-- Asks for independent copies of one of the caller's personal items in the chosen Homes. Each Home
-- is decided on its own: 'completed' (made now), 'copying' (files being copied), 'pending' (waits
-- for that Home's approval; approvers are notified), 'already_open', 'not_member', 'failed' (with a
-- code). Returns {"batchId", "homes": [{homeId, outcome, requestId?, code?}]}.
create function public.request_home_copies(p_item_type text, p_item_id uuid, p_home_ids uuid[]) returns jsonb
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
    for v_home in select distinct x.id from pg_catalog.unnest(p_home_ids) x(id) order by x.id loop
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

-- Approves or rejects one pending request: an approver of that Home now (the requester too when
-- they are one: self-approval). Everything is checked again; an expired request becomes 'expired',
-- one that no longer holds 'invalidated'. Outcomes: 'completed', 'copying', 'rejected', 'expired',
-- 'invalidated', 'failed', 'not_pending'. P0002 for a request the caller may not decide.
create function public.decide_home_copy(p_request_id uuid, p_approve boolean) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_req private.home_copy_requests;
    v_outcome text;
  begin
    if p_approve is null then
      raise exception 'invalid decision' using errcode = '22023';
    end if;
    select * into v_req from private.home_copy_requests r where r.id = p_request_id;
    if not found or not private.copy_can_approve(v_req.item_type, v_req.home_id, v_user_id) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    perform private.lock_home(v_req.home_id);
    select * into v_req from private.home_copy_requests r where r.id = p_request_id for update;
    if v_req.status <> 'pending' then
      return 'not_pending';
    end if;
    if not private.copy_can_approve(v_req.item_type, v_req.home_id, v_user_id) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if v_req.expires_at <= pg_catalog.now() then
      perform private.end_home_copy(v_req.id, 'expired');
      return 'expired';
    end if;
    if v_req.requester_id is null or private.home_role(v_req.home_id, v_req.requester_id) is null then
      perform private.end_home_copy(v_req.id, 'invalidated', 'not_member');
      return 'invalidated';
    end if;
    if not private.copy_item_eligible(v_req.item_type, v_req.source_id, v_req.requester_id) then
      perform private.end_home_copy(v_req.id, 'invalidated', 'item_unavailable');
      return 'invalidated';
    end if;

    update private.home_copy_requests r
      set decided_by = v_user_id, decided_at = pg_catalog.now()
      where r.id = v_req.id
      returning * into v_req;
    if not p_approve then
      perform private.end_home_copy(v_req.id, 'rejected');
      perform private.audit('copy_request.rejected', v_req.home_id, 'home_copy', v_req.id,
        pg_catalog.jsonb_build_object('itemType', v_req.item_type));
      select * into v_req from private.home_copy_requests r where r.id = v_req.id;
      perform private.notify_copy_requester(v_req, 'home_copy.rejected');
      return 'rejected';
    end if;
    perform private.audit('copy_request.approved', v_req.home_id, 'home_copy', v_req.id,
      pg_catalog.jsonb_build_object('itemType', v_req.item_type,
        'selfApproved', v_req.decided_by = v_req.requester_id));
    v_outcome := private.start_home_copy(v_req.id);
    select * into v_req from private.home_copy_requests r where r.id = v_req.id;
    if v_req.requester_id <> v_user_id then
      perform private.notify_copy_requester(v_req, case v_outcome
        when 'completed' then 'home_copy.completed'
        when 'copying' then 'home_copy.approved'
        else 'home_copy.failed' end);
    end if;
    return v_outcome;
  end
  $$;

-- Cancels one of the caller's own pending requests. Returns whether it was pending.
create function public.cancel_home_copy(p_request_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_req private.home_copy_requests;
  begin
    select * into v_req from private.home_copy_requests r
      where r.id = p_request_id and r.requester_id = v_user_id for update;
    if not found then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if v_req.status <> 'pending' then
      return false;
    end if;
    return private.end_home_copy(v_req.id, 'cancelled');
  end
  $$;

-- Cancels every pending request of the caller (before account deletion). Running copies are left
-- to finish. No one else is told. Returns how many were cancelled.
create function public.cancel_my_pending_home_copies() returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
    v_count integer := 0;
  begin
    for v_id in
      select r.id from private.home_copy_requests r
        where r.requester_id = v_user_id and r.status = 'pending' order by r.id for update
    loop
      if private.end_home_copy(v_id, 'cancelled') then
        v_count := v_count + 1;
      end if;
    end loop;
    return v_count;
  end
  $$;

-- The caller's own requests (open ones first, then the last 90 days), with the item's title while it
-- still exists and is theirs, and the Home's name.
create function public.list_my_home_copies() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'batchId', r.batch_id, 'homeId', r.home_id, 'homeName', h.name,
      'itemType', r.item_type, 'itemId', r.source_id,
      'label', case when private.copy_item_eligible(r.item_type, r.source_id, r.requester_id)
                    then private.copy_item_label(r.item_type, r.source_id) end,
      'status', r.status, 'direct', r.direct, 'requestedAt', r.requested_at,
      'expiresAt', r.expires_at, 'endedAt', r.ended_at, 'code', r.end_code,
      'selfApproved', r.decided_by is not null and r.decided_by = r.requester_id)
      order by (r.status in ('pending', 'copying')) desc, r.requested_at desc, r.id), '[]')
  from private.home_copy_requests r
  join public.homes h on h.id = r.home_id
  where r.requester_id = private.require_confirmed_caller()
    and (r.status in ('pending', 'copying') or r.requested_at > pg_catalog.now() - interval '90 days');
  $$;

-- A Home's pending requests for one of its approvers, with what is asked: the item's kind, title and
-- photo count, and who asked (their name in this Home). Requests that no longer hold are left out
-- (and end on the next decision or sweep). 42501 for anyone who approves nothing there (the same as
-- for a Home they are not in).
create function public.list_home_copy_requests(p_home_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if private.home_role(p_home_id, v_user_id) is null then
      raise exception 'not a member' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object(
      'canApprove', private.home_role(p_home_id, v_user_id) in ('owner', 'administrator')
        or private.copy_can_create('recipe', p_home_id, v_user_id)
        or private.copy_can_create('calendar_event', p_home_id, v_user_id)
        or private.copy_can_create('photo_album', p_home_id, v_user_id),
      'requests', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', r.id, 'itemType', r.item_type,
          'label', private.copy_item_label(r.item_type, r.source_id),
          'files', (select count(*) from private.copy_item_files(r.item_type, r.source_id, r.requester_id)),
          'requester', (select coalesce(hp.nickname, hp.display_name, up.display_name, '')
                          from public.home_memberships m
                          left join public.home_member_profiles hp on hp.home_id = m.home_id and hp.user_id = m.user_id
                          left join public.user_preferences up on up.user_id = m.user_id
                          where m.home_id = r.home_id and m.user_id = r.requester_id),
          'isMine', r.requester_id = v_user_id,
          'requestedAt', r.requested_at, 'expiresAt', r.expires_at)
          order by r.requested_at, r.id), '[]')
        from private.home_copy_requests r
        where r.home_id = p_home_id and r.status = 'pending' and r.expires_at > pg_catalog.now()
          and private.copy_can_approve(r.item_type, r.home_id, v_user_id)
          and private.home_role(r.home_id, r.requester_id) is not null
          and private.copy_item_eligible(r.item_type, r.source_id, r.requester_id)));
  end
  $$;

-- When a Home item the caller can see was copied from a personal item: the date, or null. Never the
-- source or who copied it.
create function public.get_copy_origin(p_item_type text, p_item_id uuid) returns timestamptz
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_home uuid;
    v_at timestamptz;
  begin
    if p_item_type = 'recipe' then
      select r.owner_home_id, r.copied_from_personal_at into v_home, v_at
        from private.recipes r where r.id = p_item_id and r.deleted_at is null;
    elsif p_item_type = 'calendar_event' then
      select e.home_id, e.copied_from_personal_at into v_home, v_at
        from private.calendar_events e where e.id = p_item_id and e.deleted_at is null;
    elsif p_item_type = 'photo_album' then
      select a.owner_home_id, a.copied_from_personal_at into v_home, v_at
        from private.photo_albums a where a.id = p_item_id and a.deleted_at is null;
    elsif p_item_type = 'photo' then
      select p.owner_home_id, p.copied_from_personal_at into v_home, v_at
        from private.photos p where p.id = p_item_id and p.deleted_at is null;
    else
      raise exception 'invalid item type' using errcode = '22023';
    end if;
    if v_home is null or private.home_role(v_home, v_user_id) is null then
      return null;
    end if;
    return v_at;
  end
  $$;

-- The job (service role) -----------------------------------------------------------------------------

-- The objects one running copy must copy inside the bucket: the files' own objects and, for photos,
-- their variants, each with the size the copy must have. 'skip' when the request is not copying.
create function public.begin_home_copy_files(p_request_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  begin
    if not exists (select 1 from private.home_copy_requests r
                   where r.id = p_request_id and r.status = 'copying') then
      return pg_catalog.jsonb_build_object('outcome', 'skip');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ok', 'objects', (
      select coalesce(pg_catalog.jsonb_agg(o order by o ->> 'to'), '[]') from (
        select pg_catalog.jsonb_build_object('from', s.object_key, 'to', d.object_key, 'size', s.size_bytes) o
          from private.home_copy_files c
          join private.stored_files s on s.id = c.source_file_id
          join private.stored_files d on d.id = c.dest_file_id
          where c.request_id = p_request_id
        union all
        select pg_catalog.jsonb_build_object('from', sv.object_key, 'to', dv.object_key, 'size', sv.size_bytes)
          from private.home_copy_files c
          join private.photo_variants sv on sv.file_id = c.source_file_id
          join private.photo_variants dv on dv.file_id = c.dest_file_id and dv.kind = sv.kind
          where c.request_id = p_request_id
      ) x));
  end
  $$;

-- Records the job's result: the objects are in place (the copy is made now, after every check) or
-- the copy failed with a short code. Returns 'completed', 'failed', 'invalidated' or 'discarded'
-- (the request had already ended; its files were removed with it).
create function public.finish_home_copy_files(p_request_id uuid, p_ok boolean, p_code text default null)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_req private.home_copy_requests;
    v_outcome text;
  begin
    if p_ok is null or (not p_ok and (p_code is null or p_code !~ '^[a-z_]{1,40}$')) then
      raise exception 'invalid result' using errcode = '22023';
    end if;
    select * into v_req from private.home_copy_requests r where r.id = p_request_id;
    if not found then
      return 'discarded';
    end if;
    perform private.lock_home(v_req.home_id);
    select * into v_req from private.home_copy_requests r where r.id = p_request_id for update;
    if v_req.status <> 'copying' then
      return 'discarded';
    end if;
    if p_ok then
      v_outcome := private.commit_home_copy(v_req.id);
    else
      perform private.end_home_copy(v_req.id, 'failed', p_code);
      v_outcome := 'failed';
    end if;
    select * into v_req from private.home_copy_requests r where r.id = v_req.id;
    perform private.notify_copy_requester(v_req,
      case when v_outcome = 'completed' then 'home_copy.completed' else 'home_copy.failed' end);
    return v_outcome;
  end
  $$;

-- Hourly (service role): pending requests past their 30 days expire; copies running for longer than
-- the copy limit fail (their job died; the requester is told); open requests into a Home pending deletion or whose
-- requester left end. Returns how many ended.
create function public.sweep_home_copies(p_limit integer default 200) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_req private.home_copy_requests;
    v_count integer := 0;
  begin
    for v_req in
      select * from private.home_copy_requests r
        where r.status in ('pending', 'copying')
          and ((r.status = 'pending' and r.expires_at <= pg_catalog.now())
            or (r.status = 'copying' and coalesce(r.decided_at, r.requested_at) <= pg_catalog.now()
                  - pg_catalog.make_interval(hours => private.home_copy_limit('copy_hours')))
            or r.requester_id is null
            or private.home_role(r.home_id, r.requester_id) is null)
        order by r.expires_at
        limit greatest(coalesce(p_limit, 200), 1)
    loop
      if v_req.status = 'pending' and v_req.expires_at <= pg_catalog.now() then
        perform private.end_home_copy(v_req.id, 'expired');
      elsif v_req.status = 'copying' and coalesce(v_req.decided_at, v_req.requested_at) <= pg_catalog.now()
                  - pg_catalog.make_interval(hours => private.home_copy_limit('copy_hours'))
            and v_req.requester_id is not null
            and private.home_role(v_req.home_id, v_req.requester_id) is not null then
        perform private.end_home_copy(v_req.id, 'failed', 'copy_timeout');
        perform private.notify_copy_requester(v_req, 'home_copy.failed');
      else
        perform private.end_home_copy(v_req.id, 'invalidated', 'not_member');
      end if;
      v_count := v_count + 1;
    end loop;
    return v_count;
  end
  $$;

-- Triggers: requests end with the requester's membership and with the item --------------------------

create function private.end_home_copies_on_membership_end() returns trigger
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    for v_id in
      select r.id from private.home_copy_requests r
        where r.home_id = old.home_id and r.requester_id = old.user_id
          and r.status in ('pending', 'copying')
        order by r.id
    loop
      perform private.end_home_copy(v_id, 'invalidated', 'not_member');
    end loop;
    return null;
  end
  $$;

create trigger home_memberships_end_home_copies
  after delete on private.home_memberships_all
  for each row execute function private.end_home_copies_on_membership_end();

-- A personal item that goes to the trash or is deleted ends its open requests.
create function private.end_home_copies_on_item_change() returns trigger
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if old.owner_user_id is null then
      return null;
    end if;
    if tg_op = 'UPDATE' and not (old.deleted_at is null and new.deleted_at is not null) then
      return null;
    end if;
    perform private.end_home_copies_of(tg_argv[0], array[old.id],
      case when tg_op = 'DELETE' then 'item_deleted' else 'item_trashed' end);
    return null;
  end
  $$;

create trigger recipes_end_home_copies after update of deleted_at or delete on private.recipes
  for each row execute function private.end_home_copies_on_item_change('recipe');
create trigger calendar_events_end_home_copies after update of deleted_at or delete on private.calendar_events
  for each row execute function private.end_home_copies_on_item_change('calendar_event');
create trigger photo_albums_end_home_copies after update of deleted_at or delete on private.photo_albums
  for each row execute function private.end_home_copies_on_item_change('photo_album');

-- Account deletion: pending requests must be cancelled first ----------------------------------------

-- The caller's open requests, for the Delete account page: every pending or running one, with the
-- item's title and the Home's name.
create function public.my_open_home_copies() returns jsonb
  language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'homeId', r.home_id, 'homeName', h.name, 'itemType', r.item_type,
      'label', private.copy_item_label(r.item_type, r.source_id), 'status', r.status,
      'expiresAt', r.expires_at) order by r.requested_at, r.id), '[]')
  from private.home_copy_requests r join public.homes h on h.id = r.home_id
  where r.requester_id = private.require_confirmed_caller() and r.status in ('pending', 'copying');
  $$;

-- The caller's own eligible personal items that are shared with a Home now, each with those Homes,
-- for the Delete account page ("keep shared items in a Home": each item is copied on its own, to the
-- Homes the person picks). Only Homes the caller is a member of are named.
create function public.my_shared_copyable_items() returns jsonb
  language sql stable security definer set search_path = '' as $$
  with me as (select private.require_confirmed_caller() as id),
  shared as (
    select 'recipe'::text as item_type, r.id, r.name as label, s.home_id
      from private.recipe_shares s join private.recipes r on r.id = s.recipe_id, me
      where r.owner_user_id = me.id
    union all
    select 'calendar_event', e.id, e.title, s.home_id
      from private.calendar_event_shares s join private.calendar_events e on e.id = s.event_id, me
      where e.owner_user_id = me.id
    union all
    select 'photo_album', a.id, a.name, s.home_id
      from private.photo_album_shares s join private.photo_albums a on a.id = s.album_id, me
      where a.owner_user_id = me.id
  ),
  eligible as (
    select sh.item_type, sh.id, sh.label, h.name as home_name
      from shared sh join public.homes h on h.id = sh.home_id, me
      where private.home_role(sh.home_id, me.id) is not null
        and private.copy_item_eligible(sh.item_type, sh.id, me.id)
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'itemType', g.item_type, 'itemId', g.id, 'label', g.label, 'homes', g.homes)
      order by g.item_type, g.label, g.id), '[]')
  from (select e.item_type, e.id, e.label,
               pg_catalog.jsonb_agg(e.home_name order by e.home_name) as homes
          from eligible e group by e.item_type, e.id, e.label) g;
  $$;

-- As S40 part 1, and refused while the caller has a pending copy request ('pending_copies': the
-- person must cancel them explicitly first) or a copy is still being made ('copies_running').
create or replace function public.request_account_deletion() returns timestamptz
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
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('home-copies:' || v_user_id::text, 0));
    if exists (select 1 from private.home_copy_requests r
               where r.requester_id = v_user_id and r.status = 'pending') then
      raise exception 'pending copies' using errcode = 'P0001', hint = 'pending_copies';
    end if;
    if exists (select 1 from private.home_copy_requests r
               where r.requester_id = v_user_id and r.status = 'copying') then
      raise exception 'copies running' using errcode = 'P0001', hint = 'copies_running';
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

-- Grants -----------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.authorize_account_change(text, uuid)',
    'public.personal_deletion_preview(text[])',
    'public.delete_personal_data(uuid, text[])',
    'public.list_copy_destinations(text, uuid)',
    'public.request_home_copies(text, uuid, uuid[])',
    'public.decide_home_copy(uuid, boolean)',
    'public.cancel_home_copy(uuid)',
    'public.cancel_my_pending_home_copies()',
    'public.list_my_home_copies()',
    'public.list_home_copy_requests(uuid)',
    'public.get_copy_origin(text, uuid)',
    'public.my_open_home_copies()',
    'public.my_shared_copyable_items()',
    'public.request_account_deletion()'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;
  foreach v_function in array array[
    'public.begin_home_copy_files(uuid)',
    'public.finish_home_copy_files(uuid, boolean, text)',
    'public.sweep_home_copies(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end
$$;
