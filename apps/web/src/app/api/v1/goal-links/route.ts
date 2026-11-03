import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readGoalLinks } from "@/goals/data";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  goalLinkAnswer,
  json,
  readAnswer,
  readGoalMutation,
  readGoalQuery,
} from "@/goals/route-helpers";
import { createLinkSchema, linksQuerySchema } from "@/goals/schema";
import { goalLinkResultSchema } from "@/goals/shapes";

/**
 * The active habit links of exactly one goal (a period answers its series' links, with the amounts
 * for that period), series (amounts for its current period) or habit, as the person may see them.
 */
export async function GET(request: Request): Promise<Response> {
  const query = await readGoalQuery(request, linksQuerySchema);
  if (!query.ok) return query.response;
  const { goalId, seriesId, habitId } = query.data;
  const read = await readGoalLinks(
    goalId ? { goalId } : seriesId ? { seriesId } : { habitId: habitId ?? "" },
  );
  return read.status === "ok" ? json(200, read.value) : readAnswer(read, "links");
}

/**
 * Links a numeric habit to a measurable goal or series of the same Personal space or Home (managers
 * of both only), counting from today, a chosen past date or the habit's beginning. `preview: true`
 * answers the impact; confirming needs the previewed `revision` and `expectedAmount` and answers
 * `409 stale` with the current ones when either changed. A retry with the same id answers the link.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readGoalMutation(request, createLinkSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_goal_link", {
    p_id: body.id,
    p_habit_id: body.habitId,
    ...(body.goalId === null ? {} : { p_goal_id: body.goalId }),
    ...(body.seriesId === null ? {} : { p_series_id: body.seriesId }),
    p_start: body.start,
    ...(body.startDate === null ? {} : { p_start_date: body.startDate }),
    p_dry_run: body.preview,
    ...(body.revision === null ? {} : { p_expected_revision: body.revision }),
    ...(body.expectedAmount === null ? {} : { p_expected_amount: body.expectedAmount }),
  });
  if (error) return databaseFailure("goals.link_create_failed", error);
  const result = goalLinkResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.link_create_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  return goalLinkAnswer("goals.link_create_failed", result.data);
}
