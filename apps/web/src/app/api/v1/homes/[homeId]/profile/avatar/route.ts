import { decideHomeAction } from "@madeora/domain/permissions";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getHomeContext } from "@/homes/server";
import type { AvatarResponse } from "@/storage/api";
import { databaseFailure, failure, json, readStorageMutation } from "@/storage/route-helpers";
import { avatarChoiceSchema } from "@/storage/schema";

const MAX_BODY_BYTES = 256;

interface HomeRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Sets the signed-in person's own avatar in one Home, or with `null` goes back to the global one
 * (S15). Only ever their own row (S11 rule): a Home they do not belong to answers 404, exactly as
 * one that does not exist, and the database checks membership and the file again.
 */
export async function PUT(request: Request, { params }: HomeRouteContext): Promise<Response> {
  const input = await readStorageMutation(request, avatarChoiceSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const found = await getHomeContext((await params).homeId);
  if (found.status === "unavailable") return failure(500, "failed");
  if (found.status === "not-found") return failure(404, "not-found");
  const { home, membership } = found.context;
  if (!decideHomeAction(home.id, membership, "home.profile.editOwn").allowed) {
    return failure(404, "not-found");
  }

  const supabase = await createSupabaseServerClient();
  // Without a file id the Home goes back to the global avatar (the argument defaults to null).
  const { data, error } = await supabase.rpc("set_my_home_avatar", {
    p_home_id: home.id,
    ...(input.data.fileId === null ? {} : { p_file_id: input.data.fileId }),
  });
  if (error) return databaseFailure("storage.home_avatar_failed", error.code);
  if (data === "not_found") return failure(404, "not-found");
  if (data !== "ok") return failure(500, "failed");
  const response: AvatarResponse = { avatarFileId: input.data.fileId };
  return json(200, response);
}
