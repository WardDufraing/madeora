import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Calendar event reminders (S32, ADR 0042). Queued in the outbox for an event's next occurrence when
 * the event has a reminder: at the occurrence's start (08:00 on an all-day one's first day) minus the
 * offset, in the event's timezone. The payload names only the event, the occurrence's date and the
 * moment. The database re-checks everything at delivery (the event is not in the trash, the
 * occurrence is not cancelled and its moment is still this one, who is reminded now, each person's
 * choices and quiet hours) and notifies once per person and moment, with ids only, so a duplicate run
 * reminds nobody twice and no title travels in a notice. A personal event reminds only its owner,
 * shared or not. It then queues the next occurrence's reminder. A moment more than 30 minutes late
 * is skipped; one not due yet (a clock difference) is retried.
 */
export const calendarEventReminder = defineJob({
  name: "calendar-event-reminder",
  version: 1,
  payload: z.strictObject({
    eventId: z.uuid(),
    on: z.iso.date(),
    at: z.iso.datetime(),
  }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverCalendarReminder(data.eventId, data.on, data.at);
    if (outcome === "not_due") throw new RetryableJobError("not_due");
    logger.info("jobs.calendar_event_reminder.done", { outcome });
  },
});
