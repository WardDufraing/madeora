-- S35: photo libraries and processing (brief plans/steps/S35-brief.md; ADR 0043; Modules.md §4.7;
-- architecture.md §37).
--
-- A photo belongs to one library: a person's personal library (visible to that person only) or a Home's
-- library. Albums group photos of the same library; a photo may be in many albums, and removing it from
-- an album never deletes it. Nothing is exposed as a table: people use security-definer functions that
-- run with their own session and recheck the confirmed caller, their current membership and their right
-- on every call.
--
-- Uploads use the S15 pipeline (intent, signed PUT, server-verified finalize). Finalizing makes an
-- optimized WebP master and three derivatives (full, display, thumb) and drops the original; the
-- master and derivatives are four objects that count, together, as one stored file against the
-- library's pool, move to the trash together for seven days and are purged together.
--
-- Home permissions (packages/domain/src/permissions/home.ts makes the same decisions): every current
-- member sees the library and may upload; the uploader may delete their own photos and manage albums
-- they created; the Owner and Administrators granted the new delegable capability manageHomePhotos
-- ('manage') do all of it for everyone. A personal library is its owner's alone.

-- Audit subjects, the new capability, trash types, file purpose ----------------------------------------

alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file', 'trash_entry', 'dashboard_template', 'task', 'task_list', 'task_label',
    'task_series', 'task_template', 'task_attachment', 'chore', 'chore_occurrence', 'chore_category',
    'chore_template', 'chore_reassignment', 'chore_proposal', 'chore_volunteer_request',
    'home_vacation', 'chore_absence', 'point_account', 'point_entry', 'reward', 'reward_redemption',
    'point_settings', 'recipe', 'shopping_list', 'meal_plan', 'habit', 'goal', 'goal_series',
    'pet', 'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity', 'pet_care_occurrence',
    'calendar_event', 'photo', 'photo_album'
  ));

-- packages/domain delegableCapabilities lists the same names.
create or replace function private.is_delegable_capability(p_capability text) returns boolean
  language sql immutable security definer set search_path = '' as $$
  select p_capability in (
    'manageHomeSettings', 'manageInvitations', 'removeMembers', 'manageHomeDashboard',
    'manageHomeTasks', 'manageHomeChores', 'approveHomeChores', 'manageHomeRewards',
    'approveHomeRewards', 'manageHomePoints', 'manageHomeRecipes', 'manageHomeShopping',
    'manageHomeMeals', 'manageHomeHabits', 'manageHomeGoals', 'manageHomePets',
    'managePetMedicalAccess', 'manageHomeCalendar', 'manageHomePhotos'
  );
  $$;

alter table private.trash_entries drop constraint trash_entries_module_check;
alter table private.trash_entries add constraint trash_entries_module_check
  check (module in ('sample', 'dashboard', 'tasks', 'chores', 'recipes', 'shopping', 'meals', 'habits',
    'goals', 'pets', 'calendar', 'photos'));

alter table private.trash_entries drop constraint trash_entries_item_type_check;
alter table private.trash_entries add constraint trash_entries_item_type_check
  check (item_type in (
    'sample', 'dashboard_template', 'task', 'task_list', 'task_series_removal',
    'task_attachment', 'task_series_attachment', 'chore', 'chore_occurrence', 'chore_removal',
    'recipe', 'shopping_list', 'shopping_item', 'shopping_clear', 'meal_entry', 'habit', 'goal',
    'goal_series', 'pet', 'pet_medical_entry', 'pet_medical_attachment', 'pet_care_activity',
    'calendar_event', 'photo', 'photo_album'
  ));

alter table private.stored_files drop constraint stored_files_purpose_check;
alter table private.stored_files add constraint stored_files_purpose_check
  check (purpose in ('avatar', 'task_attachment', 'recipe_cover', 'pet_photo', 'pet_medical_attachment',
    'photo'));

-- Limits and policy ---------------------------------------------------------------------------------------

-- apps/web/src/photos/schema.ts uses the same numbers.
create function private.photo_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'album_name' then 80
    when 'albums' then 200              -- albums per library that are not in the trash
    when 'album_photos' then 2000       -- photos per album
    when 'page' then 60                 -- photos in one list answer
    when 'max_offset' then 100000
    when 'batch' then 100               -- photo ids in one request
    when 'max_side' then 12000
    when 'max_pixels' then 50000000
  end;
  $$;

-- A photo upload: JPEG, PNG, WebP, HEIC/HEIF or GIF up to 25 MB (owner decision, S35 brief); what is
-- stored is always WebP the server made.
create or replace function private.upload_max_bytes(p_purpose text) returns bigint
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then 5242880::bigint
    when 'task_attachment' then 10485760::bigint  -- 10 MB (brief S19c)
    when 'recipe_cover' then 10485760::bigint     -- 10 MB (brief S24)
    when 'pet_photo' then 10485760::bigint        -- 10 MB (brief S31)
    when 'pet_medical_attachment' then 10485760::bigint
    when 'photo' then 26214400::bigint            -- 25 MB (brief S35)
  end;
  $$;

