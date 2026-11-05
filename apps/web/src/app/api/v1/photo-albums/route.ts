import { createSupabaseServerClient } from "@/auth/supabase-server";
import { createAlbumSchema } from "@/photos/schema";
import { homeOf } from "@/photos/route-helpers";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";

const MAX_BODY_BYTES = 1024;

/** Creates an album in the person's personal library or a Home's (S35); a retry returns the same one. */
export async function POST(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, createAlbumSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_photo_album", {
    p_id: input.data.id,
    // The generated types read every parameter as required; null is the personal library.
    p_home_id: homeOf(input.data.owner) as string,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("photos.album_create_failed", error.code);
  const result = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  switch (result.outcome) {
    case "created":
      return json(201, { id: input.data.id });
    case "exists":
      return json(200, { id: input.data.id });
    case "not_permitted":
      return failure(403, "not-permitted");
    case "limit":
      return failure(409, "limit-reached");
    default:
      return failure(500, "failed");
  }
}
