import { finalizeEndpoint, readUploadIntent, type FinalizeResponse } from "@/storage/api";

import { RECIPE_COVER_UPLOADS_ENDPOINT } from "./api";
import { isCoverType, RECIPE_FIELD_LIMITS, type CoverType } from "./schema";

/**
 * The browser side of choosing a recipe cover (S24), on the S15 pipeline:
 *
 * 1. `POST /api/v1/recipes/cover-uploads` `{ contentType, size, requestId, recipeId, lockToken }`
 *    → `201 { fileId, uploadUrl, headers, expiresAt }`;
 * 2. `PUT <uploadUrl>` straight to storage;
 * 3. `POST /api/v1/files/{fileId}/finalize` `{}` → the server checks the bytes and stores a WebP.
 *
 * The cover is applied only when the recipe is saved with its file id; an unsaved one is retired by
 * the expiry job. A retry reuses the request id, so it never opens a second upload.
 */

export type CoverFailure =
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

export class CoverUploadError extends Error {
  constructor(readonly failure: CoverFailure) {
    super(`Cover upload failed: ${failure}`);
    this.name = "CoverUploadError";
  }
}

function failureFor(code: unknown): CoverFailure {
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

async function call(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new CoverUploadError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new CoverUploadError(failureFor(code));
  }
  return payload;
}

/** Checks a chosen file before anything is sent: its type, or what is wrong with it. */
export function checkCoverFile(
  file: Pick<File, "type" | "size">,
): { readonly type: CoverType } | { readonly problem: "type" | "size" } {
  if (!isCoverType(file.type)) return { problem: "type" };
  if (file.size < 1 || file.size > RECIPE_FIELD_LIMITS.coverBytes) return { problem: "size" };
  return { type: file.type };
}

/**
 * Uploads `file` as a cover for a new recipe or a draft (`recipeId` null or the draft's), or for a
 * published recipe being edited (its id and the editor's lock token). Answers the file id to save.
 */
export async function uploadCover(
  file: File,
  target: { readonly recipeId: string | null; readonly lockToken: string | null },
  requestId: string,
): Promise<string> {
  const checked = checkCoverFile(file);
  if ("problem" in checked) throw new CoverUploadError(checked.problem);
  let intent;
  try {
    intent = readUploadIntent(
      await call(RECIPE_COVER_UPLOADS_ENDPOINT, {
        contentType: checked.type,
        size: file.size,
        requestId,
        recipeId: target.recipeId,
        lockToken: target.lockToken,
      }),
    );
  } catch (error) {
    throw error instanceof CoverUploadError ? error : new CoverUploadError("failed");
  }
  let put: Response;
  try {
    put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
  } catch {
    throw new CoverUploadError("network");
  }
  if (!put.ok) throw new CoverUploadError(put.status === 403 ? "expired" : "storageOff");
  const finalized = (await call(finalizeEndpoint(intent.fileId), {})) as FinalizeResponse | null;
  if (!finalized?.file.id) throw new CoverUploadError("failed");
  return finalized.file.id;
}
