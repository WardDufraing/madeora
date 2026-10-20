import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { TaskErrorCode, TaskErrorResponse } from "./api";
import { logTasks } from "./log";

/** Body size limits: a task with its longest description and every label, or a small change. */
export const TASK_BODY_BYTES = 32 * 1024;
export const SMALL_BODY_BYTES = 8 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: TaskErrorCode,
  extra: Omit<TaskErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every task mutation makes, in order: same-origin JSON within the size limit (CSRF), a
 * verified identity, then the body against `schema`.
 */
export async function readTaskMutation<S extends z.ZodType>(
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
  logTasks(event, error.code);
  return failure(500, "failed");
}

/**
 * Maps a database outcome to the HTTP answer. `ok` outcomes answer `okStatus` with `body`; the rest
 * are refusals with their own codes. A count (tasks in the way) or revision travels along.
 */
export function outcomeAnswer(
  event: string,
  outcome: string | undefined,
  body: object,
  details: {
    readonly revision?: number | null | undefined;
    readonly count?: number | null | undefined;
  } = {},
  okStatus = 200,
): Response {
  const revision = details.revision ?? undefined;
  const count = details.count ?? undefined;
  switch (outcome) {
    case "created":
      return json(201, body);
    case "exists":
    case "saved":
    case "deleted":
    case "completed":
    case "reopened":
    case "already_completed":
    case "already_open":
    case "preview":
      return json(okStatus, body);
    case "conflict":
      return failure(409, "conflict", revision === undefined ? {} : { revision });
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "duplicate_name":
      return failure(409, "duplicate-name");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "list_unavailable":
      return failure(409, "list-unavailable");
    case "has_tasks":
      return failure(409, "has-tasks", count === undefined ? {} : { count });
    case "has_open_tasks":
      return failure(409, "has-open-tasks", count === undefined ? {} : { count });
    case "has_series":
      return failure(409, "has-series", count === undefined ? {} : { count });
    case "scope_unavailable":
      return failure(409, "scope-unavailable");
    case "not_recurring":
      return failure(409, "not-recurring");
    case "ended":
      return failure(409, "schedule-ended");
    case "id_taken":
      return failure(409, "id-taken");
    case "invalid_label":
      return failure(400, "invalid", { fields: ["labelIds"] });
    case "invalid_assignee":
      return failure(400, "invalid", { fields: ["assigneeIds"] });
    default:
      logTasks(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}

/** Widens a value to include null, because the generated database types do not. */
export function nullable<T>(value: T): T | null {
  return value;
}
