import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pathId } from "@/pets/route-helpers";
import { attachmentIntentSchema } from "@/pets/schema";
import type { UploadIntentResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { getStorage } from "@/storage/server";

const MAX_BODY_BYTES = 2048;
/** How long the browser has to start putting the bytes (the intent itself lasts 15 minutes). */
const UPLOAD_LINK_SECONDS = 300;

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

/**
 * Opens an upload of one supporting document for a medical entry (medical manage): JPEG, PNG, WebP
 * or PDF up to 10 MB, 10 per entry (uploads in progress count), charged to the Home's pool. The
 * database checks everything under locks; this route signs a 5-minute PUT link. Finalizing checks
 * the bytes and attaches the file, re-checking the person's medical access at that moment. Someone
 * without medical view gets the same 404 as for an entry that does not exist.
 */
export async function POST(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, attachmentIntentSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pet_medical_attachment_intent", {
    p_entry_id: entryId,
    p_content_type: input.data.contentType,
    p_size: input.data.size,
    p_name: input.data.name,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("storage.pet_attachment_intent_failed", error.code);
  const row = data[0];
  switch (row?.outcome) {
    case "ok":
      break;
    case "not_found":
      return failure(404, "not-found");
    case "not_permitted":
      return failure(403, "not-permitted");
    case "limit_reached":
      return failure(409, "limit-reached");
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