create or replace function private.upload_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'task_attachment' then private.task_attachment_type(p_type)
    when 'recipe_cover' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'pet_photo' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    when 'pet_medical_attachment' then private.pet_attachment_type(p_type)
    when 'photo' then p_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'image/gif')
    else false
  end;
  $$;

create or replace function private.stored_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type = 'image/webp'
    when 'task_attachment' then private.task_attachment_type(p_type)
    when 'recipe_cover' then p_type = 'image/webp'
    when 'pet_photo' then p_type = 'image/webp'
    when 'pet_medical_attachment' then private.pet_attachment_type(p_type)
    when 'photo' then p_type = 'image/webp'
    else false
  end;
  $$;

-- Tables --------------------------------------------------------------------------------------------------

create table private.photos (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references private.stored_files (id) on delete cascade,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  -- Set null when the uploader's account is deleted: a Home keeps its photos (S40 decides the rest).
  created_by uuid references auth.users (id) on delete set null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null default pg_catalog.now(),
  deleted_at timestamptz,
  constraint photos_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint photos_file_key unique (file_id)
);
create index photos_user_library on private.photos (owner_user_id, created_at desc, id)
  where owner_user_id is not null and deleted_at is null;
create index photos_home_library on private.photos (owner_home_id, created_at desc, id)
  where owner_home_id is not null and deleted_at is null;

-- The three derivatives of a photo's file, with the keys the database generated when the upload was
-- opened. The master is the file's own object. Sizes are filled when the upload is finalized.
create table private.photo_variants (
  file_id uuid not null references private.stored_files (id) on delete cascade,
  kind text not null check (kind in ('full', 'display', 'thumb')),
  object_key text not null constraint photo_variants_key_check check (object_key ~ '^(u|h)/[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes > 0),
  width integer check (width > 0),
  height integer check (height > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  primary key (file_id, kind),
  constraint photo_variants_object_key_key unique (object_key)
);

create table private.photo_albums (
  id uuid primary key,
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  name text not null check (pg_catalog.char_length(name) between 1 and 80),
  revision integer not null default 1,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  deleted_at timestamptz,
  constraint photo_albums_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1)
);
create index photo_albums_user on private.photo_albums (owner_user_id, created_at, id)
  where owner_user_id is not null;
create index photo_albums_home on private.photo_albums (owner_home_id, created_at, id)
  where owner_home_id is not null;

-- Membership: a photo in an album. A photo may be in many albums; both always belong to one library.
create table private.photo_album_items (
  album_id uuid not null references private.photo_albums (id) on delete cascade,
  photo_id uuid not null references private.photos (id) on delete cascade,
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default pg_catalog.now(),
  primary key (album_id, photo_id)
);
create index photo_album_items_photo on private.photo_album_items (photo_id);

alter table private.photos enable row level security;
alter table private.photo_variants enable row level security;
alter table private.photo_albums enable row level security;
alter table private.photo_album_items enable row level security;
revoke all on table private.photos, private.photo_variants, private.photo_albums,
  private.photo_album_items from public, anon, authenticated, service_role;

-- Access --------------------------------------------------------------------------------------------------

-- What a person may do in a Home's photo library: 'manage' (the Owner, Administrators granted
-- manageHomePhotos), 'member' (every other current member) or null (not a member).
create function private.photo_access(p_home_id uuid, p_user_id uuid) returns text
  language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null or p_home_id is null then null
    when private.has_home_capability(p_home_id, p_user_id, 'manageHomePhotos') then 'manage'
    when exists (select 1 from public.home_memberships m where m.home_id = p_home_id and m.user_id = p_user_id)
      then 'member'
  end;
  $$;

-- Whether the person may see a library now: their own, or a Home they belong to.
create function private.can_see_photo_library(p_owner_user_id uuid, p_owner_home_id uuid, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (p_owner_home_id is not null and private.photo_access(p_owner_home_id, p_user_id) is not null)
  );
  $$;

-- Whether the person may change something they or someone else added to a library: the library's
-- owner (personal), the creator or a manager (Home).
create function private.can_change_photo_item(
  p_owner_user_id uuid, p_owner_home_id uuid, p_created_by uuid, p_user_id uuid
) returns boolean
  language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and (
    coalesce(p_owner_user_id = p_user_id, false)
    or (
      p_owner_home_id is not null
      and (
        private.photo_access(p_owner_home_id, p_user_id) = 'manage'
        or (coalesce(p_created_by = p_user_id, false)
          and private.photo_access(p_owner_home_id, p_user_id) is not null)
      )
    )
  );
  $$;

