import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, readPrivacyMutation } from "@/privacy/route-helpers";
import { personalDeletionSchema } from "@/privacy/schema";

/**
 * Deletes chosen categories of the signed-in person's own personal data for good (S40 part 2; spec
 * "Confirmed category-based deletion of adult personal data"). The typed confirmation is checked
 * here; the database requires this browser session's fresh 'delete_personal_data' permission,
 * deletes each category in its own sub-transaction and stores the result under the request id, so
 * a repeated request returns the first result instead of running again.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readPrivacyMutation(request, personalDeletionSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_personal_data", {
    p_request_id: input.data.requestId,
    p_categories: input.data.categories,
  });
  if (error) return databaseFailure("privacy.personal_deletion_failed", error);
  return json(200, data as object);
}
