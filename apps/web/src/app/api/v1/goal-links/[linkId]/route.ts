import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  goalLinkAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { changeLinkStartSchema } from "@/goals/schema";
import { goalLinkResultSchema } from "@/goals/shapes";

interface LinkRouteContext {
  readonly params: Promise<{ readonly linkId: string }>;
}

/**
 * Changes a link's first counted day (managers of both sides): days before it leave the goal, days
 * from it count. Preview and confirmation as when creating it, with the link's revision.
 */
export async function PATCH(request: Request, { params }: LinkRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, changeLinkStartSchema);
  if (!input.ok) return input.response;
  const linkId = pathId((await params).linkId);
  if (!linkId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_goal_link_start", {
    p_id: linkId,
    p_start: body.start,
    ...(body.startDate === null ? {} : { p_start_date: body.startDate }),
    p_dry_run: body.preview,
    ...(body.revision === null ? {} : { p_expected_revision: body.revision }),
    ...(body.expectedAmount === null ? {} : { p_expected_amount: body.expectedAmount }),
  });
  if (error) return databaseFailure("goals.link_start_failed", error);
  const result = goalLinkResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.link_start_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  return goalLinkAnswer("goals.link_start_failed", result.data);
}
