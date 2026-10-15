import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { StaffDecisionResponse } from "@/recovery/api";
import { staffDecisionSchema } from "@/recovery/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readRecoveryMutation,
} from "@/recovery/server";

const MAX_BODY_BYTES = 16 * 1024;

interface DecisionRouteContext {
  readonly params: Promise<{ readonly recoveryId: string }>;
}

/**
 * Madeora staff act on a recovery case: start the review, approve, pause, resume or reject (S12b;
 * architecture.md §43). The database checks the caller is staff and signed in within 15 minutes,
 * re-checks the case under the Home's lock and audits the decision with the staff account.
 *
 * Notifying people is the database's job (S14): a trigger on the case creates the in-app
 * notifications and queues the emails (the Owner when the review starts and when the objection
 * period begins, the person who asked at every step), in the decision's own transaction. No
 * session here ever handles anyone's address.
 */
export async function POST(request: Request, { params }: DecisionRouteContext): Promise<Response> {
  const input = await readRecoveryMutation(request, staffDecisionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { recoveryId } = await params;
  const parsedId = z.uuid().safeParse(recoveryId);
  if (!parsedId.success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("staff_decide_ownership_recovery", {
    p_recovery_id: parsedId.data,
    p_action: input.data.action,
    p_notes: input.data.notes,
    ...(input.data.formerOwnerOutcome
      ? { p_former_owner_outcome: input.data.formerOwnerOutcome }
      : {}),
  });
  if (error) return databaseFailure("recovery.staff_decision_failed", error, { staff: true });
  if (data !== "ok") return outcomeFailure(data);

  // The notifications to the Owner, the person who asked and the members were created by the
  // database in the same transaction as the decision (S14); background jobs send the emails.
  const response: StaffDecisionResponse = { notified: true };
  return json(200, response);
}
