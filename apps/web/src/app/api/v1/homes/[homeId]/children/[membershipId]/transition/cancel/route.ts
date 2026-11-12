import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface CancelRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Stops a child's open move to an independent account (S42 part 3). Either guardian of the child
 * in this Home may, so a guardian who disagrees can stop it before it completes.
 */
export async function POST(request: Request, { params }: CancelRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;
  const allowed = await requireChildAction(homeId, membershipId, "child.signIn.assist");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_child_transition", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
  });
  if (error) return databaseFailure("child_transition.cancel_failed", error.code);
  if (data !== "cancelled" && data !== "unchanged") return outcomeFailure(data);
  return json(200, { outcome: data });
}
