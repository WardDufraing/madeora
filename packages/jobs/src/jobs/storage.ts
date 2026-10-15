import { z } from "zod";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { OBJECT_KEY, StorageUnavailableError } from "@madeora/storage";

/**
 * File storage jobs (S15, architecture.md §10, §36). The database decides; these jobs only move
 * state forward and remove objects:
 *
 * - `storage-upload-expire`: queued with every upload intent, delayed past its end. A pending upload
 *   becomes failed; the database queues its objects (or a processed upload's raw object) for removal.
 * - `storage-file-purge`: queued when a file is retired, delayed to the end of its 7-day recovery
 *   window. The database purges it only if it is still deleted then (not restored) and releases its
 *   space; it queues the object for removal.
 * - `storage-object-delete`: removes one queued object from the bucket and marks it done. An object
 *   that is already gone counts as removed, so a repeated run changes nothing.
 *
 * Payloads hold ids only. Object keys are read from the database at run time and never logged.
 */

export const storageUploadExpire = defineJob({
  name: "storage-upload-expire",
  version: 1,
  payload: z.strictObject({ fileId: z.uuid() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const status = await services.data.expireUpload(data.fileId);
    logger.info("jobs.storage_upload_expire.done", { status });
  },
});

export const storageFilePurge = defineJob({
  name: "storage-file-purge",
  version: 1,
  payload: z.strictObject({ fileId: z.uuid() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const status = await services.data.purgeStoredFile(data.fileId);
    logger.info("jobs.storage_file_purge.done", { status });
  },
});

export const storageObjectDelete = defineJob({
  name: "storage-object-delete",
  version: 1,
  payload: z.strictObject({ deletionId: z.uuid() }),
  retry: { maxAttempts: 8 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const deletion = await services.data.getStorageObjectDeletion(data.deletionId);
    if (!deletion || deletion.done) {
      logger.info("jobs.storage_object_delete.skipped", { reason: deletion ? "done" : "missing" });
      return;
    }
    // Nothing can be removed where storage is off; the runbook requeues once it is configured.
    if (!services.objects) throw new PermanentJobError("storage_not_configured");
    if (!OBJECT_KEY.test(deletion.objectKey)) throw new PermanentJobError("invalid_key");
    try {
      await services.objects.delete(deletion.objectKey);
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new RetryableJobError(`storage_${error.code}`);
      }
      throw error;
    }
    await services.data.completeStorageObjectDeletion(data.deletionId);
    logger.info("jobs.storage_object_delete.done", {});
  },
});
