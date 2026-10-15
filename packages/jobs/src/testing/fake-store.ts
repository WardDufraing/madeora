/**
 * In-memory stand-in for the S13 Postgres functions, with the same rules (claim leases, backoff,
 * dead-lettering after 8 attempts, release, requeue, execution claims). Test-only; the real
 * functions are covered by tests/db/rls/job_outbox.test.sql.
 */
import type {
  ExecutionBegin,
  ExecutionOutcome,
  ExecutionStore,
  OutboxRow,
  OutboxStore,
} from "../store.ts";

export const MAX_DISPATCH_ATTEMPTS = 8;

interface OutboxRecord {
  id: string;
  jobName: string;
  jobVersion: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  correlationId: string;
  status: "pending" | "dispatching" | "dispatched" | "dead";
  attempts: number;
  generation: number;
  availableAt: number;
  leaseUntil: number | null;
  runId: string | null;
  lastErrorCode: string | null;
}

interface ExecutionRecord {
  status: "running" | "succeeded" | "failed_retryable" | "failed_permanent";
  attempts: number;
  claimToken: string | null;
  leaseUntil: number | null;
  lastErrorCode: string | null;
}

export class FakeJobStore implements OutboxStore, ExecutionStore {
  readonly outbox = new Map<string, OutboxRecord>();
  readonly executions = new Map<string, ExecutionRecord>();
  /** Milliseconds; tests move it forward. */
  now = Date.parse("2026-10-15T10:00:00.000Z");
  /** When set, every call throws, as when Postgres cannot be reached. */
  unavailable = false;
  private sequence = 0;

