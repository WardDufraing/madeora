import { readHabitCheckins, readHabitEvents } from "@/habits/data";
import { failure, pathId, readAnswer, readHabitQuery } from "@/habits/route-helpers";
import { historyQuerySchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * A page of a habit's check-ins (`kind=checkins`) or of its history (`kind=events`), newest first,
 * after the row `before` that ended the previous page.
 */
export async function GET(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const query = await readHabitQuery(request, historyQuerySchema);
  if (!query.ok) return query.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const { kind, before } = query.data;
  if (kind === "checkins") {
    return readAnswer(await readHabitCheckins(habitId, before ?? null), "checkins");
  }
  return readAnswer(await readHabitEvents(habitId, before ?? null), "events");
}
