import { z } from "zod";

import type { TaskPriority } from "@/tasks/schema";

/**
 * Ora's guided changes (S47; spec "limited guided cross-module workflows", "short-lived Quick Undo
 * for safe actions"). Client-safe shapes. A bounded catalogue: each action previews what it will do,
 * the person edits and confirms it, the module's own API makes the change, and an Undo that the
 * module can reverse safely is offered for a short time.
 */

export const oraActionIds = [
  "add-task",
  "add-shopping-item",
  "complete-task",
  "change-task-due",
] as const;
export type OraActionId = (typeof oraActionIds)[number];

/** The two guided changes that edit an existing task (S47d); the others add a record. */
export type OraTaskEditActionId = "complete-task" | "change-task-due";

/** The guided changes that add a record. */
export type OraAddActionId = Exclude<OraActionId, OraTaskEditActionId>;

export function isTaskEditAction(action: OraActionId): action is OraTaskEditActionId {
  return action === "complete-task" || action === "change-task-due";
}

export function isOraActionId(value: string): value is OraActionId {
  return (oraActionIds as readonly string[]).includes(value);
}

/**
 * How long Undo stays available after a change (spec: the window is specified, not open-ended).
 * Undo moves a new record to the module's Trash, reopens a completed task or puts a due date back;
 * after this the person uses the record's own page.
 */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

export interface ActionDestination {
  readonly id: string;
  readonly name: string;
}

/** What a guided change needs the person to choose: where it goes. Empty: nowhere they may add to. */
export interface ActionPreview {
  readonly action: OraActionId;
  readonly destinations: readonly ActionDestination[];
  /** The list the person asked Ora to remember for this change here (S47b), if still usable. */
  readonly remembered: string | null;
}

/** One open task the person may pick for a guided edit. */
export interface TaskChoice {
  readonly id: string;
  readonly title: string;
  readonly listName: string;
  /** `YYYY-MM-DD` or null. */
  readonly dueDate: string | null;
}

/** What a guided task edit offers first: the person's open tasks here (a short, due-soonest list). */
export interface TaskPickPreview {
  readonly action: OraTaskEditActionId;
  readonly tasks: readonly TaskChoice[];
}

/** The picked task as it is now, so a due-date change can save the whole task unchanged but for the date. */
export interface TaskEdit {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly startDate: string | null;
  readonly dueDate: string | null;
  readonly priority: TaskPriority | null;
  readonly labelIds: readonly string[];
  readonly revision: number;
  readonly listName: string;
}

export const actionInputSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("prepare") }),
  z.strictObject({
    step: z.literal("undo"),
    id: z.uuid(),
    /** A shopping item is found through its list; a task is not. */
    listId: z.uuid().optional(),
    /** The revision the change left the record at; any later edit by anyone blocks Undo. */
    expectedRevision: z.int().min(1).max(1_000_000),
  }),
  /** Task edits: the picked task as it is now. */
  z.strictObject({ step: z.literal("task"), id: z.uuid() }),
  /** Reopens a task Ora completed, if that very completion still stands. */
  z.strictObject({
    step: z.literal("undo-completion"),
    id: z.uuid(),
    completedAt: z.iso.datetime({ offset: true }),
  }),
  /** Puts the due date back, if the task is still at the revision the change left it at. */
  z.strictObject({
    step: z.literal("undo-due"),
    id: z.uuid(),
    expectedRevision: z.int().min(1).max(1_000_000),
    previousDue: z.iso.date().nullable(),
  }),
]);
export type ActionInput = z.output<typeof actionInputSchema>;

export type UndoResult =
  /** Done: moved to Trash, reopened, or the old date put back. */
  | "undone"
  /** Someone changed it since: Undo would overwrite their change, so it does nothing. */
  | "changed"
  /** Already removed or no longer visible (for example a second Undo). */
  | "gone"
  /** The window has passed. */
  | "expired"
  /** The person may no longer remove it. */
  | "not-permitted";
