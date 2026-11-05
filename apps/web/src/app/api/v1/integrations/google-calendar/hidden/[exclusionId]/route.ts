import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pathId } from "@/calendar/route-helpers";
import {
  databaseFailure,
  failure,
  json,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { emptyBodySchema } from "@/google-calendar/schema";

interface Context {
  readonly params: Promise<{ readonly exclusionId: string }>;
}

/** Restores an event the person removed from Madeora (S34): it shows again; Google was never touched. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const input = await readGoogleMutation(request, emptyBodySchema);
  if (!input.ok) return input.response;
  const exclusionId = pathId((await context.params).exclusionId);
  if (!exclusionId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("restore_google_calendar_event", {
    p_exclusion_id: exclusionId,
  });
  if (error) return databaseFailure("google_calendar.restore_failed", error);
  if (data === "restored") return json(200, { outcome: "restored" });
  return failure(404, "not-found");
}
