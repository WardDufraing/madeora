import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";
import { exportRequestSchema } from "@/privacy/schema";
import { storageEnabled } from "@/storage/server";

/**
 * Requests a personal data export of the signed-in person's own data (S39). The database requires
 * this browser session's fresh 'data_export' permission, accepts only the person's current Homes as
 * scope, allows 3 requests a day and one in preparation, and queues the background build.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readPrivacyMutation(request, exportRequestSchema);
  if (!input.ok) return input.response;
  // Archives live in private storage; without it no export can be prepared here.
  if (!storageEnabled()) return failure(503, "storage-off");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_personal_export", {
    p_all: input.data.allData,
    p_categories: input.data.allData ? [] : input.data.categories,
    p_home_ids: input.data.homeIds,
  });
  if (error) return databaseFailure("privacy.export_request_failed", error);
  return json(201, { id: data });
}
