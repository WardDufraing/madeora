import "server-only";

import { z } from "zod";

import { isMealDate } from "@madeora/domain/meals";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { MealErrorCode, MealErrorResponse, MealSeriesPreview } from "./api";
import type { Read } from "./data";
import { logMeals } from "./log";

/** Body size limits: an ingredient transfer or week copy at its largest, or a small change. */
export const LARGE_BODY_BYTES = 256 * 1024;
export const SMALL_BODY_BYTES = 8 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: MealErrorCode,
  extra: Omit<MealErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every meal-planner mutation makes, in order: same-origin JSON within the size limit
 * (CSRF), a verified identity, then the body against `schema`.
 */
export async function readMealMutation<S extends z.ZodType>(
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

/** For reads: a verified identity, and the query against `schema`, or the refusal. */
export async function readMealQuery<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  if (!(await getVerifiedIdentity())) {
    return { ok: false, response: failure(401, "unauthenticated") };
  }
  const query = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!query.success) return { ok: false, response: failure(400, "invalid") };
  return { ok: true, data: query.data };
}

/** A server read as an answer: the value under `key`, or its refusal. */
export function readAnswer<T>(read: Read<T>, key: string): Response {
  switch (read.status) {
    case "ok":
      return json(200, { [key]: read.value });
    case "not-found":
      return failure(404, "not-found");
    case "not-permitted":
      return failure(403, "not-permitted");
    case "invalid":
      return failure(400, "invalid");
    default:
      return failure(500, "failed");
  }
}

/** An id from the path, or null (answered as not found, like one that does not exist). */
export function pathId(value: string): string | null {
  const id = z.uuid().safeParse(value);
  return id.success ? id.data : null;
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
  logMeals(event, error.code);
  return failure(500, "failed");
}

/** What travels along with a refusal: the current revision, an occupied slot, collisions, an impact. */
export interface OutcomeExtra {
  readonly revision?: number | null | undefined;
  readonly occupied?: unknown;
  readonly collisions?: unknown;
  readonly impact?: unknown;
}

/**
 * Maps a database outcome to the HTTP answer. Success outcomes answer 200 (`created` 201) with
 * `body`; the rest are refusals with their own codes.
 */
export function outcomeAnswer(
  event: string,
  outcome: string | null | undefined,
  body: object,
  extra: OutcomeExtra = {},
): Response {
  switch (outcome) {
    case "created":
      return json(201, body);
    case "exists":
    case "saved":
    case "deleted":
    case "skipped":
    case "restored":
    case "unchanged":
    case "ok":
    case "done":
      return json(200, body);
    case "conflict":
      return json(409, {
        error: "conflict",
        ...(extra.revision == null ? {} : { revision: extra.revision }),
      });
    case "occupied":
      return json(409, { error: "occupied", occupied: extra.occupied ?? null });
    case "conflicts":
      return json(409, { error: "conflicts", collisions: extra.collisions ?? [] });
    case "impact_required":
      return json(409, { error: "impact-required", impact: extra.impact ?? null });
    case "stale":
      return failure(409, "stale");
    case "slot_unavailable":
      return failure(409, "slot-unavailable");
    case "recipe_unavailable":
      return failure(409, "recipe-unavailable");
    case "invalid_date":
      return failure(409, "invalid-date");
    case "name_taken":
      return failure(409, "name-taken");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "id_taken":
      return failure(409, "id-taken");
    case "list_unavailable":
      return failure(409, "list-unavailable");
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    default:
      logMeals(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}

/** A meal's content as database arguments; an omitted argument is null (none, or kept). */
export function contentArgs(body: {
  readonly recipeId: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly servings: number | null;
}): { p_recipe_id?: string; p_title?: string; p_notes?: string; p_servings?: number } {
  return {
    ...(body.recipeId === null ? {} : { p_recipe_id: body.recipeId }),
    ...(body.title === null ? {} : { p_title: body.title }),
    ...(body.notes === null ? {} : { p_notes: body.notes }),
    ...(body.servings === null ? {} : { p_servings: body.servings }),
  };
}

/** A date from the path, or null (answered as not found). */
export function pathDate(value: string): string | null {
  return isMealDate(value) ? value : null;
}

/** A series preview as an answer: `200 { preview }`, or its refusal. */
export function seriesPreviewAnswer(
  read: Read<{ readonly outcome: string; readonly preview: MealSeriesPreview | null }>,
): Response {
  if (read.status !== "ok") return readAnswer(read, "preview");
  return read.value.preview
    ? json(200, { preview: read.value.preview })
    : outcomeAnswer("meals.series_preview_failed", read.value.outcome, {});
}
