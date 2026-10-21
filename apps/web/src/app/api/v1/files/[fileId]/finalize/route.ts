import { StorageUnavailableError } from "@madeora/storage";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { AttachmentImpact, FinalizeResponse } from "@/storage/api";
import { processAvatar } from "@/storage/avatar-image";
import { checkAttachment } from "@/tasks/attachment-file";
import {
  attachmentFinalizeSchema,
  isAttachmentType,
  type AttachmentScope,
} from "@/tasks/attachment-policy";
import {
  databaseFailure,
  failure,
  json,
  logStorage,
  readStorageMutation,
} from "@/storage/route-helpers";
import { fileIdSchema, isAvatarUploadType } from "@/storage/schema";
import { getStorage, type Storage } from "@/storage/server";

const MAX_BODY_BYTES = 64;

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

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
 *
 * A task attachment (S19c) is checked by its type's signature instead (images are re-encoded in the
 * same format without metadata, other files kept as uploaded), stored under the object key, and
 * then attached to its task with the person's own session (`attach_task_file`, which re-checks
 * the task and their rights now), to this occurrence or, with `scope`, to following or all.
 */
export async function POST(request: Request, { params }: FileRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, attachmentFinalizeSchema, MAX_BODY_BYTES);
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
  const isAttachment = upload.purpose === "task_attachment";
  const scope: AttachmentScope = input.data.scope ?? "this";
  const done: FinalizeResponse = { file: { id: fileId.data } };
  const finish = () =>
    isAttachment ? attach(supabase, fileId.data, scope, done) : Promise.resolve(json(200, done));
  if (upload.status === "ready") return finish();
  if (upload.status === "expired") return failure(410, "expired");
  if (upload.status !== "pending" || (upload.purpose !== "avatar" && !isAttachment)) {
    return failure(404, "not-found");
  }
  const declaredType = upload.declared_type;
  if (isAttachment ? !isAttachmentType(declaredType) : !isAvatarUploadType(declaredType)) {
    return failure(500, "failed");
  }

  // One finalize at a time per upload, and only a few in all: each costs a download and a decode.
  const { data: claim, error: claimError } = await supabase.rpc("claim_my_upload", {
    p_file_id: fileId.data,
  });
  if (claimError) return databaseFailure("storage.claim_failed", claimError.code);
  switch (claim) {
    case "claimed":
      break;
    case "ready":
      return finish();
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

  const abandon = async (code: "mismatch" | "invalid-image" | "invalid-file") => {
    const { error: abandonError } = await supabase.rpc("abandon_my_upload", {
      p_file_id: fileId.data,
      p_reason:
        code === "mismatch"
          ? "mismatch"
          : code === "invalid-file"
            ? "invalid_file"
            : "invalid_image",
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
    // By purpose, never by type: an avatar PNG and an attachment PNG are processed differently.
    const processed =
      isAttachment && isAttachmentType(declaredType)
        ? await checkAttachment(read.bytes, declaredType)
        : !isAttachment && isAvatarUploadType(declaredType)
          ? await processAvatar(read.bytes, declaredType)
          : null;
    if (!processed) return failure(500, "failed");
    if (!processed.ok) return await abandon(processed.reason);

    await storage.objects.put(upload.object_key, processed.bytes, processed.contentType);
    const outcome = await storage.finalizer.finalize(input.identity.userId, fileId.data, {
      contentType: processed.contentType,
      size: processed.bytes.byteLength,
      sha256: processed.sha256,
    });
    if (outcome === "ready") {
      await removeQuietly(storage, [upload.upload_key]);
      return await finish();
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

/**
 * Attaches a finished attachment upload to its task. A refusal leaves the file unattached; the
 * expiry job retires it, so it never shows or counts as saved. Retrying answers the same link.
 */
async function attach(
  supabase: SupabaseClient,
  fileId: string,
  scope: AttachmentScope,
  done: FinalizeResponse,
): Promise<Response> {
  const { data, error } = await supabase.rpc("attach_task_file", {
    p_file_id: fileId,
    p_scope: scope,
  });
  if (error) return databaseFailure("storage.attach_failed", error.code);
  const row = data[0];
  switch (row?.outcome) {
    case "attached": {
      if (!row.attachment_id) return failure(500, "failed");
      const body: FinalizeResponse = {
        ...done,
        attachment: { id: row.attachment_id, impact: impactOf(row.impact) },
      };
      return json(200, body);
    }
    case "not_permitted":
      return failure(403, "not-permitted");
    case "limit_reached":
      return failure(409, "limit-reached");
    case "not_recurring":
    case "scope_unavailable":
      return failure(409, "scope-unavailable");
    default:
      return failure(404, "not-found");
  }
}

function impactOf(value: unknown): AttachmentImpact | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const count = (key: string) => (typeof record[key] === "number" ? record[key] : 0);
  return {
    changed: count("changed"),
    kept: count("kept"),
    full: count("full"),
    completed: count("completed"),
  };
}
