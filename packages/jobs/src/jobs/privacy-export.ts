import { z } from "zod";

import { OBJECT_KEY, StorageUnavailableError } from "@madeora/storage";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import {
  buildManifest,
  categoriesOf,
  collectedCategorySchema,
  README,
  README_HOME,
  summaryOf,
  toCsv,
  type CollectedCategory,
  type ExportCategory,
  type ExportMedia,
} from "../export/archive.ts";
import { buildZip, MAX_ZIP_ENTRIES, type ZipEntry } from "../export/zip.ts";

/**
 * Attachments per archive (value awaiting Ward's approval, plans/steps/S39-brief.md). The archive
 * is built in memory on the default 0.5 GB Trigger.dev machine (no larger machine: €0): the media
 * and the finished archive are held together once, so about twice this plus the text files and
 * Node itself. Larger media make the export partial: the manifest lists what was left out, and it
 * all stays in Madeora.
 */
export const EXPORT_MEDIA_BUDGET_BYTES = 100 * 1024 * 1024;

const privacyExportRetries = 3;

const encoder = new TextEncoder();

/**
 * `privacy-export-build` (S39): prepares one personal or Home data export. The database decides
 * everything (who, which categories, which Homes, what each category may contain) and re-checks
 * the request on every call; this job only packs the rows into one ZIP and stores it under the
 * key the database chose. A canceled or invalidated export is never finished: `finish` answers
 * 'discarded' and the database queues the stored object for removal. Nothing about the content is
 * ever logged; only counts and codes.
 */
export const privacyExportBuild = defineJob({
  name: "privacy-export-build",
  version: 1,
  payload: z.strictObject({ exportId: z.uuid() }),
  retry: { maxAttempts: privacyExportRetries, minTimeoutMs: 5_000, maxTimeoutMs: 60_000 },
  leaseSeconds: 900,
  async handle(data, { services, logger, attempt }) {
    // Storage outages are retried; on the last attempt the export fails visibly instead of staying
    // "preparing" (and blocking a new request) until the sweep's time limit.
    async function storageDown(error: StorageUnavailableError): Promise<never> {
      if (attempt >= privacyExportRetries) {
        await services.data.failDataExport(data.exportId, "storage_unavailable");
        throw new PermanentJobError(`storage_${error.code}`);
      }
      throw new RetryableJobError(`storage_${error.code}`);
    }
    const begin = await services.data.beginDataExport(data.exportId);
    if (begin.outcome !== "ok") {
      logger.info("jobs.privacy_export.skipped", { reason: begin.outcome });
      return;
    }
    const objects = services.objects;
    if (!objects) {
      await services.data.failDataExport(data.exportId, "storage_not_configured");
      throw new PermanentJobError("storage_not_configured");
    }
    if (!OBJECT_KEY.test(begin.objectKey)) {
      await services.data.failDataExport(data.exportId, "invalid_key");
      throw new PermanentJobError("invalid_key");
    }

    const allowed: readonly string[] = categoriesOf(begin.kind);
    const categories = begin.categories.filter((value): value is ExportCategory =>
      allowed.includes(value),
    );
    const collected = new Map<ExportCategory, CollectedCategory>();
    for (const category of categories) {
      const raw = await services.data.collectDataExport(data.exportId, category);
      if (raw === "gone") {
        // Canceled, invalidated or no longer eligible while preparing: nothing to finish.
        logger.info("jobs.privacy_export.skipped", { reason: "gone" });
        return;
      }
      const parsed = collectedCategorySchema.safeParse(raw);
      if (!parsed.success) {
        await services.data.failDataExport(data.exportId, "unexpected_data");
        throw new PermanentJobError("unexpected_data");
      }
      collected.set(category, parsed.data);
    }

    const entries: ZipEntry[] = [];
    for (const category of categories) {
      for (const [path, rows] of Object.entries(collected.get(category)?.files ?? {})) {
        entries.push(
          {
            name: `${path}.json`,
            data: encoder.encode(JSON.stringify(rows, null, 2)),
            compress: true,
          },
          { name: `${path}.csv`, data: encoder.encode(toCsv(rows)), compress: true },
        );
      }
    }

    // Attachments, smallest first within the budget, so as many as possible fit.
    const seen = new Set<string>();
    const media = [...collected.values()]
      .flatMap((category) => category.media)
      .filter((item) => !seen.has(item.path) && Boolean(seen.add(item.path)))
      .sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
    const included: ExportMedia[] = [];
    const omitted: { media: ExportMedia; reason: string }[] = [];
    let budget = EXPORT_MEDIA_BUDGET_BYTES;
    for (const item of media) {
      if (item.size > budget || entries.length + 3 >= MAX_ZIP_ENTRIES) {
        omitted.push({ media: item, reason: "archive_size_limit" });
        continue;
      }
      if (!OBJECT_KEY.test(item.objectKey)) {
        omitted.push({ media: item, reason: "unreadable" });
        continue;
      }
      let read;
      try {
        read = await objects.get(item.objectKey, item.size);
      } catch (error) {
        if (error instanceof StorageUnavailableError) return storageDown(error);
        throw error;
      }
      if (read.status !== "ok") {
        omitted.push({ media: item, reason: "unreadable" });
        continue;
      }
      budget -= read.bytes.byteLength;
      included.push(item);
      entries.push({ name: item.path, data: read.bytes, compress: false });
    }

    const generatedAt = new Date();
    const manifest = buildManifest({
      kind: begin.kind,
      exportId: data.exportId,
      generatedAt,
      allData: begin.allData,
      homes: begin.homes,
      categories,
      collected,
      includedMedia: included,
      omittedMedia: omitted,
    });
    entries.unshift(
      {
        name: "manifest.json",
        data: encoder.encode(JSON.stringify(manifest, null, 2)),
        compress: true,
      },
      {
        name: "README.txt",
        data: encoder.encode(begin.kind === "home" ? README_HOME : README),
        compress: true,
      },
    );

    let archive: Uint8Array;
    try {
      archive = buildZip(entries, generatedAt);
    } catch {
      await services.data.failDataExport(data.exportId, "archive_too_large");
      throw new PermanentJobError("archive_too_large");
    }
    // The archive holds its own copy of the media now; let the originals go before uploading.
    entries.length = 0;
    try {
      await objects.put(begin.objectKey, archive, "application/zip");
    } catch (error) {
      if (error instanceof StorageUnavailableError) return storageDown(error);
      throw error;
    }
    const outcome = await services.data.finishDataExport(
      data.exportId,
      archive.byteLength,
      summaryOf(manifest),
      !manifest.complete,
    );
    logger.info("jobs.privacy_export.done", {
      outcome,
      categories: categories.length,
      attachments: included.length,
      omitted: omitted.length,
      bytes: archive.byteLength,
    });
  },
});
