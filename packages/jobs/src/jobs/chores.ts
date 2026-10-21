import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Automatic claim release (S21, ADR 0027). Queued when a member claims an occurrence of a chore with
 * automatic release, delayed to the end of its grace period. The database decides under the chore
 * lock: a claim still held past its release time is returned to the pool (or closed when its week has
 * ended) and the former claimant is notified; a claim released, completed, replaced or not yet due
 * (a newer claim count, a changed policy) is left alone, and the pool views release it lazily
 * as well. The payload holds ids and the claim count only; titles never reach the job or its logs.
 */
export const choreClaimRelease = defineJob({
  name: "chore-claim-release",
  version: 1,
  payload: z.strictObject({ occurrenceId: z.uuid(), claim: z.int().min(0) }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.releaseOverdueChoreClaim(data.occurrenceId, data.claim);
    logger.info("jobs.chore_claim_release.done", { outcome });
  },
});

/**
 * Personal chore reminders (S21, ADR 0028). Queued in the outbox for the reminder's moment whenever
 * an assignee sets or changes one, or a moved due day moves it; the payload names the occurrence,
 * the person and the reminder's revision. The database re-checks everything at delivery (still the
 * current revision, the occurrence open, the person still assigned and a member, their choices and
 * quiet hours) and notifies once per revision, so a duplicate run reminds nobody twice. A reminder
 * that is not due yet (a clock difference) is retried.
 */
export const choreReminder = defineJob({
  name: "chore-reminder",
  version: 1,
  payload: z.strictObject({ occurrenceId: z.uuid(), userId: z.uuid(), revision: z.int().min(1) }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverChoreReminder(
      data.occurrenceId,
      data.userId,
      data.revision,
    );
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.chore_reminder.done", { outcome });
  },
});
