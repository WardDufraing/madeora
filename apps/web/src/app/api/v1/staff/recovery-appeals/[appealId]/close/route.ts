import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { staffAppealCloseSchema } from "@/recovery/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readRecoveryMutation,
} from "@/recovery/server";

const MAX_BODY_BYTES = 16 * 1024;

interface CloseAppealRouteContext {
  readonly params: Promise<{ readonly appealId: string }>;
}

/**
 * Madeora staff close an appeal with their note (S12b; architecture.md §43). Nothing in the Home
 * changes. The database checks the caller is staff and signed in within 15 minutes.
 */
export async function POST(
  request: Request,
  { params }: CloseAppealRouteContext,
): Promise<Response> {
  const input = await readRecoveryMutation(request, staffAppealCloseSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { appealId } = await params;
  const parsedId = z.uuid().safeParse(appealId);
  if (!parsedId.success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("staff_close_recovery_appeal", {
    p_appeal_id: parsedId.data,
    p_notes: input.data.notes,
  });
  if (error) return databaseFailure("recovery.appeal_close_failed", error, { staff: true });
  return data === "closed" ? json(200, {}) : outcomeFailure(data);
}
