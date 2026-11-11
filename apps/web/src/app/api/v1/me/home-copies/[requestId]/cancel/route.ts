import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";

interface RouteContext {
  readonly params: Promise<{ readonly requestId: string }>;
}

/** Cancels one of the signed-in person's own pending copy requests (S40 part 2). */
export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const input = await readPrivacyMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const requestId = z.uuid().safeParse((await params).requestId);
  if (!requestId.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_home_copy", { p_request_id: requestId.data });
  if (error) return databaseFailure("copies.cancel_failed", error);
  return json(200, { cancelled: data });
}
