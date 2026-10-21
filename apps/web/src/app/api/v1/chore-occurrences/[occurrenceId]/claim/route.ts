import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getChoreClaimState } from "@/chores/data";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { claimSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * An occurrence's claim state (S21): its chore's policies, whether the viewer can claim it and if
 * not why, who has it, whether they can release it, and the reassignment requests they may see.
 */
export async function GET(
  _request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const state = await getChoreClaimState(id);
  if (state.status === "not-found") return failure(404, "not-found");
  if (state.status === "unavailable") return failure(500, "failed");
  return json(200, { claim: state.value });
}

/**
 * Claims an unassigned occurrence (S21, spec "first-come claims"): the caller becomes its only
 * assignee at once. Of two claims at the same moment one wins; the other answers
 * `409 already-claimed` with who has it. A retry of the caller's own claim answers `claimed` again.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, claimSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_chore_occurrence", { p_occurrence_id: id });
  if (error) return databaseFailure("chores.claim_failed", error);
  const row = data[0];
  if (row?.outcome === "already_claimed") {
    return failure(409, "already-claimed", {
      claimedByMe: row.claimed_by_me,
      claimant: nullable(row.claimant_member),
    });
  }
  if (row?.outcome === "already_completed") return failure(409, "already-completed");
  if (row?.outcome === "already_skipped") return failure(409, "already-skipped");
  return outcomeAnswer("chores.claim_failed", row?.outcome, {
    outcome: row?.outcome,
    revision: row ? nullable(row.revision) : null,
  });
}
