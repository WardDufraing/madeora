import { randomUUID } from "node:crypto";

import { SyncPermanentError, SyncRetryableError, syncConnection } from "@madeora/google-calendar";
import { z } from "zod";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";

/**
 * Google Calendar inbound sync (S33, ADR 0043, architecture.md §31): one run per connection, queued when
 * the person connects, turns a calendar on or asks Sync now, and every 15 minutes by the outbox
 * dispatcher. The payload names only the connection. The run (`syncConnection`, packages/google-calendar)
 * takes the connection's lease in the database, so two runs never sync one connection at once, rechecks
 * that it is still connected and the account usable, and applies every page idempotently: a repeated or
 * retried run never duplicates an event. Google refusing the refresh token ends the connection as
 * "authorization expired" (the person is told once); an outage before anything synced is retried; a
 * refused OAuth client stops for good. The access token lives only in this run's memory.
 */
export const googleCalendarSync = defineJob({
  name: "google-calendar-sync",
  version: 1,
  payload: z.strictObject({ connectionId: z.uuid() }),
  retry: { maxAttempts: 4, minTimeoutMs: 30_000, maxTimeoutMs: 600_000 },
  // The database lease of a run (SYNC_LIMITS.leaseSeconds) is the same, so a run that is stopped at
  // its maximum duration never overlaps the next one.
  leaseSeconds: 300,
  async handle(data, { services, logger }) {
    const google = services.googleCalendar;
    if (!google) throw new PermanentJobError("not_configured");
    let outcome;
    try {
      outcome = await syncConnection(data.connectionId, {
        store: services.data.googleSync,
        google: google.client,
        tokenKey: google.tokenKey,
        lease: randomUUID(),
        now: () => new Date(),
        logger,
      });
    } catch (error) {
      if (error instanceof SyncRetryableError) throw new RetryableJobError(error.code);
      if (error instanceof SyncPermanentError) throw new PermanentJobError(error.code);
      throw error;
    }
    logger.info("jobs.google_calendar_sync.done", { outcome });
  },
});
