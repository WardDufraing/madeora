-- S13: private.job_outbox, private.job_executions and their functions. No API role reads or writes
-- the tables; only the service role runs the dispatcher and execution functions; enqueueing is
-- idempotent; claims, leases, backoff, dead-lettering, release, requeue and execution states behave
-- as the dispatcher and executor rely on. Concurrent claims are in job-outbox-concurrency.test.ts.
--
-- The whole file runs in one transaction, so now() does not move: the tests move rows' timestamps
-- into the past (as the database owner) to simulate time passing.

create temporary table ids (name text primary key, id uuid not null) on commit drop;
grant all on ids to service_role;
create temporary table tokens (name text primary key, token uuid) on commit drop;
grant all on tokens to service_role;

-- Nobody reaches the tables or the functions through the API ------------------------------------------

select tests.assert_true(
  not exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) r(role_name),
      (values ('private.job_outbox'), ('private.job_executions')) t(table_name),
      (values ('select'), ('insert'), ('update'), ('delete')) p(privilege)
    where has_table_privilege(r.role_name, t.table_name, p.privilege)
  ),
  'No API role, not even service_role, has any privilege on the job tables'
);

select tests.assert_true(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('private.job_outbox'::regclass, 'private.job_executions'::regclass)),
  'Both job tables have row level security enabled'
);

select tests.assert_true(
  not exists (
    select 1
    from (values
      ('public.claim_job_outbox(integer,integer)'),
      ('public.complete_job_outbox(uuid,text)'),
      ('public.fail_job_outbox(uuid,text,boolean)'),
      ('public.release_job_outbox(uuid[])'),
      ('public.requeue_job_outbox(uuid)'),
      ('public.begin_job_execution(text,text,integer)'),
      ('public.finish_job_execution(text,text,uuid,text,text)'),
      ('public.job_outbox_stats()')
    ) f(signature),
    (values ('anon'), ('authenticated')) r(role_name)
    where has_function_privilege(r.role_name, f.signature, 'execute')
  ),
  'anon and authenticated cannot execute any job function'
);

select tests.assert_true(
  has_function_privilege('service_role', 'public.claim_job_outbox(integer,integer)', 'execute')
    and has_function_privilege('service_role', 'public.begin_job_execution(text,text,integer)', 'execute')
    and not has_function_privilege('service_role', 'private.enqueue_job(text,integer,text,jsonb,uuid,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'private.enqueue_job(text,integer,text,jsonb,uuid,timestamptz)', 'execute'),
  'service_role runs the dispatcher functions; nobody enqueues through the API'
);

select tests.act_as('alice');
select tests.assert_denied('select * from public.claim_job_outbox(10, 60)', 'A signed-in person cannot claim jobs');
select tests.assert_denied('select * from public.job_outbox_stats()', 'A signed-in person cannot read job stats');
select tests.assert_denied(
  $$select * from public.begin_job_execution('sample-ping', 'k', 60)$$,
  'A signed-in person cannot begin an execution'
);
select tests.assert_denied('select id from private.job_outbox', 'A signed-in person cannot read the outbox');
select tests.act_as_anon();
select tests.assert_denied('select * from public.claim_job_outbox(10, 60)', 'A visitor cannot claim jobs');
select tests.act_as_service_role();
select tests.assert_denied('select id from private.job_outbox', 'Even the service role cannot read the outbox table');
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 1, 'x', '{}')$$,
  'The service role cannot enqueue directly'
);

-- Enqueue ----------------------------------------------------------------------------------------------

select tests.act_as_owner();
insert into ids values ('correlation', '0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f');
insert into ids
  select 'job-1', private.enqueue_job(
    'sample-ping', 1, 'ping:1', '{"note": "a"}', (select id from ids where name = 'correlation')
  );
insert into ids
  select 'job-1-again', private.enqueue_job('sample-ping', 1, 'ping:1', '{"note": "a"}');

