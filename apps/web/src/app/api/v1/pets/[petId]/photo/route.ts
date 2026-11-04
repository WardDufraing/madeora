import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure as petDatabaseFailure,
  failure as petFailure,
  outcomeAnswer,
  pathId,
  readPetMutation,
  resultOf,
} from "@/pets/route-helpers";
import { photoIntentSchema, revisionSchema } from "@/pets/schema";
import type { UploadIntentResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { getStorage } from "@/storage/server";

const MAX_BODY_BYTES = 512;
/** How long the browser has to start putting the bytes (the intent itself lasts 15 minutes). */
const UPLOAD_LINK_SECONDS = 300;

interface PetRouteContext {
  readonly params: Promise<{ readonly petId: string }>;
}

/**
 * Opens an upload of a pet's photo (pet managers), on the S15 pipeline: the database checks the
 * person's right, the type and size, rate limits and the Home pool's capacity under locks; this
 * route signs a 5-minute PUT link bound to the generated key, type and size. Finalizing
 * (`POST /api/v1/files/:id/finalize`) checks the bytes, stores a WebP without metadata and makes it
 * the pet's photo.
 */
export async function POST(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, photoIntentSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return failure(404, "not-found");
  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pet_photo_intent", {
    p_pet_id: petId,
    p_content_type: input.data.contentType,
    p_size: input.data.size,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("storage.pet_photo_intent_failed", error.code);
  const row = data[0];
  switch (row?.outcome) {
    case "ok":
      break;
    case "not_found":
      return failure(404, "not-found");
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

/** Removes the pet's photo (pet managers); revision-checked. */
export async function DELETE(request: Request, { params }: PetRouteContext): Promise<Response> {
  const input = await readPetMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const petId = pathId((await params).petId);
  if (!petId) return petFailure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_pet_photo", {
    p_pet_id: petId,
    p_expected_revision: input.data.revision,
  });
  if (error) return petDatabaseFailure("pets.photo_remove_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.photo_remove_failed", outcome, body);
}
