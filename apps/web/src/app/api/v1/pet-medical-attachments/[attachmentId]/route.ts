import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readPetMutation,
  resultOf,
} from "@/pets/route-helpers";

interface AttachmentRouteContext {
  readonly params: Promise<{ readonly attachmentId: string }>;
}

/** Moves a medical attachment to the Home's trash (medical manage). */
export async function DELETE(
  request: Request,
  { params }: AttachmentRouteContext,
): Promise<Response> {
  const input = await readPetMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const attachmentId = pathId((await params).attachmentId);
  if (!attachmentId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_pet_medical_attachment", {
    p_attachment_id: attachmentId,
  });
  if (error) return databaseFailure("pets.attachment_remove_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.attachment_remove_failed", outcome, body);
}
