import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { NotificationErrorCode, NotificationErrorResponse } from "./api";

// A setting is a few hundred bytes; marking 100 notifications read sends 100 ids.
export const MAX_BODY_BYTES = 2048;
export const MAX_READ_BODY_BYTES = 8192;

export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: NotificationErrorCode,
  fields?: readonly string[],
): Response {
  const body: NotificationErrorResponse = fields ? { error, fields } : { error };
  return json(status, body);
}

/**
 * The checks every notification endpoint makes, in order: same-origin JSON within the size limit
 * (CSRF, architecture.md §7), a confirmed identity, then the body against `schema`. The database
 * function then acts with the person's own session and only on their own rows.
 */
export async function readNotificationMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused) return { ok: false, response: failure(refused.status, refused.error) };
  if (!(await getVerifiedIdentity())) {
    return { ok: false, response: failure(401, "unauthenticated") };
  }
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: failure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) {
    return { ok: false, response: failure(400, "invalid", refusedFields(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

/** Maps a database error: malformed input 400, a lost session 401, anything else 500. */
export function databaseFailure(event: string, error: { readonly code?: string }): Response {
  if (error.code === "22023" || error.code === "22P02") return failure(400, "invalid");
  if (error.code === "42501") return failure(401, "unauthenticated");
  // Privacy-safe: the error code only, no ids, no values.
  console.error(JSON.stringify({ event, code: error.code ?? null }));
  return failure(500, "failed");
}
