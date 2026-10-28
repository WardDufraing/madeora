import { readHabitCalendar } from "@/habits/data";
import { failure, pathId, readAnswer, readHabitQuery } from "@/habits/route-helpers";
import { calendarQuerySchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** One month (`?month=YYYY-MM`) of a habit: every day's state and each week's outcome. */
export async function GET(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const query = await readHabitQuery(request, calendarQuerySchema);
  if (!query.ok) return query.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  return readAnswer(await readHabitCalendar(habitId, query.data.month), "calendar");
}
