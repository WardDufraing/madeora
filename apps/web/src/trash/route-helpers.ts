import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { TrashErrorCode, TrashErrorResponse } from "./api";

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: TrashErrorCode,
  fields?: readonly string[],
): Response {
  const body: TrashErrorResponse = fields ? { error, fields } : { error };
  return json(status, body);
}

/** Logs by event and short code only: never ids, titles or names. */
export function logTrash(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/**
 * The checks every trash mutation makes, in order: same-origin JSON within the size limit (CSRF), a
 * verified identity, then the body against `schema`.
 */
export async function readTrashMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
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

/**
 * Maps a database error for the whole request: malformed input 400; a scope the person has no part
 * in (`42501` "not permitted" from a Home they do not belong to) the same 404 as one that does not
 * exist; any other `42501` is an unconfirmed or ended session (401). Anything else 500.
 */
export function databaseFailure(
  event: string,
  error: { readonly code?: string; readonly message?: string },
): Response {
  if (error.code === "22023" || error.code === "22P02") return failure(400, "invalid");
  if (error.code === "42501") {
    return error.message === "not permitted"
      ? failure(404, "not-found")
      : failure(401, "unauthenticated");
  }
  logTrash(event, error.code);
  return failure(500, "failed");
}
