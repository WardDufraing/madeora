import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { releaseSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Returns a claimed occurrence to the pool (S21): its claimant (`undo` right after claiming) or a
 * chore manager, while it is open. Its checklist progress is cleared; a chore that closes after its
 * week closes it at once when that week has ended (`status: expired`). A retry answers
 * `409 not-claimed`.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, releaseSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("release_chore_occurrence", {
    p_occurrence_id: id,
    p_undo: input.data.undo,
  });
  if (error) return databaseFailure("chores.release_failed", error);
  const row = data[0];
  return outcomeAnswer("chores.release_failed", row?.outcome, {
    outcome: row?.outcome,
    status: row ? nullable(row.status) : null,
    revision: row ? nullable(row.revision) : null,
  });
}