select tests.assert_true(
  (select id from ids where name = 'job-1') = (select id from ids where name = 'job-1-again'),
  'Enqueueing the same job and key twice returns the first row'
);
select tests.assert_true(
  (select count(*) = 1 and bool_and(payload = '{"note": "a"}' and status = 'pending'
      and correlation_id = '0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f')
    from private.job_outbox where idempotency_key = 'ping:1'),
  'The second enqueue leaves the first row unchanged'
);
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 1, 'ping:1', '{"note": "changed"}')$$,
  'Reusing a key with a different payload is refused', '23505'
);
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 1, 'k-v7', '{}', '01890a5d-ac96-774b-bcce-b302099a8057')$$,
  'Correlation IDs are UUID v4, as the dispatcher requires', '23514'
);
select tests.assert_true(
  (select prosecdef = false from pg_proc where oid = 'private.enqueue_job(text,integer,text,jsonb,uuid,timestamptz)'::regprocedure),
  'enqueue_job runs with its caller''s rights'
);
insert into ids select 'no-correlation', private.enqueue_job('sample-ping', 1, 'ping:no-correlation', '{}');
select tests.assert_true(
  (select correlation_id is not null from private.job_outbox o
    where o.id = (select id from ids where name = 'no-correlation')),
  'An enqueue without a correlation ID gets a fresh one'
);
select tests.assert_denied(
  $$select private.enqueue_job('Sample Ping', 1, 'k', '{}')$$, 'Job names are kebab-case', '23514'
);
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 1, 'bad key with spaces', '{}')$$,
  'Idempotency keys are restricted to safe characters', '23514'
);
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 1, 'k-array', '[1]')$$, 'Payloads are objects', '23514'
);
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 1, 'k-big',
      jsonb_build_object('x', (select string_agg(md5(i::text), '') from generate_series(1, 1000) i)))$$,
  'Payloads are small', '23514'
);
select tests.assert_denied(
  $$select private.enqueue_job('sample-ping', 0, 'k-v0', '{}')$$, 'Versions start at 1', '23514'
);

-- A job scheduled for later is not due yet.
insert into ids select 'later', private.enqueue_job(
  'sample-ping', 1, 'ping:later', '{}', null, now() + interval '1 hour'
);

-- Claiming ---------------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_denied('select * from public.claim_job_outbox(0, 60)', 'A limit of 0 is refused', '22023');
select tests.assert_denied('select * from public.claim_job_outbox(101, 60)', 'A limit above 100 is refused', '22023');
select tests.assert_denied('select * from public.claim_job_outbox(5, 5)', 'A lease under 10 s is refused', '22023');

select tests.assert_row_count(
  'select * from public.claim_job_outbox(100, 60)', 2,
  'The two due rows are claimed; the scheduled one is not'
);
select tests.assert_row_count(
  'select * from public.claim_job_outbox(100, 60)', 0, 'Claimed rows are not claimed again while leased'
);

select tests.act_as_owner();
select tests.assert_true(
  (select status = 'dispatching' and attempts = 1 and lease_until = now() + interval '60 seconds'
    from private.job_outbox where id = (select id from ids where name = 'job-1')),
  'A claimed row is dispatching, counts one attempt and holds a lease'
);

-- Completing -------------------------------------------------------------------------------------------

select tests.act_as_service_role();
select tests.assert_denied(
  $$select public.complete_job_outbox((select id from ids where name = 'job-1'), 'run with spaces')$$,
  'Run ids are validated', '22023'
);
select tests.assert_true(
  public.complete_job_outbox((select id from ids where name = 'job-1'), 'run_abc123'),
  'A claimed row is completed'
);
select tests.assert_true(
  not public.complete_job_outbox((select id from ids where name = 'job-1'), 'run_other'),
  'Completing again reports a lost claim'
);
select tests.assert_true(
  not public.complete_job_outbox((select id from ids where name = 'later'), 'run_x'),
  'A row that was never claimed cannot be completed'
);

select tests.act_as_owner();
select tests.assert_true(
  (select status = 'dispatched' and trigger_run_id = 'run_abc123' and dispatched_at is not null
      and lease_until is null
    from private.job_outbox where id = (select id from ids where name = 'job-1')),
  'A completed row keeps the run id and drops its lease'
);

-- Failing, backoff and dead-lettering ------------------------------------------------------------------

