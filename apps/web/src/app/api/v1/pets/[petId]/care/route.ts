import { createSupabaseServerClient } from "@/auth/supabase-server";
import { createCareSchema } from "@/pets/care-schema";
import { readPetCare } from "@/pets/data";
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

interface PetRouteContext {
  readonly params: Promise<{ readonly petId: string }>;
}

/** The pet's care activities (every member; medical details concealed without medical view). */
export async function GET(_request: Request, { params }: PetRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  return readAnswer(await readPetCare(petId), "care");
}

/** Adds a care activity (pet managers; medical manage too for medical details). Retry-safe. */
export async function POST(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readPetMutation(request, createCareSchema);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pet_care", {
    p_id: input.data.id,
    p_pet_id: petId,
    p_activity: input.data.activity,
    p_schedule: input.data.schedule,
  });
  if (error) return databaseFailure("pets.care_create_failed", error);
  const { outcome } = resultOf(data);
  return outcomeAnswer("pets.care_create_failed", outcome, { outcome, id: input.data.id });
}
