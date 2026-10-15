import { createLogger } from "@madeora/observability";
import { AbortTaskRunError, ApiError } from "@trigger.dev/sdk";
import type * as TriggerSdk from "@trigger.dev/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DispatchRejectedError } from "../dispatcher.ts";
import { RetryableJobError } from "../errors.ts";
import { samplePing } from "../jobs/sample-ping.ts";
import { jobRegistry, jobs } from "../registry.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { parseWorkerEnv } from "./env.ts";

const sdk = vi.hoisted(() => ({
  create: vi.fn((key: string, options: { scope: string }) =>
    Promise.resolve(`hashed(${key},${options.scope})`),
  ),
  trigger: vi.fn(() => Promise.resolve({ id: "run_123" })),
}));

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof TriggerSdk>();
  return {
    ...actual,
    idempotencyKeys: { ...actual.idempotencyKeys, create: sdk.create },
    tasks: { ...actual.tasks, trigger: sdk.trigger },
  };
});

const { retryTiming, runJobTask, sweepOutbox, triggerDispatchClient } = await import("./run.ts");
const tasksModule = await import("./tasks.ts");

const logger = createLogger({ env: "test", sink: () => undefined });
const envelope = {
  v: 1,
  correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
  idempotencyKey: "ping:1",
  data: { label: "hello" },
};

beforeEach(() => {
  sdk.create.mockClear();
  sdk.trigger.mockClear();
});

describe("Trigger.dev tasks", () => {
  it("exports one task per job, with the job's name as id, plus the outbox dispatcher", () => {
    const ids = Object.values(tasksModule).map((exported) => exported.id);
    expect(ids.sort()).toEqual([...jobs.map((job) => job.name), "outbox-dispatch"].sort());
  });
});

describe("runJobTask", () => {
  it("returns the run result", async () => {
    const store = new FakeJobStore();
    await expect(runJobTask(samplePing, envelope, { store, logger })).resolves.toEqual({
      status: "succeeded",
      attempt: 1,
    });
  });

  it("turns a permanent failure into AbortTaskRunError, so Trigger.dev stops retrying", async () => {
    const store = new FakeJobStore();
    const failure = runJobTask(samplePing, { ...envelope, data: { label: 42 } }, { store, logger });
    await expect(failure).rejects.toBeInstanceOf(AbortTaskRunError);
    await expect(failure).rejects.toThrow("invalid_payload");
  });

  it("rethrows a retryable failure for Trigger.dev's retry policy", async () => {
    const store = new FakeJobStore();
    store.unavailable = true;
    await expect(runJobTask(samplePing, envelope, { store, logger })).rejects.toBeInstanceOf(
      RetryableJobError,
    );
  });
});

describe("retryTiming", () => {
  it("retries just after another run's lease ends", () => {
    const leaseUntil = new Date("2026-10-15T10:05:00.000Z");
    expect(retryTiming(new RetryableJobError("execution_in_progress", leaseUntil))).toEqual({
      retryAt: new Date("2026-10-15T10:05:01.000Z"),
    });
  });

  it("leaves other errors to the task's backoff", () => {
    expect(retryTiming(new RetryableJobError("busy"))).toBeUndefined();
    expect(retryTiming(new Error("x"))).toBeUndefined();
  });
});

describe("triggerDispatchClient", () => {
  it("triggers with a global idempotency key and id-only tags", async () => {
    const result = await triggerDispatchClient.trigger("sample-ping", envelope, {
      idempotencyKey: "sample-ping:row-1:0",
    });
    expect(result).toEqual({ runId: "run_123" });
    expect(sdk.create).toHaveBeenCalledWith("sample-ping:row-1:0", { scope: "global" });
    expect(sdk.trigger).toHaveBeenCalledWith("sample-ping", envelope, {
      idempotencyKey: "hashed(sample-ping:row-1:0,global)",
      idempotencyKeyTTL: "30d",
      tags: ["job:sample-ping", "cor:0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f"],
    });
  });
});

describe("triggerDispatchClient errors", () => {
  it.each([400, 404, 422])("reports a %s answer as a rejection of this one run", async (status) => {
    sdk.trigger.mockRejectedValueOnce(new ApiError(status, {}, "refused", undefined));
    const failure = triggerDispatchClient.trigger("sample-ping", envelope, {
      idempotencyKey: "k",
    });
    await expect(failure).rejects.toBeInstanceOf(DispatchRejectedError);
    await expect(failure).rejects.toMatchObject({ status });
  });

  it.each([408, 429, 500, 503, undefined])(
    "passes a %s answer on as Trigger.dev being unavailable",
    async (status) => {
      sdk.trigger.mockRejectedValueOnce(new ApiError(status, {}, "unavailable", undefined));
      const failure = triggerDispatchClient.trigger("sample-ping", envelope, {
        idempotencyKey: "k",
      });
      await expect(failure).rejects.toBeInstanceOf(ApiError);
      await expect(failure).rejects.not.toBeInstanceOf(DispatchRejectedError);
    },
  );
});

describe("sweepOutbox", () => {
  it("dispatches and logs the backlog", async () => {
    const store = new FakeJobStore();
    store.enqueue({ jobName: "sample-ping", idempotencyKey: "ping:1", payload: { label: "x" } });
    const lines: Record<string, unknown>[] = [];
    const sweepLogger = createLogger({
      env: "test",
      sink: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    const summary = await sweepOutbox({
      store,
      client: triggerDispatchClient,
      registry: jobRegistry,
      logger: sweepLogger,
      stats: () => Promise.resolve({ pending: 0, dead: 0 }),
    });
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(lines.find((line) => line.event === "jobs.outbox.stats")).toMatchObject({
      pending: 0,
      dead: 0,
    });
  });

  it("still succeeds when the stats cannot be read", async () => {
    const store = new FakeJobStore();
    const summary = await sweepOutbox({
      store,
      client: triggerDispatchClient,
      registry: jobRegistry,
      logger,
      stats: () => Promise.reject(new Error("db down")),
    });
    expect(summary.claimed).toBe(0);
  });
});

describe("worker environment", () => {
  const valid = {
    APP_ENV: "development",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abcdefghijklmnopqrstuvwxyz",
  };

  it("accepts a complete configuration", () => {
    expect(parseWorkerEnv(valid)).toEqual(valid);
  });

  it("names missing and invalid variables without their values", () => {
    try {
      parseWorkerEnv({
        ...valid,
        SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_not-a-secret-key",
        APP_ENV: "",
      });
      expect.unreachable();
    } catch (error) {
      const message = String(error);
      expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY (invalid)");
      expect(message).toContain("APP_ENV (missing)");
      expect(message).not.toContain("not-a-secret-key");
    }
  });
});
