import "server-only";

import type { ExportRow } from "@/components/privacy/data-export";
import { formatDateTime } from "@/invitations/format";
import type { getDateTimeFormats } from "@/invitations/server";
import { formatBytes } from "@/storage/usage-view";

import type { ExportView } from "./server";

/** Exports as the export list shows them, formatted for the person on the server. */
export function toExportRows(
  views: readonly ExportView[],
  formats: Awaited<ReturnType<typeof getDateTimeFormats>>,
  locale: string,
  nameOf: ReadonlyMap<string, string>,
): ExportRow[] {
  return views.map((row) => {
    const homeNames = row.homeIds
      .map((id) => nameOf.get(id))
      .filter((name): name is string => name !== undefined);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      allData: row.allData,
      categories: row.categories,
      homeNames,
      formerHomes: Math.max(0, row.homeCount - homeNames.length),
      partial: row.partial,
      requested: formatDateTime(row.createdAt, formats),
      expires: row.expiresAt ? formatDateTime(row.expiresAt, formats) : null,
      size: row.sizeBytes === null ? null : formatBytes(row.sizeBytes, locale),
      downloaded: row.downloadedAt ? formatDateTime(row.downloadedAt, formats) : null,
      counts: row.counts,
      omittedAttachments: row.omittedAttachments,
      failureCode: row.failureCode,
    };
  });
}
