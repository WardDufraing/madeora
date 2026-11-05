import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getVerifiedIdentity, type VerifiedIdentity } from "@/auth/identity";

import type { GoogleCalendarErrorCode } from "./api";
import { logGoogleCalendar } from "./data";

const BODY_BYTES = 8 * 1024;

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
