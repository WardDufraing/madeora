import { createSupabaseServerClient } from "@/auth/supabase-server";
import { emptyBodySchema } from "@/members/manage-schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readRecoveryMutation,
  requireRecoveryAction,
} from "@/recovery/server";

const MAX_BODY_BYTES = 64;

interface CancelRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * The Owner, evidently still able to sign in, ends every open recovery request about their Home
 * ("I still have access"; S12b).
 */
export async function POST(request: Request, { params }: CancelRouteContext): Promise<Response> {
  const input = await readRecoveryMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  const allowed = await requireRecoveryAction(homeId, "home.recovery.cancel");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_ownership_recoveries", {
    p_home_id: allowed.context.home.id,
  });
  if (error) return databaseFailure("recovery.cancel_failed", error);
  const row = data[0];
  if (!row) return failure(500, "failed");
  return row.outcome === "cancelled"
    ? json(200, { cancelled: row.cancelled })
    : outcomeFailure(row.outcome);
}
