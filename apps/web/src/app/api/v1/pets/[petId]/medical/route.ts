import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readPetMedical } from "@/pets/data";
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
import { putMedicalSchema } from "@/pets/schema";

interface PetRouteContext {
  readonly params: Promise<{ readonly petId: string }>;
}

/**
 * A pet's sensitive details and medical history, for someone with medical view now. Everyone else
 * gets the same 404 as for a pet that does not exist.
 */
export async function GET(_request: Request, { params }: PetRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  return readAnswer(await readPetMedical(petId), "medical");
}

/** Replaces the sensitive details (medical manage); revision-checked (0: never saved). */
export async function PUT(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readPetMutation(request, putMedicalSchema);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_pet_medical_details", {
    p_pet_id: petId,
    p_expected_revision: input.data.revision,
    p_details: input.data.details,
  });
  if (error) return databaseFailure("pets.medical_update_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.medical_update_failed", outcome, body);
}
