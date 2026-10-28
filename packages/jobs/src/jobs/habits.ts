import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Habit reminders (S28, ADR 0035). Queued in the outbox for each reminder moment whenever a reminder
 * is set or changed, and again by each delivery for the moment after it; the payload names the
 * habit, the reminder's revision and the moment. The database re-checks everything at delivery (the
 * revision is still current, the habit active, that day still open and not yet done, who may check
 * in now, each person's choices and quiet hours) and notifies once per person and moment, so a
 * duplicate run reminds nobody twice. A moment more than 30 minutes late is skipped. A reminder that
 * is not due yet (a clock difference) is retried.
 */
export const habitReminder = defineJob({
  name: "habit-reminder",
  version: 1,
  payload: z.strictObject({
    habitId: z.uuid(),
    revision: z.int().min(1),
    at: z.iso.datetime(),
  }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverHabitReminder(data.habitId, data.revision, data.at);
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.habit_reminder.done", { outcome });
  },
});

/**
 * A snoozed habit reminder (S28). Queued for the end of the snooze; the database re-checks that the
 * person may still check in, still wants the reminder, the day is still open and it is not quiet hours
 * (otherwise the snooze is dropped, not delayed) and delivers it once.
 */
export const habitReminderSnooze = defineJob({
  name: "habit-reminder-snooze",
  version: 1,
  payload: z.strictObject({ notificationId: z.uuid() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverHabitSnooze(data.notificationId);
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.habit_reminder_snooze.done", { outcome });
  },
});

/**
 * The automatic end of a dated pause of a Home habit (S28). Queued for the resume day; the database
 * tells the opted-in members once that the habit resumed, only when the pause still ends that day
 * and nothing else (another pause, a vacation) still pauses it.
 */
export const habitPauseEnd = defineJob({
  name: "habit-pause-end",
  version: 1,
  payload: z.strictObject({ pauseId: z.uuid(), resumesOn: z.iso.date() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverHabitPauseEnd(data.pauseId, data.resumesOn);
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.habit_pause_end.done", { outcome });
  },
});
