import { createSupabaseServerClient } from "@/auth/supabase-server";
import { deletePhotosSchema } from "@/photos/schema";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Moves photos to the trash (S35): all four stored pictures of each keep counting against storage
 * and stay recoverable for seven days. A photo the person may not delete (another member's in a
 * Home library, without photo management) or cannot see is skipped, never named.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, deletePhotosSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_photos", { p_photo_ids: input.data.photoIds });
  if (error) return databaseFailure("photos.delete_failed", error.code);
  const result = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  if (typeof result.deleted !== "number" || typeof result.skipped !== "number") {
    return failure(500, "failed");
  }
  return json(200, { deleted: result.deleted, skipped: result.skipped });
}
