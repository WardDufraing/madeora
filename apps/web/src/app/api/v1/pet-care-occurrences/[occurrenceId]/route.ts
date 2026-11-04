import { createSupabaseServerClient } from "@/auth/supabase-server";
import { occurrenceActionSchema } from "@/pets/care-schema";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readPetMutation,
  resultOf,
} from "@/pets/route-helpers";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * One action on one occurrence: complete (any member), skip (a responsible member or a pet manager),
 * reopen and correct (whoever recorded it or a pet manager), or change only this occurrence (pet
 * managers). Revision-checked; a completion someone else already recorded answers `409 closed`.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readPetMutation(request, occurrenceActionSchema);
  if (!input.ok) return input.response;
  const occurrenceId = pathId((await params).occurrenceId);
  if (!occurrenceId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const body = input.data;
  const event = `pets.care_${body.action}_failed`;
  const { data, error } = await (() => {
    switch (body.action) {
      case "complete":
        return supabase.rpc("complete_pet_care_occurrence", {
          p_occurrence_id: occurrenceId,
          p_expected_revision: body.revision,
          ...(body.completedAt ? { p_completed_at: body.completedAt } : {}),
          ...(body.note ? { p_note: body.note } : {}),
        });
      case "skip":
        return supabase.rpc("skip_pet_care_occurrence", {
          p_occurrence_id: occurrenceId,
          p_expected_revision: body.revision,
        });
      case "reopen":
        return supabase.rpc("reopen_pet_care_occurrence", {
          p_occurrence_id: occurrenceId,
          p_expected_revision: body.revision,
        });
      case "correct":
        return supabase.rpc("correct_pet_care_completion", {
          p_occurrence_id: occurrenceId,
          p_expected_revision: body.revision,
          p_completed_at: body.completedAt,
          ...(body.note ? { p_note: body.note } : {}),
        });
      case "update":
        return supabase.rpc("update_pet_care_occurrence", {
          p_occurrence_id: occurrenceId,
          p_expected_revision: body.revision,
          p_due_on: body.dueOn,
          p_time: body.time as string,
          p_members: body.members,
        });
    }
  })();
  if (error) return databaseFailure(event, error);
  const { outcome, body: answer } = resultOf(data);
  return outcomeAnswer(event, outcome, answer);
}
