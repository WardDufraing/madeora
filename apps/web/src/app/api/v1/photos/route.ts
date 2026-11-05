import { getVerifiedIdentity } from "@/auth/identity";
import { readLibrary } from "@/photos/data";
import { photoListQuerySchema } from "@/photos/schema";
import { failure, json } from "@/storage/route-helpers";

/**
 * One page of the person's personal library or a Home's, or of one album in it (S35). The database
 * answers only what the person may see now; a Home they are not in, and an album that is not in this
 * library, are `404 not-found`, like ones that do not exist.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = photoListQuerySchema.safeParse(params);
  if (!query.success || (query.data.scope === "home") !== (query.data.homeId !== undefined)) {
    return failure(400, "invalid");
  }
  const read = await readLibrary(
    query.data.scope === "home" ? (query.data.homeId ?? null) : null,
    query.data.albumId ?? null,
    query.data.offset,
  );
  switch (read.status) {
    case "ok":
      return json(200, { library: read.value });
    case "not-found":
      return failure(404, "not-found");
    case "invalid":
      return failure(400, "invalid");
    default:
      return failure(500, "failed");
  }
}
