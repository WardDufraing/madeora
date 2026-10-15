import { StorageUnavailableError } from "@madeora/storage";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { FinalizeResponse } from "@/storage/api";
import { processAvatar } from "@/storage/avatar-image";
import {
  databaseFailure,
  failure,
  json,
  logStorage,
  readStorageMutation,
} from "@/storage/route-helpers";
import { emptyBodySchema, fileIdSchema, isAvatarUploadType } from "@/storage/schema";
import { getStorage, type Storage } from "@/storage/server";

const MAX_BODY_BYTES = 64;

interface FileRouteContext {
  readonly params: Promise<{ readonly fileId: string }>;
}

/** Removes objects without failing the request; the database's clean-up job removes them anyway. */
async function removeQuietly(storage: Storage, keys: readonly string[]): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      storage.objects.delete(key).catch(() => {
        logStorage("storage.cleanup_deferred", "delete_failed");
      }),
    ),
  );
}

/**
 * Checks and processes one of the signed-in person's own uploads, then marks it ready (S15,
 * architecture.md §10 step 5). The upload is read from storage, never trusted: its real size and
 * type must equal what the intent declared, its signature must match the type, and it must decode
 * as an image. The processed 512×512 WebP is stored under the key the database generated, and the
 * upload itself is deleted (the original is not kept). Finalizing records the verified facts
 * through the one privileged call (ADR 0019), which re-checks ownership, expiry and capacity.
 */
export async function POST(request: Request, { params }: FileRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const fileId = fileIdSchema.safeParse((await params).fileId);
  if (!fileId.success) return failure(404, "not-found");

  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_upload", { p_file_id: fileId.data });
  if (error) return databaseFailure("storage.upload_read_failed", error.code);
  const upload = data[0];
  if (!upload) return failure(404, "not-found");
  const done: FinalizeResponse = { file: { id: fileId.data } };
  if (upload.status === "ready") return json(200, done);
  if (upload.status === "expired") return failure(410, "expired");
  if (upload.status !== "pending" || upload.purpose !== "avatar") return failure(404, "not-found");
  const declaredType = upload.declared_type;
  if (!isAvatarUploadType(declaredType)) return failure(500, "failed");

  // One finalize at a time per upload, and only a few in all: each costs a download and a decode.
  const { data: claim, error: claimError } = await supabase.rpc("claim_my_upload", {
    p_file_id: fileId.data,
  });
  if (claimError) return databaseFailure("storage.claim_failed", claimError.code);
  switch (claim) {
    case "claimed":
      break;
    case "ready":
      return json(200, done);
    case "busy":
      return failure(409, "conflict");
    case "limit":
      return failure(429, "rate-limited");
    case "expired":
      return failure(410, "expired");
    default:
      return failure(404, "not-found");
  }
  const release = async () => {
    const { error: releaseError } = await supabase.rpc("release_my_upload", {
      p_file_id: fileId.data,
    });
    if (releaseError) logStorage("storage.release_failed", releaseError.code);
  };

  const abandon = async (code: "mismatch" | "invalid-image") => {
    const { error: abandonError } = await supabase.rpc("abandon_my_upload", {
      p_file_id: fileId.data,
      p_reason: code === "mismatch" ? "mismatch" : "invalid_image",
    });
    if (abandonError) logStorage("storage.abandon_failed", abandonError.code);
    await removeQuietly(storage, [upload.upload_key, upload.object_key]);
    return failure(422, code);
  };

  try {
    const facts = await storage.objects.head(upload.upload_key);
    // Nothing there yet: the browser has not finished putting the bytes. It may try again.
    if (!facts) {
      await release();
      return failure(409, "not-uploaded");
    }
    if (facts.size !== upload.declared_size || facts.contentType !== declaredType) {
      return await abandon("mismatch");
    }
    const read = await storage.objects.get(upload.upload_key, upload.declared_size);
    if (read.status === "missing") {
      await release();
      return failure(409, "not-uploaded");
    }
    if (read.status === "too-large" || read.bytes.byteLength !== upload.declared_size) {
      return await abandon("mismatch");
    }
    const processed = await processAvatar(read.bytes, declaredType);
    if (!processed.ok) return await abandon(processed.reason);

    await storage.objects.put(upload.object_key, processed.bytes, processed.contentType);
    const outcome = await storage.finalizer.finalize(input.identity.userId, fileId.data, {
      contentType: processed.contentType,
      size: processed.bytes.byteLength,
      sha256: processed.sha256,
    });
    if (outcome === "ready") {
      await removeQuietly(storage, [upload.upload_key]);
      return json(200, done);
    }
    // The database has already marked the upload failed and queued both objects; removing them now
    // only frees space sooner. 'not_found' means the upload is no longer this request's to clean up.
    if (outcome !== "not_found") {
      await removeQuietly(storage, [upload.upload_key, upload.object_key]);
    }
    switch (outcome) {
      case "storage_full":
        return failure(409, "storage-full");
      case "expired":
        return failure(410, "expired");
      case "not_found":
        return failure(404, "not-found");
      default:
        return failure(500, "failed");
    }
  } catch (caught) {
    await release();
    if (caught instanceof StorageUnavailableError) {
      logStorage("storage.unavailable", caught.code);
      return failure(503, "storage-unavailable");
    }
    logStorage("storage.finalize_failed", "unexpected");
    return failure(500, "failed");
  }
}