create function private.audit_photo(
  p_action text, p_home_id uuid, p_subject_type text, p_subject_id uuid, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  select private.audit(p_action, p_home_id, p_subject_type, p_subject_id, p_details);
  $$;

-- Serializes the per-library album limit, so two creates cannot both take the last place.
create function private.lock_photo_library(p_owner_user_id uuid, p_owner_home_id uuid) returns void
  language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('photos:' || coalesce(p_owner_home_id, p_owner_user_id)::text, 0));
  $$;

create function private.photo_albums_full(p_owner_user_id uuid, p_owner_home_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select (select count(*) from private.photo_albums a
    where a.deleted_at is null
      and a.owner_user_id is not distinct from p_owner_user_id
      and a.owner_home_id is not distinct from p_owner_home_id) >= private.photo_limit('albums');
  $$;

create function private.photo_album_name(p_name text) returns text
  language sql immutable set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  $$;

-- Uploads -------------------------------------------------------------------------------------------------

-- Opens an upload in the library's pool (the person's own, or the Home's), after the caller-specific
-- checks. The shared S15 rules: request id reuse, rate limits, capacity under the pool lock. Also
-- generates the keys of the three derivatives. Returns the outcome and the new or retried file.
create function private.open_photo_upload(
  p_user_id uuid, p_home_id uuid, p_content_type text, p_size bigint, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text := case when p_home_id is null then 'u' else 'h' end;
    v_kind text;
  begin
    v_pool := case when p_home_id is null then private.lock_storage_pool(p_user_id, null)
      else private.lock_storage_pool(null, p_home_id) end;
    select * into v_existing from private.stored_files f
      where f.created_by = p_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'photo' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.pool_id = v_pool.id and v_existing.expires_at > pg_catalog.now() then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.created_at > pg_catalog.now() - interval '1 hour')
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = p_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now())
         >= private.storage_limit('pending_per_account') then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    select * into v_usage from private.storage_usage(v_pool.id);
    if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + p_size
       > private.storage_allowance(v_pool) then
      return query select 'storage_full'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'photo', p_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    foreach v_kind in array array['full', 'display', 'thumb'] loop
      insert into private.photo_variants (file_id, kind, object_key)
        values (v_file.id, v_kind, private.new_object_key(v_prefix));
    end loop;

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      p_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'photo', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

