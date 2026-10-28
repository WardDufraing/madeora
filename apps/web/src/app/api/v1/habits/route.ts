import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readHabits } from "@/habits/data";
import {
  databaseFailure,
  outcomeAnswer,
  readAnswer,
  readHabitMutation,
  readHabitQuery,
} from "@/habits/route-helpers";
import { createHabitSchema, listQuerySchema } from "@/habits/schema";
import { getEffectiveTimeZone } from "@/preferences/server";

/** The habits of a context in one view (active, ended or archived), optionally searched by name. */
export async function GET(request: Request): Promise<Response> {
  const query = await readHabitQuery(request, listQuerySchema);
  if (!query.ok) return query.response;
  const { homeId, view, q } = query.data;
  return readAnswer(await readHabits(homeId ?? null, view, q?.trim() || null), "list");
}

/**
 * Creates a habit with its first tracking period and schedule (a personal habit; a Home habit:
 * habit managers). A personal habit without a timezone takes the person's effective one.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readHabitMutation(request, createHabitSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const timeZone =
    body.homeId === null ? (body.timeZone ?? (await getEffectiveTimeZone()).timeZone) : null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_habit", {
    p_id: body.id,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
    p_name: body.name,
    ...(body.description === null ? {} : { p_description: body.description }),
    p_kind: body.schedule.kind,
    ...(body.schedule.weekdays === null ? {} : { p_weekdays: body.schedule.weekdays }),
    ...(body.schedule.target === null ? {} : { p_target: body.schedule.target }),
    p_starts_on: body.startsOn,
    ...(body.endsOn === null ? {} : { p_ends_on: body.endsOn }),
    ...(timeZone === null ? {} : { p_time_zone: timeZone }),
    p_week_start: body.weekStart,
  });
  if (error) return databaseFailure("habits.create_failed", error);
  const row = data[0];
  return outcomeAnswer("habits.create_failed", row?.outcome, {
    id: body.id,
    revision: row?.revision ?? null,
  });
}
