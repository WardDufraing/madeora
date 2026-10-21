import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { updateCategorySchema } from "@/chores/schema";

interface CategoryRouteContext {
  readonly params: Promise<{ readonly categoryId: string }>;
}

/** Renames, recolours, archives or unarchives a category (S20, chore managers). */
export async function PATCH(request: Request, { params }: CategoryRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, updateCategorySchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).categoryId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_chore_category", {
    p_id: id,
    p_expected_revision: change.expectedRevision,
    p_name: change.name,
    p_color: change.color,
    p_archived: change.archived,
  });
  if (error) return databaseFailure("chores.category_update_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.category_update_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
