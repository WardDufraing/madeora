import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getVerifiedIdentity, type VerifiedIdentity } from "@/auth/identity";

import type { GoogleCalendarErrorCode } from "./api";
import { logGoogleCalendar } from "./data";

// An event's description may be a few thousand characters of multi-byte text, as on the native routes.
const BODY_BYTES = 32 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(status: number, error: GoogleCalendarErrorCode): Response {
  return json(status, { error });
}

/** Same-origin JSON (CSRF), a verified identity, then the body against `schema`. */
export async function readGoogleMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<
  | { readonly ok: true; readonly data: z.output<S>; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, BODY_BYTES);
  if (refused) return { ok: false, response: failure(refused.status, refused.error) };
  const identity = await getVerifiedIdentity();
  if (!identity) return { ok: false, response: failure(401, "unauthenticated") };
  const body = await readJsonBody(request, BODY_BYTES);
  if (!body.ok) return { ok: false, response: failure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return { ok: false, response: failure(400, "invalid") };
  return { ok: true, data: parsed.data, identity };
}

/** A database error: malformed input 400, an ended session 401, anything else 500 (logged by code). */
export function databaseFailure(event: string, error: { readonly code?: string }): Response {
  if (error.code === "22023" || error.code === "22P02") return failure(400, "invalid");
  if (error.code === "42501") return failure(401, "unauthenticated");
  logGoogleCalendar(event, error.code);
  return failure(500, "failed");
}

/**
 * S34: the database outcomes of changing Google events, as HTTP refusals (null: not a refusal). The same
 * `not_found` for an event the person cannot change as for one that does not exist.
 */
export function outcomeFailure(outcome: unknown): Response | null {
  switch (outcome) {
    case "not_found":
      return failure(404, "not-found");
    case "read_only":
      return failure(409, "read-only");
    case "authorization_expired":
      return failure(409, "authorization-expired");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "invalid_dates":
      return failure(400, "invalid-dates");
    case "nonexistent_time":
      return failure(400, "nonexistent-time");
    case "stale":
      return failure(409, "stale");
    case "busy":
      return failure(409, "busy");
    case "conflict_open":
      return failure(409, "conflict-open");
    case "series_limit":
      return failure(409, "series-limit");
    case "invalid_scope":
      return failure(400, "invalid-scope");
    case "pending_changes":
      return failure(409, "pending-changes");
    case "not_in_conflict":
      return failure(409, "not-in-conflict");
    case "in_conflict":
      return failure(409, "in-conflict");
    case "not_failed":
      return failure(409, "not-failed");
    default:
      return null;
  }
}

/** The `outcome` of a JSON answer from the database, or null. */
export function outcomeOf(data: unknown): unknown {
  return typeof data === "object" && data !== null && "outcome" in data ? data.outcome : data;
}
