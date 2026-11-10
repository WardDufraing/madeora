/**
 * How a personal or Home data export is laid out (S39, spec "Confirmed export package structure"): one
 * folder per category, every record file as JSON and CSV, attachments under the category's
 * folder named by their file id, and `manifest.json` at the root describing the export type,
 * generation time, selection, files, counts, formats, exclusions and anything left out.
 */
import { z } from "zod";

export const EXPORT_SCHEMA_VERSION = 1;

export const PERSONAL_EXPORT_CATEGORIES = [
  "account",
  "calendar",
  "tasks",
  "recipes",
  "shopping",
  "meals",
  "habits_goals",
  "media",
  "home_contributions",
] as const;
export type PersonalExportCategory = (typeof PERSONAL_EXPORT_CATEGORIES)[number];

export const HOME_EXPORT_CATEGORIES = [
  "home",
  "tasks",
  "chores",
  "calendar",
  "recipes",
  "shopping",
  "meals",
  "habits_goals",
  "pets",
  "photos",
  "points",
] as const;
export type HomeExportCategory = (typeof HOME_EXPORT_CATEGORIES)[number];

export type ExportKind = "personal" | "home";
export type ExportCategory = PersonalExportCategory | HomeExportCategory;

/** The categories an export of this kind may hold, in the order the app shows them. */
export function categoriesOf(kind: ExportKind): readonly ExportCategory[] {
  return kind === "home" ? HOME_EXPORT_CATEGORIES : PERSONAL_EXPORT_CATEGORIES;
}

const RECORD_PATH = /^[a-z_]+\/[a-z_]+$/;
const MEDIA_PATH = /^[a-z_]+\/[a-z_]+\/[0-9a-f-]{36}\.[a-z]{2,4}$/;

const mediaSchema = z.object({
  fileId: z.uuid(),
  path: z.string().regex(MEDIA_PATH),
  objectKey: z.string(),
  size: z.number().int().nonnegative(),
  contentType: z.string().max(100),
});
export type ExportMedia = z.infer<typeof mediaSchema>;

/** What `collect_data_export` returns for one category. */
export const collectedCategorySchema = z.object({
  files: z.record(z.string().regex(RECORD_PATH), z.array(z.record(z.string(), z.unknown()))),
  media: z.array(mediaSchema),
});
export type CollectedCategory = z.infer<typeof collectedCategorySchema>;

