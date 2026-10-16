import { z } from "zod";

import { defineJob } from "../definition.ts";
import { RetryableJobError } from "../errors.ts";

/**
 * Trash purge (S16, architecture.md §36). Queued with every trash entry, delayed to the end of its
 * 7-day recovery window. The database decides: an entry still in the trash after its deadline is
 * purged together with its exclusively attached files (their space is released and their objects
 * are queued for removal); an entry restored or deleted meanwhile, or not yet due, is left alone.
 * The payload holds the entry id only; titles never reach the job or its logs.
 */
export const trashEntryPurge = defineJob({
  name: "trash-entry-purge",
  version: 1,
  payload: z.strictObject({ entryId: z.uuid() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const status = await services.data.purgeExpiredTrashEntry(data.entryId);
    // Still in the trash means it was not due yet (a clock difference): try again later.
    if (status === "trashed") throw new RetryableJobError("not_due");
    logger.info("jobs.trash_entry_purge.done", { status });
  },
});
