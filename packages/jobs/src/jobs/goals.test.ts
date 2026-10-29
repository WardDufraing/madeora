import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { goalReminder } from "./goals.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const GOAL = "4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4b02";
const AT = "2026-11-10T08:00:00Z";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("goal-reminder", () => {
  it("leaves delivery to the database and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      goalReminder,
      envelope({ goalId: GOAL, revision: 2, kind: "lead", at: AT }, `goal-reminder:${GOAL}:2:lead`),
      ctx,
    );
    expect(ctx.services.data.goalReminderCalls).toEqual([
      { goalId: GOAL, revision: 2, kind: "lead", at: AT },
    ]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(GOAL);
  });

  it("is harmless when the reminder changed, is late, or the goal needs none", async () => {
    for (const outcome of ["stale", "late", "inactive"] as const) {
      const ctx = setup();
      ctx.services.data.goalReminderOutcome = outcome;
      await runJob(
        goalReminder,
        envelope({ goalId: GOAL, revision: 1, kind: "overdue", at: AT }, `gr:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.goalReminderCalls).toHaveLength(1);
    }
  });

  it("retries when the moment is not due yet, or the database cannot be reached", async () => {
    const early = setup();
    early.services.data.goalReminderOutcome = "not_due";
    await expect(
      runJob(
        goalReminder,
        envelope({ goalId: GOAL, revision: 1, kind: "lead", at: AT }, "gr:e"),
        early,
      ),
    ).rejects.toThrow("not_due");
    const down = setup();
    down.services.data.unavailable = true;
    await expect(
      runJob(
        goalReminder,
        envelope({ goalId: GOAL, revision: 1, kind: "lead", at: AT }, "gr:d"),
        down,
      ),
    ).rejects.toThrow();
  });

  it("refuses a payload with an unknown moment kind", async () => {
    const ctx = setup();
    await expect(
      runJob(
        goalReminder,
        envelope({ goalId: GOAL, revision: 1, kind: "soon", at: AT }, "gr:k"),
        ctx,
      ),
    ).rejects.toThrow();
    expect(ctx.services.data.goalReminderCalls).toHaveLength(0);
  });
});
