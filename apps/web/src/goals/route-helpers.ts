import "server-only";

import { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { GoalErrorCode, GoalErrorResponse } from "./api";
import type { Read } from "./data";
import { logGoals } from "./log";

/** Body size limit: every goal change is small. */
export const BODY_BYTES = 8 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: GoalErrorCode,
  extra: Omit<GoalErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every goal mutation makes, in order: same-origin JSON within the size limit (CSRF), a
 * verified identity, then the body against `schema`.
 */
export async function readGoalMutation<S extends z.ZodType>(
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

/** For reads without a query: a verified identity, or the refusal. */
export async function requireReader(): Promise<Response | null> {
  return (await getVerifiedIdentity()) ? null : failure(401, "unauthenticated");
}

/** For reads: a verified identity, and the query against `schema`, or the refusal. */
export async function readGoalQuery<S extends z.ZodType>(
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
  logGoals(event, error.code);
  return failure(500, "failed");
}

/** Refusals that are a plain 409 with their own code (snake case in SQL, kebab case here). */
const refusals = new Set<string>([
  "id_taken",
  "archived",
  "not_measurable",
  "stale",
  "already_reversed",
  "negative_total",
  "target_not_reached",
  "confirm_unit",
  "confirm_status",
  "no_deadline",
  "period_ended",
  "series_period",
  "invalid_period",
  "stopped",
]);

/** What travels along with an answer: the current revision, an impact, the goal as it is now. */
export interface OutcomeExtra {
  readonly revision?: number | null | undefined;
  readonly impact?: unknown;
  readonly goal?: unknown;
}

function present(extra: OutcomeExtra): object {
  return Object.fromEntries(
    Object.entries(extra).filter(([, value]) => value !== null && value !== undefined),
  );
}

/**
 * Maps a database outcome to the HTTP answer. Success outcomes answer 200 (`created` 201) with
 * `body`; the rest are refusals with their own codes and what explains them. `achieved` is a success
 * (the achievement route); the progress route answers its own refusal of an achieved goal first.
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
    case "unchanged":
    case "deleted":
    case "preview":
    case "added":
    case "adjusted":
    case "corrected":
    case "reversed":
    case "achieved":
    case "reopened":
      return json(200, body);
    case "conflict":
      return json(409, {
        error: "conflict",
        ...(extra.revision == null ? {} : { revision: extra.revision }),
      });
    case "invalid_dates":
      return failure(409, "invalid-dates");
    case "too_many":
      return failure(409, "limit-reached");
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    default:
      if (outcome && refusals.has(outcome)) {
        return json(409, {
          error: outcome.replaceAll("_", "-"),
          ...present({ goal: extra.goal, impact: extra.impact }),
        });
      }
      logGoals(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}
