import { createSupabaseServerClient } from "@/auth/supabase-server";
import { emptyBodySchema } from "@/children/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface RemoveChildRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Removes a child from this Home (S41): the Owner or the child's primary guardian here. The child
 * identity and its other Homes stay; a child's only Home answers `409 child-last-home`.
 * `public.remove_home_member` decides again under the Home lock.
 */
export async function POST(
  request: Request,
  { params }: RemoveChildRouteContext,
): Promise<Response> {
  const input = await readMemberMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireChildAction(homeId, membershipId, "child.remove");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_home_member", {
    p_home_id: allowed.context.home.id,
    p_membership_id: allowed.child.membershipId,
    p_expected_role: "member",
  });
  if (error) return databaseFailure("children.remove_failed", error.code);
  return data === "removed" ? json(200, {}) : outcomeFailure(data);
}
