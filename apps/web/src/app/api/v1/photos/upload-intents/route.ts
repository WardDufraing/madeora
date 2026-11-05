import { createSupabaseServerClient } from "@/auth/supabase-server";
import { photoUploadIntentSchema } from "@/photos/schema";
import { homeOf } from "@/photos/route-helpers";
import type { UploadIntentResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { getStorage } from "@/storage/server";

const MAX_BODY_BYTES = 1024;
/** How long the browser has to start putting the bytes (the intent itself lasts 15 minutes). */
const UPLOAD_LINK_SECONDS = 300;

/**
 * Opens an upload of a photo into the person's personal library or a Home's (S35), on the S15
 * pipeline: the database checks the person's right to add there, the type and size, rate limits and
 * the pool's capacity under locks; this route then signs a 5-minute PUT link bound to the generated
 * key, type and size. Finalizing (`POST /api/v1/files/:id/finalize`) checks the bytes and stores an
 * optimized WebP master with its derivatives; the original is not kept.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, photoUploadIntentSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_photo_intent", {
    // The generated types read every parameter as required; null is the personal library.
    p_home_id: homeOf(input.data.owner) as string,
    p_content_type: input.data.contentType,
    p_size: input.data.size,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("storage.photo_intent_failed", error.code);
  const row = data[0];
  switch (row?.outcome) {
    case "ok":
      break;
    case "not_permitted":
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
