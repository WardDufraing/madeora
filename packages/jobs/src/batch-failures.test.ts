import { createLogger, type LogLevel } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import { reportBatchFailures } from "./batch-failures.ts";
import { fakeServices } from "./testing/fake-services.ts";

function capture() {
  const lines: { level: LogLevel; line: Record<string, unknown> }[] = [];
  const logger = createLogger({
    env: "test",
    sink: (level, line) => lines.push({ level, line: JSON.parse(line) as Record<string, unknown> }),
  });
  return { lines, logger };
}

describe("reportBatchFailures", () => {
  it("logs each batch with failing rows at error level and totals them", async () => {
    const services = fakeServices();
    services.data.batchFailures = [
      {
        source: "sign_in_events",
        failing: 2,
        maxAttempts: 3,
        oldestFailedAt: "2026-11-18T10:00:00Z",
      },
      { source: "goal_series", failing: 0, maxAttempts: 0, oldestFailedAt: null },
    ];
    const { lines, logger } = capture();
    await expect(reportBatchFailures(services.data, logger)).resolves.toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.line).toMatchObject({
      event: "jobs.batch.row_failures",
      source: "sign_in_events",
      failing: 2,
      maxAttempts: 3,
      oldestFailedAt: "2026-11-18T10:00:00Z",
    });
  });

  it("logs nothing when no rows are failing", async () => {
    const services = fakeServices();
    const { lines, logger } = capture();
    await expect(reportBatchFailures(services.data, logger)).resolves.toBe(0);
    expect(lines).toEqual([]);
  });
});
