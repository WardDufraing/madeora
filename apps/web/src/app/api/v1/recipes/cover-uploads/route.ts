import { createSupabaseServerClient } from "@/auth/supabase-server";
import { coverIntentSchema } from "@/recipes/schema";
import type { UploadIntentResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { getStorage } from "@/storage/server";

const MAX_BODY_BYTES = 1024;
/** How long the browser has to start putting the bytes (the intent itself lasts 15 minutes). */
const UPLOAD_LINK_SECONDS = 300;

/**
 * Opens an upload of a recipe cover (S24): for a new recipe or a draft (charged to the person's own
 * storage), or for a published recipe they are editing (with the editor's lock token; charged to
 * where the recipe lives). The database checks the type and size policy, rate limits and capacity
 * under locks; this route then signs a 5-minute PUT link bound to that key, type and size. The
 * bytes are checked and re-encoded by the finalize route, and the cover is applied only by Save.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, coverIntentSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_recipe_cover_intent", {
    p_content_type: input.data.contentType,
    p_size: input.data.size,
    p_request_id: input.data.requestId,
    ...(input.data.recipeId ? { p_recipe_id: input.data.recipeId } : {}),
    ...(input.data.lockToken ? { p_lock_token: input.data.lockToken } : {}),
  });
  if (error) return databaseFailure("storage.recipe_cover_intent_failed", error.code);
  const row = data[0];
  switch (row?.outcome) {
    case "ok":
      break;
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
    case "lock_lost":
      return failure(403, "not-permitted");
    case "storage_full":
      return failure(409, "storage-full");
    case "rate_limited":
      return failure(429, "rate-limited");
    case "conflict":
      return failure(409, "conflict");
    default:
      return failure(500, "failed");
  }
  if (!row.file_id || !row.upload_key || !row.expires_at) return failure(500, "failed");

  const upload = storage.objects.presignPut(row.upload_key, {
    contentType: input.data.contentType,
    contentLength: input.data.size,
    expiresInSeconds: UPLOAD_LINK_SECONDS,
  });
  const response: UploadIntentResponse = {
    fileId: row.file_id,
    uploadUrl: upload.url,
    headers: upload.headers,
    expiresAt: row.expires_at,
  };
  return json(201, response);
}
