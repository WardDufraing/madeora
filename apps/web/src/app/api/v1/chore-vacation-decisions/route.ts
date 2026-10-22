import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, readChoreMutation } from "@/chores/route-helpers";
import { vacationAnswer } from "@/vacations/route-helpers";
import { decisionSchema } from "@/vacations/schema";

/**
 * A chore manager's decision on one occurrence a vacation or absence affects (S22): keep, skip,
 * reassign (assigning a member away then needs `confirmAway`, else `409 member-away`) or, for a
 * one-off chore of a vacation, reschedule. Taken once per occurrence and source
 * (`409 already-decided`); work pending approval or in rework is never changed (`409 protected`).
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, decisionSchema);
  if (!input.ok) return input.response;
  const decision = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("decide_chore_vacation_item", {
    p_source_kind: decision.sourceKind,
    p_source_id: decision.sourceId,
    p_occurrence_id: decision.occurrenceId,
    p_expected_revision: decision.expectedRevision,
    p_decision: decision.decision,
    ...(decision.memberId !== undefined ? { p_member: decision.memberId } : {}),
    ...(decision.dueDate !== undefined ? { p_due_date: decision.dueDate } : {}),
    ...(decision.confirmAway ? { p_confirm_away: true } : {}),
  });
  if (error) return databaseFailure("vacations.decision_failed", error);
  return vacationAnswer("vacations.decision_failed", data[0]);
}
