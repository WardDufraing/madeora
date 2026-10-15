// Background job conventions (S13, ADR 0017). Framework-independent: Trigger.dev is only imported
// under src/trigger/, which the Trigger.dev CLI bundles and deploys.
export {
  createJobRegistry,
  defineJob,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_RETRY,
  IDEMPOTENCY_KEY,
  JOB_NAME,
  jobEnvelopeSchema,
  type AnyJobDefinition,
  type JobContext,
  type JobDefinition,
  type JobEnvelope,
  type RetryPolicy,
} from "./definition.ts";
export {
  DISPATCH_BATCH_SIZE,
  DISPATCH_LEASE_SECONDS,
  dispatchKey,
  DispatchRejectedError,
  dispatchOutbox,
  type DispatchClient,
  type DispatchSummary,
} from "./dispatcher.ts";
export {
  classifyError,
  PermanentJobError,
  RetryableJobError,
  safeErrorCode,
  type FailureKind,
} from "./errors.ts";
export { runJob, type RunResult } from "./executor.ts";
export { jobRegistry, jobs } from "./registry.ts";
export type {
  ExecutionBegin,
  ExecutionOutcome,
  ExecutionStore,
  OutboxRow,
  OutboxStore,
} from "./store.ts";
export {
  createSupabaseJobStore,
  JobStoreError,
  type JobsSupabaseClient,
} from "./supabase-store.ts";
