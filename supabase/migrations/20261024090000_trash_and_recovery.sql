-- S16: trash and recovery (architecture.md §36; spec "Confirmed central personal and Home trash
-- organization", "Confirmed deletion and recovery of parent items with attachments", "Confirmed
-- meaningful conflict handling on item restoration", "Confirmed individual and selected-item bulk
-- restoration", "Confirmed early permanent deletion from file trash", "Confirmed recovery period for
-- individually deleted items").
--
-- A deleted item becomes a trash entry: it stays recoverable for 7 days (the same setting as deleted
-- files), then a job purges it. Exclusively attached files go to the file trash with it: still
-- counted against the quota, restored together, released when purged. Personal and Home trash are
-- separate scopes. Restoring is per item and never overwrites active data.
--
-- Nothing here is exposed as a table. The sample record type at the end is the worked example that
-- real modules (tasks in S18, recipes in S24, ...) copy: they add a case to the three dispatch
-- functions and call private.trash_move from their own delete function.

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry'
  ));

-- Entries ---------------------------------------------------------------------------------------------

create table private.trash_entries (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  -- Which module and record type, so the list can filter and the hooks know what to do. Each module
  -- step extends these two lists.
  module text not null constraint trash_entries_module_check check (module in ('sample')),
  item_type text not null constraint trash_entries_item_type_check check (item_type in ('sample')),
  subject_id uuid not null,
  -- What the list shows (a title). Cleared once the entry is restored or purged.
  label text constraint trash_entries_label_check check (char_length(label) <= 200),
  deleted_by uuid references auth.users (id) on delete set null,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'trashed'
    constraint trash_entries_status_check check (status in ('trashed', 'restored', 'purged')),
  settled_at timestamptz,
  constraint trash_entries_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint trash_entries_window check (expires_at > deleted_at),
  constraint trash_entries_settled check ((status = 'trashed') = (settled_at is null))
);

-- One open entry per item, so two deletes at once or a repeated delete make one entry.
create unique index trash_entries_one_open_idx on private.trash_entries (item_type, subject_id)
  where status = 'trashed';
create index trash_entries_user_idx on private.trash_entries (owner_user_id, deleted_at desc)
  where status = 'trashed';
create index trash_entries_home_idx on private.trash_entries (owner_home_id, deleted_at desc)
  where status = 'trashed';

comment on table private.trash_entries is
  'S16: deleted items awaiting restore or purge, personal or per Home. Not exposed through the API.';

-- The files that went to the file trash together with an entry, so a restore knows which to bring back.
create table private.trash_entry_files (
  entry_id uuid not null references private.trash_entries (id) on delete cascade,
  file_id uuid not null references private.stored_files (id) on delete cascade,
  primary key (entry_id, file_id)
);

alter table private.trash_entries enable row level security;
alter table private.trash_entry_files enable row level security;
revoke all on private.trash_entries, private.trash_entry_files from public, anon, authenticated;

-- Limits ----------------------------------------------------------------------------------------------

create function private.trash_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'batch' then 100        -- ids per restore or purge request
    when 'empty_batch' then 200  -- entries one "empty trash" call purges
    when 'list' then 500         -- rows one list returns
  end;
  $$;

