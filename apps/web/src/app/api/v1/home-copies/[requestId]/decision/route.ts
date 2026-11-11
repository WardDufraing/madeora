import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { copyDecisionSchema } from "@/copies/schema";
import { databaseFailure, failure, json, readPrivacyMutation } from "@/privacy/route-helpers";

interface RouteContext {
  readonly params: Promise<{ readonly requestId: string }>;
}

/**
 * Approves or rejects one pending copy request (S40 part 2; spec "Confirmed permissions for
 * receiving personal-to-Home ownership transfers", "Confirmed self-approval"). The database checks
 * that the caller approves that kind of content in the request's Home now, and checks the request,
 * the requester and the item again; anyone else gets 404, as for a request that does not exist.
 */
export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const input = await readPrivacyMutation(request, copyDecisionSchema);
  if (!input.ok) return input.response;
  const requestId = z.uuid().safeParse((await params).requestId);
  if (!requestId.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("decide_home_copy", {
    p_request_id: requestId.data,
    p_approve: input.data.approve,
  });
  if (error) return databaseFailure("copies.decide_failed", error);
  return json(200, { outcome: data });
}
