import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getShoppingList, listShoppingLists } from "@/shopping/data";
import { getTask, listTaskLists } from "@/tasks/data";

import type { OraToolContext } from "../tools/types";
import {
  UNDO_WINDOW_MS,
  type ActionInput,
  type ActionPreview,
  type OraActionId,
  type UndoResult,
} from "./types";

/**
 * The server half of Ora's guided changes (S47). Both steps read and write with the person's own
 * Supabase session, so the database decides what they may see and remove; the tool registry has
 * already confirmed the person may use the action in this place.
 */

export type PrepareResult =
  { readonly status: "ok"; readonly preview: ActionPreview } | { readonly status: "unavailable" };

/** The lists a new task or item can go to: active, and (for shopping) ones the person may edit. */
export async function prepareAction(
  context: OraToolContext,
  action: OraActionId,
): Promise<PrepareResult> {
  const homeId = context.home?.id ?? null;
  if (action === "add-task") {
    const lists = await listTaskLists(homeId, false);
    if (lists.status !== "ok") return { status: "unavailable" };
    return {
      status: "ok",
      preview: {
        action,
        destinations: lists.value
          .filter((list) => !list.archived)
          .map((list) => ({ id: list.id, name: list.name })),
      },
    };
  }
  const lists = await listShoppingLists(homeId, false);
  if (lists.status !== "ok") return { status: "unavailable" };
  return {
    status: "ok",
    preview: {
      action,
      destinations: lists.value
        .filter((list) => !list.archived && (list.access === "manage" || list.access === "edit"))
        .map((list) => ({ id: list.id, name: list.name })),
    },
  };
}

type UndoInput = Extract<ActionInput, { step: "undo" }>;

function withinWindow(createdAt: string): boolean {
  const created = Date.parse(createdAt);
  return !Number.isNaN(created) && Date.now() - created <= UNDO_WINDOW_MS;
}

/**
 * Undo of a change Ora just made: moves the new record to Trash, only while it is in the same place
 * as the person is now, still at the revision the change left it, and inside the window. Anything
 * else answers truthfully and changes nothing.
 */
export async function undoAction(
  context: OraToolContext,
  action: OraActionId,
  input: UndoInput,
): Promise<UndoResult | "unavailable"> {
  const homeId = context.home?.id ?? null;
  const supabase = await createSupabaseServerClient();

  if (action === "add-task") {
    const task = await getTask(input.id);
    if (task.status === "unavailable") return "unavailable";
    if (task.status !== "ok" || task.value.homeId !== homeId) return "gone";
    if (task.value.revision !== input.expectedRevision) return "changed";
    if (!withinWindow(task.value.createdAt)) return "expired";
    const { data, error } = await supabase.rpc("delete_task", { p_task_id: input.id });
    if (error) return error.code === "42501" ? "not-permitted" : "unavailable";
    return outcomeOf(data[0]?.outcome);
  }

  if (input.listId === undefined) return "gone";
  const list = await getShoppingList(input.listId, homeId);
  if (list.status === "unavailable") return "unavailable";
  if (list.status !== "ok") return "gone";
  const item = list.value.items.find((candidate) => candidate.id === input.id);
  if (!item) return "gone";
  if (item.revision !== input.expectedRevision) return "changed";
  if (!withinWindow(item.createdAt)) return "expired";
  const { data, error } = await supabase.rpc("delete_shopping_item", { p_item_id: input.id });
  if (error) return error.code === "42501" ? "not-permitted" : "unavailable";
  return outcomeOf(data[0]?.outcome);
}

function outcomeOf(outcome: string | undefined): UndoResult | "unavailable" {
  switch (outcome) {
    case "deleted":
      return "undone";
    case "not_found":
      return "gone";
    case "not_permitted":
      return "not-permitted";
    case "conflict":
      return "changed";
    default:
      return "unavailable";
  }
}
