import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import type { AvatarUploadType } from "./schema";

/** The stored avatar: a square WebP, the size every surface can scale down from. */
export const AVATAR_SIZE = 512;
// Anything larger is refused from the header, before decoding: a 5 MB file can claim to be an
// enormous image, and decoding costs memory (4 bytes a pixel) and CPU on a shared free plan. 24
// megapixels covers ordinary phone and camera photos; 8192 caps a very long, thin one.
const MAX_INPUT_PIXELS = 24_000_000;
const MAX_SIDE = 8192;

export type ProcessedAvatar =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly contentType: "image/webp";
      readonly sha256: string;
    }
  /** `mismatch`: the bytes are not the declared type; `invalid-image`: not a usable image. */
  | { readonly ok: false; readonly reason: "mismatch" | "invalid-image" };

/** The type the file's first bytes say it is, from its signature; never from its name or header. */
export function sniffImageType(bytes: Uint8Array): AvatarUploadType | null {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/**
 * Turns an uploaded avatar into the stored one (S15; spec L447, architecture §37): checks the
 * signature against the declared type, decodes it with a pixel limit, turns it upright by its
 * orientation, crops it to a 512×512 square and re-encodes it as WebP. Re-encoding drops every
 * piece of metadata (camera, GPS, comments) and anything hidden in the file, so only pixels are
 * kept; the upload itself is deleted afterwards.
 */
export async function processAvatar(
  bytes: Uint8Array,
  declaredType: AvatarUploadType,
): Promise<ProcessedAvatar> {
  if (sniffImageType(bytes) !== declaredType) return { ok: false, reason: "mismatch" };
  let output: Buffer;
  try {
    // Reads only the header: refuses an oversized image before any pixel is decoded.
    const { width, height } = await sharp(bytes).metadata();
    if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_INPUT_PIXELS) {
      return { ok: false, reason: "invalid-image" };
    }
    output = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
    })
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return { ok: false, reason: "invalid-image" };
  }
  return {
    ok: true,
    bytes: new Uint8Array(output),
    contentType: "image/webp",
    sha256: createHash("sha256").update(output).digest("hex"),
  };
}
