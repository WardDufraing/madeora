import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readPet } from "@/pets/data";
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
import { revisionSchema, updatePetSchema } from "@/pets/schema";

interface PetRouteContext {
  readonly params: Promise<{ readonly petId: string }>;
}

/** One pet's basic profile (never a sensitive field); not found when the person may not see it. */
export async function GET(_request: Request, { params }: PetRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  return readAnswer(await readPet(petId), "pet");
}

/** Replaces the basic profile (pet managers); revision-checked. Unknown fields are explicit. */
export async function PATCH(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readPetMutation(request, updatePetSchema);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_pet", {
    p_pet_id: petId,
    p_expected_revision: input.data.revision,
    p_profile: input.data.profile,
  });
  if (error) return databaseFailure("pets.update_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.update_failed", outcome, body);
}

/** Moves a pet, with its medical history and files, to the Home's trash (pet managers). */
export async function DELETE(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readPetMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_pet", {
    p_pet_id: petId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("pets.delete_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.delete_failed", outcome, body);
}