select tests.act_as_owner();
insert into ids select 'flaky', private.enqueue_job('sample-ping', 1, 'ping:flaky', '{}');
-- Everything else out of the way, so each claim below picks exactly this row.
update private.job_outbox set status = 'dispatched', lease_until = null, trigger_run_id = 'run_parked'
  where id <> (select id from ids where name = 'flaky') and status = 'dispatching';
update private.job_outbox set available_at = now() + interval '1 day'
  where id = (select id from ids where name = 'later');

select tests.act_as_service_role();
select tests.assert_denied(
  $$select public.fail_job_outbox((select id from ids where name = 'flaky'), 'Trigger said: boom', false)$$,
  'Error codes are short codes, never messages', '22023'
);

-- Attempts 1 to 7 come back with backoff 30 s, 60 s, ... capped at one hour; attempt 8 is dead.
do $$
  declare
    v_id uuid := (select id from ids where name = 'flaky');
    v_attempt integer;
    v_status text;
    v_available timestamptz;
  begin
    for v_attempt in 1..8 loop
      perform tests.act_as_owner();
      update private.job_outbox set available_at = now() - interval '1 second' where id = v_id;
      perform tests.act_as_service_role();
      if (select count(*) from public.claim_job_outbox(10, 60) c where c.id = v_id) <> 1 then
        raise exception 'RLS assertion failed: attempt % did not claim the row', v_attempt
          using errcode = 'MT001';
      end if;
      v_status := public.fail_job_outbox(v_id, 'trigger_unavailable', false);
      perform tests.act_as_owner();
      select o.available_at into v_available from private.job_outbox o where o.id = v_id;
      if v_attempt < 8 and (v_status <> 'pending'
          or v_available <> now() + least(make_interval(secs => 30 * power(2, v_attempt - 1)), interval '1 hour')) then
        raise exception 'RLS assertion failed: attempt % gave % at %', v_attempt, v_status, v_available
          using errcode = 'MT001';
      end if;
      if v_attempt = 8 and v_status <> 'dead' then
        raise exception 'RLS assertion failed: attempt 8 gave %', v_status using errcode = 'MT001';
      end if;
    end loop;
  end
$$;

select tests.act_as_owner();
select tests.assert_true(
  (select status = 'dead' and attempts = 8 and last_error_code = 'trigger_unavailable'
    from private.job_outbox where id = (select id from ids where name = 'flaky')),
  'After 8 failed attempts the row is dead with its last error code'
);
update private.job_outbox set available_at = now() - interval '1 day'
  where id = (select id from ids where name = 'flaky');
select tests.act_as_service_role();
select tests.assert_row_count(
  'select * from public.claim_job_outbox(10, 60)', 0, 'A dead row is never claimed'
);
select tests.assert_true(
  public.fail_job_outbox((select id from ids where name = 'flaky'), 'x', false) = 'missing',
  'Failing a row that is not claimed reports missing'
);

-- A permanent failure is dead at once.
select tests.act_as_owner();
insert into ids select 'bad', private.enqueue_job('sample-ping', 1, 'ping:bad', '{}');
select tests.act_as_service_role();
select count(*) from public.claim_job_outbox(10, 60);
select tests.assert_true(
  public.fail_job_outbox((select id from ids where name = 'bad'), 'invalid_payload', true) = 'dead',
  'A permanent failure is dead after one attempt'
);

-- Release: untried rows go back without spending an attempt.
select tests.act_as_owner();
insert into ids select 'untried', private.enqueue_job('sample-ping', 1, 'ping:untried', '{}');
select tests.act_as_service_role();
select count(*) from public.claim_job_outbox(10, 60);
select tests.assert_true(
  public.release_job_outbox(array[(select id from ids where name = 'untried')]) = 1,
  'A claimed row is released'
);
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'pending' and attempts = 0 and available_at = now() + interval '1 minute'
      and lease_until is null
    from private.job_outbox where id = (select id from ids where name = 'untried')),
  'A released row is pending again, with no attempt counted, in one minute'
);
select tests.act_as_service_role();
select tests.assert_true(
  public.release_job_outbox(array[(select id from ids where name = 'untried')]) = 0,
  'Releasing a row that is not claimed does nothing'
);

