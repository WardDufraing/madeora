import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  outcomeAnswer,
  readCalendarMutation,
  resultOf,
} from "@/calendar/route-helpers";
import { createEventSchema } from "@/calendar/schema";

/**
 * Creates an event: personal (homeId null, optionally shared with the person's Homes) or a Home
 * event (calendar level edit or more). A retry with the same id answers it again.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readCalendarMutation(request, createEventSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_calendar_event", {
    p_id: input.data.id,
    p_event: input.data.event,
    ...(input.data.homeId === null ? {} : { p_home_id: input.data.homeId }),
  });
  if (error) return databaseFailure("calendar.create_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("calendar.create_failed", outcome, body);
}
