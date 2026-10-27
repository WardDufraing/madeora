import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { LockAcquired } from "@/recipes/api";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readRecipeMutation,
} from "@/recipes/route-helpers";
import { acquireLockSchema, lockTokenSchema } from "@/recipes/schema";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

/**
 * Takes the exclusive editing lock of a published recipe for this editor (`token`, one per edit
 * session), or takes over the person's own lock from another tab or device (`takeOver`). Someone
 * else's lock answers `409 locked` with whether it is the person's own and, when they both belong
 * to the Home it is seen from (`homeId`, S25), which member holds it; nobody can take over another
 * person's lock.
 */
export async function POST(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, acquireLockSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("acquire_recipe_lock", {
    p_recipe_id: recipeId,
    p_token: input.data.token,
    p_take_over: input.data.takeOver,
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
  });
  if (error) return databaseFailure("recipes.lock_failed", error);
  const row = data[0];
  if (row?.outcome === "locked") {
    return failure(409, "locked", {
      heldByMe: row.held_by_me,
      member: nullable(row.held_by_member),
    });
  }
  // A draft needs no lock: only its creator can open it.
  if (row?.outcome === "draft") return failure(400, "invalid");
  const body: LockAcquired | Record<string, never> =
    row?.outcome === "acquired" ? { revision: row.revision, expiresAt: row.expires_at } : {};
  return outcomeAnswer("recipes.lock_failed", row?.outcome, body);
}

/** The editor's heartbeat (every 30 s): the lock lasts 2 minutes after the last one. */
export async function PATCH(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, lockTokenSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("renew_recipe_lock", {
    p_recipe_id: recipeId,
    p_token: input.data.token,
  });
  if (error) return databaseFailure("recipes.renew_failed", error);
  const row = data[0];
  return outcomeAnswer("recipes.renew_failed", row?.outcome, { expiresAt: row?.expires_at });
}

/** Releases the editor's lock (Cancel, leaving the page); releasing a lock already gone is fine. */
export async function DELETE(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, lockTokenSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("release_recipe_lock", {
    p_recipe_id: recipeId,
    p_token: input.data.token,
  });
  if (error) return databaseFailure("recipes.release_failed", error);
  return json(200, { released: data });
}
