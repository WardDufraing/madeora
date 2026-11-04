import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readEvent } from "@/calendar/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readCalendarMutation,
  requireReader,
  resultOf,
} from "@/calendar/route-helpers";
import { deleteEventSchema, eventQuerySchema, updateEventSchema } from "@/calendar/schema";

interface EventRouteContext {
  readonly params: Promise<{ readonly eventId: string }>;
}

/** One event as the person sees it in a context; not found when they may not see it there. */
export async function GET(request: Request, { params }: EventRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const eventId = pathId((await params).eventId);
  if (!eventId) return failure(404, "not-found");
  const query = eventQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) return failure(400, "invalid");
  return readAnswer(
    await readEvent(eventId, query.data.homeId ?? null, query.data.on ?? null),
    "event",
  );
}

/**
 * Changes an event, one occurrence, this and following, or all (revision-checked). `dryRun`
 * answers which occurrences the change affects without changing anything.
 */
export async function PATCH(request: Request, { params }: EventRouteContext): Promise<Response> {
  const input = await readCalendarMutation(request, updateEventSchema);
  if (!input.ok) return input.response;
  const eventId = pathId((await params).eventId);
  if (!eventId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_calendar_event", {
    p_event_id: eventId,
    p_expected_revision: input.data.revision,
    p_event: input.data.event,
    p_dry_run: input.data.dryRun ?? false,
    ...(input.data.scope === null ? {} : { p_scope: input.data.scope }),
    ...(input.data.on === null ? {} : { p_on: input.data.on }),
    ...(input.data.newId === undefined ? {} : { p_new_id: input.data.newId }),
  });
  if (error) return databaseFailure("calendar.update_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("calendar.update_failed", outcome, body);
}

/** Cancels occurrences, ends a series, or moves the event to the trash (calendar delete rights). */
export async function DELETE(request: Request, { params }: EventRouteContext): Promise<Response> {
  const input = await readCalendarMutation(request, deleteEventSchema);
  if (!input.ok) return input.response;
  const eventId = pathId((await params).eventId);
  if (!eventId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_calendar_event", {
    p_event_id: eventId,
    p_expected_revision: input.data.revision,
    p_dry_run: input.data.dryRun ?? false,
    ...(input.data.scope === null ? {} : { p_scope: input.data.scope }),
    ...(input.data.on === null ? {} : { p_on: input.data.on }),
  });
  if (error) return databaseFailure("calendar.delete_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("calendar.delete_failed", outcome, body);
}
