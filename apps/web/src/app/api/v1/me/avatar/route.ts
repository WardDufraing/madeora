import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { AvatarResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { avatarChoiceSchema } from "@/storage/schema";

const MAX_BODY_BYTES = 256;

/**
 * Sets or removes the signed-in person's global avatar (S15). Only a ready avatar file of their
 * own qualifies; the database checks that and retires the replaced file (still recoverable and
 * counted for 7 days). Nobody can set another person's avatar: the account is the session's.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readStorageMutation(request, avatarChoiceSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const supabase = await createSupabaseServerClient();
  // Without a file id the function removes the avatar (its argument defaults to null).
  const { data, error } = await supabase.rpc(
    "set_my_avatar",
    input.data.fileId === null ? {} : { p_file_id: input.data.fileId },
  );
  if (error) return databaseFailure("storage.avatar_failed", error.code);
  if (data === "not_found") return failure(404, "not-found");
  if (data !== "ok") return failure(500, "failed");
  const response: AvatarResponse = { avatarFileId: input.data.fileId };
  return json(200, response);
}
