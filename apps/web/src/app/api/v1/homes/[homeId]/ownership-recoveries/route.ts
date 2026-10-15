import { createSupabaseServerClient } from "@/auth/supabase-server";
import { recoveryRequestSchema } from "@/recovery/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readRecoveryMutation,
  requireRecoveryAction,
} from "@/recovery/server";

// A statement of up to 4000 characters (UTF-8, JSON-escaped) and a request id.
const MAX_BODY_BYTES = 32 * 1024;

interface RecoveriesRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * An eligible member asks Madeora staff to review a takeover of the Home's ownership (S12b; spec
 * "Confirmed verified Home ownership recovery"). The statement is private to staff. The database
 * decides eligibility (Administrator or Member, a confirmed account, 30 days in the Home) under
 * the Home's lock; nothing changes in the Home until staff approve and the period has passed.
 */
export async function POST(
  request: Request,
  { params }: RecoveriesRouteContext,
): Promise<Response> {
  const input = await readRecoveryMutation(request, recoveryRequestSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  const allowed = await requireRecoveryAction(homeId, "home.recovery.request");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_ownership_recovery", {
    p_home_id: allowed.context.home.id,
    p_statement: input.data.statement,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("recovery.request_failed", error);
  const row = data[0];
  if (!row) return failure(500, "failed");
  if (row.outcome !== "submitted" || !row.recovery_id) return outcomeFailure(row.outcome);
  return json(201, { recovery: { id: row.recovery_id } });
}
