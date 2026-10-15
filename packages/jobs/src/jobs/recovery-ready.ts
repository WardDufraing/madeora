import { z } from "zod";

import { defineJob } from "../definition.ts";

/**
 * Tells the person who asked for an ownership recovery that the objection period is over and they
 * can accept (S12b carry-over). Queued when a case is approved, to run at the end of the period.
 * The payload names the case and the end it was queued for; the database function re-checks that
 * the case is still approved with that end, not paused, ended or answered by its Owner, and then
 * creates the notification (and queues its email) itself, so this job holds no data of its own.
 */
export const recoveryReady = defineJob({
  name: "recovery-ready",
  version: 1,
  payload: z.strictObject({ recoveryId: z.uuid(), objectionEndsAt: z.iso.datetime() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverRecoveryReady(
      data.recoveryId,
      new Date(data.objectionEndsAt),
    );
    logger.info("jobs.recovery_ready.done", { outcome });
  },
});
