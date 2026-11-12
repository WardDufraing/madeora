import { createSupabaseServerClient } from "@/auth/supabase-server";
import { linkCodeActionSchema } from "@/children/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface LinkCodeRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Issues or withdraws the one-time code that links this child to another Home (S41; spec
 * "Confirmed one child identity across multiple Homes"): only the child's primary guardian here.
 * The code is returned once and stored only as a hash (`public.create_child_link_code`).
 */
export async function POST(request: Request, { params }: LinkCodeRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, linkCodeActionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;
  const allowed = await requireChildAction(homeId, membershipId, "child.link.issue");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  if (input.data.action === "cancel") {
    const { data, error } = await supabase.rpc("cancel_child_link_code", {
      p_home_id: allowed.context.home.id,
      p_child_membership_id: allowed.child.membershipId,
    });
    if (error) return databaseFailure("children.link_cancel_failed", error.code);
    return data === "cancelled" ? json(200, {}) : outcomeFailure(data);
  }
  const { data, error } = await supabase.rpc("create_child_link_code", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
  });
  if (error) return databaseFailure("children.link_issue_failed", error.code);
  const row = data[0];
  if (row?.outcome === "issued") {
    return json(200, { code: row.code, expiresAt: row.expires_at });
  }
  return outcomeFailure(row?.outcome ?? "failed");
}
