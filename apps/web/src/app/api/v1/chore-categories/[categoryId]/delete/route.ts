import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { deleteCategorySchema } from "@/chores/schema";

interface CategoryRouteContext {
  readonly params: Promise<{ readonly categoryId: string }>;
}

/**
 * Deletes a category after its impact review (S20, chore managers): its chores become
 * uncategorized; closed occurrences keep the name they were closed under. `dryRun` answers the count.
 */
export async function POST(request: Request, { params }: CategoryRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, deleteCategorySchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).categoryId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_chore_category", {
    p_id: id,
    p_expected_revision: input.data.expectedRevision,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("chores.category_delete_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.category_delete_failed",
    row?.outcome,
    { outcome: row?.outcome, choreCount: row ? nullable(row.chore_count) : null },
    { revision },
  );
}