  private check(): void {
    if (this.unavailable) throw new Error("database unavailable");
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence)}`;
  }

  enqueue(input: {
    jobName: string;
    jobVersion?: number;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    correlationId?: string;
  }): string {
    for (const row of this.outbox.values()) {
      if (row.jobName === input.jobName && row.idempotencyKey === input.idempotencyKey) {
        if (JSON.stringify(row.payload) !== JSON.stringify(input.payload)) {
          throw new Error("job key reused with a different payload");
        }
        return row.id;
      }
    }
    const id = this.nextId("row");
    this.outbox.set(id, {
      id,
      jobName: input.jobName,
      jobVersion: input.jobVersion ?? 1,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      correlationId: input.correlationId ?? "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
      status: "pending",
      attempts: 0,
      generation: 0,
      availableAt: this.now,
      leaseUntil: null,
      runId: null,
      lastErrorCode: null,
    });
    return id;
  }

  row(id: string): OutboxRecord {
    const row = this.outbox.get(id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  claim(limit: number, leaseSeconds: number): Promise<readonly OutboxRow[]> {
    this.check();
    for (const row of this.outbox.values()) {
      if (
        row.status === "dispatching" &&
        (row.leaseUntil ?? 0) <= this.now &&
        row.attempts >= MAX_DISPATCH_ATTEMPTS
      ) {
        Object.assign(row, { status: "dead", leaseUntil: null, lastErrorCode: "lease_expired" });
      }
    }
    const due = [...this.outbox.values()]
      .filter(
        (row) =>
          (row.status === "pending" && row.availableAt <= this.now) ||
          (row.status === "dispatching" && (row.leaseUntil ?? 0) <= this.now),
      )
      .sort((a, b) => (a.leaseUntil ?? a.availableAt) - (b.leaseUntil ?? b.availableAt))
      .slice(0, limit);
    return Promise.resolve(
      due.map((row) => {
        row.status = "dispatching";
        row.attempts += 1;
        row.leaseUntil = this.now + leaseSeconds * 1000;
        return {
          id: row.id,
          jobName: row.jobName,
          jobVersion: row.jobVersion,
          idempotencyKey: row.idempotencyKey,
          payload: row.payload,
          correlationId: row.correlationId,
          attempts: row.attempts,
          generation: row.generation,
        };
      }),
    );
  }

  complete(id: string, runId: string): Promise<boolean> {
    this.check();
    const row = this.outbox.get(id);
    if (row?.status !== "dispatching") return Promise.resolve(false);
    Object.assign(row, { status: "dispatched", leaseUntil: null, runId, lastErrorCode: null });
    return Promise.resolve(true);
  }

  fail(id: string, errorCode: string, permanent: boolean): Promise<"pending" | "dead" | "missing"> {
    this.check();
    const row = this.outbox.get(id);
    if (row?.status !== "dispatching") return Promise.resolve("missing");
    const dead = permanent || row.attempts >= MAX_DISPATCH_ATTEMPTS;
    row.status = dead ? "dead" : "pending";
    row.leaseUntil = null;
    row.lastErrorCode = errorCode;
    if (!dead) {
      row.availableAt = this.now + Math.min(30 * 2 ** Math.max(row.attempts - 1, 0), 3600) * 1000;
    }
    return Promise.resolve(row.status === "dead" ? "dead" : "pending");
  }

  release(ids: readonly string[]): Promise<number> {
    this.check();
    let count = 0;
    for (const id of ids) {
      const row = this.outbox.get(id);
      if (row?.status !== "dispatching") continue;
      Object.assign(row, {
        status: "pending",
        leaseUntil: null,
        attempts: Math.max(row.attempts - 1, 0),
        availableAt: this.now + 60_000,
      });
      count += 1;
    }
    return Promise.resolve(count);
  }

  requeue(id: string): boolean {
    const row = this.row(id);
    if (row.status !== "dead" && row.status !== "dispatched") return false;
    Object.assign(row, {
      status: "pending",
      attempts: 0,
      generation: row.generation + 1,
      leaseUntil: null,
      availableAt: this.now,
      runId: null,
      lastErrorCode: null,
    });
    const key = `${row.jobName}|${row.idempotencyKey}`;
    const execution = this.executions.get(key);
    if (execution && execution.status !== "succeeded" && execution.status !== "running") {
      this.executions.delete(key);
    }
    return true;
  }

  begin(jobName: string, idempotencyKey: string, leaseSeconds: number): Promise<ExecutionBegin> {
    this.check();
    const key = `${jobName}|${idempotencyKey}`;
    const existing = this.executions.get(key);
    const claim = (attempts: number): ExecutionBegin => {
      const claimToken = this.nextId("token");
      this.executions.set(key, {
        status: "running",
        attempts,
        claimToken,
        leaseUntil: this.now + leaseSeconds * 1000,
        lastErrorCode: existing?.lastErrorCode ?? null,
      });
      return { state: "claimed", claimToken, attempt: attempts };
    };
    if (!existing) return Promise.resolve(claim(1));
    if (existing.status === "succeeded") return Promise.resolve({ state: "succeeded" });
    if (existing.status === "failed_permanent") return Promise.resolve({ state: "failed" });
    if (existing.status === "running" && (existing.leaseUntil ?? 0) > this.now) {
      return Promise.resolve({ state: "running", leaseUntil: new Date(existing.leaseUntil ?? 0) });
    }
    return Promise.resolve(claim(existing.attempts + 1));
  }

  finish(
    jobName: string,
    idempotencyKey: string,
    claimToken: string,
    outcome: ExecutionOutcome,
    errorCode: string | null,
  ): Promise<boolean> {
    this.check();
    const execution = this.executions.get(`${jobName}|${idempotencyKey}`);
    if (execution?.status !== "running" || execution.claimToken !== claimToken) {
      return Promise.resolve(false);
    }
    Object.assign(execution, {
      status: outcome,
      claimToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode,
    });
    return Promise.resolve(true);
  }

  execution(jobName: string, idempotencyKey: string): ExecutionRecord | undefined {
    return this.executions.get(`${jobName}|${idempotencyKey}`);
  }
}
