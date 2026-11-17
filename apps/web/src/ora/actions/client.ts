import { callOraTool } from "../tools/client";
import type {
  ActionPreview,
  OraAddActionId,
  OraTaskEditActionId,
  TaskChoice,
  TaskEdit,
  UndoResult,
} from "./types";

/**
 * The browser's side of a guided change (S47): fetch the preview, make the confirmed change through
 * the module's own authorized API, and undo it. Ids of new records are made by the caller once per
 * draft, so a retry returns the same record instead of a second one.
 */

export type ApplyFailure =
  | "signedOut"
  | "not-permitted"
  | "duplicate"
  | "list-unavailable"
  | "invalid"
  /** Someone changed the record after it was shown (a task edit saves only the version shown). */
  | "conflict"
  | "network"
  | "failed";

export class ApplyError extends Error {
  constructor(readonly failure: ApplyFailure) {
    super(`Ora change failed: ${failure}`);
    this.name = "ApplyError";
  }
}

export interface Applied {
  readonly id: string;
  /** The record's revision right after the change; Undo is refused once anyone edits it. */
  readonly revision: number;
}

export async function prepareAction(
  homeId: string | null,
  action: OraAddActionId,
): Promise<ActionPreview> {
  const output = await callOraTool(homeId, action, { step: "prepare" });
  if (output.kind !== "action-preview") throw new Error("unexpected Ora answer");
  return output.preview;
}

export async function undoAction(
  homeId: string | null,
  action: OraAddActionId,
  applied: Applied & { readonly listId?: string },
): Promise<UndoResult> {
  const output = await callOraTool(homeId, action, {
    step: "undo",
    id: applied.id,
    ...(applied.listId === undefined ? {} : { listId: applied.listId }),
    expectedRevision: applied.revision,
  });
  if (output.kind !== "action-undo") throw new Error("unexpected Ora answer");
  return output.result;
}

async function send(
  url: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" = "POST",
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApplyError("network");
  }
  if (response.ok) return response.json().catch(() => ({}));
  const error = ((await response.json().catch(() => null)) as { error?: string } | null)?.error;
  if (response.status === 401) throw new ApplyError("signedOut");
  if (error === "duplicate") throw new ApplyError("duplicate");
  if (response.status === 409 && error === "conflict") throw new ApplyError("conflict");
  if (error === "not-found" || error === "list-unavailable")
    throw new ApplyError("list-unavailable");
  if (response.status === 403 || error === "not-permitted") throw new ApplyError("not-permitted");
  if (response.status === 400) throw new ApplyError("invalid");
  throw new ApplyError("failed");
}

export interface NewTask {
  readonly id: string;
  readonly homeId: string | null;
  readonly listId: string;
  readonly title: string;
  /** `YYYY-MM-DD` or null. */
  readonly dueDate: string | null;
}

export async function applyAddTask(task: NewTask): Promise<Applied> {
  const body = (await send("/api/v1/tasks", {
    id: task.id,
    homeId: task.homeId,
    listId: task.listId,
    title: task.title,
    description: null,
    startDate: null,
    dueDate: task.dueDate,
    priority: null,
    labelIds: [],
    assigneeIds: [],
  })) as { revision?: unknown };
  return { id: task.id, revision: typeof body.revision === "number" ? body.revision : 1 };
}

export interface NewShoppingItem {
  readonly id: string;
  readonly listId: string;
  readonly name: string;
  readonly allowDuplicate: boolean;
}

export async function applyAddShoppingItem(item: NewShoppingItem): Promise<Applied> {
  const body = (await send(`/api/v1/shopping/lists/${encodeURIComponent(item.listId)}/items`, {
    items: [{ id: item.id, name: item.name, allowDuplicate: item.allowDuplicate }],
  })) as { results?: readonly { outcome?: string }[] };
  const outcome = body.results?.[0]?.outcome;
  if (outcome === "duplicate") throw new ApplyError("duplicate");
  if (outcome === "not_permitted") throw new ApplyError("not-permitted");
  if (outcome === "not_found") throw new ApplyError("list-unavailable");
  if (outcome === "invalid") throw new ApplyError("invalid");
  if (outcome !== "created" && outcome !== "exists") throw new ApplyError("failed");
  // A new item starts at revision 1; a retried add that already exists is the same item.
  return { id: item.id, revision: 1 };
}

/** The person's open tasks here for "complete a task" and "change a due date". */
export async function fetchTaskChoices(
  homeId: string | null,
  action: OraTaskEditActionId,
): Promise<readonly TaskChoice[]> {
  const output = await callOraTool(homeId, action, { step: "prepare" });
  if (output.kind !== "action-tasks") throw new Error("unexpected Ora answer");
  return output.preview.tasks;
}

/** The picked task as it is now (null: gone, done, repeating, or not theirs to edit). */
export async function fetchTaskEdit(homeId: string | null, id: string): Promise<TaskEdit | null> {
  const output = await callOraTool(homeId, "change-task-due", { step: "task", id });
  if (output.kind !== "action-task") throw new Error("unexpected Ora answer");
  return output.task;
}

export interface Completed {
  readonly id: string;
  /** Null: it was already completed by someone else, so there is nothing of Ora's to undo. */
  readonly completedAt: string | null;
}

export async function applyCompleteTask(id: string): Promise<Completed> {
  const body = (await send(
    `/api/v1/tasks/${encodeURIComponent(id)}/completion`,
    { completed: true },
    "PUT",
  )) as { outcome?: string; completedAt?: unknown };
  if (body.outcome === "already_completed") return { id, completedAt: null };
  if (body.outcome !== "completed" || typeof body.completedAt !== "string") {
    throw new ApplyError("failed");
  }
  return { id, completedAt: body.completedAt };
}

export async function undoCompletion(
  homeId: string | null,
  completed: { readonly id: string; readonly completedAt: string },
): Promise<UndoResult> {
  const output = await callOraTool(homeId, "complete-task", {
    step: "undo-completion",
    id: completed.id,
    completedAt: completed.completedAt,
  });
  if (output.kind !== "action-undo") throw new Error("unexpected Ora answer");
  return output.result;
}

export interface DueChanged {
  readonly id: string;
  readonly previousDue: string | null;
  /** The revision the change left the task at; Undo is refused once anyone edits it. */
  readonly revision: number;
}

/** Saves the task exactly as shown but for its due date (null removes it). */
export async function applyChangeDue(task: TaskEdit, dueDate: string | null): Promise<DueChanged> {
  const body = (await send(
    `/api/v1/tasks/${encodeURIComponent(task.id)}`,
    {
      expectedRevision: task.revision,
      title: task.title,
      description: task.description,
      startDate: task.startDate,
      dueDate,
      priority: task.priority,
      labelIds: task.labelIds,
    },
    "PATCH",
  )) as { revision?: unknown };
  if (typeof body.revision !== "number") throw new ApplyError("failed");
  return { id: task.id, previousDue: task.dueDate, revision: body.revision };
}

export async function undoDue(homeId: string | null, changed: DueChanged): Promise<UndoResult> {
  const output = await callOraTool(homeId, "change-task-due", {
    step: "undo-due",
    id: changed.id,
    expectedRevision: changed.revision,
    previousDue: changed.previousDue,
  });
  if (output.kind !== "action-undo") throw new Error("unexpected Ora answer");
  return output.result;
}
