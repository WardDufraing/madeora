import { decideHomeAction } from "@madeora/domain/permissions";

import { checkJsonMutation, readJsonBody, refusedFields } from "@/api/json-request";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { HomesErrorCode } from "@/homes/api";
import { getHomeContext } from "@/homes/server";
import {
  HOME_PROFILE_COLUMNS,
  homeProfileFromRow,
  homeProfilePatchToColumns,
} from "@/members/profile";
import type { HomeProfileErrorResponse, HomeProfileResponse } from "@/members/profile-api";
import { homeProfilePatchSchema } from "@/members/profile-schema";

// Two names of at most 50 characters and a colour; anything far larger is not a profile change.
const MAX_BODY_BYTES = 2048;

function json(status: number, body: HomeProfileResponse | HomeProfileErrorResponse): Response {
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
 * Changes the signed-in person's own nickname, Home display name or accent in one Home (S11).
 *
 * Request checks as for every `/api/v1` mutation; then the person's current membership of exactly
 * this Home is read from the database and the permission engine decides. The row written is
 * always the caller's own (the user id comes from the verified session, never the request), with
 * their own session, so RLS refuses anything else too. There is no way to name another member:
 * nobody, whatever their role, edits another adult's presentation. A Home the person does not
 * belong to answers 404, exactly as one that does not exist.
 */
export async function PATCH(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const refused = checkJsonMutation(request, MAX_BODY_BYTES);
  if (refused) return failure(refused.status, refused.error);

  const identity = await getVerifiedIdentity();
  if (!identity) return failure(401, "unauthenticated");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return failure(body.status, body.error);
  const parsed = homeProfilePatchSchema.safeParse(body.body);
  if (!parsed.success) return failure(400, "invalid", refusedFields(parsed.error.issues));

  const { homeId } = await params;
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return failure(500, "failed");
  if (found.status === "not-found") return failure(404, "not-found");
  const { home, membership } = found.context;
  if (!decideHomeAction(home.id, membership, "home.profile.editOwn").allowed) {
    return failure(404, "not-found");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("home_member_profiles")
    .upsert(
      { home_id: home.id, user_id: identity.userId, ...homeProfilePatchToColumns(parsed.data) },
      { onConflict: "home_id,user_id" },
    )
    .select(HOME_PROFILE_COLUMNS)
    .single();
  // A check constraint refused a value the schema let through: the request was invalid.
  if (error?.code === "23514") return failure(400, "invalid");
  // The membership ended between the check above and the write (RLS or the membership key).
  if (error?.code === "42501" || error?.code === "23503") return failure(404, "not-found");
  if (error) {
    // Privacy-safe: the error code only, no account or Home ids, no names.
    console.error(JSON.stringify({ event: "home_profile.write_failed", code: error.code }));
    return failure(500, "failed");
  }
  return json(200, { profile: homeProfileFromRow(data) });
}
