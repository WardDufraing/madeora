import "server-only";

import { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { RecipeErrorCode, RecipeErrorResponse } from "./api";
import { logRecipes } from "./log";

/** Body size limits: a recipe at its largest (100 steps of 2,000 characters), or a small change. */
export const RECIPE_BODY_BYTES = 1024 * 1024;
export const SMALL_BODY_BYTES = 2 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: RecipeErrorCode,
  extra: Omit<RecipeErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every recipe mutation makes, in order: same-origin JSON within the size limit (CSRF),
 * a verified identity, then the body against `schema`.
 */
export async function readRecipeMutation<S extends z.ZodType>(
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
 * ended session (401); a broken check constraint 400. Anything else 500.
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
  logRecipes(event, error.code);
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
    case "cleared":
    case "deleted":
    case "published":
    case "already_published":
    case "acquired":
    case "renewed":
    case "ok":
    case "shared":
    case "updated":
    case "unchanged":
    case "unshared":
    case "not_shared":
      return json(200, body);
    case "conflict":
      return failure(409, "conflict", revision == null ? {} : { revision });
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "id_taken":
      return failure(409, "id-taken");
    case "incomplete":
      return failure(409, "incomplete");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "invalid_cover":
      return failure(409, "invalid-cover");
    case "storage_full":
      return failure(409, "storage-full");
    case "lock_lost":
      return failure(409, "lock-lost");
    case "locked":
      return failure(409, "locked");
    case "destination_unavailable":
      return failure(409, "destination-unavailable");
    case "impact_review_required":
      return failure(409, "impact-review-required");
    case "stale_impact":
      return failure(409, "stale-impact");
    case "rate_limited":
      return failure(429, "rate-limited");
    default:
      logRecipes(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}

/** Widens a value to include null, because the generated database types do not. */
export function nullable<T>(value: T): T | null {
  return value;
}

/** A rating average as a number (Postgres numeric may arrive as text), or null. */
export function ratingAverage(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}
