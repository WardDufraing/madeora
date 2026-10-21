import { listChoreSchedule } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";
import { scheduleQuerySchema } from "@/chores/schema";

/**
 * A Home's chores between two dates, at most 42 days (S21): each occurrence with its state and the
 * dates of recurring chores still to be created (projected, never movable), for the schedule widget
 * and the Chores calendar. A Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const search = new URL(request.url).searchParams;
  const query = scheduleQuerySchema.safeParse({
    homeId: search.get("homeId"),
    from: search.get("from"),
    to: search.get("to"),
  });
  if (!query.success) return failure(400, "invalid");
  const schedule = await listChoreSchedule(query.data.homeId, query.data.from, query.data.to);
  if (schedule.status === "not-found") return failure(404, "not-found");
  if (schedule.status === "unavailable") return failure(500, "failed");
  return json(200, schedule.value);
}
