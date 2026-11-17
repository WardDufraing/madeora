import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { loadRemembered } from "@/ora/memories/server";
import { getShoppingList, listShoppingLists } from "@/shopping/data";
import { getTask, listTaskLists, listTasks } from "@/tasks/data";
import { defaultTaskQuery } from "@/tasks/filters";

import type { OraToolContext } from "../tools/types";
import {
  UNDO_WINDOW_MS,
  type ActionInput,
  type ActionPreview,
  type OraAddActionId,
  type OraTaskEditActionId,
  type TaskEdit,
  type TaskPickPreview,
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
  action: OraAddActionId,
): Promise<PrepareResult> {
  const homeId = context.home?.id ?? null;
  if (action === "add-task") {
    const lists = await listTaskLists(homeId, false);
    if (lists.status !== "ok") return { status: "unavailable" };
    const destinations = lists.value
      .filter((list) => !list.archived)
      .map((list) => ({ id: list.id, name: list.name }));
    return {
      status: "ok",
      preview: {
        action,
        destinations,
        remembered: await loadRemembered(context, action, destinations),
      },
    };
  }
  const lists = await listShoppingLists(homeId, false);
  if (lists.status !== "ok") return { status: "unavailable" };
  const destinations = lists.value
    .filter((list) => !list.archived && (list.access === "manage" || list.access === "edit"))
    .map((list) => ({ id: list.id, name: list.name }));
  return {
    status: "ok",
    preview: {
      action,
      destinations,
      remembered: await loadRemembered(context, action, destinations),
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
  action: OraAddActionId,
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
    // Locks the task, checks the revision again and deletes in one call, so an edit made after the
    // reads above cannot be trashed with it.
    const { data, error } = await supabase.rpc("ora_undo_task_create", {
      p_task_id: input.id,
      p_expected_revision: input.expectedRevision,
    });
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
  const { data, error } = await supabase.rpc("ora_undo_shopping_item", {
    p_item_id: input.id,
    p_expected_revision: input.expectedRevision,
  });
  if (error) return error.code === "42501" ? "not-permitted" : "unavailable";
  return outcomeOf(data[0]?.outcome);
}

function outcomeOf(outcome: string | undefined): UndoResult | "unavailable" {
  switch (outcome) {
    case "deleted":
    case "reopened":
    case "saved":
      return "undone";
    case "not_found":
      return "gone";
    case "not_permitted":
      return "not-permitted";
    // "list_unavailable" (the list was archived) and "invalid" (the date no longer fits) also mean
    // the record is no longer as Ora left it.
    case "conflict":
    case "list_unavailable":
    case "invalid":
    case "invalid_label":
      return "changed";
    default:
      return "unavailable";
  }
}

/** How many open tasks a guided task edit offers (a short list, due soonest first). */
const TASK_CHOICES = 25;

export type PrepareTasksResult =
  { readonly status: "ok"; readonly preview: TaskPickPreview } | { readonly status: "unavailable" };

/**
 * The open tasks the person may pick for "complete a task" or "change a due date", read with their
 * own session. Both offer only tasks the module says they can complete (the same right as editing); a due-date change
 * leaves out repeating tasks (changing one occurrence has its own rules on the task's page).
 */
export async function prepareTaskAction(
  context: OraToolContext,
  action: OraTaskEditActionId,
): Promise<PrepareTasksResult> {
  const page = await listTasks(context.home?.id ?? null, defaultTaskQuery, 50);
  if (page.status !== "ok") return { status: "unavailable" };
  const tasks = page.value.tasks
    .filter(
      (task) =>
        !task.completed && task.canComplete && (action === "complete-task" || !task.recurring),
    )
    .slice(0, TASK_CHOICES)
    .map((task) => ({
      id: task.id,
      title: task.title,
      listName: task.listName,
      dueDate: task.dueDate,
    }));
  return { status: "ok", preview: { action, tasks } };
}

export type TaskEditResult =
  { readonly status: "ok"; readonly task: TaskEdit | null } | { readonly status: "unavailable" };

/**
 * The picked task as it is now, for a due-date change. Null when it is gone, in another place, done,
 * repeating, or the person may not edit it. The change itself still goes through the task's own
 * update, which checks all of that again.
 */
export async function loadTaskEdit(context: OraToolContext, id: string): Promise<TaskEditResult> {
  const task = await getTask(id);
  if (task.status === "unavailable") return { status: "unavailable" };
  if (task.status !== "ok") return { status: "ok", task: null };
  const detail = task.value;
  if (
    detail.homeId !== (context.home?.id ?? null) ||
    detail.completedAt !== null ||
    detail.series !== null ||
    !detail.can.edit
  ) {
    return { status: "ok", task: null };
  }
  return {
    status: "ok",
    task: {
      id: detail.id,
      title: detail.title,
      description: detail.description,
      startDate: detail.startDate,
      dueDate: detail.dueDate,
      priority: detail.priority,
      labelIds: detail.labels.map((label) => label.id),
      revision: detail.revision,
      listName: detail.list.name,
    },
  };
}

type TaskUndoInput = Extract<ActionInput, { step: "undo-completion" | "undo-due" }>;

/**
 * Undo of a task edit Ora just made: reopens the task, or puts the old due date back. Same rules as
 * the creation Undo (same place, inside the window) and the database call locks the task and checks
 * that nobody changed it since, so it never overwrites someone else's edit.
 */
export async function undoTaskEdit(
  context: OraToolContext,
  action: OraTaskEditActionId,
  input: TaskUndoInput,
): Promise<UndoResult | "unavailable"> {
  const task = await getTask(input.id);
  if (task.status === "unavailable") return "unavailable";
  if (task.status !== "ok" || task.value.homeId !== (context.home?.id ?? null)) return "gone";
  const supabase = await createSupabaseServerClient();

  if (action === "complete-task" && input.step === "undo-completion") {
    if (Date.now() - Date.parse(input.completedAt) > UNDO_WINDOW_MS) return "expired";
    const { data, error } = await supabase.rpc("ora_undo_task_completion", {
      p_task_id: input.id,
      p_expected_completed_at: input.completedAt,
    });
    if (error) return error.code === "42501" ? "not-permitted" : "unavailable";
    return outcomeOf(data[0]?.outcome);
  }

  if (action === "change-task-due" && input.step === "undo-due") {
    if (task.value.revision !== input.expectedRevision) return "changed";
    if (!withinWindow(task.value.updatedAt)) return "expired";
    const { data, error } = await supabase.rpc("ora_undo_task_due", {
      p_task_id: input.id,
      p_expected_revision: input.expectedRevision,
      ...(input.previousDue === null ? {} : { p_previous_due: input.previousDue }),
    });
    if (error) return error.code === "42501" ? "not-permitted" : "unavailable";
    return outcomeOf(data[0]?.outcome);
  }
  return "gone";
}
