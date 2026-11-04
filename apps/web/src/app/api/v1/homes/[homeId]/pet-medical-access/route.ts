import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readMedicalAccess } from "@/pets/data";
import {
  databaseFailure,
  failure,
  json,
  pathId,
  readAnswer,
  readPetMutation,
  requireReader,
} from "@/pets/route-helpers";
import { medicalAccessSchema } from "@/pets/schema";

interface HomeRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/** Who has medical access: every member for a grantor, only the person's own level otherwise. */
export async function GET(_request: Request, { params }: HomeRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = pathId((await params).homeId);
  if (!homeId) return failure(404, "not-found");
  return readAnswer(await readMedicalAccess(homeId), "access");
}

/**
 * Sets one member's medical access (none, view or manage): the Owner and Administrators granted
 * managePetMedicalAccess, never for themselves or the Owner. Works at once and is audited.
 */
export async function PUT(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const input = await readPetMutation(request, medicalAccessSchema);
  if (!input.ok) return input.response;
  const homeId = pathId((await params).homeId);
  if (!homeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_pet_medical_access", {
    p_home_id: homeId,
    p_membership_id: input.data.membershipId,
    p_level: input.data.level,
  });
  if (error) return databaseFailure("pets.access_update_failed", error);
  switch (data) {
    case "ok":
    case "unchanged":
      return json(200, { outcome: data });
    case "not_permitted":
      return failure(403, "not-permitted");
    case "not_found":
      return failure(404, "not-found");
    default:
      return failure(500, "failed");
  }
}
