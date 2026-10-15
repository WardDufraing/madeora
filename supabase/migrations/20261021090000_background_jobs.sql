-- S13: background jobs (brief S13; architecture.md §11, §22; ADR 0017).
--
-- Transactional outbox. Business functions call private.enqueue_job() inside their own
-- transaction, so a job row exists exactly when the business change committed. A dispatcher that
-- runs inside Trigger.dev claims due rows, triggers one task run per row and records the outcome.
-- Each run then claims its execution here, so a duplicate run of the same idempotency key is
-- skipped and two runs never execute one key at the same time.
--
-- Access: no API role (anon, authenticated, service_role) can read or write the two tables. The
-- dispatcher and the job runs use the service role, which may only execute the functions below;
-- every function validates its arguments and stores short error codes, never messages. Payloads
-- hold ids only (packages/jobs/src/definition.ts).
--
-- No retention or purge here: the product specification leaves retention periods open. The health
-- counts read only through partial indexes or a bounded time window, so they stay cheap as the
-- history grows.

-- Outbox --------------------------------------------------------------------------------------------

create table private.job_outbox (
  id uuid primary key default gen_random_uuid(),
  job_name text not null
    constraint job_outbox_job_name_check
    check (job_name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(job_name) <= 64),
  job_version smallint not null constraint job_outbox_job_version_check
    check (job_version between 1 and 1000),
  idempotency_key text not null constraint job_outbox_idempotency_key_check
    check (idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  payload jsonb not null constraint job_outbox_payload_check
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  -- A random UUID v4, as the app generates them (packages/observability) and gen_random_uuid() does;
  -- the dispatcher refuses any other shape, so the table does too.
  correlation_id uuid not null constraint job_outbox_correlation_id_check
    check (correlation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  status text not null default 'pending' constraint job_outbox_status_check
    check (status in ('pending', 'dispatching', 'dispatched', 'dead')),
  -- Dispatch attempts, counted when a row is claimed.
  attempts smallint not null default 0 constraint job_outbox_attempts_check check (attempts >= 0),
  -- Raised by each manual requeue, so Trigger.dev sees a new idempotency key.
  generation smallint not null default 0
    constraint job_outbox_generation_check check (generation >= 0),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  trigger_run_id text constraint job_outbox_trigger_run_id_check
    check (trigger_run_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  last_error_code text constraint job_outbox_last_error_code_check
    check (last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  dispatched_at timestamptz,
  constraint job_outbox_key unique (job_name, idempotency_key),
  constraint job_outbox_lease_check check ((status = 'dispatching') = (lease_until is not null))
);

comment on table private.job_outbox is
  'Transactional outbox for background jobs (S13, ADR 0017). Service-role functions only.';

-- Due rows, oldest first: pending ones by available_at, claimed ones by lease expiry.
create index job_outbox_due_idx on private.job_outbox (available_at)
  where status = 'pending';
create index job_outbox_lease_idx on private.job_outbox (lease_until)
  where status = 'dispatching';
-- For the health counts (public.job_outbox_stats).
create index job_outbox_dead_idx on private.job_outbox (updated_at) where status = 'dead';
create index job_outbox_dispatched_idx on private.job_outbox (dispatched_at)
  where status = 'dispatched';

-- Executions ----------------------------------------------------------------------------------------

create table private.job_executions (
  job_name text not null constraint job_executions_job_name_check
    check (job_name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(job_name) <= 64),
  idempotency_key text not null constraint job_executions_idempotency_key_check
    check (idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  status text not null constraint job_executions_status_check
    check (status in ('running', 'succeeded', 'failed_retryable', 'failed_permanent')),
  attempts integer not null constraint job_executions_attempts_check check (attempts >= 1),
  -- Identifies the run holding the execution; only that run may record the outcome.
  claim_token uuid,
  lease_until timestamptz,
  last_error_code text constraint job_executions_last_error_code_check
    check (last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (job_name, idempotency_key),
  constraint job_executions_running_check
    check ((status = 'running') = (claim_token is not null and lease_until is not null))
);

comment on table private.job_executions is
  'One row per job idempotency key: claims, outcomes and attempts (S13). Service-role functions only.';

-- For the health counts: executions that failed, and running ones whose lease ran out.
create index job_executions_failed_idx on private.job_executions (finished_at)
  where status in ('failed_retryable', 'failed_permanent');
create index job_executions_running_idx on private.job_executions (lease_until)
  where status = 'running';

-- Neither table is reachable through the Data API: schema private is not exposed and the API roles
-- have no usage on it. RLS without policies and revoked grants keep it so even if that changes.
alter table private.job_outbox enable row level security;
alter table private.job_executions enable row level security;
revoke all on private.job_outbox, private.job_executions from public, anon, authenticated, service_role;

-- Shared argument checks ----------------------------------------------------------------------------

create function private.check_job_error_code(p_code text) returns text
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_code is null or p_code !~ '^[a-z0-9_.-]{1,64}$' then
      raise exception 'invalid error code' using errcode = '22023';
    end if;
    return p_code;
  end
  $$;

-- Dispatch attempts before an outbox row is dead (packages/jobs/src/testing/fake-store.ts mirrors it).
create function private.job_outbox_max_attempts() returns integer
  language sql immutable set search_path = '' as $$ select 8 $$;

create function private.check_lease_seconds(p_seconds integer) returns interval
  language plpgsql immutable set search_path = '' as $$
  begin
    if p_seconds is null or p_seconds not between 10 and 3600 then
      raise exception 'lease must be 10 to 3600 seconds' using errcode = '22023';
    end if;
    return make_interval(secs => p_seconds);
  end
  $$;

-- Enqueue (inside business transactions) ------------------------------------------------------------

-- Adds a job to the outbox in the caller's transaction and returns its id. The same job name,
-- idempotency key and payload return the existing row unchanged, so a retried request never
-- enqueues twice. The same key with a different payload is a programming error (one key, one piece
-- of work) and raises 23505, rolling back the caller's transaction. Security invoker and executable
-- by no API role: only migrations, security definer business functions (running as their owner)
-- and the SQL Editor call it.
create function private.enqueue_job(
  p_job_name text,
  p_job_version integer,
  p_idempotency_key text,
  p_payload jsonb,
  p_correlation_id uuid default null,
  p_available_at timestamptz default null
) returns uuid
  language plpgsql volatile security invoker set search_path = '' as $$
  declare
    v_id uuid;
    v_payload jsonb;
  begin
    insert into private.job_outbox (
      job_name, job_version, idempotency_key, payload, correlation_id, available_at
    )
    values (
      p_job_name, p_job_version, p_idempotency_key, p_payload,
      coalesce(p_correlation_id, gen_random_uuid()), coalesce(p_available_at, now())
    )
    on conflict on constraint job_outbox_key do nothing
    returning id into v_id;
    if v_id is null then
      select o.id, o.payload into v_id, v_payload
      from private.job_outbox o
      where o.job_name = p_job_name and o.idempotency_key = p_idempotency_key;
      if v_payload is distinct from p_payload then
        raise exception 'job % key reused with a different payload', p_job_name
          using errcode = '23505';
      end if;
    end if;
    return v_id;
  end
  $$;

-- Dispatcher (service role) -------------------------------------------------------------------------

-- Claims up to p_limit due rows for p_lease_seconds and returns them. Due: pending and available,
-- or claimed by a dispatcher whose lease ran out (it crashed). SKIP LOCKED means concurrent
-- dispatchers never get the same row. A crashed-claim row that has used every attempt is dead.
create function public.claim_job_outbox(p_limit integer, p_lease_seconds integer)
  returns table (
    id uuid,
    job_name text,
    job_version integer,
    idempotency_key text,
    payload jsonb,
    correlation_id uuid,
    attempts integer,
    generation integer
  )
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_lease interval := private.check_lease_seconds(p_lease_seconds);
  begin
    if p_limit is null or p_limit not between 1 and 100 then
      raise exception 'limit must be 1 to 100' using errcode = '22023';
    end if;

    -- The same attempt limit as private.fail_job_outbox, for rows whose claim expired.
    update private.job_outbox o
    set status = 'dead', lease_until = null, last_error_code = 'lease_expired', updated_at = now()
    where o.status = 'dispatching' and o.lease_until <= now()
      and o.attempts >= private.job_outbox_max_attempts();

    return query
    with due as (
      select o.id
      from private.job_outbox o
      where (o.status = 'pending' and o.available_at <= now())
         or (o.status = 'dispatching' and o.lease_until <= now())
      order by coalesce(o.lease_until, o.available_at), o.created_at
      limit p_limit
      for update skip locked
    )
    update private.job_outbox o
    set status = 'dispatching',
        attempts = o.attempts + 1,
        lease_until = now() + v_lease,
        updated_at = now()
    from due
    where o.id = due.id
    returning o.id, o.job_name, o.job_version::integer, o.idempotency_key, o.payload,
      o.correlation_id, o.attempts::integer, o.generation::integer;
  end
  $$;

-- Marks a claimed row dispatched with the Trigger.dev run id. False when the row is not claimed
-- (its lease expired and another dispatcher took it, or it was already completed).
create function public.complete_job_outbox(p_id uuid, p_run_id text) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_run_id is null or p_run_id !~ '^[A-Za-z0-9_-]{1,100}$' then
      raise exception 'invalid run id' using errcode = '22023';
    end if;
    update private.job_outbox o
    set status = 'dispatched', lease_until = null, trigger_run_id = p_run_id,
        dispatched_at = now(), last_error_code = null, updated_at = now()
    where o.id = p_id and o.status = 'dispatching';
    return found;
  end
  $$;

-- Records a failed dispatch of a claimed row. Permanent failures and the last failed attempt
-- (private.job_outbox_max_attempts(), 8) make it dead; otherwise it is pending again after
-- 30 s × 2^(attempts − 1), at most one hour.
-- Returns the new status, or 'missing' when the row is not claimed.
create function public.fail_job_outbox(p_id uuid, p_error_code text, p_permanent boolean)
  returns text
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_code text := private.check_job_error_code(p_error_code);
    v_status text;
  begin
    if p_permanent is null then
      raise exception 'permanent must be true or false' using errcode = '22023';
    end if;
    update private.job_outbox o
    set status = case
          when p_permanent or o.attempts >= private.job_outbox_max_attempts() then 'dead'
          else 'pending'
        end,
        lease_until = null,
        available_at = case
          when p_permanent or o.attempts >= private.job_outbox_max_attempts() then o.available_at
          else now() + least(
            make_interval(secs => 30 * power(2, greatest(o.attempts - 1, 0))),
            interval '1 hour'
          )
        end,
        last_error_code = v_code,
        updated_at = now()
    where o.id = p_id and o.status = 'dispatching'
    returning o.status into v_status;
    return coalesce(v_status, 'missing');
  end
  $$;

-- Hands back claimed rows the dispatcher did not try (it stopped after Trigger.dev failed), without
-- counting the attempt, available again in one minute. Returns how many were released.
create function public.release_job_outbox(p_ids uuid[]) returns integer
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_count integer;
  begin
    if p_ids is null or cardinality(p_ids) > 100 then
      raise exception 'at most 100 ids' using errcode = '22023';
    end if;
    update private.job_outbox o
    set status = 'pending', lease_until = null, attempts = greatest(o.attempts - 1, 0),
        available_at = now() + interval '1 minute', updated_at = now()
    where o.id = any (p_ids) and o.status = 'dispatching';
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;

-- Manual recovery (docs/background-jobs.md): puts a dead or dispatched row back to pending with
-- fresh attempts and a new generation, and clears a failed execution so the job runs again. An
-- execution that succeeded stays succeeded: the run would be skipped as a duplicate.
create function public.requeue_job_outbox(p_id uuid) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_job_name text;
    v_key text;
  begin
    update private.job_outbox o
    set status = 'pending', attempts = 0, generation = o.generation + 1, lease_until = null,
        available_at = now(), trigger_run_id = null, dispatched_at = null, last_error_code = null,
        updated_at = now()
    where o.id = p_id and o.status in ('dead', 'dispatched')
    returning o.job_name, o.idempotency_key into v_job_name, v_key;
    if not found then
      return false;
    end if;
    delete from private.job_executions e
    where e.job_name = v_job_name and e.idempotency_key = v_key
      and e.status in ('failed_retryable', 'failed_permanent');
    return true;
  end
  $$;

-- Executions (service role, from inside job runs) ---------------------------------------------------

-- Claims the execution of one idempotency key for a run. Returns the state and, when claimed, a
-- token that the run must present to record the outcome:
--   claimed    no run yet, the last run failed and may be retried, or a run's lease expired;
--   succeeded  a run already succeeded (the caller skips: duplicate);
--   failed     a run failed permanently (the caller skips until a requeue);
--   running    another run holds an unexpired lease (the caller retries once it ends, at
--              lease_until).
create function public.begin_job_execution(
  p_job_name text, p_idempotency_key text, p_lease_seconds integer
) returns table (state text, claim_token uuid, attempt integer, lease_until timestamptz)
  language plpgsql volatile security definer set search_path = '' as $$
  declare
    v_lease interval := private.check_lease_seconds(p_lease_seconds);
    v_token uuid := gen_random_uuid();
    v_row private.job_executions;
  begin
    -- Concurrent first runs: one inserts, the other waits on the key and then sees `running`.
    insert into private.job_executions as e (
      job_name, idempotency_key, status, attempts, claim_token, lease_until
    )
    values (p_job_name, p_idempotency_key, 'running', 1, v_token, now() + v_lease)
    on conflict (job_name, idempotency_key) do nothing;
    if found then
      return query select 'claimed'::text, v_token, 1, now() + v_lease;
      return;
    end if;

    select * into strict v_row
    from private.job_executions e
    where e.job_name = p_job_name and e.idempotency_key = p_idempotency_key
    for update;

    if v_row.status = 'succeeded' then
      return query select 'succeeded'::text, null::uuid, v_row.attempts, null::timestamptz;
    elsif v_row.status = 'failed_permanent' then
      return query select 'failed'::text, null::uuid, v_row.attempts, null::timestamptz;
    elsif v_row.status = 'running' and v_row.lease_until > now() then
      return query select 'running'::text, null::uuid, v_row.attempts, v_row.lease_until;
    else
      update private.job_executions e
      set status = 'running', attempts = e.attempts + 1, claim_token = v_token,
          lease_until = now() + v_lease, started_at = now(), finished_at = null
      where e.job_name = p_job_name and e.idempotency_key = p_idempotency_key;
      return query select 'claimed'::text, v_token, v_row.attempts + 1, now() + v_lease;
    end if;
  end
  $$;

-- Records the outcome of a claimed execution. False when p_claim_token no longer holds it (the
-- lease expired and another run took over), so a late run cannot overwrite a newer outcome.
create function public.finish_job_execution(
  p_job_name text,
  p_idempotency_key text,
  p_claim_token uuid,
  p_outcome text,
  p_error_code text default null
) returns boolean
  language plpgsql volatile security definer set search_path = '' as $$
  begin
    if p_outcome is null or p_outcome not in ('succeeded', 'failed_retryable', 'failed_permanent') then
      raise exception 'invalid outcome' using errcode = '22023';
    end if;
    if (p_outcome = 'succeeded') <> (p_error_code is null) then
      raise exception 'an error code goes with a failure only' using errcode = '22023';
    end if;
    if p_error_code is not null then
      perform private.check_job_error_code(p_error_code);
    end if;
    update private.job_executions e
    set status = p_outcome, claim_token = null, lease_until = null,
        last_error_code = p_error_code, finished_at = now()
    where e.job_name = p_job_name and e.idempotency_key = p_idempotency_key
      and e.status = 'running' and e.claim_token = p_claim_token;
    return found;
  end
  $$;

-- Health (service role): counts only, for the dispatcher's log line and the runbook. Each count
-- reads a partial index or a bounded window, never the whole history.
--   pending, dispatching, dead       outbox rows in that state;
--   oldest_pending_seconds           how long the oldest due row has waited (0 when none is due);
--   failed_executions                runs that failed and were not requeued;
--   stalled_executions               runs still `running` 5 minutes after their lease ended: killed
--                                    at their maximum duration or crashed on the last attempt;
--   unexecuted_dispatches            rows dispatched between 7 days and 1 hour ago whose run never
--                                    claimed its execution (cancelled, expired, or lost).
create function public.job_outbox_stats()
  returns table (
    pending bigint,
    dispatching bigint,
    dead bigint,
    oldest_pending_seconds integer,
    failed_executions bigint,
    stalled_executions bigint,
    unexecuted_dispatches bigint
  )
  language sql stable security definer set search_path = '' as $$
    select
      (select count(*) from private.job_outbox o where o.status = 'pending'),
      (select count(*) from private.job_outbox o where o.status = 'dispatching'),
      (select count(*) from private.job_outbox o where o.status = 'dead'),
      coalesce((
        select extract(epoch from now() - min(o.available_at))::integer
        from private.job_outbox o
        where o.status = 'pending' and o.available_at <= now()
      ), 0),
      (select count(*) from private.job_executions e
        where e.status in ('failed_retryable', 'failed_permanent')),
      (select count(*) from private.job_executions e
        where e.status = 'running' and e.lease_until < now() - interval '5 minutes'),
      (select count(*) from private.job_outbox o
        where o.status = 'dispatched'
          and o.dispatched_at between now() - interval '7 days' and now() - interval '1 hour'
          and not exists (
            select 1 from private.job_executions e
            where e.job_name = o.job_name and e.idempotency_key = o.idempotency_key
          ))
  $$;

-- Grants ----------------------------------------------------------------------------------------------

-- Supabase's default privileges grant every new function in schema public to anon and authenticated;
-- these are for the service role only.
revoke execute on function
  public.claim_job_outbox(integer, integer),
  public.complete_job_outbox(uuid, text),
  public.fail_job_outbox(uuid, text, boolean),
  public.release_job_outbox(uuid[]),
  public.requeue_job_outbox(uuid),
  public.begin_job_execution(text, text, integer),
  public.finish_job_execution(text, text, uuid, text, text),
  public.job_outbox_stats()
from public, anon, authenticated;

grant execute on function
  public.claim_job_outbox(integer, integer),
  public.complete_job_outbox(uuid, text),
  public.fail_job_outbox(uuid, text, boolean),
  public.release_job_outbox(uuid[]),
  public.requeue_job_outbox(uuid),
  public.begin_job_execution(text, text, integer),
  public.finish_job_execution(text, text, uuid, text, text),
  public.job_outbox_stats()
to service_role;