-- A crashed dispatcher: its lease expires and the row is claimed again.
select tests.act_as_owner();
update private.job_outbox set available_at = now() - interval '1 second'
  where id = (select id from ids where name = 'untried');
select tests.act_as_service_role();
select count(*) from public.claim_job_outbox(10, 60);
select tests.act_as_owner();
update private.job_outbox set lease_until = now() - interval '1 second'
  where id = (select id from ids where name = 'untried');
select tests.act_as_service_role();
select tests.assert_row_count(
  $$select * from public.claim_job_outbox(10, 60) c where c.id = (select id from ids where name = 'untried') and c.attempts = 2$$,
  1, 'A row whose lease expired is claimed again, counting another attempt'
);
-- ... unless its attempts are used up: then it is dead.
select tests.act_as_owner();
update private.job_outbox set attempts = 8, lease_until = now() - interval '1 second'
  where id = (select id from ids where name = 'untried');
select tests.act_as_service_role();
select count(*) from public.claim_job_outbox(10, 60);
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'dead' and last_error_code = 'lease_expired'
    from private.job_outbox where id = (select id from ids where name = 'untried')),
  'A row that keeps losing its lease is dead after the last attempt'
);

-- Requeue ----------------------------------------------------------------------------------------------

select tests.act_as_owner();
insert into private.job_executions (job_name, idempotency_key, status, attempts, last_error_code)
  values ('sample-ping', 'ping:bad', 'failed_permanent', 1, 'invalid_payload');
select tests.act_as_service_role();
select tests.assert_true(
  public.requeue_job_outbox((select id from ids where name = 'bad')),
  'A dead row is requeued'
);
select tests.assert_true(
  not public.requeue_job_outbox((select id from ids where name = 'bad')),
  'A pending row is not requeued again'
);
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'pending' and attempts = 0 and generation = 1 and last_error_code is null
    from private.job_outbox where id = (select id from ids where name = 'bad'))
    and not exists (select 1 from private.job_executions where idempotency_key = 'ping:bad'),
  'A requeued row starts again under a new generation and its failed execution is cleared'
);
insert into private.job_executions (job_name, idempotency_key, status, attempts)
  values ('sample-ping', 'ping:1', 'succeeded', 1);
select tests.act_as_service_role();
select public.requeue_job_outbox((select id from ids where name = 'job-1'));
select tests.act_as_owner();
select tests.assert_true(
  (select status = 'succeeded' from private.job_executions where idempotency_key = 'ping:1'),
  'Requeueing keeps a succeeded execution, so the rerun is skipped as a duplicate'
);

-- Executions -------------------------------------------------------------------------------------------

select tests.act_as_service_role();
insert into tokens
  select 'first', b.claim_token from public.begin_job_execution('sample-ping', 'exec:1', 60) b
  where b.state = 'claimed' and b.attempt = 1;
select tests.assert_true((select count(*) = 1 from tokens where name = 'first'), 'The first run claims the execution');
select tests.assert_row_count(
  $$select * from public.begin_job_execution('sample-ping', 'exec:1', 60) where state = 'running' and claim_token is null$$,
  1, 'A second run while the lease holds is told it is running elsewhere'
);
select tests.assert_true(
  not public.finish_job_execution('sample-ping', 'exec:1', gen_random_uuid(), 'succeeded', null),
  'A forged claim token cannot record an outcome'
);
select tests.assert_denied(
  $$select public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'first'), 'done', null)$$,
  'Outcomes are validated', '22023'
);
select tests.assert_denied(
  $$select public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'first'), 'succeeded', 'oops')$$,
  'A success carries no error code', '22023'
);
select tests.assert_denied(
  $$select public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'first'), 'failed_retryable', null)$$,
  'A failure carries an error code', '22023'
);
select tests.assert_true(
  public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'first'), 'failed_retryable', 'provider_unavailable'),
  'The run holding the claim records a retryable failure'
);
insert into tokens
  select 'second', b.claim_token from public.begin_job_execution('sample-ping', 'exec:1', 60) b
  where b.state = 'claimed' and b.attempt = 2;
