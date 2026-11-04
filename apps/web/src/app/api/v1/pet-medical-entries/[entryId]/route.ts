import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readMedicalEntry } from "@/pets/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readPetMutation,
  requireReader,
  resultOf,
} from "@/pets/route-helpers";
import { revisionSchema, updateEntrySchema } from "@/pets/schema";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

/** One medical entry with its attachments (medical view); otherwise not found. */
export async function GET(_request: Request, { params }: EntryRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  return readAnswer(await readMedicalEntry(entryId), "entry");
}

/** Corrects an entry in place (medical manage); revision-checked. */
export async function PATCH(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readPetMutation(request, updateEntrySchema);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_pet_medical_entry", {
    p_entry_id: entryId,
    p_expected_revision: input.data.revision,
    p_entry: input.data.entry,
  });
  if (error) return databaseFailure("pets.entry_update_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.entry_update_failed", outcome, body);
}

/** Moves an entry and its attachments to the Home's trash (medical manage). */
export async function DELETE(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readPetMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_pet_medical_entry", {
    p_entry_id: entryId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("pets.entry_delete_failed", error);
  const { outcome, body } = resultOf(data);
  return outcomeAnswer("pets.entry_delete_failed", outcome, body);
}
