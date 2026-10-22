import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, pathId, readChoreMutation } from "@/chores/route-helpers";
import { vacationAnswer } from "@/vacations/route-helpers";
import { proposalAnswerSchema } from "@/vacations/schema";

interface ProposalRouteContext {
  readonly params: Promise<{ readonly proposalId: string }>;
}

/**
 * Answers a date proposal (S22): its participant accepts or declines it; its proposer or a chore
 * manager withdraws it. Accepting re-checks the dates (`409 stale` when they can no longer apply).
 */
export async function PATCH(request: Request, { params }: ProposalRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, proposalAnswerSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).proposalId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("answer_vacation_date_proposal", {
    p_proposal_id: id,
    p_action: input.data.action,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("vacations.proposal_failed", error);
  return vacationAnswer("vacations.proposal_failed", data[0]);
}
