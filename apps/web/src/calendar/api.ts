export type {
  CalendarAccessList,
  CalendarList,
  EventDetail,
  Occurrence,
  Preview,
  Upcoming,
  VacationBanner,
} from "./shapes";

/**
 * The HTTP contract of the calendar (S32). Every mutation is same-origin JSON, checked again by the
 * database with the person's own session. Ids of new events come from the client, so a retry answers
 * the same event instead of a second one. Revision-checked changes answer `409 stale` with the
 * current revision.
 *
 * - `GET /api/v1/calendar?homeId=&from=&to=` → `200 { calendar }`: occurrences over local dates
 *   (at most 62), with Home vacations when the person shows them.
 * - `POST /api/v1/calendar/events` `{ id, homeId, event }` creates (homeId null: personal).
 * - `GET /api/v1/calendar/events/:id?homeId=&on=` → `{ event }`.
 * - `PATCH /api/v1/calendar/events/:id` `{ revision, scope, on, event, dryRun?, newId? }` changes
 *   it (`only`, `following`, `all`); `dryRun` answers a preview of what is affected.
 * - `DELETE /api/v1/calendar/events/:id` `{ revision, scope, on, dryRun? }`: cancels occurrences or
 *   moves the event to the trash.
 * - `PUT /api/v1/calendar/events/:id/shares` `{ revision, homeIds }` (personal events, owner only).
 * - `GET|PUT /api/v1/homes/:homeId/calendar-access` (levels; set one member's).
 * - `PUT /api/v1/calendar/preferences` `{ homeId, showVacations?, showTasks?, showChores? }`: the
 *   person's own view settings for the Personal calendar or a Home's.
 *
 * An event the person may not see answers `404 not-found` everywhere, exactly like a missing one.
 */
export const CALENDAR_ENDPOINT = "/api/v1/calendar";

export const EVENTS_ENDPOINT = "/api/v1/calendar/events";

export function eventEndpoint(eventId: string, part?: "shares"): string {
  const base = `${EVENTS_ENDPOINT}/${encodeURIComponent(eventId)}`;
  return part ? `${base}/${part}` : base;
}

export function calendarAccessEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/calendar-access`;
}

export const CALENDAR_PREFERENCES_ENDPOINT = "/api/v1/calendar/preferences";

export type CalendarErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "stale"
  | "id-taken"
  | "limit-reached"
  | "invalid-member"
  | "invalid-home"
  | "invalid-dates"
  | "nonexistent-time"
  | "invalid-scope"
  | "failed";

export interface CalendarErrorResponse {
  readonly error: CalendarErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
}

/** What a refused or failed request means to the person. */
export type CalendarFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "stale"
  | "idTaken"
  | "limitReached"
  | "invalidMember"
  | "invalidHome"
  | "invalidDates"
  | "nonexistentTime"
  | "invalidScope"
  | "network"
  | "failed";

const failures: { readonly [C in CalendarErrorCode]?: CalendarFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  stale: "stale",
  "id-taken": "idTaken",
  "limit-reached": "limitReached",
  "invalid-member": "invalidMember",
  "invalid-home": "invalidHome",
  "invalid-dates": "invalidDates",
  "nonexistent-time": "nonexistentTime",
  "invalid-scope": "invalidScope",
};

export class CalendarRequestError extends Error {
  constructor(
    readonly failure: CalendarFailure,
    readonly fields: readonly string[] = [],
  ) {
    super(`Calendar request failed: ${failure}`);
    this.name = "CalendarRequestError";
  }
}

/** Sends one calendar request; answers the JSON body or throws a CalendarRequestError. */
export async function sendCalendarRequest<T = Record<string, unknown>>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new CalendarRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? (record.error as CalendarErrorCode) : "failed";
    const fields = Array.isArray(record.fields)
      ? record.fields.filter((field): field is string => typeof field === "string")
      : [];
    throw new CalendarRequestError(failures[code] ?? "failed", fields);
  }
  return payload as T;
}
