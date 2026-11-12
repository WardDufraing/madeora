import { getPublicEnv } from "@madeora/config/env/public";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { startTransitionSchema } from "@/child-transition/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 128;

interface TransitionRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Starts a child's move to an independent account (S42 part 3; spec "Confirmed age-aware
 * child-to-independent-account transition"). The birth date is checked against the age the
 * child's Homes require and is not stored. The claim link is returned once, for the guardian to
 * give to the young person; the database keeps only its hash.
 */
export async function POST(
  request: Request,
  { params }: TransitionRouteContext,
): Promise<Response> {
  const input = await readMemberMutation(request, startTransitionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;
  const allowed = await requireChildAction(homeId, membershipId, "child.signIn.manage");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_child_transition", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
    p_birth_date: input.data.birthDate,
  });
  if (error) return databaseFailure("child_transition.start_failed", error.code);
  const row = data[0];
  if (row?.outcome === "not_eligible" && row.eligible_on) {
    return json(200, { outcome: "not_eligible", eligibleOn: row.eligible_on });
  }
  if (row?.outcome !== "started" || !row.token) return outcomeFailure(row?.outcome ?? "");
  const claimUrl = new URL("/claim", getPublicEnv().NEXT_PUBLIC_APP_URL);
  claimUrl.searchParams.set("token", row.token);
  return json(200, {
    outcome: "started",
    claimUrl: claimUrl.toString(),
    expiresAt: row.expires_at,
  });
}
