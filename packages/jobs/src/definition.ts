/**
 * Typed job conventions (architecture.md §11, CLAUDE.md background processing strategy B).
 *
 * A job is defined once, with:
 * - a stable `name` (also its Trigger.dev task id) and a `version` of its payload;
 * - a strict Zod payload: an object that refuses unknown keys. Payloads are minimal and carry ids
 *   only, because Trigger.dev shows them in its dashboard and the outbox keeps them in Postgres.
 *   Never put secrets, sessions, email addresses, names or household content in a payload; the
 *   handler loads what it needs and re-checks access when it runs;
 * - a bounded retry policy and an execution lease;
 * - a handler that must be safe to run more than once for the same idempotency key (the executor
 *   skips a key that already succeeded, but a crash after an external effect and before the
 *   success is recorded can still repeat it: pass the idempotency key on to providers).
 */
import type { Logger } from "@madeora/observability";
import { isCorrelationId } from "@madeora/observability";
import { z } from "zod";

import type { JobServices } from "./services.ts";

export const JOB_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_.-]{1,200}$/;

export interface RetryPolicy {
  /** Total runs including the first, 1–10. */
  readonly maxAttempts: number;
  readonly minTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly factor: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60_000,
  factor: 2,
};

export const DEFAULT_LEASE_SECONDS = 300;

export interface JobContext {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** 1 for the first run of this execution, counting runs recorded in Postgres. */
  readonly attempt: number;
  /** Already carries the job name and correlation ID. */
  readonly logger: Logger;
  /** Data access and email for jobs that need them (S14); the sample job ignores it. */
  readonly services: JobServices;
}

// Zod's strict object: `z.strictObject({...})` or `z.object({...}).strict()`.
type StrictObject = z.ZodObject<z.ZodRawShape, z.core.$strict>;

export interface JobDefinition<Schema extends StrictObject = StrictObject> {
  readonly name: string;
  readonly version: number;
  readonly payload: Schema;
  readonly retry: RetryPolicy;
  /** How long one run may hold the execution before another run may take it over. */
  readonly leaseSeconds: number;
  handle(data: z.infer<Schema>, context: JobContext): Promise<void>;
}

export interface JobDefinitionInput<Schema extends StrictObject> {
  readonly name: string;
  readonly version: number;
  readonly payload: Schema;
  readonly retry?: Partial<RetryPolicy>;
  readonly leaseSeconds?: number;
  handle(data: z.infer<Schema>, context: JobContext): Promise<void>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid job definition: ${message}`);
}

export function defineJob<Schema extends StrictObject>(
  input: JobDefinitionInput<Schema>,
): JobDefinition<Schema> {
  const retry = { ...DEFAULT_RETRY, ...input.retry };
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  assert(JOB_NAME.test(input.name) && input.name.length <= 64, `name ${input.name}`);
  assert(Number.isInteger(input.version) && input.version >= 1 && input.version <= 1000, "version");
  // The type already asks for a strict object; this also catches casts and `.passthrough()`.
  assert(
    input.payload._zod.def.catchall?._zod.def.type === "never",
    `${input.name} payload must be strict`,
  );
  assert(Number.isInteger(retry.maxAttempts) && retry.maxAttempts >= 1, "retry.maxAttempts");
  assert(retry.maxAttempts <= 10, "retry.maxAttempts at most 10");
  assert(retry.minTimeoutMs >= 0 && retry.maxTimeoutMs >= retry.minTimeoutMs, "retry timeouts");
  assert(retry.factor >= 1, "retry.factor");
  assert(Number.isInteger(leaseSeconds) && leaseSeconds >= 10, "leaseSeconds at least 10");
  assert(leaseSeconds <= 3600, "leaseSeconds at most 3600");
  return { ...input, retry, leaseSeconds };
}

/**
 * What a job run receives from the dispatcher: the payload version, the correlation ID of the
 * request that enqueued it, the idempotency key of the execution and the job's own data.
 */
export const jobEnvelopeSchema = z.strictObject({
  v: z.int().min(1).max(1000),
  correlationId: z.string().refine(isCorrelationId),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
  data: z.record(z.string(), z.unknown()),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

export type AnyJobDefinition = JobDefinition;

/** The jobs this code knows, by name. Two jobs with one name are a programming error. */
export function createJobRegistry(
  definitions: readonly AnyJobDefinition[],
): ReadonlyMap<string, AnyJobDefinition> {
  const registry = new Map<string, AnyJobDefinition>();
  for (const definition of definitions) {
    if (registry.has(definition.name)) throw new Error(`Duplicate job ${definition.name}`);
    registry.set(definition.name, definition);
  }
  return registry;
}
