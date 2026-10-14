import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { DecisionResponse } from "@/invitations/api";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMutation,
  requireHomeAction,
} from "@/invitations/route-helpers";
import { decisionSchema } from "@/invitations/schema";

const MAX_BODY_BYTES = 256;

interface DecisionRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly requestId: string }>;
}

/**
 * Approves or declines a join request (S10). Approval is the membership boundary: the database
 * function re-checks the manager's authority, the invitation, the applicant and any existing
 * membership under row locks, then creates exactly one membership with the invited role.
 */
export async function POST(request: Request, { params }: DecisionRouteContext): Promise<Response> {
  const input = await readMutation(request, decisionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, requestId } = await params;
  if (!z.uuid().safeParse(requestId).success) return failure(404, "not-found");

  const allowed = await requireHomeAction(homeId, "home.invitations.manage");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("decide_join_request", {
    p_home_id: allowed.context.home.id,
    p_request_id: requestId,
    p_decision: input.data.decision,
  });
  if (error) return databaseFailure("join_requests.decide_failed", error.code);
  if (data === "approved" || data === "declined") {
    const response: DecisionResponse = { outcome: data };
    return json(200, response);
  }
  return outcomeFailure(data);
}
