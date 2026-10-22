import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, pathId, readChoreMutation } from "@/chores/route-helpers";
import { vacationAnswer } from "@/vacations/route-helpers";
import { participantsAddSchema } from "@/vacations/schema";

interface ParticipantsRouteContext {
  readonly params: Promise<{ readonly vacationId: string }>;
}

/**
 * Adds participants (S22): a chore manager adds them directly; the creator invites them (each is
 * told and accepts or declines before their dates count). `dryRun` answers the preview.
 */
export async function POST(
  request: Request,
  { params }: ParticipantsRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, participantsAddSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).vacationId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_vacation_participants", {
    p_vacation_id: id,
    p_expected_revision: input.data.expectedRevision,
    p_people: input.data.people,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("vacations.participants_failed", error);
  return vacationAnswer("vacations.participants_failed", data[0]);
}
