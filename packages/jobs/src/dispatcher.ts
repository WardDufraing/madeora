/**
 * Moves committed outbox rows to Trigger.dev (architecture.md §11: transactional outbox).
 *
 * Business code writes an outbox row in the same transaction as its own change
 * (`private.enqueue_job`), so a job exists exactly when the change committed. The dispatcher, run
 * on a schedule inside Trigger.dev, claims due rows and triggers one task run per row:
 *
 * - The Trigger.dev idempotency key is derived from the row (job, row id, generation), so a crash
 *   between triggering and recording `dispatched` cannot start a second run: the row's lease
 *   expires, the next sweep triggers again and Trigger.dev returns the run it already has. The row
 *   id keeps a re-created row (after a database reset that reuses business keys) from being
 *   mistaken for an old one.
 * - When Trigger.dev cannot be reached, the row goes back to `pending` with exponential backoff
 *   and the rest of the batch is released untried, so an outage costs one attempt per sweep,
 *   not one per row. When Trigger.dev refuses one row (its task is not deployed, a bad request),
 *   only that row backs off and the batch carries on. After the bounded attempts the row is
 *   `dead`, kept for manual requeue.
 * - A job or payload version this code does not know yet is retried with backoff: the tasks may
 *   simply not be deployed yet. A version older than the code handles, or an invalid payload, can
 *   never run and is `dead` at once.
 */
import type { Logger } from "@madeora/observability";

import { jobEnvelopeSchema, type AnyJobDefinition, type JobEnvelope } from "./definition.ts";
import type { OutboxRow, OutboxStore } from "./store.ts";

export interface DispatchClient {
  /** Triggers one run; with the same idempotency key, returns the existing run instead. */
  trigger(
    taskId: string,
    envelope: JobEnvelope,
    options: { readonly idempotencyKey: string },
  ): Promise<{ readonly runId: string }>;
}

export interface DispatchOptions {
  readonly store: OutboxStore;
  readonly client: DispatchClient;
  readonly registry: ReadonlyMap<string, AnyJobDefinition>;
  readonly logger: Logger;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly dispatched: number;
  /** Back to `pending` with backoff after a failed trigger. */
  readonly retrying: number;
  readonly dead: number;
  /** Claimed but not tried because Trigger.dev was unreachable earlier in this batch. */
  readonly released: number;
  /** Store calls that failed after the row was handled; leases make them safe to retry. */
  readonly unrecorded: number;
}

/**
 * Trigger.dev answered but refused this one run (a client error other than timeout or rate
 * limit), as opposed to being unreachable. `DispatchClient` implementations throw it.
 */
export class DispatchRejectedError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`dispatch rejected (${String(status)})`);
    this.name = "DispatchRejectedError";
    this.status = status;
  }
}

export const DISPATCH_BATCH_SIZE = 25;
export const DISPATCH_LEASE_SECONDS = 120;

/** The Trigger.dev idempotency key of an outbox row. */
export function dispatchKey(row: Pick<OutboxRow, "jobName" | "id" | "generation">) {
  return `${row.jobName}:${row.id}:${String(row.generation)}`;
}

type Check = { ok: true; envelope: JobEnvelope } | { ok: false; code: string; permanent: boolean };

function check(row: OutboxRow, registry: DispatchOptions["registry"]): Check {
  const definition = registry.get(row.jobName);
  // Enqueued by a migration whose tasks are not deployed yet: wait for the deploy.
  if (!definition) return { ok: false, code: "unknown_job", permanent: false };
  if (row.jobVersion > definition.version) {
    return { ok: false, code: "version_not_deployed", permanent: false };
  }
  if (row.jobVersion < definition.version) {
    return { ok: false, code: "version_retired", permanent: true };
  }
  if (!definition.payload.safeParse(row.payload).success) {
    return { ok: false, code: "invalid_payload", permanent: true };
  }
  const envelope = jobEnvelopeSchema.safeParse({
    v: row.jobVersion,
    correlationId: row.correlationId,
    idempotencyKey: row.idempotencyKey,
    data: row.payload,
  });
  return envelope.success
    ? { ok: true, envelope: envelope.data }
    : { ok: false, code: "invalid_envelope", permanent: true };
}

export async function dispatchOutbox(options: DispatchOptions): Promise<DispatchSummary> {
  const { store, client, registry, logger } = options;
  const rows = await store.claim(
    options.batchSize ?? DISPATCH_BATCH_SIZE,
    options.leaseSeconds ?? DISPATCH_LEASE_SECONDS,
  );
  let dispatched = 0;
  let retrying = 0;
  let dead = 0;
  let unrecorded = 0;
  let released = 0;

  const recordFailure = async (
    row: OutboxRow,
    rowLogger: Logger,
    code: string,
    permanent: boolean,
  ) => {
    try {
      const status = await store.fail(row.id, code, permanent);
      if (status === "dead") dead += 1;
      else if (status === "pending") retrying += 1;
      rowLogger.warn(status === "dead" ? "jobs.outbox.dead" : "jobs.outbox.retry_scheduled", {
        errorCode: code,
        attempts: row.attempts,
      });
    } catch {
      unrecorded += 1;
      rowLogger.error("jobs.outbox.failure_unrecorded", { errorCode: code });
    }
  };

  for (const [index, row] of rows.entries()) {
    const rowLogger = logger.child({ job: row.jobName, correlationId: row.correlationId });
    const checked = check(row, registry);
    if (!checked.ok) {
      await recordFailure(row, rowLogger, checked.code, checked.permanent);
      continue;
    }

    let runId: string;
    try {
      ({ runId } = await client.trigger(row.jobName, checked.envelope, {
        idempotencyKey: dispatchKey(row),
      }));
    } catch (error) {
      if (error instanceof DispatchRejectedError) {
        await recordFailure(row, rowLogger, "trigger_rejected", false);
        rowLogger.warn("jobs.outbox.trigger_rejected", { status: error.status });
        continue;
      }
      await recordFailure(row, rowLogger, "trigger_unavailable", false);
      // Trigger.dev is unreachable: do not spend an attempt of every other row on it.
      const untried = rows.slice(index + 1).map((other) => other.id);
      if (untried.length > 0) {
        try {
          released = await store.release(untried);
        } catch {
          unrecorded += untried.length;
        }
        logger.warn("jobs.outbox.batch_released", { released: untried.length });
      }
      break;
    }

    try {
      const held = await store.complete(row.id, runId);
      if (!held) rowLogger.warn("jobs.outbox.claim_lost");
      dispatched += 1;
      rowLogger.info("jobs.outbox.dispatched", { attempts: row.attempts, runId });
    } catch {
      // Triggered but not recorded: the lease expires and the next sweep triggers again with the
      // same idempotency key, which returns this same run.
      dispatched += 1;
      unrecorded += 1;
      rowLogger.error("jobs.outbox.dispatch_unrecorded", { runId });
    }
  }

  const summary = { claimed: rows.length, dispatched, retrying, dead, released, unrecorded };
  logger.info("jobs.outbox.swept", summary);
  return summary;
}
