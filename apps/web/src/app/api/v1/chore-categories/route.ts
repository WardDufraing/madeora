import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listChoreCategories } from "@/chores/data";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { createCategorySchema, reorderCategoriesSchema } from "@/chores/schema";

/** The Home's chore categories in order (S20), archived ones too with `archived=true`. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const archived = z
    .enum(["true", "false"])
    .optional()
    .safeParse(params.get("archived") ?? undefined);
  if (!homeId.success || !archived.success) return failure(400, "invalid");
  const categories = await listChoreCategories(homeId.data, archived.data === "true");
  if (categories.status === "not-found") return failure(404, "not-found");
  if (categories.status === "unavailable") return failure(500, "failed");
  return json(200, { categories: categories.value });
}

/** Creates a category (S20, chore managers); the client's id makes a retry return the same one. */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, createCategorySchema);
  if (!input.ok) return input.response;
  const category = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_chore_category", {
    p_id: category.id,
    p_home_id: category.homeId,
    p_name: category.name,
    p_color: category.color,
  });
  if (error) return databaseFailure("chores.category_create_failed", error);
  const row = data[0];
  return outcomeAnswer("chores.category_create_failed", row?.outcome, {
    outcome: row?.outcome,
    revision: row ? nullable(row.revision) : null,
  });
}

/** Puts the Home's categories in the given order (S20, chore managers). */
export async function PUT(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, reorderCategoriesSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reorder_chore_categories", {
    p_home_id: input.data.homeId,
    p_ids: input.data.ids,
  });
  if (error) return databaseFailure("chores.category_order_failed", error);
  return outcomeAnswer("chores.category_order_failed", data, { outcome: data });
}
