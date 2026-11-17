-- Review backlog Part 2 (api, jobs, perf): S35-M1, S27-M2, S29-M1, S20-M3, S38-M3.
-- Rollback: re-apply the replaced function bodies from their original migrations; the added column
-- and functions are unused by older bodies and may stay.

-- S35-M1: a batch import of pictures needs more room than the shared S15 limits (30 intents an hour,
-- 5 pending) give. Photo uploads get their own limits and their own count: photos never use up the
-- room of other uploads (a task attachment after a large import), nor other uploads the photos'.
-- Storage capacity is still checked per pool.
create function private.photo_upload_limit(p_name text) returns integer
  language sql immutable set search_path = '' as $$
  select case p_name
    when 'intents_per_hour' then 120
    when 'pending_per_account' then 25
  end
  $$;

revoke all on function private.photo_upload_limit(text) from public, anon, authenticated;

-- Whether p_user_id has reached the upload limits of p_purpose's group: photos, or every other
-- purpose together. Callers hold the pool lock, which serialises one person's intents.
create function private.upload_rate_limited(p_user_id uuid, p_purpose text) returns boolean
  language sql stable set search_path = '' as $$
  select (select pg_catalog.count(*) from private.stored_files f
      where f.created_by = p_user_id and (f.purpose = 'photo') = (p_purpose = 'photo')
        and f.created_at > pg_catalog.now() - interval '1 hour')
      >= case when p_purpose = 'photo' then private.photo_upload_limit('intents_per_hour')
           else private.storage_limit('intents_per_hour') end
    or (select pg_catalog.count(*) from private.stored_files f
      where f.created_by = p_user_id and (f.purpose = 'photo') = (p_purpose = 'photo')
        and f.status = 'pending' and f.expires_at > pg_catalog.now())
      >= case when p_purpose = 'photo' then private.photo_upload_limit('pending_per_account')
           else private.storage_limit('pending_per_account') end
  $$;

revoke all on function private.upload_rate_limited(uuid, text) from public, anon, authenticated;


