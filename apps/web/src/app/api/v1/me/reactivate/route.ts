import { databaseFailure, json, readActivityMutation } from "@/activity/route-helpers";
import { emptyBodySchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * Reactivates a deactivated account (S38) from its own fully signed-in session: the sign-in
 * method and, when enabled, two-factor sign-in were just passed. Returns when it was deactivated.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readActivityMutation(request, emptyBodySchema, { deactivated: true });
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reactivate_my_account");
  if (error) return databaseFailure("account.reactivate_failed", error);
  return json(200, { since: data });
}
