import { careQuerySchema } from "@/pets/care-schema";
import { readHomeCare } from "@/pets/data";
import { failure, readAnswer, requireReader } from "@/pets/route-helpers";

/** The pet-care widget's rows for a Home (every member; concealed where needed). */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const query = careQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) return failure(400, "invalid");
  const { homeId, petId, days, who, count } = query.data;
  return readAnswer(await readHomeCare(homeId, { petId: petId ?? null, days, who, count }), "care");
}
