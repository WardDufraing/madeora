import { readGoalLinkCandidates } from "@/goals/data";
import { json, readAnswer, readGoalQuery } from "@/goals/route-helpers";
import { linkCandidatesQuerySchema } from "@/goals/schema";

/**
 * The habits the person could link to a goal or series: numeric habits of the same context they
 * manage, with a compatible unit, not linked to it yet (none when they may not manage it).
 */
export async function GET(request: Request): Promise<Response> {
  const query = await readGoalQuery(request, linkCandidatesQuerySchema);
  if (!query.ok) return query.response;
  const { goalId, seriesId } = query.data;
  const read = await readGoalLinkCandidates(goalId ? { goalId } : { seriesId: seriesId ?? "" });
  return read.status === "ok" ? json(200, read.value) : readAnswer(read, "habits");
}
