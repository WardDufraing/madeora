import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";
import { homeExportRequestSchema } from "@/privacy/schema";
import { storageEnabled } from "@/storage/server";

interface HomeRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Requests an export of one Home's data (S39 part 2, spec "Confirmed Home data export
 * permissions"). The database requires the Home permission exportHomeData (the Owner, or an
 * Administrator or Member the Owner granted it to), this browser session's fresh 'data_export'
 * permission, 3 requests a day and one in preparation per Home, and queues the background build.
 * It collects only Home-owned records the person may see. Cancel and download use the personal
 * export endpoints, which act on the person's own exports of either kind.
 */
export async function POST(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const input = await readPrivacyMutation(request, homeExportRequestSchema);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  if (!z.uuid().safeParse(homeId).success) return failure(404, "not-found");
  if (!storageEnabled()) return failure(503, "storage-off");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_home_export", {
    p_home_id: homeId,
    p_all: input.data.allData,
    p_categories: input.data.allData ? [] : input.data.categories,
  });
  if (error) return databaseFailure("privacy.home_export_request_failed", error);
  return json(201, { id: data });
}
