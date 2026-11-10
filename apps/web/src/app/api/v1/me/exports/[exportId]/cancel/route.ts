import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";

interface CancelRouteContext {
  readonly params: Promise<{ readonly exportId: string }>;
}

/** Cancels the person's own queued or preparing export, or deletes a ready one early (S39). */
export async function POST(request: Request, { params }: CancelRouteContext): Promise<Response> {
  const input = await readPrivacyMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const { exportId } = await params;
  if (!z.uuid().safeParse(exportId).success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_my_export", { p_export_id: exportId });
  if (error) return databaseFailure("privacy.export_cancel_failed", error);
  return json(200, { canceled: data });
}
