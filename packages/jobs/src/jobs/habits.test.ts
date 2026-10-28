import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { habitPauseEnd, habitReminder, habitReminderSnooze } from "./habits.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const HABIT = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";
const NOTICE = "7e1b2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const PAUSE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const AT = "2026-11-10T07:30:00Z";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("habit-reminder", () => {
  it("leaves delivery to the database and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      habitReminder,
      envelope({ habitId: HABIT, revision: 2, at: AT }, `habit-reminder:${HABIT}:2:1`),
      ctx,
    );
    expect(ctx.services.data.habitReminderCalls).toEqual([{ habitId: HABIT, revision: 2, at: AT }]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(HABIT);
  });

  it("is harmless when the reminder changed, is late, or the day needs none", async () => {
    for (const outcome of ["stale", "late", "inactive", "not_needed"] as const) {
      const ctx = setup();
      ctx.services.data.habitReminderOutcome = outcome;
      await runJob(
        habitReminder,
        envelope({ habitId: HABIT, revision: 1, at: AT }, `habit-reminder:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.habitReminderCalls).toHaveLength(1);
    }
  });

  it("retries when the moment is not due yet, or the database cannot be reached", async () => {
    const early = setup();
    early.services.data.habitReminderOutcome = "not_due";
    await expect(
      runJob(habitReminder, envelope({ habitId: HABIT, revision: 1, at: AT }, "hr:e"), early),
    ).rejects.toThrow("not_due");
    const down = setup();
    down.services.data.unavailable = true;
    await expect(
      runJob(habitReminder, envelope({ habitId: HABIT, revision: 1, at: AT }, "hr:d"), down),
    ).rejects.toThrow();
  });

  it("refuses a payload with anything but the habit, revision and moment", async () => {
    for (const data of [
      { habitId: HABIT, revision: 1, at: AT, name: "Run" },
      { habitId: HABIT, revision: 0, at: AT },
      { habitId: HABIT, revision: 1, at: "tomorrow" },
      { habitId: "run", revision: 1, at: AT },
    ]) {
      const ctx = setup();
      await expect(runJob(habitReminder, envelope(data, "hr:bad"), ctx)).rejects.toThrow();
      expect(ctx.services.data.habitReminderCalls).toEqual([]);
    }
  });
});

describe("habit-reminder-snooze", () => {
  it("delivers by notification id; a cancelled or stale snooze is done", async () => {
    for (const outcome of ["notified", "cancelled", "stale"] as const) {
      const ctx = setup();
      ctx.services.data.habitSnoozeOutcome = outcome;
      await runJob(habitReminderSnooze, envelope({ notificationId: NOTICE }, `hs:${outcome}`), ctx);
      expect(ctx.services.data.habitSnoozeCalls).toEqual([NOTICE]);
      expect(ctx.lines.join("\n")).not.toContain(NOTICE);
    }
  });

  it("retries when not due yet and refuses extra fields", async () => {
    const ctx = setup();
    ctx.services.data.habitSnoozeOutcome = "not_due";
    await expect(
      runJob(habitReminderSnooze, envelope({ notificationId: NOTICE }, "hs:e"), ctx),
    ).rejects.toThrow("not_due");
    const bad = setup();
    await expect(
      runJob(habitReminderSnooze, envelope({ notificationId: NOTICE, minutes: 10 }, "hs:b"), bad),
    ).rejects.toThrow();
    expect(bad.services.data.habitSnoozeCalls).toEqual([]);
  });
});

describe("habit-pause-end", () => {
  it("passes the pause and its resume day; a pause still in force is done", async () => {
    for (const outcome of ["notified", "still_paused", "stale"] as const) {
      const ctx = setup();
      ctx.services.data.habitPauseEndOutcome = outcome;
      await runJob(
        habitPauseEnd,
        envelope({ pauseId: PAUSE, resumesOn: "2026-11-12" }, `hp:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.habitPauseEndCalls).toEqual([
        { pauseId: PAUSE, resumesOn: "2026-11-12" },
      ]);
    }
  });

  it("retries when not due yet and refuses a bad day", async () => {
    const ctx = setup();
    ctx.services.data.habitPauseEndOutcome = "not_due";
    await expect(
      runJob(habitPauseEnd, envelope({ pauseId: PAUSE, resumesOn: "2026-11-12" }, "hp:e"), ctx),
    ).rejects.toThrow("not_due");
    const bad = setup();
    await expect(
      runJob(habitPauseEnd, envelope({ pauseId: PAUSE, resumesOn: "12/11" }, "hp:b"), bad),
    ).rejects.toThrow();
    expect(bad.services.data.habitPauseEndCalls).toEqual([]);
  });
});
