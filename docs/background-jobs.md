# Background jobs

How Madeora runs work outside a request (S13, [ADR 0017](adr/0017-background-jobs.md), architecture §11). Setting up Trigger.dev itself: [`trigger-setup.md`](trigger-setup.md).

## How it fits together

1. A business function changes data **and** calls `private.enqueue_job(...)` in the same transaction. The job exists exactly when the change committed.
2. Every 5 minutes the Trigger.dev task `outbox-dispatch` claims due outbox rows and triggers one run per row (`packages/jobs/src/dispatcher.ts`).
3. The run validates the envelope and payload, claims the execution in Postgres, runs the handler and records the outcome (`packages/jobs/src/executor.ts`).

Use a job only for work that is durable, scheduled, retryable, long-running or failure-sensitive (CLAUDE.md, strategy B). Fast work whose result the person waits for stays in the API route.

## Adding a job

1. Define it in `packages/jobs/src/jobs/<name>.ts` with `defineJob`:
   - `name`: kebab-case, never renamed (it is the Trigger.dev task id and is stored in the outbox).
   - `version`: start at 1. A job handles exactly one payload version. For an incompatible payload change, prefer a **new job name** (`send-invitation-email-v2`) and keep the old job registered until `select count(*) from private.job_outbox where job_name = '<old>' and status in ('pending', 'dispatching')` is 0. Raising `version` instead works only when no old-version rows remain: rows of a newer version than the deployed code are retried until the deploy arrives, but rows of an older version are dead (`version_retired`).
   - **Deploy order:** deploy the tasks to Trigger.dev before, or together with, the migration that starts enqueueing a new job. Rows that arrive first are retried (`unknown_job`, `version_not_deployed`) and dead after 8 attempts, about 2.5 hours.
   - `payload`: `z.strictObject({...})` with **ids only**. Payloads appear in Trigger.dev's dashboard and in Postgres: no names, email addresses, tokens, sessions, URLs or household content.
   - `handle(data, { idempotencyKey, correlationId, logger, attempt })`: load what you need through narrow `security definer` functions granted to the service role (never by reading or writing household tables directly with the service-role client, which bypasses RLS), **re-check that the people and resources involved still allow the work** (membership revoked, account deactivated, integration disabled: spec lines 309, 315), and throw `PermanentJobError("code")` when it can never succeed or `RetryableJobError("code")` when it may later. Pass `idempotencyKey` on to providers (Resend's idempotency key) so a repeated run cannot repeat an external effect.
2. List it in `packages/jobs/src/registry.ts` and export its task from `packages/jobs/src/trigger/tasks.ts` (`export const xTask = jobTask(x)`). A unit test fails if a job has no task.
3. Enqueue it from the SQL function that makes the business change:

   ```sql
   perform private.enqueue_job(
     'send-invitation-email',      -- job name
     1,                            -- payload version
     'invitation:' || v_invitation_id || ':email',  -- idempotency key: same work, same key
     jsonb_build_object('invitationId', v_invitation_id),
     p_correlation_id              -- from requestCorrelationId(request), passed by the route
   );
   ```

4. Test the handler with `FakeJobStore` (`packages/jobs/src/testing/fake-store.ts`): success, duplicate delivery, retryable and permanent failures, revoked access.

## Logs and correlation IDs

`proxy.ts` gives every request a correlation ID (header `x-correlation-id`, also returned to the browser); route handlers read it with `requestCorrelationId(request)` from `apps/web/src/api/correlation.ts`. Pass it to `enqueue_job`, and it follows the job into every log line and onto the Trigger.dev run as the tag `cor:<id>`.

Log with `createLogger` from `@madeora/observability`: an event name (`area.thing_happened`) and ids or short codes only. Sensitive-looking fields are replaced by `[redacted]` and token-shaped values are masked, but that is a safety net, not permission.

To trace an incident: take the ID from the response header or a log line, search Vercel's logs for it, then filter Trigger.dev runs by the tag `cor:<id>`.

## Recovery runbook

All of this runs in the Supabase **SQL Editor** of the affected project (the API cannot reach these tables).

**Health:**

```sql
select * from public.job_outbox_stats();
```

Each sweep also logs these as `jobs.outbox.stats`.

- `pending` growing and `oldest_pending_seconds` above 15 minutes: the dispatcher is not running (Trigger.dev down, the Free credit used up, or a wrong environment variable). Check Trigger.dev → Runs → `outbox-dispatch`. An outage longer than about 2.5 hours makes rows dead; requeue them once it is over.
- `stalled_executions` above 0: a run claimed its execution and stopped without recording an outcome (killed at its maximum duration, or crashed on its last attempt). List them below and requeue their outbox rows.
- `unexecuted_dispatches` above 0: Trigger.dev accepted a run more than an hour ago that never started (cancelled in the dashboard, expired, or lost). Requeue those rows.
- `failed_executions` above 0: see "Failed executions".

**Dead rows** (dispatch failed 8 times, or the row can never run):

```sql
select id, job_name, idempotency_key, attempts, last_error_code, updated_at
from private.job_outbox where status = 'dead' order by updated_at desc limit 50;
```

- `trigger_unavailable` or `lease_expired`: Trigger.dev was unreachable. Once it works again, requeue.
- `trigger_rejected`: Trigger.dev refused the run (task not deployed, invalid request). Deploy or fix, then requeue.
- `unknown_job`, `version_not_deployed`: the tasks were not deployed before the rows arrived. Deploy, then requeue.
- `version_retired`, `invalid_payload`: a code or data problem. Fix and deploy first, then requeue.

**Stalled work:**

```sql
-- Runs that never recorded an outcome.
select job_name, idempotency_key, attempts, lease_until
from private.job_executions
where status = 'running' and lease_until < now() - interval '5 minutes';

-- Dispatched rows whose run never started.
select o.id, o.job_name, o.idempotency_key, o.dispatched_at, o.trigger_run_id
from private.job_outbox o
where o.status = 'dispatched' and o.dispatched_at < now() - interval '1 hour'
  and not exists (select 1 from private.job_executions e
    where e.job_name = o.job_name and e.idempotency_key = o.idempotency_key);
```

For a stalled execution, find its outbox row (`where job_name = … and idempotency_key = …`) and requeue it; the lease has ended, so the new run takes the execution over.

**Failed executions** (the job ran and failed, or its payload was refused at run time):

```sql
select job_name, idempotency_key, status, attempts, last_error_code, finished_at
from private.job_executions where status in ('failed_retryable', 'failed_permanent')
order by finished_at desc limit 50;
```

`failed_retryable` with Trigger.dev showing the run as failed means its retries ran out. `failed_permanent` is a validation or permission failure. Fix the cause, then requeue the outbox row.

**Requeue** one row (fresh attempts, a new Trigger.dev idempotency key, failed execution cleared; an execution that succeeded stays and the rerun is skipped):

```sql
select public.requeue_job_outbox('<outbox row id>');
```

**Smoke test** a fresh environment: enqueue the sample job, wait up to 5 minutes, and check that the row is `dispatched` and Trigger.dev shows a successful `sample-ping` run.

```sql
select private.enqueue_job('sample-ping', 1, 'smoke-' || to_char(now(), 'YYYYMMDDHH24MISS'), '{"label": "smoke-test"}');
select status, attempts, last_error_code from private.job_outbox order by created_at desc limit 1;
```

## Local development

`packages/jobs/.env.example` lists what the jobs need. With the local Supabase stack running (`pnpm db:start`) and a Trigger.dev account:

```sh
cd packages/jobs
cp .env.example .env       # fill in TRIGGER_PROJECT_REF and the local secret key
pnpm dlx trigger.dev@4.6.4 login
pnpm dlx trigger.dev@4.6.4 dev
```

`trigger.dev dev` runs tasks on your machine in the Dev environment (free). Without an account, the unit tests (`pnpm --filter @madeora/jobs test`) and database tests cover the same rules with fakes.
