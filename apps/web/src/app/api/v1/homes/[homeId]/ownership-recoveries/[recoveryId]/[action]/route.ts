import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { emptyBodySchema } from "@/members/manage-schema";
import { claimantActions } from "@/recovery/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readRecoveryMutation,
  requireRecoveryAction,
} from "@/recovery/server";

const MAX_BODY_BYTES = 64;

interface RecoveryActionRouteContext {
  readonly params: Promise<{
    readonly homeId: string;
    readonly recoveryId: string;
    readonly action: string;
  }>;
}

/**
 * The person who asked withdraws their request, or accepts ownership once staff approved it and
 * the objection period passed (S12b). Accepting re-checks everything under the Home's lock and
 * hands the Home over in one transaction. The engine checks the caller may have asked at all;
 * the database checks the request is theirs.
 */
export async function POST(
  request: Request,
  { params }: RecoveryActionRouteContext,
): Promise<Response> {
  const { homeId, recoveryId, action } = await params;
  const parsedAction = z.enum(claimantActions).safeParse(action);
  if (!parsedAction.success) return failure(404, "not-found");
  const input = await readRecoveryMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const parsedId = z.uuid().safeParse(recoveryId);
  if (!parsedId.success) return failure(404, "not-found");

  // Only an Administrator or Member can have asked; the database checks it is their own request.
  const allowed = await requireRecoveryAction(homeId, "home.recovery.request");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const args = { p_home_id: allowed.context.home.id, p_recovery_id: parsedId.data };
  if (parsedAction.data === "withdraw") {
    const { data, error } = await supabase.rpc("withdraw_ownership_recovery", args);
    if (error) return databaseFailure("recovery.withdraw_failed", error);
    return data === "withdrawn" ? json(200, {}) : outcomeFailure(data);
  }
  const { data, error } = await supabase.rpc("accept_ownership_recovery", args);
  if (error) return databaseFailure("recovery.accept_failed", error);
  return data === "completed" ? json(200, {}) : outcomeFailure(data);
}
