import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  goalLinkAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { removeLinkSchema } from "@/goals/schema";
import { goalLinkResultSchema } from "@/goals/shapes";

interface LinkRouteContext {
  readonly params: Promise<{ readonly linkId: string }>;
}

/**
 * Removes a link: `keep` turns what it counted in each goal into a manual adjustment (no total
 * changes), `remove` takes it out (ended periods recompute their outcome). Preview and confirmation
 * with the link's revision and the previewed amount.
 */
export async function POST(request: Request, { params }: LinkRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, removeLinkSchema);
  if (!input.ok) return input.response;
  const linkId = pathId((await params).linkId);
  if (!linkId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_goal_link", {
    p_id: linkId,
    p_mode: body.mode,
    p_dry_run: body.preview,
    ...(body.revision === null ? {} : { p_expected_revision: body.revision }),
    ...(body.expectedAmount === null ? {} : { p_expected_amount: body.expectedAmount }),
  });
  if (error) return databaseFailure("goals.link_remove_failed", error);
  const result = goalLinkResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.link_remove_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  return goalLinkAnswer("goals.link_remove_failed", result.data);
}
