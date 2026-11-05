/**
 * The HTTP contract of Google Calendar (S33). Every JSON mutation is same-origin, by a signed-in person,
 * about their own connection only; the database checks again with their session. Client-safe.
 *
 * - `POST /api/v1/integrations/google-calendar/connect` (an HTML form, same-origin): `303` to Google's
 *   consent screen; Google returns to `/callback`, which ends on `/settings/google-calendar?google=…`.
 * - `GET /api/v1/integrations/google-calendar` → `200 { connection }` (null when not connected).
 * - `DELETE /api/v1/integrations/google-calendar` `{}` → `{ outcome: "disconnected", revoked }` or
 *   `{ outcome: "not_connected" }`: revokes at Google (best effort) and removes everything.
 * - `POST /api/v1/integrations/google-calendar/sync` `{}` → `{ outcome }`: `queued`, `too_soon` (429),
 *   `not_connected` (404), `authorization_expired` (409).
 * - `PUT /api/v1/integrations/google-calendar/calendars/:id` `{ sync, showPersonal, homes }` →
 *   `{ outcome: "saved" }`; `unavailable` (409), `invalid-home` (400), `too-many` (409).
 * - `GET /api/v1/calendar/google-events/:id?homeId=` → `200 { event }`; one the person may not see
 *   answers `404 not-found`, exactly like a missing one.
 */
export const GOOGLE_CALENDAR_ENDPOINT = "/api/v1/integrations/google-calendar";
export const GOOGLE_CONNECT_ENDPOINT = `${GOOGLE_CALENDAR_ENDPOINT}/connect`;
export const GOOGLE_SYNC_ENDPOINT = `${GOOGLE_CALENDAR_ENDPOINT}/sync`;

export function googleCalendarEndpoint(calendarId: string): string {
  return `${GOOGLE_CALENDAR_ENDPOINT}/calendars/${encodeURIComponent(calendarId)}`;
}

export type GoogleCalendarErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "invalid"
  | "unauthenticated"
  | "not-found"
  | "not-configured"
  | "too-soon"
  | "authorization-expired"
  | "unavailable"
  | "invalid-home"
  | "too-many"
  | "failed";

export interface GoogleCalendarErrorResponse {
  readonly error: GoogleCalendarErrorCode;
}

/** A refused or failed Google Calendar request, by its code (`network` when nothing answered). */
export class GoogleRequestError extends Error {
  constructor(readonly code: GoogleCalendarErrorCode | "network") {
    super(`Google Calendar request failed: ${code}`);
    this.name = "GoogleRequestError";
  }
}

const errorCodes: readonly string[] = [
  "forbidden",
  "unsupported-media-type",
  "too-large",
  "invalid",
  "unauthenticated",
  "not-found",
  "not-configured",
  "too-soon",
  "authorization-expired",
  "unavailable",
  "invalid-home",
  "too-many",
  "failed",
];

/** Sends one request; answers the JSON body or throws a GoogleRequestError. */
export async function sendGoogleRequest(
  method: "POST" | "PUT" | "DELETE",
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new GoogleRequestError("network");
  }
  let answer: unknown = null;
  try {
    answer = await response.json();
  } catch {
    // An empty or broken body is handled below.
  }
  const record =
    typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : {};
  if (response.ok) return record;
  const code =
    typeof record.error === "string" && errorCodes.includes(record.error) ? record.error : "failed";
  throw new GoogleRequestError(code as GoogleCalendarErrorCode);
}
