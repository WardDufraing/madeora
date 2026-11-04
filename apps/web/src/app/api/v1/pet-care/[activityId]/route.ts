import { createSupabaseServerClient } from "@/auth/supabase-server";
import { updateCareSchema } from "@/pets/care-schema";
import { readCareActivity } from "@/pets/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readPetMutation,
  requireReader,
  resultOf,
} from "@/pets/route-helpers";
import { revisionSchema } from "@/pets/schema";

interface CareRouteContext {
  readonly params: Promise<{ readonly activityId: string }>;
}

/** One care activity with its open and recent occurrences; otherwise not found. */
export async function GET(_request: Request, { params }: CareRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const activityId = pathId((await params).activityId);
  if (!activityId) return failure(404, "not-found");
  return readAnswer(await readCareActivity(activityId), "activity");
}

/** Changes an activity; with a schedule, from `from` on. Revision-checked. */
export async function PATCH(request: Request, { params }: CareRouteContext): Promise<Response> {
  const input = await readPetMutation(request, updateCareSchema);
  if (!input.ok) return input.response;
  const activityId = pathId((await params).activityId);
  if (!activityId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_pet_care", {
    p_activity_id: activityId,
    p_expected_revision: input.data.revision,
    p_activity: input.data.activity,
    // Without a schedule, the schedule stays as it is.
    ...(input.data.schedule && input.data.from
      ? { p_schedule: input.data.schedule, p_from: input.data.from }
      : {}),
  });
  if (error) return databaseFailure("pets.care_update_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.care_update_failed", outcome, body);
}

/** Moves an activity with its occurrences to the Home's trash. */
export async function DELETE(request: Request, { params }: CareRouteContext): Promise<Response> {
  const input = await readPetMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const activityId = pathId((await params).activityId);
  if (!activityId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_pet_care", {
    p_activity_id: activityId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("pets.care_delete_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.care_delete_failed", outcome, body);
}
