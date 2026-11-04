import { readCalendar } from "@/calendar/data";
import { failure, readAnswer, requireReader } from "@/calendar/route-helpers";
import { windowQuerySchema } from "@/calendar/schema";

/**
 * The occurrences the person sees in a context (no homeId: Personal) over at most 62 local dates,
 * with the Home's vacations when they show them. A Home they are not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const query = windowQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) return failure(400, "invalid");
  return readAnswer(
    await readCalendar(query.data.homeId ?? null, query.data.from, query.data.to),
    "calendar",
  );
}
