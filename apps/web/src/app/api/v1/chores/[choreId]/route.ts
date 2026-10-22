import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { chorePointsArgs } from "@/points/chore-points";
import { updateChoreSchema } from "@/chores/schema";

interface ChoreRouteContext {
  readonly params: Promise<{ readonly choreId: string }>;
}

/**
 * Changes a chore's own fields (S20, chore managers): title, instructions, category and whether
 * completions need approval (prospective: what already waits stays pending). Open occurrences show
 * them at once; completed and skipped ones keep what they were closed under.
 */
export async function PATCH(request: Request, { params }: ChoreRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, updateChoreSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).choreId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_chore", {
    p_chore_id: id,
    p_expected_revision: change.expectedRevision,
    p_title: change.title,
    ...(change.instructions !== null ? { p_instructions: change.instructions } : {}),
    ...(change.categoryId !== null ? { p_category_id: change.categoryId } : {}),
    ...(change.requiresApproval !== undefined
      ? { p_requires_approval: change.requiresApproval }
      : {}),
    ...(change.points !== undefined ? chorePointsArgs(change.points) : {}),
  });
  if (error) return databaseFailure("chores.update_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.update_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
