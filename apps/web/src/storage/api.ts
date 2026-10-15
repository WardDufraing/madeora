import { AVATAR_MAX_BYTES, isAvatarUploadType } from "./schema";

/**
 * The HTTP contract of file storage (S15, versioned for later mobile clients) and the browser's
 * avatar upload built on it:
 *
 * 1. `POST /api/v1/files/upload-intents` `{ purpose, contentType, size, requestId }` →
 *    `201 { fileId, uploadUrl, headers, expiresAt }`: a 5-minute link to put exactly those bytes.
 * 2. `PUT <uploadUrl>` with `headers` and the file, straight to storage (never through Madeora).
 * 3. `POST /api/v1/files/{fileId}/finalize` `{}` → `200 { file: { id } }` once the server checked
 *    and processed the bytes.
 * 4. `PUT /api/v1/me/avatar` or `PUT /api/v1/homes/{homeId}/profile/avatar` `{ fileId | null }`.
 *
 * `GET /api/v1/files/{fileId}/content` authorizes the viewer and redirects to a 60-second link.
 */
export const UPLOAD_INTENTS_ENDPOINT = "/api/v1/files/upload-intents";
export const MY_AVATAR_ENDPOINT = "/api/v1/me/avatar";

export function finalizeEndpoint(fileId: string): string {
  return `/api/v1/files/${encodeURIComponent(fileId)}/finalize`;
}

export function fileContentPath(fileId: string): string {
  return `/api/v1/files/${encodeURIComponent(fileId)}/content`;
}

export function homeAvatarEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/profile/avatar`;
}

export type StorageErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "storage-unavailable"
  | "storage-full"
  | "rate-limited"
  | "conflict"
  | "not-uploaded"
  | "mismatch"
  | "invalid-image"
  | "expired"
  | "failed";

export interface StorageErrorResponse {
  readonly error: StorageErrorCode;
  readonly fields?: readonly string[];
}

export interface UploadIntentResponse {
  readonly fileId: string;
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface FinalizeResponse {
  readonly file: { readonly id: string };
}

export interface AvatarResponse {
  readonly avatarFileId: string | null;
}

/** Why an avatar change failed, in words the picker can explain. */
export type AvatarFailure =
  | "type"
  | "size"
  | "storageFull"
  | "rateLimited"
  | "invalidImage"
  | "expired"
  | "unavailable"
  | "signedOut"
  | "notFound"
  | "network"
  | "failed";

export class AvatarUploadError extends Error {
  constructor(readonly failure: AvatarFailure) {
    super(`Avatar change failed: ${failure}`);
    this.name = "AvatarUploadError";
  }
}

function failureFor(code: unknown): AvatarFailure {
  switch (code) {
    case "storage-full":
      return "storageFull";
    case "rate-limited":
      return "rateLimited";
    case "mismatch":
    case "invalid-image":
      return "invalidImage";
    case "expired":
    case "conflict":
      return "expired";
    case "storage-unavailable":
      return "unavailable";
    case "unauthenticated":
      return "signedOut";
    case "not-found":
      return "notFound";
    default:
      return "failed";
  }
}

async function call(url: string, method: "POST" | "PUT", body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AvatarUploadError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new AvatarUploadError(failureFor(code));
  }
  return payload;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/** The upload intent from the server's answer; anything else is a failure, never trusted blindly. */
export function readUploadIntent(payload: unknown): UploadIntentResponse {
  if (typeof payload === "object" && payload !== null) {
    const { fileId, uploadUrl, headers, expiresAt } = payload as Record<string, unknown>;
    if (
      typeof fileId === "string" &&
      typeof uploadUrl === "string" &&
      typeof expiresAt === "string" &&
      isStringRecord(headers)
    ) {
      return { fileId, uploadUrl, headers, expiresAt };
    }
  }
  throw new AvatarUploadError("failed");
}

/** Checks a chosen file before anything is sent; null when it may be uploaded. */
export function checkAvatarFile(file: Pick<File, "type" | "size">): AvatarFailure | null {
  if (!isAvatarUploadType(file.type)) return "type";
  if (file.size < 1 || file.size > AVATAR_MAX_BYTES) return "size";
  return null;
}

export type AvatarScope =
  { readonly kind: "global" } | { readonly kind: "home"; readonly homeId: string };

function avatarEndpoint(scope: AvatarScope): string {
  return scope.kind === "global" ? MY_AVATAR_ENDPOINT : homeAvatarEndpoint(scope.homeId);
}

/** Uploads `file` and makes it the avatar for `scope`. Throws AvatarUploadError. */
export async function uploadAvatar(file: File, scope: AvatarScope): Promise<string> {
  const problem = checkAvatarFile(file);
  if (problem) throw new AvatarUploadError(problem);
  const intent = readUploadIntent(
    await call(UPLOAD_INTENTS_ENDPOINT, "POST", {
      purpose: "avatar",
      contentType: file.type,
      size: file.size,
      requestId: crypto.randomUUID(),
    }),
  );

  let put: Response;
  try {
    put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
  } catch {
    throw new AvatarUploadError("network");
  }
  if (!put.ok) throw new AvatarUploadError(put.status === 403 ? "expired" : "unavailable");

  await call(finalizeEndpoint(intent.fileId), "POST", {});
  await call(avatarEndpoint(scope), "PUT", { fileId: intent.fileId });
  return intent.fileId;
}

/** Removes the global avatar, or makes a Home use the global one again. */
export async function clearAvatar(scope: AvatarScope): Promise<void> {
  await call(avatarEndpoint(scope), "PUT", { fileId: null });
}
