import { createSupabaseServerClient } from "@/auth/supabase-server";
import { notFound, pathId } from "@/photos/route-helpers";
import { shareAlbumSchema, unshareAlbumSchema } from "@/photos/schema";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";

const MAX_BODY_BYTES = 4 * 1024;

interface AlbumRouteContext {
  readonly params: Promise<{ readonly albumId: string }>;
}

function answer(data: unknown, event: string): Response {
  const result = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  switch (result.outcome) {
    case "saved":
      return json(200, {
        shareCount: typeof result.shareCount === "number" ? result.shareCount : 0,
      });
    case "removed":
      return json(200, {});
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
 * Shares an album with Homes, or changes their access (S36): only a personal album's owner, or a
 * Home album's photo managers; each destination a Home they belong to now. Nothing is copied.
 */
export async function POST(request: Request, { params }: AlbumRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, shareAlbumSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const albumId = pathId((await params).albumId);
  if (!albumId) return notFound();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("share_photo_album", {
    p_album_id: albumId,
    p_shares: input.data.shares,
  });
  if (error) return databaseFailure("photos.album_share_failed", error.code);
  return answer(data, "photos.album_share_failed");
}

/**
 * Ends the album's share with one Home ("Remove from this Home"): by the album's sharer or that
 * Home's photo managers. Only access and the memberships it allowed end; no photo is deleted.
 */
export async function DELETE(request: Request, { params }: AlbumRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, unshareAlbumSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const albumId = pathId((await params).albumId);
  if (!albumId) return notFound();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("unshare_photo_album", {
    p_album_id: albumId,
    p_home_id: input.data.homeId,
  });
  if (error) return databaseFailure("photos.album_unshare_failed", error.code);
  return answer(data, "photos.album_unshare_failed");
}
