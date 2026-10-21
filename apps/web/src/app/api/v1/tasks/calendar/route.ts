import { z } from "zod";

import { daysBetween } from "@/tasks/calendar";
import { listTaskCalendar } from "@/tasks/data";
import { failure, json, requireReader } from "@/tasks/route-helpers";
import { calendarQuerySchema, dateOnlySchema, TASK_LIMITS } from "@/tasks/schema";

const windowSchema = z
  .object({ from: dateOnlySchema, to: dateOnlySchema })
  .refine(({ from, to }) => {
    const days = daysBetween(from, to) + 1;
    return days >= 1 && days <= TASK_LIMITS.calendarDays;
  });
const filtersSchema = calendarQuerySchema.pick({
  list: true,
  status: true,
  priority: true,
  label: true,
  assignee: true,
  member: true,
});

/**
 * The task calendar of the Personal space or a Home (S19c): `?homeId&from&to` (at most 42 days)
 * with the list filters `list`, `status`, `priority`, `label`, `assignee` (`member` with `member`).
 * Read with the person's own session: a Home they are not in answers 404.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z
    .uuid()
    .optional()
    .safeParse(params.get("homeId") ?? undefined);
  const window = windowSchema.safeParse({ from: params.get("from"), to: params.get("to") });
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    if (key === "homeId" || key === "from" || key === "to") continue;
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  const filters = filtersSchema.safeParse(raw);
  if (!homeId.success || !window.success || !filters.success) return failure(400, "invalid");
  if ((filters.data.assignee === "member") !== (filters.data.member !== undefined)) {
    return failure(400, "invalid");
  }
  const calendar = await listTaskCalendar(homeId.data ?? null, window.data, filters.data);
  if (calendar.status === "not-found") return failure(404, "not-found");
  if (calendar.status === "unavailable") return failure(500, "failed");
  return json(200, calendar.value);
}
