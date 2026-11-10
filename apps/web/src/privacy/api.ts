import type {
  ExportRequestInput,
  HomeExportAccessInput,
  HomeExportRequestInput,
  ReviewActionInput,
} from "./schema";

/**
 * The HTTP contract of the privacy endpoints (S39; versioned, so later mobile clients can use them
 * too), and the browser's callers. Cookie-authenticated, same-origin JSON requests acting only on
 * the signed-in account's own exports and review.
 *
 * - `POST /api/v1/me/exports` `{ allData: boolean, categories: string[], homeIds: uuid[] }`
 *   → `201 { id }`; `403 reauthentication-required`; `409 in-progress`; `429 rate-limited`
 * - `POST /api/v1/me/exports/{exportId}/cancel` `{}` → `200 { canceled }`
 * - `POST /api/v1/me/exports/{exportId}/download` `{}` → `200 { url }`, a 60-second GET-only link
 *   to the archive; `410 invalidated` when access changed since it was prepared (a fresh export is
 *   needed); `410 expired`; `403 reauthentication-required`
 * - `POST /api/v1/homes/{homeId}/exports` `{ allData: boolean, categories: string[] }` → `201 { id }`
 *   (a Home export; needs exportHomeData: `403 not-permitted`); then the same cancel and download
 *   endpoints as a personal export
 * - `PUT /api/v1/homes/{homeId}/export-access` `{ membershipId, granted }` → `200 { outcome }`
 *   (the Owner only: `403 not-permitted`)
 * - `POST /api/v1/me/privacy-review` `{ action: "start" | "step" | "finish" | "dismiss", step? }`
 *   → `200 {}`
 *
 * Errors: `401 unauthenticated`, `400 invalid`, `403 forbidden` (cross-site), `404 not-found`,
 * `413 too-large`, `415 unsupported-media-type`, `500 failed`, `503 storage-off`.
 */
export const EXPORTS_ENDPOINT = "/api/v1/me/exports";
export const PRIVACY_REVIEW_ENDPOINT = "/api/v1/me/privacy-review";

export type PrivacyErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "reauthentication-required"
  | "rate-limited"
  | "in-progress"
  | "invalidated"
  | "expired"
  | "storage-off"
  | "not-permitted"
  | "failed";

export type PrivacyFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "reauthenticate"
  | "rateLimited"
  | "inProgress"
  | "invalidated"
  | "expired"
  | "storageOff"
  | "notPermitted"
  | "network"
  | "failed";

export class PrivacyActionError extends Error {
  constructor(readonly failure: PrivacyFailure) {
    super(`Privacy action failed: ${failure}`);
    this.name = "PrivacyActionError";
  }
}

const failures: Record<string, PrivacyFailure> = {
  invalid: "invalid",
  "not-found": "notFound",
  "reauthentication-required": "reauthenticate",
  "rate-limited": "rateLimited",
  "in-progress": "inProgress",
  invalidated: "invalidated",
  expired: "expired",
  "storage-off": "storageOff",
  "not-permitted": "notPermitted",
};

async function send(
  url: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new PrivacyActionError("network");
  }
  const json = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new PrivacyActionError("signedOut");
    const code = typeof json.error === "string" ? json.error : "";
    throw new PrivacyActionError(failures[code] ?? "failed");
  }
  return json;
}

export async function requestExport(input: ExportRequestInput): Promise<string> {
  const body = await send(EXPORTS_ENDPOINT, input);
  if (typeof body.id !== "string") throw new PrivacyActionError("failed");
  return body.id;
}

export async function cancelExport(exportId: string): Promise<boolean> {
  const body = await send(`${EXPORTS_ENDPOINT}/${encodeURIComponent(exportId)}/cancel`, {});
  return body.canceled === true;
}

/** A short-lived link to the archive; the caller navigates to it straight away. */
export async function exportDownloadLink(exportId: string): Promise<string> {
  const body = await send(`${EXPORTS_ENDPOINT}/${encodeURIComponent(exportId)}/download`, {});
  if (typeof body.url !== "string") throw new PrivacyActionError("failed");
  return body.url;
}

export async function saveReview(input: ReviewActionInput): Promise<void> {
  await send(PRIVACY_REVIEW_ENDPOINT, input);
}

export function homeExportsEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/exports`;
}

export function homeExportAccessEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/export-access`;
}

export async function requestHomeExport(
  homeId: string,
  input: HomeExportRequestInput,
): Promise<string> {
  const body = await send(homeExportsEndpoint(homeId), input);
  if (typeof body.id !== "string") throw new PrivacyActionError("failed");
  return body.id;
}

export async function setHomeExportAccess(
  homeId: string,
  input: HomeExportAccessInput,
): Promise<void> {
  await send(homeExportAccessEndpoint(homeId), input, "PUT");
}
