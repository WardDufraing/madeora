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
  readonly params: Promise<{ readonly homeId: string; readonly deviceId: string }>;
}

/**
 * Revokes an approved household device (S42): its PIN sessions end at once and it can no longer
 * be used for PIN sign-in. Same managers as approval.
 */
export async function POST(request: Request, { params }: RevokeRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, deviceId } = await params;
  if (!z.uuid().safeParse(deviceId).success) return failure(404, "not-found");
  const allowed = await requireHomeAction(homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("revoke_household_device", {
    p_home_id: allowed.context.home.id,
    p_device_id: deviceId,
  });
  if (error) return databaseFailure("household_devices.revoke_failed", error.code);
  return data === "revoked" || data === "unchanged" ? json(200, {}) : outcomeFailure(data);
}
