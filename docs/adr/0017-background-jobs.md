# ADR 0017: Background jobs with Trigger.dev and a transactional outbox

- **Status:** Accepted for S13 within the approved architecture (§11, §20, §22, §23) and CLAUDE.md (background processing strategy B, observability strategy B, database access strategy A). The defaults below are open to correction by the owner.
- **Date:** 2026-10-15
- **Step:** S13 (brief: `plans/steps/S13-brief.md`). Builds on S03 (the `private` schema and database tests).

## Context

Architecture §11 asks for durable, retryable background work in Trigger.dev, a transactional outbox (or an equally reliable handoff) where a database write must lead to a job, idempotent tasks with Postgres-recorded state, bounded retries with permanent failures kept apart, and correlation IDs in logs (§22). Until now the app sends email synchronously (S10, S12b). Development spend must stay at €0: Trigger.dev's Free plan gives $5 of monthly usage and stops tasks, rather than billing, when it runs out.

## Decision

**Packages.** `packages/observability` holds correlation IDs and a structured, redacting JSON logger, for the web app and the jobs alike. `packages/jobs` holds the job conventions and imports Trigger.dev only under `src/trigger/`, which the Trigger.dev CLI bundles and deploys with `trigger.config.ts`.

**Jobs.** `defineJob` takes a kebab-case name (also the Trigger.dev task id), a payload version, a strict Zod payload of ids only, a bounded retry policy and an execution lease. Errors are `RetryableJobError` or `PermanentJobError` with a short code; anything else counts as retryable with the code `unexpected_error`. Messages never reach logs, Postgres or Trigger.dev.

**Outbox.** `private.job_outbox`, filled by `private.enqueue_job()` inside the business transaction; one row per `(job_name, idempotency_key)`. A scheduled Trigger.dev task, `outbox-dispatch`, runs every 5 minutes, one at a time. It claims due rows with `FOR UPDATE SKIP LOCKED` under a 2-minute lease and triggers one run per row with a global Trigger.dev idempotency key `job:rowId:generation` (the row id, not the business key, so a row re-created after a database reset is never mistaken for an old one). Then it marks the row `dispatched`. When Trigger.dev cannot be reached, the row goes back to `pending` with backoff (30 s doubling, at most 1 hour) and the rest of the batch is released without spending an attempt; when Trigger.dev refuses one row (a 4xx answer other than 408 or 429), only that row backs off. A job or payload version the deployed code does not know yet is retried the same way, because a migration may land before the Trigger.dev deploy. After 8 attempts the row is `dead`. A retired (older) version or an invalid payload is `dead` at once. `requeue_job_outbox` puts a dead row back under a new generation. Enqueueing the same key with a different payload raises an error, because one key means one piece of work.

**Executions.** `private.job_executions` holds one row per job key. A run claims it with a token under a lease (`begin_job_execution`) and records its outcome with that token (`finish_job_execution`). A key that succeeded is skipped. A key held by a live lease makes the run retry once the lease ends (`catchError` returns `retryAt`). A key that failed permanently is skipped until requeued. A run whose lease expired is taken over, and the late run can no longer record anything. A job's maximum duration equals its lease.

**Access.** No API role, including the service role, has any privilege on the two tables (RLS on, no policies, grants revoked). Of this migration's objects, the service role may execute only the eight `public` functions, each validating its arguments; `anon` and `authenticated` may execute none. The Supabase secret (service-role) key held by Trigger.dev is still the service role: outside these tables it bypasses RLS on every public table and has every earlier service-role grant. CLAUDE.md treats such clients as exceptional, so jobs must not read or write household data through the Data API directly: each job gets narrow `security definer` functions granted to the service role that re-check membership, roles and resource state in SQL, as the outbox functions do (first applied in S14). The key exists only in Trigger.dev's environment variables, never in Vercel. The web app gets no Trigger.dev key until the first feature needs a low-latency "kick" (S14).

**Health.** `job_outbox_stats()` counts pending, dispatching and dead rows, the oldest due wait, failed executions, executions still `running` 5 minutes after their lease ended (a run killed at its maximum duration or crashed on its last attempt), and rows dispatched between 7 days and 1 hour ago whose run never claimed its execution (cancelled or expired in Trigger.dev). Each count reads a partial index or a bounded window, so it stays cheap without a purge. The sweeper logs them every 5 minutes; the runbook explains each.

**Correlation.** `proxy.ts` generates a correlation ID for every request (a client-sent one is replaced), forwards it to handlers (`requestCorrelationId`) and returns it in `x-correlation-id`. Outbox rows carry it into the job envelope, logs and Trigger.dev run tags.

## Defaults chosen (owner may correct)

1. Dispatch from Trigger.dev on a 5-minute schedule (about 8,600 runs a month, roughly $0.50 of the $5).
2. Retry numbers: 8 dispatch attempts; job runs 5 attempts from 1 s to 60 s (the sample job 3); lease 5 minutes by default (the sample job 1 minute); sweep batch 25.
3. Trigger.dev idempotency keys live 30 days.
4. No outbox purge: retention periods are open in the product specification.
5. The Trigger.dev CLI is not a repository dependency; it is run with `pnpm dlx trigger.dev@4.6.4`, the same version as the SDK.

## Consequences

- Payload versions: one code version handles one payload version. An incompatible change gets a new job name, or a new version deployed to Trigger.dev before any migration enqueues it; rows of a retired version are dead and need a data fix (`docs/background-jobs.md`).
- Delivery is at least once: a handler whose external effect succeeded but whose success could not be recorded may run again after its lease. Handlers pass their idempotency key to providers (Resend accepts one) or check state first.
- A job waits up to 5 minutes (plus backoff) before it runs, until a feature adds the kick.
- When the Free credit is spent, jobs wait in the outbox until the next month or an approved upgrade; nothing is lost.
- The Trigger.dev SDK brings its own OpenTelemetry libraries for its run tracing; they report only to Trigger.dev and add no monitoring vendor (§22).
- Trigger.dev behaviour (idempotency, schedules, environments) is covered by fakes in unit tests; the owner checks it once in the real dashboard (`docs/trigger-setup.md`).

## Alternatives considered

- **Dispatch from the web app after commit, with the service-role key in Vercel.** Lower latency, but puts the most privileged database key into every Vercel function. Rejected for now; a kick with a Trigger.dev key only is the planned refinement.
- **Supabase Database Webhooks / `pg_net` to call Trigger.dev from Postgres.** Couples the database to an outbound HTTP call and a secret stored in Postgres; harder to test locally and in CI.
- **Trigger.dev idempotency alone, without an execution table.** Does not protect against replays from the dashboard, requeues or a retry after the handler finished, and records no state in Postgres as §11 requires.
