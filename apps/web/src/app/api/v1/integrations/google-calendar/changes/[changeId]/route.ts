import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pathId } from "@/calendar/route-helpers";
import { logGoogleCalendar } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { googleChangeActionSchema } from "@/google-calendar/schema";

interface Context {
  readonly params: Promise<{ readonly changeId: string }>;
}

/**
 * The person's answer to one of their changes waiting for Google (S34): their choice in a conflict
 * (Madeora's or Google's version; nothing else ever ends a conflict), try again after a failure, or discard
 * a change Google has not received.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const input = await readGoogleMutation(request, googleChangeActionSchema);
  if (!input.ok) return input.response;
  const changeId = pathId((await context.params).changeId);
  if (!changeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const action = input.data;
  const { data, error } =
    action.action === "resolve"
      ? await supabase.rpc("resolve_google_calendar_conflict", {
          p_change_id: changeId,
          p_choice: action.choice,
        })
      : action.action === "retry"
        ? await supabase.rpc("retry_google_calendar_change", { p_change_id: changeId })
        : await supabase.rpc("discard_google_calendar_change", { p_change_id: changeId });
  if (error) return databaseFailure("google_calendar.change_failed", error);
  if (data === "resolved" || data === "queued" || data === "discarded") {
    return json(200, { outcome: data });
  }
  const refused = outcomeFailure(data);
  if (refused) return refused;
  logGoogleCalendar("google_calendar.change_failed", "unexpected_outcome");
  return failure(500, "failed");
}
