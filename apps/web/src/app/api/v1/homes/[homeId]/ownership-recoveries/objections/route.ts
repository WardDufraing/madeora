import { createSupabaseServerClient } from "@/auth/supabase-server";
import { recoveryObjectionSchema } from "@/recovery/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readRecoveryMutation,
  requireRecoveryAction,
} from "@/recovery/server";

// A reason of up to 2000 characters, JSON-escaped.
const MAX_BODY_BYTES = 16 * 1024;

interface ObjectionsRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * A member (or the Owner) objects to the open recovery request about the Home (S12b). The case
 * pauses until staff look at it; the reason is visible to staff only.
 */
export async function POST(
  request: Request,
  { params }: ObjectionsRouteContext,
): Promise<Response> {
  const input = await readRecoveryMutation(request, recoveryObjectionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  const allowed = await requireRecoveryAction(homeId, "home.recovery.object");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("object_to_ownership_recovery", {
    p_home_id: allowed.context.home.id,
    p_reason: input.data.reason,
  });
  if (error) return databaseFailure("recovery.object_failed", error);
  return data === "objected" ? json(200, {}) : outcomeFailure(data);
}
