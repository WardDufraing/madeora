import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { advanceShopping, listShoppingLists } from "@/shopping/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readShoppingMutation,
  requireReader,
} from "@/shopping/route-helpers";
import { createListSchema } from "@/shopping/schema";

const listQuerySchema = z.strictObject({
  homeId: z.uuid().optional(),
  archived: z.enum(["true", "false"]).optional(),
});

/**
 * The context's lists in their order (S26), active or archived, with their counts and the
 * viewer's access, read with the person's own session after applying due recurring items.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const query = listQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) return failure(400, "invalid");
  const homeId = query.data.homeId ?? null;
  const advanced = await advanceShopping(homeId);
  if (advanced.status === "not-found") return failure(404, "not-found");
  if (advanced.status === "unavailable") return failure(500, "failed");
  const lists = await listShoppingLists(homeId, query.data.archived === "true");
  if (lists.status === "not-found") return failure(404, "not-found");
  if (lists.status === "unavailable") return failure(500, "failed");
  return json(200, { lists: lists.value });
}

/**
 * Creates a list at the end of the context's order (S26): the Personal space, or a Home the
 * person belongs to (every member may). The id comes from the client, so a retry answers the same
 * list (`200`) instead of a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readShoppingMutation(request, createListSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_shopping_list", {
    p_id: input.data.id,
    p_name: input.data.name,
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
  });
  if (error) return databaseFailure("shopping.create_list_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.create_list_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision ?? null,
  });
}
