import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "./definition.ts";
import {
  dispatchKey,
  dispatchOutbox,
  DispatchRejectedError,
  type DispatchClient,
} from "./dispatcher.ts";
import { RetryableJobError } from "./errors.ts";
import { runJob } from "./executor.ts";
import { jobRegistry } from "./registry.ts";
import { FakeJobStore, MAX_DISPATCH_ATTEMPTS } from "./testing/fake-store.ts";
import { fakeServices } from "./testing/fake-services.ts";

/**
 * A stand-in for Trigger.dev: one run per idempotency key (as Trigger.dev returns the existing run
 * for a key it has seen), and an `down` switch for outages.
 */
class FakeTrigger implements DispatchClient {
  down = false;
  /** Idempotency keys (business keys) whose trigger Trigger.dev refuses. */
  reject = new Set<string>();
  readonly runs = new Map<string, { taskId: string; envelope: JobEnvelope; runId: string }>();
  calls = 0;

  trigger(taskId: string, envelope: JobEnvelope, { idempotencyKey }: { idempotencyKey: string }) {
    this.calls += 1;
    if (this.down) return Promise.reject(new Error("fetch failed: ECONNRESET"));
    if (this.reject.has(envelope.idempotencyKey)) {
      return Promise.reject(new DispatchRejectedError(404));
    }
    const existing = this.runs.get(idempotencyKey);
    if (existing) return Promise.resolve({ runId: existing.runId });
    const runId = `run_${String(this.runs.size + 1)}`;
    this.runs.set(idempotencyKey, { taskId, envelope, runId });
    return Promise.resolve({ runId });
  }
}

function setup() {
  const store = new FakeJobStore();
  const client = new FakeTrigger();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    env: "test",
    sink: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const sweep = () => dispatchOutbox({ store, client, registry: jobRegistry, logger });
  const ping = (key: string, label = "hello") =>
    store.enqueue({ jobName: "sample-ping", idempotencyKey: key, payload: { label } });
  return { store, client, lines, logger, sweep, ping };
}

describe("dispatchOutbox", () => {
  it("triggers each due row once, with its envelope and a key per row and generation", async () => {
    const { store, client, sweep, ping } = setup();
    const id = ping("ping:1");
    const summary = await sweep();
    expect(summary).toEqual({
      claimed: 1,
      dispatched: 1,
      retrying: 0,
      dead: 0,
      released: 0,
      unrecorded: 0,
    });
    expect([...client.runs.entries()]).toEqual([
      [
        `sample-ping:${id}:0`,
        {
          taskId: "sample-ping",
          runId: "run_1",
          envelope: {
            v: 1,
            correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
            idempotencyKey: "ping:1",
            data: { label: "hello" },
          },
        },
      ],
    ]);
    expect(store.row(id)).toMatchObject({ status: "dispatched", runId: "run_1", attempts: 1 });
    expect(await sweep()).toMatchObject({ claimed: 0 });
  });

  it("logs every row with the correlation ID of the request that enqueued it", async () => {
    const { lines, sweep, ping } = setup();
    ping("ping:1");
    await sweep();
    expect(lines.find((line) => line.event === "jobs.outbox.dispatched")).toMatchObject({
      job: "sample-ping",
      correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
      runId: "run_1",
    });
  });

  it("does not wait for rows scheduled later", async () => {
    const { store, sweep, ping } = setup();
    const id = ping("ping:later");
    store.row(id).availableAt = store.now + 60_000;
    expect(await sweep()).toMatchObject({ claimed: 0 });
  });

  it.each([
    [
      "a retired version",
      { jobName: "sample-ping", jobVersion: 0, payload: { label: "x" } },
      "version_retired",
    ],
    [
      "an invalid payload",
      { jobName: "sample-ping", payload: { label: "x", email: "a@b.c" } },
      "invalid_payload",
    ],
  ])("dead-letters %s at once and carries on with the batch", async (_name, row, code) => {
    const { store, client, sweep, ping } = setup();
    const bad = store.enqueue({ idempotencyKey: "bad", ...row });
    const good = ping("ping:good");
    expect(await sweep()).toMatchObject({ claimed: 2, dispatched: 1, dead: 1 });
    expect(store.row(bad)).toMatchObject({ status: "dead", lastErrorCode: code, attempts: 1 });
    expect(store.row(good).status).toBe("dispatched");
    expect(client.runs.size).toBe(1);
  });

  it.each([
    ["a job whose task is not deployed yet", { jobName: "new-job", payload: {} }, "unknown_job"],
    [
      "a payload version newer than the deployed code",
      { jobName: "sample-ping", jobVersion: 2, payload: { label: "x" } },
      "version_not_deployed",
    ],
  ])("retries %s with backoff instead of dead-lettering it", async (_name, row, code) => {
    const { store, client, sweep, ping } = setup();
    const waiting = store.enqueue({ idempotencyKey: "early", ...row });
    const good = ping("ping:good");
    expect(await sweep()).toMatchObject({ claimed: 2, dispatched: 1, retrying: 1, dead: 0 });
    expect(store.row(waiting)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: code,
      availableAt: store.now + 30_000,
    });
    expect(store.row(good).status).toBe("dispatched");
    expect(client.runs.size).toBe(1);
  });

  it("backs off a row Trigger.dev refuses and carries on with the batch", async () => {
    const { store, client, sweep, ping } = setup();
    const refused = ping("ping:refused");
    const good = ping("ping:good");
    client.reject = new Set(["ping:refused"]);
    expect(await sweep()).toMatchObject({
      claimed: 2,
      dispatched: 1,
      retrying: 1,
      released: 0,
    });
    expect(store.row(refused)).toMatchObject({
      status: "pending",
      lastErrorCode: "trigger_rejected",
    });
    expect(store.row(good).status).toBe("dispatched");
  });

  it("gives a re-created row its own run, even with a reused business key", async () => {
    const { store, client, sweep, ping } = setup();
    const first = ping("ping:reused");
    await sweep();
    // A database reset recreates the row under a new id; Trigger.dev still remembers the old key.
    store.outbox.delete(first);
    const second = ping("ping:reused");
    await sweep();
    expect(store.row(second)).toMatchObject({ status: "dispatched", runId: "run_2" });
    expect(client.runs.size).toBe(2);
  });
});

