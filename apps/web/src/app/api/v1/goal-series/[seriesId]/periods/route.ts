import { readGoalSeriesPeriods } from "@/goals/data";
import { failure, pathId, readAnswer, readGoalQuery } from "@/goals/route-helpers";
import { pageQuerySchema } from "@/goals/schema";

interface SeriesRouteContext {
  readonly params: Promise<{ readonly seriesId: string }>;
}

/** A page of the series' periods, newest first, each with its progress and outcome. */
export async function GET(request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const query = await readGoalQuery(request, pageQuerySchema);
  if (!query.ok) return query.response;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  return readAnswer(await readGoalSeriesPeriods(seriesId, query.data.before ?? null), "periods");
}
