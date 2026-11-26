import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { dismissSuggestionsSchema } from "@/dashboard/schema";
import { logDashboard } from "@/dashboard/server";

/**
 * Dismisses widgets the shared default added so they are not suggested again (UX2d; redesign
 * decision 34). Only the person's own view remembers it: nobody else's suggestions change, and a
 * dismissed widget never grants or removes access to anything. Ids that are not in the shared
 * default are ignored by the database.
 *
 * `POST { homeId, widgetIds }` → `200 { dismissed }` (`false`: the person has no view of their own,
 * so there is nothing to remember). `404` for a Home the person does not belong to.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, dismissSuggestionsSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("dismiss_dashboard_suggestions", {
    p_home_id: input.data.homeId,
    p_widget_ids: input.data.widgetIds,
  });
  if (error) return databaseFailure("dashboard.suggestions_dismiss_failed", error);
  if (data !== "dismissed" && data !== "no_override") {
    logDashboard("dashboard.suggestions_dismiss_failed", "unexpected_outcome");
    return failure(500, "failed");
  }
  return json(200, { dismissed: data === "dismissed" });
}
