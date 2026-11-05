import { getVerifiedIdentity } from "@/auth/identity";
import { readWidgetPhotos } from "@/photos/data";
import { photoWidgetQuerySchema } from "@/photos/schema";
import { failure, json } from "@/storage/route-helpers";

/**
 * The photos a photo widget shows to this viewer now (S36): the slideshow asks again every minute and
 * whenever a picture fails, so revoked, deleted or newly inaccessible photos stop showing. A Home the
 * viewer is not in is `404`; an album that cannot be used in this context answers `available: false`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = photoWidgetQuerySchema.safeParse(params);
  if (!query.success) return failure(400, "invalid");
  const { homeId, albumId, photoIds } = query.data;
  const read = await readWidgetPhotos(
    homeId ?? null,
    albumId !== undefined ? { albumId } : { photoIds: photoIds ?? [] },
  );
  switch (read.status) {
    case "ok":
      return json(200, { widget: read.value });
    case "not-found":
      return failure(404, "not-found");
    case "invalid":
      return failure(400, "invalid");
    default:
      return failure(500, "failed");
  }
}
