import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, readPrivacyMutation } from "@/privacy/route-helpers";

/**
 * Cancels every pending copy request of the signed-in person (S40 part 2; spec "Confirmed pending
 * content transfers during account deletion"): the explicit step before account deletion. Copies
 * already being made finish; nobody else is told.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readPrivacyMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_my_pending_home_copies");
  if (error) return databaseFailure("copies.cancel_pending_failed", error);
  return json(200, { cancelled: data });
}
