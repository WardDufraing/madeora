import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { ActionDestination, OraActionId } from "@/ora/actions/types";
import type { OraToolContext } from "@/ora/tools/types";

import { memoryKeyFor, memoryKeys, type MemoryKey, type OraMemory } from "./types";

/**
 * The server half of Ora's remembered list choices (S47b). Every call uses the person's own session:
 * the database shows and changes only their own rows, and a Home's rows only while they belong to
 * it. A memory is only a preselection; it never overrides what the person sees and confirms.
 */

const scopeOf = (context: OraToolContext) => context.home?.id ?? "personal";

/**
 * The remembered list for this action in this place, if it is still one the person can add to now
 * (it appears in `destinations`). A deleted, archived or no-longer-writable list is ignored, so a
 * stale memory never preselects something that cannot be used.
 */
export async function loadRemembered(
  context: OraToolContext,
  action: OraActionId,
  destinations: readonly ActionDestination[],
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("ora_memories")
    .select("list_id")
    .eq("scope", scopeOf(context))
    .eq("key", memoryKeyFor(action))
    .maybeSingle();
  if (error) {
    // A failed read only loses a convenience; the preview still works.
    console.error(JSON.stringify({ event: "ora.memory_read_failed", code: error.code }));
    return null;
  }
  return data && destinations.some((destination) => destination.id === data.list_id)
    ? data.list_id
    : null;
}

export type MemoryWrite = "ok" | "forbidden" | "not-found" | "failed";

/**
 * Remembers `listId` for this action here. The list must be one the person can add to right now (its
 * name is read from the server's own list of destinations, not taken from the browser).
 */
export async function saveMemory(
  context: OraToolContext,
  action: OraActionId,
  listId: string,
  destinations: readonly ActionDestination[],
): Promise<MemoryWrite> {
  const list = destinations.find((destination) => destination.id === listId);
  if (!list) return "not-found";
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("ora_memories").upsert(
    {
      scope: scopeOf(context),
      home_id: context.home?.id ?? null,
      key: memoryKeyFor(action),
      list_id: list.id,
      list_name: list.name.slice(0, 200),
    },
    { onConflict: "user_id,scope,key" },
  );
  if (error?.code === "42501") return "forbidden";
  if (error) {
    console.error(JSON.stringify({ event: "ora.memory_write_failed", code: error.code }));
    return "failed";
  }
  return "ok";
}

/** Forgets one remembered choice. Forgetting something already gone is fine. */
export async function deleteMemory(
  userId: string,
  homeId: string | null,
  key: MemoryKey,
): Promise<MemoryWrite> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("ora_memories")
    .delete()
    .eq("user_id", userId)
    .eq("scope", homeId ?? "personal")
    .eq("key", key);
  if (error) {
    console.error(JSON.stringify({ event: "ora.memory_delete_failed", code: error.code }));
    return "failed";
  }
  return "ok";
}

export type MemoriesLoad =
  | { readonly status: "ok"; readonly memories: readonly OraMemory[] }
  | { readonly status: "unavailable" };

/** Everything Ora remembers for the signed-in person, across their places (their own rows only). */
export async function listMemories(): Promise<MemoriesLoad> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("ora_memories")
    .select("key, home_id, list_name")
    .order("created_at", { ascending: true });
  if (error) {
    console.error(JSON.stringify({ event: "ora.memories_read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    memories: data.flatMap((row) =>
      (memoryKeys as readonly string[]).includes(row.key)
        ? [{ key: row.key as MemoryKey, homeId: row.home_id, listName: row.list_name }]
        : [],
    ),
  };
}
