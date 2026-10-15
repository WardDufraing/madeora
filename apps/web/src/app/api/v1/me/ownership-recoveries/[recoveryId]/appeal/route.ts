import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { recoveryAppealSchema } from "@/recovery/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readRecoveryMutation,
} from "@/recovery/server";

// A reason of up to 4000 characters, JSON-escaped.
const MAX_BODY_BYTES = 32 * 1024;

interface AppealRouteContext {
  readonly params: Promise<{ readonly recoveryId: string }>;
}

/**
 * A former Owner appeals a completed recovery of their Home (S12b). It is recorded for staff and
 * changes nothing on its own; the caller need not be a member any more, so the database checks
 * only that they were the Owner it was taken from.
 */
export async function POST(request: Request, { params }: AppealRouteContext): Promise<Response> {
  const input = await readRecoveryMutation(request, recoveryAppealSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { recoveryId } = await params;
  const parsedId = z.uuid().safeParse(recoveryId);
  if (!parsedId.success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("appeal_ownership_recovery", {
    p_recovery_id: parsedId.data,
    p_reason: input.data.reason,
  });
  if (error) return databaseFailure("recovery.appeal_failed", error);
  return data === "appealed" ? json(200, {}) : outcomeFailure(data);
}
