import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import { sniffImageType } from "@/storage/avatar-image";

import { ATTACHMENT_MAX_BYTES, attachmentTypes, type AttachmentType } from "./attachment-policy";

/**
 * Checks an uploaded task attachment before it is kept (S19c; architecture.md §10 step 5). No free
 * malware scanner fits the €0 budget, so safety is the type allowlist plus a check that the bytes
 * really are that type: image signatures (and a full decode), `%PDF-` for PDF, a ZIP with the
 * Office or OpenDocument structure, UTF-8 text without NUL bytes. Images are re-encoded in the same
 * format, upright, with every piece of metadata (location, camera, comments) removed; other files
 * are kept exactly as uploaded and served as downloads.
 */

// The same header limits as avatars, a little higher for documents photographed at full size.
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_SIDE = 16_384;

export type CheckedAttachment =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly contentType: AttachmentType;
      readonly sha256: string;
    }
  /** `mismatch`: not the declared type; `invalid-file`: that type, but unusable (or a pixel bomb). */
  | { readonly ok: false; readonly reason: "mismatch" | "invalid-file" };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

/** The names of a ZIP archive's entries, from its central directory; null when it is not a ZIP. */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 22 + 65535 bytes (its comment may follow).
  const lowest = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (offset + size > end) return null;
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > end) return null;
    names.push(decoder.decode(bytes.subarray(offset + 46, nameEnd)));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

const officeFolder: Partial<Record<AttachmentType, string>> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word/",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xl/",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt/",
};

/** An OpenDocument file starts with an uncompressed `mimetype` entry holding its type. */
function openDocumentType(bytes: Uint8Array): string | null {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || bytes.byteLength < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const method = view.getUint16(8, true);
  const size = view.getUint32(18, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
  if (method !== 0 || name !== "mimetype" || size > 100) return null;
  const start = 30 + nameLength + extraLength;
  if (start + size > bytes.byteLength) return null;
  return new TextDecoder().decode(bytes.subarray(start, start + size));
}

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function reencodeImage(
  bytes: Uint8Array,
  type: "image/jpeg" | "image/png" | "image/webp",
): Promise<CheckedAttachment> {
  try {
    // Reads only the header: refuses an oversized image before any pixel is decoded.
    const { width, height, isPalette } = await sharp(bytes).metadata();
    if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_INPUT_PIXELS) {
      return { ok: false, reason: "invalid-file" };
    }
    const image = sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
    }).rotate();
    // No withMetadata(): sharp writes no EXIF, XMP, IPTC or ICC data unless asked to.
    const output =
      type === "image/jpeg"
        ? await image.jpeg({ quality: 88, mozjpeg: true }).toBuffer()
        : type === "image/png"
          ? // A palette PNG stays a palette PNG, so re-encoding does not make it several times larger.
            await image.png({ compressionLevel: 9, palette: isPalette }).toBuffer()
          : await image.webp({ quality: 88 }).toBuffer();
    // The stored file keeps to the per-file limit too, whatever re-encoding did to its size.
    if (output.byteLength > ATTACHMENT_MAX_BYTES) return { ok: false, reason: "invalid-file" };
    const result = new Uint8Array(output);
    return { ok: true, bytes: result, contentType: type, sha256: sha256(result) };
  } catch {
    return { ok: false, reason: "invalid-file" };
  }
}

/** Checks `bytes` against the declared type and returns what is stored. */
export async function checkAttachment(
  bytes: Uint8Array,
  declaredType: AttachmentType,
): Promise<CheckedAttachment> {
  const kept = (): CheckedAttachment => ({
    ok: true,
    bytes,
    contentType: declaredType,
    sha256: sha256(bytes),
  });
  switch (attachmentTypes[declaredType].kind) {
    case "image": {
      if (sniffImageType(bytes) !== declaredType) return { ok: false, reason: "mismatch" };
      return reencodeImage(bytes, declaredType);
    }
    case "pdf":
      return startsWith(bytes, ascii("%PDF-")) ? kept() : { ok: false, reason: "mismatch" };
    case "text":
      return isText(bytes) ? kept() : { ok: false, reason: "mismatch" };
    case "office": {
      const names = zipEntryNames(bytes);
      if (!names) return { ok: false, reason: "mismatch" };
      const folder = officeFolder[declaredType] ?? "";
      return names.includes("[Content_Types].xml") && names.some((name) => name.startsWith(folder))
        ? kept()
        : { ok: false, reason: "mismatch" };
    }
    case "opendocument": {
      if (openDocumentType(bytes) !== declaredType || !zipEntryNames(bytes)) {
        return { ok: false, reason: "mismatch" };
      }
      return kept();
    }
  }
}
