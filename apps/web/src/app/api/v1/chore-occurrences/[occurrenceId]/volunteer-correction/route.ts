import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { volunteerCorrectionSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Corrects an accepted volunteer assignment before submission (S21, chore managers), with a
 * reason: back to Needs assignment review (`memberId: null`) or to another member. `dryRun`
 * answers the preview (the volunteer, whether it is overdue). The accepted request stays as it was.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, volunteerCorrectionSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("correct_chore_volunteer_assignment", {
    p_occurrence_id: id,
    p_expected_revision: input.data.expectedRevision,
    p_reason: input.data.reason,
    ...(input.data.memberId !== null ? { p_member_id: input.data.memberId } : {}),
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("chores.volunteer_correction_failed", error);
  const row = data[0];
  if (row?.outcome === "invalid_assignee") return failure(400, "invalid", { fields: ["memberId"] });
  return outcomeAnswer(
    "chores.volunteer_correction_failed",
    row?.outcome,
    {
      outcome: row?.outcome,
      volunteer: row ? nullable(row.volunteer_member) : null,
      overdue: row?.overdue ?? false,
      revision: row ? nullable(row.revision) : null,
    },
    { revision: row ? nullable(row.revision) : null },
  );
}
