import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  readDashboardMutation,
  revisionAnswer,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { undoDashboardSchema } from "@/dashboard/schema";

/**
 * Undoes the last reset or template apply (S17): the layout it replaced comes back, once. The
 * database checks membership, authority and the revision.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, undoDashboardSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const { target, expectedRevision } = input.data;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("undo_dashboard_change", {
    p_expected_revision: expectedRevision,
    ...(target.kind === "home" ? { p_home_id: target.homeId } : {}),
  });
  if (error) return databaseFailure("dashboard.undo_failed", error);
  return revisionAnswer("dashboard.undo_failed", data[0]);
}
