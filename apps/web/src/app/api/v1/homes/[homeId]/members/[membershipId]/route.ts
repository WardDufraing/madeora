import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { RoleChangeResponse } from "@/members/manage-api";
import { roleChangeSchema } from "@/members/manage-schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireMemberAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface MemberRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * The Owner makes a Member an Administrator or an Administrator a Member (S12; spec "Confirmed
 * customizable Administrator permissions": assigning and removing Administrators is an Owner-only
 * power). Never Owner: ownership changes only through the transfer. `expectedRole` is the target's
 * role as the Owner saw it; if it changed meanwhile, nothing happens (409 stale).
 */
export async function PATCH(request: Request, { params }: MemberRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, roleChangeSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireMemberAction(homeId, membershipId, "member.changeRole");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_home_member_role", {
    p_home_id: allowed.context.home.id,
    p_membership_id: allowed.target.membershipId,
    p_role: input.data.role,
    p_expected_role: input.data.expectedRole,
  });
  if (error) return databaseFailure("members.role_change_failed", error.code);
  if (data !== "ok" && data !== "unchanged") return outcomeFailure(data);
  const body: RoleChangeResponse = { role: input.data.role };
  return json(200, body);
}