-- Who may see and act on an entry. Personal trash: its owner. Home trash: a current member who
-- deleted the item themselves, or the Owner / an Administrator granted manageHomeSettings (the
-- engine action home.trash.viewAll). The per-module permission matrix is open in the spec, so this
-- is the generic rule; a module step may narrow or widen it for its own item type. The answer for
-- "may not see" is the same as for "does not exist" everywhere it is used.
create function private.can_see_trash_entry(p_entry private.trash_entries, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  -- Every term is false, never null, when it does not hold: a null here would slip past "not allowed".
  select p_user_id is not null and (
    coalesce(p_entry.owner_user_id = p_user_id, false)
    or (
      p_entry.owner_home_id is not null
      and exists (
        select 1 from public.home_memberships m
        where m.home_id = p_entry.owner_home_id and m.user_id = p_user_id
      )
      and (
        coalesce(p_entry.deleted_by = p_user_id, false)
        or private.has_home_capability(p_entry.owner_home_id, p_user_id, 'manageHomeSettings')
      )
    )
  );
  $$;

create function private.audit_trash_entry(
  p_actor uuid, p_entry private.trash_entries, p_action text
) returns void
  language sql volatile security definer set search_path = '' as $$
  -- Ids and type names only: never the label.
  insert into private.audit_events (actor_user_id, home_id, action, subject_type, subject_id, details)
    values (
      p_actor, p_entry.owner_home_id, p_action, 'trash_entry', p_entry.id,
      pg_catalog.jsonb_build_object('module', p_entry.module, 'itemType', p_entry.item_type)
    );
  $$;

-- Files ------------------------------------------------------------------------------------------------

-- Brings a deleted file back. It keeps its place in the pool, so nothing is charged twice. False when
-- the file is gone (purged by expiry or an early delete): the caller reports it.
create function private.restore_file(p_file_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found then
      return false;
    end if;
    -- Pool first, then the file: the same lock order as every other writer.
    perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'ready' then
      return true;
    end if;
    if v_file.status = 'deleted' and v_file.purge_after > pg_catalog.now() then
      update private.stored_files f
        set status = 'ready', deleted_at = null, purge_after = null
        where f.id = v_file.id;
      return true;
    end if;
    return false;
  end
  $$;

-- Removes a deleted file for good now: releases its space and queues the object. A file that is not
-- (or no longer) deleted is left alone.
create function private.purge_file_now(p_file_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found then
      return;
    end if;
    perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'deleted' then
      update private.stored_files f set status = 'purged' where f.id = v_file.id
        returning * into v_file;
      perform private.queue_object_deletion(v_file.object_key, 'purged');
      perform private.storage_reassess(v_file.pool_id);
    end if;
  end
  $$;

-- Moving an item to the trash ----------------------------------------------------------------------------

-- The one way an item enters the trash. The module's own delete function has already checked that the
-- actor may delete the item and has marked it deleted; p_file_ids are the files attached to it and
-- to nothing else. Idempotent per item: a second call returns the open entry.
create function private.trash_move(
  p_actor uuid, p_module text, p_item_type text, p_subject_id uuid,
  p_owner_user_id uuid, p_owner_home_id uuid, p_label text, p_file_ids uuid[] default '{}'
) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.trash_entries;
    v_file_id uuid;
    v_pool_id uuid;
  begin
    select * into v_entry from private.trash_entries t
      where t.item_type = p_item_type and t.subject_id = p_subject_id and t.status = 'trashed';
    if found then
      return v_entry.id;
    end if;
    insert into private.trash_entries (
      owner_user_id, owner_home_id, module, item_type, subject_id, label, deleted_by, expires_at
    ) values (
      p_owner_user_id, p_owner_home_id, p_module, p_item_type, p_subject_id,
      left(p_label, 200), p_actor,
      pg_catalog.now() + pg_catalog.make_interval(days => private.storage_limit('recovery_days'))
    ) returning * into v_entry;

    -- Pools in a fixed order, so two deletes touching the same pools cannot wait on each other.
    perform 1 from private.storage_pools p
      where p.id in (select f.pool_id from private.stored_files f where f.id = any (coalesce(p_file_ids, '{}')))
      order by p.id for update;
    for v_file_id in select distinct unnest(coalesce(p_file_ids, '{}')) loop
      select f.pool_id into v_pool_id from private.stored_files f where f.id = v_file_id;
      if v_pool_id is null then
        continue;
      end if;
      perform 1 from private.storage_pools p where p.id = v_pool_id for update;
      -- Still counted while it is in the trash; the usual purge job removes it at the end of the same
      -- window if nobody restores or deletes it first.
      perform private.retire_file(v_file_id);
      if exists (select 1 from private.stored_files f where f.id = v_file_id and f.status = 'deleted') then
        insert into private.trash_entry_files (entry_id, file_id) values (v_entry.id, v_file_id);
      end if;
    end loop;

    perform private.enqueue_job(
      'trash-entry-purge', 1, 'trash-entry:' || v_entry.id::text || ':purge',
      pg_catalog.jsonb_build_object('entryId', v_entry.id),
      private.request_correlation_id(),
      v_entry.expires_at
    );
    perform private.audit_trash_entry(p_actor, v_entry, 'trash_entry.moved');
    return v_entry.id;
  end
  $$;

-- The sample record type's table. A reference module, not reachable through the API: tests and the
-- browser tests create samples directly and call private.trash_sample_delete (below). Real modules
-- copy its shape: a soft-delete column, a real uniqueness constraint among active items (the slot), an
-- optional parent and an optional attached file, and a delete function that checks the actor and
-- calls private.trash_move.

create table private.trash_samples (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  name text not null constraint trash_samples_name_check check (char_length(name) between 1 and 200),
  slot text constraint trash_samples_slot_check check (slot ~ '^[a-z0-9-]{1,40}$'),
  parent_id uuid references private.trash_samples (id) on delete set null,
  file_id uuid references private.stored_files (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint trash_samples_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);

create unique index trash_samples_user_slot_idx on private.trash_samples (owner_user_id, slot)
  where slot is not null and deleted_at is null and owner_user_id is not null;
create unique index trash_samples_home_slot_idx on private.trash_samples (owner_home_id, slot)
  where slot is not null and deleted_at is null and owner_home_id is not null;

alter table private.trash_samples enable row level security;
revoke all on private.trash_samples from public, anon, authenticated;

comment on table private.trash_samples is
  'S16: the reference record type for trash and recovery. Not exposed through the API.';

-- Per-type hooks ---------------------------------------------------------------------------------------
-- A module adds a case to each. Matching names or titles are never a conflict.

-- The reason an entry cannot simply be restored, or null. The kind says what is in the way and
-- trash_conflict_options says what the person may choose.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_sample private.trash_samples;
  begin
    case p_entry.item_type
      when 'sample' then
        select * into v_sample from private.trash_samples s where s.id = p_entry.subject_id;
        if not found then
          return 'item_missing';
        end if;
        if v_sample.parent_id is not null and exists (
          select 1 from private.trash_samples p
          where p.id = v_sample.parent_id and p.deleted_at is not null
        ) then
          return 'parent_unavailable';
        end if;
        if v_sample.slot is not null and exists (
          select 1 from private.trash_samples o
          where o.id <> v_sample.id and o.deleted_at is null and o.slot = v_sample.slot
            and o.owner_user_id is not distinct from v_sample.owner_user_id
            and o.owner_home_id is not distinct from v_sample.owner_home_id
        ) then
          return 'slot_taken';
        end if;
        return null;
    end case;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case p_kind
    when 'slot_taken' then array['clear_slot']
    when 'parent_unavailable' then array['detach_parent']
    else array[]::text[]
  end;
  $$;

-- Applies the person's chosen resolution to the still-trashed item.
create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    case p_entry.item_type
      when 'sample' then
        if p_resolution = 'clear_slot' then
          update private.trash_samples s set slot = null where s.id = p_entry.subject_id;
        elsif p_resolution = 'detach_parent' then
          update private.trash_samples s set parent_id = null where s.id = p_entry.subject_id;
        end if;
    end case;
  end
  $$;

-- Brings the item and its trashed files back. Returns how many files could not come back.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
    v_lost integer := 0;
    v_lost_ids uuid[] := '{}';
    v_ref uuid;
  begin
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id
      order by ef.file_id
    loop
      if not private.restore_file(v_file_id) then
        v_lost := v_lost + 1;
        v_lost_ids := v_lost_ids || v_file_id;
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        -- The file the item uses must be usable too: it may have gone to the trash with another
        -- item that shared it (the last one deleted takes it along).
        select s.file_id into v_ref from private.trash_samples s where s.id = p_entry.subject_id;
        if v_ref is not null and not (v_ref = any (v_lost_ids)) and not private.restore_file(v_ref) then
          v_lost := v_lost + 1;
          v_lost_ids := v_lost_ids || v_ref;
        end if;
        update private.trash_samples s
          set deleted_at = null,
            -- A reference to a file that is gone would be broken: drop it, the caller reports it.
            file_id = case when s.file_id = any (v_lost_ids) then null else s.file_id end
          where s.id = p_entry.subject_id;
    end case;
    return v_lost;
  end
  $$;

-- Removes the item for good and releases its exclusively attached files.
create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
  begin
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id
      order by ef.file_id
    loop
      -- Never release a file another active item still uses.
      if not exists (
        select 1 from private.trash_samples s where s.file_id = v_file_id and s.deleted_at is null
      ) then
        perform private.purge_file_now(v_file_id);
      end if;
    end loop;
    case p_entry.item_type
      when 'sample' then
        delete from private.trash_samples s where s.id = p_entry.subject_id and s.deleted_at is not null;
    end case;
  end
  $$;

-- One entry: restore and purge ---------------------------------------------------------------------------

-- Restores one entry for p_user_id. Outcomes: 'restored', 'needs_resolution' (conflict and options
-- say what the person may choose), 'expired', 'not_found' (also for an entry the person may not see
-- or one already settled). Call it inside a block that turns an error into 'failed'.
create function private.trash_restore_one(p_user_id uuid, p_entry_id uuid, p_resolution text)
returns table (outcome text, conflict text, options text[], attachments_lost integer)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.trash_entries;
    v_kind text;
    v_round integer := 0;
    v_resolution text := p_resolution;
    v_lost integer;
  begin
    select * into v_entry from private.trash_entries t where t.id = p_entry_id for update;
    if not found or v_entry.status <> 'trashed' or not private.can_see_trash_entry(v_entry, p_user_id) then
      return query select 'not_found', null::text, null::text[], 0;
      return;
    end if;
    if v_entry.expires_at <= pg_catalog.now() then
      return query select 'expired', null::text, null::text[], 0;
      return;
    end if;
    loop
      v_kind := private.trash_conflict(v_entry);
      exit when v_kind is null;
      if v_kind = 'item_missing' then
        return query select 'not_found', null::text, null::text[], 0;
        return;
      end if;
      -- A chosen resolution counts only when it answers a conflict that is really there.
      if v_resolution is not null and v_resolution = any (private.trash_conflict_options(v_kind))
         and v_round < 3 then
        perform private.trash_resolve(v_entry, v_resolution);
        v_resolution := null;
        v_round := v_round + 1;
        continue;
      end if;
      return query select 'needs_resolution', v_kind, private.trash_conflict_options(v_kind), 0;
      return;
    end loop;
    begin
      v_lost := private.trash_item_restore(v_entry);
    exception when unique_violation then
      -- An active item took the place between the check and the restore: ask again, change nothing.
      v_kind := coalesce(private.trash_conflict(v_entry), 'slot_taken');
      return query select 'needs_resolution', v_kind, private.trash_conflict_options(v_kind), 0;
      return;
    end;
    return query select 'restored', null::text, null::text[], v_lost;
    update private.trash_entries t
      set status = 'restored', settled_at = pg_catalog.now(), label = null
      where t.id = v_entry.id;
    perform private.audit_trash_entry(p_user_id, v_entry, 'trash_entry.restored');
  end
  $$;

-- Purges one entry now (early delete, or the job after the window). Returns 'purged' or 'not_found'.
create function private.trash_purge_one(p_user_id uuid, p_entry_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.trash_entries;
  begin
    select * into v_entry from private.trash_entries t where t.id = p_entry_id for update;
    if not found or v_entry.status <> 'trashed'
       or (p_user_id is not null and not private.can_see_trash_entry(v_entry, p_user_id)) then
      return 'not_found';
    end if;
    perform private.trash_item_purge(v_entry);
    update private.trash_entries t
      set status = 'purged', settled_at = pg_catalog.now(), label = null
      where t.id = v_entry.id;
    perform private.audit_trash_entry(p_user_id, v_entry, 'trash_entry.purged');
    return 'purged';
  end
  $$;

-- The signed-in person's trash ------------------------------------------------------------------------------

-- The caller's trash for one scope: their personal trash (p_home_id null) or a Home they belong to,
-- showing only what they may see. Expired entries (waiting for the job) are not offered. 42501 for a
-- Home the caller does not belong to, whether or not it exists.
create function public.list_trash(
  p_home_id uuid default null, p_module text default null, p_item_type text default null,
  p_deleted_from timestamptz default null, p_deleted_to timestamptz default null
) returns table (
  entry_id uuid, module text, item_type text, label text, deleted_at timestamptz,
  expires_at timestamptz, deleted_by_me boolean, file_count integer
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    if p_home_id is not null and not exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    return query
      select t.id, t.module, t.item_type, t.label, t.deleted_at, t.expires_at,
        t.deleted_by is not distinct from v_user_id,
        (select count(*)::integer from private.trash_entry_files ef
          join private.stored_files sf on sf.id = ef.file_id
          where ef.entry_id = t.id and sf.status <> 'purged')
      from private.trash_entries t
      where t.status = 'trashed' and t.expires_at > pg_catalog.now()
        and case when p_home_id is null then t.owner_user_id = v_user_id
          else t.owner_home_id = p_home_id end
        and private.can_see_trash_entry(t, v_user_id)
        and (p_module is null or t.module = p_module)
        and (p_item_type is null or t.item_type = p_item_type)
        and (p_deleted_from is null or t.deleted_at >= p_deleted_from)
        and (p_deleted_to is null or t.deleted_at < p_deleted_to)
      order by t.deleted_at desc, t.id
      limit private.trash_limit('list');
  end
  $$;

-- Restores the chosen entries, each on its own: a conflict, an expired entry or a failure in one never
-- stops the others, and nothing active is overwritten. p_resolutions maps an entry id to the
-- resolution the person chose for it. 22023 for a malformed request.
create function public.restore_trash_entries(p_entry_ids uuid[], p_resolutions jsonb default '{}'::jsonb)
returns table (
  entry_id uuid, outcome text, conflict text, options text[], attachments_lost integer
)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
    v_resolution text;
    v_result record;
  begin
    if p_entry_ids is null or cardinality(p_entry_ids) not between 1 and private.trash_limit('batch')
       or p_resolutions is null or pg_catalog.jsonb_typeof(p_resolutions) <> 'object' then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- Every requested entry is locked first, in id order: two overlapping batches then queue on the
    -- entries and never hold one entry's pool while waiting for another entry.
    perform 1 from private.trash_entries t where t.id = any (p_entry_ids) order by t.id for update;
    -- A fixed order keeps two overlapping requests from waiting on each other.
    for v_id in select distinct x from unnest(p_entry_ids) as x order by x loop
      v_resolution := p_resolutions ->> v_id::text;
      begin
        select * into v_result from private.trash_restore_one(v_user_id, v_id, v_resolution);
        entry_id := v_id; outcome := v_result.outcome; conflict := v_result.conflict;
        options := v_result.options; attachments_lost := v_result.attachments_lost;
      exception when others then
        entry_id := v_id; outcome := 'failed'; conflict := null; options := null; attachments_lost := 0;
      end;
      return next;
    end loop;
  end
  $$;

-- Deletes the chosen entries for good, each only if the caller may. Outcomes: 'purged', 'not_found'
-- (not theirs to see, or already settled), 'failed'. The API asks for explicit confirmation first.
create function public.purge_trash_entries(p_entry_ids uuid[])
returns table (entry_id uuid, outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
  begin
    if p_entry_ids is null or cardinality(p_entry_ids) not between 1 and private.trash_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    -- Every requested entry is locked first, in id order: two overlapping batches then queue on the
    -- entries and never hold one entry's pool while waiting for another entry.
    perform 1 from private.trash_entries t where t.id = any (p_entry_ids) order by t.id for update;
    for v_id in select distinct x from unnest(p_entry_ids) as x order by x loop
      begin
        entry_id := v_id; outcome := private.trash_purge_one(v_user_id, v_id);
      exception when others then
        entry_id := v_id; outcome := 'failed';
      end;
      return next;
    end loop;
  end
  $$;

-- Empties the caller's trash for one scope: what they may see that was deleted at or before
-- p_deleted_before (the moment their page was loaded, so nothing listed later is touched), up to one
-- batch. Entries they may not see, and entries already past their window, are not touched. The result
-- has one row per entry; a full batch means more may remain, so call again. 42501 for a Home the
-- caller does not belong to, 22023 without a cutoff.
create function public.empty_trash(p_home_id uuid default null, p_deleted_before timestamptz default null)
returns table (entry_id uuid, outcome text)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_ids uuid[];
    v_id uuid;
  begin
    if p_deleted_before is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if p_home_id is not null and not exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    select coalesce(array_agg(x.id order by x.id), '{}') into v_ids from (
      select t.id from private.trash_entries t
      where t.status = 'trashed' and t.expires_at > pg_catalog.now() and t.deleted_at <= p_deleted_before
        and case when p_home_id is null then t.owner_user_id = v_user_id
          else t.owner_home_id = p_home_id end
        and private.can_see_trash_entry(t, v_user_id)
      order by t.id
      limit private.trash_limit('empty_batch')
    ) x;
    -- Every requested entry is locked first, in id order: two overlapping batches then queue on the
    -- entries and never hold one entry's pool while waiting for another entry.
    perform 1 from private.trash_entries t where t.id = any (v_ids) order by t.id for update;
    foreach v_id in array v_ids loop
      begin
        entry_id := v_id; outcome := private.trash_purge_one(v_user_id, v_id);
      exception when others then
        entry_id := v_id; outcome := 'failed';
      end;
      return next;
    end loop;
  end
  $$;

-- The job -----------------------------------------------------------------------------------------------------

-- trash-entry-purge: purges an entry whose window has ended. An entry restored or purged meanwhile, or
-- not yet due, is left alone. Returns the entry's status afterwards, or 'missing'.
create function public.purge_expired_trash_entry(p_entry_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_entry private.trash_entries;
    v_status text;
  begin
    select * into v_entry from private.trash_entries t where t.id = p_entry_id for update;
    if not found then
      return 'missing';
    end if;
    v_status := v_entry.status;
    if v_status = 'trashed' and v_entry.expires_at <= pg_catalog.now() then
      perform private.trash_purge_one(null, v_entry.id);
      v_status := 'purged';
    end if;
    return v_status;
  end
  $$;

-- Health for the runbook: entries past their window that are still waiting, and the oldest.
create function public.trash_stats()
returns table (open_entries bigint, overdue_entries bigint, oldest_overdue_seconds integer)
  language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from private.trash_entries t where t.status = 'trashed'),
    (select count(*) from private.trash_entries t
      where t.status = 'trashed' and t.expires_at <= pg_catalog.now()),
    (select extract(epoch from pg_catalog.now() - min(t.expires_at))::integer
      from private.trash_entries t where t.status = 'trashed' and t.expires_at <= pg_catalog.now());
  $$;

-- The sample record type's delete function ----------------------------------------------------------------------

-- Deletes a sample as p_actor: personal samples by their owner, Home samples by any current member.
-- Its attached file goes to the file trash with it unless another active sample uses it too.
create function private.trash_sample_delete(p_actor uuid, p_id uuid) returns uuid
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_sample private.trash_samples;
    v_files uuid[] := '{}';
  begin
    select * into v_sample from private.trash_samples s where s.id = p_id for update;
    if not found or v_sample.deleted_at is not null or not (
      v_sample.owner_user_id = p_actor
      or exists (
        select 1 from public.home_memberships m
        where m.home_id = v_sample.owner_home_id and m.user_id = p_actor
      )
    ) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    update private.trash_samples s set deleted_at = pg_catalog.now() where s.id = v_sample.id;
    if v_sample.file_id is not null and not exists (
      select 1 from private.trash_samples o
      where o.file_id = v_sample.file_id and o.id <> v_sample.id and o.deleted_at is null
    ) then
      v_files := array[v_sample.file_id];
    end if;
    return private.trash_move(
      p_actor, 'sample', 'sample', v_sample.id, v_sample.owner_user_id, v_sample.owner_home_id,
      v_sample.name, v_files
    );
  end
  $$;

-- Grants ---------------------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.list_trash(uuid, text, text, timestamptz, timestamptz)',
    'public.restore_trash_entries(uuid[], jsonb)',
    'public.purge_trash_entries(uuid[])',
    'public.empty_trash(uuid, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- The job and the runbook: the service role only.
  foreach v_function in array array[
    'public.purge_expired_trash_entry(uuid)',
    'public.trash_stats()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  foreach v_function in array array[
    'private.trash_limit(text)',
    'private.can_see_trash_entry(private.trash_entries, uuid)',
    'private.audit_trash_entry(uuid, private.trash_entries, text)',
    'private.restore_file(uuid)',
    'private.purge_file_now(uuid)',
    'private.trash_move(uuid, text, text, uuid, uuid, uuid, text, uuid[])',
    'private.trash_conflict(private.trash_entries)',
    'private.trash_conflict_options(text)',
    'private.trash_resolve(private.trash_entries, text)',
    'private.trash_item_restore(private.trash_entries)',
    'private.trash_item_purge(private.trash_entries)',
    'private.trash_restore_one(uuid, uuid, text)',
    'private.trash_purge_one(uuid, uuid)',
    'private.trash_sample_delete(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
