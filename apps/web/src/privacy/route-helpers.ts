import "server-only";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { z } from "zod";

import type { PrivacyErrorCode } from "./api";

export const MAX_BODY_BYTES = 2048;

export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store, private" } });
}

export function failure(
  status: number,
  error: PrivacyErrorCode,
  fields?: readonly string[],
): Response {
  return json(status, fields ? { error, fields } : { error });
}

/**
 * The checks every privacy endpoint makes, in order: same-origin JSON within the size limit (CSRF,
 * architecture.md §7), a confirmed identity, then the body against `schema`. The database functions
 * then act with the person's own session and only on their own records.
 */
export async function readPrivacyMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return { ok: false, response: failure(refused.status, refused.error) };
  if (!(await getVerifiedIdentity())) {
    return { ok: false, response: failure(401, "unauthenticated") };
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: failure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) {
    return { ok: false, response: failure(400, "invalid", refusedFields(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Maps a database error: malformed input 400, unknown or someone else's export 404 (expired: 410),
 * a missing fresh re-authentication 403, an export already being prepared 409, too many 429, a lost
 * session 401, anything else 500.
 */
export function databaseFailure(
  event: string,
  error: { readonly code?: string; readonly hint?: string },
): Response {
  if (error.code === "22023" || error.code === "22P02") return failure(400, "invalid");
  if (error.code === "P0002" && error.hint === "export_expired") return failure(410, "expired");
  if (error.code === "P0002") return failure(404, "not-found");
  if (error.code === "54000" && error.hint === "in_progress") return failure(409, "in-progress");
  if (error.code === "54000") return failure(429, "rate-limited");
  if (error.code === "42501" && error.hint === "reauthentication_required") {
    return failure(403, "reauthentication-required");
  }
  if (error.code === "42501" && error.hint === "not_permitted")
    return failure(403, "not-permitted");
  // A Home the person is not in answers like one that does not exist.
  if (error.code === "42501" && error.hint === "homes") return failure(404, "not-found");
  if (error.code === "42501") return failure(401, "unauthenticated");
  // Privacy-safe: the error code only, no ids, no values.
  console.error(JSON.stringify({ event, code: error.code ?? null }));
  return failure(500, "failed");
}
