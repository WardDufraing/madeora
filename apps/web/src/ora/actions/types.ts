import { z } from "zod";

/**
 * Ora's guided changes (S47; spec "limited guided cross-module workflows", "short-lived Quick Undo
 * for safe actions"). Client-safe shapes. A bounded catalogue: each action previews what it will do,
 * the person edits and confirms it, the module's own API makes the change, and an Undo that the
 * module can reverse safely is offered for a short time.
 */

export const oraActionIds = ["add-task", "add-shopping-item"] as const;
export type OraActionId = (typeof oraActionIds)[number];

export function isOraActionId(value: string): value is OraActionId {
  return (oraActionIds as readonly string[]).includes(value);
}

/**
 * How long Undo stays available after a change (spec: the window is specified, not open-ended).
 * Both supported reversals move the new record to the module's Trash; after this the person uses
 * the record's own page.
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
]);
export type ActionInput = z.output<typeof actionInputSchema>;

export type UndoResult =
  /** Moved to Trash. */
  | "undone"
  /** Someone changed it since: Undo would overwrite their change, so it does nothing. */
  | "changed"
  /** Already removed or no longer visible (for example a second Undo). */
  | "gone"
  /** The window has passed. */
  | "expired"
  /** The person may no longer remove it. */
  | "not-permitted";
