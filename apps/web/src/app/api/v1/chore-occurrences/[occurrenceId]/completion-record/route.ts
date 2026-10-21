import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { correctionSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Corrects a completed occurrence's record (S20, chore managers): who actually did it, when, and
 * the note, with an optional reason. What was recorded before stays in the occurrence's events.
 * Answers `corrected` or `unchanged`; `409 not-completed` when it is not completed (any more).
 */
export async function PUT(request: Request, { params }: OccurrenceRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, correctionSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const correction = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("correct_chore_completion", {
    p_occurrence_id: id,
    p_expected_revision: correction.expectedRevision,
    ...(correction.contributor ? { p_contributor: correction.contributor } : {}),
    ...(correction.completedAt ? { p_completed_at: correction.completedAt } : {}),
    p_set_note: correction.note !== undefined,
    ...(correction.note ? { p_note: correction.note } : {}),
    ...(correction.reason ? { p_reason: correction.reason } : {}),
  });
  if (error) return databaseFailure("chores.correct_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.correct_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
