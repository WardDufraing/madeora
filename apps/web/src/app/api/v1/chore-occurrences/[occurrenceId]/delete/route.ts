import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { deleteSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Deletes this occurrence, this and following, or the entire series (S20, chore managers) to the
 * trash, or previews that with `dryRun`. Completed and skipped occurrences always stay as history.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, deleteSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_chore_occurrences", {
    p_occurrence_id: id,
    p_scope: input.data.scope,
    p_expected_revision: input.data.expectedRevision,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("chores.delete_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.delete_failed",
    row?.outcome,
    {
      outcome: row?.outcome,
      impact: row ? nullable(row.impact) : null,
      entryId: row ? nullable(row.entry_id) : null,
    },
    { revision },
  );
}
