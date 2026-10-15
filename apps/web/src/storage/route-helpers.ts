import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity, type VerifiedIdentity } from "@/auth/identity";

import type { StorageErrorCode, StorageErrorResponse } from "./api";

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: StorageErrorCode,
  fields?: readonly string[],
): Response {
  const body: StorageErrorResponse = fields ? { error, fields } : { error };
  return json(status, body);
}

/** Logs by event and short code only: never keys, signed links, ids or names. */
export function logStorage(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/**
 * The checks every storage mutation makes, in order: same-origin JSON within the size limit (CSRF),
 * a verified identity, then the body against `schema`.
 */
export async function readStorageMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly data: z.output<S>; readonly identity: VerifiedIdentity }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused) return { ok: false, response: failure(refused.status, refused.error) };
  const identity = await getVerifiedIdentity();
  if (!identity) return { ok: false, response: failure(401, "unauthenticated") };
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: failure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) {
    return { ok: false, response: failure(400, "invalid", refusedFields(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data, identity };
}

/** Maps a database error: malformed input 400, an unconfirmed session 401, anything else 500. */
export function databaseFailure(event: string, code: string | undefined): Response {
  if (code === "22023" || code === "23514" || code === "22P02") return failure(400, "invalid");
  if (code === "42501") return failure(401, "unauthenticated");
  logStorage(event, code);
  return failure(500, "failed");
}
