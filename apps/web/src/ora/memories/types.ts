import { z } from "zod";

import type { OraActionId } from "@/ora/actions/types";

/**
 * What Ora remembers (S47b; spec "Confirmed controlled long-term Ora memory"). One closed kind: the
 * list to preselect for a guided change in one place. Personal to the person who saved it, never
 * shared with the Home or carried to another place, and only ever a preselection: the preview still
 * shows it and the person still confirms. Client-safe shapes.
 */

export const memoryKeys = ["task-list", "shopping-list"] as const;
export type MemoryKey = (typeof memoryKeys)[number];

export const memoryKeyFor = (action: OraActionId): MemoryKey =>
  action === "add-task" ? "task-list" : "shopping-list";

export interface OraMemory {
  readonly key: MemoryKey;
  /** `null`: Personal space. */
  readonly homeId: string | null;
  /** The list's name when it was remembered. */
  readonly listName: string;
}

export const saveMemorySchema = z.strictObject({
  homeId: z.uuid().nullable(),
  action: z.enum(["add-task", "add-shopping-item"]),
  listId: z.uuid(),
});
export type SaveMemoryInput = z.output<typeof saveMemorySchema>;

export const deleteMemorySchema = z.strictObject({
  homeId: z.uuid().nullable(),
  key: z.enum(memoryKeys),
});
export type DeleteMemoryInput = z.output<typeof deleteMemorySchema>;
