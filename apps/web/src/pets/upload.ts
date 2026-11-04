import { finalizeEndpoint, readUploadIntent, type FinalizeResponse } from "@/storage/api";
import { attachmentDisplayName, attachmentTypeOf } from "@/tasks/attachment-policy";

import { medicalEntryEndpoint, petEndpoint } from "./api";
import {
  PET_FILE_MAX_BYTES,
  isPetAttachmentType,
  isPetPhotoType,
  type PetAttachmentType,
  type PetPhotoType,
} from "./schema";

/**
 * The browser side of a pet's photo and of a medical entry's supporting documents (S31), on the
 * S15 pipeline:
 *
 * 1. `POST /api/v1/pets/:id/photo` `{ contentType, size, requestId }` or
 *    `POST /api/v1/pet-medical-entries/:id/attachments` `{ contentType, size, name, requestId }`
 *    → `201 { fileId, uploadUrl, headers, expiresAt }`;
 * 2. `PUT <uploadUrl>` straight to storage;
 * 3. `POST /api/v1/files/:fileId/finalize` `{}` → the server checks the bytes and makes the photo
 *    the pet's, or attaches the document, re-checking the person's rights at that moment.
 *
 * Nothing counts as saved before finalize answers. A retry passes the same attempt: it reuses the
 * request id (the same upload), and once the bytes are stored it only finalizes again.
 */

export type PetUploadFailure =
  | "type"
  | "size"
  | "limit"
  | "storageFull"
  | "storageOff"
  | "rateLimited"
  | "invalidFile"
  | "expired"
  | "notPermitted"
  | "notFound"
  | "signedOut"
  | "network"
  | "failed";

export class PetUploadError extends Error {
  constructor(readonly failure: PetUploadFailure) {
    super(`Pet upload failed: ${failure}`);
    this.name = "PetUploadError";
  }
}

function failureFor(code: unknown): PetUploadFailure {
  switch (code) {
    case "storage-full":
      return "storageFull";
    case "storage-unavailable":
      return "storageOff";
    case "rate-limited":
      return "rateLimited";
    case "limit-reached":
      return "limit";
    case "mismatch":
    case "invalid-file":
    case "invalid-image":
      return "invalidFile";
    case "expired":
    case "conflict":
      return "expired";
    case "not-permitted":
      return "notPermitted";
    case "not-found":
      return "notFound";
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
    throw new PetUploadError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new PetUploadError(failureFor(code));
  }
  return payload;
}

/** Checks a chosen photo before anything is sent. */
export function checkPetPhoto(
  file: Pick<File, "type" | "size">,
): { readonly type: PetPhotoType } | { readonly problem: "type" | "size" } {
  if (!isPetPhotoType(file.type)) return { problem: "type" };
  if (file.size < 1 || file.size > PET_FILE_MAX_BYTES) return { problem: "size" };
  return { type: file.type };
}

/** Checks a chosen document before anything is sent (by its type, or its extension). */
export function checkPetAttachment(
  file: Pick<File, "name" | "type" | "size">,
): { readonly type: PetAttachmentType } | { readonly problem: "type" | "size" } {
  const type = attachmentTypeOf(file);
  if (!isPetAttachmentType(type)) return { problem: "type" };
  if (file.size < 1 || file.size > PET_FILE_MAX_BYTES) return { problem: "size" };
  return { type };
}

export interface PetUploadAttempt {
  readonly requestId: string;
  fileId?: string;
  uploaded?: boolean;
}

export function newPetAttempt(): PetUploadAttempt {
  return { requestId: crypto.randomUUID() };
}

async function send(
  intentUrl: string,
  body: Record<string, unknown>,
  file: File,
  attempt: PetUploadAttempt,
): Promise<FinalizeResponse> {
  if (!(attempt.uploaded && attempt.fileId)) {
    let intent;
    try {
      intent = readUploadIntent(await call(intentUrl, { ...body, requestId: attempt.requestId }));
    } catch (error) {
      throw error instanceof PetUploadError ? error : new PetUploadError("failed");
    }
    attempt.fileId = intent.fileId;
    let put: Response;
    try {
      put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
    } catch {
      throw new PetUploadError("network");
    }
    if (!put.ok) throw new PetUploadError(put.status === 403 ? "expired" : "storageOff");
    attempt.uploaded = true;
  }
  const finalized = (await call(finalizeEndpoint(attempt.fileId), {})) as FinalizeResponse | null;
  if (!finalized?.file.id) throw new PetUploadError("failed");
  return finalized;
}

/** Uploads `file` and makes it the pet's photo. */
export async function uploadPetPhoto(
  petId: string,
  file: File,
  attempt: PetUploadAttempt,
): Promise<void> {
  const checked = checkPetPhoto(file);
  if ("problem" in checked) throw new PetUploadError(checked.problem);
  await send(
    petEndpoint(petId, "photo"),
    { contentType: checked.type, size: file.size },
    file,
    attempt,
  );
}

/** Uploads `file` and attaches it to the medical entry. */
export async function uploadMedicalAttachment(
  entryId: string,
  file: File,
  attempt: PetUploadAttempt,
): Promise<void> {
  const checked = checkPetAttachment(file);
  if ("problem" in checked) throw new PetUploadError(checked.problem);
  const finalized = await send(
    medicalEntryEndpoint(entryId, "attachments"),
    {
      contentType: checked.type,
      size: file.size,
      name: attachmentDisplayName(file.name, checked.type),
    },
    file,
    attempt,
  );
  if (!finalized.attachment) throw new PetUploadError("failed");
}
