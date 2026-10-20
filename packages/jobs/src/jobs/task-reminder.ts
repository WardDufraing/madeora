import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Task reminders (S19b). Queued in the outbox for the reminder's time whenever a reminder is set or
 * changed; the payload names the task and the reminder's revision. The database re-checks
 * everything at delivery (the revision is still current, the task is open and not deleted, who is
 * assigned now, each person's choices and quiet hours) and creates the notifications itself, once
 * per person and revision, so this job holds no data of its own and a duplicate run notifies nobody
 * twice. A reminder that is not due yet (a clock difference) is retried.
 */
export const taskReminder = defineJob({
  name: "task-reminder",
  version: 1,
  payload: z.strictObject({ taskId: z.uuid(), revision: z.int().min(1) }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverTaskReminder(data.taskId, data.revision);
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.task_reminder.done", { outcome });
  },
});
