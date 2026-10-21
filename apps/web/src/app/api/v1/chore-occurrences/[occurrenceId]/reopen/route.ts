import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Reopens a completed or skipped occurrence (S20, chore managers): it is outstanding again with its
 * assignees and checklist as they were; what was recorded stays in its events.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reopen_chore_occurrence", { p_occurrence_id: id });
  if (error) return databaseFailure("chores.reopen_failed", error);
  const row = data[0];
  return outcomeAnswer("chores.reopen_failed", row?.outcome, {
    outcome: row?.outcome,
    revision: row ? nullable(row.revision) : null,
  });
}
