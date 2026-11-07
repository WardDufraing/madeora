import { databaseFailure, json, readActivityMutation } from "@/activity/route-helpers";
import { emptyBodySchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/** Marks the security review after a long absence as done (S38). */
export async function POST(request: Request): Promise<Response> {
  const input = await readActivityMutation(request, emptyBodySchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("complete_security_review");
  if (error) return databaseFailure("account.security_review_failed", error);
  return json(200, {});
}
