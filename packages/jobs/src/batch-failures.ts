/**
 * Batches that skip a failing row (sign-in classification, goal series rollover) record the failure
 * on the row and retry it with a growing back-off, never counting it as done. This reports the rows
 * still failing at error level so they are visible in the job logs, with no row content.
 */
import type { Logger } from "@madeora/observability";

import type { JobDataPort } from "./services.ts";

/** Logs one error line per batch with failing rows; how many rows are failing in total. */
export async function reportBatchFailures(
  data: Pick<JobDataPort, "jobBatchFailures">,
  logger: Logger,
): Promise<number> {
  const failures = await data.jobBatchFailures();
  let failing = 0;
  for (const failure of failures) {
    if (failure.failing <= 0) continue;
    failing += failure.failing;
    logger.error("jobs.batch.row_failures", {
      source: failure.source,
      failing: failure.failing,
      maxAttempts: failure.maxAttempts,
      oldestFailedAt: failure.oldestFailedAt,
    });
  }
  return failing;
}
