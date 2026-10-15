# S13 brief: background jobs (Trigger.dev, typed idempotent jobs, transactional outbox, correlation IDs)

- **Branch:** `feat/background-jobs` (from `main` at `c142900`)
- **Date:** 2026-10-15
- **Depends on:** S03 (Supabase, `private` schema, RLS test harness). Builds on S10/S12b, which send email synchronously "until background jobs exist (S13)".

## Gate: free tier check (done 2026-10-15)

Trigger.dev's Free plan is $0/month with $5 of included monthly usage, 20 concurrent runs, 1 day of log retention, a limited number of schedules (sources say 10), and free development runs. It needs a **verified GitHub account**. Once the $5 is used the plan does not bill: tasks stop until the owner upgrades. That is the pause-instead-of-charge behaviour the €0 rule needs.

**Not verified:** whether signing up or creating a project asks for a card. The official pricing page could not be fetched from the build container; one third-party directory says a card is required, others say nothing. Mitigation: S13 writes code and local tests only and provisions nothing. The account step (`docs/trigger-setup.md`) tells the owner to stop at any card prompt. The cost register row is filled in with this caveat.

## Scope

1. **`packages/observability`** (new, framework-independent): correlation ID helpers (`newCorrelationId`, `isCorrelationId`) and a structured JSON logger with redaction of secrets, tokens, signed URLs, emails and free-text bodies (architecture §22).
2. **Correlation at the API boundary:** `apps/web/src/proxy.ts` always generates a correlation ID (a client-sent one is ignored, so nobody can inject log lines or collide IDs), forwards it as `x-correlation-id` on the request and returns it on the response. A server helper reads it for route handlers.
3. **`packages/jobs`** (new): typed job conventions, with no Trigger.dev imports outside `src/trigger/`:
   - `defineJob({ name, version, payload (strict Zod object), retry, leaseSeconds, handle })`; payloads are minimal and carry ids only (Trigger.dev shows payloads in its dashboard).
   - Payload envelope `{ v, correlationId, data }`, validated on both enqueue and run.
   - Errors: `RetryableJobError` (retry with backoff) and `PermanentJobError` (never retry; validation or permission failures). Anything else is treated as retryable.
   - Executor `runJob`: validate, claim the execution under a lease, run, record the outcome. A duplicate of a succeeded execution is skipped; one in progress backs off; one failed permanently is not rerun.
   - Dispatcher `dispatchOutbox`: claim a batch, trigger each job with an idempotency key, mark dispatched, or release with backoff, or dead-letter.
   - Supabase-backed store (through `supabase.rpc()` only) and a Trigger.dev client behind small interfaces, so every rule is unit-tested with in-memory fakes.
4. **Postgres** (one migration): `private.job_outbox` and `private.job_executions` (no API role can read them; RLS on, no policies, no table grants), `private.enqueue_job(...)` for use **inside business transactions** (same-key enqueue returns the existing row), and `service_role`-only `security definer` functions for claim, complete, fail, requeue, execution begin/finish and a stats function. Row-level state transitions are recorded in the tables themselves (architecture §11).
5. **Trigger.dev tasks and config** (`packages/jobs/src/trigger/`, `packages/jobs/trigger.config.ts`): a scheduled `outbox-dispatch` sweeper (every 5 minutes, queue concurrency 1), which also logs the backlog stats; a sample job `sample.ping` that does nothing but log, proving the pipeline; the SDK's retry policy wired from the job definition.
6. **Docs:** `docs/adr/0017-background-jobs.md`, `docs/background-jobs.md` (conventions, how to add a job, failure and recovery runbook, the SQL to inspect and requeue dead rows), `docs/trigger-setup.md` (owner steps), `docs/provider-cost-register.md` row, `docs/development.md` local commands.

**Out of scope:** any real job (email invitations stay synchronous until S14 moves them), notifications, a web-side "kick" call (added with the first caller, so no Trigger.dev key goes to Vercel before it is needed), outbox retention/purge (the spec leaves log and history retention open; nothing is invented), deploying tasks to Trigger.dev, alerting configuration (owner checks what the Free plan offers; see runbook), migrating the existing ad-hoc `console.error` calls (done when each area is next touched).

Spec: `docs/product/Project-specification.md` lines 349 (retries and duplicate deliveries must not create misleading duplicates), 367 (server-authoritative timestamps and correlation identifiers), 309 (recheck authorization on revoked membership, disabled integrations), 315 (deactivation disables personal background jobs), 662–664 and 678 (asynchronous export jobs with states, safe retry/cancel). Architecture: §5, §6, §11, §20, §21, §22. CLAUDE.md: background processing strategy B, observability strategy B, database access strategy A, application configuration strategy A, €0 constraint.

## Decisions (defaults chosen; owner may correct)

