import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Goal deadline reminders (S30, ADR 0038). Queued in the outbox for each moment still ahead (an
 * advance reminder before the deadline, an overdue reminder after it) whenever the reminder, the
 * deadline or the goal's state changes; the payload names the goal, the reminder's revision, the
 * moment kind and the instant. The database re-checks everything at delivery (the revision is still
 * current, the goal still has its deadline and is not achieved, archived or in the trash, who may see
 * it now, each person's choices and quiet hours) and notifies once per person and moment, so a
 * duplicate run reminds nobody twice. A moment more than 30 minutes late is skipped. A reminder that
 * is not due yet (a clock difference) is retried.
 */
export const goalReminder = defineJob({
  name: "goal-reminder",
  version: 1,
  payload: z.strictObject({
    goalId: z.uuid(),
    revision: z.int().min(1),
    kind: z.enum(["lead", "overdue"]),
    at: z.iso.datetime(),
  }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverGoalReminder(
      data.goalId,
      data.revision,
      data.kind,
      data.at,
    );
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.goal_reminder.done", { outcome });
  },
});