select tests.assert_true(
  (select count(*) = 1 from tokens where name = 'second'), 'A retry after a retryable failure claims attempt 2'
);
select tests.assert_true(
  not public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'first'), 'succeeded', null),
  'The earlier run cannot record an outcome over the retry'
);
select tests.assert_true(
  public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'second'), 'succeeded', null),
  'The retry records success'
);
select tests.assert_row_count(
  $$select * from public.begin_job_execution('sample-ping', 'exec:1', 60) where state = 'succeeded'$$,
  1, 'A duplicate run after success is told to skip'
);
select tests.assert_true(
  not public.finish_job_execution('sample-ping', 'exec:1', (select token from tokens where name = 'second'), 'failed_permanent', 'late'),
  'A finished execution cannot be overwritten'
);

-- A crashed run: its lease expires and the next run takes over.
insert into tokens
  select 'crashed', b.claim_token from public.begin_job_execution('sample-ping', 'exec:2', 60) b;
select tests.act_as_owner();
update private.job_executions set lease_until = now() - interval '1 second' where idempotency_key = 'exec:2';
select tests.act_as_service_role();
insert into tokens
  select 'takeover', b.claim_token from public.begin_job_execution('sample-ping', 'exec:2', 60) b
  where b.state = 'claimed' and b.attempt = 2;
select tests.assert_true(
  (select count(*) = 1 from tokens where name = 'takeover'), 'A run whose lease expired is taken over'
);
select tests.assert_true(
  not public.finish_job_execution('sample-ping', 'exec:2', (select token from tokens where name = 'crashed'), 'succeeded', null),
  'The crashed run cannot record an outcome after the takeover'
);
select tests.assert_true(
  public.finish_job_execution('sample-ping', 'exec:2', (select token from tokens where name = 'takeover'), 'failed_permanent', 'access_revoked'),
  'The takeover records a permanent failure'
);
select tests.assert_row_count(
  $$select * from public.begin_job_execution('sample-ping', 'exec:2', 60) where state = 'failed'$$,
  1, 'A permanently failed execution is skipped until requeued'
);
select tests.assert_denied(
  $$select * from public.begin_job_execution('sample-ping', 'exec:3', 3601)$$, 'Leases are bounded', '22023'
);
select tests.assert_denied(
  $$select * from public.begin_job_execution('Bad Name', 'exec:3', 60)$$, 'Job names are validated', '23514'
);

-- Stats ------------------------------------------------------------------------------------------------

select tests.assert_true(
  (select dead >= 1 and failed_executions >= 1 and oldest_pending_seconds >= 0
    from public.job_outbox_stats()),
  'Stats count dead rows and failed executions, and a row scheduled later never makes the wait negative'
);

-- Stalled work the stats must surface: a run killed after claiming (its lease long over), and a
-- row dispatched two hours ago whose run never claimed its execution.
select tests.act_as_owner();
insert into private.job_executions (job_name, idempotency_key, status, attempts, claim_token, lease_until)
  values ('sample-ping', 'exec:killed', 'running', 1, gen_random_uuid(), now() - interval '10 minutes'),
         ('sample-ping', 'exec:live', 'running', 1, gen_random_uuid(), now() + interval '1 minute');
insert into private.job_outbox (job_name, job_version, idempotency_key, payload, correlation_id,
    status, attempts, trigger_run_id, dispatched_at)
  values ('sample-ping', 1, 'ping:lost', '{}', gen_random_uuid(), 'dispatched', 1, 'run_lost',
          now() - interval '2 hours'),
         ('sample-ping', 1, 'ping:recent', '{}', gen_random_uuid(), 'dispatched', 1, 'run_recent',
          now() - interval '5 minutes'),
         ('sample-ping', 1, 'ping:old', '{}', gen_random_uuid(), 'dispatched', 1, 'run_old',
          now() - interval '30 days');
-- ping:1 was dispatched and has a succeeded execution, so it is not lost.
select tests.act_as_service_role();
select tests.assert_true(
  (select stalled_executions = 1 and unexecuted_dispatches = 1 from public.job_outbox_stats()),
  'Stats count a run whose lease ended long ago and a recent dispatch whose run never started'
);
