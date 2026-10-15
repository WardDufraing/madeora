-- S15: file storage and quotas (brief S15; spec "Confirmed MVP personal and Home storage
-- allowances", "Confirmed full-storage behavior", "Confirmed deleted-file storage accounting",
-- "Confirmed deleted-file recovery period", "Confirmed progressive storage warnings"; architecture.md
-- §10, §36; ADR 0019).
--
-- * private.stored_files: the authority for every stored file: its pool, purpose, opaque object keys,
--   declared and verified type and size, checksum and lifecycle. Object keys are generated here from
--   256 random bits and never accepted from a client; possessing one grants nothing.
-- * private.storage_pools: one allowance per account and per Home (null = the environment default
--   in private.storage_defaults). Every function that adds bytes locks the pool row, so two uploads
--   at the same time cannot both take the last free space.
-- * Usage = ready files + deleted files still recoverable + unexpired pending reservations.
-- * public.create_upload_intent (the signed-in person), public.finalize_upload (the server only,
--   after it verified the bytes), public.set_my_avatar / public.set_my_home_avatar (the person
--   themselves), public.authorize_file_read (every view of a file asks again).
-- * Objects are removed by jobs (ADR 0017) from a queue of deletions, so a row that disappears with
--   its account or Home never leaves an object behind unnoticed.
-- * Warnings at 80% and 95%, once per crossing, as in-app notices to the account holder or to the
--   Home's storage managers (the Owner, or an Administrator granted manageHomeSettings).
--
-- Allowance amounts are open in the spec until pricing is decided. The values seeded below are
-- development placeholders, changed with one SQL update (docs/file-storage.md), never promises.

-- Uploads are audited by id only (architecture §10): intent opened, finalize outcome, abandoned.
alter table private.audit_events drop constraint audit_events_subject_type_check;
alter table private.audit_events add constraint audit_events_subject_type_check
  check (subject_type in (
    'home', 'user', 'invitation', 'join_request', 'ownership_transfer', 'ownership_recovery',
    'stored_file'
  ));

-- Defaults and pools --------------------------------------------------------------------------------

create table private.storage_defaults (
  pool_kind text primary key constraint storage_defaults_pool_kind_check
    check (pool_kind in ('personal', 'home')),
  allowance_bytes bigint not null constraint storage_defaults_allowance_check
    check (allowance_bytes >= 0),
  updated_at timestamptz not null default now()
);

comment on table private.storage_defaults is
  'S15: default storage allowance per pool kind. Development placeholders until pricing is decided.';

insert into private.storage_defaults (pool_kind, allowance_bytes) values
  ('personal', 1073741824),  -- 1 GiB, placeholder
  ('home', 5368709120);      -- 5 GiB, placeholder

create table private.storage_pools (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete cascade,
  owner_home_id uuid references public.homes (id) on delete cascade,
  -- Null: the default for the pool's kind.
  allowance_bytes bigint constraint storage_pools_allowance_check check (allowance_bytes >= 0),
  -- The warning last notified (0, 80 or 95) and how many upward crossings there have been, so each
  -- new crossing gets its own notification and a repeated check none.
  warning_level smallint not null default 0
    constraint storage_pools_warning_level_check check (warning_level in (0, 80, 95)),
  warning_crossings integer not null default 0,
  created_at timestamptz not null default now(),
  constraint storage_pools_one_owner check (num_nonnulls(owner_user_id, owner_home_id) = 1),
  constraint storage_pools_user_key unique (owner_user_id),
  constraint storage_pools_home_key unique (owner_home_id)
);

comment on table private.storage_pools is
  'S15: one storage allowance per account and per Home. Not exposed through the API.';

-- Files ----------------------------------------------------------------------------------------------

