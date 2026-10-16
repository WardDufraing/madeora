import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { trashEntryPurge } from "./trash.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const ENTRY = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects: null }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("trash-entry-purge", () => {
  it("leaves the decision to the database and logs only the resulting status", async () => {
    const ctx = setup();
    await runJob(trashEntryPurge, envelope({ entryId: ENTRY }, `trash-entry:${ENTRY}:purge`), ctx);
    expect(ctx.services.data.trashCalls).toEqual([ENTRY]);
    expect(ctx.lines.join("\n")).toContain("purged");
  });

  it("is harmless when the entry was restored or is already gone", async () => {
    for (const status of ["restored", "missing", "purged"] as const) {
      const ctx = setup();
      ctx.services.data.trashStatus = status;
      await runJob(
        trashEntryPurge,
        envelope({ entryId: ENTRY }, `trash-entry:${ENTRY}:${status}`),
        ctx,
      );
      expect(ctx.services.data.trashCalls).toEqual([ENTRY]);
    }
  });

  it("retries when the entry is not yet due", async () => {
    const ctx = setup();
    ctx.services.data.trashStatus = "trashed";
    await expect(
      runJob(trashEntryPurge, envelope({ entryId: ENTRY }, `trash-entry:${ENTRY}:early`), ctx),
    ).rejects.toThrow();
  });

  it("retries when the database cannot be reached", async () => {
    const ctx = setup();
    ctx.services.data.unavailable = true;
    await expect(
      runJob(trashEntryPurge, envelope({ entryId: ENTRY }, `trash-entry:${ENTRY}:down`), ctx),
    ).rejects.toThrow();
  });

  it("refuses a payload with anything but an entry id", async () => {
    const ctx = setup();
    await expect(
      runJob(
        trashEntryPurge,
        envelope({ entryId: ENTRY, title: "x" }, `trash-entry:${ENTRY}:bad`),
        ctx,
      ),
    ).rejects.toThrow();
  });
});
