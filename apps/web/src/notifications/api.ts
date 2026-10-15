import type {
  MarkReadInput,
  PreferenceInput,
  QuietHoursInput,
  ResetPreferenceInput,
  ResetQuietHoursInput,
} from "./schema";

/**
 * The HTTP contract of the notification endpoints (versioned, so later mobile clients can use them
 * too), and the browser's callers. All are cookie-authenticated JSON mutations.
 *
 * - `POST /api/v1/me/notifications/read` `{ ids } | { all: true }` → `200 { updated }`
 * - `PUT  /api/v1/me/notifications/preferences` `{ homeId, category, channel, enabled }` → `200 {}`
 * - `POST /api/v1/me/notifications/preferences/reset` `{ homeId, category, channel }` → `200 {}`
 * - `PUT  /api/v1/me/notifications/quiet-hours` `{ homeId, enabled, start, end, timeZone }` → `200 {}`
 * - `POST /api/v1/me/notifications/quiet-hours/reset` `{ homeId }` → `200 {}`
 *
 * `homeId: null` addresses the account's defaults; an id addresses that Home's override. Errors:
 * `401 unauthenticated`, `400 invalid`, `404 not-found` (a Home the person does not belong to),
 * `403 forbidden`, `413 too-large`, `415 unsupported-media-type`, `500 failed`.
 */
export const NOTIFICATIONS_ENDPOINT = "/api/v1/me/notifications";

export type NotificationErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "failed";

export interface NotificationErrorResponse {
  readonly error: NotificationErrorCode;
  readonly fields?: readonly string[];
}

export type NotificationFailure = "signedOut" | "invalid" | "notFound" | "network" | "failed";

export class NotificationActionError extends Error {
  constructor(readonly failure: NotificationFailure) {
    super(`Notification action failed: ${failure}`);
    this.name = "NotificationActionError";
  }
}

async function send(method: "POST" | "PUT", path: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${NOTIFICATIONS_ENDPOINT}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new NotificationActionError("network");
  }
  if (response.status === 401) throw new NotificationActionError("signedOut");
  if (response.status === 400) throw new NotificationActionError("invalid");
  if (response.status === 404) throw new NotificationActionError("notFound");
  if (!response.ok) throw new NotificationActionError("failed");
  return response.json().catch(() => ({}));
}

/** Marks notifications read; resolves with how many changed. */
export async function markNotificationsRead(input: MarkReadInput): Promise<number> {
  const body = (await send("POST", "/read", input)) as { updated?: unknown };
  return typeof body.updated === "number" ? body.updated : 0;
}

export async function setNotificationPreference(input: PreferenceInput): Promise<void> {
  await send("PUT", "/preferences", input);
}

export async function resetNotificationPreference(input: ResetPreferenceInput): Promise<void> {
  await send("POST", "/preferences/reset", input);
}

export async function setNotificationQuietHours(input: QuietHoursInput): Promise<void> {
  await send("PUT", "/quiet-hours", input);
}

export async function resetNotificationQuietHours(input: ResetQuietHoursInput): Promise<void> {
  await send("POST", "/quiet-hours/reset", input);
}
