/**
 * The Postgres side of jobs, through the `service_role`-only functions of the S13 migration
 * (CLAUDE.md database access strategy A: `supabase.rpc()` only, no direct table access; the
 * service role has none). Used inside Trigger.dev runs only, never in the web app.
 */
import type { Database, Json } from "@madeora/database";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ExecutionBegin, ExecutionStore, OutboxRow, OutboxStore } from "./store.ts";

export type JobsSupabaseClient = SupabaseClient<Database>;

export class JobStoreError extends Error {
  /** Postgres or PostgREST error code, never the message (it may echo arguments). */
  readonly code: string;
  constructor(operation: string, code: string | undefined) {
    super(`${operation} failed (${code ?? "unknown"})`);
    this.name = "JobStoreError";
    this.code = code ?? "unknown";
  }
}

function isObject(value: Json): value is Readonly<Record<string, Json | undefined>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSupabaseJobStore(client: JobsSupabaseClient): OutboxStore & ExecutionStore {
  return {
    async claim(limit, leaseSeconds) {
      const { data, error } = await client.rpc("claim_job_outbox", {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new JobStoreError("claim_job_outbox", error.code);
      return data.map((row): OutboxRow => ({
        id: row.id,
        jobName: row.job_name,
        jobVersion: row.job_version,
        idempotencyKey: row.idempotency_key,
        // The table only accepts objects; anything else fails the payload check as `{}` would.
        payload: isObject(row.payload) ? row.payload : {},
        correlationId: row.correlation_id,
        attempts: row.attempts,
        generation: row.generation,
      }));
    },

    async complete(id, runId) {
      const { data, error } = await client.rpc("complete_job_outbox", {
        p_id: id,
        p_run_id: runId,
      });
      if (error) throw new JobStoreError("complete_job_outbox", error.code);
      return data;
    },

    async fail(id, errorCode, permanent) {
      const { data, error } = await client.rpc("fail_job_outbox", {
        p_id: id,
        p_error_code: errorCode,
        p_permanent: permanent,
      });
      if (error) throw new JobStoreError("fail_job_outbox", error.code);
      if (data !== "pending" && data !== "dead" && data !== "missing") {
        throw new JobStoreError("fail_job_outbox", "unexpected_result");
      }
      return data;
    },

    async release(ids) {
      const { data, error } = await client.rpc("release_job_outbox", { p_ids: [...ids] });
      if (error) throw new JobStoreError("release_job_outbox", error.code);
      return data;
    },

    async begin(jobName, idempotencyKey, leaseSeconds): Promise<ExecutionBegin> {
      const { data, error } = await client.rpc("begin_job_execution", {
        p_job_name: jobName,
        p_idempotency_key: idempotencyKey,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new JobStoreError("begin_job_execution", error.code);
      const [row] = data;
      switch (row?.state) {
        case "claimed":
          // `claim_token` is set whenever the state is `claimed` (the generated type cannot say so).
          if (!row.claim_token) break;
          return { state: "claimed", claimToken: row.claim_token, attempt: row.attempt };
        case "running":
          if (!row.lease_until) break;
          return { state: "running", leaseUntil: new Date(row.lease_until) };
        case "succeeded":
        case "failed":
          return { state: row.state };
      }
      throw new JobStoreError("begin_job_execution", "unexpected_result");
    },

    async finish(jobName, idempotencyKey, claimToken, outcome, errorCode) {
      const { data, error } = await client.rpc("finish_job_execution", {
        p_job_name: jobName,
        p_idempotency_key: idempotencyKey,
        p_claim_token: claimToken,
        p_outcome: outcome,
        ...(errorCode === null ? {} : { p_error_code: errorCode }),
      });
      if (error) throw new JobStoreError("finish_job_execution", error.code);
      return data;
    },
  };
}
