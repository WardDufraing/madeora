import { z } from "zod";

/**
 * The trash contract (S16, versioned for later mobile clients). Client-safe. The database checks
 * every one of these again (`public.list_trash`, `restore_trash_entries`, ...).
 */

/** Each module step adds its own value here and in the database check constraints. */
export const trashModules = ["sample", "dashboard", "tasks", "chores"] as const;
export type TrashModule = (typeof trashModules)[number];
export const trashItemTypes = [
  "sample",
  "dashboard_template",
  "task",
  "task_list",
  "task_series_removal",
  "task_attachment",
  "task_series_attachment",
  "chore",
  "chore_occurrence",
  "chore_removal",
] as const;
export type TrashItemType = (typeof trashItemTypes)[number];

export function isTrashModule(value: unknown): value is TrashModule {
  return typeof value === "string" && (trashModules as readonly string[]).includes(value);
}
export function isTrashItemType(value: unknown): value is TrashItemType {
  return typeof value === "string" && (trashItemTypes as readonly string[]).includes(value);
}

/** What the person may choose to resolve a restore conflict (the database names the options). */
export const trashResolutions = [
  "clear_slot",
  "detach_parent",
  "move_to_list",
  "restore_tasks_only",
  "restore_occurrences_only",
] as const;
export type TrashResolution = (typeof trashResolutions)[number];

/**
 * A chosen resolution as sent: a plain option, or an option with its argument after a colon
 * (`move_to_list:<list id>`: restore a task into another list of the same context, S18).
 * `restore_tasks_only` (S19): a removed series changed since; bring back only its occurrences.
 * `restore_occurrences_only` (S20): the same for a chore's removed occurrences.
 */
export type TrashResolutionChoice =
  Exclude<TrashResolution, "move_to_list"> | `move_to_list:${string}`;

const resolutionChoiceSchema = z.union([
  z.enum(["clear_slot", "detach_parent", "restore_tasks_only", "restore_occurrences_only"]),
  z
    .string()
    .regex(/^move_to_list:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .transform((value) => value as `move_to_list:${string}`),
]);

/** The resolution that restores a task into the list `listId`. */
export function moveToListResolution(listId: string): TrashResolutionChoice {
  return `move_to_list:${listId}`;
}

/** Same limit as the database (`private.trash_limit('batch')`). */
export const TRASH_BATCH_LIMIT = 100;

const entryId = z.uuid();
const entryIds = z.array(entryId).min(1).max(TRASH_BATCH_LIMIT);

export const restoreSchema = z.strictObject({
  entryIds,
  /** Entry id → the resolution chosen for that entry; only for entries that reported a conflict. */
  resolutions: z.record(entryId, resolutionChoiceSchema).optional(),
});
export type RestoreInput = z.infer<typeof restoreSchema>;

/** `confirm: true` is the explicit "this cannot be undone" the spec requires before any early delete. */
export const purgeSchema = z.strictObject({
  entryIds,
  confirm: z.literal(true),
});
export type PurgeInput = z.infer<typeof purgeSchema>;

export const emptySchema = z.strictObject({
  /** Null or absent: the personal trash. */
  homeId: z.uuid().nullish(),
  /** When the page that showed the list was loaded: nothing deleted after it is touched. */
  deletedBefore: z.iso.datetime(),
  confirm: z.literal(true),
});
export type EmptyInput = z.infer<typeof emptySchema>;

/** The list filters, as a query string or search params give them. */
export const listQuerySchema = z.strictObject({
  homeId: z.uuid().optional(),
  module: z.enum(trashModules).optional(),
  itemType: z.enum(trashItemTypes).optional(),
  /** Instants (inclusive start, exclusive end) of the deletion-date filter. */
  deletedFrom: z.iso.datetime().optional(),
  deletedTo: z.iso.datetime().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