1. **Dispatch lives in Trigger.dev, not in Vercel.** The sweeper runs there with the Supabase service-role key held only as a Trigger.dev environment variable. The web app never gets the service-role key. When a feature needs lower latency, S14 adds a best-effort "kick" with a Trigger.dev secret key only; the schedule remains the safety net.
2. **Service role stays narrow on the job tables:** of this step's objects, `service_role` can execute exactly the new functions and has no table access. Each function validates its inputs; error codes stored are short sanitized codes, never messages. The key itself keeps the service role's full reach elsewhere, so jobs use narrow `security definer` functions for household data (from S14; ADR 0017).
3. **Two idempotency layers:** the outbox row is unique on `(job_name, idempotency_key)` (so a retried request cannot enqueue twice), the same key is passed to Trigger.dev as its idempotency key (so a crash between trigger and mark-dispatched cannot start two runs), and `job_executions` makes the handler itself safe against replays.
4. **Retry numbers:** dispatch attempts 8, backoff 30 s × 2ⁿ capped at 1 hour, then `dead`; when Trigger.dev is unreachable the rest of the batch is released without spending an attempt, so an outage costs one attempt per sweep; task run attempts 5 with exponential backoff (1 s to 60 s, randomized; the sample job 3); execution lease 5 minutes by default (per job, the sample job 1 minute), and a run that finds another run's live lease retries just after that lease ends; a run's maximum duration equals its lease; outbox claim lease 2 minutes; sweeper batch 25.
5. **Sweeper cadence 5 minutes** (about 8,600 runs a month, roughly $0.50 of the $5 credit). Nothing urgent depends on it before S14.
6. **Environments:** local `trigger dev` uses Trigger.dev's Dev environment (free runs); preview and production use their own environments and Supabase projects. Which environments the Free plan includes is checked by the owner at setup; if staging is not free, previews run no jobs.
7. **Versioning:** a job's `version` is part of the envelope. A newer version than the deployed code (or an unknown job) is retried with backoff, since the Trigger.dev deploy may simply lag the migration, and is dead after 8 attempts; an older (retired) version or an invalid payload is a permanent failure, dead in the outbox or recorded as a failed execution, never silently dropped.
8. **Correlation ID format:** a random UUID v4, generated server-side only.
9. **Logs:** one JSON line per event with `ts`, `level`, `event`, `env`, `correlationId`, `job`, sanitized `errorCode`; keys named like secrets, tokens, authorization, cookies, passwords, emails, URLs, bodies or names are replaced by `[redacted]`, and token-shaped strings in values are masked.

10. **Dependency fix:** the Trigger.dev SDK pulls `ws` 8.17.1 (high advisory GHSA-96hv-2xvq-fx4p) through socket.io-client; a scoped pnpm override `engine.io-client>ws: 8.21.3` fixes it within the same major version.

## Done when

- Unit tests on a sample job cover **duplicate execution** (second run skipped, handler side effect once), **retry** (retryable errors retried and recorded, permanent failures not retried, lease expiry recovers a crashed run) and **dispatch outage** (Trigger.dev down: rows stay pending with backoff, nothing lost, recovery on the next sweep, dead-letter after the bounded attempts, unknown job/version dead-lettered, duplicate trigger of the same row reuses the idempotency key).
- Database tests prove: no API role (anon, authenticated, even service_role) can read or write the tables; only `service_role` can execute the functions; enqueue is idempotent; two concurrent claimers never get the same row; leases expire; backoff, dead-lettering and requeue behave; executions refuse a second concurrent run and a rerun after success.
- Correlation: tests for ID generation/validation, the proxy ignoring a client-sent ID, and the logger's redaction with synthetic secrets.
- Format, lint, typecheck, unit tests, build, database tests and E2E pass; the independent review returns PASS or all BLOCKER/HIGH findings are fixed and checked; review saved in `reviews/steps/S13-review.md`.

## Tests

- **Unit** (`packages/jobs`, `packages/observability`): job definition validation (strict payloads, envelope), executor, dispatcher, backoff, error classification, Supabase store (rpc names and argument mapping against a fake client), Trigger client wrapper, task wiring, logger redaction, correlation helpers. `apps/web`: proxy header behaviour.
- **Database:** `tests/db/rls/job_outbox.test.sql` (grants, RLS, enqueue idempotency, claim/lease/backoff/dead/requeue, execution states) and a concurrency test in TypeScript beside the existing invitations concurrency test.
- **E2E:** unchanged flows must still pass (proxy change); no new E2E because no user-facing behaviour is added.

## Risks

- The new `security definer` functions run with elevated rights and are granted to `service_role`; mitigated by fixed `search_path`, input checks, no table grants, tests on grants (and the existing baseline test that fails on any function executable by PUBLIC, anon or authenticated that is not on its allowlist).
- Trigger.dev behaviour (idempotency key lifetime, schedule limits, environments on the Free plan) can only be confirmed in the real dashboard; the code is covered by fakes. The owner verifies with `docs/trigger-setup.md` once an account exists.
- The migration must be applied to `madeora-preview` and `madeora-production` by the owner before those environments use this release (`docs/supabase-migrations.md`). It is additive and unused until S14.
- Trigger.dev's Free plan stops tasks when the credit is spent; jobs would then wait in the outbox (not lost) until the next month or an upgrade the owner chooses.

## Model

**This step needs the heavier model.** It adds privileged `security definer` functions granted to `service_role`, tables that must be unreachable from every API role, and concurrency logic (`FOR UPDATE SKIP LOCKED` claiming, leases, duplicate-run races). A mistake there is silent: lost jobs, double sends or a privilege leak that normal tests do not show. The TypeScript conventions and docs are routine, but the SQL and the executor/dispatcher race handling are exactly the security and concurrency work the heavier model is for.
