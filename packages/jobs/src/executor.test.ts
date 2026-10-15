import { createLogger } from "@madeora/observability";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineJob, type JobEnvelope } from "./definition.ts";
import { PermanentJobError, RetryableJobError } from "./errors.ts";
import { runJob } from "./executor.ts";
import { samplePing } from "./jobs/sample-ping.ts";
import { FakeJobStore } from "./testing/fake-store.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";

function setup() {
  const store = new FakeJobStore();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    env: "test",
    sink: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { store, lines, logger, events: () => lines.map((line) => line.event) };
}

function envelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  return {
    v: 1,
    correlationId: CORRELATION,
    idempotencyKey: "ping:1",
    data: { label: "hello" },
    ...overrides,
  };
}

/** A job that records each call and does whatever the test scripts for that call. */
function scriptedJob(...script: (() => Promise<void>)[]) {
  const calls: { label: string; attempt: number }[] = [];
  const job = defineJob({
    name: "scripted-job",
    version: 1,
    payload: z.strictObject({ label: z.string() }),
    leaseSeconds: 60,
    async handle(data, { attempt }) {
      calls.push({ label: data.label, attempt });
      const step = script[calls.length - 1];
      if (step) await step();
    },
  });
  return { job, calls };
}

describe("runJob: the sample job", () => {
  it("runs, records success and logs with the correlation ID", async () => {
    const { store, logger, lines, events } = setup();
    const result = await runJob(samplePing, envelope(), { store, logger });
    expect(result).toEqual({ status: "succeeded", attempt: 1 });
    expect(store.execution("sample-ping", "ping:1")?.status).toBe("succeeded");
    expect(events()).toEqual(["jobs.run.started", "jobs.sample_ping.ran", "jobs.run.succeeded"]);
    for (const line of lines) {
      expect(line).toMatchObject({ job: "sample-ping", correlationId: CORRELATION, env: "test" });
    }
  });

  it("skips a duplicate execution of the same key", async () => {
    const { store, logger, events } = setup();
    await runJob(samplePing, envelope(), { store, logger });
    const second = await runJob(samplePing, envelope(), { store, logger });
    expect(second).toEqual({ status: "skipped", reason: "already_succeeded" });
    expect(events().filter((event) => event === "jobs.sample_ping.ran")).toHaveLength(1);
    expect(events()).toContain("jobs.run.duplicate_skipped");
  });

  it("runs a different key separately", async () => {
    const { store, logger } = setup();
    await runJob(samplePing, envelope(), { store, logger });
    const other = await runJob(samplePing, envelope({ idempotencyKey: "ping:2" }), {
      store,
      logger,
    });
    expect(other.status).toBe("succeeded");
  });
});

describe("runJob: duplicate execution", () => {
  it("runs the handler once however often the same key is delivered", async () => {
    const { store, logger } = setup();
    const { job, calls } = scriptedJob();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await runJob(job, envelope(), { store, logger }));
    expect(calls).toHaveLength(1);
    expect(results.filter((result) => result.status === "skipped")).toHaveLength(4);
  });

  it("refuses a second run while the first holds the lease, retrying when the lease ends", async () => {
    const { store, logger } = setup();
    let release: () => void = () => undefined;
    const { job, calls } = scriptedJob(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = runJob(job, envelope(), { store, logger });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    const second = runJob(job, envelope(), { store, logger });
    await expect(second).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "execution_in_progress",
      retryAt: new Date(store.now + 60_000),
    });
    release();
    await expect(first).resolves.toEqual({ status: "succeeded", attempt: 1 });
    expect(calls).toHaveLength(1);
  });

  it("lets a run take over after a crashed run's lease expired, and ignores the crashed run", async () => {
    const { store, logger } = setup();
    const { job, calls } = scriptedJob();
    // A run that claimed the execution and then vanished (process killed).
    const crashed = await store.begin("scripted-job", "ping:1", 60);
    store.now += 61_000;
    const result = await runJob(job, envelope(), { store, logger });
    expect(result).toEqual({ status: "succeeded", attempt: 2 });
    expect(calls).toEqual([{ label: "hello", attempt: 2 }]);
    if (crashed.state !== "claimed") throw new Error("expected a claim");
    expect(
      await store.finish("scripted-job", "ping:1", crashed.claimToken, "failed_permanent", "late"),
    ).toBe(false);
    expect(store.execution("scripted-job", "ping:1")?.status).toBe("succeeded");
  });
});

