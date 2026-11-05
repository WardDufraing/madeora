import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readCalendarMutation,
  resultOf,
} from "@/calendar/route-helpers";
import { sharesSchema } from "@/calendar/schema";

interface EventRouteContext {
  readonly params: Promise<{ readonly eventId: string }>;
}

/** Replaces the Homes a personal event is shared with (its owner only, their current Homes). */
export async function PUT(request: Request, { params }: EventRouteContext): Promise<Response> {
  const input = await readCalendarMutation(request, sharesSchema);
  if (!input.ok) return input.response;
  const eventId = pathId((await params).eventId);
  if (!eventId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_calendar_event_shares", {
    p_event_id: eventId,
    p_expected_revision: input.data.revision,
    p_home_ids: input.data.homeIds,
  });
  if (error) return databaseFailure("calendar.shares_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("calendar.shares_failed", outcome, body);
}