-- Opens an upload of a photo into the caller's personal library (p_home_id null) or a Home's library
-- (any current member). Outcomes: 'ok' (file id, upload key, expiry), 'not_permitted', 'storage_full',
-- 'rate_limited', 'conflict'. 22023 for an invalid type or size.
create function public.create_photo_intent(
  p_home_id uuid, p_content_type text, p_size bigint, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_row record;
  begin
    if p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('photo')
       or not private.upload_type_allowed('photo', p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    if p_home_id is not null and private.photo_access(p_home_id, v_user_id) is null then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    select * into v_row from private.open_photo_upload(v_user_id, p_home_id, p_content_type, p_size,
      p_request_id);
    return query select v_row.outcome, v_row.file_id, v_row.upload_key, v_row.expires_at;
  end
  $$;

-- The objects the server writes for the caller's own pending photo upload: the master (the file's own
-- key) and the three derivatives. Empty for anything else.
create function public.get_photo_upload_keys(p_file_id uuid)
returns table (kind text, object_key text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select 'master'::text, f.object_key from private.stored_files f
        where f.id = p_file_id and f.created_by = v_user_id and f.purpose = 'photo'
          and f.status = 'pending'
      union all
      select v.kind, v.object_key from private.photo_variants v
        join private.stored_files f on f.id = v.file_id
        where f.id = p_file_id and f.created_by = v_user_id and f.purpose = 'photo'
          and f.status = 'pending';
  end
  $$;

-- Finalizes a photo (the server only, after it verified and stored the four pictures): records the
-- derivatives, finalizes the file with their total size (so all four count against the pool, under its
-- lock) and creates the photo. p_variants is a JSON array of exactly four { kind, size, width, height,
-- sha256 } for master, full, display and thumb. Outcomes: 'ready', 'not_found', 'expired', 'invalid',
-- 'storage_full'. A refusal leaves the file failed with all its objects queued for removal.
create function public.finalize_photo(p_user_id uuid, p_file_id uuid, p_variants jsonb)
returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
    v_pool private.storage_pools;
    v_variant jsonb;
    v_kinds text[] := '{}';
    v_total bigint := 0;
    v_master jsonb;
    v_ok boolean := true;
    v_outcome text;
    v_photo private.photos;
  begin
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = p_user_id and f.purpose = 'photo';
    if not found then
      return 'not_found';
    end if;
    select * into v_pool from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'ready' then
      return case when exists (select 1 from private.photos x where x.file_id = v_file.id)
        then 'ready' else 'not_found' end;
    end if;
    if v_file.status <> 'pending' then
      return 'not_found';
    end if;

    if p_variants is null or pg_catalog.jsonb_typeof(p_variants) <> 'array'
       or pg_catalog.jsonb_array_length(p_variants) <> 4 then
      v_ok := false;
    else
      for v_variant in select * from pg_catalog.jsonb_array_elements(p_variants) loop
        if pg_catalog.jsonb_typeof(v_variant) <> 'object'
           or coalesce(v_variant ->> 'kind', '') not in ('master', 'full', 'display', 'thumb')
           or (v_variant ->> 'kind') = any (v_kinds)
           or coalesce(v_variant ->> 'size', '') !~ '^[0-9]{1,10}$'
           or coalesce(v_variant ->> 'width', '') !~ '^[0-9]{1,5}$'
           or coalesce(v_variant ->> 'height', '') !~ '^[0-9]{1,5}$'
           or coalesce(v_variant ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then
          v_ok := false;
          exit;
        end if;
        if (v_variant ->> 'size')::bigint < 1 or (v_variant ->> 'width')::integer < 1
           or (v_variant ->> 'height')::integer < 1 then
          v_ok := false;
          exit;
        end if;
        v_kinds := v_kinds || (v_variant ->> 'kind');
        v_total := v_total + (v_variant ->> 'size')::bigint;
        if (v_variant ->> 'kind') = 'master' then
          v_master := v_variant;
        end if;
      end loop;
    end if;
    -- The uploader must still be allowed to add to a Home library.
    if v_ok and v_pool.owner_home_id is not null
       and private.photo_access(v_pool.owner_home_id, p_user_id) is null then
      v_ok := false;
    end if;
    if not v_ok then
      -- Marks the file failed and queues its objects (the facts below are never valid).
      perform public.finalize_upload(p_user_id, p_file_id, 'image/webp', 0, null);
      return 'invalid';
    end if;

    v_outcome := public.finalize_upload(
      p_user_id, p_file_id, 'image/webp', v_total, v_master ->> 'sha256');
    if v_outcome <> 'ready' then
      return v_outcome;
    end if;

    for v_variant in select * from pg_catalog.jsonb_array_elements(p_variants) loop
      if (v_variant ->> 'kind') <> 'master' then
        update private.photo_variants v
          set size_bytes = (v_variant ->> 'size')::bigint, width = (v_variant ->> 'width')::integer,
            height = (v_variant ->> 'height')::integer, sha256 = v_variant ->> 'sha256'
          where v.file_id = p_file_id and v.kind = v_variant ->> 'kind';
      end if;
    end loop;
    insert into private.photos (file_id, owner_user_id, owner_home_id, created_by, width, height)
      values (p_file_id, v_pool.owner_user_id, v_pool.owner_home_id, p_user_id,
        (v_master ->> 'width')::integer, (v_master ->> 'height')::integer)
      on conflict (file_id) do nothing
      returning * into v_photo;
    return 'ready';
  end
  $$;

-- Queues every object of a photo file when the file fails, is purged or is deleted outright: the
-- derivatives are not in stored_files, so the shared S15 paths would not remove them.
create function private.queue_photo_objects() returns trigger
  language plpgsql security definer set search_path = '' as $$
  declare
    v_key text;
  begin
    if tg_op = 'DELETE' then
      if old.purpose <> 'photo' or old.status = 'purged' then
        return old;
      end if;
    elsif old.purpose <> 'photo' or new.status = old.status or new.status not in ('failed', 'purged') then
      return new;
    end if;
    for v_key in
      select v.object_key from private.photo_variants v
        where v.file_id = coalesce(old.id, new.id)
    loop
      perform private.queue_object_deletion(v_key,
        case when tg_op = 'DELETE' then 'owner_deleted' else new.status end);
    end loop;
    return case when tg_op = 'DELETE' then old else new end;
  end
  $$;

create trigger stored_files_photo_objects_update
  after update of status on private.stored_files
  for each row execute function private.queue_photo_objects();
create trigger stored_files_photo_objects_delete
  before delete on private.stored_files
  for each row execute function private.queue_photo_objects();

-- Reading --------------------------------------------------------------------------------------------------

create function private.photo_json(p_photo private.photos, p_user_id uuid) returns jsonb
  language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', p_photo.id, 'width', p_photo.width, 'height', p_photo.height,
    'createdAt', p_photo.created_at,
    'canDelete', private.can_change_photo_item(p_photo.owner_user_id, p_photo.owner_home_id,
      p_photo.created_by, p_user_id));
  $$;

-- A library page: what the person may do, the library's albums, and one page of photos (newest first),
-- of the whole library or of one album. p_home_id null is the caller's personal library. Null for a
-- Home they are not in, and for an album that is not in this library or is in the trash. The answer
-- for "no such Home" and "not your Home" is the same.
create function public.list_photo_library(p_home_id uuid, p_album_id uuid, p_offset integer)
returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_manage boolean;
    v_album private.photo_albums;
    v_offset integer := coalesce(p_offset, 0);
    v_photos jsonb;
    v_total integer;
  begin
    if v_offset < 0 or v_offset > private.photo_limit('max_offset') then
      raise exception 'invalid offset' using errcode = '22023';
    end if;
    if p_home_id is not null and private.photo_access(p_home_id, v_user_id) is null then
      return null;
    end if;
    v_manage := p_home_id is null or private.photo_access(p_home_id, v_user_id) = 'manage';
    if p_album_id is not null then
      select * into v_album from private.photo_albums a
        where a.id = p_album_id and a.deleted_at is null
          and a.owner_user_id is not distinct from v_owner_user
          and a.owner_home_id is not distinct from p_home_id;
      if not found then
        return null;
      end if;
    end if;

    select pg_catalog.count(*) into v_total from private.photos p
      where p.deleted_at is null
        and p.owner_user_id is not distinct from v_owner_user
        and p.owner_home_id is not distinct from p_home_id
        and (p_album_id is null or exists (
          select 1 from private.photo_album_items i where i.album_id = p_album_id and i.photo_id = p.id));
    select coalesce(pg_catalog.jsonb_agg(private.photo_json(x, v_user_id) order by x.created_at desc, x.id), '[]')
      into v_photos
      from (
        select p.* from private.photos p
          where p.deleted_at is null
            and p.owner_user_id is not distinct from v_owner_user
            and p.owner_home_id is not distinct from p_home_id
            and (p_album_id is null or exists (
              select 1 from private.photo_album_items i where i.album_id = p_album_id and i.photo_id = p.id))
          order by p.created_at desc, p.id
          limit private.photo_limit('page') offset v_offset
      ) x;

    return pg_catalog.jsonb_build_object(
      'homeId', p_home_id,
      'canUpload', true,
      'canManage', v_manage,
      'albumId', p_album_id,
      'albumName', v_album.name,
      'total', v_total,
      'photos', v_photos,
      'albums', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', a.id, 'name', a.name, 'revision', a.revision,
          'photoCount', (select pg_catalog.count(*) from private.photo_album_items i
            join private.photos p on p.id = i.photo_id and p.deleted_at is null where i.album_id = a.id),
          'coverPhotoId', (select p.id from private.photo_album_items i
            join private.photos p on p.id = i.photo_id and p.deleted_at is null
            where i.album_id = a.id order by i.added_at desc, p.id limit 1),
          'canEdit', private.can_change_photo_item(a.owner_user_id, a.owner_home_id, a.created_by, v_user_id)
        ) order by a.created_at, a.id), '[]')
        from private.photo_albums a
        where a.deleted_at is null
          and a.owner_user_id is not distinct from v_owner_user
          and a.owner_home_id is not distinct from p_home_id
      )
    );
  end
  $$;

