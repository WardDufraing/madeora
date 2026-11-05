import "server-only";

import { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { CalendarErrorCode, CalendarErrorResponse } from "./api";
import type { Read } from "./data";
import { logCalendar } from "./log";

/** Body size limit: an event with a long description stays well under it. */
export const BODY_BYTES = 32 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: CalendarErrorCode,
  extra: Omit<CalendarErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every calendar mutation makes, in order: same-origin JSON within the size limit (CSRF), a
 * verified identity, then the body against `schema`.
 */
export async function readCalendarMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, BODY_BYTES);
  if (refused) return { ok: false, response: failure(refused.status, refused.error) };
  if (!(await getVerifiedIdentity())) {
    return { ok: false, response: failure(401, "unauthenticated") };
  }
  const body = await readJsonBody(request, BODY_BYTES);
  if (!body.ok) return { ok: false, response: failure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) {
    return {
      ok: false,
      response: failure(400, "invalid", { fields: refusedFields(parsed.error.issues) }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** For reads: a verified identity, or the refusal. */
export async function requireReader(): Promise<Response | null> {
  return (await getVerifiedIdentity()) ? null : failure(401, "unauthenticated");
}

/** A server read as an answer: the value under `key`, or its refusal. */
export function readAnswer<T>(read: Read<T>, key: string): Response {
  switch (read.status) {
    case "ok":
      return json(200, { [key]: read.value });
    case "not-found":
      return failure(404, "not-found");
    case "invalid":
      return failure(400, "invalid");
    default:
      return failure(500, "failed");
  }
}

/** An id from the path, or null (answered as not found, like one that does not exist). */
export function pathId(value: string): string | null {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Maps a database error: malformed input 400; "not permitted" (a Home the person does not belong
 * to, or no such Home) 404, like one that does not exist; any other 42501 is an unconfirmed or
 * ended session (401). Anything else 500.
 */
export function databaseFailure(
  event: string,
  error: { readonly code?: string; readonly message?: string },
): Response {
  if (error.code === "22023" || error.code === "22P02" || error.code === "23514") {
    return failure(400, "invalid");
  }
  if (error.code === "42501") {
    return error.message === "not permitted"
      ? failure(404, "not-found")
      : failure(401, "unauthenticated");
  }
  logCalendar(event, error.code);
  return failure(500, "failed");
}

/** A database answer (`{ outcome, ... }`), checked for its outcome. */
export function resultOf(data: unknown): {
  readonly outcome: string | null;
  readonly body: Record<string, unknown>;
} {
  if (typeof data !== "object" || data === null) return { outcome: null, body: {} };
  const body = data as Record<string, unknown>;
  return { outcome: typeof body.outcome === "string" ? body.outcome : null, body };
}

/**
 * Maps a database outcome to the HTTP answer: `created` 201, the other successes 200 with `body`;
 * `stale` 409 with the current revision; the rest are refusals with their own codes.
 */
export function outcomeAnswer(
  event: string,
  outcome: string | null,
  body: Record<string, unknown>,
): Response {
  switch (outcome) {
    case "created":
      return json(201, body);
    case "exists":
    case "saved":
    case "deleted":
    case "preview":
    case "ok":
    case "unchanged":
      return json(200, body);
    case "stale":
      return json(409, {
        error: "stale",
        ...(typeof body.revision === "number" ? { revision: body.revision } : {}),
      });
    case "invalid_member":
      return failure(400, "invalid-member");
    case "invalid_home":
      return failure(400, "invalid-home");
    case "invalid_dates":
      return failure(400, "invalid-dates");
    case "nonexistent_time":
      return failure(400, "nonexistent-time");
    case "invalid_scope":
      return failure(400, "invalid-scope");
    case "id_taken":
      return failure(409, "id-taken");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    default:
      logCalendar(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}