describe("runJob: retry", () => {
  it("records a retryable failure and succeeds on the next attempt", async () => {
    const { store, logger, lines } = setup();
    const { job, calls } = scriptedJob(() =>
      Promise.reject(new RetryableJobError("provider_down")),
    );
    await expect(runJob(job, envelope(), { store, logger })).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "provider_down",
    });
    expect(store.execution("scripted-job", "ping:1")).toMatchObject({
      status: "failed_retryable",
      attempts: 1,
      lastErrorCode: "provider_down",
    });
    expect(lines.find((line) => line.event === "jobs.run.failed")).toMatchObject({
      kind: "retryable",
      errorCode: "provider_down",
      attempt: 1,
    });

    await expect(runJob(job, envelope(), { store, logger })).resolves.toEqual({
      status: "succeeded",
      attempt: 2,
    });
    expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
  });

  it("treats an unexpected error as retryable without exposing its message", async () => {
    const { store, logger, lines } = setup();
    const { job } = scriptedJob(() =>
      Promise.reject(new Error("connect to alice@example.com failed with token=secret")),
    );
    const failure = runJob(job, envelope(), { store, logger });
    await expect(failure).rejects.toBeInstanceOf(RetryableJobError);
    await expect(failure).rejects.toMatchObject({ code: "unexpected_error" });
    expect(JSON.stringify(lines)).not.toContain("alice@example.com");
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("does not retry a permanent failure, and skips the key afterwards", async () => {
    const { store, logger } = setup();
    const { job, calls } = scriptedJob(() =>
      Promise.reject(new PermanentJobError("access_revoked")),
    );
    await expect(runJob(job, envelope(), { store, logger })).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "access_revoked",
    });
    expect(store.execution("scripted-job", "ping:1")?.status).toBe("failed_permanent");
    await expect(runJob(job, envelope(), { store, logger })).resolves.toEqual({
      status: "skipped",
      reason: "failed_permanently",
    });
    expect(calls).toHaveLength(1);
  });

  it("asks for a retry when the execution store is unreachable, without running the handler", async () => {
    const { store, logger } = setup();
    const { job, calls } = scriptedJob();
    store.unavailable = true;
    await expect(runJob(job, envelope(), { store, logger })).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "execution_store_unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports success when only recording the success failed, instead of repeating the effect", async () => {
    const { store, logger, events } = setup();
    const { job, calls } = scriptedJob(() => {
      store.unavailable = true;
      return Promise.resolve();
    });
    await expect(runJob(job, envelope(), { store, logger })).resolves.toEqual({
      status: "succeeded",
      attempt: 1,
    });
    expect(calls).toHaveLength(1);
    expect(events()).toContain("jobs.run.outcome_unrecorded");
  });
});

describe("runJob: invalid input is a permanent failure", () => {
  it.each([
    ["no envelope", "just a string"],
    ["missing correlation ID", { ...envelope(), correlationId: undefined }],
    ["forged correlation ID", { ...envelope(), correlationId: "x\n{}" }],
    ["unsafe idempotency key", { ...envelope(), idempotencyKey: "a b" }],
    ["extra envelope field", { ...envelope(), session: "token" }],
  ])("%s", async (_name, raw) => {
    const { store, logger } = setup();
    await expect(runJob(samplePing, raw, { store, logger })).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "invalid_envelope",
    });
    expect(store.executions.size).toBe(0);
  });

  it("retries a payload version newer than the deployed code, without recording a failure", async () => {
    const { store, logger } = setup();
    await expect(runJob(samplePing, envelope({ v: 2 }), { store, logger })).rejects.toMatchObject({
      name: "RetryableJobError",
      code: "version_not_deployed",
    });
    expect(store.executions.size).toBe(0);
  });

  it("refuses and records a retired payload version", async () => {
    const { store, logger } = setup();
    const v2 = defineJob({
      name: "scripted-job",
      version: 2,
      payload: z.strictObject({ label: z.string() }),
      handle: () => Promise.resolve(),
    });
    await expect(runJob(v2, envelope({ v: 1 }), { store, logger })).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "version_retired",
    });
    expect(store.execution("scripted-job", "ping:1")).toMatchObject({
      status: "failed_permanent",
      lastErrorCode: "version_retired",
    });
  });

  it.each([
    ["wrong type", { label: 42 }],
    ["unknown key", { label: "ok", email: "a@b.c" }],
    ["unsafe label", { label: "Alice Smith" }],
  ])("refuses an invalid payload: %s", async (_name, data) => {
    const { store, logger } = setup();
    await expect(runJob(samplePing, envelope({ data }), { store, logger })).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "invalid_payload",
    });
    // Recorded in Postgres, so the failed-execution count shows it.
    expect(store.execution("sample-ping", "ping:1")).toMatchObject({
      status: "failed_permanent",
      lastErrorCode: "invalid_payload",
    });
  });

  it("still refuses an invalid payload when the failure cannot be recorded", async () => {
    const { store, logger, events } = setup();
    store.unavailable = true;
    await expect(
      runJob(samplePing, envelope({ data: { label: 42 } }), { store, logger }),
    ).rejects.toMatchObject({ name: "PermanentJobError", code: "invalid_payload" });
    expect(events()).toContain("jobs.run.outcome_unrecorded");
  });
});
