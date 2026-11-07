import { cookies } from "next/headers";

import { databaseFailure, json, readActivityMutation } from "@/activity/route-helpers";
import { emptyBodySchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * Temporarily deactivates the signed-in account (S38). The database checks the fresh
 * re-authentication and that no Home it alone owns is left without an Owner, then ends every
 * session of the account. This browser's session cookies are deleted here too.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readActivityMutation(request, emptyBodySchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("deactivate_my_account");
  if (error) return databaseFailure("account.deactivate_failed", error);
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (/^sb-.+-auth-token(?:\.\d+)?$/.test(name)) cookieStore.delete(name);
  }
  return json(200, {});
}
