import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { UploadIntentResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { getStorage } from "@/storage/server";
import { attachmentIntentSchema } from "@/tasks/attachment-policy";

const MAX_BODY_BYTES = 2048;
/** How long the browser has to start putting the bytes (the intent itself lasts 15 minutes). */
const UPLOAD_LINK_SECONDS = 300;

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Opens an upload of one file for a task (S19c): the database checks that the person may edit the
 * task, the type and size policy, the task's 10 places (uploads in progress count), rate limits
 * and the capacity of the task's pool (the person's own for a Personal task, the Home's for a Home
 * task) under locks, and stores the display name with the upload. This route then signs a 5-minute
 * PUT link bound to that key, type and size, exactly like an avatar upload (S15).
 */
export async function POST(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, attachmentIntentSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const taskId = z.uuid().safeParse((await params).taskId);
  if (!taskId.success) return failure(404, "not-found");

  const storage = getStorage();
  if (!storage) return failure(503, "storage-unavailable");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task_attachment_intent", {
    p_task_id: taskId.data,
    p_content_type: input.data.contentType,
    p_size: input.data.size,
    p_name: input.data.name,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("storage.attachment_intent_failed", error.code);
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
