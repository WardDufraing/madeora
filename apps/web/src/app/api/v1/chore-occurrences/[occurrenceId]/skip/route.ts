import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { skipSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Skips an open occurrence (S20, chore managers) with an optional reason: it closes as Skipped,
 * never completed; the schedule and the rotation do not change. A retry answers `already_skipped`.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, skipSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("skip_chore_occurrence", {
    p_occurrence_id: id,
    ...(input.data.reason !== null ? { p_reason: input.data.reason } : {}),
  });
  if (error) return databaseFailure("chores.skip_failed", error);
  const row = data[0];
  if (row?.outcome === "already_completed") return failure(409, "already-completed");
  return outcomeAnswer("chores.skip_failed", row?.outcome, {
    outcome: row?.outcome,
    revision: row ? nullable(row.revision) : null,
  });
}
