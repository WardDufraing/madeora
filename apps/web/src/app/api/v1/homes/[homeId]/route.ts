import { decideHomeAction } from "@madeora/domain/permissions";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { HomeSettingsResponse, HomesErrorCode, HomesErrorResponse } from "@/homes/api";
import { homeSettingsPatchSchema } from "@/homes/schema";
import { getHomeContext } from "@/homes/server";

const MAX_BODY_BYTES = 2048;

function json(status: number, body: HomeSettingsResponse | HomesErrorResponse): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(status: number, error: HomesErrorCode, fields?: string[]): Response {
  return json(status, fields ? { error, fields } : { error });
}

// Typed here rather than with Next's generated RouteContext, which only exists after `next typegen`.
interface HomeRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Changes a Home's name or scheduling timezone (S09).
 *
 * Request checks as for every `/api/v1` mutation; then the person's current membership of exactly
 * this Home is read from the database (never from the request or a cookie) and the permission
 * engine decides. The write uses the person's own session, so RLS makes the same decision again.
 * A Home the person does not belong to answers 404, exactly as one that does not exist.
 */
export async function PATCH(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return failure(refused.status, refused.error);

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.status, body.error);
  const parsed = homeSettingsPatchSchema.safeParse(body.body);
  if (!parsed.success) return failure(400, "invalid", refusedFields(parsed.error.issues));

  const { homeId } = await params;
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return failure(500, "failed");
  if (found.status === "not-found") return failure(404, "not-found");
  const { home, membership } = found.context;
  if (!decideHomeAction(home.id, membership, "home.updateSettings").allowed) {
    return failure(403, "not-permitted");
  }

  const changes: { name?: string; timezone?: string } = {};
  if (parsed.data.name !== undefined) changes.name = parsed.data.name;
  if (parsed.data.timeZone !== undefined) changes.timezone = parsed.data.timeZone;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("homes")
    .update(changes)
    .eq("id", home.id)
    .select("id, name, timezone")
    .maybeSingle();
  if (error?.code === "23514") return failure(400, "invalid");
  if (error) {
    console.error(JSON.stringify({ event: "homes.update_failed", code: error.code }));
    return failure(500, "failed");
  }
  // RLS refused the row: the role changed since the check above. Same answer as the engine's.
  if (!data) return failure(403, "not-permitted");
  return json(200, { home: { id: data.id, name: data.name, timeZone: data.timezone } });
}
