import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readPetMutation,
  resultOf,
} from "@/pets/route-helpers";
import { createEntrySchema } from "@/pets/schema";

interface PetRouteContext {
  readonly params: Promise<{ readonly petId: string }>;
}

/** Adds a medical entry (medical manage); a retry with the same id answers it again. */
export async function POST(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readPetMutation(request, createEntrySchema);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pet_medical_entry", {
    p_id: input.data.id,
    p_pet_id: petId,
    p_entry: input.data.entry,
  });
  if (error) return databaseFailure("pets.entry_create_failed", error);
  const { outcome } = resultOf(data);
  return outcomeAnswer("pets.entry_create_failed", outcome, { outcome, id: input.data.id });
}
