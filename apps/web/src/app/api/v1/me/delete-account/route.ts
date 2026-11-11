import {
  clearSessionCookies,
  databaseFailure,
  json,
  readActivityMutation,
} from "@/activity/route-helpers";
import { accountDeletionSchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * Asks for the signed-in account's deletion (S40; spec "Confirmed Madeora account deletion and
 * recovery"). The typed confirmation is checked here; the database checks the fresh
 * re-authentication and that the account owns no active Home, suspends the account and ends every
 * session. This browser's session cookies are deleted here too. Returns the deadline.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readActivityMutation(request, accountDeletionSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_account_deletion");
  if (error) return databaseFailure("account.delete_failed", error);
  await clearSessionCookies();
  return json(200, { purgeAfter: data });
}
