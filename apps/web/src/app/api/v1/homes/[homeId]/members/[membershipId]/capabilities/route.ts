import { delegableCapabilities } from "@madeora/domain/permissions";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { CapabilitiesResponse } from "@/members/manage-api";
import { capabilitiesSchema } from "@/members/manage-schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireMemberAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 512;

interface CapabilitiesRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * The Owner replaces an Administrator's capabilities with exactly the list sent (S12; spec
 * "Confirmed customizable Administrator permissions"). An empty list revokes them all. Owner only,
 * never delegable; a target who is no longer an Administrator answers 409 stale.
 */
export async function PUT(
  request: Request,
  { params }: CapabilitiesRouteContext,
): Promise<Response> {
  const input = await readMemberMutation(request, capabilitiesSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireMemberAction(homeId, membershipId, "member.editCapabilities");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_administrator_capabilities", {
    p_home_id: allowed.context.home.id,
    p_membership_id: allowed.target.membershipId,
    p_capabilities: [...input.data.capabilities],
  });
  if (error) return databaseFailure("members.capabilities_change_failed", error.code);
  if (data !== "ok" && data !== "unchanged") return outcomeFailure(data);
  // In the engine's order, so the answer does not depend on the order sent.
  const body: CapabilitiesResponse = {
    capabilities: delegableCapabilities.filter((capability) =>
      input.data.capabilities.includes(capability),
    ),
  };
  return json(200, body);
}