-- One photo and the albums of its library that hold it. Null when the person may not see it.
create function public.get_photo(p_photo_id uuid) returns jsonb
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_photo private.photos;
  begin
    select * into v_photo from private.photos p where p.id = p_photo_id and p.deleted_at is null;
    if not found or not private.can_see_photo_library(v_photo.owner_user_id, v_photo.owner_home_id, v_user_id) then
      return null;
    end if;
    return private.photo_json(v_photo, v_user_id) || pg_catalog.jsonb_build_object(
      'homeId', v_photo.owner_home_id,
      'albums', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', a.id, 'name', a.name)
          order by a.created_at, a.id), '[]')
        from private.photo_album_items i
        join private.photo_albums a on a.id = i.album_id and a.deleted_at is null
        where i.photo_id = v_photo.id));
  end
  $$;

-- The object to serve for one picture of a photo the caller may see now (variant: master, full,
-- display or thumb). Empty for everything else, for every reason alike.
create function public.authorize_photo_read(p_photo_id uuid, p_variant text)
returns table (object_key text, content_type text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select case when p_variant = 'master' then f.object_key else v.object_key end, f.content_type
      from private.photos p
      join private.stored_files f on f.id = p.file_id and f.status = 'ready'
      left join private.photo_variants v on v.file_id = f.id and v.kind = p_variant
      where p.id = p_photo_id and p.deleted_at is null
        and p_variant in ('master', 'full', 'display', 'thumb')
        and (p_variant = 'master' or v.object_key is not null)
        and private.can_see_photo_library(p.owner_user_id, p.owner_home_id, v_user_id);
  end
  $$;

-- Deleting photos -------------------------------------------------------------------------------------------

-- Moves photos to the trash (the whole file, derivatives included, keeps counting for seven days). Each
-- photo the caller may not delete, or cannot see, is skipped without telling which. Their album
-- memberships stay, so restoring a photo puts it back where it was. Returns { deleted, skipped }.
create function public.delete_photos(p_photo_ids uuid[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_id uuid;
    v_photo private.photos;
    v_deleted integer := 0;
    v_skipped integer := 0;
  begin
    if p_photo_ids is null or pg_catalog.cardinality(p_photo_ids) < 1
       or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    for v_id in select distinct u from pg_catalog.unnest(p_photo_ids) u order by u loop
      select * into v_photo from private.photos p where p.id = v_id for update;
      if not found or v_photo.deleted_at is not null
         or not private.can_see_photo_library(v_photo.owner_user_id, v_photo.owner_home_id, v_user_id)
         or not private.can_change_photo_item(v_photo.owner_user_id, v_photo.owner_home_id,
           v_photo.created_by, v_user_id) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      update private.photos p set deleted_at = pg_catalog.now() where p.id = v_photo.id;
      perform private.trash_move(v_user_id, 'photos', 'photo', v_photo.id, v_photo.owner_user_id,
        v_photo.owner_home_id, 'Photo', array[v_photo.file_id]);
      perform private.audit_photo('photo.deleted', v_photo.owner_home_id, 'photo', v_photo.id);
      v_deleted := v_deleted + 1;
    end loop;
    return pg_catalog.jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped);
  end
  $$;

-- Albums --------------------------------------------------------------------------------------------------

-- Creates an album in the caller's personal library (p_home_id null) or a Home's (any current member).
-- The id comes from the client, so a retry returns the same album. Outcomes: 'created', 'exists' (the
-- retry), 'not_permitted', 'limit'. 22023 for an invalid name.
create function public.create_photo_album(p_id uuid, p_home_id uuid, p_name text) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_owner_user uuid := case when p_home_id is null then v_user_id end;
    v_name text := private.photo_album_name(p_name);
    v_album private.photo_albums;
  begin
    if p_id is null or pg_catalog.char_length(v_name) not between 1 and private.photo_limit('album_name')
       or v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid album' using errcode = '22023';
    end if;
    if p_home_id is not null and private.photo_access(p_home_id, v_user_id) is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    perform private.lock_photo_library(v_owner_user, p_home_id);
    select * into v_album from private.photo_albums a where a.id = p_id;
    if found then
      if v_album.created_by = v_user_id and v_album.owner_user_id is not distinct from v_owner_user
         and v_album.owner_home_id is not distinct from p_home_id and v_album.deleted_at is null then
        return pg_catalog.jsonb_build_object('outcome', 'exists', 'id', v_album.id);
      end if;
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if private.photo_albums_full(v_owner_user, p_home_id) then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;
    insert into private.photo_albums (id, owner_user_id, owner_home_id, created_by, name)
      values (p_id, v_owner_user, p_home_id, v_user_id, v_name);
    perform private.audit_photo('photo_album.created', p_home_id, 'photo_album', p_id);
    return pg_catalog.jsonb_build_object('outcome', 'created', 'id', p_id, 'revision', 1);
  end
  $$;

-- The album, locked, when the caller may see its library and it is not in the trash; otherwise null.
create function private.lock_photo_album(p_album_id uuid, p_user_id uuid) returns private.photo_albums
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_album private.photo_albums;
  begin
    select * into v_album from private.photo_albums a where a.id = p_album_id for update;
    if not found or v_album.deleted_at is not null
       or not private.can_see_photo_library(v_album.owner_user_id, v_album.owner_home_id, p_user_id) then
      return null;
    end if;
    return v_album;
  end
  $$;

-- Renames an album (its creator, a manager; the owner for a personal one). Outcomes: 'saved' (with the
-- revision), 'stale', 'not_found', 'not_permitted'. 22023 for an invalid name.
create function public.rename_photo_album(p_album_id uuid, p_expected_revision integer, p_name text)
returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_name text := private.photo_album_name(p_name);
  begin
    if p_album_id is null or p_expected_revision is null
       or pg_catalog.char_length(v_name) not between 1 and private.photo_limit('album_name')
       or v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid album' using errcode = '22023';
    end if;
    v_album := private.lock_photo_album(p_album_id, v_user_id);
    if v_album.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
      v_album.created_by, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_album.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_album.revision);
    end if;
    update private.photo_albums a set name = v_name, revision = a.revision + 1,
        updated_at = pg_catalog.now()
      where a.id = v_album.id returning * into v_album;
    perform private.audit_photo('photo_album.renamed', v_album.owner_home_id, 'photo_album', v_album.id);
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'revision', v_album.revision);
  end
  $$;

