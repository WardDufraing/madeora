import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readPets } from "@/pets/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  readAnswer,
  readPetMutation,
  requireReader,
  resultOf,
} from "@/pets/route-helpers";
import { createPetSchema, listQuerySchema } from "@/pets/schema";

/** The Home's pets with the person's access (every current member). */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const query = listQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) return failure(400, "invalid");
  return readAnswer(await readPets(query.data.homeId), "list");
}

/** Adds a pet with only its name (pet managers). A retry with the same id answers it again. */
export async function POST(request: Request): Promise<Response> {
  const input = await readPetMutation(request, createPetSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pet", {
    p_id: input.data.id,
    p_home_id: input.data.homeId,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("pets.create_failed", error);
  const { outcome } = resultOf(data);
  return outcomeAnswer("pets.create_failed", outcome, { outcome, id: input.data.id });
}
