import "server-only";

import { decideHomeAction, type HomeAction } from "@madeora/domain/permissions";
import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { getHomeContext, type HomeContext } from "@/homes/server";

import type { InvitationErrorCode, InvitationErrorResponse } from "./api";

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: InvitationErrorCode,
  fields?: readonly string[],
): Response {
  const body: InvitationErrorResponse = fields ? { error, fields } : { error };
  return json(status, body);
}

/** Logs a database failure by its code only (no ids, names, addresses or secrets). */
export function logFailure(event: string, code: string | undefined): void {
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/**
 * The request checks every invitation endpoint makes, in order: same-origin JSON within the size
 * limit (CSRF), a confirmed identity, then the body against `schema`. Returns the parsed body or
 * the answer to send.
 */
export async function readMutation<S extends z.ZodType>(
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
 * The person's current membership of `homeId`, read from the database (never from the request),
 * and the permission engine's answer for `action`. A Home they do not belong to is 404 whether or
 * not it exists; one they belong to without the right is 403. The database functions decide again.
 */
export async function requireHomeAction(
  homeId: string,
  action: HomeAction,
): Promise<
  | { readonly ok: true; readonly context: HomeContext }
  | { readonly ok: false; readonly response: Response }
> {
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (found.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const { home, membership } = found.context;
  if (!decideHomeAction(home.id, membership, action).allowed) {
    return { ok: false, response: failure(403, "not-permitted") };
  }
  return { ok: true, context: found.context };
}

/** Answers for the outcomes the database functions share. */
export function outcomeFailure(outcome: string): Response {
  switch (outcome) {
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "not_active":
    case "not_email":
      return failure(409, "not-active");
    case "has_request":
      return failure(409, "has-request");
    case "rate_limited":
      return failure(429, "rate-limited");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "duplicate_email":
      return failure(409, "duplicate-email");
    case "already_decided":
      return failure(409, "already-decided");
    case "no_longer_valid":
      return failure(409, "no-longer-valid");
    case "already_member":
      return failure(409, "already-member");
    case "not_pending":
      return failure(409, "not-pending");
    default:
      return failure(500, "failed");
  }
}

/** Maps a database error: malformed input 400, an unconfirmed session 401, anything else 500. */
export function databaseFailure(event: string, code: string | undefined): Response {
  if (code === "22023" || code === "23514" || code === "22P02") return failure(400, "invalid");
  if (code === "42501") return failure(401, "unauthenticated");
  logFailure(event, code);
  return failure(500, "failed");
}
