import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readCalendarAccess } from "@/calendar/data";
import {
  databaseFailure,
  failure,
  json,
  pathId,
  readAnswer,
  readCalendarMutation,
  requireReader,
} from "@/calendar/route-helpers";
import { calendarAccessSchema } from "@/calendar/schema";

interface HomeRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/** Calendar levels: every member for a calendar manager, only the person's own otherwise. */
export async function GET(_request: Request, { params }: HomeRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = pathId((await params).homeId);
  if (!homeId) return failure(404, "not-found");
  return readAnswer(await readCalendarAccess(homeId), "access");
}

/**
 * Sets one member's calendar level (view, edit, or edit and delete): the Owner and Administrators
 * granted manageHomeCalendar, never for themselves or another manager. Works at once; audited.
 */
export async function PUT(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const input = await readCalendarMutation(request, calendarAccessSchema);
  if (!input.ok) return input.response;
  const homeId = pathId((await params).homeId);
  if (!homeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_home_calendar_access", {
    p_home_id: homeId,
    p_membership_id: input.data.membershipId,
    p_level: input.data.level,
  });
  if (error) return databaseFailure("calendar.access_update_failed", error);
  switch (data) {
    case "ok":
    case "unchanged":
      return json(200, { outcome: data });
    case "not_permitted":
      return failure(403, "not-permitted");
    case "not_found":
      return failure(404, "not-found");
    default:
      return failure(500, "failed");
  }
}
