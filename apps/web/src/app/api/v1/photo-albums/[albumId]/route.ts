import { createSupabaseServerClient } from "@/auth/supabase-server";
import { notFound, pathId } from "@/photos/route-helpers";
import { deleteAlbumSchema, renameAlbumSchema } from "@/photos/schema";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";

const MAX_BODY_BYTES = 1024;

interface AlbumRouteContext {
  readonly params: Promise<{ readonly albumId: string }>;
}

function answer(data: unknown, event: string): Response {
  const result = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  switch (result.outcome) {
    case "saved":
      return json(200, { revision: result.revision });
    case "deleted":
      return json(200, {});
    case "stale":
      return failure(409, "conflict");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "not_found":
      return failure(404, "not-found");
    default:
      return databaseFailure(event, "outcome");
  }
}

/** Renames an album (its creator, a photo manager, or the owner of a personal one); revision-checked. */
export async function PATCH(request: Request, { params }: AlbumRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, renameAlbumSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const albumId = pathId((await params).albumId);
  if (!albumId) return notFound();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rename_photo_album", {
    p_album_id: albumId,
    p_expected_revision: input.data.expectedRevision,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("photos.album_rename_failed", error.code);
  return answer(data, "photos.album_rename_failed");
}

/** Deletes an album to the trash; its photos are untouched. Revision-checked. */
export async function DELETE(request: Request, { params }: AlbumRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, deleteAlbumSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const albumId = pathId((await params).albumId);
  if (!albumId) return notFound();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_photo_album", {
    p_album_id: albumId,
    p_expected_revision: input.data.expectedRevision,
  });
  if (error) return databaseFailure("photos.album_delete_failed", error.code);
  return answer(data, "photos.album_delete_failed");
}