describe("dispatchOutbox: dispatch outage", () => {
  it("keeps every row while Trigger.dev is down, spends one attempt per sweep, and delivers after recovery", async () => {
    const { store, client, sweep, ping, lines } = setup();
    const ids = ["a", "b", "c"].map((key) => ping(`ping:${key}`));
    client.down = true;

    const first = await sweep();
    expect(first).toEqual({
      claimed: 3,
      dispatched: 0,
      retrying: 1,
      dead: 0,
      released: 2,
      unrecorded: 0,
    });
    // One call reached the dead client; the rest of the batch was released untried.
    expect(client.calls).toBe(1);
    const [tried, ...untried] = ids.map((id) => store.row(id));
    expect(tried).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "trigger_unavailable",
      availableAt: store.now + 30_000,
    });
    for (const row of untried) {
      expect(row).toMatchObject({
        status: "pending",
        attempts: 0,
        availableAt: store.now + 60_000,
      });
    }
    expect(lines.some((line) => line.event === "jobs.outbox.batch_released")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("ECONNRESET");

    // Still down at the next sweep: the tried row's backoff doubles to 60 s, the others wait again
    // without spending an attempt.
    store.now += 60_000;
    await sweep();
    const [again, ...waiting] = ids.map((id) => store.row(id));
    expect(again).toMatchObject({ attempts: 2, availableAt: store.now + 60_000 });
    for (const row of waiting) {
      expect(row).toMatchObject({ attempts: 0, availableAt: store.now + 60_000 });
    }

    // Trigger.dev is back: everything goes out, exactly once.
    client.down = false;
    store.now += 10 * 60_000;
    await sweep();
    for (const id of ids) expect(store.row(id).status).toBe("dispatched");
    expect(client.runs.size).toBe(3);
  });

  it("dead-letters a row after the bounded attempts, and a requeue delivers it", async () => {
    const { store, client, sweep, ping } = setup();
    const id = ping("ping:doomed");
    client.down = true;
    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      store.now += 2 * 60 * 60_000;
      await sweep();
    }
    expect(store.row(id)).toMatchObject({
      status: "dead",
      attempts: MAX_DISPATCH_ATTEMPTS,
      lastErrorCode: "trigger_unavailable",
    });
    store.now += 2 * 60 * 60_000;
    expect(await sweep()).toMatchObject({ claimed: 0 });

    client.down = false;
    expect(store.requeue(id)).toBe(true);
    await sweep();
    expect(store.row(id)).toMatchObject({ status: "dispatched", generation: 1 });
    expect([...client.runs.keys()]).toEqual([`sample-ping:${id}:1`]);
  });

  it("never starts a second run when the dispatcher dies between triggering and recording", async () => {
    const { store, client, sweep, ping } = setup();
    const id = ping("ping:1");
    // Trigger.dev accepts the run, then the database goes away before `dispatched` is stored.
    const original = store.complete.bind(store);
    store.complete = () => Promise.reject(new Error("database unavailable"));
    expect(await sweep()).toMatchObject({ dispatched: 1, unrecorded: 1 });
    expect(store.row(id).status).toBe("dispatching");

    // The lease runs out; the next sweep triggers again with the same key.
    store.complete = original;
    store.now += 121_000;
    expect(await sweep()).toMatchObject({ claimed: 1, dispatched: 1, unrecorded: 0 });
    expect(client.calls).toBe(2);
    expect(client.runs.size).toBe(1);
    expect(store.row(id)).toMatchObject({ status: "dispatched", runId: "run_1", attempts: 2 });
  });

  it("fails the sweep when the outbox cannot be read, leaving rows untouched", async () => {
    const { store, sweep, ping } = setup();
    const id = ping("ping:1");
    store.unavailable = true;
    await expect(sweep()).rejects.toThrow();
    expect(store.row(id)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("gives two concurrent sweeps different rows", async () => {
    const { store, client, logger, ping } = setup();
    for (const key of ["a", "b", "c", "d"]) ping(`ping:${key}`);
    const run = () =>
      dispatchOutbox({ store, client, registry: jobRegistry, logger, batchSize: 2 });
    const [one, two] = await Promise.all([run(), run()]);
    expect(one.dispatched + two.dispatched).toBe(4);
    expect(client.calls).toBe(4);
  });
});

describe("the sample job end to end: outbox, dispatch, run, retry and duplicate delivery", () => {
  it("runs once despite a failed run attempt and a duplicate delivery", async () => {
    const { store, client, logger, sweep, ping, lines } = setup();
    ping("ping:e2e", "end-to-end");
    await sweep();
    const [run] = [...client.runs.values()];
    if (!run) throw new Error("no run");

    // Attempt 1 dies after claiming (as if the process was killed); Trigger.dev retries.
    const crashed = await store.begin("sample-ping", "ping:e2e", 60);
    expect(crashed.state).toBe("claimed");
    const retryWhileLeased = runJob(jobRegistry.get("sample-ping") ?? fail(), run.envelope, {
      store,
      logger,
      services: fakeServices(),
    });
    await expect(retryWhileLeased).rejects.toBeInstanceOf(RetryableJobError);

    // Attempt 2, after the lease: runs.
    store.now += 61_000;
    await expect(
      runJob(jobRegistry.get("sample-ping") ?? fail(), run.envelope, {
        store,
        logger,
        services: fakeServices(),
      }),
    ).resolves.toEqual({ status: "succeeded", attempt: 2 });

    // A duplicate delivery (replay from the dashboard, or a requeue of the dispatched row).
    const outboxId = [...store.outbox.keys()][0] ?? fail();
    store.requeue(outboxId);
    await sweep();
    const replay = client.runs.get(
      dispatchKey({ jobName: "sample-ping", id: outboxId, generation: 1 }),
    );
    await expect(
      runJob(jobRegistry.get("sample-ping") ?? fail(), replay?.envelope, {
        store,
        logger,
        services: fakeServices(),
      }),
    ).resolves.toEqual({ status: "skipped", reason: "already_succeeded" });

    expect(lines.filter((line) => line.event === "jobs.sample_ping.ran")).toHaveLength(1);
  });
});

function fail(): never {
  throw new Error("missing test fixture");
}
