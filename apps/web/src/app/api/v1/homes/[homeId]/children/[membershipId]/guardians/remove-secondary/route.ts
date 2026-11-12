import { createSupabaseServerClient } from "@/auth/supabase-server";
import { emptyBodySchema } from "@/children/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface RemoveSecondaryRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Ends the secondary guardian's role (S41): the primary guardian removes them, or the secondary
 * steps down. `public.remove_child_secondary_guardian` checks again under the Home lock.
 */
export async function POST(
  request: Request,
  { params }: RemoveSecondaryRouteContext,
): Promise<Response> {
  const input = await readMemberMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireChildAction(homeId, membershipId, "child.guardian.removeSecondary");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_child_secondary_guardian", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
  });
  if (error) return databaseFailure("children.guardian_remove_failed", error.code);
  return data === "removed" ? json(200, {}) : outcomeFailure(data);
}
