import type {
  SecurityAlertsInput,
  SecurityReportFormat,
  SecurityReportRequestInput,
} from "./schema";

/**
 * The HTTP contract of the activity endpoints (S38; versioned, so later mobile clients can use
 * them too), and the browser's callers. All are cookie-authenticated, same-origin JSON requests
 * acting only on the signed-in account's own records.
 *
 * - `POST /api/v1/me/activity/{eventId}/response` `{ response: "confirmed" | "reported" }`
 *   → `200 { result: "confirmed" | "signed_out" | "reported" }`
 * - `PUT  /api/v1/me/security-alerts` `{ newDevice, everySignIn }` → `200 {}`
 * - `POST /api/v1/me/security-reports` `{ from, to, timeZone }` → `201 { id }`
 * - `POST /api/v1/me/security-reports/{reportId}/download` `{ format: "csv" | "json" }`
 *   → `200` the file (`Content-Disposition: attachment`, `Cache-Control: no-store`)
 * - `POST /api/v1/me/security-reports/{reportId}/discard` `{}` → `200 { discarded }`
 * - `POST /api/v1/me/deactivate` `{}` → `200 {}` (every session ends, this one too);
 *   `409 sole-owner` while a Home the account alone owns has no other Owner
 * - `POST /api/v1/me/reactivate` `{}` → `200 { since }` (the deactivated account's own session)
 * - `POST /api/v1/me/security-review` `{}` → `200 {}`
 * - `POST /api/v1/me/delete-account` `{ confirmation }` → `200 { purgeAfter }` (S40: every session
 *   ends, this one too); `409 sole-owner` while the account owns an active Home
 * - `POST /api/v1/homes/{homeId}/close` `{ name }` → `200 { purgeAfter }` (S40, the Owner only)
 * - `POST /api/v1/homes/{homeId}/restore` `{}` → `200 {}` (S40, the Owner only, before the deadline);
 *   `410 expired` once the recovery period has ended
 *
 * Errors: `401 unauthenticated`, `400 invalid`, `403 forbidden` (cross-site),
 * `403 reauthentication-required` (a fresh re-authentication is needed), `404 not-found`,
 * `409 sole-owner`, `410 expired`,
 * `413 too-large`, `415 unsupported-media-type`, `429 rate-limited`, `500 failed`.
 */
export const ACTIVITY_ENDPOINT = "/api/v1/me/activity";
export const SECURITY_ALERTS_ENDPOINT = "/api/v1/me/security-alerts";
export const SECURITY_REPORTS_ENDPOINT = "/api/v1/me/security-reports";
export const DEACTIVATE_ENDPOINT = "/api/v1/me/deactivate";
export const REACTIVATE_ENDPOINT = "/api/v1/me/reactivate";
export const SECURITY_REVIEW_ENDPOINT = "/api/v1/me/security-review";
export const DELETE_ACCOUNT_ENDPOINT = "/api/v1/me/delete-account";

export function homeCloseEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/close`;
}

export function homeRestoreEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/restore`;
}

export type ActivityErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "reauthentication-required"
  | "rate-limited"
  | "sole-owner"
  | "expired"
  | "failed";

export interface ActivityErrorResponse {
  readonly error: ActivityErrorCode;
  readonly fields?: readonly string[];
}

export type ActivityFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "reauthenticate"
  | "rateLimited"
  | "soleOwner"
  | "expired"
  | "network"
  | "failed";

export class ActivityActionError extends Error {
  constructor(readonly failure: ActivityFailure) {
    super(`Activity action failed: ${failure}`);
    this.name = "ActivityActionError";
  }
}

async function errorOf(response: Response): Promise<ActivityFailure> {
  if (response.status === 401) return "signedOut";
  if (response.status === 400) return "invalid";
  if (response.status === 404) return "notFound";
  if (response.status === 429) return "rateLimited";
  if (response.status === 409) return "soleOwner";
  if (response.status === 410) return "expired";
  if (response.status === 403) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    return body.error === "reauthentication-required" ? "reauthenticate" : "failed";
  }
  return "failed";
}

async function send(method: "POST" | "PUT", url: string, body: unknown): Promise<Response> {
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
    throw new ActivityActionError("network");
  }
  if (!response.ok) throw new ActivityActionError(await errorOf(response));
  return response;
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

export type SignInResponseResult = "confirmed" | "signed_out" | "reported";

export async function respondToSignIn(
  eventId: string,
  response: "confirmed" | "reported",
): Promise<SignInResponseResult> {
  const body = await jsonOf(
    await send("POST", `${ACTIVITY_ENDPOINT}/${encodeURIComponent(eventId)}/response`, {
      response,
    }),
  );
  return body.result === "signed_out" || body.result === "reported" ? body.result : "confirmed";
}

export async function setSecurityAlerts(input: SecurityAlertsInput): Promise<void> {
  await send("PUT", SECURITY_ALERTS_ENDPOINT, input);
}

export async function requestSecurityReport(input: SecurityReportRequestInput): Promise<string> {
  const body = await jsonOf(await send("POST", SECURITY_REPORTS_ENDPOINT, input));
  if (typeof body.id !== "string") throw new ActivityActionError("failed");
  return body.id;
}

export async function discardSecurityReport(reportId: string): Promise<boolean> {
  const body = await jsonOf(
    await send("POST", `${SECURITY_REPORTS_ENDPOINT}/${encodeURIComponent(reportId)}/discard`, {}),
  );
  return body.discarded === true;
}

export interface DownloadedReport {
  readonly blob: Blob;
  readonly fileName: string;
}

export async function downloadSecurityReport(
  reportId: string,
  format: SecurityReportFormat,
): Promise<DownloadedReport> {
  const response = await send(
    "POST",
    `${SECURITY_REPORTS_ENDPOINT}/${encodeURIComponent(reportId)}/download`,
    { format },
  );
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await response.blob(),
    fileName: match?.[1] ?? `madeora-security-report.${format}`,
  };
}

export async function deactivateAccount(): Promise<void> {
  await send("POST", DEACTIVATE_ENDPOINT, {});
}

/** Returns when the account was deactivated (ISO), to show what changed since. */
export async function reactivateAccount(): Promise<string | null> {
  const body = await jsonOf(await send("POST", REACTIVATE_ENDPOINT, {}));
  return typeof body.since === "string" ? body.since : null;
}

/** S40: asks for the account's deletion; returns the permanent-deletion deadline (ISO). */
export async function requestAccountDeletion(confirmation: string): Promise<string | null> {
  const body = await jsonOf(await send("POST", DELETE_ACCOUNT_ENDPOINT, { confirmation }));
  return typeof body.purgeAfter === "string" ? body.purgeAfter : null;
}

/** S40: closes a Home (its Owner); returns the permanent-deletion deadline (ISO). */
export async function closeHome(homeId: string, name: string): Promise<string | null> {
  const body = await jsonOf(await send("POST", homeCloseEndpoint(homeId), { name }));
  return typeof body.purgeAfter === "string" ? body.purgeAfter : null;
}

/** S40: restores a closed Home before its deadline (its Owner). */
export async function restoreHome(homeId: string): Promise<void> {
  await send("POST", homeRestoreEndpoint(homeId), {});
}

export async function completeSecurityReview(): Promise<void> {
  await send("POST", SECURITY_REVIEW_ENDPOINT, {});
}
