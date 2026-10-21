import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { stepsArg } from "@/chores/rpc-args";
import { proposalDecisionSchema } from "@/chores/schema";

interface ProposalRouteContext {
  readonly params: Promise<{ readonly proposalId: string }>;
}

/**
 * A decision on a waiting proposal (S21): its proposer withdraws it; a chore manager rejects it
 * with a reason, or approves the final fields they saw, which publishes one unassigned one-off
 * chore (`occurrenceId`). Every decision carries the revision it was made on (`409 conflict`); a
 * proposal decided already answers `409 not-open` with its status.
 */
export async function PATCH(request: Request, { params }: ProposalRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, proposalDecisionSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).proposalId);
  if (!id) return failure(404, "not-found");
  const decision = input.data;
  const supabase = await createSupabaseServerClient();
  if (decision.action === "withdraw") {
    const { data, error } = await supabase.rpc("withdraw_chore_proposal", {
      p_id: id,
      p_expected_revision: decision.expectedRevision,
    });
    if (error) return databaseFailure("chores.proposal_withdraw_failed", error);
    const row = data[0];
    if (row?.outcome === "not_open") return failure(409, "not-open", { status: row.status });
    return outcomeAnswer(
      "chores.proposal_withdraw_failed",
      row?.outcome,
      { outcome: row?.outcome, revision: row ? nullable(row.revision) : null },
      { revision: row ? nullable(row.revision) : null },
    );
  }
  const { data, error } = await supabase.rpc("review_chore_proposal", {
    p_id: id,
    p_expected_revision: decision.expectedRevision,
    p_decision: decision.action,
    ...(decision.action === "reject"
      ? { p_reason: decision.reason }
      : {
          p_title: decision.title,
          p_due_date: decision.dueDate,
          p_steps: stepsArg(decision.steps),
          ...(decision.instructions !== null ? { p_instructions: decision.instructions } : {}),
          ...(decision.categoryId !== null ? { p_category_id: decision.categoryId } : {}),
          ...(decision.minutes !== null ? { p_minutes: decision.minutes } : {}),
        }),
  });
  if (error) return databaseFailure("chores.proposal_review_failed", error);
  const row = data[0];
  if (row?.outcome === "not_open") {
    return failure(409, "not-open", { status: row.status });
  }
  return outcomeAnswer(
    "chores.proposal_review_failed",
    row?.outcome,
    { outcome: row?.outcome, occurrenceId: row ? nullable(row.occurrence_id) : null },
    { revision: row ? nullable(row.revision) : null },
  );
}
