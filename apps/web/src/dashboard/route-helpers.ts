import "server-only";

import { randomUUID } from "node:crypto";

import type { Json } from "@madeora/database";
import type { z } from "zod";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import type { DashboardErrorCode, DashboardErrorResponse } from "./api";
import type { DashboardLayout } from "./layout";
import type { DashboardTarget } from "./schema";
import { logDashboard } from "./server";

/** A JSON answer that no cache may keep. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function failure(
  status: number,
  error: DashboardErrorCode,
  extra: Omit<DashboardErrorResponse, "error"> = {},
): Response {
  return json(status, { error, ...extra });
}

/**
 * The checks every dashboard mutation makes, in order: same-origin JSON within the size limit
 * (CSRF), a verified identity, then the body against `schema`.
 */
export async function readDashboardMutation<S extends z.ZodType>(
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
    return {
      ok: false,
      response: failure(400, "invalid", { fields: refusedFields(parsed.error.issues) }),
    };
  }
  return { ok: true, data: parsed.data };
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
  if (error.code === "22023" || error.code === "22P02") return failure(400, "invalid");
  if (error.code === "42501") {
    return error.message === "not permitted"
      ? failure(404, "not-found")
      : failure(401, "unauthenticated");
  }
  logDashboard(event, error.code);
  return failure(500, "failed");
}

/** Body size limit of a save: a layout is at most 64 KB as stored, plus the envelope. */
export const SAVE_BODY_BYTES = 72 * 1024;
export const SMALL_BODY_BYTES = 2 * 1024;

export function newWidgetId(): string {
  return randomUUID();
}

/** A plain JSON copy of a value: what a jsonb argument accepts. Anything else is left out. */
function jsonValue(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    const result: { [key: string]: Json } = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[key] = jsonValue(entry);
    }
    return result;
  }
  return null;
}

/** A layout as a jsonb argument. */
export function layoutJson(layout: DashboardLayout): Json {
  return jsonValue(layout);
}

/**
 * Saves `layout` as `target`'s dashboard if nobody saved it since `expectedRevision`, keeping
 * `previous` for one Undo when given. The database re-checks membership and editing rights.
 */
export async function persistLayout(
  event: string,
  target: DashboardTarget,
  layout: DashboardLayout,
  expectedRevision: number,
  previous: DashboardLayout | null,
  extra: { readonly dropped?: number } = {},
): Promise<Response> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_dashboard", {
    p_layout: layoutJson(layout),
    p_expected_revision: expectedRevision,
    ...(target.kind === "home" ? { p_home_id: target.homeId } : {}),
    ...(previous ? { p_previous: layoutJson(previous) } : {}),
  });
  if (error) return databaseFailure(event, error);
  return revisionAnswer(event, data[0], extra);
}

export function revisionAnswer(
  event: string,
  row: { readonly outcome: string; readonly revision: number } | undefined,
  extra: { readonly dropped?: number } = {},
): Response {
  switch (row?.outcome) {
    case "saved":
      return json(200, { revision: row.revision, ...extra });
    case "conflict":
      return failure(409, "conflict", { revision: row.revision });
    case "not_permitted":
      return failure(403, "not-permitted");
    case "nothing_to_undo":
      return failure(409, "nothing-to-undo");
    default:
      logDashboard(event, "unexpected_outcome");
      return failure(500, "failed");
  }
}
