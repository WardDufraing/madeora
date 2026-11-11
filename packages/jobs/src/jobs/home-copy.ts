import { z } from "zod";

import { OBJECT_KEY, StorageUnavailableError } from "@madeora/storage";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";

const homeCopyRetries = 3;

/**
 * `home-copy-files` (S40 part 2): copies the files of one personal-to-Home copy (a recipe's cover,
 * an album's photos with their variants) to the new Home files the database reserved, inside the
 * bucket (CopyObject: the bytes never pass through the job), checks each copy's size, and tells the
 * database. The database then makes the Home item in one transaction after checking everything
 * again, or answers 'discarded' when the request ended meanwhile (its reserved files and their
 * objects are removed with it). Nothing about the content is logged; only counts and codes.
 */
export const homeCopyFiles = defineJob({
  name: "home-copy-files",
  version: 1,
  payload: z.strictObject({ requestId: z.uuid() }),
  retry: { maxAttempts: homeCopyRetries, minTimeoutMs: 5_000, maxTimeoutMs: 60_000 },
  leaseSeconds: 600,
  async handle(data, { services, logger, attempt }) {
    async function fail(code: string): Promise<never> {
      const outcome = await services.data.finishHomeCopyFiles(data.requestId, false, code);
      logger.info("jobs.home_copy.failed", { code, outcome });
      throw new PermanentJobError(code);
    }
    const begin = await services.data.beginHomeCopyFiles(data.requestId);
    if (begin.outcome !== "ok") {
      logger.info("jobs.home_copy.skipped", { reason: begin.outcome });
      return;
    }
    const objects = services.objects;
    if (!objects) return fail("storage_not_configured");
    if (begin.objects.some((o) => !OBJECT_KEY.test(o.from) || !OBJECT_KEY.test(o.to))) {
      return fail("invalid_key");
    }
    try {
      for (const object of begin.objects) {
        // Copying again onto the same new key is harmless, so a retry starts from the top.
        if ((await objects.copy(object.from, object.to)) === "missing") {
          return await fail("source_missing");
        }
        const facts = await objects.head(object.to);
        if (!facts || (object.size !== null && facts.size !== object.size)) {
          return await fail("copy_mismatch");
        }
      }
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) throw error;
      // Outages are retried; on the last attempt the copy fails visibly (and its files go).
      if (attempt >= homeCopyRetries) return fail("storage_unavailable");
      throw new RetryableJobError(`storage_${error.code}`);
    }
    const outcome = await services.data.finishHomeCopyFiles(data.requestId, true, null);
    logger.info("jobs.home_copy.done", { outcome, objects: begin.objects.length });
  },
});
