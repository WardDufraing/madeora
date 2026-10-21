import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { CompleteResponse } from "@/chores/api";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { completionSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Completes an open occurrence (S20): any current member, also someone else's, naming who actually
 * did the work, with an optional note. Every mandatory step must be ticked. Of two people completing
 * at once one is recorded and the other is told who was first (`already_completed`). A chore that
 * requires approval answers `submitted` (Pending approval) instead, or `already_submitted` with who
 * submitted the attempt that waits.
 */
export async function PUT(request: Request, { params }: OccurrenceRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, completionSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("complete_chore_occurrence", {
    p_occurrence_id: id,
    p_contributor: input.data.contributor,
    ...(input.data.note !== null ? { p_note: input.data.note } : {}),
  });
  if (error) return databaseFailure("chores.complete_failed", error);
  const row = data[0];
  if (row?.outcome === "already_skipped") return failure(409, "already-skipped");
  const completedAt = row ? nullable(row.completed_at) : null;
  const body: CompleteResponse | object = row
    ? {
        outcome: row.outcome,
        completedAt,
        completedBy:
          completedAt === null
            ? null
            : { me: row.completed_by_me, member: nullable(row.completed_by_member) },
        contributor:
          completedAt === null
            ? null
            : { me: row.contributor_me, member: nullable(row.contributor_member) },
      }
    : {};
  return outcomeAnswer("chores.complete_failed", row?.outcome, body, {
    count: row ? nullable(row.open_mandatory) : null,
  });
}
