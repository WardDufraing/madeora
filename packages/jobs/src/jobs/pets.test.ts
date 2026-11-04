import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { petCareReminder } from "./pets.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const OCCURRENCE = "4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4b03";
const AT = "2026-11-10T06:45:00Z";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("pet-care-reminder", () => {
  it("leaves delivery to the database and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      petCareReminder,
      envelope({ occurrenceId: OCCURRENCE, at: AT }, `pet-care-reminder:${OCCURRENCE}:1`),
      ctx,
    );
    expect(ctx.services.data.petCareReminderCalls).toEqual([{ occurrenceId: OCCURRENCE, at: AT }]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(OCCURRENCE);
  });

  it("is harmless when the moment changed, is late, or the care is closed", async () => {
    for (const outcome of ["stale", "late", "inactive"] as const) {
      const ctx = setup();
      ctx.services.data.petCareReminderOutcome = outcome;
      await runJob(
        petCareReminder,
        envelope({ occurrenceId: OCCURRENCE, at: AT }, `pcr:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.petCareReminderCalls).toHaveLength(1);
    }
  });

  it("retries when the moment is not due yet, or the database cannot be reached", async () => {
    const early = setup();
    early.services.data.petCareReminderOutcome = "not_due";
    await expect(
      runJob(petCareReminder, envelope({ occurrenceId: OCCURRENCE, at: AT }, "pcr:e"), early),
    ).rejects.toThrow("not_due");
    const down = setup();
    down.services.data.unavailable = true;
    await expect(
      runJob(petCareReminder, envelope({ occurrenceId: OCCURRENCE, at: AT }, "pcr:d"), down),
    ).rejects.toThrow();
  });

  it("refuses a payload with anything more than the occurrence and the moment", async () => {
    const ctx = setup();
    await expect(
      runJob(
        petCareReminder,
        envelope({ occurrenceId: OCCURRENCE, at: AT, title: "Thyroxine" }, "pcr:x"),
        ctx,
      ),
    ).rejects.toThrow();
    expect(ctx.services.data.petCareReminderCalls).toHaveLength(0);
  });
});
