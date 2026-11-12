import { createSupabaseServerClient } from "@/auth/supabase-server";
import { assignGuardianSchema } from "@/children/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface GuardiansRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Offers a guardian role for the child in this Home (S41; spec "Confirmed guardian roles"): the
 * primary guardian offers the secondary role or hands over the primary role; while the child has
 * no primary guardian, the Owner offers it to another adult (never themselves). The role applies
 * only when the named adult accepts. `public.assign_child_guardian` checks again under the lock.
 */
export async function PUT(request: Request, { params }: GuardiansRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, assignGuardianSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const action =
    input.data.role === "secondary"
      ? "child.guardian.assignSecondary"
      : "child.guardian.handOverPrimary";
  let allowed = await requireChildAction(homeId, membershipId, action);
  if (!allowed.ok && input.data.role === "primary") {
    allowed = await requireChildAction(homeId, membershipId, "child.guardian.appointPrimary");
  }
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("assign_child_guardian", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
    p_guardian_membership_id: input.data.guardianMembershipId,
    p_role: input.data.role,
  });
  if (error) return databaseFailure("children.guardian_failed", error.code);
  return data === "offered" ? json(200, { outcome: "offered" }) : outcomeFailure(data);
}
