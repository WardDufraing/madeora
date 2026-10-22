import { z } from "zod";

import { VACATION_LIMITS } from "@madeora/domain/vacations";

import { failure, json, requireReader } from "@/chores/route-helpers";
import { daysBetween } from "@/tasks/calendar";
import { dateOnlySchema } from "@/tasks/schema";
import { listVacationDays } from "@/vacations/data";

const querySchema = z
  .object({ homeId: z.uuid(), from: dateOnlySchema, to: dateOnlySchema })
  .refine((query) => query.to >= query.from, { path: ["to"] });

/**
 * The chores calendar's vacation days (S22): for a range of at most 42 days, the days someone is
 * away with whether the Home's chores are paused, how many members are away and whether the caller
 * is, and the vacations overlapping the range.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const query = querySchema.safeParse({
    homeId: params.get("homeId"),
    from: params.get("from"),
    to: params.get("to"),
  });
  if (
    !query.success ||
    daysBetween(query.data.from, query.data.to) >= VACATION_LIMITS.calendarDays
  ) {
    return failure(400, "invalid");
  }
  const days = await listVacationDays(query.data.homeId, query.data.from, query.data.to);
  if (days.status === "not-found") return failure(404, "not-found");
  if (days.status === "unavailable") return failure(500, "failed");
  return json(200, days.value);
}
