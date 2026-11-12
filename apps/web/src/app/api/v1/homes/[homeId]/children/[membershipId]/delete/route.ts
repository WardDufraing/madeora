import { createSupabaseServerClient } from "@/auth/supabase-server";
import { emptyBodySchema } from "@/children/schema";
import { getHomeChildren } from "@/children/server";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface DeleteChildRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Deletes a child created by mistake (S41; spec: recovery from mistaken or duplicate creation):
 * the creator or the primary guardian, within the correction window, when this is the child's only
 * Home. `public.delete_mistaken_child` decides again under the Home lock.
 */
export async function POST(
  request: Request,
  { params }: DeleteChildRouteContext,
): Promise<Response> {
  const input = await readMemberMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;
  const allowed = await requireHomeAction(homeId, "home.members.view");
  if (!allowed.ok) return allowed.response;
  const children = await getHomeChildren(allowed.context.home.id);
  if (children.status !== "ok")
    return failure(
      children.status === "not-found" ? 404 : 500,
      children.status === "not-found" ? "not-found" : "failed",
    );
  const child = children.children.find((entry) => entry.membershipId === membershipId);
  if (!child) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_mistaken_child", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: child.membershipId,
  });
  if (error) return databaseFailure("children.delete_failed", error.code);
  return data === "deleted" ? json(200, {}) : outcomeFailure(data);
}
