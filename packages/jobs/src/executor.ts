/**
 * Runs one job execution safely (architecture.md §11): validates the envelope and payload, claims
 * the execution in Postgres under a lease, runs the handler, records the outcome.
 *
 * - A key that already succeeded is skipped, so a duplicate run (a Trigger.dev retry after the
 *   handler finished, a replay from the dashboard, a requeued row) has no effect.
 * - A key held by another run with an unexpired lease is retried later, never run twice at once.
 * - A key that failed permanently is skipped until someone requeues it.
 * - A payload version newer than this code is retried (the new code may not be deployed yet).
 * - An invalid envelope, a retired (older) payload version or an invalid payload is a permanent
 *   failure; when the idempotency key is known it is recorded in Postgres, so it shows up in the
 *   failed-execution count instead of only in Trigger.dev's short-lived logs.
 *
 * Thrown errors are `RetryableJobError` or `PermanentJobError`; the Trigger.dev task maps them to
 * a retry or to stopping retries.
 */
import { isCorrelationId, newCorrelationId, type Logger } from "@madeora/observability";

import { jobEnvelopeSchema, type AnyJobDefinition } from "./definition.ts";
import { classifyError, PermanentJobError, RetryableJobError } from "./errors.ts";
import type { JobServices } from "./services.ts";
import type { ExecutionOutcome, ExecutionStore } from "./store.ts";

export type RunResult =
  | { readonly status: "succeeded"; readonly attempt: number }
  | { readonly status: "skipped"; readonly reason: "already_succeeded" | "failed_permanently" };

export interface RunJobDependencies {
  readonly store: ExecutionStore;
  readonly logger: Logger;
  readonly services: JobServices;
}

export async function runJob(
  definition: AnyJobDefinition,
  rawEnvelope: unknown,
  { store, logger: baseLogger, services }: RunJobDependencies,
): Promise<RunResult> {
  const envelope = jobEnvelopeSchema.safeParse(rawEnvelope);
  const rawCorrelation =
    typeof rawEnvelope === "object" && rawEnvelope !== null && "correlationId" in rawEnvelope
      ? rawEnvelope.correlationId
      : undefined;
  const logger = baseLogger.child({
    job: definition.name,
    correlationId: isCorrelationId(rawCorrelation) ? rawCorrelation : newCorrelationId(),
  });

  if (!envelope.success) {
    logger.error("jobs.run.invalid_envelope");
    throw new PermanentJobError("invalid_envelope");
  }
  const { v, correlationId, idempotencyKey, data } = envelope.data;

  // Records a permanent rejection on the execution when this run can claim it, then throws.
  const reject = async (code: string): Promise<never> => {
    try {
      const claim = await store.begin(definition.name, idempotencyKey, definition.leaseSeconds);
      if (claim.state === "claimed") {
        await store.finish(
          definition.name,
          idempotencyKey,
          claim.claimToken,
          "failed_permanent",
          code,
        );
      }
    } catch {
      logger.error("jobs.run.outcome_unrecorded", { outcome: "failed_permanent" });
    }
    throw new PermanentJobError(code);
  };

  if (v > definition.version) {
    logger.warn("jobs.run.version_not_deployed", { version: v, deployed: definition.version });
    throw new RetryableJobError("version_not_deployed");
  }
  if (v < definition.version) {
    logger.error("jobs.run.version_retired", { version: v, current: definition.version });
    return reject("version_retired");
  }
  const payload = definition.payload.safeParse(data);
  if (!payload.success) {
    logger.error("jobs.run.invalid_payload");
    return reject("invalid_payload");
  }

  let begin;
  try {
    begin = await store.begin(definition.name, idempotencyKey, definition.leaseSeconds);
  } catch {
    logger.error("jobs.run.store_unavailable");
    throw new RetryableJobError("execution_store_unavailable");
  }

  switch (begin.state) {
    case "succeeded":
      logger.info("jobs.run.duplicate_skipped");
      return { status: "skipped", reason: "already_succeeded" };
    case "failed":
      logger.warn("jobs.run.failed_skipped");
      return { status: "skipped", reason: "failed_permanently" };
    case "running":
      logger.warn("jobs.run.in_progress_elsewhere");
      throw new RetryableJobError("execution_in_progress", begin.leaseUntil);
    case "claimed":
      break;
  }

  const { claimToken, attempt } = begin;
  const record = async (outcome: ExecutionOutcome, errorCode: string | null): Promise<void> => {
    try {
      const held = await store.finish(
        definition.name,
        idempotencyKey,
        claimToken,
        outcome,
        errorCode,
      );
      if (!held) logger.warn("jobs.run.claim_lost", { outcome });
    } catch {
      // The outcome could not be stored. After a success, retrying the run would only repeat the
      // handler's effects, so the run still reports success; the lease expires and the row shows
      // `running` until then. After a failure the original error is what matters.
      logger.error("jobs.run.outcome_unrecorded", { outcome });
    }
  };

  logger.info("jobs.run.started", { attempt });
  const startedAt = Date.now();
  try {
    await definition.handle(payload.data, {
      correlationId,
      idempotencyKey,
      attempt,
      logger,
      services,
    });
  } catch (error) {
    const { kind, code } = classifyError(error);
    await record(kind === "permanent" ? "failed_permanent" : "failed_retryable", code);
    logger.error("jobs.run.failed", { attempt, kind, errorCode: code });
    throw kind === "permanent" ? new PermanentJobError(code) : new RetryableJobError(code);
  }
  await record("succeeded", null);
  logger.info("jobs.run.succeeded", { attempt, durationMs: Date.now() - startedAt });
  return { status: "succeeded", attempt };
}
