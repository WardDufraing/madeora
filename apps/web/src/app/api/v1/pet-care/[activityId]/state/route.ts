import { createSupabaseServerClient } from "@/auth/supabase-server";
import { careStateSchema } from "@/pets/care-schema";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readPetMutation,
  resultOf,
} from "@/pets/route-helpers";

interface CareRouteContext {
  readonly params: Promise<{ readonly activityId: string }>;
}

/** Pauses, resumes or ends an activity (pet managers). Revision-checked. */
export async function POST(request: Request, { params }: CareRouteContext): Promise<Response> {
  const input = await readPetMutation(request, careStateSchema);
  if (!input.ok) return input.response;
  const activityId = pathId((await params).activityId);
  if (!activityId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_pet_care_state", {
    p_activity_id: activityId,
    p_expected_revision: input.data.revision,
    p_state: input.data.state,
  });
  if (error) return databaseFailure("pets.care_state_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.care_state_failed", outcome, body);
}
