import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 16;

interface RevokeRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly displayId: string }>;
}

/**
 * Revokes a Household Display at once (S43; lost or replaced tablet): the database deletes its
 * account with every session, so it falls back to the pairing screen on its next check and an
 * offline tablet cannot come back. Same managers as pairing.
 */
export async function POST(request: Request, { params }: RevokeRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, displayId } = await params;
  if (!z.uuid().safeParse(displayId).success) return failure(404, "not-found");
  const allowed = await requireHomeAction(homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("revoke_household_display", {
    p_home_id: allowed.context.home.id,
    p_display_id: displayId,
  });
  if (error) return databaseFailure("household_displays.revoke_failed", error.code);
  return data === "revoked" || data === "unchanged" ? json(200, {}) : outcomeFailure(data);
}
