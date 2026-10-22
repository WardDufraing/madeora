import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { choreClaimRelease, choreReminder, vacationReminder } from "./chores.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const OCCURRENCE = "7c1e2a3b-4d5f-4a6b-8c7d-9e0f1a2b3c4d";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("chore-claim-release", () => {
  it("passes the occurrence and claim count to the database and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      choreClaimRelease,
      envelope({ occurrenceId: OCCURRENCE, claim: 3 }, `chore-claim-release:${OCCURRENCE}:3:1`),
      ctx,
    );
    expect(ctx.services.data.claimReleaseCalls).toEqual([{ occurrenceId: OCCURRENCE, claim: 3 }]);
    expect(ctx.lines.join("\n")).toContain("released");
    expect(ctx.lines.join("\n")).not.toContain(OCCURRENCE);
  });

  it("is harmless when the claim changed or the occurrence is gone", async () => {
    for (const outcome of ["stale", "missing"] as const) {
      const ctx = setup();
      ctx.services.data.claimReleaseOutcome = outcome;
      await runJob(
        choreClaimRelease,
        envelope({ occurrenceId: OCCURRENCE, claim: 1 }, `chore-claim-release:${outcome}`),
        ctx,
      );
      expect(ctx.services.data.claimReleaseCalls).toHaveLength(1);
    }
  });

  it("retries when the database cannot be reached", async () => {
    const ctx = setup();
    ctx.services.data.unavailable = true;
    await expect(
      runJob(
        choreClaimRelease,
        envelope({ occurrenceId: OCCURRENCE, claim: 1 }, "chore-claim-release:down"),
        ctx,
      ),
    ).rejects.toThrow();
  });

  it("refuses a payload with anything but the occurrence and claim count", async () => {
    for (const data of [
      { occurrenceId: OCCURRENCE, claim: 1, title: "x" },
      { occurrenceId: OCCURRENCE, claim: -1 },
      { occurrenceId: "nope", claim: 1 },
    ]) {
      const ctx = setup();
      await expect(
        runJob(choreClaimRelease, envelope(data, "chore-claim-release:bad"), ctx),
      ).rejects.toThrow();
      expect(ctx.services.data.claimReleaseCalls).toEqual([]);
    }
  });
});

describe("chore-reminder", () => {
  const USER = "2d4e6f80-1a2b-4c3d-8e5f-6a7b8c9d0e1f";

  it("passes the occurrence, the person and the revision and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      choreReminder,
      envelope(
        { occurrenceId: OCCURRENCE, userId: USER, revision: 2 },
        `chore-reminder:${OCCURRENCE}:${USER}:2`,
      ),
      ctx,
    );
    expect(ctx.services.data.choreReminderCalls).toEqual([
      { occurrenceId: OCCURRENCE, userId: USER, revision: 2 },
    ]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(USER);
  });

  it("retries a reminder that is not due yet and accepts a stale one", async () => {
    const early = setup();
    early.services.data.choreReminderOutcome = "not_due";
    await expect(
      runJob(
        choreReminder,
        envelope({ occurrenceId: OCCURRENCE, userId: USER, revision: 1 }, "chore-reminder:early"),
        early,
      ),
    ).rejects.toThrow("not_due");
    const stale = setup();
    stale.services.data.choreReminderOutcome = "stale";
    await runJob(
      choreReminder,
      envelope({ occurrenceId: OCCURRENCE, userId: USER, revision: 1 }, "chore-reminder:stale"),
      stale,
    );
    expect(stale.services.data.choreReminderCalls).toHaveLength(1);
  });

  it("refuses a payload with anything more than ids and the revision", async () => {
    const ctx = setup();
    await expect(
      runJob(
        choreReminder,
        envelope(
          { occurrenceId: OCCURRENCE, userId: USER, revision: 1, title: "Dishes" },
          "chore-reminder:extra",
        ),
        ctx,
      ),
    ).rejects.toThrow();
    expect(ctx.services.data.choreReminderCalls).toEqual([]);
  });
});

describe("vacation-reminder", () => {
  const VACATION = "4f5e6d7c-8b9a-4c0d-9e1f-2a3b4c5d6e7f";

  it("passes the vacation, its start and the lead days and logs only the outcome", async () => {
    const ctx = setup();
    await runJob(
      vacationReminder,
      envelope(
        { vacationId: VACATION, startsOn: "2026-12-20", days: 3 },
        `vacation-reminder:${VACATION}:2026-12-20:3`,
      ),
      ctx,
    );
    expect(ctx.services.data.vacationReminderCalls).toEqual([
      { vacationId: VACATION, startsOn: "2026-12-20", days: 3 },
    ]);
    expect(ctx.lines.join("\n")).toContain("notified");
    expect(ctx.lines.join("\n")).not.toContain(VACATION);
  });

  it("retries a reminder that is not due yet and accepts a stale one", async () => {
    const early = setup();
    early.services.data.vacationReminderOutcome = "not_due";
    await expect(
      runJob(
        vacationReminder,
        envelope({ vacationId: VACATION, startsOn: "2026-12-20", days: 3 }, "vacation:early"),
        early,
      ),
    ).rejects.toThrow("not_due");
    const stale = setup();
    stale.services.data.vacationReminderOutcome = "stale";
    await runJob(
      vacationReminder,
      envelope({ vacationId: VACATION, startsOn: "2026-12-20", days: 3 }, "vacation:stale"),
      stale,
    );
    expect(stale.services.data.vacationReminderCalls).toHaveLength(1);
  });

  it("refuses a payload with a name, a bad date or lead days out of range", async () => {
    for (const data of [
      { vacationId: VACATION, startsOn: "2026-12-20", days: 3, name: "Ski" },
      { vacationId: VACATION, startsOn: "20-12-2026", days: 3 },
      { vacationId: VACATION, startsOn: "2026-12-20", days: 31 },
      { vacationId: VACATION, startsOn: "2026-12-20", days: 0 },
    ]) {
      const ctx = setup();
      await expect(runJob(vacationReminder, envelope(data, "vacation:bad"), ctx)).rejects.toThrow();
      expect(ctx.services.data.vacationReminderCalls).toEqual([]);
    }
  });
});