create or replace function private.open_photo_upload(
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

    if private.upload_rate_limited(p_user_id, 'photo') then
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


-- The shared S15 openers count every upload except photos (S35-M1).
create or replace function public.create_upload_intent(
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

    if private.upload_rate_limited(v_user_id, p_purpose) then
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


create or replace function public.create_task_attachment_intent(
  p_task_id uuid, p_content_type text, p_size bigint, p_name text, p_request_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_task private.tasks;
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text;
  begin
    if p_task_id is null or p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('task_attachment')
       or not private.upload_type_allowed('task_attachment', p_content_type)
       or p_name is null or not private.is_visible_name(p_name, private.task_limit('attachment_name')) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    -- Task first, then the pool: the same order as deleting a task (which then moves files).
    v_task := private.lock_task(p_task_id, v_user_id);
    if v_task.id is null then
      return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    if not private.can_edit_task(v_task, v_user_id) then
      return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;
    v_pool := private.lock_storage_pool(v_task.owner_user_id, v_task.owner_home_id);

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'task_attachment' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() and exists (
           select 1 from private.task_attachment_uploads u
           where u.file_id = v_existing.id and u.task_id = v_task.id) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if private.task_attachment_count(v_task.id) + (
         select count(*)::integer from private.task_attachment_uploads u
         join private.stored_files f on f.id = u.file_id
         where u.task_id = v_task.id
           and (f.status = 'ready' or (f.status = 'pending' and f.expires_at > pg_catalog.now()))
       ) >= private.task_limit('attachments') then
      return query select 'limit_reached'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    if private.upload_rate_limited(v_user_id, 'task_attachment') then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    select * into v_usage from private.storage_usage(v_pool.id);
    if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + p_size
       > private.storage_allowance(v_pool) then
      return query select 'storage_full'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    v_prefix := case when v_task.owner_home_id is not null then 'h' else 'u' end;
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'task_attachment', v_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    insert into private.task_attachment_uploads (file_id, task_id, display_name)
      values (v_file.id, v_task.id, p_name);

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'task_attachment', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;


create or replace function public.create_recipe_cover_intent(
  p_content_type text, p_size bigint, p_request_id uuid, p_recipe_id uuid default null,
  p_lock_token uuid default null
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_recipe private.recipes;
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
    v_prefix text;
  begin
    if p_request_id is null or p_size is null or p_size <= 0
       or p_size > private.upload_max_bytes('recipe_cover')
       or not private.upload_type_allowed('recipe_cover', p_content_type) then
      raise exception 'invalid upload' using errcode = '22023';
    end if;
    if p_recipe_id is not null then
      -- Recipe first, then the pool: the same order as saving and deleting.
      v_recipe := private.lock_recipe(p_recipe_id, v_user_id);
      if v_recipe.id is null then
        return query select 'not_found'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      if not private.can_edit_recipe(v_recipe, v_user_id) then
        return query select 'not_permitted'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      if v_recipe.status = 'published'
         and (p_lock_token is null or not private.holds_recipe_lock(v_recipe.id, v_user_id, p_lock_token)) then
        return query select 'lock_lost'::text, null::uuid, null::text, null::timestamptz;
        return;
      end if;
      v_pool := private.recipe_pool(v_recipe);
    else
      v_pool := private.lock_storage_pool(v_user_id, null);
    end if;

    select * into v_existing from private.stored_files f
      where f.created_by = v_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = 'recipe_cover' and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now() and exists (
           select 1 from private.recipe_cover_uploads u
           where u.file_id = v_existing.id and u.recipe_id is not distinct from v_recipe.id) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if private.upload_rate_limited(v_user_id, 'recipe_cover') then
      return query select 'rate_limited'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    select * into v_usage from private.storage_usage(v_pool.id);
    if v_usage.ready_bytes + v_usage.deleted_bytes + v_usage.reserved_bytes + p_size
       > private.storage_allowance(v_pool) then
      return query select 'storage_full'::text, null::uuid, null::text, null::timestamptz;
      return;
    end if;

    v_prefix := case when v_pool.owner_home_id is not null then 'h' else 'u' end;
    insert into private.stored_files (
      pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type,
      declared_size, expires_at
    ) values (
      v_pool.id, 'recipe_cover', v_user_id, p_request_id, private.new_object_key(v_prefix),
      private.new_object_key(v_prefix), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;
    insert into private.recipe_cover_uploads (file_id, user_id, recipe_id)
      values (v_file.id, v_user_id, v_recipe.id);

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      v_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', 'recipe_cover', 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;


create or replace function private.open_pet_upload(
  p_user_id uuid, p_home_id uuid, p_purpose text, p_content_type text, p_size bigint, p_request_id uuid,
  p_pet_id uuid, p_entry_id uuid
) returns table (outcome text, file_id uuid, upload_key text, expires_at timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_existing private.stored_files;
    v_pool private.storage_pools;
    v_usage record;
    v_file private.stored_files;
  begin
    v_pool := private.lock_storage_pool(null, p_home_id);
    select * into v_existing from private.stored_files f
      where f.created_by = p_user_id and f.request_id = p_request_id;
    if found then
      if v_existing.purpose = p_purpose and v_existing.declared_type = p_content_type
         and v_existing.declared_size = p_size and v_existing.status = 'pending'
         and v_existing.expires_at > pg_catalog.now()
         and (exists (select 1 from private.pet_photo_uploads u
                where u.file_id = v_existing.id and u.pet_id = p_pet_id and p_entry_id is null)
           or exists (select 1 from private.pet_medical_attachment_uploads u
                where u.file_id = v_existing.id and u.entry_id = p_entry_id)) then
        return query select 'ok'::text, v_existing.id, v_existing.upload_key, v_existing.expires_at;
      else
        return query select 'conflict'::text, null::uuid, null::text, null::timestamptz;
      end if;
      return;
    end if;

    if private.upload_rate_limited(p_user_id, p_purpose) then
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
      v_pool.id, p_purpose, p_user_id, p_request_id, private.new_object_key('h'),
      private.new_object_key('h'), p_content_type, p_size,
      pg_catalog.now() + pg_catalog.make_interval(mins => private.storage_limit('intent_minutes'))
    ) returning * into v_file;

    perform private.enqueue_job(
      'storage-upload-expire', 1, 'storage-file:' || v_file.id::text || ':expire',
      pg_catalog.jsonb_build_object('fileId', v_file.id),
      private.request_correlation_id(),
      v_file.expires_at + interval '5 minutes'
    );
    perform private.audit_stored_file(
      p_user_id, v_file.id, 'stored_file.upload_intent',
      pg_catalog.jsonb_build_object('purpose', p_purpose, 'size', p_size)
    );
    return query select 'ok'::text, v_file.id, v_file.upload_key, v_file.expires_at;
  end
  $$;


create or replace function public.copy_meal_week(
  p_source date, p_destination date, p_token text, p_rows jsonb, p_home_id uuid default null
) returns table (outcome text, results jsonb)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_ids uuid[];
    v_rows jsonb;
    v_choice jsonb;
    v_row jsonb;
    v_id uuid;
    v_existing private.meal_entries;
    v_results jsonb := '[]'::jsonb;
    v_result text;
    v_occupants jsonb;
    v_retry boolean;
    v_created integer;
  begin
    perform private.require_meal_context(p_home_id, v_user_id);
    if not private.is_meal_date(p_source) or not private.is_meal_date(p_destination)
       or p_source = p_destination or (p_destination - p_source) % 7 <> 0
       or p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array'
       or pg_catalog.jsonb_array_length(p_rows) not between 1 and private.meal_limit('copy_rows')
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_rows) x
         where pg_catalog.jsonb_typeof(x) <> 'object'
           or coalesce(x ->> 'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or pg_catalog.jsonb_typeof(x -> 'key') is distinct from 'string'
           or coalesce(pg_catalog.jsonb_typeof(x -> 'replace'), 'boolean') <> 'boolean') then
      raise exception 'invalid request' using errcode = '22023';
    end if;
    if not private.meal_may(p_home_id, v_user_id, 'edit') then
      return query select 'not_permitted', null::jsonb;
      return;
    end if;
    perform private.lock_meal_context(p_home_id, v_user_id);
    select array_agg((x ->> 'id')::uuid) into v_ids from pg_catalog.jsonb_array_elements(p_rows) x;
    v_rows := private.meal_copy_rows(p_home_id, v_user_id, p_source, p_destination, v_ids);
    -- S27-M2: a retry of a copy that replaced something no longer sees what it replaced, so its
    -- token cannot match. When at least one chosen id is already this person's own copy in this
    -- context (the first call is one transaction, so it finished), the call is a retry: those rows
    -- answer 'exists' and the others are reported again but never written with an out-of-date
    -- preview. Without such a copy a changed preview is stale and copies nothing.
    v_retry := p_token is distinct from private.meal_copy_token(v_rows);
    if v_retry and not exists (
        select 1 from private.meal_entries e
        where e.id = any (v_ids) and e.created_by = v_user_id and e.deleted_at is null
          and private.in_meal_context(e.owner_user_id, e.owner_home_id, p_home_id, v_user_id)) then
      return query select 'stale', null::jsonb;
      return;
    end if;
    for v_choice in select * from pg_catalog.jsonb_array_elements(p_rows) loop
      v_id := (v_choice ->> 'id')::uuid;
      select x into v_row from pg_catalog.jsonb_array_elements(v_rows) x where x ->> 'key' = v_choice ->> 'key';
      select * into v_existing from private.meal_entries e where e.id = v_id;
      v_result := case
        when v_existing.id is not null then
          case when v_existing.created_by = v_user_id and v_existing.deleted_at is null
            and private.in_meal_context(v_existing.owner_user_id, v_existing.owner_home_id, p_home_id, v_user_id)
            then 'exists' else 'id_taken' end
        when v_row is null then 'missing'
        when v_row ->> 'status' = 'unavailable' then 'unavailable'
        when v_row ->> 'status' = 'slot_disabled' then 'slot_unavailable'
      end;
      if v_result is null then
        -- What is there now (unchanged since the preview, by the token, except this copy's own rows):
        -- a meal this copy just made is never replaced; anything else only when the row says so.
        v_occupants := private.meal_occupants(p_home_id, v_user_id, (v_row ->> 'date')::date,
          (v_row ->> 'slotId')::uuid);
        if v_retry then
          -- A row the first call did not copy: still taken, or changed since the preview.
          v_result := 'stale';
          if pg_catalog.jsonb_array_length(v_occupants) > 0 then
            v_result := 'occupied';
          end if;
        elsif pg_catalog.jsonb_array_length(v_occupants) > 0 then
          if not coalesce((v_choice ->> 'replace')::boolean, false) or exists (
              select 1 from pg_catalog.jsonb_array_elements(v_occupants) o
              where o ->> 'kind' = 'entry' and (o ->> 'id')::uuid = any (v_ids)) then
            v_result := 'occupied';
          else
            perform private.meal_clear_occupants(p_home_id, v_user_id, v_occupants);
          end if;
        end if;
      end if;
      if v_result is null then
        insert into private.meal_entries (
          id, owner_user_id, owner_home_id, on_date, slot_id, recipe_id, is_recipe, title, notes, servings,
          created_by, updated_by
        ) values (
          v_id, case when p_home_id is null then v_user_id end, p_home_id, (v_row ->> 'date')::date,
          (v_row ->> 'slotId')::uuid, (v_row -> 'recipe' ->> 'id')::uuid, v_row ->> 'type' = 'recipe',
          v_row ->> 'title', v_row ->> 'notes', (v_row ->> 'servings')::smallint, v_user_id, v_user_id
        );
        v_result := 'created';
      end if;
      v_results := v_results || pg_catalog.jsonb_build_object('key', v_choice ->> 'key', 'id', v_id, 'outcome', v_result);
      v_row := null;
      v_existing := null;
    end loop;
    -- A retry that creates nothing is not another copy (review L5).
    select count(*)::integer into v_created
      from pg_catalog.jsonb_array_elements(v_results) x where x ->> 'outcome' = 'created';
    if v_created > 0 then
      perform private.audit_meals('meal_plan.week_copied', p_home_id, p_home_id, pg_catalog.jsonb_build_object(
        'source', p_source, 'destination', p_destination, 'created', v_created));
    end if;
    return query select 'done', v_results;
  end
  $$;


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


-- S20-M3: the base of the advance_chores wrappers (pool, volunteers, vacations).
create or replace function private.advance_chores_before_pool(p_home_id uuid) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_user_id uuid := private.require_confirmed_caller();
    v_today date;
    v_chore_id uuid;
    v_chore private.chores;
    v_part private.chore_schedules;
    v_created integer := 0;
  begin
    perform private.require_chore_home(p_home_id, v_user_id);
    v_today := private.task_today(p_home_id, null);
    -- Locked one chore at a time, chore before part (the order every change uses), so two page loads
    -- queue instead of creating anything twice.
    for v_chore_id in
      select s.chore_id from private.chore_schedules s
      join private.chores c on c.id = s.chore_id
      where s.home_id = p_home_id and s.superseded_at is null and s.next_date is not null
        and (s.last_date is null or s.last_date <= v_today)
        and c.deleted_at is null and c.ended_at is null
        -- S20-M3: an open-ended pause that has started creates nothing, so it must not take a slot
        -- (and starve chores behind it) on every call.
        and not (s.paused_from is not null and s.paused_until is null and s.next_date >= s.paused_from)
      order by s.last_date nulls first, s.id
      limit private.chore_limit('parts_per_advance')
    loop
      select * into v_chore from private.chores c where c.id = v_chore_id for update;
      if v_chore.deleted_at is null and v_chore.ended_at is null then
        v_part := private.chore_head(v_chore.id);
        v_created := v_created + private.advance_chore_part(v_part, v_today);
      end if;
    end loop;
    return v_created;
  end
  $$;


-- S38-M3: the report's rows are frozen when it is requested, so rows written later (a history
-- sweep may backfill earlier times) never change a report that was already offered. The copy keeps
-- to the history's retention: rows past it are left out at download, and the copy is cleared when
-- the report is discarded or expires (the hourly purge).
alter table private.security_reports add column rows jsonb;

comment on table private.security_reports is
  'S38: requested security reports. The security events in range are frozen into rows at the request, '
  'left out at download once past the history retention, and cleared when the report is discarded or '
  'expires; the file is built at download, never stored.';
comment on column private.security_reports.rows is
  'The security events of the report, frozen at the request; null once discarded or expired, and for '
  'reports made before it existed (those read the history at download).';


create or replace function public.request_security_report(p_from date, p_to date, p_timezone text)
returns uuid
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_today date;
    v_earliest date;
    v_id uuid;
    v_snapshot timestamptz;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    if p_timezone is null or pg_catalog.char_length(p_timezone) > 64
       or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
      raise exception 'invalid timezone' using errcode = '22023';
    end if;
    v_today := (pg_catalog.now() at time zone p_timezone)::date;
    v_earliest := ((pg_catalog.now() - private.activity_retention()) at time zone p_timezone)::date;
    if p_from is null or p_to is null or p_from > p_to or p_from < v_earliest or p_to > v_today then
      raise exception 'invalid range' using errcode = '22023';
    end if;
    perform private.lock_sign_in_methods(v_user_id);
    if not private.has_account_change_grant(v_user_id, 'security_report', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    if (select pg_catalog.count(*) from private.security_reports r
        where r.user_id = v_user_id and r.created_at > pg_catalog.now() - interval '24 hours')
       >= private.security_report_daily_limit() then
      raise exception 'too many reports' using errcode = '54000', hint = 'rate_limited';
    end if;
    -- clock_timestamp: the snapshot is fixed before the request is recorded, so the report never
    -- contains its own request.
    v_snapshot := pg_catalog.clock_timestamp();
    insert into private.security_reports (user_id, range_from, range_to, timezone, snapshot_at, expires_at, rows)
      values (v_user_id, p_from, p_to, p_timezone, v_snapshot,
              pg_catalog.now() + private.security_report_lifetime(),
              (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                  'kind', a.kind, 'outcome', a.outcome, 'home_name', a.home_name, 'actor', a.actor,
                  'device_kind', a.device_kind, 'browser', a.browser, 'platform', a.platform,
                  'created_at', a.created_at) order by a.created_at, a.id), '[]'::jsonb)
               from private.account_activity_events a
               where a.user_id = v_user_id and a.category = 'security'
                 and a.created_at >= (p_from::timestamp at time zone p_timezone)
                 and a.created_at < ((p_to + 1)::timestamp at time zone p_timezone)
                 and a.created_at < v_snapshot
                 and a.created_at > pg_catalog.now() - private.activity_retention()))
      returning id into v_id;
    insert into private.account_security_events (user_id, kind, session_id, created_at)
      values (v_user_id, 'security_report_requested', v_session_id, pg_catalog.clock_timestamp());
    perform private.notify_user(
      v_user_id, null, 'security', 'account.security_report_ready', '{}'::jsonb,
      'account.security_report_ready:' || v_id::text, true);
    return v_id;
  end
  $$;


create or replace function public.security_report_rows(p_report_id uuid)
returns table (
  kind text, outcome text, home_name text, actor text, device_kind text, browser text,
  platform text, created_at timestamptz
)
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_session_id uuid := private.jwt_session_id();
    v_report private.security_reports;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, v_session_id) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    select * into v_report from private.security_reports r
      where r.id = p_report_id and r.user_id = v_user_id;
    if v_report.id is null or private.report_status(v_report) <> 'ready' then
      raise exception 'report not available' using errcode = 'P0002';
    end if;
    if not private.has_account_change_grant(v_user_id, 'security_report', v_session_id) then
      raise exception 'recent reauthentication required'
        using errcode = '42501', hint = 'reauthentication_required';
    end if;
    update private.security_reports r set downloaded_at = pg_catalog.now() where r.id = v_report.id;
    -- clock_timestamp: always after the snapshot, even inside the request's own transaction.
    insert into private.account_security_events (user_id, kind, session_id, created_at)
      values (v_user_id, 'security_report_downloaded', v_session_id, pg_catalog.clock_timestamp());
    -- The rows frozen at the request, in their order and within retention; a report made before
    -- they were kept falls back to the history.
    if v_report.rows is not null then
      return query
        select e.r ->> 'kind', e.r ->> 'outcome', e.r ->> 'home_name', e.r ->> 'actor',
          e.r ->> 'device_kind', e.r ->> 'browser', e.r ->> 'platform', (e.r ->> 'created_at')::timestamptz
        from pg_catalog.jsonb_array_elements(v_report.rows) with ordinality as e(r, n)
        where (e.r ->> 'created_at')::timestamptz > pg_catalog.now() - private.activity_retention()
        order by e.n;
      return;
    end if;
    return query
      select a.kind, a.outcome, a.home_name, a.actor, a.device_kind, a.browser, a.platform, a.created_at
      from private.account_activity_events a
      where a.user_id = v_user_id and a.category = 'security'
        and a.created_at >= (v_report.range_from::timestamp at time zone v_report.timezone)
        and a.created_at < ((v_report.range_to + 1)::timestamp at time zone v_report.timezone)
        and a.created_at < v_report.snapshot_at
        and a.created_at > pg_catalog.now() - private.activity_retention()
      order by a.created_at, a.id;
  end
  $$;


-- S38-M3: discarding a report also drops its frozen rows.
create or replace function public.discard_security_report(p_report_id uuid) returns boolean
  language plpgsql security definer set search_path = '' as $$
  declare
    v_user_id uuid := auth.uid();
    v_found boolean;
  begin
    if v_user_id is null or not private.session_is_live(v_user_id, private.jwt_session_id()) then
      raise exception 'not signed in' using errcode = '42501';
    end if;
    update private.security_reports r set discarded_at = pg_catalog.now(), rows = null
      where r.id = p_report_id and r.user_id = v_user_id and r.discarded_at is null
        and r.expires_at > pg_catalog.now()
      returning true into v_found;
    if coalesce(v_found, false) then
      perform private.record_security_event(v_user_id, 'security_report_discarded', private.jwt_session_id());
    end if;
    return coalesce(v_found, false);
  end
  $$;


-- S38-M3: the hourly purge also drops the frozen rows of reports that expired or were discarded
-- (the report record itself still goes a week after it expired).
create or replace function public.purge_account_activity() returns integer
  language plpgsql security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    delete from private.account_activity_events a
      where a.created_at < pg_catalog.now() - private.activity_retention();
    get diagnostics v_count = row_count;
    delete from private.account_security_events e
      where e.created_at < pg_catalog.now() - private.activity_retention();
    update private.security_reports r set rows = null
      where r.rows is not null and (r.expires_at <= pg_catalog.now() or r.discarded_at is not null);
    delete from private.security_reports r
      where r.expires_at < pg_catalog.now() - interval '7 days';
    return v_count;
  end
  $$;
