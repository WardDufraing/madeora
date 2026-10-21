import "server-only";

import { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";

import type { ChoreErrorCode, ChoreErrorResponse } from "./api";
import { logChores } from "./log";

/** Body size limits: a chore with its longest instructions and full checklist, or a small change. */
export const CHORE_BODY_BYTES = 32 * 1024;
export const SMALL_BODY_BYTES = 8 * 1024;

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: ChoreErrorCode,
  extra: Omit<ChoreErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every chore mutation makes, in order: same-origin JSON within the size limit (CSRF), a
 * verified identity, then the body against `schema`.
 */
export async function readChoreMutation<S extends z.ZodType>(
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
  logChores(event, error.code);
  return failure(500, "failed");
}

/**
 * Maps a database outcome to the HTTP answer. Success outcomes answer 200 (`created` 201) with
 * `body`; the rest are refusals with their own codes, a revision or count travelling along.
 */
export function outcomeAnswer(
  event: string,
  outcome: string | undefined,
  body: object,
  details: {
    readonly revision?: number | null | undefined;
    readonly count?: number | null | undefined;
    readonly impact?: ChoreErrorResponse["impact"] | undefined;
  } = {},
): Response {
  const revision = details.revision ?? undefined;
  const count = details.count ?? undefined;
  switch (outcome) {
    case "created":
      return json(201, body);
    case "exists":
    case "saved":
    case "removed":
    case "deleted":
    case "completed":
    case "already_completed":
    case "skipped":
    case "already_skipped":
    case "reopened":
    case "already_open":
    case "preview":
    case "submitted":
    case "already_submitted":
    case "approved":
    case "rejected":
    case "corrected":
    case "unchanged":
    case "claimed":
    case "released":
    case "requested":
    case "accepted":
    case "awaiting_manager":
    case "declined":
    case "cancelled":
    case "refused":
    case "withdrawn":
    case "sent":
    case "added":
      return json(200, body);
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
    case "id_taken":
      return failure(409, "id-taken");
    case "steps_incomplete":
      return failure(409, "steps-incomplete", count === undefined ? {} : { count });
    case "occurrence_closed":
      return failure(409, "occurrence-closed");
    case "needs_confirmation":
      return failure(
        409,
        "needs-confirmation",
        details.impact === undefined ? {} : { impact: details.impact },
      );
    case "scope_unavailable":
      return failure(409, "scope-unavailable");
    case "not_recurring":
      return failure(409, "not-recurring");
    case "pending_approval":
      return failure(409, "pending-approval");
    case "not_pending":
      return failure(409, "not-pending", revision === undefined ? {} : { revision });
    case "contributor_unavailable":
      return failure(409, "contributor-unavailable");
    case "not_completed":
      return failure(409, "not-completed", revision === undefined ? {} : { revision });
    case "ended":
      return failure(409, "schedule-ended");
    case "already_claimed":
      return failure(409, "already-claimed");
    case "assigned":
      return failure(409, "assigned");
    case "not_claimable":
      return failure(409, "not-claimable");
    case "not_eligible":
      return failure(403, "not-eligible");
    case "expired":
      return failure(409, "expired");
    case "not_claimed":
      return failure(409, "not-claimed");
    case "not_assignee":
      return failure(409, "not-assignee");
    case "request_open":
      return failure(409, "request-open");
    case "not_open":
      return failure(409, "not-open");
    case "invalidated":
      return failure(409, "invalidated");
    case "duplicate":
      return failure(409, "duplicate");
    case "not_in_review":
      return failure(409, "not-in-review");
    case "deadline_passed":
      return failure(409, "deadline-passed");
    case "not_volunteered":
      return failure(409, "not-volunteered");
    case "not_invited":
      return failure(404, "not-found");
    case "in_past":
      return failure(409, "in-past");
    case "invalid_date":
      return failure(400, "invalid", { fields: ["dueDate"] });
    case "invalid_recipient":
      return failure(400, "invalid", { fields: ["toMember"] });
    case "invalid_member":
      return failure(400, "invalid", { fields: ["memberIds"] });
    case "invalid_category":
      return failure(400, "invalid", { fields: ["categoryId"] });
    case "invalid_assignee":
      return failure(400, "invalid", { fields: ["assignment"] });
    case "invalid_contributor":
      return failure(400, "invalid", { fields: ["contributor"] });
    default:
      logChores(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}

/** Widens a value to include null, because the generated database types do not. */
export function nullable<T>(value: T): T | null {
  return value;
}

const impactNextSchema = z
  .object({
    next: z.array(
      z
        .object({ date: z.string(), assignees: z.array(z.string().nullable()) })
        .transform((entry) => ({ date: entry.date, assigneeIds: entry.assignees })),
    ),
  })
  .loose();

/**
 * An impact with its next dates in the shape the client reads (`assigneeIds`, as on the chore's
 * page); the database names them `assignees`. Any other impact is passed through unchanged.
 */
export function impactWithNextDates(impact: unknown): unknown {
  const parsed = impactNextSchema.safeParse(impact);
  return parsed.success ? parsed.data : impact;
}
