import { createSupabaseServerClient } from "@/auth/supabase-server";
import { copyRequestSchema } from "@/copies/schema";
import { databaseFailure, json, readPrivacyMutation } from "@/privacy/route-helpers";

/**
 * Asks for independent Home-owned copies of one of the signed-in person's own personal items in
 * the chosen Homes (S40 part 2; spec "Confirmed personal-to-Home ownership transfers at any time").
 * The database decides each Home on its own (made now, copying files, or waiting for that Home's
 * approval) and answers per Home; an item that is not the person's own eligible item is 404.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readPrivacyMutation(request, copyRequestSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_home_copies", {
    p_item_type: input.data.itemType,
    p_item_id: input.data.itemId,
    p_home_ids: input.data.homeIds,
  });
  if (error) return databaseFailure("copies.request_failed", error);
  return json(200, data as object);
}
