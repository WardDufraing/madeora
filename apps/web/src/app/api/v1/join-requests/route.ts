import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { JoinRequestResponse } from "@/invitations/api";
import { databaseFailure, failure, json, readMutation } from "@/invitations/route-helpers";
import { joinRequestSchema } from "@/invitations/schema";
import { isOneOf, previewOutcomes } from "@/invitations/types";

const MAX_BODY_BYTES = 512;

/**
 * Asks to join a Home with an invitation link or a join code (S10). Creates a pending request for
 * a manager to decide; nothing is consumed and no access is granted. Every outcome (requested,
 * already pending, expired, revoked, wrong email, too many attempts, …) is a normal answer the
 * join page explains; none reveals anything about the Home unless the person may use it.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readMutation(request, joinRequestSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_to_join_home", { p_token: input.data.token });
  if (error) return databaseFailure("join_requests.create_failed", error.code);
  const outcome = data[0]?.outcome;
  if (outcome !== "requested" && !isOneOf(previewOutcomes, outcome)) return failure(500, "failed");
  const response: JoinRequestResponse = { outcome };
  return json(200, response);
}
