/**
 * The glue between Trigger.dev tasks and Madeora's job rules, kept apart from `task()` so it is
 * unit-tested without the Trigger.dev runtime.
 */
import { createLogger, type Logger } from "@madeora/observability";
import { AbortTaskRunError, ApiError, idempotencyKeys, tasks } from "@trigger.dev/sdk";

import type { AnyJobDefinition } from "../definition.ts";
import {
  DispatchRejectedError,
  dispatchOutbox,
  type DispatchClient,
  type DispatchOptions,
  type DispatchSummary,
} from "../dispatcher.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { runJob, type RunResult } from "../executor.ts";
import type { JobServices } from "../services.ts";
import type { ExecutionStore, OutboxStore } from "../store.ts";

export interface TriggerRunDependencies {
  readonly store: ExecutionStore & OutboxStore;
  readonly logger: Logger;
  readonly services: JobServices;
}

/**
 * Runs a job inside a Trigger.dev task. A permanent failure becomes AbortTaskRunError, which
 * stops Trigger.dev's retries; anything else is rethrown with its code only, so Trigger.dev
 * retries with the task's policy and its dashboard shows no message or personal data.
 */
export async function runJobTask(
  definition: AnyJobDefinition,
  payload: unknown,
  dependencies: TriggerRunDependencies,
): Promise<RunResult> {
  try {
    return await runJob(definition, payload, dependencies);
  } catch (error) {
    if (error instanceof PermanentJobError) throw new AbortTaskRunError(error.code);
    throw error;
  }
}

/**
 * When another run holds the execution (a crashed run's lease has not expired yet), retry just
 * after the lease ends instead of spending every attempt on the task's short backoff.
 */
export function retryTiming(error: unknown): { retryAt: Date } | undefined {
  if (error instanceof RetryableJobError && error.retryAt) {
    return { retryAt: new Date(error.retryAt.getTime() + 1_000) };
  }
  return undefined;
}

/** A client error that refuses this one run, as opposed to Trigger.dev being unreachable. */
function isRejection(error: unknown): error is ApiError & { status: number } {
  return (
    error instanceof ApiError &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** Triggers job runs through Trigger.dev's API with a global idempotency key per outbox row. */
export const triggerDispatchClient: DispatchClient = {
  async trigger(taskId, envelope, { idempotencyKey }) {
    // Global scope: inside the dispatcher's own run, a plain key would be scoped to that run, and
    // the next sweep (a different run) would then start a second run for the same row.
    const key = await idempotencyKeys.create(idempotencyKey, { scope: "global" });
    try {
      const handle = await tasks.trigger(taskId, envelope, {
        idempotencyKey: key,
        idempotencyKeyTTL: "30d",
        // Searchable in the dashboard; ids only, never personal data.
        tags: [`job:${taskId}`, `cor:${envelope.correlationId}`],
      });
      return { runId: handle.id };
    } catch (error) {
      if (isRejection(error)) throw new DispatchRejectedError(error.status);
      throw error;
    }
  },
};

export interface SweepDependencies extends DispatchOptions {
  /** Backlog counts for the log line; failures to read them never fail the sweep. */
  readonly stats?: () => Promise<Readonly<Record<string, number>>>;
}

export async function sweepOutbox(dependencies: SweepDependencies): Promise<DispatchSummary> {
  const summary = await dispatchOutbox(dependencies);
  if (dependencies.stats) {
    try {
      dependencies.logger.info("jobs.outbox.stats", await dependencies.stats());
    } catch {
      dependencies.logger.warn("jobs.outbox.stats_unavailable");
    }
  }
  return summary;
}

/** The structured logger of job runs, tagged with the environment. */
export function jobLogger(env: string): Logger {
  return createLogger({ env, fields: { service: "jobs" } });
}
