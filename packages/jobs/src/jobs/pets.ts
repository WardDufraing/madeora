import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Pet-care reminders (S31, ADR 0041). Queued in the outbox for an open occurrence with responsible
 * members when its activity has a reminder: at the occurrence's time (08:00 Home time without one)
 * minus the offset. The payload names only the occurrence and the moment. The database re-checks
 * everything at delivery (the occurrence is still open and its moment is still this one, the
 * activity is active, neither it nor its pet is in the trash, who is responsible now, each person's
 * choices and quiet hours) and notifies once per person and moment, with ids only, so a duplicate run
 * reminds nobody twice and no medication detail travels in a notice. A moment more than 30 minutes
 * late is skipped. A reminder that is not due yet (a clock difference) is retried.
 */
export const petCareReminder = defineJob({
  name: "pet-care-reminder",
  version: 1,
  payload: z.strictObject({
    occurrenceId: z.uuid(),
    at: z.iso.datetime(),
  }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverPetCareReminder(data.occurrenceId, data.at);
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.pet_care_reminder.done", { outcome });
  },
});
