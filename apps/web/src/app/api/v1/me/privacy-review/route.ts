import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, readPrivacyMutation } from "@/privacy/route-helpers";
import { reviewActionSchema } from "@/privacy/schema";

/**
 * Saves the person's place in the optional guided privacy review (S39): start (or restart),
 * the step reached, finish, or dismiss. It stores progress only; it never changes a setting.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readPrivacyMutation(request, reviewActionSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("save_my_privacy_review", {
    p_action: input.data.action,
    ...(input.data.action === "step" ? { p_step: input.data.step } : {}),
  });
  if (error) return databaseFailure("privacy.review_save_failed", error);
  return json(200, {});
}
