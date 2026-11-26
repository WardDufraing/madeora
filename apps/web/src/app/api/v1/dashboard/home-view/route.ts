import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { resetHomeViewSchema } from "@/dashboard/schema";
import { logDashboard } from "@/dashboard/server";

/**
 * Ends the person's own view of a Home (UX2d; redesign decision 33: "return to the shared
 * default"): they see the shared default again. The view's version history and their unsaved draft
 * of it go too; nothing else (the shared default, other members' views, any record) is touched. The
 * interface previews and confirms first.
 *
 * `DELETE { homeId }` → `200 { reset }` (`false`: they had no view). `404` for a Home the person does
 * not belong to, indistinguishable from none. The database decides membership again with the
 * person's own session, and only ever acts on the caller's own view.
 */
export async function DELETE(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, resetHomeViewSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reset_dashboard_override", {
    p_home_id: input.data.homeId,
  });
  if (error) return databaseFailure("dashboard.home_view_reset_failed", error);
  if (data !== "reset" && data !== "nothing_to_reset") {
    logDashboard("dashboard.home_view_reset_failed", "unexpected_outcome");
    return failure(500, "failed");
  }
  return json(200, { reset: data === "reset" });
}
