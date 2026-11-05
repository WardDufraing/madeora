import { createSupabaseServerClient } from "@/auth/supabase-server";
import { notFound, pathId } from "@/photos/route-helpers";
import { albumPhotosSchema } from "@/photos/schema";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";

const MAX_BODY_BYTES = 8 * 1024;

interface AlbumRouteContext {
  readonly params: Promise<{ readonly albumId: string }>;
}

function answer(data: unknown, event: string): Response {
  const result = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  switch (result.outcome) {
    case "saved":
      return json(200, {
        added: typeof result.added === "number" ? result.added : 0,
        removed: typeof result.removed === "number" ? result.removed : 0,
      });
    case "limit":
      return failure(409, "limit-reached");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "not_found":
      return failure(404, "not-found");
    default:
      return databaseFailure(event, "outcome");
  }
}

/**
 * Adds photos of the album's own library to it (S35). A photo may be in many albums. Photos from
 * another library, in the trash or already in the album are skipped without saying which.
 */
export async function POST(request: Request, { params }: AlbumRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, albumPhotosSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const albumId = pathId((await params).albumId);
  if (!albumId) return notFound();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_photos_to_album", {
    p_album_id: albumId,
    p_photo_ids: input.data.photoIds,
  });
  if (error) return databaseFailure("photos.album_add_failed", error.code);
  return answer(data, "photos.album_add_failed");
}

/** Takes photos out of the album. The photos themselves are never deleted by this. */
export async function DELETE(request: Request, { params }: AlbumRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, albumPhotosSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const albumId = pathId((await params).albumId);
  if (!albumId) return notFound();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_photos_from_album", {
    p_album_id: albumId,
    p_photo_ids: input.data.photoIds,
  });
  if (error) return databaseFailure("photos.album_remove_failed", error.code);
  return answer(data, "photos.album_remove_failed");
}
