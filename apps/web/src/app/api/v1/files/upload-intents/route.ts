import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { UploadIntentResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { uploadIntentSchema } from "@/storage/schema";
import { getStorage } from "@/storage/server";

const MAX_BODY_BYTES = 512;
/** How long the browser has to start putting the bytes (the intent itself lasts 15 minutes). */
const UPLOAD_LINK_SECONDS = 300;

/**
 * Opens an upload into the signed-in person's own storage (S15). The database checks the type and
 * size policy, rate limits and the pool's capacity under a lock, and generates the opaque key; this
 * route then signs a 5-minute PUT link bound to that key, type and size. The browser never chooses
 * a key or a bucket and never sees a credential.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, uploadIntentSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_upload_intent", {
    p_purpose: input.data.purpose,
    p_content_type: input.data.contentType,
    p_size: input.data.size,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("storage.intent_failed", error.code);
  const row = data[0];
  switch (row?.outcome) {
    case "ok":
      break;
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
