import { callOraTool } from "../tools/client";
import type { ActionPreview, OraActionId, UndoResult } from "./types";

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
  action: OraActionId,
): Promise<ActionPreview> {
  const output = await callOraTool(homeId, action, { step: "prepare" });
  if (output.kind !== "action-preview") throw new Error("unexpected Ora answer");
  return output.preview;
}

export async function undoAction(
  homeId: string | null,
  action: OraActionId,
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

async function send(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
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
