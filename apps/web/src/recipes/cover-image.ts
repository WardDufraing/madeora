import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import { sniffImageType } from "@/storage/avatar-image";

import type { CoverType } from "./schema";

/** The stored cover: a WebP of at most this many pixels on its long side (brief S24). */
export const COVER_MAX_SIDE = 1600;
// Refused from the header, before decoding, exactly like avatars (S15): ordinary phone and camera
// photos fit; an enormous image costs memory and CPU on a shared free plan.
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_SIDE = 10_000;

export type ProcessedCover =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly contentType: "image/webp";
      readonly sha256: string;
    }
  /** `mismatch`: the bytes are not the declared type; `invalid-image`: not a usable image. */
  | { readonly ok: false; readonly reason: "mismatch" | "invalid-image" };

/**
 * Turns an uploaded recipe cover into the stored one (S24): checks the signature against the
 * declared type, decodes it with a pixel limit, turns it upright, scales it down to fit 1600 px
 * (never up) and re-encodes it as WebP. Re-encoding drops every piece of metadata (camera, GPS,
 * comments), so only pixels are kept; the upload itself is deleted afterwards.
 */
export async function processCover(
  bytes: Uint8Array,
  declaredType: CoverType,
): Promise<ProcessedCover> {
  if (sniffImageType(bytes) !== declaredType) return { ok: false, reason: "mismatch" };
  let output: Buffer;
  try {
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
      .resize(COVER_MAX_SIDE, COVER_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
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
