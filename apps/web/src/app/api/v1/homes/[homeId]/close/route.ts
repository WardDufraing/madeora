import { databaseFailure, failure, json, readActivityMutation } from "@/activity/route-helpers";
import { closeHomeSchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getHomeContext } from "@/homes/server";

interface CloseRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Closes a Home (S40; spec "Confirmed Home deletion and recovery"): its Owner only, with the Home's
 * name typed and a fresh re-authentication (both checked by the database). Every member loses
 * access at once; the Owner can restore it for 30 days. Anyone else gets 404, as for a Home they
 * cannot see.
 */
export async function POST(request: Request, { params }: CloseRouteContext): Promise<Response> {
  const input = await readActivityMutation(request, closeHomeSchema);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return failure(500, "failed");
  if (found.status !== "ok" || found.context.membership.role !== "owner") {
    return failure(404, "not-found");
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("close_home", {
    p_home_id: found.context.home.id,
    p_confirm_name: input.data.name,
  });
  if (error) {
    if (error.code === "42501" && !error.hint) return failure(404, "not-found");
    return databaseFailure("home.close_failed", error);
  }
  return json(200, { purgeAfter: data });
}
