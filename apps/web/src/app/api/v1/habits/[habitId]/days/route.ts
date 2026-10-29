import { readHabitDailyTotals } from "@/habits/data";
import { failure, pathId, readAnswer, readHabitQuery } from "@/habits/route-helpers";
import { daysQuerySchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** A page of a numeric habit's daily totals, newest first, before the day `before` (none: up to today). */
export async function GET(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const query = await readHabitQuery(request, daysQuerySchema);
  if (!query.ok) return query.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  return readAnswer(await readHabitDailyTotals(habitId, query.data.before ?? null), "totals");
}
