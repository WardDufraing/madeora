/**
 * What the executor and the dispatcher need from Postgres. The production implementation calls
 * the `service_role`-only functions of the S13 migration through `supabase.rpc()`
 * (`supabase-store.ts`); tests use in-memory fakes with the same rules.
 */

/** One outbox row claimed for dispatch. */
export interface OutboxRow {
  readonly id: string;
  readonly jobName: string;
  readonly jobVersion: number;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  /** Dispatch attempts so far, including this claim. */
  readonly attempts: number;
  /** Raised by every manual requeue, so Trigger.dev treats the requeued row as a new run. */
  readonly generation: number;
}

export interface OutboxStore {
  /** Claims up to `limit` due rows for `leaseSeconds`; no two callers get the same row. */
  claim(limit: number, leaseSeconds: number): Promise<readonly OutboxRow[]>;
  /** Marks a claimed row dispatched; false when the claim was lost (lease expired). */
  complete(id: string, runId: string): Promise<boolean>;
  /**
   * Records a failed dispatch: `pending` again with backoff, or `dead` when it was permanent or
   * the attempts are used up. `missing` when the row is no longer claimed.
   */
  fail(id: string, errorCode: string, permanent: boolean): Promise<"pending" | "dead" | "missing">;
  /** Hands back claimed rows that were not tried, without counting an attempt. */
  release(ids: readonly string[]): Promise<number>;
}

export type ExecutionOutcome = "succeeded" | "failed_retryable" | "failed_permanent";

export type ExecutionBegin =
  /** This run holds the execution until its lease ends. */
  | { readonly state: "claimed"; readonly claimToken: string; readonly attempt: number }
  /** A run for this key already succeeded: skip. */
  | { readonly state: "succeeded" }
  /** A run for this key failed permanently: skip until someone requeues it. */
  | { readonly state: "failed" }
  /** Another run holds an unexpired lease: try again once it ends. */
  | { readonly state: "running"; readonly leaseUntil: Date };

export interface ExecutionStore {
  begin(jobName: string, idempotencyKey: string, leaseSeconds: number): Promise<ExecutionBegin>;
  /** Records the outcome; false when this run no longer holds the claim. */
  finish(
    jobName: string,
    idempotencyKey: string,
    claimToken: string,
    outcome: ExecutionOutcome,
    errorCode: string | null,
  ): Promise<boolean>;
}
