import "server-only";

import { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { ShoppingErrorCode, ShoppingErrorResponse } from "./api";
import { logShopping } from "./log";

/** Body size limits: a multi-item entry at its largest (100 full rows), or a small change. */
export const ADD_BODY_BYTES = 256 * 1024;
export const SMALL_BODY_BYTES = 4 * 1024;
/** A clear of every item a list may hold (500 ids). */
export const CLEAR_BODY_BYTES = 32 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: ShoppingErrorCode,
  extra: Omit<ShoppingErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every shopping mutation makes, in order: same-origin JSON within the size limit
 * (CSRF), a verified identity, then the body against `schema`.
 */
export async function readShoppingMutation<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number = SMALL_BODY_BYTES,
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
    return {
      ok: false,
      response: failure(400, "invalid", { fields: refusedFields(parsed.error.issues) }),
    };
  }
  return { ok: true, data: parsed.data };
}

/** For reads: a verified identity, or the 401 answer. */
export async function requireReader(): Promise<Response | null> {
  return (await getVerifiedIdentity()) ? null : failure(401, "unauthenticated");
}

/** An id from the path, or null (answered as not found, like one that does not exist). */
export function pathId(value: string): string | null {
  const id = z.uuid().safeParse(value);
  return id.success ? id.data : null;
}

/**
 * Maps a database error: malformed input 400; "not permitted" (a Home the person does not belong
 * to, or no such Home) 404, like one that does not exist; any other 42501 is an unconfirmed or
 * ended session (401); a broken check or a restore that is in the way 400/409. Anything else 500.
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
  logShopping(event, error.code);
  return failure(500, "failed");
}

/**
 * Maps a database outcome to the HTTP answer. Success outcomes answer 200 (`created` 201) with
 * `body`; the rest are refusals with their own codes, the current revision travelling along.
 */
export function outcomeAnswer(
  event: string,
  outcome: string | null | undefined,
  body: object,
  revision?: number | null,
): Response {
  switch (outcome) {
    case "created":
      return json(201, body);
    case "exists":
    case "saved":
    case "deleted":
    case "cleared":
    case "completed":
    case "reopened":
    case "unchanged":
    case "moved":
    case "copied":
      return json(200, body);
    case "conflict":
      return failure(409, "conflict", revision == null ? {} : { revision });
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "id_taken":
      return failure(409, "id-taken");
    case "duplicate":
      return failure(409, "duplicate");
    case "duplicate_name":
      return failure(409, "duplicate-name");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "same_list":
      return failure(409, "same-list");
    case "destination_unavailable":
      return failure(409, "destination-unavailable");
    case "invalid_category":
    case "invalid_item":
      return failure(409, "invalid-category");
    case "already_repeating":
      return failure(409, "already-repeating");
    default:
      logShopping(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}
