import { createSupabaseServerClient } from "@/auth/supabase-server";
import { removalSchema } from "@/members/manage-schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireMemberAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface RemoveRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Removes another member from the Home (S12; spec "Confirmed Home member-removal authority" and
 * its reaffirmation). The Owner removes Members and Administrators; an Administrator granted
 * removeMembers removes Members only; nobody removes the Owner or themselves. The database checks
 * authority, the target's current role against `expectedRole` and the membership again under the
 * Home lock. Their access ends with this request: every page and API reads membership afresh.
 * A member who is already gone answers 404 (already removed), never a second removal.
 */
export async function POST(request: Request, { params }: RemoveRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, removalSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireMemberAction(homeId, membershipId, "member.remove");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_home_member", {
    p_home_id: allowed.context.home.id,
    p_membership_id: allowed.target.membershipId,
    p_expected_role: input.data.expectedRole,
  });
  if (error) return databaseFailure("members.remove_failed", error.code);
  return data === "removed" ? json(200, {}) : outcomeFailure(data);
}
