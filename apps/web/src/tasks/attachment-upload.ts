import { finalizeEndpoint, readUploadIntent, type FinalizeResponse } from "@/storage/api";

import { TASKS_ENDPOINT } from "./api";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentDisplayName,
  attachmentTypeOf,
  type AttachmentScope,
  type AttachmentType,
} from "./attachment-policy";

/**
 * The browser side of adding a task attachment (S19c), on the S15 pipeline:
 *
 * 1. `POST /api/v1/tasks/{taskId}/attachments/upload-intents` `{ contentType, size, name,
 *    requestId }` → `201 { fileId, uploadUrl, headers, expiresAt }`;
 * 2. `PUT <uploadUrl>` straight to storage, with progress and cancel;
 * 3. `POST /api/v1/files/{fileId}/finalize` `{ scope }` → the server checks the bytes, keeps them
 *    and attaches the file to the task (and, for a series scope, to following or all occurrences).
 *
 * A retry passes the same attempt: it reuses the request id (the server answers with the same
 * upload), and once the bytes are stored it only finalizes again, which attaches the file at most
 * once. So a retry never opens a second upload or attaches a second copy.
 */

export type AttachmentFailure =
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
  | "scopeUnavailable"
  | "signedOut"
  | "network"
  | "cancelled"
  | "failed";

export class AttachmentUploadError extends Error {
  constructor(readonly failure: AttachmentFailure) {
    super(`Attachment upload failed: ${failure}`);
    this.name = "AttachmentUploadError";
  }
}

export function attachmentIntentEndpoint(taskId: string): string {
  return `${TASKS_ENDPOINT}/${encodeURIComponent(taskId)}/attachments/upload-intents`;
}

function failureFor(code: unknown): AttachmentFailure {
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
    case "scope-unavailable":
      return "scopeUnavailable";
    case "unauthenticated":
      return "signedOut";
    case "too-large":
      return "size";
    default:
      return "failed";
  }
}

async function call(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new AttachmentUploadError(signal?.aborted ? "cancelled" : "network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new AttachmentUploadError(failureFor(code));
  }
  return payload;
}

/** Puts the bytes with progress; XMLHttpRequest because fetch reports no upload progress. */
function put(
  url: string,
  headers: Readonly<Record<string, string>>,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new AttachmentUploadError(request.status === 403 ? "expired" : "storageOff"));
    };
    request.onerror = () => {
      reject(new AttachmentUploadError("network"));
    };
    request.onabort = () => {
      reject(new AttachmentUploadError("cancelled"));
    };
    if (signal) {
      if (signal.aborted) {
        reject(new AttachmentUploadError("cancelled"));
        return;
      }
      signal.addEventListener("abort", () => {
        request.abort();
      });
    }
    request.send(file);
  });
}

/** Checks a chosen file before anything is sent: its type (or null) and what is wrong with it. */
export function checkAttachmentFile(
  file: Pick<File, "name" | "type" | "size">,
): { readonly type: AttachmentType } | { readonly problem: "type" | "size" } {
  const type = attachmentTypeOf(file);
  if (!type) return { problem: "type" };
  if (file.size < 1 || file.size > ATTACHMENT_MAX_BYTES) return { problem: "size" };
  return { type };
}

export interface UploadAttempt {
  /** The same for retries of one attempt, so the server opens one upload. */
  readonly requestId: string;
  /** Set once the intent answered, and `uploaded` once storage accepted the bytes. */
  fileId?: string;
  uploaded?: boolean;
}

export function newAttempt(): UploadAttempt {
  return { requestId: crypto.randomUUID() };
}

/** Uploads `file` and attaches it to the task. Throws AttachmentUploadError. */
export async function uploadAttachment(
  taskId: string,
  file: File,
  scope: AttachmentScope,
  attempt: UploadAttempt,
  options: { readonly onProgress: (fraction: number) => void; readonly signal?: AbortSignal },
): Promise<NonNullable<FinalizeResponse["attachment"]>> {
  const checked = checkAttachmentFile(file);
  if ("problem" in checked) throw new AttachmentUploadError(checked.problem);
  if (!(attempt.uploaded && attempt.fileId)) {
    attempt.fileId = await upload(taskId, file, checked.type, attempt, options);
    attempt.uploaded = true;
  }
  options.onProgress(1);
  const finalized = (await call(
    finalizeEndpoint(attempt.fileId),
    { scope },
    options.signal,
  )) as FinalizeResponse | null;
  if (!finalized?.attachment) throw new AttachmentUploadError("failed");
  return finalized.attachment;
}

/** Opens the upload (or the same one again) and puts the bytes; answers the file id. */
async function upload(
  taskId: string,
  file: File,
  type: AttachmentType,
  attempt: UploadAttempt,
  options: { readonly onProgress: (fraction: number) => void; readonly signal?: AbortSignal },
): Promise<string> {
  let intent;
  try {
    intent = readUploadIntent(
      await call(
        attachmentIntentEndpoint(taskId),
        {
          contentType: type,
          size: file.size,
          name: attachmentDisplayName(file.name, type),
          requestId: attempt.requestId,
        },
        options.signal,
      ),
    );
  } catch (error) {
    if (error instanceof AttachmentUploadError) throw error;
    throw new AttachmentUploadError("failed");
  }
  attempt.fileId = intent.fileId;
  await put(intent.uploadUrl, intent.headers, file, options.onProgress, options.signal);
  return intent.fileId;
}