/** A cell for CSV: text as is, everything else as JSON; never a live spreadsheet formula. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let text = typeof value === "string" ? value : JSON.stringify(value);
  // Spreadsheet formula injection (OWASP): text with a leading =, +, -, @, tab or CR is
  // neutralised. Numbers stay numbers (-5 is not a formula).
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** CSV (RFC 4180, CRLF, UTF-8 with BOM for spreadsheet apps); columns are every key in order seen. */
export function toCsv(rows: readonly Readonly<Record<string, unknown>>[]): string {
  const columns: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export interface ManifestInput {
  readonly kind: ExportKind;
  readonly exportId: string;
  readonly generatedAt: Date;
  readonly allData: boolean;
  readonly categories: readonly ExportCategory[];
  /** The selected Homes (personal), or the exported Home (Home). */
  readonly homes: readonly { readonly id: string; readonly name: string }[];
  readonly collected: ReadonlyMap<ExportCategory, CollectedCategory>;
  readonly includedMedia: readonly ExportMedia[];
  readonly omittedMedia: readonly { readonly media: ExportMedia; readonly reason: string }[];
}

/** Codes, so the archive stays language-neutral; README.txt explains them in plain words. */
export const EXPORT_EXCLUSIONS = [
  "home_owned_records",
  "other_members_personal_data",
  "items_in_trash",
  "credentials_tokens_and_security_secrets",
  "security_activity_see_security_report",
  "audit_internals",
  "google_calendar_tokens_and_synced_copies",
  "notification_details",
] as const;

/** What a Home export never holds (README_HOME explains them). */
export const HOME_EXPORT_EXCLUSIONS = [
  "personal_items_shared_into_the_home",
  "records_you_may_not_see",
  "members_personal_data_and_accounts",
  "items_in_trash",
  "credentials_tokens_and_security_secrets",
  "audit_internals",
  "google_calendar_synced_copies",
] as const;

export function buildManifest(input: ManifestInput) {
  const categories = input.categories.map((category) => {
    const collected = input.collected.get(category);
    const files = Object.entries(collected?.files ?? {}).map(([path, rows]) => ({
      path,
      formats: ["json", "csv"],
      records: rows.length,
    }));
    const records = files.reduce((sum, file) => sum + file.records, 0);
    return {
      category,
      records,
      empty: records === 0 && (collected?.media.length ?? 0) === 0,
      files,
    };
  });
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportType: input.kind,
    exportId: input.exportId,
    generatedAt: input.generatedAt.toISOString(),
    selection: input.allData ? "all_eligible_data" : "chosen_categories",
    homes: input.homes.map((home) => ({ id: home.id, name: home.name })),
    categories,
    attachments: {
      included: input.includedMedia.map((media) => ({
        path: media.path,
        fileId: media.fileId,
        bytes: media.size,
        contentType: media.contentType,
      })),
      omitted: input.omittedMedia.map(({ media, reason }) => ({ fileId: media.fileId, reason })),
    },
    complete: input.omittedMedia.length === 0,
    exclusions: input.kind === "home" ? HOME_EXPORT_EXCLUSIONS : EXPORT_EXCLUSIONS,
    encoding: "UTF-8; CSV files start with a byte order mark; times are ISO 8601 in UTC",
  };
}
export type ExportManifest = ReturnType<typeof buildManifest>;

/** The small summary stored with the export (counts only), shown on the export screen. */
export function summaryOf(manifest: ExportManifest) {
  return {
    categories: Object.fromEntries(
      manifest.categories.map((category) => [category.category, category.records]),
    ),
    attachments: manifest.attachments.included.length,
    omittedAttachments: manifest.attachments.omitted.length,
  };
}

export const README = `Madeora personal data export
============================

This archive holds the personal data you chose to export from Madeora.

- manifest.json lists every folder and file, how many records each holds, the attachments
  included or left out, and what an export never contains.
- Every record file is included twice: as JSON and as CSV (UTF-8). Times are in UTC.
- Attachments (photos, recipe covers, task files, profile pictures) sit in their category's folder,
  named by their file id; the records refer to them by that id.
- People other than you appear only as "someone_else"; Homes appear by name.
- Not included: records owned by a Home, other members' personal data, items in trash, passwords,
  codes and other security secrets, your security activity (download the security report in
  Settings > Security > Security activity), Google Calendar tokens and synced copies, and the
  details of your in-app notifications (they can name other people; their kind and dates are in
  account/notifications).

If "complete" in manifest.json is false, some attachments were too large for one archive or could
not be read; they are listed under attachments.omitted and are still in Madeora.
`;

export const README_HOME = `Madeora Home data export
========================

This archive holds the data of one Home that you may see, exported with the Home's export
permission.

- manifest.json lists every folder and file, how many records each holds, the attachments
  included or left out, and what a Home export never contains.
- Every record file is included twice: as JSON and as CSV (UTF-8). Times are in UTC.
- Attachments (photos, recipe covers, task files, pet photos and, where you may see them, pet
  medical files) sit in their category's folder, named by their file id.
- Members appear by their name in the Home ("you" for you, "former_member" once they left).
- Not included: personal items members shared into the Home (they stay their owners'), records
  and fields you may not see in Madeora (for example pet medical information without medical
  access, or other members' point accounts), members' personal data and accounts, items in trash,
  passwords, tokens and other security secrets, audit internals, and copies synced from Google
  Calendar.

If "complete" in manifest.json is false, some attachments were too large for one archive or could
not be read; they are listed under attachments.omitted and are still in Madeora.
`;
