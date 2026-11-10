import { databaseFailure, failure, json, readActivityMutation } from "@/activity/route-helpers";
import { emptyBodySchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

interface RestoreRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Restores a closed Home before its deadline (S40): its current Owner only, with a fresh
 * re-authentication. The Home is not visible while closed, so the database alone decides who may.
 * Anyone else gets 404; after the deadline 410.
 */
export async function POST(request: Request, { params }: RestoreRouteContext): Promise<Response> {
  const input = await readActivityMutation(request, emptyBodySchema);
  if (!input.ok) return input.response;
  const homeId = homeIdSchema.safeParse((await params).homeId);
  if (!homeId.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("restore_home", { p_home_id: homeId.data });
  if (error) {
    if (error.code === "42501" && !error.hint) return failure(404, "not-found");
    return databaseFailure("home.restore_failed", error);
  }
  return json(200, {});
}
