import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { reviewSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Approves or rejects an occurrence's pending submission (S20, chore reviewers: the Owner and
 * Administrators granted approveHomeChores; a reviewer may approve their own completion). A
 * rejection needs a reason and leaves the occurrence Needs rework. `expectedRevision` is the
 * occurrence's revision the reviewer saw: anything changed since answers `409 conflict`, a decision
 * already taken `409 not-pending`, and a contributor who left `409 contributor-unavailable`.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, reviewSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const review = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("review_chore_submission", {
    p_occurrence_id: id,
    p_expected_revision: review.expectedRevision,
    p_decision: review.decision,
    ...(review.reason !== null ? { p_reason: review.reason } : {}),
  });
  if (error) return databaseFailure("chores.review_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.review_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