create table private.stored_files (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references private.storage_pools (id) on delete cascade,
  purpose text not null constraint stored_files_purpose_check check (purpose in ('avatar')),
  created_by uuid references auth.users (id) on delete set null,
  -- Double-submit safety: the same request id from the same person is the same intent.
  request_id uuid not null,
  -- Where the browser puts the raw upload, and where the server stores the processed file. Both are
  -- generated here; the raw upload is deleted once processed (the original is not kept, §37).
  upload_key text not null constraint stored_files_upload_key_check
    check (upload_key ~ '^(u|h)/[0-9a-f]{64}$'),
  object_key text not null constraint stored_files_object_key_check
    check (object_key ~ '^(u|h)/[0-9a-f]{64}$'),
  declared_type text not null constraint stored_files_declared_type_check
    check (declared_type ~ '^[a-z]+/[a-z0-9.+-]{1,60}$'),
  declared_size bigint not null constraint stored_files_declared_size_check
    check (declared_size > 0),
  -- Set at finalize from what the server verified, never from the client.
  content_type text constraint stored_files_content_type_check
    check (content_type ~ '^[a-z]+/[a-z0-9.+-]{1,60}$'),
  size_bytes bigint constraint stored_files_size_check check (size_bytes > 0),
  sha256 text constraint stored_files_sha256_check check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' constraint stored_files_status_check
    check (status in ('pending', 'ready', 'failed', 'deleted', 'purged')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  -- One finalize at a time (H1): the server claims the upload for a short lease before it reads and
  -- processes the bytes, and may try only a few times per upload.
  claimed_until timestamptz,
  finalize_attempts smallint not null default 0
    constraint stored_files_finalize_attempts_check check (finalize_attempts >= 0),
  deleted_at timestamptz,
  purge_after timestamptz,
  constraint stored_files_request_key unique (created_by, request_id),
  constraint stored_files_upload_key_key unique (upload_key),
  constraint stored_files_object_key_key unique (object_key),
  constraint stored_files_ready_facts check (
    status not in ('ready', 'deleted', 'purged')
    or (content_type is not null and size_bytes is not null and sha256 is not null)
  ),
  constraint stored_files_deleted_facts check (
    status <> 'deleted' or (deleted_at is not null and purge_after is not null)
  )
);

create index stored_files_pool_idx on private.stored_files (pool_id, status);
create index stored_files_creator_recent_idx on private.stored_files (created_by, created_at);

comment on table private.stored_files is
  'S15: every stored file, its pool, keys, verified facts and lifecycle. Not exposed through the API.';

-- Objects to remove from the bucket, one row per key. A job deletes the object and marks it done;
-- a missing object counts as deleted. Unique per key, so queueing twice is harmless.
create table private.storage_object_deletions (
  id uuid primary key default gen_random_uuid(),
  object_key text not null constraint storage_object_deletions_key_check
    check (object_key ~ '^(u|h)/[0-9a-f]{64}$'),
  reason text not null constraint storage_object_deletions_reason_check
    check (reason in ('processed', 'expired', 'failed', 'purged', 'owner_deleted')),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  constraint storage_object_deletions_key unique (object_key)
);

create index storage_object_deletions_open_idx on private.storage_object_deletions (created_at)
  where done_at is null;

alter table private.storage_defaults enable row level security;
alter table private.storage_pools enable row level security;
alter table private.stored_files enable row level security;
alter table private.storage_object_deletions enable row level security;
revoke all on private.storage_defaults, private.storage_pools, private.stored_files,
  private.storage_object_deletions
from public, anon, authenticated, service_role;

-- Avatars point at files. Only the functions below write these columns (no column grant).
alter table public.user_preferences
  add column avatar_file_id uuid references private.stored_files (id) on delete set null;
alter table public.home_member_profiles
  add column avatar_file_id uuid references private.stored_files (id) on delete set null;
-- The person reads their own row (RLS, S11), now including the avatar; writing it stays with
-- set_my_home_avatar. user_preferences is already readable by its owner in full.
grant select (avatar_file_id) on table public.home_member_profiles to authenticated;

-- Policy ---------------------------------------------------------------------------------------------

-- What a purpose accepts from a browser: the largest upload and the declared types. Avatars are
-- re-encoded by the server to a 512x512 WebP (brief S15, owner may change the limits).
create function private.upload_max_bytes(p_purpose text) returns bigint
  language sql immutable set search_path = '' as $$
  select case p_purpose when 'avatar' then 5242880::bigint end;
  $$;

create function private.upload_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose
    when 'avatar' then p_type in ('image/jpeg', 'image/png', 'image/webp')
    else false
  end;
  $$;

-- What the server may store for a purpose after processing.
create function private.stored_type_allowed(p_purpose text, p_type text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_purpose when 'avatar' then p_type = 'image/webp' else false end;
  $$;

-- Limits (brief S15, owner may change): intents per account per hour, pending uploads per account,
-- how long an intent stays open, and the recovery window for deleted files (spec: 7 days).
create function private.storage_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'intents_per_hour' then 30
    when 'pending_per_account' then 5
    when 'intent_minutes' then 15
    when 'recovery_days' then 7
    when 'finalize_attempts' then 3
    when 'finalize_lease_seconds' then 120
  end;
  $$;

create function private.new_object_key(p_prefix text) returns text
  language sql volatile set search_path = '' as $$
  select p_prefix || '/' || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  $$;

-- One audit row about a stored file: ids and short codes only, never keys, names or contents.
create function private.audit_stored_file(
  p_actor uuid, p_file_id uuid, p_action text, p_details jsonb default '{}'::jsonb
) returns void
  language sql volatile security definer set search_path = '' as $$
  insert into private.audit_events (actor_user_id, home_id, action, subject_type, subject_id, details)
    values (p_actor, null, p_action, 'stored_file', p_file_id, p_details);
  $$;

-- Pools and usage -------------------------------------------------------------------------------------

-- The pool of an account or a Home (exactly one argument set), created on first use and locked for
-- the rest of the transaction.
create function private.lock_storage_pool(p_user_id uuid, p_home_id uuid)
returns private.storage_pools
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool private.storage_pools;
  begin
    if num_nonnulls(p_user_id, p_home_id) <> 1 then
      raise exception 'exactly one pool owner' using errcode = '22023';
    end if;
    if p_user_id is not null then
      insert into private.storage_pools (owner_user_id) values (p_user_id)
        on conflict (owner_user_id) do nothing;
      select * into v_pool from private.storage_pools p where p.owner_user_id = p_user_id for update;
    else
      insert into private.storage_pools (owner_home_id) values (p_home_id)
        on conflict (owner_home_id) do nothing;
      select * into v_pool from private.storage_pools p where p.owner_home_id = p_home_id for update;
    end if;
    return v_pool;
  end
  $$;

create function private.storage_allowance(p_pool private.storage_pools) returns bigint
  language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_pool.allowance_bytes,
    (select d.allowance_bytes from private.storage_defaults d
      where d.pool_kind = case when p_pool.owner_user_id is not null then 'personal' else 'home' end)
  );
  $$;

-- Bytes a pool holds: ready files, deleted files still recoverable (spec: they count until purged),
-- and unexpired pending reservations (so a check at request time holds at execution time).
create function private.storage_usage(p_pool_id uuid, p_except_file uuid default null)
returns table (ready_bytes bigint, deleted_bytes bigint, reserved_bytes bigint)
  language sql stable security definer set search_path = '' as $$
  select
    coalesce(sum(f.size_bytes) filter (where f.status = 'ready'), 0)::bigint,
    coalesce(sum(f.size_bytes) filter (where f.status = 'deleted'), 0)::bigint,
    coalesce(sum(f.declared_size) filter (
      where f.status = 'pending' and f.expires_at > pg_catalog.now()
    ), 0)::bigint
  from private.stored_files f
  where f.pool_id = p_pool_id and f.status in ('ready', 'deleted', 'pending')
    and f.id is distinct from p_except_file;
  $$;

-- Who manages a Home's storage: the Owner, or an Administrator granted manageHomeSettings
-- (packages/domain "home.storage.view").
create function private.can_view_home_storage(p_home_id uuid, p_user_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select private.has_home_capability(p_home_id, p_user_id, 'manageHomeSettings');
  $$;

-- Recomputes a pool's warning level from its committed usage (ready + recoverable deleted) and
-- notifies on each upward crossing of 80% or 95%; going below resets the level so a later crossing
-- warns again. Call it with the pool locked.
create function private.storage_reassess(p_pool_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool private.storage_pools;
    v_usage record;
    v_allowance bigint;
    v_used bigint;
    v_level smallint := 0;
    v_kind text;
    v_member record;
  begin
    select * into v_pool from private.storage_pools p where p.id = p_pool_id;
    if not found then
      return;
    end if;
    select * into v_usage from private.storage_usage(p_pool_id);
    v_allowance := private.storage_allowance(v_pool);
    v_used := v_usage.ready_bytes + v_usage.deleted_bytes;
    if v_used > 0 and (v_allowance = 0 or v_used * 100 >= v_allowance * 95) then
      v_level := 95;
    elsif v_used > 0 and v_used * 100 >= v_allowance * 80 then
      v_level := 80;
    end if;
    if v_level = v_pool.warning_level then
      return;
    end if;
    if v_level < v_pool.warning_level then
      update private.storage_pools p set warning_level = v_level where p.id = p_pool_id;
      return;
    end if;

    update private.storage_pools p
      set warning_level = v_level, warning_crossings = p.warning_crossings + 1
      where p.id = p_pool_id
      returning * into v_pool;
    if v_pool.owner_user_id is not null then
      perform private.notify_user(
        v_pool.owner_user_id, null, 'storage',
        case v_level when 95 then 'storage.personal_critical' else 'storage.personal_warning' end,
        pg_catalog.jsonb_build_object('level', v_level),
        'storage:' || v_pool.id || ':' || v_pool.warning_crossings
      );
    else
      for v_member in
        select m.user_id from public.home_memberships m
        where m.home_id = v_pool.owner_home_id
          and private.can_view_home_storage(m.home_id, m.user_id)
      loop
        perform private.notify_user(
          v_member.user_id, v_pool.owner_home_id, 'storage',
          case v_level when 95 then 'storage.home_critical' else 'storage.home_warning' end,
          pg_catalog.jsonb_build_object('level', v_level),
          'storage:' || v_pool.id || ':' || v_pool.warning_crossings
        );
      end loop;
    end if;
  end
  $$;

-- Queues an object for removal and the job that removes it.
create function private.queue_object_deletion(p_key text, p_reason text) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_id uuid;
  begin
    insert into private.storage_object_deletions (object_key, reason) values (p_key, p_reason)
      on conflict on constraint storage_object_deletions_key do nothing
      returning id into v_id;
    if v_id is not null then
      perform private.enqueue_job(
        'storage-object-delete', 1, 'storage-object:' || v_id::text,
        pg_catalog.jsonb_build_object('deletionId', v_id),
        private.request_correlation_id()
      );
    end if;
  end
  $$;

-- A file someone stopped using: still counted and recoverable for 7 days, then purged by a job.
create function private.retire_file(p_file_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    update private.stored_files f
      set status = 'deleted', deleted_at = pg_catalog.now(),
        purge_after = pg_catalog.now() + pg_catalog.make_interval(days => private.storage_limit('recovery_days'))
      where f.id = p_file_id and f.status = 'ready'
      returning * into v_file;
    if found then
      perform private.enqueue_job(
        'storage-file-purge', 1, 'storage-file:' || v_file.id::text || ':purge:' ||
          pg_catalog.to_char(v_file.deleted_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
        pg_catalog.jsonb_build_object('fileId', v_file.id),
        private.request_correlation_id(),
        v_file.purge_after
      );
    end if;
  end
  $$;

-- Retires an avatar file of p_user_id that nothing of theirs uses any more.
create function private.retire_avatar_if_unused(p_user_id uuid, p_file_id uuid) returns void
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_file_id is null then
      return;
    end if;
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

-- A departure deletes the Home profile (S11); its avatar override is no longer used.
create function private.retire_avatar_on_profile_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    perform private.retire_avatar_if_unused(old.user_id, old.avatar_file_id);
    return null;
  end
  $$;

create trigger home_member_profiles_retire_avatar
  after delete on public.home_member_profiles
  for each row when (old.avatar_file_id is not null)
  execute function private.retire_avatar_on_profile_delete();

-- A row that disappears with its account or Home (cascade) queues its objects, so nothing stays in
-- the bucket unnoticed. Whole-account and whole-Home recovery periods come with those steps.
create function private.queue_objects_on_file_delete() returns trigger
  language plpgsql security definer set search_path = '' as $$
  begin
    if old.status <> 'purged' then
      perform private.queue_object_deletion(old.object_key, 'owner_deleted');
    end if;
    if old.status in ('pending', 'failed') then
      perform private.queue_object_deletion(old.upload_key, 'owner_deleted');
    end if;
    return null;
  end
  $$;

create trigger stored_files_queue_objects
  after delete on private.stored_files
  for each row execute function private.queue_objects_on_file_delete();

-- Uploads (the signed-in person) ----------------------------------------------------------------------

-- Opens an upload into the caller's personal pool. Outcomes: 'ok' (with the file id, the key to
-- put the bytes at and when the intent ends), 'storage_full', 'rate_limited', 'conflict' (the
-- request id was used for a different upload). Invalid purpose, type or size: 22023.
create function public.create_upload_intent(
  p_purpose text, p_content_type text, p_size bigint, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
  begin
    if p_request_id is null or p_size is null or p_size <= 0
       or private.upload_max_bytes(p_purpose) is null
       or p_size > private.upload_max_bytes(p_purpose)
       or not private.upload_type_allowed(p_purpose, p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;

    -- The pool lock also serialises one person's concurrent intents, so the checks below hold.
    v_pool := private.lock_storage_pool(v_user_id, null);

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = p_purpose and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.created_at > pg_catalog.now() - interval '1 hour')
         >= private.storage_limit('intents_per_hour')
       or (select count(*) from private.stored_files f
        where f.created_by = v_user_id and f.status = 'pending' and f.expires_at > pg_catalog.now())
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
      v_pool.id, p_purpose, v_user_id, p_request_id, private.new_object_key('u'),
      private.new_object_key('u'), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;

    -- Cleans up after the intent ends, whatever happened to it.
    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', p_purpose, 'size', p_size)
    );

    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;

-- One of the caller's own uploads, for the server to verify before it finalizes. Nobody else's.
create function public.get_my_upload(p_file_id uuid)
returns table (
  purpose text, status text, upload_key text, object_key text, declared_type text,
  declared_size bigint, expires_at timestamptz
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select f.purpose, case
          when f.status = 'pending' and f.expires_at <= pg_catalog.now() then 'expired'
          else f.status
        end,
        f.upload_key, f.object_key, f.declared_type, f.declared_size, f.expires_at
      from private.stored_files f
      where f.id = p_file_id and f.created_by = v_user_id;
  end
  $$;

-- Claims one of the caller's own pending uploads for finalizing, before the server reads and
-- processes its bytes, so the same upload is never processed twice at once and only a few times in
-- all (H1: each attempt costs a download and an image decode). Outcomes: 'claimed', 'busy' (another
-- finalize holds the lease), 'limit' (attempts used up), 'ready' (already finalized), 'expired',
-- 'not_found' (not the caller's, or failed or deleted).
create function public.claim_my_upload(p_file_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = v_user_id
      for update;
    if not found then
      return 'not_found';
    end if;
    if v_file.status = 'ready' then
      return 'ready';
    end if;
    if v_file.status <> 'pending' then
      return 'not_found';
    end if;
    if v_file.expires_at <= pg_catalog.now() then
      return 'expired';
    end if;
    if v_file.claimed_until is not null and v_file.claimed_until > pg_catalog.now() then
      return 'busy';
    end if;
    if v_file.finalize_attempts >= private.storage_limit('finalize_attempts') then
      return 'limit';
    end if;
    update private.stored_files f
      set claimed_until = pg_catalog.now()
          + pg_catalog.make_interval(secs => private.storage_limit('finalize_lease_seconds')),
        finalize_attempts = f.finalize_attempts + 1
      where f.id = v_file.id;
    return 'claimed';
  end
  $$;

-- Gives back the claim on one of the caller's own pending uploads (the bytes were not there yet, or
-- storage could not be reached), so a later attempt may run. Returns whether anything changed.
create function public.release_my_upload(p_file_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    update private.stored_files f set claimed_until = null
      where f.id = p_file_id and f.created_by = v_user_id and f.status = 'pending'
        and f.claimed_until is not null;
    return found;
  end
  $$;

-- Gives up one of the caller's own pending uploads (the server found the bytes wrong: 'mismatch' or
-- 'invalid_image'). Its objects are queued for removal. Returns whether anything changed.
create function public.abandon_my_upload(p_file_id uuid, p_reason text) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_file private.stored_files;
  begin
    if p_reason is null or p_reason not in ('mismatch', 'invalid_image') then
      raise exception 'invalid reason' using errcode = '22023';
    end if;
    update private.stored_files f set status = 'failed', claimed_until = null
      where f.id = p_file_id and f.created_by = v_user_id and f.status = 'pending'
      returning * into v_file;
    if not found then
      return false;
    end if;
    perform private.queue_object_deletion(v_file.upload_key, 'failed');
    perform private.queue_object_deletion(v_file.object_key, 'failed');
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.abandoned', pg_catalog.jsonb_build_object('reason', p_reason)
    );
    return true;
  end
  $$;

-- Finalize (the server only) --------------------------------------------------------------------------

-- Marks p_user_id's pending upload ready with the facts the server verified and the processed
-- object it stored. Only the service role may call this: these facts are trusted. Re-checks
-- ownership, expiry, the stored type and the pool's capacity with the real size, under the pool lock.
-- Outcomes: 'ready', 'not_found' (not theirs, or not pending), 'expired', 'invalid', 'storage_full'.
-- Anything but 'ready' leaves the file failed with its objects queued for removal.
create function public.finalize_upload(
  p_user_id uuid, p_file_id uuid, p_content_type text, p_size bigint, p_sha256 text
) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_outcome text;
  begin
    select * into v_file from private.stored_files f
      where f.id = p_file_id and f.created_by = p_user_id;
    if not found then
      return 'not_found';
    end if;
    -- Pool first, then the file: the same lock order as every other writer.
    select * into v_pool from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'ready' and v_file.sha256 = p_sha256 then
      return 'ready';
    end if;
    if v_file.status <> 'pending' then
      return 'not_found';
    end if;

    if v_file.expires_at <= pg_catalog.now() then
      v_outcome := 'expired';
    elsif p_size is null or p_size <= 0 or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
       or not private.stored_type_allowed(v_file.purpose, p_content_type) then
      v_outcome := 'invalid';
    else
      select * into v_usage from private.storage_usage(v_pool.id, v_file.id);
      if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + p_size
         > private.storage_allowance(v_pool) then
        v_outcome := 'storage_full';
      end if;
    end if;

    if v_outcome is not null then
      update private.stored_files f set status = 'failed', claimed_until = null
        where f.id = v_file.id;
      perform private.queue_object_deletion(v_file.upload_key, 'failed');
      perform private.queue_object_deletion(v_file.object_key, 'failed');
      perform private.audit_stored_file(
        p_user_id, v_file.id, 'stored_file.finalize_refused',
        pg_catalog.jsonb_build_object('outcome', v_outcome)
      );
      return v_outcome;
    end if;

    update private.stored_files f
      set status = 'ready', content_type = p_content_type, size_bytes = p_size, sha256 = p_sha256,
        finalized_at = pg_catalog.now(), claimed_until = null
      where f.id = v_file.id;
    perform private.queue_object_deletion(v_file.upload_key, 'processed');
    perform private.storage_reassess(v_pool.id);
    perform private.audit_stored_file(
      p_user_id, v_file.id, 'stored_file.finalized', pg_catalog.jsonb_build_object('size', p_size)
    );
    return 'ready';
  end
  $$;

-- Avatars ----------------------------------------------------------------------------------------------

-- The caller's ready avatar file, or null: anything else is 'not found' (22023 below).
create function private.own_ready_avatar(p_user_id uuid, p_file_id uuid) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.stored_files f
    join private.storage_pools p on p.id = f.pool_id
    where f.id = p_file_id and f.created_by = p_user_id and p.owner_user_id = p_user_id
      and f.purpose = 'avatar' and f.status = 'ready'
  );
  $$;

-- Sets (or with null removes) the caller's global avatar. Outcomes: 'ok', 'not_found' (the file is
-- not the caller's own ready avatar). The replaced file is retired if nothing else uses it.
create function public.set_my_avatar(p_file_id uuid default null) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_old uuid;
  begin
    perform private.lock_storage_pool(v_user_id, null);
    if p_file_id is not null and not private.own_ready_avatar(v_user_id, p_file_id) then
      return 'not_found';
    end if;
    select up.avatar_file_id into v_old from public.user_preferences up
      where up.user_id = v_user_id for update;
    insert into public.user_preferences (user_id, avatar_file_id) values (v_user_id, p_file_id)
      on conflict (user_id) do update set avatar_file_id = excluded.avatar_file_id;
    if v_old is distinct from p_file_id then
      perform private.retire_avatar_if_unused(v_user_id, v_old);
    end if;
    return 'ok';
  end
  $$;

-- Sets (or with null resets to the global avatar) the caller's avatar in one Home they belong to.
-- Outcomes: 'ok', 'not_found' (not a member, or not the caller's own ready avatar).
create function public.set_my_home_avatar(p_home_id uuid, p_file_id uuid default null) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_old uuid;
  begin
    if p_home_id is null or not private.lock_membership(p_home_id, v_user_id) then
      return 'not_found';
    end if;
    perform private.lock_storage_pool(v_user_id, null);
    if p_file_id is not null and not private.own_ready_avatar(v_user_id, p_file_id) then
      return 'not_found';
    end if;
    select hp.avatar_file_id into v_old from public.home_member_profiles hp
      where hp.home_id = p_home_id and hp.user_id = v_user_id for update;
    insert into public.home_member_profiles (home_id, user_id, avatar_file_id)
      values (p_home_id, v_user_id, p_file_id)
      on conflict (home_id, user_id) do update set avatar_file_id = excluded.avatar_file_id;
    if v_old is distinct from p_file_id then
      perform private.retire_avatar_if_unused(v_user_id, v_old);
    end if;
    return 'ok';
  end
  $$;

-- Reading files ---------------------------------------------------------------------------------------

-- The object behind a file the caller may see now, or no row: the same answer for a file that does
-- not exist, is not ready, or is not theirs to see. Avatars: the person themselves, and current
-- members of a Home in which the file is that person's effective avatar (the Home override, else
-- the global one). A former member, or a member of another Home, gets nothing.
create function public.authorize_file_read(p_file_id uuid)
returns table (object_key text, content_type text, size_bytes bigint, sha256 text)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
  begin
    return query
      select f.object_key, f.content_type, f.size_bytes, f.sha256
      from private.stored_files f
      where f.id = p_file_id and f.status = 'ready' and f.purpose = 'avatar'
        and (
          f.created_by = v_user_id
          or exists (
            select 1
            from public.home_memberships owner_m
            join public.home_memberships viewer_m
              on viewer_m.home_id = owner_m.home_id and viewer_m.user_id = v_user_id
            left join public.home_member_profiles hp
              on hp.home_id = owner_m.home_id and hp.user_id = owner_m.user_id
            left join public.user_preferences up on up.user_id = owner_m.user_id
            where owner_m.user_id = f.created_by
              and coalesce(hp.avatar_file_id, up.avatar_file_id) = f.id
          )
        );
  end
  $$;

-- Usage -------------------------------------------------------------------------------------------------

-- The caller's personal storage: allowance, bytes in use, bytes held by recoverable deleted files,
-- bytes reserved by uploads in progress, and the warning level (0, 80, 95).
create function public.my_storage_usage()
returns table (
  allowance_bytes bigint, used_bytes bigint, deleted_bytes bigint, reserved_bytes bigint,
  warning_level smallint
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pool private.storage_pools;
    v_usage record;
  begin
    select * into v_pool from private.storage_pools p where p.owner_user_id = v_user_id;
    if not found then
      return query select (select d.allowance_bytes from private.storage_defaults d
        where d.pool_kind = 'personal'), 0::bigint, 0::bigint, 0::bigint, 0::smallint;
      return;
    end if;
    select * into v_usage from private.storage_usage(v_pool.id);
    return query select private.storage_allowance(v_pool), v_usage.ready_bytes,
      v_usage.deleted_bytes, v_usage.reserved_bytes, v_pool.warning_level;
  end
  $$;

-- A Home's storage, for its storage managers only (42501 for anyone else, whether or not the Home
-- exists).
create function public.home_storage_usage(p_home_id uuid)
returns table (
  allowance_bytes bigint, used_bytes bigint, deleted_bytes bigint, reserved_bytes bigint,
  warning_level smallint
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_pool private.storage_pools;
    v_usage record;
  begin
    if p_home_id is null or not private.can_view_home_storage(p_home_id, v_user_id) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    select * into v_pool from private.storage_pools p where p.owner_home_id = p_home_id;
    if not found then
      return query select (select d.allowance_bytes from private.storage_defaults d
        where d.pool_kind = 'home'), 0::bigint, 0::bigint, 0::bigint, 0::smallint;
      return;
    end if;
    select * into v_usage from private.storage_usage(v_pool.id);
    return query select private.storage_allowance(v_pool), v_usage.ready_bytes,
      v_usage.deleted_bytes, v_usage.reserved_bytes, v_pool.warning_level;
  end
  $$;

-- Operators (service role, from the SQL Editor): change one pool's allowance (null: back to the
-- default) and reassess its warning. Existing files are never deleted by a lower allowance (spec);
-- the pool simply refuses new files until it has room. Returns false for an unknown owner.
create function public.set_storage_allowance(p_user_id uuid, p_home_id uuid, p_bytes bigint)
returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_pool private.storage_pools;
  begin
    if p_bytes is not null and p_bytes < 0 then
      raise exception 'invalid allowance' using errcode = '22023';
    end if;
    if (p_user_id is not null and not exists (select 1 from auth.users u where u.id = p_user_id))
       or (p_home_id is not null and not exists (select 1 from public.homes h where h.id = p_home_id)) then
      return false;
    end if;
    v_pool := private.lock_storage_pool(p_user_id, p_home_id);
    update private.storage_pools p set allowance_bytes = p_bytes where p.id = v_pool.id;
    perform private.storage_reassess(v_pool.id);
    return true;
  end
  $$;

-- Jobs (service role) -------------------------------------------------------------------------------------

-- storage-upload-expire: after an intent ends, a pending upload becomes failed; a failed one has
-- its objects queued for removal; a ready one has its raw upload queued (in case the server could
-- not delete it), and a ready avatar nobody chose is retired. Idempotent. Returns the file's status
-- afterwards, or 'missing'.
create function public.expire_upload(p_file_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found then
      return 'missing';
    end if;
    -- Pool first, then the file: the same lock order as every other writer.
    perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'pending' and v_file.expires_at <= pg_catalog.now() then
      update private.stored_files f set status = 'failed' where f.id = v_file.id
        returning * into v_file;
    end if;
    if v_file.status = 'failed' then
      perform private.queue_object_deletion(v_file.upload_key, 'expired');
      perform private.queue_object_deletion(v_file.object_key, 'expired');
    elsif v_file.status <> 'pending' then
      perform private.queue_object_deletion(v_file.upload_key, 'processed');
    end if;
    -- A finished avatar that was never chosen (the browser stopped after finalize) would count
    -- forever without being visible anywhere: it is retired like a replaced one (M2).
    if v_file.status = 'ready' and v_file.purpose = 'avatar' then
      perform private.retire_avatar_if_unused(v_file.created_by, v_file.id);
      select * into v_file from private.stored_files f where f.id = p_file_id;
    end if;
    return v_file.status;
  end
  $$;

-- storage-file-purge: a deleted file past its recovery window is purged: the space is released,
-- the warning reassessed and the object queued for removal. A file restored meanwhile (S16) or
-- not yet due is left alone. Returns the status afterwards, or 'missing'.
create function public.purge_stored_file(p_file_id uuid) returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_file private.stored_files;
  begin
    select * into v_file from private.stored_files f where f.id = p_file_id;
    if not found then
      return 'missing';
    end if;
    perform 1 from private.storage_pools p where p.id = v_file.pool_id for update;
    select * into v_file from private.stored_files f where f.id = p_file_id for update;
    if v_file.status = 'deleted' and v_file.purge_after <= pg_catalog.now() then
      update private.stored_files f set status = 'purged' where f.id = v_file.id
        returning * into v_file;
      perform private.queue_object_deletion(v_file.object_key, 'purged');
      perform private.storage_reassess(v_file.pool_id);
    end if;
    return v_file.status;
  end
  $$;

-- storage-object-delete: the key to remove, if still open; then mark it done.
create function public.get_storage_object_deletion(p_deletion_id uuid)
returns table (object_key text, done boolean)
  language sql stable security definer set search_path = '' as $$
  select d.object_key, d.done_at is not null
  from private.storage_object_deletions d where d.id = p_deletion_id;
  $$;

create function public.complete_storage_object_deletion(p_deletion_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    update private.storage_object_deletions d set done_at = pg_catalog.now()
      where d.id = p_deletion_id and d.done_at is null;
    return found;
  end
  $$;

-- Health for the runbook: open deletions and the oldest one.
create function public.storage_stats()
returns table (open_deletions bigint, oldest_open_deletion_seconds integer, pending_uploads bigint)
  language sql stable security definer set search_path = '' as $$
  select
    (select count(*) from private.storage_object_deletions d where d.done_at is null),
    (select extract(epoch from pg_catalog.now() - min(d.created_at))::integer
      from private.storage_object_deletions d where d.done_at is null),
    (select count(*) from private.stored_files f where f.status = 'pending');
  $$;

-- Notifications: storage warnings ------------------------------------------------------------------------

-- A new essential category: storage warnings are in-app only (spec "Confirmed progressive storage
-- warnings"), sent once per crossing, and not something to mute (brief S15, owner may change).
create or replace function private.notification_category_essential(p_category text) returns boolean
  language sql immutable set search_path = '' as $$
  select case p_category
    when 'security' then true when 'storage' then true when 'invitations' then false
  end;
  $$;

alter table public.notifications drop constraint notifications_category_check;
alter table public.notifications add constraint notifications_category_check
  check (category in ('security', 'invitations', 'storage'));

-- Members ----------------------------------------------------------------------------------------------

-- The directory (S11) gains each member's effective avatar file id (the Home override, else the
-- global one). The file itself is still authorized on every view (authorize_file_read).
drop function public.home_directory(uuid);
create function public.home_directory(p_home_id uuid)
returns table (
  membership_id uuid,
  role text,
  joined_at timestamptz,
  is_self boolean,
  name text,
  accent_color text,
  avatar_file_id uuid
)
  language plpgsql stable security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
  begin
    if v_user_id is null or p_home_id is null or not exists (
      select 1 from public.home_memberships m
      where m.home_id = p_home_id and m.user_id = v_user_id
    ) then
      raise exception 'not a member of this Home' using errcode = '42501';
    end if;

    return query
      select
        m.id,
        m.role,
        m.created_at,
        m.user_id = v_user_id,
        coalesce(p.nickname, p.display_name, up.display_name),
        coalesce(p.accent_color, up.accent_color),
        coalesce(p.avatar_file_id, up.avatar_file_id)
      from public.home_memberships m
      left join public.home_member_profiles p
        on p.home_id = m.home_id and p.user_id = m.user_id
      left join public.user_preferences up on up.user_id = m.user_id
      where m.home_id = p_home_id
      order by m.created_at, m.id;
  end
  $$;

comment on function public.home_directory(uuid) is
  'S11/S15: the members of a Home the caller belongs to, with effective name, colour and avatar file id.';

-- Grants ---------------------------------------------------------------------------------------------------

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'public.home_directory(uuid)',
    'public.create_upload_intent(text, text, bigint, uuid)',
    'public.get_my_upload(uuid)',
    'public.claim_my_upload(uuid)',
    'public.release_my_upload(uuid)',
    'public.abandon_my_upload(uuid, text)',
    'public.set_my_avatar(uuid)',
    'public.set_my_home_avatar(uuid, uuid)',
    'public.authorize_file_read(uuid)',
    'public.my_storage_usage()',
    'public.home_storage_usage(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_function);
    execute format('grant execute on function %s to authenticated', v_function);
  end loop;

  -- Trusted facts and jobs: the service role only.
  foreach v_function in array array[
    'public.finalize_upload(uuid, uuid, text, bigint, text)',
    'public.set_storage_allowance(uuid, uuid, bigint)',
    'public.expire_upload(uuid)',
    'public.purge_stored_file(uuid)',
    'public.get_storage_object_deletion(uuid)',
    'public.complete_storage_object_deletion(uuid)',
    'public.storage_stats()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end
$$;

-- Private helpers stay closed to the API roles (tests/db/rls/baseline.test.sql).
do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'private.upload_max_bytes(text)',
    'private.upload_type_allowed(text, text)',
    'private.stored_type_allowed(text, text)',
    'private.storage_limit(text)',
    'private.new_object_key(text)',
    'private.lock_storage_pool(uuid, uuid)',
    'private.storage_allowance(private.storage_pools)',
    'private.storage_usage(uuid, uuid)',
    'private.can_view_home_storage(uuid, uuid)',
    'private.storage_reassess(uuid)',
    'private.queue_object_deletion(text, text)',
    'private.retire_file(uuid)',
    'private.retire_avatar_if_unused(uuid, uuid)',
    'private.retire_avatar_on_profile_delete()',
    'private.queue_objects_on_file_delete()',
    'private.own_ready_avatar(uuid, uuid)',
    'private.audit_stored_file(uuid, uuid, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end
$$;
