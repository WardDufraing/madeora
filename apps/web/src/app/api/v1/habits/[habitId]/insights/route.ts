import { readHabitInsights } from "@/habits/data";
import { failure, pathId, readAnswer, readHabitQuery } from "@/habits/route-helpers";
import { insightsQuerySchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** Insights for the last 7, 30 (default), 90 or 365 days. */
export async function GET(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const query = await readHabitQuery(request, insightsQuerySchema);
  if (!query.ok) return query.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  return readAnswer(await readHabitInsights(habitId, query.data.days), "insights");
}
