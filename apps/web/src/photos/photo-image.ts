import "server-only";

import { createHash } from "node:crypto";

import decodeHeic from "heic-decode";
import sharp from "sharp";

import { PHOTO_LIMITS, type PhotoUploadType } from "./schema";

/** One stored picture of a photo: always a WebP the server made. */
export interface PhotoVariantBytes {
  readonly kind: "master" | "full" | "display" | "thumb";
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export type ProcessedPhoto =
  | { readonly ok: true; readonly variants: readonly PhotoVariantBytes[] }
  /** `mismatch`: the bytes are not the declared type; `invalid-image`: not a usable picture. */
  | { readonly ok: false; readonly reason: "mismatch" | "invalid-image" };

const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "heif",
]);

/** The type the file's first bytes say it is, from its signature; never from its name or header. */
export function sniffPhotoType(bytes: Uint8Array): PhotoUploadType | null {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (bytes.byteLength >= 12 && ascii(4, 4) === "ftyp") {
    return HEIC_BRANDS.has(ascii(8, 4)) ? "image/heic" : null;
  }
  return null;
}

/** HEIC and HEIF are one family; a file may declare either. */
function sameKind(sniffed: PhotoUploadType, declared: PhotoUploadType): boolean {
  const heif = (type: PhotoUploadType) => type === "image/heic" || type === "image/heif";
  return heif(sniffed) && heif(declared) ? true : sniffed === declared;
}

/**
 * The largest picture size a HEIC file claims, read from its `ispe` boxes before anything is
 * decoded (a small file can claim an enormous image). Null when no size can be read.
 */
export function heicClaimedSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let found = false;
  // 'ispe' box: size, 'ispe', version/flags (4 bytes), width, height.
  for (let i = 4; i + 16 <= bytes.byteLength; i += 1) {
    if (
      bytes[i] === 0x69 &&
      bytes[i + 1] === 0x73 &&
      bytes[i + 2] === 0x70 &&
      bytes[i + 3] === 0x65
    ) {
      width = Math.max(width, view.getUint32(i + 8));
      height = Math.max(height, view.getUint32(i + 12));
      found = true;
    }
  }
  return found ? { width, height } : null;
}

function tooBig(width: number | undefined, height: number | undefined): boolean {
  if (!width || !height) return true;
  return (
    width > PHOTO_LIMITS.maxSide ||
    height > PHOTO_LIMITS.maxSide ||
    width * height > PHOTO_LIMITS.maxPixels
  );
}

async function encode(
  source: Buffer,
  kind: PhotoVariantBytes["kind"],
  side: number,
  quality: number,
): Promise<PhotoVariantBytes> {
  const { data, info } = await sharp(source)
    .resize(side, side, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return {
    kind,
    bytes: new Uint8Array(data),
    width: info.width,
    height: info.height,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/**
 * Turns an uploaded photo into what is stored (S35; spec "no original kept", architecture §37):
 * checks the signature against the declared type, refuses a picture whose header claims too many
 * pixels, decodes it (HEIC with a WebAssembly decoder, since sharp's build has no HEVC), turns it
 * upright by its orientation, keeps the first frame of an animation, and re-encodes an optimized
 * master and three display derivatives as WebP. Re-encoding drops every piece of metadata (camera,
 * GPS, time, comments), so only pixels are kept. The upload itself is deleted afterwards.
 */
export async function processPhoto(
  bytes: Uint8Array,
  declaredType: PhotoUploadType,
): Promise<ProcessedPhoto> {
  const sniffed = sniffPhotoType(bytes);
  if (!sniffed || !sameKind(sniffed, declaredType)) return { ok: false, reason: "mismatch" };
  try {
    let upright: Buffer;
    if (sniffed === "image/heic") {
      const claimed = heicClaimedSize(bytes);
      if (!claimed || tooBig(claimed.width, claimed.height)) {
        return { ok: false, reason: "invalid-image" };
      }
      const decoded = await decodeHeic({ buffer: bytes });
      if (tooBig(decoded.width, decoded.height)) return { ok: false, reason: "invalid-image" };
      // libheif applies the file's own rotation and mirroring while decoding; raw pixels carry no
      // orientation tag, so nothing is rotated twice.
      upright = await sharp(
        Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
        {
          raw: { width: decoded.width, height: decoded.height, channels: 4 },
          limitInputPixels: PHOTO_LIMITS.maxPixels,
        },
      )
        .png({ compressionLevel: 1 })
        .toBuffer();
    } else {
      // Reads only the header: refuses an oversized image before any pixel is decoded.
      const { width, height } = await sharp(bytes).metadata();
      if (tooBig(width, height)) return { ok: false, reason: "invalid-image" };
      upright = await sharp(bytes, {
        limitInputPixels: PHOTO_LIMITS.maxPixels,
        failOn: "error",
        animated: false,
      })
        .rotate()
        .png({ compressionLevel: 1 })
        .toBuffer();
    }
    const variants = [
      await encode(upright, "master", PHOTO_LIMITS.masterSide, 85),
      await encode(upright, "full", PHOTO_LIMITS.fullSide, 82),
      await encode(upright, "display", PHOTO_LIMITS.displaySide, 80),
      await encode(upright, "thumb", PHOTO_LIMITS.thumbSide, 76),
    ];
    return { ok: true, variants };
  } catch {
    return { ok: false, reason: "invalid-image" };
  }
}
