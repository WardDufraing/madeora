import { readGoalEvents } from "@/goals/data";
import { failure, pathId, readAnswer, readGoalQuery } from "@/goals/route-helpers";
import { pageQuerySchema } from "@/goals/schema";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/** A page of the goal's history (codes and numbers only), newest first. */
export async function GET(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const query = await readGoalQuery(request, pageQuerySchema);
  if (!query.ok) return query.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  return readAnswer(await readGoalEvents(goalId, query.data.before ?? null), "history");
}
