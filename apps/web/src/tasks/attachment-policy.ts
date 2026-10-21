import { z } from "zod";

import { nameProblem, normalizeName } from "@/names/visible-name";

import { TASK_LIMITS } from "./schema";

/**
 * What a task attachment may be (S19c; brief defaults pending the owner's choice): images, PDF,
 * plain text and CSV, and the Office and OpenDocument formats, up to 10 MB each and 10 per task.
 * The database checks the same list and limits again (`private.task_attachment_type`,
 * `private.upload_max_bytes`, `private.task_limit`). Client-safe.
 */
export const attachmentTypes = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], kind: "image" },
  "image/png": { extensions: [".png"], kind: "image" },
  "image/webp": { extensions: [".webp"], kind: "image" },
  "application/pdf": { extensions: [".pdf"], kind: "pdf" },
  "text/plain": { extensions: [".txt"], kind: "text" },
  "text/csv": { extensions: [".csv"], kind: "text" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    kind: "office",
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: [".xlsx"],
    kind: "office",
  },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extensions: [".pptx"],
    kind: "office",
  },
  "application/vnd.oasis.opendocument.text": { extensions: [".odt"], kind: "opendocument" },
  "application/vnd.oasis.opendocument.spreadsheet": {
    extensions: [".ods"],
    kind: "opendocument",
  },
  "application/vnd.oasis.opendocument.presentation": {
    extensions: [".odp"],
    kind: "opendocument",
  },
} as const satisfies Record<
  string,
  {
    readonly extensions: readonly string[];
    readonly kind: "image" | "pdf" | "text" | "office" | "opendocument";
  }
>;
export type AttachmentType = keyof typeof attachmentTypes;
export const attachmentTypeList = Object.keys(attachmentTypes) as AttachmentType[];

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export function isAttachmentType(value: unknown): value is AttachmentType {
  return typeof value === "string" && Object.hasOwn(attachmentTypes, value);
}

/** The `accept` value of the file picker: types and extensions, for browsers that know either. */
export const attachmentAccept = [
  ...attachmentTypeList,
  ...attachmentTypeList.flatMap((type) => attachmentTypes[type].extensions),
].join(",");

/**
 * The type of a chosen file. Browsers often leave `type` empty, or say `application/octet-stream`,
 * for Office and OpenDocument files and CSV; then the extension decides. The server checks the
 * file's real signature either way, so a wrong guess only fails the upload.
 */
export function attachmentTypeOf(file: Pick<File, "name" | "type">): AttachmentType | null {
  if (isAttachmentType(file.type)) return file.type;
  if (file.type === "application/vnd.ms-excel" || file.type === "text/x-csv") {
    if (file.name.toLowerCase().endsWith(".csv")) return "text/csv";
  }
  if (file.type !== "" && file.type !== "application/octet-stream") return null;
  const name = file.name.toLowerCase();
  return (
    attachmentTypeList.find((type) =>
      attachmentTypes[type].extensions.some((extension) => name.endsWith(extension)),
    ) ?? null
  );
}

// Invisible characters that would reorder or hide parts of a name: controls, line and paragraph
// separators, direction marks, overrides and isolates, the zero-width space and the BOM.
const invisible = /[\p{Cc}\p{Zl}\p{Zp}\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

/**
 * The name an attachment shows: the file's own name without any folder, invisible characters or
 * runs of spaces, at most 200 characters with its extension kept. A name that is still not a
 * visible name (S11 rule) becomes "file" with the type's extension. The server checks it again.
 */
export function attachmentDisplayName(fileName: string, type: AttachmentType): string {
  const base = fileName.split(/[\\/]/).at(-1) ?? "";
  let name = normalizeName(base.replace(invisible, "").replace(/\s+/gu, " "));
  const max = TASK_LIMITS.attachmentName;
  if (Array.from(name).length > max) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    const stem = Array.from(name.slice(0, name.length - extension.length));
    name = normalizeName(stem.slice(0, max - extension.length).join("")) + extension;
  }
  if (name === "" || nameProblem(name, max)) return `file${attachmentTypes[type].extensions[0]}`;
  return name;
}

/** The display name the server accepts (the same rule as the database's `is_visible_name`). */
export const attachmentNameSchema = z
  .string()
  .max(4 * TASK_LIMITS.attachmentName)
  .refine((value) => {
    const name = normalizeName(value);
    return name === value && name !== "" && nameProblem(name, TASK_LIMITS.attachmentName) === null;
  });

export const attachmentScopes = ["this", "following", "series"] as const;
export type AttachmentScope = (typeof attachmentScopes)[number];

/** `POST /api/v1/tasks/:id/attachments/upload-intents`. */
export const attachmentIntentSchema = z.strictObject({
  contentType: z.enum(attachmentTypeList as [AttachmentType, ...AttachmentType[]]),
  size: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
  name: attachmentNameSchema,
  /** A fresh random id per attempt, so a repeated request opens no second upload. */
  requestId: z.uuid(),
});
export type AttachmentIntentInput = z.infer<typeof attachmentIntentSchema>;

/** `POST /api/v1/files/:id/finalize` for an attachment: which occurrences it goes to. */
export const attachmentFinalizeSchema = z.strictObject({
  scope: z.enum(attachmentScopes).optional(),
});

/** `DELETE /api/v1/task-attachments/:id`. */
export const attachmentRemoveSchema = z.strictObject({
  scope: z.enum(attachmentScopes).default("this"),
  dryRun: z.boolean().default(false),
});
