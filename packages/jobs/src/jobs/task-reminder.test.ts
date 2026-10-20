import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { taskReminder } from "./task-reminder.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const TASK = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("task-reminder", () => {
  it("leaves delivery to the database and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      taskReminder,
      envelope({ taskId: TASK, revision: 2 }, `task-reminder:${TASK}:2`),
      ctx,
    );
    expect(ctx.services.data.reminderCalls).toEqual([{ taskId: TASK, revision: 2 }]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(TASK);
  });

  it("is harmless when the reminder changed, or nobody could be notified", async () => {
    for (const outcome of ["stale", "not_sent"] as const) {
      const ctx = setup();
      ctx.services.data.reminderOutcome = outcome;
      await runJob(
        taskReminder,
        envelope({ taskId: TASK, revision: 1 }, `task-reminder:${TASK}:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.reminderCalls).toHaveLength(1);
    }
  });

  it("retries when the reminder is not due yet", async () => {
    const ctx = setup();
    ctx.services.data.reminderOutcome = "not_due";
    await expect(
      runJob(taskReminder, envelope({ taskId: TASK, revision: 1 }, `task-reminder:${TASK}:e`), ctx),
    ).rejects.toThrow("not_due");
  });

  it("retries when the database cannot be reached", async () => {
    const ctx = setup();
    ctx.services.data.unavailable = true;
    await expect(
      runJob(taskReminder, envelope({ taskId: TASK, revision: 1 }, `task-reminder:${TASK}:d`), ctx),
    ).rejects.toThrow();
  });

  it("refuses a payload with anything but a task id and revision", async () => {
    for (const data of [
      { taskId: TASK, revision: 1, title: "Bins" },
      { taskId: TASK, revision: 0 },
      { taskId: "bins", revision: 1 },
    ]) {
      const ctx = setup();
      await expect(
        runJob(taskReminder, envelope(data, `task-reminder:${TASK}:bad`), ctx),
      ).rejects.toThrow();
      expect(ctx.services.data.reminderCalls).toEqual([]);
    }
  });
});
