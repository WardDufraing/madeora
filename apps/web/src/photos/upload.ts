import { finalizeEndpoint, readUploadIntent, type FinalizeResponse } from "@/storage/api";

import { PHOTO_UPLOAD_INTENTS_ENDPOINT } from "./api";
import {
  isPhotoUploadType,
  PHOTO_LIMITS,
  type PhotoOwnerInput,
  type PhotoUploadType,
} from "./schema";

/**
 * The browser side of adding a photo (S35), on the S15 pipeline:
 *
 * 1. `POST /api/v1/photos/upload-intents` `{ owner, contentType, size, requestId }` → a signed link;
 * 2. `PUT <uploadUrl>` straight to storage;
 * 3. `POST /api/v1/files/{fileId}/finalize` → the server checks the bytes, makes the optimized master
 *    and its derivatives, and the photo appears in the library.
 *
 * A retry reuses the request id, so it never opens a second upload.
 */

export type PhotoFailure =
  | "type"
  | "size"
  | "storageFull"
  | "storageOff"
  | "rateLimited"
  | "invalidFile"
  | "expired"
  | "notPermitted"
  | "signedOut"
  | "network"
  | "failed";

export class PhotoUploadError extends Error {
  constructor(readonly failure: PhotoFailure) {
    super(`Photo upload failed: ${failure}`);
    this.name = "PhotoUploadError";
  }
}

function failureFor(code: unknown): PhotoFailure {
  switch (code) {
    case "storage-full":
      return "storageFull";
    case "storage-unavailable":
      return "storageOff";
    case "rate-limited":
      return "rateLimited";
    case "mismatch":
    case "invalid-image":
      return "invalidFile";
    case "expired":
    case "conflict":
      return "expired";
    case "not-permitted":
    case "not-found":
      return "notPermitted";
    case "unauthenticated":
      return "signedOut";
    case "too-large":
      return "size";
    default:
      return "failed";
  }
}

async function post(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new PhotoUploadError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new PhotoUploadError(failureFor(code));
  }
  return payload;
}

/**
 * What a chosen file is, from the browser's own claim: HEIC and HEIF often arrive with an empty type,
 * so the extension decides then. The server checks the real bytes again.
 */
export function photoTypeOf(file: Pick<File, "type" | "name">): PhotoUploadType | null {
  if (isPhotoUploadType(file.type)) return file.type;
  if (file.type !== "" && file.type !== "application/octet-stream") return null;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return null;
}

/** Checks a chosen file before anything is sent: its type, or what is wrong with it. */
export function checkPhotoFile(
  file: Pick<File, "type" | "name" | "size">,
): { readonly type: PhotoUploadType } | { readonly problem: "type" | "size" } {
  const type = photoTypeOf(file);
  if (!type) return { problem: "type" };
  if (file.size < 1 || file.size > PHOTO_LIMITS.uploadBytes) return { problem: "size" };
  return { type };
}

/** Uploads `file` into the library `owner` names and answers once the photo is stored. */
export async function uploadPhoto(
  file: File,
  owner: PhotoOwnerInput,
  requestId: string,
): Promise<void> {
  const checked = checkPhotoFile(file);
  if ("problem" in checked) throw new PhotoUploadError(checked.problem);
  let intent;
  try {
    intent = readUploadIntent(
      await post(PHOTO_UPLOAD_INTENTS_ENDPOINT, {
        owner,
        contentType: checked.type,
        size: file.size,
        requestId,
      }),
    );
  } catch (error) {
    throw error instanceof PhotoUploadError ? error : new PhotoUploadError("failed");
  }
  let put: Response;
  try {
    // The signed link fixes the type: send the one the intent was opened for, not the browser's guess.
    put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
  } catch {
    throw new PhotoUploadError("network");
  }
  if (!put.ok) throw new PhotoUploadError(put.status === 403 ? "expired" : "storageOff");
  const finalized = (await post(finalizeEndpoint(intent.fileId), {})) as FinalizeResponse | null;
  if (!finalized?.file.id) throw new PhotoUploadError("failed");
}
