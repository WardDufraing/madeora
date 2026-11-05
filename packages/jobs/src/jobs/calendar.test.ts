import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { calendarEventReminder } from "./calendar.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const EVENT = "4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4b03";
const ON = "2026-11-10";
const AT = "2026-11-10T06:45:00Z";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("calendar-event-reminder", () => {
  it("leaves delivery to the database and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      calendarEventReminder,
      envelope({ eventId: EVENT, on: ON, at: AT }, `calendar-event-reminder:${EVENT}:1`),
      ctx,
    );
    expect(ctx.services.data.calendarReminderCalls).toEqual([{ eventId: EVENT, on: ON, at: AT }]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(EVENT);
  });

  it("is harmless when the moment changed, is late, or the event is gone", async () => {
    for (const outcome of ["stale", "late"] as const) {
      const ctx = setup();
      ctx.services.data.calendarReminderOutcome = outcome;
      await runJob(
        calendarEventReminder,
        envelope({ eventId: EVENT, on: ON, at: AT }, `pcr:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.calendarReminderCalls).toHaveLength(1);
    }
  });

  it("retries when the moment is not due yet, or the database cannot be reached", async () => {
    const early = setup();
    early.services.data.calendarReminderOutcome = "not_due";
    await expect(
      runJob(calendarEventReminder, envelope({ eventId: EVENT, on: ON, at: AT }, "cer:e"), early),
    ).rejects.toThrow("not_due");
    const down = setup();
    down.services.data.unavailable = true;
    await expect(
      runJob(calendarEventReminder, envelope({ eventId: EVENT, on: ON, at: AT }, "cer:d"), down),
    ).rejects.toThrow();
  });

  it("refuses a payload with anything more than the event, the date and the moment", async () => {
    const ctx = setup();
    await expect(
      runJob(
        calendarEventReminder,
        envelope({ eventId: EVENT, on: ON, at: AT, title: "Dentist" }, "cer:x"),
        ctx,
      ),
    ).rejects.toThrow();
    expect(ctx.services.data.calendarReminderCalls).toHaveLength(0);
  });
});