-- Deletes an album to the trash. Its photos are untouched; restoring the album restores the grouping.
-- Outcomes: 'deleted', 'stale', 'not_found', 'not_permitted'.
create function public.delete_photo_album(p_album_id uuid, p_expected_revision integer) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
  begin
    if p_album_id is null or p_expected_revision is null then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_album := private.lock_photo_album(p_album_id, v_user_id);
    if v_album.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
      v_album.created_by, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    if v_album.revision <> p_expected_revision then
      return pg_catalog.jsonb_build_object('outcome', 'stale', 'revision', v_album.revision);
    end if;
    update private.photo_albums a set deleted_at = pg_catalog.now(), revision = a.revision + 1
      where a.id = v_album.id;
    perform private.trash_move(v_user_id, 'photos', 'photo_album', v_album.id, v_album.owner_user_id,
      v_album.owner_home_id, v_album.name);
    perform private.audit_photo('photo_album.deleted', v_album.owner_home_id, 'photo_album', v_album.id);
    return pg_catalog.jsonb_build_object('outcome', 'deleted');
  end
  $$;

-- Adds photos of the album's own library to it (a photo may be in many albums). Photos that are not
-- in this library, are in the trash or are already in the album are skipped without telling which.
-- Outcomes: 'saved' (with added and skipped), 'not_found', 'not_permitted', 'limit'.
create function public.add_photos_to_album(p_album_id uuid, p_photo_ids uuid[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_ids uuid[];
    v_added integer;
  begin
    if p_album_id is null or p_photo_ids is null or pg_catalog.cardinality(p_photo_ids) < 1
       or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_album := private.lock_photo_album(p_album_id, v_user_id);
    if v_album.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
      v_album.created_by, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    select coalesce(pg_catalog.array_agg(p.id order by p.id), '{}') into v_ids
      from private.photos p
      where p.id = any (p_photo_ids) and p.deleted_at is null
        and p.owner_user_id is not distinct from v_album.owner_user_id
        and p.owner_home_id is not distinct from v_album.owner_home_id
        and not exists (select 1 from private.photo_album_items i
          where i.album_id = v_album.id and i.photo_id = p.id);
    if (select pg_catalog.count(*) from private.photo_album_items i where i.album_id = v_album.id)
       + pg_catalog.cardinality(v_ids) > private.photo_limit('album_photos') then
      return pg_catalog.jsonb_build_object('outcome', 'limit');
    end if;
    insert into private.photo_album_items (album_id, photo_id, added_by)
      select v_album.id, u, v_user_id from pg_catalog.unnest(v_ids) u;
    get diagnostics v_added = row_count;
    perform private.audit_photo('photo_album.photos_added', v_album.owner_home_id, 'photo_album', v_album.id,
      pg_catalog.jsonb_build_object('count', v_added));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'added', v_added,
      'skipped', pg_catalog.cardinality(p_photo_ids) - v_added);
  end
  $$;

-- Takes photos out of an album. The photos themselves are never deleted by this. Outcomes: 'saved'
-- (with removed), 'not_found', 'not_permitted'.
create function public.remove_photos_from_album(p_album_id uuid, p_photo_ids uuid[]) returns jsonb
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_album private.photo_albums;
    v_removed integer;
  begin
    if p_album_id is null or p_photo_ids is null or pg_catalog.cardinality(p_photo_ids) < 1
       or pg_catalog.cardinality(p_photo_ids) > private.photo_limit('batch') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    v_album := private.lock_photo_album(p_album_id, v_user_id);
    if v_album.id is null then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if not private.can_change_photo_item(v_album.owner_user_id, v_album.owner_home_id,
      v_album.created_by, v_user_id) then
      return pg_catalog.jsonb_build_object('outcome', 'not_permitted');
    end if;
    delete from private.photo_album_items i where i.album_id = v_album.id and i.photo_id = any (p_photo_ids);
    get diagnostics v_removed = row_count;
    perform private.audit_photo('photo_album.photos_removed', v_album.owner_home_id, 'photo_album',
      v_album.id, pg_catalog.jsonb_build_object('count', v_removed));
    return pg_catalog.jsonb_build_object('outcome', 'saved', 'removed', v_removed);
  end
  $$;

-- Trash ---------------------------------------------------------------------------------------------------

-- A photo's or album's entry is for the person who deleted it, and for the Owner and Administrators
-- granted manageHomePhotos in a Home (whoever deleted it); a personal entry is its owner's alone.
alter function private.can_see_trash_entry(private.trash_entries, uuid) rename to can_see_trash_entry_before_photos;

create function private.can_see_trash_entry(p_entry private.trash_entries, p_user_id uuid)
returns boolean
  language sql stable security definer set search_path = '' as $$
  select case
    when p_entry.module <> 'photos' then private.can_see_trash_entry_before_photos(p_entry, p_user_id)
    when p_user_id is null then false
    when p_entry.owner_user_id is not null then p_entry.owner_user_id = p_user_id
    else private.photo_access(p_entry.owner_home_id, p_user_id) is not null
      and (coalesce(p_entry.deleted_by = p_user_id, false)
        or private.photo_access(p_entry.owner_home_id, p_user_id) = 'manage')
  end;
  $$;

alter function private.trash_conflict(private.trash_entries) rename to trash_conflict_before_photos;
alter function private.trash_conflict_options(text) rename to trash_conflict_options_before_photos;
alter function private.trash_resolve(private.trash_entries, text) rename to trash_resolve_before_photos;
alter function private.trash_item_restore(private.trash_entries) rename to trash_item_restore_before_photos;
alter function private.trash_item_purge(private.trash_entries) rename to trash_item_purge_before_photos;

-- A photo's only conflict: its file was purged meanwhile ('item_missing'). An album's: its library
-- already has 200 albums ('album_limit'); the person makes room.
create function private.trash_conflict(p_entry private.trash_entries) returns text
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_photo private.photos;
    v_album private.photo_albums;
  begin
    if p_entry.module <> 'photos' then
      return private.trash_conflict_before_photos(p_entry);
    end if;
    if p_entry.item_type = 'photo' then
      select * into v_photo from private.photos p where p.id = p_entry.subject_id;
      if not found or v_photo.deleted_at is null or not exists (
        select 1 from private.stored_files f where f.id = v_photo.file_id and f.status = 'deleted') then
        return 'item_missing';
      end if;
      return null;
    end if;
    select * into v_album from private.photo_albums a where a.id = p_entry.subject_id;
    if not found or v_album.deleted_at is null then
      return 'item_missing';
    end if;
    if private.photo_albums_full(v_album.owner_user_id, v_album.owner_home_id) then
      return 'album_limit';
    end if;
    return null;
  end
  $$;

create function private.trash_conflict_options(p_kind text) returns text[]
  language sql immutable set search_path = '' as $$
  select case
    when p_kind = 'album_limit' then array[]::text[]
    else private.trash_conflict_options_before_photos(p_kind)
  end;
  $$;

create function private.trash_resolve(p_entry private.trash_entries, p_resolution text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_entry.module <> 'photos' then
      perform private.trash_resolve_before_photos(p_entry, p_resolution);
    end if;
    -- Photos and albums have no resolvable conflict.
  end
  $$;

-- A photo comes back with its file (still counted, never charged twice) and its album memberships; an
-- album comes back with its photos that are not in the trash.
create function private.trash_item_restore(p_entry private.trash_entries) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_photo private.photos;
    v_album private.photo_albums;
    v_file_id uuid;
  begin
    if p_entry.module <> 'photos' then
      return private.trash_item_restore_before_photos(p_entry);
    end if;
    if p_entry.item_type = 'photo' then
      select * into v_photo from private.photos p where p.id = p_entry.subject_id for update;
      if not found or v_photo.deleted_at is null then
        raise exception 'photo unavailable' using errcode = '23505';
      end if;
      for v_file_id in
        select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id order by ef.file_id
      loop
        if not private.restore_file(v_file_id) then
          raise exception 'photo unavailable' using errcode = '23505';
        end if;
      end loop;
      update private.photos p set deleted_at = null where p.id = v_photo.id;
      return 0;
    end if;
    select * into v_album from private.photo_albums a where a.id = p_entry.subject_id for update;
    if not found or v_album.deleted_at is null then
      raise exception 'album unavailable' using errcode = '23505';
    end if;
    perform private.lock_photo_library(v_album.owner_user_id, v_album.owner_home_id);
    if private.photo_albums_full(v_album.owner_user_id, v_album.owner_home_id) then
      raise exception 'album limit' using errcode = '23505';
    end if;
    update private.photo_albums a set deleted_at = null, revision = a.revision + 1, updated_at = pg_catalog.now()
      where a.id = v_album.id;
    return 0;
  end
  $$;

create function private.trash_item_purge(p_entry private.trash_entries) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file_id uuid;
  begin
    if p_entry.module <> 'photos' then
      perform private.trash_item_purge_before_photos(p_entry);
      return;
    end if;
    for v_file_id in
      select ef.file_id from private.trash_entry_files ef where ef.entry_id = p_entry.id order by ef.file_id
    loop
      perform private.purge_file_now(v_file_id);
    end loop;
    if p_entry.item_type = 'photo' then
      -- The album memberships go with it (on delete cascade).
      delete from private.photos p where p.id = p_entry.subject_id and p.deleted_at is not null;
    else
      delete from private.photo_albums a where a.id = p_entry.subject_id and a.deleted_at is not null;
    end if;
  end
  $$;

-- Grants --------------------------------------------------------------------------------------------------

do $$
declare
  v_function regprocedure;
begin
  -- The photos API: signed-in people only (every function rechecks the confirmed caller).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'create_photo_intent', 'get_photo_upload_keys', 'list_photo_library', 'get_photo',
      'authorize_photo_read', 'delete_photos', 'create_photo_album', 'rename_photo_album',
      'delete_photo_album', 'add_photos_to_album', 'remove_photos_from_album'
    )
  loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Finalizing: the server's privileged call only (the facts are trusted).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_photo'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;

  -- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
  for v_function in
    select p.oid::regprocedure from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and (
      p.proname like '%photo%'
      or p.proname in ('can_see_trash_entry', 'trash_conflict', 'trash_conflict_options', 'trash_resolve',
        'trash_item_restore', 'trash_item_purge', 'is_delegable_capability', 'upload_max_bytes',
        'upload_type_allowed', 'stored_type_allowed')
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
